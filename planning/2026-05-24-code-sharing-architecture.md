# Code Sharing Architecture for Emerald Sequoia Web Apps

## Problem Statement

Chronometer Web has accumulated a substantial body of reusable infrastructure: astronomy computations (~1.2 MB of TS), animation primitives, a time controller, location/city search, and a help system framework. Future apps — starting with Emerald Observatory — need much of this but should **not** pull in Chronometer-specific code (XML parsing, watch rendering, face grid, etc.).

The question: what's the right way to structure the codebase(s) so that shared code is reusable, app-specific code stays isolated, and contributors can work on one app without risking breakage in another?

---

## What Needs to Be Shared vs. What Doesn't

### Definitely shared

| Module | Current location | Approx size | Notes |
|--------|-----------------|-------------|-------|
| Astronomy (WB) | [src/astronomy/](file:///Users/spucci/chronometer-web/src/astronomy/) | ~1.2 MB | 14 files. Pure computation, zero DOM deps |
| Expression evaluator | [src/expr/](file:///Users/spucci/chronometer-web/src/expr/) | 30 KB total | Generic parser/evaluator. iOS EO doesn't currently use this, but the web EO port should have it available |
| Astro environment functions | Subset of [watch-env.ts](file:///Users/spucci/chronometer-web/src/watch/watch-env.ts) | TBD | The ~100 astronomy/calendar/time function registrations. Must be extracted from watch-env.ts into a shared `astro-env.ts` |
| Animation system | [animation.ts](file:///Users/spucci/chronometer-web/src/watch/animation.ts) | 47 KB | The full animation system including `AnimatingValue`, interpolation, `HandState`, `tickAnimations`, and XML-expression-driven scheduling. Kept unified since Observatory and future apps are likely to need expression-driven scheduling too |
| Time controller | [time-controller.ts](file:///Users/spucci/chronometer-web/src/time-controller.ts) | 21 KB | Imports only `es-calendar.ts` and `es-time.ts` |
| Location dialog (main) | [partials/location-dialog.*](file:///Users/spucci/chronometer-web/src/partials/) | 14 KB | HTML+CSS partial. Depends on city-search, mini-map |
| City search | [city-search.ts](file:///Users/spucci/chronometer-web/src/city-search.ts) | 9 KB | + `cities-data.js` (19 MB). Pure data, no DOM |
| Mini map (globe) | [mini-map.ts](file:///Users/spucci/chronometer-web/src/mini-map.ts) | 8 KB | Blue Marble renderer, OSM tiles |
| DST detection | [dst-detect.ts](file:///Users/spucci/chronometer-web/src/dst-detect.ts) | 5 KB | Pure computation |
| TZ resolution | [tz-resolve.ts](file:///Users/spucci/chronometer-web/src/tz-resolve.ts) | 1 KB | Pure computation |
| URL state helpers | [url-state.ts](file:///Users/spucci/chronometer-web/src/url-state.ts) | 10 KB | Read/write lat/lon/tz/time params |
| Help system (visual pattern) | Pattern in [engine-entry.ts](file:///Users/spucci/chronometer-web/src/engine-entry.ts) + [face-template.html](file:///Users/spucci/chronometer-web/src/face-template.html) | — | See "Help system" section below |

### Chronometer-only (should NOT be shared)

| Module | Notes |
|--------|-------|
| XML parser | Parses Chronometer's specific XML watch format |
| Renderer | Canvas rendering of watch parts (QHand, QDial, QWedge, etc.) |
| Terminator / Analemma | Watch-face-specific visual elements |
| Face grid / picker | Multi-face layout, selection, deep linking |
| Terra/Gaia slot system | World-time customization UI |
| Terra/Gaia city dialog | `terra-city-dialog.html/css` partial |
| Face template HTML | Chronometer-specific page structure |
| Per-face bundles | XML + image assets per watch face |
| Kyoto wadokei / Vienna noon toggle | Face-specific state in watch-env.ts |
| Venezia body selector | Face-specific state in watch-env.ts |

---

## Deployment Model

Each app will be served from its own URL path:
- Chronometer: `/ecweb/` (existing)
- Inspector: `/ecweb/inspector.html` (lives in Chronometer's dist for now)
- Observatory: `/eoweb/` (future)
- Future apps: their own paths

Inspector is simple enough that it ships as a single page inside the Chronometer dist. Observatory and other full apps will get their own paths.

---

## Help System: Shared Visual Pattern, Simpler Structure

All apps should share the same visual pattern:
- **ℹ button** in the top right → opens a popover
- Popover can **shift right** to show sub-pages (Privacy, Disclaimer, Support)
- **Version number** (including build number) at the bottom
- **Same visual styles** — differing only by theme color per app
- External links open in new tabs

What **doesn't** need to be shared:
- Chronometer's per-face help sections and `<details>` grouping
- The general help iframe (Complications table, Eclipse prediction, etc.)
- Build-time HTML injection of per-face content into `<template>` elements

For Observatory and other single-page apps, the help popover would contain a single help section (the app's own help content) rather than the face-specific collapsible sections. The shared implementation should be the **popover shell** (ℹ button, slide-right navigation to Privacy/Disclaimer/Support, version display, styles). App-specific help text is injected into that shell.

> [!NOTE]
> The help popover shell, privacy/disclaimer/support partials, and help-subview CSS are good candidates for `src/shared/help-framework/`. The per-face logic (combined help, `<template>` cloning, thumbnail injection) stays in Chronometer's engine-entry.ts. Sharing implementation is worthwhile here only if it doesn't add nontrivial complexity.

---

## Alternatives

### Alternative A: Single Repo, Separate Pages ("Monolith")

Keep everything in `chronometer-web`. New apps become separate pages with their own entry points, HTML templates, and engine bundles. The repo name stays `chronometer-web`.

#### Structure

```
chronometer-web/
├── src/
│   ├── astronomy/           # shared
│   ├── expr/                # shared
│   ├── shared/              # NEW: extracted shared modules
│   │   ├── animation.ts         # Full animation system (moved from watch/)
│   │   ├── astro-env.ts         # NEW: astronomy function registration (from watch-env.ts)
│   │   ├── time-controller.ts   # moved here
│   │   ├── city-search.ts       # moved here
│   │   ├── help-framework/      # popover shell, sub-page navigation, styles
│   │   ├── location-dialog/     # HTML+CSS+TS
│   │   ├── url-state.ts
│   │   ├── mini-map.ts
│   │   ├── dst-detect.ts
│   │   └── tz-resolve.ts
│   ├── watch/               # Chronometer-specific
│   │   ├── watch-env.ts     # Imports astro-env, adds Terra/Kyoto/Venezia specifics
│   │   ├── renderer.ts
│   │   ├── xml-parser.ts
│   │   └── ...
│   ├── inspector/           # NEW: Inspector app (text-only astro values)
│   │   ├── inspector-entry.ts
│   │   └── inspector.html
│   ├── observatory/         # FUTURE: Observatory app
│   │   ├── observatory-entry.ts
│   │   ├── observatory-template.html
│   │   └── ...
│   ├── engine-entry.ts      # Chronometer entry point
│   └── ...
├── build.sh                 # Extended to build Inspector (and later Observatory)
└── dist/
    ├── index.html           # Chronometer index
    ├── inspector.html       # Inspector page
    └── ...
```

#### Pros

- **Simplest migration.** No new repos, no package management, no version coordination.
- **Single build.** One `bash build.sh` produces all apps' outputs.
- **Shared code changes are immediately visible** to all apps — no publish/sync step.
- **Tests run together.** A change to astronomy code is tested against both Chronometer and Inspector tests in one `npx vitest` run.
- **Consistent versioning.** One `version.txt`, one build number.
- **Deployment is straightforward.** Inspector ships right alongside Chronometer in the same `dist/`. Observatory would later deploy to its own path.

#### Cons

- **Contributor coupling.** A PR that touches `src/astronomy/` could break Chronometer even if only Inspector is intended. Tests mitigate this but don't eliminate it.
- **Build bloat.** `build.sh` grows more complex. But esbuild is fast enough that this is measured in seconds, not minutes.
- **Conceptual sprawl.** The `chronometer-web` repo contains non-Chronometer code. README and docs need to accommodate this. (Mitigated by keeping the repo name; Inspector and Observatory live in clearly labeled subdirectories.)
- **Bundle isolation requires discipline.** Must ensure `inspector-engine.js` doesn't accidentally pull in watch-specific code. esbuild's tree-shaking helps but isn't foolproof — shared files that import watch-specific types will pull them in.
- **Single `package.json`.** Dependencies are shared; an Inspector-only dependency becomes a Chronometer dependency too. (Unlikely to matter for Inspector, which needs no extra deps.)

---

### Alternative B: npm Workspace Monorepo

Use npm/pnpm workspaces to create multiple packages in one repo, with a shared library package.

#### Structure

```
chronometer-web/                     # Same repo, restructured
├── packages/
│   ├── astro-core/              # Shared library
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── astronomy/
│   │   │   ├── expr/
│   │   │   ├── astro-env.ts
│   │   │   ├── animation.ts
│   │   │   ├── time-controller.ts
│   │   │   ├── city-search.ts
│   │   │   ├── location/
│   │   │   ├── help-framework/
│   │   │   └── ...
│   │   └── tsconfig.json
│   ├── chronometer/             # Watch app
│   │   ├── package.json         # depends on @emerald/astro-core
│   │   ├── src/
│   │   │   ├── watch/
│   │   │   ├── engine-entry.ts
│   │   │   └── ...
│   │   ├── build.sh
│   │   └── dist/                # deploys to /ecweb/
│   ├── inspector/               # Text-only astro values
│   │   ├── package.json         # depends on @emerald/astro-core
│   │   ├── src/
│   │   └── dist/
│   └── observatory/             # Observatory app (future)
│       ├── package.json         # depends on @emerald/astro-core
│       ├── src/
│       └── dist/                # deploys to /eoweb/
├── package.json                 # workspace root
└── tsconfig.base.json
```

#### Pros

- **Clean dependency boundaries.** Each app declares its dependencies explicitly. `import` resolution enforces that Chronometer code can't leak into Inspector/Observatory and vice versa.
- **Independent builds.** Each app has its own `dist/` and build script.
- **Framework flexibility.** Each app could use different build tools without affecting others.
- **Scale-friendly.** Adding more apps is straightforward — another `packages/` entry.
- **Still one repo.** CI, PRs, and issues stay unified.
- **Contributor isolation.** A contributor in `packages/inspector/` can't accidentally modify watch rendering code.

#### Cons

- **Significant refactoring upfront.** Must move files, fix all import paths, create package.json files, set up workspace configuration, and adapt build.sh.
- **Build complexity.** Need to build `astro-core` before apps (or use TypeScript project references). The current simple `bash build.sh` → esbuild pipeline gets replaced by a more complex orchestration.
- **The current no-framework, no-bundler-config simplicity is lost.** Workspaces introduce `node_modules` hoisting issues, TypeScript project references, and tooling overhead.
- **HTML partial sharing is awkward in workspaces.** The location dialog HTML/CSS isn't a normal JS module — it's injected by `build.sh` via `awk`. Workspace packages don't naturally share non-JS assets.

---

### Alternative C: Separate Repos with Shared Library (Git Submodule or npm Package)

Create a separate `emerald-astro-core` repository containing the shared code, consumed by each app repo as either a git submodule or a published npm package.

#### Structure

```
emerald-astro-core/            # NEW shared library repo
├── src/
│   ├── astronomy/
│   ├── expr/
│   ├── astro-env.ts
│   ├── animation.ts
│   ├── time-controller.ts
│   ├── city-search.ts
│   ├── location/
│   ├── help-framework/
│   └── ...
├── package.json
└── tsconfig.json

chronometer-web/               # Existing repo
├── src/
│   ├── watch/
│   ├── engine-entry.ts
│   └── ...
├── astro-core/                # git submodule → emerald-astro-core
└── ...

observatory-web/               # NEW app repo (future)
├── src/
│   └── ...
├── astro-core/                # git submodule → emerald-astro-core
└── ...
```

#### Pros

- **Strongest isolation.** Each app is a fully independent repo with its own CI, issues, releases.
- **Safe for external contributors.** Someone can work on Observatory without cloning Chronometer at all.
- **Library versioning.** Each app can pin a specific version/commit of `astro-core`, so a breaking library change doesn't immediately break everything.
- **Clean open-source story.** Each repo has a clear scope and license.

#### Cons

- **Version coordination overhead.** While the astronomy code itself is unlikely to need patches, shared infrastructure like the location dialog is likely to be enhanced over time. Each enhancement requires: push to `astro-core`, update submodule SHA in each consuming app, test both. Multiple PRs for one logical change.
- **Git submodules are notoriously fragile.** Developers forget to `git submodule update`, commits can accidentally point to wrong SHAs, CI needs special handling.
- **The alternative (npm publish)** adds registry overhead: you need a private or public npm package, versioning, `npm publish` workflow, and consumers must `npm update` to get fixes.
- **Shared development is slow.** To iterate on a shared module while testing in an app, you need `npm link` or submodule branch tracking, both of which add friction.
- **Doubles the repo management.** Issues, PRs, CI configs, READMEs, and deploy scripts multiply.
- **Breaks the current simplicity.** Today you clone one repo and `bash build.sh`. With submodules you need `git clone --recurse-submodules` and pray.

---

## Comparison Matrix

| Criterion | A: Monolith | B: Workspace | C: Separate Repos |
|-----------|:-----------:|:------------:|:-----------------:|
| Migration effort | 🟢 Low | 🟡 Medium | 🔴 High |
| Contributor isolation | 🟡 Medium | 🟢 Good | 🟢 Best |
| Accidental cross-app breakage | 🟡 Possible | 🟢 Unlikely | 🟢 Very unlikely |
| Shared code iteration speed | 🟢 Instant | 🟢 Fast | 🔴 Slow (multi-PR) |
| Build simplicity | 🟢 Simple | 🟡 Moderate | 🟡 Moderate |
| Deployment (separate paths) | 🟢 One build → split | 🟢 Independent | 🟢 Independent |
| Adding a 3rd app | 🟢 Easy | 🟢 Easy | 🟡 New repo + submodule |
| Doesn't ship unused code | 🟡 Need discipline | 🟢 Enforced | 🟢 Enforced |
| `file://` deployment | 🟢 Works (per-app dist) | 🟢 Works (per-app dist) | 🟢 Works (per-app dist) |
| Test unification | 🟢 One `vitest` | 🟡 Per-package | 🔴 Per-repo |

---

## Recommendation

**Start with Alternative A (Monolith with internal structure), evolve to B if/when the pain warrants it.**

### Rationale

1. **The shared/app-specific boundary isn't fully clear yet.** While we know the broad categories (astronomy = shared, renderer = Chronometer-only), details like exactly which expression-environment functions Observatory needs will be discovered during the port. Building new apps inside the monolith lets you draw that boundary organically.

2. **Inspector is the ideal proving ground.** It needs the astronomy code, a time controller, location infrastructure, the expression evaluator, and a bit of UI — but no canvas and no watch rendering. Building it first forces us to establish clean imports from `src/shared/` and proves that shared modules don't pull in watch-specific code. If the extraction works cleanly for Inspector, we'll have high confidence it works for Observatory too.

3. **The expression system decision favors colocation.** The iOS EO doesn't use the expression evaluator, but the web port should have access to it. Inspector's expression textbox will exercise the evaluator against the full astro-env, validating the API before Observatory needs it.

4. **Premature extraction is expensive.** Extracting a library requires deciding the API surface up front. If you get it wrong, you pay the refactoring cost twice.

5. **The monolith risk is manageable** for a small number of apps (2–3) with a single primary developer. The risk of cross-app breakage is real but mitigated by the existing test suite. A `vitest` run that covers all apps catches regressions immediately.

6. **Migration from A → B is straightforward.** Once the `src/shared/` boundary is well-established and stable, moving those files into a workspace package is a mechanical refactor — rename imports, add `package.json` files, done. Going from C → B or A → C is much harder.

### Concrete first steps under Alternative A

#### Phase 1: Extract shared modules ✅ COMPLETE

1. **Extract `astro-env.ts` from `watch-env.ts`.** Move the ~100 astronomy/calendar/time function registrations into `src/shared/astro-env.ts`. The remaining `watch-env.ts` imports from `astro-env.ts` and adds Chronometer-specific functions (Terra slots, Kyoto wadokei, Venezia body selector, `evalAttr`, `evalColor`).

2. **Create `src/shared/` and move shared modules there.** Time-controller, animation (full system including expression-driven scheduling), city-search, mini-map, dst-detect, tz-resolve, url-state. Update all imports in Chronometer code.

3. **Verify Chronometer still works.** Run `bash build.sh`, `npx vitest`, and manually test a few faces to confirm the refactoring is clean.

#### Phase 2: Build Inspector ✅ COMPLETE

4. **Create `src/inspector/inspector.html`.** A standalone page with:
   - Current simulated time display (large, at the top) — similar to the time footer on faces pages but more prominent
   - Location name, lat/lon, and timezone below the time
   - A "Set Location" button that opens the shared location dialog
   - Sunrise and sunset for the current day (formatted as local times)
   - Expression evaluator textbox (see below)
   - No canvas, no watch rendering

5. **Create `src/inspector/inspector-entry.ts`.** The entry point imports from `src/shared/`, `src/expr/`, and `src/astronomy/` only — never from `src/watch/`. It:
   - Initializes a read-only time source (real time, no controller UI yet)
   - Resolves location (from URL params or location dialog)
   - Creates an astro-env `Environment` for expression evaluation
   - Calls astronomy functions directly (sunrise/sunset via `planetaryRiseSetTimeRefined`)
   - Updates the DOM with computed values
   - Refreshes on a ~1s timer for the live clock
   - Handles the expression evaluator textbox

6. **Extend `build.sh`** to:
   - Bundle `src/inspector/inspector-entry.ts` → `dist/inspector-engine.js`
   - Process `src/inspector/inspector.html` with partial injection (location dialog) → `dist/inspector.html`

7. **Verify bundle isolation.** Grep `dist/inspector-engine.js` for any `watch/` imports — there should be none. Check bundle size (should be much smaller than `chronometer-engine.js`).

#### Phase 3: Help framework extraction (NOT STARTED)

8. **Extract help popover shell** into `src/shared/help-framework/`. This includes: the ℹ button, popover structure, slide-right sub-page navigation (Privacy, Disclaimer, Support), version display, and shared CSS. Each app provides its own help content and theme color. Don't over-engineer this — if it's simpler to just have a shared CSS file and a pattern to follow, that's fine too.

> [!NOTE]
> Phase 3 is deferred until Inspector's core functionality is working. Inspector's initial version can have a minimal ℹ button implementation (or none at all), refined later when the shared help framework is extracted.

#### Phase 4: Time controller for Inspector (NOT STARTED)

9. **Add time controller UI to Inspector.** Port the time controller bar (play/pause, step buttons, rate selector, direction toggle) from the face template into Inspector. This lets the user scrub time and validate that:
   - Sunrise/sunset values update correctly as time changes
   - The expression evaluator reflects the simulated time
   - The time display shows stopped/scrubbing/running state
   - Edge cases (DST transitions, polar regions, date range limits) behave correctly

This is valuable early on as a validation tool for the shared time system.

#### Future: Observatory

10. **Create `src/observatory/`** with its own entry point and HTML template, building on the shared infrastructure proven by Inspector.

---

## Inspector: Initial Feature Scope

The first version of Inspector is intentionally minimal — a proof-of-concept that the shared code extraction works, plus a useful debugging/exploration tool.

| Element | Details |
|---------|---------|
| **Time display** | Current simulated time, large format at the top. Shows date, time with seconds, and whether the clock is running/stopped/scrubbing. Mirrors the time footer on face pages but more prominent. |
| **Location** | City name (or "X mi DIR of City"), lat/lon, timezone. Sourced from URL params or the shared location dialog. |
| **Set Location button** | Opens the main location dialog (shared with Chronometer). |
| **Sunrise** | Local time of sunrise for the current day. Shows "—" if no sunrise (polar conditions). |
| **Sunset** | Local time of sunset for the current day. Shows "—" if no sunset (polar conditions). |
| **Expression evaluator** | A text input where the user can type any expression (e.g., `sunAltitude()`, `moonAgeAngle() * 180 / pi`, `hour24Value()`). The expression is parsed and evaluated against the full astro-env. The result is displayed in three formats simultaneously: **as a number** (raw value), **as an angle** (converted to degrees), and **as a date** (interpreting the number as a date interval). Updates live as the clock ticks. Invalid expressions show an error message. |

---

## Implementation Status

### Phase 1: Extract Shared Modules — ✅ Complete (2025-05-25)

The `src/shared/` directory was created with the following modules extracted from their original locations:

| Module | Moved from | Size | Notes |
|--------|-----------|------|-------|
| `astro-env.ts` | NEW (extracted from `watch-env.ts`) | 99 KB | ~159 astronomy/calendar/time functions + 27 time-returning functions (ForDay, Next, Prev variants for rise/set/transit of Sun, Moon, and any planet). Factory function `createAstroEnvironment()` for non-Chronometer apps |
| `animation.ts` | `src/watch/animation.ts` | 47 KB | Full animation system (unchanged) |
| `time-controller.ts` | `src/time-controller.ts` | 21 KB | |
| `city-search.ts` | `src/city-search.ts` | 9 KB | |
| `location-dialog.ts` | NEW (extracted from partials + engine-entry) | 23 KB | Self-contained: creates dialog DOM, handles geolocation, city search, mini-map. Exports `initLocationDialog()` and `requestBrowserLocation()` |
| `mini-map.ts` | `src/mini-map.ts` | 8 KB | |
| `url-state.ts` | `src/url-state.ts` | 10 KB | |
| `dst-detect.ts` | `src/dst-detect.ts` | 5 KB | |
| `tz-resolve.ts` | `src/tz-resolve.ts` | 1 KB | |

**Key architectural decisions made during extraction:**

- `watch-env.ts` now imports from `astro-env.ts` via `registerAstroFunctions()` and adds only Chronometer-specific functions (Terra/Gaia slots, Kyoto wadokei, Venezia body selector, `evalAttr`, `evalColor`). It re-exports `computeTzDeltaMs`, `evalAttr`, `evalColor` for backward compatibility.
- `astro-env.ts` exports a `createAstroEnvironment()` factory that Inspector (and future apps) use directly — no dependency on `watch-env.ts` or the watch model.
- The location dialog was extracted from the HTML partial + engine-entry.ts JS into a single self-contained TypeScript module. It programmatically creates its DOM rather than relying on build-time HTML injection. Both Chronometer and Inspector use the same module.
- Planet name constants (`Sun=0`, `Moon=1`, `Mercury=2`, ..., `Pluto=10`) were added to the expression evaluator's default environment so expressions like `nextRiseOfPlanet(Venus)` work in any app.

All 8,472 regression tests pass after the extraction. No Chronometer functionality was lost.

### Phase 2: Build Inspector — ✅ Complete (2025-05-25)

Inspector is a standalone astronomy data explorer at `dist/inspector.html`. It imports only from `src/shared/`, `src/expr/`, and `src/astronomy/` — never from `src/watch/`.

**What was built:**

| Feature | Implementation |
|---------|---------------|
| **Live clock** | Updates every second, shows HH:MM:SS and full date in location's timezone |
| **Location** | Reads `lat`/`lon`/`tz` from URL params. `bloc=1` triggers browser geolocation. No params → opens location dialog automatically |
| **Location dialog** | Uses shared `location-dialog.ts` — same city search and mini-map as Chronometer |
| **Timezone display** | Shows timezone abbreviation and UTC offset, e.g. `(PDT) UTC-7:00` |
| **Sunrise/Sunset** | Formatted in location's timezone. Shows "—" for polar conditions |
| **Expression evaluator** | Parses and evaluates against full astro-env. Results shown as Number, Angle (°), and Date (in location timezone). Error messages for invalid expressions |
| **Autocomplete** | As-you-type dropdown with 2+ character trigger. Shows name, signature, and description. Arrow/Enter/Escape keyboard navigation. Prefix matches sorted first |
| **Reference panel** | 📖 button opens a categorized, collapsible panel of all ~159 functions + constants organized into 10 categories (Sun Times, Moon Times, Planet Times, etc.). Click any entry to insert it into the input |
| **Expression metadata** | `expr-metadata.ts` provides curated descriptions for all functions and constants. Falls back to env keys for anything not in the curated list |

**Bundle isolation verified:** `dist/inspector-engine.js` (~1.2 MB) contains no `watch/` imports. The Chronometer `chronometer-engine.js` bundle is unaffected.

---

## Resolved Questions

| Question | Resolution |
|----------|-----------|
| **Deployment URLs** | Each app gets its own URL path (`/ecweb/`, `/eoweb/`). Inspector ships inside Chronometer's dist as `inspector.html`. |
| **Expression system** | Should be shared. iOS EO doesn't use it, but the web port should have access to it for future use. Inspector exercises it directly via the expression evaluator textbox. |
| **watch-env.ts decomposition** | Done — astronomy function registration extracted to `shared/astro-env.ts`. `watch-env.ts` imports from it and adds Chronometer-specific functions. |
| **Repo naming** | Keep `chronometer-web` for now. |
| **Help system** | Share the visual pattern (ℹ button, popover, slide-right to Privacy/Disclaimer, version number, styles). Don't share Chronometer's per-face section architecture. Share implementation where it doesn't add nontrivial complexity. |
| **Version coordination (Alt C)** | Astronomy code is unlikely to need patches, but shared infrastructure (e.g., location dialog) will be enhanced. The multi-PR overhead of Alternative C is a real concern for actively-evolving shared code. |
| **First new app** | Inspector (text-only astro values), not Observatory. Inspector is the minimal test case for proving the shared code boundary. |
| **Animation system split** | Keep the full animation system unified in shared code (including XML-expression-driven scheduling), since Observatory and future apps are likely to need it. Don't split into core/watch. |
| **Time controller in Inspector** | Added as explicit Phase 4. Useful early for validating the shared time system against sunrise/sunset, expression evaluator, and edge cases. |
| **Location dialog sharing** | Extracted to `src/shared/location-dialog.ts` as a self-contained module with programmatic DOM creation. Both apps use the same code. |
