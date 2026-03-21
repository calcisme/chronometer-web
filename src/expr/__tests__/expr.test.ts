/**
 * Tests for the C-expression evaluator (tokenizer, parser, evaluator).
 * 
 * Tests cover token types, AST construction, evaluation semantics,
 * and integration with real expressions from Chronometer watch XML files.
 */

import { describe, test, expect } from 'vitest';
import { tokenize, TokenType, TokenizerError } from '../tokenizer.js';
import { parse, ParseError } from '../parser.js';
import {
    evaluate,
    evaluateExpression,
    evaluateInit,
    createDefaultEnvironment,
    Environment,
    EvalError,
} from '../evaluator.js';

// ============================================================================
// Helper
// ============================================================================

function freshEnv(): Environment {
    return createDefaultEnvironment();
}

// ============================================================================
// Tokenizer tests
// ============================================================================

describe('tokenizer', () => {
    test('simple integer', () => {
        const tokens = tokenize('42');
        expect(tokens[0].type).toBe(TokenType.Integer);
        expect(tokens[0].value).toBe('42');
        expect(tokens[1].type).toBe(TokenType.EOF);
    });

    test('hex integer', () => {
        const tokens = tokenize('0xff00c0ac');
        expect(tokens[0].type).toBe(TokenType.Integer);
        expect(tokens[0].value).toBe('0xff00c0ac');
    });

    test('octal integer', () => {
        const tokens = tokenize('0377');
        expect(tokens[0].type).toBe(TokenType.Integer);
        expect(tokens[0].value).toBe('0377');
    });

    test('double with leading dot', () => {
        const tokens = tokenize('.5');
        expect(tokens[0].type).toBe(TokenType.Double);
        expect(tokens[0].value).toBe('.5');
    });

    test('double with trailing dot', () => {
        const tokens = tokenize('2.');
        expect(tokens[0].type).toBe(TokenType.Double);
        expect(tokens[0].value).toBe('2.');
    });

    test('double with digits on both sides', () => {
        const tokens = tokenize('3.14');
        expect(tokens[0].type).toBe(TokenType.Double);
        expect(tokens[0].value).toBe('3.14');
    });

    test('scientific notation', () => {
        const tokens = tokenize('1e10');
        expect(tokens[0].type).toBe(TokenType.DoubleE);
        expect(tokens[0].value).toBe('1e10');
    });

    test('scientific notation with sign and decimal', () => {
        const tokens = tokenize('3.14e-2');
        expect(tokens[0].type).toBe(TokenType.DoubleE);
        expect(tokens[0].value).toBe('3.14e-2');
    });

    test('identifier', () => {
        const tokens = tokenize('myVar_123');
        expect(tokens[0].type).toBe(TokenType.Identifier);
        expect(tokens[0].value).toBe('myVar_123');
    });

    test('all two-char operators', () => {
        const ops = ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/='];
        for (const op of ops) {
            const tokens = tokenize(op);
            expect(tokens[0].value).toBe(op);
        }
    });

    test('all single-char operators', () => {
        const ops = ['(', ')', ',', ':', '?', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '='];
        for (const op of ops) {
            const tokens = tokenize(op);
            expect(tokens[0].value).toBe(op);
        }
    });

    test('skips whitespace', () => {
        const tokens = tokenize('  a  + b  ');
        expect(tokens.filter(t => t.type !== TokenType.EOF).length).toBe(3);
    });

    test('skips block comments', () => {
        const tokens = tokenize('a /* comment */ + b');
        const nonEOF = tokens.filter(t => t.type !== TokenType.EOF);
        expect(nonEOF.length).toBe(3);
        expect(nonEOF[0].value).toBe('a');
        expect(nonEOF[1].value).toBe('+');
        expect(nonEOF[2].value).toBe('b');
    });

    test('throws on unterminated comment', () => {
        expect(() => tokenize('a /* unterminated')).toThrow(TokenizerError);
    });

    test('complex expression from Haleakala init', () => {
        const src = "r=143, ri=r-5, th=26, bx=r*cos(th*pi/180), by=r*sin(th*pi/180)";
        const tokens = tokenize(src);
        // Should tokenize without errors
        expect(tokens[tokens.length - 1].type).toBe(TokenType.EOF);
        // Check a few tokens
        expect(tokens[0].value).toBe('r');
        expect(tokens[1].value).toBe('=');
        expect(tokens[2].value).toBe('143');
    });

    test('positions are tracked', () => {
        const tokens = tokenize('ab + cd');
        expect(tokens[0].position).toBe(0);
        expect(tokens[1].position).toBe(3);
        expect(tokens[2].position).toBe(5);
    });
});

// ============================================================================
// Parser tests
// ============================================================================

describe('parser', () => {
    test('number literal', () => {
        const ast = parse('42');
        expect(ast).toEqual({ kind: 'NumberLiteral', value: 42 });
    });

    test('hex number literal', () => {
        const ast = parse('0xff');
        expect(ast).toEqual({ kind: 'NumberLiteral', value: 255 });
    });

    test('identifier', () => {
        const ast = parse('pi');
        expect(ast).toEqual({ kind: 'Identifier', name: 'pi' });
    });

    test('simple addition', () => {
        const ast = parse('1 + 2');
        expect(ast.kind).toBe('BinaryOp');
        if (ast.kind === 'BinaryOp') {
            expect(ast.operator).toBe('+');
            expect(ast.left).toEqual({ kind: 'NumberLiteral', value: 1 });
            expect(ast.right).toEqual({ kind: 'NumberLiteral', value: 2 });
        }
    });

    test('operator precedence: * before +', () => {
        const ast = parse('1 + 2 * 3');
        expect(ast.kind).toBe('BinaryOp');
        if (ast.kind === 'BinaryOp') {
            expect(ast.operator).toBe('+');
            expect(ast.left).toEqual({ kind: 'NumberLiteral', value: 1 });
            expect(ast.right).toEqual({
                kind: 'BinaryOp',
                operator: '*',
                left: { kind: 'NumberLiteral', value: 2 },
                right: { kind: 'NumberLiteral', value: 3 },
            });
        }
    });

    test('parenthesized expression overrides precedence', () => {
        const ast = parse('(1 + 2) * 3');
        expect(ast.kind).toBe('BinaryOp');
        if (ast.kind === 'BinaryOp') {
            expect(ast.operator).toBe('*');
        }
    });

    test('unary minus', () => {
        const ast = parse('-x');
        expect(ast.kind).toBe('UnaryOp');
        if (ast.kind === 'UnaryOp') {
            expect(ast.operator).toBe('-');
            expect(ast.operand).toEqual({ kind: 'Identifier', name: 'x' });
        }
    });

    test('function call no args', () => {
        const ast = parse('hour24Number()');
        expect(ast).toEqual({ kind: 'FunctionCall', name: 'hour24Number', args: [] });
    });

    test('function call with args', () => {
        const ast = parse('atan2(y, x)');
        expect(ast.kind).toBe('FunctionCall');
        if (ast.kind === 'FunctionCall') {
            expect(ast.name).toBe('atan2');
            expect(ast.args.length).toBe(2);
        }
    });

    test('ternary expression', () => {
        const ast = parse('a ? b : c');
        expect(ast.kind).toBe('Ternary');
    });

    test('assignment', () => {
        const ast = parse('x = 5');
        expect(ast.kind).toBe('Assignment');
        if (ast.kind === 'Assignment') {
            expect(ast.name).toBe('x');
            expect(ast.operator).toBe('=');
            expect(ast.value).toEqual({ kind: 'NumberLiteral', value: 5 });
        }
    });

    test('comma-separated expression list', () => {
        const ast = parse('a = 1, b = 2, c = 3');
        expect(ast.kind).toBe('ExpressionList');
        if (ast.kind === 'ExpressionList') {
            expect(ast.expressions.length).toBe(3);
        }
    });

    test('nested ternary', () => {
        const ast = parse('a ? b : c ? d : e');
        expect(ast.kind).toBe('Ternary');
        if (ast.kind === 'Ternary') {
            expect(ast.alternate.kind).toBe('Ternary');
        }
    });

    test('comparison operators', () => {
        const ast = parse('a >= 12');
        expect(ast.kind).toBe('BinaryOp');
        if (ast.kind === 'BinaryOp') {
            expect(ast.operator).toBe('>=');
        }
    });

    test('logical operators', () => {
        const ast = parse('a && b || c');
        expect(ast.kind).toBe('BinaryOp');
        if (ast.kind === 'BinaryOp') {
            // || has lower precedence, so it's the root
            expect(ast.operator).toBe('||');
        }
    });

    test('throws on unexpected token', () => {
        expect(() => parse('')).toThrow(ParseError);
    });

    test('throws on trailing garbage', () => {
        expect(() => parse('1 2')).toThrow(ParseError);
    });

    test('complex init expression parses', () => {
        // From Haleakala.xml
        const src = "r=143, ri=r-5, th=26, bx=r*cos(th*pi/180), by=r*sin(th*pi/180), dr=8, mx=dr*cos(th*pi/180), my=dr*sin(th*pi/180)";
        const ast = parse(src);
        expect(ast.kind).toBe('ExpressionList');
    });

    test('real ternary expression parses', () => {
        // From Geneva.xml
        const src = "hour24Number() >= 12 ? 0 : pi";
        const ast = parse(src);
        expect(ast.kind).toBe('Ternary');
    });

    test('nested function call with arithmetic', () => {
        const src = "fmod((dayNumber()+1), 10)*2*pi/10";
        const ast = parse(src);
        expect(ast.kind).toBe('BinaryOp');
    });

    test('compound action expression', () => {
        // From Haleakala.xml buttons: (tick(), stemIn())
        const src = "manualSet() ? (tick(), stemIn()) : (tock(), stemOut())";
        const ast = parse(src);
        expect(ast.kind).toBe('Ternary');
    });
});

// ============================================================================
// Evaluator tests
// ============================================================================

describe('evaluator', () => {
    test('integer literal', () => {
        expect(evaluateExpression('42', freshEnv())).toBe(42);
    });

    test('double literal', () => {
        expect(evaluateExpression('3.14', freshEnv())).toBeCloseTo(3.14);
    });

    test('hex literal (color constant)', () => {
        expect(evaluateExpression('0xff000000', freshEnv())).toBe(0xff000000 >>> 0);
    });

    test('scientific notation', () => {
        expect(evaluateExpression('1e3', freshEnv())).toBe(1000);
    });

    test('octal literal', () => {
        expect(evaluateExpression('0377', freshEnv())).toBe(255);
    });

    test('pi constant', () => {
        expect(evaluateExpression('pi', freshEnv())).toBe(Math.PI);
    });

    test('basic arithmetic', () => {
        expect(evaluateExpression('2 + 3', freshEnv())).toBe(5);
        expect(evaluateExpression('10 - 4', freshEnv())).toBe(6);
        expect(evaluateExpression('3 * 7', freshEnv())).toBe(21);
        expect(evaluateExpression('15 / 4', freshEnv())).toBe(3.75);
        expect(evaluateExpression('17 % 5', freshEnv())).toBe(2);
    });

    test('operator precedence', () => {
        expect(evaluateExpression('2 + 3 * 4', freshEnv())).toBe(14);
        expect(evaluateExpression('(2 + 3) * 4', freshEnv())).toBe(20);
    });

    test('unary minus', () => {
        expect(evaluateExpression('-5', freshEnv())).toBe(-5);
    });

    test('unary not', () => {
        expect(evaluateExpression('!0', freshEnv())).toBe(1);
        expect(evaluateExpression('!1', freshEnv())).toBe(0);
        expect(evaluateExpression('!42', freshEnv())).toBe(0);
    });

    test('comparison operators', () => {
        expect(evaluateExpression('3 < 5', freshEnv())).toBe(1);
        expect(evaluateExpression('5 < 3', freshEnv())).toBe(0);
        expect(evaluateExpression('3 <= 3', freshEnv())).toBe(1);
        expect(evaluateExpression('3 > 5', freshEnv())).toBe(0);
        expect(evaluateExpression('5 >= 5', freshEnv())).toBe(1);
        expect(evaluateExpression('3 == 3', freshEnv())).toBe(1);
        expect(evaluateExpression('3 != 4', freshEnv())).toBe(1);
    });

    test('logical operators with short-circuit', () => {
        expect(evaluateExpression('1 && 2', freshEnv())).toBe(2);
        expect(evaluateExpression('0 && 2', freshEnv())).toBe(0);
        expect(evaluateExpression('0 || 3', freshEnv())).toBe(3);
        expect(evaluateExpression('1 || 3', freshEnv())).toBe(1);
    });

    test('bitwise operators', () => {
        expect(evaluateExpression('5 & 3', freshEnv())).toBe(1);
        expect(evaluateExpression('5 | 3', freshEnv())).toBe(7);
        expect(evaluateExpression('5 ^ 3', freshEnv())).toBe(6);
    });

    test('shift operators', () => {
        expect(evaluateExpression('1 << 4', freshEnv())).toBe(16);
        expect(evaluateExpression('16 >> 2', freshEnv())).toBe(4);
    });

    test('ternary expression', () => {
        expect(evaluateExpression('1 ? 10 : 20', freshEnv())).toBe(10);
        expect(evaluateExpression('0 ? 10 : 20', freshEnv())).toBe(20);
    });

    test('variable assignment and retrieval', () => {
        const env = freshEnv();
        evaluateExpression('x = 42', env);
        expect(env.variables.get('x')).toBe(42);
        expect(evaluateExpression('x', env)).toBe(42);
    });

    test('compound assignment operators', () => {
        const env = freshEnv();
        evaluateExpression('x = 10', env);
        evaluateExpression('x += 5', env);
        expect(env.variables.get('x')).toBe(15);
        evaluateExpression('x -= 3', env);
        expect(env.variables.get('x')).toBe(12);
        evaluateExpression('x *= 2', env);
        expect(env.variables.get('x')).toBe(24);
        evaluateExpression('x /= 4', env);
        expect(env.variables.get('x')).toBe(6);
    });

    test('assignment chains in expression list', () => {
        const env = freshEnv();
        evaluateExpression('a = 1, b = 2, c = a + b', env);
        expect(env.variables.get('a')).toBe(1);
        expect(env.variables.get('b')).toBe(2);
        expect(env.variables.get('c')).toBe(3);
    });

    test('math function sin', () => {
        expect(evaluateExpression('sin(0)', freshEnv())).toBe(0);
        expect(evaluateExpression('sin(pi/2)', freshEnv())).toBeCloseTo(1);
    });

    test('math function cos', () => {
        expect(evaluateExpression('cos(0)', freshEnv())).toBe(1);
        expect(evaluateExpression('cos(pi)', freshEnv())).toBeCloseTo(-1);
    });

    test('math function atan2', () => {
        expect(evaluateExpression('atan2(1, 0)', freshEnv())).toBeCloseTo(Math.PI / 2);
    });

    test('math function sqrt', () => {
        expect(evaluateExpression('sqrt(4)', freshEnv())).toBe(2);
    });

    test('math function floor/ceil', () => {
        expect(evaluateExpression('floor(3.7)', freshEnv())).toBe(3);
        expect(evaluateExpression('ceil(3.2)', freshEnv())).toBe(4);
    });

    test('fmod function', () => {
        expect(evaluateExpression('fmod(7, 3)', freshEnv())).toBeCloseTo(1);
        expect(evaluateExpression('fmod(-7, 3)', freshEnv())).toBeCloseTo(-1);
    });

    test('pow function', () => {
        expect(evaluateExpression('pow(2, 10)', freshEnv())).toBe(1024);
    });

    test('nested function calls', () => {
        expect(evaluateExpression('abs(sin(pi))', freshEnv())).toBeCloseTo(0);
    });

    test('undefined variable throws', () => {
        expect(() => evaluateExpression('undefinedVar', freshEnv())).toThrow(EvalError);
    });

    test('undefined function throws', () => {
        expect(() => evaluateExpression('undefinedFunc()', freshEnv())).toThrow(EvalError);
    });

    test('custom function registration', () => {
        const env = freshEnv();
        env.functions.set('double', (x: number) => x * 2);
        expect(evaluateExpression('double(21)', env)).toBe(42);
    });

    test('color constant black', () => {
        const env = freshEnv();
        expect(evaluateExpression('black', env)).toBe(0xFF000000 >>> 0);
    });

    test('color constant white', () => {
        const env = freshEnv();
        expect(evaluateExpression('white', env)).toBe(0xFFFFFFFF >>> 0);
    });

    test('color constant clear', () => {
        const env = freshEnv();
        expect(evaluateExpression('clear', env)).toBe(0);
    });
});

// ============================================================================
// Integration tests with real watch XML expressions
// ============================================================================

describe('integration: real watch XML expressions', () => {
    test('Haleakala init block 1', () => {
        const env = freshEnv();
        evaluateInit(
            "hairline=0.25, nMoons=16, nightBg=black, azR=130, mainR=118, altR=79",
            env,
        );
        expect(env.variables.get('hairline')).toBe(0.25);
        expect(env.variables.get('nMoons')).toBe(16);
        expect(env.variables.get('nightBg')).toBe(0xFF000000 >>> 0);
        expect(env.variables.get('azR')).toBe(130);
        expect(env.variables.get('mainR')).toBe(118);
        expect(env.variables.get('altR')).toBe(79);
    });

    test('Haleakala init block with cross-references', () => {
        const env = freshEnv();
        evaluateInit(
            "riseX=-40, setX=-riseX, riseSetY=22, riseSetRadius=27",
            env,
        );
        expect(env.variables.get('riseX')).toBe(-40);
        expect(env.variables.get('setX')).toBe(40);  // -(-40) = 40
        expect(env.variables.get('riseSetY')).toBe(22);
        expect(env.variables.get('riseSetRadius')).toBe(27);
    });

    test('Haleakala init with trig functions', () => {
        const env = freshEnv();
        evaluateInit(
            "r=143, ri=r-5, th=26, bx=r*cos(th*pi/180), by=r*sin(th*pi/180), dr=8, mx=dr*cos(th*pi/180), my=dr*sin(th*pi/180)",
            env,
        );
        expect(env.variables.get('r')).toBe(143);
        expect(env.variables.get('ri')).toBe(138);
        expect(env.variables.get('th')).toBe(26);
        // bx = 143 * cos(26°) ≈ 143 * 0.89879 ≈ 128.53
        expect(env.variables.get('bx')).toBeCloseTo(143 * Math.cos(26 * Math.PI / 180), 5);
        // by = 143 * sin(26°) ≈ 143 * 0.43837 ≈ 62.69
        expect(env.variables.get('by')).toBeCloseTo(143 * Math.sin(26 * Math.PI / 180), 5);
    });

    test('Geneva init with chained variable references', () => {
        const env = freshEnv();
        evaluateInit(
            "latitudeY=58, longitudeY=-latitudeY, latlongradius=20, errRadius=23, actRadius=8",
            env,
        );
        expect(env.variables.get('latitudeY')).toBe(58);
        expect(env.variables.get('longitudeY')).toBe(-58);
        expect(env.variables.get('latlongradius')).toBe(20);
    });

    test('Geneva init with complex arithmetic chains', () => {
        const env = freshEnv();
        evaluateInit(
            "latlongradius=20, firstLatX=-latlongradius*3-6, secondLatX=-latlongradius-5, thirdLatX=-secondLatX, fourthLatX=-firstLatX",
            env,
        );
        expect(env.variables.get('firstLatX')).toBe(-20 * 3 - 6);  // -66
        expect(env.variables.get('secondLatX')).toBe(-20 - 5);       // -25
        expect(env.variables.get('thirdLatX')).toBe(25);
        expect(env.variables.get('fourthLatX')).toBe(66);
    });

    test('Geneva init with hex color constants', () => {
        const env = freshEnv();
        evaluateInit(
            "frontBg=0xffb0b0b0, backBg=0xff808080, dials=white, dialmarks=black",
            env,
        );
        expect(env.variables.get('frontBg')).toBe(0xffb0b0b0 >>> 0);
        expect(env.variables.get('backBg')).toBe(0xff808080 >>> 0);
        expect(env.variables.get('dials')).toBe(0xFFFFFFFF >>> 0);
        expect(env.variables.get('dialmarks')).toBe(0xFF000000 >>> 0);
    });

    test('ternary with function call (angle expression)', () => {
        const env = freshEnv();
        // Simulate hour24Number returning 14 (2 PM)
        env.functions.set('hour24Number', () => 14);
        const result = evaluateExpression('hour24Number() >= 12 ? 0 : pi', env);
        expect(result).toBe(0);
    });

    test('ternary with function call (AM case)', () => {
        const env = freshEnv();
        env.functions.set('hour24Number', () => 8);
        const result = evaluateExpression('hour24Number() >= 12 ? 0 : pi', env);
        expect(result).toBe(Math.PI);
    });

    test('complex ternary from button motion', () => {
        const env = freshEnv();
        env.functions.set('timeIsCorrect', () => 0);  // time is not correct
        env.functions.set('manualSet', () => 1);       // in manual set mode
        env.functions.set('runningDemo', () => 0);     // not running demo
        const result = evaluateExpression(
            '(!timeIsCorrect()) || manualSet() ? (runningDemo() == 1 ? 0 : 1) : 0',
            env,
        );
        expect(result).toBe(1);
    });

    test('fmod expression from SWheel angle', () => {
        const env = freshEnv();
        env.functions.set('dayNumber', () => 14);
        const result = evaluateExpression(
            'fmod((dayNumber()+1), 10)*2*pi/10',
            env,
        );
        // fmod(15, 10) = 5;  5 * 2 * pi / 10 = pi
        expect(result).toBeCloseTo(Math.PI, 5);
    });

    test('nested fmod with floor', () => {
        const env = freshEnv();
        env.functions.set('dayNumber', () => 14);
        const result = evaluateExpression(
            'fmod(floor((dayNumber()+1)/10),10)*2*pi/10',
            env,
        );
        // floor(15/10) = 1;  fmod(1, 10) = 1;  1 * 2 * pi / 10 = pi/5
        expect(result).toBeCloseTo(Math.PI / 5, 5);
    });

    test('Geneva second init block', () => {
        const env = freshEnv();
        evaluateInit(
            "cr=136, cr2=114, gm=90, gw=.2, gc1=black, rs=36, ms=25, mainClrGold=0xff706040, mainClr=clear, subClr=0xff202000, innerBg=0xffc0c0c0, subBg=0xffe7e7e7",
            env,
        );
        expect(env.variables.get('cr')).toBe(136);
        expect(env.variables.get('gw')).toBeCloseTo(0.2);
        expect(env.variables.get('gc1')).toBe(0xFF000000 >>> 0);
        expect(env.variables.get('mainClr')).toBe(0);
    });

    test('expression with timezone offset comparison', () => {
        const env = freshEnv();
        env.functions.set('hour24Number', () => 14);
        env.functions.set('tzOffset', () => -28800); // PST = -8h
        const result = evaluateExpression(
            'hour24Number()-tzOffset()/3600>=24 ? pi*3/4 : pi*5/4',
            env,
        );
        // 14 - (-28800)/3600 = 14 + 8 = 22;  22 >= 24? no → pi*5/4
        expect(result).toBeCloseTo(Math.PI * 5 / 4, 5);
    });

    test('evaluateInit processes multiple blocks sequentially', () => {
        const env = freshEnv();
        evaluateInit("azR=130, mainR=118, altR=79", env);
        evaluateInit("riseX=-40, setX=-riseX, riseSetY=22, riseSetRadius=27, rsampmX=69", env);
        evaluateInit("dateY=-51, firstDateX=-14, monthRadius=86, monthX=-monthRadius+firstDateX+36, weekdayRadius=95", env);
        
        expect(env.variables.get('azR')).toBe(130);
        expect(env.variables.get('setX')).toBe(40);
        expect(env.variables.get('monthX')).toBe(-86 + (-14) + 36);  // -64
        expect(env.variables.get('weekdayRadius')).toBe(95);
    });
});
