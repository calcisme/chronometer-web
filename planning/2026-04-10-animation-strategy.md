# Animation Strategy for Accelerated Time Rates

## Background

The Chronometer web app has two time modes:
- **1× (real-time)**: Display time tracks the real clock (with a possible offset). Hands update at their XML-defined intervals. Animation uses angular speed to smoothly sweep between positions.
- **Quantized rates** (10 hr/s, 10 day/s, etc.): Display time jumps discretely at a fixed **tick rate** of 10 Hz (every 100ms real time). Each tick advances display time by one unit (1 hour, 1 day, etc.).

## Two Time Bases

The system requires two distinct time bases:

| Time Base | Source | Used For |
|-----------|--------|----------|
| **Display time** | `getNow()` → `timeController.getDisplayTime()` | Evaluating angle expressions — determines **what** the target position should be |
| **Real time** | `performance.now()` | Animation interpolation — determines **where** the hand is drawn right now |

> [!IMPORTANT]
> These two time bases serve fundamentally different purposes and must not be conflated. Display time can jump by hours/days per tick; real time always advances smoothly at 1:1.

## Strategy for 1× Real Time

At 1× speed — whether forward or backward, and whether at "Now" or at an offset time — the existing strategy applies:
- Parts update at their XML-defined intervals (aligned to display-time boundaries)
- Animation duration is computed from angular distance / animation speed
- Both time bases effectively track the same clock (possibly with an offset and/or a sign change)

This mode is used for:
- Normal real-time operation (forward, "Now")
- Forward from an offset time (e.g., after stepping then pressing ▶)
- Backward real-time (pressing ◀, i.e. -1× mode)

## Strategy for Quantized Rates

### 1. Update at Tick Boundaries Only

When running at a quantized rate, hand expressions should only be re-evaluated when a **tick** occurs (every 100ms real time). Between ticks, display time is frozen, so re-evaluation would return the same value.

- On tick: `tickTime` advances by one unit (e.g., +1 hour)
- `beginFrame()` captures the new `tickTime` as the frame snapshot
- `evalAttr(part.angle, env)` returns the new target angle

### 2. Adaptive Animation Duration

When a new target is computed after a tick, the animation duration is chosen to be as natural as possible while guaranteeing the animation completes before the next update arrives.

**Decision rule**:
1. Compute `ticksUntilUpdate = ceil(part.updateIntervalSec / displayDeltaPerTick)` — how many ticks before this part's next re-evaluation
2. Compute `timeUntilNextUpdate = ticksUntilUpdate × TICK_INTERVAL_MS` — how much real time the animation has
3. Compute the **normal speed-based duration**: `normalDuration = angular_delta / (kECGLAngleAnimationSpeed × animSpeed)`
4. If `normalDuration ≤ timeUntilNextUpdate` → use **normal speed-based animation** (it will complete in time)
5. If `normalDuration > timeUntilNextUpdate` → compress to `timeUntilNextUpdate`

**In practice for 10 hr/s mode** (tick = 100ms):
- **12-hour hand** (update = 1s): `ticksUntilUpdate = 1`, `timeUntilNextUpdate = 100ms`. Normal duration = 262ms > 100ms → **compressed to 100ms**
- **Day wheel** (update = 86400s): `ticksUntilUpdate = 24`, `timeUntilNextUpdate = 2400ms`. Normal duration = 314ms < 2400ms → **normal speed (314ms)**

```
Fast part (12hr hand at 10hr/s, compressed to 100ms):
  Tick 0 (t=0ms):     target = 210°, animation: 180° → 210° over 100ms
  Tick 1 (t=100ms):   target = 240°, animation: 210° → 240° over 100ms
  Tick 2 (t=200ms):   target = 270°, animation: 240° → 270° over 100ms

Slow part (day wheel at 10hr/s, normal speed):
  Tick 0 (t=0ms):     target = 36°, no change from current → no animation
  Tick 1–23:          NOT re-evaluated (skipped)
  Tick 24 (t=2400ms): target = 72°, animation: 36° → 72° at normal speed (~314ms)
```

### 3. Scheduling: Skip Ticks for Slow Parts

In quantized mode, not every part needs re-evaluation on every tick. A part should only be re-evaluated when enough **display time** has elapsed to cross its update interval boundary.

**Scheduling rule**: After re-evaluating a part, compute how many ticks must elapse before the part's update interval is exceeded, and schedule `nextUpdateTime` accordingly:

```
displayDeltaPerTick = displayTimeAdvancePerTick  (e.g., 3600s for 10 hr/s)
ticksUntilUpdate = ceil(part.updateIntervalSec / displayDeltaPerTick)
nextUpdateTime = now + ticksUntilUpdate × TICK_INTERVAL_MS
```

For example at 10 hr/s (display delta = 3600s per tick):
- **12-hour hand** (update = 1s): `ceil(1 / 3600) = 1` tick → re-evaluate every tick ✅
- **Day wheel** (update = 86400s): `ceil(86400 / 3600) = 24` ticks → skip 23 ticks, re-evaluate on tick 24 ✅

This saves processing by not wastefully re-evaluating slow parts that will return the same value.

### 4. No Re-evaluation Between Ticks

Between tick boundaries, `tickAnimations` should:
- ✅ **Interpolate** the animation using real time (smooth hand movement at up to 240fps)
- ❌ **NOT re-evaluate** the angle expression (display time hasn't changed)

This is enforced by the scheduling in section 3 — `nextUpdateTime` is always at or beyond the next tick boundary.

## Transition Between Modes

### Single Tap on Step Button
A single tap on a step button (e.g., `1h ▶`) should behave like a single tick in quantized mode:
1. `timeController.step(unit, dir)` advances display time by one unit
2. All hand expressions are re-evaluated with the new time
3. Animations run over **100ms** (same as `TICK_INTERVAL_MS`), producing a smooth sweep to the new position
4. After 100ms, hands are at their targets and the system is idle

### Hold-to-Scrub (Entering Quantized Rate)
1. mousedown: single step (as above)
2. After 300ms hold delay: `timeController.setRate(RATE_OPTIONS[n])` starts the quantized tick model
3. `resetHandSchedules()` forces immediate re-evaluation on next frame
4. Subsequent updates occur at tick boundaries with adaptive animation duration

### Stopping (Pause)
1. `timeController.stop()` freezes display time
2. `finishAnimations()` snaps all hands to their targets and sets `nextUpdateTime = Infinity`
3. No further re-evaluations occur while stopped

### Resuming (Play ◀/▶)
1. `timeController.setRate(null)` and `setDirection(±1)` unfreezes time at 1×
2. `resetHandSchedules()` sets `nextUpdateTime = 0`, forcing immediate re-evaluation
3. Normal 1× scheduling resumes (speed-based animation, display-time-aligned updates)

## Proposed Changes

### [MODIFY] [animation.ts](file:///Users/spucci/chronometer-web/src/watch/animation.ts)

1. **Add `tickIntervalMs` parameter to `tickAnimations`**: When non-null, indicates quantized mode.

2. **`startAnimation` changes**: Accept an optional `durationMs` override. When provided, use it instead of `distance / animSpeed`.

3. **`tickAnimations` adaptive logic** (quantized mode):
   ```
   if (tickIntervalMs !== null && now >= state.nextUpdateTime) {
       // How long until next re-evaluation?
       ticksUntilUpdate = max(1, ceil(part.updateIntervalSec / displayDeltaPerTick))
       timeUntilNextUpdate = ticksUntilUpdate × tickIntervalMs

       newTarget = evalAttr(part.angle, env)
       normalDuration = angular_delta / (kECGLAngleAnimationSpeed × animSpeed)

       if (normalDuration > timeUntilNextUpdate) {
           // Wouldn't finish in time: compress
           startAnimation(state, newTarget, now, timeUntilNextUpdate)
       } else {
           // Fits: animate at normal speed
           startAnimation(state, newTarget, now)
       }

       nextUpdateTime = now + timeUntilNextUpdate
   }
   ```

### [MODIFY] [engine-entry.ts](file:///Users/spucci/chronometer-web/src/engine-entry.ts)

1. Pass `TICK_INTERVAL_MS` (or `null` for 1×) to `tickAnimations` based on current time controller state
2. For single-tap steps: trigger a one-shot update with `tickIntervalMs = 100`
3. Expose the display-time-per-tick value so animation.ts can compute tick skip counts

## Verification Plan

### Manual Verification
- Hold `1h ▶` on Mauna Kea: 12-hour hand should sweep smoothly at ~240fps
- Hold `1d ▶`: day/month wheels should animate at natural speed; hour hand sweeps fast
- Single tap `1h ▶`: hour hand sweeps to next position over 100ms
- Press pause: all hands snap to tick marks (no mid-animation freeze)
- Resume at 1× forward: second hand ticks normally from clean boundaries
- Resume at 1× backward: same behavior in reverse
- 240fps video capture should show intermediate hand positions during sweeps
