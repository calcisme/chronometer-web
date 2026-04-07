/**
 * Canvas 2D renderer for Chronometer watch parts.
 *
 * Document-order architecture:
 *   1. buildStaticBlockCaches() — pre-renders only explicit <static> blocks
 *      (with window cutouts baked in) to OffscreenCanvases stored on each
 *      StaticPart node. Runs once per mode/date/resize change.
 *   2. renderFrame() — iterates ALL parts in XML document order each frame:
 *      - <static> blocks → blit their pre-cached image
 *      - QHands → draw live geometry
 *      - Everything else → draw directly
 *
 * Window cutouts use Canvas 2D compositing (destination-out).
 * Parts are always rendered in XML document order — no sorting or z-index.
 */

import type { Environment } from '../expr/evaluator.js';
import type {
    Watch,
    WatchPart,
    QDialPart,
    QHandPart,
    WheelPart,
    QTextPart,
    ImagePart,
    ButtonPart,
    WindowPart,
    StaticPart,
    QRectPart,
} from './types.js';
import { evalAttr, evalColor } from './watch-env.js';
import type { LoadedImage } from './image-loader.js';
import type { TerminatorLeafState } from './terminator.js';
import { drawTerminator } from './terminator.js';

/** Returns true if a CSS color string has alpha = 0 (fully transparent). */
function isTransparent(cssColor: string): boolean {
    // evalColor always produces 'rgba(r,g,b,a)' strings.
    // The alpha is the last numeric value; 0.000 means fully transparent.
    const m = cssColor.match(/,([\d.]+)\)$/);
    return m !== null && parseFloat(m[1]) === 0;
}

/** Shared context type — works for both on-screen and offscreen canvases. */
type RenderContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Module-scoped image map, set during rendering calls. */
let currentImages: Map<string, LoadedImage> | undefined;

// ============================================================================
// Public API
// ============================================================================

/**
 * Bezel ring thickness in XML coordinate units.
 * This constant is exported so the scale calculation in standalone.ts
 * can account for the bezel when sizing the canvas.
 */
export const BEZEL_THICKNESS_XML = 10;

/**
 * Pre-render all <static> blocks in the watch.
 *
 * Each StaticPart gets its own OffscreenCanvas (stored on part.cachedCanvas)
 * with all window cutouts — both internal and from preceding windows — baked
 * in. Call once on init, and again when mode/date/timezone/size changes.
 */
export function buildStaticBlockCaches(
    watch: Watch,
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
    images?: Map<string, LoadedImage>,
    terminatorLeaves?: TerminatorLeafState[],
): void {
    currentImages = images;

    // Walk top-level parts, accumulating windows that precede <static> blocks
    const pendingWindows: WindowPart[] = [];

    for (const part of watch.parts) {
        if (part.type === 'Window') {
            pendingWindows.push(part);
        } else if (part.type === 'Static') {
            // Capture the preceding windows for this block
            part.precedingWindows = pendingWindows.slice();
            pendingWindows.length = 0;

            // Build the cache for this static block
            const cache = new OffscreenCanvas(canvasWidth, canvasHeight);
            const ctx = cache.getContext('2d')!;
            ctx.translate(canvasWidth / 2, canvasHeight / 2);
            ctx.scale(scale, scale);

            // Draw the static block's children with internal window handling
            renderPartsWithWindows(ctx, part.children, env, canvasWidth, canvasHeight, scale, terminatorLeaves, true);

            // Apply preceding window cutouts
            for (const win of part.precedingWindows) {
                cutWindowHole(ctx, win, env);
            }

            part.cachedCanvas = cache;
        } else {
            // Non-window, non-static parts reset the pending windows
            pendingWindows.length = 0;
        }
    }
}

/**
 * Render a single frame in document order.
 *
 * All parts are drawn in XML order: <static> blocks blit pre-cached images,
 * QHands draw live, and everything else draws directly.
 */
export function renderFrame(
    ctx: CanvasRenderingContext2D,
    watch: Watch,
    env: Environment,
    scale: number,
    terminatorLeaves?: TerminatorLeafState[],
): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);

    renderPartsDocumentOrder(ctx, watch.parts, env, w, h, scale, terminatorLeaves);
    drawBezel(ctx, watch);

    ctx.restore();
}

/**
 * Legacy single-call API — builds caches and renders in one step.
 * Kept for backward compatibility (main.ts).
 */
export function renderWatch(
    ctx: CanvasRenderingContext2D,
    watch: Watch,
    env: Environment,
    scale: number,
    images?: Map<string, LoadedImage>,
): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    buildStaticBlockCaches(watch, env, w, h, scale, images);
    renderFrame(ctx, watch, env, scale);
}

// ============================================================================
// Window accumulation + compositing
// ============================================================================

// ============================================================================
// Document-order frame rendering
// ============================================================================

/**
 * Iterate parts in document order, drawing each appropriately.
 * Windows accumulate and are applied to the next drawable part
 * (unless consumed by a <static> block, whose cache already has them).
 */
function renderPartsDocumentOrder(
    ctx: CanvasRenderingContext2D,
    parts: WatchPart[],
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
    terminatorLeaves?: TerminatorLeafState[],
): void {
    const pendingWindows: WindowPart[] = [];

    for (const part of parts) {
        if (part.type === 'Window') {
            pendingWindows.push(part);
            continue;
        }

        if (part.type === 'Button') continue;

        if (part.type === 'Static') {
            // The static cache already has preceding window cutouts baked in
            pendingWindows.length = 0;

            if (part.cachedCanvas) {
                ctx.save();
                ctx.resetTransform();
                ctx.drawImage(part.cachedCanvas, 0, 0);
                ctx.restore();
            }

            // Draw any QHands inside the static block (they're dynamic)
            drawQHandsInParts(ctx, part.children, env);

            // Draw window borders from the preceding windows
            if (part.precedingWindows) {
                for (const win of part.precedingWindows) {
                    drawWindowBorder(ctx, win, env);
                }
            }
            continue;
        }

        if (part.type === 'QHand') {
            // Flush any pending windows as borders only (they don't clip QHands)
            for (const win of pendingWindows) {
                drawWindowBorder(ctx, win, env);
            }
            pendingWindows.length = 0;

            if (part.src && currentImages) {
                drawImageHand(ctx, part, env);
            } else {
                drawQHand(ctx, part, env);
            }
            continue;
        }

        if (part.type === 'Terminator') {
            if (terminatorLeaves && terminatorLeaves.length > 0) {
                drawTerminator(ctx, terminatorLeaves);
            }
            continue;
        }

        // Regular drawable part — apply pending window cutouts if any
        if (pendingWindows.length > 0) {
            renderWithWindowCutouts(ctx, part, pendingWindows, env, canvasWidth, canvasHeight, scale);
            pendingWindows.length = 0;
        } else {
            drawStaticPart(ctx, part, env, canvasWidth, canvasHeight, scale);
        }
    }

    // Leftover windows — draw borders only
    for (const win of pendingWindows) {
        drawWindowBorder(ctx, win, env);
    }
}

/** Draw only QHands found within a list of parts (recursive into Static). */
function drawQHandsInParts(
    ctx: CanvasRenderingContext2D,
    parts: WatchPart[],
    env: Environment,
): void {
    for (const part of parts) {
        if (part.type === 'QHand') {
            if (part.src && currentImages) {
                drawImageHand(ctx, part, env);
            } else {
                drawQHand(ctx, part, env);
            }
        } else if (part.type === 'Static') {
            drawQHandsInParts(ctx, part.children, env);
        }
    }
}

/** Draw the bezel ring if the watch specifies one. */
function drawBezel(ctx: RenderContext, watch: Watch): void {
    if (!watch.bezelColor) return;
    const faceRadius = watch.faceWidth / 2;
    const outerRadius = faceRadius + BEZEL_THICKNESS_XML;
    ctx.beginPath();
    ctx.arc(0, 0, outerRadius, 0, 2 * Math.PI, false);
    ctx.arc(0, 0, faceRadius, 0, 2 * Math.PI, true);
    ctx.fillStyle = watch.bezelColor;
    ctx.fill('evenodd');

    ctx.beginPath();
    ctx.arc(0, 0, faceRadius, 0, 2 * Math.PI);
    ctx.strokeStyle = 'black';
    ctx.lineWidth = 0.75;
    ctx.stroke();
}

/**
 * Render a list of parts in document order, accumulating windows and
 * applying cutouts to the next drawable part.
 * Used internally for building <static> block caches.
 */
function renderPartsWithWindows(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    parts: WatchPart[],
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
    terminatorLeaves?: TerminatorLeafState[],
    applyTrailingCutouts: boolean = false,
): void {
    const pendingWindows: WindowPart[] = [];

    for (const part of parts) {
        if (part.type === 'Window') {
            pendingWindows.push(part);
            continue;
        }

        if (part.type === 'Button') continue;

        // QHand: Image-based hands without anchors (e.g. moon disc) are drawn
        // into the static cache. Everything else is dynamic.
        if (part.type === 'QHand') {
            if (part.src && currentImages && !part.xAnchor && !part.yAnchor) {
                drawImageHand(ctx, part, env);
            }
            continue;
        }

        if (part.type === 'Terminator') {
            if (terminatorLeaves && terminatorLeaves.length > 0) {
                drawTerminator(ctx, terminatorLeaves);
            }
            continue;
        }

        if (pendingWindows.length > 0) {
            renderWithWindowCutouts(ctx, part, pendingWindows, env, canvasWidth, canvasHeight, scale);
            pendingWindows.length = 0;
        } else {
            drawStaticPart(ctx, part, env, canvasWidth, canvasHeight, scale);
        }
    }

    // Leftover pending windows
    for (const win of pendingWindows) {
        if (applyTrailingCutouts) {
            cutWindowHole(ctx, win, env);
        }
        drawWindowBorder(ctx, win, env);
    }
}

/**
 * Render a part to a temporary OffscreenCanvas, cut window holes,
 * then composite the result onto the main context.
 */
function renderWithWindowCutouts(
    ctx: RenderContext,
    part: WatchPart,
    windows: WindowPart[],
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
): void {
    // Create temp canvas for compositing
    const temp = new OffscreenCanvas(canvasWidth, canvasHeight);
    const tctx = temp.getContext('2d')!;

    // Set up same coordinate system as main context
    tctx.translate(canvasWidth / 2, canvasHeight / 2);
    tctx.scale(scale, scale);

    // Draw the part onto the temp canvas
    drawStaticPart(tctx, part, env, canvasWidth, canvasHeight, scale);

    // Cut window holes using destination-out
    for (const win of windows) {
        cutWindowHole(tctx, win, env);
    }

    // Composite temp canvas onto main context (reset transform first)
    ctx.save();
    ctx.resetTransform();
    ctx.drawImage(temp, 0, 0);
    ctx.restore();

    // Draw window borders on main context (on top of composited result)
    for (const win of windows) {
        drawWindowBorder(ctx, win, env);
    }
}

/**
 * Cut a transparent hole in the given context using destination-out.
 */
function cutWindowHole(
    ctx: RenderContext,
    win: WindowPart,
    env: Environment,
): void {
    const xVal = evalAttr(win.x, env);
    const yVal = evalAttr(win.y, env);
    const w = evalAttr(win.w, env);
    const h = evalAttr(win.h, env);
    const isPorthole = win.windowType === 'porthole';

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';

    if (isPorthole) {
        // iOS: x,y is the arc center (CGContextAddArc uses rect.origin directly)
        const cx = xVal;
        const cy = -yVal;
        const r = Math.min(w, h) / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.fill();
    } else {
        // iOS: x,y is the rect corner (CGContextClearRect uses rect directly)
        const cx = xVal + w / 2;
        const cy = -(yVal + h / 2);
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    }

    ctx.restore();
}

// ============================================================================
// Part dispatch — static vs. dynamic
// ============================================================================

/** Draw a static part (everything except QHand/Button). */
function drawStaticPart(
    ctx: RenderContext,
    part: WatchPart,
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
): void {
    switch (part.type) {
        case 'Static':
            drawStatic(ctx, part, env, canvasWidth, canvasHeight, scale);
            break;
        case 'QDial':
            drawQDial(ctx, part, env);
            break;
        case 'Wheel':
            drawWheel(ctx, part, env);
            break;
        case 'QText':
            drawQText(ctx, part, env);
            break;
        case 'Image':
            drawImage(ctx, part, env);
            break;
        case 'QRect':
            drawQRect(ctx, part, env);
            break;
        case 'Window':
            // Standalone window (no following part to clip) — just draw border
            drawWindowBorder(ctx, part, env);
            break;
    }
}

// ============================================================================
// Static container — handles inner windows via recursive renderPartsWithWindows
// ============================================================================

function drawStatic(
    ctx: RenderContext,
    part: StaticPart,
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
): void {
    // Static containers can have windows inside them — trailing windows
    // should cut through the entire static composite (e.g. AM/PM porthole).
    renderPartsWithWindows(ctx, part.children, env, canvasWidth, canvasHeight, scale, undefined, true);
}

// ============================================================================
// QDial — circular dial with marks and text
// ============================================================================

// Mark type bitmask values (matching ECDiskMarksMask in the original)
const MARKS_NONE     = 0;
const MARKS_OUTER    = 1 << 0;
const MARKS_CENTER   = 1 << 1;
const MARKS_TICK_OUT = 1 << 2;
const MARKS_DOT      = 1 << 4;

function parseMarksType(marks: string | undefined): number {
    if (!marks) return MARKS_NONE;
    // Handle pipe-separated values like 'outer|tickOut'
    let result = MARKS_NONE;
    for (const part of marks.split('|')) {
        switch (part.trim().toLowerCase()) {
            case 'outer': result |= MARKS_OUTER; break;
            case 'center': result |= MARKS_CENTER; break;
            case 'tickout': result |= MARKS_TICK_OUT; break;
            case 'dot': result |= MARKS_DOT; break;
        }
    }
    return result;
}

function drawQDial(
    ctx: RenderContext,
    part: QDialPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const radius = evalAttr(part.radius, env);
    if (radius <= 0) return;

    const bgColor = evalColor(part.bgColor, env);
    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'rgba(0,0,0,1)';
    const markWidth = part.markWidth !== undefined ? evalAttr(part.markWidth, env) : 1;
    const nMarks = evalAttr(part.nMarks, env);
    const mSize = evalAttr(part.mSize, env);
    const angle1 = evalAttr(part.angle1, env);
    const angle2 = part.angle2 !== undefined ? evalAttr(part.angle2, env) : 2 * Math.PI;
    const marks = parseMarksType(part.marks);

    ctx.save();
    ctx.translate(x, y);

    // Background fill
    if (bgColor !== 'rgba(0,0,0,0)') {
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Border stroke (skip when markWidth is 0 — e.g. dial-ua txt suppresses border)
    if ((marks & MARKS_OUTER) && markWidth > 0) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = markWidth;
        ctx.beginPath();
        // Respect angle1/angle2 range if specified
        if (angle1 !== 0 || angle2 !== 2 * Math.PI) {
            ctx.arc(0, 0, radius, angle1 - Math.PI / 2, angle2 - Math.PI / 2);
        } else {
            ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        }
        ctx.stroke();
    }

    // Tick marks
    if ((marks & MARKS_TICK_OUT) && nMarks > 0) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = markWidth;
        const ms = mSize || radius * 0.03;
        for (let i = 0; i < nMarks; i++) {
            const th = (i / nMarks) * 2 * Math.PI;
            // Check angle range
            if (angle1 !== 0 || angle2 !== 2 * Math.PI) {
                // Adjust: XML angles are measured clockwise from 12 o'clock
                // In the original, theta = th - pi/2, then negated
                const normTh = th;
                if (normTh < angle1 || normTh > angle2) continue;
            }
            const cosT = Math.cos(th - Math.PI / 2);
            const sinT = Math.sin(th - Math.PI / 2);
            const outerR = radius;
            const innerR = Math.max(0, radius - ms);
            ctx.beginPath();
            ctx.moveTo(outerR * cosT, outerR * sinT);
            ctx.lineTo(innerR * cosT, innerR * sinT);
            ctx.stroke();
        }
    }

    // Dot marks
    if ((marks & MARKS_DOT) && nMarks > 0) {
        ctx.fillStyle = strokeColor;
        const dotR = (mSize || 1.5) / 2;
        for (let i = 0; i < nMarks; i++) {
            const th = (i / nMarks) * 2 * Math.PI;
            // Angle range check
            if (angle1 !== 0 || angle2 !== 2 * Math.PI) {
                if (th < angle1 || th > angle2) continue;
            }
            const cosT = Math.cos(th - Math.PI / 2);
            const sinT = Math.sin(th - Math.PI / 2);
            ctx.beginPath();
            ctx.arc(radius * cosT, radius * sinT, dotR, 0, 2 * Math.PI);
            ctx.fill();
        }
    }

    // Text labels around the dial
    // Constants from the original iOS source (ECConstants.h in ESAstro)
    const EC_DIAL_RADIUS_FACTOR = 0.92;
    const EC_DIAL_SMALL_RADIUS_CUTOFF = 45;
    const EC_DIAL_SMALL_RADIUS_FACTOR = 0.11 / (EC_DIAL_SMALL_RADIUS_CUTOFF - 25);

    if (part.text) {
        const labels = part.text.split(',');
        const n = labels.length;
        const fontSize = evalAttr(part.fontSize, env) || 12;
        const fontName = part.fontName || 'Arial';
        const orientation = part.orientation || 'upright';
        const hasTicks = marks !== MARKS_NONE;

        ctx.fillStyle = strokeColor;
        ctx.font = `${fontSize}px "${fontName}"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        if (orientation === 'upright') {
            // Original iOS: drawDialUpright
            // radiusFactor increases for small dials (radius < 45)
            const radiusFactor = radius < EC_DIAL_SMALL_RADIUS_CUTOFF
                ? EC_DIAL_RADIUS_FACTOR + EC_DIAL_SMALL_RADIUS_FACTOR * (EC_DIAL_SMALL_RADIUS_CUTOFF - radius)
                : EC_DIAL_RADIUS_FACTOR;

            for (let i = 0; i < n; i++) {
                const label = labels[i].trim();
                if (!label) continue;
                // Original uses -(i/n)*2*PI + PI/2 in iOS coords (Y-up);
                // Canvas Y-down, so angle = (i/n)*2*PI - PI/2
                const th = (i / n) * 2 * Math.PI - Math.PI / 2;

                // Measure actual text size for diagonal-aware offset
                const measured = ctx.measureText(label);
                const w = measured.width;
                const h = fontSize;  // approximate text height
                // Offset inward by half the diagonal of the bounding box
                const textR = radius * radiusFactor - Math.sqrt(w * w + h * h) / 2;
                const tx = textR * Math.cos(th);
                const ty = textR * Math.sin(th);
                ctx.save();
                ctx.translate(tx, ty);
                ctx.fillText(label, 0, 0);
                ctx.restore();
            }
        } else if (orientation === 'demi') {
            // Original iOS: drawDialDemiRadial
            // Uses rotate-per-label approach; radial half at top, anti-radial at bottom
            const demiTweak = evalAttr(part.demiTweak, env);
            // QDial parts always have tick=ECDialTickNone (tick is a separate
            // attribute from marks), so the original code uses: radius * 1 = radius
            const baseR = radius;

            for (let i = 0; i < n; i++) {
                const label = labels[i].trim();
                if (!label) continue;

                // In iOS, labels are rotated clockwise from 12-o'clock.
                // Compute which half this label is in:
                //   i in [0..n/4] or [3n/4..n] => radial (top) half
                //   i in (n/4..3n/4) => anti-radial (bottom) half
                const th = (i / n) * 2 * Math.PI - Math.PI / 2;

                // Measure text for height-based offset
                const measured = ctx.measureText(label);
                const textH = fontSize;

                ctx.save();
                if (i > n / 4 && i < 3 * n / 4) {
                    // Anti-radial half: text flipped 180°
                    // iOS: r = baseR + demiTweak, rect at y = -r (text top at -r)
                    // Center of text at -(baseR + demiTweak) + textH/2
                    const r = baseR + demiTweak;
                    const textR = r - textH / 2;
                    const tx = textR * Math.cos(th);
                    const ty = textR * Math.sin(th);
                    ctx.translate(tx, ty);
                    ctx.rotate(th + Math.PI / 2 + Math.PI);  // rotated + flipped
                    ctx.fillText(label, 0, 0);
                } else {
                    // Radial half: text upright along radius
                    // iOS: rect at y = r - s.height → center at r - textH/2
                    const textR = baseR - textH / 2;
                    const tx = textR * Math.cos(th);
                    const ty = textR * Math.sin(th);
                    ctx.translate(tx, ty);
                    ctx.rotate(th + Math.PI / 2);
                    ctx.fillText(label, 0, 0);
                }
                ctx.restore();
            }
        } else {
            // Default: radial text
            // Original iOS: drawDialRadial
            // rect at y = radius * 0.92 - s.height → center at radius * 0.92 - textH/2
            for (let i = 0; i < n; i++) {
                const label = labels[i].trim();
                if (!label) continue;
                const th = (i / n) * 2 * Math.PI - Math.PI / 2;
                const textH = fontSize;
                const textR = radius * EC_DIAL_RADIUS_FACTOR - textH / 2;
                const tx = textR * Math.cos(th);
                const ty = textR * Math.sin(th);
                ctx.save();
                ctx.translate(tx, ty);
                ctx.rotate(th + Math.PI / 2);
                ctx.fillText(label, 0, 0);
                ctx.restore();
            }
        }
    }

    // Center dot (matching original drawFilledArcRing centerRadius logic)
    if (marks & MARKS_CENTER) {
        ctx.fillStyle = 'rgba(0,0,0,1)';
        ctx.beginPath();
        ctx.arc(0, 0, markWidth, 0, 2 * Math.PI);
        ctx.fill();
    }

    ctx.restore();
}

// ============================================================================
// QHand — drawn clock hand
// ============================================================================

function drawQHand(
    ctx: CanvasRenderingContext2D,
    part: QHandPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    // Use pre-computed animated angle if available, otherwise evaluate expression
    const angle = part.dynamicState
        ? part.dynamicState.currentAngle
        : evalAttr(part.angle, env);
    const length = evalAttr(part.length, env);
    const width = evalAttr(part.width, env);
    const tail = evalAttr(part.tail, env);

    if (length <= 0) return;

    const handType = part.handType || 'tri';
    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'rgba(0,0,0,1)';
    const fillColor = part.fillColor ? evalColor(part.fillColor, env) : 'rgba(0,0,0,1)';
    const lineWidth = evalAttr(part.lineWidth, env) || 0.5;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Main hand body (rect stops short by oTail so ornament overlaps cleanly)
    const oTail = evalAttr(part.oTail, env);
    const length2 = evalAttr(part.length2, env);

    if (handType === 'quad') {
        // iOS ECQHandQuad: bezier curves + filled triangle tip
        // Uses oWidth, oLength, oCenter (not width for the shape)
        const oLength = evalAttr(part.oLength, env);
        const oWidth = evalAttr(part.oWidth, env);
        const oCenter2 = evalAttr(part.oCenter, env);

        // Two quadratic bezier curves forming the bulging body
        // iOS Y-up → Canvas Y-down: negate Y values
        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = strokeColor;
        ctx.fillStyle = fillColor;

        // Left curve: from -oWidth/12 at oCenter up to -oWidth/4 at oLength
        ctx.beginPath();
        ctx.moveTo(-oWidth / 12, -oCenter2);
        ctx.quadraticCurveTo(-oWidth * 0.45, -oLength / 2, -oWidth / 4, -oLength);
        // Right curve: from oWidth/4 at oLength down to oWidth/12 at oCenter
        ctx.moveTo(oWidth / 4, -oLength);
        ctx.quadraticCurveTo(oWidth * 0.45, -oLength / 2, oWidth / 12, -oCenter2);
        if (fillColor !== 'rgba(0,0,0,0)') ctx.fill();
        if (strokeColor !== 'rgba(0,0,0,0)') ctx.stroke();

        // Filled triangle tip from oLength to length
        const oStrokeColor = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
        ctx.fillStyle = oStrokeColor;
        ctx.lineWidth = 0;
        ctx.beginPath();
        ctx.moveTo(oWidth / 4 + lineWidth / 2, -oLength);
        ctx.lineTo(0, -length);
        ctx.lineTo(-oWidth / 4 - lineWidth / 2, -oLength);
        ctx.lineTo(-oWidth / 4 + lineWidth / 2, -oLength);
        ctx.lineTo(0, -oLength * 1.2);
        ctx.lineTo(oWidth / 4 - lineWidth / 2, -oLength);
        ctx.closePath();
        ctx.fill();

        // Center dot
        const oCenter3 = evalAttr(part.oCenter, env);
        if (oCenter3 > 0) {
            const osc = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
            drawCenterDot(ctx, oCenter3, osc);
        }
    } else {
        drawHandShape(ctx, handType, length, width, tail, strokeColor, fillColor, lineWidth, oTail, length2);

        // Ornament diamond (for non-quad hands)
        const oLength = evalAttr(part.oLength, env);
        if (oLength > 0) {
            const oWidth = evalAttr(part.oWidth, env) || width;
            const oLineWidth = evalAttr(part.oLineWidth, env) || lineWidth;
            const oStrokeColor = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
            const oFillColor = part.oFillColor ? evalColor(part.oFillColor, env) : fillColor;
            drawHandOrnament(ctx, length, oLength, oWidth, oTail, oLineWidth, oStrokeColor, oFillColor);
        }

        // Tail circle
        const oRadius = evalAttr(part.oRadius, env);
        if (oRadius > 0) {
            const tLW = evalAttr(part.tLineWidth, env) || evalAttr(part.oLineWidth, env) || lineWidth;
            const tSC = part.tStrokeColor ? evalColor(part.tStrokeColor, env)
                      : (part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor);
            const tFC = part.tFillColor ? evalColor(part.tFillColor, env)
                      : (part.oFillColor ? evalColor(part.oFillColor, env) : fillColor);
            drawTailCircle(ctx, tail, oRadius, tLW, tSC, tFC);
        }

        // Center dot
        const oCenter2 = evalAttr(part.oCenter, env);
        if (oCenter2 > 0) {
            const osc = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
            drawCenterDot(ctx, oCenter2, osc);
        }
    }

    ctx.restore();
}

/** Diamond/kite-shaped arrowhead ornament at the hand tip */
function drawHandOrnament(
    ctx: CanvasRenderingContext2D,
    length: number,
    oLength: number,
    oWidth: number,
    oTail: number,
    oLineWidth: number,
    oStrokeColor: string,
    oFillColor: string,
): void {
    // Ornament extends beyond the hand tip as a kite/arrowhead
    const baseY = -(length - oLineWidth * 3);   // widest point
    const tipY = -(length - oLineWidth * 3 + oLength);  // tip
    const innerY = -(length - oTail);            // inner point

    ctx.beginPath();
    ctx.lineWidth = oLineWidth;
    ctx.strokeStyle = oStrokeColor;
    ctx.fillStyle = oFillColor;
    ctx.moveTo(0, tipY);
    ctx.lineTo(oWidth / 2, baseY);
    ctx.lineTo(0, innerY);
    ctx.lineTo(-oWidth / 2, baseY);
    ctx.closePath();
    if (oFillColor !== 'rgba(0,0,0,0)') ctx.fill();
    if (oStrokeColor !== 'rgba(0,0,0,0)') ctx.stroke();

    // Extra small triangle at the very tip for a sharp point
    if (oLineWidth > 0) {
        const extraTipY = -(length + oLength);
        const extraBaseY = -(length + oLength - oLineWidth * 3);
        ctx.beginPath();
        ctx.lineWidth = 0;
        ctx.fillStyle = oStrokeColor;
        ctx.moveTo(oLineWidth / 2, extraBaseY);
        ctx.lineTo(0, extraTipY);
        ctx.lineTo(-oLineWidth / 2, extraBaseY);
        ctx.closePath();
        ctx.fill();
    }
}

/** Filled/stroked circle at the tail of the hand */
function drawTailCircle(
    ctx: CanvasRenderingContext2D,
    tail: number,
    oRadius: number,
    lineWidth: number,
    strokeColor: string,
    fillColor: string,
): void {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;
    ctx.beginPath();
    // iOS: CGRectMake(-oRadiusX, -tail-2*oRadius, oRadiusX*2, oRadius*2)
    // The center of that ellipse is at y = -tail - oRadius (Y-up).
    // In our Y-down canvas, the tail extends in +Y, so center = tail + oRadius.
    ctx.arc(0, tail + oRadius, oRadius, 0, 2 * Math.PI);
    if (fillColor !== 'rgba(0,0,0,0)') ctx.fill();
    if (strokeColor !== 'rgba(0,0,0,0)') ctx.stroke();
}

/** Filled dot at the center of rotation */
function drawCenterDot(
    ctx: CanvasRenderingContext2D,
    radius: number,
    color: string,
): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, 2 * Math.PI);
    ctx.fill();
}

function drawHandShape(
    ctx: CanvasRenderingContext2D,
    handType: string,
    length: number,
    width: number,
    tail: number,
    strokeColor: string,
    fillColor: string,
    lineWidth: number,
    oTail: number = 0,
    length2: number = 0,
): void {
    ctx.beginPath();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;

    if (handType === 'rect') {
        // Rectangle hand: from length2 to length (or tail to length if no length2)
        const hw = width / 2;
        if (length2 > 0) {
            // Short outer segment: draw from -length2 to -length
            ctx.rect(-hw, -length2, width, -(length - length2));
        } else {
            ctx.rect(-hw, tail, width, -(length + tail - oTail));
        }
    } else if (handType === 'quad') {
        // Diamond/needle hand: quadrilateral that tapers from a point at
        // the tail to max width at the midpoint, then back to a point at the tip.
        const hw = width / 2;
        const totalLen = length + tail;
        const midY = -(totalLen * 0.3) + tail;  // widest point at ~30% from center

        ctx.moveTo(0, tail);              // point at tail end
        ctx.lineTo(hw, midY);             // right side at widest point
        ctx.lineTo(0, -(length - oTail)); // point at tip
        ctx.lineTo(-hw, midY);            // left side at widest point
        ctx.closePath();
    } else {
        // Triangle hand (default): pointed tip, wide base
        const hw = width / 2;
        if (length2 > 0) {
            ctx.moveTo(0, -length);          // tip
            ctx.lineTo(hw, -length2);        // bottom right
            ctx.lineTo(-hw, -length2);       // bottom left
        } else {
            ctx.moveTo(0, -length);          // tip
            ctx.lineTo(hw, tail);            // bottom right
            ctx.lineTo(-hw, tail);           // bottom left
        }
        ctx.closePath();
    }

    // Fill if not clear
    if (fillColor !== 'rgba(0,0,0,0)') {
        ctx.fill();
    }
    // Stroke
    if (strokeColor !== 'rgba(0,0,0,0)') {
        ctx.stroke();
    }
}

// ============================================================================
// Wheel — rotating text wheel (SWheel / QWheel)
// ============================================================================

function drawWheel(
    ctx: RenderContext,
    part: WheelPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const radius = evalAttr(part.radius, env);
    const angle = evalAttr(part.angle, env);
    if (radius <= 0) return;

    const labels = part.text?.split(',') || [];
    const n = labels.length;
    if (n === 0) return;

    const fontSize = evalAttr(part.fontSize, env) || 12;
    const fontName = part.fontName || 'Arial';
    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'rgba(0,0,0,1)';
    const bgColor = evalColor(part.bgColor, env);
    const orientation = part.orientation || 'twelve';

    ctx.save();
    ctx.translate(x, y);

    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Compute max label dimensions for consistent positioning
    let maxW = 0, maxH = fontSize;
    for (const lab of labels) {
        const m = ctx.measureText(lab.trim());
        maxW = Math.max(maxW, m.width);
    }

    // angle1/angle2 define the arc range (default: full circle)
    const angle1 = part.angle1 ? evalAttr(part.angle1, env) : 0;
    const angle2 = part.angle2 ? evalAttr(part.angle2, env) : 2 * Math.PI;
    const arcSpan = angle2 - angle1;
    const step = arcSpan / n;

    // tradius = text radius (same as radius if not specified)
    const tradius = radius;

    // QWheels draw their own circular background; SWheels rely on
    // the QRect behind the window for their background.
    if (part.wheelVariant === 'QWheel' && bgColor !== 'rgba(0,0,0,0)') {
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Draw labels around the circle.
    // Two modes depending on whether the wheel spans a full circle or partial arc:
    // - Full circle (no angle1/angle2): text rotates with wheel, tops toward center
    //   (iOS ECQHandSpoke rendering — e.g. Haleakala weekday/date wheels)
    // - Partial arc (angle1/angle2 specified): text stays horizontal/upright
    //   through small windows (e.g. Chandra date digit wheels)
    const isPartialArc = !!part.angle1 || !!part.angle2;
    
    ctx.save();
    if (isPartialArc) {
        ctx.rotate(-angle + angle1);
    } else {
        ctx.rotate(angle + angle1);
    }

    for (let i = 0; i < n; i++) {
        const label = labels[i].trim();

        if (label) {
            ctx.fillStyle = strokeColor;
            ctx.save();

            // Position text based on orientation
            const currentRotation = isPartialArc ? (-angle + angle1 + i * step) : 0;
            switch (orientation.toLowerCase()) {
                case 'three':
                    ctx.translate(tradius - maxW / 2, 0);
                    break;
                case 'six':
                    ctx.translate(0, tradius - maxH / 2);
                    break;
                case 'twelve':
                    ctx.translate(0, -(tradius - maxH / 2));
                    break;
                case 'nine':
                    ctx.translate(-(tradius - maxW / 2), 0);
                    break;
            }
            // Counter-rotate only for partial-arc wheels to keep text horizontal
            if (isPartialArc) {
                ctx.rotate(-currentRotation);
            }

            ctx.fillText(label, 0, 0);
            ctx.restore();
        }

        ctx.rotate(isPartialArc ? step : -step);
    }

    ctx.restore(); // closes ctx.save() for ctx.rotate(angle + angle1)

    // Note: iOS SWheels render text in rectangular panes — no circular border.
    // The window + QRect system handles visual framing.

    ctx.restore(); // closes outermost ctx.save() / ctx.translate(x, y)
}

function orientationAngle(orientation: string): number {
    switch (orientation.toLowerCase()) {
        case 'twelve': return -Math.PI / 2;
        case 'three': return 0;
        case 'six': return Math.PI / 2;
        case 'nine': return Math.PI;
        default: return -Math.PI / 2;
    }
}

// ============================================================================
// QText — static text label
// ============================================================================

function drawQText(
    ctx: RenderContext,
    part: QTextPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const text = part.text || '';
    if (!text) return;

    const fontSize = evalAttr(part.fontSize, env) || 12;
    const fontName = part.fontName || 'Arial';
    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'rgba(0,0,0,1)';
    const radius = part.radius ? evalAttr(part.radius, env) : 0;

    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = strokeColor;
    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (radius > 0 && part.orientation === 'demi') {
        // Curved text along an arc: each character is placed at a position
        // on a circle of the given radius, centered around startAngle.
        // startAngle: 0 = top (12 o'clock), π = bottom (6 o'clock)
        const startAngle = part.startAngle ? evalAttr(part.startAngle, env) : 0;

        // Measure each character's width to compute angular spans
        const charWidths: number[] = [];
        let totalWidth = 0;
        for (let i = 0; i < text.length; i++) {
            const w = ctx.measureText(text[i]).width;
            charWidths.push(w);
            totalWidth += w;
        }

        // Total angular span of the text along the arc
        const totalAngle = totalWidth / radius;

        // Determine if text is on the bottom half of the dial.
        // Bottom half: characters need π rotation to stay upright,
        // and step counter-clockwise so text reads left-to-right.
        const normalizedAngle = ((startAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const isBottomHalf = normalizedAngle > Math.PI / 2 && normalizedAngle < 3 * Math.PI / 2;

        let currentAngle: number;
        const direction = isBottomHalf ? -1 : 1;

        if (isBottomHalf) {
            // Start from the right end so text reads L-to-R from outside
            currentAngle = startAngle + totalAngle / 2;
        } else {
            // Start from the left end, step clockwise
            currentAngle = startAngle - totalAngle / 2;
        }

        for (let i = 0; i < text.length; i++) {
            const charAngle = charWidths[i] / radius;
            const midAngle = currentAngle + direction * charAngle / 2;

            ctx.save();
            ctx.rotate(midAngle);
            ctx.translate(0, -radius + fontSize / 2);
            if (isBottomHalf) {
                // Flip character so it's right-side up at the bottom
                ctx.rotate(Math.PI);
            }
            ctx.fillText(text[i], 0, 0);
            ctx.restore();

            currentAngle += direction * charAngle;
        }
    } else {
        // Simple flat text (no radius)
        ctx.fillText(text, 0, 0);
    }

    ctx.restore();
}

// ============================================================================
// Image — rendered PNG asset
// ============================================================================

function drawImage(
    ctx: RenderContext,
    part: ImagePart,
    env: Environment,
): void {
    if (!part.src || !currentImages) return;
    const loaded = currentImages.get(part.src);
    if (!loaded) return;

    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const alpha = part.alpha !== undefined ? evalAttr(part.alpha, env) : 1;

    const { bitmap, scale: imgScale } = loaded;
    // Image dimensions in XML coordinate units (1x space)
    const drawW = bitmap.width * imgScale;
    const drawH = bitmap.height * imgScale;

    ctx.save();
    if (alpha < 1) {
        ctx.globalAlpha = alpha;
    }
    // Draw centered at (x, y)
    ctx.drawImage(bitmap, x - drawW / 2, y - drawH / 2, drawW, drawH);
    ctx.restore();
}

/**
 * Draw an image-based hand (QHand with src but no geometric length).
 * Used for items like the moon disc and star indicators that appear in the
 * static cache as images positioned at the hand's (x, y) and rotated by angle.
 */
function drawImageHand(
    ctx: RenderContext,
    part: QHandPart,
    env: Environment,
): void {
    if (!part.src || !currentImages) return;
    const loaded = currentImages.get(part.src);
    if (!loaded) return;

    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y
    const angle = evalAttr(part.angle, env);

    const { bitmap, scale: imgScale } = loaded;
    const drawW = bitmap.width * imgScale;
    const drawH = bitmap.height * imgScale;

    ctx.save();
    ctx.translate(x, y);
    if (angle) {
        ctx.rotate(angle);
    }

    // xAnchor: pivot X position from image's left edge (default: image center)
    // yAnchor: pivot Y offset — image inner edge sits at this radius
    const xAnchor = part.xAnchor ? evalAttr(part.xAnchor, env) : drawW / 2;
    const yAnchor = part.yAnchor ? -evalAttr(part.yAnchor, env) : -drawH / 2;  // Negate Y

    ctx.drawImage(bitmap, -xAnchor, -yAnchor - drawH, drawW, drawH);
    ctx.restore();
}

// ============================================================================
// QRect — colored rectangle
// ============================================================================

function drawQRect(
    ctx: RenderContext,
    part: QRectPart,
    env: Environment,
): void {
    const xCorner = evalAttr(part.x, env);
    const yCorner = evalAttr(part.y, env);
    const w = evalAttr(part.w, env);
    const h = evalAttr(part.h, env);
    if (w <= 0 || h <= 0) return;

    // Original iOS: (x,y) is top-left corner; center = (x+w/2, y+h/2)
    const cx = xCorner + w / 2;
    const cy = -(yCorner + h / 2);  // Negate Y: XML Y-up → Canvas Y-down

    const bgColor = evalColor(part.bgColor, env);

    ctx.save();
    ctx.translate(cx, cy);

    // Centered rect
    if (!isTransparent(bgColor)) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(-w / 2, -h / 2, w, h);
    } else {
        // Default white background for QRect
        ctx.fillStyle = 'white';
        ctx.fillRect(-w / 2, -h / 2, w, h);
    }

    // Pane dividers
    const panes = evalAttr(part.panes, env);
    if (panes > 1) {
        ctx.strokeStyle = 'rgba(0,0,0,0.3)';
        ctx.lineWidth = 0.25;
        for (let p = 1; p < panes; p++) {
            const px = -w / 2 + (w * p) / panes;
            ctx.beginPath();
            ctx.moveTo(px, -h / 2);
            ctx.lineTo(px, h / 2);
            ctx.stroke();
        }
    }

    ctx.restore();
}

// ============================================================================
// Window — clipping region with border
// ============================================================================

function drawWindowBorder(
    ctx: RenderContext,
    part: WindowPart,
    env: Environment,
): void {
    const xVal = evalAttr(part.x, env);
    const yVal = evalAttr(part.y, env);
    const w = evalAttr(part.w, env);
    const h = evalAttr(part.h, env);
    const border = evalAttr(part.border, env);
    const strokeColor = evalColor(part.strokeColor, env);
    const isPorthole = part.windowType === 'porthole';

    if (w <= 0 || h <= 0) return;

    // Porthole: x,y is the center; Rectangular: x,y is the corner
    const cx = isPorthole ? xVal : xVal + w / 2;
    const cy = isPorthole ? -yVal : -(yVal + h / 2);

    ctx.save();
    ctx.translate(cx, cy);

    // Shadow
    const shadowOpacity = evalAttr(part.shadowOpacity, env);
    if (shadowOpacity > 0) {
        const shadowSigma = evalAttr(part.shadowSigma, env) || 1;
        ctx.shadowColor = `rgba(0,0,0,${shadowOpacity})`;
        ctx.shadowBlur = shadowSigma * 2;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = evalAttr(part.shadowOffset, env);
    }

    if (border > 0) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = border;

        if (isPorthole) {
            const r = Math.min(w, h) / 2;
            ctx.beginPath();
            ctx.arc(0, 0, r, 0, 2 * Math.PI);
            ctx.stroke();
        } else {
            ctx.strokeRect(-w / 2, -h / 2, w, h);
        }
    }

    ctx.restore();
}
