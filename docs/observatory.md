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
├── earth-view.ts          Earth map with day/night terminator
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
| `animSpeed` | Catch-up animation speed in rad/s (default 2.0) |
| `naturalSpeed` | Steady-state sweep speed in rad/s (default 0 = snap-to-target) |
| `currentValue` | Current interpolated value (NaN = don't display) |
| `anim` | AnimatingValue state for smooth interpolation |
| `nextUpdateTime` | performance.now() of next scheduled re-evaluation |
| `pendingSweep` | Phase 2 sweep params (target + duration), or null |
| `linear` | If true, value is not an angle — skip fmod wrapping (see [Earth Map](#earth-map-with-terminator)) |

### Update Scheduling

Values use two scheduling mechanisms:

**Epoch-aligned** (positive `updateInterval`):
- Value re-evaluates at fixed wall-clock boundaries
- Example: `updateInterval: 60` → evaluates at :00, :01, :02, etc.

**Sentinel-based** (negative `updateInterval`):
- Value re-evaluates at astronomical events
- Example: `EC_UPDATE_NEXT_SUNSET` → sunrise hand updates when time crosses sunset
- Planet sentinels use encoding: `EC_UPDATE_NEXT_PLANET_RISE(planet)` / `EC_UPDATE_NEXT_PLANET_SET(planet)`

### Animation Modes

The update pass dispatches to one of three modes:

**1. Snap-to-target** (`naturalSpeed === 0`, most values):
The expression is evaluated at time T and the value animates at `animSpeed`
(default 2.0 rad/s) to A(T). Used for hour/minute hands, sun events,
planet hands, ring stops — anything that just moves to a new position.

**2. Two-phase sweep** (`naturalSpeed > 0`, second hands):
For constant-velocity values that sweep between infrequent updates (e.g.,
second hands updating every 20s). Uses a two-phase algorithm:

- **Phase 1 (catch-up)**: If the hand is more than 0.002 rad from where it
  should be, animate at `animSpeed` (2.0 rad/s) to the point where the hand
  *should be when catch-up finishes* (the correct position advances at
  `naturalSpeed` during catch-up, so `catchUpTime = error / (animSpeed - naturalSpeed)`).
- **Phase 2 (sweep)**: From the catch-up target, sweep at `naturalSpeed` until
  the next update boundary. Phase 2 params are stored in `pendingSweep` and
  picked up by the animate pass when Phase 1 completes.

This handles tab-switch recovery gracefully: the hand catches up at 2 rad/s
then resumes smooth ticking.

**3. Scrub compression** (quantized mode, all values):
During hold-to-scrub, display time jumps by large units per tick. The
compression logic mirrors the watch-face `tickAnimations`:
- Compute ticks until next update boundary: `ceil(displayDelta / displayDeltaPerTick)`
- Real-time budget: `ticksUntilUpdate × TICK_INTERVAL_MS`
- If natural animation duration exceeds the budget, compress to fit

### Value Catalog

| Group | Values | Update | naturalSpeed |
|-------|--------|--------|--------------|
| Clock hands | h24, h12, minute, second | 1–20s | second: 2π/60 |
| Sun events | sunrise, sunset, golden×2, civil×2, nautical×2, astro×2, noon, midnight | Sentinel (rise↔set) | 0 |
| UTC subdial | hour, minute, second | 1–60s | second: 2π/60 |
| Solar subdial | hour, minute, second | 1–60s | second: 2π/60 |
| Sidereal subdial | hour, minute, second | 1–60s | second: 2π/60 |
| Planet hands | saturn, jupiter, mars, earth, venus, mercury, moonOffset | 3600s | 0 |
| Planet rings | 6 × (rise, set, transit, riseValid, setValid, aboveHorizon) | Sentinel (rise↔set) | 0 |
| Sun ring | 14 altitude stops + noon + midnight | Sentinel (rise↔set) | 0 |

### Planet Ring Validity Flags

Planet rings use explicit validity flags rather than `NaN` or `isFinite()` checks.
When a planet doesn't rise or set (polar regions), `dayNightLeafAngle` returns
the transit angle as a fallback — a finite value that would draw a phantom ring
if not gated. Each ring therefore carries three metadata ObsValues:

| ObsValue | Expression | Meaning |
|----------|------------|---------|
| `riseValid` | `dayNightLeafAngleIsRiseSet(pn, 0)` | 1 if planet actually rises, 0 if angle is a transit fallback |
| `setValid` | `dayNightLeafAngleIsRiseSet(pn, 1)` | 1 if planet actually sets, 0 if angle is a transit fallback |
| `aboveHorizon` | `dayNightLeafAngleAboveHorizon(pn, 0)` | 1 if planet is always above horizon (polar summer), 0 if always below |

The ring renderer uses these flags to decide:
- **Both valid**: draw the arc from rise to set (normal case)
- **Invalid + aboveHorizon**: draw a full-circle ring (planet never sets)
- **Invalid + !aboveHorizon**: draw only the planet label (planet never rises)

These values come from the iOS `isRiseSet` and `aboveHorizon` output parameters
of `dayNightLeafAngleForPlanetNumber`, propagated through a compute-once cache
in `astro-env.ts`. See [Astronomy — Planet Rise/Set Cache](astronomy.md#planet-riseset-cache).

### NaN Convention (Sun Ring and Hands)

`NaN` means "don't display this element." Sun event hands (e.g., sunrise in
polar regions) and sun ring altitude stops use NaN to suppress rendering.
Draw functions check `isNaN(value)` before drawing.

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
altitude kinds, they use the actual sunrise/sunset angle ± ε radians, where
ε = 0.001 rad ≈ 0.23 time-minutes (≈ 14 time-seconds):

```
ring1BelowMorn:    sunSpecialAngle(SunRiseMorning) + pi * noonOnTop - ε
ringHalfBelowMorn: sunSpecialAngle(SunRiseMorning) + pi * noonOnTop + ε
```

This ensures the cyan→red boundary aligns closely with the sunrise/sunset
hand, producing a visible color marker. The constant `SUNSET_EPSILON` in
`obs-values.ts` controls this gap width.

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

## Earth Map with Terminator

The earth map shows a Mercator-projection Blue Marble image with a day/night
terminator overlay. It displays the current month's day image, a static night
image (city lights), and a computed twilight mask.

### iOS/Android Reference

| Repo | Key files |
|------|-----------|
| `.esastro-ref/` | `src/ESSunAltitudeTable.cpp` — altitude table generation and interpolation |
| `.esgl-ref/` | `src/ESGLPartEarthMapNightMask.mm`, `src/ESGLPartMoverEarthMapDayImage.mm` — OpenGL rendering |

### Architecture

```
initEarthView()
 ├── loadAltitudeTable()    — decode altitude-table.bin (data URL → Int16 → Float32)
 └── load 12 monthly day images + 1 night image

drawEarthView()  [called per frame]
 ├── Select month image from getNow().getMonth()
 ├── regenerateNightMask()  — only when sslat changes
 │   └── For each pixel: interpolateRowData() → alpha from altitude bands
 └── Composite: night → (day − shifted mask) → observer dot
```

### Altitude Table

The altitude table is a precomputed 3D lookup indexed by:

| Dimension | Steps | Range | Description |
|-----------|-------|-------|-------------|
| Sub-solar latitude | 101 (0–100) | 0° to 24° | Only positive; negative sslat flips the latitude index |
| Map latitude | 150 (0–149) | −90° to +90° | Geographic latitude |
| Altitude offset | 23 (0–22) | 0° to −9° | Sun altitude thresholds (horizon → deep twilight) |

Each entry stores the **longitude offset from the sub-solar meridian** (in
radians) at which the sun reaches that altitude. Values are stored as **Int16
fixed-point** (`value × 32767 / π`) in `src/observatory/data/altitude-table.bin`
(681 KB), generated by `scripts/generate-altitude-table.ts`.

The table was verified against the iOS reference file
`SunAltitudeData-ss101-lat150-alt23-9.dat` — all differences are strictly within
Int16 quantization bounds (see `scripts/compare-altitude-tables.ts`).

### Latitude Flip Logic

The table only stores positive sub-solar latitudes (0° to 24°). For negative
sslat (September–March), the `interpolateRowData()` function:
1. Negates sslat to make it positive
2. Flips the latitude index: `latIdx = LAT_STEPS - mapLatitudeIndex`

This mirrors the iOS `getInterpolatedSSLatIndex()` / `interpolateRowData()`
logic exactly.

### Night Mask Generation

`regenerateNightMask()` creates an OffscreenCanvas where each pixel's alpha
represents night opacity (0 = day, 255 = full night, intermediate = twilight).
The mask is **centered at the sub-solar meridian** and shifted horizontally by
`sslng` during the draw pass.

**Boundary comparisons use strict `<`** (not `<=`). This prevents a 1-pixel
artifact at the sub-solar longitude for polar-night latitudes, where `row[0] = 0`
and `absOffset = 0` would incorrectly match `0 <= 0` → DAY.

### Mask Shift and Wrapping

The mask is drawn twice on the compositing canvas with `destination-out` to
remove day pixels where it's night:

```
dx = round(sslng / 2π × physW)          // integer shift, avoids sub-pixel seam
dx = ((dx % physW) + physW) % physW      // normalize to [0, physW) for overshoot
drawImage(mask, dx, 0)                   // main copy
drawImage(mask, dx - physW, 0)           // wrapped copy (fills left gap)
```

**Three wrapping pitfalls** were discovered during development:
1. **Sub-pixel anti-aliasing**: Fractional `dx` creates semi-transparent edges
   at the seam → fix: round to integer
2. **Animation overshoot**: Angular animation can produce `sslng > 2π` during
   wrap-around, making `dx > physW` → fix: modular normalization
3. **Polar-night center pixel**: `absOffset = 0` matching `row[0] = 0` with `<=`
   → fix: strict `<` comparison

### Linear vs Angular ObsValues

The earth view uses two ObsValues with different animation semantics:

| Value | Expression | `linear` | Why |
|-------|-----------|----------|-----|
| `earthSslat` | `subSolarLatitude()` | `true` | Sun declination is in [−0.41, +0.41] rad — must not be fmod'd to [0, 2π) |
| `earthSslng` | `subSolarLongitude()` | `false` | Longitude wraps at ±π (dateline) — angular animation handles this correctly |

The `linear` flag on ObsValue controls whether `startAnimationRaw()` applies
`fmod` normalization and angular unwrapping. Without it, a declination of
−0.41 rad (December) would become 5.88 rad (336.89°), which the altitude table
interprets as maximum summer.

### Blue Marble Assets

Day images (12 months) and night image are stored in
`src/shared/assets/blue-marble/` — shared between the earth view and the
location panel's mini-map globe (`src/shared/mini-map.ts`).

### Update Scheduling

| Value | Update | Rationale |
|-------|--------|-----------|
| `earthSslat` | Sentinel: `EC_UPDATE_NEXT_SSLAT_CHANGE` | Binary-search for when declination changes by ≥0.1° (slow near solstices, fast near equinoxes) |
| `earthSslng` | 60 seconds | Longitude changes ~1°/4min; 60s is sufficient |

The sslat sentinel (`nextSslatChange` in `animation.ts`) binary-searches within
a ±2 day window to find when the declination changes by more than 0.1° from
its current value. This avoids unnecessary mask regeneration during slow
solstice periods while staying responsive during fast equinox transitions.
