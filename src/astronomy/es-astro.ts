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

// ============================================================================
// Moon relative position angle (terminator rotation as seen in sky)
// ============================================================================

/**
 * Position angle between the Sun and an object (Moon).
 * Standard astronomical position angle — the angle at the object
 * between the great circle to the Sun and the great circle to the
 * north celestial pole, measured eastward.
 *
 * Ported from ECAstronomy.m positionAngle().
 */
export function positionAngle(
    sunRA: number, sunDecl: number,
    objRA: number, objDecl: number,
): number {
    return Math.atan2(
        Math.cos(sunDecl) * Math.sin(sunRA - objRA),
        Math.cos(objDecl) * Math.sin(sunDecl) - Math.sin(objDecl) * Math.cos(sunDecl) * Math.cos(sunRA - objRA),
    );
}

/**
 * Great circle initial course from (lat1, lon1) to (lat2, lon2).
 * Ported from ECAstronomy.m greatCircleCourse().
 */
export function greatCircleCourse(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
): number {
    return Math.atan2(
        Math.sin(lon1 - lon2) * Math.cos(lat2),
        Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(lon1 - lon2),
    );
}

/**
 * The angle from an object to the celestial north pole as seen by an observer.
 * Uses the great circle course on a sphere whose north is at the zenith,
 * where the celestial north pole is at (observerLatitude, 0) and
 * the object is at (altitude, azimuth).
 *
 * Ported from ECAstronomy.m northAngleForObject().
 */
export function northAngleForObject(
    altitude: number,
    azimuth: number,
    observerLatitude: number,
): number {
    return greatCircleCourse(altitude, azimuth, observerLatitude, 0);
}

/**
 * Rotation of the terminator as it appears in the sky.
 *
 * Combines the Sun–Moon position angle with the observer's
 * sky orientation (via northAngleForObject) to give the angle
 * the terminator should be drawn at for a sky-aligned display.
 *
 * Ported from ECAstronomy.m moonRelativePositionAngle (lines 3153-3196).
 *
 * @param dateInterval - Apple epoch seconds
 * @param observerLatitude - Observer latitude in radians
 * @param observerLongitude - Observer longitude in radians (east positive)
 * @param cache - AstroCache or null
 * @returns angle in [0, 2π)
 */
export function moonRelativePositionAngle(
    dateInterval: number,
    observerLatitude: number,
    observerLongitude: number,
    cache: AstroCache | null,
): number {
    // Sun RA/Decl
    const sunResult = sunRAandDecl(dateInterval, cache);
    const sunRA = sunResult.rightAscension;
    const sunDecl = sunResult.declination;

    // Moon RA/Decl
    const moonResult = moonRAAndDecl(dateInterval, cache);
    const moonRA = moonResult.rightAscension;
    const moonDecl = moonResult.declination;

    // Position angle Sun→Moon
    let posAngle = positionAngle(sunRA, sunDecl, moonRA, moonDecl);

    // Moon age — if waning (age > π), bright limb is on the left,
    // so the sense of posAngle is reversed by 180°
    const { age: moonAgeAngle } = moonAge(dateInterval, cache);
    if (moonAgeAngle > Math.PI) {
        if (posAngle > Math.PI) {
            posAngle -= Math.PI;
        } else {
            posAngle += Math.PI;
        }
    }

    // Moon's local hour angle, altitude, azimuth
    const gst = convertUTToGSTP03(dateInterval, cache);
    const lst = convertGSTtoLST(gst, observerLongitude);
    const moonHourAngle = lst - moonRA;
    const sinAlt = Math.sin(moonDecl) * Math.sin(observerLatitude)
        + Math.cos(moonDecl) * Math.cos(observerLatitude) * Math.cos(moonHourAngle);
    const moonAz = Math.atan2(
        -Math.cos(moonDecl) * Math.cos(observerLatitude) * Math.sin(moonHourAngle),
        Math.sin(moonDecl) - Math.sin(observerLatitude) * sinAlt,
    );
    const moonAlt = Math.asin(sinAlt);

    // North angle for the Moon
    const northAngle = northAngleForObject(moonAlt, moonAz, observerLatitude);

    // Combine into final angle
    let angle = -northAngle - posAngle - Math.PI / 2;
    if (angle < 0) {
        angle += TWO_PI;
    } else if (angle > TWO_PI) {
        angle -= TWO_PI;
    }

    return angle;
}

// ============================================================================
// Moon elongation (angular separation Sun–Moon in ecliptic longitude)
// ============================================================================

/**
 * Moon elongation angle — same as moon age angle.
 * Range [0, 2π). 0 = new moon (conjunction), π = full moon (opposition).
 */
export function moonElongation(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    return moonAge(dateInterval, cache).age;
}

// ============================================================================
// Closest lunar phase quarter (days from now to nearest quarter)
// ============================================================================

/**
 * Find the day number relative to today when the moon is closest to
 * a given phase angle (0=new, π/2=first quarter, π=full, 3π/2=third quarter).
 *
 * Returns the day-of-month (1-based) of the closest occurrence within ±16 days.
 * The search uses daily moon age samples and looks for the day where the age
 * is closest to the target phase.
 *
 * @param targetPhase - Phase angle to search for (0, π/2, π, or 3π/2)
 * @param dateInterval - Current time in Apple epoch seconds
 * @param cache - AstroCache or null (a fresh cache is used per day anyway)
 */
export function closestPhaseDayNumber(
    targetPhase: number,
    dateInterval: number,
): number {
    const DAY_SECONDS = 86400;
    let bestDelta = Infinity;
    let bestDayOffset = 0;

    // Search ±16 days (slightly more than one synodic month / 2)
    for (let d = -16; d <= 16; d++) {
        const di = dateInterval + d * DAY_SECONDS;
        const { age } = moonAge(di, null);

        // Angular distance to target phase (wrapping around 2π)
        let delta = Math.abs(age - targetPhase);
        if (delta > Math.PI) delta = TWO_PI - delta;

        if (delta < bestDelta) {
            bestDelta = delta;
            bestDayOffset = d;
        }
    }

    // Convert offset to day-of-month
    const targetDate = new Date((dateInterval + bestDayOffset * DAY_SECONDS + 978307200) * 1000);
    return targetDate.getDate();
}

// ============================================================================
// Planetary ecliptic coordinates (for ELatitudeOfPlanet, ELongitudeOfPlanet, etc.)
// ============================================================================

import { WB_planetApparentPosition } from './willmann-bell';

/**
 * Get geocentric apparent ecliptic longitude of a planet (radians).
 */
export function planetEclipticLongitude(
    planetNumber: ECPlanetNumber,
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const U = julianCenturiesSince2000Epoch / 100;
    const pos = WB_planetApparentPosition(planetNumber, U, cache ?? undefined);
    return pos.geocentricApparentLongitude;
}

/**
 * Get geocentric apparent ecliptic latitude of a planet (radians).
 */
export function planetEclipticLatitude(
    planetNumber: ECPlanetNumber,
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const U = julianCenturiesSince2000Epoch / 100;
    const pos = WB_planetApparentPosition(planetNumber, U, cache ?? undefined);
    return pos.geocentricApparentLatitude;
}

/**
 * Get geocentric distance of a planet in AU.
 */
export function planetGeocentricDistance(
    planetNumber: ECPlanetNumber,
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);
    const U = julianCenturiesSince2000Epoch / 100;
    const pos = WB_planetApparentPosition(planetNumber, U, cache ?? undefined);
    return pos.geocentricDistance;
}

// ============================================================================
// Lunar ascending node longitude
// ============================================================================

/**
 * Mean longitude of the lunar ascending node (Ω).
 * Uses the standard Meeus formula.
 *
 * @param dateInterval - Apple epoch seconds
 * @param cache - AstroCache or null
 * @returns longitude in radians [0, 2π)
 */
export function lunarAscendingNodeLongitude(
    dateInterval: number,
    cache: AstroCache | null,
): number {
    const { julianCenturiesSince2000Epoch: T } =
        julianCenturiesSince2000EpochForDateInterval(dateInterval, cache);

    // Mean longitude of ascending node (Meeus, Table 47.a)
    // Ω = 125.0445479° − 1934.1362891°T + 0.0020754°T² + T³/467441 − T⁴/60616000
    const omegaDeg = 125.0445479
        - 1934.1362891 * T
        + 0.0020754 * T * T
        + T * T * T / 467441
        - T * T * T * T / 60616000;

    return fmod(omegaDeg * Math.PI / 180, TWO_PI);
}

