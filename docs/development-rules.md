# Rules to Follow When Making Changes

This document collects critical invariants, rules, and pitfalls that must be observed when modifying the Chronometer Web codebase. Violating these rules tends to produce subtle bugs that are hard to diagnose.

## 1. Keep Documentation Up to Date

If you change anything that would invalidate a doc in this directory, update the doc at the same time. If you add something that should be covered by the docs but isn't, add that too. The docs should always reflect the current state of the codebase.

When editing HTML files (especially the help files in `src/help/`), format them with Prettier: `npx -y prettier --write src/help/*.html`.

## 2. Never Simplify iOS Algorithms

When porting logic from the iOS reference code (`.chronometer-ref/`, `.esastro-ref/`, `.estime-ref/`), **never simplify** the logic. Code that appears redundant or overly complex is almost always handling an edge case that is not immediately obvious.

If you *cannot* implement the iOS algorithm directly for technical or structural reasons, **stop and ask the user** how to proceed. Do not attempt to design a novel approximation on your own.

**Example**: The Willmann-Bell astronomical calculations have intermediate steps that look algebraically reducible. They are not — they handle numerical stability at extreme date ranges.

## 3. Never Rebuild Parts at Runtime

Parts are parsed once at startup via `parseWatchXML`. The resulting `watch.parts` array is **never replaced** after that. All runtime state changes — time ticks, location changes, body switches, timezone changes — must preserve the existing part tree.

**The animation-preserving pattern** (used for any input change):
1. Create a fresh `Environment` via `createWatchEnvironment()` (picks up new lat/lon/timezone/body)
2. Preserve existing `HandState` objects — do **not** call `initHandStates()`
3. Reset hand schedules (`hs.nextUpdateTime = 0`) so expressions re-evaluate immediately
4. Update terminator leaf angles and reset their schedules
5. Rebuild static caches (`buildStaticBlockCaches()`) for visual elements that depend on the new state
6. Restart the scheduler

**The only exceptions** where full rebuild (including fresh hand states) is acceptable: initial startup and canvas resize — both are "from scratch" moments where there are no animations to preserve.

**If you believe a full part rebuild is needed, stop and ask the user.** There is almost certainly a way to achieve the desired effect by refreshing the environment and resetting schedules instead.

## 4. Rendering Order is Sacred

Parts must be rendered in exactly the order they appear in the XML file. This order is critical for correct visual layering:
- Hands that overlap other hands must appear later in the XML than the hands they overlap.
- "Windows" (cutout borders) must appear after the parts that show through them but before any hands that overlap them.
- The renderer must **not** sort, reorder, or apply z-index logic — it must use pure document order.

## 5. API Pitfalls

### `julianCenturiesSince2000EpochForDateInterval` returns an object

This function returns `{ julianCenturiesSince2000Epoch: number, deltaT: number }`, **not** a bare number. Always destructure it:

```typescript
const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
```

### NaN guards in astronomical functions

During initial hand state collection (`createHandState` in `animation.ts`), expression functions may be called before all variables are resolved, producing `NaN` inputs. Functions that do table lookups (e.g., `findOuterPlanetDatum` in `wb-planets.ts`) must guard against `NaN` at the top:

```typescript
if (isNaN(U)) return null;
```

`NaN` defeats range checks because `NaN < x` and `NaN > x` are both `false`, causing index calculations to produce `NaN` and crash on array access.

### Boundary scheduling must use `rawGetNow`, never `getNow`

`HandState` has two time sources: `getNow` (quantized by `beatsPerSecond`) and `rawGetNow` (unquantized). `computeNextBoundary` and `displayTimeToPerfNow` must always use `rawGetNow`. Using the quantized `getNow` causes `Math.ceil` to return the current time (not the next boundary) when the quantized time is already aligned, leading to every-frame evaluation and a visible ~0.5s timing skew between faces with different `beatsPerSecond` values. See the `[!IMPORTANT]` block in [animation.md](animation.md) for details.

## 6. Animation Schedule Reset Rules

Reset hand schedules (`nextUpdateTime = 0`) only at **discrete transition points**:
- Single step taps
- Body switches
- Start of hold-to-scrub

Do **not** reset on every tick during continuous scrubbing — the quantized tick system handles scheduling correctly, and resetting disrupts in-progress animations.

Terminator leaves have their own `nextUpdateTime` and `resetLeafSchedules()` function. These must also be reset at the same transition points as hand states.

## 7. Engine Bundling Awareness

`watch-env.ts` is bundled into `chronometer-engine.js` (the shared engine), not into the per-face bundles. This means adding new environment functions requires rebuilding the engine, which affects all faces. After adding env functions, always do a full `bash build.sh` rebuild.

## 8. Interactive Controller Patterns

### Planet/body selector

Faces like Venezia that allow switching between celestial bodies use a URL parameter (`?body=...`) for state persistence. The selector UI is injected into `#planet-selector` in `face-template.html`, hidden by default and shown only for applicable faces.

### URL parameter vs init blocks

When the URL specifies a body parameter, it must be applied **after** XML init block evaluation in `watch-env.ts`, as init blocks may set default values that would overwrite the URL parameter.

### Animation-preserving body switch

When switching bodies, preserve existing `HandState` objects rather than recreating them. Update the environment, reset schedules, and let the animation system interpolate from old to new target values for smooth transitions. (This is an instance of the general rule in §3.)

### Vienna noon/midnight toggle

Vienna's 24-hour dial supports switching between midnight-on-top (default) and noon-on-top via a `vnoon=1` URL parameter and a pill toggle in `#vienna-noon-toggle`. The toggle:
1. Sets `noonOnTop` and `dialFlip` env variables (the XML uses `dialFlip` in hand angles and day/night ring `masterOffset`)
2. Swaps the 24-hour dial number text on the parsed `QDialPart`
3. Rebuilds the static cache and resets hand/analemma schedules

This follows the same post-init-override pattern as `body=` (applied after init blocks in `watch-env.ts`).

## 9. If Blocked, Ask

If you cannot implement the iOS algorithm directly, cannot find the source of a rendering bug, or believe a fundamental architectural constraint needs to be violated — **stop and ask the user** how to proceed. Do not attempt speculative workarounds.

## 10. Date Range Constraint: 4000 BCE – 2800 CE

The astronomical series approximations (Willmann-Bell planetary/sun tables) are only valid for the range **4000 BCE to 2800 CE**. All time-mutation paths must enforce this invariant:

- `TimeController.clampDisplayTime()` checks the current display time against the boundary constants `MIN_DISPLAY_DATE_MS` / `MAX_DISPLAY_DATE_MS` (from `es-time.ts`). When the limit is hit, the clock stops (if running) or the frozen value is clamped (if stopped). This mirrors iOS `ESWatchTime::checkAndConstrainAbsoluteTime()`.
- The method is called after every time mutation (`step`, `setTime`, `setRate`, `setDirection`, `setOffset`, `checkTick`) and in the render-loop frame callback (for 1×/-1× with offset).
- Date input fields in `applyDateInputs()` clamp the constructed date before passing it to `setTime()`.
- `formatSimTime()` appends "⚠ earliest" or "⚠ latest" at the boundary.
