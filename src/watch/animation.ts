/**
 * Animation system for watch hands and wheels.
 *
 * Two-time-base architecture (see planning/2026-04-10-animation-strategy.md):
 *
 * - **Display time** (getNow) is used to evaluate angle expressions,
 *   determining WHAT the target angle should be.
 * - **Real time** (performance.now) is used for animation interpolation,
 *   determining WHERE the hand is drawn right now.
 *
 * At quantized rates (10 hr/s etc.), display time jumps discretely on
 * each tick. The animation system smoothly interpolates hand positions
 * at up to 240fps between ticks using real time.
 *
 * Animation duration is adaptive:
 * - If the normal speed-based duration would exceed the tick interval,
 *   compress the animation to fit within one tick (fast parts).
 * - Otherwise, use the normal speed-based duration (slow parts).
 */

import type { Watch, WatchPart, QHandPart, WheelPart, QWedgePart, CalendarRowCoverPart } from './types.js';
import type { Environment } from '../expr/evaluator.js';
import { evalAttr } from './watch-env.js';
import {
    timeIntervalFromUTCComponents, daysInMonth as calendarDaysInMonth,
    weekdayFromTimeInterval,
} from '../astronomy/es-calendar.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { planetaryRiseSetTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet } from '../astronomy/astro-constants.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';

// Constants used by the scheduler
export const SCHEDULER_LOOKAHEAD_MS = 50; // arm setTimeout this many ms early to avoid skipping boundaries

// ============================================================================
// Constants (from ECConstants.h)
// ============================================================================

/** Base angular animation speed (radians per second). */
const kECGLAngleAnimationSpeed = 2.0;

/** Minimum animation duration; below this, snap directly. */
const kECGLFrameRate = 1.0 / 240;

/** Base linear animation speed (pixels per second). */
const kECGLLinearAnimationSpeed = 60.0;

// --- Named update interval sentinels (matching iOS ECConstants.h) ---
// Negative values that the animation system interprets specially.
export const EC_UPDATE_NEXT_SUNRISE              = -1001;
export const EC_UPDATE_NEXT_SUNSET               = -1002;
export const EC_UPDATE_NEXT_MOONRISE             = -1003;
export const EC_UPDATE_NEXT_MOONSET              = -1004;
export const EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT  = -1005;
export const EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT   = -1006;
export const EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT = -1007;
export const EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT  = -1008;
export const EC_UPDATE_ENV_CHANGE_ONLY           = -1013;
export const EC_UPDATE_NEXT_SUNRISE_OR_SUNSET    = -1016;
export const EC_UPDATE_NEXT_MOONRISE_OR_MOONSET  = -1017;

// ============================================================================
// Types
// ============================================================================

/** Per-value animation state. */
export interface AnimatingValue {
    currentValue: number;
    targetValue: number;
    lastAnimationTime: number;   // performance.now() in ms
    animationStopTime: number;   // performance.now() in ms
    animating: boolean;
}

/** Create a fresh AnimatingValue initialized to the given value. */
export function makeAnimatingValue(initial: number, now: number): AnimatingValue {
    return {
        currentValue: initial,
        targetValue: initial,
        lastAnimationTime: now,
        animationStopTime: now,
        animating: false,
    };
}

/** Per-part state tracked by the animation system. */
export interface HandState {
    /** Reference to the XML part definition. */
    part: QHandPart | WheelPart | QWedgePart | CalendarRowCoverPart;
    /** The angle being animated. */
    angle: AnimatingValue;
    /** The offsetAngle being animated (only for offset-orbit hands like Moon). */
    offsetAngle: AnimatingValue | null;
    /** Update interval in milliseconds. */
    updateIntervalMs: number;
    /** Display-time ms-since-epoch of the next scheduled update.
     *  For positive intervals: next epoch-aligned boundary.
     *  For sentinels: next astronomical event time. */
    nextUpdateDisplayTime: number;
    /** performance.now() at which to wake the idle timer (derived from nextUpdateDisplayTime). */
    nextUpdateTime: number;
    /** Animation speed multiplier from XML (default 1.0). */
    animSpeed: number;
    /** Time source for expression evaluation (may be quantized by beatsPerSecond). */
    getNow: () => Date;
    /** Unquantized time source for boundary scheduling.
     *  Matches iOS architecture where update boundaries are computed in
     *  iPhone time (real time), not latched/quantized watch time. */
    rawGetNow: () => Date;
    /** X-axis linear motion (calendar day-indicator wires). */
    xMotion: AnimatingValue | null;
    /** Y-axis linear motion (calendar day-indicator wires). */
    yMotion: AnimatingValue | null;
}


// ============================================================================
// Initialization
// ============================================================================

/**
 * Build animation state for all dynamic parts in the watch.
 * Call once after the environment is set up.
 */
export function initHandStates(
    watch: Watch,
    env: Environment,
    now: number,  // performance.now()
    getNow?: () => Date,
    rawGetNow?: () => Date,
): HandState[] {
    const states: HandState[] = [];
    const effectiveGetNow = getNow || (() => new Date());
    const effectiveRawGetNow = rawGetNow || effectiveGetNow;
    collectDynamicParts(watch.parts, env, now, states, effectiveGetNow, effectiveRawGetNow);
    return states;
}

function collectDynamicParts(
    parts: WatchPart[],
    env: Environment,
    now: number,
    out: HandState[],
    getNow: () => Date,
    rawGetNow: () => Date,
): void {
    for (const part of parts) {
        if (part.type === 'QHand' || part.type === 'Wheel' || part.type === 'QWedge') {
            out.push(createHandState(part, env, now, getNow, rawGetNow));
        } else if (part.type === 'CalendarRowCover') {
            out.push(createCalendarCoverState(part as CalendarRowCoverPart, env, now, getNow, rawGetNow));
        } else if (part.type === 'Static') {
            collectDynamicParts(part.children, env, now, out, getNow, rawGetNow);
        }
    }
}

function createHandState(
    part: QHandPart | WheelPart | QWedgePart,
    env: Environment,
    now: number,
    getNow: () => Date,
    rawGetNow: () => Date,
): HandState {
    // Evaluate the update interval. Named sentinel constants evaluate to
    // negative values; numeric values are expression strings like "1" or "60".
    const updateIntervalSec = part.update ? evalAttr(part.update, env) : 1;
    const updateIntervalMs = updateIntervalSec * 1000;

    // animSpeed: default 1.0 (from original iOS boundsCheck default)
    const animSpeed = part.animSpeed ? evalAttr(part.animSpeed, env) : 1.0;

    // Evaluate initial angle and write to part's dynamicState
    const initialAngle = part.angle ? evalAttr(part.angle, env) : 0;
    // Evaluate initial offsetAngle if present (e.g. Moon orbit position)
    const hasOffsetAngle = (part.type === 'QHand' || part.type === 'QWedge') && part.offsetAngle;
    const initialOffsetAngle = hasOffsetAngle ? evalAttr(part.offsetAngle!, env) : 0;
    part.dynamicState = {
        currentAngle: initialAngle,
        ...(hasOffsetAngle ? { currentOffsetAngle: initialOffsetAngle } : {}),
    };
    // Evaluate initial xMotion/yMotion if present (calendar day-indicator wires)
    const hasXMotion = part.type === 'QHand' && part.xMotion;
    const hasYMotion = part.type === 'QHand' && part.yMotion;
    const initialXMotion = hasXMotion ? evalAttr((part as QHandPart).xMotion!, env) : 0;
    const initialYMotion = hasYMotion ? evalAttr((part as QHandPart).yMotion!, env) : 0;
    if (hasXMotion || hasYMotion) {
        part.dynamicState!.currentXMotion = initialXMotion;
        part.dynamicState!.currentYMotion = initialYMotion;
    }

    // Use raw (unquantized) time for boundary computation, matching iOS
    // where boundaries are computed in iPhone time, not latched watch time.
    const nextDisplayMs = computeNextBoundary(updateIntervalMs, rawGetNow, 1, env);

    return {
        part,
        angle: {
            currentValue: initialAngle,
            targetValue: initialAngle,
            lastAnimationTime: now,
            animationStopTime: now,
            animating: false,
        },
        offsetAngle: hasOffsetAngle ? {
            currentValue: initialOffsetAngle,
            targetValue: initialOffsetAngle,
            lastAnimationTime: now,
            animationStopTime: now,
            animating: false,
        } : null,
        xMotion: hasXMotion ? makeAnimatingValue(initialXMotion, now) : null,
        yMotion: hasYMotion ? makeAnimatingValue(initialYMotion, now) : null,
        updateIntervalMs,
        nextUpdateDisplayTime: nextDisplayMs,
        nextUpdateTime: displayTimeToPerfNow(nextDisplayMs, rawGetNow),
        animSpeed,
        getNow,
        rawGetNow,
    };
}

/**
 * Compute the xOffset for a CalendarRowCover part.
 * Ported from iOS calendarRowCoverOffsetForType / calendarRowUnderlayOffsetForType.
 *
 * Uses the hybrid Julian/Gregorian calendar system (via es-calendar.ts)
 * for first-of-month weekday and month-length calculations.
 */
function computeCalendarCoverOffset(
    part: CalendarRowCoverPart,
    env: Environment,
): number {
    const calendarWeekdayStart = env.functions.get('calendarWeekdayStart')?.() ?? 0;
    const cellWidth = env.variables.get('calendarCellWidth') ?? 13.3;

    const monthNum = (env.functions.get('monthNumber')?.() ?? 0) + 1;
    const yearNum = env.functions.get('yearNumber')?.() ?? 2024;
    const era = env.functions.get('eraNumber')?.() ?? 1;
    const absYear = yearNum;

    // First of this month: compute weekday via epoch arithmetic
    const firstOfMonthDI = timeIntervalFromUTCComponents(era, absYear, monthNum, 1, 12, 0, 0);
    const thisMonthStartCol = (7 + weekdayFromTimeInterval(firstOfMonthDI, 0) - calendarWeekdayStart) % 7;

    // Days in this month and previous month (hybrid calendar)
    const dim = calendarDaysInMonth(era, absYear, monthNum);
    // Previous month: handle January → December of prior year
    let prevEra = era;
    let prevYear = absYear;
    let prevMonth = monthNum - 1;
    if (prevMonth < 1) {
        prevMonth = 12;
        if (era === 1 && absYear === 1) {
            prevEra = 0; prevYear = 1;  // 1 CE - 1 = 1 BCE
        } else if (era === 0) {
            prevYear = absYear + 1;      // further into BCE
        } else {
            prevYear = absYear - 1;
        }
    }
    const daysInPrevMonth = calendarDaysInMonth(prevEra, prevYear, prevMonth);

    // Next month: compute weekday and start row
    let nextEra = era;
    let nextYear = absYear;
    let nextMonth = monthNum + 1;
    if (nextMonth > 12) {
        nextMonth = 1;
        if (era === 0 && absYear === 1) {
            nextEra = 1; nextYear = 1;  // 1 BCE + 1 = 1 CE
        } else if (era === 0) {
            nextYear = absYear - 1;      // towards CE
        } else {
            nextYear = absYear + 1;
        }
    }
    const nextMonthFirstDI = timeIntervalFromUTCComponents(nextEra, nextYear, nextMonth, 1, 12, 0, 0);
    const nextMonthStartCol = (7 + weekdayFromTimeInterval(nextMonthFirstDI, 0) - calendarWeekdayStart) % 7;
    const nextMonthStartRow = Math.floor((dim + thisMonthStartCol) / 7);

    const coverType = part.coverType || '';
    let columnMotion = 7;

    if (coverType === 'row1Left') {
        columnMotion = thisMonthStartCol + 22 - daysInPrevMonth;
        if (columnMotion < -4) columnMotion = -4;
    } else if (coverType === 'row1Right') {
        columnMotion = thisMonthStartCol + 26 - daysInPrevMonth;
        if (columnMotion < -5) columnMotion = -5;
    } else if (coverType === 'row56Right') {
        columnMotion = nextMonthStartRow === 4 ? nextMonthStartCol : 7;
    } else if (coverType === 'row6Left') {
        if (nextMonthStartRow === 5) {
            columnMotion = nextMonthStartCol;
        } else if (nextMonthStartRow === 4) {
            columnMotion = nextMonthStartCol - 7;
        } else {
            columnMotion = 7;
        }
    }

    return Math.round(columnMotion * cellWidth);
}

/**
 * Create animation state for a CalendarRowCover part.
 * These parts animate via xMotion (horizontal sliding) — no angle.
 */
function createCalendarCoverState(
    part: CalendarRowCoverPart,
    env: Environment,
    now: number,
    getNow: () => Date,
    rawGetNow: () => Date,
): HandState {
    const updateIntervalSec = part.update ? evalAttr(part.update, env) : 3600;
    const updateIntervalMs = updateIntervalSec * 1000;
    const animSpeed = part.animSpeed ? evalAttr(part.animSpeed, env) : 1.0;

    const initialXOffset = computeCalendarCoverOffset(part, env);

    part.dynamicState = {
        currentAngle: 0,
        currentXMotion: initialXOffset,
    };

    // Use raw (unquantized) time for boundary computation
    const nextDisplayMs = computeNextBoundary(updateIntervalMs, rawGetNow, 1, env);

    return {
        part,
        angle: makeAnimatingValue(0, now),
        offsetAngle: null,
        xMotion: makeAnimatingValue(initialXOffset, now),
        yMotion: null,
        updateIntervalMs,
        nextUpdateDisplayTime: nextDisplayMs,
        nextUpdateTime: displayTimeToPerfNow(nextDisplayMs, rawGetNow),
        animSpeed,
        getNow,
        rawGetNow,
    };
}

// ============================================================================
// Per-frame update
// ============================================================================

/**
 * Tick all hand animations for one frame.
 * Call this from requestAnimationFrame before rendering.
 *
 * @param tickIntervalMs  When non-null, indicates quantized mode.
 *   The animation system uses this to:
 *   - Compress fast-part animations to fit within one tick
 *   - Schedule slow-part re-evaluation to skip unnecessary ticks
 * @param displayDeltaPerTickSec  Display seconds advanced per tick (e.g. 3600 for 10hr/s).
 *   Only used when tickIntervalMs is non-null.
 *
 * Updates each part's `dynamicState.currentAngle` in place.
 */
export function tickAnimations(
    states: HandState[],
    env: Environment,
    now: number,   // performance.now()
    tickIntervalMs: number | null = null,
    displayDeltaPerTickSec: number = 0,
    timeDirection: 1 | -1 = 1,
): void {
    for (const state of states) {
        // Gate on performance.now() — this handles reset (nextUpdateTime=0 → immediate)
        // and freeze (nextUpdateTime=Infinity → never) direction-agnostically.
        // The display-time boundary is used to COMPUTE nextUpdateTime, not as the gate.
        if (now >= state.nextUpdateTime) {
            const newTarget = ('angle' in state.part && state.part.angle)
                ? evalAttr(state.part.angle, env)
                : 0;

            // Also evaluate offsetAngle if this hand has one
            const newOffsetTarget = state.offsetAngle && (state.part.type === 'QHand' || state.part.type === 'QWedge') && state.part.offsetAngle
                ? evalAttr(state.part.offsetAngle!, env)
                : null;

            // Compute the next boundary BEFORE starting animations
            // (so we know the time budget for compression)
            // Use rawGetNow for boundary computation — matches iOS where
            // boundaries are computed in iPhone time, not latched watch time.
            const nextDisplayMs = computeNextBoundary(state.updateIntervalMs, state.rawGetNow, timeDirection, env);

            if (tickIntervalMs !== null && tickIntervalMs > 0) {
                // --- Quantized mode ---
                // Compute real-time budget until next boundary for animation compression.
                // The display-time delta is converted to real-time via the tick rate.
                const displayNowMs = state.getNow().getTime();
                const displayDeltaMs = Math.abs(nextDisplayMs - displayNowMs);
                const displayDeltaPerTickMs = displayDeltaPerTickSec * 1000;
                const ticksUntilUpdate = displayDeltaPerTickMs > 0
                    ? Math.max(1, Math.ceil(displayDeltaMs / displayDeltaPerTickMs))
                    : 1;
                const timeUntilNextUpdateMs = ticksUntilUpdate * tickIntervalMs;

                // Adaptive duration: use normal speed unless it wouldn't
                // finish before the next re-evaluation.
                // Angle and offsetAngle are compressed INDEPENDENTLY so that
                // e.g. a slow wedge flip doesn't get compressed just because
                // the offset (ring tracking) needs compression.
                const animateSpeed = kECGLAngleAnimationSpeed * state.animSpeed;

                // Angle duration
                const normalizedTarget = fmod(newTarget, 2 * Math.PI);
                const normalizedCurrent = fmod(state.angle.currentValue, 2 * Math.PI);
                let angleDelta = Math.abs(normalizedTarget - normalizedCurrent);
                if (angleDelta > Math.PI) angleDelta = 2 * Math.PI - angleDelta;
                const angleDurationMs = (animateSpeed > 0)
                    ? (angleDelta / animateSpeed) * 1000
                    : 0;

                // Compress angle if needed, otherwise use natural speed
                if (angleDurationMs > timeUntilNextUpdateMs) {
                    startAnimation(state, newTarget, now, timeUntilNextUpdateMs);
                } else {
                    startAnimation(state, newTarget, now);
                }

                // Handle offsetAngle independently
                if (newOffsetTarget !== null && state.offsetAngle) {
                    const normOffTarget = fmod(newOffsetTarget, 2 * Math.PI);
                    const normOffCurrent = fmod(state.offsetAngle.currentValue, 2 * Math.PI);
                    let offDelta = Math.abs(normOffTarget - normOffCurrent);
                    if (offDelta > Math.PI) offDelta = 2 * Math.PI - offDelta;
                    const offsetDurationMs = (animateSpeed > 0)
                        ? (offDelta / animateSpeed) * 1000
                        : 0;

                    if (offsetDurationMs > timeUntilNextUpdateMs) {
                        startAnimationRaw(state.offsetAngle, newOffsetTarget, now, state.animSpeed, timeUntilNextUpdateMs);
                    } else {
                        startAnimationRaw(state.offsetAngle, newOffsetTarget, now, state.animSpeed);
                    }
                }

                // Compress xMotion/yMotion in quantized mode
                compressLinearMotions(state, env, now, timeUntilNextUpdateMs);

                // Schedule next re-evaluation (also update perfNow for idle timer)
                state.nextUpdateDisplayTime = nextDisplayMs;
                state.nextUpdateTime = now + timeUntilNextUpdateMs;
            } else {
                // --- 1× mode (normal) ---
                startAnimation(state, newTarget, now);
                if (newOffsetTarget !== null && state.offsetAngle) {
                    startAnimationRaw(state.offsetAngle, newOffsetTarget, now, state.animSpeed);
                }

                // Evaluate xMotion/yMotion at natural speed
                evaluateLinearMotions(state, env, now);

                state.nextUpdateDisplayTime = nextDisplayMs;
                state.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, state.rawGetNow);
            }
        }

        // Interpolate if animating (uses real time for smooth rendering)
        const rawAngle = interpolateValue(state.angle, now);
        const angle = state.angle.animating ? rawAngle : fmod(rawAngle, 2 * Math.PI);

        // Write to part's dynamicState
        if (!state.part.dynamicState) {
            state.part.dynamicState = { currentAngle: angle };
        } else {
            state.part.dynamicState.currentAngle = angle;
        }

        // Interpolate offsetAngle if present
        if (state.offsetAngle) {
            const rawOA = interpolateValue(state.offsetAngle, now);
            const oa = state.offsetAngle.animating ? rawOA : fmod(rawOA, 2 * Math.PI);
            if (state.part.dynamicState) {
                state.part.dynamicState.currentOffsetAngle = oa;
            }
        }

        // Interpolate xMotion/yMotion if present (linear, no angle wrapping)
        if (state.xMotion) {
            const xm = interpolateValue(state.xMotion, now);
            if (state.part.dynamicState) {
                state.part.dynamicState.currentXMotion = xm;
            }
        }
        if (state.yMotion) {
            const ym = interpolateValue(state.yMotion, now);
            if (state.part.dynamicState) {
                state.part.dynamicState.currentYMotion = ym;
            }
        }
    }
}

// ============================================================================
// Scheduler helpers
// ============================================================================

/**
 * Returns the performance.now() time of the next scheduled hand update,
 * across all hand states. Used by the scheduler to set an idle setTimeout.
 */
export function nextWakeupTime(states: HandState[]): number {
    let earliest = Infinity;
    for (const s of states) {
        if (s.nextUpdateTime < earliest) earliest = s.nextUpdateTime;
    }
    return earliest;
}

/**
 * Returns true if any hand is currently mid-animation.
 * When this is true the scheduler should keep calling requestAnimationFrame.
 */
export function anyAnimating(states: HandState[]): boolean {
    for (const s of states) {
        if (s.angle.animating) return true;
        if (s.offsetAngle && s.offsetAngle.animating) return true;
        if (s.xMotion && s.xMotion.animating) return true;
        if (s.yMotion && s.yMotion.animating) return true;
    }
    return false;
}

/**
 * Snap all in-flight animations to their target values immediately,
 * and freeze all schedules so no re-evaluation happens while stopped.
 * Call this when pausing so hands don't freeze mid-sweep.
 */
export function finishAnimations(states: HandState[]): void {
    for (const s of states) {
        const val = s.angle;
        if (val.animating) {
            val.currentValue = fmod(val.targetValue, 2 * Math.PI);
            val.animating = false;
            if (s.part.dynamicState) {
                s.part.dynamicState.currentAngle = val.currentValue;
            }
        }
        if (s.offsetAngle && s.offsetAngle.animating) {
            s.offsetAngle.currentValue = fmod(s.offsetAngle.targetValue, 2 * Math.PI);
            s.offsetAngle.animating = false;
            if (s.part.dynamicState) {
                s.part.dynamicState.currentOffsetAngle = s.offsetAngle.currentValue;
            }
        }
        if (s.xMotion && s.xMotion.animating) {
            s.xMotion.currentValue = s.xMotion.targetValue;
            s.xMotion.animating = false;
            if (s.part.dynamicState) {
                s.part.dynamicState.currentXMotion = s.xMotion.currentValue;
            }
        }
        if (s.yMotion && s.yMotion.animating) {
            s.yMotion.currentValue = s.yMotion.targetValue;
            s.yMotion.animating = false;
            if (s.part.dynamicState) {
                s.part.dynamicState.currentYMotion = s.yMotion.currentValue;
            }
        }
        // Prevent the scheduler from re-evaluating while stopped
        s.nextUpdateDisplayTime = Infinity;
        s.nextUpdateTime = Infinity;
    }
}

/**
 * Unfreeze hand schedules so expressions re-evaluate on the very next frame.
 * Call when resuming playback after a finishAnimations() pause.
 */
export function resetHandSchedules(states: HandState[]): void {
    for (const s of states) {
        s.nextUpdateDisplayTime = 0;
        s.nextUpdateTime = 0;
    }
}

// ============================================================================
// Animation logic (ported from ECGLPart.m)
// ============================================================================

/**
 * Start (or restart) an animation from the current position to a new target.
 *
 * @param durationOverrideMs  When provided, use this fixed duration instead of
 *   computing from angular distance / animation speed. Used for tick-interval
 *   compression and single-tap steps.
 */
function startAnimation(
    state: HandState,
    newTarget: number,
    now: number,
    durationOverrideMs?: number,
): void {
    startAnimationRaw(state.angle, newTarget, now, state.animSpeed, durationOverrideMs);
}

/**
 * Snap a hand directly to a target angle with no animation.
 * Used for parts with dragAnimationType != 'dragAnimationAlways' during scrub.
 */
function snapToTarget(state: HandState, newTarget: number): void {
    const normalized = fmod(newTarget, 2 * Math.PI);
    state.angle.currentValue = normalized;
    state.angle.targetValue = normalized;
    state.angle.animating = false;
    if (!state.part.dynamicState) {
        state.part.dynamicState = { currentAngle: normalized };
    } else {
        state.part.dynamicState.currentAngle = normalized;
    }
}

/** Snap an AnimatingValue directly to a target with no animation. */
function snapToTargetRaw(val: AnimatingValue, newTarget: number): void {
    const normalized = fmod(newTarget, 2 * Math.PI);
    val.currentValue = normalized;
    val.targetValue = normalized;
    val.animating = false;
}

// ============================================================================
// Core animation (semantics-free)
// ============================================================================

/**
 * Core animation start — operates on abstract values without angle/linear
 * semantics.  Callers handle any normalization (e.g. angle wrapping) before
 * invoking this function.
 *
 * @param speed  Units per second (radians/s for angles, pixels/s for linear).
 * @param durationOverrideMs  When provided, use this fixed duration instead of
 *   computing from distance / speed.  Used for tick-interval compression.
 */
function startValueAnimation(
    val: AnimatingValue,
    newTarget: number,
    now: number,
    speed: number,
    durationOverrideMs?: number,
): void {
    if (speed === 0) {
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    // If already animating toward this same target, let it continue
    if (val.animating && val.targetValue === newTarget) return;

    // If mid-animation toward a DIFFERENT target, snapshot current position
    if (val.animating) {
        interpolateValue(val, now);
    }

    if (val.currentValue === newTarget) {
        val.animating = false;
        return;
    }

    val.targetValue = newTarget;

    // Compute animation duration
    const delta = Math.abs(newTarget - val.currentValue);
    const durationMs = durationOverrideMs ?? (delta / speed) * 1000;

    if (durationMs < kECGLFrameRate * 1000) {
        val.currentValue = newTarget;
        val.animating = false;
        return;
    }

    val.lastAnimationTime = now;
    val.animating = true;
    val.animationStopTime = now + durationMs;
}

/**
 * Core interpolation — operates on abstract values.
 * Exported for use by the terminator leaf animation system.
 */
export function interpolateValue(val: AnimatingValue, now: number): number {
    if (!val.animating) {
        return val.currentValue;
    }

    if (now >= val.animationStopTime) {
        val.animating = false;
        val.currentValue = val.targetValue;
        return val.currentValue;
    }

    const fraction = (now - val.lastAnimationTime) / (val.animationStopTime - val.lastAnimationTime);
    val.currentValue += (val.targetValue - val.currentValue) * fraction;
    val.lastAnimationTime = now;
    return val.currentValue;
}

// ============================================================================
// Angle animation (wraps to [0, 2π))
// ============================================================================

/**
 * Start an angle animation.  Normalizes the target to [0, 2π) and unwraps
 * currentValue for the shortest angular path, then delegates to the core.
 * Exported for use by the terminator leaf animation system.
 */
export function startAnimationRaw(
    val: AnimatingValue,
    newTarget: number,
    now: number,
    animSpeed: number = 1.0,
    durationOverrideMs?: number,
): void {
    const speed = kECGLAngleAnimationSpeed * animSpeed;

    // Normalize target to [0, 2π)
    newTarget = fmod(newTarget, 2 * Math.PI);

    if (speed === 0) {
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    if (val.animating && val.targetValue === newTarget) return;
    if (val.animating) { interpolateValue(val, now); }
    if (val.currentValue === newTarget) { val.animating = false; return; }

    // Unwrap currentValue so |currentValue - targetValue| ≤ π.
    // This avoids the animation flipping direction when crossing 0°/360°.
    const TWO_PI = 2 * Math.PI;
    let delta = newTarget - val.currentValue;
    delta = delta - TWO_PI * Math.round(delta / TWO_PI);
    val.currentValue = newTarget - delta;

    startValueAnimation(val, newTarget, now, speed, durationOverrideMs);
}

/**
 * Interpolate an angle AnimatingValue.  Wraps result to [0, 2π) on completion.
 * Legacy export — new code should use interpolateValue + fmod.
 */
export function interpolateRaw(val: AnimatingValue, now: number): number {
    const result = interpolateValue(val, now);
    return val.animating ? result : fmod(result, 2 * Math.PI);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute the next display-time boundary for any part.
 * Returns ms-since-epoch in display time.
 *
 * For positive intervals, returns the next epoch-aligned boundary.
 * For negative sentinel values, delegates to resolveSentinel().
 */
function computeNextBoundary(
    updateIntervalMs: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
    env: Environment,
): number {
    if (updateIntervalMs > 0) {
        // Positive interval — epoch-aligned boundary in display time.
        // Shift by the timezone offset so that daily (86400s) boundaries
        // fall at LOCAL midnight instead of UTC midnight.
        // iOS: ECDynamicUpdate.m line 192 subtracts tzOffset in the alignment.
        const tzOffsetMs = (env.tzOffsetSec ?? 0) * 1000;
        const displayNowMs = getNow().getTime();
        const localNowMs = displayNowMs + tzOffsetMs;  // shift to local
        if (timeDirection === -1) {
            // Time flows backward: find the previous boundary
            const localBoundary = Math.floor(localNowMs / updateIntervalMs) * updateIntervalMs;
            const boundary = (localBoundary === localNowMs
                ? localBoundary - updateIntervalMs
                : localBoundary) - tzOffsetMs;
            return boundary;
        } else {
            const localBoundary = Math.ceil(localNowMs / updateIntervalMs) * updateIntervalMs;
            return localBoundary - tzOffsetMs;  // shift back to UTC
        }
    }

    // Sentinel value — convert from ms back to the original constant
    const sentinel = updateIntervalMs / 1000;
    const eventDI = resolveSentinel(sentinel, getNow, env, timeDirection);

    if (!isFinite(eventDI)) {
        // envChangeOnly or unknown — return Infinity (far future in display time)
        return Infinity;
    }

    // Convert dateInterval (Apple epoch sec) to ms-since-epoch (JS Date.getTime())
    return (eventDI + 978307200) * 1000;
}

/**
 * Convert a display-time ms-since-epoch boundary to performance.now().
 * Used to set the idle-timer wakeup.
 */
function displayTimeToPerfNow(displayTimeMs: number, getNow: () => Date): number {
    if (!isFinite(displayTimeMs)) return Infinity;
    const deltaMs = Math.abs(displayTimeMs - getNow().getTime());
    return performance.now() + deltaMs;
}

// ============================================================================
// Sentinel scheduling — astronomical event boundary computation
// ============================================================================

/** Fudge factor: 5 seconds to avoid retriggering on exact boundaries. */
const SENTINEL_FUDGE_SECONDS = 5;

/** Lookahead: 13.2 hours (matching iOS). */
const SENTINEL_LOOKAHEAD_SECONDS = 3600 * 13.2;

/**
 * Find the next rise or set event for a planet, searching in the direction
 * time is flowing. Returns a dateInterval, or NaN if no event found.
 *
 * Ports iOS ECAstronomy nextPrevRiseSetInternal + nextPrevPlanetRiseSetForPlanet.
 * The iOS "runningBackward XOR nextNotPrev" pattern simplifies here because
 * sentinel scheduling always requests "next in the direction of flow", so
 * searchForward = (timeDirection === 1).
 */
function nextPlanetRiseSet(
    riseNotSet: boolean,
    planetNumber: ECPlanetNumber,
    getNow: () => Date,
    lat: number,
    lon: number,
    timeDirection: 1 | -1,
): number {
    const calculationDI = dateToDateInterval(getNow());
    const searchForward = timeDirection === 1;

    // Fudge to avoid retriggering on the exact boundary
    const fudge = searchForward ? SENTINEL_FUDGE_SECONDS : -SENTINEL_FUDGE_SECONDS;
    const lookahead = searchForward ? SENTINEL_LOOKAHEAD_SECONDS : -SENTINEL_LOOKAHEAD_SECONDS;
    const fudgeDate = calculationDI + fudge;

    // Create a temporary cache pool for the rise/set calculation
    const pool = new AstroCachePool();
    initializeCachePool(pool, fudgeDate, lat, lon, !searchForward);

    try {
        // First attempt: search from fudged date
        const result = planetaryRiseSetTimeRefined(
            fudgeDate, lat, lon, riseNotSet, planetNumber, NaN, pool,
        );

        if (isNoRiseSet(result.riseSetTime)) {
            // Object is always above or below horizon — no event
            return NaN;
        }

        // Check if the transit time is in the right direction
        // (iOS: nextPrevRiseSetInternalWithFudgeInterval lines 2335-2337)
        const inRightDirection = searchForward
            ? result.transitTime >= fudgeDate
            : result.transitTime < fudgeDate;

        if (inRightDirection) {
            return result.riseSetTime;
        }

        // Not found on first try — search from 13.2 hours away
        const tryDate = fudgeDate + lookahead;
        releaseCachePool(pool);
        initializeCachePool(pool, tryDate, lat, lon, !searchForward);

        const result2 = planetaryRiseSetTimeRefined(
            tryDate, lat, lon, riseNotSet, planetNumber, NaN, pool,
        );

        if (isNoRiseSet(result2.riseSetTime)) {
            return NaN;
        }

        return result2.riseSetTime;
    } finally {
        releaseCachePool(pool);
    }
}

/**
 * Clamp an event time to midnight: return the earlier of the event
 * or the next local midnight (in the direction time is flowing).
 * All times are dateIntervals (Apple epoch seconds).
 *
 * Ports iOS ECAstronomy nextOrMidnightForDateInterval.
 */
function nextOrMidnight(
    eventDI: number,
    getNow: () => Date,
    tzOffsetSec: number,
    timeDirection: 1 | -1,
): number {
    if (isNaN(eventDI)) {
        // No event found — return midnight as fallback
        return nextMidnightDI(getNow, tzOffsetSec, timeDirection);
    }

    const nowDI = dateToDateInterval(getNow());

    // Compute today's local midnight (start of day) in dateInterval space.
    // Add timezone offset to get local time, floor to day, subtract tz offset.
    const localNowSec = nowDI + tzOffsetSec;
    const dayStartLocal = Math.floor(localNowSec / 86400) * 86400;
    const todayMidnightDI = dayStartLocal - tzOffsetSec;

    if (timeDirection === -1) {
        // Backward: "next midnight" = today's midnight (start of current day).
        // If event is before that, return the midnight instead.
        if (eventDI < todayMidnightDI) {
            return todayMidnightDI;
        }
    } else {
        // Forward: next midnight = today's midnight + 1 day.
        const tomorrowMidnightDI = todayMidnightDI + 86400;
        if (eventDI > tomorrowMidnightDI) {
            return tomorrowMidnightDI;
        }
    }

    return eventDI;
}

/**
 * Compute the dateInterval of the next local midnight in the direction
 * time is flowing. Used as a fallback when no astronomical event is found.
 */
function nextMidnightDI(
    getNow: () => Date,
    tzOffsetSec: number,
    timeDirection: 1 | -1,
): number {
    const nowDI = dateToDateInterval(getNow());
    const localNowSec = nowDI + tzOffsetSec;
    const dayStartLocal = Math.floor(localNowSec / 86400) * 86400;
    const todayMidnightDI = dayStartLocal - tzOffsetSec;

    if (timeDirection === -1) {
        return todayMidnightDI;
    } else {
        return todayMidnightDI + 86400;
    }
}

/**
 * Resolve a sentinel constant to its next display-time event.
 * Returns a dateInterval (Apple epoch seconds), or Infinity for envChangeOnly.
 *
 * Ports iOS ECDynamicUpdate getUpdateCalculatorForInterval dispatch table.
 */
function resolveSentinel(
    sentinel: number,
    getNow: () => Date,
    env: Environment,
    timeDirection: 1 | -1,
): number {
    const lat = env.observerLatRad ?? 0;
    const lon = env.observerLonRad ?? 0;
    const tzOff = env.tzOffsetSec ?? 0;

    switch (sentinel) {
        // Bare rise/set (no midnight clamp)
        case EC_UPDATE_NEXT_SUNRISE:
            return nextPlanetRiseSet(true, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
        case EC_UPDATE_NEXT_SUNSET:
            return nextPlanetRiseSet(false, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
        case EC_UPDATE_NEXT_MOONRISE:
            return nextPlanetRiseSet(true, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);
        case EC_UPDATE_NEXT_MOONSET:
            return nextPlanetRiseSet(false, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);

        // Rise/set clamped to midnight
        case EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(true, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );
        case EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(false, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );
        case EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(true, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );
        case EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT:
            return nextOrMidnight(
                nextPlanetRiseSet(false, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection),
                getNow, tzOff, timeDirection,
            );

        // Combined: whichever comes first in the direction of flow
        case EC_UPDATE_NEXT_SUNRISE_OR_SUNSET: {
            const rise = nextPlanetRiseSet(true, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
            const set = nextPlanetRiseSet(false, ECPlanetNumber.Sun, getNow, lat, lon, timeDirection);
            return closerInTimeDirection(rise, set, timeDirection);
        }
        case EC_UPDATE_NEXT_MOONRISE_OR_MOONSET: {
            const rise = nextPlanetRiseSet(true, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);
            const set = nextPlanetRiseSet(false, ECPlanetNumber.Moon, getNow, lat, lon, timeDirection);
            return closerInTimeDirection(rise, set, timeDirection);
        }

        // Environment change only — effectively never (only explicit reset)
        case EC_UPDATE_ENV_CHANGE_ONLY:
            return Infinity;

        default:
            console.warn(`Unknown update sentinel: ${sentinel}, defaulting to daily`);
            return nextMidnightDI(getNow, tzOff, timeDirection);
    }
}

/**
 * Return whichever event is closer in the direction time is flowing.
 * Forward: min. Backward: max. Handles NaN (no-event) gracefully.
 */
function closerInTimeDirection(a: number, b: number, timeDirection: 1 | -1): number {
    if (isNaN(a)) return b;
    if (isNaN(b)) return a;
    return timeDirection === 1 ? Math.min(a, b) : Math.max(a, b);
}

/** Floating-point modulo that always returns a non-negative result. */
function fmod(value: number, modulus: number): number {
    const result = value % modulus;
    return result < 0 ? result + modulus : result;
}

// ============================================================================
// Linear animation helpers
// ============================================================================

/**
 * Start a linear animation (no angle wrapping) for xMotion/yMotion.
 * Delegates to the core startValueAnimation with linear speed.
 */
function startLinearAnimation(
    val: AnimatingValue,
    newTarget: number,
    now: number,
    animSpeed: number = 1.0,
    durationOverrideMs?: number,
): void {
    startValueAnimation(val, newTarget, now, kECGLLinearAnimationSpeed * animSpeed, durationOverrideMs);
}

/**
 * Evaluate and start linear motions (xMotion/yMotion) for QHand and
 * CalendarRowCover parts at natural speed (1× mode).
 */
function evaluateLinearMotions(
    state: HandState,
    env: Environment,
    now: number,
): void {
    if (state.part.type === 'QHand') {
        const qhand = state.part as QHandPart;
        if (state.xMotion && qhand.xMotion) {
            startLinearAnimation(state.xMotion, evalAttr(qhand.xMotion, env), now, state.animSpeed);
        }
        if (state.yMotion && qhand.yMotion) {
            startLinearAnimation(state.yMotion, evalAttr(qhand.yMotion, env), now, state.animSpeed);
        }
    }
    if (state.part.type === 'CalendarRowCover' && state.xMotion) {
        const newXM = computeCalendarCoverOffset(state.part as CalendarRowCoverPart, env);
        startLinearAnimation(state.xMotion, newXM, now, state.animSpeed);
    }
}

/**
 * Evaluate and start linear motions with quantized-mode compression.
 * If the natural duration exceeds the time budget, compress to fit.
 */
function compressLinearMotions(
    state: HandState,
    env: Environment,
    now: number,
    timeUntilNextUpdateMs: number,
): void {
    const linearSpeed = kECGLLinearAnimationSpeed * state.animSpeed;

    const compressLinear = (val: AnimatingValue, newTarget: number) => {
        const naturalMs = linearSpeed > 0
            ? (Math.abs(newTarget - val.currentValue) / linearSpeed) * 1000
            : 0;
        const overrideMs = naturalMs > timeUntilNextUpdateMs ? timeUntilNextUpdateMs : undefined;
        startLinearAnimation(val, newTarget, now, state.animSpeed, overrideMs);
    };

    if (state.part.type === 'QHand') {
        const qhand = state.part as QHandPart;
        if (state.xMotion && qhand.xMotion) {
            compressLinear(state.xMotion, evalAttr(qhand.xMotion, env));
        }
        if (state.yMotion && qhand.yMotion) {
            compressLinear(state.yMotion, evalAttr(qhand.yMotion, env));
        }
    }
    if (state.part.type === 'CalendarRowCover' && state.xMotion) {
        compressLinear(state.xMotion, computeCalendarCoverOffset(state.part as CalendarRowCoverPart, env));
    }
}
