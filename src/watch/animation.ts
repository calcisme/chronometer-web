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

// Constants used by the scheduler
export const SCHEDULER_LOOKAHEAD_MS = 50; // arm setTimeout this many ms early to avoid skipping boundaries

// ============================================================================
// Constants (from ECConstants.h)
// ============================================================================

/** Base angular animation speed (radians per second). */
const kECGLAngleAnimationSpeed = 2.0;

/** Minimum animation duration; below this, snap directly. */
const kECGLFrameRate = 1.0 / 240;

// --- Named update interval sentinels (matching iOS ECConstants.h) ---
// Negative values that the animation system interprets specially.
export const EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT  = -1005;
export const EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT   = -1006;
export const EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT = -1007;
export const EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT  = -1008;
export const EC_UPDATE_ENV_CHANGE_ONLY           = -1013;

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
    part: QHandPart | WheelPart | QWedgePart;
    /** The angle being animated. */
    angle: AnimatingValue;
    /** The offsetAngle being animated (only for offset-orbit hands like Moon). */
    offsetAngle: AnimatingValue | null;
    /** Update interval in milliseconds. */
    updateIntervalMs: number;
    /** Next time to re-evaluate the expression (performance.now()). */
    nextUpdateTime: number;
    /** Animation speed multiplier from XML (default 1.0). */
    animSpeed: number;
    /** Time source for scheduling aligned updates. */
    getNow: () => Date;
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
): HandState[] {
    const states: HandState[] = [];
    collectDynamicParts(watch.parts, env, now, states, getNow || (() => new Date()));
    return states;
}

function collectDynamicParts(
    parts: WatchPart[],
    env: Environment,
    now: number,
    out: HandState[],
    getNow: () => Date,
): void {
    for (const part of parts) {
        if (part.type === 'QHand' || part.type === 'Wheel' || part.type === 'QWedge') {
            out.push(createHandState(part, env, now, getNow));
        } else if (part.type === 'CalendarRowCover') {
            out.push(createCalendarCoverState(part as CalendarRowCoverPart, env, now, getNow));
        } else if (part.type === 'Static') {
            collectDynamicParts(part.children, env, now, out, getNow);
        }
    }
}

function createHandState(
    part: QHandPart | WheelPart | QWedgePart,
    env: Environment,
    now: number,
    getNow: () => Date,
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
        nextUpdateTime: scheduleNextUpdate(updateIntervalMs, getNow),
        animSpeed,
        getNow,
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
): HandState {
    const updateIntervalSec = part.update ? evalAttr(part.update, env) : 3600;
    const updateIntervalMs = updateIntervalSec * 1000;
    const animSpeed = part.animSpeed ? evalAttr(part.animSpeed, env) : 1.0;

    const initialXOffset = computeCalendarCoverOffset(part, env);

    part.dynamicState = {
        currentAngle: 0,
        currentXMotion: initialXOffset,
    };

    return {
        part,
        angle: makeAnimatingValue(0, now),
        offsetAngle: null,
        xMotion: makeAnimatingValue(initialXOffset, now),
        yMotion: null,
        updateIntervalMs,
        nextUpdateTime: scheduleNextUpdate(updateIntervalMs, getNow),
        animSpeed,
        getNow,
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
        // Check if it's time to re-evaluate
        if (now >= state.nextUpdateTime) {
            const newTarget = state.part.angle
                ? evalAttr(state.part.angle, env)
                : 0;

            // Also evaluate offsetAngle if this hand has one
            const newOffsetTarget = state.offsetAngle && (state.part.type === 'QHand' || state.part.type === 'QWedge') && state.part.offsetAngle
                ? evalAttr(state.part.offsetAngle!, env)
                : null;

            if (tickIntervalMs !== null && tickIntervalMs > 0) {
                // --- Quantized mode ---
                // Compute how many ticks until this part's next re-evaluation
                let ticksUntilUpdate = 1;
                if (displayDeltaPerTickSec > 0 && state.updateIntervalMs > 0) {
                    const updateIntervalSec = state.updateIntervalMs / 1000;
                    ticksUntilUpdate = Math.max(1, Math.ceil(updateIntervalSec / displayDeltaPerTickSec));
                }
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

                // Schedule next re-evaluation
                state.nextUpdateTime = now + timeUntilNextUpdateMs;
            } else {
                // --- 1× mode (normal) ---
                startAnimation(state, newTarget, now);
                if (newOffsetTarget !== null && state.offsetAngle) {
                    startAnimationRaw(state.offsetAngle, newOffsetTarget, now, state.animSpeed);
                }
                state.nextUpdateTime = scheduleNextUpdate(state.updateIntervalMs, state.getNow, timeDirection);
            }

            // Evaluate xMotion/yMotion (QHand day-indicator wires)
            if (state.part.type === 'QHand') {
                const qhand = state.part as QHandPart;
                if (state.xMotion && qhand.xMotion) {
                    const newXM = evalAttr(qhand.xMotion, env);
                    startLinearAnimation(state.xMotion, newXM, now, state.animSpeed);
                }
                if (state.yMotion && qhand.yMotion) {
                    const newYM = evalAttr(qhand.yMotion, env);
                    startLinearAnimation(state.yMotion, newYM, now, state.animSpeed);
                }
            }
            // CalendarRowCover xMotion — recompute offset from current month
            if (state.part.type === 'CalendarRowCover' && state.xMotion) {
                const newXM = computeCalendarCoverOffset(state.part as CalendarRowCoverPart, env);
                startLinearAnimation(state.xMotion, newXM, now, state.animSpeed);
            }
        }

        // Interpolate if animating (uses real time for smooth rendering)
        const angle = interpolate(state.angle, now);

        // Write to part's dynamicState
        if (!state.part.dynamicState) {
            state.part.dynamicState = { currentAngle: angle };
        } else {
            state.part.dynamicState.currentAngle = angle;
        }

        // Interpolate offsetAngle if present
        if (state.offsetAngle) {
            const oa = interpolateRaw(state.offsetAngle, now);
            if (state.part.dynamicState) {
                state.part.dynamicState.currentOffsetAngle = oa;
            }
        }

        // Interpolate xMotion/yMotion if present (linear, no angle wrapping)
        if (state.xMotion) {
            const xm = interpolateLinear(state.xMotion, now);
            if (state.part.dynamicState) {
                state.part.dynamicState.currentXMotion = xm;
            }
        }
        if (state.yMotion) {
            const ym = interpolateLinear(state.yMotion, now);
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
        s.nextUpdateTime = Infinity;
    }
}

/**
 * Unfreeze hand schedules so expressions re-evaluate on the very next frame.
 * Call when resuming playback after a finishAnimations() pause.
 */
export function resetHandSchedules(states: HandState[]): void {
    for (const s of states) {
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

/**
 * Core animation start logic, usable by any AnimatingValue.
 * Exported for use by the terminator leaf animation system.
 */
export function startAnimationRaw(
    val: AnimatingValue,
    newTarget: number,
    now: number,
    animSpeed: number = 1.0,
    durationOverrideMs?: number,
): void {
    const animateSpeed = kECGLAngleAnimationSpeed * animSpeed;

    // Normalize target to [0, 2π)
    newTarget = fmod(newTarget, 2 * Math.PI);

    if (animateSpeed === 0 || animSpeed === 0) {
        // No animation — snap directly
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    // If already animating toward this same target, let it continue
    if (val.animating && val.targetValue === newTarget) {
        return;
    }

    // If mid-animation toward a DIFFERENT target, snapshot current position
    if (val.animating) {
        interpolateRaw(val, now);
    }

    if (val.currentValue === newTarget) {
        val.animating = false;
        return;
    }

    val.targetValue = newTarget;

    // Unwrap currentValue so |currentValue - targetValue| ≤ π.
    // This avoids the animation flipping direction when crossing 0°/360°.
    // In both normal and compressed modes, we want the shortest angular path.
    const TWO_PI = 2 * Math.PI;
    let delta = newTarget - val.currentValue;
    // Normalize delta to [-π, π]
    delta = delta - TWO_PI * Math.round(delta / TWO_PI);
    // Set currentValue so that (currentValue + delta) == newTarget
    val.currentValue = newTarget - delta;

    // Compute animation duration
    let durationMs: number;
    if (durationOverrideMs !== undefined) {
        durationMs = durationOverrideMs;
    } else {
        const deltaTime = Math.abs(val.targetValue - val.currentValue) / animateSpeed;
        durationMs = deltaTime * 1000;
    }

    if (durationMs < kECGLFrameRate * 1000) {
        // Too small to animate — snap
        val.currentValue = val.targetValue;
        val.animating = false;
        return;
    }

    // Start (or restart) animation from current position
    val.lastAnimationTime = now;
    val.animating = true;
    val.animationStopTime = now + durationMs;
}

function interpolate(val: AnimatingValue, now: number): number {
    return interpolateRaw(val, now);
}

/**
 * Core interpolation logic, usable by any AnimatingValue.
 * Exported for use by the terminator leaf animation system.
 */
export function interpolateRaw(val: AnimatingValue, now: number): number {
    if (!val.animating) {
        return val.currentValue;
    }

    if (now >= val.animationStopTime) {
        // Animation complete — snap to target
        val.animating = false;
        val.currentValue = fmod(val.targetValue, 2 * Math.PI);
        return val.currentValue;
    }

    // Linear interpolation
    const fraction = (now - val.lastAnimationTime) / (val.animationStopTime - val.lastAnimationTime);
    val.currentValue += (val.targetValue - val.currentValue) * fraction;
    val.lastAnimationTime = now;
    return val.currentValue;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Schedule the next update time based on the update interval.
 * Positive intervals use epoch-aligned boundaries.
 * Negative sentinel values are routed to event-specific scheduling.
 *
 * Used only in 1× mode. Quantized mode computes schedules directly
 * in tickAnimations based on tick intervals and display-delta-per-tick.
 */
function scheduleNextUpdate(updateIntervalMs: number, getNow: () => Date, timeDirection: 1 | -1 = 1): number {
    if (updateIntervalMs > 0) {
        return nextAlignedUpdate(updateIntervalMs, getNow, timeDirection);
    }

    // Sentinel value — convert from ms back to the original constant
    const sentinel = updateIntervalMs / 1000;
    switch (sentinel) {
        case EC_UPDATE_NEXT_SUNRISE_OR_MIDNIGHT:
        case EC_UPDATE_NEXT_SUNSET_OR_MIDNIGHT:
        case EC_UPDATE_NEXT_MOONRISE_OR_MIDNIGHT:
        case EC_UPDATE_NEXT_MOONSET_OR_MIDNIGHT:
            // For now, schedule at next local midnight.
            // TODO: also check for the actual next sunrise/sunset/moonrise/moonset
            // and use whichever comes first.
            return nextLocalMidnight();

        case EC_UPDATE_ENV_CHANGE_ONLY:
            // Only update when the environment changes (e.g. location changes).
            // Schedule far in the future; an env change would reset this.
            return performance.now() + 365 * 24 * 3600 * 1000;

        default:
            // Unknown sentinel — treat as daily at midnight
            console.warn(`Unknown update sentinel: ${sentinel}, defaulting to daily`);
            return nextLocalMidnight();
    }
}

/**
 * Compute the next epoch-aligned update time in performance.now() ms.
 * Uses the display time (from getNow) so updates align to display-time
 * second/minute/hour boundaries, not wall-clock boundaries.
 *
 * For example, with intervalMs=1000, if the display time is 14:00:00.350,
 * the next boundary is 14:00:01.000, which is 650ms from now.
 */
function nextAlignedUpdate(intervalMs: number, getNow: () => Date, timeDirection: 1 | -1 = 1): number {
    const displayNow = getNow().getTime();  // ms since epoch (display time)
    let nextDisplay: number;
    if (timeDirection === -1) {
        // Time flows backward: find the previous boundary
        nextDisplay = Math.floor(displayNow / intervalMs) * intervalMs;
        // If exactly on a boundary, step one interval further back
        if (nextDisplay === displayNow) {
            nextDisplay -= intervalMs;
        }
    } else {
        nextDisplay = Math.ceil(displayNow / intervalMs) * intervalMs;
    }
    const deltaMs = Math.abs(nextDisplay - displayNow);
    // Convert display-time delta to performance.now() time
    return performance.now() + deltaMs;
}

/**
 * Compute performance.now() time of next local midnight (00:00:00.000).
 */
function nextLocalMidnight(): number {
    const now = new Date();
    const midnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,  // next day
        0, 0, 0, 0,         // 00:00:00.000
    );
    const msUntilMidnight = midnight.getTime() - now.getTime();
    return performance.now() + msUntilMidnight;
}

/** Floating-point modulo that always returns a non-negative result. */
function fmod(value: number, modulus: number): number {
    const result = value % modulus;
    return result < 0 ? result + modulus : result;
}

/**
 * Start a linear animation (no angle wrapping) for xMotion/yMotion.
 * Uses the same speed model as angular animation but treats values as pixels.
 */
function startLinearAnimation(
    val: AnimatingValue,
    newTarget: number,
    now: number,
    animSpeed: number = 1.0,
): void {
    const speed = kECGLAngleAnimationSpeed * animSpeed;

    if (speed === 0 || animSpeed === 0) {
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    if (val.animating && val.targetValue === newTarget) return;

    if (val.animating) {
        interpolateLinear(val, now);
    }

    if (val.currentValue === newTarget) {
        val.animating = false;
        return;
    }

    val.targetValue = newTarget;

    // Linear distance, no wrapping
    const delta = Math.abs(newTarget - val.currentValue);
    // Scale: treat ~100 pixels like ~π radians for speed purposes
    const durationMs = (delta / (speed * 30)) * 1000;

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
 * Linear interpolation (no angle wrapping) for xMotion/yMotion values.
 */
function interpolateLinear(val: AnimatingValue, now: number): number {
    if (!val.animating) return val.currentValue;

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
