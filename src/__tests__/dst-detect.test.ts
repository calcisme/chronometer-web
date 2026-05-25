/**
 * Tests for DST transition detection utilities.
 *
 * Exercises findNextDstTransition and getTimezoneOffsetMinutes against
 * a broad set of IANA timezones, including edge cases like Lord Howe
 * Island's 30-minute DST offset and timezones without DST.
 */

import { describe, test, expect } from 'vitest';
import { findNextDstTransition, findPrevDstTransition, getTimezoneOffsetMinutes } from '../shared/dst-detect.js';

// ============================================================================
// getTimezoneOffsetMinutes
// ============================================================================

describe('getTimezoneOffsetMinutes', () => {
    test('UTC returns 0', () => {
        expect(getTimezoneOffsetMinutes('Etc/UTC', new Date())).toBe(0);
        expect(getTimezoneOffsetMinutes('Etc/GMT', new Date())).toBe(0);
    });

    test('fixed-offset timezones', () => {
        const date = new Date('2024-06-15T12:00:00Z');
        expect(getTimezoneOffsetMinutes('Asia/Kolkata', date)).toBe(330);   // UTC+5:30
        expect(getTimezoneOffsetMinutes('Asia/Tokyo', date)).toBe(540);     // UTC+9
        expect(getTimezoneOffsetMinutes('Pacific/Honolulu', date)).toBe(-600); // UTC-10
    });

    test('DST-observing timezone in winter vs summer', () => {
        // America/New_York: EST = UTC-5, EDT = UTC-4
        const winter = new Date('2024-01-15T12:00:00Z');
        const summer = new Date('2024-07-15T12:00:00Z');
        expect(getTimezoneOffsetMinutes('America/New_York', winter)).toBe(-300); // EST
        expect(getTimezoneOffsetMinutes('America/New_York', summer)).toBe(-240); // EDT
    });

    test('Europe/London: GMT in winter, BST in summer', () => {
        const winter = new Date('2024-01-15T12:00:00Z');
        const summer = new Date('2024-07-15T12:00:00Z');
        expect(getTimezoneOffsetMinutes('Europe/London', winter)).toBe(0);   // GMT
        expect(getTimezoneOffsetMinutes('Europe/London', summer)).toBe(60);  // BST
    });

    test('Australia/Lord_Howe: 30-minute DST offset', () => {
        // Lord Howe Island: UTC+10:30 in winter, UTC+11:00 in summer (southern hemisphere)
        // Summer = Jan, Winter = Jul
        const summer = new Date('2024-01-15T12:00:00Z');
        const winter = new Date('2024-07-15T12:00:00Z');
        expect(getTimezoneOffsetMinutes('Australia/Lord_Howe', summer)).toBe(660);  // UTC+11:00 (DST)
        expect(getTimezoneOffsetMinutes('Australia/Lord_Howe', winter)).toBe(630);  // UTC+10:30 (standard)
    });
});

// ============================================================================
// findNextDstTransition — known timezone behavior
// ============================================================================

describe('findNextDstTransition', () => {
    test('no DST timezone returns null', () => {
        const now = new Date('2024-06-15T12:00:00Z');
        expect(findNextDstTransition('Asia/Tokyo', now)).toBeNull();
        expect(findNextDstTransition('Pacific/Honolulu', now)).toBeNull();
        expect(findNextDstTransition('America/Phoenix', now)).toBeNull();
        expect(findNextDstTransition('Asia/Kolkata', now)).toBeNull();
        expect(findNextDstTransition('Etc/UTC', now)).toBeNull();
    });

    test('America/New_York — finds spring forward', () => {
        // Start in January 2024 — next transition is March 10, 2024 at 2:00 AM EST (07:00 UTC)
        const from = new Date('2024-01-15T12:00:00Z');
        const result = findNextDstTransition('America/New_York', from);
        expect(result).not.toBeNull();

        // Should be March 10, 2024 at 07:00:00.000 UTC (2:00 AM EST)
        expect(result!.toISOString()).toBe('2024-03-10T07:00:00.000Z');

        // Verify offset changes at this boundary
        const before = new Date(result!.getTime() - 1);
        const after = result!;
        expect(getTimezoneOffsetMinutes('America/New_York', before)).toBe(-300); // EST
        expect(getTimezoneOffsetMinutes('America/New_York', after)).toBe(-240);  // EDT
    });

    test('America/New_York — finds fall back', () => {
        // Start in June 2024 — next transition is Nov 3, 2024 at 2:00 AM EDT (06:00 UTC)
        const from = new Date('2024-06-15T12:00:00Z');
        const result = findNextDstTransition('America/New_York', from);
        expect(result).not.toBeNull();

        // Should be November 3, 2024 at 06:00:00.000 UTC (2:00 AM EDT)
        expect(result!.toISOString()).toBe('2024-11-03T06:00:00.000Z');

        // Verify offset changes
        const before = new Date(result!.getTime() - 1);
        expect(getTimezoneOffsetMinutes('America/New_York', before)).toBe(-240); // EDT
        expect(getTimezoneOffsetMinutes('America/New_York', result!)).toBe(-300); // EST
    });

    test('Europe/London — spring forward (last Sunday of March)', () => {
        // Start in February 2024 — next transition is March 31, 2024 at 1:00 AM GMT (01:00 UTC)
        const from = new Date('2024-02-15T12:00:00Z');
        const result = findNextDstTransition('Europe/London', from);
        expect(result).not.toBeNull();

        expect(result!.toISOString()).toBe('2024-03-31T01:00:00.000Z');

        const before = new Date(result!.getTime() - 1);
        expect(getTimezoneOffsetMinutes('Europe/London', before)).toBe(0);   // GMT
        expect(getTimezoneOffsetMinutes('Europe/London', result!)).toBe(60); // BST
    });

    test('Australia/Lord_Howe — 30-minute DST offset transition', () => {
        // Lord Howe: DST ends first Sunday of April at 2:00 AM LHDT (UTC+11)
        // In 2024: April 7, 2024. 2:00 AM LHDT = 15:00 UTC April 6
        const from = new Date('2024-02-15T12:00:00Z');
        const result = findNextDstTransition('Australia/Lord_Howe', from);
        expect(result).not.toBeNull();

        // Verify offset changes by 30 minutes
        const before = new Date(result!.getTime() - 1);
        const afterOffset = getTimezoneOffsetMinutes('Australia/Lord_Howe', result!);
        const beforeOffset = getTimezoneOffsetMinutes('Australia/Lord_Howe', before);
        expect(Math.abs(afterOffset - beforeOffset)).toBe(30);
    });

    test('result is snapped to top of minute', () => {
        const from = new Date('2024-01-15T12:00:00Z');
        const result = findNextDstTransition('America/New_York', from);
        expect(result).not.toBeNull();

        // Should be exactly on a minute boundary (ms = 0, seconds = 0)
        expect(result!.getTime() % 60000).toBe(0);
        expect(result!.getUTCSeconds()).toBe(0);
        expect(result!.getUTCMilliseconds()).toBe(0);
    });

    test('round-trip: next transition after a transition is a different one', () => {
        const from = new Date('2024-01-15T12:00:00Z');
        const first = findNextDstTransition('America/New_York', from);
        expect(first).not.toBeNull();

        // Search again from 1 minute after the first transition
        const afterFirst = new Date(first!.getTime() + 60000);
        const second = findNextDstTransition('America/New_York', afterFirst);
        expect(second).not.toBeNull();

        // The two transitions should be different dates
        expect(second!.getTime()).toBeGreaterThan(first!.getTime());

        // And the offset at the second transition should differ from the offset just before
        const beforeSecond = new Date(second!.getTime() - 1);
        const offsetBefore = getTimezoneOffsetMinutes('America/New_York', beforeSecond);
        const offsetAfter = getTimezoneOffsetMinutes('America/New_York', second!);
        expect(offsetBefore).not.toBe(offsetAfter);
    });

    test('southern hemisphere: Australia/Sydney', () => {
        // Sydney: DST starts first Sunday of October, ends first Sunday of April
        // From June 2024 (winter), next transition is Oct 6, 2024
        const from = new Date('2024-06-15T12:00:00Z');
        const result = findNextDstTransition('Australia/Sydney', from);
        expect(result).not.toBeNull();

        // Should be in October 2024
        expect(result!.getUTCMonth()).toBe(9); // October = month 9 (0-indexed)
        expect(result!.getUTCFullYear()).toBe(2024);

        // Verify offset changes
        const before = new Date(result!.getTime() - 1);
        const offsetBefore = getTimezoneOffsetMinutes('Australia/Sydney', before);
        const offsetAfter = getTimezoneOffsetMinutes('Australia/Sydney', result!);
        expect(offsetAfter - offsetBefore).toBe(60); // spring forward: +10 → +11
    });
});

// ============================================================================
// Comprehensive test: all timezones from a representative set
// ============================================================================

describe('findNextDstTransition — comprehensive timezone coverage', () => {
    // Representative set covering all major DST behaviors worldwide.
    // A full test against every timezone in the city DB would be run separately.
    const timezones = [
        // North America
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Anchorage', 'America/Phoenix', // no DST
        'America/Halifax', 'America/St_Johns', // Newfoundland: ±30 min DST
        'America/Sao_Paulo', 'America/Santiago',
        // Europe
        'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow', // no DST
        'Europe/Istanbul', // no DST (since 2016)
        // Asia
        'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Dubai', // no DST
        'Asia/Tehran', // Iran: +3:30 / +4:30
        // Oceania
        'Australia/Sydney', 'Australia/Lord_Howe', // 30-min DST
        'Pacific/Auckland', 'Pacific/Chatham', // ±45 min offset
        'Pacific/Honolulu', // no DST
        // Africa
        'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Casablanca',
        // Fixed offset
        'Etc/UTC', 'Etc/GMT+5',
    ];

    for (const tz of timezones) {
        test(`${tz}: transition is valid or null`, () => {
            const from = new Date('2024-06-15T12:00:00Z');
            const result = findNextDstTransition(tz, from);

            if (result === null) {
                // No DST — verify offset is constant across the year
                const jan = getTimezoneOffsetMinutes(tz, new Date('2024-01-15T12:00:00Z'));
                const jul = getTimezoneOffsetMinutes(tz, new Date('2024-07-15T12:00:00Z'));
                expect(jan).toBe(jul);
                return;
            }

            // Has DST — verify the transition is valid:
            // 1. Result is on a minute boundary
            expect(result.getTime() % 60000).toBe(0);

            // 2. Offset changes at this exact point
            const before = new Date(result.getTime() - 1);
            const offsetBefore = getTimezoneOffsetMinutes(tz, before);
            const offsetAfter = getTimezoneOffsetMinutes(tz, result);
            expect(offsetBefore).not.toBe(offsetAfter);

            // 3. Transition is in the future relative to 'from'
            expect(result.getTime()).toBeGreaterThan(from.getTime());
        });
    }
});

// ============================================================================
// findPrevDstTransition — backward search
// ============================================================================

describe('findPrevDstTransition', () => {
    test('no DST timezone returns null', () => {
        const now = new Date('2024-06-15T12:00:00Z');
        expect(findPrevDstTransition('Asia/Tokyo', now)).toBeNull();
        expect(findPrevDstTransition('Pacific/Honolulu', now)).toBeNull();
        expect(findPrevDstTransition('America/Phoenix', now)).toBeNull();
        expect(findPrevDstTransition('Etc/UTC', now)).toBeNull();
    });

    test('America/New_York — finds most recent past transition (spring forward)', () => {
        // Start in June 2024 — most recent past transition was March 10, 2024 (spring forward)
        const from = new Date('2024-06-15T12:00:00Z');
        const result = findPrevDstTransition('America/New_York', from);
        expect(result).not.toBeNull();

        // Should be March 10, 2024 at 07:00:00.000 UTC (2:00 AM EST)
        expect(result!.toISOString()).toBe('2024-03-10T07:00:00.000Z');

        // Verify offset changes at this boundary
        const before = new Date(result!.getTime() - 1);
        expect(getTimezoneOffsetMinutes('America/New_York', before)).toBe(-300); // EST
        expect(getTimezoneOffsetMinutes('America/New_York', result!)).toBe(-240); // EDT
    });

    test('America/New_York — finds most recent past transition (fall back)', () => {
        // Start in January 2024 — most recent past transition was Nov 5, 2023 (fall back)
        const from = new Date('2024-01-15T12:00:00Z');
        const result = findPrevDstTransition('America/New_York', from);
        expect(result).not.toBeNull();

        // Should be November 5, 2023 at 06:00:00.000 UTC (2:00 AM EDT)
        expect(result!.toISOString()).toBe('2023-11-05T06:00:00.000Z');

        // Verify offset changes
        const before = new Date(result!.getTime() - 1);
        expect(getTimezoneOffsetMinutes('America/New_York', before)).toBe(-240); // EDT
        expect(getTimezoneOffsetMinutes('America/New_York', result!)).toBe(-300); // EST
    });

    test('symmetry: findPrev from after a transition finds the same boundary as findNext from before', () => {
        // findNext from Jan 2024 should find March 10 spring-forward
        const nextResult = findNextDstTransition('America/New_York', new Date('2024-01-15T12:00:00Z'));
        expect(nextResult).not.toBeNull();

        // findPrev from April 2024 should find the same March 10 boundary
        const prevResult = findPrevDstTransition('America/New_York', new Date('2024-04-15T12:00:00Z'));
        expect(prevResult).not.toBeNull();

        expect(prevResult!.toISOString()).toBe(nextResult!.toISOString());
    });

    test('result is snapped to top of minute', () => {
        const from = new Date('2024-06-15T12:00:00Z');
        const result = findPrevDstTransition('America/New_York', from);
        expect(result).not.toBeNull();

        expect(result!.getTime() % 60000).toBe(0);
        expect(result!.getUTCSeconds()).toBe(0);
        expect(result!.getUTCMilliseconds()).toBe(0);
    });

    test('result is in the past relative to from', () => {
        const from = new Date('2024-06-15T12:00:00Z');
        const result = findPrevDstTransition('America/New_York', from);
        expect(result).not.toBeNull();
        expect(result!.getTime()).toBeLessThan(from.getTime());
    });

    test('Australia/Lord_Howe — 30-minute DST backward', () => {
        // From July 2024 (winter), the most recent past transition is April 2024 (DST ended)
        const from = new Date('2024-07-15T12:00:00Z');
        const result = findPrevDstTransition('Australia/Lord_Howe', from);
        expect(result).not.toBeNull();

        const before = new Date(result!.getTime() - 1);
        const offsetBefore = getTimezoneOffsetMinutes('Australia/Lord_Howe', before);
        const offsetAfter = getTimezoneOffsetMinutes('Australia/Lord_Howe', result!);
        expect(Math.abs(offsetAfter - offsetBefore)).toBe(30);
    });
});

// ============================================================================
// findPrevDstTransition — comprehensive timezone coverage
// ============================================================================

describe('findPrevDstTransition — comprehensive timezone coverage', () => {
    const timezones = [
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Anchorage', 'America/Phoenix',
        'America/Halifax', 'America/St_Johns',
        'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
        'Asia/Tokyo', 'Asia/Kolkata', 'Asia/Dubai',
        'Australia/Sydney', 'Australia/Lord_Howe',
        'Pacific/Auckland', 'Pacific/Honolulu',
        'Etc/UTC',
    ];

    for (const tz of timezones) {
        test(`${tz}: prev transition is valid or null`, () => {
            const from = new Date('2024-06-15T12:00:00Z');
            const result = findPrevDstTransition(tz, from);

            if (result === null) {
                // No DST — verify offset is constant across the year
                const jan = getTimezoneOffsetMinutes(tz, new Date('2024-01-15T12:00:00Z'));
                const jul = getTimezoneOffsetMinutes(tz, new Date('2024-07-15T12:00:00Z'));
                expect(jan).toBe(jul);
                return;
            }

            // Has DST — verify the transition is valid:
            // 1. Result is on a minute boundary
            expect(result.getTime() % 60000).toBe(0);

            // 2. Offset changes at this exact point
            const before = new Date(result.getTime() - 1);
            const offsetBefore = getTimezoneOffsetMinutes(tz, before);
            const offsetAfter = getTimezoneOffsetMinutes(tz, result);
            expect(offsetBefore).not.toBe(offsetAfter);

            // 3. Transition is in the past relative to 'from'
            expect(result.getTime()).toBeLessThan(from.getTime());
        });
    }
});
