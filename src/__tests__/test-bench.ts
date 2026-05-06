/**
 * TestBench — Core test driver for watch face regression testing.
 *
 * Wraps TimeController + createWatchEnvironment + initHandStates + tickAnimations
 * into a single class that can be used to set mock times, simulate user
 * interactions (step, scrub, play/pause), and capture snapshots of all
 * dynamic part values for comparison against golden baselines.
 *
 * Usage:
 *   const bench = new TestBench({ faceName: 'Babylon', location: TEST_LOCATIONS[0] });
 *   bench.setTime(new Date('2025-06-15T12:00:00Z'));
 *   bench.tick();  // run one animation frame
 *   const snap = bench.snapshot();
 */

import { vi, describe, test, beforeAll, afterAll } from 'vitest';
import { JSDOM } from 'jsdom';

import { type FaceConfig, type TestLocation, FACE_CONFIGS, TEST_LOCATIONS, loadFaceXML } from './face-registry.js';
import {
    type GoldenData, type ScenarioSnapshot, type PartValueSnapshot,
    isCaptureMode, loadGolden, saveGolden, assertScenarioMatch,
} from './snapshot-utils.js';

import { parseWatchXML } from '../watch/xml-parser.js';
import { createWatchEnvironment } from '../watch/watch-env.js';
import type { Watch } from '../watch/types.js';
import type { Environment } from '../expr/evaluator.js';
import {
    type HandState,
    initHandStates,
    tickAnimations,
    finishAnimations,
    resetHandSchedules,
    anyAnimating,
} from '../watch/animation.js';
import {
    type TerminatorLeafState,
    expandTerminatorToLeaves,
    tickLeafAnimations,
    finishLeafAnimations,
    resetLeafSchedules,
    anyLeafAnimating,
} from '../watch/terminator.js';
import { TimeController, type TimeUnit, RATE_OPTIONS, TICK_INTERVAL_MS, displaySecondsPerTick } from '../time-controller.js';
import type { TerminatorPart } from '../watch/types.js';

// ============================================================================
// TestBench
// ============================================================================

export interface TestBenchOptions {
    faceName: string;
    location: TestLocation;
}

export class TestBench {
    readonly faceName: string;
    readonly faceConfig: FaceConfig;
    readonly location: TestLocation;

    // Parsed watch definition (immutable after construction)
    readonly watch: Watch;

    // Mutable state
    env!: Environment;
    handStates!: HandState[];
    terminatorLeaves!: TerminatorLeafState[];
    timeController!: TimeController;

    /** Mocked performance.now() value (ms). */
    perfNow: number = 1000; // Start at 1s to avoid edge cases at 0

    /**
     * Simulated play direction. When non-null, advanceRealTime() advances
     * display time by deltaMs × playDirection in addition to perfNow.
     * This avoids using TimeController's 1×/-1× mode which relies on
     * Date.now() and is inherently non-deterministic.
     */
    private playDirection: 1 | -1 | null = null;

    /** The vitest spy on performance.now. Stored so we can restore it. */
    private perfNowSpy: ReturnType<typeof vi.spyOn> | null = null;

    constructor(options: TestBenchOptions) {
        this.faceName = options.faceName;
        this.faceConfig = FACE_CONFIGS[options.faceName];
        if (!this.faceConfig) {
            throw new Error(`Unknown face: "${options.faceName}"`);
        }
        this.location = options.location;

        // Parse the XML using jsdom's DOMParser
        const xmlText = loadFaceXML(options.faceName);
        const dom = new JSDOM('', { contentType: 'text/html' });
        const domParser = new dom.window.DOMParser();
        this.watch = parseWatchXML(xmlText, 'front', domParser);

        // Mock performance.now() so all internal calls use our controlled value
        this.perfNowSpy = vi.spyOn(performance, 'now').mockImplementation(() => this.perfNow);

        // Initialize with a default time
        this.timeController = new TimeController();
    }

    /**
     * Set the mock display time and (re)initialize all animation state.
     * This is the primary way to set up a scenario.
     */
    setTime(date: Date): void {
        // Set display time via TimeController (stops the clock)
        this.timeController.setTime(date);

        // Create a fresh environment with the mock time source
        const getNow = () => this.timeController.getDisplayTime();
        this.env = createWatchEnvironment(
            this.watch,
            this.location.lat,
            this.location.lon,
            getNow,
            this.location.olsonTimezone,
        );

        // Initialize hand states
        this.handStates = initHandStates(
            this.watch,
            this.env,
            this.perfNow,
            getNow,
            getNow, // rawGetNow = getNow for testing (time is fully controlled)
        );

        // Expand terminators
        this.terminatorLeaves = [];
        this._collectTerminators(this.watch.parts);
    }

    /**
     * Rebuild the environment and hand states without changing the time.
     * Used after TimeController mutations (step, setRate, etc.) to refresh
     * the environment's time-dependent variable bindings.
     */
    rebuildEnv(): void {
        const getNow = () => this.timeController.getDisplayTime();

        // Rebuild the environment (recalculates all time-dependent variables)
        this.env = createWatchEnvironment(
            this.watch,
            this.location.lat,
            this.location.lon,
            getNow,
            this.location.olsonTimezone,
        );

        // Update getNow/rawGetNow closures on existing hand states
        // (so expression evaluation uses the new time)
        for (const hs of this.handStates) {
            hs.getNow = getNow;
            hs.rawGetNow = getNow;
        }
    }

    /**
     * Advance the mocked performance.now() by deltaMs and run one
     * animation tick across all hands and terminator leaves.
     *
     * When playing (playDirection is set), also advances display time
     * by deltaMs in the play direction, keeping both time bases in sync.
     */
    advanceRealTime(deltaMs: number): void {
        this.perfNow += deltaMs;

        if (this.playDirection !== null) {
            // Advance display time to simulate 1× play
            const currentMs = this.timeController.getDisplayTime().getTime();
            const newMs = currentMs + deltaMs * this.playDirection;
            this.timeController.setTime(new Date(newMs));
            this.rebuildEnv();
        }

        const dir = this.playDirection ?? 1;
        this._tickAll(null, 0, dir);
    }

    /**
     * Run one animation frame at the current perfNow.
     * Uses the given tick parameters for quantized mode.
     */
    tick(
        tickIntervalMs: number | null = null,
        displayDeltaPerTickSec: number = 0,
        direction: 1 | -1 = 1,
    ): void {
        this._tickAll(tickIntervalMs, displayDeltaPerTickSec, direction);
    }

    /**
     * Simulate a single-step tap on a step button.
     * Mirrors the mousedown handler in engine-entry.ts.
     */
    singleStep(unit: TimeUnit, direction: 1 | -1): void {
        // Stop time and snap in-flight animations
        this.timeController.stop();
        finishAnimations(this.handStates);
        finishLeafAnimations(this.terminatorLeaves);

        // Step the time controller
        this.timeController.step(unit, direction);

        // Rebuild env with new time
        this.rebuildEnv();

        // One-shot: re-evaluate all hands with natural speed animation
        this.timeController.beginFrame();
        resetHandSchedules(this.handStates);
        resetLeafSchedules(this.terminatorLeaves);
        tickAnimations(this.handStates, this.env, this.perfNow, null, 0, direction);
        tickLeafAnimations(this.terminatorLeaves, this.env, this.perfNow, null, 0);
        this.timeController.endFrame();
    }

    /**
     * Start a hold-to-scrub simulation.
     * Sets up quantized rate mode at the given unit.
     */
    startScrub(unit: TimeUnit, direction: 1 | -1): void {
        this.timeController.setDirection(direction);
        // Find the rate option matching the unit
        const rateIdx = RATE_OPTIONS.findIndex(r => r.unit === unit);
        if (rateIdx >= 0) {
            this.timeController.setRate(RATE_OPTIONS[rateIdx]);
        }
        this.rebuildEnv();
        resetHandSchedules(this.handStates);
        resetLeafSchedules(this.terminatorLeaves);
    }

    /**
     * Advance one scrub tick (100ms real time + one calendar unit).
     */
    scrubTick(): void {
        this.perfNow += TICK_INTERVAL_MS;

        // Advance the time controller's tick
        this.timeController.beginFrame();
        this.timeController.checkTick(this.perfNow);

        // Rebuild env with new time
        this.rebuildEnv();

        const rate = this.timeController.currentRate;
        const tickMs = TICK_INTERVAL_MS;
        const displayDelta = rate ? displaySecondsPerTick(rate.unit) : 0;
        const dir = this.timeController.currentDirection;

        tickAnimations(this.handStates, this.env, this.perfNow, tickMs, displayDelta, dir);
        tickLeafAnimations(this.terminatorLeaves, this.env, this.perfNow, tickMs, displayDelta);
        this.timeController.endFrame();
    }

    /**
     * End a scrub simulation — stop and snap all animations.
     */
    endScrub(): void {
        this.timeController.stop();
        finishAnimations(this.handStates);
        finishLeafAnimations(this.terminatorLeaves);
    }

    /**
     * Simulate play at 1× in the given direction.
     *
     * Instead of using TimeController's 1×/-1× mode (which relies on
     * Date.now()), we keep the clock stopped and track the play direction.
     * advanceRealTime() will advance display time accordingly.
     */
    play(direction: 1 | -1): void {
        this.playDirection = direction;

        // Unfreeze hand schedules so expressions re-evaluate
        resetHandSchedules(this.handStates);
        resetLeafSchedules(this.terminatorLeaves);
    }

    /**
     * Simulate pause — stop and snap animations.
     */
    pause(): void {
        this.playDirection = null;
        this.timeController.stop();
        finishAnimations(this.handStates);
        finishLeafAnimations(this.terminatorLeaves);
    }

    /**
     * Run animation frames until all animations complete, or max 5 seconds of sim time.
     * Advances perfNow in 16.7ms increments (60fps).
     */
    finishAllAnimations(): void {
        const maxIterations = 300; // 5s at 60fps
        for (let i = 0; i < maxIterations; i++) {
            if (!anyAnimating(this.handStates) && !anyLeafAnimating(this.terminatorLeaves)) {
                break;
            }
            this.perfNow += 16.7;
            this._tickAll(null, 0, this.timeController.currentDirection);
        }
        // Final snap
        finishAnimations(this.handStates);
        finishLeafAnimations(this.terminatorLeaves);
    }

    /**
     * Capture a snapshot of all current part values.
     */
    snapshot(): PartValueSnapshot[] {
        const parts: PartValueSnapshot[] = [];

        for (const hs of this.handStates) {
            const snap: PartValueSnapshot = {
                partName: hs.part.name,
                partType: hs.part.type,
                angle: hs.angle.currentValue,
                angleAnimating: hs.angle.animating,
                angleTarget: hs.angle.targetValue,
                updateIntervalMs: hs.updateIntervalMs,
                nextUpdateDisplayTime: hs.nextUpdateDisplayTime,
            };

            if (hs.offsetAngle) {
                snap.offsetAngle = hs.offsetAngle.currentValue;
                snap.offsetAngleAnimating = hs.offsetAngle.animating;
                snap.offsetAngleTarget = hs.offsetAngle.targetValue;
            }

            if (hs.xMotion) {
                snap.xMotion = hs.xMotion.currentValue;
                snap.xMotionAnimating = hs.xMotion.animating;
            }

            if (hs.yMotion) {
                snap.yMotion = hs.yMotion.currentValue;
                snap.yMotionAnimating = hs.yMotion.animating;
            }

            parts.push(snap);
        }

        return parts;
    }

    /**
     * Clean up vitest mocks.
     */
    dispose(): void {
        if (this.perfNowSpy) {
            this.perfNowSpy.mockRestore();
            this.perfNowSpy = null;
        }
    }

    // ========================================================================
    // Internal helpers
    // ========================================================================

    private _tickAll(
        tickIntervalMs: number | null,
        displayDeltaPerTickSec: number,
        direction: 1 | -1,
    ): void {
        this.timeController.beginFrame();
        tickAnimations(this.handStates, this.env, this.perfNow, tickIntervalMs, displayDeltaPerTickSec, direction);
        tickLeafAnimations(this.terminatorLeaves, this.env, this.perfNow, tickIntervalMs, displayDeltaPerTickSec);
        this.timeController.endFrame();
    }

    private _collectTerminators(parts: import('../watch/types.js').WatchPart[]): void {
        for (const part of parts) {
            if (part.type === 'Terminator') {
                const leaves = expandTerminatorToLeaves(part as TerminatorPart, this.env);
                this.terminatorLeaves.push(...leaves);
            } else if (part.type === 'Static') {
                this._collectTerminators(part.children);
            }
        }
    }
}

// ============================================================================
// High-level test runner
// ============================================================================

import { type ScenarioDefinition, type ScenarioAction, buildAllScenarios } from './scenarios.js';

/**
 * Execute a single scenario definition against a TestBench.
 * Returns an array of ScenarioSnapshots, one per 'capture' action.
 */
function executeScenario(bench: TestBench, scenario: ScenarioDefinition): ScenarioSnapshot[] {
    const snapshots: ScenarioSnapshot[] = [];

    for (const action of scenario.actions) {
        executeAction(bench, action, scenario.name, snapshots);
    }

    return snapshots;
}

/**
 * Execute a single action within a scenario.
 */
function executeAction(
    bench: TestBench,
    action: ScenarioAction,
    scenarioName: string,
    snapshots: ScenarioSnapshot[],
): void {
    switch (action.type) {
        case 'setTime':
            bench.perfNow = 1000; // Reset for determinism
            bench.setTime(action.date);
            break;
        case 'tick':
            bench.tick();
            break;
        case 'singleStep':
            bench.singleStep(action.unit, action.direction);
            break;
        case 'advanceRealTime':
            bench.advanceRealTime(action.deltaMs);
            break;
        case 'finishAnimations':
            bench.finishAllAnimations();
            break;
        case 'startScrub':
            bench.startScrub(action.unit, action.direction);
            break;
        case 'scrubTick':
            bench.scrubTick();
            break;
        case 'endScrub':
            bench.endScrub();
            break;
        case 'play':
            bench.play(action.direction);
            break;
        case 'pause':
            bench.pause();
            break;
        case 'capture':
            snapshots.push({
                name: `${scenarioName}:${action.label}`,
                parts: bench.snapshot(),
            });
            break;
    }
}

/**
 * Run the full regression suite for a single face across all locations.
 * This is the function called by each per-face test file.
 *
 * Builds all scenario definitions (idle, step, scrub, play/pause)
 * and runs each as an individual vitest test. In capture mode,
 * records results to golden files; in verify mode, compares against them.
 */
export function runFaceRegressionSuite(faceName: string): void {
    const captureMode = isCaptureMode();
    const allScenarios = buildAllScenarios();

    for (const location of TEST_LOCATIONS) {
        describe(`${faceName} @ ${location.name}`, () => {
            let bench: TestBench;
            let golden: GoldenData | null;
            const capturedScenarios: ScenarioSnapshot[] = [];

            beforeAll(() => {
                bench = new TestBench({ faceName, location });
                golden = captureMode ? null : loadGolden(faceName, location.name);
            });

            afterAll(() => {
                if (captureMode) {
                    const data: GoldenData = {
                        face: faceName,
                        location: {
                            name: location.name,
                            lat: location.lat,
                            lon: location.lon,
                            tz: location.olsonTimezone,
                        },
                        generatedAt: new Date().toISOString(),
                        scenarios: capturedScenarios,
                    };
                    saveGolden(data, faceName, location.name);
                }
                bench.dispose();
            });

            for (const scenario of allScenarios) {
                test(scenario.name, () => {
                    const results = executeScenario(bench, scenario);

                    if (captureMode) {
                        capturedScenarios.push(...results);
                    } else {
                        // Verify each capture checkpoint against golden data
                        for (const actual of results) {
                            const expected = golden?.scenarios.find(s => s.name === actual.name);
                            if (!expected) {
                                throw new Error(
                                    `No golden data for scenario "${actual.name}" in ${faceName}-${location.name}.snap.json. ` +
                                    'Run with CAPTURE=1 to generate baselines.',
                                );
                            }
                            assertScenarioMatch(actual, expected);
                        }
                    }
                });
            }
        });
    }
}

