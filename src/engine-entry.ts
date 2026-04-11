

/**
 * Per-face data files push their data onto this global array.
 * The engine reads it at startup.
 */
interface FaceData {
    name: string;
    xml: string;
    images: Record<string, { dataUrl: string; scale: number }>;
}

interface ChronometerEngine {
    start: () => Promise<void>;
}

declare global {
    interface Window {
        ChronometerFaces: FaceData[];
        Chronometer: ChronometerEngine;
    }
}

import { parseWatchXML } from './watch/xml-parser.js';
import { createWatchEnvironment } from './watch/watch-env.js';
import { buildStaticBlockCaches, renderFrame, BEZEL_THICKNESS_XML } from './watch/renderer.js';
import type { LoadedImage } from './watch/image-loader.js';
import { initHandStates, tickAnimations, nextWakeupTime, anyAnimating, finishAnimations, resetHandSchedules, SCHEDULER_LOOKAHEAD_MS } from './watch/animation.js';
import type { HandState } from './watch/animation.js';
import type { Watch } from './watch/types.js';
import type { Environment } from './expr/evaluator.js';
import type { TerminatorLeafState } from './watch/terminator.js';
import { expandTerminatorToLeaves, updateLeafAngles, tickLeafAnimations, finishLeafAnimations, resetLeafSchedules, anyLeafAnimating } from './watch/terminator.js';
import { TimeController, RATE_OPTIONS, TICK_INTERVAL_MS, displaySecondsPerTick } from './time-controller.js';
import type { TimeUnit } from './time-controller.js';
import { readUrlState, writeUrlState, initNavigationLinks } from './url-state.js';

// ============================================================================
// Location helpers
// ============================================================================

const DEMO_LAT = 37.3349;   // Apple Park, Cupertino
const DEMO_LON = -122.0090;

function requestBrowserLocation(): Promise<{ lat: number; lon: number } | null> {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            () => resolve(null),
            { timeout: 5000 },
        );
    });
}

// ============================================================================
// Grid layout maths
/**
 * Find the (cols, rows) layout that maximizes face size for the given
 * container dimensions.  Tries every valid column count from 1..count
 * and picks the one producing the largest cells.  When two candidates
 * tie on size, prefer the one with smaller rows+cols (more balanced).
 */
function optimizeGrid(
    count: number,
    containerW: number, containerH: number,
    gap: number, padding: number,
): { cols: number; rows: number; size: number } {
    if (count <= 0) return { cols: 1, rows: 1, size: 0 };

    let bestCols = 1, bestRows = count, bestSize = 0;

    for (let c = 1; c <= count; c++) {
        const r = Math.ceil(count / c);
        const usableW = containerW - 2 * padding - gap * (c - 1);
        const usableH = containerH - 2 * padding - gap * (r - 1);
        const size = Math.floor(Math.min(usableW / c, usableH / r));
        // Prefer larger size; break ties with smaller rows+cols (more balanced)
        const isBetter = size > bestSize;
        const isTie = size === bestSize && (c + r) < (bestCols + bestRows);
        if (isBetter || isTie) {
            bestSize = size;
            bestCols = c;
            bestRows = r;
        }
    }

    return { cols: bestCols, rows: bestRows, size: bestSize };
}

// ============================================================================
// Image loading from FaceData
// ============================================================================

async function loadImagesFromFaceData(
    imageMap: Record<string, { dataUrl: string; scale: number }>
): Promise<Map<string, LoadedImage>> {
    const result = new Map<string, LoadedImage>();
    const entries = Object.entries(imageMap);
    const loadPromises = entries.map(async ([src, { dataUrl, scale }]) => {
        try {
            const response = await fetch(dataUrl);
            const blob = await response.blob();
            const bitmap = await createImageBitmap(blob);
            result.set(src, { bitmap, scale });
        } catch (e) {
            console.warn(`Failed to load image: ${src}`, e);
        }
    });
    await Promise.all(loadPromises);
    return result;
}

// ============================================================================
// Per-face instance
// ============================================================================

interface FaceInstance {
    watch: Watch;
    env: Environment;
    cachesBuilt: boolean;
    handStates: HandState[];
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    sizePx: number;
    images: Map<string, LoadedImage>;
    enabled: boolean;
    scale: number;
    terminatorLeaves: TerminatorLeafState[];
    lastTerminatorRebuild: number;
    faceDataIndex: number;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const faceDataArray = window.ChronometerFaces || [];
    if (faceDataArray.length === 0) {
        console.error('No face data registered. Include at least one face-*.js script.');
        return;
    }

    // --- UI elements ---
    const grid = document.getElementById('watch-grid') as HTMLDivElement;
    const locationDisplay = document.getElementById('location-display')!;
    const sourceLabel = document.getElementById('location-source')!;
    const setLocationBtn = document.getElementById('set-location-btn')!;
    const locationPrompt = document.getElementById('location-prompt')!;
    const lpLatInput = document.getElementById('lp-lat') as HTMLInputElement;
    const lpLonInput = document.getElementById('lp-lon') as HTMLInputElement;
    const lpUseCoords = document.getElementById('lp-use-coords')!;
    const lpUseBrowser = document.getElementById('lp-use-browser')!;
    const lpUseDemo = document.getElementById('lp-use-demo')!;

    // Initialize link preservation
    initNavigationLinks();

    // --- Resolve location ---
    const urlState = readUrlState();
    let lat: number, lon: number;
    let locationSource = '';
    let needsPrompt = false;
    // Track whether browser geolocation is available
    // 'granted' = we got a position, 'denied' = user rejected or unavailable, 'unknown' = never tried
    let geoPermission: 'granted' | 'denied' | 'unknown' = 'unknown';

    if (urlState.lat !== null && urlState.lon !== null) {
        lat = urlState.lat;
        lon = urlState.lon;
        locationSource = '';
        // We haven't tried geolocation — check the Permissions API if available
        if (navigator.permissions) {
            try {
                const status = await navigator.permissions.query({ name: 'geolocation' });
                geoPermission = status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown';
            } catch { /* ignore — not all browsers support this */ }
        }
    } else {
        const loc = await requestBrowserLocation();
        if (loc) {
            lat = loc.lat; lon = loc.lon;
            locationSource = '(from browser)';
            geoPermission = 'granted';
        } else {
            // No location available — render at 0,0 with blur, show prompt
            lat = 0; lon = 0;
            locationSource = '';
            needsPrompt = true;
            geoPermission = 'denied';
        }
    }

    function updateLocationDisplay() {
        locationDisplay.innerHTML = `Latitude <span style="font-family:monospace">${lat.toFixed(3)}</span>&nbsp;&nbsp;Longitude <span style="font-family:monospace">${lon.toFixed(3)}</span>`;
        sourceLabel.textContent = locationSource;
    }
    updateLocationDisplay();

    // --- Load per-face images and parse watches ---
    const parsedWatches: Watch[] = [];
    const allImages: Map<string, LoadedImage>[] = [];

    for (const fd of faceDataArray) {
        parsedWatches.push(parseWatchXML(fd.xml, 'front'));
        allImages.push(await loadImagesFromFaceData(fd.images));
        // Release the large base64 data-URL strings now that ImageBitmaps
        // have been created — these are ~4.4 MB of retained strings otherwise.
        fd.images = null as any;
    }
    // Also release the global so the face-*.js IIFE closures can be GC'd
    delete (window as any).ChronometerFaces;

    // --- Time controller ---
    const timeController = new TimeController();

    // Restore time state from URL
    if (urlState.t !== null && !isNaN(urlState.t)) {
        timeController.setTime(new Date(urlState.t));
        if (urlState.dir === 1) {
            // Resume forward at 1×
            timeController.setDirection(1);
            timeController.setRate(null);
        } else if (urlState.dir === -1) {
            // Resume reverse at 1×
            timeController.setDirection(-1);
            timeController.setRate(null);
        }
        // dir === 0 stays stopped (setTime already stops)
    }

    const getNow = () => timeController.getDisplayTime();

    // --- Build the DOM: one cell + canvas per face ---
    // cols/rows are recomputed on every resize via optimizeGrid
    let cols = 1, rows = 1;

    const faces: FaceInstance[] = [];

    for (let i = 0; i < parsedWatches.length; i++) {
        const cell = document.createElement('div');
        cell.className = 'face-cell';

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        cell.appendChild(canvas);
        grid.appendChild(cell);

        const watch = parsedWatches[i];
        const env = createWatchEnvironment(watch, lat, lon, getNow);

        const face: FaceInstance = {
            watch,
            env,
            cachesBuilt: false,
            handStates: [],
            canvas,
            ctx,
            sizePx: 0,
            images: allImages[i],
            enabled: true,
            scale: 1,
            terminatorLeaves: [],
            lastTerminatorRebuild: 0,
            faceDataIndex: i,
        };
        faces.push(face);
    }

    // --- Size all canvases to match the grid container ---
    function applySize(face: FaceInstance, size: number) {
        const dpr = window.devicePixelRatio || 1;
        const physPx = Math.round(size * dpr);
        face.canvas.width = physPx;
        face.canvas.height = physPx;
        face.canvas.style.width = `${size}px`;
        face.canvas.style.height = `${size}px`;
        const bezel = face.watch.bezelColor ? BEZEL_THICKNESS_XML : 0;
        const totalDiameter = face.watch.faceWidth + 2 * bezel;
        face.sizePx = size;
        face.scale = physPx / totalDiameter;
    }

    // --- Build (or rebuild) the StaticCache for a face ---
    function buildCache(face: FaceInstance) {
        if (!face.enabled || face.sizePx === 0) return;
        const { canvas, watch, env, images, scale } = face;
        face.terminatorLeaves = [];
        for (const part of watch.parts) {
            if (part.type === 'Terminator') {
                face.terminatorLeaves.push(...expandTerminatorToLeaves(part, env));
            }
        }
        if (face.terminatorLeaves.length > 0) {
            updateLeafAngles(face.terminatorLeaves, face.env);
        }
        buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
        face.cachesBuilt = true;
        face.handStates = initHandStates(watch, env, performance.now(), getNow);
    }

    function buildAllCachesSequentially(facesToBuild: FaceInstance[], onDone: () => void) {
        let idx = 0;
        function buildNext() {
            if (idx >= facesToBuild.length) { onDone(); return; }
            buildCache(facesToBuild[idx++]);
            setTimeout(buildNext, 0);
        }
        buildNext();
    }

    // =========================================================================
    // Time controller — tick callback
    // =========================================================================

    /**
     * Rebuild environments and static caches for the current simulated time,
     * preserving existing part objects and hand states so animations
     * continue smoothly. Used for step events where only the time changes.
     *
     * The env functions (hour12ValueAngle, etc.) are live closures over
     * getNow(), so they automatically see the new time. But calendar-
     * dependent init expressions and terminator computations need
     * a fresh environment.
     */
    function rebuildEnvironments() {
        for (const face of faces) {
            if (!face.enabled) continue;
            // Rebuild the environment but keep the same watch/parts
            face.env = createWatchEnvironment(face.watch, lat, lon, getNow);
            // Preserve terminator leaves — their expressions are evaluated
            // against the env each frame by tickLeafAnimations, so they
            // don't need recreating. Recreating them would destroy animation state.
            // Just update the static caches with current leaf positions.
            const { canvas, watch, env, images, scale } = face;
            buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
            // Hand states are preserved — their angle expressions will
            // be re-evaluated by tickAnimations using the fresh env
        }
    }

    /**
     * Full rebuild including fresh hand states.
     * Only used for major time changes (setTime, location change)
     * where animation continuity doesn't matter.
     */
    function rebuildAllForTime() {
        for (const face of faces) {
            if (!face.enabled) continue;
            const fd = faceDataArray[face.faceDataIndex];
            const freshWatch = parseWatchXML(fd.xml, 'front');
            face.watch.parts = freshWatch.parts;
            face.watch.initExprs = freshWatch.initExprs;
            face.env = createWatchEnvironment(face.watch, lat, lon, getNow);
            face.cachesBuilt = false;
        }
        // Rebuild caches synchronously (tight loop for responsiveness during ticking)
        for (const face of faces) {
            if (!face.enabled) continue;
            buildCache(face);
        }
    }

    timeController.onTick = rebuildEnvironments;

    // =========================================================================
    // Scheduler
    // =========================================================================

    let idleTimerId: ReturnType<typeof setTimeout> | null = null;
    let rafId: number | null = null;

    function stopScheduler() {
        if (idleTimerId !== null) { clearTimeout(idleTimerId); idleTimerId = null; }
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    }

    function frame() {
        rafId = null;
        const now = performance.now();
        let stillAnimating = false;

        // Check for quantized tick boundary
        timeController.checkTick(now);

        // Snapshot the time for this frame — all getNow() calls within
        // this frame will return the exact same value.
        timeController.beginFrame();
        const frameRealTime = new Date();  // capture real time at same instant as sim

        // Compute tick parameters for the animation system
        const rate = timeController.currentRate;
        const tickMs = rate !== null ? TICK_INTERVAL_MS : null;
        const deltaSec = rate !== null ? displaySecondsPerTick(rate.unit) : 0;

        for (const face of faces) {
            if (!face.enabled || !face.cachesBuilt) continue;
            tickAnimations(face.handStates, face.env, now, tickMs, deltaSec);
            if (face.terminatorLeaves.length > 0) {
                // Animate leaf angles and rotations using the same system
                // as hands/wheels (adaptive duration, interpolation at 240fps)
                tickLeafAnimations(face.terminatorLeaves, face.env, now, tickMs, deltaSec);

                // Rebuild static caches periodically (they include terminator
                // for the background layer). In quantized mode, rebuild every tick.
                // In 1× mode, use the part's own update interval.
                const cacheIntervalMs = tickMs !== null
                    ? tickMs
                    : Math.min(...face.terminatorLeaves.map(l => l.updateIntervalSec)) * 1000;
                if (now - face.lastTerminatorRebuild > cacheIntervalMs) {
                    buildStaticBlockCaches(
                        face.watch, face.env, face.canvas.width, face.canvas.height,
                        face.scale, face.images, face.terminatorLeaves
                    );
                    face.lastTerminatorRebuild = now;
                }
            }
            renderFrame(face.ctx, face.watch, face.env, face.scale, face.images, face.terminatorLeaves);
            if (anyAnimating(face.handStates) || anyLeafAnimating(face.terminatorLeaves)) stillAnimating = true;
        }
        // Update mini-bar time display (using frameRealTime captured at beginFrame)
        {
            const sim = timeController.getDisplayTime();
            timeBarDate.textContent = formatSimTime(sim);
            if (!timeController.isRealTime) {
                timeBarOffset.textContent = formatOffset(sim, frameRealTime);
            }
        }

        timeController.endFrame();

        // Decide whether to keep the RAF loop running
        if (timeController.needsContinuousRender || stillAnimating) {
            rafId = requestAnimationFrame(frame);
        } else {
            armIdle();
        }
    }

    function armIdle() {
        if (idleTimerId !== null) return;
        let earliest = Infinity;
        for (const face of faces) {
            if (!face.enabled || face.handStates.length === 0) continue;
            const t = nextWakeupTime(face.handStates);
            if (t < earliest) earliest = t;
        }
        if (earliest === Infinity) return;
        const delay = Math.max(0, earliest - performance.now() - SCHEDULER_LOOKAHEAD_MS);
        idleTimerId = setTimeout(onIdleWakeup, delay);
    }

    function onIdleWakeup() {
        idleTimerId = null;
        if (rafId !== null) return;
        rafId = requestAnimationFrame(frame);
    }

    function startScheduler() {
        stopScheduler();
        rafId = requestAnimationFrame(frame);
    }

    // =========================================================================
    // Resize handling
    // =========================================================================

    const GAP_PX = 12;
    const PADDING_PX = 12;
    const POPOVER_GAP = 8;   // minimum gap between face edge and popover

    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    let lastContainerW = 0;
    let lastContainerH = 0;

    /**
     * Compute face center positions (relative to the grid container)
     * for a given grid configuration and face size.
     * offsetAdjustX/Y shift the grid from its default centered position.
     */
    function computeFaceCenters(
        nFaces: number, gridCols: number, gridRows: number,
        size: number, containerW: number, containerH: number,
        offsetAdjustX = 0, offsetAdjustY = 0,
    ): Array<{ cx: number; cy: number }> {
        const cellStep = size + GAP_PX;
        const remainder = nFaces - gridCols * (gridRows - 1);
        const canNestle = gridRows > 1 && remainder !== gridCols
                          && (gridCols - remainder) % 2 === 1;
        const nestledStep = canNestle ? cellStep * Math.sqrt(3) / 2 : cellStep;

        const gridW = gridCols * size + (gridCols - 1) * GAP_PX;
        const lastRowY = gridRows === 1 ? 0 : nestledStep + (gridRows - 2) * cellStep;
        const totalH = lastRowY + size;

        const offsetX = (containerW - gridW) / 2 + offsetAdjustX;
        const offsetY = (containerH - totalH) / 2 + offsetAdjustY;

        const centers: Array<{ cx: number; cy: number }> = [];
        for (let i = 0; i < nFaces; i++) {
            let row: number, colIdx: number, itemsInRow: number;
            if (i < remainder) {
                row = 0; colIdx = i; itemsInRow = remainder;
            } else {
                const j = i - remainder;
                row = 1 + Math.floor(j / gridCols);
                colIdx = j % gridCols;
                itemsInRow = gridCols;
            }
            const rowW = itemsInRow * size + (itemsInRow - 1) * GAP_PX;
            const rowOffsetX = (gridW - rowW) / 2;
            const x = offsetX + rowOffsetX + colIdx * cellStep;
            const rowY = row === 0 ? 0 : nestledStep + (row - 1) * cellStep;
            const y = offsetY + rowY;
            centers.push({ cx: x + size / 2, cy: y + size / 2 });
        }
        return centers;
    }

    /**
     * Check if any circular face overlaps a rectangle (the popover).
     * Returns true if overlap detected.
     */
    function anyFaceOverlapsRect(
        centers: Array<{ cx: number; cy: number }>,
        radius: number,
        rectLeft: number, rectTop: number,
        rectRight: number, rectBottom: number,
    ): boolean {
        for (const { cx, cy } of centers) {
            const nearX = Math.max(rectLeft, Math.min(cx, rectRight));
            const nearY = Math.max(rectTop, Math.min(cy, rectBottom));
            const dx = cx - nearX;
            const dy = cy - nearY;
            if (dx * dx + dy * dy < (radius + POPOVER_GAP) * (radius + POPOVER_GAP)) {
                return true;
            }
        }
        return false;
    }


    function onGridResize(W: number, H: number) {
        lastContainerW = W;
        lastContainerH = H;

        const result = optimizeGrid(faces.length, W, H, GAP_PX, PADDING_PX);
        if (result.size <= 0) return;

        let size = result.size;
        let gridShiftX = 0, gridShiftY = 0;
        let useTopLeftAlign = false;

        // Compute X position for column c with hex close-pack at the
        // long/short boundary.  Long columns use normal cellStep spacing,
        // and the first short column is placed hexStep from the last long
        // column. Subsequent short columns use normal cellStep.
        const hexColX = (
            col: number, remainder: number, nCols: number,
            cellStep: number, hasNestle: boolean,
        ): number => {
            if (!hasNestle || col < remainder) {
                return col * cellStep;
            }
            const hexStep = cellStep * Math.sqrt(3) / 2;
            return (remainder - 1) * cellStep + hexStep + (col - remainder) * cellStep;
        };

        // If the popover is open, find the largest face size where some
        // grid configuration (column count) places the grid top-left-aligned
        // without the bottom-right face overlapping the popover.
        if (popoverOpen) {
            const gridRect = grid.getBoundingClientRect();
            const popRect = timePopover.getBoundingClientRect();
            const pLeft = popRect.left - gridRect.left;
            const pTop = popRect.top - gridRect.top;
            const pRight = popRect.right - gridRect.left;
            const pBottom = popRect.bottom - gridRect.top;

            // Check whether a grid with `cols` columns at face `size`
            // fits without any face overlapping the popover.
            // The grid is pinned to top-left (PADDING offset).
            const configFits = (cols: number, s: number): boolean => {
                const rows = Math.ceil(faces.length / cols);
                const cellStep = s + GAP_PX;
                const remainder = faces.length - cols * (rows - 1);
                const r = s / 2;

                const hasNestle = remainder > 0 && remainder < cols;

                // Check grid fits in container at all
                const lastColX = hexColX(cols - 1, remainder, cols, cellStep, hasNestle);
                const gridW = lastColX + s + 2 * PADDING_PX;
                const gridH = (rows - 1) * cellStep + s + 2 * PADDING_PX;
                if (gridW > W || gridH > H) return false;

                // Check ALL faces for overlap with popover
                for (let i = 0; i < faces.length; i++) {
                    const row = Math.floor(i / cols);
                    const col = i % cols;
                    const isShortCol = col >= remainder;
                    const ny = isShortCol && hasNestle ? cellStep / 2 : 0;
                    const cx = PADDING_PX + hexColX(col, remainder, cols, cellStep, hasNestle) + r;
                    const cy = PADDING_PX + row * cellStep + ny + r;

                    const nearX = Math.max(pLeft, Math.min(cx, pRight));
                    const nearY = Math.max(pTop, Math.min(cy, pBottom));
                    const dx = cx - nearX;
                    const dy = cy - nearY;
                    if (dx * dx + dy * dy < (r + POPOVER_GAP) * (r + POPOVER_GAP)) {
                        return false;
                    }
                }
                return true;
            };

            // Check if the current full-size layout has overlap
            const centers = computeFaceCenters(
                faces.length, result.cols, result.rows, size, W, H);
            if (anyFaceOverlapsRect(centers, size / 2, pLeft, pTop, pRight, pBottom)) {

                // Binary search for the largest face size that works
                // with some grid configuration, pinned top-left.
                // Use max(W,H) as upper bound since hex packing allows
                // larger faces than optimizeGrid's uniform-spacing estimate.
                let lo = 0, hi = Math.max(W, H);
                let bestCols = result.cols;

                for (let iter = 0; iter < 25; iter++) {
                    const mid = Math.floor((lo + hi) / 2);
                    if (mid <= 0) break;

                    // Try all possible column counts
                    let anyWorks = false;
                    for (let c = 1; c <= faces.length; c++) {
                        if (configFits(c, mid)) {
                            anyWorks = true;
                            break;
                        }
                    }
                    if (anyWorks) {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }

                // Found the max size. Now pick the best column count at that size:
                // prefer the config that gives the largest face (they're all `lo`,
                // so prefer fewer total cells = more balanced layout).
                size = lo;
                let bestConfig = result.cols;
                for (let c = 1; c <= faces.length; c++) {
                    if (configFits(c, size)) {
                        bestConfig = c;
                        break;  // first valid config at this size
                    }
                }

                result.cols = bestConfig;
                result.rows = Math.ceil(faces.length / bestConfig);
                useTopLeftAlign = true;
                if (size <= 0) return;

                // Now find the best position that doesn't overlap.
                const cellStep = size + GAP_PX;
                const remainder = faces.length - bestConfig * (result.rows - 1);
                const hasNestle = remainder > 0 && remainder < bestConfig;
                const lastColX = hexColX(bestConfig - 1, remainder, bestConfig, cellStep, hasNestle);
                const gridW = lastColX + size;
                const gridH = (result.rows - 1) * cellStep + size;
                const centeredX = (W - gridW) / 2 - PADDING_PX;
                const centeredY = (H - gridH) / 2 - PADDING_PX;
                const r = size / 2;

                const shiftFits = (dx: number, dy: number): boolean => {
                    for (let i = 0; i < faces.length; i++) {
                        const row = Math.floor(i / bestConfig);
                        const col = i % bestConfig;
                        const isShort = col >= remainder;
                        const cx = PADDING_PX + dx + hexColX(col, remainder, bestConfig, cellStep, hasNestle) + r;
                        const cy = PADDING_PX + dy + row * cellStep + (isShort && hasNestle ? cellStep / 2 : 0) + r;
                        const nearX = Math.max(pLeft, Math.min(cx, pRight));
                        const nearY = Math.max(pTop, Math.min(cy, pBottom));
                        const ddx = cx - nearX;
                        const ddy = cy - nearY;
                        if (ddx * ddx + ddy * ddy < (r + POPOVER_GAP) * (r + POPOVER_GAP)) {
                            return false;
                        }
                    }
                    return true;
                };

                // Step 1: find best horizontal position
                let sLo = 0, sHi = Math.max(0, centeredX);
                for (let iter = 0; iter < 20; iter++) {
                    const sMid = (sLo + sHi) / 2;
                    if (shiftFits(sMid, 0)) {
                        sLo = sMid;
                    } else {
                        sHi = sMid;
                    }
                }
                gridShiftX = sLo;

                // Step 2: at that horizontal position, find best vertical position
                let vLo = 0, vHi = Math.max(0, centeredY);
                for (let iter = 0; iter < 20; iter++) {
                    const vMid = (vLo + vHi) / 2;
                    if (shiftFits(gridShiftX, vMid)) {
                        vLo = vMid;
                    } else {
                        vHi = vMid;
                    }
                }
                gridShiftY = vLo;
            }
        }

        const dpr = window.devicePixelRatio || 1;
        const newPhys = Math.round(size * dpr);
        if (newPhys === faces[0]?.canvas.width) return;

        stopScheduler();

        cols = result.cols;
        rows = result.rows;

        if (useTopLeftAlign) {
            // Top-left-aligned grid with hex close-pack (matches configFits() geometry)
            const cellStep = size + GAP_PX;
            const remainder = faces.length - cols * (rows - 1);
            const hasNestle = remainder > 0 && remainder < cols;

            for (let i = 0; i < faces.length; i++) {
                const row = Math.floor(i / cols);
                const col = i % cols;
                const isShortCol = col >= remainder;
                const x = PADDING_PX + gridShiftX + hexColX(col, remainder, cols, cellStep, hasNestle);
                const y = PADDING_PX + gridShiftY + row * cellStep + (isShortCol && hasNestle ? cellStep / 2 : 0);
                const cell = faces[i].canvas.parentElement as HTMLElement;
                cell.style.position = 'absolute';
                cell.style.left = `${x}px`;
                cell.style.top = `${y}px`;
                cell.style.width = `${size}px`;
                cell.style.height = `${size}px`;
            }
        } else {
            const cellStep = size + GAP_PX; // center-to-center distance

            // Position each face cell absolutely.
            // The first (incomplete) row goes at the top.
            const remainder = faces.length - cols * (rows - 1); // items in short top row

            // Nestling: when (cols - remainder) is odd, the short row's faces
            // are offset by half a cellStep from the full rows.  Round faces
            // can nestle into those gaps, reducing the vertical spacing so that
            // the diagonal edge-to-edge distance equals GAP_PX.
            const canNestle = rows > 1 && remainder !== cols && (cols - remainder) % 2 === 1;
            const nestledStep = canNestle ? cellStep * Math.sqrt(3) / 2 : cellStep;

            // Total grid dimensions (nestled first gap, normal for rest)
            const gridW = cols * size + (cols - 1) * GAP_PX;
            // Simpler: row 0 at y=0, row 1 at y=nestledStep, row k>1 at y=nestledStep+(k-1)*cellStep
            // Total height = last_row_y + size
            const lastRowY = rows === 1 ? 0 : nestledStep + (rows - 2) * cellStep;
            const totalH = lastRowY + size;

            // Offset to center the grid in the container, with popover shift
            const offsetX = (W - gridW) / 2 + gridShiftX;
            const offsetY = (H - totalH) / 2 + gridShiftY;

            for (let i = 0; i < faces.length; i++) {
                let row: number, colIdx: number, itemsInRow: number;

                if (i < remainder) {
                    // Short top row
                    row = 0;
                    colIdx = i;
                    itemsInRow = remainder;
                } else {
                    // Full rows below
                    const j = i - remainder;
                    row = 1 + Math.floor(j / cols);
                    colIdx = j % cols;
                    itemsInRow = cols;
                }

                // Center incomplete rows: extra offset for short rows
                const rowW = itemsInRow * size + (itemsInRow - 1) * GAP_PX;
                const rowOffsetX = (gridW - rowW) / 2;

                const x = offsetX + rowOffsetX + colIdx * cellStep;
                // Row 0 at y=0, row 1 at y=nestledStep, row 2+ at y=nestledStep+(row-1)*cellStep
                const rowY = row === 0 ? 0 : nestledStep + (row - 1) * cellStep;
                const y = offsetY + rowY;

                const cell = faces[i].canvas.parentElement as HTMLElement;
                cell.style.position = 'absolute';
                cell.style.left = `${x}px`;
                cell.style.top = `${y}px`;
                cell.style.width = `${size}px`;
                cell.style.height = `${size}px`;
            }
        }

        for (const face of faces) {
            applySize(face, size);
            face.cachesBuilt = false;
        }

        buildAllCachesSequentially(faces.filter(f => f.enabled), startScheduler);
    }

    const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width } = entry.contentRect;
        // Subtract the location panel and time bar heights from the parent's height
        const locationPanel = document.getElementById('location-panel');
        const timeBarEl = document.getElementById('time-bar');
        const panelH = locationPanel ? locationPanel.offsetHeight : 0;
        const timeBarH = timeBarEl ? timeBarEl.offsetHeight : 0;
        const height = entry.contentRect.height - panelH - timeBarH;
        if (resizeDebounceTimer !== null) clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
            resizeDebounceTimer = null;
            onGridResize(width, height);
        }, 150);
    });
    resizeObserver.observe(grid.parentElement!);

    // =========================================================================
    // Location change / prompt
    // =========================================================================

    function rebuildAllForLocation(newLat: number, newLon: number) {
        stopScheduler();
        lat = newLat;
        lon = newLon;
        for (const face of faces) {
            const fd = faceDataArray[face.faceDataIndex];
            const freshWatch = parseWatchXML(fd.xml, 'front');
            face.watch.parts = freshWatch.parts;
            face.watch.initExprs = freshWatch.initExprs;
            face.env = createWatchEnvironment(face.watch, newLat, newLon, getNow);
            face.cachesBuilt = false;
        }
        updateLocationDisplay();
        buildAllCachesSequentially(faces.filter(f => f.enabled), startScheduler);
    }

    function showLocationPrompt(blur: boolean) {
        locationPrompt.style.display = '';
        if (blur) grid.classList.add('blurred');
        // Pre-fill with current values (always, for manual invocation)
        lpLatInput.value = (lat !== 0 || lon !== 0) ? lat.toFixed(3) : '';
        lpLonInput.value = (lat !== 0 || lon !== 0) ? lon.toFixed(3) : '';

        // Configure browser location button based on permission state
        const btn = lpUseBrowser as HTMLButtonElement;
        const isFileUrl = window.location.protocol === 'file:';
        const deniedTooltip = isFileUrl
            ? 'Not all browsers support location access from file:// URLs'
            : 'Browser location was not granted — check your browser settings to allow it';

        if (geoPermission === 'granted') {
            btn.disabled = false;
            delete btn.dataset.tooltip;
            btn.textContent = 'Use browser location';
        } else {
            btn.disabled = true;
            btn.dataset.tooltip = deniedTooltip;
            btn.textContent = 'Use browser location (unavailable)';
        }

        // Disable "Use this location" until inputs have valid numbers
        const coordsBtn = lpUseCoords as HTMLButtonElement;
        function validateCoordInputs() {
            const validLat = !isNaN(parseFloat(lpLatInput.value));
            const validLon = !isNaN(parseFloat(lpLonInput.value));
            coordsBtn.disabled = !(validLat && validLon);
        }
        validateCoordInputs();
        lpLatInput.oninput = validateCoordInputs;
        lpLonInput.oninput = validateCoordInputs;
    }

    function dismissLocationPrompt() {
        locationPrompt.style.display = 'none';
        grid.classList.remove('blurred');
    }

    function applyLocation(newLat: number, newLon: number, source: string, writeToUrl: boolean) {
        locationSource = source;
        dismissLocationPrompt();
        rebuildAllForLocation(newLat, newLon);
        if (writeToUrl) {
            writeUrlState({ lat: newLat, lon: newLon });
        }
    }

    // "Use this location" button in prompt
    lpUseCoords.addEventListener('click', () => {
        const newLat = parseFloat(lpLatInput.value);
        const newLon = parseFloat(lpLonInput.value);
        if (isNaN(newLat) || isNaN(newLon)) return;
        applyLocation(newLat, newLon, '', true);
    });

    // "Use browser location" button in prompt
    lpUseBrowser.addEventListener('click', async () => {
        lpUseBrowser.textContent = 'Requesting…';
        const loc = await requestBrowserLocation();
        lpUseBrowser.textContent = 'Use browser location';
        if (loc) {
            applyLocation(loc.lat, loc.lon, '(from browser)', false);
        }
    });

    // "Demo — Cupertino" button in prompt
    lpUseDemo.addEventListener('click', () => {
        applyLocation(DEMO_LAT, DEMO_LON, '(Cupertino, CA)', true);
    });

    // "Set location" button on the location bar
    setLocationBtn.addEventListener('click', () => {
        showLocationPrompt(false);  // no blur when opened manually
    });

    // Close prompt when clicking backdrop
    locationPrompt.querySelector('.lp-backdrop')!.addEventListener('click', () => {
        // Only allow closing if we have a real location (not 0,0 from startup)
        if (!needsPrompt || (lat !== 0 || lon !== 0)) {
            dismissLocationPrompt();
        }
    });

    // =========================================================================
    // Time Controller UI
    // =========================================================================

    const timeBar = document.getElementById('time-bar')!;
    const timeBarLabel = document.getElementById('time-bar-label')!;
    const timeBarDate = document.getElementById('time-bar-date')!;
    const timeBarOffset = document.getElementById('time-bar-offset')!;
    const timeBarRate = document.getElementById('time-bar-rate')!;
    const timeBarNow = document.getElementById('time-bar-now')!;
    const timePopover = document.getElementById('time-popover')!;
    const tpRateLabel = document.getElementById('tp-rate-label')!;
    const tpTransport = document.getElementById('tp-transport')!;
    const tpClose = document.getElementById('tp-close')!;

    let popoverOpen = false;

    /** Map step unit names to RATE_OPTIONS indices for hold-to-scrub */
    const unitToRateIndex: Record<string, number> = {
        'minute': 1, // 10 min/s
        'hour':   2, // 10 hr/s
        'day':    3, // 10 day/s
        'month':  4, // 10 mo/s
        'year':   5, // 10 yr/s
    };

    /** Map data-step attributes to [unit, direction] */
    const stepMap: Record<string, [TimeUnit, 1 | -1]> = {
        '-year': ['year', -1],
        '-month': ['month', -1],
        '-day': ['day', -1],
        '-hour': ['hour', -1],
        '-minute': ['minute', -1],
        '+minute': ['minute', 1],
        '+hour': ['hour', 1],
        '+day': ['day', 1],
        '+month': ['month', 1],
        '+year': ['year', 1],
    };

    function formatSimTime(d: Date): string {
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const mo = months[d.getMonth()];
        const day = d.getDate();
        const yr = d.getFullYear();
        const h = d.getHours().toString().padStart(2, '0');
        const m = d.getMinutes().toString().padStart(2, '0');
        const s = d.getSeconds().toString().padStart(2, '0');
        return `${mo} ${day}, ${yr}  ${h}:${m}:${s}`;
    }

    /** Rebuild the transport bar buttons based on current state. */
    function renderTransport() {
        tpTransport.innerHTML = '';
        const isStopped = timeController.isStopped;

        if (isStopped) {
            // Show play-reverse and play-forward buttons
            const revBtn = document.createElement('button');
            revBtn.className = 'tp-btn';
            revBtn.textContent = '◀';
            revBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                timeController.setDirection(-1);
                timeController.setRate(null);
                resetAllSchedules();
                updateTimeUI();
                ensureSchedulerRunning();
                writeUrlState({ t: timeController.getDisplayTime().getTime(), dir: -1 });
            });

            const fwdBtn = document.createElement('button');
            fwdBtn.className = 'tp-btn';
            fwdBtn.textContent = '▶';
            fwdBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                timeController.setDirection(1);
                timeController.setRate(null);
                resetAllSchedules();
                updateTimeUI();
                ensureSchedulerRunning();
                writeUrlState({ t: timeController.getDisplayTime().getTime(), dir: 1 });
            });

            tpTransport.appendChild(revBtn);
            tpTransport.appendChild(fwdBtn);
        } else {
            // Show pause button
            const pauseBtn = document.createElement('button');
            pauseBtn.className = 'tp-btn active';
            pauseBtn.textContent = '‖';
            pauseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                timeController.stop();
                finishAllAnimations();
                updateTimeUI();
                ensureSchedulerRunning();
                writeUrlState({ t: timeController.getDisplayTime().getTime(), dir: 0 });
            });
            tpTransport.appendChild(pauseBtn);
        }

        // Add "Now ▶" button when time is overridden
        if (!timeController.isRealTime) {
            const nowBtn = document.createElement('button');
            nowBtn.className = 'tp-btn';
            nowBtn.innerHTML = 'Now\u2009<span style="position:relative;top:1px">▶</span>';
            nowBtn.style.padding = '5px 4px';
            nowBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                nowClicked();
            });
            tpTransport.appendChild(nowBtn);
        }
    }

    function updateTimeUI() {
        const isReal = timeController.isRealTime;

        // Toggle overridden class to show/hide offset, rate, "Now" button
        timeBar.classList.toggle('overridden', !isReal);

        // Always update the displayed time
        const sim = timeController.getDisplayTime();
        timeBarDate.textContent = formatSimTime(sim);

        if (!isReal) {
            timeBarRate.textContent = timeController.statusLabel;
            timeBarOffset.textContent = formatOffset(sim, new Date());
        }
        tpRateLabel.textContent = timeController.statusLabel;

        // Rebuild transport bar
        renderTransport();

        // Populate date inputs with current sim time
        (document.getElementById('tp-year') as HTMLInputElement).value = sim.getFullYear().toString();
        (document.getElementById('tp-month') as HTMLInputElement).value = (sim.getMonth() + 1).toString();
        (document.getElementById('tp-day') as HTMLInputElement).value = sim.getDate().toString();
        (document.getElementById('tp-hour') as HTMLInputElement).value = sim.getHours().toString();
        (document.getElementById('tp-minute') as HTMLInputElement).value = sim.getMinutes().toString();
    }

    /** Format the difference between sim and real time as a human-readable string.
     *  Uses calendar-based differencing for years and months. */
    function formatOffset(sim: Date, real: Date): string {
        const ms = sim.getTime() - real.getTime();
        const sign = ms < 0 ? '-' : '+';
        if (Math.abs(ms) < 2000) return '';

        // Truncate to whole seconds to avoid sub-second jitter
        // between sim capture time and new Date() call
        const fromMs = (ms < 0 ? sim : real).getTime();
        const toMs   = (ms < 0 ? real : sim).getTime();
        const from = new Date(Math.floor(fromMs / 1000) * 1000);
        const to   = new Date(Math.floor(toMs / 1000) * 1000);

        // Calendar difference: years, months
        let years = to.getFullYear() - from.getFullYear();
        let months = to.getMonth() - from.getMonth();
        let cursor = new Date(from);
        cursor.setFullYear(cursor.getFullYear() + years);
        cursor.setMonth(cursor.getMonth() + months);
        if (cursor > to) {
            months--;
            if (months < 0) { years--; months += 12; }
            cursor = new Date(from);
            cursor.setFullYear(cursor.getFullYear() + years);
            cursor.setMonth(cursor.getMonth() + months);
        }

        // Remaining difference in seconds
        let remainSec = Math.round((to.getTime() - cursor.getTime()) / 1000);

        // Round to the least significant displayed unit:
        //   years shown → round to nearest hour
        //   months/days shown → round to nearest minute
        //   otherwise → show exact seconds
        let days: number, hrs: number, mins: number, sec: number;
        if (years > 0 || months > 0) {
            // Round to nearest hour
            remainSec = Math.round(remainSec / 3600) * 3600;
            days = Math.floor(remainSec / 86400); remainSec %= 86400;
            hrs  = Math.floor(remainSec / 3600);
            mins = 0; sec = 0;
        } else if (remainSec >= 86400) {
            // Round to nearest minute
            remainSec = Math.round(remainSec / 60) * 60;
            days = Math.floor(remainSec / 86400); remainSec %= 86400;
            hrs  = Math.floor(remainSec / 3600);  remainSec %= 3600;
            mins = Math.floor(remainSec / 60);
            sec  = 0;
        } else {
            days = 0;
            hrs  = Math.floor(remainSec / 3600);  remainSec %= 3600;
            mins = Math.floor(remainSec / 60);     remainSec %= 60;
            sec  = remainSec;
        }

        // Handle rounding overflow (e.g. 23.5h rounds to 24h → +1 day)
        if (hrs >= 24) { days += Math.floor(hrs / 24); hrs %= 24; }

        const parts = [];
        if (years > 0)  parts.push(`${years}y`);
        if (months > 0) parts.push(`${months}mo`);
        if (days > 0)   parts.push(`${days}d`);
        if (hrs > 0)    parts.push(`${hrs}h`);
        if (mins > 0)   parts.push(`${mins}m`);
        if (sec > 0)    parts.push(`${sec}s`);
        return parts.length > 0 ? `(${sign}${parts.join(' ')})` : '';
    }

    function showPopover() {
        popoverOpen = true;
        timePopover.style.display = '';
        timeBarLabel.textContent = '⏱ Hide time controller';
        timeBarLabel.classList.add('active');
        updateTimeUI();
        writeUrlState({ tc: true });
        // Re-layout to shrink faces if popover overlaps
        if (lastContainerW > 0) {
            onGridResize(lastContainerW, lastContainerH);
        }
    }

    function hidePopover() {
        popoverOpen = false;
        timePopover.style.display = 'none';
        timeBarLabel.textContent = '⏱ Show time controller';
        timeBarLabel.classList.remove('active');
        updateTimeUI();
        writeUrlState({ tc: false });
        // Re-layout to restore full-size faces
        if (lastContainerW > 0) {
            onGridResize(lastContainerW, lastContainerH);
        }
    }

    function ensureSchedulerRunning() {
        // Kick the scheduler if it's idle
        if (rafId === null && idleTimerId === null) {
            startScheduler();
        } else if (rafId === null && timeController.needsContinuousRender) {
            // Idle timer is set but we need continuous render now
            stopScheduler();
            startScheduler();
        }
    }

    /** Snap all in-flight hand animations to their targets across all faces. */
    function finishAllAnimations() {
        for (const face of faces) {
            finishAnimations(face.handStates);
            finishLeafAnimations(face.terminatorLeaves);
        }
    }

    /** Unfreeze hand schedules on all faces after a pause. */
    function resetAllSchedules() {
        for (const face of faces) {
            resetHandSchedules(face.handStates);
            resetLeafSchedules(face.terminatorLeaves);
        }
    }

    // --- "Time control" button (opens popover) ---
    timeBarLabel.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popoverOpen) {
            hidePopover();
        } else {
            showPopover();
        }
    });

    // --- Rate label click (opens popover when overridden) ---
    timeBarRate.addEventListener('click', (e) => {
        e.stopPropagation();
        if (popoverOpen) {
            hidePopover();
        } else {
            showPopover();
        }
    });

    /** Reset to real time — shared by both Now buttons. */
    function nowClicked() {
        timeController.reset();
        finishAllAnimations();
        resetAllSchedules();
        updateTimeUI();
        stopScheduler();
        startScheduler();
        writeUrlState({ t: null, dir: 1 });
    }

    // --- "Now" reset button (time-bar version) ---
    timeBarNow.addEventListener('click', (e) => {
        e.stopPropagation();
        nowClicked();
    });

    // --- Step buttons with hold-to-scrub ---
    const HOLD_DELAY_MS = 300;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdingBtn: HTMLElement | null = null;

    function startHold(btn: HTMLElement, unit: string, dir: 1 | -1) {
        holdingBtn = btn;
        btn.classList.add('holding');

        // Set direction and start the corresponding rate
        timeController.setDirection(dir);
        const rateIdx = unitToRateIndex[unit];
        if (rateIdx !== undefined) {
            timeController.setRate(RATE_OPTIONS[rateIdx]);
        }
        resetAllSchedules();
        updateTimeUI();
        ensureSchedulerRunning();
    }

    function endHold() {
        if (holdTimer !== null) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
        if (holdingBtn) {
            holdingBtn.classList.remove('holding');
            holdingBtn = null;

            // Stop at current position and snap animations
            timeController.stop();
            finishAllAnimations();
            updateTimeUI();
            ensureSchedulerRunning();
            // Write time state to URL on button release
            writeUrlState({
                t: timeController.getDisplayTime().getTime(),
                dir: 0,
            });
        }
    }

    timePopover.querySelectorAll('[data-step]').forEach(btn => {
        const el = btn as HTMLElement;
        const stepKey = el.dataset.step!;
        const entry = stepMap[stepKey];
        if (!entry) return;
        const [unit, dir] = entry;
        const unitName = el.dataset.unit || unit;

        // Mouse events
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Immediate single step with smooth animation
            timeController.step(unit, dir);
            // One-shot: re-evaluate all hands with tick-interval animation
            const stepDeltaSec = displaySecondsPerTick(unit);
            timeController.beginFrame();
            const stepNow = performance.now();
            for (const face of faces) {
                if (!face.enabled || !face.cachesBuilt) continue;
                resetHandSchedules(face.handStates);
                resetLeafSchedules(face.terminatorLeaves);
                tickAnimations(face.handStates, face.env, stepNow, TICK_INTERVAL_MS, stepDeltaSec);
                tickLeafAnimations(face.terminatorLeaves, face.env, stepNow, TICK_INTERVAL_MS, stepDeltaSec);
            }
            timeController.endFrame();
            updateTimeUI();
            ensureSchedulerRunning();
            // Start hold timer
            holdTimer = setTimeout(() => {
                holdTimer = null;
                startHold(el, unitName, dir);
            }, HOLD_DELAY_MS);
        });

        el.addEventListener('mouseup', (e) => {
            e.stopPropagation();
            endHold();
            // Write current time state after step tap or hold release
            writeUrlState({
                t: timeController.getDisplayTime().getTime(),
                dir: timeController.isStopped ? 0 : timeController.currentDirection,
            });
        });

        el.addEventListener('mouseleave', () => {
            endHold();
        });

        // Touch events
        el.addEventListener('touchstart', (e) => {
            e.preventDefault();
            e.stopPropagation();
            // Immediate single step with smooth animation
            timeController.step(unit, dir);
            const stepDeltaSec = displaySecondsPerTick(unit);
            timeController.beginFrame();
            const stepNow = performance.now();
            for (const face of faces) {
                if (!face.enabled || !face.cachesBuilt) continue;
                resetHandSchedules(face.handStates);
                resetLeafSchedules(face.terminatorLeaves);
                tickAnimations(face.handStates, face.env, stepNow, TICK_INTERVAL_MS, stepDeltaSec);
                tickLeafAnimations(face.terminatorLeaves, face.env, stepNow, TICK_INTERVAL_MS, stepDeltaSec);
            }
            timeController.endFrame();
            updateTimeUI();
            ensureSchedulerRunning();
            holdTimer = setTimeout(() => {
                holdTimer = null;
                startHold(el, unitName, dir);
            }, HOLD_DELAY_MS);
        });

        el.addEventListener('touchend', (e) => {
            e.stopPropagation();
            endHold();
            // Write current time state after step tap or hold release
            writeUrlState({
                t: timeController.getDisplayTime().getTime(),
                dir: timeController.isStopped ? 0 : timeController.currentDirection,
            });
        });

        el.addEventListener('touchcancel', () => {
            endHold();
        });
    });

    // --- Date input Apply ---
    document.getElementById('tp-apply')!.addEventListener('click', (e) => {
        e.stopPropagation();
        const yr = parseInt((document.getElementById('tp-year') as HTMLInputElement).value, 10);
        const mo = parseInt((document.getElementById('tp-month') as HTMLInputElement).value, 10) - 1;
        const dy = parseInt((document.getElementById('tp-day') as HTMLInputElement).value, 10);
        const hr = parseInt((document.getElementById('tp-hour') as HTMLInputElement).value, 10);
        const mn = parseInt((document.getElementById('tp-minute') as HTMLInputElement).value, 10);
        if (isNaN(yr) || isNaN(mo) || isNaN(dy) || isNaN(hr) || isNaN(mn)) return;
        const d = new Date(yr, mo, dy, hr, mn, 0, 0);
        timeController.setTime(d);
        updateTimeUI();
        ensureSchedulerRunning();
        writeUrlState({
            t: d.getTime(),
            dir: 0,
        });
    });

    // Auto-apply when any date/time input changes (not just via Apply button)
    ['tp-year', 'tp-month', 'tp-day', 'tp-hour', 'tp-minute'].forEach(id => {
        document.getElementById(id)!.addEventListener('change', () => {
            // Trigger the same logic as the Apply button
            const yr = parseInt((document.getElementById('tp-year') as HTMLInputElement).value, 10);
            const mo = parseInt((document.getElementById('tp-month') as HTMLInputElement).value, 10) - 1;
            const dy = parseInt((document.getElementById('tp-day') as HTMLInputElement).value, 10);
            const hr = parseInt((document.getElementById('tp-hour') as HTMLInputElement).value, 10);
            const mn = parseInt((document.getElementById('tp-minute') as HTMLInputElement).value, 10);
            if (isNaN(yr) || isNaN(mo) || isNaN(dy) || isNaN(hr) || isNaN(mn)) return;
            const d = new Date(yr, mo, dy, hr, mn, 0, 0);
            timeController.setTime(d);
            updateTimeUI();
            ensureSchedulerRunning();
            writeUrlState({ t: d.getTime(), dir: 0 });
        });
    });

    // --- Close button in popover ---
    tpClose.addEventListener('click', (e) => {
        e.stopPropagation();
        hidePopover();
    });



    // =========================================================================
    // Time bar clock — update at the top of each second
    // =========================================================================
    function tickTimeBarClock() {
        // Only update here when in real-time mode — when overridden,
        // the frame loop handles all time bar updates with properly
        // paired sim/real timestamps to avoid offset jitter.
        if (timeController.isRealTime) {
            timeBarDate.textContent = formatSimTime(timeController.getDisplayTime());
        }
        const msUntilNextSecond = 1000 - (Date.now() % 1000);
        setTimeout(tickTimeBarClock, msUntilNextSecond);
    }
    tickTimeBarClock();

    // Periodic URL time capture — every 60s when running at 1× or -1×
    setInterval(() => {
        if (!timeController.isRealTime && !timeController.isStopped && timeController.currentRate === null) {
            writeUrlState({
                t: timeController.getDisplayTime().getTime(),
                dir: timeController.currentDirection,
            });
        }
    }, 60_000);

    // =========================================================================
    // Initial build
    // =========================================================================
    const initialRect = grid.getBoundingClientRect();
    if (initialRect.width > 0 && initialRect.height > 0) {
        onGridResize(initialRect.width, initialRect.height);
    }

    // Show time controller if URL says so
    if (urlState.tc) {
        showPopover();
    }

    // Show location prompt if no location was available
    if (needsPrompt) {
        showLocationPrompt(true);  // with blur
    }
}

// Expose the engine on the global window object
window.Chronometer = {
    start: main,
};

// Auto-start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(console.error));
} else {
    main().catch(console.error);
}
