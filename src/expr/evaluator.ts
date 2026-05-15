/**
 * Tree-walking evaluator for C-like expressions from Chronometer watch XML files.
 *
 * Evaluates an AST (produced by the parser) against an Environment of
 * variables and functions. All values are JavaScript numbers (double-precision
 * float), matching the original Chronometer implementation.
 */

import { ASTNode, parse } from './parser.js';

// ============================================================================
// Environment
// ============================================================================

export type ExprFunction = (...args: number[]) => number;

export interface Environment {
    /** Mutable variable bindings. */
    variables: Map<string, number>;
    /** Function bindings (math builtins + watch-specific functions). */
    functions: Map<string, ExprFunction>;
    /** Kyoto hand mode: 0 = moving hand (default), 1 = fixed hand at top */
    kyHandMode: number;
    /** Observer latitude in radians (set by watch-env, used by sentinel scheduling). */
    observerLatRad?: number;
    /** Observer longitude in radians (set by watch-env, used by sentinel scheduling). */
    observerLonRad?: number;
    /** Timezone offset in seconds east-positive (set by watch-env, used by sentinel scheduling). */
    tzOffsetSec?: number;
    /** Display-time source (set by watch-env, used by renderer ring cache). */
    getNow?: () => Date;
}

/**
 * Create an environment pre-populated with math builtins and standard constants.
 */
export function createDefaultEnvironment(): Environment {
    const variables = new Map<string, number>();
    const functions = new Map<string, ExprFunction>();

    // Standard constants
    variables.set('pi', Math.PI);
    variables.set('true', 1);
    variables.set('false', 0);

    // Color constants used across watch XMLs
    variables.set('black', 0xFF000000 >>> 0);
    variables.set('white', 0xFFFFFFFF >>> 0);
    variables.set('red', 0xFFFF0000 >>> 0);
    variables.set('green', 0xFF00FF00 >>> 0);
    variables.set('blue', 0xFF0000FF >>> 0);
    variables.set('clear', 0x00000000);
    variables.set('yellow', 0xFFFFFF00 >>> 0);
    variables.set('cyan', 0xFF00FFFF >>> 0);
    variables.set('magenta', 0xFFFF00FF >>> 0);
    variables.set('darkGray', 0xFF555555 >>> 0);   // iOS [UIColor darkGrayColor] = 1/3
    variables.set('lightGray', 0xFFAAAAAA >>> 0);   // iOS [UIColor lightGrayColor] = 2/3

    // Planet number constants (matching ECPlanetNumber enum)
    variables.set('planetSun', 0);
    variables.set('planetMoon', 1);

    // Math functions
    functions.set('sin', Math.sin);
    functions.set('cos', Math.cos);
    functions.set('tan', Math.tan);
    functions.set('asin', Math.asin);
    functions.set('acos', Math.acos);
    functions.set('atan', Math.atan);
    functions.set('atan2', Math.atan2);
    functions.set('sqrt', Math.sqrt);
    functions.set('abs', Math.abs);
    functions.set('floor', Math.floor);
    functions.set('ceil', Math.ceil);
    functions.set('log', Math.log);
    functions.set('exp', Math.exp);
    functions.set('pow', Math.pow);
    functions.set('min', Math.min);
    functions.set('max', Math.max);
    functions.set('round', Math.round);

    // fmod: C-style float modulus (matches the original's use of fmod)
    functions.set('fmod', (a: number, b: number) => a - Math.trunc(a / b) * b);

    return { variables, functions, kyHandMode: 0 };
}

// ============================================================================
// Evaluator
// ============================================================================

export class EvalError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'EvalError';
    }
}

/**
 * Evaluate an AST node in the given environment, returning a numeric result.
 */
export function evaluate(node: ASTNode, env: Environment): number {
    switch (node.kind) {
        case 'NumberLiteral':
            return node.value;

        case 'Identifier': {
            const val = env.variables.get(node.name);
            if (val === undefined) {
                // Check if it's a zero-arg function being referenced without parens
                // (shouldn't happen per grammar, but be safe)
                throw new EvalError(`Undefined variable: ${node.name}`);
            }
            return val;
        }

        case 'UnaryOp': {
            const operand = evaluate(node.operand, env);
            switch (node.operator) {
                case '+': return operand;
                case '-': return -operand;
                case '~': return ~operand;
                case '!': return operand ? 0 : 1;
            }
            break;
        }

        case 'BinaryOp':
            return evaluateBinaryOp(node.operator, node.left, node.right, env);

        case 'Ternary': {
            const cond = evaluate(node.condition, env);
            return cond ? evaluate(node.consequent, env) : evaluate(node.alternate, env);
        }

        case 'Assignment': {
            const value = evaluate(node.value, env);
            const name = node.name;
            switch (node.operator) {
                case '=':
                    env.variables.set(name, value);
                    return value;
                case '+=': {
                    const cur = env.variables.get(name) ?? 0;
                    const result = cur + value;
                    env.variables.set(name, result);
                    return result;
                }
                case '-=': {
                    const cur = env.variables.get(name) ?? 0;
                    const result = cur - value;
                    env.variables.set(name, result);
                    return result;
                }
                case '*=': {
                    const cur = env.variables.get(name) ?? 0;
                    const result = cur * value;
                    env.variables.set(name, result);
                    return result;
                }
                case '/=': {
                    const cur = env.variables.get(name) ?? 0;
                    const result = cur / value;
                    env.variables.set(name, result);
                    return result;
                }
            }
            break;
        }

        case 'FunctionCall': {
            const fn = env.functions.get(node.name);
            if (!fn) {
                throw new EvalError(`Undefined function: ${node.name}`);
            }
            const args = node.args.map(arg => evaluate(arg, env));
            return fn(...args);
        }

        case 'ExpressionList': {
            let result = 0;
            for (const expr of node.expressions) {
                result = evaluate(expr, env);
            }
            return result;
        }
    }

    // Should be unreachable
    throw new EvalError(`Unknown node kind: ${(node as ASTNode).kind}`);
}

// ============================================================================
// Binary operator evaluation
// ============================================================================

function evaluateBinaryOp(operator: string, left: ASTNode, right: ASTNode, env: Environment): number {
    // Short-circuit for logical operators
    if (operator === '&&') {
        const l = evaluate(left, env);
        return l ? evaluate(right, env) : 0;
    }
    if (operator === '||') {
        const l = evaluate(left, env);
        return l ? l : evaluate(right, env);
    }

    const l = evaluate(left, env);
    const r = evaluate(right, env);

    switch (operator) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return l / r;
        case '%': return l % r;
        case '<<': return l << r;
        case '>>': return l >> r;
        case '<': return l < r ? 1 : 0;
        case '>': return l > r ? 1 : 0;
        case '<=': return l <= r ? 1 : 0;
        case '>=': return l >= r ? 1 : 0;
        case '==': return l === r ? 1 : 0;
        case '!=': return l !== r ? 1 : 0;
        case '&': return l & r;
        case '^': return l ^ r;
        case '|': return l | r;
        default:
            throw new EvalError(`Unknown binary operator: ${operator}`);
    }
}

// ============================================================================
// Convenience functions
// ============================================================================

/**
 * Parse and evaluate an expression string in one step.
 */
export function evaluateExpression(source: string, env: Environment): number {
    const ast = parse(source);
    return evaluate(ast, env);
}

/**
 * Evaluate an `init expr` string — a comma-separated list of assignments.
 * The side effects (variable assignments) are the point; the return value
 * is the value of the last expression.
 */
export function evaluateInit(source: string, env: Environment): number {
    return evaluateExpression(source, env);
}
