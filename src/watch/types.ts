/**
 * Type definitions for the Chronometer watch model.
 *
 * Each XML element type in a watch definition maps to a typed interface.
 * Numeric attribute values are stored as expression strings (not pre-evaluated)
 * so the rendering layer can re-evaluate dynamic attributes per-frame.
 */

import type { ASTNode } from '../expr/parser.js';

// ============================================================================
// Watch (top level)
// ============================================================================

export interface Watch {
    name: string;
    beatsPerSecond: string;
    /** Diameter of the watch face in XML coordinate units (from faceWidth attribute). */
    faceWidth: number;
    /** CSS color string for the surrounding bezel ring. Empty string means no bezel. */
    bezelColor: string;
    /** If true, draw a fine noon-indicator line at the top of the bezel. */
    bezelNoonMark: boolean;
    /** All `<init expr="...">` blocks in document order. */
    initExprs: ASTNode[];
    /** All parts included for the selected mode, in document order. */
    parts: WatchPart[];
}

// ============================================================================
// Part union type
// ============================================================================

export type WatchPart =
    | QDialPart
    | QHandPart
    | WheelPart
    | QTextPart
    | ImagePart
    | ButtonPart
    | WindowPart
    | StaticPart
    | QRectPart
    | TerminatorPart
    | QWedgePart
    | QDayNightRingPart;

// ============================================================================
// Shared base for all parts
// ============================================================================

/**
 * Runtime animation state, separate from parsed XML data.
 * Populated by the animation system; read by the renderer.
 */
export interface DynamicState {
    /** Current interpolated angle (radians), set by the animation system. */
    currentAngle: number;
    /** Current interpolated offsetAngle (radians), for offset-orbit hands like the Moon. */
    currentOffsetAngle?: number;
    // Future: currentX, currentY for linear animation
}

export interface PartBase {
    name: string;
    x?: ASTNode;
    y?: ASTNode;
    modes?: string;
    /** Runtime animation state — populated by the animation system, not by XML parsing. */
    dynamicState?: DynamicState;
}

// ============================================================================
// QDial — circular dial with marks, text, tick marks
// ============================================================================

export interface QDialPart extends PartBase {
    type: 'QDial';
    radius?: ASTNode;
    radius2?: ASTNode;
    clipRadius?: ASTNode;
    orientation?: string;     // 'upright' | 'demi' | 'radial' etc.
    demiTweak?: ASTNode;
    text?: string;
    fontSize?: ASTNode;
    fontName?: string;
    bgColor?: ASTNode;
    strokeColor?: ASTNode;
    fillColor1?: ASTNode;
    fillColor2?: ASTNode;
    marks?: string;           // 'outer' | 'center' | 'tickOut' | 'dot' | 'none' etc.
    markWidth?: ASTNode;
    nMarks?: ASTNode;
    mSize?: ASTNode;
    angle?: ASTNode;
    angle0?: ASTNode;
    angle1?: ASTNode;
    angle2?: ASTNode;
    update?: ASTNode;
    updateOffset?: ASTNode;
    kind?: string;
    z?: ASTNode;
    thick?: ASTNode;
}

// ============================================================================
// QHand — drawn hand (rect, tri, or default triangle)
// ============================================================================

export interface QHandPart extends PartBase {
    type: 'QHand';
    angle?: ASTNode;
    length?: ASTNode;
    length2?: ASTNode;
    width?: ASTNode;
    tail?: ASTNode;
    handType?: string;         // 'rect' | 'tri' (stored from XML `type` attr)
    strokeColor?: ASTNode;
    fillColor?: ASTNode;
    lineWidth?: ASTNode;
    kind?: string;             // 'hour12Kind' | 'minuteKind' | 'secondKind' etc.
    update?: ASTNode;
    updateOffset?: ASTNode;
    z?: ASTNode;
    thick?: ASTNode;
    animSpeed?: ASTNode;
    dragAnimationType?: string;
    // Arrow overlay attributes
    oLength?: ASTNode;
    oWidth?: ASTNode;
    oTail?: ASTNode;
    oLineWidth?: ASTNode;
    oStrokeColor?: ASTNode;
    oFillColor?: ASTNode;
    oCenter?: ASTNode;
    oRadius?: ASTNode;
    tFillColor?: ASTNode;
    tStrokeColor?: ASTNode;
    tLineWidth?: ASTNode;
    /** Image source path (for image-based `hand` elements). */
    src?: string;
    /** Image anchor X offset in XML coords. */
    xAnchor?: ASTNode;
    /** Image anchor Y offset in XML coords. */
    yAnchor?: ASTNode;
    /** Polar offset radius (e.g. moon orbiting 24-hr dial). */
    offsetRadius?: ASTNode;
    /** Polar offset angle expression. */
    offsetAngle?: ASTNode;
    /** Number of rays for 'sun' hand type. */
    nRays?: ASTNode;
}

// ============================================================================
// Wheel — SWheel, QWheel, Swheel (rotating text wheel)
// ============================================================================

export interface WheelPart extends PartBase {
    type: 'Wheel';
    wheelVariant: 'SWheel' | 'QWheel' | 'TWheel';
    angle?: ASTNode;
    angle1?: ASTNode;
    angle2?: ASTNode;
    radius?: ASTNode;
    orientation?: string;     // 'three' | 'six' | 'nine' | 'twelve'
    text?: string;
    fontSize?: ASTNode;
    fontName?: string;
    strokeColor?: ASTNode;
    bgColor?: ASTNode;
    bgColor2?: ASTNode;       // TWheel: second background color (halfAndHalf mode)
    update?: ASTNode;
    updateOffset?: ASTNode;
    animSpeed?: ASTNode;
    dragAnimationType?: string;
    marks?: string;
    refName?: string;
    /** Separate text radius (QWheel only). */
    tradius?: ASTNode;
    /** Tick mark style (e.g. 'tick288', 'tick96'). */
    tick?: string;
    /** Kind indicator (e.g. 'reverseHour24Kind'). */
    kind?: string;
    /** If set, wheel is split into two halves with different background colors. */
    halfAndHalf?: ASTNode;
    /** Number of tick marks around the wheel. */
    ticks?: ASTNode;
    /** Width of tick marks. */
    tickWidth?: ASTNode;
}

// ============================================================================
// QText — static text label
// ============================================================================

export interface QTextPart extends PartBase {
    type: 'QText';
    text?: string;
    fontSize?: ASTNode;
    fontName?: string;
    strokeColor?: ASTNode;
    radius?: ASTNode;       // If set, text is drawn along a circular arc
    startAngle?: ASTNode;   // Center angle for curved text (radians, 0=top)
    orientation?: string;   // 'demi' = text along arc, tops inward
}

// ============================================================================
// Image — external PNG reference
// ============================================================================

export interface ImagePart extends PartBase {
    type: 'Image';
    src?: string;
    alpha?: ASTNode;
    scale?: ASTNode;
}

// ============================================================================
// Button — interactive element
// ============================================================================

export interface ButtonPart extends PartBase {
    type: 'Button';
    action?: string;
    enabled?: ASTNode;
    src?: string;
    motion?: ASTNode;
    xMotion?: ASTNode;
    yMotion?: ASTNode;
    w?: ASTNode;
    h?: ASTNode;
    opacity?: ASTNode;
    rotation?: ASTNode;
    expanded?: ASTNode;
    immediate?: string;
    repeatStrategy?: string;
    grabPrio?: string;
}

// ============================================================================
// Window — clipping region
// ============================================================================

export interface WindowPart extends PartBase {
    type: 'Window';
    w?: ASTNode;
    h?: ASTNode;
    windowType?: string;       // 'porthole' | 'rect' (stored from XML `type` attr)
    border?: ASTNode;
    strokeColor?: ASTNode;
    shadowOpacity?: ASTNode;
    shadowSigma?: ASTNode;
    shadowOffset?: ASTNode;
}

// ============================================================================
// Static — container for grouped static elements
// ============================================================================

export interface StaticPart extends PartBase {
    type: 'Static';
    children: WatchPart[];
    /** Pre-rendered cache (with all window cutouts baked in). Set at cache-build time. */
    cachedCanvas?: OffscreenCanvas;
    /** Windows that precede this static block in document order; consumed at cache-build time. */
    precedingWindows?: WindowPart[];
}

// ============================================================================
// QRect — simple colored rectangle
// ============================================================================

export interface QRectPart extends PartBase {
    type: 'QRect';
    w?: ASTNode;
    h?: ASTNode;
    bgColor?: ASTNode;
    panes?: ASTNode;
}

// ============================================================================
// Terminator — moon phase leaf display
// ============================================================================

export interface TerminatorPart extends PartBase {
    type: 'Terminator';
    radius?: ASTNode;
    leavesPerQuadrant?: ASTNode;
    incremental?: ASTNode;
    leafBorderColor?: ASTNode;
    leafFillColor?: ASTNode;
    leafAnchorRadius?: ASTNode;
    update?: ASTNode;
    updateOffset?: ASTNode;
    phaseAngle?: ASTNode;       // expression: moonAgeAngle()
    rotation?: ASTNode;         // expression: moonRelativePositionAngle()
}

// ============================================================================
// QWedge — annular sector (pie-slice of a ring)
// ============================================================================

export interface QWedgePart extends PartBase {
    type: 'QWedge';
    outerRadius?: ASTNode;
    innerRadius?: ASTNode;
    angleSpan?: ASTNode;
    angle?: ASTNode;
    strokeColor?: ASTNode;
    fillColor?: ASTNode;
    opaque?: number;
    update?: ASTNode;
}

// ============================================================================
// QDayNightRing — colored wedges showing daylight hours on 24-hour dial
// ============================================================================

export interface QDayNightRingPart extends PartBase {
    type: 'QDayNightRing';
    outerRadius?: ASTNode;
    innerRadius?: ASTNode;
    numWedges?: ASTNode;
    planetNumber?: ASTNode;
    masterOffset?: ASTNode;
    strokeColor?: ASTNode;
    fillColor?: ASTNode;
    update?: ASTNode;
    timeBase?: string;         // 'LST' for Local Sidereal Time, omitted for local time
}
