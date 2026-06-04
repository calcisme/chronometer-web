# Inspector Ephemeris Catalog — Plan

**Date:** 2026-06-04
**Status:** Proposed (awaiting review, rev. 6)

## Goal

Replace the Inspector's single rise/set "Sun" card with a **grouped, scrolling
ephemeris catalog** that surfaces most of the astronomical/time expressions used
across the Chronometer faces, each as a live value driven by the shared
**ObsValue** system (eval-ahead, lag-free). This is the real-world realization of
the "Inspector at O(50) values" forward design in
[2026-06-03-inspector-obsvalue-animation.md](2026-06-03-inspector-obsvalue-animation.md).

Order (top → bottom): **User expression → Time → Sun → Moon → Planets
(inner → outer: Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune).**
(Pluto omitted — no WB data. Earth omitted — it's the observer.)

## How the value list was derived

1. **Surveyed all 17 face XMLs** (`src/watch/assets/*/*.xml`) — 149 distinct
   function identifiers.
2. **Skipped intermediate / UI-only values:** face machinery (`terraIDeviceSlot`,
   `kyotoMasterRotation`, `*IndicatorAngle`, `*IndicatorValid`, calendar wheels,
   sectors), terminator/ring internals (`terminatorAngle`, `dayNightLeafAngle*`,
   `sunSpecialAngle`, `moonDelta…`), colors & math primitives, and
   actions/device state (`advance*`, `battery*`, `tick/tock`, …).
3. **Collapsed time expressions** to a canonical set. The Y/M/D/H/M/S **angle**
   forms are dropped (they add little as standalone quantities and complicate the
   layout); only `EOTAngle` is kept (unusual formula). Time/date numbers display
   as separate labeled fields on a line (see Time group).
4. **Grouped semantically** by body with paired coordinate subgroups (RA/Dec,
   topocentric alt/az, ecliptic lon/lat, heliocentric lon/lat, distance,
   rise/set/transit), filled out symmetrically across all bodies.

## Animation & display semantics

Each value carries an ObsValue `linear` flag (animation) and a display format:

| Tag | `linear` | Meaning | Display |
|-----|----------|---------|---------|
| **A** | `false` | Full-circle angle (wrap, shortest path) | degrees `0–360°` |
| **L°** | `true` | Bounded angle (decl, altitude, latitude) — must not wrap | signed degrees |
| **L#** | `true` | Plain number | number (+ unit) |
| **HMS** | `true` | A clock quantity in seconds | `HH:MM:SS.sss` |
| **MS** | `true` | A small signed duration (EOT) | `±MM:SS.sss` |
| **DIST** | `true` | A distance in AU | two fields, `1.523 AU` and `227’943’000 km` (thousands grouped with a compressed apostrophe — see note) |
| **LT** | `true` | dateInterval | local time/date, `—` if no event |

> Bounded angles use **linear** deliberately (an altitude of −10° under angular
> `fmod` would render 350° and animate the wrong way), matching Observatory's
> `earthSslat`.

## Catalog

`n` = planet number (Sun 0, Moon 1, Mercury 2, Venus 3, Mars 5, Jupiter 6,
Saturn 7, Uranus 8, Neptune 9). `[NEW]` = function to add (see *Gaps*). Each
**subgroup pair** is shown as **one two-column row** to use horizontal space
(e.g. `RA  14h…°   Dec  −12.3°`). Default update interval per group in the
heading; eval-ahead keeps all of them smooth & lag-free.

### Group: Time  (header: text · update 1 s; seconds 0.1 s) — **12 values**
Date/clock numbers display as **separate labeled fields on a line** (visual
separators between fields); no angle forms except `EOTAngle`.
| Field/Row | Expr | Tag |
|-----------|------|-----|
| Year | `yearNumber()` | L# |
| Month | `monthNumber()` | L# |
| Day | `dayNumber()` | L# |
| Weekday | `weekdayNumber()` | L# — shown as `0 (Sunday)` |
| Hour | `hour24Number()` | L# |
| Minute | `minuteValue()` | L# |
| Second | `secondValue()` | L# |
| Sidereal time | `lstValue()` | HMS |
| Solar time | `solarTimeSec()` | HMS |
| TZ offset | `tzOffset()` | HMS |
| Equation of time | `EOTSeconds()` + `EOTAngle()` | MS + A |

### Group: Sun  (text header · update 1 s; rise/set 60 s) — **11 values**
| Subgroup (one row) | Left | Right |
|--------------------|------|-------|
| RA / Dec | `sunRA()` A | `declinationOfPlanet(0)` `[NEW]` L° |
| Topocentric alt / az | `sunAltitude()` L° | `sunAzimuth()` A |
| Ecliptic longitude | `ELongitudeOfPlanet(0)` A | — |
| Sub-solar lat / long | `subSolarLatitude()` L° | `subSolarLongitude()` A |
| Solar-noon angle | `solarNoonAngle24h()` A | — |
| Rise / Set / Transit | `sunriseForDayTime()`, `sunsetForDayTime()`, `sunTransitForDayTime()` (LT ×3) | |

`ELongitudeOfPlanet(0)` **is** the Sun's geocentric ecliptic longitude — verified:
`WB_planetApparentPosition` special-cases the Sun (returns `apparentLongitude`).
No `sunEclipticLongitude()` needed. (`subSolarLatitude/Longitude` are the
Observatory `earthSslat`/`earthSslng`.)

### Group: Moon  (text header · update 1 s; rise/set 60 s) — **16 values**
| Subgroup (one row) | Left | Right |
|--------------------|------|-------|
| RA / Dec | `moonRA()` A | `declinationOfPlanet(1)` `[NEW]` L° |
| Topocentric alt / az | `moonAltitude()` L° | `moonAzimuth()` A |
| Ecliptic lon / lat | `ELongitudeOfPlanet(1)` A | `ELatitudeOfPlanet(1)` L° |
| Phase: age / elongation | `moonAgeAngle()` A | `moonElongation()` A |
| Relative / rel-position | `moonRelativeAngle()` A | `moonRelativePositionAngle()` A |
| Asc. node lon / RA | `lunarAscendingNodeLongitude()` A | `lunarAscendingNodeRA()` A |
| Distance | `distanceFromEarthOfPlanet(1)` DIST (AU + km) | — |
| Rise / Set / Transit | `moonriseForDayTime()`, `moonsetForDayTime()`, `moonTransitForDayTime()` (LT ×3) | |

### Group: each Planet — Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune  (text header · update 1 s; rise/set/distance 60 s) — **13 each**
| Subgroup (one row) | Left | Right |
|--------------------|------|-------|
| RA / Dec | `RAOfPlanet(n)` A | `declinationOfPlanet(n)` `[NEW]` L° |
| Topocentric alt / az | `altitudeOfPlanet(n)` L° | `azimuthOfPlanet(n)` A |
| Ecliptic (geo) lon / lat | `ELongitudeOfPlanet(n)` A | `ELatitudeOfPlanet(n)` L° |
| Heliocentric lon / lat | `HLongitudeOfPlanet(n)` A | `HLatitudeOfPlanet(n)` `[NEW]` L° |
| Distance / Up now | `distanceFromEarthOfPlanet(n)` DIST (AU + km) | `planetIsUp(n)` L# (0/1) |
| Rise / Set / Transit | `riseOfPlanetForDayTime(n)`, `setOfPlanetForDayTime(n)`, `transitOfPlanetForDayTime(n)` (LT ×3) | |

**7 planets × 13 = 91 values.**

## Counts

| Group | Values |
|-------|-------:|
| User expression (3 representations) | 1 |
| Time | 12 |
| Sun | 11 |
| Moon | 16 |
| Mercury / Venus / Mars / Jupiter / Saturn / Uranus / Neptune (13 each) | 91 |
| **Total** | **131** |

New functions to add: **2** (`declinationOfPlanet`, `HLatitudeOfPlanet`).
`ELongitudeOfPlanet(0)` already covers the Sun's ecliptic longitude (verified).

## Gaps — new functions

Both computable from internals already present; both uniform across Sun/Moon/planets:

| New function | Backing (already present) |
|--------------|---------------------------|
| `declinationOfPlanet(n)` | `WB_planetApparentPosition(n).apparentDeclination` — one wrapper covers Sun (0), Moon (1) and all planets |
| `HLatitudeOfPlanet(n)` | `WB_planetHeliocentricLatitude` (`willmann-bell.ts:131`) — confirmed present |

Geocentric alt/az: **omitted** (only topocentric exists / is meaningful — agreed).
`sunEclipticLongitude()`: **not needed** — `ELongitudeOfPlanet(0)` is equivalent.
Per **Development Rules §13**, each new function also gets an `expr-metadata.ts`
entry.

## UI design

Replace the **Sun** rise/set card with a **scrolling catalog region** below the
existing header / Location / Expression-Evaluator cards.

- **Body headers are text (no icons this phase).** Each group header is the body
  name (e.g. `Sun`, `Moon`, `Mercury`) as a styled heading; Time likewise.
  Icons are **deferred to a later phase** (see below).
- **Horizontal layout.** Coordinate subgroups are natural pairs (RA/Dec, alt/az,
  lon/lat) → render each as **one row with two labeled value columns**; Time
  numbers as **separate labeled fields on a line** (with visual separators);
  rise/set/transit as a 3-up row. A CSS grid (2–3 value columns) keeps it dense
  and aligned.
- **Type scale.** Values small (~13 px mono, like today's `expr-result` rows);
  **group headings** larger (~18–20 px); **subgroup labels** small uppercase muted
  (~11–12 px). Reuse/extend `.data-grid/.data-item/.data-label/.data-value`.
- **Formatting** by tag: **A** `123.46°`; **L°** `−12.35°`; **L#** number + unit
  (`0/1`, weekday `0 (Sunday)`); **DIST** two fields `1.523 AU` and
  `227’943’000 km`; **HMS** `HH:MM:SS.sss`; **MS** `±MM:SS.sss`; **LT** local time
  (existing formatter), `—` when NaN / no event (polar).
- **Thousands separator:** use an **apostrophe `’`** (U+2019) — *not* a comma —
  for grouping large numbers (e.g. km distances), to avoid the international
  comma-as-decimal ambiguity. In the monospace value font a full-cell apostrophe
  looks gappy, so **wrap each separator in `<span class="kilo-sep">’</span>`** and
  style it to compress: a proportional font for that glyph plus tightening
  (e.g. `font-family: <UI sans>; margin: 0 -0.18em;` / negative `letter-spacing`),
  tuned so the digits stay monospace-aligned while the apostrophe takes minimal
  width. (The AU↔km pair renders as two separate fields, so the apostrophe is
  unambiguous as a group separator.)
- **Scroll scope.** Only the catalog scrolls (header / Location / Expression
  pinned) via a flex child with `overflow-y:auto`. The catalog is **always built
  and always live** (no visibility toggle).
- **FPS indicator.** Already `position:fixed` bottom-left, so it floats over the
  viewport and stays visible regardless of catalog scroll — just add bottom padding
  to the scroll region so the last rows aren't hidden behind it.

## Implementation

Each catalog value is **one `ObsValue`** (known `linear` flag → a single value,
unlike the free-form expression box which needs two).

1. **Add functions** `declinationOfPlanet`, `HLatitudeOfPlanet` to `astro-env.ts`
   (uniform wrappers over `WB_planetApparentPosition` / `WB_planetHeliocentric`-
   `Latitude`); update `expr-metadata.ts` (§13).
2. **Catalog definition** — declarative table in new `src/inspector/catalog.ts`:
   groups → subgroups → entries `{ label, expr, tag, updateInterval }`; planet
   groups generated from the template × planet list; entries carry their display
   tag (A/L°/L#/DIST/HMS/MS/LT).
3. **Build rows + ObsValues once**: create DOM (text headers, subgroup labels,
   paired-column rows) and a parallel `ObsValue[]` (`createObsValue`, correct
   `linear`/`updateInterval`/`evalAhead:true`); keep per-entry handles
   `{ valueEl, obsValue, tag }`.
4. **Per frame** in `tick()`: `updateObsValues(catalogValues, env, now, getNow,
   null, 0, 1, withDisplayTime)` + `animateObsValues(...)`, then write each
   `currentValue` via a tag formatter.
5. **On location change**: rebuild env (already happens) + `resetObsValueSchedules`
   so the catalog snaps/re-evaluates.

### Performance

~139 ObsValues, mostly 1 s (coordinates change slowly; eval-ahead interpolates the
1 s window smoothly, no lag), seconds at 0.1 s, rise/set/distance at 60 s →
worst-case ≈ ~120 evals on the shared 1 s boundary + a few fast ones. If the
synchronized boundary spike shows in `?fps`, apply eval-load **staggering** (prior
plan); worker path remains the long-term escape hatch. We'll **stress-test the
0.1 s path when the time controller lands** (cadence stays as-is for now).

## Deferred: body icons (later phase, two steps)

Not in this phase. When done:
1. **Move** the planet/sun/moon icons to a shared area **and change the EC image
   finder** (`generate-face-modules.js` parts-bin scan + the watch image loader) to
   also look in the shared area — a reasonable behavior for the finder regardless.
   Chronometer faces (Venezia/Firenze orrery) and the planet selector keep working
   via the finder's new shared lookup.
2. **Use** the now-shared icons as Inspector group headers (data-URL import).

## Docs to update (Development Rules §1)

- `docs/inspector.md` — the ephemeris catalog: groups, A/L°/L#/DIST/HMS/MS/LT
  tags, paired layout, scroll region, ObsValue-driven.
- `expr-metadata.ts` / §13 — entries for `declinationOfPlanet`, `HLatitudeOfPlanet`.
- `docs/astronomy.md` — note `declinationOfPlanet` / `HLatitudeOfPlanet`.

## Resolved decisions (from review)

- **Icons:** skipped this phase; deferred two-step phase recorded above. ✓
- **Weekday:** display `0 (Sunday)`. ✓
- **Catalog:** always built, always live (no toggle). ✓
- **Sun ecliptic longitude:** `ELongitudeOfPlanet(0)` (verified equivalent); no new
  function. ✓
- **Distance:** show both AU and km, km grouped with a **compressed apostrophe
  `’`** (not a comma/center dot) — a `.kilo-sep` span styled proportional + tightened
  so the monospace digits stay aligned. ✓
- **Time angles:** dropped except `EOTAngle`; numbers shown as separate fields. ✓
- **Planets:** Mercury→Neptune (7); Pluto excluded; Earth excluded. ✓
- **Cadence:** 1 s coords / 0.1 s seconds / 60 s rise-set-distance (stress-test the
  0.1 s path later with the time controller). ✓

No open questions remain — ready to implement when you are.
