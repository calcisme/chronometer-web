/**
 * XML parser for Chronometer watch definition files.
 *
 * Parses watch XML into the typed model defined in types.ts.
 * Filters parts by mode (front, back, night) at parse time.
 */

import type {
    Watch,
    WatchPart,
    QDialPart,
    QHandPart,
    WheelPart,
    QTextPart,
    ImagePart,
    ButtonPart,
    WindowPart,
    StaticPart,
    QRectPart,
} from './types.js';

// ============================================================================
// Public API
// ============================================================================

export type ModeFilter = 'front' | 'back' | 'night';

/**
 * Parse a watch XML string, returning only parts matching the given mode.
 *
 * @param xmlText   The raw XML string
 * @param mode      Which mode to filter for ('front', 'back', 'night')
 * @param domParser Optional DOMParser instance (for Node.js testing with jsdom)
 */
export function parseWatchXML(
    xmlText: string,
    mode: ModeFilter,
    domParser?: { parseFromString(text: string, type: string): Document },
): Watch {
    const parser = domParser ?? new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');

    const watchEl = doc.querySelector('watch');
    if (!watchEl) {
        throw new Error('No <watch> element found in XML');
    }

    const watch: Watch = {
        name: attr(watchEl, 'name') ?? 'unknown',
        beatsPerSecond: attr(watchEl, 'beatsPerSecond') ?? '1',
        initExprs: [],
        parts: [],
    };

    // Walk children of <watch>
    for (const child of Array.from(watchEl.children)) {
        processElement(child, mode, watch.initExprs, watch.parts);
    }

    return watch;
}

// ============================================================================
// Element processing
// ============================================================================

function processElement(
    el: Element,
    mode: ModeFilter,
    initExprs: string[],
    parts: WatchPart[],
): void {
    const tag = el.tagName.toLowerCase();

    switch (tag) {
        case 'init':
            // Always collect init blocks (they define variables needed by all modes)
            {
                const expr = attr(el, 'expr');
                if (expr) {
                    initExprs.push(expr);
                }
            }
            break;

        case 'atlas':
            // Stored on the watch if needed, but not a renderable part
            break;

        case 'static':
            processStatic(el, mode, initExprs, parts);
            break;

        case 'qdial':
            if (matchesMode(el, mode)) {
                parts.push(parseQDial(el));
            }
            break;

        case 'qhand':
        case 'hand':
            if (matchesMode(el, mode)) {
                parts.push(parseQHand(el));
            }
            break;

        case 'swheel':
        case 'qwheel':
            if (matchesMode(el, mode)) {
                parts.push(parseWheel(el, tag === 'qwheel' ? 'QWheel' : 'SWheel'));
            }
            break;

        case 'qtext':
            if (matchesMode(el, mode)) {
                parts.push(parseQText(el));
            }
            break;

        case 'image':
            if (matchesMode(el, mode)) {
                parts.push(parseImage(el));
            }
            break;

        case 'button':
            if (matchesMode(el, mode)) {
                parts.push(parseButton(el));
            }
            break;

        case 'window':
            if (matchesMode(el, mode)) {
                parts.push(parseWindow(el));
            }
            break;

        case 'qrect':
            if (matchesMode(el, mode)) {
                parts.push(parseQRect(el));
            }
            break;

        case 'terminator':
        case 'tick':
            // Skipped for now
            break;

        default:
            // Unknown element — skip silently
            break;
    }
}

// ============================================================================
// Static container
// ============================================================================

function processStatic(
    el: Element,
    mode: ModeFilter,
    initExprs: string[],
    parts: WatchPart[],
): void {
    // If the static element itself doesn't match the mode, skip entirely
    if (!matchesMode(el, mode)) {
        // Still collect init blocks from inside even if static is filtered out?
        // No — in the original code, static groups are mode-filtered as a unit.
        return;
    }

    const staticPart: StaticPart = {
        type: 'Static',
        name: attr(el, 'name') ?? '',
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        children: [],
    };

    for (const child of Array.from(el.children)) {
        processElement(child, mode, initExprs, staticPart.children);
    }

    parts.push(staticPart);
}

// ============================================================================
// Individual element parsers
// ============================================================================

function parseQDial(el: Element): QDialPart {
    return {
        type: 'QDial',
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        radius: attr(el, 'radius'),
        radius2: attr(el, 'radius2'),
        clipRadius: attr(el, 'clipRadius'),
        orientation: attr(el, 'orientation'),
        demiTweak: attr(el, 'demiTweak'),
        text: attr(el, 'text'),
        fontSize: attr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        bgColor: attr(el, 'bgColor'),
        strokeColor: attr(el, 'strokeColor'),
        fillColor1: attr(el, 'fillColor1'),
        fillColor2: attr(el, 'fillColor2'),
        marks: attr(el, 'marks'),
        markWidth: attr(el, 'markWidth'),
        nMarks: attr(el, 'nMarks'),
        mSize: attr(el, 'mSize'),
        angle: attr(el, 'angle'),
        angle0: attr(el, 'angle0'),
        angle1: attr(el, 'angle1'),
        angle2: attr(el, 'angle2'),
        update: attr(el, 'update'),
        updateOffset: attr(el, 'updateOffset'),
        kind: attr(el, 'kind'),
        z: attr(el, 'z'),
        thick: attr(el, 'thick'),
    };
}

function parseQHand(el: Element): QHandPart {
    return {
        type: 'QHand',
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        angle: attr(el, 'angle'),
        length: attr(el, 'length'),
        width: attr(el, 'width'),
        tail: attr(el, 'tail'),
        handType: attr(el, 'type'),
        strokeColor: attr(el, 'strokeColor'),
        fillColor: attr(el, 'fillColor'),
        lineWidth: attr(el, 'lineWidth'),
        kind: attr(el, 'kind'),
        update: attr(el, 'update'),
        updateOffset: attr(el, 'updateOffset'),
        z: attr(el, 'z'),
        thick: attr(el, 'thick'),
        animSpeed: attr(el, 'animSpeed'),
        dragAnimationType: attr(el, 'dragAnimationType'),
        oLength: attr(el, 'oLength'),
        oWidth: attr(el, 'oWidth'),
        oTail: attr(el, 'oTail'),
        oLineWidth: attr(el, 'oLineWidth'),
        oStrokeColor: attr(el, 'oStrokeColor'),
        oFillColor: attr(el, 'oFillColor'),
        oCenter: attr(el, 'oCenter'),
        oRadius: attr(el, 'oRadius'),
    };
}

function parseWheel(el: Element, variant: 'SWheel' | 'QWheel'): WheelPart {
    return {
        type: 'Wheel',
        wheelVariant: variant,
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        angle: attr(el, 'angle'),
        radius: attr(el, 'radius'),
        orientation: attr(el, 'orientation'),
        text: attr(el, 'text'),
        fontSize: attr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        strokeColor: attr(el, 'strokeColor'),
        bgColor: attr(el, 'bgColor'),
        update: attr(el, 'update'),
        updateOffset: attr(el, 'updateOffset'),
        animSpeed: attr(el, 'animSpeed'),
        dragAnimationType: attr(el, 'dragAnimationType'),
        marks: attr(el, 'marks'),
        refName: attr(el, 'refName'),
    };
}

function parseQText(el: Element): QTextPart {
    return {
        type: 'QText',
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        text: attr(el, 'text'),
        fontSize: attr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        strokeColor: attr(el, 'strokeColor'),
    };
}

function parseImage(el: Element): ImagePart {
    return {
        type: 'Image',
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        src: attr(el, 'src'),
        alpha: attr(el, 'alpha'),
    };
}

function parseButton(el: Element): ButtonPart {
    return {
        type: 'Button',
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        action: attr(el, 'action'),
        enabled: attr(el, 'enabled'),
        src: attr(el, 'src'),
        motion: attr(el, 'motion'),
        xMotion: attr(el, 'xMotion'),
        yMotion: attr(el, 'yMotion'),
        w: attr(el, 'w'),
        h: attr(el, 'h'),
        opacity: attr(el, 'opacity'),
        rotation: attr(el, 'rotation'),
        expanded: attr(el, 'expanded'),
        immediate: attr(el, 'immediate'),
        repeatStrategy: attr(el, 'repeatStrategy'),
        grabPrio: attr(el, 'grabPrio'),
    };
}

function parseWindow(el: Element): WindowPart {
    return {
        type: 'Window',
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        w: attr(el, 'w'),
        h: attr(el, 'h'),
        windowType: attr(el, 'type'),
        border: attr(el, 'border'),
        strokeColor: attr(el, 'strokeColor'),
        shadowOpacity: attr(el, 'shadowOpacity'),
        shadowSigma: attr(el, 'shadowSigma'),
        shadowOffset: attr(el, 'shadowOffset'),
    };
}

function parseQRect(el: Element): QRectPart {
    return {
        type: 'QRect',
        name: partName(el),
        x: attr(el, 'x'),
        y: attr(el, 'y'),
        modes: attr(el, 'modes'),
        w: attr(el, 'w'),
        h: attr(el, 'h'),
        bgColor: attr(el, 'bgColor'),
        panes: attr(el, 'panes'),
    };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get an attribute value, returning undefined if not present.
 */
function attr(el: Element, name: string): string | undefined {
    const val = el.getAttribute(name);
    return val !== null ? val.trim() : undefined;
}

/**
 * Get the part name — uses `name` or `refName`, whichever is present.
 */
function partName(el: Element): string {
    return attr(el, 'name') ?? attr(el, 'refName') ?? '';
}

/**
 * Check whether an element's modes include the desired mode.
 *
 * Matching rules:
 * - No `modes` attr → matches 'front' only (default)
 * - `modes` contains 'all' → matches everything
 * - `modes` is a '|'-separated list → matches if the desired mode is in the list
 */
function matchesMode(el: Element, desiredMode: ModeFilter): boolean {
    const modesAttr = attr(el, 'modes');

    // No modes attribute — default to 'front' only (matching the original behavior
    // where frontMask is the default in ECWatchDefinitionManager)
    if (modesAttr === undefined) {
        return desiredMode === 'front';
    }

    const lower = modesAttr.toLowerCase();
    if (lower === 'all') return true;
    return lower.split('|').some(m => m.trim() === desiredMode);
}
