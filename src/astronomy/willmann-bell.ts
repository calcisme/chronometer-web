/**
 * Willmann-Bell — generic dispatch by planet number.
 * Ported from ESWillmannBell.cpp.
 */

import { ECPlanetNumber, ECWBPrecision, kECAUInKilometers, fmod } from './astro-constants.js';
import { AstroCache } from './astro-cache.js';

import {
    WB_MoonRAAndDecl, WB_MoonDistance,
} from './wb-moon.js';
import {
    WB_sunRAAndDecl, WB_sunRadius, WB_sunLongitudeRaw,
} from './wb-sun.js';
import {
    mercuryApparentPosition, mercuryHeliocentricLongitude,
    mercuryHeliocentricLatitude, mercuryRadius,
    venusApparentPosition, venusHeliocentricLongitude,
    venusHeliocentricLatitude, venusRadius,
    marsApparentPosition, marsHeliocentricLongitude,
    marsHeliocentricLatitude, marsRadius,
    jupiterApparentPosition, jupiterHeliocentricLongitude,
    jupiterHeliocentricLatitude, jupiterRadius,
    saturnApparentPosition, saturnHeliocentricLongitude,
    saturnHeliocentricLatitude, saturnRadius,
    uranusApparentPosition, uranusHeliocentricLongitude,
    uranusHeliocentricLatitude, uranusRadius,
    neptuneApparentPosition, neptuneHeliocentricLongitude,
    neptuneHeliocentricLatitude, neptuneRadius,
} from './wb-planets.js';

export interface PlanetPositionResult {
    geocentricApparentLongitude: number;
    geocentricApparentLatitude: number;
    geocentricDistance: number;
    apparentRightAscension: number;
    apparentDeclination: number;
}

export function WB_planetApparentPosition(
    planetNumber: ECPlanetNumber,
    U: number,
    cache?: AstroCache,
    moonPrecision: ECWBPrecision = ECWBPrecision.Full,
): PlanetPositionResult {
    switch (planetNumber) {
        case ECPlanetNumber.Sun: {
            const s = WB_sunRAAndDecl(U, cache);
            return {
                geocentricApparentLongitude: s.apparentLongitude,
                geocentricApparentLatitude: 0,
                geocentricDistance: WB_sunRadius(U, cache),
                apparentRightAscension: s.rightAscension,
                apparentDeclination: s.declination,
            };
        }
        case ECPlanetNumber.Moon: {
            const m = WB_MoonRAAndDecl(U * 100, cache, moonPrecision);
            return {
                geocentricApparentLongitude: m.longitude,
                geocentricApparentLatitude: m.latitude,
                geocentricDistance: WB_MoonDistance(U * 100, cache, moonPrecision) / kECAUInKilometers,
                apparentRightAscension: m.rightAscension,
                apparentDeclination: m.declination,
            };
        }
        case ECPlanetNumber.Mercury: {
            const r = mercuryApparentPosition(U, cache);
            return { geocentricApparentLongitude: r.geoLong, geocentricApparentLatitude: r.geoLat,
                geocentricDistance: r.distance, apparentRightAscension: r.ra, apparentDeclination: r.decl };
        }
        case ECPlanetNumber.Venus: {
            const r = venusApparentPosition(U, cache);
            return { geocentricApparentLongitude: r.geoLong, geocentricApparentLatitude: r.geoLat,
                geocentricDistance: r.distance, apparentRightAscension: r.ra, apparentDeclination: r.decl };
        }
        case ECPlanetNumber.Mars: {
            const r = marsApparentPosition(U, cache);
            return { geocentricApparentLongitude: r.geoLong, geocentricApparentLatitude: r.geoLat,
                geocentricDistance: r.distance, apparentRightAscension: r.ra, apparentDeclination: r.decl };
        }
        case ECPlanetNumber.Jupiter: {
            const r = jupiterApparentPosition(U, cache);
            return { geocentricApparentLongitude: r.geoLong, geocentricApparentLatitude: r.geoLat,
                geocentricDistance: r.distance, apparentRightAscension: r.ra, apparentDeclination: r.decl };
        }
        case ECPlanetNumber.Saturn: {
            const r = saturnApparentPosition(U, cache);
            return { geocentricApparentLongitude: r.geoLong, geocentricApparentLatitude: r.geoLat,
                geocentricDistance: r.distance, apparentRightAscension: r.ra, apparentDeclination: r.decl };
        }
        case ECPlanetNumber.Uranus: {
            const r = uranusApparentPosition(U, cache);
            return { geocentricApparentLongitude: r.geoLong, geocentricApparentLatitude: r.geoLat,
                geocentricDistance: r.distance, apparentRightAscension: r.ra, apparentDeclination: r.decl };
        }
        case ECPlanetNumber.Neptune: {
            const r = neptuneApparentPosition(U, cache);
            return { geocentricApparentLongitude: r.geoLong, geocentricApparentLatitude: r.geoLat,
                geocentricDistance: r.distance, apparentRightAscension: r.ra, apparentDeclination: r.decl };
        }
        default:
            return {
                geocentricApparentLongitude: NaN, geocentricApparentLatitude: NaN,
                geocentricDistance: NaN, apparentRightAscension: NaN, apparentDeclination: NaN,
            };
    }
}

export function WB_planetHeliocentricLongitude(
    planetNumber: ECPlanetNumber, U: number, cache?: AstroCache
): number {
    switch (planetNumber) {
        case ECPlanetNumber.Earth: {
            const sunLong = WB_sunLongitudeRaw(U, cache);
            let helio = fmod(Math.PI + sunLong, 2 * Math.PI);
            if (helio < 0) helio += 2 * Math.PI;
            return helio;
        }
        case ECPlanetNumber.Mercury: return mercuryHeliocentricLongitude(U);
        case ECPlanetNumber.Venus:   return venusHeliocentricLongitude(U);
        case ECPlanetNumber.Mars:    return marsHeliocentricLongitude(U);
        case ECPlanetNumber.Jupiter: return jupiterHeliocentricLongitude(U);
        case ECPlanetNumber.Saturn:  return saturnHeliocentricLongitude(U);
        case ECPlanetNumber.Uranus:  return uranusHeliocentricLongitude(U);
        case ECPlanetNumber.Neptune: return neptuneHeliocentricLongitude(U);
        default: return NaN;
    }
}

export function WB_planetHeliocentricLatitude(
    planetNumber: ECPlanetNumber, U: number
): number {
    switch (planetNumber) {
        case ECPlanetNumber.Earth:   return 0;
        case ECPlanetNumber.Mercury: return mercuryHeliocentricLatitude(U);
        case ECPlanetNumber.Venus:   return venusHeliocentricLatitude(U);
        case ECPlanetNumber.Mars:    return marsHeliocentricLatitude(U);
        case ECPlanetNumber.Jupiter: return jupiterHeliocentricLatitude(U);
        case ECPlanetNumber.Saturn:  return saturnHeliocentricLatitude(U);
        case ECPlanetNumber.Uranus:  return uranusHeliocentricLatitude(U);
        case ECPlanetNumber.Neptune: return neptuneHeliocentricLatitude(U);
        default: return NaN;
    }
}

export function WB_planetHeliocentricRadius(
    planetNumber: ECPlanetNumber, U: number, cache?: AstroCache
): number {
    switch (planetNumber) {
        case ECPlanetNumber.Earth:   return WB_sunRadius(U, cache);
        case ECPlanetNumber.Mercury: return mercuryRadius(U);
        case ECPlanetNumber.Venus:   return venusRadius(U);
        case ECPlanetNumber.Mars:    return marsRadius(U);
        case ECPlanetNumber.Jupiter: return jupiterRadius(U);
        case ECPlanetNumber.Saturn:  return saturnRadius(U);
        case ECPlanetNumber.Uranus:  return uranusRadius(U);
        case ECPlanetNumber.Neptune: return neptuneRadius(U);
        default: return NaN;
    }
}

// Re-export everything for convenience
export * from './astro-constants.js';
export * from './astro-cache.js';
export * from './wb-moon.js';
export * from './wb-sun.js';
export * from './wb-planets.js';
