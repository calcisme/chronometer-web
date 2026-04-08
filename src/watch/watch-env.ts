/**
 * Watch expression environment setup.
 *
 * Creates an Environment populated with all init-block variables
 * and time/astronomy functions for a parsed Watch model.
 */

import {
    createDefaultEnvironment,
    evaluate,
    Environment,
} from '../expr/evaluator.js';
import type { ASTNode } from '../expr/parser.js';
import type { Watch } from './types.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import {
    EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT,
    EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT,
    EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT,
    EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT,
    EC_UPDATE_ENV_CHANGE_ONLY,
} from './animation.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';
import {
    sunAltitude, sunAzimuth, moonAltitude, moonAzimuth, moonAge,
    moonRelativePositionAngle, moonRelativeAngle as computeMoonRelativeAngle,
    moonElongation as computeMoonElongation,
    closestPhaseDayNumber, planetEclipticLongitude, planetEclipticLatitude,
    planetGeocentricDistance, lunarAscendingNodeLongitude as computeLunarAscendingNode,
    EOTSeconds,
} from '../astronomy/es-astro.js';
import { planetaryRiseSetTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet, kECAlwaysAboveHorizon, kECAlwaysBelowHorizon, fmod } from '../astronomy/astro-constants.js';
import { terminatorAngle } from './terminator.js';
import { GSTDifferenceForDate } from '../astronomy/es-sidereal.js';
import { generalPrecessionSinceJ2000 } from '../astronomy/es-coordinates.js';
import { julianCenturiesSince2000EpochForDateInterval } from '../astronomy/es-time.js';

// Default observer location (San Jose, CA): used if geolocation unavailable
const DEFAULT_LAT_DEG = 37.205;    // degrees N
const DEFAULT_LON_DEG = -121.954;  // degrees (west is negative)

/**
 * Build the expression environment for a watch:
 *  1. Math builtins + color constants
 *  2. Evaluate all init blocks (populates watch variables)
 *  3. Register time/astronomy functions using real current time
 *
 * @param observerLatDeg - Observer latitude in degrees (positive = north). Defaults to San Jose, CA.
 * @param observerLonDeg - Observer longitude in degrees (negative = west). Defaults to San Jose, CA.
 */
export function createWatchEnvironment(
    watch: Watch,
    observerLatDeg: number = DEFAULT_LAT_DEG,
    observerLonDeg: number = DEFAULT_LON_DEG,
): Environment {
    const OBSERVER_LAT = observerLatDeg * Math.PI / 180;
    const OBSERVER_LON = observerLonDeg * Math.PI / 180;
    const env = createDefaultEnvironment();

    // Named update interval sentinels — negative values matching iOS ECConstants.h.
    // The animation system detects these and schedules at the appropriate event time.
    env.variables.set('updateAtNextSunriseOrMidnight', EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT);
    env.variables.set('updateAtNextSunsetOrMidnight', EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT);
    env.variables.set('updateAtNextMoonriseOrMidnight', EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT);
    env.variables.set('updateAtNextMoonsetOrMidnight', EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT);
    env.variables.set('updateAtEnvChangeOnly', EC_UPDATE_ENV_CHANGE_ONLY);

    // Aliases used by Mauna Kea (shorter names without "OrMidnight")
    env.variables.set('updateAtNextSunrise', EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT);
    env.variables.set('updateAtNextSunset', EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT);
    env.variables.set('updateAtNextSunriseOrSunset', EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT);
    env.variables.set('updateForTimeSyncIndicator', EC_UPDATE_ENV_CHANGE_ONLY);
    env.variables.set('updateForLocSyncIndicator', EC_UPDATE_ENV_CHANGE_ONLY);

    // Planet constants used in XML expressions
    env.variables.set('planetSun', ECPlanetNumber.Sun);
    env.variables.set('planetMoon', ECPlanetNumber.Moon);

    // Register real time functions
    registerTimeFunctions(env, OBSERVER_LAT, OBSERVER_LON);

    // Evaluate all init blocks in document order
    for (const expr of watch.initExprs) {
        evaluate(expr, env);
    }

    return env;
}

/**
 * Evaluate a single attribute expression in the given env.
 * Returns 0 for undefined expressions.
 */
export function evalAttr(expr: ASTNode | undefined, env: Environment): number {
    if (!expr) return 0;
    return evaluate(expr, env);
}

/**
 * Evaluate a color expression and return a CSS color string.
 * The XML uses 0xAARRGGBB format (matching iOS UIColor).
 */
export function evalColor(expr: ASTNode | undefined, env: Environment): string {
    if (!expr) return 'rgba(0,0,0,0)';
    const val = evaluate(expr, env);
    return argbToCSS(val);
}

/**
 * Convert an ARGB integer (0xAARRGGBB) to a CSS rgba() string.
 */
function argbToCSS(argb: number): string {
    const v = argb >>> 0;  // treat as unsigned 32-bit
    const a = ((v >>> 24) & 0xFF) / 255;
    const r = (v >>> 16) & 0xFF;
    const g = (v >>> 8) & 0xFF;
    const b = v & 0xFF;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// ============================================================================
// Real time functions — computed once from Date.now()
// ============================================================================

function registerTimeFunctions(env: Environment, OBSERVER_LAT: number, OBSERVER_LON: number): void {
    const { functions } = env;
    // Time source — returns real time; will be overridden for
    // user time controls (fast-forward, rewind, etc.)
    const getNow = () => new Date();

    // Snapshot time for astronomy/calendar (changes at most daily)
    const now = getNow();
    const dateInterval = dateToDateInterval(now);

    // Local timezone offset in seconds (JS gives minutes, positive for west)
    const tzOffsetMinutes = now.getTimezoneOffset();
    const tzOffsetSeconds = -tzOffsetMinutes * 60; // Convert to seconds, east-positive

    // --- Clock hands (LIVE — recompute from Date.now() on each call) ---
    // These are called every animation frame so the hands move in real time.
    // Helper to extract fractional components from the current time:
    const liveTime = () => {
        const t = getNow();
        const s = t.getSeconds() + t.getMilliseconds() / 1000;
        const m = t.getMinutes() + s / 60;
        const h = (t.getHours() % 12) + m / 60;
        return { h, m, s, h24: t.getHours() };
    };

    functions.set('hour12ValueAngle', () => liveTime().h * 2 * Math.PI / 12);
    functions.set('minuteValueAngle', () => liveTime().m * 2 * Math.PI / 60);
    functions.set('secondValueAngle', () => liveTime().s * 2 * Math.PI / 60);
    functions.set('secondNumberAngle', () => Math.floor(liveTime().s) * 2 * Math.PI / 60);
    functions.set('secondValue', () => liveTime().s);
    functions.set('hour24Number', () => liveTime().h24);

    // --- Calendar (LIVE — recompute from getNow()) ---
    functions.set('dayNumber', () => getNow().getDate() - 1);  // 0-indexed for wheel math
    functions.set('monthNumber', () => getNow().getMonth());
    functions.set('monthNumberAngle', () => getNow().getMonth() * 2 * Math.PI / 12);
    functions.set('weekdayNumberAngle', () => getNow().getDay() * 2 * Math.PI / 7);
    functions.set('yearNumber', () => getNow().getFullYear());
    functions.set('eraNumber', () => 1); // CE = 1 (always CE for modern dates)

    // --- 24-hour time (Mauna Kea) ---
    functions.set('hour24ValueAngle', () => {
        const t = getNow();
        const h24 = t.getHours() + t.getMinutes() / 60 + t.getSeconds() / 3600;
        return h24 * 2 * Math.PI / 24;
    });

    // Time-unit helpers (return value in seconds, matching iOS convention for update intervals)
    functions.set('days', () => 86400);
    functions.set('hours', () => 3600);
    functions.set('minutes', () => 60);
    functions.set('seconds', () => 1);

    // --- Astronomy setup (snapshot for rise/set, which are daily values) ---
    const pool = new AstroCachePool();
    initializeCachePool(pool, dateInterval, OBSERVER_LAT, OBSERVER_LON, false, tzOffsetSeconds);

    // --- Sun position (LIVE — recompute each call) ---
    // Sun altitude and azimuth change continuously throughout the day.
    functions.set('sunAltitude', () => {
        const di = dateToDateInterval(getNow());
        return sunAltitude(di, OBSERVER_LAT, OBSERVER_LON, null);
    });
    functions.set('sunAzimuth', () => {
        const di = dateToDateInterval(getNow());
        return sunAzimuth(di, OBSERVER_LAT, OBSERVER_LON, null);
    });

    // --- Rise/set "for day" helpers ---
    // iOS planetRiseSetForDay: search forward then backward, only accept
    // results on the current calendar day.  Return NaN if no event today.
    function riseSetForDay(
        riseNotSet: boolean,
        planetNumber: ECPlanetNumber,
    ): number {
        const fudgeSeconds = -5;  // match iOS: fudge backward slightly
        const lookahead = 3600 * 13.2;
        const calcDate = dateToDateInterval(getNow());

        // Search forward
        const fwdResult = planetaryRiseSetTimeRefined(
            calcDate + fudgeSeconds, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(fwdResult) && isSameLocalDay(fwdResult, calcDate)) {
            return fwdResult;
        }

        // Forward wasn't today — search backward
        const bwdResult = planetaryRiseSetTimeRefined(
            calcDate - fudgeSeconds - lookahead, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(bwdResult) && isSameLocalDay(bwdResult, calcDate)) {
            return bwdResult;
        }

        return NaN;  // no event on current day
    }

    /** Check if two date intervals fall on the same local calendar day */
    function isSameLocalDay(di1: number, di2: number): boolean {
        const d1 = new Date((di1 + 978307200) * 1000);
        const d2 = new Date((di2 + 978307200) * 1000);
        return d1.getFullYear() === d2.getFullYear()
            && d1.getMonth() === d2.getMonth()
            && d1.getDate() === d2.getDate();
    }

    /** Convert a dateInterval rise/set result into hour12/minute/hour24 values */
    function riseSetAngles(di: number): { hour12: number; minute: number; hour24: number } {
        const d = new Date((di + 978307200) * 1000);
        return {
            hour12: (d.getHours() % 12) + d.getMinutes() / 60 + d.getSeconds() / 3600,
            minute: d.getMinutes() + d.getSeconds() / 60,
            hour24: d.getHours(),
        };
    }

    // --- Sunrise/sunset for today (LIVE — recompute on call) ---
    functions.set('sunriseForDayValid', () => {
        return isNaN(riseSetForDay(true, ECPlanetNumber.Sun)) ? 0 : 1;
    });
    functions.set('sunriseForDayHour12ValueAngle', () => {
        const sr = riseSetForDay(true, ECPlanetNumber.Sun);
        return isNaN(sr) ? 0 : riseSetAngles(sr).hour12 * 2 * Math.PI / 12;
    });
    functions.set('sunriseForDayMinuteValueAngle', () => {
        const sr = riseSetForDay(true, ECPlanetNumber.Sun);
        return isNaN(sr) ? 0 : riseSetAngles(sr).minute * 2 * Math.PI / 60;
    });

    functions.set('sunsetForDayValid', () => {
        return isNaN(riseSetForDay(false, ECPlanetNumber.Sun)) ? 0 : 1;
    });
    functions.set('sunsetForDayHour12ValueAngle', () => {
        const ss = riseSetForDay(false, ECPlanetNumber.Sun);
        return isNaN(ss) ? 0 : riseSetAngles(ss).hour12 * 2 * Math.PI / 12;
    });
    functions.set('sunsetForDayMinuteValueAngle', () => {
        const ss = riseSetForDay(false, ECPlanetNumber.Sun);
        return isNaN(ss) ? 0 : riseSetAngles(ss).minute * 2 * Math.PI / 60;
    });

    // --- Moon (LIVE — recompute each call) ---
    functions.set('moonAltitude', () => {
        const di = dateToDateInterval(getNow());
        return moonAltitude(di, OBSERVER_LAT, OBSERVER_LON, null);
    });
    functions.set('moonAzimuth', () => {
        const di = dateToDateInterval(getNow());
        return moonAzimuth(di, OBSERVER_LAT, OBSERVER_LON, null);
    });
    functions.set('moonAgeAngle', () => {
        const di = dateToDateInterval(getNow());
        return moonAge(di, null).age;
    });
    functions.set('moonRelativePositionAngle', () => {
        const di = dateToDateInterval(getNow());
        return moonRelativePositionAngle(di, OBSERVER_LAT, OBSERVER_LON, null);
    });
    functions.set('moonRelativeAngle', () => {
        const di = dateToDateInterval(getNow());
        return computeMoonRelativeAngle(di, OBSERVER_LAT, OBSERVER_LON, null);
    });

    // --- Moon elongation (angular separation Sun–Moon) ---
    functions.set('moonElongation', () => {
        const di = dateToDateInterval(getNow());
        return computeMoonElongation(di, OBSERVER_LAT, OBSERVER_LON, null);
    });

    // --- Closest phase quarter day numbers (LIVE — recompute from getNow()) ---
    functions.set('closestNewMoonDayNumber', () => {
        return closestPhaseDayNumber(0, dateToDateInterval(getNow())) - 1;
    });
    functions.set('closestFirstQuarterDayNumber', () => {
        return closestPhaseDayNumber(Math.PI / 2, dateToDateInterval(getNow())) - 1;
    });
    functions.set('closestFullMoonDayNumber', () => {
        return closestPhaseDayNumber(Math.PI, dateToDateInterval(getNow())) - 1;
    });
    functions.set('closestThirdQuarterDayNumber', () => {
        return closestPhaseDayNumber(3 * Math.PI / 2, dateToDateInterval(getNow())) - 1;
    });

    // --- Planetary ecliptic coordinates ---
    // ELongitudeOfPlanet(n): geocentric apparent ecliptic longitude (radians)
    functions.set('ELongitudeOfPlanet', (n: number) => {
        const di = dateToDateInterval(getNow());
        return planetEclipticLongitude(n as ECPlanetNumber, di, null);
    });
    // ELatitudeOfPlanet(n): geocentric apparent ecliptic latitude (radians)
    functions.set('ELatitudeOfPlanet', (n: number) => {
        const di = dateToDateInterval(getNow());
        return planetEclipticLatitude(n as ECPlanetNumber, di, null);
    });
    // distanceFromEarthOfPlanet(n): geocentric distance in AU
    functions.set('distanceFromEarthOfPlanet', (n: number) => {
        const di = dateToDateInterval(getNow());
        return planetGeocentricDistance(n as ECPlanetNumber, di, null);
    });

    // --- Lunar ascending node longitude ---
    functions.set('lunarAscendingNodeLongitude', () => {
        const di = dateToDateInterval(getNow());
        return computeLunarAscendingNode(di, null);
    });

    // --- Moon delta ecliptic longitude at delta day ---
    // Computes moonAge (= moonEclipticLong - sunEclipticLong) at local midnight ± n days.
    // Uses JS Date for DST-correct midnight (better than iOS, which is imprecise across DST).
    functions.set('moonDeltaEclipticLongitudeAtDeltaDay', (n: number) => {
        const nowDate = getNow();
        // Midnight of the target day in local timezone (DST-aware)
        const targetMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + n);
        const requestedDI = dateToDateInterval(targetMidnight);
        return moonAge(requestedDI, null).age;
    });

    // --- Moonrise/moonset for today (LIVE — recompute on call) ---
    functions.set('moonriseForDayValid', () => {
        return isNaN(riseSetForDay(true, ECPlanetNumber.Moon)) ? 0 : 1;
    });
    functions.set('moonriseForDayHour12ValueAngle', () => {
        const mr = riseSetForDay(true, ECPlanetNumber.Moon);
        return isNaN(mr) ? 0 : riseSetAngles(mr).hour12 * 2 * Math.PI / 12;
    });
    functions.set('moonriseForDayMinuteValueAngle', () => {
        const mr = riseSetForDay(true, ECPlanetNumber.Moon);
        return isNaN(mr) ? 0 : riseSetAngles(mr).minute * 2 * Math.PI / 60;
    });
    functions.set('moonriseForDayHour24Number', () => {
        const mr = riseSetForDay(true, ECPlanetNumber.Moon);
        return isNaN(mr) ? 0 : riseSetAngles(mr).hour24;
    });

    functions.set('moonsetForDayValid', () => {
        return isNaN(riseSetForDay(false, ECPlanetNumber.Moon)) ? 0 : 1;
    });
    functions.set('moonsetForDayHour12ValueAngle', () => {
        const ms = riseSetForDay(false, ECPlanetNumber.Moon);
        return isNaN(ms) ? 0 : riseSetAngles(ms).hour12 * 2 * Math.PI / 12;
    });
    functions.set('moonsetForDayMinuteValueAngle', () => {
        const ms = riseSetForDay(false, ECPlanetNumber.Moon);
        return isNaN(ms) ? 0 : riseSetAngles(ms).minute * 2 * Math.PI / 60;
    });
    functions.set('moonsetForDayHour24Number', () => {
        const ms = riseSetForDay(false, ECPlanetNumber.Moon);
        return isNaN(ms) ? 0 : riseSetAngles(ms).hour24;
    });

    // --- Button action stubs (no-ops) ---
    functions.set('manualSet', () => 0);
    functions.set('timeIsCorrect', () => 1);
    functions.set('inReverse', () => 0);
    functions.set('runningDemo', () => 0);
    functions.set('thisButtonPressed', () => 0);
    functions.set('tick', () => 0);
    functions.set('tock', () => 0);
    functions.set('stemIn', () => 0);
    functions.set('stemOut', () => 0);
    functions.set('goForward', () => 0);
    functions.set('goBackward', () => 0);
    functions.set('reset', () => 0);
    functions.set('advanceHour', () => 0);
    functions.set('advanceDay', () => 0);
    functions.set('advanceMonth', () => 0);
    functions.set('advanceSeconds', () => 0);
    functions.set('advanceToSunriseForDay', () => 0);
    functions.set('advanceToSunsetForDay', () => 0);
    functions.set('advanceToMoonriseForDay', () => 0);
    functions.set('advanceToMoonsetForDay', () => 0);
    functions.set('heading', () => 0);

    // Timezone
    functions.set('tzOffset', () => tzOffsetSeconds);
    functions.set('tzOffsetAngle', () => tzOffsetSeconds * Math.PI / (12 * 3600));

    // Observer longitude in radians (used by Mauna Kea angle expressions)
    functions.set('longitude', () => OBSERVER_LON);

    // Calendar wheel helpers
    functions.set('calendarWeekdayStart', () => 0);

    // --- Terminator leaf function (5 args) ---
    functions.set('terminatorAngle', terminatorAngle);

    // --- Equation of Time angle (radians) ---
    // iOS: EOTAngle() returns [astro EOT] which is in radians
    // EOTSeconds converts HA to seconds, we need to convert back to angle
    functions.set('EOTAngle', () => {
        const di = dateToDateInterval(getNow());
        const eotSec = EOTSeconds(di, null);
        return eotSec * Math.PI / (12 * 3600);
    });
    functions.set('EOTSeconds', () => EOTSeconds(dateToDateInterval(getNow()), null));

    // --- Vernal equinox angle (sidereal-UT offset) ---
    // iOS: STDifferenceForDate — the difference between GST and UT
    functions.set('vernalEquinoxAngle', () => {
        const di = dateToDateInterval(getNow());
        return GSTDifferenceForDate(di, null);
    });

    // --- J2000 RA of vernal equinox of date (precession correction) ---
    // iOS: -[astro precession] = -generalPrecessionSinceJ2000(centuriesTDT)
    functions.set('J2000RAofVernalEquinoxOfDateAngle', () => {
        const di = dateToDateInterval(getNow());
        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, null);
        return -generalPrecessionSinceJ2000(julianCenturiesSince2000Epoch);
    });

    // --- Sunrise/sunset 24-hour indicator angles ---
    // iOS: dayNightLeafAngleForPlanetNumber:leafNumber:numLeaves:0
    // with leafNumber=0 (rise) or 1 (set), numLeaves=0 (special case)
    functions.set('sunrise24HourIndicatorAngle', () => {
        return dayNightLeafAngle(true, getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds);
    });
    functions.set('sunset24HourIndicatorAngle', () => {
        return dayNightLeafAngle(false, getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds);
    });

    // --- Polar summer/winter detection ---
    functions.set('polarSummer', () => {
        return isPolarSummer(getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds) ? 1 : 0;
    });
    functions.set('polarWinter', () => {
        return isPolarWinter(getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds) ? 1 : 0;
    });

    // --- Sunrise/sunset indicator validity (special ops for Mauna Kea) ---
    functions.set('sunriseIndicatorValid', () => {
        // iOS: sunIsUp ? prevSunriseValid : nextSunriseValid
        // Simplified: just check if sunrise for today is valid
        return isNaN(riseSetForDay(true, ECPlanetNumber.Sun)) ? 0 : 1;
    });
    functions.set('sunsetIndicatorValid', () => {
        return isNaN(riseSetForDay(false, ECPlanetNumber.Sun)) ? 0 : 1;
    });

    // --- Sun planetIsUp check ---
    functions.set('planetIsUp', (n: number) => {
        const di = dateToDateInterval(getNow());
        const alt = sunAltitude(di, OBSERVER_LAT, OBSERVER_LON, null);
        return alt > 0 ? 1 : 0;
    });

    // --- Time/location indicator stubs ---
    functions.set('timeIndicatorColor', () => 0);  // stub
    functions.set('locationIndicatorColor', () => 0);  // stub
    functions.set('skew', () => 0);  // stub

    // --- Day/night ring leaf angle function (used by QdayNightRing) ---
    functions.set('dayNightLeafAngle', (planetNumber: number, leafNumber: number, numLeaves: number) => {
        return computeDayNightLeafAngle(
            planetNumber, leafNumber, numLeaves,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        );
    });

    // Release the cache pool
    releaseCachePool(pool);
}

// ============================================================================
// Day/night leaf angle — full iOS-faithful implementation
// ============================================================================

/**
 * Compute the 24-hour indicator angle for sunrise or sunset.
 * iOS: dayNightLeafAngleForPlanetNumber:ECPlanetSun leafNumber:0/1 numLeaves:0
 *
 * When numLeaves==0, leafNumber 0 returns rise angle, 1 returns set angle.
 * Falls back to transit angle if rise/set is NaN.
 */
function dayNightLeafAngle(
    riseNotSet: boolean,
    getNow: () => Date,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
    tzOffsetSeconds: number,
): number {
    const calcDate = dateToDateInterval(getNow());
    const fudgeSeconds = -5;
    const lookahead = 3600 * 13.2;

    // Determine if sun is currently up
    const sunIsUp = sunAltitude(calcDate, observerLat, observerLon, null) > 0;

    // Search for rise: if sun is up, search backward; if down, search forward
    // Search for set:  if sun is up, search forward; if down, search backward
    const searchForward = riseNotSet ? !sunIsUp : sunIsUp;

    const eventTime = planetaryRiseSetTimeRefined(
        searchForward ? calcDate + fudgeSeconds : calcDate - fudgeSeconds - lookahead,
        observerLat, observerLon,
        riseNotSet, ECPlanetNumber.Sun, NaN, pool,
    );

    // Also compute the transit angle for fallback
    const transitSearchForward = riseNotSet ? !sunIsUp : sunIsUp;
    // Transit is midpoint of the search — we don't have a direct transit search,
    // so we'll use noon as transit fallback
    const now = getNow();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const noonDI = dateToDateInterval(noon);
    const noonAngle = angle24HourForDate(noonDI, tzOffsetSeconds);

    if (isNoRiseSet(eventTime)) {
        // No rise/set — return transit angle (noon for sun)
        if (eventTime === kECAlwaysAboveHorizon) {
            // Polar summer: transit is at the high point, add PI for low transit
            return fmod(noonAngle + Math.PI, 2 * Math.PI);
        }
        return noonAngle;
    }

    return angle24HourForDate(eventTime, tzOffsetSeconds);
}

/**
 * Check if we're in polar summer (sun never sets).
 */
function isPolarSummer(
    getNow: () => Date,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
    tzOffsetSeconds: number,
): boolean {
    const calcDate = dateToDateInterval(getNow());
    const fudgeSeconds = -5;
    const sunIsUp = sunAltitude(calcDate, observerLat, observerLon, null) > 0;

    // Search for rise
    const riseTime = planetaryRiseSetTimeRefined(
        sunIsUp ? calcDate - fudgeSeconds - 3600 * 13.2 : calcDate + fudgeSeconds,
        observerLat, observerLon, true, ECPlanetNumber.Sun, NaN, pool,
    );
    // Search for set
    const setTime = planetaryRiseSetTimeRefined(
        sunIsUp ? calcDate + fudgeSeconds : calcDate - fudgeSeconds - 3600 * 13.2,
        observerLat, observerLon, false, ECPlanetNumber.Sun, NaN, pool,
    );

    if (isNoRiseSet(riseTime) && isNoRiseSet(setTime)) {
        return riseTime === kECAlwaysAboveHorizon;
    }
    if (isNoRiseSet(riseTime) && !isNoRiseSet(setTime)) {
        return riseTime === kECAlwaysAboveHorizon;
    }
    return false;
}

/**
 * Check if we're in polar winter (sun never rises).
 */
function isPolarWinter(
    getNow: () => Date,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
    tzOffsetSeconds: number,
): boolean {
    const calcDate = dateToDateInterval(getNow());
    const fudgeSeconds = -5;
    const sunIsUp = sunAltitude(calcDate, observerLat, observerLon, null) > 0;

    const riseTime = planetaryRiseSetTimeRefined(
        sunIsUp ? calcDate - fudgeSeconds - 3600 * 13.2 : calcDate + fudgeSeconds,
        observerLat, observerLon, true, ECPlanetNumber.Sun, NaN, pool,
    );
    const setTime = planetaryRiseSetTimeRefined(
        sunIsUp ? calcDate + fudgeSeconds : calcDate - fudgeSeconds - 3600 * 13.2,
        observerLat, observerLon, false, ECPlanetNumber.Sun, NaN, pool,
    );

    if (isNoRiseSet(riseTime) && isNoRiseSet(setTime)) {
        return riseTime === kECAlwaysBelowHorizon;
    }
    if (isNoRiseSet(riseTime) && !isNoRiseSet(setTime)) {
        return riseTime === kECAlwaysBelowHorizon;
    }
    return false;
}

/**
 * Convert a dateInterval to a 24-hour angle in local time.
 * iOS: angle24HourForDateInterval:timeBaseKind:ECTimeBaseKindLT
 */
function angle24HourForDate(dateInterval: number, _tzOffsetSeconds: number): number {
    const d = new Date((dateInterval + 978307200) * 1000);  // Apple epoch to JS epoch
    const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
    return h * Math.PI / 12;  // 24h → 2π
}

/**
 * Full day/night leaf angle computation.
 * iOS: dayNightLeafAngleForPlanetNumber:leafNumber:numLeaves:timeBaseKind:ECTimeBaseKindLT
 *
 * numLeaves == 0: special indicator angles (rise/set/polar)
 * numLeaves > 0: individual leaf positions for day/night ring
 */
function computeDayNightLeafAngle(
    planetNumber: number,
    leafNumber: number,
    numLeaves: number,
    getNow: () => Date,
    observerLat: number,
    observerLon: number,
    pool: AstroCachePool,
    tzOffsetSeconds: number,
): number {
    const calcDate = dateToDateInterval(getNow());
    const fudgeSeconds = -5;
    const lookahead = 3600 * 13.2;

    const alt = sunAltitude(calcDate, observerLat, observerLon, null);
    const sunIsUp = alt > 0;

    // Get rise time
    const riseTime = planetaryRiseSetTimeRefined(
        sunIsUp ? calcDate - fudgeSeconds - lookahead : calcDate + fudgeSeconds,
        observerLat, observerLon, true, ECPlanetNumber.Sun, NaN, pool,
    );
    // Get set time
    const setTime = planetaryRiseSetTimeRefined(
        sunIsUp ? calcDate + fudgeSeconds : calcDate - fudgeSeconds - lookahead,
        observerLat, observerLon, false, ECPlanetNumber.Sun, NaN, pool,
    );

    // Compute transit angles for fallback
    const now = getNow();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const rTransitAngle = angle24HourForDate(dateToDateInterval(noon), tzOffsetSeconds);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const sTransitAngle = angle24HourForDate(dateToDateInterval(midnight), tzOffsetSeconds);

    let riseTimeAngle = isNoRiseSet(riseTime) ? NaN : angle24HourForDate(riseTime, tzOffsetSeconds);
    let setTimeAngle = isNoRiseSet(setTime) ? NaN : angle24HourForDate(setTime, tzOffsetSeconds);

    // Special case: numLeaves == 0
    if (numLeaves === 0) {
        if (leafNumber === 0) {
            return isNaN(riseTimeAngle) ? rTransitAngle : riseTimeAngle;
        } else if (leafNumber === 1) {
            return isNaN(setTimeAngle) ? sTransitAngle : setTimeAngle;
        } else if (leafNumber === 2) {
            // polarSummer
            return (isNoRiseSet(riseTime) && riseTime === kECAlwaysAboveHorizon) ? 1 : 0;
        } else if (leafNumber === 3) {
            // polarWinter
            return (isNoRiseSet(riseTime) && riseTime === kECAlwaysBelowHorizon) ? 1 : 0;
        }
    }

    const leafWidth = 2 * Math.PI / numLeaves;
    let polarSummer = false;
    let polarWinter = false;

    // Handle NaN cases — match iOS logic exactly
    if (isNaN(riseTimeAngle)) {
        if (isNaN(setTimeAngle)) {
            // Both invalid — use average transit
            let sTA = sTransitAngle;
            if (sTA > rTransitAngle + Math.PI) sTA -= 2 * Math.PI;
            else if (sTA < rTransitAngle - Math.PI) sTA += 2 * Math.PI;
            const avgTransit = (rTransitAngle + sTA) / 2;
            if (isNoRiseSet(riseTime) && riseTime === kECAlwaysAboveHorizon) {
                riseTimeAngle = avgTransit - Math.PI;
                setTimeAngle = avgTransit + Math.PI;
                polarSummer = true;
            } else {
                riseTimeAngle = avgTransit - leafWidth / 2 - 0.00001;
                setTimeAngle = avgTransit + leafWidth / 2 + 0.00001;
                polarWinter = true;
            }
        } else {
            if (isNoRiseSet(riseTime) && riseTime === kECAlwaysAboveHorizon) {
                riseTimeAngle = setTimeAngle - 2 * Math.PI;
                polarSummer = true;
            } else {
                riseTimeAngle = setTimeAngle - leafWidth;
                polarWinter = true;
            }
        }
    } else if (isNaN(setTimeAngle)) {
        if (isNoRiseSet(setTime) && setTime === kECAlwaysAboveHorizon) {
            setTimeAngle = riseTimeAngle + 2 * Math.PI;
            polarSummer = true;
        } else {
            setTimeAngle = riseTimeAngle + leafWidth;
            polarWinter = true;
        }
    }

    // Normalize
    riseTimeAngle = fmod(riseTimeAngle, 2 * Math.PI);
    setTimeAngle = fmod(setTimeAngle, 2 * Math.PI);
    if (setTimeAngle <= riseTimeAngle + 0.0001) {
        setTimeAngle += 2 * Math.PI;
    }

    // Normal daytime leaf: shrink by half leaf width
    setTimeAngle -= leafWidth / 2;
    riseTimeAngle += leafWidth / 2;

    if (setTimeAngle < riseTimeAngle) {
        riseTimeAngle = setTimeAngle = (riseTimeAngle + setTimeAngle) / 2;
    }

    let leafCenterAngle = riseTimeAngle + (setTimeAngle - riseTimeAngle) / (numLeaves - 1) * leafNumber;

    if (leafCenterAngle > 2 * Math.PI) {
        leafCenterAngle -= 2 * Math.PI;
    }

    return leafCenterAngle;
}
