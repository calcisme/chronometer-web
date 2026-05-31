# Animation

The animation system manages how watch hands move between their computed positions, supporting both real-time ticking and accelerated time scrubbing.

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.chronometer-ref/` | `Classes/ECGLPart.m` (animation interpolation, `kECGLAngleAnimationSpeed`), `Classes/ECWatchController.m` (update scheduling) |

## `beatsPerSecond` — Time Quantization

Each watch declares `beatsPerSecond` on its `<watch>` element. This controls the granularity of the time that expressions see, mirroring the behavior of a physical watch mechanism:

| `beatsPerSecond` | Effect | Faces |
|---|---|---|
| `0` | No quantization — fully continuous sweep | Firenze, Chandra, Miami, Venezia, Selene |
| `1` | Snap to whole seconds — tick-tick second hand | Babylon, Haleakala, Hana |
| `8` | Snap to 1/8 s — smooth sweep at 8 Hz | Terra, Gaia |
| `10` | Snap to 1/10 s — smooth sweep at 10 Hz | Geneva, Basel, Mauna Kea |

The default is `0` (continuous), matching iOS (`ECWatchDefinitionManager.m`, `df:0`).

**Implementation**: `makeGetNow(bps)` in `engine-entry.ts` wraps the raw `timeController.getDisplayTime()` with quantization, mirroring iOS `latchTimeForBeatsPerSecond`:
```typescript
const quantizedMs = Math.round(ms / 1000 * bps) / bps * 1000;
```
Each face gets its own quantized `getNow` closure, passed to `createWatchEnvironment` (for expression evaluation) and as the `getNow` parameter of `initHandStates`. A separate **unquantized** `rawGetNow` is also passed to `initHandStates` for boundary scheduling (see below).

> [!IMPORTANT]
> **Boundary scheduling must use raw (unquantized) time.** The quantized `getNow` is only for expression evaluation — determining *what* angle a hand should show. The `rawGetNow` is used by `computeNextBoundary` and `displayTimeToPerfNow` to determine *when* the next update fires. This matches the iOS architecture where `ECDynamicUpdate.getNextUpdateTimeForInterval` computes boundaries in "iPhone time" (real device time), not in latched/quantized watch time.
>
> **Why this matters**: With `bps=1`, `Math.round` snaps the displayed time to the nearest whole second, which can be up to 0.5s ahead of real time. If `computeNextBoundary` uses this quantized time, `Math.ceil` of an already-aligned value returns the current time (not the next boundary), producing a zero delta and causing every-frame re-evaluation. The hand then ticks 0.5s before faces with `bps=0`, creating visible inter-face skew.

## Two-Time-Base Architecture

The system uses two independent time bases:

| Time Base | Source | Used For |
|-----------|--------|----------|
| **Display time** | `getNow()` → `makeGetNow(bps)` → `timeController.getDisplayTime()` | Evaluating angle expressions — determines **what** the target position should be |
| **Real time** | `performance.now()` | Animation interpolation — determines **where** the hand is drawn right now |

These must never be conflated. Display time can jump by hours/days per tick; real time always advances smoothly at 1:1.

## Core Types

```typescript
interface AnimatingValue {
    currentValue: number;       // What we render right now
    targetValue: number;        // Where we're heading
    lastAnimationTime: number;  // performance.now() at last interpolation step
    animationStopTime: number;  // When animation should be complete
    animating: boolean;         // Is an animation in progress?
}

interface HandState {
    part: QHandPart | WheelPart | QWedgePart;
    angle: AnimatingValue;
    offsetAngle: AnimatingValue | null;   // For orbit hands (e.g. Moon)
    xMotion: AnimatingValue | null;       // Linear X translation (calendar wires)
    yMotion: AnimatingValue | null;       // Linear Y translation (calendar wires)
    updateIntervalMs: number;             // From XML update attr
    nextUpdateTime: number;               // performance.now() for next re-eval
    animSpeed: number;                    // From XML animSpeed attr (default 1.0)
    getNow: () => Date;                   // Display time source (quantized) — for expressions
    rawGetNow: () => Date;                // Unquantized time — for boundary scheduling
}
```

## Update Interval (`update` attribute)

Controls **how often** a hand's angle expression is re-evaluated:

| Example | Meaning |
|---------|---------|
| `update="1"` | Every 1 second (second hand, sun/moon hands) |
| `update="60"` | Every 60 seconds (hour hand, AM/PM wheel) |
| `update="1/60"` | 60× per second (subsecond smooth sweep) |
| `update="1 * days()"` | Once per day (date/month/weekday wheels) |
| No `update` | Defaults to `1/beatsPerSecond` |

Updates fire on **local-time-aligned clock boundaries**, not relative to page load. The alignment formula shifts by the watch's timezone offset (iOS: `ECDynamicUpdate.m` line 192), so a daily update (`1 * days()`) fires at **local midnight**, not UTC midnight.

**Sentinel-based scheduling**: Named sentinel values (e.g., `updateAtNextSunriseOrMidnight`) compute the true next astronomical event time (sunrise, sunset, moonrise, moonset) in display time and schedule the part to re-evaluate at that boundary. The `OrMidnight` variants clamp the event time to the next local midnight, so the part updates at whichever comes first. This works correctly in forward, backward (-1×), and quantized (scrubbing) modes. See `computeNextBoundary()` and `resolveSentinel()` in `animation.ts`.

## Animation Speed (`animSpeed` attribute)

Controls **how** the hand moves to its new position:

- `animSpeed="0"` or absent → snap instantly
- `animSpeed="2.0"` → animate at 2× base speed
- Default is `1.0` if not specified

The animation is **linear interpolation**: although the per-frame code updates `lastAnimationTime` and uses `(target - current) * fraction`, the math works out to constant per-frame displacement since remaining time and remaining distance decrease proportionally.

### Animation Direction (`animationDir`)

For circular values, controls which direction to sweep:
- `ECAnimationDirClosest` (default) — shortest path
- `ECAnimationDirAlwaysCW` — always clockwise
- `ECAnimationDirAlwaysCCW` — always counter-clockwise
- `ECAnimationDirFurthest` — long way around

### Wrap-Around Handling

`startAnimationRaw` normalizes targets to `[0, 2π)` and unwraps `currentValue` so the delta is in `[-π, π]`:

```typescript
let delta = newTarget - val.currentValue;
delta = delta - TWO_PI * Math.round(delta / TWO_PI);  // normalize to [-π, π]
val.currentValue = newTarget - delta;  // unwrap so animation goes shortest path
```

## Modes of Operation

### 1× Mode (Normal / Real Time) and -1× Mode (Reverse)

- `tickIntervalMs = null`
- Expressions re-evaluate at local-time-aligned boundaries
- Animations use natural speed (`kECGLAngleAnimationSpeed × animSpeed`)
- No compression logic
- Both directions use the same idle-timeout scheduler; `nextAlignedUpdate()` is direction-aware, using `Math.ceil` (forward) or `Math.floor` (backward) to find the next boundary in the direction time is flowing

### Quantized Mode (Scrubbing / Accelerated)

Used for hold-to-scrub at rates like 10 hr/s, 10 day/s:

- Display time jumps in fixed steps on each tick (10 Hz tick rate, 100ms intervals)
- **Adaptive compression**: If natural animation duration exceeds the tick interval, compress to fit. Otherwise, use natural speed.
- **Independent compression**: `angle`, `offsetAngle`, `xMotion`, and `yMotion` are all compressed independently
- **Schedule skipping**: Slow-updating parts skip ticks where their expression wouldn't change

**Decision rule** for each hand update:
1. `ticksUntilUpdate = ceil(part.updateIntervalSec / displayDeltaPerTick)`
2. `timeUntilNextUpdate = ticksUntilUpdate × TICK_INTERVAL_MS`
3. `normalDuration = delta / (speed × animSpeed)` — where speed is angular or linear
4. If `normalDuration ≤ timeUntilNextUpdate` → use normal speed
5. If `normalDuration > timeUntilNextUpdate` → compress to `timeUntilNextUpdate`

### Single-Step Mode

- Triggered by a single tap on a step button
- **Stops time first** (`timeController.stop()`) and snaps in-flight animations (`finishAllAnimations()`), matching scrub behavior
- Then calls `timeController.step()`, `resetHandSchedules`, and `tickAnimations` once
- Animations use natural speed (no compression)
- `ensureSchedulerRunning()` keeps the rAF loop running while `anyAnimating` is true

### Astro Step Mode

- Triggered by tapping a ◀/▶ button on the **Astro tab** of the time controller
- Jumps to the next/previous occurrence of an astronomical event (sunrise, sunset, moonrise, moonset, moon phase, transit)
- **Flow**: `stop()` → `finishAllAnimations()` → `setTime(targetDate)` → `beginFrame()` → `tickAnimations()` per face → `endFrame()` → `startScheduler()`
- Uses `computeAstroTarget()` (in `src/watch/astro-stepper.ts`) to find the event time
- **Degree/radian conversion**: `lat`/`lon` are stored in degrees in `engine-entry.ts` but the astronomy routines expect radians; the handler converts with `× Math.PI / 180`
- **Invalid date guard**: If the astro computation returns `null` or `NaN`, the button flashes red and no time change occurs (prevents time controller corruption)
- **Venezia body swap**: On single-face Venezia, the moonrise/moonset/moon-transit rows are replaced with body-aware versions that use the currently selected planet. The body param propagates to navigation links via `updateNavigationLinks()`

#### Astro Event Search Algorithms

| Event | Function | Source |
|-------|----------|--------|
| Sunrise/Sunset | `findNextRiseSet()` | Ports iOS `nextPrevRiseSetInternal` via `planetaryRiseSetTimeRefined` |
| Moonrise/Moonset | `findNextRiseSet()` | Same as above with `ECPlanetNumber.Moon` |
| Moon Phase | `findNextQuarterPhase()` | Ports iOS `nextMoonPhase()` / `prevMoonPhase()` using `refineMoonAgeTargetForDate` |
| Sun/Moon Transit | `findNextTransit()` | Uses `planettransitTimeRefined` with 12-hour fudge to avoid same-transit convergence |
| Body Rise/Set/Transit | Same as above | Uses the selected body's `ECPlanetNumber` from Venezia's planet selector |

## Hold-Scrub Time Preservation

When holding a step button, `timeController.setRate()` starts quantized scrubbing. The rate activation includes a `snapToUnit()` call that aligns to the nearest boundary.

**Problem**: For rates above seconds, `snapToUnit` zeroes sub-unit time fields (minutes, seconds), causing hands to jump.

**Solution**: Only snap for the `second` rate (zeroing milliseconds). For all other rates, preserve current time exactly and start ticking from there. Since `advanceByUnit()` preserves sub-unit fields (e.g., adding 1 day preserves HMS), all subsequent ticks maintain correct time-of-day.

## Transition Behavior

| Transition | What happens |
|-----------|--------------|
| **Single tap** | Stop time, snap in-flight animations, step by one unit, animate at natural speed |
| **Astro tap** | Stop time, snap in-flight, compute next event, `setTime()`, animate all hands to new positions |
| **Hold → scrub** | After 300ms hold delay, enter quantized mode. `resetHandSchedules()` forces immediate re-eval |
| **Pause** | Freeze display time. `finishAnimations()` snaps all hands to targets |
| **Resume (Play)** | Unfreeze at 1×. `resetHandSchedules()` forces immediate re-eval with normal scheduling |

## Key Functions

| Function | Purpose |
|----------|---------|
| `initHandStates(watch, env, now, getNow)` | Build animation state for all dynamic parts |
| `tickAnimations(states, env, now, tickMs, deltaSec, timeDir)` | Per-frame: re-evaluate + start animations |
| `startValueAnimation(val, target, now, speed, durationOverride?)` | Core: begin/restart an animation on an abstract value |
| `startAnimationRaw(val, target, now, speed, durationOverride?, linear?)` | Angle wrapper: unwraps for shortest-path, then calls core. If `linear` is true, skips `fmod` normalization and angular unwrapping (used for Observatory earth view's sun declination) |
| `startLinearAnimation(val, target, now, speed, durationOverride?)` | Linear wrapper: calls core without angle wrapping |
| `interpolateValue(val, now)` | Advance currentValue toward target (abstract, semantics-free) |
| `interpolateRaw(val, now)` | Angle wrapper: calls core, applies `fmod(2π)` when done |
| `finishAnimations(states)` | Snap all in-flight animations to targets |
| `finishAllAnimations()` | Snap all hands on all faces |
| `resetHandSchedules(states)` | Set nextUpdateTime=0 so all hands re-evaluate next frame |
| `nextWakeupTime(states)` | Find earliest scheduled update (for idle timer) |
| `makeGetNow(bps)` | Create a per-face quantized getNow closure |

## Constants (from `ECConstants.h`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `kECGLAngleAnimationSpeed` | `2.0` rad/s | Base angular animation speed |
| `kECGLLinearAnimationSpeed` | `60.0` px/s | Base linear animation speed (xMotion/yMotion) |
| `kECGLFrameRate` | `1/240` s | Minimum animation duration; below this, snap |

## Unified Animation Core

All animation types (angular, linear, terminator leaf) share a common semantics-free core:

1. **`startValueAnimation(val, target, now, speed, durationOverride?)`** — Sets `targetValue`, computes `animationStopTime`, marks `animating = true`
2. **`interpolateValue(val, now)`** — Linear interpolation from current to target based on elapsed real time

Specialized wrappers add type-specific behavior:
- **`startAnimationRaw`** — Normalizes angles to `[0, 2π)` and unwraps for shortest-path before calling core
- **`startLinearAnimation`** — Calls core directly (no wrapping needed for pixel translations)
- **`interpolateRaw`** — Calls core, then applies `fmod(2π)` when animation completes

The terminator leaf system (`terminator.ts`) also uses the unified core via `startAnimationRaw` for leaf angles and rotations.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/animation.ts` | All animation logic: hand states, ticking, interpolation, unified core |
| `src/watch/astro-stepper.ts` | Astronomical event stepping: rise/set, moon phase, transit search |
| `src/watch/terminator.ts` | Moon-phase leaf animation (uses unified core) |
| `src/time-controller.ts` | Display time management, rate control, tick scheduling |
| `src/engine-entry.ts` | Main loop, scheduler, transition handling, `makeGetNow` |
| `src/watch/watch-env.ts` | Expression environment (receives quantized `getNow`) |

## Related Docs

- [Rendering](rendering.md) — How animated parts are drawn each frame
- [Timezone & DST](timezone-and-dst.md) — DST transition detection and environment rebuild triggers
- [Development Rules](development-rules.md) — Schedule reset rules (§6), never rebuild parts (§3)
