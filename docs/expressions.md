# Expressions

The expression system parses and evaluates the C-like arithmetic expressions embedded in watch-face XML attributes (e.g., `hour24Number() >= 12 ? 0 : pi`).

## Expression Language

The language supports:
- **Arithmetic**: `+`, `-`, `*`, `/`, `%`
- **Comparisons**: `<`, `>`, `<=`, `>=`, `==`, `!=`
- **Logical**: `&&`, `||`, `!`
- **Ternary**: `cond ? trueExpr : falseExpr`
- **Function calls**: `sin(x)`, `hour24Number()`, `sunRA()`, up to 5 arguments
- **Variables**: `pi`, `mainR`, user-defined via init blocks
- **Assignment chains**: `cr=136, cr2=114, mainR=cr+18` (in init blocks)
- **Constants**: numeric literals, `pi`

Examples from watch XML:
```
hour24Number() >= 12 ? 0 : pi
r*cos(th*pi/180)
DSTNumber() ? pi*7/4 : pi/4
terminatorAngle(moonAgeAngle(), 0, 3, 6, 0)
```

## Pipeline: Tokenizer → Parser → Evaluator

### Tokenizer (`src/expr/tokenizer.ts`)

Converts expression strings into a stream of tokens: numbers, identifiers, operators, parentheses, commas.

### Parser (`src/expr/parser.ts`)

Recursive-descent parser that builds an Abstract Syntax Tree (AST). Handles operator precedence, unary operators, ternary expressions, and function calls.

### Evaluator (`src/expr/evaluator.ts`)

Walks the AST given a variable/function environment and returns a numeric result. The environment provides:
- **Variables**: `pi`, `mainR`, and all init-block-defined variables
- **Functions**: `sin`, `cos`, `hour24Number`, `sunRA`, `moonAgeAngle`, etc.

## Pre-Parsed Expressions

Expressions are parsed **once** when the XML is loaded, not on every frame. All numeric expression attributes in the part model are stored as `ASTNode` objects rather than strings.

### Type system

In `src/watch/types.ts`, numeric attributes that contain expressions use the `ASTNode` type:
- **Kept as `string`**: Non-expression textual attributes (`name`, `type`, `text`, `fontName`, `marks`, `src`, `modes`, `action`)
- **Changed to `ASTNode`**: Mathematical properties (`x`, `y`, `radius`, `angle`, `length`, `width`, `update`, `animSpeed`, `fontSize`, etc.)

### `evalAttr` API

```typescript
export function evalAttr(expr: ASTNode | undefined, env: Environment): number {
    if (!expr) return 0;
    return evaluate(expr, env);
}
```

This is the primary interface for evaluating an expression attribute. Called throughout `renderer.ts` and `animation.ts`.

### Colors

Color attributes can be either hex strings (`#FF0000`) or numeric expressions. The `evalColor` function handles both cases — if the value evaluates to a number, it's interpreted as an RGB integer; if it's a string, it's used directly.

## Init Blocks

Watch XML can contain `<init expr>` blocks that define variables:

```xml
<init expr="cr=136, cr2=114, mainR=cr+18, ..." />
```

These are:
1. Parsed into `ASTNode[]` in `xml-parser.ts` (stored as `watch.initExprs`)
2. Evaluated by `evaluateInit()` in `watch-env.ts` (for Chronometer) or directly via `createAstroEnvironment()` in `astro-env.ts` (for Inspector and other apps) at environment creation time
3. The resulting variable bindings are added to the environment for subsequent expression evaluation

## Key Source Files

| File | Purpose |
|------|---------|
| `src/expr/tokenizer.ts` | Expression tokenizer |
| `src/expr/parser.ts` | Recursive-descent parser → AST |
| `src/expr/evaluator.ts` | AST walker / evaluator. Default environment includes `pi`, planet constants (`Sun`, `Moon`, `Venus`, etc.), and math functions |
| `src/shared/astro-env.ts` | Shared astronomy/calendar/time function registry (~159 functions). `createAstroEnvironment()` factory for non-Chronometer apps |
| `src/watch/watch-env.ts` | Imports `astro-env.ts`, adds Chronometer-specific functions (Terra slots, Kyoto wadokei, Venezia body). `evalAttr()`, `evaluateInit()`, environment creation |
| `src/watch/xml-parser.ts` | `attrExpr()` helper that parses attributes to `ASTNode` |
| `src/watch/types.ts` | `ASTNode` type on part attributes |
| `src/inspector/expr-metadata.ts` | Curated descriptions of all functions/constants for autocomplete and reference panel |

## Related Docs

- [XML Parsing](xml-parsing.md) — How attributes are parsed from XML into `ASTNode`
- [Astronomy](astronomy.md) — Astronomy functions available in the expression environment
- [Animation](animation.md) — How `evalAttr` is called during animation ticks
- [Architecture Overview](architecture-overview.md) — Shared environment architecture and import discipline
