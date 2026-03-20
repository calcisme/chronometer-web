/**
 * Willmann-Bell Sun computation functions.
 * Ported from ESWillmannBell.cpp — sun section.
 */

import { fmod } from './astro-constants.js';
import { AstroCache, WBCacheSlot } from './astro-cache.js';
import { sunData, numSunData } from './planet-tables.js';

/** Without aberration, nutation. Returns radians. */
export function WB_sunLongitudeRaw(
    U: number, cache?: AstroCache
): number {
    if (cache && cache.isValid(WBCacheSlot.SunLongitude)) {
        return cache.get(WBCacheSlot.SunLongitude);
    }
    let longitude = 0;
    for (let i = 0; i < numSunData; i++) {
        const d = sunData[i];
        longitude += d.li * Math.sin(d.ali + d.bli * U);
    }
    longitude = 1E-7 * longitude + 4.9353929 + 62833.1961680 * U;
    longitude = fmod(longitude, Math.PI * 2);
    if (cache) cache.set(WBCacheSlot.SunLongitude, longitude);
    return longitude;
}

/** Returns AU. */
export function WB_sunRadius(
    U: number, cache?: AstroCache
): number {
    if (cache && cache.isValid(WBCacheSlot.SunRadius)) {
        return cache.get(WBCacheSlot.SunRadius);
    }
    let radius = 0;
    for (let i = 0; i < numSunData; i++) {
        const d = sunData[i];
        radius += d.ri * Math.cos(d.ali + d.bli * U);
    }
    radius = 1E-7 * radius + 1.0001026;
    if (cache) cache.set(WBCacheSlot.SunRadius, radius);
    return radius;
}

export interface SunLongRadResult {
    longitude: number;
    radius: number;
}

/** Without aberration or nutation. Returns {longitude: radians, radius: AU}. */
export function WB_sunLongitudeRadiusRaw(
    U: number, cache?: AstroCache
): SunLongRadResult {
    if (cache && cache.isValid(WBCacheSlot.SunRadius) &&
        cache.isValid(WBCacheSlot.SunLongitude)) {
        return {
            longitude: cache.get(WBCacheSlot.SunLongitude),
            radius: cache.get(WBCacheSlot.SunRadius),
        };
    }
    if (cache && cache.isValid(WBCacheSlot.SunRadius)) {
        return {
            longitude: WB_sunLongitudeRaw(U, cache),
            radius: cache.get(WBCacheSlot.SunRadius),
        };
    }
    if (cache && cache.isValid(WBCacheSlot.SunLongitude)) {
        return {
            longitude: cache.get(WBCacheSlot.SunLongitude),
            radius: WB_sunRadius(U, cache),
        };
    }
    // Compute both at once
    let longitude = 0;
    let radius = 0;
    for (let i = 0; i < numSunData; i++) {
        const d = sunData[i];
        const term = d.ali + d.bli * U;
        longitude += d.li * Math.sin(term);
        radius += d.ri * Math.cos(term);
    }
    longitude = 1E-7 * longitude + 4.9353929 + 62833.1961680 * U;
    radius = 1E-7 * radius + 1.0001026;
    longitude = fmod(longitude, Math.PI * 2);
    if (cache) {
        cache.set(WBCacheSlot.SunLongitude, longitude);
        cache.set(WBCacheSlot.SunRadius, radius);
    }
    return { longitude, radius };
}

export function WB_sunLongitudeAberration(U: number): number {
    return 1E-7 * (-993 + 17 * Math.cos(3.10 + 62830.14 * U));
}

export interface NutationObliquityResult {
    nutation: number;
    obliquity: number;
}

export function WB_nutationObliquity(
    U: number, cache?: AstroCache
): NutationObliquityResult {
    if (cache && cache.isValid(WBCacheSlot.Nutation)) {
        return {
            nutation: cache.get(WBCacheSlot.Nutation),
            obliquity: cache.get(WBCacheSlot.Obliquity),
        };
    }
    const U_2 = U * U;
    const A1 = 2.18 - 3375.70 * U + 0.36 * U_2;
    const A2 = 3.51 + 125666.39 * U + 0.10 * U_2;
    const nutation = 1E-7 * (-834 * Math.sin(A1) - 64 * Math.sin(A2));
    const U_3 = U * U_2;
    const U_4 = U_2 * U_2;
    const U_5 = U * U_4;
    const obliquity = 0.4090928 + 1E-7 * (
        -226938 * U - 75 * U_2 + 96926 * U_3
        - 2491 * U_4 - 12104 * U_5
        + 446 * Math.cos(A1) + 28 * Math.cos(A2)
    );
    if (cache) {
        cache.set(WBCacheSlot.Nutation, nutation);
        cache.set(WBCacheSlot.Obliquity, obliquity);
    }
    return { nutation, obliquity };
}

export interface SunRADeclResult {
    rightAscension: number;
    declination: number;
    apparentLongitude: number;
}

export function WB_sunRAAndDecl(
    U: number, cache?: AstroCache
): SunRADeclResult {
    const longitude = WB_sunLongitudeRaw(U, cache);
    const aberration = WB_sunLongitudeAberration(U);
    const { nutation, obliquity } = WB_nutationObliquity(U, cache);
    let apparentLongitude = longitude + aberration + nutation;
    apparentLongitude = fmod(apparentLongitude, Math.PI * 2);
    if (apparentLongitude < 0) apparentLongitude += Math.PI * 2;

    const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));
    let rightAscension = Math.atan2(
        Math.cos(obliquity) * Math.sin(apparentLongitude),
        Math.cos(apparentLongitude)
    );
    if (rightAscension < 0) rightAscension += Math.PI * 2;

    return { rightAscension, declination, apparentLongitude };
}

/** Returns radians. */
export function WB_sunLongitudeApparent(
    U: number, cache?: AstroCache
): number {
    if (cache && cache.isValid(WBCacheSlot.SunLongitudeApparent)) {
        return cache.get(WBCacheSlot.SunLongitudeApparent);
    }
    const longitude = WB_sunLongitudeRaw(U, cache);
    const aberration = WB_sunLongitudeAberration(U);
    const { nutation } = WB_nutationObliquity(U, cache);
    let apparentLongitude = longitude + aberration + nutation;
    apparentLongitude = fmod(apparentLongitude, Math.PI * 2);
    if (apparentLongitude < 0) apparentLongitude += Math.PI * 2;
    if (cache) cache.set(WBCacheSlot.SunLongitudeApparent, apparentLongitude);
    return apparentLongitude;
}
