/**
 * Clock hand drawing for the Observatory main dial.
 *
 * Port of iOS:
 *   EOHandView.mm        — arrow-style hands (24h, sunrise/set, twilight, golden, noon, midnight)
 *   EOHandBreguetView.mm — Breguet pomme hands (12h, minute)
 *   EOHandNeedleView.mm  — needle hand (seconds)
 *
 * All hands are drawn on the live canvas (not cached), since they move
 * every frame.  The coordinate convention is:
 *   ctx.rotate(clockAngle)  // 0 = 12 o'clock (top), CW
 *   draw along -y axis      // tip at (0, -length)
 *
 * iOS draws along +y (which is down in UIKit = 6 o'clock) then rotates.
 * We flip: draw along -y (up in canvas = 12 o'clock) then rotate.
 */

import type { LayoutParams } from './layout.js';
import type { ObsValueName } from './obs-values.js';
import type { Updater } from '../shared/updater.js';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const TWO_PI = Math.PI * 2;

// ============================================================================
// Hand colors — direct port of iOS EOClock.mm L1690-1700
// ============================================================================

const HOUR24_COLOR  = 'rgba(255, 255, 255, 0.85)';
const HOUR12_COLOR  = 'rgba(250, 183, 0, 1)';     // #FAB700
const MINUTE_COLOR  = 'rgba(255, 193, 37, 1)';     // #FFC125
const SECOND_COLOR  = 'rgba(255, 217, 154, 1)';    // #FFD99A
const RISESET_COLOR = 'rgba(255, 128, 0, 0.75)';
const GOLDEN_COLOR  = 'rgba(255, 204, 0, 0.75)';
const TWILIGHT_COLOR     = 'rgba(0, 128, 128, 0.75)';
const TWILIGHT_ARM_COLOR = 'rgba(77, 153, 153, 1)';
const SNOON_COLOR   = 'rgba(255, 255, 0, 0.75)';
const SMID_COLOR    = 'rgba(0, 0, 255, 0.75)';

// ============================================================================
// Arrow hand — port of EOHandView drawRect (L100-135)
// ============================================================================

/**
 * Draw an arrow-style hand.  Arm from (0, len2) to (0, length-arrowLength),
 * triangular arrowhead from there to (0, length).  If arrowLength == 0,
 * a small circle cap is drawn instead.
 *
 * iOS coordinate note: iOS draws at +y (down).  We draw at -y (up).
 */
function drawArrowHand(
    ctx: Ctx2D,
    cx: number, cy: number,
    angle: number,
    length: number,
    len2: number,
    width: number,
    arrowLength: number,
    arrowWidth: number,
    strokeColor: string,
    armColor: string,
): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    // arm — line from tail to arrow base
    ctx.strokeStyle = armColor;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -len2);         // tail (near center, flipped)
    ctx.lineTo(0, -(length - arrowLength));  // arrow base
    ctx.stroke();

    // arrowhead or circle cap
    ctx.fillStyle = strokeColor;
    ctx.beginPath();
    if (arrowLength > 0) {
        ctx.moveTo(-arrowWidth, -(length - arrowLength));
        ctx.lineTo(0, -length);   // tip
        ctx.lineTo(arrowWidth, -(length - arrowLength));
        ctx.closePath();
    } else {
        ctx.arc(0, -length, width / 2, 0, TWO_PI);
    }
    ctx.fill();

    ctx.restore();
}

// ============================================================================
// Breguet pomme hand — port of EOHandBreguetView drawRect (L38-86)
// ============================================================================

/**
 * Draw a Breguet-style pomme hand.
 * Components: filled hub circle → inner arm trapezoid → Breguet ring (outer
 * circle minus offset inner circle) → tip triangle.
 */
function drawBreguetHand(
    ctx: Ctx2D,
    cx: number, cy: number,
    angle: number,
    length: number,
    handWidth: number,
    strokeColor: string,
    fillColor: string,
    centerRadius: number,
): void {
    // iOS sizing parameters (Breguet drawRect L44-54)
    // Original iOS uses (length-81)/10 but 81 is a fixed pixel constant.
    // We make it fully proportional: at iOS scale, length≈197, so
    // (197-81)/10 = 11.6 ≈ length * 0.059.
    const widthScaler   = handWidth / (length * 0.16);
    const lengthScaler  = length * 0.059;
    const armWidth      = length * 0.04 * widthScaler;
    const breOuterCenter = length * 0.71 + lengthScaler;
    const breInnerCenter = length * 0.725 + lengthScaler * 0.88;
    const breOuterRadius = length * 0.075 * widthScaler;
    const breInnerRadius = length * 0.05 * widthScaler;
    const breBase        = breInnerCenter - breInnerRadius;
    const tipBase        = breOuterCenter + breOuterRadius - length * 0.005;
    const tipWidth       = length * 0.045 * widthScaler;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;
    ctx.lineWidth = 0.1;

    // 1. Filled circle at the hub
    ctx.beginPath();
    ctx.arc(0, 0, centerRadius, 0, TWO_PI);
    ctx.fill();
    ctx.stroke();

    // 2. Inner arm trapezoid (center → Breguet ring base)
    //    iOS: from centerRadius to breBase along +y → we flip to -y
    ctx.beginPath();
    ctx.moveTo(-armWidth / 2, -centerRadius);
    ctx.lineTo(-armWidth / 5, -breBase);
    ctx.lineTo(armWidth / 5, -breBase);
    ctx.lineTo(armWidth / 2, -centerRadius);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 3. Breguet ring: filled outer circle minus inner circle
    //    Use even-odd fill to cut out the hole
    ctx.beginPath();
    ctx.arc(0, -breOuterCenter, breOuterRadius, 0, TWO_PI);
    ctx.moveTo(breInnerRadius, -breInnerCenter);
    ctx.arc(0, -breInnerCenter, breInnerRadius, 0, -TWO_PI, true);
    ctx.fill('evenodd');
    ctx.stroke();

    // 4. Tip triangle (from ring top to hand tip)
    ctx.beginPath();
    ctx.moveTo(-tipWidth / 2, -tipBase);
    ctx.lineTo(0, -length);
    ctx.lineTo(tipWidth / 2, -tipBase);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
}

// ============================================================================
// Needle hand — port of EOHandNeedleView drawRect (L45-73)
// ============================================================================

const TAIL_FRACTION = 0.3;

/**
 * Draw a needle-style second hand.
 * Long skinny pentagon from tail to tip, with a ball on the tail
 * and a small circle at the center.
 */
function drawNeedleHand(
    ctx: Ctx2D,
    cx: number, cy: number,
    angle: number,
    length: number,
    width: number,
    color: string,
    ballRadius: number,
): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    // arm — long skinny pentagon (flipped: -y = tip, +y = tail)
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(-width / 2, 0);
    ctx.lineTo(-width / 2, -(length / 2));
    ctx.lineTo(0, -length);                          // tip
    ctx.lineTo(width / 2, -(length / 2));
    ctx.lineTo(width / 2, length * TAIL_FRACTION - ballRadius);  // tail side
    ctx.lineTo(-width / 2, length * TAIL_FRACTION - ballRadius);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // ball on the tail end
    if (ballRadius > 0) {
        // Small center dot
        ctx.beginPath();
        ctx.arc(0, 0, ballRadius / 2, 0, TWO_PI);
        ctx.fill();

        // Tail ball (circle outline)
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.arc(0, length * TAIL_FRACTION, ballRadius, 0, TWO_PI);
        ctx.stroke();
    }

    ctx.restore();
}

// ============================================================================
// Triangle hand — port of EOHandTriangleView drawRect (L39-64)
// ============================================================================

const TRIANGLE_TAIL_FRACTION = 0.21;

// Subdial hand colors (iOS EOClock.mm L2011-2028)
const SUBDIAL_STROKE = 'rgba(170, 170, 170, 1)';   // lightGrayColor
const SUBDIAL_FILL   = 'rgba(128, 128, 128, 1)';   // grayColor
const SUBDIAL_SEC_STROKE = 'rgba(255, 0, 0, 0.5)';
const SUBDIAL_SEC_FILL   = 'rgba(255, 0, 0, 0.75)';

/**
 * Draw a triangle-style hand (diamond with tail).
 * iOS draws in polar coordinates around the angle; we use the same
 * rotate-then-draw-along-minus-y convention as the other hands.
 */
function drawTriangleHand(
    ctx: Ctx2D,
    cx: number, cy: number,
    angle: number,
    length: number,
    width: number,
    strokeColor: string,
    fillColor: string,
): void {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;
    ctx.lineWidth = width / 10;

    // Diamond: base at center (±width/2), tip at -length, tail at +length*TAILFRACTION
    ctx.beginPath();
    ctx.moveTo(-width / 2, 0);                          // left base
    ctx.lineTo(0, -length);                              // tip (up)
    ctx.lineTo(width / 2, 0);                            // right base
    ctx.lineTo(0, length * TRIANGLE_TAIL_FRACTION);      // tail (down)
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
}

// ============================================================================
// Main entry point — drawClockHands
// ============================================================================

/**
 * Draw all clock hands for the Observatory main dial.
 *
 * This covers 16+ hands in the iOS rendering order:
 *   - 24-hour hand (arrow)
 *   - Sunrise/sunset (arrow, orange)
 *   - Golden hour begin/end (arrow, golden)
 *   - Civil/nautical/astronomical twilight begin/end (arrow, teal)
 *   - Solar noon/midnight (arrow, yellow/blue)
 *   - 12-hour hand (Breguet)
 *   - Minute hand (Breguet)
 *   - Second hand (needle)
 *
 * iOS rendering order (from EOClock.mm L2048-2093):
 *   alarm → 24h → 12h → minute → second → sunrise/set →
 *   golden → civil → nautical → astro twilight (begin/end) →
 *   golden/civil/nautical/astro end → noon → midnight
 *
 * We skip the alarm hand (not applicable to the web port).
 */
export function drawClockHands(
    ctx: Ctx2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
): void {
    const { mainCX, mainCY } = L;

    // ====================================================================
    // 1. Twilight / sunrise-sunset / golden hour / noon-midnight hands
    //    These are drawn BEHIND the timekeeping hands in iOS (L2060-2094).
    //    NaN currentValue = event is invalid (e.g., polar regions) → skip.
    // ====================================================================

    // Helper: draw a sun event hand if valid (not NaN)
    const drawSunHand = (v: { currentValue: number }, stroke: string, arm: string) => {
        if (!isNaN(v.currentValue)) {
            drawArrowHand(ctx, mainCX, mainCY,
                v.currentValue,
                L.sunRiseSetLen, L.len2, 1, L.sunRiseSetArrow, L.sunRiseSetArrow / 2 / Math.sqrt(3),
                stroke, arm);
        }
    };

    // Sunrise / Sunset (orange)
    drawSunHand(u.get('sunrise'), RISESET_COLOR, RISESET_COLOR);
    drawSunHand(u.get('sunset'),  RISESET_COLOR, RISESET_COLOR);

    // Golden hour (golden with grey arm)
    drawSunHand(u.get('goldenMorning'), GOLDEN_COLOR, '#555555');
    drawSunHand(u.get('goldenEvening'), GOLDEN_COLOR, '#555555');

    // Civil twilight (teal)
    drawSunHand(u.get('civilTwiMorning'), TWILIGHT_COLOR, TWILIGHT_ARM_COLOR);
    drawSunHand(u.get('civilTwiEvening'), TWILIGHT_COLOR, TWILIGHT_ARM_COLOR);

    // Nautical twilight (teal)
    drawSunHand(u.get('nautTwiMorning'), TWILIGHT_COLOR, TWILIGHT_ARM_COLOR);
    drawSunHand(u.get('nautTwiEvening'), TWILIGHT_COLOR, TWILIGHT_ARM_COLOR);

    // Astronomical twilight (teal)
    drawSunHand(u.get('astroTwiMorning'), TWILIGHT_COLOR, TWILIGHT_ARM_COLOR);
    drawSunHand(u.get('astroTwiEvening'), TWILIGHT_COLOR, TWILIGHT_ARM_COLOR);

    // Solar noon (yellow) — always valid
    drawArrowHand(ctx, mainCX, mainCY,
        u.get('solarNoon').currentValue,
        L.sunRiseSetLen, L.len2, 1, L.sunRiseSetArrow, L.sunRiseSetArrow / 2 / Math.sqrt(3),
        SNOON_COLOR, '#555555');

    // Solar midnight (blue) — always valid
    drawArrowHand(ctx, mainCX, mainCY,
        u.get('solarMidnight').currentValue,
        L.sunRiseSetLen, L.len2, 1, L.sunRiseSetArrow, L.sunRiseSetArrow / 2 / Math.sqrt(3),
        SMID_COLOR, '#555555');

    // ====================================================================
    // 2. 24-hour hand (arrow, white)
    //    noonOnTop offset is baked into the expression
    // ====================================================================
    drawArrowHand(ctx, mainCX, mainCY,
        u.get('h24').currentValue,
        L.h24Len, 0, 0.75, L.h24Arrow, L.h24Wid,
        HOUR24_COLOR, HOUR24_COLOR);

    // ====================================================================
    // 3. 12-hour hand (Breguet, gold)
    // ====================================================================
    drawBreguetHand(ctx, mainCX, mainCY,
        u.get('h12').currentValue,
        L.h12Len, L.breH12Width, 'white', HOUR12_COLOR, L.breH12CenterR);

    // ====================================================================
    // 4. Minute hand (Breguet, lighter gold)
    // ====================================================================
    drawBreguetHand(ctx, mainCX, mainCY,
        u.get('minute').currentValue,
        L.minLen, L.breMinWidth, 'white', MINUTE_COLOR, L.breMinCenterR);

    // ====================================================================
    // 5. Second hand (needle, warm white)
    // ====================================================================
    drawNeedleHand(ctx, mainCX, mainCY,
        u.get('second').currentValue,
        L.secLen, L.secWidth, SECOND_COLOR, L.secBallR);
}

// ============================================================================
// Subdial hands — UTC, Solar, Sidereal
// ============================================================================

/**
 * Draw all subdial hands for the three inner time displays.
 *
 * Port of iOS EOClock.mm L2010-2028 (INNER_SUBDIALS):
 *   - UTC subdial: 24h hour + minute + second triangle hands
 *   - Solar subdial: 12h hour + minute + second triangle hands
 *   - Sidereal subdial: 24h hour + minute + second triangle hands
 *
 * Dimensions from iOS:
 *   hour:   length = subR * 0.55, width = 5
 *   minute: length = subR * 0.75, width = 4
 *   second: length = subR * 0.85, width = 3
 */
export function drawSubdialHands(
    ctx: Ctx2D,
    L: LayoutParams,
    u: Updater<ObsValueName>,
): void {
    const { subR } = L;

    // Compute scale factor from subR: iOS subR = 73, our scale = subR / 73
    // for the width parameter that was originally in iOS pixels.
    const ss = subR / 73;
    const hourLen   = subR * 0.55;
    const minuteLen = subR * 0.75;
    const secondLen = subR * 0.85;
    const hourWid   = 5 * ss;
    const minuteWid = 4 * ss;
    const secondWid = 3 * ss;

    // ====================================================================
    // UTC subdial — 24h clock, hands show UTC time
    // ====================================================================
    drawTriangleHand(ctx, L.utcCX, L.utcCY, u.get('utcHour').currentValue,   hourLen,   hourWid,   SUBDIAL_STROKE, SUBDIAL_FILL);
    drawTriangleHand(ctx, L.utcCX, L.utcCY, u.get('utcMinute').currentValue, minuteLen, minuteWid, SUBDIAL_STROKE, SUBDIAL_FILL);
    drawTriangleHand(ctx, L.utcCX, L.utcCY, u.get('utcSecond').currentValue, secondLen, secondWid, SUBDIAL_SEC_STROKE, SUBDIAL_SEC_FILL);

    // ====================================================================
    // Solar subdial — 12h clock, hands show local apparent solar time
    // ====================================================================
    drawTriangleHand(ctx, L.solarCX, L.solarCY, u.get('solarHour').currentValue,   hourLen,   hourWid,   SUBDIAL_STROKE, SUBDIAL_FILL);
    drawTriangleHand(ctx, L.solarCX, L.solarCY, u.get('solarMinute').currentValue, minuteLen, minuteWid, SUBDIAL_STROKE, SUBDIAL_FILL);
    drawTriangleHand(ctx, L.solarCX, L.solarCY, u.get('solarSecond').currentValue, secondLen, secondWid, SUBDIAL_SEC_STROKE, SUBDIAL_SEC_FILL);

    // ====================================================================
    // Sidereal subdial — 24h clock, hands show local sidereal time
    // ====================================================================
    drawTriangleHand(ctx, L.sidCX, L.sidCY, u.get('sidHour').currentValue,   hourLen,   hourWid,   SUBDIAL_STROKE, SUBDIAL_FILL);
    drawTriangleHand(ctx, L.sidCX, L.sidCY, u.get('sidMinute').currentValue, minuteLen, minuteWid, SUBDIAL_STROKE, SUBDIAL_FILL);
    drawTriangleHand(ctx, L.sidCX, L.sidCY, u.get('sidSecond').currentValue, secondLen, secondWid, SUBDIAL_SEC_STROKE, SUBDIAL_SEC_FILL);
}
