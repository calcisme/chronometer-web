/**
 * Animation system for watch hands and wheels.
 *
 * Each dynamic part (QHand, Wheel) has an update interval (how often its
 * angle expression is re-evaluated) and an optional animSpeed (how fast
 * it animates from its old angle to the new one).
 *
 * The animation loop calls `tickAnimations` each frame, which:
 *   1. Checks if each part's update interval has elapsed
 *   2. If so, re-evaluates the angle expression to get a new target
 *   3. Starts a linear animation from old → new angle
 *   4. On subsequent frames, interpolates toward the target
 */

import type { Watch, WatchPart, QHandPart, WheelPart } from './types.js';
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
const kECGLFrameRate = 1.0 / 120;

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
interface AnimatingValue {
    currentValue: number;
    targetValue: number;
    lastAnimationTime: number;   // performance.now() in ms
    animationStopTime: number;   // performance.now() in ms
    animating: boolean;
}

/** Per-part state tracked by the animation system. */
export interface HandState {
    /** Reference to the XML part definition. */
    part: QHandPart | WheelPart;
    /** The angle being animated. */
    angle: AnimatingValue;
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
        if (part.type === 'QHand' || part.type === 'Wheel') {
            out.push(createHandState(part, env, now, getNow));
        } else if (part.type === 'Static') {
            collectDynamicParts(part.children, env, now, out, getNow);
        }
    }
}

function createHandState(
    part: QHandPart | WheelPart,
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
    part.dynamicState = { currentAngle: initialAngle };

    return {
        part,
        angle: {
            currentValue: initialAngle,
            targetValue: initialAngle,
            lastAnimationTime: now,
            animationStopTime: now,
            animating: false,
        },
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
 * Updates each part's `dynamicState.currentAngle` in place.
 */
export function tickAnimations(
    states: HandState[],
    env: Environment,
    now: number,   // performance.now()
): void {
    for (const state of states) {
        // Check if it's time to re-evaluate
        if (now >= state.nextUpdateTime) {
            const newTarget = state.part.angle
                ? evalAttr(state.part.angle, env)
                : 0;
            startAnimation(state, newTarget, now);
            state.nextUpdateTime = scheduleNextUpdate(state.updateIntervalMs, state.getNow);
        }

        // Interpolate if animating
        const angle = interpolate(state.angle, now);

        // Write to part's dynamicState
        if (!state.part.dynamicState) {
            state.part.dynamicState = { currentAngle: angle };
        } else {
            state.part.dynamicState.currentAngle = angle;
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

function startAnimation(
    state: HandState,
    newTarget: number,
    now: number,
): void {
    const val = state.angle;
    const animateSpeed = kECGLAngleAnimationSpeed * state.animSpeed;

    // Normalize target to [0, 2π)
    newTarget = fmod(newTarget, 2 * Math.PI);

    if (animateSpeed === 0 || state.animSpeed === 0) {
        // No animation — snap directly
        val.currentValue = newTarget;
        val.targetValue = newTarget;
        val.animating = false;
        return;
    }

    // If mid-animation, snapshot the current interpolated position first
    if (val.animating) {
        interpolate(val, now);
    }

    if (val.currentValue === newTarget) {
        val.animating = false;
        return;
    }

    val.targetValue = newTarget;

    // Animation direction: always take the shortest path (ECAnimationDirClosest)
    // Adjust currentValue so the delta is ≤ π
    if (newTarget > val.currentValue) {
        if (newTarget - val.currentValue > Math.PI) {
            val.currentValue += 2 * Math.PI;
        }
    } else {
        if (val.currentValue - newTarget > Math.PI) {
            val.currentValue -= 2 * Math.PI;
        }
    }

    const deltaTime = Math.abs(val.targetValue - val.currentValue) / animateSpeed;

    if (deltaTime < kECGLFrameRate) {
        // Too small to animate — snap
        val.currentValue = val.targetValue;
        val.animating = false;
        return;
    }

    // Start (or restart) animation from current position
    val.lastAnimationTime = now;
    val.animating = true;
    val.animationStopTime = now + deltaTime * 1000;  // convert to ms
}

function interpolate(val: AnimatingValue, now: number): number {
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
