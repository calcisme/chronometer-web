/**
 * Snapshot utilities for golden-file regression testing.
 *
 * Handles saving, loading, and comparing JSON snapshot files that
 * capture all dynamic part values for a watch face at a given scenario.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { expect } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = join(__dirname, 'snapshots');

// ============================================================================
// Types
// ============================================================================

/** Snapshot of a single dynamic part's values at one point in time. */
export interface PartValueSnapshot {
    partName: string;
    partType: string;
    // Current rendered values
    angle: number;
    angleAnimating: boolean;
    angleTarget: number;
    offsetAngle?: number;
    offsetAngleAnimating?: boolean;
    offsetAngleTarget?: number;
    xMotion?: number;
    xMotionAnimating?: boolean;
    yMotion?: number;
    yMotionAnimating?: boolean;
    // Scheduling info
    nextUpdateDisplayTime: number;
    updateIntervalMs: number;
}

/** All part values captured at a single scenario checkpoint. */
export interface ScenarioSnapshot {
    name: string;
    parts: PartValueSnapshot[];
}

/** Top-level golden file structure. */
export interface GoldenData {
    face: string;
    location: { name: string; lat: number; lon: number; tz: string };
    generatedAt: string;
    scenarios: ScenarioSnapshot[];
}

// ============================================================================
// Capture mode detection
// ============================================================================

/** Returns true if CAPTURE=1 environment variable is set. */
export function isCaptureMode(): boolean {
    return process.env.CAPTURE === '1';
}

// ============================================================================
// File I/O
// ============================================================================

/** Build the golden file path for a face + location combo. */
function goldenPath(faceName: string, locationName: string): string {
    const slug = faceName.toLowerCase().replace(/\s+/g, '-');
    return join(SNAPSHOTS_DIR, `${slug}-${locationName}.snap.json`);
}

/** Load an existing golden file. Returns null if not found. */
export function loadGolden(faceName: string, locationName: string): GoldenData | null {
    const path = goldenPath(faceName, locationName);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'), jsonReviver);
}

/** Save golden data to disk (creates the snapshots/ directory if needed). */
export function saveGolden(data: GoldenData, faceName: string, locationName: string): void {
    if (!existsSync(SNAPSHOTS_DIR)) {
        mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    }
    const path = goldenPath(faceName, locationName);
    writeFileSync(path, JSON.stringify(data, jsonReplacer, 2) + '\n', 'utf-8');
}

// ============================================================================
// JSON Infinity/NaN handling
// ============================================================================

/**
 * JSON.stringify replacer: converts Infinity, -Infinity, and NaN to
 * sentinel strings so they survive the round-trip through JSON.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
    if (typeof value === 'number') {
        if (value === Infinity) return '__Infinity__';
        if (value === -Infinity) return '__-Infinity__';
        if (isNaN(value)) return '__NaN__';
    }
    return value;
}

/**
 * JSON.parse reviver: restores Infinity, -Infinity, and NaN from
 * their sentinel string representations.
 */
function jsonReviver(_key: string, value: unknown): unknown {
    if (value === '__Infinity__') return Infinity;
    if (value === '__-Infinity__') return -Infinity;
    if (value === '__NaN__') return NaN;
    return value;
}

// ============================================================================
// Comparison
// ============================================================================

/** Default numeric tolerance for floating-point comparison. */
const TOLERANCE = 1e-9;

/**
 * Compare two part snapshots, asserting all values match within tolerance.
 * Throws a vitest assertion error on mismatch with a descriptive message.
 */
export function assertPartMatch(
    actual: PartValueSnapshot,
    expected: PartValueSnapshot,
    scenarioName: string,
): void {
    const prefix = `[${scenarioName}] part "${actual.partName}"`;

    expect(actual.partType, `${prefix} partType`).toBe(expected.partType);

    // Angle
    assertClose(actual.angle, expected.angle, `${prefix} angle`);
    expect(actual.angleAnimating, `${prefix} angleAnimating`).toBe(expected.angleAnimating);
    assertClose(actual.angleTarget, expected.angleTarget, `${prefix} angleTarget`);

    // Offset angle (optional)
    if (expected.offsetAngle !== undefined) {
        assertClose(actual.offsetAngle!, expected.offsetAngle, `${prefix} offsetAngle`);
        expect(actual.offsetAngleAnimating, `${prefix} offsetAngleAnimating`).toBe(expected.offsetAngleAnimating);
        assertClose(actual.offsetAngleTarget!, expected.offsetAngleTarget!, `${prefix} offsetAngleTarget`);
    }

    // Linear motions (optional)
    if (expected.xMotion !== undefined) {
        assertClose(actual.xMotion!, expected.xMotion, `${prefix} xMotion`);
        expect(actual.xMotionAnimating, `${prefix} xMotionAnimating`).toBe(expected.xMotionAnimating);
    }
    if (expected.yMotion !== undefined) {
        assertClose(actual.yMotion!, expected.yMotion, `${prefix} yMotion`);
        expect(actual.yMotionAnimating, `${prefix} yMotionAnimating`).toBe(expected.yMotionAnimating);
    }

    // Scheduling
    assertClose(actual.updateIntervalMs, expected.updateIntervalMs, `${prefix} updateIntervalMs`);
    // nextUpdateDisplayTime: compare with tolerance only when finite
    if (isFinite(expected.nextUpdateDisplayTime)) {
        assertClose(actual.nextUpdateDisplayTime, expected.nextUpdateDisplayTime, `${prefix} nextUpdateDisplayTime`);
    } else {
        expect(actual.nextUpdateDisplayTime, `${prefix} nextUpdateDisplayTime`).toBe(expected.nextUpdateDisplayTime);
    }
}

/**
 * Compare two scenario snapshots (all parts).
 */
export function assertScenarioMatch(
    actual: ScenarioSnapshot,
    expected: ScenarioSnapshot,
): void {
    expect(actual.parts.length, `[${actual.name}] part count`).toBe(expected.parts.length);
    for (let i = 0; i < expected.parts.length; i++) {
        assertPartMatch(actual.parts[i], expected.parts[i], actual.name);
    }
}

/**
 * Assert that two numbers are within TOLERANCE of each other.
 */
function assertClose(actual: number, expected: number, label: string): void {
    if (isNaN(expected) && isNaN(actual)) return; // both NaN is ok
    if (!isFinite(expected) && actual === expected) return; // both +Inf or both -Inf
    const diff = Math.abs(actual - expected);
    if (diff > TOLERANCE) {
        expect.soft(actual, `${label} (diff=${diff})`).toBeCloseTo(expected, 9);
    }
}
