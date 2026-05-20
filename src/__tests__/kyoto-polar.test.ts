/**
 * Kyoto day/night ring polar conditions unit tests.
 *
 * Verifies that wadokeiDNSunsetAngle/wadokeiDNSunriseAngle and
 * wadokeiDNNumVisible produce correct results when there is no
 * sunrise or sunset (polar summer/winter).
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import { parseWatchXML } from '../watch/xml-parser.js';
import { createWatchEnvironment } from '../watch/watch-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', 'watch', 'assets');

function loadKyotoWatch() {
    const xmlText = readFileSync(join(ASSETS_DIR, 'kyoto', 'Kyoto-I.xml'), 'utf-8');
    const dom = new JSDOM('', { contentType: 'text/html' });
    const domParser = new dom.window.DOMParser();
    return parseWatchXML(xmlText, 'front', domParser);
}

describe('Kyoto day/night ring polar handling', () => {
    let perfNowSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        perfNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => 1000);
    });

    afterAll(() => {
        perfNowSpy.mockRestore();
    });

    test('normal latitude (Kyoto 35°N) — summer produces reasonable night arc', () => {
        const watch = loadKyotoWatch();
        // June 21 noon — longest day at 35°N
        const getNow = () => new Date('2025-06-21T12:00:00+09:00');
        const env = createWatchEnvironment(watch, 35.0, 135.8, getNow, 'Asia/Tokyo');

        const sunsetAngle = (env.functions.get('wadokeiDNSunsetAngle') as () => number)();
        const sunriseAngle = (env.functions.get('wadokeiDNSunriseAngle') as () => number)();
        const numVis = (env.functions.get('wadokeiDNNumVisible') as (n: number) => number)(75);

        // At 35°N in June, there IS a sunrise and sunset.
        // Night arc should be between ~8h and ~16h (π/3 to π).
        let nightArc = sunriseAngle - sunsetAngle;
        if (nightArc < 0) nightArc += 2 * Math.PI;

        expect(nightArc).toBeGreaterThan(0.5);    // some night
        expect(nightArc).toBeLessThan(Math.PI);     // less than 12h night in summer
        expect(numVis).toBeGreaterThan(0);
        expect(numVis).toBeLessThan(75);
    });

    test('polar summer (85°N, June 21) — no sunset, numVis = 0', () => {
        const watch = loadKyotoWatch();
        // June 21 at 85°N — midnight sun, no sunset at all
        const getNow = () => new Date('2025-06-21T12:00:00Z');
        const env = createWatchEnvironment(watch, 85.0, 21.0, getNow, 'Europe/Oslo');

        const sunsetAngle = (env.functions.get('wadokeiDNSunsetAngle') as () => number)();
        const sunriseAngle = (env.functions.get('wadokeiDNSunriseAngle') as () => number)();
        const numVis = (env.functions.get('wadokeiDNNumVisible') as (n: number) => number)(75);

        // Polar summer: sunset and sunrise should be equal (zero-width night arc)
        expect(sunsetAngle).toBe(sunriseAngle);

        // No night wedges should be visible
        expect(numVis).toBe(0);
    });

    test('polar winter (85°N, December 21) — no sunrise, numVis = all', () => {
        const watch = loadKyotoWatch();
        // December 21 at 85°N — polar night, no sunrise
        const getNow = () => new Date('2025-12-21T12:00:00Z');
        const env = createWatchEnvironment(watch, 85.0, 21.0, getNow, 'Europe/Oslo');

        const sunsetAngle = (env.functions.get('wadokeiDNSunsetAngle') as () => number)();
        const sunriseAngle = (env.functions.get('wadokeiDNSunriseAngle') as () => number)();
        const numVis = (env.functions.get('wadokeiDNNumVisible') as (n: number) => number)(75);

        // Polar winter: night arc should span nearly the full circle
        let nightArc = sunriseAngle - sunsetAngle;
        if (nightArc < 0) nightArc += 2 * Math.PI;
        expect(nightArc).toBeGreaterThan(2 * Math.PI - 0.01);

        // All wedges should be visible
        expect(numVis).toBe(75);
    });

    test('Tromsø (69.6°N) June — polar summer, no sunset', () => {
        const watch = loadKyotoWatch();
        // June 15 at Tromsø — midnight sun
        const getNow = () => new Date('2025-06-15T12:00:00+02:00');
        const env = createWatchEnvironment(watch, 69.65, 18.96, getNow, 'Europe/Oslo');

        const numVis = (env.functions.get('wadokeiDNNumVisible') as (n: number) => number)(75);

        // No night at 69.6°N in mid-June
        expect(numVis).toBe(0);
    });

    test('Tromsø (69.6°N) December — polar winter, no sunrise', () => {
        const watch = loadKyotoWatch();
        // December 15 at Tromsø — polar night
        const getNow = () => new Date('2025-12-15T12:00:00+01:00');
        const env = createWatchEnvironment(watch, 69.65, 18.96, getNow, 'Europe/Oslo');

        const numVis = (env.functions.get('wadokeiDNNumVisible') as (n: number) => number)(75);

        // All night at 69.6°N in mid-December
        expect(numVis).toBe(75);
    });

    test('mode 1 (temporal dial) ignores polar conditions', () => {
        const watch = loadKyotoWatch();
        // Force kyMode=1 at polar latitude
        const getNow = () => new Date('2025-06-21T12:00:00Z');
        const env = createWatchEnvironment(watch, 85.0, 21.0, getNow, 'Europe/Oslo');
        env.variables.set('kyMode', 1);

        const sunsetAngle = (env.functions.get('wadokeiDNSunsetAngle') as () => number)();
        const sunriseAngle = (env.functions.get('wadokeiDNSunriseAngle') as () => number)();

        // Mode 1 always returns fixed temporal angles regardless of latitude
        expect(sunsetAngle).toBeCloseTo(3 * Math.PI / 2, 5);
        expect(sunriseAngle).toBeCloseTo(Math.PI / 2, 5);
    });
});

describe('Kyoto temporal hours at near-polar latitudes (Fairbanks)', () => {
    let perfNowSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        perfNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => 1000);
    });

    afterAll(() => {
        perfNowSpy.mockRestore();
    });

    test('Fairbanks May 30 noon — solarNoonAngle is valid', () => {
        const watch = loadKyotoWatch();
        // May 30, 2026 at Fairbanks (64.8°N, 147.7°W) — sunset occurs past midnight
        const getNow = () => new Date('2026-05-30T12:00:00-08:00');
        const env = createWatchEnvironment(watch, 64.84, -147.72, getNow, 'America/Anchorage');

        const solarNoonAngle = (env.functions.get('solarNoonAngle') as () => number)();

        // solarNoonAngle = angle24HourForDate(transit) + π
        // For Fairbanks: solar noon ~13:47 AKDT → h ≈ 13.78
        // angle24HourForDate = 13.78 * π/12 ≈ 3.61, + π ≈ 6.75, mod 2π ≈ 0.47
        // The key check: the angle should be reasonable and not NaN/Infinity
        expect(solarNoonAngle).not.toBeNaN();
        // And it should be consistent (the old buggy version would give 12:00 noon-based values
        // from the fallback, which would be wrong by ~2 hours)
    });

    test('Fairbanks May 30 — angleForJapanHour spans reasonable range', () => {
        const watch = loadKyotoWatch();
        const getNow = () => new Date('2026-05-30T12:00:00-08:00');
        const env = createWatchEnvironment(watch, 64.84, -147.72, getNow, 'America/Anchorage');

        const angleForJapanHour = env.functions.get('angleForJapanHour') as (n: number, anchor: number) => number;

        // Get angles for noon hour (0) and midnight hour (6) with topAnchorSolarNoon (2)
        const noonAngle = angleForJapanHour(0, 2);
        const midnightAngle = angleForJapanHour(6, 2);

        // On a wadokei with topAnchorSolarNoon, noon (hour 0) should be near 0 (top)
        const normalizedNoon = ((noonAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        // With topAnchorSolarNoon, noon hour 0 should be close to 0 or 2π
        expect(Math.min(normalizedNoon, 2 * Math.PI - normalizedNoon)).toBeLessThan(0.5);

        // The midnight hour (6) should be roughly opposite (~π away)
        const normalizedMidnight = ((midnightAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        expect(Math.abs(normalizedMidnight - Math.PI)).toBeLessThan(0.5);
    });

    test('Fairbanks May 30 — japanHourValueAngle during daytime is reasonable', () => {
        const watch = loadKyotoWatch();
        const getNow = () => new Date('2026-05-30T12:00:00-08:00');
        const env = createWatchEnvironment(watch, 64.84, -147.72, getNow, 'America/Anchorage');

        const japanHourValueAngle = (env.functions.get('japanHourValueAngle') as () => number)();

        // The angle should be a valid number (not NaN or Infinity)
        expect(japanHourValueAngle).not.toBeNaN();
        expect(Number.isFinite(japanHourValueAngle)).toBe(true);
    });

    test('Fairbanks equinox — day/night temporal hours reasonable', () => {
        const watch = loadKyotoWatch();
        // March equinox at Fairbanks — roughly 12h day
        const getNow = () => new Date('2026-03-20T12:00:00-08:00');
        const env = createWatchEnvironment(watch, 64.84, -147.72, getNow, 'America/Anchorage');

        const angleForJapanHour = env.functions.get('angleForJapanHour') as (n: number, anchor: number) => number;

        // Check that all 12 japan hours produce valid, non-NaN angles
        for (let h = 0; h < 12; h++) {
            const angle = angleForJapanHour(h, 2);
            expect(angle).not.toBeNaN();
            expect(Number.isFinite(angle)).toBe(true);
        }

        // Noon (0) and midnight (6) should be roughly π apart
        const noonAngle = angleForJapanHour(0, 2);
        const midnightAngle = angleForJapanHour(6, 2);
        const separation = Math.abs(midnightAngle - noonAngle);
        // Should be close to π (±0.5 for latitude effects)
        expect(separation).toBeGreaterThan(Math.PI - 0.5);
        expect(separation).toBeLessThan(Math.PI + 0.5);
    });
});
