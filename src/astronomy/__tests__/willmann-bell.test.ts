/**
 * Willmann-Bell unit tests based on STANDALONE EXAMPLE5 and EXAMPLE12
 * from ESWillmannBell.cpp, with known expected values from the book.
 */
import { describe, it, expect } from 'vitest';
import { ECWBPrecision } from '../astro-constants.js';
import {
    lunarLongitudeForTDT,
    lunarLatitudeForTDT,
    lunarDistanceForTDT,
    WB_MoonRAAndDecl,
    WB_MoonEclipticLongitude,
    WB_MoonAscendingNodeLongitude,
} from '../wb-moon.js';
import {
    WB_sunRAAndDecl,
    WB_sunLongitudeRaw,
    WB_sunLongitudeApparent,
} from '../wb-sun.js';

// Helper: Julian Date for a calendar date (from MCT/JP sec 4.2 p8)
function JDForDate(yr: number, mo: number, dy: number, hr: number, mi: number, sc: number): number {
    let yprime: number, mprime: number;
    if (mo > 2) { mprime = mo; yprime = yr; }
    else { mprime = mo + 12; yprime = yr - 1; }

    let C: number, yearSign: number, absYprime: number;
    if (yprime < 0) { C = -0.75; yearSign = -1; absYprime = -yprime; }
    else { C = 0; yearSign = 1; absYprime = yprime; }

    let B: number;
    if (yr < 1582 || (yr === 1582 && (mo < 10 || (mo === 10 && dy < 5)))) {
        B = 0;
    } else {
        const A = Math.floor(absYprime / 100);
        B = (2 - A + Math.floor(A / 4)) * yearSign;
    }

    return 1720994.5 + Math.trunc(365.25 * yprime + C)
        + Math.trunc(30.60001 * (mprime + 1)) + dy + B
        + hr / 24.0 + mi / 1440.0 + sc / 86400.0;
}

function TDTForTDTDate(yr: number, mo: number, dy: number, hr: number, mi: number, sc: number): number {
    return (JDForDate(yr, mo, dy, hr, mi, sc) - 2451545) / 36525;
}

// Meeus Delta T for UT->TDT conversion
function ECMeeusDeltaT(yearValue: number): number {
    if (yearValue < 948) {
        const t = (yearValue - 2000) / 100;
        return 2177 + 497 * t + 44.1 * t * t;
    } else if (yearValue < 1620) {
        const t = (yearValue - 2000) / 100;
        return 102 + 102 * t + 25.3 * t * t;
    } else if (yearValue >= 2100) {
        const t = (yearValue - 2000) / 100;
        return 102 + 102 * t + 25.3 * t * t;
    } else if (yearValue > 2004) {
        const t = (yearValue - 2000) / 100;
        return 102 + 102 * t + 25.3 * t * t + 0.37 * (yearValue - 2100);
    } else {
        // Use deltaTTable for 1620-2004
        const deltaTTable = [
            121,112,103,95,88,82,77,72,68,63,60,56,53,51,48,46,44,42,40,38,
            35,33,31,29,26,24,22,20,18,16,14,12,11,10,9,8,7,7,7,7,
            7,7,8,8,9,9,9,9,9,10,10,10,10,10,10,10,10,11,11,11,
            11,11,12,12,12,12,13,13,13,14,14,14,14,15,15,15,15,15,16,16,
            16,16,16,16,16,16,15,15,14,13,
            13.1,12.5,12.2,12,12,12,12,12,12,11.9,
            11.6,11,10.2,9.2,8.2,7.1,6.2,5.6,5.4,5.3,
            5.4,5.6,5.9,6.2,6.5,6.8,7.1,7.3,7.5,7.6,
            7.7,7.3,6.2,5.2,2.7,1.4,-1.2,-2.8,-3.8,-4.8,
            -5.5,-5.3,-5.6,-5.7,-5.9,-6.0,-6.3,-6.5,-6.2,-4.7,
            -2.8,-0.1,2.6,5.3,7.7,10.4,13.3,16.0,18.2,20.2,
            21.1,22.4,23.5,23.8,24.3,24,23.9,23.9,23.7,24,
            24.3,25.3,26.2,27.3,28.2,29.1,30,30.7,31.4,32.2,
            33.1,34,35,36.5,38.3,40.2,42.2,44.5,46.5,48.5,
            50.5,52.2,53.8,54.9,55.8,56.9,58.3,60,61.6,63,
            63.8,64.3,64.6
        ];
        if (yearValue === 2004) return deltaTTable[(2004 - 1620) / 2];
        const realIndex = (yearValue - 1620) / 2;
        const priorIndex = Math.floor(realIndex);
        const interpolation = realIndex - priorIndex;
        return deltaTTable[priorIndex] + (deltaTTable[priorIndex + 1] - deltaTTable[priorIndex]) * interpolation;
    }
}

function TDTForUTDate(yr: number, mo: number, dy: number, hr: number, mi: number, sc: number): number {
    const t = TDTForTDTDate(yr, mo, dy, hr, mi, sc);
    const yearValue = t * 100 + 2000;
    const deltaT = ECMeeusDeltaT(yearValue);
    return t + deltaT / (36525 * 24 * 3600);
}

describe('EXAMPLE5 — Moon position tests from book tables', () => {
    it('EXAMPLE5A: Moon at 1563 BC, low precision', () => {
        const t = TDTForTDTDate(-1562, 2, 10, 16, 5, 0);
        expect(t).toBeCloseTo(-35.6185305917, 8);

        const V = lunarLongitudeForTDT(t, ECWBPrecision.Low);
        expect(V).toBeCloseTo(285.5572, 3);

        const U = lunarLatitudeForTDT(t, ECWBPrecision.Low);
        expect(U).toBeCloseTo(2.2214, 3);

        const R = lunarDistanceForTDT(t, ECWBPrecision.Low);
        expect(R).toBeCloseTo(375342, 0);
    });

    it('EXAMPLE5B: Moon at 1590 AD, mid precision', () => {
        const t = TDTForUTDate(1590, 1, 15, 2, 25, 30);
        expect(t).toBeCloseTo(-4.0995317709, 7);

        const V = lunarLongitudeForTDT(t, ECWBPrecision.Mid);
        expect(V).toBeCloseTo(51.96876, 2); // Looser tolerance due to Meeus vs Chapront DeltaT

        const U = lunarLatitudeForTDT(t, ECWBPrecision.Mid);
        expect(U).toBeCloseTo(-5.20601, 4);

        const R = lunarDistanceForTDT(t, ECWBPrecision.Mid);
        expect(Math.abs(R - 388236.5)).toBeLessThan(2); // Loose tolerance: Meeus vs Chapront DeltaT
    });

    it('EXAMPLE5C: Moon at 1986 AD, full precision', () => {
        const t = TDTForUTDate(1986, 8, 7, 22, 15, 12);
        expect(t).toBeCloseTo(-0.13400608189, 9);

        const V = lunarLongitudeForTDT(t, ECWBPrecision.Full);
        expect(V).toBeCloseTo(160.466436, 4);

        const U = lunarLatitudeForTDT(t, ECWBPrecision.Full);
        expect(U).toBeCloseTo(3.422415, 4);

        const R = lunarDistanceForTDT(t, ECWBPrecision.Full);
        expect(R).toBeCloseTo(388150.634, 0);

        const m = WB_MoonRAAndDecl(t, undefined, ECWBPrecision.Full);
        expect(m.rightAscension * 12 / Math.PI).toBeCloseTo(10.8857436, 5);
        expect(m.declination * 180 / Math.PI).toBeCloseTo(10.810752, 4);
    });

    it('EXAMPLE5A full precision: RA and Decl', () => {
        const t = TDTForTDTDate(-1562, 2, 10, 16, 5, 0);
        const m = WB_MoonRAAndDecl(t, undefined, ECWBPrecision.Full);
        expect(m.longitude * 180 / Math.PI).toBeCloseTo(285.5617, 2);
        expect(m.latitude * 180 / Math.PI).toBeCloseTo(2.216, 2);
        expect(m.rightAscension * 12 / Math.PI).toBeCloseTo(19.11097, 3);
        expect(m.declination * 180 / Math.PI).toBeCloseTo(-20.7487, 3);
    });
});

describe('EXAMPLE12 — Ascending node longitude', () => {
    it('EXAMPLE12A: Low precision at 497 BC', () => {
        const t = TDTForTDTDate(-497, 4, 1, 2, 6, 0);
        const Omega = 180.0 / Math.PI * WB_MoonAscendingNodeLongitude(t);
        expect(Omega).toBeCloseTo(176.4, 0);
    });

    it('EXAMPLE12B: Mid precision at 1420 AD', () => {
        const t = TDTForTDTDate(1420, 9, 22, 12, 10, 20);
        const Omega = 180.0 / Math.PI * WB_MoonAscendingNodeLongitude(t);
        expect(Omega).toBeCloseTo(169.51, 1);
    });

    it('EXAMPLE12C: Full precision at 1990 AD', () => {
        const t = TDTForTDTDate(1990, 9, 20, 22, 50, 43);
        const Omega = 180.0 / Math.PI * WB_MoonAscendingNodeLongitude(t);
        expect(Omega).toBeCloseTo(306.010, 2);
    });
});
