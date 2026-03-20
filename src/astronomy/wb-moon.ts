/**
 * Willmann-Bell Moon computation functions.
 * Ported from ESWillmannBell.cpp — lunar section.
 */

import { ECWBPrecision, fmod } from './astro-constants.js';
import { AstroCache, WBCacheSlot } from './astro-cache.js';
import {
    Sv, Sv1, Sv2, Sv3, Nv, N1v, N2v, N3v,
    Su, Su1, Su2, Su3, Nu, N1u, N2u, N3u,
    Sr, Sr1, Sr2, Sr3, Nr, N1r, N2r, N3r,
    NutationData, NNut,
    type SvDatum, type SuDatum, type SrDatum,
    type NutationDatum,
} from './lunar-tables.js';

/** Returns lunar longitude in DEGREES. */
export function lunarLongitudeForTDT(
    t: number, p: ECWBPrecision, cache?: AstroCache
): number {
    const slotIndex = WBCacheSlot.LunarLongitudeLow + p;
    if (cache && cache.isValid(slotIndex)) {
        return cache.get(slotIndex);
    }

    const t2 = t * t;
    const t3 = t * t2;
    const t4 = t2 * t2;

    let SV = 0;
    const nvEnd = Nv[p];
    for (let i = 0; i < nvEnd; i++) {
        const d = Sv[i];
        const sinArg = d.an0 + d.an1 * t + d.an2 * t2 * 1E-4
            + d.an3 * t3 * 1E-6 + d.an4 * t4 * 1E-8;
        SV += d.vn * Math.sin((Math.PI / 180) * sinArg);
    }

    let SV1 = 0;
    const n1vEnd = N1v[p];
    for (let i = 0; i < n1vEnd; i++) {
        const d = Sv1[i];
        SV1 += d.vn * Math.sin((Math.PI / 180) * (d.an0 + d.an1 * t));
    }

    let SV2 = 0;
    const n2vEnd = N2v[p];
    for (let i = 0; i < n2vEnd; i++) {
        const d = Sv2[i];
        SV2 += d.vn * Math.sin((Math.PI / 180) * (d.an0 + d.an1 * t));
    }

    let SV3 = 0;
    const n3vEnd = N3v[p];
    for (let i = 0; i < n3vEnd; i++) {
        const d = Sv3[i];
        SV3 += d.vn * Math.sin((Math.PI / 180) * (d.an0 + d.an1 * t));
    }

    let V = 218.31665436
        + 481267.88134240 * t
        - 13.268E-4 * t2
        + 1.856E-6 * t3
        - 1.534E-8 * t4
        + SV
        + (1E-3) * (SV1 + t * SV2 + t2 * (1E-4) * SV3);

    V = fmod(V, 360.0);

    if (cache) cache.set(slotIndex, V);
    return V;
}

/** Returns lunar latitude in DEGREES. */
export function lunarLatitudeForTDT(
    t: number, p: ECWBPrecision, cache?: AstroCache
): number {
    const slotIndex = WBCacheSlot.LunarLatitudeLow + p;
    if (cache && cache.isValid(slotIndex)) {
        return cache.get(slotIndex);
    }

    const t2 = t * t;
    const t3 = t * t2;
    const t4 = t2 * t2;

    let SU = 0;
    const nuEnd = Nu[p];
    for (let i = 0; i < nuEnd; i++) {
        const d = Su[i];
        const sinArg = d.bn0 + d.bn1 * t + d.bn2 * t2 * 1E-4
            + d.bn3 * t3 * 1E-6 + d.bn4 * t4 * 1E-8;
        SU += d.un * Math.sin((Math.PI / 180) * sinArg);
    }

    let SU1 = 0;
    for (let i = 0; i < N1u[p]; i++) {
        const d = Su1[i];
        SU1 += d.un * Math.sin((Math.PI / 180) * (d.bn0 + d.bn1 * t));
    }

    let SU2 = 0;
    for (let i = 0; i < N2u[p]; i++) {
        const d = Su2[i];
        SU2 += d.un * Math.sin((Math.PI / 180) * (d.bn0 + d.bn1 * t));
    }

    let SU3 = 0;
    for (let i = 0; i < N3u[p]; i++) {
        const d = Su3[i];
        SU3 += d.un * Math.sin((Math.PI / 180) * (d.bn0 + d.bn1 * t));
    }

    let U = SU + (1E-3) * (SU1 + t * SU2 + t2 * (1E-4) * SU3);
    U = fmod(U, 360.0);
    if (U > 180) U -= 360;

    if (cache) cache.set(slotIndex, U);
    return U;
}

/** Returns lunar distance in km. */
export function lunarDistanceForTDT(
    t: number, p: ECWBPrecision, cache?: AstroCache
): number {
    const slotIndex = WBCacheSlot.LunarDistanceLow + p;
    if (cache && cache.isValid(slotIndex)) {
        return cache.get(slotIndex);
    }

    const t2 = t * t;
    const t3 = t * t2;
    const t4 = t2 * t2;

    let SR = 0;
    for (let i = 0; i < Nr[p]; i++) {
        const d = Sr[i];
        const cosArg = d.dn0 + d.dn1 * t + d.dn2 * t2 * 1E-4
            + d.dn3 * t3 * 1E-6 + d.dn4 * t4 * 1E-8;
        SR += d.rn * Math.cos((Math.PI / 180) * cosArg);
    }

    let SR1 = 0;
    for (let i = 0; i < N1r[p]; i++) {
        const d = Sr1[i];
        SR1 += d.rn * Math.cos((Math.PI / 180) * (d.dn0 + d.dn1 * t));
    }

    let SR2 = 0;
    for (let i = 0; i < N2r[p]; i++) {
        const d = Sr2[i];
        SR2 += d.rn * Math.cos((Math.PI / 180) * (d.dn0 + d.dn1 * t));
    }

    let SR3 = 0;
    for (let i = 0; i < N3r[p]; i++) {
        const d = Sr3[i];
        SR3 += d.rn * Math.cos((Math.PI / 180) * (d.dn0 + d.dn1 * t));
    }

    const R = 385000.57 + SR + SR1 + t * SR2 + t2 * (1E-4) * SR3;

    if (cache) cache.set(slotIndex, R);
    return R;
}

function lunarAberrationV(t: number): number {
    return (Math.PI / 180) * (-0.00019524 - 0.00001059 *
        Math.sin((225 + 477198.9 * t) * Math.PI / 180));
}

function lunarAberrationU(t: number): number {
    return (Math.PI / 180) * (-0.00001754 *
        Math.sin((183.3 + 483202.0 * t) * Math.PI / 180));
}

function lunarAberrationR(t: number): number {
    return (Math.PI / 180) * (0.0708 *
        Math.cos((225 + 477198.9 * t) * Math.PI / 180));
}

/** Returns radians. */
function meanObliquityFromTDT(t: number): number {
    const t2 = t * t;
    const t3 = t * t2;
    const t4 = t2 * t2;
    return (Math.PI / 180) * (23.43928 - 0.013 * t + 0.555E-6 * t3 - 0.014E-8 * t4);
}

/** Returns {longitudeNutation, obliquityNutation} in radians. */
function nutations(t: number): { longitudeNutation: number; obliquityNutation: number } {
    let longNut = 0;
    let obliqueNut = 0;
    const iterations = NNut[ECWBPrecision.Full];
    const t2 = t * t;

    for (let i = 0; i < iterations; i++) {
        const d = NutationData[i];
        const arg = (d.mu0n + d.mu1n * t + d.mu2n * t2) * Math.PI / 180;
        longNut += (d.psin + d.psi1n * t) * Math.sin(arg);
        if (i < 4 || (i > 5 && i < 9)) {
            obliqueNut += (d.obn + d.ob1n * t) * Math.cos(arg);
        }
    }

    return {
        longitudeNutation: longNut * Math.PI / 180,
        obliquityNutation: obliqueNut * Math.PI / 180,
    };
}

function moonRightAscensionAndDeclForTDT(
    V: number, U: number, centuriesSinceEpochTDT: number
): { ra: number; decl: number } {
    const meanOb = meanObliquityFromTDT(centuriesSinceEpochTDT);
    const { longitudeNutation, obliquityNutation } = nutations(centuriesSinceEpochTDT);
    const Vn = V + longitudeNutation;
    const trueOb = meanOb + obliquityNutation;

    const cosV = Math.cos(Vn);
    const sinV = Math.sin(Vn);
    const sinU = Math.sin(U);
    const cosU = Math.cos(U);
    const cosTrueOb = Math.cos(trueOb);
    const sinTrueOb = Math.sin(trueOb);

    let ra: number;
    if (cosV === 0) {
        ra = Vn;
    } else {
        ra = Math.atan2(
            cosTrueOb * sinV * cosU - sinTrueOb * sinU,
            cosV * cosU
        );
        if (ra < 0) ra += Math.PI * 2;
    }
    const decl = Math.asin(sinTrueOb * sinV * cosU + cosTrueOb * sinU);
    return { ra, decl };
}

export interface MoonRADeclResult {
    rightAscension: number;
    declination: number;
    longitude: number;
    latitude: number;
}

export function WB_MoonRAAndDecl(
    centuriesSinceEpochTDT: number,
    cache: AstroCache | undefined,
    p: ECWBPrecision
): MoonRADeclResult {
    const raSlot = WBCacheSlot.MoonRALow + p;
    const declSlot = WBCacheSlot.MoonDeclLow + p;
    const longSlot = WBCacheSlot.MoonEclipticLongitudeLow + p;
    const latSlot = WBCacheSlot.MoonEclipticLatitudeLow + p;

    if (cache && cache.isValid(raSlot)) {
        return {
            rightAscension: cache.get(raSlot),
            declination: cache.get(declSlot),
            longitude: cache.get(longSlot),
            latitude: cache.get(latSlot),
        };
    }

    const V = lunarLongitudeForTDT(centuriesSinceEpochTDT, p, cache);
    const U = lunarLatitudeForTDT(centuriesSinceEpochTDT, p, cache);
    const longitude = V * Math.PI / 180 + lunarAberrationV(centuriesSinceEpochTDT);
    const latitude = U * Math.PI / 180 + lunarAberrationU(centuriesSinceEpochTDT);
    const { ra, decl } = moonRightAscensionAndDeclForTDT(
        longitude, latitude, centuriesSinceEpochTDT
    );

    if (cache) {
        cache.set(raSlot, ra);
        cache.set(declSlot, decl);
        cache.set(longSlot, longitude);
        cache.set(latSlot, latitude);
    }

    return { rightAscension: ra, declination: decl, longitude, latitude };
}

/** Returns radians. */
export function WB_MoonEclipticLongitude(
    centuriesSinceEpochTDT: number,
    cache: AstroCache | undefined,
    p: ECWBPrecision
): number {
    const slotIndex = WBCacheSlot.MoonEclipticLongitudeLow + p;
    if (cache && cache.isValid(slotIndex)) return cache.get(slotIndex);

    const V = lunarLongitudeForTDT(centuriesSinceEpochTDT, p, cache);
    const Vr = V * Math.PI / 180 + lunarAberrationV(centuriesSinceEpochTDT);
    if (cache) cache.set(slotIndex, Vr);
    return Vr;
}

/** Returns radians. */
export function WB_MoonEclipticLatitude(
    centuriesSinceEpochTDT: number,
    cache: AstroCache | undefined,
    p: ECWBPrecision
): number {
    const slotIndex = WBCacheSlot.MoonEclipticLatitudeLow + p;
    if (cache && cache.isValid(slotIndex)) return cache.get(slotIndex);

    const U = lunarLatitudeForTDT(centuriesSinceEpochTDT, p, cache);
    const Ur = U * Math.PI / 180 + lunarAberrationU(centuriesSinceEpochTDT);
    if (cache) cache.set(slotIndex, Ur);
    return Ur;
}

/** Returns km. */
export function WB_MoonDistance(
    centuriesSinceEpochTDT: number,
    cache: AstroCache | undefined,
    p: ECWBPrecision
): number {
    const slotIndex = WBCacheSlot.MoonDistanceLow + p;
    if (cache && cache.isValid(slotIndex)) return cache.get(slotIndex);

    let R = lunarDistanceForTDT(centuriesSinceEpochTDT, p, cache);
    R += lunarAberrationR(centuriesSinceEpochTDT);
    if (cache) cache.set(slotIndex, R);
    return R;
}

/** Returns radians. Uses full precision. */
export function WB_MoonAscendingNodeLongitude(
    centuriesSinceEpochTDT: number,
    cache?: AstroCache
): number {
    if (cache && cache.isValid(WBCacheSlot.AscendingNodeLongitude)) {
        return cache.get(WBCacheSlot.AscendingNodeLongitude);
    }

    const t = centuriesSinceEpochTDT;
    const p = ECWBPrecision.Full;
    const t2 = t * t;
    const t3 = t * t2;

    // Compute Vdot
    let SVdot = 0;
    const nvEnd = Nv[p];
    for (let i = 0; i < nvEnd; i++) {
        const d = Sv[i];
        const cosArg = d.an0 + d.an1 * t + d.an2 * t2 * 1E-4
            + d.an3 * t3 * 1E-6 + d.an4 * (t2 * t2) * 1E-8;
        const derivArg = d.an1 + 2 * d.an2 * t * 1E-4
            + 3 * d.an3 * t2 * 1E-6 + 4 * d.an4 * t3 * 1E-8;
        SVdot += d.vn * derivArg * Math.cos((Math.PI / 180) * cosArg);
    }
    SVdot *= (Math.PI / 180);

    let SV1dot = 0;
    for (let i = 0; i < N1v[p]; i++) {
        const d = Sv1[i];
        const cosArg = d.an0 + d.an1 * t;
        SV1dot += d.vn * d.an1 * Math.cos((Math.PI / 180) * cosArg);
    }
    SV1dot *= (Math.PI / 180);

    let SV2dot = 0;
    for (let i = 0; i < N2v[p]; i++) {
        const d = Sv2[i];
        SV2dot += d.vn * d.an1 * Math.cos((Math.PI / 180) * (d.an0 + d.an1 * t));
    }
    SV2dot *= (Math.PI / 180);

    let SV3dot = 0;
    for (let i = 0; i < N3v[p]; i++) {
        const d = Sv3[i];
        SV3dot += d.vn * d.an1 * Math.cos((Math.PI / 180) * (d.an0 + d.an1 * t));
    }
    SV3dot *= (Math.PI / 180);

    const Vdot = 481267.881 - 0.0026536 * t + 0.05568E-4 * t2 - 0.06136E-6 * t3
        + SVdot + 1E-3 * (SV1dot + t * SV2dot + t2 * SV3dot * 1E-4);

    // Compute Udot
    let SUdot = 0;
    const nuEnd = Nu[p];
    for (let i = 0; i < nuEnd; i++) {
        const d = Su[i];
        const cosArg = d.bn0 + d.bn1 * t + d.bn2 * t2 * 1E-4
            + d.bn3 * t3 * 1E-6 + d.bn4 * (t2 * t2) * 1E-8;
        const derivArg = d.bn1 + 2 * d.bn2 * t * 1E-4
            + 3 * d.bn3 * t2 * 1E-6 + 4 * d.bn4 * t3 * 1E-8;
        SUdot += d.un * derivArg * Math.cos((Math.PI / 180) * cosArg);
    }
    SUdot *= (Math.PI / 180);

    let SU1dot = 0;
    for (let i = 0; i < N1u[p]; i++) {
        const d = Su1[i];
        SU1dot += d.un * d.bn1 * Math.cos((Math.PI / 180) * (d.bn0 + d.bn1 * t));
    }
    SU1dot *= (Math.PI / 180);

    let SU2dot = 0;
    for (let i = 0; i < N2u[p]; i++) {
        const d = Su2[i];
        SU2dot += d.un * d.bn1 * Math.cos((Math.PI / 180) * (d.bn0 + d.bn1 * t));
    }
    SU2dot *= (Math.PI / 180);

    let SU3dot = 0;
    for (let i = 0; i < N3u[p]; i++) {
        const d = Su3[i];
        SU3dot += d.un * d.bn1 * Math.cos((Math.PI / 180) * (d.bn0 + d.bn1 * t));
    }
    SU3dot *= (Math.PI / 180);

    const Udot = SUdot + 1E-3 * (SU1dot + t * SU2dot + 1E-4 * t2 * SU3dot);

    // Compute Omega from V, U, Vdot, Udot
    const V = lunarLongitudeForTDT(centuriesSinceEpochTDT, p, cache);
    const U = lunarLatitudeForTDT(centuriesSinceEpochTDT, p, cache);

    const cosU = Math.cos(Math.PI / 180 * U);
    const sinU = Math.sin(Math.PI / 180 * U);
    const cosV = Math.cos(Math.PI / 180 * V);
    const sinV = Math.sin(Math.PI / 180 * V);

    const Y = Udot * sinV - Vdot * sinU * cosU * cosV;
    const Z = Udot * cosV + Vdot * sinU * cosU * sinV;

    const Omega = Math.atan2(Y, Z);
    let L = fmod(Omega, 2 * Math.PI);
    if (L < 0) L += 2 * Math.PI;

    if (cache) cache.set(WBCacheSlot.AscendingNodeLongitude, L);
    return L;
}
