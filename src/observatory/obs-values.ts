/**
 * Observatory expression-driven value system (catalog).
 *
 * Defines the full set of Observatory ObsValues (clock hands, sun events,
 * subdials, planet hands/rings, sun ring, earth view) and provides a named,
 * typed `ObsValueSet` for the renderers.
 *
 * The generic machinery lives in the shared layer:
 *   - `src/shared/obs-value.ts` — the `ObsValue` value type + `createObsValue`
 *   - `src/shared/updater.ts`   — the per-frame update/animate passes
 *
 * This module keeps the Observatory-specific catalog plus thin `ObsValueSet`
 * wrappers that delegate to the shared array-based passes via `getAllValues`.
 *
 * Architecture:
 *   1. **Init** — parse expression strings into ASTs, evaluate initial values.
 *   2. **Update pass** — re-evaluate any ObsValue whose timer has expired.
 *   3. **Animate pass** — interpolate every AnimatingValue toward its target.
 *   4. **Draw pass** — renderers read `obsValue.currentValue` instead of
 *      computing inline.
 */

import type { Environment } from '../expr/evaluator.js';
import {
    EC_UPDATE_NEXT_SUNRISE,
    EC_UPDATE_NEXT_SUNSET,
    EC_UPDATE_NEXT_SUNRISE_OR_SUNSET,
    EC_UPDATE_NEXT_PLANET_RISE,
    EC_UPDATE_NEXT_PLANET_SET,
    EC_UPDATE_NEXT_SSLAT_CHANGE,
} from '../shared/animation.js';
import { SunAltitudeKind } from '../shared/astro-env.js';
import { type ObsValue, type ObsValueDef, createObsValue } from '../shared/obs-value.js';
import {
    updateObsValues as coreUpdateObsValues,
    animateObsValues as coreAnimateObsValues,
    resetObsValueSchedules as coreResetObsValueSchedules,
    anyObsAnimating as coreAnyObsAnimating,
    type WithDisplayTime,
} from '../shared/updater.js';

// Re-export the ObsValue type so renderers can import it from here.
export type { ObsValue } from '../shared/obs-value.js';

/**
 * Named collection of all Observatory ObsValues, organized by purpose.
 * This gives typed access to values by name in the draw pass.
 */
export interface ObsValueSet {
    // -- Main dial clock hands --
    h24: ObsValue;
    h12: ObsValue;
    minute: ObsValue;
    second: ObsValue;

    // -- Sun event hands (NaN = hidden) --
    sunrise: ObsValue;
    sunset: ObsValue;
    goldenMorning: ObsValue;
    goldenEvening: ObsValue;
    civilTwiMorning: ObsValue;
    civilTwiEvening: ObsValue;
    nautTwiMorning: ObsValue;
    nautTwiEvening: ObsValue;
    astroTwiMorning: ObsValue;
    astroTwiEvening: ObsValue;
    solarNoon: ObsValue;
    solarMidnight: ObsValue;

    // -- UTC subdial --
    utcHour: ObsValue;
    utcMinute: ObsValue;
    utcSecond: ObsValue;

    // -- Solar subdial --
    solarHour: ObsValue;
    solarMinute: ObsValue;
    solarSecond: ObsValue;

    // -- Sidereal subdial --
    sidHour: ObsValue;
    sidMinute: ObsValue;
    sidSecond: ObsValue;

    // -- Planet hands --
    saturnHand: ObsValue;
    jupiterHand: ObsValue;
    marsHand: ObsValue;
    earthHand: ObsValue;
    venusHand: ObsValue;
    mercuryHand: ObsValue;
    moonOffset: ObsValue;

    // -- Planet rings (6 values each: rise angle, set angle, transit angle,
    //    riseValid, setValid, aboveHorizon) --
    // riseValid/setValid: 1 if planet actually rises/sets, 0 if angle is transit fallback
    // aboveHorizon: 1 if planet is always above horizon (polar), 0 otherwise
    saturnRing: ObsValue[];
    jupiterRing: ObsValue[];
    marsRing: ObsValue[];
    venusRing: ObsValue[];
    mercuryRing: ObsValue[];
    moonRing: ObsValue[];

    // -- Sun ring gradient stops (angular positions with fixed colors) --
    // NaN = sun doesn't reach this altitude (polar regions)
    sunRing: ObsValue[];

    // -- Earth view (sub-solar point) --
    earthSslat: ObsValue;
    earthSslng: ObsValue;
}

// ============================================================================
// Expression definitions
// ============================================================================

/**
 * Build the full catalog of ObsValue definitions.
 *
 * Expression strings reference functions registered in astro-env.ts.
 * The `noonOnTop` variable (0 or 1) is set in the environment.
 */
function buildValueDefs(): {
    clock: ObsValueDef[];
    sunEvents: ObsValueDef[];
    utc: ObsValueDef[];
    solar: ObsValueDef[];
    sidereal: ObsValueDef[];
    planets: ObsValueDef[];
    rings: Map<string, ObsValueDef[]>;
    sunRing: ObsValueDef[];
} {
    // SunAltitudeKind enum values for expression args
    const SK = SunAltitudeKind;

    // Planet numbers (matching ECPlanetNumber)
    const SATURN = 7, JUPITER = 6, MARS = 5, VENUS = 3, MERCURY = 2, MOON = 1;

    // Second hands sweep at exactly one revolution per 60 seconds.
    const SECOND_NATURAL_SPEED = 2 * Math.PI / 60;  // rad/s

    const clock: ObsValueDef[] = [
        { name: 'h24',    expr: 'hour24ValueAngle() + pi * noonOnTop', updateInterval: 15 },
        { name: 'h12',    expr: 'hour12ValueAngle()',                  updateInterval: 1 },
        { name: 'minute', expr: 'minuteValueAngle()',                  updateInterval: 1 },
        { name: 'second', expr: 'secondValueAngle()',                  updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const sunEvents: ObsValueDef[] = [
        // Sunrise updates when time crosses sunset (and vice versa)
        // Morning events update at next sunset; evening events at next sunrise.
        // This matches iOS: sunriseForDay changes when time passes through
        // the point 180° from the observer.
        { name: 'sunrise',          expr: `sunSpecialAngle(${SK.SunRiseMorning}) + pi * noonOnTop`,          updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'sunset',           expr: `sunSpecialAngle(${SK.SunSetEvening}) + pi * noonOnTop`,           updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'goldenMorning',    expr: `sunSpecialAngle(${SK.SunGoldenHourMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'goldenEvening',    expr: `sunSpecialAngle(${SK.SunGoldenHourEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'civilTwiMorning',  expr: `sunSpecialAngle(${SK.SunCivilTwilightMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'civilTwiEvening',  expr: `sunSpecialAngle(${SK.SunCivilTwilightEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'nautTwiMorning',   expr: `sunSpecialAngle(${SK.SunNauticalTwilightMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'nautTwiEvening',   expr: `sunSpecialAngle(${SK.SunNauticalTwilightEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'astroTwiMorning',  expr: `sunSpecialAngle(${SK.SunAstroTwilightMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'astroTwiEvening',  expr: `sunSpecialAngle(${SK.SunAstroTwilightEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'solarNoon',        expr: 'solarNoonAngle24h() + pi * noonOnTop',     updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
        { name: 'solarMidnight',    expr: 'solarNoonAngle24h() + pi + pi * noonOnTop', updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
    ];

    const utc: ObsValueDef[] = [
        // UTC subdial is 24h
        { name: 'utcHour',   expr: 'fmod((hour24Value() - tzOffset() / 3600), 24) * 2 * pi / 24', updateInterval: 60 },
        { name: 'utcMinute', expr: 'utcMinuteAngle()', updateInterval: 15 },
        { name: 'utcSecond', expr: 'utcSecondAngle()', updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const solar: ObsValueDef[] = [
        // Solar subdial is 12h
        { name: 'solarHour',   expr: 'fmod(solarTimeSec() / 3600, 12) * 2 * pi / 12', updateInterval: 60 },
        { name: 'solarMinute', expr: 'fmod(solarTimeSec() / 60, 60) * 2 * pi / 60',   updateInterval: 15 },
        { name: 'solarSecond', expr: 'fmod(solarTimeSec(), 60) * 2 * pi / 60',         updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const sidereal: ObsValueDef[] = [
        // Sidereal subdial is 24h
        { name: 'sidHour',   expr: 'fmod(lstValue() / 3600, 24) * 2 * pi / 24', updateInterval: 60 },
        { name: 'sidMinute', expr: 'fmod(lstValue() / 60, 60) * 2 * pi / 60',   updateInterval: 15 },
        { name: 'sidSecond', expr: 'fmod(lstValue(), 60) * 2 * pi / 60',         updateInterval: 20, naturalSpeed: SECOND_NATURAL_SPEED },
    ];

    const planets: ObsValueDef[] = [
        { name: 'saturnHand',  expr: `-HLongitudeOfPlanet(${SATURN})`,  updateInterval: 3600 },
        { name: 'jupiterHand', expr: `-HLongitudeOfPlanet(${JUPITER})`, updateInterval: 3600 },
        { name: 'marsHand',    expr: `-HLongitudeOfPlanet(${MARS})`,    updateInterval: 3600 },
        { name: 'earthHand',   expr: '-HLongitudeOfPlanet(4)',          updateInterval: 3600 },  // Earth = 4
        { name: 'venusHand',   expr: `-HLongitudeOfPlanet(${VENUS})`,   updateInterval: 3600 },
        { name: 'mercuryHand', expr: `-HLongitudeOfPlanet(${MERCURY})`, updateInterval: 3600 },
        { name: 'moonOffset',  expr: '-moonAgeAngle() + pi',            updateInterval: 3600 },
    ];

    // Planet rings: 6 values each (rise, set, transit, riseValid, setValid, aboveHorizon)
    const ringPlanets = [
        { key: 'saturn',  pn: SATURN },
        { key: 'jupiter', pn: JUPITER },
        { key: 'mars',    pn: MARS },
        { key: 'venus',   pn: VENUS },
        { key: 'mercury', pn: MERCURY },
        { key: 'moon',    pn: MOON },
    ];

    const rings = new Map<string, ObsValueDef[]>();
    for (const { key, pn } of ringPlanets) {
        // Ring rise angle updates at next planet set (and vice versa)
        // Transit updates at whichever rise/set comes first
        // Validity/polar flags update at the same cadence as their corresponding angle
        rings.set(key, [
            { name: `${key}Rise`,         expr: `dayNightLeafAngle(${pn}, 0, 0) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
            { name: `${key}Set`,          expr: `dayNightLeafAngle(${pn}, 1, 0) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_PLANET_RISE(pn) },
            { name: `${key}Transit`,      expr: `planetTransitAngle(${pn}) + pi * noonOnTop`,      updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
            { name: `${key}RiseValid`,    expr: `dayNightLeafAngleIsRiseSet(${pn}, 0)`,             updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
            { name: `${key}SetValid`,     expr: `dayNightLeafAngleIsRiseSet(${pn}, 1)`,             updateInterval: EC_UPDATE_NEXT_PLANET_RISE(pn) },
            { name: `${key}AboveHorizon`, expr: `dayNightLeafAngleAboveHorizon(${pn}, 0)`,          updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
        ]);
    }

    // Sun ring gradient stops — angular positions for fixed-color stops.
    // Each stop represents where the sun crosses a specific altitude threshold.
    // Morning stops update at sunset; evening stops at sunrise (same as hands).
    // Noon/midnight anchors update at either event.
    //
    // Epsilon for the sunrise/sunset color-stop boundary.  Larger values
    // widen the sharp cyan→red transition band around the sunrise/sunset hand.
    // 0.001 rad ≈ 0.23 time-minutes (≈ 14 time-seconds).
    const SUNSET_EPSILON = 0.001;
    const sunRing: ObsValueDef[] = [
        // Morning side (night → day): update at next sunset
        { name: 'ring18BelowMorn',   expr: `sunSpecialAngle(${SK.SunRing18BelowMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring9BelowMorn',    expr: `sunSpecialAngle(${SK.SunRing9BelowMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring1BelowMorn',    expr: `sunSpecialAngle(${SK.SunRiseMorning}) + pi * noonOnTop - ${SUNSET_EPSILON}`,  updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ringHalfBelowMorn', expr: `sunSpecialAngle(${SK.SunRiseMorning}) + pi * noonOnTop + ${SUNSET_EPSILON}`,  updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring1AboveMorn',    expr: `sunSpecialAngle(${SK.SunRing1AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring9AboveMorn',    expr: `sunSpecialAngle(${SK.SunRing9AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring30AboveMorn',   expr: `sunSpecialAngle(${SK.SunRing30AboveMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },
        // Evening side (day → night): update at next sunrise
        { name: 'ring30AboveEve',    expr: `sunSpecialAngle(${SK.SunRing30AboveEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring9AboveEve',     expr: `sunSpecialAngle(${SK.SunRing9AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring1AboveEve',     expr: `sunSpecialAngle(${SK.SunRing1AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ringHalfBelowEve',  expr: `sunSpecialAngle(${SK.SunSetEvening}) + pi * noonOnTop - ${SUNSET_EPSILON}`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring1BelowEve',     expr: `sunSpecialAngle(${SK.SunSetEvening}) + pi * noonOnTop + ${SUNSET_EPSILON}`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring9BelowEve',     expr: `sunSpecialAngle(${SK.SunRing9BelowEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring18BelowEve',    expr: `sunSpecialAngle(${SK.SunRing18BelowEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        // Anchor points: solar noon and midnight (positions always valid, colors computed at render time)
        { name: 'ringNoon',     expr: 'solarNoonAngle24h() + pi * noonOnTop',      updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
        { name: 'ringMidnight', expr: 'solarNoonAngle24h() + pi + pi * noonOnTop',  updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
    ];

    return { clock, sunEvents, utc, solar, sidereal, planets, rings, sunRing };
}

// Earth view defs are separate because they use a different sentinel and
// their values are linear (radians), not angular (no wrapping).
const earthDefs: ObsValueDef[] = [
    // subSolarLatitude changes slowly; the sentinel binary-searches for
    // when it changes by ≥0.1° (see nextSslatChange in animation.ts).
    { name: 'earthSslat', expr: 'subSolarLatitude()', updateInterval: EC_UPDATE_NEXT_SSLAT_CHANGE, linear: true },
    // subSolarLongitude changes ~1°/4min; update every 60s.
    // NOT linear — sslng is angular and wraps at ±π (dateline).
    { name: 'earthSslng', expr: 'subSolarLongitude()', updateInterval: 60 },
];

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize all Observatory dynamic values.
 *
 * Parses expression strings, evaluates initial values, and sets up
 * animation state and scheduling for every value.
 */
export function initObsValues(
    env: Environment,
    perfNow: number,
    getNow: () => Date,
): ObsValueSet {
    const defs = buildValueDefs();
    const make = (d: ObsValueDef) => createObsValue(d, env, perfNow, getNow);

    // Create a helper to find a def by name and create it
    const findAndMake = (defs: ObsValueDef[], name: string): ObsValue => {
        const def = defs.find(d => d.name === name);
        if (!def) throw new Error(`[ObsValues] Missing def: ${name}`);
        return make(def);
    };

    // Build ring arrays
    const makeRing = (key: string): ObsValue[] => {
        const ringDefs = defs.rings.get(key);
        if (!ringDefs) throw new Error(`[ObsValues] Missing ring defs: ${key}`);
        return ringDefs.map(make);
    };

    return {
        // Clock hands
        h24:    findAndMake(defs.clock, 'h24'),
        h12:    findAndMake(defs.clock, 'h12'),
        minute: findAndMake(defs.clock, 'minute'),
        second: findAndMake(defs.clock, 'second'),

        // Sun events
        sunrise:         findAndMake(defs.sunEvents, 'sunrise'),
        sunset:          findAndMake(defs.sunEvents, 'sunset'),
        goldenMorning:   findAndMake(defs.sunEvents, 'goldenMorning'),
        goldenEvening:   findAndMake(defs.sunEvents, 'goldenEvening'),
        civilTwiMorning: findAndMake(defs.sunEvents, 'civilTwiMorning'),
        civilTwiEvening: findAndMake(defs.sunEvents, 'civilTwiEvening'),
        nautTwiMorning:  findAndMake(defs.sunEvents, 'nautTwiMorning'),
        nautTwiEvening:  findAndMake(defs.sunEvents, 'nautTwiEvening'),
        astroTwiMorning: findAndMake(defs.sunEvents, 'astroTwiMorning'),
        astroTwiEvening: findAndMake(defs.sunEvents, 'astroTwiEvening'),
        solarNoon:       findAndMake(defs.sunEvents, 'solarNoon'),
        solarMidnight:   findAndMake(defs.sunEvents, 'solarMidnight'),

        // UTC subdial
        utcHour:   findAndMake(defs.utc, 'utcHour'),
        utcMinute: findAndMake(defs.utc, 'utcMinute'),
        utcSecond: findAndMake(defs.utc, 'utcSecond'),

        // Solar subdial
        solarHour:   findAndMake(defs.solar, 'solarHour'),
        solarMinute: findAndMake(defs.solar, 'solarMinute'),
        solarSecond: findAndMake(defs.solar, 'solarSecond'),

        // Sidereal subdial
        sidHour:   findAndMake(defs.sidereal, 'sidHour'),
        sidMinute: findAndMake(defs.sidereal, 'sidMinute'),
        sidSecond: findAndMake(defs.sidereal, 'sidSecond'),

        // Planet hands
        saturnHand:  findAndMake(defs.planets, 'saturnHand'),
        jupiterHand: findAndMake(defs.planets, 'jupiterHand'),
        marsHand:    findAndMake(defs.planets, 'marsHand'),
        earthHand:   findAndMake(defs.planets, 'earthHand'),
        venusHand:   findAndMake(defs.planets, 'venusHand'),
        mercuryHand: findAndMake(defs.planets, 'mercuryHand'),
        moonOffset:  findAndMake(defs.planets, 'moonOffset'),

        // Planet rings
        saturnRing:  makeRing('saturn'),
        jupiterRing: makeRing('jupiter'),
        marsRing:    makeRing('mars'),
        venusRing:   makeRing('venus'),
        mercuryRing: makeRing('mercury'),
        moonRing:    makeRing('moon'),

        // Sun ring gradient stops
        sunRing: defs.sunRing.map(make),

        // Earth view
        earthSslat: findAndMake(earthDefs, 'earthSslat'),
        earthSslng: findAndMake(earthDefs, 'earthSslng'),
    };
}

// ============================================================================
// Per-frame passes
// ============================================================================

/** Flat list of all values for iteration. Cached after first call. */
let allValuesCache: ObsValue[] | null = null;

/** Collect all values from the set into a flat array for iteration. */
export function getAllValues(vs: ObsValueSet): ObsValue[] {
    if (allValuesCache) return allValuesCache;

    const all: ObsValue[] = [
        vs.h24, vs.h12, vs.minute, vs.second,
        vs.sunrise, vs.sunset,
        vs.goldenMorning, vs.goldenEvening,
        vs.civilTwiMorning, vs.civilTwiEvening,
        vs.nautTwiMorning, vs.nautTwiEvening,
        vs.astroTwiMorning, vs.astroTwiEvening,
        vs.solarNoon, vs.solarMidnight,
        vs.utcHour, vs.utcMinute, vs.utcSecond,
        vs.solarHour, vs.solarMinute, vs.solarSecond,
        vs.sidHour, vs.sidMinute, vs.sidSecond,
        vs.saturnHand, vs.jupiterHand, vs.marsHand,
        vs.earthHand, vs.venusHand, vs.mercuryHand, vs.moonOffset,
        ...vs.saturnRing, ...vs.jupiterRing, ...vs.marsRing,
        ...vs.venusRing, ...vs.mercuryRing, ...vs.moonRing,
        ...vs.sunRing,
        vs.earthSslat, vs.earthSslng,
    ];

    allValuesCache = all;
    return all;
}

// ============================================================================
// Per-frame passes — thin ObsValueSet wrappers over the shared updater
// ============================================================================

/**
 * Pass 1: UPDATE — re-evaluate expressions whose timer has expired.
 * Delegates to the shared updater over the flat value list.
 *
 * @param tickIntervalMs      null = 1×/−1× mode, >0 = scrub tick rate (ms)
 * @param displayDeltaPerTickSec  Display seconds advanced per tick (for scrub compression)
 * @param timeDirection       1 = forward, -1 = reverse, 0 = stopped
 */
export function updateObsValues(
    vs: ObsValueSet,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    tickIntervalMs: number | null = null,
    displayDeltaPerTickSec: number = 0,
    timeDirection: 0 | 1 | -1 = 1,
    withDisplayTime?: WithDisplayTime,
): void {
    coreUpdateObsValues(getAllValues(vs), env, perfNow, getNow,
        tickIntervalMs, displayDeltaPerTickSec, timeDirection, withDisplayTime);
}

/**
 * Pass 2: ANIMATE — interpolate all AnimatingValues toward their targets
 * (incl. Phase 2 sweep handoff). Delegates to the shared updater.
 */
export function animateObsValues(vs: ObsValueSet, perfNow: number): void {
    coreAnimateObsValues(getAllValues(vs), perfNow);
}

/**
 * Reset all value schedules so they re-evaluate on the very next frame.
 * Call when the environment changes (location, noonOnTop toggle, etc.).
 */
export function resetObsValueSchedules(vs: ObsValueSet): void {
    coreResetObsValueSchedules(getAllValues(vs));
}

/**
 * Returns true if any value is still animating (mid-interpolation) or has a
 * pending Phase-2 sweep. The render loop uses this to decide whether to keep
 * rendering while the clock is stopped.
 */
export function anyObsAnimating(vs: ObsValueSet): boolean {
    return coreAnyObsAnimating(getAllValues(vs));
}

/**
 * Invalidate the cached flat value list (call after re-creating ObsValueSet).
 */
export function invalidateObsValueCache(): void {
    allValuesCache = null;
}
