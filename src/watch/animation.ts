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

import type { Watch, WatchPart, QHandPart, WheelPart, QWedgePart } from './types.js';
import type { Environment } from '../expr/evaluator.js';
import { evalAttr } from './watch-env.js';

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
                // Check BOTH angle and offsetAngle to decide compression.
                const animateSpeed = kECGLAngleAnimationSpeed * state.animSpeed;

                // Angle duration
                const normalizedTarget = fmod(newTarget, 2 * Math.PI);
                const normalizedCurrent = fmod(state.angle.currentValue, 2 * Math.PI);
                let angleDelta = Math.abs(normalizedTarget - normalizedCurrent);
                if (angleDelta > Math.PI) angleDelta = 2 * Math.PI - angleDelta;
                const angleDurationMs = (animateSpeed > 0)
                    ? (angleDelta / animateSpeed) * 1000
                    : 0;

                // OffsetAngle duration (may be the dominant animation)
                let offsetDurationMs = 0;
                if (newOffsetTarget !== null && state.offsetAngle) {
                    const normOffTarget = fmod(newOffsetTarget, 2 * Math.PI);
                    const normOffCurrent = fmod(state.offsetAngle.currentValue, 2 * Math.PI);
                    let offDelta = Math.abs(normOffTarget - normOffCurrent);
                    if (offDelta > Math.PI) offDelta = 2 * Math.PI - offDelta;
                    offsetDurationMs = (animateSpeed > 0)
                        ? (offDelta / animateSpeed) * 1000
                        : 0;
                }

                const normalDurationMs = Math.max(angleDurationMs, offsetDurationMs);

                if (normalDurationMs > timeUntilNextUpdateMs) {
                    // Animation wouldn't finish before next re-eval:
                    // compress to fit within the available time
                    startAnimation(state, newTarget, now, timeUntilNextUpdateMs);
                    if (newOffsetTarget !== null && state.offsetAngle) {
                        startAnimationRaw(state.offsetAngle, newOffsetTarget, now, state.animSpeed, timeUntilNextUpdateMs);
                    }
                } else {
                    // Animation finishes in time: use normal speed
                    startAnimation(state, newTarget, now);
                    if (newOffsetTarget !== null && state.offsetAngle) {
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
                state.nextUpdateTime = scheduleNextUpdate(state.updateIntervalMs, state.getNow);
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
function scheduleNextUpdate(updateIntervalMs: number, getNow: () => Date): number {
    if (updateIntervalMs > 0) {
        return nextAlignedUpdate(updateIntervalMs, getNow);
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
function nextAlignedUpdate(intervalMs: number, getNow: () => Date): number {
    const displayNow = getNow().getTime();  // ms since epoch (display time)
    const nextDisplay = Math.ceil(displayNow / intervalMs) * intervalMs;
    const deltaMs = nextDisplay - displayNow;
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
