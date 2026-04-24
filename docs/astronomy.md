# Astronomy

The astronomy module provides high-precision calculations for sun, moon, and planet positions, rise/set times, twilight boundaries, and lunar phase. These are ported from the iOS `esastro` library, which implements the Willmann-Bell series calculations.

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.esastro-ref/` | `src/ECAstronomy.mm` (high-level methods), `Willmann-Bell/ESWillmannBell*.cpp` (series calculations) |
| `.chronometer-ref/` | `ECVirtualMachineOps.m` (opcode → method mapping), `Classes/ECWatchTime.mm` (time methods) |
| `.estime-ref/` | `src/ESWatchTime.mm` (`secondValue`, `hour12ValueAngle`, etc.) |

## Tracing an Expression Function

When the XML uses a function like `sunRA()`, trace it through the iOS code:

1. **`ECVirtualMachineOps.m`** — Find the opcode name, see what method it calls  
   *Example*: `sunRA` → `[mainAstro sunRA]`

2. **`ECAstronomy.m`** (in `.esastro-ref/`) — Find the method implementation  
   *Example*: `sunRA` → `sunRAandDecl().rightAscension`

3. **`ECWatchTime.m`** (in `.estime-ref/`) — For time methods  
   *Example*: `year366IndicatorFraction`, `minuteValue`

4. **WB modules** (`ESWillmannBell*.cpp`) — Low-level series calculations

See [iOS Reference](ios-reference.md) for a complete file listing.

## Web Module Map

| File | Purpose | iOS equivalent |
|------|---------|---------------|
| `src/astronomy/es-astro.ts` | High-level sun/moon astronomy (RA, declination, age, position angle) | `ECAstronomy.m` |
| `src/astronomy/es-coordinates.ts` | Coordinate transforms (ecliptic ↔ equatorial ↔ horizontal) | `ECAstronomy.m` helpers |
| `src/astronomy/es-riseset.ts` | Rise/set/transit calculations for sun and moon | `ECAstronomyManager.cpp` |
| `src/astronomy/es-sidereal.ts` | Sidereal time (GMST, LST) | `ECAstronomy.m` |
| `src/astronomy/es-time.ts` | Julian date, ΔT, date interval conversions | `ESTime.cpp`, `ESCalendar.cpp` |
| `src/astronomy/es-calendar.ts` | Calendar utilities (day of year, leap year, month lengths) | `ESCalendar.cpp` |
| `src/astronomy/wb-sun.ts` | Willmann-Bell sun position (Bretagnon & Simon series) | `ESWillmannBellSun.cpp` |
| `src/astronomy/wb-moon.ts` | Willmann-Bell moon position (Chapront-Touzé tables) | `ESWillmannBellMoon.cpp` |
| `src/astronomy/wb-planets.ts` | Willmann-Bell planetary positions | `ESWillmannBellPlanets.cpp` |
| `src/astronomy/willmann-bell.ts` | WB manager and shared utilities | `ESWillmannBellManager.cpp` |
| `src/astronomy/astro-cache.ts` | Per-frame astronomy result caching | No direct equivalent |
| `src/astronomy/astro-constants.ts` | Shared constants | Various |
| `src/astronomy/lunar-tables.ts` | Chapront-Touzé lunar series coefficients | Data tables in WB Moon |
| `src/astronomy/planet-tables.ts` | Bretagnon & Simon planetary series coefficients | Data tables in WB Planets |

## Key Algorithms

### Moon Relative Position Angle

`moonRelativePositionAngle` determines the tilt of the moon's terminator as seen from the observer's location:

1. Compute Sun RA/Decl and Moon RA/Decl
2. Compute `positionAngle(sunRA, sunDecl, moonRA, moonDecl)` — `atan2` formula
3. Adjust for waning phase (`moonAgeAngle > π` → flip by 180°)
4. Compute Moon's hour angle, altitude, azimuth
5. Compute `northAngleForObject` (great circle course to celestial north pole)
6. Final angle = `−northAngle − posAngle − π/2`, normalized to [0, 2π)

### Astronomy Caching

`astro-cache.ts` provides per-frame caching to avoid redundant calculations. Multiple hands that reference the same astronomy function (e.g., `sunAltitude()`) within one frame reuse the cached result.

## Key Pitfalls

### `julianCenturiesSince2000EpochForDateInterval` returns an object

This function returns `{ julianCenturiesSince2000Epoch: number, deltaT: number }`, **not** a bare number. Always destructure:

```typescript
const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, cache);
```

### NaN guards for table lookups

During initial hand state collection, expression functions may be called before all variables are resolved, producing `NaN` inputs. Functions that do table lookups must guard at the top:

```typescript
if (isNaN(U)) return null;
```

`NaN` defeats range checks (`NaN < x` and `NaN > x` are both `false`), causing index calculations to produce `NaN` and crash on array access.

### Never simplify iOS algorithms

See [Development Rules §2](development-rules.md#2-never-simplify-ios-algorithms). The astronomical calculations contain steps that look algebraically reducible but handle numerical stability at extreme date ranges.

### Rise/Set Two-Step Search (`nextPrevRiseSetInternal`)

Finding the next/previous rise or set event uses the iOS `nextPrevRiseSetInternalWithFudgeInterval` algorithm (a faithful port in `watch-env.ts`):

1. **Fudge**: Offset `calcDate` by a small fudge factor (5 seconds) in the search direction
2. **First try**: Call `planetaryRiseSetTimeRefined(fudgeDate, ...)` which returns both `riseSetTime` and `transitTime`
3. **Transit validation**: Check if `transitTime` is in the correct temporal direction (iOS lines 2335-2337). This catches cases where the solver converges on an event in the wrong direction
4. **Retry**: If transit validation fails, retry from `fudgeDate ± 13.2 hours` (the lookahead)

The `planetaryRiseSetTimeRefined` function returns a `RiseSetResult` with both `riseSetTime` and `transitTime` fields, matching the iOS `riseSetOrTransit` output parameter pattern.

### `planetIsUp` Check

Determining whether a planet is currently above the horizon must use the same altitude threshold as the rise/set algorithm. iOS (`ECAstronomy.m` line 3427-3430) compares the planet's altitude against `altitudeAtRiseSet()` — a negative value accounting for atmospheric refraction and body semidiameter (~-0.8° to -1.0° for the Moon) — **not** against zero. Using `alt > 0` creates a several-minute gap near rise/set where the altitude check and the algorithm disagree, causing the day/night ring to briefly show tomorrow's event instead of today's.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/astronomy/es-astro.ts` | Main astronomy API |
| `src/astronomy/astro-cache.ts` | Per-frame result caching |
| `src/watch/watch-env.ts` | Wires astronomy functions into the expression environment |

## Related Docs

- [Expressions](expressions.md) — How astronomy functions are called from XML expressions
- [iOS Reference](ios-reference.md) — Full tracing guide for opcodes
- [Terminator](terminator.md) — Moon phase display using `moonAgeAngle` and `moonRelativePositionAngle`
- [Development Rules](development-rules.md) — Never-simplify rule, NaN guards
