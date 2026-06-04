/**
 * Updater — the per-frame logic that drives ObsValues.
 *
 * This is the embryonic "updater" subsystem: it owns the per-value update
 * branches (snap-to-target, two-phase natural-speed sweep, scrub compression,
 * and lag-free eval-ahead), the per-frame interpolation pass, and the
 * time-shift helper (`makeOverridableGetNow`) used by eval-ahead.
 *
 * It operates on a single `ObsValue` or a flat `ObsValue[]` — collection
 * management (named structs, keyed maps) is left to each app. Over time this
 * file is the natural home for a fuller encapsulated update subsystem (keyed
 * collection, worker-backed eval, double-buffering, time-controller transition
 * glue); for now it is just the passes plus the time helper.
 */

import type { Environment } from '../expr/evaluator.js';
import { evalAttr } from './astro-env.js';
import {
    startAnimationRaw,
    interpolateValue,
    computeNextBoundary,
    displayTimeToPerfNow,
} from './animation.js';
import type { ObsValue } from './obs-value.js';

// Base angular animation speed (must match kECGLAngleAnimationSpeed in animation.ts).
// Used to convert ObsValue animSpeed (rad/s) to the multiplier that
// startAnimationRaw expects.
const K_ANGLE_ANIM_SPEED = 2.0;

// Error threshold (radians) below which a natural-speed value is considered
// "on track" and skips the catch-up phase.
const NATURAL_ERROR_THRESHOLD = 0.002;

// ============================================================================
// Time source / eval-ahead helper
// ============================================================================

/** Run `fn` as if the display clock read `displayMs`, then restore. */
export type WithDisplayTime = <T>(displayMs: number, fn: () => T) => T;

/**
 * Wrap a base time source in a transiently-overridable `getNow`.
 *
 * `getNow()` normally returns `base()`, but inside `withDisplayTime(ms, fn)` it
 * returns `new Date(ms)` for the duration of `fn`. This lets the updater
 * evaluate an expression "ahead" (at a future display-time boundary) without a
 * second environment — the display time enters expressions only through
 * `getNow`, so shifting it shifts the whole evaluation.
 */
export function makeOverridableGetNow(base: () => Date): {
    getNow: () => Date;
    withDisplayTime: WithDisplayTime;
} {
    let overrideMs: number | null = null;
    const getNow = (): Date => (overrideMs != null ? new Date(overrideMs) : base());
    function withDisplayTime<T>(displayMs: number, fn: () => T): T {
        const prev = overrideMs;
        overrideMs = displayMs;
        try {
            return fn();
        } finally {
            overrideMs = prev;
        }
    }
    return { getNow, withDisplayTime };
}

// ============================================================================
// Update helpers
// ============================================================================

/**
 * Update a value using the lag-free **eval-ahead** scheme.
 *
 * Evaluates the target at the *next* update boundary (one interval into the
 * future in display time) and sweeps the current value there over the real-time
 * budget, arriving exactly when that boundary occurs. Because the previous sweep
 * landed on the value at the current boundary, each interval is the chord
 * A(T) → A(T+Δ): symmetric curvature error, no time lag.
 */
function updateObsValueEvalAhead(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 0 | 1 | -1,
    withDisplayTime?: WithDisplayTime,
): void {
    const dir: 1 | -1 = timeDirection === -1 ? -1 : 1;

    // Next boundary in display time (computed against the real clock).
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, dir, env);
    v.nextUpdateDisplayTime = nextDisplayMs;
    v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);
    const budgetMs = v.nextUpdateTime - perfNow;

    // Evaluate the target AT the next boundary (eval-ahead). The override only
    // applies during this evaluation; boundary scheduling above used real time.
    const target = withDisplayTime
        ? withDisplayTime(nextDisplayMs, () => evalAttr(v.expr, env))
        : evalAttr(v.expr, env);

    v.pendingSweep = null;
    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;
    if (budgetMs > 0 && isFinite(budgetMs)) {
        // Sweep to the future target over the real-time budget.
        startAnimationRaw(v.anim, target, perfNow, multiplier, budgetMs, v.linear);
    } else {
        // Boundary is now/past — snap.
        startAnimationRaw(v.anim, target, perfNow, multiplier, undefined, v.linear);
    }
}

/**
 * Update a natural-speed value (e.g., second hand) in 1×/−1× mode.
 *
 * Two-phase animation:
 *   Phase 1 (catch-up): Animate at animSpeed from current position to where
 *     the hand should be when catch-up finishes (the correct position advances
 *     at naturalSpeed during catch-up).
 *   Phase 2 (sweep): Sweep at naturalSpeed until the next update boundary.
 *
 * Phase 2 params are stored in v.pendingSweep and picked up by animateObsValue
 * when Phase 1 completes.
 */
function updateNaturalSpeedValue(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
): void {
    const currentCorrectAngle = evalAttr(v.expr, env);

    // Schedule next update
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, timeDirection, env);
    v.nextUpdateDisplayTime = nextDisplayMs;
    v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);

    // Real time until next update
    const dtToNextUpdateMs = v.nextUpdateTime - perfNow;
    const dtToNextUpdateSec = dtToNextUpdateMs / 1000;
    if (dtToNextUpdateSec <= 0 || !isFinite(dtToNextUpdateSec)) {
        // Edge case: next update is now or in the past — snap
        startAnimationRaw(v.anim, currentCorrectAngle, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, undefined, v.linear);
        v.pendingSweep = null;
        return;
    }

    // Effective natural speed (clockwise forward, counter-clockwise reverse)
    const effNaturalSpeed = v.naturalSpeed * timeDirection;

    // Compute error: how far is the hand from where it should be?
    const TWO_PI = 2 * Math.PI;
    let error: number;
    if (timeDirection === 1) {
        // Normalize clockwise [0, 2π)
        error = currentCorrectAngle - v.anim.currentValue;
        error = ((error % TWO_PI) + TWO_PI) % TWO_PI;
    } else {
        // Normalize counter-clockwise
        error = v.anim.currentValue - currentCorrectAngle;
        error = ((error % TWO_PI) + TWO_PI) % TWO_PI;
    }

    if (error < NATURAL_ERROR_THRESHOLD) {
        // On track — Phase 2 only (sweep at naturalSpeed)
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.naturalSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs, v.linear);
        v.pendingSweep = null;
        return;
    }

    // Phase 1: Catch-up at animSpeed.
    // The hand closes the gap at (animSpeed - naturalSpeed) rad/s.
    // catchUpTime = error / (animSpeed - naturalSpeed)
    const differentialSpeed = v.animSpeed - v.naturalSpeed;
    if (differentialSpeed <= 0) {
        // animSpeed not fast enough to close gap — compress everything
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs, v.linear);
        v.pendingSweep = null;
        return;
    }

    const catchUpSec = error / differentialSpeed;
    const catchUpMs = catchUpSec * 1000;

    if (catchUpMs >= dtToNextUpdateMs) {
        // Can't finish catch-up before next update — compress both phases
        const sweepAngle = effNaturalSpeed * dtToNextUpdateSec;
        const finalTarget = currentCorrectAngle + sweepAngle;
        startAnimationRaw(v.anim, finalTarget, perfNow,
            v.animSpeed / K_ANGLE_ANIM_SPEED, dtToNextUpdateMs, v.linear);
        v.pendingSweep = null;
        return;
    }

    // Phase 1 target: where the correct position will be when catch-up ends
    const catchUpTarget = currentCorrectAngle + effNaturalSpeed * catchUpSec;
    startAnimationRaw(v.anim, catchUpTarget, perfNow,
        v.animSpeed / K_ANGLE_ANIM_SPEED, catchUpMs, v.linear);

    // Store Phase 2 for the animate pass to pick up
    const remainingMs = dtToNextUpdateMs - catchUpMs;
    const sweepAngle = effNaturalSpeed * (remainingMs / 1000);
    v.pendingSweep = {
        target: catchUpTarget + sweepAngle,
        durationMs: remainingMs,
    };
}

/**
 * Update a value during scrub (quantized mode).
 *
 * Compression logic modeled after the watch-face tickAnimations:
 * compute how many ticks until the next update boundary, use that
 * as the real-time budget, and compress if the natural animation
 * duration exceeds it.
 */
function updateObsValueScrub(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    timeDirection: 1 | -1,
    tickIntervalMs: number,
    displayDeltaPerTickSec: number,
): void {
    const newTarget = evalAttr(v.expr, env);

    // Compute next boundary in display time
    const nextDisplayMs = computeNextBoundary(
        v.updateInterval * 1000, getNow, timeDirection, env);
    v.nextUpdateDisplayTime = nextDisplayMs;

    // Compute real-time budget (same formula as tickAnimations)
    const displayNowMs = getNow().getTime();
    const displayDeltaMs = Math.abs(nextDisplayMs - displayNowMs);
    const displayDeltaPerTickMs = displayDeltaPerTickSec * 1000;
    const ticksUntilUpdate = displayDeltaPerTickMs > 0
        ? Math.max(1, Math.ceil(displayDeltaMs / displayDeltaPerTickMs))
        : 1;
    const timeUntilNextUpdateMs = ticksUntilUpdate * tickIntervalMs;

    // Schedule next re-evaluation
    v.nextUpdateTime = perfNow + timeUntilNextUpdateMs;

    // Compute natural animation duration
    const speed = v.animSpeed;  // rad/s
    let angleDelta: number;
    if (v.linear) {
        // Linear values: straight-line delta (no angular wrapping)
        angleDelta = Math.abs(newTarget - v.anim.currentValue);
    } else {
        const TWO_PI = 2 * Math.PI;
        const normalizedTarget = ((newTarget % TWO_PI) + TWO_PI) % TWO_PI;
        const normalizedCurrent = ((v.anim.currentValue % TWO_PI) + TWO_PI) % TWO_PI;
        angleDelta = Math.abs(normalizedTarget - normalizedCurrent);
        if (angleDelta > Math.PI) angleDelta = TWO_PI - angleDelta;
    }
    const naturalDurationMs = speed > 0 ? (angleDelta / speed) * 1000 : 0;

    const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;

    // Compress if needed, stretch if too fast, otherwise use natural speed.
    if (naturalDurationMs > timeUntilNextUpdateMs) {
        // Too slow — compress to finish before next re-evaluation
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            timeUntilNextUpdateMs, v.linear);
    } else if (naturalDurationMs < tickIntervalMs) {
        // Too fast — stretch to fill one tick (prevents sub-frame snaps)
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            tickIntervalMs, v.linear);
    } else {
        // Natural speed falls between one tick and next update — use as-is
        startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
            undefined, v.linear);
    }

    // No pending sweep during scrub — just snap-to-target with compression
    v.pendingSweep = null;
}

// ============================================================================
// Per-frame passes
// ============================================================================

/**
 * UPDATE one value — dispatch to the appropriate branch. Caller has already
 * checked that the value's timer has expired.
 *
 * Branches:
 *   0. Eval-ahead (v.evalAhead): lag-free future-boundary target
 *   1. Scrub mode (tickIntervalMs != null): compress animations to fit tick budget
 *   2. Natural-speed 1× (naturalSpeed > 0): two-phase catch-up + sweep
 *   3. Normal 1× (naturalSpeed === 0): snap-to-target at animSpeed
 */
export function updateObsValue(
    v: ObsValue,
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    tickIntervalMs: number | null,
    displayDeltaPerTickSec: number,
    timeDirection: 0 | 1 | -1,
    withDisplayTime?: WithDisplayTime,
): void {
    if (v.evalAhead) {
        updateObsValueEvalAhead(v, env, perfNow, getNow, timeDirection, withDisplayTime);
    } else if (tickIntervalMs !== null && tickIntervalMs > 0) {
        // Scrub mode: compress as needed
        // (timeDirection is always 1 or -1 in scrub mode)
        updateObsValueScrub(v, env, perfNow, getNow,
            (timeDirection || 1) as 1 | -1,
            tickIntervalMs, displayDeltaPerTickSec);
    } else if (v.naturalSpeed > 0 && timeDirection !== 0) {
        // 1×/−1× mode, natural speed: two-phase animation
        updateNaturalSpeedValue(v, env, perfNow, getNow, timeDirection);
    } else {
        // Snap-to-target at animSpeed.
        // This branch handles:
        //   - Normal values (naturalSpeed === 0)
        //   - Natural-speed values when time is stopped
        //     (timeDirection === 0, no forward projection)
        const newTarget = evalAttr(v.expr, env);
        if (timeDirection === 0) {
            // Stopped: snap and re-check shortly (time may resume)
            v.nextUpdateTime = perfNow + 100;
            v.pendingSweep = null;
            startAnimationRaw(v.anim, newTarget, perfNow,
                v.animSpeed / K_ANGLE_ANIM_SPEED, undefined, v.linear);
        } else {
            const nextDisplayMs = computeNextBoundary(
                v.updateInterval * 1000, getNow, timeDirection, env);
            v.nextUpdateDisplayTime = nextDisplayMs;
            v.nextUpdateTime = displayTimeToPerfNow(nextDisplayMs, getNow);
            v.pendingSweep = null;
            const multiplier = v.animSpeed / K_ANGLE_ANIM_SPEED;
            startAnimationRaw(v.anim, newTarget, perfNow, multiplier,
                undefined, v.linear);
        }
    }
}

/**
 * Pass 1: UPDATE — re-evaluate expressions whose timer has expired.
 *
 * @param tickIntervalMs      null = 1×/−1× mode, >0 = scrub tick rate (ms)
 * @param displayDeltaPerTickSec  Display seconds advanced per tick (for scrub compression)
 * @param timeDirection       1 = forward, -1 = reverse, 0 = stopped
 * @param withDisplayTime     Required for eval-ahead values (see makeOverridableGetNow)
 */
export function updateObsValues(
    values: ObsValue[],
    env: Environment,
    perfNow: number,
    getNow: () => Date,
    tickIntervalMs: number | null = null,
    displayDeltaPerTickSec: number = 0,
    timeDirection: 0 | 1 | -1 = 1,
    withDisplayTime?: WithDisplayTime,
): void {
    for (const v of values) {
        if (perfNow >= v.nextUpdateTime) {
            updateObsValue(v, env, perfNow, getNow,
                tickIntervalMs, displayDeltaPerTickSec, timeDirection, withDisplayTime);
        }
    }
}

/**
 * ANIMATE one value — interpolate toward its target and handle Phase 2 handoff.
 * Writes the interpolated result to `currentValue`.
 */
export function animateObsValue(v: ObsValue, perfNow: number): void {
    v.currentValue = interpolateValue(v.anim, perfNow);

    // Phase 2 handoff: if Phase 1 just finished and sweep is pending
    if (!v.anim.animating && v.pendingSweep) {
        const sweep = v.pendingSweep;
        v.pendingSweep = null;
        const sweepMultiplier = v.naturalSpeed / K_ANGLE_ANIM_SPEED;
        startAnimationRaw(v.anim, sweep.target, perfNow,
            sweepMultiplier, sweep.durationMs, v.linear);
        // Re-interpolate to pick up the new animation immediately
        v.currentValue = interpolateValue(v.anim, perfNow);
    }
}

/**
 * Pass 2: ANIMATE — interpolate all values toward their targets.
 */
export function animateObsValues(values: ObsValue[], perfNow: number): void {
    for (const v of values) {
        animateObsValue(v, perfNow);
    }
}

/**
 * Reset all value schedules so they re-evaluate on the very next frame.
 * Call when the environment changes (location, noonOnTop toggle, etc.).
 */
export function resetObsValueSchedules(values: ObsValue[]): void {
    for (const v of values) {
        v.nextUpdateDisplayTime = 0;
        v.nextUpdateTime = 0;
    }
}

/**
 * Returns true if any value is still animating (mid-interpolation) or has a
 * pending Phase-2 sweep. The render loop uses this to decide whether to keep
 * rendering while the clock is stopped.
 */
export function anyObsAnimating(values: ObsValue[]): boolean {
    for (const v of values) {
        if (v.anim.animating || v.pendingSweep) return true;
    }
    return false;
}
