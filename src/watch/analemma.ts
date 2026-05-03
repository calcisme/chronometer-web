/**
 * Analemma part — Sun analemma figure-eight display.
 *
 * Displays the Sun's analemma path (the figure-eight traced by the Sun's
 * position over a year at a fixed time/location) on a circular disc,
 * rotated to match the observer's current sky orientation.
 *
 * Architecture follows the terminator pattern: a single <analemma> XML
 * element is parsed into an AnalemmaState at init time, with dedicated
 * tick/draw functions called from the animation and render loops.
 *
 * Path coordinates: altitude/azimuth deltas from a reference configuration
 * (lon=0°, lat=45°N, 12:00 UT civil time, vernal equinox).
 *
 * Rotation: uses northAngleForObject(sunAlt, sunAz, observerLat) to orient
 * the analemma correctly in the observer's sky.
 */

import type { AnalemmaPart } from './types.js';
import type { Environment } from '../expr/evaluator.js';
import { evalAttr, evalColor } from './watch-env.js';
import type { LoadedImage } from './image-loader.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { sunAltitude, sunAzimuth, sunSkyOrientationAngle } from '../astronomy/es-astro.js';

// ============================================================================
// Constants
// ============================================================================

/** Reference latitude for path generation: 45°N */
const REF_LAT_RAD = 45 * Math.PI / 180;

/** Reference longitude: 0° (Greenwich) */
const REF_LON_RAD = 0;

/**
 * Reference date: vernal equinox 2024 (March 20, 2024 at 12:00 UT).
 * In Apple epoch seconds (seconds since 2001-01-01 00:00:00 UTC).
 * 2024-03-20 12:00 UT = 2024-03-20T12:00:00Z
 */
const REF_EPOCH_SECONDS = (() => {
    const d = new Date(Date.UTC(2024, 2, 20, 12, 0, 0));  // March 20, 2024 12:00 UT
    return (d.getTime() / 1000) - 978307200;  // Convert to Apple epoch
})();

/** Number of days in the analemma path. */
const PATH_DAYS = 365;

/** Default update interval in seconds (5 minutes). */
const DEFAULT_UPDATE_SEC = 300;

/** Padding factor: fraction of disc radius reserved as margin around the path. */
const PATH_MARGIN_FRACTION = 0.15;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize an angle difference to [-π, π].
 * Critical for azimuth deltas near due south (π / -π boundary).
 */
function normalizeAngleDelta(delta: number): number {
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return delta;
}

// ============================================================================
// Path generation
// ============================================================================

interface AnalemmaPathPoint {
    dayOfYear: number;
    deltaAz: number;   // radians, normalized to [-π, π]
    deltaAlt: number;   // radians
}

/**
 * Pre-compute the 365-point analemma path using alt/az deltas.
 *
 * For each day 0–364, computes Sun altitude/azimuth at the same civil
 * time (12:00 UT) at the reference location, and stores the delta from
 * the reference day (vernal equinox) values.
 *
 * The equation of time causes the Sun to be east or west of due south
 * at the same civil time each day — this is what creates the figure-eight's
 * horizontal extent. The changing declination creates the vertical extent.
 */
function computeAnalemmaPath(): {
    path: AnalemmaPathPoint[];
    refAlt: number;
    refAz: number;
} {
    const refAlt = sunAltitude(REF_EPOCH_SECONDS, REF_LAT_RAD, REF_LON_RAD, null);
    const refAz = sunAzimuth(REF_EPOCH_SECONDS, REF_LAT_RAD, REF_LON_RAD, null);

    const path: AnalemmaPathPoint[] = [];
    for (let d = 0; d < PATH_DAYS; d++) {
        const di = REF_EPOCH_SECONDS + d * 86400;
        const alt = sunAltitude(di, REF_LAT_RAD, REF_LON_RAD, null);
        const az = sunAzimuth(di, REF_LAT_RAD, REF_LON_RAD, null);
        path.push({
            dayOfYear: d,
            deltaAz: normalizeAngleDelta(az - refAz),
            deltaAlt: alt - refAlt,
        });
    }

    return { path, refAlt, refAz };
}

// ============================================================================
// Runtime state
// ============================================================================

export interface AnalemmaState {
    // Geometry (computed once at init)
    path: AnalemmaPathPoint[];
    pathScaled: [number, number][];  // path in XML coords (x, y)
    scaleFactor: number;              // radians → XML coord scaling
    pathOffsetX: number;              // bounding box centering offset (XML coords)
    pathOffsetY: number;
    refAlt: number;
    refAz: number;
    centerX: number;
    centerY: number;
    radius: number;

    // Appearance
    sunRadius: number;
    sunFillColor: string;
    sunStrokeColor: string;
    channelColor: string;
    channelWidth: number;
    bgRotates: boolean;

    // Current state (updated at each interval, no interpolation)
    currentSunX: number;
    currentSunY: number;
    currentRotation: number;

    // Scheduling
    updateIntervalSec: number;
    nextUpdateTime: number;  // performance.now() ms

    // Cached rendering
    channelBitmap: OffscreenCanvas | null;  // channel + ticks + overlay, pre-rendered
    bgBitmap: OffscreenCanvas | null;

    // Pre-rendered Sun glyph with shadow (bitmap cache)
    sunBitmap: OffscreenCanvas | null;
    sunBitmapAnchorX: number;  // pivot offset within bitmap (XML coords)
    sunBitmapAnchorY: number;
    sunBitmapW: number;        // bitmap dimensions in XML coords
    sunBitmapH: number;
}

// ============================================================================
// State expansion (init)
// ============================================================================

/**
 * Expand an AnalemmaPart into runtime state.
 * Called once at init (after XML parsing).
 *
 * Pre-computes the 365-point path, scales it to fit within the disc radius,
 * caches a Path2D for the channel, creates a circular clip of the face
 * background image, and computes initial Sun position and rotation.
 */
export function expandAnalemma(
    part: AnalemmaPart,
    env: Environment,
    images: Map<string, LoadedImage>,
): AnalemmaState {
    const centerX = evalAttr(part.x, env);
    const centerY = evalAttr(part.y, env);
    const radius = evalAttr(part.radius, env) || 40;
    const sunRadius = evalAttr(part.sunRadius, env) || 2.5;
    const sunFillColor = part.sunFillColor ? evalColor(part.sunFillColor, env) : 'rgba(242,228,7,1)';
    const sunStrokeColor = part.sunStrokeColor ? evalColor(part.sunStrokeColor, env) : 'rgba(139,129,75,1)';
    const channelColor = part.channelColor ? evalColor(part.channelColor, env) : 'rgba(0,0,0,1)';
    const channelWidth = evalAttr(part.channelWidth, env) || 0.8;
    const bgRotates = (evalAttr(part.bgRotates, env) || 0) !== 0;
    const updateIntervalSec = evalAttr(part.update, env) || DEFAULT_UPDATE_SEC;

    // Generate the path
    const { path, refAlt, refAz } = computeAnalemmaPath();

    // Scale the path to fit within the disc, using max extent in each axis
    // independently so the figure-eight shape fills the disc well
    // (altitude range is much larger than azimuth range).
    const usableRadius = radius * (1 - PATH_MARGIN_FRACTION);
    let maxAbsAz = 0;
    let maxAbsAlt = 0;
    for (const pt of path) {
        const absAz = Math.abs(pt.deltaAz);
        const absAlt = Math.abs(pt.deltaAlt);
        if (absAz > maxAbsAz) maxAbsAz = absAz;
        if (absAlt > maxAbsAlt) maxAbsAlt = absAlt;
    }
    // Scale each axis so the path fills the disc circle.
    // Use the same scale for both to maintain aspect ratio.
    const maxExtent = Math.max(maxAbsAz, maxAbsAlt);
    const scaleFactor = maxExtent > 0 ? usableRadius / maxExtent : 1;

    // Scale path to XML coords: deltaAz → x, deltaAlt → y
    const pathScaled: [number, number][] = path.map(pt => [
        pt.deltaAz * scaleFactor,
        pt.deltaAlt * scaleFactor,
    ]);

    // Center the figure-eight within the disc by shifting to bounding box midpoint
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [px, py] of pathScaled) {
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
    }
    const pathOffsetX = (minX + maxX) / 2;
    const pathOffsetY = (minY + maxY) / 2;
    for (let i = 0; i < pathScaled.length; i++) {
        pathScaled[i][0] -= pathOffsetX;
        pathScaled[i][1] -= pathOffsetY;
    }

    // Build background disc from face image (includes disc border)
    let bgBitmap: OffscreenCanvas | null = null;
    if (part.bgSrc) {
        const loaded = images.get(part.bgSrc);
        if (loaded) {
            bgBitmap = createDiscBackground(loaded.bitmap, loaded.scale, radius);
        }
    }
    if (!bgBitmap) {
        // No background image — create a simple dark disc with border
        bgBitmap = createFallbackDiscBackground(radius);
    }

    // Build pre-rendered Sun glyph + shadow bitmap
    const { bitmap: sunBitmap, anchorX: sunAnchorX, anchorY: sunAnchorY, w: sunW, h: sunH } =
        buildSunBitmap(sunRadius, sunFillColor, sunStrokeColor);

    // Build pre-rendered channel + season ticks + dark overlay bitmap
    const channelBitmap = buildChannelBitmap(
        pathScaled, radius, channelColor, channelWidth,
    );

    const state: AnalemmaState = {
        path,
        pathScaled,
        scaleFactor,
        pathOffsetX,
        pathOffsetY,
        refAlt,
        refAz,
        centerX,
        centerY,
        radius,
        sunRadius,
        sunFillColor,
        sunStrokeColor,
        channelColor,
        channelWidth,
        bgRotates,
        currentSunX: 0,
        currentSunY: 0,
        currentRotation: 0,
        updateIntervalSec,
        nextUpdateTime: 0,
        channelBitmap,
        bgBitmap,
        sunBitmap,
        sunBitmapAnchorX: sunAnchorX,
        sunBitmapAnchorY: sunAnchorY,
        sunBitmapW: sunW,
        sunBitmapH: sunH,
    };

    // Compute initial position
    updateAnalemmaValues(state, env);

    return state;
}

/**
 * Build a Path2D from the scaled path points.
 * The path is drawn as a closed loop (day 0 → day 364 → back to day 0).
 */
function buildChannelPath2D(pathScaled: [number, number][]): Path2D {
    const p = new Path2D();
    if (pathScaled.length === 0) return p;
    p.moveTo(pathScaled[0][0], -pathScaled[0][1]);  // negate Y for canvas
    for (let i = 1; i < pathScaled.length; i++) {
        p.lineTo(pathScaled[i][0], -pathScaled[i][1]);
    }
    p.closePath();
    return p;
}

/**
 * Pre-render the channel path + season ticks + dark overlay onto a single
 * OffscreenCanvas. This bitmap is blitted rotated per-frame, avoiding
 * per-frame Path2D stroking and fillRect calls.
 *
 * The bitmap covers a 2*radius square centered at (0,0) in XML coords.
 */
function buildChannelBitmap(
    pathScaled: [number, number][],
    radius: number,
    channelColor: string,
    channelWidth: number,
): OffscreenCanvas {
    const scale = 4;  // 4x resolution for quality
    const size = radius * 2;
    const pxSize = Math.ceil(size * scale);
    const canvas = new OffscreenCanvas(pxSize, pxSize);
    const ctx = canvas.getContext('2d')!;

    ctx.scale(scale, scale);
    // Origin at center of the bitmap
    ctx.translate(radius, radius);

    // --- Dark overlay ---
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fill();

    // --- Channel path ---
    const channelPath = buildChannelPath2D(pathScaled);
    ctx.strokeStyle = channelColor;
    ctx.lineWidth = channelWidth;
    ctx.lineJoin = 'round';
    ctx.stroke(channelPath);

    // --- Season ticks ---
    const tickLen = 2;
    const tickAlong = 0.5;
    const gap = channelWidth / 2;

    for (const { dayIndex, color } of SEASON_TICKS) {
        const idx = dayIndex % pathScaled.length;
        const [px, py] = pathScaled[idx];

        const prev = (idx - 1 + pathScaled.length) % pathScaled.length;
        const next = (idx + 1) % pathScaled.length;
        const dx = pathScaled[next][0] - pathScaled[prev][0];
        const dy = pathScaled[next][1] - pathScaled[prev][1];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;

        const tx = dx / len;
        const ty = dy / len;
        const nx = -ty;
        const ny = tx;

        ctx.fillStyle = color;

        for (const side of [1, -1]) {
            const innerX = px + side * nx * gap;
            const innerY = py + side * ny * gap;
            const outerX = px + side * nx * (gap + tickLen);
            const outerY = py + side * ny * (gap + tickLen);
            const midX = (innerX + outerX) / 2;
            const midY = (innerY + outerY) / 2;

            ctx.save();
            ctx.translate(midX, -midY);
            ctx.rotate(-Math.atan2(ty, tx));
            ctx.fillRect(-tickAlong, -tickLen / 2, tickAlong * 2, tickLen);
            ctx.restore();
        }
    }

    return canvas;
}

/**
 * Pre-render the Sun glyph with a drop shadow onto an OffscreenCanvas.
 * Returns the bitmap and layout info for blitting at runtime.
 * The bitmap is at a fixed 8x resolution for quality.
 */
function buildSunBitmap(
    sunRadius: number,
    fillColor: string,
    strokeColor: string,
): { bitmap: OffscreenCanvas; anchorX: number; anchorY: number; w: number; h: number } {
    // Shadow parameters (in XML coords)
    const shadowBlur = 1.5;
    const shadowOffsetX = 0.5;
    const shadowOffsetY = 0.5;
    const shadowPad = shadowBlur * 3 + Math.max(Math.abs(shadowOffsetX), Math.abs(shadowOffsetY));

    // Total extent in XML coords: Sun radius + stroke + shadow padding
    const extent = sunRadius + 0.5 + shadowPad;
    const w = extent * 2;
    const h = extent * 2;

    // Bitmap at 8x resolution
    const scale = 8;
    const pxW = Math.ceil(w * scale);
    const pxH = Math.ceil(h * scale);
    const canvas = new OffscreenCanvas(pxW, pxH);
    const ctx = canvas.getContext('2d')!;

    ctx.scale(scale, scale);

    // Set up shadow
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = shadowBlur * scale;  // shadowBlur is in pixel space
    ctx.shadowOffsetX = shadowOffsetX * scale;
    ctx.shadowOffsetY = shadowOffsetY * scale;

    // Draw Sun glyph centered in the bitmap
    drawSunGlyph(ctx, extent, extent, sunRadius, fillColor, strokeColor);

    return {
        bitmap: canvas,
        anchorX: extent,   // pivot is at center
        anchorY: extent,
        w,
        h,
    };
}

/**
 * Create a circular clip of the face background image, scaled to fit
 * within the analemma disc radius.
 */
function createDiscBackground(
    faceImage: ImageBitmap,
    faceImageScale: number,
    discRadius: number,
): OffscreenCanvas {
    // The face image covers the full face; we want a circular clip centered
    // at the disc position. For simplicity, we scale the entire face image
    // down to fit within 2*discRadius and clip to a circle.
    const size = Math.ceil(discRadius * 2);
    // Use a reasonable pixel resolution
    const pxSize = Math.ceil(size * 4);  // 4x for quality
    const canvas = new OffscreenCanvas(pxSize, pxSize);
    const ctx = canvas.getContext('2d')!;

    // Clip to circle
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2, 0, Math.PI * 2);
    ctx.clip();

    // Scale the face image to fit — the face image covers faceWidth which is
    // typically ~280 XML units. We want to show the portion corresponding
    // to our disc within the face.
    const imgW = faceImage.width * faceImageScale;
    const imgH = faceImage.height * faceImageScale;
    const drawScale = pxSize / (discRadius * 2);

    // Draw the face image centered: the face center maps to the disc center.
    // The face image center is at (imgW/2, imgH/2) in image coords.
    ctx.save();
    ctx.translate(pxSize / 2, pxSize / 2);
    ctx.scale(drawScale, drawScale);
    // Draw at (-imgW/2, -imgH/2) so the center of the face image is at the center
    ctx.drawImage(faceImage, -imgW / 2, -imgH / 2, imgW, imgH);
    ctx.restore();

    // Draw disc border on top (non-rotating, so baked into the background)
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 2;  // in pixel space (4x scale)
    ctx.stroke();

    return canvas;
}

/**
 * Create a simple fallback disc background (dark tinted circle with border)
 * when no face image is available.
 */
function createFallbackDiscBackground(discRadius: number): OffscreenCanvas {
    const size = Math.ceil(discRadius * 2);
    const pxSize = Math.ceil(size * 4);
    const canvas = new OffscreenCanvas(pxSize, pxSize);
    const ctx = canvas.getContext('2d')!;

    // Dark fill
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fill();

    // Border
    ctx.beginPath();
    ctx.arc(pxSize / 2, pxSize / 2, pxSize / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();

    return canvas;
}

// ============================================================================
// Update (no animation — direct value setting)
// ============================================================================

/**
 * Recompute the Sun's position and rotation from the current environment.
 * Called when the update interval expires.
 */
function updateAnalemmaValues(state: AnalemmaState, env: Environment): void {
    const getNow = env.getNow;
    if (!getNow) return;

    const now = getNow();
    const di = dateToDateInterval(now);

    // --- Sun position within the analemma (at reference location/time) ---
    // We compute the Sun's alt/az at the reference location for the current date
    // at the same civil time (12:00 UT), then take the delta from the reference day.
    const nowUTC = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0,
    ));
    const noonDI = dateToDateInterval(nowUTC);

    const alt = sunAltitude(noonDI, REF_LAT_RAD, REF_LON_RAD, null);
    const az = sunAzimuth(noonDI, REF_LAT_RAD, REF_LON_RAD, null);

    state.currentSunX = normalizeAngleDelta(az - state.refAz) * state.scaleFactor - state.pathOffsetX;
    state.currentSunY = (alt - state.refAlt) * state.scaleFactor - state.pathOffsetY;

    // --- Rotation (at observer's actual location/time) ---
    const obsLat = env.observerLatRad ?? 0;
    const obsLon = env.observerLonRad ?? 0;
    state.currentRotation = sunSkyOrientationAngle(di, obsLat, obsLon, null);
}

/**
 * Tick the analemma — called every frame but only recomputes when the
 * update interval has elapsed.
 */
export function tickAnalemma(
    state: AnalemmaState,
    env: Environment,
    now: number,
): void {
    if (now >= state.nextUpdateTime) {
        updateAnalemmaValues(state, env);
        state.nextUpdateTime = now + state.updateIntervalSec * 1000;
    }
}

/**
 * Reset the analemma schedule — forces an immediate recompute on the next tick.
 * Called on step events, body switches, and scrub starts.
 */
export function resetAnalemmaSchedule(state: AnalemmaState): void {
    state.nextUpdateTime = 0;
}

// ============================================================================
// Drawing
// ============================================================================

/**
 * Draw a sun glyph (disc + triangular rays), matching the 'sun' hand type
 * rendering used by Mauna Kea and other faces.
 *
 * @param ctx - Canvas context, already positioned at the sun's center
 * @param radius - Overall radius of the sun glyph (tips of rays)
 * @param fillColor - Fill color for both disc and rays
 * @param strokeColor - Stroke color
 * @param nRays - Number of rays (default 8)
 */
function drawSunGlyph(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    fillColor: string,
    strokeColor: string,
    nRays: number = 8,
): void {
    const innerRadius = radius * 0.5;   // central disc radius
    const rayTip = radius;               // tip of rays

    ctx.fillStyle = fillColor;

    // Draw rays as triangles from inner disc to tips
    ctx.beginPath();
    for (let i = 0; i < nRays; i++) {
        const theta = 2 * Math.PI * i / nRays;
        const tipX = cx + rayTip * Math.cos(theta);
        const tipY = cy + rayTip * Math.sin(theta);
        const cwX = cx + innerRadius * Math.cos(theta + Math.PI / nRays);
        const cwY = cy + innerRadius * Math.sin(theta + Math.PI / nRays);
        const ccwX = cx + innerRadius * Math.cos(theta - Math.PI / nRays);
        const ccwY = cy + innerRadius * Math.sin(theta - Math.PI / nRays);

        ctx.moveTo(tipX, tipY);
        ctx.lineTo(cwX, cwY);
        ctx.lineTo(ccwX, ccwY);
        ctx.closePath();
    }
    ctx.fill();

    // Draw central disc
    ctx.beginPath();
    ctx.arc(cx, cy, innerRadius, 0, 2 * Math.PI);
    ctx.fill();
}

/**
 * Season tick marks: colored squares straddling the channel at equinox/solstice points.
 * Perpendicular to the local path direction, 1 unit on a side.
 */
const SEASON_TICKS: { dayIndex: number; color: string }[] = [
    { dayIndex: 0,   color: '#22aa22' },  // Vernal equinox — green
    { dayIndex: 93,  color: '#ddcc00' },  // Summer solstice — yellow
    { dayIndex: 184, color: '#ee7722' },  // Autumnal equinox — orange
    { dayIndex: 275, color: '#2266cc' },  // Winter solstice — blue
];

/**
 * Draw the analemma onto the canvas.
 *
 * All static elements (background, dark overlay, channel path, season ticks,
 * disc border) are pre-rendered into bitmaps at init time. Per-frame work is
 * just three drawImage() calls plus one arc stroke:
 *
 * 1. Background disc bitmap (optionally non-rotating)
 * 2. Channel+ticks bitmap (rotated)
 * 3. Sun marker bitmap (rotated)
 * 4. Disc border stroke
 */
export function drawAnalemma(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    state: AnalemmaState,
): void {
    const { centerX, centerY, radius, currentRotation, bgRotates } = state;

    ctx.save();

    // Translate to disc center (negate Y for canvas coords)
    ctx.translate(centerX, -centerY);

    // --- Background disc (includes border) ---
    if (state.bgBitmap) {
        if (bgRotates) {
            ctx.save();
            ctx.rotate(currentRotation);
            drawBackground(ctx, state);
            ctx.restore();
        } else {
            drawBackground(ctx, state);
        }
    }

    // --- Clip to disc ---
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.clip();

    // --- Pre-rendered channel + ticks + overlay (rotated) ---
    ctx.rotate(currentRotation);
    if (state.channelBitmap) {
        ctx.drawImage(state.channelBitmap, -radius, -radius, radius * 2, radius * 2);
    }

    // --- Sun marker (pre-rendered bitmap with shadow) ---
    if (state.sunBitmap) {
        ctx.drawImage(
            state.sunBitmap,
            state.currentSunX - state.sunBitmapAnchorX,
            -state.currentSunY - state.sunBitmapAnchorY,
            state.sunBitmapW,
            state.sunBitmapH,
        );
    }

    ctx.restore();  // unclip

    ctx.restore();  // undo translate
}

/** Draw the clipped background image at the disc center. */
function drawBackground(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    state: AnalemmaState,
): void {
    if (!state.bgBitmap) return;
    const { radius } = state;
    const bmp = state.bgBitmap;
    // Draw the cached circular background centered at (0, 0)
    ctx.drawImage(bmp, -radius, -radius, radius * 2, radius * 2);
}
