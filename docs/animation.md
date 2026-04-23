# Animation

The animation system manages how watch hands move between their computed positions, supporting both real-time ticking and accelerated time scrubbing.

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.chronometer-ref/` | `Classes/ECGLPart.m` (animation interpolation, `kECGLAngleAnimationSpeed`), `Classes/ECWatchController.m` (update scheduling) |

## Two-Time-Base Architecture

The system uses two independent time bases:

| Time Base | Source | Used For |
|-----------|--------|----------|
| **Display time** | `getNow()` → `timeController.getDisplayTime()` | Evaluating angle expressions — determines **what** the target position should be |
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
    updateIntervalMs: number;            // From XML update attr
    nextUpdateTime: number;              // performance.now() for next re-eval
    animSpeed: number;                   // From XML animSpeed attr (default 1.0)
    getNow: () => Date;                  // Display time source
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

Updates fire on **exact clock boundaries** (epoch-aligned), not relative to page load. Named sentinel values (e.g., `updateAtNextSunriseOrMidnight`) are approximated as daily (`86400s`).

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
- Expressions re-evaluate at epoch-aligned boundaries
- Animations use natural speed (`kECGLAngleAnimationSpeed × animSpeed`)
- No compression logic
- Both directions use the same idle-timeout scheduler; `nextAlignedUpdate()` is direction-aware, using `Math.ceil` (forward) or `Math.floor` (backward) to find the next boundary in the direction time is flowing

### Quantized Mode (Scrubbing / Accelerated)

Used for hold-to-scrub at rates like 10 hr/s, 10 day/s:

- Display time jumps in fixed steps on each tick (10 Hz tick rate, 100ms intervals)
- **Adaptive compression**: If natural animation duration exceeds the tick interval, compress to fit. Otherwise, use natural speed.
- **Independent compression**: `angle` and `offsetAngle` are compressed independently
- **Schedule skipping**: Slow-updating parts skip ticks where their expression wouldn't change

**Decision rule** for each hand update:
1. `ticksUntilUpdate = ceil(part.updateIntervalSec / displayDeltaPerTick)`
2. `timeUntilNextUpdate = ticksUntilUpdate × TICK_INTERVAL_MS`
3. `normalDuration = angular_delta / (kECGLAngleAnimationSpeed × animSpeed)`
4. If `normalDuration ≤ timeUntilNextUpdate` → use normal speed
5. If `normalDuration > timeUntilNextUpdate` → compress to `timeUntilNextUpdate`

### Single-Step Mode

- Triggered by a single tap on a step button
- Calls `resetHandSchedules` then `tickAnimations` once
- Animations use natural speed (no compression)

## Hold-Scrub Time Preservation

When holding a step button, `timeController.setRate()` starts quantized scrubbing. The rate activation includes a `snapToUnit()` call that aligns to the nearest boundary.

**Problem**: For rates above seconds, `snapToUnit` zeroes sub-unit time fields (minutes, seconds), causing hands to jump.

**Solution**: Only snap for the `second` rate (zeroing milliseconds). For all other rates, preserve current time exactly and start ticking from there. Since `advanceByUnit()` preserves sub-unit fields (e.g., adding 1 day preserves HMS), all subsequent ticks maintain correct time-of-day.

## Transition Behavior

| Transition | What happens |
|-----------|--------------|
| **Single tap** | Step by one unit, animate at natural speed over 100ms |
| **Hold → scrub** | After 300ms hold delay, enter quantized mode. `resetHandSchedules()` forces immediate re-eval |
| **Pause** | Freeze display time. `finishAnimations()` snaps all hands to targets |
| **Resume (Play)** | Unfreeze at 1×. `resetHandSchedules()` forces immediate re-eval with normal scheduling |

## Key Functions

| Function | Purpose |
|----------|---------|
| `initHandStates(watch, env, now)` | Build animation state for all dynamic parts |
| `tickAnimations(states, env, now, tickMs, deltaSec)` | Per-frame: re-evaluate + start animations |
| `startAnimationRaw(val, target, now, speed, durationOverride?)` | Begin/restart an animation |
| `interpolateRaw(val, now)` | Advance currentValue toward target |
| `finishAnimations(states)` | Snap all in-flight animations to targets |
| `resetHandSchedules(states)` | Set nextUpdateTime=0 so all hands re-evaluate next frame |
| `nextWakeupTime(states)` | Find earliest scheduled update (for idle timer) |

## Constants (from `ECConstants.h`)

| Constant | Value | Meaning |
|----------|-------|---------|
| `kECGLAngleAnimationSpeed` | `2.0` rad/s | Base angular animation speed |
| `kECGLFrameRate` | `1/240` s | Minimum animation duration; below this, snap |

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/animation.ts` | All animation logic: hand states, ticking, interpolation |
| `src/time-controller.ts` | Display time management, rate control, tick scheduling |
| `src/engine-entry.ts` | Main loop, scheduler, transition handling |

## Related Docs

- [Rendering](rendering.md) — How animated parts are drawn each frame
- [Development Rules](development-rules.md) — Schedule reset rules (§6), never rebuild parts (§3)
