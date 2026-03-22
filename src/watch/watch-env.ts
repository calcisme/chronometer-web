/**
 * Watch expression environment setup.
 *
 * Creates an Environment populated with all init-block variables
 * and stub time/astronomy functions for a parsed Watch model.
 */

import {
    createDefaultEnvironment,
    evaluateInit,
    evaluateExpression,
    Environment,
} from '../expr/evaluator.js';
import type { Watch } from './types.js';

/**
 * Build the expression environment for a watch:
 *  1. Math builtins + color constants
 *  2. Evaluate all init blocks (populates watch variables)
 *  3. Register time/astronomy stub functions
 */
export function createWatchEnvironment(watch: Watch): Environment {
    const env = createDefaultEnvironment();

    // Register update interval constants used in hand `update` attrs
    env.variables.set('updateAtNextSunriseOrMidnight', 86400);
    env.variables.set('updateAtNextSunsetOrMidnight', 86400);
    env.variables.set('updateAtNextMoonriseOrMidnight', 86400);
    env.variables.set('updateAtNextMoonsetOrMidnight', 86400);
    env.variables.set('updateAtEnvChangeOnly', 86400);

    // Register stub time functions — return demo values
    // Phase 4 will replace these with real-time calculations
    registerTimeFunctions(env);

    // Evaluate all init blocks in document order
    for (const expr of watch.initExprs) {
        evaluateInit(expr, env);
    }

    return env;
}

/**
 * Evaluate a single attribute expression in the given env.
 * Returns 0 for undefined/empty expressions.
 */
export function evalAttr(expr: string | undefined, env: Environment): number {
    if (!expr || expr.trim() === '') return 0;
    return evaluateExpression(expr.trim(), env);
}

/**
 * Evaluate a color expression and return a CSS color string.
 * The XML uses 0xAARRGGBB format (matching iOS UIColor).
 */
export function evalColor(expr: string | undefined, env: Environment): string {
    if (!expr || expr.trim() === '') return 'rgba(0,0,0,0)';

    // Handle 'clear' specially
    const trimmed = expr.trim();
    if (trimmed === 'clear') return 'rgba(0,0,0,0)';

    const val = evaluateExpression(trimmed, env);
    return argbToCSS(val);
}

/**
 * Convert an ARGB integer (0xAARRGGBB) to a CSS rgba() string.
 */
function argbToCSS(argb: number): string {
    const v = argb >>> 0;  // treat as unsigned 32-bit
    const a = ((v >>> 24) & 0xFF) / 255;
    const r = (v >>> 16) & 0xFF;
    const g = (v >>> 8) & 0xFF;
    const b = v & 0xFF;
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// ============================================================================
// Stub time functions — return fixed demo values for Phase 3
// ============================================================================

function registerTimeFunctions(env: Environment): void {
    const { functions } = env;

    // Clock hands — set to ~10:10:36 for a classic demo position
    functions.set('hour12ValueAngle', () => (10 + 10 / 60) * 2 * Math.PI / 12);
    functions.set('minuteValueAngle', () => 10 * 2 * Math.PI / 60);
    functions.set('secondValueAngle', () => 36 * 2 * Math.PI / 60);
    functions.set('secondNumberAngle', () => 36 * 2 * Math.PI / 60);
    functions.set('secondValue', () => 36);
    functions.set('hour24Number', () => 10);

    // Day/date for calendar wheels
    functions.set('dayNumber', () => 21);
    functions.set('monthNumber', () => 2);    // March (0-indexed)
    functions.set('weekdayNumberAngle', () => 5 * 2 * Math.PI / 7); // Friday

    // Helper that returns days-in-seconds
    functions.set('days', () => 86400);

    // Sun position
    functions.set('sunAzimuth', () => 3.0);     // ~172 degrees
    functions.set('sunAltitude', () => 0.8);    // ~46 degrees

    // Sunrise/sunset
    functions.set('sunriseForDayValid', () => 1);
    functions.set('sunriseForDayHour12ValueAngle', () => 6.25 * 2 * Math.PI / 12);
    functions.set('sunriseForDayMinuteValueAngle', () => 15 * 2 * Math.PI / 60);
    functions.set('sunsetForDayValid', () => 1);
    functions.set('sunsetForDayHour12ValueAngle', () => 6.25 * 2 * Math.PI / 12);
    functions.set('sunsetForDayMinuteValueAngle', () => 15 * 2 * Math.PI / 60);

    // Moon (back side only, but needed for init expressions)
    functions.set('moonAzimuth', () => 1.5);
    functions.set('moonAltitude', () => 0.4);
    functions.set('moonAgeAngle', () => Math.PI / 4);
    functions.set('moonRelativePositionAngle', () => 0);
    functions.set('moonriseForDayValid', () => 1);
    functions.set('moonriseForDayHour12ValueAngle', () => 9 * 2 * Math.PI / 12);
    functions.set('moonriseForDayMinuteValueAngle', () => 30 * 2 * Math.PI / 60);
    functions.set('moonriseForDayHour24Number', () => 21);
    functions.set('moonsetForDayValid', () => 1);
    functions.set('moonsetForDayHour12ValueAngle', () => 7 * 2 * Math.PI / 12);
    functions.set('moonsetForDayMinuteValueAngle', () => 45 * 2 * Math.PI / 60);
    functions.set('moonsetForDayHour24Number', () => 7);

    // Button action stubs (no-ops)
    functions.set('manualSet', () => 0);
    functions.set('timeIsCorrect', () => 1);
    functions.set('inReverse', () => 0);
    functions.set('runningDemo', () => 0);
    functions.set('thisButtonPressed', () => 0);
    functions.set('tick', () => 0);
    functions.set('tock', () => 0);
    functions.set('stemIn', () => 0);
    functions.set('stemOut', () => 0);
    functions.set('goForward', () => 0);
    functions.set('goBackward', () => 0);
    functions.set('reset', () => 0);
    functions.set('advanceHour', () => 0);
    functions.set('advanceDay', () => 0);
    functions.set('advanceMonth', () => 0);
    functions.set('advanceSeconds', () => 0);
    functions.set('advanceToSunriseForDay', () => 0);
    functions.set('advanceToSunsetForDay', () => 0);
    functions.set('advanceToMoonriseForDay', () => 0);
    functions.set('advanceToMoonsetForDay', () => 0);
    functions.set('heading', () => 0);

    // Timezone
    functions.set('tzOffset', () => 0);

    // Calendar wheel helpers
    functions.set('calendarWeekdayStart', () => 0);
}
