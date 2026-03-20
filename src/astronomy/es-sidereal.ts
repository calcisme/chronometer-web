/**
 * Sidereal time conversions.
 *
 * Ported from ESAstronomy.cpp: GST/LST conversions using the P03 precession model.
 *
 * All angles are in radians unless otherwise noted.
 * All time intervals are seconds since Apple epoch (Jan 1, 2001 00:00:00 UTC).
 */

import { fmod, kECUTUnitsPerGSTUnit } from './astro-constants';
import { AstroCache, AstroCachePool, pushECAstroCacheInPool, popECAstroCacheToInPool } from './astro-cache';
import {
    julianCenturiesSince2000EpochForDateInterval,
    priorUTMidnightForDateInterval,
} from './es-time';

const TWO_PI = Math.PI * 2;

// ============================================================================
// GST ↔ LST conversions
// ============================================================================

/**
 * Convert LST (Local Sidereal Time) to GST (Greenwich Sidereal Time).
 * Returns { gst, dayOffset } where dayOffset is -1, 0, or 1.
 */
export function convertLSTtoGST(
    lst: number,
    observerLongitude: number,
): { gst: number; dayOffset: number } {
    let gst = lst - observerLongitude;
    let dayOffset = 0;
    if (gst < 0) {
        gst += TWO_PI;
        dayOffset = -1;
    } else if (gst > TWO_PI) {
        gst -= TWO_PI;
        dayOffset = 1;
    }
    return { gst, dayOffset };
}

/**
 * Convert GST (Greenwich Sidereal Time) to LST (Local Sidereal Time).
 */
export function convertGSTtoLST(
    gst: number,
    observerLongitude: number,
): number {
    let lst = gst + observerLongitude;
    if (lst < 0) {
        lst += TWO_PI;
    } else if (lst > TWO_PI) {
        lst -= TWO_PI;
    }
    return lst;
}

// ============================================================================
// UT ↔ GST conversions  (P03 precession model)
// ============================================================================

/**
 * Convert UT to GST using the P03 precession model.
 * Internal function that takes pre-computed parameters.
 *
 * @param centuriesSinceEpochTDT - TDT Julian centuries since J2000.0
 * @param deltaTSeconds - Delta T in seconds
 * @param utSinceMidnightRadians - UT since midnight, in radians (1h = π/12)
 * @param _priorUTMidnight - unused but kept for API compatibility
 */
function convertUTToGSTP03x(
    centuriesSinceEpochTDT: number,
    deltaTSeconds: number,
    utSinceMidnightRadians: number,
    _priorUTMidnight: number,
): number {
    const t = centuriesSinceEpochTDT;
    const tu = t - deltaTSeconds / (24 * 3600 * 36525);
    const t2 = t * t;
    const t3 = t2 * t;
    const t4 = t2 * t2;
    const t5 = t3 * t2;

    // GMST in seconds of time
    let gmst = 24110.5493771
        + 8640184.79447825 * tu
        + 307.4771013 * (t - tu)
        + 0.092772110 * t2
        - 0.0000002926 * t3
        - 0.00000199708 * t4
        - 0.000000002454 * t5;

    // Convert from seconds to radians
    gmst *= Math.PI / (12.0 * 3600);

    // Add UT since midnight
    gmst += utSinceMidnightRadians;

    // Normalize to [0, 2π)
    gmst = fmod(gmst, TWO_PI);
    if (gmst < 0) {
        gmst += TWO_PI;
    }

    return gmst;
}

/**
 * Convert a UT date interval to Greenwich Sidereal Time (radians) using P03 model.
 */
export function convertUTToGSTP03(
    calculationDate: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch, deltaT } =
        julianCenturiesSince2000EpochForDateInterval(calculationDate, cache);
    const priorUTMidnightD = priorUTMidnightForDateInterval(calculationDate, cache);
    const utRadiansSinceMidnight = (calculationDate - priorUTMidnightD) * Math.PI / (12 * 3600);
    return convertUTToGSTP03x(julianCenturiesSince2000Epoch, deltaT, utRadiansSinceMidnight, priorUTMidnightD);
}

/**
 * Convert GST to UT (returns UT in radians since midnight, plus a potential second UT).
 * There may be two UT values for a given GST; ut2 is set to -1 if there is only one.
 */
export function convertGSTtoUT(
    gst: number,
    priorUTMidnight: number,
    cachePool: AstroCachePool | null,
): { ut: number; ut2: number } {
    let priorCache: AstroCache | null = null;
    if (cachePool) {
        priorCache = pushECAstroCacheInPool(cachePool, cachePool.midnightCache, priorUTMidnight);
    }

    const { julianCenturiesSince2000Epoch, deltaT } =
        julianCenturiesSince2000EpochForDateInterval(
            priorUTMidnight,
            cachePool ? cachePool.currentCache : null,
        );

    const T0 = convertUTToGSTP03x(julianCenturiesSince2000Epoch, deltaT, 0, priorUTMidnight);

    if (cachePool && priorCache !== undefined) {
        popECAstroCacheToInPool(cachePool, priorCache);
    }

    let ut = gst - T0;
    if (ut < 0) {
        ut += TWO_PI;
    } else if (ut > TWO_PI) {
        ut -= TWO_PI;
    }
    ut *= kECUTUnitsPerGSTUnit;

    let ut2 = ut + kECUTUnitsPerGSTUnit * TWO_PI;
    if (ut2 > TWO_PI) {
        ut2 = -1; // only one UT for this GST
    }

    return { ut, ut2 };
}

/**
 * Convert GST to UT, finding the UT closest to a given target date.
 */
export function convertGSTtoUTclosest(
    gst: number,
    closestToThisDate: number,
    cachePool: AstroCachePool | null,
): number {
    let priorUTMidnightD = priorUTMidnightForDateInterval(
        closestToThisDate,
        cachePool ? cachePool.currentCache : null,
    );

    // Calculate answer for this UT date
    let { ut: ut0, ut2: ut0_2 } = convertGSTtoUT(gst, priorUTMidnightD, cachePool);
    let utSecondsSinceMidnight = ut0 * (12 * 3600) / Math.PI;
    let utD = priorUTMidnightD + utSecondsSinceMidnight;

    // If answer is less than target date - 12h, try the next UT date
    if (utD < closestToThisDate - 12 * 3600.0 * kECUTUnitsPerGSTUnit) {
        if (ut0_2 > 0) {
            ut0 = ut0_2;
            utSecondsSinceMidnight = ut0 * (12 * 3600) / Math.PI;
            utD = priorUTMidnightD + utSecondsSinceMidnight;
        } else {
            priorUTMidnightD += 24 * 3600.0;
            ({ ut: ut0, ut2: ut0_2 } = convertGSTtoUT(gst, priorUTMidnightD, cachePool));
            utSecondsSinceMidnight = ut0 * (12 * 3600) / Math.PI;
            utD = priorUTMidnightD + utSecondsSinceMidnight;
        }
    } else if (utD > closestToThisDate + 12 * 3600.0 * kECUTUnitsPerGSTUnit) {
        priorUTMidnightD -= 24 * 3600.0;
        ({ ut: ut0, ut2: ut0_2 } = convertGSTtoUT(gst, priorUTMidnightD, cachePool));
        if (ut0_2 > 0) {
            ut0 = ut0_2;
        }
        utSecondsSinceMidnight = ut0 * (12 * 3600) / Math.PI;
        utD = priorUTMidnightD + utSecondsSinceMidnight;
    }

    return utD;
}

/**
 * Compute the difference between GST and UT for a given date.
 * Returns the sidereal-UT offset in radians.
 */
export function GSTDifferenceForDate(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch, deltaT } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const priorUTMidnightD = priorUTMidnightForDateInterval(dateInterval, cache);
    const utRadiansSinceMidnight = (dateInterval - priorUTMidnightD) * Math.PI / (12 * 3600);
    const gst = convertUTToGSTP03x(julianCenturiesSince2000Epoch, deltaT, utRadiansSinceMidnight, priorUTMidnightD);
    return gst - utRadiansSinceMidnight;
}
