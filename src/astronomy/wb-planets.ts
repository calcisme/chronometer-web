/**
 * Willmann-Bell planet computation functions.
 * Ported from ESWillmannBell.cpp — inner and outer planet sections.
 */

import { fmod } from './astro-constants.js';
import { AstroCache } from './astro-cache.js';
import {
    WB_sunLongitudeRadiusRaw, WB_nutationObliquity,
} from './wb-sun.js';
import {
    mercuryLongitudeData, mercuryLatitudeData, mercuryRadiusData,
    numMercuryLongData, numMercuryLatData, numMercuryRadData,
    venusLongitudeData, venusLatitudeData, venusRadiusData,
    numVenusLongData, numVenusLatData, numVenusRadData,
    marsLongitudeData, marsLatitudeData, marsRadiusData,
    numMarsLongData, numMarsLatData, numMarsRadData,
    jupiterDescriptor, saturnDescriptor, uranusDescriptor, neptuneDescriptor,
    type OuterPlanetDescriptor, type OuterPlanetDatum,
} from './planet-tables.js';

// ---- Geocentric conversion (shared helper) ----

export interface GeocentricResult {
    geoLong: number;
    geoLat: number;
    distance: number;
    ra: number;
    decl: number;
}

function convertGeocentric(
    planetHelioLong: number, planetHelioLat: number, planetHelioRad: number,
    sunMeanLong: number, sunMeanRad: number,
    longAberration: number, latAberration: number,
    obliquity: number, nutation: number,
): GeocentricResult {
    const xSun = sunMeanRad * Math.cos(sunMeanLong);
    const ySun = sunMeanRad * Math.sin(sunMeanLong);

    const cosLat = Math.cos(planetHelioLat);
    const xP = planetHelioRad * cosLat * Math.cos(planetHelioLong);
    const yP = planetHelioRad * cosLat * Math.sin(planetHelioLong);
    const zP = planetHelioRad * Math.sin(planetHelioLat);

    const xGeo = xSun + xP;
    const yGeo = ySun + yP;
    const zGeo = zP; // zSunGeo = 0

    const distance = Math.sqrt(xGeo * xGeo + yGeo * yGeo + zGeo * zGeo);
    const meanGeoLong = Math.atan2(yGeo, xGeo);
    const meanGeoLat = Math.atan2(zGeo, Math.sqrt(xGeo * xGeo + yGeo * yGeo));

    let geoLong = meanGeoLong + longAberration + nutation;
    if (geoLong < 0) geoLong += Math.PI * 2;
    else if (geoLong > Math.PI * 2) geoLong -= Math.PI * 2;
    const geoLat = meanGeoLat + latAberration;

    const cosObl = Math.cos(obliquity);
    const sinObl = Math.sin(obliquity);
    const sinLat = Math.sin(geoLat);
    const cosLatG = Math.cos(geoLat);
    const sinLong = Math.sin(geoLong);
    const sinDecl = cosObl * sinLat + sinObl * cosLatG * sinLong;
    const decl = Math.asin(sinDecl);
    const y = cosObl * cosLatG * sinLong - sinObl * sinLat;
    const x = cosLatG * Math.cos(geoLong);
    let ra = fmod(Math.atan2(y, x), Math.PI * 2);
    if (ra < 0) ra += Math.PI * 2;

    return { geoLong, geoLat, distance, ra, decl };
}

// ---- Inner planet helper ----

function innerPlanetApparentPosition(
    U: number,
    helioLong: number, helioLat: number, radius: number,
    longAber: number, latAber: number,
    cache?: AstroCache
): GeocentricResult {
    const { longitude: sunLong, radius: sunRad } = WB_sunLongitudeRadiusRaw(U, cache);
    const { nutation, obliquity } = WB_nutationObliquity(U, cache);
    return convertGeocentric(
        helioLong, helioLat, radius,
        sunLong, sunRad,
        longAber, latAber,
        obliquity, nutation,
    );
}

// ---- MERCURY ----

export function mercuryHeliocentricLongitude(U: number): number {
    const U_2 = U * U, U_3 = U * U_2, U_4 = U_2 * U_2, U_5 = U * U_4;
    let L = 0;
    for (let i = 0; i < numMercuryLongData; i++) {
        const d = mercuryLongitudeData[i];
        L += d.vi * Math.sin(d.ai + U * d.bi);
    }
    L = L * 1E-7 + 4.4429839 + 260881.4701279 * U
        + 1E-6 * (409894.2 + 2435 * U - 1408 * U_2 + 114 * U_3 + 233 * U_4 - 88 * U_5)
        * Math.sin(3.053817 + 260878.756773 * U - 0.001093 * U_2 - 0.00093 * U_3 + 0.00043 * U_4 + 0.00014 * U_5);
    L = fmod(L, Math.PI * 2);
    if (L < 0) L += Math.PI * 2;
    return L;
}

export function mercuryHeliocentricLatitude(U: number): number {
    let L = 0;
    for (let i = 0; i < numMercuryLatData; i++) {
        const d = mercuryLatitudeData[i];
        L += d.vi * Math.sin(d.ai + U * d.bi);
    }
    return L * 1E-7;
}

export function mercuryRadius(U: number): number {
    let R = 0;
    for (let i = 0; i < numMercuryRadData; i++) {
        const d = mercuryRadiusData[i];
        R += d.vi * Math.cos(d.ai + U * d.bi);
    }
    return 0.3952020 + 1E-7 * R;
}

export function mercuryLongitudeAberration(U: number): number {
    return 1E-7 * (-1261 + 1485 * Math.cos(2.649 + 198048.273 * U)
        + 305 * Math.cos(5.71 + 458927.03 * U)
        + 230 * Math.cos(5.30 + 396096.55 * U));
}

export function mercuryLatitudeAberration(U: number): number {
    return 190E-7 * Math.cos(0.42 + 260879.41 * U);
}

export function mercuryApparentPosition(U: number, cache?: AstroCache): GeocentricResult {
    return innerPlanetApparentPosition(U,
        mercuryHeliocentricLongitude(U), mercuryHeliocentricLatitude(U), mercuryRadius(U),
        mercuryLongitudeAberration(U), mercuryLatitudeAberration(U), cache);
}

// ---- VENUS ----

export function venusHeliocentricLongitude(U: number): number {
    const U_2 = U * U, U_3 = U * U_2, U_4 = U_2 * U_2, U_5 = U * U_4, U_6 = U_3 * U_3;
    let L = 0;
    for (let i = 0; i < numVenusLongData; i++) {
        const d = venusLongitudeData[i];
        L += d.vi * Math.sin(d.ai + U * d.bi);
    }
    L = L * 1E-7 + 3.2184413 + 102135.2937764 * U
        + 1E-6 * (13539.7 - 9570.0 * U + 1987 * U_2 + 927 * U_3 + 230 * U_4 - 51 * U_5 + 10 * U_6)
        * Math.sin(0.88074 + 102132.84648 * U + 0.24082 * U_2 + 0.1004 * U_3 + 0.0355 * U_4 - 0.0017 * U_5 - 0.0151 * U_6)
        + 1E-6 * (898.9 + 112.4 * U - 170 * U_2 + 113 * U_3 + 34 * U_4 - 79 * U_5 + 56 * U_6)
        * Math.sin(0.5941 + 204267.3130 * U + 0.014 * U_2 + 0.123 * U_3 - 0.146 * U_4 + 0.052 * U_5);
    L = fmod(L, Math.PI * 2);
    if (L < 0) L += Math.PI * 2;
    return L;
}

export function venusHeliocentricLatitude(U: number): number {
    const U_2 = U * U, U_3 = U * U_2, U_4 = U_2 * U_2;
    let L = 0;
    for (let i = 0; i < numVenusLatData; i++) {
        const d = venusLatitudeData[i];
        L += d.vi * Math.sin(d.ai + U * d.bi);
    }
    L = L * 1E-7
        + 1E-7 * (4011 - 2713 * U + 490 * U_2 + 290 * U_3 + 90 * U_4)
        * Math.sin(2.7182 + 204266.568 * U + 0.225 * U_2 + 0.102 * U_3 + 0.035 * U_4)
        + 1E-7 * (101 + 26 * U - 64 * U_2)
        * Math.sin(2.66 + 306400.49 * U + 0.45 * U_2);
    return L;
}

export function venusRadius(U: number): number {
    const U_2 = U * U, U_3 = U * U_2, U_4 = U_2 * U_2, U_5 = U_2 * U_3, U_6 = U_3 * U_3;
    let R = 0;
    for (let i = 0; i < numVenusRadData; i++) {
        const d = venusRadiusData[i];
        R += d.vi * Math.cos(d.ai + U * d.bi);
    }
    R = R * 1E-7 + 0.7235481
        + 1E-7 * (48982 - 34549 * U + 7096 * U_2 + 3360 * U_3 + 890 * U_4 - 210 * U_5)
        * Math.cos(4.02152 + 102132.84695 * U + 0.2420 * U_2 + 0.0994 * U_3 + 0.0351 * U_4 - 0.0013 * U_5 - 0.015 * U_6)
        + 1E-7 * (166 - 234 * U + 131 * U_2)
        * Math.cos(4.90 + 204265.69 * U + 0.48 * U_2 + 0.20 * U_3);
    return R;
}

export function venusLongitudeAberration(U: number): number {
    return 1E-7 * (-1304 + 1016 * Math.cos(1.423 + 39302.097 * U)
        + 224 * Math.cos(2.85 + 78604.19 * U)
        + 98 * Math.cos(4.27 + 117906.29 * U));
}

export function venusApparentPosition(U: number, cache?: AstroCache): GeocentricResult {
    return innerPlanetApparentPosition(U,
        venusHeliocentricLongitude(U), venusHeliocentricLatitude(U), venusRadius(U),
        venusLongitudeAberration(U), 0, cache);
}

// ---- MARS ----

export function marsHeliocentricLongitude(U: number): number {
    const U_2 = U * U, U_3 = U * U_2, U_4 = U_2 * U_2, U_5 = U * U_4, U_6 = U_3 * U_3;
    let L = 0;
    for (let i = 0; i < numMarsLongData; i++) {
        const d = marsLongitudeData[i];
        L += d.vi * Math.sin(d.ai + U * d.bi);
    }
    L = L * 1E-7 + 6.2458611 + 33408.5620646 * U
        + 1E-6 * (186563.7 + 18135.0 * U - 1332 * U_2 - 704 * U_3 - 65 * U_4 - 89 * U_5 + 9 * U_6)
        * Math.sin(0.337967 + 33405.348759 * U + 0.031676 * U_2 - 0.007354 * U_3 + 0.001143 * U_4 - 0.00029 * U_5 - 0.00010 * U_6);
    L = fmod(L, Math.PI * 2);
    if (L < 0) L += Math.PI * 2;
    return L;
}

export function marsHeliocentricLatitude(U: number): number {
    const U_2 = U * U, U_3 = U * U_2, U_4 = U_2 * U_2, U_5 = U_2 * U_3, U_6 = U_3 * U_3, U_7 = U_3 * U_4;
    let L = 0;
    for (let i = 0; i < numMarsLatData; i++) {
        const d = marsLatitudeData[i];
        L += d.vi * Math.sin(d.ai + U * d.bi);
    }
    L = L * 1E-7
        + 1E-7 * (319714 - 10277 * U + 24272 * U_2 - 2420 * U_3 - 10850 * U_4 + 3880 * U_5 + 5310 * U_6 - 1050 * U_7)
        * Math.sin(5.339102 + 33407.21879 * U + 0.04800 * U_2 - 0.04831 * U_3 + 0.01402 * U_4 + 0.0290 * U_5 - 0.0073 * U_6 - 0.0112 * U_7)
        + 1E-7 * (29803 + 1904 * U + 1865 * U_2 - 60 * U_3 - 950 * U_4 + 220 * U_5 + 270 * U_6)
        * Math.sin(5.67694 + 66812.5668 * U + 0.0803 * U_2 - 0.0536 * U_3 + 0.0147 * U_4 + 0.028 * U_5)
        + 1E-7 * (3137 + 472 * U + 111 * U_2 + 70 * U_3)
        * Math.sin(6.0173 + 100217.928 * U + 0.093 * U_2 - 0.086 * U_3 + 0.037 * U_4);
    return L;
}

export function marsRadius(U: number): number {
    const U_2 = U * U, U_3 = U * U_2, U_4 = U_2 * U_2, U_5 = U_2 * U_3, U_6 = U_3 * U_3;
    let R = 0;
    for (let i = 0; i < numMarsRadData; i++) {
        const d = marsRadiusData[i];
        R += d.vi * Math.cos(d.ai + U * d.bi);
    }
    R = R * 1E-7 + 1.529856
        + 1E-6 * (141849.5 + 13651.8 * U - 1230 * U_2 - 378 * U_3 + 187 * U_4 - 153 * U_5 - 73 * U_6)
        * Math.cos(3.479698 + 33405.349560 * U + 0.030669 * U_2 - 0.00909 * U_3 + 0.00223 * U_4 + 0.00083 * U_5 - 0.00048 * U_6)
        + 1E-6 * (6607.8 + 1272.8 * U - 53 * U_2 - 46 * U_3 + 14 * U_4 - 12 * U_5 + 99 * U_6)
        * Math.cos(3.81781 + 66810.6991 * U + 0.0613 * U_2 - 0.0182 * U_3 + 0.0044 * U_4 + 0.0012 * U_5 + 0.002 * U_6);
    return R;
}

export function marsLongitudeAberration(U: number): number {
    return 1E-7 * (-1052 + 877 * Math.cos(1.834 + 29424.634 * U)
        + 187 * Math.cos(3.67 + 58849.27 * U)
        + 84 * Math.cos(3.49 + 33405.34 * U));
}

export function marsApparentPosition(U: number, cache?: AstroCache): GeocentricResult {
    return innerPlanetApparentPosition(U,
        marsHeliocentricLongitude(U), marsHeliocentricLatitude(U), marsRadius(U),
        marsLongitudeAberration(U), 0, cache);
}

// ---- Outer planet helpers ----

function calcOuterValue(Vs: number[], coeffs: readonly number[]): number {
    return coeffs[0] + coeffs[1] * Vs[1] + coeffs[2] * Vs[2]
        + coeffs[3] * Vs[3] + coeffs[4] * Vs[4]
        + coeffs[5] * Vs[5] + coeffs[6] * Vs[6];
}

function makeVsTable(V: number): number[] {
    const Vs = [1, V, V * V, 0, 0, 0, 0];
    Vs[3] = Vs[2] * V;
    Vs[4] = Vs[2] * Vs[2];
    Vs[5] = Vs[3] * Vs[2];
    Vs[6] = Vs[3] * Vs[3];
    return Vs;
}

function findOuterPlanetDatum(
    U: number, descriptor: OuterPlanetDescriptor
): { datum: OuterPlanetDatum; V: number } | null {
    if (isNaN(U)) return null;
    const jdRanges = descriptor.jdRange;
    const jd = U * 3652500 + 2451545;
    const firstJD = jdRanges[0].startJD;
    const lastJD = jdRanges[descriptor.numEntries - 1].endJD;

    if (jd < firstJD || jd > lastJD) return null;

    const fract = (jd - firstJD) / (lastJD - 4 - firstJD);
    let indx = Math.trunc(fract * descriptor.numEntries);
    if (indx < 0) indx = 0;
    else if (indx > descriptor.numEntries - 1) indx = descriptor.numEntries - 1;

    if (jd < jdRanges[indx].startJD) {
        indx--;
    } else if (indx < descriptor.numEntries - 1 && jd >= jdRanges[indx + 1].startJD) {
        indx++;
    }

    const V = (jd - jdRanges[indx].startJD) / 2000;
    return { datum: descriptor.data[indx], V };
}

function outerHelioLong(U: number, desc: OuterPlanetDescriptor): number {
    const r = findOuterPlanetDatum(U, desc);
    if (!r) return 0;
    const Vs = makeVsTable(r.V);
    let L = calcOuterValue(Vs, r.datum.aLong);
    L = fmod(L, Math.PI * 2);
    if (L < 0) L += Math.PI * 2;
    return L;
}

function outerHelioLat(U: number, desc: OuterPlanetDescriptor): number {
    const r = findOuterPlanetDatum(U, desc);
    if (!r) return 0;
    return calcOuterValue(makeVsTable(r.V), r.datum.aLat);
}

function outerRadius(U: number, desc: OuterPlanetDescriptor): number {
    const r = findOuterPlanetDatum(U, desc);
    if (!r) return 0;
    return calcOuterValue(makeVsTable(r.V), r.datum.aRad);
}

// ---- JUPITER ----
export const jupiterHeliocentricLongitude = (U: number) => outerHelioLong(U, jupiterDescriptor);
export const jupiterHeliocentricLatitude = (U: number) => outerHelioLat(U, jupiterDescriptor);
export const jupiterRadius = (U: number) => outerRadius(U, jupiterDescriptor);
export function jupiterLongitudeAberration(U: number): number {
    return 1E-7 * (-527 + 978 * Math.cos(1.154 + 57533.849 * U)
        + 89 * Math.cos(2.30 + 115067.70 * U)
        + 46 * Math.cos(4.64 + 62830.76 * U)
        + 45 * Math.cos(0.76 + 52236.94 * U));
}
export function jupiterApparentPosition(U: number, cache?: AstroCache): GeocentricResult {
    return innerPlanetApparentPosition(U,
        jupiterHeliocentricLongitude(U), jupiterHeliocentricLatitude(U), jupiterRadius(U),
        jupiterLongitudeAberration(U), 0, cache);
}

// ---- SATURN ----
export const saturnHeliocentricLongitude = (U: number) => outerHelioLong(U, saturnDescriptor);
export const saturnHeliocentricLatitude = (U: number) => outerHelioLat(U, saturnDescriptor);
export const saturnRadius = (U: number) => outerRadius(U, saturnDescriptor);
export function saturnLongitudeAberration(U: number): number {
    return 1E-7 * (-373 + 986 * Math.cos(0.880 + 60697.768 * U)
        + 54 * Math.cos(3.31 + 62830.76 * U)
        + 52 * Math.cos(1.59 + 58564.78 * U)
        + 51 * Math.cos(1.76 + 121395.54 * U));
}
export function saturnApparentPosition(U: number, cache?: AstroCache): GeocentricResult {
    return innerPlanetApparentPosition(U,
        saturnHeliocentricLongitude(U), saturnHeliocentricLatitude(U), saturnRadius(U),
        saturnLongitudeAberration(U), 0, cache);
}

// ---- URANUS ----
export const uranusHeliocentricLongitude = (U: number) => outerHelioLong(U, uranusDescriptor);
export const uranusHeliocentricLatitude = (U: number) => outerHelioLat(U, uranusDescriptor);
export const uranusRadius = (U: number) => outerRadius(U, uranusDescriptor);
export function uranusLongitudeAberration(U: number): number {
    return 1E-7 * (-252 + 990 * Math.cos(2.555 + 62082.943 * U)
        + 46 * Math.cos(1.88 + 62830.76 * U)
        + 45 * Math.cos(0.11 + 61335.13 * U));
}
export function uranusApparentPosition(U: number, cache?: AstroCache): GeocentricResult {
    return innerPlanetApparentPosition(U,
        uranusHeliocentricLongitude(U), uranusHeliocentricLatitude(U), uranusRadius(U),
        uranusLongitudeAberration(U), 0, cache);
}

// ---- NEPTUNE ----
export const neptuneHeliocentricLongitude = (U: number) => outerHelioLong(U, neptuneDescriptor);
export const neptuneHeliocentricLatitude = (U: number) => outerHelioLat(U, neptuneDescriptor);
export const neptuneRadius = (U: number) => outerRadius(U, neptuneDescriptor);
export function neptuneLongitudeAberration(U: number): number {
    return 1E-7 * (-198 + 993 * Math.cos(2.725 + 62449.428 * U));
}
export function neptuneApparentPosition(U: number, cache?: AstroCache): GeocentricResult {
    return innerPlanetApparentPosition(U,
        neptuneHeliocentricLongitude(U), neptuneHeliocentricLatitude(U), neptuneRadius(U),
        neptuneLongitudeAberration(U), 0, cache);
}
