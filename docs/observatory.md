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
| Sun ring | 14 altitude stops + noon + midnight | Sentinel (rise↔set) | 1.0 |

### NaN Convention

`NaN` means "don't display this element." Sun event hands (e.g., sunrise in
polar regions) and planet rings (never-rising planets) use NaN to suppress
rendering. Draw functions check `isNaN(value)` before drawing.

Sun ring altitude stops also use NaN — if the sun never reaches a given
altitude (e.g., -18° during polar summer), that gradient stop is skipped
and the conic gradient interpolates between adjacent valid stops.

## Sun Ring

The outermost ring on the Observatory dial shows a 24-hour sky-color gradient
based on sun altitude. It uses a **conic gradient with fixed colors at animated
positions** — a design that naturally supports smooth animation during
noonOnTop toggles, DST transitions, and location changes.

### Architecture

Instead of computing sun altitude at 200-400 points per frame (the old approach),
the sun ring defines a small set of **color stops** at specific altitude
thresholds. Each stop has:

- A **fixed color** from the gradient table (e.g., red at sunrise, dark blue at
  nautical twilight)
- An **animated angular position** (an ObsValue tracking where on the 24h dial
  the sun crosses that altitude)

The conic gradient API (`createConicGradient`) interpolates smoothly between
stops, producing the continuous color ring with a single draw call.

### Color Stops

| Index | Position | Color | Description |
|-------|----------|-------|-------------|
| 0, 13 | -18° altitude | Dark gray `(32,32,32)` | Astronomical twilight boundary (full night) |
| 1, 12 | -9° altitude | Dark blue `(0,0,100)` | Deep twilight |
| 2, 11 | sunrise/set − ε | Light cyan `(43,196,214)` | Night side of sunrise/sunset hand |
| 3, 10 | sunrise/set + ε | Red `(214,0,0)` | Day side of sunrise/sunset hand |
| 4, 9 | +1° altitude | Orange `(240,107,0)` | Just above horizon |
| 5, 8 | +9° altitude | Yellow `(255,255,0)` | Golden hour |
| 6, 7 | +30° altitude | Pale blue-white `(230,230,255)` | Full daylight |
| 14 | solar noon | *computed* | Color from altitude at solar noon |
| 15 | solar midnight | *computed* | Color from altitude at solar midnight |

Indices 0–6 are the morning side (night→day), 7–13 are the evening side
(day→night). Each morning/evening pair at the same position has the same
fixed color.

### Sunrise/Sunset Boundary

Stops 2/3 (morning) and 10/11 (evening) create an **abrupt color transition**
at the sunrise/sunset hand. Instead of computing positions from separate
altitude kinds, they use the actual sunrise/sunset angle ± 0.001 radians:

```
ring1BelowMorn:    sunSpecialAngle(SunRiseMorning) + pi * noonOnTop - 0.001
ringHalfBelowMorn: sunSpecialAngle(SunRiseMorning) + pi * noonOnTop + 0.001
```

This ensures the cyan→red boundary aligns exactly with the sunrise/sunset
hand, producing a sharp visual marker.

### Noon/Midnight Anchors

The noon and midnight anchors always exist (their positions never become NaN).
Their colors are **computed at render time** from the actual sun altitude at
solar noon/midnight, with alpha forced to 1 (the original iOS gradient table
used alpha=0 for deep night, but the conic gradient ring is always opaque).

This is critical for polar regions:

- **Polar summer**: The midnight sun might be at +5° altitude → midnight anchor
  gets orange-yellow. The -18° and -9° stops are NaN (skipped), so the gradient
  smoothly transitions through the computed color at midnight.
- **Polar winter**: The noon sun might be at -15° altitude → noon anchor gets
  deep blue. The +30° and +9° stops are NaN (skipped).

### Conic Gradient Wrap

Canvas conic gradients clamp at the 0/1 offset boundary rather than wrapping.
Since the first and last stops straddle this boundary (both in the deep-night
region), the renderer computes an **interpolated boundary color** at offset
0.0 and 1.0 to create a seamless join:

```
gapSize = (1 - lastOffset) + firstOffset
frac = (1 - lastOffset) / gapSize
boundaryColor = lerp(lastStop.color, firstStop.color, frac)
```

### Update Schedule

All stops use sentinel-based scheduling, matching the existing twilight hands:

| Stops | Sentinel | Rationale |
|-------|----------|-----------|
| Morning (indices 0–6) | `EC_UPDATE_NEXT_SUNSET` | Morning values change when today's sunset passes |
| Evening (indices 7–13) | `EC_UPDATE_NEXT_SUNRISE` | Evening values change when today's sunrise passes |
| Noon, Midnight | `EC_UPDATE_NEXT_SUNRISE_OR_SUNSET` | Anchor colors change at either event |

### Performance

- **Per frame**: 1 conic gradient draw call (16 color stops, hardware-accelerated)
- **Per sentinel event**: 7 expression evaluations + 2 altitude computations
  (noon/midnight anchors) — runs once per sunrise/sunset
- **Old approach**: 200-400+ `cachelessPlanetAlt` calls per frame = eliminated
