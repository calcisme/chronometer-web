/**
 * Observatory header date display.
 *
 * Port of the EOClock date labels (EOClock.mm:525-570): weekday, big date
 * (month + day), year, leap-year indicator, and the timezone abbreviation.
 * Rendered as a centered text stack near the layout's date anchor.
 *
 * All fields use Intl.DateTimeFormat in the location's timezone so the display
 * follows the selected location and scrubbed time, not the browser's locale tz.
 *
 * Exact positions are intentionally rough here — Phase 8 ("Tune the layout")
 * refines placement once every element is on screen.
 */

import type { LayoutParams } from './layout.js';
import { drawText } from './draw-utils.js';

const COLOR = 'rgba(255,255,255,0.9)';
const COLOR_DIM = 'rgba(255,255,255,0.6)';

/** Gregorian leap-year test (port of EOClock.mm:541-547). */
function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

interface DateFields {
    weekday: string;
    monthDay: string;
    year: string;
    yearNum: number;
    tzAbbrev: string;
}

function extractFields(date: Date, timezone: string | undefined): DateFields {
    const tz = timezone || undefined;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    }).formatToParts(date);

    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const weekday = get('weekday');
    const month = get('month');
    const day = get('day');
    const year = get('year');

    let tzAbbrev = '';
    try {
        const tzParts = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            timeZoneName: 'short',
        }).formatToParts(date);
        tzAbbrev = tzParts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
        tzAbbrev = '';
    }

    return {
        weekday,
        monthDay: `${month} ${day}`,
        year,
        yearNum: parseInt(year, 10),
        tzAbbrev,
    };
}

/**
 * Draw the date stack centered at (L.dateCX, L.dateCY).
 *
 * @param date      The display-time Date (already the scrubbed/current instant).
 * @param timezone  IANA timezone for the location (undefined → browser local).
 */
export function drawDateView(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    date: Date,
    timezone: string | undefined,
): void {
    const f = extractFields(date, timezone);
    const s = L.mainR / 365;

    const fWeekday = `${11 * s}px Arial, sans-serif`;
    const fBig = `bold ${16 * s}px Arial, sans-serif`;
    const fYear = `${12 * s}px Arial, sans-serif`;
    const fSmall = `${9 * s}px Arial, sans-serif`;

    const cx = L.dateCX;
    let y = L.dateCY;
    const line = (h: number) => { y += h; return y; };

    // Stack downward from the anchor.
    drawText(ctx, f.weekday, cx, line(0), fWeekday, COLOR_DIM);
    drawText(ctx, f.monthDay, cx, line(18 * s), fBig, COLOR);
    drawText(ctx, f.year, cx, line(16 * s), fYear, COLOR);
    drawText(ctx, isLeapYear(f.yearNum) ? 'leap' : 'not leap', cx, line(12 * s), fSmall, COLOR_DIM);
    if (f.tzAbbrev) {
        drawText(ctx, f.tzAbbrev, cx, line(13 * s), fSmall, COLOR_DIM);
    }
}
