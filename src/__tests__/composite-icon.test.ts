import { describe, test, expect } from 'vitest';
import { 
    getBezelBackgroundColor, 
    parseColorToRgb, 
    getAverageBezelBackgroundColor 
} from '../shared/composite-icon.js';

describe('Color Parsing Helpers (parseColorToRgb)', () => {
    test('Parses rgb() format correctly', () => {
        expect(parseColorToRgb('rgb(160, 160, 160)')).toEqual({ r: 160, g: 160, b: 160 });
        expect(parseColorToRgb('RGB(255,0,10)')).toEqual({ r: 255, g: 0, b: 10 });
    });

    test('Parses hex format correctly', () => {
        expect(parseColorToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
        expect(parseColorToRgb('#aaa')).toEqual({ r: 170, g: 170, b: 170 });
    });

    test('Handles invalid formats gracefully', () => {
        expect(parseColorToRgb('')).toBeNull();
        expect(parseColorToRgb('invalid')).toBeNull();
        expect(parseColorToRgb('blue')).toBeNull();
    });
});

describe('Composite Icon Background Calculations', () => {
    test('Calculates background color from rgb() bezel colors correctly', () => {
        // Geneva bezel color: rgb(160, 160, 160) -> rgb(53, 53, 53)
        expect(getBezelBackgroundColor('rgb(160, 160, 160)')).toBe('rgb(53, 53, 53)');
        expect(getBezelBackgroundColor('RGB(160,160,160)')).toBe('rgb(53, 53, 53)');

        // Terra bezel color: rgb(180, 150, 130) -> rgb(60, 50, 43)
        expect(getBezelBackgroundColor('rgb(180, 150, 130)')).toBe('rgb(60, 50, 43)');

        // Edge case checks
        expect(getBezelBackgroundColor('rgb(0, 0, 0)')).toBe('rgb(0, 0, 0)');
        expect(getBezelBackgroundColor('rgb(255, 255, 255)')).toBe('rgb(85, 85, 85)');
    });

    test('Calculates background color from hex bezel colors correctly', () => {
        // 6-digit hex
        expect(getBezelBackgroundColor('#a0a0a0')).toBe('rgb(53, 53, 53)');
        expect(getBezelBackgroundColor('#ffffff')).toBe('rgb(85, 85, 85)');

        // 3-digit hex
        expect(getBezelBackgroundColor('#aaa')).toBe('rgb(57, 57, 57)'); // rgb(170, 170, 170) -> 170/3 = 56.66 -> round to 57
        expect(getBezelBackgroundColor('#000')).toBe('rgb(0, 0, 0)');
    });

    test('Handles fallback for invalid or missing bezel colors', () => {
        expect(getBezelBackgroundColor('')).toBe('#000000');
        expect(getBezelBackgroundColor('invalid')).toBe('#000000');
        expect(getBezelBackgroundColor('blue')).toBe('#000000');
    });
});

describe('Average Bezel Background Calculation', () => {
    test('Falls back to default dark blue when empty or invalid', () => {
        expect(getAverageBezelBackgroundColor()).toBe('#1a1a2e');
        expect(getAverageBezelBackgroundColor([])).toBe('#1a1a2e');
        expect(getAverageBezelBackgroundColor(['', 'invalid'])).toBe('#1a1a2e');
    });

    test('Handles single bezel color correctly', () => {
        expect(getAverageBezelBackgroundColor('rgb(160, 160, 160)')).toBe('rgb(53, 53, 53)');
        expect(getAverageBezelBackgroundColor(['rgb(160, 160, 160)'])).toBe('rgb(53, 53, 53)');
    });

    test('Averages two grey bezel backgrounds correctly', () => {
        // Geneva background: rgb(53, 53, 53)
        // Vienna background: rgb(200, 195, 180) -> 200/3 = 66.6 -> 67; 195/3 = 65; 180/3 = 60 -> rgb(67, 65, 60)
        // Average:
        // R: (53 + 67)/2 = 60
        // G: (53 + 65)/2 = 59
        // B: (53 + 60)/2 = 56.5 -> 57
        expect(getAverageBezelBackgroundColor(['rgb(160, 160, 160)', 'rgb(200, 195, 180)'])).toBe('rgb(60, 59, 57)');
    });

    test('Averages different hue bezel backgrounds correctly', () => {
        // Geneva: rgb(160,160,160) -> bg rgb(53,53,53)
        // Terra: rgb(180,150,130) -> bg rgb(60,50,43)
        // Average:
        // R: (53 + 60)/2 = 56.5 -> 57
        // G: (53 + 50)/2 = 51.5 -> 52
        // B: (53 + 43)/2 = 48
        expect(getAverageBezelBackgroundColor(['rgb(160, 160, 160)', 'rgb(180, 150, 130)'])).toBe('rgb(57, 52, 48)');
    });

    test('Handles mixed hex and rgb formats', () => {
        // Geneva: rgb(160,160,160) -> bg rgb(53,53,53)
        // Terra: #b49682 (180,150,130) -> bg rgb(60,50,43)
        expect(getAverageBezelBackgroundColor(['rgb(160, 160, 160)', '#b49682'])).toBe('rgb(57, 52, 48)');
    });
});

describe('Layout Math Geometry Rules', () => {
    test('Diagonal 2-face layout size and overlap verification', () => {
        const d = 230; // Diameter
        // Centers:
        const cx1 = 115, cy1 = 115;
        const cx2 = 285, cy2 = 285;

        // Verify distance between centers is greater than the sum of radii (no overlap)
        const centerDistance = Math.sqrt((cx2 - cx1) ** 2 + (cy2 - cy1) ** 2);
        const sumRadii = d; // R1 + R2 = 115 + 115 = 230
        expect(centerDistance).toBeGreaterThan(sumRadii);
        expect(centerDistance).toBeCloseTo(240.416, 3);
        // The watch faces will have a gap of ~10.4 pixels
        expect(centerDistance - sumRadii).toBeGreaterThan(10);
    });

    test('Asymmetric 3-face packing size and touching verification', () => {
        const dTop = 225; // Top face diameter (R1 = 112.5)
        const dBottom = 200; // Bottom faces diameter (R2 = R3 = 100)

        // Centers:
        const cx1 = 200, cy1 = 112.5; // Top face
        const cx2 = 100, cy2 = 300;   // Bottom-Left face
        const cx3 = 300, cy3 = 300;   // Bottom-Right face

        // 1. Verify top circle touches bottom-left circle precisely (distance = R1 + R2)
        const dist1_2 = Math.sqrt((cx1 - cx2) ** 2 + (cy1 - cy2) ** 2);
        const sumRadii1_2 = 112.5 + 100; // 212.5
        expect(dist1_2).toBe(sumRadii1_2);

        // 2. Verify top circle touches bottom-right circle precisely (distance = R1 + R3)
        const dist1_3 = Math.sqrt((cx1 - cx3) ** 2 + (cy1 - cy3) ** 2);
        const sumRadii1_3 = 112.5 + 100; // 212.5
        expect(dist1_3).toBe(sumRadii1_3);

        // 3. Verify bottom circles do not overlap (their width is exactly 400 side-by-side)
        const dist2_3 = Math.sqrt((cx2 - cx3) ** 2 + (cy2 - cy3) ** 2);
        const sumRadii2_3 = 100 + 100; // 200
        expect(dist2_3).toBe(sumRadii2_3);

        // 4. Verify everything fits inside the 400x400 canvas bounds
        // Top edge of top circle:
        expect(cy1 - 112.5).toBe(0);
        // Bottom edge of bottom circles:
        expect(cy2 + 100).toBe(400);
        // Left edge of bottom-left circle:
        expect(cx2 - 100).toBe(0);
        // Right edge of bottom-right circle:
        expect(cx3 + 100).toBe(400);
    });
});
