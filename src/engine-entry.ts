

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
import { loadCityData, searchCities, findClosestCity, isCityDataLoaded, loadError } from './city-search.js';
import type { CityResult } from './city-search.js';
import { renderGlobe, loadOSMTile } from './mini-map.js';

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

    const lpCityInput = document.getElementById('lp-city-input') as HTMLInputElement;
    const lpCityResults = document.getElementById('lp-city-results')!;
    const lpGlobe = document.getElementById('lp-globe') as HTMLCanvasElement;
    const lpOsmContainer = document.getElementById('lp-osm-container')!;
    const lpOsmTile = document.getElementById('lp-osm-tile') as HTMLImageElement;
    const lpMapMarker = document.getElementById('lp-map-marker')!;
    const lpOsmOffline = document.getElementById('lp-osm-offline')!;
    const lpStatusSection = document.getElementById('lp-status-section')!;
    const lpNoLocation = document.getElementById('lp-no-location')!;
    const lpLocationName = document.getElementById('lp-location-name')!;
    const lpOsmAttribution = document.getElementById('lp-osm-attribution')!;
    const lpDoneBtn = document.getElementById('lp-done')!;
    const lpDialogFooter = lpDoneBtn.parentElement!;

    // Initialize link preservation
    initNavigationLinks();

    // Preload city database in the background so it's ready when the user
    // opens the location dialog. This is fire-and-forget — errors are silently
    // ignored here since loadCityData() will report them on actual use.
    loadCityData().catch(() => {});

    // --- Resolve location ---
    const urlState = readUrlState();
    let lat: number, lon: number;
    let locationSource = '';
    let locationFullLabel = '';  // Full "City, State, Country" for dialog display
    // Track how the location was obtained for display purposes
    let locationSourceType: 'url-city' | 'browser' | 'manual' | 'none' = 'none';
    let needsPrompt = false;
    // Track whether browser geolocation is available
    // 'granted' = we got a position, 'denied' = user rejected or unavailable, 'unknown' = never tried
    let geoPermission: 'granted' | 'denied' | 'unknown' = 'unknown';

    if (urlState.lat !== null && urlState.lon !== null) {
        lat = urlState.lat;
        lon = urlState.lon;
        locationSource = urlState.city || '';
        locationSourceType = urlState.city ? 'url-city' : 'manual';
        // We haven't tried geolocation — check the Permissions API if available
        if (navigator.permissions) {
            try {
                const status = await navigator.permissions.query({ name: 'geolocation' });
                geoPermission = status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown';
            } catch { /* ignore — not all browsers support this */ }
        }
    } else if (urlState.bloc) {
        // bloc=1 set — ask browser for location without showing prompt
        const loc = await requestBrowserLocation();
        if (loc) {
            lat = loc.lat; lon = loc.lon;
            locationSource = 'from browser';
            locationSourceType = 'browser';
            geoPermission = 'granted';
        } else {
            // Browser denied — fall through to prompt
            lat = 0; lon = 0;
            locationSource = '';
            locationSourceType = 'none';
            needsPrompt = true;
            geoPermission = 'denied';
        }
    } else {
        // No lat/lon and no bloc — go straight to location prompt
        lat = 0; lon = 0;
        locationSource = '';
        locationSourceType = 'none';
        needsPrompt = true;
        geoPermission = 'unknown';
    }

    function updateLocationDisplay() {
        locationDisplay.innerHTML = `Latitude&nbsp;<span style="font-family:monospace">${lat.toFixed(3)}</span>&nbsp;&ensp;Longitude&nbsp;<span style="font-family:monospace">${lon.toFixed(3)}</span>`;
        sourceLabel.textContent = locationSource;
    }
    updateLocationDisplay();

    // --- Load per-face images and parse watches ---
    const parsedWatches: Watch[] = [];
    const allImages: Map<string, LoadedImage>[] = [];

    // Capture planet icon data URLs for the planet selector before releasing
    const planetIconDataUrls: Map<string, string> = new Map();
    const planetIconKeys = [
        'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'sun',
    ];
    const planetIconSrcMap: Record<string, string> = {
        moon: '../partsBin/moonES36.png',
        mercury: '../partsBin/planets/mercury36.png',
        venus: '../partsBin/planets/venus36.png',
        mars: '../partsBin/planets/mars36.png',
        jupiter: '../partsBin/planets/jupiter36.png',
        saturn: '../partsBin/planets/saturn36.png',
        uranus: '../partsBin/planets/uranus36.png',
        neptune: '../partsBin/planets/neptune36.png',
        sun: '../partsBin/planets/sun36.png',
    };

    for (const fd of faceDataArray) {
        parsedWatches.push(parseWatchXML(fd.xml, 'front'));
        // Capture planet icon data URLs before loading (Venezia face has these)
        if (fd.images) {
            for (const [key, src] of Object.entries(planetIconSrcMap)) {
                const entry = (fd.images as Record<string, { dataUrl: string }>)[src];
                if (entry && !planetIconDataUrls.has(key)) {
                    planetIconDataUrls.set(key, entry.dataUrl);
                }
            }
        }
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
    if (urlState.off !== null && !isNaN(urlState.off)) {
        // Offset mode: 1× forward with a fixed offset from real time
        timeController.setOffset(urlState.off);
    } else if (urlState.t !== null && !isNaN(urlState.t)) {
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
    let wasShifted = false;  // tracks if face is currently in a popover-dodged position

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
        // Skip if size hasn't changed AND layout position hasn't changed
        const positionChanged = useTopLeftAlign !== wasShifted;
        if (newPhys === faces[0]?.canvas.width && !positionChanged) return;
        wasShifted = useTopLeftAlign;

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
        const planetSelectorEl = document.getElementById('planet-selector');
        const panelH = locationPanel ? locationPanel.offsetHeight : 0;
        const timeBarH = timeBarEl ? timeBarEl.offsetHeight : 0;
        const planetSelH = planetSelectorEl ? planetSelectorEl.offsetHeight : 0;
        const height = entry.contentRect.height - panelH - timeBarH - planetSelH;
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
        // Clear city search and autofocus
        if (lpCityInput) { lpCityInput.value = ''; }
        if (lpCityResults) { lpCityResults.innerHTML = ''; }
        // Autofocus the search input after dialog renders
        setTimeout(() => lpCityInput?.focus(), 50);

        // Show status section (map + location name) or no-location placeholder
        const hasLocation = lat !== 0 || lon !== 0;
        if (hasLocation) {
            lpStatusSection.classList.add('visible');
            lpNoLocation.classList.add('hidden');
            updateMapPreview(lat, lon);
        } else {
            lpStatusSection.classList.remove('visible');
            lpNoLocation.classList.remove('hidden');
        }

        // Show Done button when user can dismiss (has a real location)
        lpDialogFooter.classList.toggle('visible', !needsPrompt || hasLocation);

        // Configure browser location button based on permission state
        const btn = lpUseBrowser as HTMLButtonElement;
        const isFileUrl = window.location.protocol === 'file:';
        const deniedTooltip = isFileUrl
            ? 'Not all browsers support location access from file:// URLs'
            : 'Browser location was not granted — check your browser settings to allow it';

        if (geoPermission === 'denied') {
            btn.disabled = true;
            btn.dataset.tooltip = deniedTooltip;
            btn.textContent = 'Use browser location (unavailable)';
        } else {
            btn.disabled = false;
            delete btn.dataset.tooltip;
            btn.textContent = 'Use browser location';
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

    const isFileProtocol = window.location.protocol === 'file:';

    /**
     * Build the location name string for the dialog header.
     * Rules:
     *   - If locationSourceType is 'url-city' → use locationSource + "(from cities database)"
     *   - If locationSourceType is 'browser' → find closest city + "(from browser)"
     *   - If locationSourceType is 'manual'  → find closest city + "(manually entered)"
     *   - If no city data loaded yet, just show coords
     */
    function buildLocationNameHTML(): string {
        if (locationSourceType === 'url-city' && locationFullLabel) {
            return `${locationFullLabel} <span class="lp-loc-source">(from cities database)</span>`;
        }
        // For browser or manual, find closest city
        if (locationSourceType === 'browser' || locationSourceType === 'manual') {
            const closest = findClosestCity(lat, lon);
            const sourceLabel = locationSourceType === 'browser' ? '(from browser)' : '(manually entered)';
            if (closest) {
                return `${closest.label} <span class="lp-loc-source">${sourceLabel}</span>`;
            }
            return `${lat.toFixed(3)}, ${lon.toFixed(3)} <span class="lp-loc-source">${sourceLabel}</span>`;
        }
        // Fallback — just coords
        return `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
    }

    /** Update the map preview in the dialog to show the given location. */
    function updateMapPreview(mapLat: number, mapLon: number) {
        // Show the status section, hide the no-location placeholder
        lpStatusSection.classList.add('visible');
        lpNoLocation.classList.add('hidden');

        // Globe always renders
        renderGlobe(lpGlobe, mapLat, mapLon);
        // OSM tiles require a Referer header, which file:// URLs can't provide
        if (isFileProtocol) {
            lpOsmContainer.style.display = 'none';
            lpOsmAttribution.style.display = 'none';
            // Enlarge globe when it's the only map
            lpGlobe.width = 160;
            lpGlobe.height = 160;
            lpGlobe.style.width = '160px';
            lpGlobe.style.height = '160px';
        } else {
            lpOsmContainer.style.display = '';
            lpOsmAttribution.style.display = '';
            lpOsmOffline.style.display = 'none';
            loadOSMTile(lpOsmContainer, lpOsmTile, lpMapMarker, mapLat, mapLon).then(ok => {
                lpOsmOffline.style.display = ok ? 'none' : '';
            });
        }
        // Update location name
        lpLocationName.innerHTML = buildLocationNameHTML();
    }

    /** Apply location to the watch AND update the map preview (dialog stays open). */
    function applyLocation(newLat: number, newLon: number, source: string, fullLabel: string, sourceType: typeof locationSourceType, writeToUrl: boolean) {
        locationSource = source;
        locationFullLabel = fullLabel;
        locationSourceType = sourceType;
        rebuildAllForLocation(newLat, newLon);
        if (writeToUrl) {
            writeUrlState({ lat: newLat, lon: newLon, city: source || null });
        }
        // Update the map preview and show Done button
        updateMapPreview(newLat, newLon);
        lpDialogFooter.classList.add('visible');
        needsPrompt = false;
    }

    // "Use this location" button in prompt
    lpUseCoords.addEventListener('click', () => {
        const newLat = parseFloat(lpLatInput.value);
        const newLon = parseFloat(lpLonInput.value);
        if (isNaN(newLat) || isNaN(newLon)) return;
        applyLocation(newLat, newLon, '', '', 'manual', true);
    });

    // "Use browser location" button in prompt
    lpUseBrowser.addEventListener('click', async () => {
        lpUseBrowser.textContent = 'Requesting…';
        const loc = await requestBrowserLocation();
        lpUseBrowser.textContent = 'Use browser location';
        if (loc) {
            applyLocation(loc.lat, loc.lon, '', '', 'browser', false);
            // Write bloc=1 and clear lat/lon/city so next reload asks browser again
            writeUrlState({ bloc: true, lat: null, lon: null, city: null });
        }
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

    // Close prompt with Escape key (same condition as backdrop)
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Escape' && locationPrompt.style.display !== 'none') {
            if (!needsPrompt || (lat !== 0 || lon !== 0)) {
                dismissLocationPrompt();
            }
        }
    });

    // "Done" button in map footer
    lpDoneBtn.addEventListener('click', () => {
        dismissLocationPrompt();
    });

    // =========================================================================
    // City search autocomplete
    // =========================================================================

    let citySearchDebounce: ReturnType<typeof setTimeout> | null = null;
    let cityDataLoading = false;
    let selectedCityIndex = -1;

    function renderCityResults(results: CityResult[]) {
        lpCityResults.innerHTML = '';
        selectedCityIndex = -1;
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const div = document.createElement('div');
            div.className = 'lp-city-item';
            if (r.isAirport) {
                // "SFO  San Francisco airport" — split IATA from rest
                const parts = r.label.split('  ');
                div.innerHTML = `<span class="iata-tag">${parts[0]}</span>${parts.slice(1).join('  ')}`;
            } else {
                div.textContent = r.label;
            }
            div.addEventListener('click', () => {
                applyLocation(r.lat, r.lon, r.shortLabel, r.label, 'url-city', true);
                lpCityInput.value = '';
                lpCityResults.innerHTML = '';
                // Update lat/lon inputs to reflect selection
                lpLatInput.value = r.lat.toFixed(3);
                lpLonInput.value = r.lon.toFixed(3);
            });
            lpCityResults.appendChild(div);
        }
    }

    let cityDataFailed = false;

    async function onCityInput() {
        try {
            let query = lpCityInput.value.trim();
            if (query.length < 2) {
                lpCityResults.innerHTML = '';
                return;
            }

            // If a previous load failed, show the error
            if (cityDataFailed) {
                lpCityResults.innerHTML = `<div class="lp-city-loading">City search unavailable: ${loadError || 'unknown error'}</div>`;
                return;
            }

            if (!isCityDataLoaded()) {
                if (!cityDataLoading) {
                    cityDataLoading = true;
                    lpCityResults.innerHTML = '<div class="lp-city-loading">Loading city database…</div>';
                    try {
                        await loadCityData();
                    } catch (err) {
                        cityDataLoading = false;
                        cityDataFailed = true;
                        lpCityResults.innerHTML = `<div class="lp-city-loading">Failed to load city data: ${(err as Error).message}</div>`;
                        return;
                    }
                    cityDataLoading = false;
                    // Re-read value — user may have typed more while loading
                    query = lpCityInput.value.trim();
                    if (query.length < 2) {
                        lpCityResults.innerHTML = '';
                        return;
                    }
                } else {
                    return;  // still loading, keep "Loading…" message visible
                }
            }

            const results = searchCities(query, 20);
            renderCityResults(results);
        } catch (err) {
            console.error('[CitySearch] Error:', err);
            lpCityResults.innerHTML = `<div class="lp-city-loading">Error: ${(err as Error).message}</div>`;
        }
    }

    function debounceCitySearch() {
        if (citySearchDebounce) clearTimeout(citySearchDebounce);
        citySearchDebounce = setTimeout(onCityInput, 150);
    }

    // Listen on multiple events for iOS compatibility.
    // iOS Safari may not fire 'input' during autocorrect/compose.
    lpCityInput.addEventListener('input', debounceCitySearch);
    lpCityInput.addEventListener('keyup', debounceCitySearch);
    lpCityInput.addEventListener('compositionend', debounceCitySearch);

    // On iOS, when the keyboard opens the viewport shrinks.
    // Scroll the input into view so the results below it stay visible.
    lpCityInput.addEventListener('focus', () => {
        setTimeout(() => {
            lpCityInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);  // delay lets iOS keyboard animation finish
    });

    // Keyboard navigation in results
    lpCityInput.addEventListener('keydown', (e: KeyboardEvent) => {
        const items = lpCityResults.querySelectorAll('.lp-city-item');
        if (items.length === 0) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedCityIndex = Math.min(selectedCityIndex + 1, items.length - 1);
            items.forEach((el, i) => el.classList.toggle('selected', i === selectedCityIndex));
            (items[selectedCityIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedCityIndex = Math.max(selectedCityIndex - 1, 0);
            items.forEach((el, i) => el.classList.toggle('selected', i === selectedCityIndex));
            (items[selectedCityIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter' && selectedCityIndex >= 0) {
            e.preventDefault();
            (items[selectedCityIndex] as HTMLElement).click();
        } else if (e.key === 'Escape') {
            lpCityResults.innerHTML = '';
            lpCityInput.value = '';
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
                writeTimeState();
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
                writeTimeState();
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
                writeTimeState();
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
        // Defer resize to next frame so the popover has been laid out
        // (getBoundingClientRect needs the element to be rendered first)
        requestAnimationFrame(() => {
            if (lastContainerW > 0) {
                onGridResize(lastContainerW, lastContainerH);
            }
        });
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

    /**
     * Write the current time state to the URL.
     * Uses 'off' for 1× forward with offset (stays valid as real time advances),
     * and 't'+'dir' for all other modes (stopped, reverse, accelerated).
     */
    function writeTimeState() {
        if (timeController.isRealTime) {
            // Real time — clear all time params
            writeUrlState({ t: null, off: null, dir: 1 });
        } else if (
            !timeController.isStopped &&
            timeController.currentRate === null &&
            timeController.currentDirection === 1
        ) {
            // 1× forward with offset — store offset, clear absolute time
            writeUrlState({ off: timeController.timeOffset, t: null, dir: 1 });
        } else {
            // Stopped, reverse, or accelerated — store absolute time
            const dir = timeController.isStopped ? 0 : timeController.currentDirection;
            writeUrlState({
                t: timeController.getDisplayTime().getTime(),
                off: null,
                dir: dir as 0 | 1 | -1,
            });
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
        writeTimeState();
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
            writeTimeState();
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
            writeTimeState();
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
            writeTimeState();
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
        writeTimeState();
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
            writeTimeState();
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
            writeTimeState();
        }
    }, 60_000);

    // =========================================================================
    // Planet selector (Venezia only, single-face mode)
    // =========================================================================
    const isSingleFace = faceDataArray.length === 1;
    const isVenezia = isSingleFace && faceDataArray[0].name === 'Venezia';

    if (isVenezia) {
        const selectorEl = document.getElementById('planet-selector');
        const iconsContainer = document.getElementById('planet-icons');
        const nameLabel = document.getElementById('planet-name');
        const prevBtn = document.getElementById('planet-prev');
        const nextBtn = document.getElementById('planet-next');

        if (selectorEl && iconsContainer && nameLabel && prevBtn && nextBtn) {
            selectorEl.style.display = 'flex';

            const planetOrder = [
                { key: 'sun',     name: 'Sun',     param: 'sun' },
                { key: 'moon',    name: 'Moon',    param: 'moon' },
                { key: 'mercury', name: 'Mercury', param: 'mercury' },
                { key: 'venus',   name: 'Venus',   param: 'venus' },
                { key: 'mars',    name: 'Mars',    param: 'mars' },
                { key: 'jupiter', name: 'Jupiter', param: 'jupiter' },
                { key: 'saturn',  name: 'Saturn',  param: 'saturn' },
                { key: 'uranus',  name: 'Uranus',  param: 'uranus' },
                { key: 'neptune', name: 'Neptune', param: 'neptune' },
            ];

            // Determine current selection from URL or default
            const params = new URLSearchParams(window.location.search);
            const currentBody = (params.get('body') || 'jupiter').toLowerCase();
            let selectedIdx = planetOrder.findIndex(p => p.param === currentBody);
            if (selectedIdx < 0) selectedIdx = 5; // Jupiter

            // Build icon buttons
            const iconBtns: HTMLButtonElement[] = [];
            for (let i = 0; i < planetOrder.length; i++) {
                const p = planetOrder[i];
                const btn = document.createElement('button');
                btn.className = 'planet-icon-btn';
                btn.title = p.name;
                const imgUrl = planetIconDataUrls.get(p.key);
                if (imgUrl) {
                    const img = document.createElement('img');
                    img.src = imgUrl;
                    img.alt = p.name;
                    btn.appendChild(img);
                } else {
                    btn.textContent = p.name.charAt(0);
                }
                if (i === selectedIdx) btn.classList.add('selected');
                btn.addEventListener('click', () => selectPlanet(i));
                iconsContainer.appendChild(btn);
                iconBtns.push(btn);
            }

            nameLabel.textContent = planetOrder[selectedIdx].name;

            function selectPlanet(idx: number) {
                selectedIdx = idx;
                const p = planetOrder[idx];

                // Update UI
                iconBtns.forEach((b, i) => b.classList.toggle('selected', i === idx));
                nameLabel!.textContent = p.name;

                // Update URL parameter (without reload)
                const url = new URL(window.location.href);
                url.searchParams.set('body', p.param);
                window.history.replaceState({}, '', url.toString());

                // Rebuild face with new body — preserve hand states for smooth animation
                for (const face of faces) {
                    if (!face.enabled) continue;
                    // Rebuild environment (picks up new body URL param)
                    face.env = createWatchEnvironment(face.watch, lat, lon, getNow);
                    // Update terminator leaf angles for the new planet's phase
                    // (keep existing leaves so the animation system can interpolate)
                    if (face.terminatorLeaves.length > 0) {
                        updateLeafAngles(face.terminatorLeaves, face.env);
                        resetLeafSchedules(face.terminatorLeaves);
                        face.lastTerminatorRebuild = 0;  // force static cache rebuild
                    }
                    // Rebuild static caches (background, marks, windows)
                    const { canvas, watch, env, images, scale } = face;
                    buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
                    // Force all hands to re-evaluate immediately (reset update timers)
                    for (const hs of face.handStates) {
                        hs.nextUpdateTime = 0;
                    }
                }
                // Kick the scheduler immediately so animations start without delay
                stopScheduler();
                startScheduler();
            }

            prevBtn.addEventListener('click', () => {
                selectPlanet((selectedIdx - 1 + planetOrder.length) % planetOrder.length);
            });
            nextBtn.addEventListener('click', () => {
                selectPlanet((selectedIdx + 1) % planetOrder.length);
            });
        }
    }

    // =========================================================================
    // Initial build
    // =========================================================================
    const initialRect = grid.getBoundingClientRect();
    if (initialRect.width > 0 && initialRect.height > 0) {
        onGridResize(initialRect.width, initialRect.height);
    }

    // Apply initial time bar styling (red text if URL set a non-real-time state)
    updateTimeUI();

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
