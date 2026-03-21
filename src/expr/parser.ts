/**
 * Recursive-descent parser for C-like expressions used in Chronometer watch XML files.
 *
 * Grammar matches the yacc specification in Parser/c.y of the original Chronometer source.
 * Produces an AST from a token array.
 */

import { Token, TokenType, tokenize } from './tokenizer.js';

// ============================================================================
// AST node types
// ============================================================================

export type ASTNode =
    | NumberLiteral
    | Identifier
    | UnaryOp
    | BinaryOp
    | Ternary
    | Assignment
    | FunctionCall
    | ExpressionList;

export interface NumberLiteral {
    kind: 'NumberLiteral';
    value: number;
}

export interface Identifier {
    kind: 'Identifier';
    name: string;
}

export interface UnaryOp {
    kind: 'UnaryOp';
    operator: '+' | '-' | '~' | '!';
    operand: ASTNode;
}

export interface BinaryOp {
    kind: 'BinaryOp';
    operator: string;
    left: ASTNode;
    right: ASTNode;
}

export interface Ternary {
    kind: 'Ternary';
    condition: ASTNode;
    consequent: ASTNode;
    alternate: ASTNode;
}

export interface Assignment {
    kind: 'Assignment';
    name: string;
    operator: '=' | '+=' | '-=' | '*=' | '/=';
    value: ASTNode;
}

export interface FunctionCall {
    kind: 'FunctionCall';
    name: string;
    args: ASTNode[];
}

export interface ExpressionList {
    kind: 'ExpressionList';
    expressions: ASTNode[];
}

// ============================================================================
// Parser
// ============================================================================

export class ParseError extends Error {
    constructor(message: string, public position: number) {
        super(message);
        this.name = 'ParseError';
    }
}

/**
 * Parse a C-expression string into an AST.
 */
export function parse(source: string): ASTNode {
    const tokens = tokenize(source);
    const parser = new Parser(tokens);
    const result = parser.parseExpression();
    parser.expect(TokenType.EOF);
    return result;
}

class Parser {
    private pos = 0;

    constructor(private tokens: Token[]) {}

    // Current token
    private peek(): Token {
        return this.tokens[this.pos];
    }

    // Advance and return the consumed token
    private advance(): Token {
        const tok = this.tokens[this.pos];
        this.pos++;
        return tok;
    }

    // Expect a specific token type, advance, and return the token
    expect(type: TokenType): Token {
        const tok = this.peek();
        if (tok.type !== type) {
            throw new ParseError(
                `Expected ${type} but got ${tok.type} ('${tok.value}')`,
                tok.position,
            );
        }
        return this.advance();
    }

    // Check if current token is a specific type (optionally with a specific value)
    private match(type: TokenType, value?: string): boolean {
        const tok = this.peek();
        if (tok.type !== type) return false;
        if (value !== undefined && tok.value !== value) return false;
        return true;
    }

    // Save/restore for backtracking
    private save(): number {
        return this.pos;
    }
    private restore(saved: number): void {
        this.pos = saved;
    }

    // ========================================================================
    // Grammar rules — following c.y precedence exactly
    // ========================================================================

    // expression → assignment_expression (',' assignment_expression)*
    parseExpression(): ASTNode {
        const first = this.parseAssignment();
        if (!this.match(TokenType.Comma)) {
            return first;
        }
        const expressions: ASTNode[] = [first];
        while (this.match(TokenType.Comma)) {
            this.advance();
            expressions.push(this.parseAssignment());
        }
        return { kind: 'ExpressionList', expressions };
    }

    // assignment_expression → IDENTIFIER ('='|'+='|'-='|'*='|'/=') assignment_expression
    //                       | conditional_expression
    private parseAssignment(): ASTNode {
        // Try to match IDENTIFIER followed by assignment operator
        if (this.match(TokenType.Identifier)) {
            const saved = this.save();
            const idTok = this.advance();
            const tok = this.peek();
            if (tok.type === TokenType.Equals ||
                tok.type === TokenType.PlusEquals ||
                tok.type === TokenType.MinusEquals ||
                tok.type === TokenType.StarEquals ||
                tok.type === TokenType.SlashEquals) {
                const op = this.advance();
                const value = this.parseAssignment();
                return {
                    kind: 'Assignment',
                    name: idTok.value,
                    operator: op.value as Assignment['operator'],
                    value,
                };
            }
            // Not an assignment — backtrack
            this.restore(saved);
        }
        return this.parseConditional();
    }

    // conditional_expression → logical_or ('?' expression ':' conditional_expression)?
    private parseConditional(): ASTNode {
        let node = this.parseLogicalOr();
        if (this.match(TokenType.Question)) {
            this.advance();
            const consequent = this.parseExpression();
            this.expect(TokenType.Colon);
            const alternate = this.parseConditional();
            node = { kind: 'Ternary', condition: node, consequent, alternate };
        }
        return node;
    }

    // logical_or → logical_and ('||' logical_and)*
    private parseLogicalOr(): ASTNode {
        let node = this.parseLogicalAnd();
        while (this.match(TokenType.PipePipe)) {
            this.advance();
            const right = this.parseLogicalAnd();
            node = { kind: 'BinaryOp', operator: '||', left: node, right };
        }
        return node;
    }

    // logical_and → inclusive_or ('&&' inclusive_or)*
    private parseLogicalAnd(): ASTNode {
        let node = this.parseBitwiseOr();
        while (this.match(TokenType.AmpAmp)) {
            this.advance();
            const right = this.parseBitwiseOr();
            node = { kind: 'BinaryOp', operator: '&&', left: node, right };
        }
        return node;
    }

    // inclusive_or → exclusive_or ('|' exclusive_or)*
    private parseBitwiseOr(): ASTNode {
        let node = this.parseBitwiseXor();
        while (this.match(TokenType.Pipe)) {
            this.advance();
            const right = this.parseBitwiseXor();
            node = { kind: 'BinaryOp', operator: '|', left: node, right };
        }
        return node;
    }

    // exclusive_or → and_expression ('^' and_expression)*
    private parseBitwiseXor(): ASTNode {
        let node = this.parseBitwiseAnd();
        while (this.match(TokenType.Caret)) {
            this.advance();
            const right = this.parseBitwiseAnd();
            node = { kind: 'BinaryOp', operator: '^', left: node, right };
        }
        return node;
    }

    // and_expression → equality ('&' equality)*
    private parseBitwiseAnd(): ASTNode {
        let node = this.parseEquality();
        while (this.match(TokenType.Ampersand)) {
            this.advance();
            const right = this.parseEquality();
            node = { kind: 'BinaryOp', operator: '&', left: node, right };
        }
        return node;
    }

    // equality → relational (('=='|'!=') relational)*
    private parseEquality(): ASTNode {
        let node = this.parseRelational();
        while (this.match(TokenType.EqualEqual) || this.match(TokenType.BangEqual)) {
            const op = this.advance();
            const right = this.parseRelational();
            node = { kind: 'BinaryOp', operator: op.value, left: node, right };
        }
        return node;
    }

    // relational → shift (('<'|'>'|'<='|'>=') shift)*
    private parseRelational(): ASTNode {
        let node = this.parseShift();
        while (
            this.match(TokenType.LessThan) ||
            this.match(TokenType.GreaterThan) ||
            this.match(TokenType.LessEqual) ||
            this.match(TokenType.GreaterEqual)
        ) {
            const op = this.advance();
            const right = this.parseShift();
            node = { kind: 'BinaryOp', operator: op.value, left: node, right };
        }
        return node;
    }

    // shift → additive (('<<'|'>>') additive)*
    private parseShift(): ASTNode {
        let node = this.parseAdditive();
        while (this.match(TokenType.LeftShift) || this.match(TokenType.RightShift)) {
            const op = this.advance();
            const right = this.parseAdditive();
            node = { kind: 'BinaryOp', operator: op.value, left: node, right };
        }
        return node;
    }

    // additive → multiplicative (('+'|'-') multiplicative)*
    private parseAdditive(): ASTNode {
        let node = this.parseMultiplicative();
        while (this.match(TokenType.Plus) || this.match(TokenType.Minus)) {
            const op = this.advance();
            const right = this.parseMultiplicative();
            node = { kind: 'BinaryOp', operator: op.value, left: node, right };
        }
        return node;
    }

    // multiplicative → unary (('*'|'/'|'%') unary)*
    private parseMultiplicative(): ASTNode {
        let node = this.parseUnary();
        while (this.match(TokenType.Star) || this.match(TokenType.Slash) || this.match(TokenType.Percent)) {
            const op = this.advance();
            const right = this.parseUnary();
            node = { kind: 'BinaryOp', operator: op.value, left: node, right };
        }
        return node;
    }

    // unary → ('+'|'-'|'~'|'!') unary | postfix
    private parseUnary(): ASTNode {
        if (
            this.match(TokenType.Plus) ||
            this.match(TokenType.Minus) ||
            this.match(TokenType.Tilde) ||
            this.match(TokenType.Bang)
        ) {
            const op = this.advance();
            const operand = this.parseUnary();
            return { kind: 'UnaryOp', operator: op.value as UnaryOp['operator'], operand };
        }
        return this.parsePostfix();
    }

    // postfix → IDENTIFIER '(' argList? ')' | primary
    private parsePostfix(): ASTNode {
        if (this.match(TokenType.Identifier)) {
            const saved = this.save();
            const idTok = this.advance();
            if (this.match(TokenType.LParen)) {
                this.advance(); // consume '('
                if (this.match(TokenType.RParen)) {
                    this.advance(); // no args
                    return { kind: 'FunctionCall', name: idTok.value, args: [] };
                }
                // Parse argument list
                const args: ASTNode[] = [this.parseAssignment()];
                while (this.match(TokenType.Comma)) {
                    this.advance();
                    args.push(this.parseAssignment());
                }
                this.expect(TokenType.RParen);
                return { kind: 'FunctionCall', name: idTok.value, args };
            }
            // Not a function call — it's just an identifier
            this.restore(saved);
        }
        return this.parsePrimary();
    }

    // primary → NUMBER | IDENTIFIER | '(' expression ')'
    private parsePrimary(): ASTNode {
        const tok = this.peek();

        // Number literals
        if (tok.type === TokenType.Integer || tok.type === TokenType.Double || tok.type === TokenType.DoubleE) {
            this.advance();
            return { kind: 'NumberLiteral', value: parseNumericLiteral(tok) };
        }

        // Identifier
        if (tok.type === TokenType.Identifier) {
            this.advance();
            return { kind: 'Identifier', name: tok.value };
        }

        // Parenthesized expression
        if (tok.type === TokenType.LParen) {
            this.advance();
            const expr = this.parseExpression();
            this.expect(TokenType.RParen);
            return expr;
        }

        throw new ParseError(
            `Unexpected token ${tok.type} ('${tok.value}')`,
            tok.position,
        );
    }
}

// ============================================================================
// Numeric literal parsing
// ============================================================================

function parseNumericLiteral(tok: Token): number {
    const s = tok.value;

    if (tok.type === TokenType.Integer) {
        // Hex
        if (s.startsWith('0x') || s.startsWith('0X')) {
            // Parse as unsigned 32-bit, then convert to number.
            // This correctly handles color constants like 0xffb0b0b0.
            return Number(BigInt(s) & BigInt(0xFFFFFFFF));
        }
        // Octal (leading zero with more digits)
        if (s.length > 1 && s.startsWith('0')) {
            return parseInt(s, 8);
        }
        // Decimal integer
        return parseInt(s, 10);
    }

    // Double or DoubleE — JavaScript parseFloat handles both
    return parseFloat(s);
}
