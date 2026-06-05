# Observatory → shared Updater port (+ generalize the controller↔updater seam)

**Date:** 2026-06-05
**Status:** Proposed (awaiting review, rev. 2)

## Goal

Two coupled goals:

1. **Generalize the controller↔updater seam** so the *generic* communication
   between the time controller and an updater lives in the **shared** layer, not
   re-wired in every client. A client constructs an `Updater` with its values and
   hands it to the time controls; from then on it is only *notified* of transitions
   when it has **custom** logic to run.
2. **Port Observatory onto the shared `Updater`** — drive its values through the
   same seam (no bespoke per-frame glue) and store them in a **name-keyed
   collection** instead of the hand-written `ObsValueSet` struct.

Behavior-preserving for rendering. (Eval-ahead convergence stays out of scope —
see end.)

## Background: the seam is half-generic today

`time-controls-ui.ts` is the transition source (it owns the buttons). Inconsistency:

- **Transport buttons** (pause/rev/fwd) do the controller action *in the UI*
  (`timeController.stop()`/`setDirection()`/`setRate()`) and call the client's
  `onTransportChange()` only as a **notification**. ✅ right pattern.
- **Now** (`nowClicked`) and **scrub-end** (`endHold`) **delegate** the controller
  action to the client — every client's `onNowClicked` calls
  `timeController.reset()`, every `onScrubEnd` calls `timeController.stop()`. ❌
- **`updater.reset()` / `resetObsValueSchedules(...)`** is hand-wired in *every*
  client transition callback. ❌ (This is the controller→updater "comms" that
  should be generic.)

Clients genuinely differ in their *custom* work, so we can't collapse to one hook:
- **Chronometer** (uses `HandState`, no `Updater`): `finishAllAnimations()` on
  step/now/scrub-end, and a deliberate **no-reset when transitioning into stopped**
  (keeps the hand freeze — see planning/2026-06-03-stopped-clock-rendering.md).
- **Observatory** (`Updater`): `rebuildEnv()` on env/cache-affecting changes.
- **Inspector** (`Updater` for the catalog): `rebuildExprValues()` for the
  free-form expression box (which lives outside the updater for error isolation).

## Design

### 0. Make the generic seam generic (shared `time-controls-ui.ts`)

- **Move the generic controller actions into the UI** for consistency with the
  transport buttons: `nowClicked()` calls `timeController.reset()`; `endHold()`
  calls `timeController.stop()`. (Done *before* the client notification, preserving
  current ordering — Chronometer does `reset()`/`stop()` first today too.)
- **Add `updater?: { reset(): void }` to the config** (minimal interface — the
  shared UI does *not* depend on the `Updater` class or any client type). On
  **every** transition (scrub start/end, single-step, astro-step, date-input, now,
  transport) the UI calls `updater?.reset()`.
- **Make the per-transition client callbacks optional** — `onScrubStart?`,
  `onScrubEnd?`, `onTimeStep?`, `onNowClicked?`, `onTransportChange?`. They are now
  *notifications for custom logic only*. A client with no custom work omits them.
- **Generic time-state URL persistence (default, overridable).** Writing the
  *time* params (`t`/`off`/`dir`) from the controller state is identical in every
  app (Chronometer's and the Inspector's `writeTimeState` are byte-identical;
  Observatory's is a no-op TODO). Make `writeTimeState?` **optional**; when omitted
  the UI uses a built-in default `writeTimeStateToUrl(timeController)` (the t/off/dir
  logic, via the shared `writeUrlState`). All three apps drop their copies and use
  the default — which also gives **Observatory time *persistence*** for free,
  completing the deep-link round-trip (we already added restore). An app may still
  pass `writeTimeState` to override. (Lives in `time-controls-ui.ts`, which already
  imports both `TimeController` and `writeUrlState` — no new import cycle. The
  *non-time* URL params remain each app's own business, out of scope.)
- `ensureSchedulerRunning` stays **client-supplied** — the rAF render loop is
  genuinely app-owned (each app renders different content), so there's no sensible
  generic default today. See *Long-term* below.

Handler shape becomes, uniformly: `controllerAction(); updater?.reset();
onXxx?.(); updateTimeUI(); ensureSchedulerRunning(); writeTimeState();`

> **Long-term (not this pass):** the endgame is to integrate **Chronometer**
> itself onto the `ObsValue`/`Updater`/controller system. When that happens,
> Chronometer stops needing most of its custom transition callbacks (they exist
> only because it still drives `HandState` by hand), and the scheduler/`updater`
> wiring unifies. For *now* we make **only** the changes strictly required for the
> Observatory port; Chronometer keeps its custom callbacks and its own scheduler.
> Where a generic default with an override slot is cheap and clearly right *today*
> (the time-state writer above), we do it now; where it isn't (the app-owned rAF
> loop), we leave it and revisit during the Chronometer integration.

**Per-client fallout:**
- **Chronometer**: passes **no** `updater` (HandState) → no auto-reset; keeps its
  per-transition callbacks, but **drops** the now-UI-owned `timeController.reset()`
  / `stop()` from `onNowClicked` / `onScrubEnd`. Its freeze-on-stop subtlety is
  untouched (it lives in its callbacks; no updater auto-reset to fight it).
- **Observatory**: passes `updater`. With the `rebuildEnv` trim (below) it needs
  **no** transition callbacks at all.
- **Inspector**: passes its catalog `updater`; keeps one custom hook that rebuilds
  the expression box (could fold the expr values into the updater later to drop
  even that).

### 1. Generic keyed `Updater<K extends string = string>`

```ts
// shared/updater.ts — client-agnostic; K is abstract.
export class Updater<K extends string = string> {
    private byName = new Map<string, ObsValue>();
    add(v: ObsValue): void { /* push to array + byName.set(v.name, v) */ }
    get(name: K): ObsValue { /* throws on miss */ }
    // tick / anyAnimating / reset / all unchanged
}
```
Internally `Map<string, ObsValue>`; `K` only types `get()`. Observatory passes
its own `ObsValueName` union as the type arg; the shared updater never names it.
Inspector uses `Updater` (`K = string`), never calls `get()`.

### 2. Observatory collection → the Updater
`buildObsValues(env, perfNow, getNow): Updater<ObsValueName>` from
`buildValueDefs()`; define `ObsValueName` in Observatory; startup-assert every def
name resolves. Delete `ObsValueSet`, `getAllValues`, `invalidateObsValueCache`,
the 4 thin wrappers.

### 3. Renderers look up by name
`hand-views` (~30 names), `planet-hands` (`planetValueMap` → names), `ring-view`
(per-planet 6-tuples + 16 sun-ring stops by name; drop `RING_VALUE_KEYS`),
`earth-view` (`earthSslat`/`earthSslng`) → `u.get(name)`.

### 4. `observatory-entry.ts`
- `makeOverridableGetNow(() => timeController.getDisplayTime())`.
- Per frame: `updater.tick(env, perfNow, getNow, withDisplayTime,
  timingContextForFrame(timeController))`; `animating = updater.anyAnimating()`.
  Removes the hand-rolled `tickIntervalMs`/`displayDelta`/`timeDirection` block.
- Pass `updater` to `initTimeControls`. **Transition callbacks: none** (given the
  trim) — the UI auto-resets the updater and calls `ensureSchedulerRunning`
  (`scheduleFrame`). `rebuildEnv()` stays, wired only to **location / noonOnTop**
  changes (where it's actually needed), not time transports.

> **Why no transition callbacks:** `invalidateRingCache()` is a **no-op** (the
> ring cache "is cleared implicitly by ObsValue reset"; the sun ring draws from
> values each frame), `env` is time-independent (getNow is a closure), and the
> static dial layer is time-independent. So on a time transport, `updater.reset()`
> + `scheduleFrame()` is all that's needed — exactly what the generalized UI does
> automatically. This is the `rebuildEnv`-trim; it must be verified (decision #1).

## Task list

1. **time-controls-ui.ts** — move `reset()`/`stop()` into `nowClicked`/`endHold`;
   add `updater?: {reset()}` + call it on every transition; make the 5 transition
   callbacks optional; add a built-in default `writeTimeState`
   (`writeTimeStateToUrl(timeController)`) used when the client omits it.
2. **Chronometer (`engine-entry.ts`)** — drop `timeController.reset()`/`stop()` from
   `onNowClicked`/`onScrubEnd` (now UI-owned) and drop its `writeTimeState` (use the
   default); keep the rest. Passes no `updater`.
3. **Generic keyed `Updater<K>`** (`shared/updater.ts`): `byName` map + `get(name: K)`.
4. **`obs-values.ts`** → `buildObsValues(): Updater<ObsValueName>` + `ObsValueName`
   union + startup assertion; delete `ObsValueSet`/`getAllValues`/cache/wrappers.
5. **Renderers** (`hand-views`, `planet-hands`, `ring-view`, `earth-view`) → name lookup.
6. **`observatory-entry.ts`** — `makeOverridableGetNow`; build + tick via `Updater`;
   pass `updater` to controls; drop transition callbacks **and `writeTimeState`**
   (uses default → Observatory now persists time to URL); rewire `rebuildEnv` to
   location/noonOnTop only.
7. **Inspector (`inspector-entry.ts`)** — pass catalog `updater` to controls; drop
   the now-auto catalog reset, the UI-owned `timeController.reset()`/`stop()`, and
   its `writeTimeState` (use default) from its callbacks; keep the
   `rebuildExprValues` custom hook.
8. **Delete dead code** + fix imports across the Observatory files.
9. **Verify** (below).
10. **Docs**: `observatory.md`, `animation.md` (Updater keyed lookup; the seam),
    `architecture-overview.md`, and the time-controls contract.

## Verification (behavior-preserving — prove it across all three apps)

- `tsc` + `bash build.sh` green; full `vitest` 8485 (Chronometer regression suites
  exercise its transport callbacks — the `reset`/`stop` move must keep them green).
- Bundle isolation unchanged.
- **Manual parity (ask reviewer):**
  - **Chronometer**: Now / pause / scrub / step / reverse still behave identically
    (esp. the stop-freeze and "Now"). *Highest-risk area — shared UI change.*
  - **Observatory**: renders identically (hands, sun-event hands, 6 rings + polar
    flags, 16-stop sun ring, planet hands, earth terminator) at 1× / scrub /
    reverse / step / stop. Main new failure mode: a mis-typed name → `get` miss
    (guarded by `ObsValueName` typing + startup assertion).
  - **Inspector**: catalog + expr box still track/scrub/stop correctly; "Now",
    step, and date inputs still work (the earlier `ensureSchedulerRunning` fixes).

## Out of scope (explicit follow-ups)

- **Eval-ahead convergence**: migrate Observatory's `naturalSpeed`/scrub values to
  eval-ahead, then delete the legacy `updateNaturalSpeedValue`/`updateObsValueScrub`
  branches. Behavior-changing; separate validated pass.
- **Inspector expr-box into the updater** (would drop its last custom callback).
- Chronometer `HandState` → `ObsValue`/`Updater` (large, separate).

## Resolved (from review)

- **`rebuildEnv` trim:** included — Observatory needs no transition callbacks. ✓
- **Cross-app reach:** approved — make the seam truly generic (touches the shared
  time-controls UI + drops 2 delegated controller actions from Chronometer). ✓
- **Generic time-state URL persistence:** included now via a default
  `writeTimeState` (overridable) — the time params are the controller's domain and
  identical across apps; Observatory gains persistence. Broader URL params stay
  out of scope. ✓
- **Eval-ahead convergence:** stays out of scope. ✓
- **Long-term Chronometer integration** noted in the text; we do only what this
  port requires, plus generic-with-override where it's cheap and clearly right now.

No open questions remain — ready to implement on your go.
