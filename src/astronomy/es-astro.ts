/**
 * Core astronomy functions for Haleakala: Sun/Moon altitude/azimuth, Moon age, EOT.
 *
 * Ported from ESAstronomy.cpp. All functions are stateless (pure functions
 * taking a cache parameter), following the same pattern as the WB modules.
 *
 * Angles in radians, times in Apple epoch seconds.
 */

import {
    fmod,
    ECPlanetNumber,
    ECWBPrecision,
    kECAUInKilometers,
    kECLimitingAzimuthLatitude,
    kECRefractionAtHorizonX,
} from './astro-constants';
import { AstroCache, CacheSlot, AstroCachePool } from './astro-cache';
import { julianCenturiesSince2000EpochForDateInterval } from './es-time';
import { convertUTToGSTP03, convertGSTtoLST } from './es-sidereal';
import {
    sunRAandDecl,
    moonRAAndDecl,
    sunEclipticLongitudeForDate,
    topocentricParallax,
    distanceOfPlanetInAU,
    planetSizeAndParallax,
} from './es-coordinates';
import { WB_sunLongitudeApparent, WB_sunRAAndDecl } from './wb-sun';
import { WB_MoonDistance } from './wb-moon';

const TWO_PI = Math.PI * 2;

// ============================================================================
// Planet altitude / azimuth (general function)
// ============================================================================

/**
 * Calculate altitude or azimuth for a planet (including Sun and Moon).
 *
 * @param planetNumber - ECPlanetNumber value
 * @param calculationDateInterval - Apple epoch seconds
 * @param observerLatitude - Observer latitude in radians
 * @param observerLongitude - Observer longitude in radians (east positive)
 * @param correctForParallax - Whether to apply topocentric parallax correction
 * @param altNotAz - true for altitude, false for azimuth
 * @param cache - AstroCache or null
 */
export function planetAltAz(
    planetNumber: number,
    calculationDateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    correctForParallax: boolean,
    altNotAz: boolean,
    cache: AstroCache | null,
): number {
    const altSlotBase = CacheSlot.planetAltitude;
    const azSlotBase = CacheSlot.planetAzimuth;
    const slotBase = altNotAz ? altSlotBase : azSlotBase;

    if (cache && cache.isValid(slotBase + planetNumber)) {
        return cache.get(slotBase + planetNumber);
    }

    // Clamp latitude to avoid singularity at poles
    if (observerLatitude > kECLimitingAzimuthLatitude) {
        observerLatitude = kECLimitingAzimuthLatitude;
    } else if (observerLatitude < -kECLimitingAzimuthLatitude) {
        observerLatitude = -kECLimitingAzimuthLatitude;
    }

    let planetRightAscension: number;
    let planetDeclination: number;
    let planetGeocentricDistance: number;

    // Get planet RA/Decl
    if (planetNumber === ECPlanetNumber.Sun) {
        const sunResult = sunRAandDecl(calculationDateInterval, cache);
        planetRightAscension = sunResult.rightAscension;
        planetDeclination = sunResult.declination;
        const { julianCenturiesSince2000Epoch } =
            julianCenturiesSince2000EpochForDateInterval(calculationDateInterval, cache);
        planetGeocentricDistance = distanceOfPlanetInAU(
            ECPlanetNumber.Sun, julianCenturiesSince2000Epoch, cache,
        );
    } else if (planetNumber === ECPlanetNumber.Moon) {
        const moonResult = moonRAAndDecl(calculationDateInterval, cache);
        planetRightAscension = moonResult.rightAscension;
        planetDeclination = moonResult.declination;
        const { julianCenturiesSince2000Epoch } =
            julianCenturiesSince2000EpochForDateInterval(calculationDateInterval, cache);
        planetGeocentricDistance = distanceOfPlanetInAU(
            ECPlanetNumber.Moon, julianCenturiesSince2000Epoch, cache,
        );
    } else {
        // For other planets, use the cached RA/Decl if available
        if (cache && cache.isValid(CacheSlot.planetRA + planetNumber)) {
            planetRightAscension = cache.get(CacheSlot.planetRA + planetNumber);
            planetDeclination = cache.get(CacheSlot.planetDecl + planetNumber);
            planetGeocentricDistance = cache.get(CacheSlot.planetGeocentricDistance + planetNumber);
        } else {
            // Skeleton: would call WB_planetApparentPosition here
            // For now, return 0 for unsupported planets
            return 0;
        }
    }

    // Compute hour angle
    const gst = convertUTToGSTP03(calculationDateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    let planetHourAngle = lst - planetRightAscension;

    // Apply topocentric parallax if requested
    if (correctForParallax) {
        const { Hprime, declPrime } = topocentricParallax(
            planetRightAscension, planetDeclination, planetHourAngle,
            planetGeocentricDistance, observerLatitude, 0,
        );
        planetDeclination = declPrime;
        planetHourAngle = Hprime;
    }

    // Compute altitude and azimuth
    const sinAlt = Math.sin(planetDeclination) * Math.sin(observerLatitude)
        + Math.cos(planetDeclination) * Math.cos(observerLatitude) * Math.cos(planetHourAngle);
    const planetAzimuth = Math.atan2(
        -Math.cos(planetDeclination) * Math.cos(observerLatitude) * Math.sin(planetHourAngle),
        Math.sin(planetDeclination) - Math.sin(observerLatitude) * sinAlt,
    );
    const planetAltitude = Math.asin(sinAlt);

    // Cache both values
    if (cache) {
        cache.set(CacheSlot.planetAltitude + planetNumber, planetAltitude);
        cache.set(CacheSlot.planetAzimuth + planetNumber, planetAzimuth);
    }

    return altNotAz ? planetAltitude : planetAzimuth;
}

// ============================================================================
// Convenience functions for Sun/Moon
// ============================================================================

/** Sun altitude (radians). */
export function sunAltitude(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Sun, dateInterval, observerLatitude, observerLongitude, false, true, cache);
}

/** Sun azimuth (radians). */
export function sunAzimuth(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Sun, dateInterval, observerLatitude, observerLongitude, false, false, cache);
}

/** Moon altitude (radians, with topocentric correction). */
export function moonAltitude(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Moon, dateInterval, observerLatitude, observerLongitude, true, true, cache);
}

/** Moon azimuth (radians, with topocentric correction). */
export function moonAzimuth(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    return planetAltAz(ECPlanetNumber.Moon, dateInterval, observerLatitude, observerLongitude, true, false, cache);
}

// ============================================================================
// Moon age (phase angle)
// ============================================================================

/**
 * Moon age angle: the difference in ecliptic longitude between Moon and Sun.
 * Range [0, 2π). At 0 = new moon, π = full moon.
 *
 * Also returns the "phase" value (1-cos(age))/2 for backward compat,
 * although the original code notes this isn't really correct.
 */
export function moonAge(
    dateInterval: number,
    cache: AstroCache | null,
): { age: number; phase: number } {
    if (cache && cache.isValid(CacheSlot.moonAge)) {
        return {
            age: cache.get(CacheSlot.moonAge),
            phase: cache.get(CacheSlot.moonPhase),
        };
    }

    const { moonEclipticLongitude } = moonRAAndDecl(dateInterval, cache);
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const sunEclipticLong = WB_sunLongitudeApparent(julianCenturiesSince2000Epoch / 100, cache ?? undefined);

    let age = moonEclipticLongitude - sunEclipticLong;
    if (age < 0) {
        age += TWO_PI;
    }

    const phase = (1 - Math.cos(age)) / 2;

    if (cache) {
        cache.set(CacheSlot.moonAge, age);
        cache.set(CacheSlot.moonPhase, phase);
    }

    return { age, phase };
}

// ============================================================================
// Equation of Time
// ============================================================================

/**
 * Equation of Time in seconds.
 * EOT = apparent solar time - mean solar time.
 * Based on Sun RA and GMST.
 */
export function EOTSeconds(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    if (cache && cache.isValid(CacheSlot.eotForDay)) {
        return cache.get(CacheSlot.eotForDay);
    }

    const { rightAscension: sunRA } = sunRAandDecl(dateInterval, cache);
    const gst = convertUTToGSTP03(dateInterval, cache);

    // Sun hour angle = GST - Sun RA
    let sunHA = gst - sunRA;

    // Normalize to [-π, π)
    if (sunHA > Math.PI) {
        sunHA -= TWO_PI;
    } else if (sunHA < -Math.PI) {
        sunHA += TWO_PI;
    }

    // Convert from UT hour-angle offset to seconds
    // HA in radians, 1 radian = 12*3600/π seconds of time
    const eotSeconds = -sunHA * 12 * 3600 / Math.PI;

    if (cache) {
        cache.set(CacheSlot.eotForDay, eotSeconds);
    }

    return eotSeconds;
}

// ============================================================================
// Local Sidereal Time
// ============================================================================

/**
 * Local Sidereal Time in radians.
 */
export function localSiderealTime(
    dateInterval: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    if (cache && cache.isValid(CacheSlot.lst)) {
        return cache.get(CacheSlot.lst);
    }

    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);

    if (cache) {
        cache.set(CacheSlot.lst, lst);
    }

    return lst;
}
