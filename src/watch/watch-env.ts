/**
 * Watch expression environment setup.
 *
 * Creates an Environment populated with all init-block variables
 * and time/astronomy functions for a parsed Watch model.
 */

import {
    createDefaultEnvironment,
    evaluateInit,
    evaluateExpression,
    Environment,
} from '../expr/evaluator.js';
import type { Watch } from './types.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';
import { sunAltitude, sunAzimuth, moonAltitude, moonAzimuth, moonAge } from '../astronomy/es-astro.js';
import { planetaryRiseSetTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet } from '../astronomy/astro-constants.js';

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

    // Register update interval constants used in hand `update` attrs
    env.variables.set('updateAtNextSunriseOrMidnight', 86400);
    env.variables.set('updateAtNextSunsetOrMidnight', 86400);
    env.variables.set('updateAtNextMoonriseOrMidnight', 86400);
    env.variables.set('updateAtNextMoonsetOrMidnight', 86400);
    env.variables.set('updateAtEnvChangeOnly', 86400);

    // Register real time functions
    registerTimeFunctions(env, OBSERVER_LAT, OBSERVER_LON);

    // Evaluate all init blocks in document order
    for (const expr of watch.initExprs) {
        evaluateInit(expr, env);
    }

    return env;
}

/**
 * Evaluate a single attribute expression in the given env.
 * Returns 0 for undefined/empty expressions.
 */
export function evalAttr(expr: string | undefined, env: Environment): number {
    if (!expr || expr.trim() === '') return 0;
    return evaluateExpression(expr.trim(), env);
}

/**
 * Evaluate a color expression and return a CSS color string.
 * The XML uses 0xAARRGGBB format (matching iOS UIColor).
 */
export function evalColor(expr: string | undefined, env: Environment): string {
    if (!expr || expr.trim() === '') return 'rgba(0,0,0,0)';

    // Handle 'clear' specially
    const trimmed = expr.trim();
    if (trimmed === 'clear') return 'rgba(0,0,0,0)';

    const val = evaluateExpression(trimmed, env);
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

    // Snapshot time for astronomy/calendar (changes at most daily)
    const now = new Date();
    const dateInterval = dateToDateInterval(now);

    // Local timezone offset in seconds (JS gives minutes, positive for west)
    const tzOffsetMinutes = now.getTimezoneOffset();
    const tzOffsetSeconds = -tzOffsetMinutes * 60; // Convert to seconds, east-positive

    // --- Clock hands (LIVE — recompute from Date.now() on each call) ---
    // These are called every animation frame so the hands move in real time.
    // Helper to extract fractional components from the current time:
    const liveTime = () => {
        const t = new Date();
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

    // --- Calendar (snapshot — changes daily) ---
    const dayOfMonth = now.getDate();     // 1-31
    const month = now.getMonth();         // 0-11
    const weekday = now.getDay();         // 0=Sunday

    functions.set('dayNumber', () => dayOfMonth - 1);  // 0-indexed for wheel math
    functions.set('monthNumber', () => month);
    functions.set('weekdayNumberAngle', () => weekday * 2 * Math.PI / 7);

    // Helper that returns days-in-seconds
    functions.set('days', () => 86400);

    // --- Astronomy setup (snapshot for rise/set, which are daily values) ---
    const pool = new AstroCachePool();
    initializeCachePool(pool, dateInterval, OBSERVER_LAT, OBSERVER_LON, false, tzOffsetSeconds);

    // --- Sun position (LIVE — recompute each call) ---
    // Sun altitude and azimuth change continuously throughout the day.
    functions.set('sunAltitude', () => {
        const di = dateToDateInterval(new Date());
        return sunAltitude(di, OBSERVER_LAT, OBSERVER_LON, null);
    });
    functions.set('sunAzimuth', () => {
        const di = dateToDateInterval(new Date());
        return sunAzimuth(di, OBSERVER_LAT, OBSERVER_LON, null);
    });

    // --- Sunrise/sunset for today ---
    // Use LOCAL noon as starting point (not UT noon, which is 5 AM PDT and
    // would find yesterday's sunset instead of today's)
    const cache = pool.currentCache;
    const localMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000 - 978307200;
    const localNoon = localMidnight + 12 * 3600;

    const sunrise = planetaryRiseSetTimeRefined(
        localNoon, OBSERVER_LAT, OBSERVER_LON, true, ECPlanetNumber.Sun, NaN, pool,
    );
    const sunset = planetaryRiseSetTimeRefined(
        localNoon, OBSERVER_LAT, OBSERVER_LON, false, ECPlanetNumber.Sun, NaN, pool,
    );
    if (!isNoRiseSet(sunrise)) {
        const srDate = new Date((sunrise + 978307200) * 1000);
        const srHour12 = (srDate.getHours() % 12) + srDate.getMinutes() / 60 + srDate.getSeconds() / 3600;
        const srMinute = srDate.getMinutes() + srDate.getSeconds() / 60;
        functions.set('sunriseForDayValid', () => 1);
        functions.set('sunriseForDayHour12ValueAngle', () => srHour12 * 2 * Math.PI / 12);
        functions.set('sunriseForDayMinuteValueAngle', () => srMinute * 2 * Math.PI / 60);
    } else {
        functions.set('sunriseForDayValid', () => 0);
        functions.set('sunriseForDayHour12ValueAngle', () => 0);
        functions.set('sunriseForDayMinuteValueAngle', () => 0);
    }

    if (!isNoRiseSet(sunset)) {
        const ssDate = new Date((sunset + 978307200) * 1000);
        const ssHour12 = (ssDate.getHours() % 12) + ssDate.getMinutes() / 60 + ssDate.getSeconds() / 3600;
        const ssMinute = ssDate.getMinutes() + ssDate.getSeconds() / 60;
        functions.set('sunsetForDayValid', () => 1);
        functions.set('sunsetForDayHour12ValueAngle', () => ssHour12 * 2 * Math.PI / 12);
        functions.set('sunsetForDayMinuteValueAngle', () => ssMinute * 2 * Math.PI / 60);
    } else {
        functions.set('sunsetForDayValid', () => 0);
        functions.set('sunsetForDayHour12ValueAngle', () => 0);
        functions.set('sunsetForDayMinuteValueAngle', () => 0);
    }

    // --- Moon (LIVE — recompute each call) ---
    functions.set('moonAltitude', () => {
        const di = dateToDateInterval(new Date());
        return moonAltitude(di, OBSERVER_LAT, OBSERVER_LON, null);
    });
    functions.set('moonAzimuth', () => {
        const di = dateToDateInterval(new Date());
        return moonAzimuth(di, OBSERVER_LAT, OBSERVER_LON, null);
    });
    functions.set('moonAgeAngle', () => {
        const di = dateToDateInterval(new Date());
        return moonAge(di, null).age;
    });
    functions.set('moonRelativePositionAngle', () => 0);  // TODO: implement

    // --- Moonrise/moonset ---
    const moonrise = planetaryRiseSetTimeRefined(
        localNoon, OBSERVER_LAT, OBSERVER_LON, true, ECPlanetNumber.Moon, NaN, pool,
    );
    const moonset = planetaryRiseSetTimeRefined(
        localNoon, OBSERVER_LAT, OBSERVER_LON, false, ECPlanetNumber.Moon, NaN, pool,
    );

    if (!isNoRiseSet(moonrise)) {
        const mrDate = new Date((moonrise + 978307200) * 1000);
        const mrHour12 = (mrDate.getHours() % 12) + mrDate.getMinutes() / 60;
        const mrMinute = mrDate.getMinutes() + mrDate.getSeconds() / 60;
        functions.set('moonriseForDayValid', () => 1);
        functions.set('moonriseForDayHour12ValueAngle', () => mrHour12 * 2 * Math.PI / 12);
        functions.set('moonriseForDayMinuteValueAngle', () => mrMinute * 2 * Math.PI / 60);
        functions.set('moonriseForDayHour24Number', () => mrDate.getHours());
    } else {
        functions.set('moonriseForDayValid', () => 0);
        functions.set('moonriseForDayHour12ValueAngle', () => 0);
        functions.set('moonriseForDayMinuteValueAngle', () => 0);
        functions.set('moonriseForDayHour24Number', () => 0);
    }

    if (!isNoRiseSet(moonset)) {
        const msDate = new Date((moonset + 978307200) * 1000);
        const msHour12 = (msDate.getHours() % 12) + msDate.getMinutes() / 60;
        const msMinute = msDate.getMinutes() + msDate.getSeconds() / 60;
        functions.set('moonsetForDayValid', () => 1);
        functions.set('moonsetForDayHour12ValueAngle', () => msHour12 * 2 * Math.PI / 12);
        functions.set('moonsetForDayMinuteValueAngle', () => msMinute * 2 * Math.PI / 60);
        functions.set('moonsetForDayHour24Number', () => msDate.getHours());
    } else {
        functions.set('moonsetForDayValid', () => 0);
        functions.set('moonsetForDayHour12ValueAngle', () => 0);
        functions.set('moonsetForDayMinuteValueAngle', () => 0);
        functions.set('moonsetForDayHour24Number', () => 0);
    }

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

    // Calendar wheel helpers
    functions.set('calendarWeekdayStart', () => 0);

    // Release the cache pool
    releaseCachePool(pool);
}
