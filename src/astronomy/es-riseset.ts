/**
 * Rise/Set/Transit computation.
 *
 * Ported from ESAstronomy.cpp: iterative refinement algorithm for calculating
 * sunrise, sunset, moonrise, moonset, and transit times.
 *
 * The algorithm follows Meeus pp 102-103 with iterative refinement using
 * the extrapolateToYEqualX convergence accelerator from the original code.
 *
 * Times in Apple epoch seconds, angles in radians.
 */

import {
    fmod,
    ECPlanetNumber,
    ECWBPrecision,
    ALWAYS_ABOVE_HORIZON,
    ALWAYS_BELOW_HORIZON,
    isNoRiseSet,
    kECRefractionAtHorizonX,
    kECCivilTwilightAltitude,
    kECNauticalTwilightAltitude,
    kECAstroTwilightAltitude,
    kECGoldenHourAltitude,
} from './astro-constants';
import {
    AstroCache,
    AstroCachePool,
    CacheSlot,
    pushECAstroCacheWithSlopInPool,
    popECAstroCacheToInPool,
} from './astro-cache';
import { julianCenturiesSince2000EpochForDateInterval, priorUTMidnightForDateInterval } from './es-time';
import { convertLSTtoGST, convertGSTtoLST, convertUTToGSTP03, convertGSTtoUTclosest } from './es-sidereal';
import { sunRAandDecl, moonRAAndDecl, altitudeAtRiseSet } from './es-coordinates';
import { WB_sunRAAndDecl } from './wb-sun';
import { WB_MoonRAAndDecl, WB_MoonDistance } from './wb-moon';
import { WB_planetApparentPosition } from './willmann-bell';

const TWO_PI = Math.PI * 2;

// ============================================================================
// Core rise/set time calculation (single iteration)
// ============================================================================

/**
 * Calculate rise or set time for an object with given RA/Decl.
 * Based on Meeus pp 102-103 (without delta-m correction).
 *
 * Returns the date interval of the rise/set event, or ALWAYS_ABOVE_HORIZON / ALWAYS_BELOW_HORIZON.
 */
function riseSetTime(
    riseNotSet: boolean,
    rightAscension: number,
    declination: number,
    observerLatitude: number,
    observerLongitude: number,
    altAtRiseSet: number,
    calculationDateInterval: number,
    cachePool: AstroCachePool | null,
): number {
    const cosH = (Math.sin(altAtRiseSet) - Math.sin(observerLatitude) * Math.sin(declination))
        / (Math.cos(observerLatitude) * Math.cos(declination));

    if (cosH < -1.0) {
        return ALWAYS_ABOVE_HORIZON; // always above the horizon
    } else if (cosH > 1.0) {
        return ALWAYS_BELOW_HORIZON; // always below the horizon
    }

    const H = Math.acos(cosH);
    let LST_rs = rightAscension + (riseNotSet ? TWO_PI - H : H);
    if (LST_rs > TWO_PI) {
        LST_rs -= TWO_PI;
    }

    const { gst: GST_rs } = convertLSTtoGST(LST_rs, observerLongitude);
    const riseSetDate = convertGSTtoUTclosest(GST_rs, calculationDateInterval, cachePool);
    return riseSetDate;
}

// ============================================================================
// Transit time
// ============================================================================

/**
 * Calculate the transit time (meridian crossing) for an object.
 */
function transitTime(
    dateInterval: number,
    wantHighTransit: boolean,
    observerLongitude: number,
    rightAscension: number,
    currentCache: AstroCache | null,
): number {
    const gst = convertUTToGSTP03(dateInterval, currentCache);
    let ra = rightAscension;
    if (!wantHighTransit) {
        ra += Math.PI;
    }
    let hourAngle = fmod(gst + observerLongitude - ra, TWO_PI);
    if (hourAngle > Math.PI) {
        hourAngle -= TWO_PI;
    } else if (hourAngle < -Math.PI) {
        hourAngle += TWO_PI;
    }
    return dateInterval - hourAngle * (12 * 3600) / Math.PI;
}

// ============================================================================
// Convergence accelerator
// ============================================================================

/**
 * Linear fit: find where y = x on the line through (X1,Y1) and (X2,Y2).
 */
function linearFit(X1: number, Y1: number, X2: number, Y2: number): number {
    const offset = X1;
    const x1 = 0;
    const y1 = Y1 - offset;
    const x2 = X2 - offset;
    const y2 = Y2 - offset;
    const denom = x2 - x1 - y2 + y1;
    if (denom === 0) {
        return y2 + offset;
    }
    const root = (y1 * (x2 - x1) - x1 * (y2 - y1)) / denom;
    if (Math.abs(root - y2) > 12 * 3600) {
        return y2 + offset;
    }
    return offset + root;
}

/**
 * Extrapolate to find x where f(x) = x, using parabolic/linear fitting.
 * From the original ESAstronomy.cpp.
 */
function extrapolateToYEqualX(x: number[], y: number[], numValues: number): number {
    if (numValues === 1) {
        return y[0];
    }

    if (numValues > 2) {
        const offset = x[numValues - 3];
        const X1 = 0;
        const Y1 = y[numValues - 3] - offset;
        const X2 = x[numValues - 2] - offset;
        const Y2 = y[numValues - 2] - offset;
        const X3 = x[numValues - 1] - offset;
        const Y3 = y[numValues - 1] - offset;

        if (X1 !== X2 && X1 !== X3 && X2 !== X3) {
            const k1 = Y1 / ((X1 - X2) * (X1 - X3));
            const k2 = Y2 / ((X2 - X1) * (X2 - X3));
            const k3 = Y3 / ((X3 - X1) * (X3 - X2));

            const C2 = k1 + k2 + k3;
            const C1 = k1 * (X2 + X3) + k2 * (X1 + X3) + k3 * (X1 + X2);
            const C0 = k1 * X2 * X3 + k2 * X1 * X3 + k3 * X1 * X2;

            if (C2 !== 0) {
                const p = (-C1 - 1) / C2;
                const q = C0 / C2;
                const D = p * p / 4 - q;
                if (D >= 0) {
                    const sqrtTerm = Math.sqrt(D);
                    const root1 = -p / 2 + sqrtTerm;
                    const root2 = -p / 2 - sqrtTerm;
                    if (Math.abs(root1 - Y3) < Math.abs(root2 - Y3)) {
                        if (Math.abs(root1 - Y3) < 24 * 3600) {
                            return root1 + offset;
                        }
                    } else {
                        if (Math.abs(root2 - Y3) < 24 * 3600) {
                            return root2 + offset;
                        }
                    }
                }
            }
        }
    }

    return linearFit(x[numValues - 2], y[numValues - 2], x[numValues - 1], y[numValues - 1]);
}

// ============================================================================
// Iterative rise/set refinement (the main algorithm)
// ============================================================================

/**
 * Get planet RA/Decl for a given date (dispatches to Sun or Moon).
 * Returns { rightAscension, declination, distance }.
 */
function getPlanetRADeclDist(
    planetNumber: number,
    julianCenturiesSince2000Epoch: number,
    cache: AstroCache | null,
    precision: ECWBPrecision,
): { rightAscension: number; declination: number; distance: number } {
    if (planetNumber === ECPlanetNumber.Sun) {
        const result = WB_sunRAAndDecl(julianCenturiesSince2000Epoch / 100, cache ?? undefined);
        return {
            rightAscension: result.rightAscension,
            declination: result.declination,
            distance: 1.0, // approximate; will use WB_sunRadius for precise
        };
    } else if (planetNumber === ECPlanetNumber.Moon) {
        const result = WB_MoonRAAndDecl(julianCenturiesSince2000Epoch, cache ?? undefined, precision);
        const distKm = WB_MoonDistance(julianCenturiesSince2000Epoch, cache ?? undefined, precision);
        return {
            rightAscension: result.rightAscension,
            declination: result.declination,
            distance: distKm / 149597870.691,
        };
    } else {
        // Other planets: use WB_planetApparentPosition
        const pos = WB_planetApparentPosition(
            planetNumber as ECPlanetNumber,
            julianCenturiesSince2000Epoch / 100,
            cache ?? undefined,
        );
        return {
            rightAscension: pos.apparentRightAscension,
            declination: pos.apparentDeclination,
            distance: pos.geocentricDistance,
        };
    }
}

/**
 * Iterative rise/set computation for Sun or Moon.
 * Follows the full algorithm from ESAstronomy.cpp:planetaryRiseSetTimeRefined.
 *
 * @param calculationDateInterval - Starting date for the search
 * @param observerLatitude - Observer latitude (radians)
 * @param observerLongitude - Observer longitude (radians, east positive)
 * @param riseNotSet - true for rise, false for set
 * @param planetNumber - ECPlanetNumber
 * @param overrideAltitudeDesired - Override the default altitude at rise/set (NaN for default)
 * @param cachePool - AstroCachePool for computation
 * @returns Date interval of the rise/set event, or ALWAYS_ABOVE_HORIZON/ALWAYS_BELOW_HORIZON
 */
export function planetaryRiseSetTimeRefined(
    calculationDateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    riseNotSet: boolean,
    planetNumber: number,
    overrideAltitudeDesired: number,
    cachePool: AstroCachePool,
): number {
    let tryDate = calculationDateInterval;
    let precision: ECWBPrecision = planetNumber === ECPlanetNumber.Moon
        ? ECWBPrecision.Low : ECWBPrecision.Full;

    const numIterations = 20;
    const tryDates: number[] = new Array(numIterations + 11);
    const results: number[] = new Array(numIterations + 11);
    let fitTries = 0;

    for (let i = 0; i < numIterations; i++) {
        // Upgrade Moon precision near the end
        if (planetNumber === ECPlanetNumber.Moon && i === numIterations - 1 && precision !== ECWBPrecision.Full) {
            precision = ECWBPrecision.Full;
            i--;
            fitTries = 0;
        }

        const priorCache = pushECAstroCacheWithSlopInPool(
            cachePool, cachePool.refinementCache, tryDate, 0,
        );

        const { julianCenturiesSince2000Epoch } =
            julianCenturiesSince2000EpochForDateInterval(tryDate, cachePool.currentCache);

        const { rightAscension, declination } = getPlanetRADeclDist(
            planetNumber, julianCenturiesSince2000Epoch, cachePool.currentCache, precision,
        );

        const altitude = isNaN(overrideAltitudeDesired)
            ? altitudeAtRiseSet(julianCenturiesSince2000Epoch, planetNumber, true, cachePool.currentCache, precision)
            : overrideAltitudeDesired;

        const newDate = riseSetTime(
            riseNotSet, rightAscension, declination,
            observerLatitude, observerLongitude,
            altitude, tryDate, cachePool,
        );

        popECAstroCacheToInPool(cachePool, priorCache);

        if (isNoRiseSet(newDate)) {
            // No rise/set at this time — the object is always above or below
            // For simplicity, return the sentinel
            return newDate;
        }

        if (Math.abs(newDate - tryDate) < 0.1) {
            if (planetNumber === ECPlanetNumber.Moon && precision !== ECWBPrecision.Full) {
                precision = ECWBPrecision.Full;
            } else {
                return newDate;
            }
        }

        tryDates[fitTries] = tryDate;
        results[fitTries] = newDate;
        fitTries++;
        tryDate = extrapolateToYEqualX(tryDates, results, fitTries);
    }

    return tryDate;
}

/**
 * Calculate transit time for a planet, with iterative refinement.
 */
export function planettransitTimeRefined(
    calculationDateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    wantHighTransit: boolean,
    planetNumber: number,
    cachePool: AstroCachePool,
): number {
    let tryDate = calculationDateInterval;
    let precision: ECWBPrecision = planetNumber === ECPlanetNumber.Moon
        ? ECWBPrecision.Low : ECWBPrecision.Full;

    const numIterations = 7;
    const tryDates: number[] = new Array(numIterations);
    const results_arr: number[] = new Array(numIterations);
    let fitTries = 0;

    for (let i = 0; i < numIterations; i++) {
        if (planetNumber === ECPlanetNumber.Moon && i === numIterations - 1 && precision !== ECWBPrecision.Full) {
            precision = ECWBPrecision.Full;
            i--;
            fitTries = 0;
        }

        const priorCache = pushECAstroCacheWithSlopInPool(
            cachePool, cachePool.refinementCache, tryDate, 0,
        );

        const { julianCenturiesSince2000Epoch } =
            julianCenturiesSince2000EpochForDateInterval(tryDate, cachePool.currentCache);

        const { rightAscension } = getPlanetRADeclDist(
            planetNumber, julianCenturiesSince2000Epoch, cachePool.currentCache, precision,
        );

        const newDate = transitTime(
            tryDate, wantHighTransit, observerLongitude,
            rightAscension, cachePool.currentCache,
        );

        popECAstroCacheToInPool(cachePool, priorCache);

        if (Math.abs(newDate - tryDate) < 0.1) {
            if (planetNumber === ECPlanetNumber.Moon && precision !== ECWBPrecision.Full) {
                precision = ECWBPrecision.Full;
            } else {
                return newDate;
            }
        }

        tryDates[fitTries] = tryDate;
        results_arr[fitTries] = newDate;
        fitTries++;
        tryDate = extrapolateToYEqualX(tryDates, results_arr, fitTries);
    }

    return tryDate;
}

// ============================================================================
// "For day" wrappers (find rise/set closest to the given day)
// ============================================================================

/**
 * Find sunrise for the day containing the given date.
 * Uses the prior UT noon as the starting point for the search.
 */
export function sunriseForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cachePool: AstroCachePool,
): number {
    if (cachePool.currentCache && cachePool.currentCache.isValid(CacheSlot.sunriseForDay)) {
        return cachePool.currentCache.get(CacheSlot.sunriseForDay);
    }

    // Start search from UT noon of the day
    const midnight = priorUTMidnightForDateInterval(dateInterval, cachePool.currentCache);
    const noon = midnight + 12 * 3600;

    const result = planetaryRiseSetTimeRefined(
        noon, observerLatitude, observerLongitude,
        true, ECPlanetNumber.Sun, NaN, cachePool,
    );

    if (cachePool.currentCache) {
        cachePool.currentCache.set(CacheSlot.sunriseForDay, result);
    }

    return result;
}

/**
 * Find sunset for the day containing the given date.
 */
export function sunsetForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cachePool: AstroCachePool,
): number {
    if (cachePool.currentCache && cachePool.currentCache.isValid(CacheSlot.sunsetForDay)) {
        return cachePool.currentCache.get(CacheSlot.sunsetForDay);
    }

    const midnight = priorUTMidnightForDateInterval(dateInterval, cachePool.currentCache);
    const noon = midnight + 12 * 3600;

    const result = planetaryRiseSetTimeRefined(
        noon, observerLatitude, observerLongitude,
        false, ECPlanetNumber.Sun, NaN, cachePool,
    );

    if (cachePool.currentCache) {
        cachePool.currentCache.set(CacheSlot.sunsetForDay, result);
    }

    return result;
}

/**
 * Find sun transit (solar noon) for the day containing the given date.
 */
export function suntransitForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cachePool: AstroCachePool,
): number {
    if (cachePool.currentCache && cachePool.currentCache.isValid(CacheSlot.suntransitForDay)) {
        return cachePool.currentCache.get(CacheSlot.suntransitForDay);
    }

    const result = planettransitTimeRefined(
        dateInterval, observerLatitude, observerLongitude,
        true, ECPlanetNumber.Sun, cachePool,
    );

    if (cachePool.currentCache) {
        cachePool.currentCache.set(CacheSlot.suntransitForDay, result);
    }

    return result;
}

// ============================================================================
// Twilight times
// ============================================================================

/**
 * Find the time when the Sun crosses a given altitude boundary for the day.
 * Used for twilight calculations.
 *
 * @param riseNotSet - true for morning boundary, false for evening boundary
 * @param altitudeDesired - The target altitude in radians (e.g. kECCivilTwilightAltitude)
 */
export function sunAltitudeTimeForDay(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    riseNotSet: boolean,
    altitudeDesired: number,
    cachePool: AstroCachePool,
): number {
    const midnight = priorUTMidnightForDateInterval(dateInterval, cachePool.currentCache);
    const noon = midnight + 12 * 3600;

    return planetaryRiseSetTimeRefined(
        noon, observerLatitude, observerLongitude,
        riseNotSet, ECPlanetNumber.Sun, altitudeDesired, cachePool,
    );
}

/** Civil twilight start (morning). */
export function civilTwilightMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECCivilTwilightAltitude, pool);
}

/** Civil twilight end (evening). */
export function civilTwilightEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECCivilTwilightAltitude, pool);
}

/** Nautical twilight start (morning). */
export function nauticalTwilightMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECNauticalTwilightAltitude, pool);
}

/** Nautical twilight end (evening). */
export function nauticalTwilightEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECNauticalTwilightAltitude, pool);
}

/** Astronomical twilight start (morning). */
export function astroTwilightMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECAstroTwilightAltitude, pool);
}

/** Astronomical twilight end (evening). */
export function astroTwilightEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECAstroTwilightAltitude, pool);
}

/** Golden hour start (morning). */
export function goldenHourMorning(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, true, kECGoldenHourAltitude, pool);
}

/** Golden hour end (evening). */
export function goldenHourEvening(
    dateInterval: number, lat: number, lon: number, pool: AstroCachePool,
): number {
    return sunAltitudeTimeForDay(dateInterval, lat, lon, false, kECGoldenHourAltitude, pool);
}
