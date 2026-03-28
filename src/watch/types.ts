/**
 * Type definitions for the Chronometer watch model.
 *
 * Each XML element type in a watch definition maps to a typed interface.
 * Numeric attribute values are stored as expression strings (not pre-evaluated)
 * so the rendering layer can re-evaluate dynamic attributes per-frame.
 */

// ============================================================================
// Watch (top level)
// ============================================================================

export interface Watch {
    name: string;
    beatsPerSecond: string;
    /** All `<init expr="...">` blocks in document order. */
    initExprs: string[];
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
    | QRectPart;

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
    // Future: currentX, currentY for linear animation
}

export interface PartBase {
    name: string;
    x?: string;
    y?: string;
    modes?: string;
    /** Runtime animation state — populated by the animation system, not by XML parsing. */
    dynamicState?: DynamicState;
}

// ============================================================================
// QDial — circular dial with marks, text, tick marks
// ============================================================================

export interface QDialPart extends PartBase {
    type: 'QDial';
    radius?: string;
    radius2?: string;
    clipRadius?: string;
    orientation?: string;     // 'upright' | 'demi' | 'radial' etc.
    demiTweak?: string;
    text?: string;
    fontSize?: string;
    fontName?: string;
    bgColor?: string;
    strokeColor?: string;
    fillColor1?: string;
    fillColor2?: string;
    marks?: string;           // 'outer' | 'center' | 'tickOut' | 'dot' | 'none' etc.
    markWidth?: string;
    nMarks?: string;
    mSize?: string;
    angle?: string;
    angle0?: string;
    angle1?: string;
    angle2?: string;
    update?: string;
    updateOffset?: string;
    kind?: string;
    z?: string;
    thick?: string;
}

// ============================================================================
// QHand — drawn hand (rect, tri, or default triangle)
// ============================================================================

export interface QHandPart extends PartBase {
    type: 'QHand';
    angle?: string;
    length?: string;
    width?: string;
    tail?: string;
    handType?: string;         // 'rect' | 'tri' (stored from XML `type` attr)
    strokeColor?: string;
    fillColor?: string;
    lineWidth?: string;
    kind?: string;             // 'hour12Kind' | 'minuteKind' | 'secondKind' etc.
    update?: string;
    updateOffset?: string;
    z?: string;
    thick?: string;
    animSpeed?: string;
    dragAnimationType?: string;
    // Arrow overlay attributes
    oLength?: string;
    oWidth?: string;
    oTail?: string;
    oLineWidth?: string;
    oStrokeColor?: string;
    oFillColor?: string;
    oCenter?: string;
    oRadius?: string;
}

// ============================================================================
// Wheel — SWheel, QWheel, Swheel (rotating text wheel)
// ============================================================================

export interface WheelPart extends PartBase {
    type: 'Wheel';
    wheelVariant: 'SWheel' | 'QWheel';
    angle?: string;
    radius?: string;
    orientation?: string;     // 'three' | 'six' | 'nine' | 'twelve'
    text?: string;
    fontSize?: string;
    fontName?: string;
    strokeColor?: string;
    bgColor?: string;
    update?: string;
    updateOffset?: string;
    animSpeed?: string;
    dragAnimationType?: string;
    marks?: string;
    refName?: string;
}

// ============================================================================
// QText — static text label
// ============================================================================

export interface QTextPart extends PartBase {
    type: 'QText';
    text?: string;
    fontSize?: string;
    fontName?: string;
    strokeColor?: string;
}

// ============================================================================
// Image — external PNG reference
// ============================================================================

export interface ImagePart extends PartBase {
    type: 'Image';
    src?: string;
    alpha?: string;
}

// ============================================================================
// Button — interactive element
// ============================================================================

export interface ButtonPart extends PartBase {
    type: 'Button';
    action?: string;
    enabled?: string;
    src?: string;
    motion?: string;
    xMotion?: string;
    yMotion?: string;
    w?: string;
    h?: string;
    opacity?: string;
    rotation?: string;
    expanded?: string;
    immediate?: string;
    repeatStrategy?: string;
    grabPrio?: string;
}

// ============================================================================
// Window — clipping region
// ============================================================================

export interface WindowPart extends PartBase {
    type: 'Window';
    w?: string;
    h?: string;
    windowType?: string;       // 'porthole' | 'rect' (stored from XML `type` attr)
    border?: string;
    strokeColor?: string;
    shadowOpacity?: string;
    shadowSigma?: string;
    shadowOffset?: string;
}

// ============================================================================
// Static — container for grouped static elements
// ============================================================================

export interface StaticPart extends PartBase {
    type: 'Static';
    children: WatchPart[];
}

// ============================================================================
// QRect — simple colored rectangle
// ============================================================================

export interface QRectPart extends PartBase {
    type: 'QRect';
    w?: string;
    h?: string;
    bgColor?: string;
    panes?: string;
}
