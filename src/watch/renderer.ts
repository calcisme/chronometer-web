/**
 * Canvas 2D renderer for Chronometer watch parts.
 *
 * Draws all part types from the parsed watch model onto an HTML canvas.
 * Ported from the Cocoa drawing code in ECQView.m.
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

// ============================================================================
// Public API
// ============================================================================

/**
 * Render a watch to a canvas context.
 *
 * @param ctx   Canvas 2D context (must already be sized)
 * @param watch Parsed watch model
 * @param env   Expression environment (with init blocks already evaluated)
 * @param scale Scale factor from XML units to canvas pixels
 */
export function renderWatch(
    ctx: CanvasRenderingContext2D,
    watch: Watch,
    env: Environment,
    scale: number,
): void {
    ctx.save();

    // Set up coordinate system: origin at center, scale XML units → pixels
    ctx.translate(ctx.canvas.width / 2, ctx.canvas.height / 2);
    ctx.scale(scale, scale);

    // Draw all parts in document order
    for (const part of watch.parts) {
        drawPart(ctx, part, env);
    }

    ctx.restore();
}

// ============================================================================
// Part dispatch
// ============================================================================

function drawPart(
    ctx: CanvasRenderingContext2D,
    part: WatchPart,
    env: Environment,
): void {
    switch (part.type) {
        case 'Static':
            drawStatic(ctx, part, env);
            break;
        case 'QDial':
            drawQDial(ctx, part, env);
            break;
        case 'QHand':
            drawQHand(ctx, part, env);
            break;
        case 'Wheel':
            drawWheel(ctx, part, env);
            break;
        case 'QText':
            drawQText(ctx, part, env);
            break;
        case 'Image':
            // Images skipped for Phase 3
            break;
        case 'QRect':
            drawQRect(ctx, part, env);
            break;
        case 'Window':
            drawWindow(ctx, part, env);
            break;
        case 'Button':
            // Buttons not drawn (interaction is Phase 6)
            break;
    }
}

// ============================================================================
// Static container
// ============================================================================

function drawStatic(
    ctx: CanvasRenderingContext2D,
    part: StaticPart,
    env: Environment,
): void {
    for (const child of part.children) {
        drawPart(ctx, child, env);
    }
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
    ctx: CanvasRenderingContext2D,
    part: QDialPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const radius = evalAttr(part.radius, env);
    if (radius <= 0) return;

    const bgColor = evalColor(part.bgColor, env);
    const strokeColor = evalColor(part.strokeColor, env);
    const markWidth = evalAttr(part.markWidth, env) || 1;
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

    // Border stroke
    if (marks & MARKS_OUTER) {
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
    if (part.text) {
        const labels = part.text.split(',');
        const n = labels.length;
        const fontSize = evalAttr(part.fontSize, env) || 12;
        const fontName = part.fontName || 'Arial';
        const orientation = part.orientation || 'upright';

        ctx.fillStyle = strokeColor;
        ctx.font = `${fontSize}px "${fontName}"`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < n; i++) {
            const label = labels[i].trim();
            if (!label) continue;

            const th = (i / n) * 2 * Math.PI - Math.PI / 2;

            if (orientation === 'upright') {
                // Draw text upright at each position around the circle
                // Use larger offset for upright text since horizontal bounding box
                // extends radially outward at diagonal positions (e.g., "11")
                const textR = radius - fontSize * 1.2;
                const tx = textR * Math.cos(th);
                const ty = textR * Math.sin(th);
                ctx.save();
                ctx.translate(tx, ty);
                ctx.fillText(label, 0, 0);
                ctx.restore();
            } else if (orientation === 'demi') {
                // Demi-radial: text follows the curve, upside-down in bottom half
                const textR = radius - fontSize * 0.85;
                const demiTweak = evalAttr(part.demiTweak, env);
                const tx = textR * Math.cos(th);
                const ty = textR * Math.sin(th);
                ctx.save();
                ctx.translate(tx, ty);
                const angle = th + Math.PI / 2;
                // Flip text in the bottom half
                if (angle > Math.PI / 2 && angle < 3 * Math.PI / 2) {
                    ctx.rotate(angle + Math.PI);
                    ctx.translate(0, demiTweak);
                } else {
                    ctx.rotate(angle);
                    ctx.translate(0, -demiTweak);
                }
                ctx.fillText(label, 0, 0);
                ctx.restore();
            } else {
                // Default: radial text
                const textR = radius - fontSize * 0.85;
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

    // Center/outer mark circle stroke
    if (marks & MARKS_CENTER) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = markWidth;
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, 2 * Math.PI);
        ctx.stroke();
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
    const angle = evalAttr(part.angle, env);
    const length = evalAttr(part.length, env);
    const width = evalAttr(part.width, env);
    const tail = evalAttr(part.tail, env);


    if (length <= 0) return;

    const handType = part.handType || 'tri';
    // Default hand color to black when not specified (XML hands often omit color)
    const strokeColor = part.strokeColor ? evalColor(part.strokeColor, env) : 'rgba(0,0,0,1)';
    const fillColor = part.fillColor ? evalColor(part.fillColor, env) : 'rgba(0,0,0,1)';
    const lineWidth = evalAttr(part.lineWidth, env) || 0.5;


    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // Draw the main hand body
    drawHandShape(ctx, handType, length, width, tail, strokeColor, fillColor, lineWidth);

    // Draw arrow overlay if present
    const oLength = evalAttr(part.oLength, env);
    if (oLength > 0) {
        const oWidth = evalAttr(part.oWidth, env);
        const oTail = evalAttr(part.oTail, env);
        const oLineWidth = evalAttr(part.oLineWidth, env) || lineWidth;
        const oStrokeColor = evalColor(part.oStrokeColor, env);
        const oFillColor = evalColor(part.oFillColor, env);

        drawHandShape(ctx, handType, oLength, oWidth, oTail, oStrokeColor, oFillColor, oLineWidth);
    }

    // Center dot
    const oCenter = evalAttr(part.oCenter, env);
    if (oCenter > 0) {
        const osc = part.oStrokeColor ? evalColor(part.oStrokeColor, env) : strokeColor;
        ctx.fillStyle = osc;
        ctx.beginPath();
        ctx.arc(0, 0, oCenter, 0, 2 * Math.PI);
        ctx.fill();
    }

    ctx.restore();
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
): void {
    ctx.beginPath();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;

    if (handType === 'rect') {
        // Rectangle hand: -tail to +length, width centered
        const hw = width / 2;
        ctx.rect(-hw, tail, width, -(length + tail));
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
    ctx: CanvasRenderingContext2D,
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
    const strokeColor = evalColor(part.strokeColor, env);
    const bgColor = evalColor(part.bgColor, env);
    const orientation = part.orientation || 'twelve';

    ctx.save();
    ctx.translate(x, y);

    // Compute the angular span per label (wedge)
    const wedgeAngle = 2 * Math.PI / n;
    // Compute the visible label index based on the current angle
    // For the wheel, the angle expression gives the rotation of the wheel
    const baseRotation = orientationAngle(orientation);

    ctx.font = `${fontSize}px "${fontName}"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Draw each wedge
    for (let i = 0; i < n; i++) {
        const label = labels[i].trim();
        const wedgeCenter = -angle + i * wedgeAngle;

        ctx.save();
        ctx.rotate(wedgeCenter + baseRotation);

        // Background wedge
        if (bgColor !== 'rgba(0,0,0,0)') {
            ctx.fillStyle = bgColor;
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, radius, -wedgeAngle / 2, wedgeAngle / 2);
            ctx.closePath();
            ctx.fill();
        }

        // Wedge border
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, radius, -wedgeAngle / 2, wedgeAngle / 2);
        ctx.closePath();
        ctx.stroke();

        // Text in wedge
        if (label) {
            ctx.fillStyle = strokeColor;
            ctx.save();
            // Orient text based on wheel orientation
            const textR = radius * 0.6;
            ctx.translate(textR, 0);
            ctx.rotate(-wedgeCenter - baseRotation);  // keep text upright
            ctx.fillText(label, 0, 0);
            ctx.restore();
        }

        ctx.restore();
    }

    ctx.restore();
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
    ctx: CanvasRenderingContext2D,
    part: QTextPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const text = part.text || '';
    if (!text) return;

    const fontSize = evalAttr(part.fontSize, env) || 12;
    const fontName = part.fontName || 'Arial';
    const strokeColor = evalColor(part.strokeColor, env);

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
// QRect — colored rectangle
// ============================================================================

function drawQRect(
    ctx: CanvasRenderingContext2D,
    part: QRectPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const w = evalAttr(part.w, env);
    const h = evalAttr(part.h, env);
    if (w <= 0 || h <= 0) return;

    const bgColor = evalColor(part.bgColor, env);

    ctx.save();
    ctx.translate(x, y);

    // Centered rect
    if (bgColor !== 'rgba(0,0,0,0)') {
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

function drawWindow(
    ctx: CanvasRenderingContext2D,
    part: WindowPart,
    env: Environment,
): void {
    const x = evalAttr(part.x, env);
    const y = -evalAttr(part.y, env);  // Negate Y: XML Y-up → Canvas Y-down
    const w = evalAttr(part.w, env);
    const h = evalAttr(part.h, env);
    const border = evalAttr(part.border, env);
    const strokeColor = evalColor(part.strokeColor, env);
    const isPorthole = part.windowType === 'porthole';

    if (w <= 0 || h <= 0) return;

    ctx.save();
    ctx.translate(x, y);

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
