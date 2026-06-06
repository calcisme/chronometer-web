/**
 * Phase 7B eclipse simulator tests.
 *
 *  (a) calculateEclipse / EclipseKind around known eclipses — validates the
 *      quantities the expr-function wrappers (eclipseAngularSeparation,
 *      eclipseShadowAngularSize, eclipseKindRaw) read.
 *  (b) the EC_UPDATE_NEXT_INTERESTING_ECLIPSE_MOTION resolver: ~1 s while the
 *      disc is shown (separation < 10°), and a capped (≤1 h) interval that never
 *      overshoots the threshold crossing while only the caption is up.
 */
import { describe, test, expect } from 'vitest';
import {
    calculateEclipse,
    EclipseKind,
    eclipseKindIsMoreSolarThanLunar,
} from '../../astronomy/es-astro';
import { nextInterestingEclipseMotion } from '../../shared/animation';

function appleEpoch(date: Date): number {
    return date.getTime() / 1000 - 978307200;
}
function toRad(deg: number): number {
    return deg * Math.PI / 180;
}

const THRESHOLD = Math.PI / 18;  // 10°

describe('calculateEclipse — known events', () => {
    test('2026-08-12 total solar eclipse: small separation, solar kind', () => {
        // Greatest eclipse ≈ 17:46 UT; path crosses northern Spain.
        const t = appleEpoch(new Date('2026-08-12T18:30:00Z'));
        const r = calculateEclipse(t, toRad(43.0), toRad(-6.0), null);
        expect(r.angularSeparation).toBeLessThan(THRESHOLD);
        expect(eclipseKindIsMoreSolarThanLunar(r.eclipseKind)).toBe(true);
    });

    test('2026-03-03 total lunar eclipse: small separation, lunar kind, shadow > 0', () => {
        // Greatest eclipse ≈ 11:33 UT; visible from the Pacific / E. Asia.
        const t = appleEpoch(new Date('2026-03-03T11:33:00Z'));
        const r = calculateEclipse(t, toRad(20.7), toRad(-156.15), null);
        expect(r.angularSeparation).toBeLessThan(THRESHOLD);
        expect(eclipseKindIsMoreSolarThanLunar(r.eclipseKind)).toBe(false);
        expect(r.shadowAngularSize).toBeGreaterThan(0);
    });

    test('first quarter moon: large separation, no eclipse', () => {
        // 2026-08-20 is roughly first quarter (≈90° from new on 2026-08-12).
        const t = appleEpoch(new Date('2026-08-20T12:00:00Z'));
        const r = calculateEclipse(t, toRad(37.2), toRad(-121.9), null);
        expect(r.angularSeparation).toBeGreaterThan(THRESHOLD);
        expect([EclipseKind.NoneSolar, EclipseKind.NoneLunar]).toContain(r.eclipseKind);
    });
});

describe('eclipse update sentinel resolver', () => {
    const lat = toRad(43.0), lon = toRad(-6.0);
    const at = (iso: string) => () => new Date(iso);

    test('inside the threshold → ~1 s cadence (forward)', () => {
        const getNow = at('2026-08-12T18:30:00Z');
        const nowDI = appleEpoch(getNow());
        const next = nextInterestingEclipseMotion(getNow, lat, lon, 1);
        expect(next - nowDI).toBeCloseTo(1, 6);
    });

    test('outside the threshold → capped at ≤ 1 hour, in the future', () => {
        const getNow = at('2026-08-20T12:00:00Z');  // first quarter, far from eclipse
        const nowDI = appleEpoch(getNow());
        const next = nextInterestingEclipseMotion(getNow, lat, lon, 1);
        const dt = next - nowDI;
        expect(dt).toBeGreaterThan(1);
        expect(dt).toBeLessThanOrEqual(3600);
    });

    test('never overshoots the crossing: separation stays > threshold at the returned time', () => {
        // ~1.5 days before the solar eclipse, comfortably outside 10°.
        const getNow = at('2026-08-11T00:00:00Z');
        const nowDI = appleEpoch(getNow());
        const sepNow = calculateEclipse(nowDI, lat, lon, null).angularSeparation;
        expect(sepNow).toBeGreaterThan(THRESHOLD);  // precondition: caption mode
        const next = nextInterestingEclipseMotion(getNow, lat, lon, 1);
        const sepNext = calculateEclipse(next, lat, lon, null).angularSeparation;
        // Conservative bound must not skip past the crossing into the disc-drawn
        // region (allow a tiny epsilon for the boundary itself).
        expect(sepNext).toBeGreaterThan(THRESHOLD - 1e-6);
    });

    test('reverse time direction returns a time in the past', () => {
        const getNow = at('2026-08-20T12:00:00Z');
        const nowDI = appleEpoch(getNow());
        const next = nextInterestingEclipseMotion(getNow, lat, lon, -1);
        expect(next).toBeLessThan(nowDI);
        expect(nowDI - next).toBeLessThanOrEqual(3600);
    });
});
