/**
 * Observatory responsive layout engine (Phase 8 — rebuilt from scratch).
 *
 * Strategy (see planning/2026-06-06-observatory-phase-8-layout.md):
 *
 *   1. Pick a template by window aspect ratio, mirroring the iOS app's
 *      portrait/landscape flip (with a small hysteresis dead-band).
 *   2. Size the central dial *adaptively*: grow it toward 0.95 × the shorter
 *      window dimension whenever the longer dimension has slack to hold the
 *      other elements; fall back toward a 0.75 floor only near square.
 *      The dial may grow without bound with the window.
 *   3. Priority cascade: dial → map → peripherals. The four peripheral dials
 *      and the map/moon/date fill the leftover margins and never steal space
 *      the dial could use. Peripheral-dial size is NOT tied to the main dial —
 *      it fills the available margin, capped at ≈ half the main-dial radius.
 *
 * Everything *inside* the main dial (rings, planets, the three inner subdials,
 * fonts) still scales as a fixed multiple of `mainR` via `s = mainR / 365`,
 * exactly as the iOS reference draws it. Only the outer composition is new.
 *
 * The logo is intentionally dropped (the company is gone; no IP to protect).
 */

// iOS reference: the whole main dial was authored at mainR = 365.
const REF_MAIN_R = 365;

// --- Adaptive sizing knobs (tunable; see plan §7) -------------------------
/** Max dial diameter as a fraction of the shorter window dimension. */
const DIAL_FRAC_MAX = 0.95;
/** Min dial diameter as a fraction of the shorter window dimension (floor). */
const DIAL_FRAC_MIN = 0.75;
/** Peripheral-dial radius cap, as a fraction of the main-dial radius. */
const EXT_R_CAP_FRAC = 0.45;

// --- Template selection with hysteresis -----------------------------------
type Template = 'portrait' | 'landscape';
/** Aspect (W/H) at/above which we switch *into* landscape. */
const CROSS_UP = 1.15;
/** Aspect (W/H) at/below which we switch *back into* portrait. */
const CROSS_DOWN = 1.05;
/** Remembered template so the dead-band can apply (module-level state). */
let lastTemplate: Template = 'portrait';

function chooseTemplate(w: number, h: number): Template {
    const a = w / h;
    if (a >= CROSS_UP) lastTemplate = 'landscape';
    else if (a <= CROSS_DOWN) lastTemplate = 'portrait';
    // else: inside the dead-band — keep whatever we had.
    return lastTemplate;
}

// ---------------------------------------------------------------------------
// Layout result — consumed by all renderers
// ---------------------------------------------------------------------------

export interface LayoutParams {
    viewW: number;
    viewH: number;
    dpr: number;

    // --- Main orrery dial ---
    mainCX: number;
    mainCY: number;
    mainR: number;
    subR: number;
    zR: number;
    zD: number;
    sunD: number;
    tickHeight: number;
    secLen: number;

    // Planet orbit ring
    plR: number;
    plR2: number;
    orbitInc: number;
    sunRingWidth: number;

    // Main hand lengths
    h24Len: number;
    h12Len: number;
    minLen: number;
    sunRiseSetLen: number;

    // Hand drawing dimensions
    h24Arrow: number;
    h24Wid: number;
    sunRiseSetArrow: number;
    len2: number;
    breH12Width: number;
    breH12CenterR: number;
    breMinWidth: number;
    breMinCenterR: number;
    secWidth: number;
    secBallR: number;

    // Font sizes (proportional to mainR)
    mainFontSize: number;
    subdialFontSize: number;
    zodiacFontSize: number;
    smallZodiacFontSize: number;

    // --- Inner subdials ---
    subOffset: number;
    utcCX: number;
    utcCY: number;
    solarCX: number;
    solarCY: number;
    sidCX: number;
    sidCY: number;

    // --- Header region ---
    moonCX: number;
    moonCY: number;
    moonR: number;

    earthCX: number;
    earthCY: number;
    earthW: number;
    earthH: number;

    // --- Peripheral dials ---
    altCX: number;
    altCY: number;
    altR: number;

    azCX: number;
    azCY: number;
    azR: number;

    eclipseCX: number;
    eclipseCY: number;
    eclipseR1: number;
    eclipseR2: number;

    eotCX: number;
    eotCY: number;
    eotR: number;

    // --- Date display ---
    dateCX: number;
    dateCY: number;

    // --- Peripheral font sizes ---
    extFontSize: number;
    eclipseFontSize: number;
    eotFontSize: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Largest axis-aligned rectangle of the given aspect (w/h) anchored into a
 * window corner (inset by `g`), that stays `g` clear of the main circle.
 * Returns the rectangle's width (height = width / aspect).
 *
 * `corner`: signs of (x, y) pointing away from center, i.e. TR = (+1, -1).
 */
function largestCornerRect(
    signX: number, signY: number,
    cx: number, cy: number, mainR: number,
    W: number, H: number, g: number, aspect: number,
): { w: number; h: number; cx: number; cy: number } {
    const maxW = W - 2 * g;
    const maxH = H - 2 * g;
    // Binary search the largest feasible width.
    let lo = 0, hi = Math.min(maxW, maxH * aspect);
    const feasible = (w: number): boolean => {
        const h = w / aspect;
        if (h > maxH) return false;
        // Rectangle anchored to the corner: the outer corner sits at the window
        // corner (inset g); the rectangle extends inward.
        const outerX = signX > 0 ? W - g : g;
        const outerY = signY > 0 ? H - g : g;
        const innerX = outerX - signX * w;
        const innerY = outerY - signY * h;
        // The inner corner (nearest the center) is the binding point.
        const dx = innerX - cx;
        const dy = innerY - cy;
        return Math.hypot(dx, dy) >= mainR + g;
    };
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (feasible(mid)) lo = mid; else hi = mid;
    }
    const w = lo;
    const h = w / aspect;
    const outerX = signX > 0 ? W - g : g;
    const outerY = signY > 0 ? H - g : g;
    return { w, h, cx: outerX - signX * w / 2, cy: outerY - signY * h / 2 };
}

// ---------------------------------------------------------------------------
// Internal main-dial geometry (all proportional to mainR via s) — unchanged
// from the original layout; these draw the rings/planets/subdials.
// ---------------------------------------------------------------------------

interface InnerDial {
    s: number;
    mainFontSize: number; tickHeight: number; zodiacFontSize: number;
    smallZodiacFontSize: number; subdialFontSize: number;
    plR: number; sunRingWidth: number; orbitInc: number; subR: number;
    subOffset: number; sunD: number; zD: number; zR: number; plR2: number;
    secLen: number; minLen: number; h12Len: number; h24Len: number;
    sunRiseSetLen: number; h24Arrow: number; h24Wid: number;
    sunRiseSetArrow: number; len2: number;
    breH12Width: number; breH12CenterR: number; breMinWidth: number;
    breMinCenterR: number; secWidth: number; secBallR: number;
}

function innerDialGeometry(mainR: number): InnerDial {
    const s = mainR / REF_MAIN_R;

    const mainFontSize = 32 * s;
    const tickHeight = mainFontSize / 2.5;
    const zodiacFontSize = 36 * s;
    const smallZodiacFontSize = 11 * s;
    const subdialFontSize = 10 * s;

    const plR = Math.max(100, 332 * s);
    const sunRingWidth = Math.max(16, 64 * s);
    const orbitInc = Math.max(10, 40 * s);
    const subR = Math.max(20, 73 * s);
    const subOffset = Math.max(40, 149 * s);
    const sunD = Math.max(24, 100 * s);
    const zD = Math.max(100, 526 * s);
    const zR = Math.max(80, 272 * s);
    const plR2 = Math.max(60, 254 * s);

    const secLen = (zR - zodiacFontSize / 2) * 1.05;
    const minLen = zR - zodiacFontSize / 2;
    const h12Len = minLen * 0.75;
    const h24Len = mainR - tickHeight * 0.37;
    const sunRiseSetLen = h24Len;

    const h24Arrow = 25 * s;
    const h24Wid = h24Arrow / 1.8 / Math.sqrt(3);
    const sunRiseSetArrow = 18 * s;
    const len2 = zR - 5 * s;

    const breH12Width = 30 * s;
    const breH12CenterR = 12 * s;
    const breMinWidth = 25 * s;
    const breMinCenterR = 8 * s;
    const secWidth = 2 * s;
    const secBallR = 6 * s;

    return {
        s, mainFontSize, tickHeight, zodiacFontSize, smallZodiacFontSize,
        subdialFontSize, plR, sunRingWidth, orbitInc, subR, subOffset, sunD,
        zD, zR, plR2, secLen, minLen, h12Len, h24Len, sunRiseSetLen, h24Arrow,
        h24Wid, sunRiseSetArrow, len2, breH12Width, breH12CenterR, breMinWidth,
        breMinCenterR, secWidth, secBallR,
    };
}

/** Inner-subdial centers (UTC top, Solar lower-left, Sidereal lower-right). */
function innerSubdials(mainCX: number, mainCY: number, subOffset: number) {
    const cos30 = Math.cos(Math.PI / 6);
    const sin30 = Math.sin(Math.PI / 6);
    return {
        utcCX: mainCX, utcCY: mainCY - subOffset,
        solarCX: mainCX - subOffset * cos30, solarCY: mainCY + subOffset * sin30,
        sidCX: mainCX + subOffset * cos30, sidCY: mainCY + subOffset * sin30,
    };
}

/** Eclipse annulus radii + peripheral font sizes, proportional to the ext dial. */
function extDerived(extR: number) {
    const es = extR / 60;            // iOS authored ext dials at R = 60
    return {
        eclipseR2: extR + 3 * es,
        eclipseR1: extR + 3 * es - 14 * es,
        extFontSize: 10 * es,
        eclipseFontSize: 10 * es,
        eotFontSize: 8 * es,
    };
}

// ---------------------------------------------------------------------------
// Compute layout from viewport
// ---------------------------------------------------------------------------

export function computeLayout(viewW: number, viewH: number): LayoutParams {
    const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1;
    const template = chooseTemplate(viewW, viewH);

    // Gap minimum: 8px apparent, relaxing toward ~2px on small/dense windows.
    const minDim = Math.min(viewW, viewH);
    const g = clamp(minDim / 96, 4 / dpr, 8);

    return template === 'landscape'
        ? computeLandscape(viewW, viewH, dpr, g)
        : computePortrait(viewW, viewH, dpr, g);
}

// --- Portrait (tall / square): header on top, dials in the corner gaps -----
function computePortrait(W: number, H: number, dpr: number, g: number): LayoutParams {
    // Header band: map (center), moon (left), date (right) across the top.
    const mapW = clamp(0.42 * W, 150, 0.55 * W);
    const mapH = mapW / 2;
    const moonR = mapH * 0.45;
    const headerBand = mapH + 2 * g;

    // Adaptive dial: fill the width, but leave room for the header on the tall axis.
    const D = clamp(
        Math.min(DIAL_FRAC_MAX * W, H - headerBand - 2 * g),
        DIAL_FRAC_MIN * W,
        DIAL_FRAC_MAX * W,
    );
    const mainR = D / 2;
    const mainCX = W / 2;
    // Vertically center the (header + dial) block when the window is taller than
    // it needs to be (e.g. phones): balanced rather than top-pinned with a big
    // empty band below. No effect on iPad-portrait, where the block fills H.
    const contentH = headerBand + g + D;
    const topPad = Math.max(0, (H - contentH) / 2);
    const mainCY = topPad + headerBand + g + mainR;

    const inner = innerDialGeometry(mainR);

    // Peripheral dials sit in the four corner gaps of the (near-full-width)
    // circle. Those gaps are narrow in portrait, so the dials stay close to the
    // iOS proportions (extR ≈ 0.165·mainR) with only modest growth.
    const extR = clamp(0.165 * mainR, 22, 0.20 * mainR);
    const ext = extDerived(extR);
    // iOS portrait offsets, as proportions of mainR.
    const offX = 0.835 * mainR;
    const offY = 0.954 * mainR;
    // Clamp so the dials stay on-screen, below the header, and above the floor.
    const cxL = clamp(mainCX - offX, g + extR, mainCX);
    const cxR = clamp(mainCX + offX, mainCX, W - g - extR);
    const cyHi = clamp(mainCY - offY, topPad + headerBand + g + extR, mainCY);
    const cyLo = clamp(mainCY + offY, mainCY, H - g - extR);
    // alt UL, az LL, eclipse UR, eot LR (matching iOS portrait).
    const altCX = cxL, altCY = cyHi;
    const azCX = cxL, azCY = cyLo;
    const eclipseCX = cxR, eclipseCY = cyHi;
    const eotCX = cxR, eotCY = cyLo;

    // Header element placement (offset by topPad so it tracks the centered block).
    const earthCX = W / 2;
    const earthCY = topPad + g + mapH / 2;
    const leftGapCenter = (g + (W / 2 - mapW / 2)) / 2;
    const moonCX = Math.max(g + moonR, leftGapCenter);
    const moonCY = topPad + g + moonR;
    const dateCX = (W / 2 + mapW / 2 + (W - g)) / 2;
    const dateCY = topPad + g;

    return assemble({
        viewW: W, viewH: H, dpr,
        mainCX, mainCY, mainR, inner,
        moonCX, moonCY, moonR,
        earthCX, earthCY, earthW: mapW, earthH: mapH,
        altCX, altCY, azCX, azCY, eclipseCX, eclipseCY, eotCX, eotCY,
        extR, ext, dateCX, dateCY,
    });
}

// --- Landscape (wide): dial centered, dials in side margins, map top-right --
function computeLandscape(W: number, H: number, dpr: number, g: number): LayoutParams {
    // Reserve a minimum side band so the dial doesn't crowd out the peripherals.
    const minSideBand = 56;
    const D = clamp(
        Math.min(DIAL_FRAC_MAX * H, W - 2 * (minSideBand + g)),
        DIAL_FRAC_MIN * H,
        DIAL_FRAC_MAX * H,
    );
    const mainR = D / 2;
    const mainCX = W / 2;
    const mainCY = H / 2;

    const inner = innerDialGeometry(mainR);

    const sideMargin = (W - D) / 2;         // = W/2 - mainR
    // A dial nestled beside the circle at mid-height must fit: extR ≤ sideMargin/2 − g.
    const extR = clamp(
        Math.min(EXT_R_CAP_FRAC * mainR, sideMargin / 2 - g),
        20,
        EXT_R_CAP_FRAC * mainR,
    );
    const ext = extDerived(extR);

    // Moon: top-left corner (kept small so the left column also holds two dials).
    const moonR = clamp(0.11 * D, 22, 0.16 * D);
    const moonCX = g + moonR;
    const moonCY = g + moonR;

    // Map: largest 2:1 box in the top-right corner, clear of the dial.
    const mapBox = largestCornerRect(+1, -1, mainCX, mainCY, mainR, W, H, g, 2);
    const earthW = mapBox.w;
    const earthH = mapBox.h;
    const earthCX = mapBox.cx;
    const earthCY = mapBox.cy;

    // Two dials per side, nestled just outside the circle, stacked vertically
    // around center — but pushed below the moon (left) / map (right) so the
    // top-corner element never collides with the upper dial.
    const xOff = mainR + extR + g;
    const xL = mainCX - xOff, xR = mainCX + xOff;
    const upperLeftY = Math.max(mainCY - extR - g / 2, 2 * moonR + 2 * g + extR);
    const mapBottom = earthCY + earthH / 2;
    const upperRightY = Math.max(mainCY - extR - g / 2, mapBottom + g + extR);
    const altCX = xL, altCY = upperLeftY;                 // upper-left
    const azCX = xL, azCY = upperLeftY + 2 * extR + g;    // lower-left
    const eclipseCX = xR, eclipseCY = upperRightY;             // upper-right
    const eotCX = xR, eotCY = upperRightY + 2 * extR + g;      // lower-right

    // Date: bottom-left, below the lower-left dial.
    const dateCX = xL;
    const dateCY = azCY + extR + g;

    return assemble({
        viewW: W, viewH: H, dpr,
        mainCX, mainCY, mainR, inner,
        moonCX, moonCY, moonR,
        earthCX, earthCY, earthW, earthH,
        altCX, altCY, azCX, azCY, eclipseCX, eclipseCY, eotCX, eotCY,
        extR, ext, dateCX, dateCY,
    });
}

// --- Assemble the flat LayoutParams from the computed pieces ---------------
interface AssembleArgs {
    viewW: number; viewH: number; dpr: number;
    mainCX: number; mainCY: number; mainR: number; inner: InnerDial;
    moonCX: number; moonCY: number; moonR: number;
    earthCX: number; earthCY: number; earthW: number; earthH: number;
    altCX: number; altCY: number; azCX: number; azCY: number;
    eclipseCX: number; eclipseCY: number; eotCX: number; eotCY: number;
    extR: number;
    ext: ReturnType<typeof extDerived>;
    dateCX: number; dateCY: number;
}

function assemble(a: AssembleArgs): LayoutParams {
    const i = a.inner;
    const subs = innerSubdials(a.mainCX, a.mainCY, i.subOffset);
    return {
        viewW: a.viewW, viewH: a.viewH, dpr: a.dpr,
        mainCX: a.mainCX, mainCY: a.mainCY, mainR: a.mainR,
        subR: i.subR, zR: i.zR, zD: i.zD, sunD: i.sunD,
        tickHeight: i.tickHeight, secLen: i.secLen,
        plR: i.plR, plR2: i.plR2, orbitInc: i.orbitInc, sunRingWidth: i.sunRingWidth,
        h24Len: i.h24Len, h12Len: i.h12Len, minLen: i.minLen, sunRiseSetLen: i.sunRiseSetLen,
        h24Arrow: i.h24Arrow, h24Wid: i.h24Wid, sunRiseSetArrow: i.sunRiseSetArrow, len2: i.len2,
        breH12Width: i.breH12Width, breH12CenterR: i.breH12CenterR,
        breMinWidth: i.breMinWidth, breMinCenterR: i.breMinCenterR,
        secWidth: i.secWidth, secBallR: i.secBallR,
        mainFontSize: i.mainFontSize, subdialFontSize: i.subdialFontSize,
        zodiacFontSize: i.zodiacFontSize, smallZodiacFontSize: i.smallZodiacFontSize,
        subOffset: i.subOffset,
        utcCX: subs.utcCX, utcCY: subs.utcCY,
        solarCX: subs.solarCX, solarCY: subs.solarCY,
        sidCX: subs.sidCX, sidCY: subs.sidCY,
        moonCX: a.moonCX, moonCY: a.moonCY, moonR: a.moonR,
        earthCX: a.earthCX, earthCY: a.earthCY, earthW: a.earthW, earthH: a.earthH,
        altCX: a.altCX, altCY: a.altCY, altR: a.extR,
        azCX: a.azCX, azCY: a.azCY, azR: a.extR,
        eclipseCX: a.eclipseCX, eclipseCY: a.eclipseCY,
        eclipseR1: a.ext.eclipseR1, eclipseR2: a.ext.eclipseR2,
        eotCX: a.eotCX, eotCY: a.eotCY, eotR: a.extR,
        dateCX: a.dateCX, dateCY: a.dateCY,
        extFontSize: a.ext.extFontSize,
        eclipseFontSize: a.ext.eclipseFontSize,
        eotFontSize: a.ext.eotFontSize,
    };
}
