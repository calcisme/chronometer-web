# Observatory Port — Phase 6: Moon Phase Display

> Dated planning doc for Phase 6 of the [Observatory web port](2026-05-26-observatory-port.md).
> Status: ✅ complete (2026-06-05). Verified against Selene — phase shape, apparent size, and smooth animation all correct.

## Context

We are porting the Emerald Observatory iPad app to the web (`chronometer-web` monorepo), following the phased plan in [2026-05-26-observatory-port.md](2026-05-26-observatory-port.md). Phases 0–5 are complete: the main orrery dial, planet hands, rise/set rings, central clock hands, the three inner subdials, and the Earth map with day/night terminator all render and animate via the shared `Updater`/`TimeController` system.

Phase 6 adds the **large moon phase display** in the header region (previously a `MOON` placeholder circle in `observatory-entry.ts`). It draws a photographic full-moon image, scaled by the Moon's apparent angular size (varies with distance), overlaid with a dark terminator that traces the current phase, and rotated to the correct sky orientation. This is a self-contained port of `EOMoonView.mm` and is Medium complexity — all required astronomy already exists; the work is rendering + wiring.

## Reference Material

| Source | What to take from it |
|--------|----------------------|
| `EOMoonView.mm` | `drawMoonPhaseAt:` terminator math, apparent-size formula, earthlight alpha |
| `EOHandView.mm:374-377` | `EOChandra` kind → whole view rotated by `moonRelativeAngle()` |
| `EOClock.mm:1914, 1526-1610` | `ChandraR=75` (radius at perigee), placement, `moonMasterScale` (1.0 portrait / 1.2 landscape), `moonViewUpdate=60` |
| `src/observatory/earth-view.ts` | Pattern: image import as dataurl, `init*View()` + `draw*View()` exports, read animated values from the `Updater`, draw into a layout region |
| `src/observatory/planet-hands.ts` | Established Canvas image-orientation convention (progress-log lesson #3) |

## Astronomy — all functions already exist

No changes to `astro-env.ts` / `es-astro.ts`. The expr layer already exposes:

- `moonAgeAngle()` — phase angle `pa` (0 = new, π/2 = first quarter, π = full).
- `moonRelativeAngle()` — view rotation angle (parallactic/position orientation).
- `distanceFromEarthOfPlanet(1)` — Moon geocentric distance in AU (`MOON = 1`).

## Changes

### 1. `src/observatory/obs-values.ts` — register 3 animated moon values

A `moon` defs block (mirroring the `earth` block), appended to the returned list, the `ObsValueName` union, and the `expectedNames()` array:

```ts
const moon: ObsValueDef[] = [
    { name: 'moonPhase',    expr: 'moonAgeAngle()',                     updateInterval: 60 },
    { name: 'moonRotation', expr: 'moonRelativeAngle()',                updateInterval: 60 },
    { name: 'moonDistAU',   expr: `distanceFromEarthOfPlanet(${MOON})`, updateInterval: 3600, linear: true },
];
```

`moonOffset` (the existing `-moonAgeAngle()+pi` value) stays — it drives the small moon hand on the Earth orbit; the big moon view uses the raw values above.

### 2. `src/observatory/moon-view.ts` [NEW] — port of EOMoonView.mm

Exports `initMoonView()` and `drawMoonView(ctx, L, u)`, following the `earth-view.ts` shape.

- **Asset:** `moon300.png` copied from `.observatory-ref/Resources/` into `src/shared/assets/moon300.png` (`.observatory-ref` is reference-only, never a build input). Imported as a dataurl via the esbuild loader — no `build.sh` change.

- **Apparent size** (port of `EOMoonView.mm` apparent-size block):
  ```
  perigeeDistance = 355000 km;  lunarRadius = 1737.10 km;  au = 149600000 km
  angularRadiusAtPerigee = atan(lunarRadius / perigeeDistance)
  angularRadiusNow       = atan(lunarRadius / (distAU * au))
  pixelRadius = L.moonR * angularRadiusNow / angularRadiusAtPerigee
  ```
  `L.moonR` (= `75*s`, ChandraR) is the radius **at perigee** (maximum). `distAU` from `u.get('moonDistAU').currentValue`.

- **Draw sequence** at `(L.moonCX, L.moonCY)`: save → translate to center → `rotate(moonRotation)` → draw full-moon image centered (`2*pixelRadius` square) → draw terminator overlay → restore.

- **Terminator** (port of `drawMoonPhaseAt`), in the rotated, moon-centered frame:
  ```
  pa    = moonPhase
  alpha = 0.75 + abs(sin(pa)) / 3          // earthlight near new moon
  fill  = rgba(20, 20, 23, alpha)           // (.08,.08,.09)·255
  r     = pixelRadius + 1
  moveTo(0, +r); arc(0,0,r, +π/2→−π/2, anticlockwise = sin(pa) >= 0)
  for i in [-n, n), n=10: th = (π/2)(i/n);
      lineTo( (sin(pa) < 0 ? -1 : 1)*cos(pa)*cos(th)*r,  sin(th)*r )
  closePath(); fill + thin stroke
  ```

  > ✅ **Coordinate reconciliation (resolved).** iOS draws in a Y-up CTM (paired `scale(1,-1)` around the image); Canvas 2D is Y-down. The literal port drew the unlit limb arc around the wrong side, making the dark area the complement of the true phase. Fix: invert the limb arc's `anticlockwise` flag to `sin(pa) < 0`. Dark fraction then matches `(1 + cos pa)/2` at all phases; the `sin(th)*r` term did not need flipping.

- **masterScale:** iOS `moonMasterScale` (1.2 landscape) folded into the responsive layout (`L.moonR` already scales); omitted by default.

### 3. `src/observatory/observatory-entry.ts` — replace the placeholder

Import `{ initMoonView, drawMoonView }`, call `initMoonView()` next to `initEarthView()`, and replace the placeholder circle + `MOON` text in `drawFrame()` with `if (updater) drawMoonView(ctx, L, updater);`.

### 4. Docs

- `docs/observatory.md`: add `moon-view.ts` to the Source Layout tree, a `Moon` row to the Value Catalog, and a new `## Moon Phase Display` section.
- `2026-05-26-observatory-port.md`: status table (phases 3/4/5 → ✅, phase 6 → ✅ on completion) + Phase 6 progress-log entry.

## Out of scope (later phases)

The small `moon75.png` hand on the Earth orbit is Phase 2 (done). The eclipse-simulator moon, alt/az dials, and EOT dial are Phase 7. No astronomy-layer changes.

## Verification

**Automated:** `npx tsc --noEmit`; `./build.sh`; `grep -c 'watch/' dist/observatory-engine.js` → 0.

**Visual (user):** compare the rendered moon against Chronometer (iOS and web) to settle phase direction, north-up orientation, apparent size, rotation, and earthlight. The literal port stays in place; orientation knobs adjusted from that feedback.
