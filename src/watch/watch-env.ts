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
    utcComponentsFromTimeInterval, localComponentsFromTimeInterval,
    daysInMonth as calendarDaysInMonth, kECJulianGregorianSwitchoverTimeInterval,
    timeIntervalFromUTCComponents, weekdayFromTimeInterval,
} from '../astronomy/es-calendar.js';
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
    calculateEclipse, EclipseKind,
    localSiderealTime,
    planetAltAz,
    positionAngle, northAngleForObject,
} from '../astronomy/es-astro.js';
import { planetaryRiseSetTimeRefined, planettransitTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet, kECAlwaysAboveHorizon, kECAlwaysBelowHorizon, fmod } from '../astronomy/astro-constants.js';
import { terminatorAngle } from './terminator.js';
import { GSTDifferenceForDate, convertUTToGSTP03, convertGSTtoLST } from '../astronomy/es-sidereal.js';
import { generalPrecessionSinceJ2000, sunRAandDecl, moonRAAndDecl, sunEclipticLongitudeForDate, raAndDeclO, generalObliquity } from '../astronomy/es-coordinates.js';
import { julianCenturiesSince2000EpochForDateInterval } from '../astronomy/es-time.js';
import { WB_planetHeliocentricLongitude, WB_planetHeliocentricRadius, WB_planetApparentPosition } from '../astronomy/willmann-bell.js';
import { WB_MoonAscendingNodeLongitude } from '../astronomy/wb-moon.js';
import { WB_nutationObliquity } from '../astronomy/wb-sun.js';

// Default observer location (San Jose, CA): used if geolocation unavailable
const DEFAULT_LAT_DEG = 37.205;    // degrees N
const DEFAULT_LON_DEG = -121.954;  // degrees (west is negative)

/**
 * Compute the millisecond delta between a target IANA timezone and the
 * browser's local timezone.  Adding this delta to a Date's getTime()
 * makes getHours()/getMinutes()/etc. return values in the target timezone.
 *
 * @param olsonTimezone  IANA timezone (e.g. "Pacific/Honolulu"). If undefined
 *                       or empty, returns 0 (no shift).
 * @param referenceDate  Date used to determine DST state.  Defaults to now.
 * @returns              Milliseconds to add to shift from browser TZ to target TZ.
 */
export function computeTzDeltaMs(olsonTimezone: string | undefined, referenceDate?: Date): number {
    if (!olsonTimezone) return 0;
    const ref = referenceDate || new Date();
    const browserOffsetSec = -ref.getTimezoneOffset() * 60;
    let targetOffsetSec: number;
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonTimezone,
            timeZoneName: 'longOffset',
        });
        const parts = fmt.formatToParts(ref);
        const tzStr = parts.find(p => p.type === 'timeZoneName')?.value || '';
        if (tzStr === 'GMT' || tzStr === 'UTC' || !tzStr) {
            targetOffsetSec = 0;
        } else {
            const m = tzStr.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
            if (m) {
                const sign = m[1] === '+' ? 1 : -1;
                targetOffsetSec = sign * (parseInt(m[2], 10) * 3600 + (m[3] ? parseInt(m[3], 10) * 60 : 0));
            } else {
                targetOffsetSec = browserOffsetSec;
            }
        }
    } catch {
        targetOffsetSec = browserOffsetSec;
    }
    return (targetOffsetSec - browserOffsetSec) * 1000;
}

/**
 * Build the expression environment for a watch:
 *  1. Math builtins + color constants
 *  2. Evaluate all init blocks (populates watch variables)
 *  3. Register time/astronomy functions using real current time
 *
 * @param observerLatDeg - Observer latitude in degrees (positive = north). Defaults to San Jose, CA.
 * @param observerLonDeg - Observer longitude in degrees (negative = west). Defaults to San Jose, CA.
 * @param getNow - Time source function. Defaults to () => new Date() (real time).
 */

// --- Exported Terra types and defaults ---

/** A city entry for a Terra worldtime ring slot. */
export interface TerraSlot {
    cityName: string;
    olsonId: string;
    lat: number;
    lon: number;
}

/** Default ring slot cities (indexed by env slot 1–24). */
export const TERRA_RING_DEFAULTS: Record<number, TerraSlot> = {
    1:  { cityName: 'Pago Pago',      olsonId: 'Pacific/Pago_Pago',      lat: -14.27806, lon: -170.70250 },
    2:  { cityName: 'Honolulu',       olsonId: 'Pacific/Honolulu',       lat:  21.30694, lon: -157.85834 },
    3:  { cityName: 'Anchorage',      olsonId: 'America/Juneau',         lat:  61.21806, lon: -149.90028 },
    4:  { cityName: 'Los Angeles',    olsonId: 'America/Los_Angeles',    lat:  34.05223, lon: -118.24368 },
    5:  { cityName: 'Denver',         olsonId: 'America/Denver',         lat:  39.73915, lon: -104.98470 },
    6:  { cityName: 'Chicago',        olsonId: 'America/Chicago',        lat:  41.85003, lon:  -87.65005 },
    7:  { cityName: 'New York',       olsonId: 'America/New_York',       lat:  40.71427, lon:  -74.00597 },
    8:  { cityName: 'Santiago',       olsonId: 'America/Santiago',       lat: -33.42628, lon:  -70.56655 },
    9:  { cityName: 'Rio de Janeiro', olsonId: 'America/Sao_Paulo',      lat: -22.90278, lon:  -43.20750 },
    10: { cityName: 'Grytviken',      olsonId: 'Atlantic/South_Georgia', lat: -54.27667, lon:  -36.51167 },
    11: { cityName: 'Dakar',          olsonId: 'Africa/Dakar',           lat:  14.74208, lon:  -17.43978 },
    12: { cityName: 'London',         olsonId: 'Europe/London',          lat:  51.50842, lon:   -0.12553 },
    13: { cityName: 'Paris',          olsonId: 'Europe/Paris',           lat:  48.85341, lon:    2.34880 },
    14: { cityName: 'Cairo',          olsonId: 'Africa/Cairo',           lat:  30.05000, lon:   31.25000 },
    15: { cityName: 'Moscow',         olsonId: 'Europe/Moscow',          lat:  55.75222, lon:   37.61555 },
    16: { cityName: 'Dubai',          olsonId: 'Asia/Dubai',             lat:  25.25222, lon:   55.28000 },
    17: { cityName: 'Delhi',          olsonId: 'Asia/Kolkata',           lat:  28.66667, lon:   77.21666 },
    18: { cityName: 'Dhaka',          olsonId: 'Asia/Dhaka',             lat:  23.72305, lon:   90.40861 },
    19: { cityName: 'Bangkok',        olsonId: 'Asia/Bangkok',           lat:  13.75000, lon:  100.51667 },
    20: { cityName: 'Hong Kong',      olsonId: 'Asia/Hong_Kong',         lat:  22.28401, lon:  114.15007 },
    21: { cityName: 'Tokyo',          olsonId: 'Asia/Tokyo',             lat:  35.68953, lon:  139.69168 },
    22: { cityName: 'Sydney',         olsonId: 'Australia/Sydney',       lat: -33.86785, lon:  151.20732 },
    23: { cityName: 'Nouméa',         olsonId: 'Pacific/Noumea',         lat: -22.26667, lon:  166.45000 },
    24: { cityName: 'Auckland',       olsonId: 'Pacific/Auckland',       lat: -36.86666, lon:  174.76666 },
};

/** Default subdial cities for Gaia (indexed by env slot 2–4; slot 1 = observer). */
export const GAIA_SUBDIAL_DEFAULTS: Record<number, TerraSlot> = {
    2: { cityName: 'New York', olsonId: 'America/New_York', lat: 40.71427, lon: -74.00597 },
    3: { cityName: 'London',   olsonId: 'Europe/London',    lat: 51.50842, lon:  -0.12553 },
    4: { cityName: 'Sydney',   olsonId: 'Australia/Sydney',  lat: -33.86785, lon: 151.20732 },
};
export function createWatchEnvironment(
    watch: Watch,
    observerLatDeg: number = DEFAULT_LAT_DEG,
    observerLonDeg: number = DEFAULT_LON_DEG,
    getNow: () => Date = () => new Date(),
    olsonTimezone?: string,
    slotOverrides?: Record<number, TerraSlot>,
    globalLocationSlot?: number,
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
    env.variables.set('planetMercury', ECPlanetNumber.Mercury);
    env.variables.set('planetVenus', ECPlanetNumber.Venus);
    env.variables.set('planetEarth', ECPlanetNumber.Earth);
    env.variables.set('planetMars', ECPlanetNumber.Mars);
    env.variables.set('planetJupiter', ECPlanetNumber.Jupiter);
    env.variables.set('planetSaturn', ECPlanetNumber.Saturn);
    env.variables.set('planetUranus', ECPlanetNumber.Uranus);
    env.variables.set('planetNeptune', ECPlanetNumber.Neptune);

    // Register time functions (uses the provided getNow source)
    registerTimeFunctions(env, OBSERVER_LAT, OBSERVER_LON, getNow, olsonTimezone, slotOverrides, globalLocationSlot);

    // Evaluate all init blocks in document order
    for (const expr of watch.initExprs) {
        evaluate(expr, env);
    }

    // URL param override for 'body' (Venezia planet selection via ?body=jupiter etc.)
    // Must run AFTER init blocks so it overrides the XML's default body assignment.
    if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        const bodyParam = params.get('body');
        if (bodyParam) {
            const bodyMap: Record<string, number> = {
                sun: ECPlanetNumber.Sun, moon: ECPlanetNumber.Moon,
                mercury: ECPlanetNumber.Mercury, venus: ECPlanetNumber.Venus,
                earth: ECPlanetNumber.Earth, mars: ECPlanetNumber.Mars,
                jupiter: ECPlanetNumber.Jupiter, saturn: ECPlanetNumber.Saturn,
                uranus: ECPlanetNumber.Uranus, neptune: ECPlanetNumber.Neptune,
            };
            const planet = bodyMap[bodyParam.toLowerCase()];
            if (planet !== undefined) {
                env.variables.set('body', planet);
                // Recompute bodySlot from body (matching the XML init expression)
                const body = planet;
                const bodySlot =
                    body === ECPlanetNumber.Moon ? 0 :
                    body === ECPlanetNumber.Mercury ? 1 :
                    body === ECPlanetNumber.Venus ? 2 :
                    body === ECPlanetNumber.Mars ? 3 :
                    body === ECPlanetNumber.Jupiter ? 4 :
                    body === ECPlanetNumber.Saturn ? 5 :
                    body === ECPlanetNumber.Uranus ? 6 :
                    body === ECPlanetNumber.Neptune ? 7 :
                    body === ECPlanetNumber.Sun ? 8 : 0.5;
                env.variables.set('bodySlot', bodySlot);
            }
        }
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

function registerTimeFunctions(
    env: Environment,
    OBSERVER_LAT: number,
    OBSERVER_LON: number,
    getNow: () => Date = () => new Date(),
    olsonTimezone?: string,
    slotOverrides?: Record<number, TerraSlot>,
    globalLocationSlot?: number,
): void {
    const { functions } = env;

    // Snapshot time for astronomy/calendar (changes at most daily)
    const now = getNow();
    const dateInterval = dateToDateInterval(now);

    // Timezone offset delta in milliseconds: adding this to a Date's getTime()
    // makes getHours()/getMinutes()/getSeconds() return target-timezone values.
    const tzDeltaMs = computeTzDeltaMs(olsonTimezone, now);

    // Timezone offset in seconds (east-positive) for calendar/astronomy.
    const browserOffsetSec = -now.getTimezoneOffset() * 60;
    const tzOffsetSeconds = browserOffsetSec + tzDeltaMs / 1000;

    // --- Clock hands (LIVE — recompute from Date.now() on each call) ---
    // These are called every animation frame so the hands move in real time.

    // Helper: return a Date shifted to the target timezone for display.
    // getHours/getMinutes/getSeconds on the result give target-tz values.
    const liveDate = (): Date => {
        const raw = getNow();
        return tzDeltaMs !== 0 ? new Date(raw.getTime() + tzDeltaMs) : raw;
    };

    // Helper to extract fractional components from the current time:
    const liveTime = () => {
        const t = liveDate();
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
    // hour24Value: 24-hour time as continuous float (e.g. 14.5 = 2:30 PM)
    // t.m already includes seconds/60, so t.h24 + t.m/60 gives the full fractional hour.
    functions.set('hour24Value', () => {
        const t = liveTime();
        return t.h24 + t.m / 60;
    });
    // hour24ValueAngle: 24-hour time as angle (2π/24 per hour)
    functions.set('hour24ValueAngle', () => {
        const t = liveTime();
        return (t.h24 + t.m / 60) * 2 * Math.PI / 24;
    });
    // tzOffsetAngle: local timezone UTC offset as angle on 24-hour dial
    functions.set('tzOffsetAngle', () => {
        return tzOffsetSeconds * Math.PI / (3600 * 12);
    });

    // --- Calendar (LIVE — uses hybrid Julian/Gregorian calendar) ---
    // Helper: get local calendar components using the hybrid calendar system.
    // This correctly handles the Julian/Gregorian switchover at Oct 15, 1582
    // and BCE dates with proleptic Julian calendar.
    const getLocalComponents = () => {
        const di = dateToDateInterval(getNow());
        return localComponentsFromTimeInterval(di, tzOffsetSeconds);
    };

    functions.set('dayNumber', () => getLocalComponents().day - 1);  // 0-indexed for wheel math
    functions.set('dayNumberAngle', () => {
        const cs = getLocalComponents();
        return (cs.day - 1) * 2 * Math.PI / 31;
    });
    functions.set('monthNumber', () => getLocalComponents().month - 1);  // 0-indexed to match JS convention
    functions.set('monthNumberAngle', () => (getLocalComponents().month - 1) * 2 * Math.PI / 12);
    functions.set('weekdayNumberAngle', () => {
        const di = dateToDateInterval(getNow());
        return weekdayFromTimeInterval(di, tzOffsetSeconds) * 2 * Math.PI / 7;
    });
    functions.set('yearNumber', () => {
        const cs = getLocalComponents();
        return cs.year;  // Always positive; era is from eraNumber()
    });
    functions.set('eraNumber', () => getLocalComponents().era);

    // --- Geneva I calendar functions ---
    functions.set('GregorianEra', () => {
        const di = dateToDateInterval(getNow());
        return di > kECJulianGregorianSwitchoverTimeInterval ? 1 : 0;
    });
    functions.set('DSTNumber', () => {
        if (olsonTimezone) {
            // For a custom timezone, compare the target offset at two reference
            // points (Jan 1 and Jul 1) to determine if DST is active now.
            const now = getNow();
            const yr = liveDate().getFullYear();
            const janDelta = computeTzDeltaMs(olsonTimezone, new Date(yr, 0, 1));
            const julDelta = computeTzDeltaMs(olsonTimezone, new Date(yr, 6, 1));
            const stdDelta = Math.min(janDelta, julDelta);  // standard time has smaller UTC offset
            return tzDeltaMs > stdDelta ? 1 : 0;
        }
        // Browser timezone: compare January offset to current offset
        const now = getNow();
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const stdOffset = Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
        return now.getTimezoneOffset() < stdOffset ? 1 : 0;
    });
    functions.set('monthLen', () => {
        const cs = getLocalComponents();
        return calendarDaysInMonth(cs.era, cs.year, cs.month);
    });
    functions.set('yearNumberCEMonotonic', () => {
        // Continuous year numbering: 2 BCE=−1, 1 BCE=0, 1 CE=1, 2 CE=2, ...
        const cs = getLocalComponents();
        return cs.era === 0 ? 1 - cs.year : cs.year;
    });
    functions.set('leapYearIndicatorAngle', () => {
        // Ported from ECVirtualMachineOps.m line 4159
        const cs = getLocalComponents();
        const yearNumber = cs.year;
        const eraNumber = cs.era;
        if (eraNumber && yearNumber >= 1582) {
            // Gregorian: accounts for 100/400 year exceptions
            return Math.PI + (yearNumber % 400 === 0 ? 3 * Math.PI / 4
                : yearNumber % 100 === 0 ? 5 * Math.PI / 4
                : yearNumber % 4 === 0 ? Math.PI / 4
                : ((yearNumber % 4) * 2 + 17) * Math.PI / 12);
        } else if (eraNumber) {
            // Julian CE
            return Math.PI + (yearNumber % 4 === 0 ? Math.PI / 4
                : ((yearNumber % 4) * 2 + 17) * Math.PI / 12);
        } else {
            // Proleptic Julian BCE (leap years on 1 BCE, 5 BCE, etc.)
            const adjustedYear = yearNumber - 1;
            return Math.PI + (adjustedYear % 4 === 0 ? Math.PI / 4
                : ((adjustedYear % 4) * 2 + 17) * Math.PI / 12);
        }
    });
    functions.set('season', () => {
        // Ported from ECVirtualMachineOps.m line 2367
        // 0=spring, 1=summer, 2=fall, 3=winter
        const north = OBSERVER_LAT >= 0;  // equator counts as north
        const di = dateToDateInterval(getNow());
        const sunLong = planetEclipticLongitude(ECPlanetNumber.Sun, di, null);
        if (sunLong > Math.PI * 3 / 2) return north ? 3 : 1;      // winter/summer
        else if (sunLong > Math.PI) return north ? 2 : 0;          // fall/spring
        else if (sunLong > Math.PI / 2) return north ? 1 : 3;      // summer/winter
        else return north ? 0 : 2;                                  // spring/fall
    });
    functions.set('offsetOfWinterSolsticeFromDec31Midnight', () => {
        // Ported from ECVirtualMachineOps.m line 1858
        // calendarErrorVsTropicalYear = sunLong(sameDay2001) - sunLong(today)
        const di = dateToDateInterval(getNow());
        const todaysLongitude = planetEclipticLongitude(ECPlanetNumber.Sun, di, null);

        // Get the same month/day but in year 2001 (Gregorian reference)
        const cs = utcComponentsFromTimeInterval(di);
        const thisDay2001 = timeIntervalFromUTCComponents(1, 2001, cs.month, cs.day, cs.hour, cs.minute, cs.seconds);
        const year2001Longitude = planetEclipticLongitude(ECPlanetNumber.Sun, thisDay2001, null);

        const calendarError = year2001Longitude - todaysLongitude;

        // North/south hemisphere offset
        const northSouthOffset = OBSERVER_LAT >= 0 ? 0 : Math.PI;

        // Subtract 10.25/365.25 * 2π to move winter solstice back to ~Dec 21
        return calendarError - 10.25 / 365.25 * 2 * Math.PI + northSouthOffset;
    });

    // Note: hour24ValueAngle, hour24Value, and hour24Number are registered
    // above via liveTime() which already uses the timezone-shifted date.

    // Time-unit helpers (return value in seconds, matching iOS convention for update intervals)
    functions.set('years', () => 365.25 * 86400);
    functions.set('weeks', () => 7 * 86400);
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
        const now = getNow();
        const calcDate = dateToDateInterval(now);

        // Compute LOCAL noon of the user's calendar day.
        // We must use local time (not UT) because isSameLocalDay
        // compares results in the user's timezone.
        const ld = liveDate();  // timezone-shifted date
        const localNoon = new Date(
            ld.getFullYear(), ld.getMonth(), ld.getDate(), 12, 0, 0,
        );
        // Shift back to real UTC for the astronomy calculation
        const noonDI = dateToDateInterval(new Date(localNoon.getTime() - tzDeltaMs));

        // Search from local noon — both sunrise (~6h before) and sunset
        // (~6h after) are within the solver's convergence radius.
        const fwdResult = planetaryRiseSetTimeRefined(
            noonDI, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(fwdResult) && isSameLocalDay(fwdResult, calcDate)) {
            return fwdResult;
        }

        // Backward: search from previous local noon (24h earlier)
        const bwdResult = planetaryRiseSetTimeRefined(
            noonDI - 24 * 3600, OBSERVER_LAT, OBSERVER_LON,
            riseNotSet, planetNumber, NaN, pool,
        );
        if (!isNoRiseSet(bwdResult) && isSameLocalDay(bwdResult, calcDate)) {
            return bwdResult;
        }

        return NaN;  // no event on current day
    }

    /** Check if two date intervals fall on the same local calendar day (in the target timezone) */
    function isSameLocalDay(di1: number, di2: number): boolean {
        // Shift to target timezone for comparison
        const d1 = new Date((di1 + 978307200) * 1000 + tzDeltaMs);
        const d2 = new Date((di2 + 978307200) * 1000 + tzDeltaMs);
        return d1.getFullYear() === d2.getFullYear()
            && d1.getMonth() === d2.getMonth()
            && d1.getDate() === d2.getDate();
    }

    /** Convert a dateInterval rise/set result into hour12/minute/hour24 values (in target timezone) */
    function riseSetAngles(di: number): { hour12: number; minute: number; hour24: number } {
        // Shift to target timezone so getHours/getMinutes return local values
        const d = new Date((di + 978307200) * 1000 + tzDeltaMs);
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
    // realMoonAgeAngle: actual elapsed days since last new moon (not radians).
    // iOS: finds nearest new moon and returns (now - newMoon) / 86400.
    // Simplified: use moonAge (radians) * lunarCycle / 2π.
    functions.set('realMoonAgeAngle', () => {
        const di = dateToDateInterval(getNow());
        const ageRadians = moonAge(di, null).age;
        const kECLunarCycleInDays = 29.530588;
        return ageRadians / (2 * Math.PI) * kECLunarCycleInDays;
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
    // HLongitudeOfPlanet(n): heliocentric longitude (radians)
    // Used by Firenze's orrery to position planets on their orbits.
    functions.set('HLongitudeOfPlanet', (n: number) => {
        const di = dateToDateInterval(getNow());
        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, null);
        return WB_planetHeliocentricLongitude(n as ECPlanetNumber, julianCenturiesSince2000Epoch / 100);
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

    // --- Planet azimuth / altitude / RA (Venezia) ---
    // azimuthOfPlanet(body): topocentric azimuth (radians)
    functions.set('azimuthOfPlanet', (planetNumber: number) => {
        const di = dateToDateInterval(getNow());
        if (planetNumber === ECPlanetNumber.Sun) return sunAzimuth(di, OBSERVER_LAT, OBSERVER_LON, null);
        if (planetNumber === ECPlanetNumber.Moon) return moonAzimuth(di, OBSERVER_LAT, OBSERVER_LON, null);
        return planetAltAz(planetNumber, di, OBSERVER_LAT, OBSERVER_LON, true, false, null);
    });
    // altitudeOfPlanet(body): topocentric altitude (radians)
    functions.set('altitudeOfPlanet', (planetNumber: number) => {
        const di = dateToDateInterval(getNow());
        if (planetNumber === ECPlanetNumber.Sun) return sunAltitude(di, OBSERVER_LAT, OBSERVER_LON, null);
        if (planetNumber === ECPlanetNumber.Moon) return moonAltitude(di, OBSERVER_LAT, OBSERVER_LON, null);
        return planetAltAz(planetNumber, di, OBSERVER_LAT, OBSERVER_LON, true, true, null);
    });
    // RAOfPlanet(body): right ascension (radians)
    functions.set('RAOfPlanet', (planetNumber: number) => {
        const di = dateToDateInterval(getNow());
        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, null);
        if (planetNumber === ECPlanetNumber.Sun) {
            return sunRAandDecl(di, null).rightAscension;
        }
        if (planetNumber === ECPlanetNumber.Moon) {
            return moonRAAndDecl(di, null).rightAscension;
        }
        const pos = WB_planetApparentPosition(planetNumber as ECPlanetNumber, julianCenturiesSince2000Epoch / 100);
        return pos.apparentRightAscension;
    });

    // --- Planet rise/transit/set for day (Venezia) ---
    // Helper: find transit of any planet for the current day
    function transitForDay(planetNumber: ECPlanetNumber): number {
        const now = getNow();
        const di = dateToDateInterval(now);
        // Compute local noon in the target timezone using UTC arithmetic
        const utcNowSec = di + 978307200;
        const localNowSec = utcNowSec + tzOffsetSeconds;
        const localDayStartSec = localNowSec - ((localNowSec % 86400) + 86400) % 86400;
        const noonDI = localDayStartSec + 12 * 3600 - tzOffsetSeconds - 978307200;

        const result = planettransitTimeRefined(noonDI, OBSERVER_LAT, OBSERVER_LON, true, planetNumber, pool);
        if (isSameLocalDay(result, di)) return result;

        // Try from noon the day before
        const result2 = planettransitTimeRefined(noonDI - 24 * 3600, OBSERVER_LAT, OBSERVER_LON, true, planetNumber, pool);
        if (isSameLocalDay(result2, di)) return result2;

        return NaN;
    }

    // riseOfPlanetForDayValid(body)
    functions.set('riseOfPlanetForDayValid', (planetNumber: number) => {
        return isNaN(riseSetForDay(true, planetNumber as ECPlanetNumber)) ? 0 : 1;
    });
    functions.set('riseOfPlanetForDayHour12ValueAngle', (planetNumber: number) => {
        const r = riseSetForDay(true, planetNumber as ECPlanetNumber);
        return isNaN(r) ? 0 : riseSetAngles(r).hour12 * 2 * Math.PI / 12;
    });
    functions.set('riseOfPlanetForDayMinuteValueAngle', (planetNumber: number) => {
        const r = riseSetForDay(true, planetNumber as ECPlanetNumber);
        return isNaN(r) ? 0 : riseSetAngles(r).minute * 2 * Math.PI / 60;
    });
    functions.set('riseOfPlanetForDayHour24Number', (planetNumber: number) => {
        const r = riseSetForDay(true, planetNumber as ECPlanetNumber);
        return isNaN(r) ? 0 : riseSetAngles(r).hour24;
    });

    // transitOfPlanetForDayValid(body)
    functions.set('transitOfPlanetForDayValid', (planetNumber: number) => {
        return isNaN(transitForDay(planetNumber as ECPlanetNumber)) ? 0 : 1;
    });
    functions.set('transitOfPlanetForDayHour12ValueAngle', (planetNumber: number) => {
        const t = transitForDay(planetNumber as ECPlanetNumber);
        return isNaN(t) ? 0 : riseSetAngles(t).hour12 * 2 * Math.PI / 12;
    });
    functions.set('transitOfPlanetForDayMinuteValueAngle', (planetNumber: number) => {
        const t = transitForDay(planetNumber as ECPlanetNumber);
        return isNaN(t) ? 0 : riseSetAngles(t).minute * 2 * Math.PI / 60;
    });
    functions.set('transitOfPlanetForDayHour24Number', (planetNumber: number) => {
        const t = transitForDay(planetNumber as ECPlanetNumber);
        return isNaN(t) ? 0 : riseSetAngles(t).hour24;
    });

    // setOfPlanetForDayValid(body)
    functions.set('setOfPlanetForDayValid', (planetNumber: number) => {
        return isNaN(riseSetForDay(false, planetNumber as ECPlanetNumber)) ? 0 : 1;
    });
    functions.set('setOfPlanetForDayHour12ValueAngle', (planetNumber: number) => {
        const s = riseSetForDay(false, planetNumber as ECPlanetNumber);
        return isNaN(s) ? 0 : riseSetAngles(s).hour12 * 2 * Math.PI / 12;
    });
    functions.set('setOfPlanetForDayMinuteValueAngle', (planetNumber: number) => {
        const s = riseSetForDay(false, planetNumber as ECPlanetNumber);
        return isNaN(s) ? 0 : riseSetAngles(s).minute * 2 * Math.PI / 60;
    });
    functions.set('setOfPlanetForDayHour24Number', (planetNumber: number) => {
        const s = riseSetForDay(false, planetNumber as ECPlanetNumber);
        return isNaN(s) ? 0 : riseSetAngles(s).hour24;
    });

    // --- Planet phase/terminator functions (Venezia) ---
    // planetMoonAgeAngle(body): returns an age-like angle for the terminator display
    // Follows ECAstronomy.m planetAge + planetMoonAgeAngle
    functions.set('planetMoonAgeAngle', (planetNumber: number) => {
        const di = dateToDateInterval(getNow());
        if (planetNumber === ECPlanetNumber.Sun) return Math.PI; // always bright
        if (planetNumber === ECPlanetNumber.Moon) return moonAge(di, null).age;

        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, null);
        const U = julianCenturiesSince2000Epoch / 100;

        // Solve the Sun-planet-Earth triangle for phase angle
        const planet_r = WB_planetHeliocentricRadius(planetNumber as ECPlanetNumber, U);
        const planet_delta = planetGeocentricDistance(planetNumber as ECPlanetNumber, di, null);
        const planet_R = WB_planetHeliocentricRadius(ECPlanetNumber.Earth, U); // Earth-Sun distance

        const cos_i = ((planet_r * planet_r) + (planet_delta * planet_delta) - (planet_R * planet_R))
            / (2 * planet_r * planet_delta);
        const phase = Math.acos(Math.max(-1, Math.min(1, cos_i)));

        // moonAge = pi - phase (complement)
        let moonAgeVal = Math.PI - phase;

        // Determine sign from heliocentric longitude difference
        const planetHLong = WB_planetHeliocentricLongitude(planetNumber as ECPlanetNumber, U);
        const earthHLong = WB_planetHeliocentricLongitude(ECPlanetNumber.Earth, U);
        let deltaHL = planetHLong - earthHLong;
        if (deltaHL < 0) deltaHL += 2 * Math.PI;
        if (deltaHL > Math.PI) {
            moonAgeVal = 2 * Math.PI - moonAgeVal;
        }
        return moonAgeVal;
    });

    // planetRelativePositionAngle(body): rotation of the terminator as it appears in the sky
    // Follows ECAstronomy.m planetRelativePositionAngle
    functions.set('planetRelativePositionAngle', (planetNumber: number) => {
        const di = dateToDateInterval(getNow());
        if (planetNumber === ECPlanetNumber.Moon) {
            return moonRelativePositionAngle(di, OBSERVER_LAT, OBSERVER_LON, null);
        }
        if (planetNumber === ECPlanetNumber.Sun) return 0;

        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, null);
        const U = julianCenturiesSince2000Epoch / 100;

        // Sun RA/Decl
        const sunRD = sunRAandDecl(di, null);
        // Planet RA/Decl (without parallax)
        const planetPos = WB_planetApparentPosition(planetNumber as ECPlanetNumber, U);
        const planetRA = planetPos.apparentRightAscension;
        const planetDecl = planetPos.apparentDeclination;

        let posAngle = positionAngle(sunRD.rightAscension, sunRD.declination, planetRA, planetDecl);

        // Check if bright limb is on the left (moonAge > pi)
        const planet_r = WB_planetHeliocentricRadius(planetNumber as ECPlanetNumber, U);
        const planet_delta = planetGeocentricDistance(planetNumber as ECPlanetNumber, di, null);
        const planet_R = WB_planetHeliocentricRadius(ECPlanetNumber.Earth, U);
        const cos_i = ((planet_r * planet_r) + (planet_delta * planet_delta) - (planet_R * planet_R))
            / (2 * planet_r * planet_delta);
        const phase = Math.acos(Math.max(-1, Math.min(1, cos_i)));
        let moonAgeVal = Math.PI - phase;
        const planetHLong = WB_planetHeliocentricLongitude(planetNumber as ECPlanetNumber, U);
        const earthHLong = WB_planetHeliocentricLongitude(ECPlanetNumber.Earth, U);
        let deltaHL = planetHLong - earthHLong;
        if (deltaHL < 0) deltaHL += 2 * Math.PI;
        if (deltaHL > Math.PI) moonAgeVal = 2 * Math.PI - moonAgeVal;

        if (moonAgeVal > Math.PI) {
            posAngle = posAngle > Math.PI ? posAngle - Math.PI : posAngle + Math.PI;
        }

        // Compute planet's azimuth/altitude for northAngle
        const gst = convertUTToGSTP03(di, null);
        const lst = convertGSTtoLST(gst, OBSERVER_LON);
        const planetHourAngle = lst - planetRA;
        const sinAlt = Math.sin(planetDecl) * Math.sin(OBSERVER_LAT)
            + Math.cos(planetDecl) * Math.cos(OBSERVER_LAT) * Math.cos(planetHourAngle);
        const planetAzimuth = Math.atan2(
            -Math.cos(planetDecl) * Math.cos(OBSERVER_LAT) * Math.sin(planetHourAngle),
            Math.sin(planetDecl) - Math.sin(OBSERVER_LAT) * sinAlt,
        );
        const planetAltitude = Math.asin(sinAlt);
        const nAngle = northAngleForObject(planetAltitude, planetAzimuth, OBSERVER_LAT);

        let angle = -nAngle - posAngle - Math.PI / 2;
        if (angle < 0) angle += 2 * Math.PI;
        else if (angle > 2 * Math.PI) angle -= 2 * Math.PI;
        return angle;
    });

    // --- Venezia state variables ---
    // VeneziaTapsEnabled: always returns 0 (buttons deferred)
    functions.set('VeneziaTapsEnabled', () => 0);
    // saveBody: no-op for now
    functions.set('saveBody', (_n: number) => 0);

    // --- Lunar ascending node longitude ---
    functions.set('lunarAscendingNodeLongitude', () => {
        const di = dateToDateInterval(getNow());
        return computeLunarAscendingNode(di, null);
    });

    // --- Moon delta ecliptic longitude at delta day ---
    // Computes moonAge (= moonEclipticLong - sunEclipticLong) at local midnight ± n days.
    // Uses JS Date for DST-correct midnight (better than iOS, which is imprecise across DST).
    functions.set('moonDeltaEclipticLongitudeAtDeltaDay', (n: number) => {
        const nowDate = liveDate();
        // Midnight of the target day in local timezone (DST-aware)
        const targetMidnight = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + n);
        const requestedDI = dateToDateInterval(new Date(targetMidnight.getTime() - tzDeltaMs));
        return moonAge(requestedDI, null).age;
    });

    // --- DEL wedge color functions (iOS-style stable alternation) ---
    // Use Unix day number (continuous integer count from epoch) for parity,
    // not day-of-month, to avoid color swaps at month boundaries with odd-length
    // months (e.g. Jan 31→Feb 1 both odd). Consecutive Unix days always alternate.
    const MS_PER_DAY = 86400000;
    functions.set('delOnDayTintColor', (n: number) => {
        const dayNum = Math.floor(liveDate().getTime() / MS_PER_DAY);
        return ((dayNum + n) % 2 === 0)
            ? env.variables.get('delOnDayTintColorA')!
            : env.variables.get('delOnDayTintColorB')!;
    });
    functions.set('delOnDayStrokeColor', (n: number) => {
        const dayNum = Math.floor(liveDate().getTime() / MS_PER_DAY);
        return ((dayNum + n) % 2 === 0)
            ? env.variables.get('delOnDayStrokeColorA')!
            : env.variables.get('delOnDayStrokeColorB')!;
    });
    functions.set('delOnDayTintNColor', (n: number) => {
        const dayNum = Math.floor(liveDate().getTime() / MS_PER_DAY);
        return ((dayNum + n) % 2 === 0)
            ? env.variables.get('delOnDayTintNColorA')!
            : env.variables.get('delOnDayTintNColorB')!;
    });
    functions.set('delOnDayStrokeNColor', (n: number) => {
        const dayNum = Math.floor(liveDate().getTime() / MS_PER_DAY);
        return ((dayNum + n) % 2 === 0)
            ? env.variables.get('delOnDayStrokeNColorA')!
            : env.variables.get('delOnDayStrokeNColorB')!;
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
    functions.set('advanceYear', () => 0);
    functions.set('advanceYears', (_n: number) => 0);
    functions.set('advanceToNextMoonPhase', () => 0);
    functions.set('batteryLevel', () => 1.0);  // always full
    functions.set('goodAccuracy', () => 1);
    functions.set('heading', () => 0);

    // Timezone
    functions.set('tzOffset', () => tzOffsetSeconds);
    functions.set('tzOffsetAngle', () => tzOffsetSeconds * Math.PI / (12 * 3600));

    // Observer longitude in radians (used by Mauna Kea angle expressions)
    functions.set('longitude', () => OBSERVER_LON);

    // Observer latitude in radians (used by Gaia to flip moon for southern hemisphere)
    functions.set('latitude', () => OBSERVER_LAT);

    // Calendar wheel helpers
    // Derive calendarWeekdayStart from browser locale (Intl.Locale.getWeekInfo().firstDay).
    // getWeekInfo returns 1=Monday..7=Sunday; iOS uses 0=Sunday..6=Saturday.
    let calendarWeekdayStart = 0;  // default Sunday
    try {
        const locale = new Intl.Locale(navigator.language);
        // getWeekInfo is the modern standard; some browsers may also have .weekInfo property.
        const weekInfo = (locale as any).getWeekInfo?.() ?? (locale as any).weekInfo;
        if (weekInfo && typeof weekInfo.firstDay === 'number') {
            // Convert: getWeekInfo 1=Mon..7=Sun → iOS 0=Sun..6=Sat
            calendarWeekdayStart = weekInfo.firstDay % 7;
        }
    } catch { /* leave as Sunday */ }
    env.variables.set('calendarWeekdayStart', calendarWeekdayStart);
    functions.set('calendarWeekdayStart', () => calendarWeekdayStart);

    // weekdayNumber: 0=Sunday through 6=Saturday (ported from ECWatchTime.m weekdayNumberUsingEnv)
    // iOS uses local epoch arithmetic. For the web, we can use the tz-shifted date's getDay().
    const weekdayNumber = (): number => {
        const di = dateToDateInterval(getNow());
        return weekdayFromTimeInterval(di, tzOffsetSeconds);
    };

    // weekdayNumberAsCalendarColumn: adjusts weekday by calendarWeekdayStart
    // (ported from ECWatchTime.m weekdayNumberAsCalendarColumnUsingEnv)
    const weekdayNumberAsCalendarColumn = (): number => {
        return (7 + weekdayNumber() - calendarWeekdayStart) % 7;
    };

    // columnOfFirstOfMonth: computes which column (0-6) the 1st of the current month falls in.
    // (ported from ECGLWatch.m columnOfFirstOfMonth)
    // Note: Does not work for October 1582 after the transition — that's handled separately.
    const columnOfFirstOfMonth = (): number => {
        const cs = getLocalComponents();
        const dayOfMonth = cs.day - 1;  // 0-indexed (1st = 0)
        const wd = weekdayNumberAsCalendarColumn();
        return (wd + 7 - (dayOfMonth % 7)) % 7;
    };

    functions.set('calendarColumn', () => weekdayNumberAsCalendarColumn());

    // calendarRow: which row (0-based) the current day falls in within the month grid.
    // (ported from ECGLWatch.m calendarRow, with October 1582 handling)
    functions.set('calendarRow', () => {
        const cs = getLocalComponents();
        let dayNumber = cs.day - 1;  // 0-indexed
        let firstCol = columnOfFirstOfMonth();
        // October 1582 CE: days 5-14 were skipped.  The calendar wheel inserts
        // a 7-slot (one-row) blank gap where the missing days were, so days 15+
        // need dayNumber reduced by only 3 (10 skipped days - 7 gap slots).
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1 && dayNumber > 4) {
            dayNumber -= 3;
            firstCol = (8 - calendarWeekdayStart) % 7;  // Oct 1582 started on a Monday
        }
        const cellNumber = dayNumber + firstCol;
        return Math.floor(cellNumber / 7);
    });

    // rotationForCalendarWheel012B(weekdayStart): rotation angle for the "012B" calendar wheel.
    // (ported from ECGLWatch.m rotationForCalendarWheel012BDesignedForWeekdayStart)
    functions.set('rotationForCalendarWheel012B', (wheelWeekdayStart: number) => {
        if (calendarWeekdayStart !== wheelWeekdayStart) return 0;
        // Oct 1582: the special Oct1582 wheel is visible; keep this one
        // at its cutout angle to avoid animation glitches during the transition.
        const cs = getLocalComponents();
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1) return 3 * Math.PI / 2;
        const wd1 = columnOfFirstOfMonth();
        if (wd1 > 2) return 3 * Math.PI / 2;  // The cutout section
        return wd1 * Math.PI / 2;
    });

    // rotationForCalendarWheel3456(weekdayStart): rotation angle for the "3456" calendar wheel.
    // (ported from ECGLWatch.m rotationForCalendarWheel3456DesignedForWeekdayStart)
    functions.set('rotationForCalendarWheel3456', (wheelWeekdayStart: number) => {
        if (calendarWeekdayStart !== wheelWeekdayStart) return 0;
        // Oct 1582: keep at quadrant 0 (which shows startColumn=3, hidden behind Oct1582 wheel)
        const cs = getLocalComponents();
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1) return 0;
        const wd1 = columnOfFirstOfMonth();
        if (wd1 < 4) return 0;
        return (wd1 - 3) * Math.PI / 2;
    });

    // rotationForCalendarWheelOct1582(weekdayStart): special case for October 1582.
    // (ported from ECGLWatch.m rotationForCalendarWheelOct1582DesignedForWeekdayStart)
    functions.set('rotationForCalendarWheelOct1582', (wheelWeekdayStart: number) => {
        if (calendarWeekdayStart !== wheelWeekdayStart) return 0;
        const cs = getLocalComponents();
        if (cs.year === 1582 && (cs.month - 1) === 9 && cs.era === 1) {
            return 0;  // It IS October 1582 CE
        }
        return Math.PI / 2;  // The cutout section
    });

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

    // --- Sun/Moon RA (radians) ---
    // iOS: [mainAstro sunRA] → sunRAandDecl().rightAscension
    functions.set('sunRA', () => {
        const di = dateToDateInterval(getNow());
        return sunRAandDecl(di, null).rightAscension;
    });
    functions.set('moonRA', () => {
        const di = dateToDateInterval(getNow());
        return moonRAAndDecl(di, null).rightAscension;
    });

    // --- minuteValue: fractional minutes (12:35:45 => 35.75) ---
    // iOS: ECWatchTime minuteValueUsingEnv: secondsSinceMidnightValue / 60 mod 60
    functions.set('minuteValue', () => {
        const now = liveDate();
        const secSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
        return fmod(secSinceMidnight / 60, 60);
    });
    functions.set('minuteValueAngle', () => {
        const now = liveDate();
        const secSinceMidnight = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
        return fmod(secSinceMidnight / 60, 60) * 2 * Math.PI / 60;
    });

    // --- Local Sidereal Time in seconds ---
    // iOS: [mainAstro localSiderealTime] returns seconds
    // Our localSiderealTime() returns radians; convert: sec = radians * 12*3600/π
    functions.set('lstValue', () => {
        const di = dateToDateInterval(getNow());
        const lstRadians = localSiderealTime(di, OBSERVER_LON, null);
        return lstRadians * (12 * 3600) / Math.PI;
    });

    // --- Lunar ascending node RA ---
    // iOS: [mainAstro moonAscendingNodeRA] — converts node ecliptic longitude to RA
    functions.set('lunarAscendingNodeRA', () => {
        const di = dateToDateInterval(getNow());
        const { julianCenturiesSince2000Epoch } = julianCenturiesSince2000EpochForDateInterval(di, null);
        const longitude = WB_MoonAscendingNodeLongitude(julianCenturiesSince2000Epoch);
        const { nutation, obliquity } = WB_nutationObliquity(julianCenturiesSince2000Epoch / 100);
        const { rightAscension } = raAndDeclO(0, longitude, obliquity);
        let ra = rightAscension;
        if (ra < 0) ra += 2 * Math.PI;
        return ra;
    });

    // --- Eclipse separation and kind ---
    // iOS: [mainAstro eclipseSeparation] → calculateEclipse().abstractSeparation
    functions.set('eclipseSeparation', () => {
        const di = dateToDateInterval(getNow());
        return calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, null).abstractSeparation;
    });
    // iOS: eclipseKind → maps enum to wheel value (0-based with "none" collapsed)
    functions.set('eclipseKind', () => {
        const di = dateToDateInterval(getNow());
        let value = calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, null).eclipseKind;
        if (value > 0) value--;  // Wheel assumes one "none" value; collapse NoneSolar(0)/NoneLunar(5→4) gap
        return value;
    });
    // legacyEclipseKind: same as eclipseKind on iOS (Android-origin shim)
    functions.set('legacyEclipseKind', () => {
        const di = dateToDateInterval(getNow());
        let value = calculateEclipse(di, OBSERVER_LAT, OBSERVER_LON, null).eclipseKind;
        if (value > 0) value--;
        return value;
    });

    // --- year366IndicatorAngle ---
    // iOS: year366IndicatorFractionUsingEnv * 2π
    // Fraction of 366-day year (non-leap years skip Feb 29 → offset after Feb)
    functions.set('year366IndicatorAngle', () => {
        return computeYear366IndicatorFraction(liveDate()) * 2 * Math.PI;
    });

    // --- closestSunEclipticLongitudeQuarter366IndicatorAngle ---
    // iOS: finds time of closest equinox/solstice, converts to year366 indicator angle
    functions.set('closestSunEclipticLongitudeQuarter366IndicatorAngle', (quarterNumber: number) => {
        return computeClosestSunEclipticLongQuarter366Angle(quarterNumber, getNow(), tzDeltaMs);
    });

    // --- planetrise/set 24-hour indicator angle LST ---
    // iOS: dayNightLeafAngleForPlanetNumber:leafNumber:0/1:numLeaves:0:timeBaseKind:LST
    functions.set('planetrise24HourIndicatorAngleLST', (planetNumber: number) => {
        return computeDayNightLeafAngleLST(
            planetNumber, 0, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        );
    });
    functions.set('planetset24HourIndicatorAngleLST', (planetNumber: number) => {
        return computeDayNightLeafAngleLST(
            planetNumber, 1, 0,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        );
    });

    // --- Day/night ring leaf angle function (used by QdayNightRing) ---
    functions.set('dayNightLeafAngle', (planetNumber: number, leafNumber: number, numLeaves: number) => {
        return computeDayNightLeafAngle(
            planetNumber, leafNumber, numLeaves,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        );
    });

    // --- Day/night ring leaf angle function with LST time base (used by QdayNightRing with timeBase='LST') ---
    functions.set('dayNightLeafAngleLST', (planetNumber: number, leafNumber: number, numLeaves: number) => {
        return computeDayNightLeafAngleLST(
            planetNumber, leafNumber, numLeaves,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        );
    });

    // --- Planet transit 24-hour indicator angle (used by Miami) ---
    // iOS: planettransit24HourIndicatorAngle(planetNumber, numLeaves)
    //   = dayNightLeafAngle(planetNumber, numLeaves/2, numLeaves)
    // Android XML calls with 1 arg; numLeaves defaults to env variable planNumWedges
    functions.set('planettransit24HourIndicatorAngle', (planetNumber: number, numLeaves?: number) => {
        const nl = (numLeaves != null && numLeaves > 0) ? numLeaves : (env.variables.get('planNumWedges') || 24);
        return computeDayNightLeafAngle(
            planetNumber, nl / 2.0, nl,
            getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds
        );
    });

    // =========================================================================
    // Terra I — World-time ring functions
    // =========================================================================
    // Terra uses 24 environment slots (1–24) for the worldtime ring cities.
    // On iOS these were 5–28; renumbered to 1-based for the web app.
    // Ring sector 0 corresponds to env slot 1.

    // Build working slot data: start with defaults, apply any overrides.
    const terraRingDefaults: Record<number, TerraSlot> = {};
    for (const [k, v] of Object.entries(TERRA_RING_DEFAULTS)) {
        terraRingDefaults[Number(k)] = { ...v };
    }
    if (slotOverrides) {
        for (const [k, v] of Object.entries(slotOverrides)) {
            terraRingDefaults[Number(k)] = { ...v };
        }
    }

    // Export the slot data, getNow, and a DST range function
    // so the dynamic ring renderer can access them.
    (env as any)._terraSlots = terraRingDefaults;
    (env as any)._getNow = getNow;

    // Callable DST range function for the renderer: returns {low, high} offset
    // in hours if DST exists, or null if no DST.  Uses the same getTzOffsetSeconds
    // that powers isDST, evaluated at call time (no precomputation).
    (env as any)._getDSTRange = (slotNum: number): { lowHours: number; highHours: number } | null => {
        const slot = terraRingDefaults[slotNum];
        if (!slot) return null;
        const now = getNow();
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const janOff = getTzOffsetSeconds(slot.olsonId, jan);
        const julOff = getTzOffsetSeconds(slot.olsonId, jul);
        if (janOff === julOff) return null;
        return {
            lowHours: Math.min(janOff, julOff) / 3600,
            highHours: Math.max(janOff, julOff) / 3600,
        };
    };

    const UTCSectorNumber = 11;

    // --- Timezone offset computation via Intl.DateTimeFormat ---

    /**
     * Get the UTC offset in seconds for a given Olson timezone at a given Date.
     * Uses Intl.DateTimeFormat with 'longOffset' to parse "GMT+05:30" etc.
     * Falls back to 0 for out-of-range dates or unknown zones.
     */
    function getTzOffsetSeconds(olsonId: string, date: Date): number {
        try {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                timeZoneName: 'longOffset',
            });
            const parts = fmt.formatToParts(date);
            const tzPart = parts.find(p => p.type === 'timeZoneName');
            if (!tzPart) return 0;
            const tzStr = tzPart.value; // e.g. "GMT+05:30" or "GMT" or "GMT-08:00"
            if (tzStr === 'GMT' || tzStr === 'UTC') return 0;
            const m = tzStr.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
            if (!m) return 0;
            const sign = m[1] === '+' ? 1 : -1;
            const hours = parseInt(m[2], 10);
            const minutes = m[3] ? parseInt(m[3], 10) : 0;
            return sign * (hours * 3600 + minutes * 60);
        } catch {
            return 0; // graceful fallback for out-of-range dates
        }
    }

    /**
     * Get local time components in a given Olson timezone.
     * Returns hours (0-23), minutes, seconds, day (1-indexed), month (0-indexed), weekday (0=Sun).
     */
    function getLocalTimeInZone(olsonId: string, date: Date): {
        h24: number; min: number; sec: number; day: number; month: number; weekday: number;
    } {
        try {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                hour: 'numeric', minute: 'numeric', second: 'numeric',
                day: 'numeric', month: 'numeric', weekday: 'short',
                hour12: false,
            });
            const parts = fmt.formatToParts(date);
            let h24 = 0, min = 0, sec = 0, day = 1, month = 0, weekday = 0;
            for (const p of parts) {
                if (p.type === 'hour') h24 = parseInt(p.value, 10);
                else if (p.type === 'minute') min = parseInt(p.value, 10);
                else if (p.type === 'second') sec = parseInt(p.value, 10);
                else if (p.type === 'day') day = parseInt(p.value, 10);
                else if (p.type === 'month') month = parseInt(p.value, 10) - 1; // 0-indexed
                else if (p.type === 'weekday') {
                    const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
                    weekday = wdMap[p.value] ?? 0;
                }
            }
            // Intl may return 24 for midnight in hour24 mode
            if (h24 === 24) h24 = 0;
            return { h24, min, sec, day, month, weekday };
        } catch {
            // Fallback to local time if Intl fails
            return {
                h24: date.getHours(), min: date.getMinutes(), sec: date.getSeconds(),
                day: date.getDate(), month: date.getMonth(), weekday: date.getDay(),
            };
        }
    }

    // --- Determine which ring slot goes at the top (12 o'clock) ---
    // If the caller specified a global-location slot, use it directly.
    // Otherwise, auto-detect from the timezone (fallback for non-Terra faces).
    let detectedTopSlot = 12; // default: London (slot 12 = UTC)
    if (globalLocationSlot !== undefined) {
        detectedTopSlot = globalLocationSlot;
    } else {
        try {
            // Use the override timezone if set, otherwise fall back to browser timezone
            const targetTz = olsonTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
            // First try exact Olson ID match
            for (const [slotStr, data] of Object.entries(terraRingDefaults)) {
                if (data.olsonId === targetTz) {
                    detectedTopSlot = parseInt(slotStr, 10);
                    break;
                }
            }
            // If no exact match, match by offset
            if (detectedTopSlot === 12 && targetTz !== 'Europe/London' && targetTz !== 'UTC') {
                const nowDate = getNow();
                const targetOffset = getTzOffsetSeconds(targetTz, nowDate);
                let bestDiff = Infinity;
                for (const [slotStr, data] of Object.entries(terraRingDefaults)) {
                    const slotOffset = getTzOffsetSeconds(data.olsonId, nowDate);
                    const diff = Math.abs(slotOffset - targetOffset);
                    if (diff < bestDiff) {
                        bestDiff = diff;
                        detectedTopSlot = parseInt(slotStr, 10);
                    }
                }
            }
        } catch {
            // keep default
        }
    }

    // terraIDeviceSlot(): returns the ring slot for the "top" city (12 o'clock)
    functions.set('terraIDeviceSlot', () => detectedTopSlot);

    // overrideTerraITopSlot(n): button action stub (Phase 2)
    functions.set('overrideTerraITopSlot', (_n: number) => 0);

    // sectorAngle(slot, topSlot): angular position of a slot relative to top
    // (slot - topSlot) * π/12
    functions.set('sectorAngle', (slot: number, topSlot: number) => {
        return (slot - topSlot) * Math.PI / 12;
    });

    // UTCSectorOffset(): constant = UTCSectorNumber - 0.5 = 10.5
    functions.set('UTCSectorOffset', () => UTCSectorNumber - 0.5);

    // cityIndicatorOffset(topSlot, firstRingSlot): returns 0
    // (EC_OFFSET_CITY_INDICATOR is not defined)
    functions.set('cityIndicatorOffset', (_topSlot: number, _firstRingSlot: number) => 0);

    // city24HrDialOffset(topSlot, firstRingSlot):
    // The offset angle for the 24-hour dial indicator showing the top city's time.
    // iOS: tzOffset(topSlot) * π/(12*3600) + (firstRingSlot - topSlot + UTCSectorOffset) * π/12
    functions.set('city24HrDialOffset', (topSlot: number, firstRingSlot: number) => {
        const slot = terraRingDefaults[topSlot];
        if (!slot) return 0;
        const offsetSec = getTzOffsetSeconds(slot.olsonId, getNow());
        return offsetSec * Math.PI / (12 * 3600) + (firstRingSlot - topSlot + UTCSectorNumber - 0.5) * Math.PI / 12;
    });

    // tzOffsetAngleN(slot): timezone offset of slot's city as an angle
    // iOS: tzOffsetUsingEnv(env[slot]) * π / (12 * 3600)
    functions.set('tzOffsetAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const offsetSec = getTzOffsetSeconds(data.olsonId, getNow());
        return offsetSec * Math.PI / (12 * 3600);
    });

    // isDST(slot): whether the city in slot is currently observing DST
    functions.set('isDST', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const nowDate = getNow();
        const currentOffset = getTzOffsetSeconds(data.olsonId, nowDate);
        // Compare to January offset (standard time in Northern hemisphere)
        const jan = new Date(nowDate.getFullYear(), 0, 1);
        const janOffset = getTzOffsetSeconds(data.olsonId, jan);
        // Compare to July offset (standard time in Southern hemisphere)
        const jul = new Date(nowDate.getFullYear(), 6, 1);
        const julOffset = getTzOffsetSeconds(data.olsonId, jul);
        const stdOffset = Math.min(janOffset, julOffset);
        return currentOffset !== stdOffset ? 1 : 0;
    });

    // moreDay(slot, topSlot): whether slot's city is on a LATER day than topSlot's city
    // iOS: numberOfDaysOffsetFrom(slot, topSlot) > 0
    functions.set('moreDay', (slot: number, topSlot: number) => {
        const slotData = terraRingDefaults[slot];
        const topData = terraRingDefaults[topSlot];
        if (!slotData || !topData) return 0;
        const nowDate = getNow();
        const slotTime = getLocalTimeInZone(slotData.olsonId, nowDate);
        const topTime = getLocalTimeInZone(topData.olsonId, nowDate);
        // Compare day-of-month (simple but works for same-month; cross-month handled by sign)
        if (slotTime.month !== topTime.month) {
            // Different months: later month = more day
            // Handle year wrap: Dec vs Jan
            const slotM = slotTime.month;
            const topM = topTime.month;
            if (slotM === 0 && topM === 11) return 1; // slot is Jan, top is Dec
            if (slotM === 11 && topM === 0) return 0; // slot is Dec, top is Jan
            return slotM > topM ? 1 : 0;
        }
        return slotTime.day > topTime.day ? 1 : 0;
    });

    // lessDay(slot, topSlot): whether slot's city is on an EARLIER day than topSlot's city
    functions.set('lessDay', (slot: number, topSlot: number) => {
        const slotData = terraRingDefaults[slot];
        const topData = terraRingDefaults[topSlot];
        if (!slotData || !topData) return 0;
        const nowDate = getNow();
        const slotTime = getLocalTimeInZone(slotData.olsonId, nowDate);
        const topTime = getLocalTimeInZone(topData.olsonId, nowDate);
        if (slotTime.month !== topTime.month) {
            const slotM = slotTime.month;
            const topM = topTime.month;
            if (slotM === 0 && topM === 11) return 0;
            if (slotM === 11 && topM === 0) return 1;
            return slotM < topM ? 1 : 0;
        }
        return slotTime.day < topTime.day ? 1 : 0;
    });

    // --- N-suffixed time functions (per-slot time in the slot's timezone) ---

    // hour12ValueAngleN(slot): 12-hour angle in the slot's timezone
    functions.set('hour12ValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        const m = t.min + s / 60;
        const h = (t.h24 % 12) + m / 60;
        return h * 2 * Math.PI / 12;
    });

    // minuteValueAngleN(slot): minute angle in the slot's timezone
    functions.set('minuteValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        const m = t.min + s / 60;
        return m * 2 * Math.PI / 60;
    });

    // secondValueAngleN(slot): second angle in the slot's timezone
    functions.set('secondValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        return s * 2 * Math.PI / 60;
    });

    // dayNumberN(slot): day of month (0-indexed) in the slot's timezone
    functions.set('dayNumberN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        return t.day - 1; // 0-indexed like iOS dayNumber
    });

    // monthNumberAngleN(slot): month angle in the slot's timezone
    functions.set('monthNumberAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        return t.month * 2 * Math.PI / 12; // month is already 0-indexed
    });

    // weekdayNumberAngleN(slot): weekday angle in the slot's timezone
    functions.set('weekdayNumberAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        return t.weekday * 2 * Math.PI / 7;
    });

    // weekdayNumberN(slot): integer weekday (0=Sun, 6=Sat) — NOT an angle
    functions.set('weekdayNumberN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        return getLocalTimeInZone(data.olsonId, getNow()).weekday;
    });

    // hour24NumberN(slot): 24-hour integer (0–23) in the slot's timezone
    functions.set('hour24NumberN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        return getLocalTimeInZone(data.olsonId, getNow()).h24;
    });

    // hour24ValueAngleN(slot): continuous 24-hour angle in the slot's timezone
    functions.set('hour24ValueAngleN', (slot: number) => {
        const data = terraRingDefaults[slot];
        if (!data) return 0;
        const t = getLocalTimeInZone(data.olsonId, getNow());
        const ms = getNow().getMilliseconds();
        const s = t.sec + ms / 1000;
        const m = t.min + s / 60;
        const h = t.h24 + m / 60;
        return h * 2 * Math.PI / 24;
    });

    // dayNightLeafAngleForSlot(planet, leaf, numLeaves, slotNumber):
    // Like dayNightLeafAngle but uses the slot's city lat/lon for astronomy.
    functions.set('dayNightLeafAngleForSlot',
        (planetNumber: number, leafNumber: number, numLeaves: number, slotNumber: number) => {
            const slot = terraRingDefaults[slotNumber];
            if (!slot) {
                // Fallback to observer location
                return computeDayNightLeafAngle(
                    planetNumber, leafNumber, numLeaves,
                    getNow, OBSERVER_LAT, OBSERVER_LON, pool, tzOffsetSeconds,
                );
            }
            const slotLat = slot.lat * Math.PI / 180;
            const slotLon = slot.lon * Math.PI / 180;
            const slotTzOffset = getTzOffsetSeconds(slot.olsonId, getNow());
            return computeDayNightLeafAngle(
                planetNumber, leafNumber, numLeaves,
                getNow, slotLat, slotLon, pool, slotTzOffset,
            );
        },
    );

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
    // Compute local noon in the target timezone using UTC arithmetic
    const utcSec = calcDate + 978307200;
    const localSec = utcSec + tzOffsetSeconds;
    const dayStartSec = localSec - ((localSec % 86400) + 86400) % 86400;
    const noonDI = dayStartSec + 12 * 3600 - tzOffsetSeconds - 978307200;
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
function angle24HourForDate(dateInterval: number, tzOffsetSeconds: number): number {
    // Compute local time of day from the UTC dateInterval + timezone offset.
    // This avoids relying on browser-local getHours() which would be wrong
    // when the target timezone differs from the browser timezone.
    const utcSeconds = dateInterval + 978307200;  // Apple epoch to Unix epoch
    const localSeconds = utcSeconds + tzOffsetSeconds;
    const secondsInDay = ((localSeconds % 86400) + 86400) % 86400;  // mod to [0, 86400)
    const h = secondsInDay / 3600;
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

    // Use the actual planet (Sun or Moon) for altitude and rise/set
    const correctForParallax = planetNumber === ECPlanetNumber.Moon;
    const alt = planetAltAz(planetNumber, calcDate, observerLat, observerLon, correctForParallax, true, null);
    const planetIsUp = alt > 0;

    // Get rise time
    const riseTime = planetaryRiseSetTimeRefined(
        planetIsUp ? calcDate - fudgeSeconds - lookahead : calcDate + fudgeSeconds,
        observerLat, observerLon, true, planetNumber, NaN, pool,
    );
    // Get set time
    const setTime = planetaryRiseSetTimeRefined(
        planetIsUp ? calcDate + fudgeSeconds : calcDate - fudgeSeconds - lookahead,
        observerLat, observerLon, false, planetNumber, NaN, pool,
    );

    // Compute transit angles for fallback
    // Compute local noon and midnight in the target timezone using UTC arithmetic.
    // Find the start of the current local day, then add 12h (noon) or 0h (midnight).
    const utcNowSec = dateToDateInterval(getNow()) + 978307200;
    const localNowSec = utcNowSec + tzOffsetSeconds;
    const localDayStartSec = localNowSec - ((localNowSec % 86400) + 86400) % 86400;
    const noonUTCSec = localDayStartSec + 12 * 3600 - tzOffsetSeconds;
    const midnightUTCSec = localDayStartSec - tzOffsetSeconds;
    const noonDI = noonUTCSec - 978307200;
    const midnightDI = midnightUTCSec - 978307200;
    const rTransitAngle = angle24HourForDate(noonDI, tzOffsetSeconds);
    const sTransitAngle = angle24HourForDate(midnightDI, tzOffsetSeconds);

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

// ============================================================================
// Year-366 (leap year inclusive) indicator fraction
// ============================================================================

/**
 * Compute the fraction of the year for a 366-day (leap-scaled) indicator.
 * iOS: ECWatchTime year366IndicatorFractionUsingEnv
 * 
 * Maps non-leap years so they skip February 29th (adding 1 day to the offset).
 *
 * @param date - Current JS Date
 * @returns Fraction of 366 days [0, 1)
 */
function computeYear366IndicatorFraction(date: Date): number {
    const year = date.getFullYear();
    const month = date.getMonth();
    const dom = date.getDate();
    
    // Determine if current year is leap year
    const isLeap = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
    
    // Find start of year
    const startOfYear = new Date(year, 0, 1);
    
    // Difference in days from start of year to now
    let diffMs = date.getTime() - startOfYear.getTime();
    let daysSinceStart = diffMs / (1000 * 60 * 60 * 24);
    
    // Non-leap years: after Feb 28, add 1 full day so we skip the Feb 29 slot
    if (!isLeap && (month > 1 || (month === 1 && dom > 28))) {
        daysSinceStart += 1;
    }
    
    // 366 days in our scaled year
    return fmod(daysSinceStart / 366.0, 1.0);
}

// ============================================================================
// Closest sun ecliptic longitude quarter (equinox/solstice)
// ============================================================================

/**
 * Approximate time when sun ecliptic longitude hits target.
 * Uses tropical year ratio.
 */
function timeOfClosestSunEclipticLongitude(
    targetSunLong: number,
    tryDate: number,
): number {
    // Pass null for cache: each iteration uses a different tryDate,
    // so a shared cache would return stale sun longitude values.
    const sunLongForTryDate = sunEclipticLongitudeForDate(tryDate, null);
    const howFarAway = targetSunLong - sunLongForTryDate;
    let deltaAngleToTarget: number;
    if (howFarAway >= 0) {
        if (howFarAway >= Math.PI) {
            deltaAngleToTarget = howFarAway - 2 * Math.PI;
        } else {
            deltaAngleToTarget = howFarAway;
        }
    } else if (howFarAway >= -Math.PI) {
        deltaAngleToTarget = howFarAway;
    } else {
        deltaAngleToTarget = howFarAway + 2 * Math.PI;
    }
    
    const kECSecondsInTropicalYear = 3600.0 * 24 * 365.2422;
    return tryDate + deltaAngleToTarget * kECSecondsInTropicalYear / (2 * Math.PI);
}

/**
 * Refine the closest equinox/solstice time and return its year366 fraction angle.
 * iOS: closestSunEclipticLongitudeQuarter366IndicatorAngle
 * quarterNumber: 0=vernal eq, 1=summer sol, 2=autumn eq, 3=winter sol
 */
function computeClosestSunEclipticLongQuarter366Angle(
    quarterNumber: number,
    nowDate: Date,
    tzDeltaMs: number,
): number {
    const calcDate = dateToDateInterval(nowDate);
    const targetSunLong = quarterNumber * Math.PI / 2;
    
    // Iterative refinement (4 steps like iOS)
    let tryDate = timeOfClosestSunEclipticLongitude(targetSunLong, calcDate);
    tryDate = timeOfClosestSunEclipticLongitude(targetSunLong, tryDate);
    tryDate = timeOfClosestSunEclipticLongitude(targetSunLong, tryDate);
    const targetTime = timeOfClosestSunEclipticLongitude(targetSunLong, tryDate);
    
    // Convert target interval to year366 fraction (tz-shifted for local calendar)
    const targetDate = new Date((targetTime + 978307200) * 1000 + tzDeltaMs);
    return computeYear366IndicatorFraction(targetDate) * 2 * Math.PI;
}

// ============================================================================
// LST variant of day/night leaf angle
// ============================================================================

/**
 * Compute the LST 24-hour angle for a given time.
 */
function angle24HourLSTForDate(dateInterval: number, observerLon: number): number {
    const lstRadians = localSiderealTime(dateInterval, observerLon, null);
    return fmod(lstRadians, 2 * Math.PI);
}

/**
 * Compute day/night leaf angle using LST.
 * Same logic as computeDayNightLeafAngle, but returns an LST angle.
 */
function computeDayNightLeafAngleLST(
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

    // Use the actual planet (Sun or Moon) for altitude and rise/set
    const correctForParallax = planetNumber === ECPlanetNumber.Moon;
    const alt = planetAltAz(planetNumber, calcDate, observerLat, observerLon, correctForParallax, true, null);
    const planetIsUp = alt > 0;

    // Get rise time
    const riseTime = planetaryRiseSetTimeRefined(
        planetIsUp ? calcDate - fudgeSeconds - lookahead : calcDate + fudgeSeconds,
        observerLat, observerLon, true, planetNumber, NaN, pool,
    );
    // Get set time
    const setTime = planetaryRiseSetTimeRefined(
        planetIsUp ? calcDate + fudgeSeconds : calcDate - fudgeSeconds - lookahead,
        observerLat, observerLon, false, planetNumber, NaN, pool,
    );

    // Compute transit angles for fallback
    const now = getNow();
    const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    
    let riseTimeAngle = isNoRiseSet(riseTime) ? NaN : angle24HourLSTForDate(riseTime, observerLon);
    let setTimeAngle = isNoRiseSet(setTime) ? NaN : angle24HourLSTForDate(setTime, observerLon);
    const rTransitAngle = angle24HourLSTForDate(dateToDateInterval(noon), observerLon);
    const sTransitAngle = angle24HourLSTForDate(dateToDateInterval(midnight), observerLon);

    // Special case: numLeaves == 0
    if (numLeaves === 0) {
        if (leafNumber === 0) { // Rise
            if (isNaN(riseTimeAngle)) {
                return rTransitAngle; // Fallback
            } else {
                return riseTimeAngle;
            }
        } else if (leafNumber === 1) { // Set
            if (isNaN(setTimeAngle)) {
                return sTransitAngle; // Fallback
            } else {
                return setTimeAngle;
            }
        }
        return 0; // polar checks not done here
    }

    const leafWidth = 2 * Math.PI / numLeaves;

    // Handle NaN cases — match iOS logic exactly
    if (isNaN(riseTimeAngle)) {
        if (isNaN(setTimeAngle)) {
            let sTA = sTransitAngle;
            if (sTA > rTransitAngle + Math.PI) sTA -= 2 * Math.PI;
            else if (sTA < rTransitAngle - Math.PI) sTA += 2 * Math.PI;
            const avgTransit = (rTransitAngle + sTA) / 2;
            if (isNoRiseSet(riseTime) && riseTime === kECAlwaysAboveHorizon) {
                riseTimeAngle = avgTransit - Math.PI;
                setTimeAngle = avgTransit + Math.PI;
            } else {
                riseTimeAngle = avgTransit - leafWidth / 2 - 0.00001;
                setTimeAngle = avgTransit + leafWidth / 2 + 0.00001;
            }
        } else {
            if (isNoRiseSet(riseTime) && riseTime === kECAlwaysAboveHorizon) {
                riseTimeAngle = setTimeAngle - 2 * Math.PI;
            } else {
                riseTimeAngle = setTimeAngle - leafWidth;
            }
        }
    } else if (isNaN(setTimeAngle)) {
        if (isNoRiseSet(setTime) && setTime === kECAlwaysAboveHorizon) {
            setTimeAngle = riseTimeAngle + 2 * Math.PI;
        } else {
            setTimeAngle = riseTimeAngle + leafWidth;
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
