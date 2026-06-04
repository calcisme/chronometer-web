/**
 * ObsValue — a single expression-driven animated value.
 *
 * An ObsValue holds a parsed AST expression, an update interval, animation
 * speeds, and an AnimatingValue for smooth interpolation between updates.
 * It is the general-purpose animation-value primitive shared across apps
 * (Observatory today; Inspector; eventually Chronometer).
 *
 * This module owns the *value* (the data type + construction). The logic that
 * *drives* values each frame — scheduling, the update branches, interpolation —
 * lives in the companion `updater.ts` (the embryonic "updater" subsystem).
 *
 * Modeled after the watch-face HandState/AnimatingValue system in animation.ts.
 */

import type { ASTNode } from '../expr/parser.js';
import { parse } from '../expr/parser.js';
import type { Environment } from '../expr/evaluator.js';
import { evalAttr } from './astro-env.js';
import { type AnimatingValue, makeAnimatingValue } from './animation.js';

// ============================================================================
// Types
// ============================================================================

/** A single dynamic value. */
export interface ObsValue {
    /** Human-readable name for debugging. */
    name: string;

    /** Parsed AST for computing this value's current target. */
    expr: ASTNode;

    /** Update interval in seconds.
     *  Positive: epoch-aligned boundary (e.g., 3600 = hourly, 1 = per second,
     *    0.1 = ten times per second).
     *  Negative: sentinel (e.g., EC_UPDATE_NEXT_SUNRISE). */
    updateInterval: number;

    /** Catch-up animation speed in rad/s.
     *  Used for snap-to-target (naturalSpeed=0) and Phase 1 catch-up
     *  (naturalSpeed>0).  Default 2.0 rad/s. */
    animSpeed: number;

    /** Steady-state sweep speed in rad/s.
     *  0 = snap-to-target mode (most values).
     *  >0 = constant-velocity sweep (e.g., second hands = 2π/60 rad/s).
     *  When >0, the update pass uses a two-phase algorithm:
     *    Phase 1: catch up at animSpeed to the moving target
     *    Phase 2: sweep at naturalSpeed until next update */
    naturalSpeed: number;

    /** Current computed value. NaN = "don't display this element". */
    currentValue: number;

    /** Animation state — always present, all values animate. */
    anim: AnimatingValue;

    /** Display-time ms-since-epoch of the next scheduled update. */
    nextUpdateDisplayTime: number;

    /** performance.now() at which the next update should fire. */
    nextUpdateTime: number;

    /** Pending Phase 2 sweep animation (only for naturalSpeed > 0).
     *  Set during update pass; consumed during animate pass when Phase 1 ends. */
    pendingSweep: { target: number; durationMs: number } | null;

    /** If true, this value is linear (not an angle) — skip fmod wrapping.
     *  Used for earth view values like sun declination, and for the Inspector's
     *  raw-number / date readouts. */
    linear: boolean;

    /** If true, use the lag-free "eval-ahead" update: evaluate the expression at
     *  the *next* update boundary (one interval into the future) and sweep there,
     *  arriving exactly as that boundary occurs. Eliminates the one-interval lag
     *  of interpolating between past samples. Requires a `withDisplayTime` helper
     *  to be supplied to the updater (see updater.ts / makeOverridableGetNow). */
    evalAhead: boolean;

    /** If true, this value is **discrete** — there is no meaningful value between
     *  two of its states (e.g. today's sunrise, an integer hour, a floored TZ
     *  offset). The updater evaluates it at the *current* display time and snaps
     *  (no eval-ahead, no interpolation), so the underlying function's semantics
     *  decide which value applies now. Takes precedence over `evalAhead`. */
    discrete: boolean;
}

/** Declarative definition used to construct an ObsValue. */
export interface ObsValueDef {
    name: string;
    expr: string;
    updateInterval: number;  // seconds
    animSpeed?: number;      // catch-up speed in rad/s; default 2.0
    naturalSpeed?: number;   // sweep speed in rad/s; default 0 (snap-to-target)
    linear?: boolean;        // if true, value is not an angle — skip fmod wrapping
    evalAhead?: boolean;     // if true, use lag-free eval-ahead update
    discrete?: boolean;      // if true, evaluate at current time and snap (no interpolation)
}

// ============================================================================
// Construction
// ============================================================================

/** Create a single ObsValue from a definition. */
export function createObsValue(
    def: ObsValueDef,
    env: Environment,
    perfNow: number,
    _getNow?: () => Date,
): ObsValue {
    const expr = parse(def.expr);
    const initialValue = evalAttr(expr, env);
    const animSpeed = def.animSpeed ?? 2.0;      // rad/s
    const naturalSpeed = def.naturalSpeed ?? 0;   // rad/s

    return {
        name: def.name,
        expr,
        updateInterval: def.updateInterval,
        animSpeed,
        naturalSpeed,
        currentValue: initialValue,
        anim: makeAnimatingValue(initialValue, perfNow),
        // Schedule immediate update on first frame so animation starts right away.
        nextUpdateDisplayTime: 0,
        nextUpdateTime: 0,
        pendingSweep: null,
        linear: def.linear ?? false,
        evalAhead: def.evalAhead ?? false,
        discrete: def.discrete ?? false,
    };
}
