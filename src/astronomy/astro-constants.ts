/**
 * Astronomical constants and enumerations.
 *
 * Ported from ECConstants.h, ESAstronomy.cpp, and ESWillmannBell.hpp
 * in the EmeraldSequoia/esastro repository.
 */

// ============================================================================
// Enumerations
// ============================================================================

/** Planet number enumeration, matching the original C ECPlanetNumber enum. */
export const enum ECPlanetNumber {
    Sun       = 0,
    Moon      = 1,
    Mercury   = 2,
    Venus     = 3,
    Earth     = 4,
    Mars      = 5,
    Jupiter   = 6,
    Saturn    = 7,
    Uranus    = 8,
    Neptune   = 9,
    Pluto     = 10,
    MidnightSun = 11,
}

export const ECNumPlanets = 11;
export const ECNumLegalPlanets = 10;
export const ECFirstActualPlanet = 2;
export const ECLastLegalPlanet = 9;

/** Precision levels for Willmann-Bell lunar calculations. */
export const enum ECWBPrecision {
    Low  = 0,
    Mid  = 1,
    Full = 2,
}

// ============================================================================
// Physical constants
// ============================================================================

/** 1 Astronomical Unit in kilometers. */
export const kECAUInKilometers = 149597870.691;

// ============================================================================
// Time epoch constants
// ============================================================================

/**
 * All time intervals in ESAstronomy are seconds since the Apple/NeXT reference
 * date of Jan 1, 2001 00:00:00 UTC. These epoch constants convert between
 * that reference and Julian dates.
 */

/** Seconds between Jan 1 1970 (Unix epoch) and Jan 1 2001 (Apple epoch). */
export const kECUnixToAppleEpochOffset = 978307200; // 31 years worth of seconds

/** Julian date of 1990 Jan 0.0 (= 1989 Dec 31 0h UT). */
export const kECJulianDateOf1990Epoch = 2447891.5;

/** Apple epoch time interval of 1990 Jan 0.0.
 *  1990 "Jan 0.0" = 1989 Dec 31 0h UT = seconds from 2001-01-01 to 1989-12-31 = -347241600 */
export const kEC1990Epoch = -347241600;

/** Julian date of J2000.0 epoch (2000 Jan 1.5 = 2000 Jan 1 12h TT). */
export const kECJulianDateOf2000Epoch = 2451545.0;

/** Number of Julian days per Julian century. */
export const kECJulianDaysPerCentury = 36525;

/** Lunar synodic period in seconds (29.530589 days). */
export const kECLunarCycleInSeconds = 29.530589 * 24 * 3600;

/** Ratio of UT units to GST units (sidereal day / solar day). */
export const kECUTUnitsPerGSTUnit = 0.9972695663;

// ============================================================================
// Sun altitude constants (radians)
// ============================================================================

/** Standard refraction at the horizon (34 arcmin = 34/60 degrees). */
export const kECRefractionAtHorizonX = (34 / 60) * Math.PI / 180;

/** Civil twilight boundary: Sun center at -6°. */
export const kECCivilTwilightAltitude = -6 * Math.PI / 180;

/** Nautical twilight boundary: Sun center at -12°. */
export const kECNauticalTwilightAltitude = -12 * Math.PI / 180;

/** Astronomical twilight boundary: Sun center at -18°. */
export const kECAstroTwilightAltitude = -18 * Math.PI / 180;

/** Golden hour boundary: Sun center at +6° (approximate). */
export const kECGoldenHourAltitude = 6 * Math.PI / 180;

/** Latitude limit for azimuth calculations (89°) — avoids singularity at poles. */
export const kECLimitingAzimuthLatitude = 89 * Math.PI / 180;

// ============================================================================
// Special NaN sentinels for rise/set
// ============================================================================

/** NaN sentinel: object is always above the horizon (never sets). */
export const kECAlwaysAboveHorizon = NaN;  // We use a convention: positive sentinel
/** NaN sentinel: object is always below the horizon (never rises). */
export const kECAlwaysBelowHorizon = NaN;  // We use a convention: negative sentinel

/**
 * Since JS NaN !== NaN, we use a different encoding: special finite
 * sentinels that are out of the normal time range. We use ±1e18.
 */
export const ALWAYS_ABOVE_HORIZON = 1e18;
export const ALWAYS_BELOW_HORIZON = -1e18;

/** Check if a value represents "always above horizon". */
export function isAlwaysAbove(value: number): boolean {
    return value === ALWAYS_ABOVE_HORIZON;
}

/** Check if a value represents "always below horizon". */
export function isAlwaysBelow(value: number): boolean {
    return value === ALWAYS_BELOW_HORIZON;
}

/** Check if a value represents either "always above" or "always below" (no rise/set). */
export function isNoRiseSet(value: number): boolean {
    return isAlwaysAbove(value) || isAlwaysBelow(value);
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Modulo that always returns a non-negative result (matching ESUtil::fmod behavior).
 * For positive divisors, the result is always in [0, divisor).
 */
export function fmod(x: number, y: number): number {
    let result = x % y;
    if (result < 0) {
        result += y;
    }
    return result;
}

/** Planet radii in AU (for angular size / parallax calculations). */
export const planetRadiiInAU: readonly number[] = [
    695500  / kECAUInKilometers,  // Sun
    1737.10 / kECAUInKilometers,  // Moon
    2439.7  / kECAUInKilometers,  // Mercury
    6051.8  / kECAUInKilometers,  // Venus
    6371.0  / kECAUInKilometers,  // Earth
    3389.5  / kECAUInKilometers,  // Mars
    69911   / kECAUInKilometers,  // Jupiter
    58232   / kECAUInKilometers,  // Saturn
    25362   / kECAUInKilometers,  // Uranus
    24622   / kECAUInKilometers,  // Neptune
    1195    / kECAUInKilometers,  // Pluto
];
