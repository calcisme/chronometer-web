# Inspector

Developer documentation for the Inspector — a live astronomy data explorer and
expression debugger. The Inspector is a standalone app (separate from Chronometer
and Observatory) that provides a real-time view of all expression function
values, useful for debugging watch face expressions and verifying astronomy
calculations.

## Purpose

The Inspector serves two roles:

1. **Debugging tool**: Type any expression from a watch face XML or Observatory
   ObsValue and see its live value — as a number, angle (degrees), and date
   (interpreting the value as a dateInterval). Values update every frame.

2. **Reference**: The Reference panel lists all curated expression functions
   with descriptions and signatures, grouped by category. Clicking an entry
   inserts it into the expression input.

## Source Layout

```
src/inspector/
├── inspector-entry.ts    Main app: time display, expression evaluator, autocomplete, reference panel
├── inspector.html        HTML template with all UI elements
└── expr-metadata.ts      Curated function/constant metadata for autocomplete and reference
```

## Architecture

The Inspector imports only from `src/shared/`, `src/expr/`, and `src/astronomy/`.
It does **not** import from `src/watch/` — this keeps its bundle
(`inspector-engine.js`) free of Chronometer-specific code (renderer, XML parser,
Terra slots, etc.).

```
inspector-entry.ts
  ├── createAstroEnvironment()    ← src/shared/astro-env.ts
  ├── parse() / evaluate()        ← src/expr/
  ├── EXPR_METADATA               ← ./expr-metadata.ts
  └── planetaryRiseSetTimeRefined ← src/astronomy/ (for sunrise/sunset display)
```

The astronomy environment is created with the user's location and timezone,
identical to how Observatory and Chronometer create theirs. All ~160 expression
functions registered by `createAstroEnvironment()` are available for evaluation.

## Main Features

### Time and Sun Display

The top section shows the current time, date, timezone, and today's
sunrise/sunset in the configured location. Sunrise/sunset update once per
minute (they're daily values).

### Expression Evaluator

The expression input accepts any valid expression (same syntax as watch XML
attributes). The result is displayed three ways simultaneously:

| Format | Description |
|--------|-------------|
| Number | Raw numeric value (integer or 10-digit precision) |
| Angle | Value converted to degrees (× 180/π) |
| Date | Value interpreted as a dateInterval (seconds since 2001-01-01T00:00:00Z) |

The expression is **re-parsed only when the text changes** (not every frame).
The AST is cached and re-evaluated every frame against the current environment
to show live-updating values.

### Autocomplete

Typing ≥2 characters shows a dropdown of matching functions/constants from the
curated metadata plus any additional entries from the environment. Matches are
ordered prefix-first, then substring. The dropdown supports keyboard navigation
(↑/↓/Enter/Tab/Escape) and mouse clicks.

Functions not in the curated metadata still appear in autocomplete (from the
live environment), but without descriptions — they show as category "Other".

### Reference Panel

The Reference button toggles a categorized list of all expression functions
and constants. Built lazily on first open from `EXPR_METADATA` merged with
the live environment. Categories are collapsible. Clicking an entry inserts
it into the expression input.

## Expression Metadata (`expr-metadata.ts`)

The curated metadata table drives both autocomplete descriptions and the
reference panel. Each entry has:

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | Function/constant name as used in expressions |
| `category` | `string` | Grouping for the reference panel |
| `desc` | `string` | One-line human-readable description |
| `kind` | `'fn' \| 'const'` | Whether to show parens in autocomplete |
| `sig` | `string?` | Parameter signature, e.g. `'(planet, leaf)'` |

`CATEGORY_ORDER` controls the display order of categories in the reference
panel. Categories not in this list appear at the end.

> [!IMPORTANT]
> This table must be updated whenever expression functions are added or changed.
> See [Development Rules §13](development-rules.md#13-keep-inspector-expression-metadata-in-sync).

### Current Categories

| Category | Contents |
|----------|----------|
| Sun Times | Next/prev/today sunrise, sunset, solar noon |
| Moon Times | Next/prev/today moonrise, moonset, moon transit |
| Planet Times | Next/prev/today rise, set, transit for any planet |
| Sun Position | Altitude, azimuth, RA, declination, ecliptic longitude |
| Moon Position | Altitude, azimuth, age angle, relative angle |
| Clock | Hour, minute, second, day/month/year, timezone |
| Astronomical | Sidereal time, Julian day, equation of time, precession |
| Day/Night Ring | Rise/set angles, leaf angles, polar detection, transit angles |
| Planet Constants | Sun(0), Moon(1), Mercury(2), ..., Pluto(10) |
| Math Constants | pi, true, false |
| Math | sin, cos, atan2, sqrt, abs, floor, ceil, fmod, etc. |

## Location

The Inspector uses the same location system as Chronometer — URL parameters
(`lat`, `lon`, `tz`, `city`, `bloc`) and the shared location dialog
(`src/shared/location-dialog.ts`). Location changes rebuild the astronomy
environment and refresh all displays.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/inspector/inspector-entry.ts` | Main app: tick loop, expression evaluator, autocomplete, reference panel |
| `src/inspector/inspector.html` | HTML template |
| `src/inspector/expr-metadata.ts` | Curated function/constant metadata |
| `src/shared/astro-env.ts` | Astronomy environment factory (shared with Chronometer and Observatory) |
| `src/expr/parser.ts` | Expression parser |
| `src/expr/evaluator.ts` | Expression evaluator |

## Related Docs

- [Expressions](expressions.md) — Expression language syntax and pipeline
- [Astronomy](astronomy.md) — Astronomy functions available in the environment
- [Development Rules §13](development-rules.md#13-keep-inspector-expression-metadata-in-sync) — Keep metadata in sync
- [Architecture Overview](architecture-overview.md) — Import boundaries between apps
