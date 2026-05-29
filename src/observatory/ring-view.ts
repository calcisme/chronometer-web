/**
 * Observatory rise/set ring rendering.
 *
 * Draws colored arc segments showing above-horizon time for each planet,
 * and the full sky-color ring for the Sun.
 *
 * Port of: EORingView.mm (EOClock.mm L2032–2044 for configuration)
 *
 * Ring layers (outer to inner, matching iOS):
 *   Sun    — widest ring (~64px iOS), altitude-color gradient for 24h
 *   Saturn — 8px, cyan day arc
 *   Jupiter — 8px, green day arc
 *   Mars   — 8px, pink day arc
 *   Venus  — 8px, white day arc
 *   Mercury — 8px, salmon day arc
 *   Moon   — 8px, blue day arc
 *
 * The Sun ring iterates over ±12 hours from now, computing sun altitude
 * at each time step and coloring arc segments using the iOS gradient table
 * (EORingView.mm L61–71). Uses cachelessPlanetAlt for time-offset altitude.
 *
 * Planet rings use rise/set angles via dayNightLeafAngle(planet, 0/1, 0)
 * (which IS the same underlying function as iOS planetrise24HourIndicatorAngle).
 *
 * Update interval: 3600s (rings recomputed hourly).
 */

import type { LayoutParams } from './layout.js';
import type { Environment } from '../expr/evaluator.js';
import type { ObsValueSet } from './obs-values.js';
import { ECPlanetNumber } from '../astronomy/astro-constants.js';
import { cachelessPlanetAlt } from '../astronomy/es-astro.js';
import { drawCircularText } from './draw-utils.js';
import { dateToDateInterval } from '../astronomy/es-time.js';

const TWO_PI = 2 * Math.PI;
const HALF_PI = Math.PI / 2;


// ---------------------------------------------------------------------------
// Sky-color gradient for Sun ring
// ---------------------------------------------------------------------------

/**
 * Altitude-based color gradient steps.
 * Port of: EORingView.mm L54–71 (gradientSteps[])
 */
interface GradientStep {
    alt: number;  // degrees
    r: number;
    g: number;
    b: number;
    a: number;
}

const GRADIENT_STEPS: GradientStep[] = [
    { alt: -90.01, r: 0.125, g: 0.125, b: 0.125, a: 0 },    // full night
    { alt: -30,    r: 0.125, g: 0.125, b: 0.125, a: 0 },
    { alt: -9,     r: 0.00,  g: 0.00,  b: 0.39,  a: 1 },
    { alt: -1,     r: 0.17,  g: 0.77,  b: 0.84,  a: 1 },
    { alt: -0.5,   r: 0.84,  g: 0.00,  b: 0.00,  a: 1 },
    { alt:  1,     r: 0.94,  g: 0.42,  b: 0.00,  a: 1 },
    { alt:  9,     r: 1.00,  g: 1.00,  b: 0.00,  a: 1 },
    { alt: 30,     r: 0.90,  g: 0.90,  b: 1.00,  a: 1 },
    { alt: 90.01,  r: 0.90,  g: 0.90,  b: 1.00,  a: 1 },
];

/**
 * Interpolate color from the altitude gradient.
 * Port of: EORingView.mm L73–100
 *
 * @param altRad  Altitude in radians
 * @returns CSS rgba color string
 */
function colorForAltitude(altRad: number): string {
    const altDeg = altRad * 180 / Math.PI;
    const alt = Math.max(-90, Math.min(90, altDeg));

    let i = 0;
    while (i < GRADIENT_STEPS.length - 1 && GRADIENT_STEPS[i].alt <= alt) {
        i++;
    }
    const j = Math.max(0, i - 1);

    const stepWidth = GRADIENT_STEPS[i].alt - GRADIENT_STEPS[j].alt;
    const fraction = stepWidth > 0 ? (alt - GRADIENT_STEPS[j].alt) / stepWidth : 0;

    const r = GRADIENT_STEPS[j].r + (GRADIENT_STEPS[i].r - GRADIENT_STEPS[j].r) * fraction;
    const g = GRADIENT_STEPS[j].g + (GRADIENT_STEPS[i].g - GRADIENT_STEPS[j].g) * fraction;
    const b = GRADIENT_STEPS[j].b + (GRADIENT_STEPS[i].b - GRADIENT_STEPS[j].b) * fraction;
    const a = GRADIENT_STEPS[j].a + (GRADIENT_STEPS[i].a - GRADIENT_STEPS[j].a) * fraction;

    return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a.toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Planet ring configuration
// ---------------------------------------------------------------------------

interface PlanetRingConfig {
    planet: ECPlanetNumber;
    outerOffset: number;  // iOS px from plR
    width: number;        // iOS px ring width
    dayColor: string;
    nightColor: string | null;
}

/**
 * Ring configuration matching iOS EOClock.mm L2032–2044.
 */
const PLANET_RINGS: PlanetRingConfig[] = [
    { planet: ECPlanetNumber.Saturn,  outerOffset: 2,  width: 8, dayColor: 'rgba(169,252,252,1)', nightColor: null },
    { planet: ECPlanetNumber.Jupiter, outerOffset: 12, width: 8, dayColor: 'rgba(169,252,169,1)', nightColor: null },
    { planet: ECPlanetNumber.Mars,    outerOffset: 22, width: 8, dayColor: 'rgba(252,169,252,1)', nightColor: null },
    { planet: ECPlanetNumber.Venus,   outerOffset: 32, width: 8, dayColor: 'rgba(255,255,255,1)', nightColor: null },
    { planet: ECPlanetNumber.Mercury, outerOffset: 42, width: 8, dayColor: 'rgba(252,169,169,1)', nightColor: null },
    { planet: ECPlanetNumber.Moon,    outerOffset: 52, width: 8, dayColor: 'rgba(169,169,252,1)', nightColor: null },
];

/**
 * Planet name strings for ring labels.
 * Port of: EORingView.mm L367-399 (switch statement)
 */
const PLANET_NAMES: Partial<Record<ECPlanetNumber, string>> = {
    [ECPlanetNumber.Moon]: 'Moon',
    [ECPlanetNumber.Mercury]: 'Mercury',
    [ECPlanetNumber.Venus]: 'Venus',
    [ECPlanetNumber.Mars]: 'Mars',
    [ECPlanetNumber.Jupiter]: 'Jupiter',
    [ECPlanetNumber.Saturn]: 'Saturn',
};

interface RingCacheEntry {
    riseAngle: number;
    setAngle: number;
    transitAngle: number;
    riseValid: boolean;
    setValid: boolean;
    aboveHorizon: boolean;
}

const ringCache = new Map<ECPlanetNumber, RingCacheEntry>();

// Sun ring OffscreenCanvas cache
let sunRingCacheCanvas: OffscreenCanvas | null = null;
let sunRingCacheNoonOnTop: boolean | null = null;

// ---------------------------------------------------------------------------
// Sun ring rendering
// ---------------------------------------------------------------------------

/**
 * Compute local time seconds since midnight for a given dateInterval + tz offset.
 *
 * Port of: tempWatchTime->secondsSinceMidnightValueUsingEnv(env)
 * iOS uses ESWatchTime which applies the timezone to get local time.
 *
 * @param dateInterval  Apple epoch seconds
 * @param tzOffsetSeconds  Timezone offset from UTC in seconds
 */
function secondsSinceMidnightForDateInterval(dateInterval: number, tzOffsetSeconds: number): number {
    // Convert Apple epoch to Unix timestamp
    const unixTime = dateInterval + 978307200;
    // Apply timezone offset to get local time
    const localTime = unixTime + tzOffsetSeconds;
    // Get seconds since midnight (modular arithmetic)
    return ((localTime % 86400) + 86400) % 86400;
}

/**
 * Draw the Sun altitude ring.
 *
 * Port of: EORingView.mm L170–310 (drawRect for planet==ECPlanetSun)
 *
 * Iterates from (now - 12h) to (now + 12h), computing sun altitude
 * at each angular step and drawing colored arc segments.
 *
 * Angular convention (matching iOS):
 * - startAngle = secondsSinceMidnight / 3600 * 2π/24 + π * noonOnTop
 * - Canvas conversion: halfPi - clockAngle
 * - Arc drawn with anticlockwise=true (matches iOS CGContextAddArc clockwise=1 in UIKit)
 */
function drawSunRing(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    now: Date,
    lat: number,
    lng: number,
    tzOffsetSeconds: number,
    noonOnTop: boolean,
): void {
    const cx = L.mainCX;
    const cy = L.mainCY;
    const outerR = L.plR;
    const innerR = L.plR - L.sunRingWidth;
    const centerR = (outerR + innerR) / 2;
    const ringWidth = outerR - innerR;
    const noonOffset = noonOnTop ? Math.PI : 0;

    const nowDI = dateToDateInterval(now);
    const latRad = lat * Math.PI / 180;
    const lngRad = lng * Math.PI / 180;

    ctx.save();
    ctx.lineWidth = ringWidth;
    ctx.lineCap = 'butt';

    // iOS: iterate from now-12h to now+12h
    // angleInc = 3/outerR (about 0.005 rad at r=600)
    // Finer steps (angleInc/3) near horizon (|alt| < 9°)
    const angleInc = 3 / outerR;

    const startTime = nowDI - 12 * 3600;
    const endTime = nowDI + 12 * 3600;

    // Compute starting clock angle
    const startSeconds = secondsSinceMidnightForDateInterval(startTime, tzOffsetSeconds);
    let startClockAngle = (startSeconds / 3600 % 24) * TWO_PI / 24 + noonOffset;
    if (startClockAngle > TWO_PI) startClockAngle -= TWO_PI;

    const cheat = 1 / outerR;
    let drawAngle = startClockAngle;
    let t = startTime;
    let first = true;

    while (t < endTime) {
        const alt = cachelessPlanetAlt(ECPlanetNumber.Sun, t, latRad, lngRad);
        const color = colorForAltitude(alt);

        // Step size: finer near horizon (|alt| < 9° = π/20 rad)
        const step = Math.abs(alt) < TWO_PI * 9 / 360 ? angleInc / 3 : angleInc * 3;

        const nextAngle = drawAngle + step;

        // iOS: CGContextAddClockArc(startAngle-cheat, endAngle+cheat)
        //   = CGContextAddArc(ctx, 0, 0, centerR, halfPi-(sa), halfPi-(ea), 1)
        // iOS uses Y-up CG angles in a UIKit Y-down context — the Y-flip makes
        // halfPi visually map to TOP. Canvas angles work directly with Y-down,
        // so the correct conversion is (clockAngle - HALF_PI), not the reverse.
        const canvasStart = (drawAngle - cheat) - HALF_PI;
        const canvasEnd = (nextAngle + cheat) - HALF_PI;

        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, centerR, canvasStart, canvasEnd);
        ctx.stroke();

        drawAngle = nextAngle;
        t += 86400 * step / TWO_PI;
        first = false;
    }

    ctx.restore();
}

// ---------------------------------------------------------------------------
// Planet ring rendering
// ---------------------------------------------------------------------------

/**
 * Map from ring config index to ObsValueSet ring array key.
 */
const RING_VALUE_KEYS: (keyof ObsValueSet)[] = [
    'saturnRing', 'jupiterRing', 'marsRing', 'venusRing', 'mercuryRing', 'moonRing',
];

/**
 * Update the planet ring cache from ObsValues.
 *
 * Reads pre-computed rise/set/transit angles from the ObsValueSet.
 * NaN rise/set = planet doesn't rise/set (always above or below horizon).
 * The aboveHorizon check uses the env function when needed.
 */
function updateRingCache(env: Environment, vs: ObsValueSet): void {
    for (let i = 0; i < PLANET_RINGS.length; i++) {
        const ring = PLANET_RINGS[i];
        const ringValues = vs[RING_VALUE_KEYS[i]] as { currentValue: number }[];

        // Ring array: [rise, set, transit]
        const riseAngle = ringValues[0].currentValue;
        const setAngle = ringValues[1].currentValue;
        const transitAngle = ringValues[2].currentValue;

        const riseValid = isFinite(riseAngle) && !isNaN(riseAngle);
        const setValid = isFinite(setAngle) && !isNaN(setAngle);

        let aboveHorizon = false;
        if (!riseValid || !setValid) {
            const altFn = env.functions.get('altitudeOfPlanet') as ((n: number) => number) | undefined;
            if (altFn) {
                aboveHorizon = altFn(ring.planet) > 0;
            }
        }

        ringCache.set(ring.planet, {
            riseAngle,
            setAngle,
            transitAngle,
            riseValid,
            setValid,
            aboveHorizon,
        });
    }
}

/**
 * Draw a single planet's rise/set arc ring.
 *
 * Port of: EORingView.mm L311–429 (planet ring drawRect, non-sun branch)
 *
 * iOS angle conversion:
 *   riseAngle = halfPi - riseAngle   (clock → CG)
 *   setAngle  = halfPi - setAngle
 *   CGContextAddArc(ctx, 0, 0, centerR, riseAngle, setAngle, 1)
 *
 * In iOS UIKit (Y-down), clockwise=1 draws **counterclockwise on screen**.
 * Canvas equivalent: anticlockwise=true.
 */
function drawPlanetRing(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
): void {
    const s = L.mainR / 365;
    const cx = L.mainCX;
    const cy = L.mainCY;

    for (const ring of PLANET_RINGS) {
        const outerR = L.plR - ring.outerOffset * s;
        const innerR = outerR - ring.width * s;
        const centerR = (outerR + innerR) / 2;
        const lineW = outerR - innerR;

        const cache = ringCache.get(ring.planet);
        if (!cache) continue;

        let riseAngle = cache.riseAngle;
        let setAngle = cache.setAngle;
        let drawLabelOnly = false;

        if (!cache.riseValid || !cache.setValid) {
            if (cache.aboveHorizon) {
                // Always above: draw complete loop
                // iOS: riseAngle = fmod(transitAngle - PI + 0.0001, 2π)
                //      setAngle  = fmod(transitAngle + PI - 0.0001, 2π)
                riseAngle = ((cache.transitAngle - Math.PI + 0.0001) % TWO_PI + TWO_PI) % TWO_PI;
                setAngle = ((cache.transitAngle + Math.PI - 0.0001) % TWO_PI + TWO_PI) % TWO_PI;
            } else {
                drawLabelOnly = true;
            }
        }

        ctx.save();
        ctx.lineWidth = lineW;
        ctx.lineCap = 'butt';

        if (!drawLabelOnly) {
            // Convert clock angles to Canvas arc angles.
            // iOS uses halfPi - clockAngle because CG angles are Y-up and UIKit
            // flips Y, making halfPi = TOP. Canvas Y-down has halfPi = BOTTOM,
            // so the correct conversion is clockAngle - HALF_PI.
            const canvasRise = riseAngle - HALF_PI;
            const canvasSet = setAngle - HALF_PI;

            // Day arc: from rise to set (clockwise on dial = CW in canvas)
            ctx.strokeStyle = ring.dayColor;
            ctx.beginPath();
            ctx.arc(cx, cy, centerR, canvasRise, canvasSet);
            ctx.stroke();

            // Night arc (if color specified)
            if (ring.nightColor) {
                ctx.strokeStyle = ring.nightColor;
                ctx.beginPath();
                ctx.arc(cx, cy, centerR, canvasSet, canvasRise);
                ctx.stroke();
            }

            // Transit diamond marker
            // iOS: EORingView.mm L415-428
            const canvasTransit = cache.transitAngle - HALF_PI;
            const dc = 9.0 / 20 * TWO_PI / 360;  // half-width in radians
            const midR = (outerR + innerR) / 2;
            const ct = Math.cos(canvasTransit);
            const st = Math.sin(canvasTransit);

            ctx.lineWidth = 0.33 * s;
            ctx.strokeStyle = `rgba(50,50,50,0.5)`;
            ctx.fillStyle = `rgba(50,50,50,0.5)`;
            ctx.beginPath();
            ctx.moveTo(cx + innerR * ct, cy + innerR * st);
            ctx.lineTo(cx + midR * Math.cos(canvasTransit - dc), cy + midR * Math.sin(canvasTransit - dc));
            ctx.lineTo(cx + outerR * ct, cy + outerR * st);
            ctx.lineTo(cx + midR * Math.cos(canvasTransit + dc), cy + midR * Math.sin(canvasTransit + dc));
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        // Planet name labels
        // Port of: EORingView.mm L367-412
        const pName = PLANET_NAMES[ring.planet];
        if (pName) {
            const labelFont = `${8 * s}px Arial, sans-serif`;
            const labelRadius = centerR;  // drawCircularText centers text visually at this radius

            if (drawLabelOnly) {
                // Planet below horizon: draw name at transit angle in day color
                drawCircularText(ctx, pName, cx, cy, labelRadius,
                    cache.transitAngle, 0, labelFont, ring.dayColor, true);
            } else {
                // Draw name at rise and set endpoints
                drawCircularText(ctx, pName, cx, cy, labelRadius,
                    cache.riseAngle, Math.PI / 40, labelFont, '#000000', true);
                drawCircularText(ctx, pName, cx, cy, labelRadius,
                    cache.setAngle, -Math.PI / 40, labelFont, '#000000', true);
            }
        }

        ctx.restore();
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Draw all rise/set rings on the orrery.
 *
 * @param ctx       Canvas 2D context (already at DPR scale)
 * @param L         Layout parameters
 * @param env       Astronomy environment (still needed for sun ring + aboveHorizon check)
 * @param noonOnTop Whether noon is at the top of the dial
 * @param now       Current display time (still needed for sun ring)
 * @param lat       Observer latitude in degrees (still needed for sun ring)
 * @param lon       Observer longitude in degrees (still needed for sun ring)
 * @param tzOffsetSeconds  Timezone offset from UTC in seconds (still needed for sun ring)
 * @param vs        Observatory values (for planet ring angles)
 */
export function drawRiseSetRings(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    env: Environment,
    noonOnTop: boolean,
    now: Date,
    lat: number,
    lon: number,
    tzOffsetSeconds: number,
    vs: ObsValueSet,
): void {
    // Update planet ring cache from ObsValues
    updateRingCache(env, vs);

    // 1. Sun ring (altitude-based sky-color gradient — stays as-is)
    // PERF TEST: sun ring disabled to measure impact
    // drawSunRing(ctx, L, now, lat, lon, tzOffsetSeconds, noonOnTop);

    // 2. Planet rings (simple rise/set arcs)
    drawPlanetRing(ctx, L);
}

/**
 * Force ring cache to recompute on next draw.
 * Call when location, timezone, or noonOnTop changes.
 */
export function invalidateRingCache(): void {
    sunRingCacheCanvas = null;
    sunRingCacheNoonOnTop = null;
}
