/**
 * Observatory peripheral dial backgrounds — static layer.
 *
 * Renders the Altitude, Azimuth and Equation-of-Time dial backgrounds into a
 * full-viewport OffscreenCanvas cache (redrawn only on resize), mirroring
 * `main-dial.ts`. The hands and planet labels are drawn dynamically each frame
 * by `peripheral-hands.ts`.
 *
 * Ports:
 *   - Altitude  : EOAltitudeDialShuffleView  (EOShuffleView.mm L295-316)
 *   - Azimuth   : EOAzimuthDialShuffleView   (EOShuffleView.mm L333-358)
 *   - EOT       : EOEOTDialShuffleView        (EOShuffleView.mm L416-446),
 *                 reworked into the asymmetric real-range design used by the
 *                 Mauna Kea / Vienna faces (renderer.ts drawEotDial).
 *
 * The eclipse simulator (slot eclipseCX/CY/R1/R2) is intentionally left empty —
 * it is deferred to its own future plan.
 */

import type { LayoutParams } from './layout.js';
import { drawArc, drawTicks, drawDialNumbersDemiRadial, drawDialNumbersUpright, drawText } from './draw-utils.js';

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ── Colors (iOS) ──────────────────────────────────────────────────────────
const WHITE = 'rgba(255,255,255,1)';
const FILL_15 = 'rgba(255,255,255,0.15)';
const FILL_10 = 'rgba(255,255,255,0.10)';
const LIGHT_GRAY = 'rgba(170,170,170,1)';        // UIColor lightGrayColor
const AZ_SALMON = 'rgba(230,128,128,0.30)';      // (.9,.5,.5,.3)
const AZ_BLUE_A = 'rgba(77,77,230,0.35)';        // (.3,.3,.9,.35)
const AZ_BLUE_B = 'rgba(77,77,255,0.45)';        // (.3,.3,1,.45)

// ── EOT real-world extremes (minutes), from renderer.ts:3826-3827 ──────────
const EOT_MAX_MIN = 16.5;
const EOT_MIN_MIN = -14.2;
const EOT_RAD_PER_MIN = Math.PI / 30;            // 15 min = 90°

// ---------------------------------------------------------------------------
// Small drawing helpers (canvas-angle, 0 = 3 o'clock, CW positive)
// ---------------------------------------------------------------------------

/** Stroke a circular arc using canvas angles. */
function strokeArc(ctx: Ctx2D, cx: number, cy: number, r: number, a0: number, a1: number, color: string, lw: number, alpha = 1): void {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    ctx.restore();
}

/** Stroke + fill the small center hub circle. */
function drawHub(ctx: Ctx2D, cx: number, cy: number, r: number, lw: number): void {
    ctx.save();
    ctx.fillStyle = FILL_15;
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TWO_PI);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
}

/** Convert EOT minutes → clock angle (0 = top, CW positive). */
function eotMinToClock(min: number): number {
    return min * EOT_RAD_PER_MIN;
}

// ---------------------------------------------------------------------------
// Altitude dial — left half-gauge, −90…+90
// ---------------------------------------------------------------------------

function drawAltitudeDial(ctx: Ctx2D, L: LayoutParams): void {
    const cx = L.altCX, cy = L.altCY, R = L.altR;
    const f = L.extFontSize;
    const s = R / 60;
    const lw = 0.5 * s;
    const innerR = R - f - 1;

    // Half-annulus band fill (left half: clock π → 2π).
    drawArc(ctx, cx, cy, R, innerR, Math.PI, TWO_PI, FILL_15);

    // Outline: outer + inner left half arcs, the horizontal baseline, and hub.
    // Left half in canvas coords: from π/2 (bottom) CW through π (left) to 3π/2 (top).
    strokeArc(ctx, cx, cy, R, HALF_PI, 3 * HALF_PI, WHITE, lw);
    strokeArc(ctx, cx, cy, innerR, HALF_PI, 3 * HALF_PI, WHITE, lw);
    ctx.save();
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx - R, cy);       // horizontal radius to the left (0° altitude)
    ctx.stroke();
    ctx.restore();
    drawHub(ctx, cx, cy, f - 1, lw);

    // Tick tiers (left half only: iOS angle1=π angle2=2π).
    drawTicks(ctx, cx, cy, 12, innerR, R, 1 * s, LIGHT_GRAY, Math.PI, TWO_PI);
    drawTicks(ctx, cx, cy, 36, R - f / 2 - 1, R, 1 * s, LIGHT_GRAY, Math.PI, TWO_PI);
    drawTicks(ctx, cx, cy, 72, R - f / 4 - 1, R, 1 * s, LIGHT_GRAY, Math.PI, TWO_PI);

    // Demi-radial numbers: 90 (top) … −90 (bottom) … up the left side.
    const labels = '90,,,,,,-90,-60,-30,-,30,60'.split(',');
    drawDialNumbersDemiRadial(ctx, cx, cy, labels, `${f}px Arial, sans-serif`, WHITE, R - f, R - f + 1);

    // "Altitude" title, centered in the upper area.
    drawText(ctx, 'Altitude', cx, cy - R / 2, `${f}px Arial, sans-serif`, WHITE);
}

// ---------------------------------------------------------------------------
// Azimuth dial — full compass, N/E/S/W
// ---------------------------------------------------------------------------

function drawAzimuthDial(ctx: Ctx2D, L: LayoutParams): void {
    const cx = L.azCX, cy = L.azCY, R = L.azR;
    const f = L.extFontSize;
    const s = R / 60;
    const lw = 0.5 * s;
    const innerR = R - f - 1;

    // Full annulus band fill.
    drawArc(ctx, cx, cy, R, innerR, 0, TWO_PI, FILL_15);
    strokeArc(ctx, cx, cy, R, 0, TWO_PI, WHITE, lw);
    strokeArc(ctx, cx, cy, innerR, 0, TWO_PI, WHITE, lw);
    drawHub(ctx, cx, cy, f - 1, lw);

    // Colored crosshair ticks (cardinal/intercardinal accents).
    drawTicks(ctx, cx, cy, 16, f - 1, (R - f) * 0.55, 1 * s, AZ_SALMON);
    drawTicks(ctx, cx, cy, 8, f - 1, (R - f) * 0.75, 1 * s, AZ_BLUE_A);
    drawTicks(ctx, cx, cy, 4, f - 1, (R - f) * 0.75, 1 * s, AZ_BLUE_B);

    // N/E/S/W upright.
    drawDialNumbersUpright(ctx, cx, cy, ['N', 'E', 'S', 'W'], `${f}px Arial, sans-serif`, WHITE, R - f);

    // Grey tick tiers around the rim.
    drawTicks(ctx, cx, cy, 4, R - f, R, 1 * s, LIGHT_GRAY);
    drawTicks(ctx, cx, cy, 12, R - f + 2, R, 1 * s, LIGHT_GRAY);
    drawTicks(ctx, cx, cy, 36, R - f + 4, R, 1 * s, LIGHT_GRAY);
    drawTicks(ctx, cx, cy, 72, R - f + 7, R, 1 * s, LIGHT_GRAY);

    drawText(ctx, 'Azimuth', cx, cy - R / 2, `${f}px Arial, sans-serif`, WHITE);
}

// ---------------------------------------------------------------------------
// Equation-of-Time dial — asymmetric real-range design
// ---------------------------------------------------------------------------

function drawEOTDial(ctx: Ctx2D, L: LayoutParams): void {
    const cx = L.eotCX, cy = L.eotCY, R = L.eotR;
    const f = L.eotFontSize;
    const s = R / 60;
    const lw = 0.5 * s;
    const bandWidth = f + 5 * s;
    const innerR = R - bandWidth;

    // Faded alpha for the unused negative sliver (−14.2 … −15). White strokes →
    // use the light-stroke alpha (cf. renderer.ts:3844).
    const FADED = 0.35;

    // ── Band fill ──
    // Solid span: true range −14.2 … +16.5.
    drawArc(ctx, cx, cy, R, innerR, eotMinToClock(EOT_MIN_MIN), eotMinToClock(EOT_MAX_MIN), FILL_10);
    // Faded sliver: −15 … −14.2 (range we never reach), so the left edge still
    // reaches the 9 o'clock (−15) position.
    ctx.save();
    ctx.globalAlpha = FADED;
    drawArc(ctx, cx, cy, R, innerR, eotMinToClock(-15), eotMinToClock(EOT_MIN_MIN), FILL_10);
    ctx.restore();

    // ── Outline arcs (canvas angles = clock − π/2) ──
    const cSolidStart = eotMinToClock(EOT_MIN_MIN) - HALF_PI;
    const cSolidEnd = eotMinToClock(EOT_MAX_MIN) - HALF_PI;
    const cFadedStart = eotMinToClock(-15) - HALF_PI;
    strokeArc(ctx, cx, cy, R, cSolidStart, cSolidEnd, WHITE, lw);
    strokeArc(ctx, cx, cy, innerR, cSolidStart, cSolidEnd, WHITE, lw);
    strokeArc(ctx, cx, cy, R, cFadedStart, cSolidStart, WHITE, lw, FADED);
    strokeArc(ctx, cx, cy, innerR, cFadedStart, cSolidStart, WHITE, lw, FADED);

    drawHub(ctx, cx, cy, f + 1, lw);

    // Vertical baseline (0-minute radial, straight up).
    ctx.save();
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx, cy - R);
    ctx.stroke();
    ctx.restore();

    // ── Ticks: minor every minute, major at 0, ±5, ±10, ±15. ──
    // Negative side stops at −15 (faded); positive extends to +16.
    const majorLen = R * 0.15;
    const minorLen = R * 0.07;
    for (let min = -15; min <= 16; min++) {
        const clock = eotMinToClock(min);
        const ca = clock - HALF_PI;
        const isMajor = (min % 5 === 0) && Math.abs(min) <= 15;
        const inner = R - (isMajor ? majorLen : minorLen);
        const cosA = Math.cos(ca), sinA = Math.sin(ca);
        const alpha = (min === -15) ? FADED : 1;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = LIGHT_GRAY;
        ctx.lineWidth = (isMajor ? 0.6 : 0.3) * 2 * s;
        ctx.beginPath();
        ctx.moveTo(cx + cosA * inner, cy + sinA * inner);
        ctx.lineTo(cx + cosA * R, cy + sinA * R);
        ctx.stroke();
        ctx.restore();
    }

    // ── Numeric labels (0 at top; 5/10/15 each side) ──
    const numR = R - majorLen - f * 0.55 - 1;
    const numFont = `${f * 1.6}px Arial, sans-serif`;
    const labelAt = (clock: number, text: string, alpha = 1) => {
        const ca = clock - HALF_PI;
        ctx.save();
        ctx.globalAlpha = alpha;
        drawText(ctx, text, cx + Math.cos(ca) * numR, cy + Math.sin(ca) * numR, numFont, WHITE);
        ctx.restore();
    };
    labelAt(eotMinToClock(0), '0');
    for (const min of [5, 10, 15]) {
        labelAt(eotMinToClock(min), String(min));
        labelAt(eotMinToClock(-min), String(min), min === 15 ? FADED : 1);
    }

    // ── "+" / "−" symbols inward at the ±15 positions ──
    const symR = numR - f * 1.0 - 2;
    const symFont = `bold ${f * 1.7}px Arial, sans-serif`;
    const symAt = (clock: number, text: string, alpha = 1) => {
        const ca = clock - HALF_PI;
        ctx.save();
        ctx.globalAlpha = alpha;
        drawText(ctx, text, cx + Math.cos(ca) * symR, cy + Math.sin(ca) * symR, symFont, WHITE);
        ctx.restore();
    };
    symAt(eotMinToClock(15), '+');
    symAt(eotMinToClock(-15), '−', FADED);

    // ── Title ──
    drawText(ctx, 'Equation of Time', cx, cy - R / 2.5, `${f}px Arial, sans-serif`, WHITE);
}

// ---------------------------------------------------------------------------
// Static cache (full-viewport OffscreenCanvas at DPR), mirroring main-dial.ts
// ---------------------------------------------------------------------------

let staticCache: OffscreenCanvas | null = null;
let cacheKey = '';

function layoutKey(L: LayoutParams): string {
    return `${L.viewW}x${L.viewH}:${L.altR.toFixed(1)}:${L.eotR.toFixed(1)}`;
}

/** Build/return the cached peripheral-dial background canvas. */
export function getPeripheralDialsCache(L: LayoutParams): OffscreenCanvas {
    const key = layoutKey(L);
    if (staticCache && key === cacheKey) return staticCache;

    const dpr = L.dpr;
    staticCache = new OffscreenCanvas(L.viewW * dpr, L.viewH * dpr);
    cacheKey = key;

    const ctx = staticCache.getContext('2d')!;
    ctx.scale(dpr, dpr);

    drawAltitudeDial(ctx, L);
    drawAzimuthDial(ctx, L);
    drawEOTDial(ctx, L);

    return staticCache;
}

/** Invalidate the cache (call on resize). */
export function invalidatePeripheralDialsCache(): void {
    staticCache = null;
    cacheKey = '';
}
