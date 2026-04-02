/**
 * Canvas 2D renderer for Chronometer watch parts.
 *
 * Two-phase architecture for 60fps animation:
 *   1. buildStaticCache() — renders all static parts (dials, text, ticks,
 *      images, QRects, windows) to an OffscreenCanvas. Runs once per
 *      mode/date change.
 *   2. renderFrame() — blits the cached static layer, then draws dynamic
 *      parts (hands) on top. Runs every frame via requestAnimationFrame.
 *
 * Window cutouts use Canvas 2D compositing (destination-out) to punch
 * transparent holes through the part that follows them, matching the
 * original iOS rendering pipeline.
 *
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
 * Build an OffscreenCanvas containing all static parts (everything except
 * QHands and Buttons). Window cutouts are applied via compositing.
 *
 * Call this once on init, and again when mode/date/timezone changes.
 */
/**
 * Bezel ring thickness in XML coordinate units.
 * Computed as floor(2/3 * gap) where gap = faceRadius - mainR.
 * For Haleakala: faceRadius=133, mainR=118, gap=15, bezel=10.
 * This constant is exported so the scale calculation in standalone.ts
 * can account for the bezel when sizing the canvas.
 */
export const BEZEL_THICKNESS_XML = 10;

export function buildStaticCache(
    watch: Watch,
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
    images?: Map<string, LoadedImage>,
): OffscreenCanvas {
    currentImages = images;
    const cache = new OffscreenCanvas(canvasWidth, canvasHeight);
    const ctx = cache.getContext('2d')!;

    // Set up coordinate system: origin at center, scale XML units → pixels
    ctx.translate(canvasWidth / 2, canvasHeight / 2);
    ctx.scale(scale, scale);

    // Render static parts with window accumulation
    renderPartsWithWindows(ctx, watch.parts, env, canvasWidth, canvasHeight, scale);

    // Draw bezel ring on top of everything, if the watch specifies one
    if (watch.bezelColor) {
        const faceRadius = watch.faceWidth / 2;
        const outerRadius = faceRadius + BEZEL_THICKNESS_XML;
        ctx.beginPath();
        // Outer circle (clockwise)
        ctx.arc(0, 0, outerRadius, 0, 2 * Math.PI, false);
        // Inner circle (anticlockwise — punches a hole for the face)
        ctx.arc(0, 0, faceRadius, 0, 2 * Math.PI, true);
        ctx.fillStyle = watch.bezelColor;
        ctx.fill('evenodd');

        // Black boundary circle at the bezel/face join
        ctx.beginPath();
        ctx.arc(0, 0, faceRadius, 0, 2 * Math.PI);
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 0.75;
        ctx.stroke();
    }

    return cache;
}

/**
 * Render a single frame: blit the static cache, then draw dynamic hands.
 */
export function renderFrame(
    ctx: CanvasRenderingContext2D,
    staticCache: OffscreenCanvas,
    watch: Watch,
    env: Environment,
    scale: number,
): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // Clear and draw cached static layer
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(staticCache, 0, 0);

    // Draw dynamic parts (hands) on top
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    for (const part of watch.parts) {
        drawDynamicParts(ctx, part, env);
    }
    ctx.restore();
}

/**
 * Legacy single-call API — builds cache and renders in one step.
 * Kept for backward compatibility during transition.
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
    const cache = buildStaticCache(watch, env, w, h, scale, images);
    ctx.drawImage(cache, 0, 0);

    // Draw hands on top
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);
    for (const part of watch.parts) {
        drawDynamicParts(ctx, part, env);
    }
    ctx.restore();
}

// ============================================================================
// Window accumulation + compositing
// ============================================================================

/**
 * Render a list of parts in document order, accumulating windows and
 * applying cutouts to the next drawable part.
 */
function renderPartsWithWindows(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    parts: WatchPart[],
    env: Environment,
    canvasWidth: number,
    canvasHeight: number,
    scale: number,
): void {
    const pendingWindows: WindowPart[] = [];

    for (const part of parts) {
        if (part.type === 'Window') {
            pendingWindows.push(part);
            continue;
        }

        // Skip dynamic parts in static cache
        if (part.type === 'QHand' || part.type === 'Button') {
            continue;
        }

        if (pendingWindows.length > 0) {
            // This part has windows — render to temp canvas, cut holes, composite
            renderWithWindowCutouts(ctx, part, pendingWindows, env, canvasWidth, canvasHeight, scale);
            pendingWindows.length = 0;
        } else {
            // No pending windows — draw directly
            drawStaticPart(ctx, part, env, canvasWidth, canvasHeight, scale);
        }
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
    const xCorner = evalAttr(win.x, env);
    const yCorner = evalAttr(win.y, env);
    const w = evalAttr(win.w, env);
    const h = evalAttr(win.h, env);
    const isPorthole = win.windowType === 'porthole';

    // Center from corner (same as drawWindow/drawQRect)
    const cx = xCorner + w / 2;
    const cy = -(yCorner + h / 2);

    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(0,0,0,1)';

    if (isPorthole) {
        const r = Math.min(w, h) / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.fill();
    } else {
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

/** Walk dynamic parts tree, drawing only QHands. */
function drawDynamicParts(
    ctx: CanvasRenderingContext2D,
    part: WatchPart,
    env: Environment,
): void {
    if (part.type === 'QHand') {
        drawQHand(ctx, part, env);
    } else if (part.type === 'Static') {
        for (const child of part.children) {
            drawDynamicParts(ctx, child, env);
        }
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
    // Static containers can have windows inside them
    renderPartsWithWindows(ctx, part.children, env, canvasWidth, canvasHeight, scale);
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
    switch (marks.toLowerCase()) {
        case 'none': return MARKS_NONE;
        case 'outer': return MARKS_OUTER;
        case 'center': return MARKS_CENTER;
        case 'tickout': return MARKS_TICK_OUT;
        case 'dot': return MARKS_DOT;
        default: return MARKS_NONE;
    }
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
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
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
    drawHandShape(ctx, handType, length, width, tail, strokeColor, fillColor, lineWidth, oTail);

    // Ornament arrowhead (diamond/kite shape at the tip)
    const oLength = evalAttr(part.oLength, env);
    if (oLength > 0) {
        const oWidth = evalAttr(part.oWidth, env);
        const oLineWidth = evalAttr(part.oLineWidth, env) || lineWidth;
        const oStrokeColor = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
        const oFillColor = part.oFillColor ? evalColor(part.oFillColor, env) : fillColor;
        drawHandOrnament(ctx, length, oLength, oWidth, oTail, oLineWidth, oStrokeColor, oFillColor);
    }

    // Tail circle
    const oRadius = evalAttr(part.oRadius, env);
    if (oRadius > 0) {
        const oStrokeColor = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
        const oFillColor = part.oFillColor ? evalColor(part.oFillColor, env) : fillColor;
        drawTailCircle(ctx, tail, oRadius, lineWidth, oStrokeColor, oFillColor);
    }

    // Center dot
    const oCenter = evalAttr(part.oCenter, env);
    if (oCenter > 0) {
        const osc = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
        drawCenterDot(ctx, oCenter, osc);
    }

    ctx.restore();
}

/** Diamond/kite-shaped arrowhead ornament — matches original iOS drawOrnaments */
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
    // Original iOS coords (Y-up) → Canvas (Y-down, hands point in -Y)
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
    ctx.arc(0, tail + 2 * oRadius, oRadius, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
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
): void {
    ctx.beginPath();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;

    if (handType === 'rect') {
        // Rectangle hand: tail to length-oTail, width centered
        // Original: CGRectMake(-width/2, length2-tail, width, length+tail-oTail)
        const hw = width / 2;
        ctx.rect(-hw, tail, width, -(length + tail - oTail));
    } else {
        // Triangle hand: pointed tip, wide base
        const hw = width / 2;
        ctx.moveTo(0, -length);          // tip
        ctx.lineTo(hw, tail);            // bottom right
        ctx.lineTo(-hw, tail);           // bottom left
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

    // Draw background arc ring
    if (!isTransparent(bgColor)) {
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.arc(0, 0, radius + 2, 0, 2 * Math.PI);
        ctx.fill();
    }

    // Draw labels around the circle
    // In iOS, the offsetAngle uses -i * step, meaning the labels are placed
    // counter-clockwise around the wheel. The wheel rotates clockwise (+angle).
    // This perfectly routes the "unused/future" weekday labels to the LEFT
    // side of the dial, keeping them safely away from the date window on the right.
    
    ctx.save();
    ctx.rotate(angle + angle1);

    for (let i = 0; i < n; i++) {
        const label = labels[i].trim();

        if (label) {
            ctx.fillStyle = strokeColor;
            ctx.save();

            // Position text based on orientation
            // Text rotates with the wheel (top of text faces center),
            // matching iOS ECQHandSpoke rendering. No counter-rotation.
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

            ctx.fillText(label, 0, 0);
            ctx.restore();
        }

        ctx.rotate(-step);
    }

    ctx.restore(); // closes ctx.save() for ctx.rotate(angle + angle1)

    // Border stroke
    if (!isTransparent(bgColor)) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        ctx.stroke();
    }

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

    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = strokeColor;
    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
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
    const xCorner = evalAttr(part.x, env);
    const yCorner = evalAttr(part.y, env);
    const w = evalAttr(part.w, env);
    const h = evalAttr(part.h, env);
    const border = evalAttr(part.border, env);
    const strokeColor = evalColor(part.strokeColor, env);
    const isPorthole = part.windowType === 'porthole';

    if (w <= 0 || h <= 0) return;

    // Original iOS: (x,y) is top-left corner; center = (x+w/2, y+h/2)
    const cx = xCorner + w / 2;
    const cy = -(yCorner + h / 2);  // Negate Y: XML Y-up → Canvas Y-down

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
