# Eliminate unnecessary rendering while the clock is stopped

*2026-06-03*

## Background

The Chronometer `?fps` indicator (shows `<active> fps · <avg> avg`, where *active* =
render rate while continuously animating and *avg* = throughput including idle gaps)
revealed that several faces keep doing work after the clock is **stopped**, when they
should be fully idle:

| Face | Observed (stopped) | Meaning |
|------|--------------------|---------|
| Haleakala (Chrome + Safari) | `0 active · ~60 avg` | Idle scheduler busy-waiting — `frame()` runs ~every refresh but nothing animates |
| Milano (Chrome only) | `~120 active · ~100 avg` | A hand is stuck `animating` → continuous RAF render |
| Kyoto (intermittent) | sometimes sticks at ~60 | Same as Milano, only when stopped mid-ring-animation |

### Why 60 vs 120? (does not indicate a self-imposed cap)

We do **not** cap any timers at 60 Hz. The 60-vs-120 split is itself diagnostic and
confirms the two distinct code paths:

- **Milano (~120):** a stuck animation keeps `frame()` re-arming via a direct
  `requestAnimationFrame(frame)` — a pure continuous RAF loop, which runs at the full
  ProMotion refresh (120 Hz).
- **Haleakala (~60):** the idle busy-loop runs `frame()` → `armIdle()` →
  `setTimeout(onIdleWakeup, ~0)` → `requestAnimationFrame(frame)`. The extra
  `setTimeout` hop each iteration means the browser effectively interleaves at ~60/s
  even on a 120 Hz display (the timer can't reliably catch every 8.3 ms vsync). So the
  lower rate is a side effect of going through the idle path, not a configured limit.

## Root cause

While stopped, display time is frozen, so every hand's angle expression returns a
constant — there is nothing to re-evaluate. `finishAnimations()` knows this and
deliberately freezes the schedule (`nextUpdateTime = Infinity`, with the comment
"Prevent the scheduler from re-evaluating while stopped").

But the stop transition **undoes that freeze**. In `engine-entry.ts`,
`onTransportChange` (pause button) and `onScrubEnd` both do:

```js
finishAllAnimations();   // freezes: nextUpdateTime = Infinity
resetAllSchedules();     // un-freezes: nextUpdateTime = 0  ← defeats the freeze
```

`resetAllSchedules()` is meant for *resuming* playback, not stopping. Once schedules
are live again while stopped, the symptom depends on the face's hands:

- **Idle busy-loop** (Haleakala): a hand re-evaluates every frame via `armIdle()`
  (its `nextUpdateTime` keeps landing at/just past `now`). No animation runs, so
  *active* = 0 but *avg* ≈ refresh rate.
- **Stuck animation** (Milano/Kyoto): re-evaluation *restarts* an animation, so
  `stillAnimating` stays true and the RAF loop renders continuously. Milano is
  Chrome-only because its power-reserve hand depends on the Battery API
  (`batteryLevelSupported()`), which Safari lacks.

A related latent defect: `computeNextBoundary()` (animation.ts) has an asymmetry —
the **backward** branch guards against "already exactly on a boundary"
(`localBoundary === localNowMs ? boundary - interval : boundary`) but the
**forward** branch does not. When the frozen time lands exactly on a hand's update
boundary, `Math.ceil` returns the *current* time → `deltaMs = 0` →
`nextUpdateTime = now` → perpetual every-frame re-evaluation. This is the §5
"every-frame evaluation" failure and is a strong candidate for Haleakala's driver.

## Planned changes

1. **Don't re-arm schedules when stopping.** Guard `resetAllSchedules()` with
   `if (!timeController.isStopped)` in the stop-transition handlers
   (`onTransportChange`, `onScrubEnd`). `finishAllAnimations()` already leaves the
   display correct and the schedule frozen.

2. **Idle scheduler ignores the stopped state.** Make `armIdle()` a no-op while
   `timeController.isStopped` — a stopped clock never needs a re-evaluation wakeup.
   This is the robust safety net: it kills the busy-loop for *every* path (pause,
   scrub-end, and step-while-stopped) once any in-flight animation settles, no
   matter which hand triggers it.

3. ~~**Fix the `computeNextBoundary` forward-branch boundary equality.**~~
   **REVERTED — do not do this.** Tried mirroring the backward branch so an
   exactly-aligned time returns the *next* boundary. This broke ~4500 regression
   goldens: the established (and correct) behavior is that a hand sitting exactly on
   a boundary re-evaluates *at* that boundary (returns "now"), which the goldens
   encode at aligned test times (midnight, etc.). It is also unnecessary — in live
   operation `rawGetNow` carries sub-ms precision so the forward branch never lands
   exactly on a boundary, and the stopped-state busy-loop is fully handled by
   changes #1 and #2. Leaving `computeNextBoundary` as-is.

4. **Set the battery indicator to exactly one minute.** There is currently exactly
   one battery-driven part — Milano's `pwr h` hand (`update='600'` = 10 minutes).
   Change it to `update='60'` (exactly one minute): the longer interval feels too
   slow for the indicator's purpose, and one minute is a sensible, low-cost cadence.
   As a forward-looking guideline, any future battery-reading part should likewise
   use the `update` mechanism to re-evaluate no more than about once per minute.
   (Open question: whether to *also* throttle the async `levelchange`-driven cache
   refresh so battery jitter can't drive extra re-renders — probably unnecessary
   once #1/#2 stop re-evaluation while stopped.)

## Investigation to confirm before/while implementing

- **Pin Haleakala's real 60-Hz driver.** The shipping asset
  (`assets/haleakala/Haleakala-android.xml`) has no sub-second hand — finest is
  `update='1'` — so the exact 60-Hz source is unconfirmed (likely change #3's
  boundary bug). Add a temporary diagnostic logging which hand has
  `nextUpdateTime <= now` each frame while stopped; expect changes #1–#3 to
  resolve it regardless.

## Broader question: do we need test XML fixtures at all?

While chasing Haleakala I found that the test fixture
`src/watch/__tests__/fixtures/Haleakala.xml` diverges substantially from the shipping
asset `assets/haleakala/Haleakala-android.xml` (the fixture has a `1/60` hand and
lacks the sync-indicator sentinels) — which sent the analysis down a wrong path.

That raises a more general design question worth resolving: **why do we maintain
hand-written test XML at all**, when the goal is to verify the behavior of the
*actual* parts on the *actual* faces? Options to evaluate:

- Point the part/animation tests at the real face assets, eliminating bespoke
  fixtures (and the risk of fixture drift).
- Keep fixtures only where a test genuinely needs a minimal/synthetic part
  configuration that no shipping face exercises — and document why.

Investigate the current test suite's dependence on fixtures, then decide whether to
consolidate onto real assets or keep a small, clearly-justified set of fixtures.

## Verification

- With `?fps`, confirm each face drops to `0 active · 0 avg` (or fully idle) shortly
  after stopping: Haleakala (both browsers), Milano (Chrome), Kyoto (repeat
  stop-at-various-moments to catch the intermittent case), plus a control face.
- Confirm running, scrubbing, single-step, astro-step, and resume still animate
  correctly (no frozen or skipped hands).
- Run the existing test suite.

## Risk / rules notes

- Changes #1–#2 alter core scheduler behavior — see Development Rules §6 (reset
  schedules only at discrete transition points; stop is not one — `finishAnimations`
  freezes instead) and §10 (don't violate core constraints without asking).
- Do **not** regenerate golden files (§12) unless explicitly requested.
- Keep affected docs in sync (§1): `animation.md` (scheduler/stop behavior) and, if
  the battery guideline is formalized, `development-rules.md`.
