# Inspector Time Controller — Plan

**Date:** 2026-06-04
**Status:** Proposed (awaiting review)

## Goal

Add the shared **time controller** (scrub / play / reverse / step / stop / offset)
to the Inspector, so the top time display **and** the whole ephemeris catalog
(and the expression evaluator) reflect a controllable display time instead of
always real-time `new Date()`.

This realizes the **"Shared time-controller integration"** and parts of the
**"updater becomes an encapsulated subsystem"** future-architecture sections of
[2026-06-03-inspector-obsvalue-animation.md](2026-06-03-inspector-obsvalue-animation.md).
It also stress-tests the eval-ahead path under non-1× time (the deferred
stress-test noted in
[2026-06-04-inspector-ephemeris-catalog.md](2026-06-04-inspector-ephemeris-catalog.md)).

## What already exists (reuse, don't rebuild)

| Piece | File |
|-------|------|
| `TimeController` (display time, rate, direction, stop, step, offset, `checkTick`, `beginFrame`/`endFrame`, `clampDisplayTime`) | `src/shared/time-controller.ts` |
| `initTimeControls(config) → TimeControlsAPI` (transport bar + popover UI, wired to a `TimeController`) | `src/shared/time-controls-ui.ts` |
| HTML/CSS partials injected by the build | `src/partials/time-controller.html` (`{{TIME_CONTROLLER}}`), `src/partials/time-controller.css` (`{{TIME_CSS}}`) |
| The exact wiring pattern (tick loop, scrub params, transition callbacks) | `src/observatory/observatory-entry.ts` |

The Inspector port mirrors Observatory closely. The one genuinely new piece is
making the updater's **eval-ahead** and **discrete** modes correct under the time
controller's non-1× states.

## Prerequisite: updater mode handling under the time controller (the "future" part)

> **Revised after review.** An earlier draft of this section proposed bolting a
> "scrub-before-eval-ahead" branch (and peers) onto the dispatch. That's the wrong
> direction: it treats scrub as a separate mechanism and adds Inspector-specific
> special cases. The correct model — and the one that **generalizes for
> Chronometer** — is that eval-ahead is the *single* continuous mechanism, and
> scrub is just eval-ahead evaluated at a different upcoming point.

Today the Inspector drives its ObsValues with `tickIntervalMs=null,
timeDirection=1` (always 1× real time). Under the time controller, the
**continuous** (`evalAhead`) update generalizes by changing *where the upcoming
eval point is*; the **discrete** update only changes its *cadence*.

### Eval-ahead = one mechanism, mode-aware "next point"

Eval-ahead evaluates the target at the display time of the **next update**, and
sweeps `current → target` over the **real-time budget** until then. Only the
"next point" depends on mode:

| Mode | Next point (display time) | Budget (real) |
|------|---------------------------|---------------|
| Play 1× / reverse −1× | next epoch boundary for this value's `updateInterval` | time to it (display↔real 1:1) |
| Scrub | **next tick**: `now + displayDeltaPerTick` (signed by dir) | `TICK_INTERVAL_MS` |
| Stopped | `now` (frozen) | hold / re-check |

So scrub needs **no separate branch** — it's eval-ahead with the next point at the
next tick. It is also **lag-free at every tick** (the displayed value equals the
true value when display reaches that point), strictly better than the old
compression branch (which evaluated at *now* and lagged a tick).

**Natural-speed falls out of this**, as observed in review: a constant-rate
value's "natural speed" is just the slope between `A(now)` and `A(nextPoint)`;
sweeping `current → A(next)` over the budget reproduces constant velocity for any
value that is linear-in-time, with the rate **inferred, not configured**. The one
extra thing the old two-phase provided — a *fast catch-up* after a long drift /
tab-switch — is a **separable** concern for long-interval values; short intervals
(Inspector cadences, scrub ticks) self-correct within one step. The existing
`naturalSpeed` and `scrub-compression` branches therefore become things we
**converge away from** later — Observatory keeps them for now; this work is
purely additive.

### Discrete = eval-at-now snap, cadence-aware

Discrete values keep their **instant snap** (interpolation is meaningless),
evaluated at the *current* display time. The only mode dependence is cadence:
re-evaluate at the value's boundary at 1×/reverse, and **every tick** while
scrubbing (so they track the scrubbed time with no stale lag). Instant-snap is
kept even when stopped (unlike the continuous "settle" path), so discrete must not
be routed through the animated snap branch.

> **`discrete` is a *client* policy, not a property of the expression.** It lives
> on the `ObsValue`/`ObsValueDef` (the client sets it), never derived inside the
> updater from the function or value. The *same quantity* is discrete in one client
> and continuous in another: when today's sunrise rolls over to the next day's, the
> Inspector's text readout should **jump** to the new time, while Observatory's
> sunrise **hand** sweeps smoothly to the new day's position. **In Observatory and
> Chronometer, `discrete` will be rare** — those displays are graphical and want to
> animate between values almost everywhere. It is common only in the Inspector's
> *text* readouts, where a value *between* two sunrises is meaningless. The
> Inspector happens to derive `discrete` from its own display *tags*; that mapping
> is an Inspector concern, invisible to the shared updater.

### Resulting dispatch

```
if (v.discrete)   → discrete    (eval-at-now, instant snap; cadence = tick if scrubbing else boundary)
else if (stopped) → settle-at-now (continuous, frozen time)
else              → eval-ahead  (mode-aware next point: 1× boundary or scrub tick)
```

All additive and **no-ops for Observatory/Chronometer**, which set neither
`evalAhead` nor `discrete`. The only genuinely new code is the mode-aware "next
point" inside eval-ahead — and that is exactly the **general** mechanism a future
Chronometer port would use, not Inspector glue.

## Inspector wiring (mirror Observatory)

### HTML (`inspector.html`)
- Add `{{TIME_CSS}}` in `<head>` and `{{TIME_CONTROLLER}}` in the body (the
  transport bar + popover markup the shared UI binds to by id: `time-bar`,
  `time-popover`, `tp-transport`, etc.).
- Place the **time bar in the pinned top area** (it must stay visible while the
  catalog scrolls) — e.g. directly under the time display. Add Inspector-specific
  `#time-bar` / `#time-popover` style overrides as Observatory does (it overrides
  the shared CSS for its theme).

### Entry (`inspector-entry.ts`)
- `const timeController = new TimeController();`
- Base the clock on it: `makeOverridableGetNow(() => timeController.getDisplayTime())`.
  `env` already closes over `getNow`, so **no env rebuild on time change** is
  needed (unlike Observatory, the Inspector env depends only on lat/lon/tz).
- **tick():** mirror Observatory —
  ```
  timeController.checkTick(perfNow);
  timeController.beginFrame();
  const rate = timeController.currentRate;
  const tickIntervalMs = rate ? TICK_INTERVAL_MS : null;
  const displayDelta  = rate ? displaySecondsPerTick(rate.unit) : 0;
  const dir = timeController.isStopped ? 0 : timeController.currentDirection;
  updateTimeDisplay();                         // now shows the controlled time
  updateExprValues(tickIntervalMs, displayDelta, dir);   // expr box (evalAhead)
  updateCatalog(tickIntervalMs, displayDelta, dir);      // catalog
  timeController.clampDisplayTime();
  timeController.endFrame();
  fpsIndicator?.recordFrame(!timeController.isStopped || anyAnimating);
  ```
  (`tickExprValues`/`tickCatalog` gain the three params and forward them to
  `updateObsValues`.)
- **initTimeControls({ timeController, getTimezone, getTzDeltaMs, getLat, getLon,
  onTimeStep, onScrubStart, onScrubEnd, onNowClicked, onTransportChange,
  ensureSchedulerRunning, writeTimeState })** — the transition callbacks
  `resetObsValueSchedules(...)` the **catalog array and the expr ObsValues** (and
  rebuild the expr values on `now`/step so they snap). No env rebuild needed.
- The top time display formatter already uses `getNow()`, so it automatically
  shows the scrubbed/offset/stopped time (incl. the existing ms subsecond).

### Scheduler — idle (decided)
Adopt Observatory's idle scheduler: `scheduleFrame()` / `ensureSchedulerRunning()`
with the `inTick` / `frameRequestedDuringTick` guard, so a **stopped + settled**
Inspector goes idle (no wasted rendering) and transport actions restart it. Also
makes the `?fps` "active" reading honest.

### URL time state (decided: include)
Restore `tc` / `t` / `off` / `dir` from `readUrlState()` on load and persist via
`writeTimeState` (the url-state fields already exist; Chronometer uses them).
**Motivating use case:** a user/developer viewing a particular time + location in
Chronometer can open the Inspector on *exactly* that time and location — the shared
URL params make that a trivial deep-link once both sides round-trip the time state.

## Two goals: also generalizing the updater for Chronometer

This work is **not only** about putting the controller in the Inspector — a stated
goal is to grow the generic updater toward eventual Chronometer use. Two
consequences:

1. **The updater code we add must be the general mechanism, not Inspector glue.**
   The mode-aware eval-ahead above satisfies this — it's exactly what a Chronometer
   port would use. (This is why the earlier "special-case branches" draft was
   wrong: it was Inspector-shaped throwaway.)
2. **The controller↔updater seam should be generic**, so eventually the generic
   controller talks to the generic updater with no per-app bridging code — clients
   only *react* to transitions, never compute how the controller affects values.

**Decision (from review): build the encapsulated updater object now,
scoped to the Inspector.** The risk of abstracting against one consumer is low
here because we are *implementing the abstraction already designed in detail* in
the original plan (the `define / get / tick / onStop/onScrub/onStep/onPlay /
anyAnimating / reset` interface), which is expected to fit all three apps. Scope:

- **`TimingContext`** value type — `{ tickIntervalMs, displayDeltaSec, direction }`
  with a `forFrame(timeController)` constructor (the per-frame seam; also what the
  eval-ahead "next point" logic consumes).
- **`Updater`** object (`src/shared/updater.ts`) that **owns its `ObsValue`
  collection**, runs the per-frame passes, exposes `anyAnimating()`/`reset()`, and
  exposes **transition responses** the time-controls callbacks bind to
  (`onScrub/onStop/onStep/onNow/onTransportChange`). So clients "only react to
  changes" — they don't compute *how* the controller affects values.
- **Wiring:** the Inspector builds its catalog + expression values *through* the
  `Updater`; the `initTimeControls` callbacks call `Updater` methods; the per-frame
  loop calls `updater.tick(env, perfNow, getNow, withDisplayTime, ctx)`.
- **Not now:** migrating Observatory onto the `Updater` (it keeps its `ObsValueSet`
  wrappers); and a keyed `Map<Key,ObsValue>` lookup (the Inspector reads via its own
  per-cell handles, so the collection can stay array-backed internally — keyed
  access layers on when a consumer needs it).

## Out of scope (defer)

- The encapsulated collection-owning **`Updater` object** (level (b) above) — until
  a second consumer (Chronometer) pushes on it.
- Replacing Observatory's `naturalSpeed` / scrub-compression branches with the
  generalized eval-ahead. Additive convergence, later.
- Astro step (◀/▶ to next sunrise/etc.) — Chronometer's astro-stepper is in
  `src/watch/` (off-limits to the Inspector). Could be ported to shared later.

## Verification

- Scrub forward/back: catalog **continuous** values (RA/alt/az/distance/sidereal)
  animate smoothly via mode-aware eval-ahead (lag-free at each tick); **discrete**
  values (hour, day index,
  weekday, month, TZ, planet up?, rise/set/transit) **snap** to the scrubbed time
  and stay correct (no stale lag).
- Stop: everything freezes at the displayed time; `?fps` "active" dims.
- Reverse 1×: values track backwards smoothly.
- Offset / "Now": jumps and re-snaps cleanly; date-range clamp (`clampDisplayTime`)
  stops at the 4000 BCE – 2800 CE bounds.
- Bundle isolation unchanged (`observatory/`=0, `watch/`=0-or-pre-existing-1 in
  `dist/inspector-engine.js`); full `tsc` + `bash build.sh` + tests green.

## Docs to update (Development Rules §1)

- `docs/inspector.md` — time controller section (transport, scrub behavior of the
  catalog, idle scheduler).
- `docs/animation.md` — eval-ahead's mode-aware "next point" (1× boundary vs scrub
  tick), how it subsumes scrub and natural-speed, and the discrete cadence rule.
- Cross-link both planning docs.

## Resolved decisions (from review)

- **`discrete` is client-assigned** display/animation policy, not an expression
  property; rare in Observatory/Chronometer (graphical, animate everywhere), common
  in the Inspector's text readouts. ✓
- **Scrub is eval-ahead** with the next point at the next tick — no separate
  branch; natural-speed falls out (rate inferred). ✓
- **Controller↔updater seam:** build the encapsulated `Updater` object + a
  `TimingContext` now (scoped to the Inspector; Observatory migration deferred). ✓
- **Idle scheduler:** yes. ✓
- **URL time state:** yes (enables Chronometer→Inspector deep-link). ✓

## Open question

1. **Time-bar placement** in the pinned header — under the time display
   (recommended) vs. its own row near the title.
