/**
 * Astronomical event stepping — computation module.
 *
 * Provides functions to find the next/previous occurrence of astronomical
 * events: sunrise, sunset, moon phase quarter, sun transit, moon transit,
 * and body transit (for Venezia).
 *
 * All functions return a Date or null (if no event found — e.g. polar latitudes).
 * All results are clamped to [4000 BCE, 2800 CE] via the TimeController boundary.
 */

import { dateToDateInterval, dateIntervalToDate } from '../astronomy/es-time.js';
import { moonAge, refineMoonAgeTargetForDate } from '../astronomy/es-astro.js';
import { planetaryRiseSetTimeRefined, planettransitTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet, fmod } from '../astronomy/astro-constants.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';

// ============================================================================
// Constants
// ============================================================================

/** Fudge factor: 5 seconds to avoid retriggering on exact boundaries. */
const FUDGE_SECONDS = 5;

/**
 * Fudge for transit search: half a solar day (~12 hours).
 * planettransitTimeRefined finds the CLOSEST transit, so starting from
 * only 5 seconds past a transit converges right back to it. We need to
 * start well past the current transit to ensure convergence to the next one.
 * Half a solar day is safe because transits are ~24h apart (sun) or ~24h50m (moon).
 */
const TRANSIT_FUDGE_SECONDS = 12 * 3600;

/** Lookahead: 13.2 hours (matching iOS sentinel scheduling). */
const LOOKAHEAD_SECONDS = 3600 * 13.2;

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

// ============================================================================
// Rise / Set
// ============================================================================

/**
 * Find the next or previous rise/set event for a planet.
 *
 * Adapted from the sentinel scheduling function in animation.ts
 * (nextPlanetRiseSet), which ports iOS ECAstronomy nextPrevRiseSetInternal.
 *
 * @returns Date of the event, or null if no event found (polar edge case).
 */
export function findNextRiseSet(
    riseNotSet: boolean,
    planetNumber: ECPlanetNumber,
    displayTime: Date,
    direction: 1 | -1,
    lat: number,
    lon: number,
): Date | null {
    const calculationDI = dateToDateInterval(displayTime);
    const searchForward = direction === 1;

    const fudge = searchForward ? FUDGE_SECONDS : -FUDGE_SECONDS;
    const lookahead = searchForward ? LOOKAHEAD_SECONDS : -LOOKAHEAD_SECONDS;
    const fudgeDate = calculationDI + fudge;

    const pool = new AstroCachePool();
    initializeCachePool(pool, fudgeDate, lat, lon, !searchForward);

    try {
        // First attempt: search from fudged date
        const result = planetaryRiseSetTimeRefined(
            fudgeDate, lat, lon, riseNotSet, planetNumber, NaN, pool,
        );

        if (isNoRiseSet(result.riseSetTime)) {
            return null;  // object always above or below horizon
        }

        // Check if the transit time is in the right direction
        // (iOS: nextPrevRiseSetInternalWithFudgeInterval lines 2335-2337)
        const inRightDirection = searchForward
            ? result.transitTime >= fudgeDate
            : result.transitTime < fudgeDate;

        if (inRightDirection) {
            return dateIntervalToDate(result.riseSetTime);
        }

        // Not found on first try — search from 13.2 hours away
        const tryDate = fudgeDate + lookahead;
        releaseCachePool(pool);
        initializeCachePool(pool, tryDate, lat, lon, !searchForward);

        const result2 = planetaryRiseSetTimeRefined(
            tryDate, lat, lon, riseNotSet, planetNumber, NaN, pool,
        );

        if (isNoRiseSet(result2.riseSetTime)) {
            return null;
        }

        return dateIntervalToDate(result2.riseSetTime);
    } finally {
        releaseCachePool(pool);
    }
}

// ============================================================================
// Moon Phase
// ============================================================================

/**
 * Find the next or previous lunar quarter phase.
 *
 * Faithful port of iOS nextMoonPhase() / prevMoonPhase() from
 * ESAstronomy.cpp lines 3047-3101.
 *
 * The algorithm:
 * 1. Get current moon age angle
 * 2. Add a tiny fudge (0.01 rad ≈ 0.05 days) to avoid retriggering on
 *    the exact quarter we're sitting on
 * 3. fmod(age, π/2) → distance since the last exact quarter
 * 4. Compute the target age for the next (or previous) quarter
 * 5. Estimate a guess date using the synodic month ratio
 * 6. Refine iteratively to sub-second accuracy
 *
 * @returns Date of the next/previous quarter phase event.
 */
export function findNextQuarterPhase(
    displayTime: Date,
    direction: 1 | -1,
): Date {
    const di = dateToDateInterval(displayTime);
    const { age } = moonAge(di, null);

    // iOS: runningBackward for prevMoonPhase is !_watchTime->runningBackward()
    // For us: direction === -1 means "running backward" for this purpose
    const runningBackward = direction === -1;
    const fudgeFactor = runningBackward ? -0.01 : 0.01;

    // fmod(age + fudge, π/2) gives the angular distance since the last exact quarter
    const ageSinceQuarter = fmod(age + fudgeFactor, HALF_PI);
    const ageAtLastQuarter = age + fudgeFactor - ageSinceQuarter;

    // Target: for forward, advance to the next quarter (lastQuarter + π/2)
    // For backward, go back to the previous quarter (lastQuarter itself)
    let targetAge = runningBackward ? ageAtLastQuarter : ageAtLastQuarter + HALF_PI;

    // iOS: if targetAge > 15/8 * π, wrap around
    if (targetAge > 15.0 / 8 * Math.PI) {
        targetAge -= TWO_PI;
    }

    const phaseDI = refineMoonAgeTargetForDate(di, targetAge);
    return dateIntervalToDate(phaseDI);
}


// ============================================================================
// Transit (meridian passage)
// ============================================================================

/**
 * Find the next or previous transit (meridian passage) of a planet.
 *
 * Uses planettransitTimeRefined() with fudge factor and retry,
 * following the same pattern as the rise/set search.
 *
 * @returns Date of the transit, or null if not found.
 */
export function findNextTransit(
    planetNumber: ECPlanetNumber,
    displayTime: Date,
    direction: 1 | -1,
    lat: number,
    lon: number,
): Date | null {
    const di = dateToDateInterval(displayTime);
    // Use a large fudge: start searching from ~12 hours away so
    // planettransitTimeRefined converges to the NEXT transit, not
    // the one we're sitting on.
    const fudgeDate = di + direction * TRANSIT_FUDGE_SECONDS;

    const pool = new AstroCachePool();
    initializeCachePool(pool, fudgeDate, lat, lon, direction === -1);

    try {
        const result = planettransitTimeRefined(
            fudgeDate, lat, lon, true, planetNumber, pool,
        );

        // Validate the result is significantly past the current time
        // (more than 60 seconds away to avoid sub-second convergence artifacts)
        const delta = result - di;
        const inRightDirection = direction === 1
            ? delta > 60
            : delta < -60;

        if (inRightDirection) {
            return dateIntervalToDate(result);
        }

        // Fallback: shouldn't normally happen with 12h fudge, but
        // try from a full day away as last resort
        releaseCachePool(pool);
        const retryDate = di + direction * 86400;
        initializeCachePool(pool, retryDate, lat, lon, direction === -1);

        const result2 = planettransitTimeRefined(
            retryDate, lat, lon, true, planetNumber, pool,
        );

        return dateIntervalToDate(result2);
    } finally {
        releaseCachePool(pool);
    }
}

// ============================================================================
// Dispatcher
// ============================================================================

/** Recognized astronomical event types. */
export type AstroEventType =
    | 'sunrise' | 'sunset'
    | 'moonrise' | 'moonset'
    | 'moonphase'
    | 'sun-transit' | 'moon-transit'
    | 'body-rise' | 'body-set' | 'body-transit';

/**
 * Compute the target time for an astronomical event step.
 *
 * @param eventType  Which event to step to
 * @param direction  1 = forward, -1 = backward
 * @param displayTime  Current display time
 * @param lat  Observer latitude in radians
 * @param lon  Observer longitude in radians (east positive)
 * @param bodyPlanetNumber  For body-* events: the ECPlanetNumber of the selected body
 * @returns Target Date, or null if no event found
 */
export function computeAstroTarget(
    eventType: AstroEventType,
    direction: 1 | -1,
    displayTime: Date,
    lat: number,
    lon: number,
    bodyPlanetNumber?: number,
): Date | null {
    switch (eventType) {
        case 'sunrise':
            return findNextRiseSet(true, ECPlanetNumber.Sun, displayTime, direction, lat, lon);
        case 'sunset':
            return findNextRiseSet(false, ECPlanetNumber.Sun, displayTime, direction, lat, lon);
        case 'moonrise':
            return findNextRiseSet(true, ECPlanetNumber.Moon, displayTime, direction, lat, lon);
        case 'moonset':
            return findNextRiseSet(false, ECPlanetNumber.Moon, displayTime, direction, lat, lon);
        case 'moonphase':
            return findNextQuarterPhase(displayTime, direction);
        case 'sun-transit':
            return findNextTransit(ECPlanetNumber.Sun, displayTime, direction, lat, lon);
        case 'moon-transit':
            return findNextTransit(ECPlanetNumber.Moon, displayTime, direction, lat, lon);
        case 'body-rise':
            if (bodyPlanetNumber === undefined) return null;
            return findNextRiseSet(true, bodyPlanetNumber as ECPlanetNumber, displayTime, direction, lat, lon);
        case 'body-set':
            if (bodyPlanetNumber === undefined) return null;
            return findNextRiseSet(false, bodyPlanetNumber as ECPlanetNumber, displayTime, direction, lat, lon);
        case 'body-transit':
            if (bodyPlanetNumber === undefined) return null;
            return findNextTransit(bodyPlanetNumber as ECPlanetNumber, displayTime, direction, lat, lon);
        default:
            return null;
    }
}
