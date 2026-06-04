# Inspector ObsValue Animation — Plan

**Date:** 2026-06-03
**Status:** Short-term build implemented (rev. 5). Future-architecture sections
remain forward design (not built).

> **Initial scope vs. forward design.** The Inspector UI today has a *single*
> expression input, so the code we actually write now drives **one expression
> (two ObsValues)**. But the page is expected to grow to many expressions, so this
> plan also fixes the shared/app boundaries (see *Collection management across
> apps*) so that scaling to O(50) values needs no re-layering later.

## Goal

Change the Inspector's expression evaluator so each displayed value is driven by
an **ObsValue** (the Observatory animation primitive): the expression is fully
re-evaluated only every **0.1 s** (epoch-aligned), and the displayed value is
**animated smoothly between updates at the full frame rate** (up to the 240 fps
target).

Crucially, the animation **aims one update interval into the future** ("eval-ahead")
so the display is *not lagging* real time — it tracks `A(t)` with only symmetric
curvature error, zero time offset. This is the same idea that makes Observatory's
`naturalSpeed` second hands lag-free (sweep toward where the value *will be*),
generalized to arbitrary expressions.

### Why this, and why now

- **`ObsValue` is the future general-purpose animation mechanism** for the whole
  codebase (we expect to port Chronometer's hand animation onto it eventually).
  So we **promote the generic `ObsValue` core into `src/shared/`** and make the
  Inspector its first non-Observatory consumer.
- **The Inspector is the deliberate guinea pig** for driving *many* values at very
  high frame rates from a small number of expensive evaluations. A single
  expression would fit in a 240 fps budget even if re-evaluated every frame, and a
  text display needs nowhere near that rate — but the Inspector is expected to grow
  into a large page with **many expressions**, and we want to prove out the
  "evaluate rarely, interpolate often" pattern on it.
- The Inspector's value is a different *shape* from Observatory's ~100 angular
  values (a single arbitrary value that we display three ways), so it doubles as a
  generality test for the shared core.

## Background — current state

- **Inspector** ([src/inspector/inspector-entry.ts](../src/inspector/inspector-entry.ts)):
  `getNow = () => new Date()` (real time, no time controller yet — a comment notes
  "Phase 4 will add time controller"). `tick()` re-evaluates the cached AST **every
  frame** and renders the result three ways — **Number**, **Angle** (`× 180/π`),
  **Date** (interpreted as a dateInterval). The AST is re-parsed only on text change.

- **ObsValue** ([src/observatory/obs-values.ts](../src/observatory/obs-values.ts)):
  Each dynamic element holds a parsed AST, an update interval, animation speeds, an
  `AnimatingValue`, and scheduling state. Three per-frame passes — `updateObsValues`
  (re-eval expired exprs, start animations), `animateObsValues` (interpolate toward
  targets), draw (read `currentValue`). Update branches: scrub compression, two-phase
  `naturalSpeed` sweep, and snap-to-target. The `linear` flag selects angle vs.
  raw-value animation semantics (`fmod`/shortest-path unwrap vs. straight line).

- **Animation primitives** ([src/shared/animation.ts](../src/shared/animation.ts),
  already shared): `AnimatingValue`, `makeAnimatingValue`, semantics-free
  `startValueAnimation`/`interpolateValue`, angle wrapper `startAnimationRaw` (with a
  `linear` flag + NaN-snap guard), `computeNextBoundary`, `displayTimeToPerfNow`.
  > Note: the prose in some docs says `src/watch/animation.ts`; it actually lives in
  > `src/shared/animation.ts`. Fix those references as part of the doc updates below.

## The mechanism: eval-ahead (lag-free)

The 0.1 s lag in a naive "sample then interpolate" design comes from aiming the
animation at a value we have **already passed** (`A(T)`), so the display shows
`≈ A(t − 0.1)`. The fix is to aim at the **next** boundary instead.

Because an expression is a **pure function of display time**, we don't have to
*estimate* the future (as `naturalSpeed` does with a known rate, or as a numerical
derivative would) — we can **sample it directly**:

At each update (real time `perfNow`, display time `T`):
1. `nextDisplayMs = computeNextBoundary(0.1 s, getNow, dir, env)` — the next aligned
   0.1 s boundary in display time.
2. `nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow)` — when that
   boundary occurs in real time; `budgetMs = nextUpdateTime − perfNow` (≈ 0.1 s @ 1×).
3. **Evaluate the target at the boundary:** `target = A(nextDisplayMs)` (eval-ahead).
4. `startAnimationRaw(anim, target, perfNow, …, budgetMs, linear)` — sweep from the
   current position to `target`, arriving exactly at the boundary.

In steady state the previous sweep landed on `A(T)` exactly at `T`, so each interval
is the chord `A(T) → A(T+Δ)`: **error is symmetric (zero at both endpoints), no time
lag.** Per update this is **one evaluation** (the current anchor comes from the
animation state, not a fresh "now" eval) — same eval budget as the lagging design,
but correct. Dropped frames / backgrounded tabs self-heal within one 0.1 s interval,
so no explicit catch-up phase is needed at this granularity.

> **Relationship to `naturalSpeed`:** for a constant-rate value, eval-ahead at the
> boundary reproduces the `naturalSpeed` sweep exactly. Eval-ahead is the more
> general mechanism (no rate needed). A future unification could have the two-phase
> sweep obtain its target via eval-ahead instead of `naturalSpeed × t`, making
> lag-free tracking work for *any* expression — **out of scope here**; Observatory's
> existing behavior stays byte-for-byte.

### Evaluating at a specified display time (the one new primitive)

Eval-ahead needs to evaluate an expression as if `getNow()` returned a chosen
display time. The display time enters expressions only through the `getNow` closure,
so we make that closure transiently overridable. Shared utility, placed in the **new
`src/shared/updater.ts`** (see *The "updater" direction* below):

```ts
// src/shared/updater.ts
export function makeOverridableGetNow(base: () => Date): {
  getNow: () => Date;
  withDisplayTime<T>(displayMs: number, fn: () => T): T;  // sets override, runs fn, restores
};
```

The app builds its `getNow` via this factory and passes the env (built on `getNow`)
plus the holder to the updater. In eval-ahead mode the updater computes the target
with `holder.withDisplayTime(nextDisplayMs, () => evalAttr(v.expr, env))`.

> **Placement, revised in review.** An earlier draft proposed a `time-source.ts`.
> But the reviewer's key observation — the relevant shared *semantic object* is the
> **updater** — argues for seeding that file now and putting time-shifting (which only
> the updater consumes, for eval-ahead) there. We avoid creating a near-empty
> `time-source.ts` that we'd reshuffle. If shared time-*sourcing* later grows
> (time-controller unification, `makeGetNow` quantization migration — see *Future
> architecture*), a `time-source.ts` can split out then.

- **Cache-thrash note:** eval-ahead evaluates **only** at the ahead time within a
  frame (never also at "now"), so there is at most one evaluation instant per frame —
  no per-frame astro-cache thrash. If a future consumer ever needs both `now()` and
  `now()+interval` simultaneously, the astro **cache pool already supports a small
  number of distinct simultaneous times** — allocate a separate cache for the ahead
  time. Not needed now.

## Design decisions (resolved)

### (A) Angle vs. linear — show **both**, one flag, two ObsValues
The page already displays the value as an **angle**, a **date**, and a **raw
number**. Those have different correct animation semantics:

| Display | Semantics | `linear` flag |
|---------|-----------|---------------|
| Angle (`× 180/π`) | angular — wrap `[0,2π)`, shortest path | `false` |
| Number (raw) | linear — straight-line interp | `true` |
| Date (dateInterval) | linear — straight-line interp | `true` |

So per expression we store **two ObsValues** sharing the same parsed AST: one
angle-tagged (`linear:false`) feeding the **Angle** readout, one linear-tagged
(`linear:true`) feeding the **Number** and **Date** readouts. The behavior is
selected entirely by the existing `linear` flag on `ObsValue`.

- **Decided: keep it simple — each ObsValue self-evaluates** (2 evals per expression
  per 0.1 s; identical raw numbers, wrapped differently). Negligible vs. per-frame
  eval, and keeps the shared core uniform. We are *not* adding a 1-eval "fan-out"
  path to the shared core, because evaluating one expression two ways is an
  Inspector-specific quirk unlikely to recur in other apps — not worth generalizing.

### (B) Expression text (or location) change — **snap**
On text change we re-parse and **rebuild both ObsValues** (snapping their
`AnimatingValue`s to the freshly evaluated value); never animate from the old
expression's value to the new one. Same on location change (env rebuilt). The aim,
exactly like the `naturalSpeed` hack, is approximately-correct values via the
animation system — we don't care about a readout "jumping" on a deliberate change.

### (C) Scheduling — **epoch-aligned 0.1 s**
`computeNextBoundary(100, getNow, 1, env)` so samples land on aligned .0/.1/.2
boundaries, consistent with Observatory. The sweep completes right at each boundary,
where `currentValue == A(boundary)` exactly and the next sweep begins.

## The refactor — promote the generic core to `src/shared/`

Split [src/observatory/obs-values.ts](../src/observatory/obs-values.ts) into a shared
**value type** (`obs-value.ts`), a shared **updater** (`updater.ts`), and the
Observatory-specific catalog (stays in `obs-values.ts`). The two-file split of the
shared code is deliberate: it separates *the value* from *the thing that drives
values*, seeding the "updater" encapsulation (see below) **without any throwaway
structures** — these functions are exactly what the updater will own.

### New: `src/shared/obs-value.ts` (the value)
The data type and single-value construction — no orchestration:

- `ObsValue` interface (+ new optional `evalAhead: boolean`), `ObsValueDef`
- `createObsValue(def, env, perfNow)`

### New: `src/shared/updater.ts` (the embryonic updater)
All the logic that *drives* ObsValues, operating on a single `ObsValue` or a flat
`ObsValue[]` (no `ObsValueSet`):

- `updateObsValue(v, env, perfNow, getNow, …, timeDirection)` — single-value
  dispatcher: existing scrub / `naturalSpeed` / snap branches **plus a new
  eval-ahead branch** (gated by `v.evalAhead`) implementing the steps above
- `updateObsValues(values: ObsValue[], …)`, `animateObsValue` /
  `animateObsValues(values: ObsValue[], perfNow)`,
  `anyObsAnimating(values: ObsValue[])`, `resetObsValueSchedules(values: ObsValue[])`
- `makeOverridableGetNow` (eval-ahead's time-shift; the updater is its only consumer)
- constants `K_ANGLE_ANIM_SPEED`, `NATURAL_ERROR_THRESHOLD`

Both modules depend only on shared code (`animation.ts`, `astro-env`'s `evalAttr`), so
the move adds no cross-boundary imports. **Observatory's existing branches are
unchanged** (eval-ahead is opt-in via the flag).

### Keep: `src/observatory/obs-values.ts` (Observatory catalog)
Retains `ObsValueSet`, `buildValueDefs`, `earthDefs`, `initObsValues`,
`getAllValues` (+ `allValuesCache` / `invalidateObsValueCache`), and adds **thin
`ObsValueSet` wrappers** for `updateObsValues` / `animateObsValues` /
`anyObsAnimating` / `resetObsValueSchedules` that delegate to `updater.ts` via
`getAllValues(vs)`. Re-export the `ObsValue` type for the renderers.

**Result: `observatory-entry.ts` and the renderers (`ring-view`, `planet-hands`,
`hand-views`, `earth-view`) need no changes** — verified: renderers use only the
`ObsValueSet` *type*; only `observatory-entry.ts` calls the per-frame functions, all
with `ObsValueSet`.

### Inspector consumes the shared code directly
`inspector-entry.ts` imports the value type from `src/shared/obs-value.js` and the
driving functions + `makeOverridableGetNow` from `src/shared/updater.js`. It must
**not** import from `src/observatory/`.

## Collection management across apps (`ObsValueSet`, and beyond)

> **Revised in review.** An earlier draft argued the three apps want *structurally
> different* collections and so nothing beyond the array passes should be shared.
> Reviewer feedback reframes all three as the **same shape — a keyed collection of
> predefined values** — which makes a shared collection plausible and probably the
> eventual direction. Recorded here as forward design; **not** built short-term.

The realization: every app ultimately wants **named/keyed access to a predefined set
of ObsValues**, plus iterate-all for the passes. `ObsValueSet`'s typed struct is just
one spelling of that.

| App | What it really wants | Spelling |
|-----|----------------------|----------|
| **Observatory** | the existing named values | enum/string key → ObsValue (today: a typed struct) |
| **Inspector** (O(50) future) | a series of **predefined, named** values shown to the user (an extension of the sunrise/sunset section — *not* the arbitrary user-expression input) | enum/string key → ObsValue |
| **Chronometer** (future port) | per-part values, but the *values* don't need part-grouping — a flat map keyed `"<part>.<subpart>"` (e.g. `moonHand.angle`, `moonHand.offsetAngle`) works; the part looks up its own keys to render | string key → ObsValue |

So all three collapse to a **keyed `Map<Key, ObsValue>`** (Key = per-app enum or
string union). Flat-list iteration for the passes is just `.values()`; the
`allValuesCache` becomes an internal detail of the collection. Per-part grouping in
Chronometer becomes a *naming convention*, not a structural difference.

- **Trade-off:** the typed struct (`vs.sunrise`) gives compile-time checks and
  autocomplete; a stringly-keyed map needs discipline (typos → runtime errors).
  Recover most of that with per-app `enum`/string-literal-union key types or a thin
  typed accessor. Worth weighing if/when we unify.
- **Short-term:** unchanged. Observatory keeps `ObsValueSet` + its cache (zero churn);
  the Inspector ships the single user expression (two ObsValues). The shared core
  stays **array-based**, and a future keyed collection feeds it via `.values()`, so
  **today's code is already forward-compatible** with the unification.

**Eval-load spikes — staggering vs. workers.** With values epoch-aligned to the same
0.1 s boundary (decision C), they'd all re-evaluate on the *same* frame — a periodic
main-thread spike (e.g. 100 evals in one frame, then ~11 idle frames @ 120 fps). Two
ways to address it, both future:
- **Staggering** each value's update phase so eval cost spreads across frames (simple,
  but a slow expression then needs an earlier stagger point — fiddly to tune).
- **Worker-thread evaluation** (next section) — moves eval off the main thread
  entirely, which makes staggering largely unnecessary: even if many results land at
  once, absorbing them is just cheap buffer writes. This is the more general/robust
  option and the likely preference.

## Future architecture (exploratory — not in short-term scope)

These ideas don't change what we build now, but they shape the *interface* we should
preserve: the per-frame consumer contract stays **"`update()`; `animate()`; read
`currentValue`; draw"**, with everything about *how/when* values are computed hidden
behind the updater. As long as consumers only read `currentValue` (never assuming
"after `update()`, `currentValue` reflects *this* frame's fresh eval" — which
eval-ahead already breaks), the eval strategy can change underneath them freely.

### Worker-thread evaluation with double-buffering

Move expression evaluation onto one or more **worker threads**, so the main thread
only ever interpolates and draws — no eval hitches regardless of value count or
expression cost.

- **⚠️ Hard prerequisite — `file://` workers.** `file://` (double-click a release
  zip) is the project's *primary* target, so the whole mechanism is contingent on a
  spike: confirm a worker **created from a Blob URL** (`URL.createObjectURL(new
  Blob([code]))`, code bundled inline) runs on `file://` in the target browsers
  (Chrome/Safari/Firefox). Classic `new Worker('file://…')` is blocked in Chrome, so
  Blob-URL is the only candidate. **If it doesn't work everywhere we care about, we
  drop the worker mechanism entirely** (fall back to eval-load staggering / main
  thread) — per reviewer's bar.
- **No `SharedArrayBuffer`.** SAB needs cross-origin isolation (COOP/COEP), impossible
  on `file://`. Transport is therefore plain `postMessage` of tiny `{key, boundary,
  value}` payloads (numbers — cheap; this is the only transport, not a fallback).
- **Pipeline (2-deep).** Boundaries `b₀,b₁,…` spaced Δ. Interval `[bᵢ,bᵢ₊₁]` needs
  `A(bᵢ₊₁)` at `bᵢ`. Giving a worker up to Δ to respond, the request goes out at
  `bᵢ₋₁`; equivalently, **at each boundary `bⱼ` request `A(bⱼ₊₂)`** (two ticks before
  the target time, as suggested). Boundaries are deterministic (epoch-aligned), so
  these future times are known in advance — including under scrub (apply
  `computeNextBoundary` twice). Pipeline depth is tunable: request 3+ ahead to give
  slow expressions more headroom.
- **Double buffer / page-flip — promote *only at the boundary*.** Results arrive
  mid-interval and are written to the *inactive* buffer (a parallel "upcoming" array
  swapped by one reference/index change); a single flip at the boundary promotes them.
  **We deliberately do *not* retarget mid-interval even though the value is already
  in hand** — for a non-linear value, switching the animation target early *increases*
  interpolation error vs. completing the sweep to the scheduled target and only then
  adopting the new one (reviewer's point). **Tag each result with its target boundary**
  so out-of-order arrivals (multiple workers) can't clobber newer data.
- **Late results.** In steady state the current sweep *completes exactly at the
  boundary*, so at the flip we are already sitting on the prior target — when the next
  buffer is ready we simply begin the next sweep, nothing else to do. (My earlier
  "keep animating toward the prior target" was wrong — there's nothing to animate
  toward when we're already there.) The only open case is when the next value is
  **late** (not delivered by the flip): we then need *some* policy — hold at the
  current value until it arrives, or extrapolate at the last velocity. **Deferred
  until we actually build this** (reviewer agreed).
- **Worker env.** Each worker builds its own `createAstroEnvironment` (lat/lon/tz) and
  re-parses (or receives) the ASTs; location/tz changes broadcast to all workers.
  Shard values across workers by key. Bootstrap the first ~2 intervals synchronously
  on the main thread so there's no blank startup.
- **Latency assumption.** Evaluation is typically sub-millisecond, so even hundreds of
  values across a few workers fit comfortably in Δ=0.1 s. A pathological expression
  slower than the pipeline depth × Δ delivers late → handled by the (deferred) late
  policy, and could earn a deeper per-value pipeline.

### Shared time-controller integration

`src/shared/time-controller.ts` already exists, but each app re-implements the *glue*
between it and animation: the transition handlers (`onScrubStart` → reset schedules,
stop → finish animations + freeze, step → reset + tick once, play → reset) live
duplicated in `engine-entry.ts` (Chronometer) and `observatory-entry.ts`
(Observatory), and the Inspector has none yet. With a shared updater owning the
ObsValue collection and its scheduling, **those transition responses become updater
methods** (`onStop()`, `onScrub()`, `onStep()`, `onPlay()`) driven by time-controller
events — shareable across all three apps. So the natural pairing is:
**time-controller (emits transitions) ↔ updater (responds, owns ObsValues)**, which
also lets the Inspector adopt the real time-controller (replacing `() => new Date()`)
with little app-specific code. Future work; noted because it reinforces where the
seams belong.

### The updater becomes an encapsulated subsystem (incl. the cache)

The worker idea, the keyed-collection idea, and the time-controller glue all point the
same way: the **update mechanism should be a black box** owning the keyed collection,
scheduling, the eval strategy (sync main-thread *or* worker pool), the **astro
caches**, the double-buffer, and the time-controller transition handlers. Per the
reviewer's point, if we move to one shared mechanism the cache belongs to that
mechanism — so swapping single-threaded → worker-backed eval, or sharing transition
glue, is entirely internal and invisible to consumers. Narrow interface, roughly:

```
define(key, def)            // register a predefined value
get(key).currentValue       // read (per frame, for draw)
tick(env, perfNow, …)       // advance scheduling/eval/promotion (or self-driving)
onStop/onScrub/onStep/onPlay()   // time-controller transition responses
anyAnimating() / reset()
```

We are **not** building this now. `src/shared/updater.ts` ships in the short term as
just the array-based passes + `makeOverridableGetNow` — the embryonic form of this
subsystem. The `currentValue` read contract is preserved so the box can grow later
without touching Observatory's renderers or the Inspector's read sites.

## Inspector implementation sketch

```ts
import { createObsValue, type ObsValue } from '../shared/obs-value.js';
import { updateObsValues, animateObsValues,
         makeOverridableGetNow } from '../shared/updater.js';

const EXPR_UPDATE_INTERVAL_SEC = 0.1;   // 10 Hz full re-eval, epoch-aligned

const { getNow, /* used by core for eval-ahead */ } = makeOverridableGetNow(() => new Date());
let env = createAstroEnvironment(lat, lon, getNow, locationTimezone);

// Per expression: two ObsValues sharing the parsed expression.
let exprAngle:  ObsValue | null = null;  // linear:false  → Angle readout
let exprLinear: ObsValue | null = null;  // linear:true   → Number + Date readouts

// On text change (replaces lastExprAST caching) / on location change:
//   parse once; createObsValue twice with
//     { expr:text, updateInterval:0.1, evalAhead:true, linear:false }  and  { …linear:true }
//   (rebuild snaps both AnimatingValues; never animates across expressions)
//   parse error → clear both, show error (current behavior)

// Per frame in tick():
//   if (exprLinear) {
//     const now = performance.now();
//     updateObsValues([exprAngle, exprLinear], env, now, getNow, /*1×*/ … , 1);
//     animateObsValues([exprAngle, exprLinear], now);
//     renderNumber(exprLinear.currentValue);
//     renderAngle (exprAngle.currentValue);   // × 180/π
//     renderDate  (exprLinear.currentValue);  // → dateInterval, existing range guard
//   }
```

- Readouts reuse the existing Number/Angle/Date formatting; `NaN` → today's "—"
  handling (eval-ahead's `startAnimationRaw` snaps on NaN endpoints, no poisoning).
- The `requestAnimationFrame` loop stays always-on (real-time 1×; no stopped state).
  Time-controller integration is future work, but eval-ahead already generalizes to
  forward/reverse/scrub via `computeNextBoundary`/`displayTimeToPerfNow`.
- Sunrise/sunset section (minute-based, separate) is unchanged.

## Step-by-step

1. **Create `src/shared/obs-value.ts`** (the value): `ObsValue` interface (+ optional
   `evalAhead`), `ObsValueDef`, `createObsValue`.
2. **Create `src/shared/updater.ts`** (the embryonic updater): `updateObsValue` +
   `updateObsValues` / `animateObsValue` / `animateObsValues` / `anyObsAnimating` /
   `resetObsValueSchedules` (Observatory behavior byte-for-byte) with the new
   `evalAhead` branch; `makeOverridableGetNow` + the `evalAttr`-at-display-time path;
   constants. Moves only shared deps (`animation.ts`, `astro-env`).
3. **Trim `src/observatory/obs-values.ts`**: import value type from `obs-value.ts`
   and driving fns from `updater.ts`; keep the catalog + `getAllValues` /
   `invalidateObsValueCache`; add the four thin `ObsValueSet` wrappers and the
   `ObsValue` type re-export. (`observatory-entry.ts` + renderers untouched.)
4. **Wire the Inspector**: build `getNow` via `makeOverridableGetNow`; replace
   `lastExprAST` with two `ObsValue`s rebuilt on text/location change; in `tick()`
   run `updateObsValues` + `animateObsValues` over `[exprAngle, exprLinear]` and map
   `currentValue`s to the three readouts.
5. **Build & verify**: `bash build.sh`; bundle isolation —
   `grep -c 'observatory/' dist/inspector-engine.js` → 0 and
   `grep -c 'watch/' dist/inspector-engine.js` → 0.
6. **Manual check**: a smoothly-changing expr (e.g. `secondValueAngle()`,
   `sunAltitude()`) animates smoothly at full frame rate, target stepping every 0.1 s,
   **with no perceptible lag vs. wall clock**; a wrapping angle takes the short path in
   the Angle readout while the Number readout moves linearly; a polar `NaN` expr shows
   "—"/`NaN` without poisoning; changing the expression snaps cleanly; Observatory is
   visually identical.

## Docs to update (per Development Rules §1)

- **[docs/inspector.md](../docs/inspector.md)** — evaluator now samples every 0.1 s and
  animates between samples via two shared `ObsValue`s (angle + linear), eval-ahead for
  lag-free display.
- **[docs/observatory.md](../docs/observatory.md)** — value type now in
  `src/shared/obs-value.ts`, driving logic in `src/shared/updater.ts`; Observatory
  keeps the catalog + thin wrappers.
- **[docs/architecture-overview.md](../docs/architecture-overview.md)** — add
  `obs-value.ts` (value) and `updater.ts` (embryonic updater) to `src/shared/`, the
  general-purpose animation-value layer (future Chronometer target).
- **[docs/animation.md](../docs/animation.md)** — document eval-ahead and the
  `ObsValue`/`updater` layer built on these primitives; fix any
  `src/watch/animation.ts` → `src/shared/animation.ts` references. Cross-reference
  `updater.ts`.
- **New `src/shared/updater.ts`** — document `makeOverridableGetNow` and the intended
  future role as the encapsulated update subsystem (keyed collection, eval strategy,
  caches, double-buffer, time-controller transition glue).

## Out of scope

- Inspector time controller / scrubbing UI (eval-ahead is shaped for it; no transport
  UI here).
- Unifying Observatory's `naturalSpeed` two-phase sweep onto eval-ahead.
- Porting Chronometer hand animation onto `ObsValue`.
- **Worker-thread evaluation + double-buffering** and a **shared keyed-collection
  updater subsystem** (see *Future architecture*). Recorded as forward design; the
  short-term code is shaped to allow them later without consumer changes.
- **Multi-value Inspector page** (predefined named values, eval-load staggering).

## Resolved decisions (from review)

- **Angle vs. linear:** show both — two ObsValues per expression via the existing
  `linear` flag. ✓
- **Text/location change:** snap. ✓
- **Scheduling:** epoch-aligned 0.1 s. ✓
- **One eval or two per expression:** two (simple); not generalized into the core. ✓
- **Shared file layout:** `obs-value.ts` (value type + `createObsValue`) **+
  `updater.ts`** (driving logic + `makeOverridableGetNow`) — seeds the "updater"
  encapsulation now, no throwaway. Replaces the earlier `time-source.ts` idea. ✓
- **`ObsValueSet`:** stays in Observatory short-term (zero churn); future direction is
  a shared keyed `Map<Key, ObsValue>` once apps need it. ✓
- **`file://` is primary:** no `file://`-incompatible optimizations — **`SharedArray
  Buffer` dropped**; workers (if pursued) gated on a Blob-URL `file://` spike. ✓
- **Worker results:** promote **only at the boundary**, never retarget mid-interval
  (non-linear error); late-result policy deferred. ✓
- **Astro-cache for simultaneous ahead+now:** separate cache-pool entry if/when
  needed; not needed now. ✓

## Open questions for reviewer

1. **Go/no-go on the short-term build** (steps 1–6) as written? It is deliberately
   simple — two shared files, two ObsValues, no collection/worker/buffer machinery —
   and creates no structures we'd throw away.
2. Anything else from *Future architecture* you'd want pulled earlier, or is deferring
   all of it (worker eval, keyed collection, staggering, shared time-controller glue)
   to its own future work correct?
