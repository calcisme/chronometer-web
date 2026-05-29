# Observatory

Developer documentation for the Observatory watch face — a custom (non-XML-driven)
watch face that renders an astronomical orrery with clock hands, subdials, planet
hands, rise/set rings, and a sun altitude ring.

## Source Layout

```
src/observatory/
├── observatory-entry.ts   Main tick loop, init, draw orchestration
├── obs-values.ts          Expression-driven value system (ObsValue/ObsValueSet)
├── hand-views.ts          Clock hands + sun event hands + subdial hands
├── planet-hands.ts        Planet hands on the orrery
├── ring-view.ts           Rise/set rings (sun altitude ring + planet arcs)
├── layout.ts              Layout calculations (radii, positions)
└── draw-utils.ts          Shared drawing utilities (circular text, etc.)
```

## ObsValue System

All dynamic elements on the Observatory dial are driven by **ObsValue** objects —
expression-driven values that are parsed once, evaluated on a schedule, and
smoothly animated between updates.

### Architecture

```
tick()
 ├── updateObsValues()   — re-eval expired expressions, start animations
 ├── animateObsValues()  — interpolate all values toward targets
 └── drawFrame()         — renderers read obsValue.currentValue
```

### ObsValue Fields

| Field | Description |
|-------|-------------|
| `name` | Human-readable name for debugging |
| `expr` | Parsed AST (from expression parser) |
| `updateInterval` | Seconds (positive = epoch-aligned, negative = sentinel) |
| `animSpeed` | Animation speed multiplier (default 1.0 = 2 rad/s) |
| `projectTarget` | When true, project animation target to next update time |
| `currentValue` | Current interpolated value (NaN = don't display) |
| `anim` | AnimatingValue state for smooth interpolation |
| `nextUpdateTime` | performance.now() of next scheduled re-evaluation |

### Update Scheduling

Values use two scheduling mechanisms:

**Epoch-aligned** (positive `updateInterval`):
- Value re-evaluates at fixed wall-clock boundaries
- Example: `updateInterval: 60` → evaluates at :00, :01, :02, etc.

**Sentinel-based** (negative `updateInterval`):
- Value re-evaluates at astronomical events
- Example: `EC_UPDATE_NEXT_SUNSET` → sunrise hand updates when time crosses sunset
- Planet sentinels use encoding: `EC_UPDATE_NEXT_PLANET_RISE(planet)` / `EC_UPDATE_NEXT_PLANET_SET(planet)`

### Animation Speed

The `animSpeed` multiplier controls how fast a value animates toward its target:

- **Default (1.0)**: Speed = 2.0 rad/s. Good for snapping to new values quickly
  (e.g., hour/minute hands, noonOnTop toggle, time step).
- **Custom**: Set to match real-world angular velocity. Second hands use
  `π/60` so speed = `2 × π/60 = 2π/60` rad/s — exactly one tick per second.

### Target Projection (`projectTarget`)

For constant-velocity values that animate between infrequent updates (e.g.,
second hands updating every 20s), the expression gives angle A(T) at evaluation
time T. But the animation needs to arrive at A(T+interval) when the next
update fires.

When `projectTarget = true`:
```
target = evaluatedValue + dtToNextUpdate × animSpeed × kECGLAngleAnimationSpeed
```

The math is self-consistent: `startValueAnimation` computes duration as
`delta / speed × 1000`, which naturally recovers the update interval because
`delta = interval × speed`.

**Without** `projectTarget` (or for fast-animation values), the expression is
evaluated at T and the value snaps/transitions quickly to A(T). This is correct
for values where the animation is just "transition to new position" rather than
"sweep at a constant rate."

### Value Catalog

| Group | Values | Update | animSpeed |
|-------|--------|--------|-----------|
| Clock hands | h24, h12, minute, second | 1–20s | 1.0 (second: π/60) |
| Sun events | sunrise, sunset, golden×2, civil×2, nautical×2, astro×2, noon, midnight | Sentinel (rise↔set) | 1.0 |
| UTC subdial | hour, minute, second | 1–60s | 1.0 (second: π/60) |
| Solar subdial | hour, minute, second | 1–60s | 1.0 (second: π/60) |
| Sidereal subdial | hour, minute, second | 1–60s | 1.0 (second: π/60) |
| Planet hands | saturn, jupiter, mars, earth, venus, mercury, moonOffset | 3600s | 1.0 |
| Planet rings | 6 × (rise, set, transit) | Sentinel (rise↔set) | 1.0 |

### NaN Convention

`NaN` means "don't display this element." Sun event hands (e.g., sunrise in
polar regions) and planet rings (never-rising planets) use NaN to suppress
rendering. Draw functions check `isNaN(value)` before drawing.
