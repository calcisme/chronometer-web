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
 *      Three branches: scrub compression, two-phase natural-speed sweep,
 *      or simple snap-to-target.
 *   3. **Animate pass** — interpolate every AnimatingValue toward its target.
 *      For natural-speed values, also handles Phase 2 sweep handoff.
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

// Base angular animation speed (must match kECGLAngleAnimationSpeed in animation.ts).
// Used to convert ObsValue animSpeed (rad/s) to the multiplier that
// startAnimationRaw expects.
const K_ANGLE_ANIM_SPEED = 2.0;

// Error threshold (radians) below which a natural-speed value is considered
// "on track" and skips the catch-up phase.
const NATURAL_ERROR_THRESHOLD = 0.002;

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

    /** Catch-up animation speed in rad/s.
     *  Used for snap-to-target (naturalSpeed=0) and Phase 1 catch-up
     *  (naturalSpeed>0).  Default 2.0 rad/s. */
    animSpeed: number;

    /** Steady-state sweep speed in rad/s.
     *  0 = snap-to-target mode (most values).
     *  >0 = constant-velocity sweep (e.g., second hands = 2π/60 rad/s).
     *  When >0, the update pass uses a two-phase algorithm:
     *    Phase 1: catch up at animSpeed to the moving target
     *    Phase 2: sweep at naturalSpeed until next update */
    naturalSpeed: number;

    /** Current computed value. NaN = "don't display this element". */
    currentValue: number;

    /** Animation state — always present, all values animate. */
    anim: AnimatingValue;

    /** Display-time ms-since-epoch of the next scheduled update. */
    nextUpdateDisplayTime: number;

    /** performance.now() at which the next update should fire. */
    nextUpdateTime: number;

    /** Pending Phase 2 sweep animation (only for naturalSpeed > 0).
     *  Set during update pass; consumed during animate pass when Phase 1 ends. */
    pendingSweep: { target: number; durationMs: number } | null;
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
}

// ============================================================================
// Expression definitions
// ============================================================================

interface ObsValueDef {
    name: string;
    expr: string;
    updateInterval: number;  // seconds
    animSpeed?: number;      // catch-up speed in rad/s; default 2.0
    naturalSpeed?: number;   // sweep speed in rad/s; default 0 (snap-to-target)
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
        { name: 'solarNoon',        expr: 'solarNoonAngle() + pi * noonOnTop',     updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
        { name: 'solarMidnight',    expr: 'solarNoonAngle() + pi + pi * noonOnTop', updateInterval: EC_UPDATE_NEXT_SUNRISE_OR_SUNSET },
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
    const animSpeed = def.animSpeed ?? 2.0;      // rad/s
    const naturalSpeed = def.naturalSpeed ?? 0;   // rad/s

    return {
        name: def.name,
        expr,
        updateInterval: def.updateInterval,
        animSpeed,
        naturalSpeed,
        currentValue: initialValue,
        anim: makeAnimatingValue(initialValue, perfNow),
        // Schedule immediate update on first frame so animation starts right away.
        // updateObsValues will evaluate the expression, start the animation,
        // and compute the real next boundary.
        nextUpdateDisplayTime: 0,
        nextUpdateTime: 0,
        pendingSweep: null,
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

// ============================================================================
// Update helpers
// ============================================================================

/**
 * Update a natural-speed value (e.g., second hand) in 1×/−1× mode.
 *
 * Two-phase animation:
 *   Phase 1 (catch-up): Animate at animSpeed from current position to where
 *     the hand should be when catch-up finishes (the correct position advances
 *     at naturalSpeed during catch-up).
 *   Phase 2 (sweep): Sweep at naturalSpeed until the next update boundary.
 *
 * Phase 2 params are stored in v.pendingSweep and picked up by animateObsValues
 * when Phase 1 completes.
 */
function updateNaturalSpeedValue(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
): void {
    const currentCorrectAngle = evalAttr(v.expr, env);

    // Schedule next update
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, timeDirection, env);
    v.nextUpdateDisplayTime = nextDisplayMs;
    v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);

    // Real time until next update
    const dtToNextUpdateMs = v.nextUpdateTime - perfNow;
    const dtToNextUpdateSec = dtToNextUpdateMs / 1000;
    if (dtToNextUpdateSec <= 0 || !isFinite(dtToNextUpdateSec)) {
        // Edge case: next update is now or in the past — snap
        startAnimationRaw(v.anim, currentCorrectAngle, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED);
        v.pendingSweep = null;
        return;
    }

    // Effective natural speed (clockwise forward, counter-clockwise reverse)
    const effNaturalSpeed = v.naturalSpeed * timeDirection;

    // Compute error: how far is the hand from where it should be?
    const TWO_PI = 2 * Math.PI;
    let error: number;
    if (timeDirection === 1) {
        // Normalize clockwise [0, 2π)
        error = currentCorrectAngle - v.anim.currentValue;
        error = ((error % TWO_PI) + TWO_PI) % TWO_PI;
    } else {
        // Normalize counter-clockwise
        error = v.anim.currentValue - currentCorrectAngle;
        error = ((error % TWO_PI) + TWO_PI) % TWO_PI;
    }

    if (error < NATURAL_ERROR_THRESHOLD) {
        // On track — Phase 2 only (sweep at naturalSpeed)
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.naturalSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs);
        v.pendingSweep = null;
        return;
    }

    // Phase 1: Catch-up at animSpeed.
    // The hand closes the gap at (animSpeed - naturalSpeed) rad/s.
    // catchUpTime = error / (animSpeed - naturalSpeed)
    const differentialSpeed = v.animSpeed - v.naturalSpeed;
    if (differentialSpeed <= 0) {
        // animSpeed not fast enough to close gap — compress everything
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs);
        v.pendingSweep = null;
        return;
    }

    const catchUpSec = error / differentialSpeed;
    const catchUpMs = catchUpSec * 1000;

    if (catchUpMs >= dtToNextUpdateMs) {
        // Can't finish catch-up before next update — compress both phases
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs);
        v.pendingSweep = null;
        return;
    }

    // Phase 1 target: where the correct position will be when catch-up ends
    const catchUpTarget = currentCorrectAngle + effNaturalSpeed * catchUpSec;
    startAnimationRaw(v.anim, catchUpTarget, perfNow,
        v.animSpeed / K_ANGLE_ANIM_SPEED, catchUpMs);

    // Store Phase 2 for the animate pass to pick up
    const remainingMs = dtToNextUpdateMs - catchUpMs;
    const sweepAngle = effNaturalSpeed * (remainingMs / 1000);
    v.pendingSweep = {
        target: catchUpTarget + sweepAngle,
        durationMs: remainingMs,
    };
}

/**
 * Update a value during scrub (quantized mode).
 *
 * Compression logic modeled after the watch-face tickAnimations:
 * compute how many ticks until the next update boundary, use that
 * as the real-time budget, and compress if the natural animation
 * duration exceeds it.
 */
function updateObsValueScrub(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
    tickIntervalMs: number,
    displayDeltaPerTickSec: number,
): void {
    const newTarget = evalAttr(v.expr, env);

    // Compute next boundary in display time
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, timeDirection, env);
    v.nextUpdateDisplayTime = nextDisplayMs;

    // Compute real-time budget (same formula as tickAnimations)
    const displayNowMs = getNow().getTime();
    const displayDeltaMs = Math.abs(nextDisplayMs - displayNowMs);
    const displayDeltaPerTickMs = displayDeltaPerTickSec * 1000;
    const ticksUntilUpdate = displayDeltaPerTickMs > 0
        ? Math.max(1, Math.ceil(displayDeltaMs / displayDeltaPerTickMs))
        : 1;
    const timeUntilNextUpdateMs = ticksUntilUpdate * tickIntervalMs;

    // Schedule next re-evaluation
    v.nextUpdateTime = perfNow + timeUntilNextUpdateMs;

    // Compute natural animation duration
    const speed = v.animSpeed;  // rad/s
    const TWO_PI = 2 * Math.PI;
    const normalizedTarget = ((newTarget % TWO_PI) + TWO_PI) % TWO_PI;
    const normalizedCurrent = ((v.anim.currentValue % TWO_PI) + TWO_PI) % TWO_PI;
    let angleDelta = Math.abs(normalizedTarget - normalizedCurrent);
    if (angleDelta > Math.PI) angleDelta = TWO_PI - angleDelta;
    const naturalDurationMs = speed > 0 ? (angleDelta / speed) * 1000 : 0;

    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;

    // Compress if needed, stretch if too fast, otherwise use natural speed.
    // With schedule skipping functional (rebuildEnv no longer resets
    // schedules every tick), timeUntilNextUpdateMs is meaningful:
    // sentinel values genuinely skip ticks until their event boundary.
    if (naturalDurationMs > timeUntilNextUpdateMs) {
        // Too slow — compress to finish before next re-evaluation
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            timeUntilNextUpdateMs);
    } else if (naturalDurationMs < tickIntervalMs) {
        // Too fast — stretch to fill one tick (prevents sub-frame snaps)
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            tickIntervalMs);
    } else {
        // Natural speed falls between one tick and next update — use as-is
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier);
    }

    // No pending sweep during scrub — just snap-to-target with compression
    v.pendingSweep = null;
}

// ============================================================================
// Per-frame passes
// ============================================================================

/**
 * Pass 1: UPDATE — re-evaluate expressions whose timer has expired.
 *
 * Three branches:
 *   1. Scrub mode (tickIntervalMs != null): compress animations to fit tick budget
 *   2. Natural-speed 1× (naturalSpeed > 0): two-phase catch-up + sweep
 *   3. Normal 1× (naturalSpeed === 0): snap-to-target at animSpeed
 *
 * @param tickIntervalMs      null = 1×/−1× mode, >0 = scrub tick rate (ms)
 * @param displayDeltaPerTickSec  Display seconds advanced per tick (for scrub compression)
 * @param timeDirection       1 = forward, -1 = reverse
 */
export function updateObsValues(
    vs: ObsValueSet,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    tickIntervalMs: number | null = null,
    displayDeltaPerTickSec: number = 0,
    timeDirection: 0 | 1 | -1 = 1,
): void {
    const all = getAllValues(vs);
    for (const v of all) {
        if (perfNow >= v.nextUpdateTime) {
            if (tickIntervalMs !== null && tickIntervalMs > 0) {
                // Scrub mode: compress as needed
                // (timeDirection is always 1 or -1 in scrub mode)
                updateObsValueScrub(v, env, perfNow, getNow,
                    (timeDirection || 1) as 1 | -1,
                    tickIntervalMs, displayDeltaPerTickSec);
            } else if (v.naturalSpeed > 0 && timeDirection !== 0) {
                // 1×/−1× mode, natural speed: two-phase animation
                updateNaturalSpeedValue(v, env, perfNow, getNow, timeDirection);
            } else {
                // Snap-to-target at animSpeed.
                // This branch handles:
                //   - Normal values (naturalSpeed === 0)
                //   - Natural-speed values when time is stopped
                //     (timeDirection === 0, no forward projection)
                const newTarget = evalAttr(v.expr, env);
                if (timeDirection === 0) {
                    // Stopped: snap and re-check shortly (time may resume)
                    v.nextUpdateTime = perfNow + 100;
                    v.pendingSweep = null;
                    startAnimationRaw(v.anim, newTarget, perfNow,
                        v.animSpeed / K_ANGLE_ANIM_SPEED);
                } else {
                    const nextDisplayMs = computeNextBoundary(
                        v.updateInterval * 1000, getNow, timeDirection, env);
                    v.nextUpdateDisplayTime = nextDisplayMs;
                    v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);
                    v.pendingSweep = null;
                    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;
                    startAnimationRaw(v.anim, newTarget, perfNow, multiplier);
                }
            }
        }
    }
}

/**
 * Pass 2: ANIMATE — interpolate all AnimatingValues toward their targets.
 *
 * For natural-speed values, also handles Phase 2 handoff: when Phase 1
 * (catch-up) completes and a pendingSweep is waiting, starts the sweep
 * animation.
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

        // Phase 2 handoff: if Phase 1 just finished and sweep is pending
        if (!v.anim.animating && v.pendingSweep) {
            const sweep = v.pendingSweep;
            v.pendingSweep = null;
            const sweepMultiplier = v.naturalSpeed / K_ANGLE_ANIM_SPEED;
            startAnimationRaw(v.anim, sweep.target, perfNow,
                sweepMultiplier, sweep.durationMs);
            // Re-interpolate to pick up the new animation immediately
            v.currentValue = interpolateValue(v.anim, perfNow);
        }
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
