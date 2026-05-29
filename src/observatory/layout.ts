/**
 * Observatory responsive layout engine.
 *
 * Computes all widget positions and sizes dynamically from viewport
 * dimensions.  The iOS ref's fixed constants (EOClock.mm L1519–1720)
 * serve as proportional guides — no absolute pixel values are kept.
 *
 * Re-computed on window resize via ResizeObserver in the entry point.
 *
 * iOS reference values (portrait mode, mainR=365):
 *   mainFontSize=32, tickHeight=12.8, plR=332, zR=272, plR2=254,
 *   orbitInc=40, subR=73, sunD=100, zD=526, secLen≈266,
 *   subOffset=149, extDialR=60
 */

const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
// iOS reference constants — used only as proportional ratios
// ---------------------------------------------------------------------------
const REF_MAIN_R = 365;

// ---------------------------------------------------------------------------
// Layout result — consumed by all renderers
// ---------------------------------------------------------------------------

export interface LayoutParams {
    /** Viewport width in CSS pixels */
    viewW: number;
    /** Viewport height in CSS pixels */
    viewH: number;
    /** Device pixel ratio used at layout time */
    dpr: number;

    // --- Main orrery dial ---
    /** Center X of the main dial */
    mainCX: number;
    /** Center Y of the main dial */
    mainCY: number;
    /** Outer radius of the main 24h dial ring */
    mainR: number;
    /** Radius of the inner subdial circle area */
    subR: number;
    /** Zodiac ring radius (inner boundary of zodiac symbols) */
    zR: number;
    /** Side length of the zodiac image */
    zD: number;
    /** Side length of the sun image */
    sunD: number;
    /** Tick height on the outer ring */
    tickHeight: number;
    /** Length of the second-hand tick ring */
    secLen: number;

    // Planet orbit ring
    /** Outer edge of planet region (mainR minus font minus margin) */
    plR: number;
    /** Outermost planet orbit radius */
    plR2: number;
    /** Spacing between concentric planet orbits */
    orbitInc: number;
    /** Width of the sun ring (widest rise/set arc) */
    sunRingWidth: number;

    // Main hand lengths
    h24Len: number;
    h12Len: number;
    minLen: number;
    sunRiseSetLen: number;

    // Hand drawing dimensions
    /** Arrow length for the 24h hand arrowhead */
    h24Arrow: number;
    /** Half-width of the 24h arrow */
    h24Wid: number;
    /** Arrow length for sunrise/sunset/twilight hands */
    sunRiseSetArrow: number;
    /** Tail length for arrow hands (inner endpoint) */
    len2: number;
    /** Breguet 12h hand width param (iOS: 30) */
    breH12Width: number;
    /** Breguet 12h hand center hub radius (iOS: 12) */
    breH12CenterR: number;
    /** Breguet minute hand width param (iOS: 25) */
    breMinWidth: number;
    /** Breguet minute hand center hub radius (iOS: 8) */
    breMinCenterR: number;
    /** Needle (second) hand body width (iOS: 2) */
    secWidth: number;
    /** Needle (second) hand tail ball radius (iOS: 6) */
    secBallR: number;

    // Font sizes (proportional to mainR)
    mainFontSize: number;
    subdialFontSize: number;
    zodiacFontSize: number;
    smallZodiacFontSize: number;

    // --- Inner subdials ---
    /** Subdial offset distance from center */
    subOffset: number;
    utcCX: number;
    utcCY: number;
    solarCX: number;
    solarCY: number;
    sidCX: number;
    sidCY: number;

    // --- Header region (above main dial) ---
    /** Moon phase display */
    moonCX: number;
    moonCY: number;
    moonR: number;

    /** Earth map */
    earthCX: number;
    earthCY: number;
    earthW: number;
    earthH: number;

    // --- Peripheral dials ---
    /** Altitude dial */
    altCX: number;
    altCY: number;
    altR: number;

    /** Azimuth dial */
    azCX: number;
    azCY: number;
    azR: number;

    /** Eclipse simulator */
    eclipseCX: number;
    eclipseCY: number;
    eclipseR1: number;
    eclipseR2: number;

    /** Equation of Time dial */
    eotCX: number;
    eotCY: number;
    eotR: number;

    // --- Date display ---
    dateCX: number;
    dateCY: number;

    // --- Logo ---
    logoCX: number;
    logoCY: number;

    // --- Peripheral font sizes ---
    extFontSize: number;
    eclipseFontSize: number;
    eotFontSize: number;
}

// ---------------------------------------------------------------------------
// Compute layout from viewport
// ---------------------------------------------------------------------------

/**
 * Compute all layout parameters from the viewport dimensions.
 *
 * The layout strategy:
 * 1. The main orrery dial occupies the largest circle that fits
 *    in the center, leaving margins for peripheral dials.
 * 2. Peripheral elements (moon, earth, alt/az/eclipse/eot dials)
 *    are positioned in the corners and margins around the main dial.
 * 3. All sizes are proportional to the main dial radius.
 *
 * iOS portrait layout: 768×1024, mainR=365, center=(0, -77) relative to screen center.
 * The header (blue marble + moon + date) takes ~160px above the main dial.
 * The peripheral dials (alt/az/eclipse/eot) sit 305px from center X, 348px from center Y.
 */
export function computeLayout(viewW: number, viewH: number): LayoutParams {
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;

    // Reserve space for header region (moon/earth/date) and peripheral dials.
    // iOS: header takes ~160px on a 1024px screen = ~15.6%
    // iOS: peripheral dials at extDialOffX=305 from center, extDialR=60
    const headerFrac = 0.16;
    const footerFrac = 0.04;
    const sideMarginPx = 80;  // min side space for peripheral dials

    const availH = viewH * (1 - headerFrac - footerFrac);
    const availW = viewW - sideMarginPx * 2;

    // Main dial radius: largest circle that fits
    const mainR = Math.min(availW, availH) / 2;

    // Center of the main dial: pushed down to make room for header
    const mainCX = viewW / 2;
    const mainCY = viewH * headerFrac + availH / 2;

    // Scale factor relative to iOS reference
    const s = mainR / REF_MAIN_R;

    // --- Derived dimensions (proportional to mainR, matching iOS ratios) ---
    const mainFontSize = Math.max(10, 32 * s);
    const tickHeight = mainFontSize / 2.5;
    const zodiacFontSize = Math.max(8, 36 * s);
    const smallZodiacFontSize = Math.max(6, 11 * s);
    const subdialFontSize = Math.max(6, 10 * s);

    const plR = Math.max(100, 332 * s);         // iOS: mainR-mainFontSize-1 = 365-32-1=332
    const sunRingWidth = Math.max(16, 64 * s);
    const orbitInc = Math.max(10, 40 * s);
    const subR = Math.max(20, 73 * s);           // iOS: (40-1)*2-5=73, scaled uniformly
    const subOffset = Math.max(40, 149 * s);     // iOS: 149
    const sunD = Math.max(24, 100 * s);
    const zD = Math.max(100, 526 * s);
    const zR = Math.max(80, 272 * s);            // iOS: plR-60=332-60=272
    const plR2 = Math.max(60, 254 * s);          // iOS: plR-52-26=332-78=254

    // Hand lengths
    const secLen = (zR - zodiacFontSize / 2) * 1.05;  // iOS: (272-18)*1.05≈266
    const minLen = zR - zodiacFontSize / 2;
    const h12Len = minLen * 0.75;
    const h24Len = mainR - tickHeight * 0.37;
    const sunRiseSetLen = h24Len;

    // Hand drawing dimensions (iOS: EOClock.mm L1676-1689)
    const h24Arrow = 25 * s;
    const h24Wid = h24Arrow / 1.8 / Math.sqrt(3);
    const sunRiseSetArrow = 18 * s;
    const len2 = zR - 5 * s;  // iOS: zR-5, tail length for arrow hands

    // Breguet hand dimensions (iOS: EOClock.mm L2053-2056)
    const breH12Width = 30 * s;     // iOS: hour12Hand width=30
    const breH12CenterR = 12 * s;   // iOS: hour12Hand centerRadius=12
    const breMinWidth = 25 * s;     // iOS: minuteHand width=25
    const breMinCenterR = 8 * s;    // iOS: minuteHand centerRadius=8

    // Needle (second) hand dimensions (iOS: EOClock.mm L2057)
    const secWidth = 2 * s;         // iOS: secondHand width=2
    const secBallR = 6 * s;         // iOS: secondHand ballRadius=6

    // --- Inner subdials (positioned relative to main center) ---
    // iOS CG coords (Y-up):
    //   UTC at (0, +subOffset) = above center
    //   Solar at (-subOffset*cos30, -subOffset*sin30) = below-left
    //   Sidereal at (+subOffset*cos30, -subOffset*sin30) = below-right
    // Canvas coords (Y-down): negate Y offsets
    const cos30 = Math.cos(Math.PI / 6);  // ≈0.866
    const sin30 = Math.sin(Math.PI / 6);  // =0.5

    const utcCX = mainCX;
    const utcCY = mainCY - subOffset;              // above center
    const solarCX = mainCX - subOffset * cos30;
    const solarCY = mainCY + subOffset * sin30;    // below center, left
    const sidCX = mainCX + subOffset * cos30;
    const sidCY = mainCY + subOffset * sin30;      // below center, right

    // --- Peripheral dials ---
    // iOS portrait: extDialOffX=305, extDialOffY=348, extDialR=60
    const extDialR = Math.max(25, 60 * s);
    const extDialOffX = Math.max(80, 305 * s);
    const extDialOffY = Math.max(80, 348 * s);

    // Clamp peripheral positions to stay within viewport
    const altR = extDialR;
    const altCX = Math.max(altR + 5, mainCX - extDialOffX);
    const altCY = Math.min(viewH - altR - 5, mainCY + extDialOffY);
    const azR = extDialR;
    const azCX = Math.max(azR + 5, mainCX - extDialOffX);
    const azCY = Math.max(azR + 5, mainCY - extDialOffY);

    const eclipseR2 = extDialR + 3 * s;
    const eclipseR1 = eclipseR2 - 14 * s;
    const eclipseCX = Math.min(viewW - eclipseR2 - 5, mainCX + extDialOffX);
    const eclipseCY = Math.min(viewH - eclipseR2 - 5, mainCY + extDialOffY);

    const eotR = extDialR;
    const eotCX = Math.min(viewW - eotR - 5, mainCX + extDialOffX);
    const eotCY = Math.max(eotR + 5, mainCY - extDialOffY);

    // --- Header elements ---
    // iOS portrait: bmw=300, ChandraR=75, Chandra at (-384+75+width/4, top-75-2)
    // Moon: upper-left area
    const moonR = Math.max(30, 75 * s);
    const moonCX = mainCX - mainR * 0.5;
    const moonCY = mainCY - mainR - moonR * 0.4;

    // Earth map: upper-center area
    const earthW = Math.max(80, 300 * s);
    const earthH = earthW / 2;
    const earthCX = mainCX + mainR * 0.15;
    const earthCY = mainCY - mainR - earthH * 0.3;

    // Date display: right of earth
    const dateCX = mainCX + mainR * 0.6;
    const dateCY = mainCY - mainR - earthH * 0.3;

    // Logo: bottom center
    const logoCX = mainCX;
    const logoCY = viewH - 15;

    // Peripheral font sizes
    const extFontSize = Math.max(7, 10 * s);
    const eclipseFontSize = Math.max(7, 10 * s);
    const eotFontSize = Math.max(6, 8 * s);

    return {
        viewW, viewH, dpr,
        mainCX, mainCY, mainR,
        subR, zR, zD, sunD, tickHeight, secLen,
        plR, plR2, orbitInc, sunRingWidth,
        h24Len, h12Len, minLen, sunRiseSetLen,
        h24Arrow, h24Wid, sunRiseSetArrow, len2,
        breH12Width, breH12CenterR, breMinWidth, breMinCenterR,
        secWidth, secBallR,
        mainFontSize, subdialFontSize, zodiacFontSize, smallZodiacFontSize,
        subOffset, utcCX, utcCY, solarCX, solarCY, sidCX, sidCY,
        moonCX, moonCY, moonR,
        earthCX, earthCY, earthW, earthH,
        altCX, altCY, altR,
        azCX, azCY, azR,
        eclipseCX, eclipseCY, eclipseR1, eclipseR2,
        eotCX, eotCY, eotR,
        dateCX, dateCY,
        logoCX, logoCY,
        extFontSize, eclipseFontSize, eotFontSize,
    };
}
