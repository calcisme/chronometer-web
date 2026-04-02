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
import { parse } from '../expr/parser.js';
import type { ASTNode } from '../expr/parser.js';

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
        faceWidth: parseFloat(attr(watchEl, 'faceWidth') ?? '290'),
        bezelColor: attr(watchEl, 'bezelColor') ?? '',
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
    initExprs: ASTNode[],
    parts: WatchPart[],
): void {
    const tag = el.tagName.toLowerCase();

    switch (tag) {
        case 'init':
            // Always collect init blocks (they define variables needed by all modes)
            {
                const exprStr = attr(el, 'expr');
                if (exprStr) {
                    try {
                        initExprs.push(parse(exprStr));
                    } catch (e) {
                        console.error(`Failed to parse <init expr="${exprStr}">`, e);
                    }
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
    initExprs: ASTNode[],
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
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
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
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        radius: attrExpr(el, 'radius'),
        radius2: attrExpr(el, 'radius2'),
        clipRadius: attrExpr(el, 'clipRadius'),
        orientation: attr(el, 'orientation'),
        demiTweak: attrExpr(el, 'demiTweak'),
        text: attr(el, 'text'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        bgColor: attrExpr(el, 'bgColor'),
        strokeColor: attrExpr(el, 'strokeColor'),
        fillColor1: attrExpr(el, 'fillColor1'),
        fillColor2: attrExpr(el, 'fillColor2'),
        marks: attr(el, 'marks'),
        markWidth: attrExpr(el, 'markWidth'),
        nMarks: attrExpr(el, 'nMarks'),
        mSize: attrExpr(el, 'mSize'),
        angle: attrExpr(el, 'angle'),
        angle0: attrExpr(el, 'angle0'),
        angle1: attrExpr(el, 'angle1'),
        angle2: attrExpr(el, 'angle2'),
        update: attrExpr(el, 'update'),
        updateOffset: attrExpr(el, 'updateOffset'),
        kind: attr(el, 'kind'),
        z: attrExpr(el, 'z'),
        thick: attrExpr(el, 'thick'),
    };
}

function parseQHand(el: Element): QHandPart {
    return {
        type: 'QHand',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        angle: attrExpr(el, 'angle'),
        length: attrExpr(el, 'length'),
        width: attrExpr(el, 'width'),
        tail: attrExpr(el, 'tail'),
        handType: attr(el, 'type'),
        strokeColor: attrExpr(el, 'strokeColor'),
        fillColor: attrExpr(el, 'fillColor'),
        lineWidth: attrExpr(el, 'lineWidth'),
        kind: attr(el, 'kind'),
        update: attrExpr(el, 'update'),
        updateOffset: attrExpr(el, 'updateOffset'),
        z: attrExpr(el, 'z'),
        thick: attrExpr(el, 'thick'),
        animSpeed: attrExpr(el, 'animSpeed'),
        dragAnimationType: attr(el, 'dragAnimationType'),
        oLength: attrExpr(el, 'oLength'),
        oWidth: attrExpr(el, 'oWidth'),
        oTail: attrExpr(el, 'oTail'),
        oLineWidth: attrExpr(el, 'oLineWidth'),
        oStrokeColor: attrExpr(el, 'oStrokeColor'),
        oFillColor: attrExpr(el, 'oFillColor'),
        oCenter: attrExpr(el, 'oCenter'),
        oRadius: attrExpr(el, 'oRadius'),
    };
}

function parseWheel(el: Element, variant: 'SWheel' | 'QWheel'): WheelPart {
    return {
        type: 'Wheel',
        wheelVariant: variant,
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        angle: attrExpr(el, 'angle'),
        radius: attrExpr(el, 'radius'),
        orientation: attr(el, 'orientation'),
        text: attr(el, 'text'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        strokeColor: attrExpr(el, 'strokeColor'),
        bgColor: attrExpr(el, 'bgColor'),
        update: attrExpr(el, 'update'),
        updateOffset: attrExpr(el, 'updateOffset'),
        animSpeed: attrExpr(el, 'animSpeed'),
        dragAnimationType: attr(el, 'dragAnimationType'),
        marks: attr(el, 'marks'),
        refName: attr(el, 'refName'),
    };
}

function parseQText(el: Element): QTextPart {
    return {
        type: 'QText',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        text: attr(el, 'text'),
        fontSize: attrExpr(el, 'fontSize'),
        fontName: attr(el, 'fontName'),
        strokeColor: attrExpr(el, 'strokeColor'),
    };
}

function parseImage(el: Element): ImagePart {
    return {
        type: 'Image',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        src: attr(el, 'src'),
        alpha: attrExpr(el, 'alpha'),
    };
}

function parseButton(el: Element): ButtonPart {
    return {
        type: 'Button',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        action: attr(el, 'action'),
        enabled: attrExpr(el, 'enabled'),
        src: attr(el, 'src'),
        motion: attrExpr(el, 'motion'),
        xMotion: attrExpr(el, 'xMotion'),
        yMotion: attrExpr(el, 'yMotion'),
        w: attrExpr(el, 'w'),
        h: attrExpr(el, 'h'),
        opacity: attrExpr(el, 'opacity'),
        rotation: attrExpr(el, 'rotation'),
        expanded: attrExpr(el, 'expanded'),
        immediate: attr(el, 'immediate'),
        repeatStrategy: attr(el, 'repeatStrategy'),
        grabPrio: attr(el, 'grabPrio'),
    };
}

function parseWindow(el: Element): WindowPart {
    return {
        type: 'Window',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        w: attrExpr(el, 'w'),
        h: attrExpr(el, 'h'),
        windowType: attr(el, 'type'),
        border: attrExpr(el, 'border'),
        strokeColor: attrExpr(el, 'strokeColor'),
        shadowOpacity: attrExpr(el, 'shadowOpacity'),
        shadowSigma: attrExpr(el, 'shadowSigma'),
        shadowOffset: attrExpr(el, 'shadowOffset'),
    };
}

function parseQRect(el: Element): QRectPart {
    return {
        type: 'QRect',
        name: partName(el),
        x: attrExpr(el, 'x'),
        y: attrExpr(el, 'y'),
        modes: attr(el, 'modes'),
        w: attrExpr(el, 'w'),
        h: attrExpr(el, 'h'),
        bgColor: attrExpr(el, 'bgColor'),
        panes: attrExpr(el, 'panes'),
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
 * Get an attribute and eagerly compile it to an ASTNode.
 */
function attrExpr(el: Element, name: string): ASTNode | undefined {
    const val = attr(el, name);
    if (!val) return undefined;
    try {
        return parse(val);
    } catch (e) {
        console.warn(`[xml-parser] Failed to parse AST for attribute: ${name}="${val}"`, e);
        return undefined;
    }
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
