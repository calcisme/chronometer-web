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
    QWedgePart,
    QDayNightRingPart,
    CalendarRowCoverPart,
    CalendarHeaderPart,
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
            renderPartsWithWindows(ctx, part.children, env, canvasWidth, canvasHeight, scale, images, terminatorLeaves, true);

            // Draw preceding window borders, THEN cut holes.
            // The cutout erases the inner half of the border stroke,
            // leaving only the outer half visible (matching iOS).
            for (const win of part.precedingWindows) {
                drawWindowBorder(ctx, win, env);
            }
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
    images?: Map<string, LoadedImage>,
    terminatorLeaves?: TerminatorLeafState[],
): void {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, scale);

    renderPartsDocumentOrder(ctx, watch.parts, env, w, h, scale, images, terminatorLeaves);
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
    renderFrame(ctx, watch, env, scale, images);
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
    images?: Map<string, LoadedImage>,
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
            drawQHandsInParts(ctx, part.children, env, images);

            // Preceding window borders are already baked into the static cache
            // (drawn before holes were cut, so only outer half is visible).
            continue;
        }

        if (part.type === 'QHand') {
            // Flush any pending windows as borders only (they don't clip QHands)
            for (const win of pendingWindows) {
                drawWindowBorder(ctx, win, env);
            }
            pendingWindows.length = 0;

            // Terra: draw ring image with city-name knockouts + channel lines
            if (part.name === 'worldtime ring') {
                drawTerraRingWithKnockouts(ctx, part, env, images);
                drawTerraChannelLines(ctx, part, env);
            } else if (part.src && images) {
                drawImageHand(ctx, part, env, images);
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

        if (part.type === 'QDayNightRing') {
            // Flush any pending windows as borders only
            for (const win of pendingWindows) {
                drawWindowBorder(ctx, win, env);
            }
            pendingWindows.length = 0;
            drawQDayNightRing(ctx, part, env);
            continue;
        }

        // Regular drawable part — apply pending window cutouts if any
        if (pendingWindows.length > 0) {
            renderWithWindowCutouts(ctx, part, pendingWindows, env, canvasWidth, canvasHeight, scale, images);
            pendingWindows.length = 0;
        } else {
            drawStaticPart(ctx, part, env, canvasWidth, canvasHeight, scale, images);
        }

        // Terra: draw city dots on top of the continents image
        if (part.name === 'decoration') {
            drawTerraCityDots(ctx, env);
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
    images?: Map<string, LoadedImage>,
): void {
    for (const part of parts) {
        if (part.type === 'QHand') {
            if (part.src && images) {
                drawImageHand(ctx, part, env, images);
            } else {
                drawQHand(ctx, part, env);
            }
        } else if (part.type === 'Static') {
            drawQHandsInParts(ctx, part.children, env, images);
        }
    }
}

/** Draw the bezel ring if the watch specifies one, with a 3D metallic look. */
function drawBezel(ctx: RenderContext, watch: Watch): void {
    if (!watch.bezelColor) return;
    const faceRadius = watch.faceWidth / 2;
    const outerRadius = faceRadius + BEZEL_THICKNESS_XML;

    // Parse the base bezel color to derive highlight/shadow variants
    ctx.save();

    // --- 1. Base bezel band with radial gradient (dark edges, bright centre) ---
    const baseGrad = ctx.createRadialGradient(0, 0, faceRadius, 0, 0, outerRadius);
    // Inner edge: darken for a shadowed lip
    baseGrad.addColorStop(0,    darkenColor(watch.bezelColor, 0.45));
    baseGrad.addColorStop(0.08, darkenColor(watch.bezelColor, 0.65));
    // Main body
    baseGrad.addColorStop(0.25, watch.bezelColor);
    baseGrad.addColorStop(0.50, lightenColor(watch.bezelColor, 1.12));
    baseGrad.addColorStop(0.75, watch.bezelColor);
    // Outer edge: darken for a rolled-over lip
    baseGrad.addColorStop(0.92, darkenColor(watch.bezelColor, 0.70));
    baseGrad.addColorStop(1,    darkenColor(watch.bezelColor, 0.40));

    ctx.beginPath();
    ctx.arc(0, 0, outerRadius, 0, 2 * Math.PI, false);
    ctx.arc(0, 0, faceRadius,  0, 2 * Math.PI, true);
    ctx.fillStyle = baseGrad;
    ctx.fill('evenodd');

    // --- 2. Specular highlight sweep (upper portion, simulated light from above) ---
    ctx.beginPath();
    ctx.arc(0, 0, outerRadius - 0.5, 0, 2 * Math.PI, false);
    ctx.arc(0, 0, faceRadius + 0.5,  0, 2 * Math.PI, true);
    // Linear gradient from top to bottom for directional light
    const highlightGrad = ctx.createLinearGradient(0, -outerRadius, 0, outerRadius);
    highlightGrad.addColorStop(0,    'rgba(255,255,255,0.35)');
    highlightGrad.addColorStop(0.30, 'rgba(255,255,255,0.12)');
    highlightGrad.addColorStop(0.50, 'rgba(0,0,0,0)');
    highlightGrad.addColorStop(0.70, 'rgba(0,0,0,0.08)');
    highlightGrad.addColorStop(1,    'rgba(0,0,0,0.15)');
    ctx.fillStyle = highlightGrad;
    ctx.fill('evenodd');

    // --- 3. Fine inner ring (shadow where bezel meets glass) ---
    ctx.beginPath();
    ctx.arc(0, 0, faceRadius, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 0.6;
    ctx.stroke();


    // --- 4. Fine outer edge highlight ---
    ctx.beginPath();
    ctx.arc(0, 0, outerRadius, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 0.4;
    ctx.stroke();

    // --- 5. Solar noon indicator mark (etched line at 12 o'clock) ---
    if (watch.bezelNoonMark) {
        const markInner = faceRadius;
        const markOuter = faceRadius + BEZEL_THICKNESS_XML * 0.55;
        // Etched groove: dark line + offset highlight
        ctx.beginPath();
        ctx.moveTo(0, -markInner);
        ctx.lineTo(0, -markOuter);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
        // Slight highlight to the right (simulates 3D groove)
        ctx.beginPath();
        ctx.moveTo(0.5, -markInner);
        ctx.lineTo(0.5, -markOuter);
        ctx.strokeStyle = 'rgba(255,255,255,0.2)';
        ctx.lineWidth = 0.3;
        ctx.stroke();
    }

    ctx.restore();
}

/**
 * Parse a CSS color string into [r, g, b] components (0-255).
 * Handles hex (#rgb, #rrggbb), rgb(), and named "silver"/"gray".
 */
function parseColorComponents(color: string): [number, number, number] {
    const c = color.trim().toLowerCase();
    // Hex
    if (c.startsWith('#')) {
        const hex = c.slice(1);
        if (hex.length === 3) {
            return [
                parseInt(hex[0] + hex[0], 16),
                parseInt(hex[1] + hex[1], 16),
                parseInt(hex[2] + hex[2], 16),
            ];
        }
        return [
            parseInt(hex.slice(0, 2), 16),
            parseInt(hex.slice(2, 4), 16),
            parseInt(hex.slice(4, 6), 16),
        ];
    }
    // rgb(r,g,b)
    const m = c.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (m) return [+m[1], +m[2], +m[3]];
    // Fallback: silver
    return [192, 192, 192];
}

/** Darken a CSS color by a factor (0 = black, 1 = unchanged). */
function darkenColor(color: string, factor: number): string {
    const [r, g, b] = parseColorComponents(color);
    return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
}

/** Lighten a CSS color by a factor (1 = unchanged, >1 = lighter). */
function lightenColor(color: string, factor: number): string {
    const [r, g, b] = parseColorComponents(color);
    return `rgb(${Math.min(255, Math.round(r * factor))},${Math.min(255, Math.round(g * factor))},${Math.min(255, Math.round(b * factor))})`;
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
    images?: Map<string, LoadedImage>,
    terminatorLeaves?: TerminatorLeafState[],
    applyTrailingCutouts: boolean = false,
): void {
    const pendingWindows: WindowPart[] = [];
    // Leading windows: windows that appear before any drawable part.
    // These cut through the entire static composite (not just the next part).
    const leadingWindows: WindowPart[] = [];
    let seenDrawable = false;

    for (const part of parts) {
        if (part.type === 'Window') {
            if (!seenDrawable) {
                leadingWindows.push(part);
            } else {
                pendingWindows.push(part);
            }
            continue;
        }

        if (part.type === 'Button') continue;

        // QHand: Image-based hands without anchors (e.g. moon disc) are drawn
        // into the static cache. Everything else is dynamic.
        if (part.type === 'QHand') {
            if (part.src && images && !part.xAnchor && !part.yAnchor) {
                drawImageHand(ctx, part, env, images);
            }
            continue;
        }

        if (part.type === 'Terminator') {
            if (terminatorLeaves && terminatorLeaves.length > 0) {
                drawTerminator(ctx, terminatorLeaves);
            }
            continue;
        }

        seenDrawable = true;

        if (pendingWindows.length > 0) {
            renderWithWindowCutouts(ctx, part, pendingWindows, env, canvasWidth, canvasHeight, scale, images);
            pendingWindows.length = 0;
        } else {
            drawStaticPart(ctx, part, env, canvasWidth, canvasHeight, scale, images);
        }
    }

    // Leftover pending windows (between-part windows with no following part)
    // Draw borders first, then cut holes (inner half of border gets erased).
    for (const win of pendingWindows) {
        drawWindowBorder(ctx, win, env);
    }
    for (const win of pendingWindows) {
        if (applyTrailingCutouts) {
            cutWindowHole(ctx, win, env);
        }
    }

    // Leading windows: draw borders first, then cut holes.
    // The cutout erases the inner half of the border stroke,
    // leaving only the outer half visible (matching iOS).
    for (const win of leadingWindows) {
        drawWindowBorder(ctx, win, env);
    }
    for (const win of leadingWindows) {
        cutWindowHole(ctx, win, env);
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
    images?: Map<string, LoadedImage>,
): void {
    // Create temp canvas for compositing
    const temp = new OffscreenCanvas(canvasWidth, canvasHeight);
    const tctx = temp.getContext('2d')!;

    // Set up same coordinate system as main context
    tctx.translate(canvasWidth / 2, canvasHeight / 2);
    tctx.scale(scale, scale);

    // Draw the part onto the temp canvas
    drawStaticPart(tctx, part, env, canvasWidth, canvasHeight, scale, images);

    // Draw window borders BEFORE cutting holes, so the cutout erases
    // the inner half of the border stroke (matching iOS).
    for (const win of windows) {
        drawWindowBorder(tctx, win, env);
    }

    // Cut window holes using destination-out
    for (const win of windows) {
        cutWindowHole(tctx, win, env);
    }

    // Composite temp canvas onto main context (reset transform first)
    ctx.save();
    ctx.resetTransform();
    ctx.drawImage(temp, 0, 0);
    ctx.restore();
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
    images?: Map<string, LoadedImage>,
): void {
    switch (part.type) {
        case 'Static':
            drawStatic(ctx, part, env, canvasWidth, canvasHeight, scale, images);
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
            drawImage(ctx, part, env, images);
            break;
        case 'QRect':
            drawQRect(ctx, part, env);
            break;
        case 'QWedge':
            drawQWedge(ctx, part, env);
            break;
        case 'QDayNightRing':
            drawQDayNightRing(ctx, part, env);
            break;
        case 'CalendarRowCover':
            drawCalendarRowCover(ctx, part, env);
            break;
        case 'CalendarHeader':
            drawCalendarHeader(ctx, part, env);
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
    images?: Map<string, LoadedImage>,
): void {
    // Static containers can have windows inside them — trailing windows
    // should cut through the entire static composite (e.g. AM/PM porthole).
    renderPartsWithWindows(ctx, part.children, env, canvasWidth, canvasHeight, scale, images, undefined, true);
}

// ============================================================================
// Text positioning helper
// ============================================================================

/**
 * Compute the Y offset for fillText() so that text is vertically centred
 * on the font's em box — replicating what textBaseline='middle' does, but
 * anchored to the more cross-browser-consistent 'alphabetic' baseline.
 *
 * Uses fontBoundingBox metrics (constant for a given font/size) and
 * caches the result per font string to avoid repeated measureText() calls.
 *
 * Requires ctx.textBaseline = 'alphabetic' and ctx.font already set.
 */
const _fontCenterCache = new Map<string, number>();

function textVisualCenterY(ctx: RenderContext, _text: string): number {
    const font = ctx.font;
    let cached = _fontCenterCache.get(font);
    if (cached !== undefined) return cached;
    const m = ctx.measureText('X');  // any character works — fontBoundingBox is per-font
    cached = (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
    _fontCenterCache.set(font, cached);
    return cached;
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
const MARKS_ROSE     = 1 << 5;

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
            case 'rose': result |= MARKS_ROSE; break;
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

    // Rose petals (compass rose pattern)
    if ((marks & MARKS_ROSE) && nMarks > 0) {
        const outerR = radius;
        const innerR = part.radius2 !== undefined ? evalAttr(part.radius2, env) : radius * 0.6;
        const fillColor1 = part.fillColor1 ? evalColor(part.fillColor1, env) : 'rgba(0,0,0,0)';
        const fillColor2 = part.fillColor2 ? evalColor(part.fillColor2, env) : 'rgba(0,0,0,0)';
        const roseStroke = strokeColor;
        const deltaTheta = Math.PI / nMarks;

        for (let i = 0; i < nMarks; i++) {
            const theta = 2 * i * deltaTheta;

            // Left petal: outer → left inner → center inner → outer
            ctx.beginPath();
            ctx.moveTo(outerR * Math.cos(theta), outerR * Math.sin(theta));
            ctx.lineTo(innerR * Math.cos(theta - deltaTheta), innerR * Math.sin(theta - deltaTheta));
            ctx.lineTo(innerR * Math.cos(theta), innerR * Math.sin(theta));
            ctx.closePath();
            if (fillColor1 !== 'rgba(0,0,0,0)') {
                ctx.fillStyle = fillColor1;
                ctx.fill();
            }
            ctx.strokeStyle = roseStroke;
            ctx.lineWidth = markWidth;
            ctx.stroke();

            // Right petal: outer → right inner → center inner → outer
            ctx.beginPath();
            ctx.moveTo(outerR * Math.cos(theta), outerR * Math.sin(theta));
            ctx.lineTo(innerR * Math.cos(theta + deltaTheta), innerR * Math.sin(theta + deltaTheta));
            ctx.lineTo(innerR * Math.cos(theta), innerR * Math.sin(theta));
            ctx.closePath();
            if (fillColor2 !== 'rgba(0,0,0,0)') {
                ctx.fillStyle = fillColor2;
                ctx.fill();
            }
            ctx.strokeStyle = roseStroke;
            ctx.lineWidth = markWidth;
            ctx.stroke();
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
        ctx.textBaseline = 'alphabetic';

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
                ctx.fillText(label, 0, textVisualCenterY(ctx, label));
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
                    ctx.fillText(label, 0, textVisualCenterY(ctx, label));
                } else {
                    // Radial half: text upright along radius
                    // iOS: rect at y = r - s.height → center at r - textH/2
                    const textR = baseR - textH / 2;
                    const tx = textR * Math.cos(th);
                    const ty = textR * Math.sin(th);
                    ctx.translate(tx, ty);
                    ctx.rotate(th + Math.PI / 2);
                    ctx.fillText(label, 0, textVisualCenterY(ctx, label));
                }
                ctx.restore();
            }
        } else if (orientation === 'rotated') {
            // iOS: drawDialRadial(rotated: true)
            // Text is positioned radially — each label points outward from center.
            // iOS first rotates the context by π/2, then places text at
            //   (radius * factor - s.height, -s.width/2) and rotates by -2π/n per label.
            // We replicate by rotating each label's angle by π/2 and drawing text
            // along the radial direction.
            for (let i = 0; i < n; i++) {
                const label = labels[i].trim();
                if (!label) continue;
                // iOS iterates i=0..n-1 and rotates CW by -2π/n each step,
                // starting from a π/2 pre-rotation.
                // Effective angle for label i: π/2 - i * 2π/n (iOS Y-up)
                // In canvas Y-down: -(π/2 - i * 2π/n) = -π/2 + i * 2π/n
                const th = (i / n) * 2 * Math.PI - Math.PI / 2;
                const textH = fontSize;
                const textR = radius * EC_DIAL_RADIUS_FACTOR - textH / 2;
                const tx = textR * Math.cos(th);
                const ty = textR * Math.sin(th);
                ctx.save();
                ctx.translate(tx, ty);
                // Rotate so text reads outward along the radius
                ctx.rotate(th);
                ctx.fillText(label, 0, textVisualCenterY(ctx, label));
                ctx.restore();
            }
        } else {
            // Default: radial text (tangent to circle)
            // Original iOS: drawDialRadial(rotated: false)
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
                ctx.fillText(label, 0, textVisualCenterY(ctx, label));
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

    const handType = part.handType || 'tri';

    // 'spoke' type: text label at offset position (e.g. AM/PM indicators)
    if (handType === 'spoke') {
        const offsetRadius = evalAttr(part.offsetRadius, env);
        const offsetAngle = part.dynamicState
            ? part.dynamicState.currentOffsetAngle ?? evalAttr(part.offsetAngle, env)
            : evalAttr(part.offsetAngle, env);
        const fontSize = evalAttr(part.fontSize, env) || 8;
        const fontName = part.fontName || 'Arial';
        const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'rgba(0,0,0,1)';

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle + offsetAngle);
        ctx.translate(0, -offsetRadius);
        // Counter-rotate text so it stays upright
        ctx.rotate(-(angle + offsetAngle));
        // Small correction: iOS spoke text baseline sits ~1 unit lower
        ctx.translate(0, 1);

        ctx.font = `${fontSize}px ${fontName}`;
        ctx.fillStyle = strokeColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (part.text) {
            ctx.fillText(part.text, 0, 0);
        }

        ctx.restore();
        return;
    }

    if (length <= 0) return;

    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'rgba(0,0,0,1)';
    const fillColor = part.fillColor ? evalColor(part.fillColor, env) : 'rgba(0,0,0,1)';
    const lineWidth = evalAttr(part.lineWidth, env) || 0.5;

    ctx.save();
    ctx.translate(x, y);

    // Apply xMotion/yMotion linear translation (calendar day-indicator wires)
    if (part.dynamicState) {
        const xm = part.dynamicState.currentXMotion ?? 0;
        const ym = part.dynamicState.currentYMotion ?? 0;
        if (xm !== 0 || ym !== 0) {
            ctx.translate(xm, -ym);  // Negate Y: XML Y-up → Canvas Y-down
        }
    }

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
    } else if (handType === 'sun') {
        // iOS ECQHandSun: sun symbol with rays
        // length2 = distance from axis to nearest visible sun point
        // length = distance from axis to furthest visible sun point
        // nRays = number of rays
        const nRays = evalAttr(part.nRays, env) || 8;
        const oCenter2 = evalAttr(part.oCenter, env);

        ctx.lineWidth = lineWidth;
        ctx.strokeStyle = strokeColor;
        ctx.fillStyle = fillColor;

        // iOS: rayRad = (length-length2)/2, raysRad = (length-length2)/3
        // cen = length2 + raysRad (center of the sun disc in the hand's coord system)
        let rayRad = (length - length2) / 2;
        const raysRad = (length - length2) / 3;
        const cen = length2 + raysRad;  // Positive in iOS (Y grows upward)
        const sunCenter = oCenter2 > 0 ? oCenter2 : raysRad / 2;

        // Draw rays: triangular teeth from the sun disc
        ctx.beginPath();
        for (let i = 0; i < nRays; i++) {
            const theta = Math.PI / 2 + 2 * Math.PI * i / nRays;
            
            // iOS math (Y is upward, so larger Y is further outward)
            const farX = rayRad * Math.cos(theta);
            const farYIOS = cen + rayRad * Math.sin(theta);
            const cwX = sunCenter * Math.cos(theta + Math.PI / nRays);
            const cwYIOS = cen + sunCenter * Math.sin(theta + Math.PI / nRays);
            const ccwX = sunCenter * Math.cos(theta - Math.PI / nRays);
            const ccwYIOS = cen + sunCenter * Math.sin(theta - Math.PI / nRays);

            // Canvas math: flip Y because Canvas negative Y is "outward"
            ctx.moveTo(farX, -farYIOS);
            ctx.lineTo(cwX, -cwYIOS);
            ctx.lineTo(ccwX, -ccwYIOS);
            ctx.lineTo(farX, -farYIOS);

            rayRad = raysRad;  // first ray is longer, rest are shorter (matching iOS)
        }
        ctx.fill();
        ctx.stroke();

        // Draw central disc
        ctx.fillStyle = fillColor;
        ctx.strokeStyle = fillColor;
        ctx.beginPath();
        // Negative cen to place the arc center in the outward direction
        ctx.arc(0, -cen, sunCenter, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
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

    if (handType === 'wire') {
        // iOS ECQHandWire: single straight line from length2 to length
        // Offset by -width/2 horizontally (iOS quirk preserved for fidelity)
        const hw = width / 2;
        ctx.moveTo(-hw, -length2);
        ctx.lineTo(-hw, -(length - (oTail < 0 ? oTail : 0)));
        // Wire has no fill, only stroke
        if (strokeColor !== 'rgba(0,0,0,0)') {
            ctx.stroke();
        }
        return;  // Skip generic fill/stroke below
    } else if (handType === 'rect') {
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
    } else if (handType === 'breguet') {
        // Breguet pomme hand — ported from iOS ECQHandBreguet
        // All geometry is in canvas Y-down coords (tip at -length, tail at +tail)
        const widthScaler     = width / (length * 0.16);
        const lengthScaler    = (length - 81) / 10;
        const armWidth        = length * 0.04  * widthScaler;
        const centerRadius    = length * 0.08  * widthScaler;
        const breOuterCenter  = length * 0.71  + lengthScaler;
        const breInnerCenter  = length * 0.725 + lengthScaler * 0.8;
        const breOuterRadius  = length * 0.075 * widthScaler;
        const breInnerRadius  = length * 0.05  * widthScaler;
        const breBase         = breOuterCenter - breOuterRadius;
        const tipBase         = breOuterCenter + breOuterRadius;
        const tipWidth        = length * 0.045 * widthScaler;

        // 1. Filled circle at the hub
        ctx.beginPath();
        ctx.arc(0, 0, centerRadius, 0, 2 * Math.PI);
        if (fillColor !== 'rgba(0,0,0,0)') ctx.fill();
        if (strokeColor !== 'rgba(0,0,0,0)') ctx.stroke();

        // 2. Inner arm trapezoid (narrow stem from hub to pomme)
        ctx.beginPath();
        ctx.moveTo(-armWidth / 2,  -centerRadius);
        ctx.lineTo(-armWidth / 10, -breBase);
        ctx.lineTo( armWidth / 10, -breBase);
        ctx.lineTo( armWidth / 2,  -centerRadius);
        ctx.closePath();
        if (fillColor !== 'rgba(0,0,0,0)') ctx.fill();
        if (strokeColor !== 'rgba(0,0,0,0)') ctx.stroke();

        // 3. Breguet pomme: filled outer circle with inner circle removed (crescent)
        ctx.beginPath();
        ctx.arc(0, -breOuterCenter, breOuterRadius, 0, 2 * Math.PI);
        // Inner circle wound in opposite direction for evenodd cutout
        ctx.moveTo(breInnerRadius, -breInnerCenter);
        ctx.arc(0, -breInnerCenter, breInnerRadius, 0, 2 * Math.PI, true);
        if (fillColor !== 'rgba(0,0,0,0)') ctx.fill('evenodd');
        if (strokeColor !== 'rgba(0,0,0,0)') ctx.stroke();

        // 4. Triangular tip beyond the pomme
        ctx.beginPath();
        ctx.moveTo(-tipWidth / 2, -tipBase);
        ctx.lineTo(0, -length);
        ctx.lineTo( tipWidth / 2, -tipBase);
        ctx.closePath();
        if (fillColor !== 'rgba(0,0,0,0)') ctx.fill();
        if (strokeColor !== 'rgba(0,0,0,0)') ctx.stroke();
        return;  // Skip generic fill/stroke below
    } else {
        // Diamond hand (default 'tri'): matches iOS ECQHandTri
        // 4-point diamond shape:
        //   top point at (0, -(length))
        //   widest at (±width/2, -(length2))
        //   bottom point at (0, -(length2-tail))
        const hw = width / 2;
        if (length2 > 0) {
            ctx.moveTo(-hw, -length2);           // left widest point
            ctx.lineTo(0, -(length - oTail));    // top point
            ctx.lineTo(hw, -length2);            // right widest point
            ctx.lineTo(0, -(length2 - tail));    // bottom point
        } else {
            ctx.moveTo(0, -length);              // tip
            ctx.lineTo(hw, tail);                // bottom right
            ctx.lineTo(-hw, tail);               // bottom left
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
    // Calendar wheels use a completely different rendering path
    if (part.calendar) {
        drawCalendarWheel(ctx, part, env);
        return;
    }

    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const radius = evalAttr(part.radius, env);
    // Use pre-computed animated angle if available, otherwise evaluate expression
    const angle = part.dynamicState
        ? part.dynamicState.currentAngle
        : evalAttr(part.angle, env);
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
    ctx.textBaseline = 'alphabetic';

    // Compute max label dimensions for consistent positioning
    let maxW = 0;
    const metrics = ctx.measureText('Xg');  // measure with descender
    // Use actual measured height for vertical positioning
    const measuredH = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    const maxH = measuredH;
    for (const lab of labels) {
        const m = ctx.measureText(lab.trim());
        maxW = Math.max(maxW, m.width);
    }

    // angle1/angle2 define the arc range (default: full circle)
    const angle1 = part.angle1 ? evalAttr(part.angle1, env) : 0;
    const angle2 = part.angle2 ? evalAttr(part.angle2, env) : 2 * Math.PI;
    const arcSpan = angle2 - angle1;
    const step = arcSpan / n;

    // tradius = text radius (separate from tick/line radius, for QWheel)
    const tradius = part.tradius ? evalAttr(part.tradius, env) : radius;

    // QWheels draw their own circular background; SWheels rely on
    // the QRect behind the window for their background.
    if (part.wheelVariant === 'QWheel' && bgColor !== 'rgba(0,0,0,0)') {
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        ctx.fill();
    }

    // TWheel halfAndHalf: split-color ring background (e.g. 24-hour dial)
    // On the 24-hour worldtime dial, with labels 0,23,22,...,1:
    //   - Midnight (0)  is at the top (12 o'clock)
    //   - 6PM (18)      is at 3 o'clock (index 6, going CW)
    //   - Noon (12)     is at the bottom (6 o'clock)
    //   - 6AM (6)       is at 9 o'clock
    // Night (bgColor=black) should cover the TOP half (6PM through midnight to 6AM)
    // Day (bgColor2=white) should cover the BOTTOM half (6AM through noon to 6PM)
    const halfAndHalf = part.halfAndHalf ? evalAttr(part.halfAndHalf, env) : 0;
    const bgColor2 = part.bgColor2 ? evalColor(part.bgColor2, env) : bgColor;
    // Inner radius of the ring: approximate from font size
    const innerR = radius - fontSize - 2;
    if (part.wheelVariant === 'TWheel' && halfAndHalf) {
        ctx.save();
        ctx.rotate(angle);
        // Night half (top): arc from left (π) CW through top to right (2π/0)
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.arc(0, 0, radius, Math.PI, 2 * Math.PI);
        ctx.arc(0, 0, innerR, 2 * Math.PI, Math.PI, true); // inner arc, reverse
        ctx.closePath();
        ctx.fill();
        // Day half (bottom): arc from right (0) CW through bottom to left (π)
        ctx.fillStyle = bgColor2;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI);
        ctx.arc(0, 0, innerR, Math.PI, 0, true); // inner arc, reverse
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    } else if (part.wheelVariant === 'TWheel' && bgColor !== 'rgba(0,0,0,0)') {
        ctx.fillStyle = bgColor;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        ctx.arc(0, 0, innerR, 0, 2 * Math.PI, true);
        ctx.fill('evenodd');
    }

    // TWheel tick marks — short marks at the outer edge, with dots on hours
    if (part.wheelVariant === 'TWheel' && part.ticks) {
        const ticksPerLabel = Math.round(evalAttr(part.ticks, env) || 0);
        const nTotalTicks = ticksPerLabel * n;
        const tw = part.tickWidth ? evalAttr(part.tickWidth, env) : 0.5;
        if (nTotalTicks > 0) {
            ctx.save();
            ctx.rotate(angle);
            const tickLen = 2;
            for (let ti = 0; ti < nTotalTicks; ti++) {
                const theta = (ti / nTotalTicks) * 2 * Math.PI;
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);
                if (ti % ticksPerLabel === 0) {
                    // Hour mark: small filled dot
                    // Determine if this position is on night (black bg) or day (white bg)
                    // to pick a contrasting color for the dot
                    const norm = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                    const onNightHalf = norm >= Math.PI;
                    ctx.fillStyle = onNightHalf ? strokeColor : evalColor(part.bgColor, env);
                    ctx.beginPath();
                    ctx.arc(cosT * (radius - 1.5), sinT * (radius - 1.5), 1.2, 0, 2 * Math.PI);
                    ctx.fill();
                } else {
                    // Regular tick mark — use contrast color for visibility
                    const norm = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
                    const onNightHalf = norm >= Math.PI;
                    ctx.strokeStyle = halfAndHalf
                        ? (onNightHalf ? strokeColor : evalColor(part.bgColor, env))
                        : strokeColor;
                    ctx.lineWidth = tw;
                    ctx.beginPath();
                    ctx.moveTo(cosT * radius, sinT * radius);
                    ctx.lineTo(cosT * (radius - tickLen), sinT * (radius - tickLen));
                    ctx.stroke();
                }
            }
            ctx.restore();
        }
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
            // For halfAndHalf TWheels, determine which half this label is in
            // and set the contrast color accordingly.
            // Night (bgColor=black) is the TOP half, Day (bgColor2=white) is BOTTOM.
            // Labels are placed starting from twelve orientation, rotating CW by -step each.
            // Label i is at angular position -i * step in the rotated frame.
            if (halfAndHalf) {
                // iOS uses kCGBlendModeDifference for text on halfAndHalf dials.
                // This automatically makes text contrast with the background:
                // white text with 'difference' blend → appears white on black, black on white.
                ctx.fillStyle = 'white';
                ctx.globalCompositeOperation = 'difference';
            } else {
                ctx.fillStyle = strokeColor;
            }
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

            ctx.fillText(label, 0, textVisualCenterY(ctx, label));
            ctx.restore();
        }

        ctx.rotate(isPartialArc ? step : -step);
    }

    ctx.restore(); // closes ctx.save() for ctx.rotate(angle + angle1)

    // Draw tick marks for QWheel (e.g. tick288, tick96)
    if (part.tick && part.wheelVariant === 'QWheel') {
        const tickMatch = part.tick.match(/tick(\d+)/);
        if (tickMatch) {
            const nTicks = parseInt(tickMatch[1], 10);
            const tickOuter = radius; // outer edge of the dial
            const tickGap = radius - tradius; // distance from outer edge to text
            // Tick lengths from the outer edge inward
            const tickLenLarge = tickGap - 2;  // hour marks: almost to the text
            const tickLenMedium = tickGap * 0.55; // 30-min marks
            const tickLenSmall = tickGap * 0.30;  // 5-min marks

            const ticksPerHour = nTicks / 24;
            const ticksPer30Min = ticksPerHour / 2;

            ctx.save();
            ctx.rotate(angle);
            ctx.strokeStyle = strokeColor;

            for (let i = 0; i < nTicks; i++) {
                const th = (i / nTicks) * 2 * Math.PI - Math.PI / 2;
                const cosT = Math.cos(th);
                const sinT = Math.sin(th);

                let tickLen: number;
                let lw: number;
                if (i % ticksPerHour === 0) {
                    // Hour mark
                    tickLen = tickLenLarge;
                    lw = 0.7;
                } else if (i % ticksPer30Min === 0) {
                    // 30-minute mark
                    tickLen = tickLenMedium;
                    lw = 0.5;
                } else {
                    // 5-minute mark
                    tickLen = tickLenSmall;
                    lw = 0.3;
                }

                ctx.beginPath();
                ctx.moveTo(cosT * tickOuter, sinT * tickOuter);
                ctx.lineTo(cosT * (tickOuter - tickLen), sinT * (tickOuter - tickLen));
                ctx.lineWidth = lw;
                ctx.stroke();
            }
            ctx.restore();
        }
    }

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
    ctx.textBaseline = 'alphabetic';

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

        // Compute consistent vertical offset from the full string so all
        // characters share the same baseline (not individually centred).
        const yOff = textVisualCenterY(ctx, text);

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
            ctx.fillText(text[i], 0, yOff);
            ctx.restore();

            currentAngle += direction * charAngle;
        }
    } else {
        // Simple flat text (no radius)
        ctx.fillText(text, 0, textVisualCenterY(ctx, text));
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
    images?: Map<string, LoadedImage>,
): void {
    if (!part.src || !images) return;
    const loaded = images.get(part.src);
    if (!loaded) return;

    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const alpha = part.alpha !== undefined ? evalAttr(part.alpha, env) : 1;

    const { bitmap, scale: imgScale } = loaded;
    // xmlScale: optional per-element scale from the XML attribute (e.g. scale='0.5')
    const xmlScale = part.scale ? evalAttr(part.scale, env) : 1;
    // Image dimensions in XML coordinate units (1x space)
    const drawW = bitmap.width * imgScale * xmlScale;
    const drawH = bitmap.height * imgScale * xmlScale;

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
    images?: Map<string, LoadedImage>,
): void {
    if (!part.src || !images) return;
    const loaded = images.get(part.src);
    if (!loaded) return;

    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y
    // Use pre-computed animated angle if available, otherwise evaluate expression
    const angle = part.dynamicState
        ? part.dynamicState.currentAngle
        : evalAttr(part.angle, env);
    const offsetRadius = evalAttr(part.offsetRadius, env);
    // Use pre-computed animated offsetAngle if available (keeps in sync with animated angle)
    const offsetAngle = (part.dynamicState && part.dynamicState.currentOffsetAngle !== undefined)
        ? part.dynamicState.currentOffsetAngle
        : evalAttr(part.offsetAngle, env);

    const { bitmap, scale: imgScale } = loaded;
    const drawW = bitmap.width * imgScale;
    const drawH = bitmap.height * imgScale;

    ctx.save();
    ctx.translate(x, y);

    if (offsetRadius > 0) {
        // iOS ECGLPart.m behavior:
        // 1. Position is at (offsetRadius, offsetAngle) — polar coordinates
        // 2. The image is rotated by (offsetAngle + angle) around its anchor point
        //    For most hands, anchor is at image center so rotation is purely visual.
        //    For the Moon (yAnchor=23 vs 10), the off-center anchor creates an
        //    orbital displacement when rotated, making it orbit around Earth.
        const xAnchor = part.xAnchor ? evalAttr(part.xAnchor, env) : drawW / 2;
        // iOS CG has Y-up (anchor from bottom), Canvas has Y-down.
        // Match the non-offset branch convention: negate and subtract drawH.
        const yAnchor = part.yAnchor ? -evalAttr(part.yAnchor, env) : -drawH / 2;

        // Translate to the offset position on the orbit circle
        ctx.rotate(offsetAngle);
        ctx.translate(0, -offsetRadius);

        // Rotate the image around its anchor point.
        // The coordinate system is already rotated by offsetAngle from above,
        // so apply only `angle` here to get the iOS total of (offsetAngle + angle).
        ctx.rotate(angle);
        ctx.drawImage(bitmap, -xAnchor, -yAnchor - drawH, drawW, drawH);
    } else if (part.xAnchor || part.yAnchor) {
        // Standard anchored image hand (rotating around pivot)
        if (angle) {
            ctx.rotate(angle);
        }
        const xAnchor = part.xAnchor ? evalAttr(part.xAnchor, env) : drawW / 2;
        const yAnchor = part.yAnchor ? -evalAttr(part.yAnchor, env) : -drawH / 2;  // Negate Y
        ctx.drawImage(bitmap, -xAnchor, -yAnchor - drawH, drawW, drawH);
    } else {
        // Simple centered image (no anchor, no offset)
        if (angle) {
            ctx.rotate(angle);
        }
        ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);
    }

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
// QWedge — annular sector (pie-slice of a ring)
// ============================================================================

function drawQWedge(
    ctx: RenderContext,
    part: QWedgePart,
    env: Environment,
): void {
    const cx = evalAttr(part.x, env);
    const cy = -evalAttr(part.y, env);  // Y-flip
    const outerR = evalAttr(part.outerRadius, env);
    const innerR = evalAttr(part.innerRadius, env);
    const span = evalAttr(part.angleSpan, env);
    const angle = part.dynamicState
        ? part.dynamicState.currentAngle
        : evalAttr(part.angle, env);
    if (outerR <= 0 || innerR <= 0 || span <= 0) return;

    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'black';
    const fillColor = part.fillColor ? evalColor(part.fillColor, env) : 'transparent';

    ctx.save();
    ctx.translate(cx, cy);

    // Apply polar offset if present (e.g. Terra date wedges orbiting the ring)
    // iOS ECGLPart.m: angleValue = offsetAngleValue + partAngle
    // The offset both translates the center and contributes to the rotation.
    let totalAngle = angle;
    if (part.offsetRadius && part.offsetAngle) {
        const offR = evalAttr(part.offsetRadius, env);
        const offA = part.dynamicState?.currentOffsetAngle !== undefined
            ? part.dynamicState.currentOffsetAngle
            : evalAttr(part.offsetAngle, env);
        ctx.translate(offR * Math.sin(offA), -offR * Math.cos(offA));
        totalAngle = offA + angle;
    }

    // Rotate by total angle (offsetAngle + partAngle)
    ctx.rotate(totalAngle);

    // Draw annular sector path centred on -PI/2 (12 o'clock)
    const startAngle = -Math.PI / 2 - span / 2;
    const endAngle = -Math.PI / 2 + span / 2;

    ctx.beginPath();
    ctx.arc(0, 0, outerR, startAngle, endAngle);
    ctx.arc(0, 0, innerR, endAngle, startAngle, true);
    ctx.closePath();

    if (!isTransparent(fillColor)) {
        ctx.fillStyle = fillColor;
        ctx.fill();
    }
    if (!isTransparent(strokeColor)) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 0.3;
        ctx.stroke();
    }

    ctx.restore();
}

// ============================================================================
// QDayNightRing — daylight/nighttime wedges on a 24-hour dial
// ============================================================================

function drawQDayNightRing(
    ctx: RenderContext,
    part: QDayNightRingPart,
    env: Environment,
): void {
    const cx = evalAttr(part.x, env);
    const cy = -evalAttr(part.y, env);  // Y-flip
    const outerR = evalAttr(part.outerRadius, env);
    const innerR = evalAttr(part.innerRadius, env);
    const numWedges = evalAttr(part.numWedges, env) || 24;
    const planetNumber = evalAttr(part.planetNumber, env);
    const masterOffset = evalAttr(part.masterOffset, env);
    if (outerR <= 0 || innerR <= 0) return;

    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'black';
    const fillColor = part.fillColor ? evalColor(part.fillColor, env) : 'white';

    // Each wedge spans a bit more than 2PI/numWedges so they overlap slightly (matching iOS)
    const wedgeSpan = (2 * Math.PI + 0.2) / numWedges;

    // Select the leaf angle function based on time base and envSlot
    const slotNumber = part.envSlot ? evalAttr(part.envSlot, env) : undefined;
    let leafAngleFn: ((planetNumber: number, leafNumber: number, numLeaves: number) => number) | undefined;

    if (slotNumber != null && !isNaN(slotNumber)) {
        // Route through slot's city lat/lon for astronomy
        const slotFn = env.functions.get('dayNightLeafAngleForSlot') as
            ((p: number, l: number, n: number, s: number) => number) | undefined;
        if (slotFn) {
            leafAngleFn = (p, l, n) => slotFn(p, l, n, slotNumber);
        }
    }
    if (!leafAngleFn) {
        const fnName = part.timeBase === 'LST' ? 'dayNightLeafAngleLST' : 'dayNightLeafAngle';
        leafAngleFn = env.functions.get(fnName) as
            ((planetNumber: number, leafNumber: number, numLeaves: number) => number) | undefined;
    }
    if (!leafAngleFn) return;

    ctx.save();
    ctx.translate(cx, cy);

    for (let i = 0; i < numWedges; i++) {
        // Compute the leaf angle for this wedge
        const leafAngle = leafAngleFn(planetNumber, i, numWedges);
        const angle = masterOffset + leafAngle;

        ctx.save();
        ctx.rotate(angle);

        // Draw annular sector centred on -PI/2 (12 o'clock)
        const startAngle = -Math.PI / 2 - wedgeSpan / 2;
        const endAngle = -Math.PI / 2 + wedgeSpan / 2;

        ctx.beginPath();
        ctx.arc(0, 0, outerR, startAngle, endAngle);
        ctx.arc(0, 0, innerR, endAngle, startAngle, true);
        ctx.closePath();

        if (!isTransparent(fillColor)) {
            ctx.fillStyle = fillColor;
            ctx.fill();
        }
        if (!isTransparent(strokeColor)) {
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = (fillColor === 'rgba(0,0,0,0)') ? 0.5 : 0.3;
            ctx.stroke();
        }

        ctx.restore();
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

// ============================================================================
// Terra I — Dynamic city name overlay on the worldtime ring
// ============================================================================

/**
 * Draw the worldtime ring image with city-name knockouts.
 *
 * Uses a cached OffscreenCanvas containing the ring background image with
 * text-shaped transparent holes punched through it. Through the holes, the
 * underlying black city-background ring and date-indicator wedges show through:
 * - Same-date cities appear black (the city backg QDial)
 * - Ahead-of-date cities appear teal/green (moreW wedge)
 * - Behind-date cities appear dark red (lessW wedge)
 *
 * The cache is built once (text is fixed relative to the ring image) and
 * drawn each frame with the ring's rotation angle applied.
 */
function drawTerraRingWithKnockouts(
    ctx: RenderContext,
    part: QHandPart,
    env: Environment,
    images?: Map<string, LoadedImage>,
): void {
    const terraSlots = (env as any)._terraSlots as Record<number, { cityName: string }> | undefined;
    if (!terraSlots || !images || !part.src) return;

    const loaded = images.get(part.src);
    if (!loaded) return;

    const angle = part.dynamicState
        ? part.dynamicState.currentAngle
        : evalAttr(part.angle, env);

    // Get or build the knockout cache
    let cache = (env as any)._terraCityKnockout as OffscreenCanvas | undefined;
    if (!cache) {
        cache = buildTerraRingKnockoutCache(loaded, terraSlots);
        (env as any)._terraCityKnockout = cache;
    }

    // Draw the cached knockout at the ring's current rotation
    const { scale: imgScale } = loaded;
    const drawW = cache.width * imgScale;
    const drawH = cache.height * imgScale;

    ctx.save();
    ctx.rotate(angle);
    ctx.drawImage(cache, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
}

/**
 * Build the knockout cache: ring background image with text-shaped
 * transparent holes punched through it. Called once and cached.
 *
 * Works at the ring image's native pixel resolution for maximum sharpness.
 */
function buildTerraRingKnockoutCache(
    loaded: LoadedImage,
    terraSlots: Record<number, { cityName: string }>,
): OffscreenCanvas {
    const { bitmap, scale: imgScale } = loaded;
    const w = bitmap.width;
    const h = bitmap.height;

    const offscreen = new OffscreenCanvas(w, h);
    const oCtx = offscreen.getContext('2d')!;

    // 1) Draw the ring background image at native resolution
    oCtx.drawImage(bitmap, 0, 0);

    // 2) Set up centered XML-like coordinates for text placement.
    //    The image is drawn centered during rendering, so (w/2, h/2) maps
    //    to (0,0) in XML space. imgScale converts XML units to image pixels.
    oCtx.translate(w / 2, h / 2);
    const xmlToPixel = 1 / imgScale;  // how many image pixels per XML unit
    oCtx.scale(xmlToPixel, xmlToPixel);

    // 3) Punch out text-shaped holes using destination-out
    oCtx.globalCompositeOperation = 'destination-out';

    const cityFS = 8;
    const cityRad2 = 131;            // outer track text center
    const cityRad1 = 127 - cityFS;   // inner track text center = 119
    const sectorAngle = Math.PI / 12; // 15° per slot

    oCtx.font = `${cityFS}px Arial`;
    oCtx.fillStyle = 'white';  // color irrelevant for destination-out; only alpha matters
    oCtx.textAlign = 'center';
    oCtx.textBaseline = 'middle';

    for (let i = 0; i < 24; i++) {
        const slot = terraSlots[i + 1]; // ring slots are 1–24
        if (!slot) continue;

        const slotCenterAngle = i * sectorAngle;
        const radius = (i % 2 === 0) ? cityRad1 : cityRad2;
        const name = slot.cityName;

        // Measure each character and compute total angular span
        const charWidths: number[] = [];
        let totalWidth = 0;
        for (let c = 0; c < name.length; c++) {
            const cw = oCtx.measureText(name[c]).width;
            charWidths.push(cw);
            totalWidth += cw;
        }
        const totalAngleSpan = totalWidth / radius;

        // Center the name on the slot's angular position
        let charAngle = slotCenterAngle - totalAngleSpan / 2;

        for (let c = 0; c < name.length; c++) {
            const charAngularWidth = charWidths[c] / radius;
            const charCenterAngle = charAngle + charAngularWidth / 2;

            oCtx.save();
            oCtx.rotate(charCenterAngle);
            oCtx.translate(0, -radius);
            oCtx.fillText(name[c], 0, 0);
            oCtx.restore();

            charAngle += charAngularWidth;
        }
    }

    oCtx.globalCompositeOperation = 'source-over';
    return offscreen;
}

// ============================================================================
// Terra I — Channel lines (DST range arcs) on the worldtime ring
// ============================================================================

/**
 * Draw channel arc lines on the worldtime ring showing the range
 * each city's DST dot can occupy.  Matches iOS ECPartSpecialWorldtimeRing.
 *
 * For cities with DST, draws a solid arc spanning the low–high offset range.
 * For cities without DST, draws a dashed 1-sector arc at half opacity.
 *
 * Calls env._getDSTRange(slotNum) which uses the proven getTzOffsetSeconds
 * from watch-env.ts, evaluated at call time (no precomputation).
 */
function drawTerraChannelLines(
    ctx: RenderContext,
    part: QHandPart,
    env: Environment,
): void {
    const terraSlots = (env as any)._terraSlots as Record<number, { cityName: string }> | undefined;
    if (!terraSlots) { console.log('[Terra] No terraSlots'); return; }
    const getDSTRange = (env as any)._getDSTRange as ((slot: number) => { lowHours: number; highHours: number } | null) | undefined;
    if (!getDSTRange) { console.log('[Terra] No getDSTRange function'); return; }

    const angle = part.dynamicState
        ? part.dynamicState.currentAngle
        : evalAttr(part.angle, env);

    // Channel radii matching iOS: channelRad1=111.5, channelRad2=126 (at 1x)
    const channelRad1 = 112;
    const channelRad2 = 125.5;
    const channelWidth = 0.25;

    ctx.save();
    ctx.rotate(angle);
    ctx.lineWidth = channelWidth;
    ctx.strokeStyle = 'black';

    for (let i = 0; i < 24; i++) {
        const slot = terraSlots[i + 1];
        if (!slot) continue;

        const channelR = (i % 2 === 0) ? channelRad1 : channelRad2;
        const slotNum = i + 1;
        const dstRange = getDSTRange(slotNum);

        if (dstRange) {
            // Solid arc showing DST offset range.
            // The -6 sector offset converts from text coords (12 o'clock = 0)
            // to arc coords (3 o'clock = 0).
            const startAngle = (4.5 + dstRange.lowHours) * Math.PI / 12;
            const endAngle = (4.5 + dstRange.highHours) * Math.PI / 12;
            ctx.globalAlpha = 1;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(0, 0, channelR, startAngle, endAngle, false);
            ctx.stroke();
        } else {
            // Dashed 1-sector arc centered on the city's sector position.
            // Same -6 sector offset for text-to-arc coordinate conversion.
            const startAngle = (i - 6.5) * Math.PI / 12;
            const endAngle = (i - 5.5) * Math.PI / 12;
            ctx.globalAlpha = 1;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.arc(0, 0, channelR, startAngle, endAngle, false);
            ctx.stroke();
        }
    }

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.restore();
}

// ============================================================================
// Terra I — City dots on the world map (Robinson projection)
// ============================================================================

// Robinson projection coefficients (from iOS ECMapProjection.m)
interface RobinsonCoefs { c0: number; c1: number; c2: number; c3: number }

const robX: RobinsonCoefs[] = [
    {c0:1, c1:-5.67239e-12, c2:-7.15511e-05, c3:3.11028e-06},
    {c0:0.9986, c1:-0.000482241, c2:-2.4897e-05, c3:-1.33094e-06},
    {c0:0.9954, c1:-0.000831031, c2:-4.4861e-05, c3:-9.86588e-07},
    {c0:0.99, c1:-0.00135363, c2:-5.96598e-05, c3:3.67749e-06},
    {c0:0.9822, c1:-0.00167442, c2:-4.4975e-06, c3:-5.72394e-06},
    {c0:0.973, c1:-0.00214869, c2:-9.03565e-05, c3:1.88767e-08},
    {c0:0.96, c1:-0.00305084, c2:-9.00732e-05, c3:1.64869e-06},
    {c0:0.9427, c1:-0.00382792, c2:-6.53428e-05, c3:-2.61493e-06},
    {c0:0.9216, c1:-0.00467747, c2:-0.000104566, c3:4.8122e-06},
    {c0:0.8962, c1:-0.00536222, c2:-3.23834e-05, c3:-5.43445e-06},
    {c0:0.8679, c1:-0.00609364, c2:-0.0001139, c3:3.32521e-06},
    {c0:0.835, c1:-0.00698325, c2:-6.40219e-05, c3:9.34582e-07},
    {c0:0.7986, c1:-0.00755337, c2:-5.00038e-05, c3:9.35532e-07},
    {c0:0.7597, c1:-0.00798325, c2:-3.59716e-05, c3:-2.27604e-06},
    {c0:0.7186, c1:-0.00851366, c2:-7.0112e-05, c3:-8.63072e-06},
    {c0:0.6732, c1:-0.00986209, c2:-0.000199572, c3:1.91978e-05},
    {c0:0.6213, c1:-0.010418, c2:8.83948e-05, c3:6.24031e-06},
    {c0:0.5722, c1:-0.00906601, c2:0.000181999, c3:6.24033e-06},
    {c0:0.5322, c1:0, c2:0, c3:0},
];
const robY: RobinsonCoefs[] = [
    {c0:0, c1:0.0124, c2:3.72529e-10, c3:1.15484e-09},
    {c0:0.062, c1:0.0124001, c2:1.76951e-08, c3:-5.92321e-09},
    {c0:0.124, c1:0.0123998, c2:-7.09668e-08, c3:2.25753e-08},
    {c0:0.186, c1:0.0124008, c2:2.66917e-07, c3:-8.44523e-08},
    {c0:0.248, c1:0.0123971, c2:-9.99682e-07, c3:3.15569e-07},
    {c0:0.31, c1:0.0124108, c2:3.73349e-06, c3:-1.1779e-06},
    {c0:0.372, c1:0.0123598, c2:-1.3935e-05, c3:4.39588e-06},
    {c0:0.434, c1:0.0125501, c2:5.20034e-05, c3:-1.00051e-05},
    {c0:0.4968, c1:0.0123198, c2:-9.80735e-05, c3:9.22397e-06},
    {c0:0.5571, c1:0.0120308, c2:4.02857e-05, c3:-5.2901e-06},
    {c0:0.6176, c1:0.0120369, c2:-3.90662e-05, c3:7.36117e-07},
    {c0:0.6769, c1:0.0117015, c2:-2.80246e-05, c3:-8.54283e-07},
    {c0:0.7346, c1:0.0113572, c2:-4.08389e-05, c3:-5.18524e-07},
    {c0:0.7903, c1:0.0109099, c2:-4.86169e-05, c3:-1.0718e-06},
    {c0:0.8435, c1:0.0103433, c2:-6.46934e-05, c3:5.36384e-09},
    {c0:0.8936, c1:0.00969679, c2:-6.46129e-05, c3:-8.54894e-06},
    {c0:0.9394, c1:0.00840949, c2:-0.000192847, c3:-4.21023e-06},
    {c0:0.9761, c1:0.00616525, c2:-0.000256001, c3:-4.21021e-06},
    {c0:1, c1:0, c2:0, c3:0},
];

const ROB_FXC = 0.8487;
const ROB_FYC = 1.3523;
const ROB_C1 = 11.45915590261646417544;
const ROB_RC1 = 0.08726646259971647884;
const ROB_NODES = 18;
const ROB_RFUDGE = 1.17;

function robV(c: RobinsonCoefs, z: number): number {
    return c.c0 + z * (c.c1 + z * (c.c2 + z * c.c3));
}

function forwardRobinson(latDeg: number, lngDeg: number): { x: number; y: number } {
    const latRad = latDeg * Math.PI / 180;
    const dphi0 = Math.abs(latRad);
    let i = Math.floor(dphi0 * ROB_C1);
    if (i >= ROB_NODES) i = ROB_NODES - 1;
    const dphi = (180 / Math.PI) * (dphi0 - ROB_RC1 * i);
    const x = ROB_RFUDGE * robV(robX[i], dphi) * ROB_FXC * lngDeg;
    let y = ROB_RFUDGE * robV(robY[i], dphi) * ROB_FYC * (180 / Math.PI);
    if (latDeg < 0) y = -y;
    return { x, y };
}

/**
 * Draw small blue dots on the continent map image for each city.
 * Uses Robinson projection to convert lat/lon to map coordinates.
 *
 * The continents-4x.png image is 720×365 pixels at 4x resolution,
 * which is 180×91.25 face units at 1x.  Following the iOS approach,
 * the Robinson output is scaled by (imageWidth/360, imageHeight/180).
 */
function drawTerraCityDots(
    ctx: RenderContext,
    env: Environment,
): void {
    const terraSlots = (env as any)._terraSlots as Record<number, { cityName: string; olsonId: string; lat: number; lon: number }> | undefined;
    if (!terraSlots) return;

    // Continents image: 720×365 at 4x = 180×91.25 at 1x face coords.
    // iOS scales by mapWidthPixels/360 and mapHeightPixels/180.
    const mapWidth = 180;      // 720 / 4
    const mapHeight = 91.25;   // 365 / 4
    const xScale = mapWidth / 360;    // 0.5 face-units per Robinson-degree
    const yScale = mapHeight / 180;   // ~0.507 face-units per Robinson-degree

    ctx.save();
    ctx.fillStyle = 'blue';

    for (let slotNum = 1; slotNum <= 24; slotNum++) {
        const slot = terraSlots[slotNum];
        if (!slot) continue;

        const proj = forwardRobinson(slot.lat, slot.lon);
        const px = proj.x * xScale;
        const py = -proj.y * yScale;  // canvas Y is inverted vs lat

        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, 2 * Math.PI);
        ctx.fill();
    }

    ctx.restore();
}

// ============================================================================
// Calendar Wheel — Babylon-style monthly day-number grid
// ============================================================================

/**
 * A calendar SWheel has 4 quadrants (90° apart), each showing a month grid
 * for a different starting-column configuration. The wheel's angle selects
 * which quadrant is visible through the calendar window.
 *
 * calendarWheel3456: quadrants for first-of-month starting in columns 3,4,5,6
 * calendarWheel012B: quadrants for columns 0,1,2, and a blank cutout
 * calendarWheelOct1582: Oct 1582 (Gregorian switchover) + cutout
 */
function drawCalendarWheel(
    ctx: RenderContext,
    part: WheelPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);
    const radius = evalAttr(part.radius, env);
    const angle = part.dynamicState
        ? part.dynamicState.currentAngle
        : evalAttr(part.angle, env);

    const fontSize = evalAttr(part.fontSize, env) || 8;
    const fontName = part.fontName || 'Arial';
    const bgColor = evalColor(part.bgColor, env);
    const weekendColor = part.calendarWeekendColor
        ? evalColor(part.calendarWeekendColor, env)
        : 'rgba(0,0,255,1)';
    const weekdayColor = 'rgba(0,0,0,1)';

    // Read calendarWeekdayStart from env
    const calendarWeekdayStart = env.functions.get('calendarWeekdayStart')?.() ?? 0;

    // Cell dimensions from XML init vars
    const cellWidth = env.variables.get('calendarCellWidth') ?? 13.3;
    const cellHeight = env.variables.get('calendarCellHeight') ?? 11;
    const calHeight = env.variables.get('calendarHeight') ?? 66;
    const calWidth = env.variables.get('calendarWidth') ?? 96;

    // Weekend column indices (relative to calendarWeekdayStart)
    const satCol = (6 - calendarWeekdayStart + 7) % 7;
    const sunCol = (7 - calendarWeekdayStart) % 7;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Determine which quadrants to draw based on calendar type
    const calType = part.calendar || '';

    // Each quadrant is drawn at 0°, 90°, 180°, 270° (i.e. offset by i*π/2)
    // The active one is whichever the wheel's angle brings to 0°
    const quadrants = getCalendarQuadrants(calType, calendarWeekdayStart);

    for (let qi = 0; qi < quadrants.length; qi++) {
        const q = quadrants[qi];
        if (q.blank) continue;  // Cutout quadrant — just leave empty

        ctx.save();
        ctx.rotate(-qi * Math.PI / 2);
        // Position at the top of the wheel (twelve orientation)
        ctx.translate(0, -(radius - calHeight / 2));

        // Draw background — skip cells before the 1st in row 0 so covers show through
        ctx.fillStyle = bgColor;
        if (q.startColumn > 0) {
            // Row 0: only fill from startColumn to end
            const firstCellX = -calWidth / 2 + q.startColumn * cellWidth;
            ctx.fillRect(firstCellX, -calHeight / 2 - 1, calWidth / 2 - firstCellX + calWidth / 2, cellHeight + 2);
            // Rows 1+: full width
            ctx.fillRect(-calWidth / 2, -calHeight / 2 - 1 + cellHeight + 2, calWidth, calHeight - cellHeight);
        } else {
            ctx.fillRect(-calWidth / 2, -calHeight / 2 - 1, calWidth, calHeight + 2);
        }

        // Draw day numbers
        ctx.font = `${fontSize}px "${fontName}"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';

        let dayNumber = 1;
        const maxDay = q.isOct1582 ? 31 : 31;  // always 31 slots; unused ones just won't draw
        let startCol = q.startColumn;

        for (let row = 0; dayNumber <= maxDay && row < 6; row++) {
            for (let col = 0; col < 7 && dayNumber <= maxDay; col++) {
                if (row === 0 && col < startCol) continue;  // Skip empty cells before 1st

                const cx = -calWidth / 2 + col * cellWidth + cellWidth / 2 + 1;
                const cy = -calHeight / 2 + row * cellHeight + cellHeight / 2;
                // hack: shift rows slightly (matching iOS)
                const cyAdj = cy - (1 - row / 5.0);

                // Weekend coloring
                ctx.fillStyle = (col === satCol || col === sunCol) ? weekendColor : weekdayColor;

                ctx.fillText(
                    String(dayNumber),
                    cx,
                    cyAdj + textVisualCenterY(ctx, String(dayNumber)),
                );

                dayNumber++;
                // October 1582 hack: skip days 5-14
                if (q.isOct1582 && dayNumber === 5) {
                    dayNumber = 15;
                }
            }
        }

        ctx.restore();
    }

    ctx.restore();
}

interface CalendarQuadrant {
    startColumn: number;
    blank: boolean;
    isOct1582: boolean;
}

function getCalendarQuadrants(calType: string, weekdayStart: number): CalendarQuadrant[] {
    switch (calType) {
        case 'calendarWheel3456':
            return [
                { startColumn: 3, blank: false, isOct1582: false },
                { startColumn: 4, blank: false, isOct1582: false },
                { startColumn: 5, blank: false, isOct1582: false },
                { startColumn: 6, blank: false, isOct1582: false },
            ];
        case 'calendarWheel012B':
            return [
                { startColumn: 0, blank: false, isOct1582: false },
                { startColumn: 1, blank: false, isOct1582: false },
                { startColumn: 2, blank: false, isOct1582: false },
                { startColumn: 0, blank: true,  isOct1582: false },  // cutout
            ];
        case 'calendarWheelOct1582':
            return [
                { startColumn: (8 - weekdayStart) % 7, blank: false, isOct1582: true },
                { startColumn: 0, blank: true, isOct1582: false },  // cutout
                { startColumn: 0, blank: true, isOct1582: false },
                { startColumn: 0, blank: true, isOct1582: false },
            ];
        default:
            return [];
    }
}

// ============================================================================
// CalendarRowCover — covers partial weeks at top/bottom of calendar grid
// ============================================================================

/**
 * Covers unused cells in the first or last row of the calendar grid with
 * previous/next month day numbers (in a muted color).
 *
 * coverType:
 *   row1Left / row1Right: previous-month days before the 1st
 *   row6Left / row56Right: next-month days after the last day
 */
function drawCalendarRowCover(
    ctx: RenderContext,
    part: CalendarRowCoverPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);
    const bgColor = evalColor(part.bgColor, env);
    const fontColor = evalColor(part.fontColor, env);
    const fontSize = evalAttr(part.fontSize, env) || 8;
    const fontName = part.fontName || 'Arial';

    const calWidth = env.variables.get('calendarWidth') ?? 96;
    const calHeight = env.variables.get('calendarHeight') ?? 66;
    const cellWidth = env.variables.get('calendarCellWidth') ?? 13.3;
    const cellHeight = env.variables.get('calendarCellHeight') ?? 11;
    const calRadius = evalAttr(part.calendarRadius, env) || 117;
    const calYOffset = env.variables.get('calendarYOffset') ?? 51;

    const calendarWeekdayStart = env.functions.get('calendarWeekdayStart')?.() ?? 0;

    // Get current month info from env functions
    const getLocalCS = () => {
        const cs = {
            month: (env.functions.get('monthNumber')?.() ?? 0) + 1,  // 1-indexed
            year: env.functions.get('yearNumber')?.() ?? 2024,
            era: env.functions.get('eraNumber')?.() ?? 1,
            day: (env.functions.get('dayNumber')?.() ?? 0) + 1,  // 1-indexed
        };
        return cs;
    };
    const cs = getLocalCS();

    // Compute weekday of first of this month
    const firstOfMonth = new Date(cs.year, cs.month - 1, 1);
    const firstWeekday = firstOfMonth.getDay();
    const firstCol = (7 + firstWeekday - calendarWeekdayStart) % 7;

    // Days in this month
    const daysInMonth = new Date(cs.year, cs.month, 0).getDate();

    // Days in previous month
    const daysInPrevMonth = new Date(cs.year, cs.month - 1, 0).getDate();

    // Compute first of next month info
    const nextMonth = new Date(cs.year, cs.month, 1);
    const nextWeekday = nextMonth.getDay();
    const nextFirstCol = (7 + nextWeekday - calendarWeekdayStart) % 7;
    const nextMonthStartRow = Math.floor((daysInMonth + firstCol) / 7);

    const coverType = part.coverType || '';

    ctx.save();
    ctx.translate(x, y);

    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // Calendar grid position (top of grid is at calRadius - calYOffset area)
    const gridTop = -(calRadius - calHeight / 2);

    switch (coverType) {
        case 'row1Left': {
            // Previous month days in the first row, left of the 1st
            if (firstCol > 0) {
                for (let col = 0; col < firstCol && col < 4; col++) {
                    const day = daysInPrevMonth - firstCol + 1 + col;
                    const cx = -calWidth / 2 + col * cellWidth + cellWidth / 2 + 1;
                    const cy = gridTop - calHeight / 2 + cellHeight / 2;
                    const cyAdj = cy - 1;

                    // Background
                    ctx.fillStyle = bgColor;
                    ctx.fillRect(cx - cellWidth / 2 - 1, cyAdj - cellHeight / 2, cellWidth + 1, cellHeight);

                    // Day number
                    ctx.fillStyle = fontColor;
                    ctx.fillText(String(day), cx, cyAdj + textVisualCenterY(ctx, String(day)));
                }
            }
            break;
        }
        case 'row1Right': {
            // Previous month days in the first row, right portion
            if (firstCol > 4) {
                for (let col = 4; col < firstCol; col++) {
                    const day = daysInPrevMonth - firstCol + 1 + col;
                    const cx = -calWidth / 2 + col * cellWidth + cellWidth / 2 + 1;
                    const cy = gridTop - calHeight / 2 + cellHeight / 2;
                    const cyAdj = cy - 1;

                    ctx.fillStyle = bgColor;
                    ctx.fillRect(cx - cellWidth / 2 - 1, cyAdj - cellHeight / 2, cellWidth + 1, cellHeight);

                    ctx.fillStyle = fontColor;
                    ctx.fillText(String(day), cx, cyAdj + textVisualCenterY(ctx, String(day)));
                }
            }
            break;
        }
        case 'row6Left':
        case 'row56Right': {
            // Next month days after the last day
            const targetRow = coverType === 'row6Left' ? 5 : 4;
            if (nextMonthStartRow <= targetRow) {
                let nextDay = 1;
                const startRow = nextMonthStartRow;
                for (let row = startRow; row < 6; row++) {
                    const startCol = (row === startRow) ? nextFirstCol : 0;
                    for (let col = startCol; col < 7; col++) {
                        const cx = -calWidth / 2 + col * cellWidth + cellWidth / 2 + 1;
                        const cy = gridTop - calHeight / 2 + row * cellHeight + cellHeight / 2;
                        const cyAdj = cy - (1 - row / 5.0);

                        ctx.fillStyle = bgColor;
                        ctx.fillRect(cx - cellWidth / 2 - 1, cyAdj - cellHeight / 2, cellWidth + 1, cellHeight);

                        ctx.fillStyle = fontColor;
                        ctx.fillText(String(nextDay), cx, cyAdj + textVisualCenterY(ctx, String(nextDay)));
                        nextDay++;
                    }
                }
            }
            break;
        }
    }

    ctx.restore();
}

// ============================================================================
// CalendarHeader — weekday abbreviation row (S M T W T F S)
// ============================================================================

/**
 * Renders the weekday abbreviation header row for the calendar grid.
 * Only the header matching the runtime calendarWeekdayStart is drawn;
 * all others are parked offscreen.
 */
function drawCalendarHeader(
    ctx: RenderContext,
    part: CalendarHeaderPart,
    env: Environment,
): void {
    const calendarWeekdayStart = env.functions.get('calendarWeekdayStart')?.() ?? 0;
    const headerStart = parseInt(part.weekdayStart || '0', 10);

    // Only draw the header that matches the runtime week start
    if (headerStart !== calendarWeekdayStart) return;

    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);
    const fontSize = evalAttr(part.fontSize, env) || 8;
    const fontName = part.fontName || 'Arial';
    const weekdayColor = evalColor(part.weekdayColor, env);
    const weekendColor = evalColor(part.weekendColor, env);

    const calWidth = env.variables.get('calendarWidth') ?? 96;
    const cellWidth = env.variables.get('calendarCellWidth') ?? 13.3;

    // Weekday names starting from Sunday
    const dayNames = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

    ctx.save();
    ctx.translate(x, y - fontSize);

    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    for (let col = 0; col < 7; col++) {
        const dayIndex = (col + headerStart) % 7;
        const isWeekend = dayIndex === 0 || dayIndex === 6;
        ctx.fillStyle = isWeekend ? weekendColor : weekdayColor;

        const cx = -calWidth / 2 + col * cellWidth + cellWidth / 2;
        ctx.fillText(dayNames[dayIndex], cx, textVisualCenterY(ctx, dayNames[dayIndex]));
    }

    ctx.restore();
}
