/**
 * Observatory expression-driven value system.
 *
 * Each dynamic element on the Observatory dial has one or more ObsValue
 * objects.  Each ObsValue holds a parsed AST expression, an update interval,
 * and an AnimatingValue for smooth interpolation.
 *
 * Architecture:
 *   1. **Init** — parse expression strings into ASTs, evaluate initial values.
 *   2. **Update pass** — re-evaluate any ObsValue whose timer has expired.
 *   3. **Animate pass** — interpolate every AnimatingValue toward its target.
 *   4. **Draw pass** — renderers read `obsValue.currentValue` instead of
 *      computing inline.
 *
 * Modeled after the watch-face HandState/AnimatingValue system in animation.ts.
 */

import type { ASTNode } from '../expr/parser.js';
import { parse } from '../expr/parser.js';
import type { Environment } from '../expr/evaluator.js';
import { evalAttr } from '../shared/astro-env.js';
import {
    type AnimatingValue,
    makeAnimatingValue,
    startAnimationRaw,
    interpolateValue,
    computeNextBoundary,
    displayTimeToPerfNow,
    EC_UPDATE_NEXT_SUNRISE,
    EC_UPDATE_NEXT_SUNSET,
    EC_UPDATE_NEXT_SUNRISE_OR_SUNSET,
    EC_UPDATE_NEXT_PLANET_RISE,
    EC_UPDATE_NEXT_PLANET_SET,
} from '../shared/animation.js';
import { SunAltitudeKind } from '../shared/astro-env.js';

// ============================================================================
// Types
// ============================================================================

/** A single dynamic value in the Observatory. */
export interface ObsValue {
    /** Human-readable name for debugging. */
    name: string;

    /** Parsed AST for computing this value's current target. */
    expr: ASTNode;

    /** Update interval in seconds.
     *  Positive: epoch-aligned boundary (e.g., 3600 = hourly, 1 = per second).
     *  Negative: sentinel (e.g., EC_UPDATE_NEXT_SUNRISE).
     *  Never 0 — minimum is 1. */
    updateInterval: number;

    /** Animation speed multiplier.
     *  Multiplied by kECGLAngleAnimationSpeed (2.0 rad/s) to get actual speed.
     *  Default 1.0 = 2 rad/s (good for large jumps like noonOnTop toggle).
     *  Second hands use π/60 so speed = 2π/60 rad/s = exact sweep rate. */
    animSpeed: number;

    /** When true, the animation target is projected forward to where the
     *  value will be at the next update time.  Use for constant-velocity
     *  values (like second hands) that animate between infrequent updates. */
    projectTarget: boolean;

    /** Current computed value. NaN = "don't display this element". */
    currentValue: number;

    /** Animation state — always present, all values animate. */
    anim: AnimatingValue;

    /** Display-time ms-since-epoch of the next scheduled update. */
    nextUpdateDisplayTime: number;

    /** performance.now() at which the next update should fire. */
    nextUpdateTime: number;
}

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

    // -- Planet rings (3 values each: rise angle, set angle, transit angle) --
    // NaN rise/set = planet doesn't rise/set (always above or below horizon)
    saturnRing: ObsValue[];
    jupiterRing: ObsValue[];
    marsRing: ObsValue[];
    venusRing: ObsValue[];
    mercuryRing: ObsValue[];
    moonRing: ObsValue[];

    // -- Sun ring gradient stops (angular positions with fixed colors) --
    // NaN = sun doesn't reach this altitude (polar regions)
    sunRing: ObsValue[];
}

// ============================================================================
// Expression definitions
// ============================================================================

interface ObsValueDef {
    name: string;
    expr: string;
    updateInterval: number;  // seconds
    animSpeed?: number;      // multiplier; default 1.0
    projectTarget?: boolean; // project animation target to next update time
}

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

    // Second hands use animSpeed = π/60 so that kECGLAngleAnimationSpeed (2) * π/60 = 2π/60 rad/s,
    // which is exactly the angular velocity of a second hand.
    const SECOND_ANIM_SPEED = Math.PI / 60;

    const clock: ObsValueDef[] = [
        { name: 'h24',    expr: 'hour24ValueAngle() + pi * noonOnTop', updateInterval: 15 },
        { name: 'h12',    expr: 'hour12ValueAngle()',                  updateInterval: 1 },
        { name: 'minute', expr: 'minuteValueAngle()',                  updateInterval: 1 },
        { name: 'second', expr: 'secondValueAngle()',                  updateInterval: 20, animSpeed: SECOND_ANIM_SPEED, projectTarget: true },
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
        { name: 'solarNoon',        expr: 'solarNoonAngle() + pi * noonOnTop',     updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
        { name: 'solarMidnight',    expr: 'solarNoonAngle() + pi + pi * noonOnTop', updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
    ];

    const utc: ObsValueDef[] = [
        // UTC subdial is 24h
        { name: 'utcHour',   expr: 'fmod((hour24Value() - tzOffset() / 3600), 24) * 2 * pi / 24', updateInterval: 60 },
        { name: 'utcMinute', expr: 'utcMinuteAngle()', updateInterval: 15 },
        { name: 'utcSecond', expr: 'utcSecondAngle()', updateInterval: 20, animSpeed: SECOND_ANIM_SPEED, projectTarget: true },
    ];

    const solar: ObsValueDef[] = [
        // Solar subdial is 12h
        { name: 'solarHour',   expr: 'fmod(solarTimeSec() / 3600, 12) * 2 * pi / 12', updateInterval: 60 },
        { name: 'solarMinute', expr: 'fmod(solarTimeSec() / 60, 60) * 2 * pi / 60',   updateInterval: 15 },
        { name: 'solarSecond', expr: 'fmod(solarTimeSec(), 60) * 2 * pi / 60',         updateInterval: 20, animSpeed: SECOND_ANIM_SPEED, projectTarget: true },
    ];

    const sidereal: ObsValueDef[] = [
        // Sidereal subdial is 24h
        { name: 'sidHour',   expr: 'fmod(lstValue() / 3600, 24) * 2 * pi / 24', updateInterval: 60 },
        { name: 'sidMinute', expr: 'fmod(lstValue() / 60, 60) * 2 * pi / 60',   updateInterval: 15 },
        { name: 'sidSecond', expr: 'fmod(lstValue(), 60) * 2 * pi / 60',         updateInterval: 20, animSpeed: SECOND_ANIM_SPEED, projectTarget: true },
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

    // Planet rings: 5 values each (rise, set, transit, riseValid, setValid)
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
        rings.set(key, [
            { name: `${key}Rise`,    expr: `dayNightLeafAngle(${pn}, 0, 0) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
            { name: `${key}Set`,     expr: `dayNightLeafAngle(${pn}, 1, 0) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_PLANET_RISE(pn) },
            { name: `${key}Transit`, expr: `planetTransitAngle(${pn}) + pi * noonOnTop`,      updateInterval: EC_UPDATE_NEXT_PLANET_SET(pn) },
        ]);
    }

    // Sun ring gradient stops — angular positions for fixed-color stops.
    // Each stop represents where the sun crosses a specific altitude threshold.
    // Morning stops update at sunset; evening stops at sunrise (same as hands).
    // Noon/midnight anchors update at either event.
    const sunRing: ObsValueDef[] = [
        // Morning side (night → day): update at next sunset
        { name: 'ring18BelowMorn',   expr: `sunSpecialAngle(${SK.SunRing18BelowMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring9BelowMorn',    expr: `sunSpecialAngle(${SK.SunRing9BelowMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring1BelowMorn',    expr: `sunSpecialAngle(${SK.SunRing1BelowMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ringHalfBelowMorn', expr: `sunSpecialAngle(${SK.SunRingHalfBelowMorning}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring1AboveMorn',    expr: `sunSpecialAngle(${SK.SunRing1AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring9AboveMorn',    expr: `sunSpecialAngle(${SK.SunRing9AboveMorning}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNSET },
        { name: 'ring30AboveMorn',   expr: `sunSpecialAngle(${SK.SunRing30AboveMorning}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNSET },
        // Evening side (day → night): update at next sunrise
        { name: 'ring30AboveEve',    expr: `sunSpecialAngle(${SK.SunRing30AboveEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring9AboveEve',     expr: `sunSpecialAngle(${SK.SunRing9AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring1AboveEve',     expr: `sunSpecialAngle(${SK.SunRing1AboveEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ringHalfBelowEve',  expr: `sunSpecialAngle(${SK.SunRingHalfBelowEvening}) + pi * noonOnTop`, updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring1BelowEve',     expr: `sunSpecialAngle(${SK.SunRing1BelowEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring9BelowEve',     expr: `sunSpecialAngle(${SK.SunRing9BelowEvening}) + pi * noonOnTop`,    updateInterval: EC_UPDATE_NEXT_SUNRISE },
        { name: 'ring18BelowEve',    expr: `sunSpecialAngle(${SK.SunRing18BelowEvening}) + pi * noonOnTop`,   updateInterval: EC_UPDATE_NEXT_SUNRISE },
        // Anchor points: solar noon and midnight (positions always valid, colors computed at render time)
        { name: 'ringNoon',     expr: 'solarNoonAngle() + pi * noonOnTop',      updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
        { name: 'ringMidnight', expr: 'solarNoonAngle() + pi + pi * noonOnTop',  updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
    ];

    return { clock, sunEvents, utc, solar, sidereal, planets, rings, sunRing };
}

// ============================================================================
// Initialization
// ============================================================================

/** Create a single ObsValue from a definition. */
function createObsValue(
    def: ObsValueDef,
    env: Environment,
    perfNow: number,
    _getNow: () => Date,
): ObsValue {
    const expr = parse(def.expr);
    const initialValue = evalAttr(expr, env);
    const animSpeed = def.animSpeed ?? 1.0;

    return {
        name: def.name,
        expr,
        updateInterval: def.updateInterval,
        animSpeed,
        projectTarget: def.projectTarget ?? false,
        currentValue: initialValue,
        anim: makeAnimatingValue(initialValue, perfNow),
        // Schedule immediate update on first frame so animation starts right away.
        // updateObsValues will evaluate the expression, start the animation,
        // and compute the real next boundary.
        nextUpdateDisplayTime: 0,
        nextUpdateTime: 0,
    };
}

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
    ];

    allValuesCache = all;
    return all;
}

/**
 * Pass 1: UPDATE — re-evaluate expressions whose timer has expired.
 *
 * For each value where `perfNow >= nextUpdateTime`, evaluate the AST
 * and set the new animation target.
 */
export function updateObsValues(
    vs: ObsValueSet,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
): void {
    const all = getAllValues(vs);
    for (const v of all) {
        if (perfNow >= v.nextUpdateTime) {
            let newTarget = evalAttr(v.expr, env);

            // Schedule next update
            const updateIntervalMs = v.updateInterval * 1000;
            const nextDisplayMs = computeNextBoundary(updateIntervalMs, getNow, 1, env);
            v.nextUpdateDisplayTime = nextDisplayMs;
            v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);

            // For constant-velocity values (custom animSpeed, e.g. second hands):
            // The expression gives the angle at time T, but we need the animation
            // target at T+interval so the hand arrives at the right place when
            // the next update fires.  Project forward by dt × angularRate.
            // (kECGLAngleAnimationSpeed = 2.0 rad/s)
            if (v.projectTarget && isFinite(v.nextUpdateTime)) {
                const dtSeconds = (v.nextUpdateTime - perfNow) / 1000;
                const angularRate = v.animSpeed * 2.0;
                newTarget += dtSeconds * angularRate;
            }

            startAnimationRaw(v.anim, newTarget, perfNow, v.animSpeed);
        }
    }
}

/**
 * Pass 2: ANIMATE — interpolate all AnimatingValues toward their targets.
 *
 * Writes the interpolated result to `currentValue`.
 */
export function animateObsValues(
    vs: ObsValueSet,
    perfNow: number,
): void {
    const all = getAllValues(vs);
    for (const v of all) {
        v.currentValue = interpolateValue(v.anim, perfNow);
    }
}

/**
 * Reset all value schedules so they re-evaluate on the very next frame.
 * Call when the environment changes (location, noonOnTop toggle, etc.).
 */
export function resetObsValueSchedules(vs: ObsValueSet): void {
    const all = getAllValues(vs);
    for (const v of all) {
        v.nextUpdateDisplayTime = 0;
        v.nextUpdateTime = 0;
    }
}

/**
 * Invalidate the cached flat value list (call after re-creating ObsValueSet).
 */
export function invalidateObsValueCache(): void {
    allValuesCache = null;
}
