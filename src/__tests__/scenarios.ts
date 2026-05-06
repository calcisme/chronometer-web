/**
 * Scenario definitions for watch face regression testing.
 *
 * Each scenario is a sequence of actions (set time, step, scrub, play, etc.)
 * with capture checkpoints. The TestBench executes these actions and records
 * the part values at each checkpoint for comparison against golden baselines.
 */

import type { TimeUnit } from '../time-controller.js';

// ============================================================================
// Types
// ============================================================================

export type ScenarioAction =
    | { type: 'setTime'; date: Date }
    | { type: 'tick' }
    | { type: 'capture'; label: string }
    | { type: 'singleStep'; unit: TimeUnit; direction: 1 | -1 }
    | { type: 'advanceRealTime'; deltaMs: number }
    | { type: 'finishAnimations' }
    | { type: 'startScrub'; unit: TimeUnit; direction: 1 | -1 }
    | { type: 'scrubTick' }
    | { type: 'endScrub' }
    | { type: 'play'; direction: 1 | -1 }
    | { type: 'pause' };

export interface ScenarioDefinition {
    /** Unique name prefix for this scenario group. */
    name: string;
    /** Ordered list of actions and capture points. */
    actions: ScenarioAction[];
}

// ============================================================================
// Reference times
// ============================================================================

export const REFERENCE_TIMES: Date[] = [
    new Date('2025-06-15T12:00:00Z'),   // Summer solstice-adjacent, daytime
    new Date('2025-06-15T00:00:00Z'),   // Same day, midnight
    new Date('2025-12-21T18:00:00Z'),   // Winter solstice, afternoon
    new Date('2025-01-01T00:00:00Z'),   // New Year midnight
    new Date('2025-03-09T10:00:00Z'),   // Near US DST spring-forward
    new Date('2024-02-29T06:00:00Z'),   // Leap day
    new Date('2000-01-01T12:00:00Z'),   // J2000 epoch
];

const TIME_UNITS: TimeUnit[] = ['second', 'minute', 'hour', 'day', 'month', 'year'];

// ============================================================================
// Scenario generators
// ============================================================================

/**
 * A. Idle — just set time, tick once, and capture.
 */
function idleScenarios(): ScenarioDefinition[] {
    return REFERENCE_TIMES.map(t => ({
        name: `idle:${t.toISOString()}`,
        actions: [
            { type: 'setTime', date: t },
            { type: 'tick' },
            { type: 'capture', label: 'idle' },
        ],
    }));
}

/**
 * B. Single-step forward — for each time unit at each reference time.
 * Captures: post-step (animations started), mid-animation, settled.
 */
function singleStepForwardScenarios(): ScenarioDefinition[] {
    const scenarios: ScenarioDefinition[] = [];
    for (const t of REFERENCE_TIMES) {
        for (const unit of TIME_UNITS) {
            scenarios.push({
                name: `step-fwd-${unit}:${t.toISOString()}`,
                actions: [
                    { type: 'setTime', date: t },
                    { type: 'tick' },
                    { type: 'singleStep', unit, direction: 1 },
                    { type: 'capture', label: 'post-step' },
                    { type: 'advanceRealTime', deltaMs: 16.7 },
                    { type: 'capture', label: 'mid-anim' },
                    { type: 'finishAnimations' },
                    { type: 'capture', label: 'settled' },
                ],
            });
        }
    }
    return scenarios;
}

/**
 * C. Single-step backward — mirror of B with direction = -1.
 */
function singleStepBackwardScenarios(): ScenarioDefinition[] {
    const scenarios: ScenarioDefinition[] = [];
    for (const t of REFERENCE_TIMES) {
        for (const unit of TIME_UNITS) {
            scenarios.push({
                name: `step-bwd-${unit}:${t.toISOString()}`,
                actions: [
                    { type: 'setTime', date: t },
                    { type: 'tick' },
                    { type: 'singleStep', unit, direction: -1 },
                    { type: 'capture', label: 'post-step' },
                    { type: 'advanceRealTime', deltaMs: 16.7 },
                    { type: 'capture', label: 'mid-anim' },
                    { type: 'finishAnimations' },
                    { type: 'capture', label: 'settled' },
                ],
            });
        }
    }
    return scenarios;
}

/**
 * D. Hold-to-scrub forward — for each time unit at each reference time.
 * Captures: after each of 3 scrub ticks, then after release.
 */
function scrubForwardScenarios(): ScenarioDefinition[] {
    const scenarios: ScenarioDefinition[] = [];
    for (const t of REFERENCE_TIMES) {
        for (const unit of TIME_UNITS) {
            scenarios.push({
                name: `scrub-fwd-${unit}:${t.toISOString()}`,
                actions: [
                    { type: 'setTime', date: t },
                    { type: 'tick' },
                    { type: 'startScrub', unit, direction: 1 },
                    { type: 'scrubTick' },
                    { type: 'capture', label: 'tick1' },
                    { type: 'scrubTick' },
                    { type: 'capture', label: 'tick2' },
                    { type: 'scrubTick' },
                    { type: 'capture', label: 'tick3' },
                    { type: 'endScrub' },
                    { type: 'capture', label: 'released' },
                ],
            });
        }
    }
    return scenarios;
}

/**
 * E. Hold-to-scrub backward — mirror of D with direction = -1.
 */
function scrubBackwardScenarios(): ScenarioDefinition[] {
    const scenarios: ScenarioDefinition[] = [];
    for (const t of REFERENCE_TIMES) {
        for (const unit of TIME_UNITS) {
            scenarios.push({
                name: `scrub-bwd-${unit}:${t.toISOString()}`,
                actions: [
                    { type: 'setTime', date: t },
                    { type: 'tick' },
                    { type: 'startScrub', unit, direction: -1 },
                    { type: 'scrubTick' },
                    { type: 'capture', label: 'tick1' },
                    { type: 'scrubTick' },
                    { type: 'capture', label: 'tick2' },
                    { type: 'scrubTick' },
                    { type: 'capture', label: 'tick3' },
                    { type: 'endScrub' },
                    { type: 'capture', label: 'released' },
                ],
            });
        }
    }
    return scenarios;
}

/**
 * F. Play/Pause/Reverse — at each reference time.
 * 1. Set time, play 1× forward, advance 500ms, capture
 * 2. Pause, capture
 * 3. Resume 1× forward, advance 500ms, capture
 * 4. Switch to -1× backward, advance 500ms, capture
 * 5. Pause, capture final
 */
function playPauseScenarios(): ScenarioDefinition[] {
    return REFERENCE_TIMES.map(t => ({
        name: `play-pause:${t.toISOString()}`,
        actions: [
            { type: 'setTime', date: t },
            { type: 'tick' },
            { type: 'play', direction: 1 },
            { type: 'advanceRealTime', deltaMs: 500 },
            { type: 'capture', label: 'play-fwd-500ms' },
            { type: 'pause' },
            { type: 'capture', label: 'paused' },
            { type: 'play', direction: 1 },
            { type: 'advanceRealTime', deltaMs: 500 },
            { type: 'capture', label: 'resumed-500ms' },
            { type: 'play', direction: -1 },
            { type: 'advanceRealTime', deltaMs: 500 },
            { type: 'capture', label: 'reverse-500ms' },
            { type: 'pause' },
            { type: 'capture', label: 'final-paused' },
        ],
    }));
}

// ============================================================================
// All scenarios
// ============================================================================

/**
 * Build the complete list of scenario definitions.
 * This is called once per face × location combination.
 */
export function buildAllScenarios(): ScenarioDefinition[] {
    return [
        ...idleScenarios(),
        ...singleStepForwardScenarios(),
        ...singleStepBackwardScenarios(),
        ...scrubForwardScenarios(),
        ...scrubBackwardScenarios(),
        ...playPauseScenarios(),
    ];
}

/**
 * Count the total number of capture checkpoints across all scenarios.
 */
export function countCheckpoints(scenarios: ScenarioDefinition[]): number {
    let count = 0;
    for (const s of scenarios) {
        count += s.actions.filter(a => a.type === 'capture').length;
    }
    return count;
}
