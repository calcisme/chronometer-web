# Observatory Port — Phase 7B: Eclipse Simulator

> Dated plan for Phase 7B of the [Observatory web port](2026-05-26-observatory-port.md).
> Status: ✅ **implemented** (2026-06-06); awaiting user visual verification.
> Notable deviation from the plan: the planned `moonAscendingNodeRA` expr already
> existed as `lunarAscendingNodeRA`, so it was reused (no 4th new function added).
> Self-contained: written to survive conversation compression. All iOS line
> references are to files under `.observatory-ref/` (reference only — never a
> build input).

## Context

Phases 0–7 are complete: the full orrery, the three inner subdials, Earth map,
Moon phase display, the alt/az/EOT peripheral dials, the date display, and
animated planet switching all work. The one peripheral slot still empty is the
**eclipse simulator** (`eclipseCX/CY`, inner radius `eclipseR1`, outer
`eclipseR2` in `layout.ts`). Phase 7 left it blank on purpose; 7B fills it in
**completely** (disc + status labels + the five ring-indicator hands).

The eclipse simulator is a small circular "telescope view" of the current
Sun–Moon (solar) or Moon–Earth-shadow (lunar) geometry. When the two bodies are
within 10° of each other it zooms into their real apparent sizes and separation,
oriented to the local horizon, with a green overlay marking any below-horizon
portion. Otherwise it shows an "Eclipse Simulator" caption. Around the disc, an
annular ring carries five small image markers (Sun, Moon, Earth-shadow,
ascending/descending lunar node) showing their right-ascensions — when the Sun
and Moon markers coincide near a node, an eclipse is imminent.

**Two design decisions from review (incorporated below):**
1. **Ring-indicator hands are included in 7B** (no separate 7C).
2. The disc is **animation-friendly via obs-values** — every component scalar is
   its own `ObsValue`, and they all share **exactly one update period** so the
   geometry stays mutually consistent frame to frame. That period is a **new
   sentinel** (below). (Basel's eclipse hand just uses `update='1'`; we want
   smarter cadence here.)

All required astronomy already exists in `src/astronomy/es-astro.ts`; 7B adds a
few thin expr-function wrappers, one new update sentinel, the obs-values, and the
rendering.

## iOS reference

| Element | Source |
|---------|--------|
| Simulator disc geometry | `EOEclipseView.mm` `drawRect:` (L63-317) — the canonical algorithm, restated below |
| Dial background ring | `EOShuffleView.mm` `EOEclipseDialShuffleView` (L373-401) |
| View creation / params | `EOClock.mm:2156-2172` |
| Status/horizon labels | `EOClock.mm:1949-1953, 2168-2172` |
| iOS update cadence | `EOClock.mm:1640` → `eclipseUpdate = 30` (we replace with the sentinel) |
| Ring hands | `EOHandView.mm:382-450` (`EOEclipseRing*` cases); `EOClock.mm:2176-2200` |

## Astronomy — already available

In `src/astronomy/es-astro.ts`:
- `calculateEclipse(dateInterval, latRad, lonRad, cache)` →
  `{ abstractSeparation, angularSeparation (rad), shadowAngularSize (rad), eclipseKind }` (L701).
- `EclipseKind` enum (L638): `NoneSolar, NoneLunar, SolarNotUp, PartialSolar, AnnularSolar, TotalSolar, LunarNotUp, PartialLunar, TotalLunar`.
- `eclipseKindIsMoreSolarThanLunar(kind)` (L825) — import into the view to derive `solarNotLunar`.
- `moonRelativeAngle` (L513), `planetGeocentricDistance` (L1006, AU),
  `lunarAscendingNodeLongitude` (L1030).

Existing **expr functions** (in `astro-env.ts`) reused by the obs-values:
`altitudeOfPlanet(p)`, `azimuthOfPlanet(p)`, `distanceFromEarthOfPlanet(p)`,
`moonRelativeAngle()`, `RAOfPlanet(p)`.

### New expr functions to add (`src/shared/astro-env.ts`)
Thin wrappers over `calculateEclipse` / node math (one `calculateEclipse` call
each; the obs-values that use them all fire on the same sentinel tick):
- `eclipseAngularSeparation()` → `calculateEclipse(...).angularSeparation` (the existing `eclipseSeparation()` returns the *abstract* 0–3 value — not what the disc needs).
- `eclipseShadowAngularSize()` → `calculateEclipse(...).shadowAngularSize`.
- `eclipseKindRaw()` → `calculateEclipse(...).eclipseKind` (raw 0–8; the existing `eclipseKind()` collapses values for the Basel wheel).
- `moonAscendingNodeRA()` → convert `lunarAscendingNodeLongitude()` (ecliptic longitude, latitude 0) to right ascension via the obliquity transform. *(Only genuinely new astronomy; small. Verify against any existing ecliptic→equatorial helper before hand-rolling.)*

## New update sentinel: `EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION`

Add to **`src/shared/animation.ts`** alongside `EC_UPDATE_NEXT_SSLAT_CHANGE`
(use the next free value, `-1019`), wire a `case` in `resolveSentinel`
(L1084-1157), and implement the resolver modeled on `nextSslatChange`
(L1042-1076). It returns a dateInterval (Apple-epoch seconds).

Behavior (per review):
- **Graphical mode** — currently within the threshold (`angularSeparation < π/18`,
  i.e. the disc is drawn): return `now + dir · 1s`.
- **Caption mode** — outside the threshold ("Eclipse Simulator" shown): return the
  next time we'd cross *into* the threshold, **capped at 1 hour**, and conservative
  (early is fine).

Implementation — a closing-rate bound avoids a fragile search (separation is
non-monotonic over a month, but locally bounded):
```
THRESHOLD = Math.PI / 18                     // 10°
MAX_CLOSING_RATE = (1.0° per hour) in rad/s  // safe upper bound on |d(sep)/dt|
                  = (Math.PI/180) / 3600       // Moon≈0.55–0.61°/h + Sun≈0.04°/h ⇒ 1°/h is conservative
sep = calculateEclipse(nowDI, lat, lon, null).angularSeparation
intervalSec = clamp((sep - THRESHOLD) / MAX_CLOSING_RATE, 1, 3600)
return nowDI + timeDirection * intervalSec
```
When `sep ≤ THRESHOLD` the clamp yields 1 s (graphical mode). When above, the
interval is the *soonest* the separation could possibly reach the threshold given
the max closing rate — so we never skip the crossing, yet never wait more than an
hour. `lat/lon` come from `env.observerLatRad/LonRad`; honor `timeDirection`
(forward/reverse) like the other resolvers.

> Why a bound, not a binary search: `nextSslatChange` works because sun
> declination is monotonic over its 2-day window; eclipse separation is not, so
> the conservative rate bound is the robust analog and matches "checking more
> often is ok."

## obs-values (`src/observatory/obs-values.ts`)

All of the following use `updateInterval: EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION`
so they re-evaluate on the *same* tick → consistent geometry. Add names to the
`ObsValueName` union and `expectedNames()`.

**Disc geometry (10):**
| name | expr | flags |
|------|------|-------|
| `eclSeparation` | `eclipseAngularSeparation()` | linear |
| `eclShadowSize` | `eclipseShadowAngularSize()` | linear |
| `eclKind` | `eclipseKindRaw()` | linear, **discrete** (snap; it's an enum — read via `Math.round`) |
| `eclSunAlt` | `altitudeOfPlanet(0)` | linear |
| `eclSunAz` | `azimuthOfPlanet(0)` | angular |
| `eclMoonAlt` | `altitudeOfPlanet(1)` | linear |
| `eclMoonAz` | `azimuthOfPlanet(1)` | angular |
| `eclSunDist` | `distanceFromEarthOfPlanet(0)` | linear |
| `eclMoonDist` | `distanceFromEarthOfPlanet(1)` | linear |
| `eclMoonRelAngle` | `moonRelativeAngle()` | angular |

> These duplicate a few quantities that exist on other periods (`moonDistAU` @3600,
> `moonRotation` @60). That's intentional — the eclipse copies must share the
> eclipse sentinel for consistency, so register dedicated `ecl*` values rather
> than reuse.

**Ring-hand RA markers (3):** (same sentinel; angular)
| name | expr |
|------|------|
| `eclRingSunRA` | `RAOfPlanet(0)` |
| `eclRingMoonRA` | `RAOfPlanet(1)` |
| `eclRingNodeRA` | `moonAscendingNodeRA()` |

## Assets to copy → `src/shared/assets/` (import as data URLs)
Disc: `sunEclipse.png` (Sun disc+corona; `sunRadiusFraction = 68/316`),
`totalEclipse.png` (totality), `earthShadow.png` (umbra gradient;
`earthShadowRadiusFraction = 118/120`). Moon reuses `moon300.png`.
Ring hands: `eclipseRingSun.png`, `eclipseRingMoon.png`,
`eclipseRingEarthShadow.png`, `eclipseRingAscNode.png`, `eclipseRingDesNode.png`.

## Implementation

### 1. `src/shared/astro-env.ts`
Add the 4 expr functions above (`eclipseAngularSeparation`, `eclipseShadowAngularSize`,
`eclipseKindRaw`, `moonAscendingNodeRA`).

### 2. `src/shared/animation.ts`
Add the sentinel constant, the `resolveSentinel` case, and the resolver function.
Import `calculateEclipse` from es-astro.

### 3. `src/observatory/obs-values.ts`
Register the 13 obs-values above; extend `ObsValueName` + `expectedNames()`.

### 4. `src/observatory/peripheral-dials.ts`
Add `drawEclipseDial(ctx, L)` to the static cache (`getPeripheralDialsCache`):
port `EOEclipseDialShuffleView` (L373-401) — annulus between `eclipseR1` and
`eclipseR2`, translucent white fill (`fill('evenodd')`), white strokes. Matches
the alt/az/EOT family.

### 5. `src/observatory/eclipse-view.ts` [NEW]
`initEclipseView()` loads the 8 images (3 disc + 5 ring; moon reused).
`drawEclipseView(ctx, L, u)` reads everything from the updater `u` and draws.

**Pixel scale (port of EOEclipseView.mm:69-100):**
```
perigeeDistance=355000, au=149600000, lunarRadius=1737.10, solarRadius=695500  (km)
moonAngularRadiusAtPerigee = atan(lunarRadius/perigeeDistance)
moonRadiusAtPerigee        = 20 * (eclipseR1 / 49)   // iOS: 20 px at reference eclipseR1≈49; scale to keep the ratio
ppar = moonRadiusAtPerigee / moonAngularRadiusAtPerigee          // pixelsPerAngularRadian
moonPixelRadiusNow = ppar * atan(lunarRadius/(eclMoonDist*au))
sunPixelRadiusNow  = ppar * atan(solarRadius/(eclSunDist*au))
viewR = eclipseR1
```

**Gate:** `solarNotLunar = eclipseKindIsMoreSolarThanLunar(Math.round(eclKind))`.
If `eclSeparation >= π/18` → draw nothing in the disc; show the "Eclipse
Simulator" caption (ring hands still drawn). Else translate to
`(eclipseCX, eclipseCY)`, clip to a circle of radius `viewR`, and draw per branch.

> ⚠️ **Coordinate note:** iOS draws in a Y-up CTM; Canvas 2D is Y-down. The
> source flags several Y signs "from the view coordinate system." Port literally,
> then verify orientation visually (Sun-above-Moon etc.) and flip the Y signs of
> the pixel positions / green overlay if mirrored — same reconciliation used for
> the Moon (Phase 6) and earth terminators.

**Solar branch** (`solarNotLunar`, port L114-179), using `eclMoonAlt/Az`,
`eclSunAlt/Az`, `eclSeparation`:
```
azDelta = fmod(moonAz - sunAz, 2π); if azDelta>π: azDelta -= 2π
altDelta = moonAlt - sunAlt;  avgAlt = (moonAlt+sunAlt)/2
azFudge = max(0.01, |cos(avgAlt)|);  theta = atan2(altDelta, azDelta*azFudge)
moonPixelX =  cos(theta)*sep*ppar/2 ;  sunPixelX = -moonPixelX
moonPixelY = -sin(theta)*sep*ppar/2 ;  sunPixelY = -moonPixelY      // Y per view coords
horizonPixelY = -avgAlt*ppar
if kind == TotalSolar:
    totalPixelRadiusNow = moonPixelRadiusNow / (68/316)
    draw totalEclipse.png centered at (moonPixelX,moonPixelY), r = totalPixelRadiusNow
else:
    draw sunEclipse.png centered at (sunPixelX,sunPixelY), r = sunPixelRadiusNow
    fill Moon silhouette ellipse at (moonPixelX,moonPixelY) r=moonPixelRadiusNow,
        fill rgba(20,20,23,1), stroke rgba(255,255,255,0.15)
drawingSomething = (dist(moon)-moonPixelRadiusNow < viewR) || (dist(sun)-sunPixelRadiusNow < viewR)
```

**Lunar branch** (else, port L180-290), using `eclShadowSize`, `eclMoonRelAngle`:
```
earthShadowAlt = -sunAlt;  earthShadowAz = fmod(sunAz+π, 2π);  shadowR = shadowSize/2
azDelta = fmod(earthShadowAz - moonAz, 2π); if azDelta>π: azDelta -= 2π
altDelta = earthShadowAlt - moonAlt;  avgAlt = (earthShadowAlt+moonAlt)/2
horizonPixelY = -avgAlt*ppar
if sep > shadowR:                                  // separated
    azFudge = max(0.01,|cos(avgAlt)|); theta = atan2(altDelta, azDelta*azFudge)
    moonPixelX        = -cos(theta)*(sep-shadowR)*ppar/2
    earthShadowPixelX =  cos(theta)*(sep+shadowR)*ppar/2
    moonPixelY        =  sin(theta)*(sep-shadowR)*ppar/2          // Y per view coords
    earthShadowPixelY = -sin(theta)*(sep+shadowR)*ppar/2
else:                                              // overlapping
    azFudge = max(0.01,|cos(moonAlt)|); theta = atan2(altDelta, azDelta*azFudge)
    moonPixelX=0; moonPixelY=0
    earthShadowPixelX =  cos(theta)*sep*ppar;  earthShadowPixelY = -sin(theta)*sep*ppar
// 1. Earth-shadow outline ellipse at earthShadowPixel, r = ppar*shadowR,
//      fill rgba(0,0,0,0.8), stroke rgba(255,255,255,0.15)
// 2. Moon: save; translate to moonPixel; rotate by eclMoonRelAngle; draw moon300.png r=moonPixelRadiusNow; restore
// 3. Shadow over Moon: save; clip to moon ellipse; draw earthShadow.png at earthShadowPixel,
//      r = ppar*shadowR / (118/120), globalCompositeOperation='multiply'; restore
drawingSomething = (dist(moon)-moonPixelRadiusNow < viewR) || (dist(earthShadow)-ppar*shadowR < viewR)
```

**Below-horizon overlay + labels** (port L291-312), `w=h=2*viewR`:
```
if drawingSomething && horizonPixelY > -h/2:
    clamp horizonPixelY ≤ h/2
    fill rgba(0,0.3,0,0.5) over the below-horizon region (verify Y sign)
    if horizonPixelY > 0:  show "Below horizon"  (hide caption)
    else:                  show "Eclipse Simulator"
else: show "Eclipse Simulator"
```
Labels via `drawText` (alphabetic baseline + `textVisualCenterY`), `eclipseFontSize`.
A faithful port shows the caption over a visible above-horizon eclipse; tweak
visually if it reads poorly (e.g. only show the caption when nothing is drawn).

**Ring-indicator hands** (port `EOHandView.mm:382-450`): five small images placed
on the ring and rotated to RA-derived clock angles (verify RA→ring orientation
and the `+π` offsets visually):
| marker | asset | radius | clock angle |
|--------|-------|--------|-------------|
| Sun | `eclipseRingSun.png` | `eclipseR2+4*s` | `π + eclRingSunRA` |
| Moon | `eclipseRingMoon.png` | `eclipseR1-1*s` | `π + eclRingMoonRA` |
| Earth shadow | `eclipseRingEarthShadow.png` | `eclipseR1-1*s` | `eclRingSunRA` (anti-solar) |
| Asc node | `eclipseRingAscNode.png` | `(R1+R2)/2` | `π + eclRingNodeRA` |
| Desc node | `eclipseRingDesNode.png` | `(R1+R2)/2` | `eclRingNodeRA` |

Draw each like a small image hand: translate to center, rotate to the clock
angle, draw the image at the radius (reuse the planet-image orientation
convention from `planet-hands.ts`, progress-log lesson #3). The iOS Moon-ring
case also rotates the glyph by `RA(Sun)−RA(Moon)`; treat that as a visual
refinement to confirm against iOS.

### 6. `src/observatory/observatory-entry.ts`
- Import + `initEclipseView()` next to `initMoonView()`.
- In `drawFrame()`, after the moon/earth/date block, `if (updater) drawEclipseView(ctx, L, updater);` (DPR-scaled section). The background ring comes free via the peripheral-dials static cache.

### 7. Docs
- `docs/observatory.md` — add `eclipse-view.ts` to the Source Layout; add an
  `## Eclipse Simulator` section (the new sentinel + why; the obs-value set and
  shared-period rationale; pixel-scale model; solar/lunar branches; ring hands;
  the Y-coordinate note). Add the `Eclipse` rows to the Value Catalog and note
  the new sentinel in the update-scheduling discussion.
- `planning/2026-05-26-observatory-port.md` — mark Phase 7B ✅ on completion; add
  a progress-log entry; the status table already lists 7B.

## Verification
- **Automated:** `npx tsc --noEmit`; `./build.sh`; `grep -c 'watch/' dist/observatory-engine.js` unchanged; unit tests for (a) the new expr functions / `moonAscendingNodeRA` and (b) the sentinel resolver returning ~1 s inside the threshold and a capped (≤1 h), never-overshooting interval outside it.
- **Visual (user):** scrub to a known **total solar** eclipse (e.g. **2026-08-12**) and a **lunar** eclipse; confirm the disc shows the bodies overlapping at correct size/orientation, the geometry **animates smoothly** while scrubbing (1 s cadence in-threshold) and the caption shows when idle; the green overlay appears when the event is low/below the horizon; the five ring markers track Sun/Moon/shadow/nodes and converge near eclipses; background ring matches the alt/az/EOT style. Cross-check against iOS Observatory / Selene.

## Note on the obs-value animation approach
Per review: the disc is driven entirely by obs-values (no monolithic snapshot
helper), so it inherits the standard animate/scrub machinery. Consistency is
guaranteed by every component sharing the single eclipse sentinel — all targets
re-evaluate on the same tick and animate over the same `animSpeed`, so the
derived pixel geometry stays coherent between samples. `eclKind` is `discrete`
(snaps, no interpolation) since it's an enum.
