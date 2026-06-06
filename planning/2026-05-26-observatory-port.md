# Observatory Web Port — Implementation Plan

Port of the [Emerald Observatory](file:///Users/spucci/chronometer-web/.observatory-ref) iPad app to a web app within the `chronometer-web` monorepo, following the patterns established by Inspector.

## Reference Material

| Source | Purpose |
|--------|---------|
| [`.observatory-ref`](file:///Users/spucci/chronometer-web/.observatory-ref) | Canonical iOS implementation — use for all astronomy logic and visual design |
| [`.observatory-opengl-ref`](file:///Users/spucci/chronometer-web/.observatory-opengl-ref) | Unreleased desktop version — reference for responsive layout and smooth terminator algorithm |
| [adding-a-new-app.md](file:///Users/spucci/chronometer-web/docs/adding-a-new-app.md) | Monorepo integration guide |
| Portrait screenshot | See `.observatory-ref/iPad2Portrait.png` |
| Landscape screenshot | See `.observatory-ref/iPad2Landscape.png` |

## Visual Anatomy of Observatory

The app is a single full-screen astronomical clock on a black starfield background. Its components, from back to front:

### Header Region (top of screen)
- **Moon phase display** — large moon image with terminator overlay, scaled by apparent distance
- **World map** — equirectangular Blue Marble image with day/night terminator overlay and location dot
- **Date display** — month/day, weekday, year, leap-year indicator
- **Eclipse simulator ring** — annular dial at right showing eclipse status

### Central Orrery Dial (main clock)
- **24-hour dial ring** — outer numbered ring with demi-radial numbers (0 or 12 on top), tick marks
- **Zodiac symbol ring** — zodiac symbols image overlay
- **12-hour markers** — inner ring with golden numbers
- **Planet orbit circles** — concentric thin circles for Mercury through Saturn
- **Planet image hands** — small planet images rotating on orbit circles at ecliptic longitude rates
- **Rise/set arc rings** — concentric colored arcs showing above-horizon periods for Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn
- **Sunrise/sunset/twilight hands** — arrow hands marking solar event times on the 24h dial
- **Solar noon/midnight hands** — colored hands
- **24-hour hand** — white hour hand on the 24h dial
- **12-hour Breguet hand** — golden ornate hand
- **Minute Breguet hand** — golden ornate hand
- **Second needle hand** — thin sweep second hand
- **Alarm hand** — red hand (optional, alarm feature)

### Three Inner Subdials
- **UTC subdial** — 24h clock showing UTC time
- **Solar time subdial** — 12h clock showing local apparent solar time
- **Sidereal time subdial** — 24h clock showing local sidereal time, with constellation names

### Sun Image
- Central Sun image at the center of the orrery

### Peripheral Dials (corners)
- **Altitude dial** — half-circle gauge (-90° to +90°) showing selected planet's altitude
- **Azimuth dial** — full-circle compass showing selected planet's azimuth (N/E/S/W)
- **Eclipse simulator** — animated display showing current eclipse geometry
- **Equation of Time dial** — shows the difference between solar and clock time (±15 min)

### Footer
- **Logo** — "Emerald ✦ Sequoia"
- **Timezone label** — local timezone abbreviation
- **NTP status indicator** — sync status dot
- **Set/Reset button** — toggles time-setting mode
- **Time advance buttons** — min/hour/day/phase/month/year/century forward/back (visible in set mode)

---

## Design Decisions (Resolved)

### 1. Responsive Layout
Build responsive layout from the start. The iOS app's two fixed layouts (768×1024 portrait / 1024×768 landscape) won't be used. Instead, `layout.ts` will compute all positions and sizes dynamically from the viewport dimensions. The main orrery dial sizes to fit, and peripheral elements reposition around it. We are not following the OpenGL ref's approach specifically — just building responsively.

### 2. Image Assets
Use existing PNGs from [`.observatory-ref/Resources/`](file:///Users/spucci/chronometer-web/.observatory-ref/Resources) directly. Higher-resolution versions can be created later as needed. The code and assets are on GitHub under a permissive license and the company no longer exists.

### 3. Noon-on-Top Toggle
Build in the `noonOnTop` variable from the start (all number sequences and dial rendering must respect it), but **defer the UI toggle**. When a toggle is eventually added, it should work like the Vienna face in the Chronometer web app.

### 4. Alarm Feature
**Omitted.** Alarms are not useful in a web app context. All alarm-related code from the iOS ref (alarm hand, snooze button, local notifications) will be skipped.

### 5. Earth Terminator Algorithm
Use the **OpenGL ref's smoother algorithm** from [`.observatory-opengl-ref`](file:///Users/spucci/chronometer-web/.observatory-opengl-ref). It has been fully qualified by the original author.

### 6. Time Controls
Use the shared **Chronometer `TimeController`** from `src/shared/time-controller.ts`. No iOS-style button grid. This gives Observatory the same scrubbing/stepping interface as Chronometer for free.

---

## Proposed Changes — Phased Implementation

Each phase produces a working (if incomplete) app that can be built and tested.

---

### Phase 0: Scaffolding & Infrastructure

Set up the app skeleton following [adding-a-new-app.md](file:///Users/spucci/chronometer-web/docs/adding-a-new-app.md).

#### [NEW] `src/observatory/observatory-entry.ts`
- Entry point — creates `AstroEnvironment`, wires up location, starts render loop
- Imports only from `shared/`, `expr/`, `astronomy/` (never `watch/`)
- Module-level `let env: Environment`, recreated on location change
- Module-level `let noonOnTop = false` variable (used by all dial rendering, UI toggle deferred)
- Uses `createAstroEnvironment()` from `astro-env.ts`
- Sets up `requestAnimationFrame` render loop (Observatory needs smooth seconds hand)
- Integrates `initLocationDialog()`, `readUrlState()`, `writeUrlState()`
- Integrates `TimeController` from `src/shared/time-controller.ts` for time stepping/scrubbing

#### [NEW] `src/observatory/observatory.html`
- Self-contained HTML page with inline CSS
- Full-viewport `<canvas>` element
- Loads fonts, includes `observatory-engine.js`
- Black background

#### [NEW] `src/observatory/layout.ts`
- Compute all widget positions/sizes **dynamically** from viewport width and height
- The iOS ref's [EOClock.mm L1377–1720](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L1377-L1720) constants serve as a guide for proportions, not absolute values
- Returns a `LayoutParams` object used by all renderers
- Re-computed on window resize (debounced via `ResizeObserver`)
- Key sizing logic: main dial radius is a fraction of `min(viewportW, viewportH)`, peripheral dials and header elements are positioned relative to the main dial

#### [NEW] `src/observatory/draw-utils.ts`
- Port reusable drawing functions from EOClock class methods:
  - `drawTicks()` — [EOClock.mm L1345–1374](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L1345-L1374)
  - `drawDialNumbersUpright()` — [EOClock.mm L1210–1236](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L1210-L1236)
  - `drawDialNumbersDemiRadial()` — [EOClock.mm L1238–1284](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L1238-L1284)
  - `drawText()` — [EOClock.mm L1138–1161](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L1138-L1161)
  - `drawCircularText()` — [EOClock.mm L1163–1208](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L1163-L1208)

#### [MODIFY] `build.sh`
- Add esbuild target for `observatory-engine.js`
- Add HTML copy step for `observatory.html`

#### [MODIFY] docs as needed
- Update `architecture-overview.md` Observatory row
- Update `build-system.md` to list the new bundle

---

### Phase 1: Main Orrery Dial (Static Background)

Render the central dial background — the most visually distinctive element.

#### [NEW] `src/observatory/main-dial.ts`
- Port [EORingsAndPlanetsShuffleView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L61-L258) `drawRect:`
- **24-hour numbered ring**: demi-radial numbers (0-23 or 12-23,0-11), tick marks at 48/144/720 intervals
- **Zodiac symbol ring**: draw the `zodiac.png` image centered
- **12-hour marker ring**: golden demi-radial numbers "12,1,2,...,11"
- **Planet orbit circles**: 6 concentric thin white circles
- **Second-hand tick marks**: ticks at 60/300 intervals (no fives)
- **Sun image**: draw `sun.png` at center
- **Background circle**: translucent white filled circle at `mainR`
- All drawing to an `OffscreenCanvas` (static cache, redrawn only on resize or `noonOnTop` change)

---

### Phase 2: Planet Hands & Rise/Set Rings

Add the dynamic planet positions and the colorful rise/set arcs.

#### [NEW] `src/observatory/planet-hands.ts`
- Port [EOHandImageView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOHandImageView.mm) — draw planet icon images rotated to ecliptic longitude
- Planets: Saturn, Jupiter, Mars, Earth (with Moon sub-hand), Venus, Mercury
- Use `planetHeliocentricLongitude()` or `planetEclipticLongitude()` from the astronomy env
- Moon orbits the Earth hand as a sub-rotation — port the child-view pattern from [EOClock.mm L1991-1993](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L1991-L1993)
- Update interval: 3600s (re-evaluate hourly)

#### [NEW] `src/observatory/ring-view.ts`
- Port [EORingView.mm](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EORingView.mm) — colored arc segments showing above-horizon time for each planet
- Each ring is a thick arc from rise-angle to set-angle on the 24h dial
- Rings: Sun (widest, ~64px), Saturn, Jupiter, Mars, Venus, Mercury, Moon (each ~8px)
- Colors per iOS: Sun=warm yellow, Saturn=cyan, Jupiter=green, Mars=pink, Venus=white, Mercury=salmon, Moon=blue
- Update interval: 3600s

---

### Phase 3: Clock Hands (Central Dial)

Add the moving hands that show current time.

#### [NEW] `src/observatory/hand-views.ts`
- **24-hour hand**: white arrow hand — port [EOHandView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOHandView.mm) triangle-arrow style
- **12-hour Breguet hand**: ornate golden hand — port [EOHandBreguetView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOHandBreguetView.mm)
- **Minute Breguet hand**: same style, thinner
- **Second needle hand**: thin red-orange needle with ball counterweight — port [EOHandNeedleView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOHandNeedleView.mm)
- **Sunrise/sunset hands**: arrow hands at sunrise/sunset times on 24h dial
- **Twilight hands**: civil, nautical, astronomical twilight begin/end hands
- **Golden hour hands**: golden hour begin/end
- **Solar noon/midnight hands**: yellow (noon) and blue (midnight)
- ~~Alarm hand~~ — **omitted**

---

### Phase 4: Inner Subdials (UTC, Solar, Sidereal)

Render the three small time subdials within the orrery.

#### [NEW] `src/observatory/subdials.ts`
- **UTC subdial**: 24h clock face with upright numbers, hour/minute/second triangle hands
  - Uses `hour24ValueUTC()`, `minuteValueUTC()`, `secondValue()`
  - Port from [EOShuffleView.mm L167-180](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L167-L180) (background) + [EOClock.mm L2011-2016](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOClock.mm#L2011-L2016) (hands)
- **Solar time subdial**: 12h clock face
  - Uses `solarHour12Value()`, `solarMinuteValue()`, `solarSecondValue()`
  - Port from [EOShuffleView.mm L182-194](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L182-L194)
- **Sidereal time subdial**: 24h clock with constellation names overlay image
  - Uses `siderealHour24Value()`, `siderealMinuteValue()`, `siderealSecondValue()`
  - Port from [EOShuffleView.mm L196-218](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L196-L218)
- Background dials are static-cached; hands update per tick

---

### Phase 5: Earth Map with Terminator

The world map at the top showing day/night regions.

#### [NEW] `src/observatory/earth-view.ts`
- Port using the **OpenGL ref's smoother terminator algorithm** from [`.observatory-opengl-ref`](file:///Users/spucci/chronometer-web/.observatory-opengl-ref), cross-referenced with [EOEarthView.mm](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOEarthView.mm) for the overall structure
- Draw the equirectangular Blue Marble image for the current month (12 seasonal images in `Resources/blueMarble/`)
- Compute sub-solar point from `sunDecl()` and seconds-since-midnight + equation-of-time
- Draw the day/night terminator using the OpenGL ref's smooth-transition algorithm
- Draw the user's location as a red dot
- Port the night background image (`night.png`) as base layer
- Update interval: 60s

---

### Phase 6: Moon Phase Display

#### [NEW] `src/observatory/moon-view.ts`
- Port [EOMoonView.mm](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOMoonView.mm)
- Draw full moon image (`moon300.png`) scaled by apparent angular size (distance-dependent)
- Overlay terminator arc using `moonAgeAngle()` — the dark half of the moon
- Rotate to correct position angle — `moonRelativeAngle()`
- Earthlight simulation: alpha varies near new moon phase
- Update interval: 60s

---

### Phase 7: Peripheral Dials

Four smaller dials around the edges of the screen.

#### [NEW] `src/observatory/altitude-dial.ts`
- Port [EOAltitudeDialShuffleView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L283-L319)
- Half-circle gauge from -90° to +90° with tick marks and numbers
- Triangle hand driven by `planetAltitude(planet)` for selected planet
- Planet selector cycles through Sun, Moon, Mercury, Venus, Mars, Jupiter, Saturn

#### [NEW] `src/observatory/azimuth-dial.ts`
- Port [EOAzimuthDialShuffleView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L321-L361)
- Full-circle compass with N/E/S/W labels, colored crosshairs
- Triangle hand driven by `planetAzimuth(planet)` for selected planet
- Shares planet selection with altitude dial

#### [NEW] `src/observatory/eclipse-view.ts`
- Port [EOEclipseView.mm](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOEclipseView.mm) — the eclipse simulator
- Displays Sun and Moon images overlapping in an annular viewport
- Shows current eclipse type/status label
- Below-horizon indicator
- Eclipse ring indicator hands (Sun, Moon, Earth shadow, ascending/descending nodes)
- Port [EOEclipseDialShuffleView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L363-L403) background

#### [NEW] `src/observatory/eot-dial.ts`
- Port [EOEOTDialShuffleView](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOShuffleView.mm#L405-L449)
- Semicircular dial showing equation of time (-15 to +15 minutes)
- Triangle hand driven by `EOTMinutes()`
- Static background with tick marks and labels "0, 5, 10, + 15, ..., 15 –, 10, 5"

---

### Phase 8: Time Controls & Date Display

#### [NEW] `src/observatory/time-controls.ts`
- **Date display**: large month/day, weekday, year, leap-year indicator labels
- **Timezone label** and **UTC day label**
- Integrate with shared `TimeController` from `src/shared/time-controller.ts` — same scrubbing/stepping/play-pause interface as Chronometer
- No iOS-style Set mode or button grid
- ~~Alarm UI~~ — **omitted**
- ~~NTP status~~ — simplified or omitted for web

---

## Astronomy Functions Needed

Most required functions are already in `astro-env.ts`. Functions that may need to be added or verified:

| Function | Used by | Status |
|----------|---------|--------|
| `sunDecl()` | Earth terminator | Likely exists as `sunDecl` |
| `EOTSeconds()` | Earth terminator, EOT dial | Likely `EOTSeconds` |
| `planetHeliocentricLongitude(p)` | Planet hands | Exists |
| `planetGeocentricDistance(p)` | Moon size | Exists |
| `moonAgeAngle()` | Moon phase | Exists |
| `moonRelativeAngle()` | Moon rotation | Exists |
| `planetAltitude(p)` | Altitude dial | Exists |
| `planetAzimuth(p)` | Azimuth dial | Exists |
| `sunriseForDay()` / `sunsetForDay()` | Sun ring | Exists |
| `riseForPlanet(p)` / `setForPlanet(p)` | Planet rings | Exists |
| `solarHour12Value()` | Solar subdial | Exists |
| `siderealHour24Value()` | Sidereal subdial | Exists |
| `eclipseKind()` / eclipse geometry | Eclipse view | May need additions |
| `hour24ValueUTC()` | UTC subdial | May need addition |

> [!NOTE]
> The eclipse simulator ([EOEclipseView.mm](file:///Users/spucci/chronometer-web/.observatory-ref/Classes/EOEclipseView.mm)) uses several specialized astronomy functions for eclipse geometry that may not yet be in `astro-env.ts`. This will be the most complex phase from an astronomy standpoint.

---

## Verification Plan

### Automated Tests
- `npx tsc --noEmit` — TypeScript type checking passes
- `grep -c 'watch/' dist/observatory-engine.js` — zero (bundle isolation)
- `ls -lh dist/observatory-engine.js` — verify bundle size is smaller than `chronometer-engine.js`
- Astronomy function unit tests for any new functions added to `astro-env.ts`

### Manual Verification (by user)
Visual verification will be done by the user after each phase.

---

## Implementation Order Summary

| Phase | Deliverable | Estimated Complexity | Status |
|-------|-------------|---------------------|--------|
| 0 | App skeleton, entry point, build integration | Low | ✅ Complete |
| 1 | Main orrery dial background (static) | Medium | ✅ Complete |
| 2 | Planet hands + rise/set rings | Medium-High | ✅ Complete |
| 3 | Central clock hands | Medium | ✅ Complete |
| 4 | UTC/Solar/Sidereal subdials (hands + constellation overlay) | Medium | ✅ Complete |
| 5 | Earth map with terminator | Medium-High | ✅ Complete |
| 6 | Moon phase display | Medium | ✅ Complete |
| 7 | Peripheral dials (alt/az/EOT) + date display | Medium | ✅ Complete |
| 7B | Eclipse simulator (disc, status, ring hands) | High | ✅ Complete |
| 8 | Tune the layout (responsive polish) | Medium | Not started |

> **Phase scope changes (2026-06-05):** The time controller already exists, so old Phase 8 ("Time controls + date display") was reduced to just the date display, which moved into Phase 7. Phase 8 is repurposed to **layout tuning**. The **eclipse simulator** was split out of Phase 7 into its own **Phase 7B** (the immediate next task) with a dedicated plan; its layout slot (`eclipseCX/CY/R1/R2`) is left empty until then. See [planning/2026-06-05-observatory-phase-7-dials.md](2026-06-05-observatory-phase-7-dials.md).

---

## Progress Log

### Phase 0 — ✅ Complete
- Scaffolding, entry point, build integration, `layout.ts`, `draw-utils.ts` all done.

### Phase 1 — ✅ Complete
- Main orrery dial background rendered to OffscreenCanvas cache.
- All subdial backgrounds (UTC, Solar, Sidereal) rendered correctly.
- 24-hour demi-radial numbers, 12-hour golden numbers, zodiac image, orbit circles, sun image.
- Subdial labels positioned at bottom (matching iOS).
- Fixed layout proportionality: all layout constants now scale directly from iOS reference values (e.g., `plR = 332*s` instead of `mainR - mainFontSize - 1`) to preserve geometric relationships at all canvas sizes.

### Phase 2 — ✅ Complete

#### Completed:
- **Planet image hands** (`planet-hands.ts`): Saturn, Jupiter, Mars, Earth, Venus, Mercury rendered at heliocentric longitudes on orbit circles. Moon sub-hand orbits Earth at moon age angle. Images correctly oriented (top facing inward) using `rotate(angle + π) + scale(-1, 1)` to match iOS UIKit drawing convention.
- **Rise/set rings** (`ring-view.ts`): All 7 rings (Sun + 6 planets) rendered with correct colors. Sun ring uses altitude-based gradient (`cachelessPlanetAlt`). Planet rings use `planetaryRiseSetTimeRefined` for rise/set times. Transit diamond markers drawn at ring midpoints.
- **Transit angle fix** (`astro-env.ts`): Added `leafNumber === 4` special case to `computeDayNightLeafAngle` (iOS ESAstronomy.cpp L5182-5190) — computes high transit directly via `planettransitTimeRefined` instead of the old leaf-center approach. Fixed `planettransit24HourIndicatorAngle` registration to use `(planet, 4, 0)`.
- **Shared astronomy cleanup**: Moved `cachelessPlanetAlt` from Observatory-specific `ring-view.ts` to the shared astronomy layer (`es-astro.ts`), per the project rule that astronomy knowledge belongs in shared code.
- **Planet name labels on rings** (`ring-view.ts`): Port of EORingView.mm L367-412. Each planet ring displays its name at rise and set endpoints using `drawCircularText` in demi-radial mode. When the planet is below the horizon (no rise/set), the name is drawn at the transit angle in the ring's day color.
- **Sidereal constellation abbreviations** (`main-dial.ts`): Port of EOShuffleView.mm L211-218. The pre-rendered `EO-Sidereal-constellation-names@2x.png` (308×308 @2x asset) is overlaid centered on the sidereal subdial, scaled to `149*s` to match iOS reference proportions. Drawn in the static cache (only redrawn on resize).

### Phase 6 — ✅ Complete

- **Moon phase display** (`moon-view.ts`): port of EOMoonView.mm. Full-moon image (`moon300.png`) scaled by apparent angular size from geocentric distance, dark terminator overlay tracing the phase, and whole-display rotation by `moonRelativeAngle()` (the iOS `EOChandra` view rotation).
- **Animated values** (`obs-values.ts`): added `moonPhase` (`moonAgeAngle()`), `moonRotation` (`moonRelativeAngle()`), and `moonDistAU` (`distanceFromEarthOfPlanet(1)`, linear). No astronomy-layer changes — all functions already existed.
- **Asset handling**: `moon300.png` copied into `src/shared/assets/` (the `.observatory-ref` reference repo is never a build input).
- **Entry wiring** (`observatory-entry.ts`): `initMoonView()` + `drawMoonView()` replace the header `MOON` placeholder.
- **Terminator coordinate fix**: the literal Y-up→Y-down port drew the unlit limb arc around the wrong side, making the dark area the complement of the true phase (>50% dark near full). Inverting the `anticlockwise` flag on the limb arc (`sin(pa) < 0`) makes the dark fraction match `(1 + cos pa)/2`.
- **Verified** against Selene: phase shape correct at elongation ≈ 242° (thin waning-gibbous crescent), apparent size tracks geocentric distance, smooth 120fps animation.

### Phase 7 — ✅ Complete

- **Peripheral dials** (`peripheral-dials.ts`, static cache; `peripheral-hands.ts`, hands): Altitude (left half-gauge), Azimuth (full compass), and an **asymmetric** Equation-of-Time dial.
- **Asymmetric EOT dial**: adopted the Mauna Kea / Vienna real-range design (`renderer.ts drawEotDial`) in the Observatory subdial style — solid band −14.2…+16.5, the unused −14.2…−15 sliver dimmed so the left edge still hits 9 o'clock while the right runs longer. Hand = `24 * EOTAngle()`.
- **Planet selection**: alt/az dials share a selected body; clicking either cycles Sun→…→Saturn (skip Earth), persisted in URL `op`. All 7 bodies' alt/az registered up front (`DIAL_BODIES` in `obs-values.ts`).
- **Date display** (`date-view.ts`): weekday/date/year/leap/tz via `Intl.DateTimeFormat` in the location timezone.
- **Planet-switch animation**: alt/az hands track single `dialAlt`/`dialAz` values driven by a `dialPlanet` env variable; clicking a dial updates it and calls `updater.reset()` so the hands sweep to the new body (same path as a location change). Per iOS, the altitude dial cycles forward and the azimuth dial backward (`cycleSelectablePlanet`).
- **Scope changes**: eclipse simulator split to its own **Phase 7B** (next task; slot left empty); Phase 8 repurposed to layout tuning. No astronomy-layer changes (`altitudeOfPlanet`/`azimuthOfPlanet`/`EOTAngle` already existed).

### Phase 7B — ✅ Complete

- **Eclipse simulator** (`eclipse-view.ts`, port of `EOEclipseView.mm` + the ring hands from `EOHandView.mm`): the upper-right disc shows the live Sun↔Moon (solar) or Moon↔Earth-shadow (lunar) geometry at real apparent sizes/orientation when within 10°, else an "Eclipse Simulator" caption; a green overlay marks any below-horizon portion. Five image markers ride the ring at RA-derived angles (Sun, Moon, anti-solar shadow, asc/desc nodes). Background annulus added to `peripheral-dials.ts` (`drawEclipseDial`).
- **Animation-friendly via obs-values**: the disc is driven by 13 per-element obs-values (no monolithic snapshot), all sharing **one** update sentinel so the geometry stays mutually consistent and inherits the standard scrub/animate machinery. `eclKind` is `discrete`; sizes/distances/altitudes are `linear`; azimuths/RA are angular.
- **New adaptive sentinel** `EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION` (`-1019`, `nextInterestingEclipseMotion` in `animation.ts`): ~1 s cadence while the disc is drawn, capped ≤1 h while only the caption shows. Uses a conservative closing-rate bound (`clamp((sep−10°)/1°·h⁻¹, 1 s, 1 h)`) rather than a binary search, since eclipse separation is non-monotonic over a month; honors `timeDirection`.
- **Astronomy**: three thin expr wrappers over `calculateEclipse` (`eclipseAngularSeparation`, `eclipseShadowAngularSize`, `eclipseKindRaw`) returning the *physical* quantities the disc needs (the existing `eclipseSeparation`/`eclipseKind` return the abstract/collapsed wheel values); the node marker reuses the existing `lunarAscendingNodeRA`.
- **Coordinate note**: `EOEclipseView` is a Y-down `UIView`, so its pixel formulas port literally into the canvas (unlike the flipped main dial); ring markers replicate the iOS layer transform as `rotate(−firstAngle)→translate(0,−radius)→rotate(−glyph)`.
- **Assets**: `sunEclipse.png`, `totalEclipse.png`, `earthShadow.png`, and 5 `eclipseRing*.png` copied into `src/shared/assets/`; the Moon disc reuses `moon300.png`.
- **Tests**: `src/observatory/__tests__/eclipse.test.ts` — `calculateEclipse` at the 2026-08-12 total solar and 2026-03-03 total lunar eclipses (small separation, correct kind, shadow > 0) and at first quarter (no eclipse); plus the sentinel resolver (~1 s inside the threshold, capped ≤1 h outside, never overshooting the crossing, reverse-direction). All pass; `tsc`/`build` clean; `watch/` coupling unchanged.
- **Pending**: user visual verification against iOS Observatory / Selene (orientation, the Y-sign reconciliation, ring `+π` offsets, and whether the caption should ever show over a visible eclipse).

### Key Technical Lessons

1. **Cross-browser text rendering**: Never use `textBaseline = 'top'` — Safari positions it differently from Chrome. Always use `textBaseline = 'alphabetic'` with `textVisualCenterY(ctx, label)` as the Y-offset.

2. **Canvas coordinate system for rings**: Canvas `arc()` in Y-down uses `(clockAngle - π/2)` for correct orientation where top-center is 270°. Arcs use `anticlockwise=false` for clockwise rendering.

3. **Planet image orientation**: iOS draws planet images at `y=+radius` (downward from rotation center in UIKit Y-down). To match in Canvas, use `rotate(angle + π)` + `drawImage` at `+orbitR` + `scale(-1, 1)` to correct tangential mirror.

4. **Layout proportionality**: All layout dimensions must scale as direct multiples of the iOS reference values × `s` (the scale factor `mainR/365`). Computing from scaled sub-components with unscaled pixel offsets (e.g., `(orbitInc-1)*2-5` where orbitInc is scaled but -1 and -5 aren't) breaks proportionality at non-reference sizes. This is because iOS draws at fixed reference sizes and then scales the entire view uniformly.

5. **Astronomy in shared layer**: All astronomy knowledge belongs in `src/astronomy/` or `src/shared/astro-env.ts`. Observatory-specific code should only contain rendering logic, calling into the shared astronomy functions.

