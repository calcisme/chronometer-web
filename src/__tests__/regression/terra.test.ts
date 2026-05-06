/**
 * Terra watch face regression tests.
 *
 * Tests all dynamic parts across all reference times and locations.
 * Run with CAPTURE=1 to generate golden baselines.
 */

import { describe } from 'vitest';
import { runFaceRegressionSuite } from '../test-bench.js';

describe('Terra regression', () => {
    runFaceRegressionSuite('Terra');
});
