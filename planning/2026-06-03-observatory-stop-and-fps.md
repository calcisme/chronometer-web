# Observatory: stop animating when stopped + two-metric FPS indicator

*2026-06-03*

Follow-on to [2026-06-03-stopped-clock-rendering.md](2026-06-03-stopped-clock-rendering.md),
applying the same ideas to Observatory, whose animation system is similar to
Chronometer's but structured differently.

## Status — ✅ implemented (2026-06-03)

Both goals shipped. Summary of what landed:

- **Goal 1 (stop when stopped):** added `anyObsAnimating()` (`obs-values.ts`); `tick()`
  now re-arms RAF only while `!isStopped || anyObsAnimating(...)` and otherwise goes
  fully idle; the previously no-op `ensureSchedulerRunning()` plus `rebuildEnv()`, the
  resize handler, and image-load now call `scheduleFrame()` to restart an idle loop.
  No snapping — in-flight animations finish naturally (the existing stopped branch in
  `updateObsValues` already eases to the frozen-time target).
- **Goal 2 (FPS indicator):** extracted the shared `src/shared/fps-indicator.ts`
  (DOM overlay, active+avg, dimming, 1s watchdog); refactored Chronometer
  (`engine-entry.ts`) to use it (behavior-preserving) and adopted it in Observatory.
- **Docs:** `docs/observatory.md` updated (render-loop idling + FPS overlay).

**Follow-up bug found & fixed during testing — render-loop re-entrancy.** Scrubbing by
day showed impossible 400–700 "fps" and the scrub slowing after ~10 s. Cause: during
scrub, `timeController.onTick = () => rebuildEnv()` runs synchronously inside `tick()`,
and `rebuildEnv()` → `scheduleFrame()` saw `rafId === null` (nulled at the top of
`tick()`) and queued a *duplicate* rAF on top of the normal end-of-tick re-arm — one
extra per frame, growing linearly into hundreds of redundant ticks/frame. Fix: an
`inTick` guard makes `scheduleFrame()` a no-op during a tick (recording a deferred
`frameRequestedDuringTick` flag the tick honors on re-arm). After the fix, scrub holds
a steady real render rate (~refresh) and constant speed.

## How Observatory differs from Chronometer

| Aspect | Chronometer | Observatory |
|--------|-------------|-------------|
| Render loop | Idle-stopping scheduler (`armIdle`/RAF) | **Continuous RAF** — `tick()` always re-requests (`observatory-entry.ts:296, 458`) |
| Animation state | `HandState` + `anyAnimating()` | `ObsValue` with `anim.animating` + `pendingSweep` |
| Freeze on stop | `finishAnimations()` (snap + `nextUpdateTime = Infinity`) | **none** — transport callbacks only `resetObsValueSchedules()` |
| Resume hook | `ensureSchedulerRunning()` restarts scheduler | `ensureSchedulerRunning` is a **no-op** today |
| Second hand | quantized tick | continuous **`naturalSpeed` sweep** (two-phase) |
| FPS indicator | DOM overlay, two metrics (active+avg), dimming, 1s watchdog | single canvas-drawn `"<n> fps"`, gated on `?fps` |

Because the loop never idles, Observatory renders at full refresh forever — including
when stopped. (The `?fps` readout will currently show a high rate while stopped, the
same class of issue we just fixed on Chronometer.)

## Goal 1 — Stop animating when time is stopped

The render loop should keep running while **running or settling an animation**, and go
**fully idle** when stopped with nothing left to animate.

**No snapping.** On scrub-end / stop we let in-flight animations *finish naturally*
(e.g., a Moon-ring end eases to its target over ~a second; a sweep hand animates the
remaining distance rather than jumping). The loop gate below provides this for free:
the loop keeps running while anything is animating, then idles.

**Already-correct stopped handling (verified).** `updateObsValues` (obs-values.ts:712,
722–737) already does the right thing when `timeDirection === 0`: it skips the
natural-speed two-phase sweep, clears `pendingSweep`, and eases the value to its
frozen-time target at `animSpeed` (`startAnimationRaw`, not an instant snap). So no
`finishObsAnimations` and no change to `updateObsValues` are needed. We also keep
`resetObsValueSchedules()` on the transition callbacks — it's what re-evaluates at the
final time and drives the ease-to-target.

Planned changes (all in `src/observatory/`):

1. **`anyObsAnimating(obsValues)`** (new, in `obs-values.ts`): returns true if any value
   has `anim.animating` or a `pendingSweep`.

2. **Gate the loop** in `tick()`: replace the unconditional
   `requestAnimationFrame(tick)` with
   `if (!timeController.isStopped || anyObsAnimating(obsValues)) requestAnimationFrame(tick); else <go idle>`.
   Track the RAF id (e.g. `rafId`) so we can tell whether the loop is running and avoid
   double-scheduling. While running (1×, reverse, scrubbing) the loop keeps going — the
   continuous second-hand sweep already requires it. Idle happens only when stopped and
   settled.

3. **Wire `ensureSchedulerRunning()`** to kick a fresh `requestAnimationFrame(tick)` if
   the loop is idle (currently a no-op). The shared time-controls UI already calls it
   after every transport action.

4. **Audit env-change paths.** Any path that mutates state while the loop may be idle
   (stopped) must kick the loop: location change, timezone change, `noonOnTop` toggle,
   body/planet selection. Ensure each calls `ensureSchedulerRunning()` (or the kick)
   after `resetObsValueSchedules()`. Without this, a change while stopped would not
   render.

Note: the stopped branch sets `nextUpdateTime = perfNow + 100` ("re-check shortly in
case time resumes"); once the loop idles this poll simply stops, which is fine — resume
is driven explicitly by `ensureSchedulerRunning()`, not by polling.

## Goal 2 — Two-metric FPS indicator (parity with Chronometer)

Bring Observatory's readout up to the new format: `<active> fps · <avg> avg`, with
*active* dimmed when idle and a 1-second watchdog owning the text.

The cleanest way to get true parity (and avoid drift) is to **extract the Chronometer
FPS logic into a shared helper**:

6. **New `src/shared/fps-indicator.ts`**: a small module that creates the DOM overlay,
   exposes `recordFrame(continuous: boolean)` (called once per frame) and runs the 1s
   watchdog computing active (EWMA over continuous frames) + avg (throughput) with the
   dimming rule (`active = continuousFrames > 0`). No app-specific imports, so it
   satisfies the import boundary (§7) for both Chronometer and Observatory.

7. **Refactor Chronometer** (`engine-entry.ts`) to use the shared helper, replacing the
   inline implementation. Behavior-preserving.

8. **Adopt in Observatory** (`observatory-entry.ts`): remove the canvas-drawn `fps`
   line and the old `fps`/`lastFrameTime` state; create the shared overlay when
   `urlState.fps` is set; call `recordFrame(!timeController.isStopped || anyObsAnimating(...))`
   each `tick()`. Position bottom-left to match Chronometer (Observatory's top-left
   currently holds the debug overlay; confirm placement is clear).

**Ordering:** Goal 1 first — the active-vs-avg distinction is only meaningful once the
loop can idle. Goal 2's shared extraction (steps 6–7) can land independently but is
most useful paired with Goal 1.

*Alternative to the shared helper:* duplicate the FPS logic inline in
`observatory-entry.ts`. Faster, but two copies will drift. Recommend the shared module.

## Verification

- With `?fps`: stopped Observatory settles to `0 active · 0 avg` and the loop idles
  (confirm via low/zero `avg` and dimmed `active`); running tracks the real rate;
  scrubbing keeps `active` bright. Confirm the **second hand stops sweeping** when
  stopped and resumes on play.
- Confirm step / scrub / "now" / location-change / body-change all resume rendering.
- Confirm Chronometer's FPS readout is unchanged after the shared-helper refactor.
- Run the test suite; typecheck; `bash build.sh`.

## Risk / rules notes

- Import boundary §7: the shared FPS helper lives in `src/shared/`; Observatory must
  not import from `src/watch/`.
- §10: changes the core render-loop continuation condition — verify resume paths.
- §3/§6 analog: don't reset ObsValue schedules while stopped.
- §1: update `docs/observatory.md` (loop/idle behavior) and `docs/animation.md` if the
  shared FPS helper or stop semantics warrant a note.
