/**
 * Tokenizer for C-like expressions used in Chronometer watch XML files.
 *
 * Derived from the lex specification in Parser/c.l of the original Chronometer source.
 * Produces a flat array of tokens from a source string.
 */

// ============================================================================
// Token types
// ============================================================================

export enum TokenType {
    Integer = 'Integer',
    Double = 'Double',
    DoubleE = 'DoubleE',
    Identifier = 'Identifier',

    // Punctuation / single-char operators
    LParen = '(',
    RParen = ')',
    Comma = ',',
    Colon = ':',
    Question = '?',
    Plus = '+',
    Minus = '-',
    Star = '*',
    Slash = '/',
    Percent = '%',
    Ampersand = '&',
    Pipe = '|',
    Caret = '^',
    Tilde = '~',
    Bang = '!',
    LessThan = '<',
    GreaterThan = '>',
    Equals = '=',

    // Multi-char operators
    LeftShift = '<<',
    RightShift = '>>',
    LessEqual = '<=',
    GreaterEqual = '>=',
    EqualEqual = '==',
    BangEqual = '!=',
    AmpAmp = '&&',
    PipePipe = '||',
    PlusEquals = '+=',
    MinusEquals = '-=',
    StarEquals = '*=',
    SlashEquals = '/=',

    // End of input
    EOF = 'EOF',
}

export interface Token {
    type: TokenType;
    value: string;     // The raw text of the token
    position: number;  // Character offset in the source string
}

// ============================================================================
// Tokenizer
// ============================================================================

export class TokenizerError extends Error {
    constructor(message: string, public position: number) {
        super(message);
        this.name = 'TokenizerError';
    }
}

/**
 * Tokenize a C-expression string into an array of Tokens.
 */
export function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let pos = 0;

    while (pos < source.length) {
        // Skip whitespace
        if (isWhitespace(source[pos])) {
            pos++;
            continue;
        }

        // Skip block comments  /* ... */
        if (source[pos] === '/' && pos + 1 < source.length && source[pos + 1] === '*') {
            pos += 2;
            while (pos + 1 < source.length && !(source[pos] === '*' && source[pos + 1] === '/')) {
                pos++;
            }
            if (pos + 1 >= source.length) {
                throw new TokenizerError('Unterminated comment', pos);
            }
            pos += 2; // skip */
            continue;
        }

        const start = pos;

        // Numbers: hex, octal, decimal integers, doubles, scientific notation
        if (isDigit(source[pos]) || (source[pos] === '.' && pos + 1 < source.length && isDigit(source[pos + 1]))) {
            const tok = readNumber(source, pos);
            tokens.push(tok);
            pos = start + tok.value.length;
            continue;
        }

        // Identifiers: [a-zA-Z_][a-zA-Z0-9_]*
        if (isIdentStart(source[pos])) {
            while (pos < source.length && isIdentChar(source[pos])) {
                pos++;
            }
            tokens.push({ type: TokenType.Identifier, value: source.slice(start, pos), position: start });
            continue;
        }

        // Two-character operators (check before single-char)
        if (pos + 1 < source.length) {
            const two = source.slice(pos, pos + 2);
            const twoCharType = TWO_CHAR_OPS[two];
            if (twoCharType !== undefined) {
                tokens.push({ type: twoCharType, value: two, position: start });
                pos += 2;
                continue;
            }
        }

        // Single-character operators / punctuation
        const oneCharType = ONE_CHAR_OPS[source[pos]];
        if (oneCharType !== undefined) {
            tokens.push({ type: oneCharType, value: source[pos], position: start });
            pos++;
            continue;
        }

        // Unknown character — skip (matching c.l behavior of ignoring bad characters)
        pos++;
    }

    tokens.push({ type: TokenType.EOF, value: '', position: pos });
    return tokens;
}

// ============================================================================
// Number reading
// ============================================================================

function readNumber(source: string, pos: number): Token {
    const start = pos;

    // Hex: 0x or 0X
    if (source[pos] === '0' && pos + 1 < source.length && (source[pos + 1] === 'x' || source[pos + 1] === 'X')) {
        pos += 2;
        while (pos < source.length && isHexDigit(source[pos])) {
            pos++;
        }
        return { type: TokenType.Integer, value: source.slice(start, pos), position: start };
    }

    // Leading digits (could be integer, double, or scientific)
    const hasLeadingDigits = isDigit(source[pos]);
    if (hasLeadingDigits) {
        while (pos < source.length && isDigit(source[pos])) {
            pos++;
        }
    }

    // Check for decimal point
    const hasDot = pos < source.length && source[pos] === '.';
    if (hasDot) {
        pos++;
        while (pos < source.length && isDigit(source[pos])) {
            pos++;
        }
    }

    // Check for exponent
    if (pos < source.length && (source[pos] === 'e' || source[pos] === 'E')) {
        pos++;
        if (pos < source.length && (source[pos] === '+' || source[pos] === '-')) {
            pos++;
        }
        while (pos < source.length && isDigit(source[pos])) {
            pos++;
        }
        return { type: TokenType.DoubleE, value: source.slice(start, pos), position: start };
    }

    if (hasDot) {
        return { type: TokenType.Double, value: source.slice(start, pos), position: start };
    }

    // Pure integer (including octal like 0377 — the parser will handle interpretation)
    return { type: TokenType.Integer, value: source.slice(start, pos), position: start };
}

// ============================================================================
// Operator lookup tables
// ============================================================================

const TWO_CHAR_OPS: Record<string, TokenType> = {
    '<<': TokenType.LeftShift,
    '>>': TokenType.RightShift,
    '<=': TokenType.LessEqual,
    '>=': TokenType.GreaterEqual,
    '==': TokenType.EqualEqual,
    '!=': TokenType.BangEqual,
    '&&': TokenType.AmpAmp,
    '||': TokenType.PipePipe,
    '+=': TokenType.PlusEquals,
    '-=': TokenType.MinusEquals,
    '*=': TokenType.StarEquals,
    '/=': TokenType.SlashEquals,
};

const ONE_CHAR_OPS: Record<string, TokenType> = {
    '(': TokenType.LParen,
    ')': TokenType.RParen,
    ',': TokenType.Comma,
    ':': TokenType.Colon,
    '?': TokenType.Question,
    '+': TokenType.Plus,
    '-': TokenType.Minus,
    '*': TokenType.Star,
    '/': TokenType.Slash,
    '%': TokenType.Percent,
    '&': TokenType.Ampersand,
    '|': TokenType.Pipe,
    '^': TokenType.Caret,
    '~': TokenType.Tilde,
    '!': TokenType.Bang,
    '<': TokenType.LessThan,
    '>': TokenType.GreaterThan,
    '=': TokenType.Equals,
};

// ============================================================================
// Character classification helpers
// ============================================================================

function isWhitespace(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

function isDigit(ch: string): boolean {
    return ch >= '0' && ch <= '9';
}

function isHexDigit(ch: string): boolean {
    return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');
}

function isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentChar(ch: string): boolean {
    return isIdentStart(ch) || isDigit(ch);
}
