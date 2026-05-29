# Observatory Expression-Driven Value System (v2)

Replace the current inline computation in `drawClockHands`, `drawSubdialHands`, `drawPlanetHands`, and `drawRiseSetRings` with a unified value system modeled on the watch face `HandState` / `AnimatingValue` architecture. Each dynamic value gets a parsed AST expression, an update interval (including negative sentinels for astro events), and a next-update time — so expensive astronomy computations only run when their values actually change.

## Background

### Current Problem
Every `requestAnimationFrame` tick (~60fps) recomputes everything:
- 10 `computeSunSpecial24HourAngle` calls (iterative astronomy with two-step search)
- 6 planet ring rise/set/transit computations (each doing refined rise/set searches)
- 6 heliocentric longitude computations
- All clock hand angles, subdial angles, sidereal time, EOT, etc.

Some of these have ad-hoc caching (planet hands cache angles for 1 hour, rings have a 1-hour cache), but the approach is inconsistent and doesn't support the update sentinels (e.g., "update at next sunrise") that the watch faces use.

### Watch Face Model (what we're extending)
The watch face system ([animation.ts](file:///Users/spucci/chronometer-web/src/shared/animation.ts)) works as:
1. **Parse**: XML attribute strings → `ASTNode` (at load time via `parse()`)
2. **HandState**: Holds `{ part, angle: AnimatingValue, updateIntervalMs, nextUpdateDisplayTime }`
3. **Update pass** (`tickAnimations`): For each state where `now >= nextUpdateTime`, re-evaluate the AST → set new target → compute next boundary
4. **Animation pass** (same function): Interpolate `AnimatingValue.currentValue` toward target
5. **Draw pass**: Renderer reads `part.dynamicState.currentAngle`

We will adapt this for Observatory, but Observatory values are not always angles and don't always need angle-wrapping — many are just numbers (rise/set angles, transit times, heliocentric longitudes).

## Key Design Decisions

### 1. All values animate — no exceptions
Every dynamic `ObsValue` has an `AnimatingValue`. This ensures smooth transitions everywhere — critical for future time-controller scrubbing, and gives free animation on noonOnTop toggle. There is no `anim: AnimatingValue | null` — it's always present.

### 2. No update interval less than 1 second
Even second hands don't need every-frame re-evaluation. Instead, second hands update once per second and set their animation rate so the hand sweeps smoothly through that second to its next position. The animation system handles the between-frame interpolation.

This means `updateInterval = 0` (every frame) is never used.

### 3. noonOnTop baked into expressions
The `noonOnTop` toggle is exposed as an environment variable (`noonOnTop` = 0 or 1). Expressions that need it include `+ pi * noonOnTop` directly. When the toggle changes:
1. Set the env variable
2. Reset all affected value schedules (`nextUpdateTime = 0`)
3. Values re-evaluate on the next frame and the animation system smoothly interpolates to the new angles

No re-parsing needed — just re-evaluation.

### 4. Reuse existing env functions where possible
Don't duplicate or modify existing functions in `astro-env.ts` without consulting the user. New general-purpose astronomy functions (applicable beyond Observatory) go in `astro-env.ts`. Only truly Observatory-layout-specific functions (e.g., computing sizes for dial elements) would go in `observatory-env.ts`.

### 5. Sun ring: keep current code as-is
The sun ring is a pixel-sampled gradient (~1200 altitude points), fundamentally different from simple values. It will eventually need optimization for 120fps rendering, but that's a separate concern. For now, keep the existing sun ring code unchanged.

### 6. Future: stop-time optimization
Once the time controller is fully integrated, we should stop requesting animation frames when time is stopped (no `requestAnimationFrame` call until restart or step). Not implementing now, but the architecture should support it — the `anyAnimating()` check from the watch system is the model.

## Proposed Data Structures

### `ObsValue` — the core unit

```typescript
/** A single dynamic value in the Observatory. */
interface ObsValue {
    /** Human-readable name for debugging (e.g., "sunriseAngle", "saturnHLong") */
    name: string;

    /** Parsed AST for computing this value's current target. */
    expr: ASTNode;

    /** Update interval in seconds.
     *  Positive: epoch-aligned boundary (e.g., 3600 = hourly, 1 = per second).
     *  Negative: sentinel (e.g., EC_UPDATE_NEXT_SUNRISE, or new
     *            EC_UPDATE_NEXT_SOLAR_SECOND / EC_UPDATE_NEXT_SIDEREAL_SECOND).
     *  Never 0 — minimum is 1. */
    updateInterval: number;

    /** Current computed value. NaN = "don't display this element". */
    currentValue: number;

    /** Animation state — always present, all values animate. */
    anim: AnimatingValue;

    /** Display-time ms-since-epoch of the next scheduled update. */
    nextUpdateDisplayTime: number;

    /** performance.now() at which the next update should fire. */
    nextUpdateTime: number;
}
```

### `ObsPart` — a drawable element with one or more values

```typescript
/** A drawable element (hand, ring, planet, etc.) with its associated values. */
interface ObsPart {
    /** Part type for the draw pass to dispatch on. */
    type: 'clockHand' | 'subdialHand' | 'planetHand' | 'planetRing';

    /** Drawing parameters (colors, lengths, etc. — static after init). */
    drawParams: Record<string, unknown>;

    /** The dynamic values this part depends on. */
    values: ObsValue[];
}
```

### Value catalog with update intervals

| Element | Values | Update | Expression |
|---|---|---|---|
| **Main dial clock hands** | | | |
| 24h hand | 1 (angle) | 15s | `fmod(hour24Value(), 24) * 2*pi/24 + pi*noonOnTop` |
| 12h Breguet hand | 1 (angle) | 1s | `hour12ValueAngle()` |
| Minute hand | 1 (angle) | 1s | `minuteValueAngle()` |
| Second hand | 1 (angle) | 1s | `secondValueAngle()` |
| **Sun event hands** | | | |
| Sunrise hand | 1 (angle) | 3600s | `sunSpecialAngle(0) + pi*noonOnTop` |
| Sunset hand | 1 (angle) | 3600s | `sunSpecialAngle(1) + pi*noonOnTop` |
| Golden hour × 2 | 1 each | 3600s | `sunSpecialAngle(6) + pi*noonOnTop`, etc. |
| Twilight × 6 | 1 each | 3600s | `sunSpecialAngle(2..5, 8..9) + pi*noonOnTop` |
| Solar noon | 1 (angle) | 3600s | `solarNoonAngle() + pi*noonOnTop` |
| Solar midnight | 1 (angle) | 3600s | `solarNoonAngle() + pi + pi*noonOnTop` |
| **UTC subdial** | | | |
| UTC hour | 1 (angle) | 60s | `fmod((hour24Value() - tzOffset()/3600), 24) * 2*pi/24` |
| UTC minute | 1 (angle) | 15s | `utcMinuteAngle()` |
| UTC second | 1 (angle) | 1s | `utcSecondAngle()` |
| **Solar subdial** | | | |
| Solar hour | 1 (angle) | 60s | `fmod(solarTimeSec()/3600, 12) * 2*pi/12` |
| Solar minute | 1 (angle) | 15s | `fmod(solarTimeSec()/60, 60) * 2*pi/60` |
| Solar second | 1 (angle) | new sentinel† | `fmod(solarTimeSec(), 60) * 2*pi/60` |
| **Sidereal subdial** | | | |
| Sidereal hour | 1 (angle) | 60s | `fmod(lstSec()/3600, 24) * 2*pi/24` |
| Sidereal minute | 1 (angle) | 15s | `fmod(lstSec()/60, 60) * 2*pi/60` |
| Sidereal second | 1 (angle) | new sentinel† | `fmod(lstSec(), 60) * 2*pi/60` |
| **Planets** | | | |
| Saturn hand | 1 (hLong) | 3600s | `-HLongitudeOfPlanet(7)` |
| Jupiter–Mercury hands | 1 each | 3600s | `-HLongitudeOfPlanet(n)` |
| Moon (Earth sub-hand) | 1 (offset) | 3600s | `-moonAgeAngle() + pi` |
| **Planet rings** | | | |
| Saturn ring | 5 | 3600s | `dayNightLeafAngle(7,0,0)`, `dayNightLeafAngle(7,1,0)`, `planetTransitAngle(7)`, rise/set valid flags |
| Other rings × 5 | 5 each | 3600s | Same pattern per planet |
| **Sun ring** | N/A | 3600s | **Kept as separate cache — not part of ObsValue system** |

> † **Solar/sidereal second hands**: Use a simple `updateInterval = 1` (1 clock second) for both solar and sidereal second hands initially. The animation system will smooth the hand sweep across each second. The sidereal second is ~0.997 clock seconds and the solar second varies slightly with EOT — both are close enough to 1s that any boundary glitch should be imperceptible. If visual evaluation reveals a noticeable speed artifact at the tick boundary, we'll revisit with true sentinel-based computation (e.g., `EC_UPDATE_NEXT_SIDEREAL_SECOND` using `1 / 1.00273790935` clock seconds).

## New Environment Functions

### In `astro-env.ts` (general-purpose additions)

These are all generally useful astronomy/time functions, not Observatory-specific:

| Function | Returns | Notes |
|---|---|---|
| `sunSpecialAngle(kind)` | 24h dial angle (radians), or NaN if invalid | Port of `sunSpecial24HourIndicatorAngleForAltitudeKind`. Currently only called as inline code; needs to be registered as an env function. Kind: 0=sunrise, 1=sunset, 2-5=twilight morning/evening, 6-7=golden hour, 8-9=astro twilight. |
| `solarNoonAngle()` | 24h dial angle of solar transit | `angle24HourForDate(planettransitTimeRefined(..., Sun, ...))` |
| `solarTimeSec()` | Local apparent solar time in seconds since midnight | `secSinceMidnight + lon*86400/2π - tzOffset + EOTSeconds` |
| `lstSec()` | Already exists as `lstValue()` | Reuse directly |
| `planetTransitAngle(planet)` | 24h dial angle of planet transit | `angle24HourForDate(planettransitTimeRefined(..., planet, ...))` |
| `utcMinuteAngle()` | UTC minute hand angle | `fmod((minuteValue - tzOffsetMinutes), 60) * 2π/60` |
| `utcSecondAngle()` | UTC second hand angle | Same as local second (tz offset is whole minutes) |
| `tzOffset()` | Timezone offset in seconds | Already available as `env.tzOffsetSec`, but may need as callable function for expressions |

Functions we can **reuse as-is**:
- `hour24Value()`, `hour24ValueAngle()`, `hour12ValueAngle()`, `minuteValueAngle()`, `secondValueAngle()`
- `HLongitudeOfPlanet(n)`, `moonAgeAngle()`
- `dayNightLeafAngle(planet, leaf, numLeaves)`
- `lstValue()` (= `lstSec()`)
- `EOTSeconds()`
- `fmod()` (already a parser builtin)

### In `src/observatory/observatory-env.ts` (if needed)

Only for truly Observatory-layout-specific calculations (e.g., computing drawing sizes that depend on the dial geometry). Currently no such functions are identified — we may not need this file at all.

## Expression Strings

Each value's expression is a string parsed into an AST at initialization:

```
// Clock hands
"fmod(hour24Value(), 24) * 2*pi/24 + pi*noonOnTop"    // 24h hand
"hour12ValueAngle()"                                     // 12h hand
"minuteValueAngle()"                                     // minute
"secondValueAngle()"                                     // second

// Sun events (NaN if invalid → element hidden)
"sunSpecialAngle(0) + pi*noonOnTop"                     // sunrise
"sunSpecialAngle(1) + pi*noonOnTop"                     // sunset
"solarNoonAngle() + pi*noonOnTop"                       // solar noon
"solarNoonAngle() + pi + pi*noonOnTop"                  // solar midnight

// Planet hands
"-HLongitudeOfPlanet(7)"                                // Saturn
"-moonAgeAngle() + pi"                                  // Moon offset

// Planet rings
"dayNightLeafAngle(7, 0, 0)"                            // Saturn rise
"dayNightLeafAngle(7, 1, 0)"                            // Saturn set
"planetTransitAngle(7)"                                  // Saturn transit

// UTC subdial
"fmod((hour24Value() - tzOffset()/3600), 24) * 2*pi/24" // UTC hour
"utcMinuteAngle()"                                       // UTC minute
"utcSecondAngle()"                                       // UTC second

// Solar subdial
"fmod(solarTimeSec()/3600, 12) * 2*pi/12"              // Solar hour
"fmod(solarTimeSec()/60, 60) * 2*pi/60"                // Solar minute
"fmod(solarTimeSec(), 60) * 2*pi/60"                    // Solar second

// Sidereal subdial
"fmod(lstValue()/3600, 24) * 2*pi/24"                  // Sidereal hour
"fmod(lstValue()/60, 60) * 2*pi/60"                    // Sidereal minute
"fmod(lstValue(), 60) * 2*pi/60"                       // Sidereal second
```

The `noonOnTop` environment variable (0 or 1) is set when the toggle changes. Expressions using it naturally re-evaluate to include the π offset, and the animation system smoothly interpolates to the new position.

## Update/Animation Architecture

### Three-pass frame loop

```typescript
function tick(): void {
    timeController.checkTick(performance.now());
    timeController.beginFrame();
    
    const perfNow = performance.now();
    
    // Pass 1: UPDATE — re-evaluate expressions whose timer has expired
    updateObsValues(allValues, env, perfNow);
    
    // Pass 2: ANIMATE — interpolate all AnimatingValues toward targets
    animateObsValues(allValues, perfNow);
    
    // Pass 3: DRAW — render using currentValue from each ObsValue
    drawFrame();
    
    timeController.endFrame();
    
    // Future: only request next frame if time is running or animations in flight
    requestAnimationFrame(tick);
}
```

### Pass 1: Update

```typescript
function updateObsValues(values: ObsValue[], env: Environment, now: number): void {
    for (const v of values) {
        if (now >= v.nextUpdateTime) {
            const newVal = evalAttr(v.expr, env);
            
            // Set new animation target — interpolation handles the rest
            startAnimationRaw(v.anim, newVal, now, /* animSpeed */ 1.0);
            
            // Schedule next update
            const nextDisplayMs = computeNextBoundary(
                v.updateInterval * 1000, getNow, 1, env
            );
            v.nextUpdateDisplayTime = nextDisplayMs;
            v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);
        }
    }
}
```

### Pass 2: Animate

For every value, call `interpolateValue(v.anim, perfNow)` and write to `v.currentValue`. This reuses the existing animation infrastructure from `animation.ts`.

### Pass 3: Draw

The existing `drawClockHands`, `drawSubdialHands`, etc. read from `ObsValue.currentValue` instead of computing inline:

```typescript
// Before:
const h24Angle = fmod(secSinceMidnight / 3600, 24) * TWO_PI / 24 + noonOffset;
drawArrowHand(ctx, mainCX, mainCY, h24Angle, ...);

// After:
const h24Angle = obsValues.h24Hand.currentValue;  // noonOnTop already in expression
drawArrowHand(ctx, mainCX, mainCY, h24Angle, ...);
```

## Proposed Changes

### [MODIFY] `src/shared/astro-env.ts`

Register new general-purpose functions (without modifying existing ones):
- `sunSpecialAngle(kind)`: wraps `computeSunSpecial24HourAngle`, returns angle or NaN
- `solarNoonAngle()`: transit angle on the 24h dial
- `solarTimeSec()`: local apparent solar time in seconds
- `planetTransitAngle(planet)`: transit angle for any planet
- `utcMinuteAngle()`, `utcSecondAngle()`: UTC time hand angles
- `tzOffset()`: timezone offset in seconds as callable function
- `noonOnTop`: environment variable (0 or 1)

### [NEW] `src/observatory/obs-values.ts`

Core value system:
- `ObsValue` and `ObsPart` interfaces
- `initObsValues(env)`: Create all values, parse expression strings, evaluate initial values, set up `AnimatingValue`s
- `updateObsValues(values, env, perfNow)`: Update pass — re-evaluate expired values
- `animateObsValues(values, perfNow)`: Animation pass — interpolate all `AnimatingValue`s
- Helper: thread through all values for efficient iteration
- Reuses `computeNextBoundary`, `displayTimeToPerfNow`, `interpolateValue`, `startAnimationRaw` from `animation.ts` — these may need to be exported if not already

### [MODIFY] `src/shared/animation.ts`

Export any internal helpers needed by `obs-values.ts`:
- `computeNextBoundary` (currently not exported)
- `displayTimeToPerfNow` (currently not exported)
- New sentinel constants: `EC_UPDATE_NEXT_SOLAR_SECOND`, `EC_UPDATE_NEXT_SIDEREAL_SECOND`

### [MODIFY] `src/observatory/hand-views.ts`

- `drawClockHands()` and `drawSubdialHands()` change to read from `ObsValue.currentValue`
- Remove all inline angle computation code
- Remove imports of astronomy functions (`computeSunSpecial24HourAngle`, `planettransitTimeRefined`, `localSiderealTime`, `EOTSeconds`)
- NaN check: if `obsValue.currentValue` is NaN, skip drawing that hand

### [MODIFY] `src/observatory/planet-hands.ts`

- Remove inline `updateAngles()` caching
- Read planet heliocentric longitudes and moon angle from `ObsValue`s

### [MODIFY] `src/observatory/ring-view.ts`

- Planet ring rise/set/transit angles read from `ObsValue`s
- Remove inline ring cache management for planet rings
- **Sun ring**: Keep unchanged (stays as separate pixel-sampling cache)

### [MODIFY] `src/observatory/observatory-entry.ts`

- Call `initObsValues(env)` at startup
- Add update + animate passes before draw in `tick()`
- Pass values to draw functions
- On noonOnTop toggle: set env variable + reset value schedules
- Remove the per-frame `AstroCachePool` init/release (no longer needed — astronomy is done in update pass only)

---

## Verification Plan

### Build
- `npx tsc --noEmit` — no type errors
- `bash build.sh` — clean build

### Visual
- All hands show identical angles to the current (pre-refactor) code
- Second hands sweep smoothly (animation-interpolated between 1s updates)
- Sunrise/sunset hands hide when invalid (NaN)
- Planet rings show correct arcs
- noonOnTop toggle smoothly animates all 24h-related hands

### Performance
- Profile before/after: `computeSunSpecial24HourAngle` calls drop from ~60/s to ~1/3600s
- `HLongitudeOfPlanet` calls: from ~360/s (6 planets × 60fps) to ~6/3600s
- Frame time should be significantly lower

## Phased Rollout

> [!NOTE]
> This refactor touches many files. Suggested order to minimize risk:

1. **Phase A — Infrastructure**: Create `obs-values.ts` with types + init + update + animate. Register new env functions in `astro-env.ts`. Wire into `observatory-entry.ts` tick loop (update + animate passes run alongside the old inline code). Add `noonOnTop` env variable. Verify computed values match inline code.

2. **Phase B — Clock hands**: Convert main dial clock hands and sun event hands to read from `ObsValue`s. Remove inline computation from `hand-views.ts`. Verify visually.

3. **Phase C — Subdial hands**: Convert subdial hands. Remove inline computation. Verify solar/sidereal second hand cadence.

4. **Phase D — Planets**: Convert planet hands to read from `ObsValue`s. Remove inline caching from `planet-hands.ts`.

5. **Phase E — Planet rings**: Convert planet ring rise/set/transit angles. Remove inline ring cache. Sun ring stays unchanged.
