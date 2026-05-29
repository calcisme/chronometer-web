# Sun Ring Optimization — Fixed Colors, Animated Positions

## Background

The sun ring is the outermost ring on the Observatory dial, showing a 24-hour altitude-based sky-color gradient. The current implementation computes sun altitude at 200-400+ points per frame using `cachelessPlanetAlt()`, which is the dominant performance bottleneck. This plan replaces that with a conic gradient approach where a small set of **fixed-color stops at animated positions** define the gradient.

## Key Design Insight

The gradient table has color stops at specific altitude thresholds (-30°, -9°, -1°, -0.5°, +1°, +9°, +30°). Instead of computing altitude at every point and mapping to colors, we:

1. Compute **where on the dial** the sun crosses each altitude threshold (morning and evening)
2. Assign each position a **fixed color** from the gradient table
3. Build a **conic gradient** from these color stops
4. The **angular positions are ObsValues** that animate smoothly via the existing system

The gradient table colors serve double duty: they define the sun ring AND the twilight/golden hour hand colors — so the ring will perfectly match the hand positions.

## Proposed Changes

### Astro Environment — New Sun Altitude Kinds

#### [MODIFY] [astro-env.ts](file:///Users/spucci/chronometer-web/src/shared/astro-env.ts)

Extend `SunAltitudeKind` enum with additional altitude thresholds needed by the ring gradient. These go beyond the existing hand altitudes to cover the full gradient range:

| New Kind | Altitude | Color (from gradient table) | Purpose |
|----------|----------|-------|---------|
| `SunRing30AboveMorning/Evening` | +30° | `rgba(230,230,255,1)` pale blue-white | Full daylight boundary |
| `SunRing9AboveMorning/Evening` | +9° | `rgba(255,255,0,1)` yellow | End of golden hour |
| `SunRing1AboveMorning/Evening` | +1° | `rgba(240,107,0,1)` orange | Just above horizon |
| `SunRingHalfBelowMorning/Evening` | -0.5° | `rgba(214,0,0,1)` red | Sunrise/sunset (refraction zone) |
| `SunRing1BelowMorning/Evening` | -1° | `rgba(43,196,214,1)` light cyan | Bright horizon glow |
| `SunRing9BelowMorning/Evening` | -9° | `rgba(0,0,100,1)` dark blue | Deep twilight boundary |
| `SunRing30BelowMorning/Evening` | -30° | `rgba(32,32,32,0)` dark gray | Night boundary |

Add corresponding cases to `getParamsForAltitudeKind()`. Register a new function `sunRingAngle(kind)` in the Observatory environment that wraps `computeSunSpecial24HourAngle` for these kinds.

---

### Solar Noon & Midnight Anchor Points

In addition to the 14 altitude-threshold stops, the ring always includes two anchor points:

- **Solar noon** — angle from `solarNoonAngle()`, at the highest point of the sun's arc
- **Solar midnight** — angle opposite solar noon, at the lowest point of the sun's arc

These anchor points serve two purposes:

1. **Normal latitudes**: They anchor the gradient's extreme colors (pale blue at noon, dark gray at midnight). Even though the adjacent stops (+30° and -30°) usually have the same colors, the anchors make the gradient well-defined across the full circle.

2. **Polar regions**: When some altitude thresholds aren't crossed (e.g., midnight sun never goes below -9°), the NaN stops are skipped. The noon/midnight anchors fill the gap: their **colors are computed from the actual sun altitude** at those times using the gradient table interpolation. For example, during Arctic summer midnight, the sun might be at +5° altitude → the midnight anchor gets an orange-yellow color from `colorForAltitude(+5°)`.

These are separate ObsValues for the angular position, with the color computed at render time (2 calls to `cachelessPlanetAlt` — negligible cost since it only happens at render rebuild, not per-frame).

---

### ObsValue Definitions — Sun Ring Stops

#### [MODIFY] [obs-values.ts](file:///Users/spucci/chronometer-web/src/observatory/obs-values.ts)

Add a new `sunRing` group to `ObsValueSet` containing ~16 ObsValues (14 altitude stops + noon + midnight positions):

```typescript
const sunRing: ObsValueDef[] = [
    // Morning side: update at next sunset (same as existing morning hands)
    { name: 'ring30BelowMorn',   expr: `sunRingAngle(${SK.SunRing30BelowMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },
    { name: 'ring9BelowMorn',    expr: `sunRingAngle(${SK.SunRing9BelowMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
    { name: 'ring1BelowMorn',    expr: `sunRingAngle(${SK.SunRing1BelowMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
    { name: 'ringHalfBelowMorn', expr: `sunRingAngle(${SK.SunRingHalfBelowMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
    { name: 'ring1AboveMorn',    expr: `sunRingAngle(${SK.SunRing1AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
    { name: 'ring9AboveMorn',    expr: `sunRingAngle(${SK.SunRing9AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
    { name: 'ring30AboveMorn',   expr: `sunRingAngle(${SK.SunRing30AboveMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },

    // Evening side: update at next sunrise (same as existing evening hands)
    { name: 'ring30AboveEve',    expr: `sunRingAngle(${SK.SunRing30AboveEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
    { name: 'ring9AboveEve',     expr: `sunRingAngle(${SK.SunRing9AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
    { name: 'ring1AboveEve',     expr: `sunRingAngle(${SK.SunRing1AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
    { name: 'ringHalfBelowEve',  expr: `sunRingAngle(${SK.SunRingHalfBelowEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
    { name: 'ring1BelowEve',     expr: `sunRingAngle(${SK.SunRing1BelowEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
    { name: 'ring9BelowEve',     expr: `sunRingAngle(${SK.SunRing9BelowEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
    { name: 'ring30BelowEve',    expr: `sunRingAngle(${SK.SunRing30BelowEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },

    // Anchor points: update at either event (same as solar noon/midnight hands)
    { name: 'ringNoon',     expr: 'solarNoonAngle() + pi * noonOnTop',     updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
    { name: 'ringMidnight', expr: 'solarNoonAngle() + pi + pi * noonOnTop', updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
];
```

Add `sunRing: ObsValue[]` to `ObsValueSet`. All values independent from existing hand values.

---

### Sun Ring Rendering — Conic Gradient

#### [MODIFY] [ring-view.ts](file:///Users/spucci/chronometer-web/src/observatory/ring-view.ts)

Replace the current `drawSunRing()` with a conic-gradient approach:

**Step 1: Build sorted color stop list**

Read the 16 animated angular positions from `ObsValueSet.sunRing`. For the 14 altitude stops, pair each with its fixed color from the gradient table. Skip any stops with `NaN` angular position (polar regions where the sun doesn't reach that altitude). For the noon/midnight anchors, compute the sun altitude at those times and derive the color via `colorForAltitude()`.

Sort all valid stops by angle.

**Step 2: Create conic gradient**

```typescript
// startAngle = -π/2 so offset 0.0 = 12 o'clock
const grad = ctx.createConicGradient(-Math.PI / 2, cx, cy);
for (const stop of sortedStops) {
    grad.addColorStop(stop.angle / TWO_PI, stop.color);
}
```

**Step 3: Draw single arc**

```typescript
ctx.strokeStyle = grad;
ctx.lineWidth = ringWidth;
ctx.beginPath();
ctx.arc(cx, cy, centerR, 0, TWO_PI);
ctx.stroke();
```

**OffscreenCanvas caching:**

- After rendering, cache to an `OffscreenCanvas`
- On subsequent frames, if no ring values are animating, blit the cached image
- If any ring value has `anim.animating === true`, re-render the gradient from the animated positions (still just 1 draw call — trivially fast)
- This is an optimization for later; start without caching to keep it simple

**Polar region handling:**

When the sun doesn't reach a certain altitude, `sunRingAngle()` returns NaN. The ring renderer skips that stop. The noon and midnight anchor points (which are always valid) fill the gap with their computed colors, so the gradient transitions smoothly through the sun's actual extremes. Examples:
- **Arctic summer (midnight sun)**: -30° and -9° stops are NaN → skipped. Midnight anchor has color for e.g. +5° altitude (orange-yellow). Gradient smoothly transitions from evening twilight → midnight anchor → morning twilight.
- **Antarctic winter (polar night)**: +30° and +9° stops are NaN → skipped. Noon anchor has color for e.g. -15° altitude (dark blue). Gradient smoothly transitions from morning twilight → noon anchor → evening twilight.

---

### Remove Old Sun Ring Code

#### [MODIFY] [ring-view.ts](file:///Users/spucci/chronometer-web/src/observatory/ring-view.ts)

Delete:
- Old `drawSunRing()` function (the per-pixel loop)
- `secondsSinceMidnightForDateInterval()` helper (only used by old sun ring)
- `sunRingCacheCanvas` / `sunRingCacheNoonOnTop` (unused cache variables)

Keep:
- `GRADIENT_STEPS` array and `colorForAltitude()` — used by the new renderer for noon/midnight anchor colors

---

### Documentation

#### [MODIFY] [observatory.md](file:///Users/spucci/chronometer-web/docs/observatory.md)

Add a "Sun Ring" section documenting the conic gradient approach, the relationship between gradient stops and altitude thresholds, and the sentinel-based update schedule.

---

## Animation Behavior

Animation falls out naturally from the existing ObsValue system:

| Trigger | What happens |
|---------|-------------|
| **Normal tick** | All ring values are at targets; cached bitmap blitted (or gradient rendered — cheap either way) |
| **noonOnTop toggle** | `resetObsValueSchedules` fires → all 16 ring angles get new targets (shifted by π) → positions animate smoothly → gradient morphs |
| **DST change** | Same as noonOnTop — angles shift, animation smooths the transition |
| **Sunrise/sunset** | Sentinel fires for morning or evening half → 7 values update → gradient morphs at the transition boundary |
| **Location change** | All values reset → all 16 positions animate to new location's values |

During animation, the ring is re-rendered from the conic gradient each frame (1 draw call with ~16 color stops — trivially fast). OffscreenCanvas caching can be added later as a pure optimization.

## Verification Plan

### Visual
- Compare the new conic gradient ring against the old pixel-by-pixel ring (can render both side-by-side by temporarily enabling the old code)
- Check polar regions (high latitudes) where some stops will be NaN
- Check transition at sunrise/sunset — ensure the gradient transitions look right
- Test noonOnTop toggle animation — ring should smoothly rotate
- Test time stepping (large jumps) — ring should animate to new positions

### Performance
- Measure frame time with and without sun ring (current code is commented out)
- Re-enable the new sun ring and measure — should be negligible cost
