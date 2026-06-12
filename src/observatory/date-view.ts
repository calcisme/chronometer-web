/**
 * Observatory date display.
 *
 * Port of the EOClock date labels (EOClock.mm:525-570, L1941-1947) with the
 * iOS font hierarchy: the full weekday name and the month/day are the big
 * elements (iOS 48 pt), the year is 0.42× (20 pt), and the leap indicator /
 * timezone abbreviation are 0.21× (10 pt). The weekday is prominent by design:
 * a stated UX goal is knowing the weekday at a glance.
 *
 * The layout hands us a target box (dateCX/CY/W/H, mode) and we scale the text
 * block uniformly to fill it. Three modes (plan §5.5):
 *   - 'stack' — weekday / month-day / year(+leap) / tz, one centered column
 *   - 'row'   — weekday over a single condensed info line (phone portrait)
 *   - 'split' — weekday alone in box 1, month-day + year(+leap+tz) in box 2
 *                (iOS landscape precedent: weekday bottom-left, date bottom-right)
 *
 * "leap" is shown only in leap years; non-leap years show nothing (per review,
 * "not leap" is dropped).
 *
 * All fields use Intl.DateTimeFormat in the location's timezone so the display
 * follows the selected location and scrubbed time, not the browser's locale tz.
 */

import type { LayoutParams } from './layout.js';

const COLOR = 'rgba(255,255,255,0.9)';
const COLOR_DIM = 'rgba(255,255,255,0.55)';

// Relative sizes from iOS (48 / 48 / 20 / 10).
const REL_BIG = 1.0;
const REL_YEAR = 0.42;
const REL_SMALL = 0.21;

/** Absolute cap on the unit size so huge windows don't produce absurd text. */
const UNIT_MAX = 72;

/** Gregorian leap-year test (port of EOClock.mm:541-547). */
function isLeapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

interface DateFields {
    weekday: string;
    monthDay: string;
    year: string;
    leap: boolean;
    tzAbbrev: string;
}

function extractFields(date: Date, timezone: string | undefined): DateFields {
    const tz = timezone || undefined;
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'long',
        month: 'short',          // iOS bigDate uses "MMM dd"
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
        leap: isLeapYear(parseInt(year, 10)),
        tzAbbrev,
    };
}

// ---------------------------------------------------------------------------
// Text-block engine: lines of mixed-size segments, scaled to fit a box.
// ---------------------------------------------------------------------------

interface Segment {
    text: string;
    rel: number;
    color: string;
}
type Line = Segment[];

// Gap between segments, in units of the LARGER neighbor's size — small
// segments (tz/leap) beside big ones (year) need real air, not 0.25 of their
// own tiny em.
const SEG_GAP_EM = 0.35;
const LINE_SPACING = 1.18;   // line height in units of the line's tallest rel
const LINE_PAD = 0.10;       // extra padding between lines, in block units

function fontFor(px: number): string {
    return `${px}px Arial, sans-serif`;
}

/** Gap before segment i (relative to the larger neighbor's size). */
function segGap(line: Line, i: number, u: number): number {
    if (i === 0) return 0;
    return SEG_GAP_EM * Math.max(line[i - 1].rel, line[i].rel) * u;
}

/** Measure a line's width and height at unit size u. */
function measureLine(ctx: CanvasRenderingContext2D, line: Line, u: number): { w: number; h: number } {
    let w = 0;
    let maxRel = 0;
    let drawn = 0;
    for (let i = 0; i < line.length; i++) {
        const seg = line[i];
        if (!seg.text) continue;
        ctx.font = fontFor(seg.rel * u);
        w += ctx.measureText(seg.text).width;
        if (drawn > 0) w += segGap(line, i, u);
        drawn++;
        if (seg.rel > maxRel) maxRel = seg.rel;
    }
    return { w, h: maxRel * u };
}

/**
 * Draw a block of lines centered in the box, choosing the largest unit size
 * that fits (≤ UNIT_MAX). Segments within a line share a baseline.
 */
function drawBlock(
    ctx: CanvasRenderingContext2D,
    lines: Line[],
    cx: number, cy: number, boxW: number, boxH: number,
): void {
    const live = lines.filter((l) => l.some((s) => s.text));
    if (live.length === 0 || boxW <= 0 || boxH <= 0) return;

    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // Fit: measure at a reference unit, scale.
    const REF = 100;
    let maxW = 0;
    let totH = (live.length - 1) * LINE_PAD * REF;
    const refDims = live.map((l) => {
        const d = measureLine(ctx, l, REF);
        if (d.w > maxW) maxW = d.w;
        totH += d.h * LINE_SPACING;
        return d;
    });
    const u = Math.min(UNIT_MAX, REF * Math.min(boxW / maxW, boxH / totH));

    // Lay the lines out, vertically centered.
    const blockH = (totH / REF) * u;
    let y = cy - blockH / 2;
    for (let li = 0; li < live.length; li++) {
        const line = live[li];
        const lineH = (refDims[li].h / REF) * u;
        const lineW = (refDims[li].w / REF) * u;
        y += lineH * (LINE_SPACING + 1) / 2;   // advance to this line's baseline
        let x = cx - lineW / 2;
        let drawn = 0;
        for (let si = 0; si < line.length; si++) {
            const seg = line[si];
            if (!seg.text) continue;
            const px = seg.rel * u;
            ctx.font = fontFor(px);
            ctx.fillStyle = seg.color;
            if (drawn > 0) x += segGap(line, si, u);
            drawn++;
            ctx.fillText(seg.text, x, y);
            x += ctx.measureText(seg.text).width;
        }
        y += lineH * (LINE_SPACING - 1) / 2 + LINE_PAD * u;
    }

    ctx.restore();
}

// ---------------------------------------------------------------------------
// Public draw
// ---------------------------------------------------------------------------

/**
 * Draw the date display into the layout's date box(es).
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
    const wk: Segment = { text: f.weekday, rel: REL_BIG, color: COLOR };
    const md: Segment = { text: f.monthDay, rel: REL_BIG, color: COLOR };
    const yr: Segment = { text: f.year, rel: REL_YEAR, color: COLOR };
    const leap: Segment = { text: f.leap ? 'leap' : '', rel: REL_SMALL, color: COLOR_DIM };
    const tz: Segment = { text: f.tzAbbrev, rel: REL_SMALL, color: COLOR_DIM };

    switch (L.dateMode) {
        case 'stack':
            drawBlock(ctx, [[wk], [md], [yr, leap], [tz]],
                L.dateCX, L.dateCY, L.dateW, L.dateH);
            break;
        case 'row': {
            // Condensed info line under the weekday (phone portrait band).
            const small = (text: string): Segment => ({ text, rel: 0.45, color: COLOR });
            const info: Line = [small(f.monthDay), small('·'), small(f.year)];
            if (f.tzAbbrev) info.push(small('·'), { text: f.tzAbbrev, rel: 0.45, color: COLOR_DIM });
            if (f.leap) info.push(small('·'), { text: 'leap', rel: 0.45, color: COLOR_DIM });
            drawBlock(ctx, [[wk], info], L.dateCX, L.dateCY, L.dateW, L.dateH);
            break;
        }
        case 'split':
            drawBlock(ctx, [[wk]], L.dateCX, L.dateCY, L.dateW, L.dateH);
            drawBlock(ctx, [[md], [yr, tz, leap]],
                L.date2CX, L.date2CY, L.date2W, L.date2H);
            break;
    }
}
