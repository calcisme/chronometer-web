

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
import { initHandStates, tickAnimations, nextWakeupTime, anyAnimating, SCHEDULER_LOOKAHEAD_MS } from './watch/animation.js';
import type { HandState } from './watch/animation.js';
import type { Watch } from './watch/types.js';
import type { Environment } from './expr/evaluator.js';
import type { TerminatorLeafState } from './watch/terminator.js';
import { expandTerminatorToLeaves, updateLeafAngles } from './watch/terminator.js';
import { TimeController, RATE_OPTIONS, TICK_INTERVAL_MS } from './time-controller.js';
import type { TimeUnit } from './time-controller.js';

// ============================================================================
// Location persistence
// ============================================================================

const DEFAULT_LAT = 37.205;
const DEFAULT_LON = -121.954;
const STORAGE_KEY = 'chronometer-location';

function getQueryLocation(): { lat: number; lon: number; name?: string } | null {
    if (typeof window === 'undefined') return null;
    const params = new URLSearchParams(window.location.search);
    const latStr = params.get('lat');
    const lonStr = params.get('lon') || params.get('long');
    const lat = parseFloat(latStr || '');
    const lon = parseFloat(lonStr || '');
    if (!isNaN(lat) && !isNaN(lon)) {
        return { lat, lon, name: params.get('loc') || '(from URL)' };
    }
    return null;
}

function loadStoredLocation(): { lat: number; lon: number } | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const { lat, lon } = JSON.parse(raw);
        if (typeof lat === 'number' && typeof lon === 'number') return { lat, lon };
    } catch { /* ignore */ }
    return null;
}

function saveStoredLocation(lat: number, lon: number): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat, lon }));
    } catch { /* ignore — may fail in some file:// contexts */ }
}

function requestLocation(): Promise<{ lat: number; lon: number } | null> {
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
    const latInput = document.getElementById('lat-input') as HTMLInputElement;
    const lonInput = document.getElementById('lon-input') as HTMLInputElement;
    const sourceLabel = document.getElementById('location-source')!;
    const resetLink = document.getElementById('reset-location')!;

    // --- Resolve location ---
    let lat: number, lon: number;
    const queryLoc = getQueryLocation();

    if (queryLoc) {
        lat = queryLoc.lat;
        lon = queryLoc.lon;
        sourceLabel.textContent = queryLoc.name || '(from URL)';
    } else {
        const loc = await requestLocation();
        if (loc) {
            lat = loc.lat; lon = loc.lon;
            sourceLabel.textContent = '(from browser)';
        } else {
            const stored = loadStoredLocation();
            if (stored) {
                lat = stored.lat; lon = stored.lon;
                sourceLabel.textContent = '(saved)';
            } else {
                lat = DEFAULT_LAT; lon = DEFAULT_LON;
                sourceLabel.textContent = "(Steve's house)";
            }
        }
    }
    latInput.value = lat.toFixed(3);
    lonInput.value = lon.toFixed(3);

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
     * Rebuild all environments for the current simulated time.
     * Called on each tick and on manual time changes.
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

    timeController.onTick = rebuildAllForTime;

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

        for (const face of faces) {
            if (!face.enabled || !face.cachesBuilt) continue;
            tickAnimations(face.handStates, face.env, now);
            if (face.terminatorLeaves.length > 0) {
                const intervalMs = Math.min(...face.terminatorLeaves.map(l => l.updateIntervalSec)) * 1000;
                if (now - face.lastTerminatorRebuild > intervalMs) {
                    updateLeafAngles(face.terminatorLeaves, face.env);
                    buildStaticBlockCaches(
                        face.watch, face.env, face.canvas.width, face.canvas.height,
                        face.scale, face.images, face.terminatorLeaves
                    );
                    face.lastTerminatorRebuild = now;
                }
            }
            renderFrame(face.ctx, face.watch, face.env, face.scale, face.images, face.terminatorLeaves);
            if (anyAnimating(face.handStates)) stillAnimating = true;
        }
        // Update mini-bar time display if time is overridden
        if (!timeController.isRealTime) {
            const sim = timeController.getDisplayTime();
            timeBarDate.textContent = formatSimTime(sim);
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

    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    function onGridResize(W: number, H: number) {
        const result = optimizeGrid(faces.length, W, H, GAP_PX, PADDING_PX);
        if (result.size <= 0) return;

        const dpr = window.devicePixelRatio || 1;
        const newPhys = Math.round(result.size * dpr);
        if (newPhys === faces[0]?.canvas.width) return;

        stopScheduler();

        cols = result.cols;
        rows = result.rows;

        const size = result.size;
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
        const gridH = size + (canNestle ? nestledStep : 0)
                     + (rows > 1 ? (rows - 2) * cellStep : 0)
                     + (rows > 1 ? (rows - 1) * size - (rows - 2) * size : 0);
        // Simpler: row 0 at y=0, row 1 at y=nestledStep, row k>1 at y=nestledStep+(k-1)*cellStep
        // Total height = last_row_y + size
        const lastRowY = rows === 1 ? 0 : nestledStep + (rows - 2) * cellStep;
        const totalH = lastRowY + size;

        // Offset to center the grid in the container
        const offsetX = (W - gridW) / 2;
        const offsetY = (H - totalH) / 2;

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
    // Location change
    // =========================================================================

    function showResetIfSaved() {
        resetLink.style.display = loadStoredLocation() ? 'inline' : 'none';
    }
    showResetIfSaved();

    function rebuildAllForLocation(newLat: number, newLon: number) {
        stopScheduler();
        for (const face of faces) {
            const fd = faceDataArray[face.faceDataIndex];
            const freshWatch = parseWatchXML(fd.xml, 'front');
            face.watch.parts = freshWatch.parts;
            face.watch.initExprs = freshWatch.initExprs;
            face.env = createWatchEnvironment(face.watch, newLat, newLon, getNow);
            face.cachesBuilt = false;
        }
        buildAllCachesSequentially(faces.filter(f => f.enabled), startScheduler);
    }

    function onLocationChange() {
        const newLat = parseFloat(latInput.value);
        const newLon = parseFloat(lonInput.value);
        if (isNaN(newLat) || isNaN(newLon)) return;
        saveStoredLocation(newLat, newLon);
        sourceLabel.textContent = '(saved)';
        showResetIfSaved();
        rebuildAllForLocation(newLat, newLon);
    }

    latInput.addEventListener('change', onLocationChange);
    lonInput.addEventListener('change', onLocationChange);

    resetLink.addEventListener('click', () => {
        try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
        latInput.value = DEFAULT_LAT.toFixed(3);
        lonInput.value = DEFAULT_LON.toFixed(3);
        sourceLabel.textContent = "(Steve's house)";
        resetLink.style.display = 'none';
        rebuildAllForLocation(DEFAULT_LAT, DEFAULT_LON);
    });

    // =========================================================================
    // Time Controller UI
    // =========================================================================

    const timeBar = document.getElementById('time-bar')!;
    const timeBarLabel = document.getElementById('time-bar-label')!;
    const timeBarDate = document.getElementById('time-bar-date')!;
    const timeBarRate = document.getElementById('time-bar-rate')!;
    const timeBarNow = document.getElementById('time-bar-now')!;
    const timePopover = document.getElementById('time-popover')!;
    const tpRateLabel = document.getElementById('tp-rate-label')!;

    let popoverOpen = false;

    /** Map data-speed attributes to RATE_OPTIONS indices (null = 1×) */
    const speedMap: Record<string, number | null> = {
        '1x': null,
        '10x': 0,
        '10min': 1,
        '10hr': 2,
        '10day': 3,
        '10mo': 4,
        '10yr': 5,
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

    function updateTimeUI() {
        const isReal = timeController.isRealTime;

        // Toggle overridden class to show/hide date, rate, "Now" button
        timeBar.classList.toggle('overridden', !isReal);

        if (!isReal) {
            const sim = timeController.getDisplayTime();
            timeBarDate.textContent = formatSimTime(sim);
            timeBarRate.textContent = timeController.statusLabel;
        }
        tpRateLabel.textContent = timeController.statusLabel;

        // Update active states on direction buttons
        const dirBtns = timePopover.querySelectorAll('[data-dir]');
        dirBtns.forEach(btn => {
            const el = btn as HTMLElement;
            const dir = el.dataset.dir;
            el.classList.toggle('active',
                (dir === 'forward' && !timeController.isStopped && timeController.currentDirection === 1) ||
                (dir === 'reverse' && !timeController.isStopped && timeController.currentDirection === -1) ||
                (dir === 'stop' && timeController.isStopped)
            );
        });

        // Update active states on speed buttons
        const speedBtns = timePopover.querySelectorAll('.tp-speed');
        speedBtns.forEach(btn => {
            const el = btn as HTMLElement;
            const speedKey = el.dataset.speed!;
            const rateIdx = speedMap[speedKey];
            const currentRate = timeController.currentRate;
            const isActive = (rateIdx === null && currentRate === null) ||
                             (rateIdx !== null && currentRate !== null && currentRate === RATE_OPTIONS[rateIdx]);
            el.classList.toggle('active', isActive);
        });

        // Populate date inputs with current sim time
        const sim = timeController.getDisplayTime();
        (document.getElementById('tp-year') as HTMLInputElement).value = sim.getFullYear().toString();
        (document.getElementById('tp-month') as HTMLInputElement).value = (sim.getMonth() + 1).toString();
        (document.getElementById('tp-day') as HTMLInputElement).value = sim.getDate().toString();
        (document.getElementById('tp-hour') as HTMLInputElement).value = sim.getHours().toString();
        (document.getElementById('tp-minute') as HTMLInputElement).value = sim.getMinutes().toString();
    }

    function showPopover() {
        popoverOpen = true;
        timePopover.style.display = '';
        updateTimeUI();
    }

    function hidePopover() {
        popoverOpen = false;
        timePopover.style.display = 'none';
        updateTimeUI();
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

    // --- "Now" reset button ---
    timeBarNow.addEventListener('click', (e) => {
        e.stopPropagation();
        timeController.reset();
        hidePopover();
        ensureSchedulerRunning();
    });

    // --- Direction buttons ---
    timePopover.querySelectorAll('[data-dir]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dir = (btn as HTMLElement).dataset.dir!;
            if (dir === 'stop') {
                timeController.stop();
            } else if (dir === 'forward') {
                timeController.setDirection(1);
            } else if (dir === 'reverse') {
                timeController.setDirection(-1);
            }
            updateTimeUI();
            ensureSchedulerRunning();
        });
    });

    // --- Speed buttons ---
    timePopover.querySelectorAll('.tp-speed').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const speedKey = (btn as HTMLElement).dataset.speed!;
            const rateIdx = speedMap[speedKey];
            const rate = rateIdx === null ? null : RATE_OPTIONS[rateIdx];
            timeController.setRate(rate);
            updateTimeUI();
            ensureSchedulerRunning();
        });
    });

    // --- Step buttons ---
    timePopover.querySelectorAll('[data-step]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const stepKey = (btn as HTMLElement).dataset.step!;
            const [unit, dir] = stepMap[stepKey];
            timeController.step(unit, dir);
            updateTimeUI();
            ensureSchedulerRunning();
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
    });

    // --- Click outside to dismiss popover ---
    document.addEventListener('click', (e) => {
        if (!popoverOpen) return;
        const target = e.target as Node;
        if (timePopover.contains(target) || timeBar.contains(target)) return;
        hidePopover();
    });



    // =========================================================================
    // Initial build
    // =========================================================================
    const initialRect = grid.getBoundingClientRect();
    if (initialRect.width > 0 && initialRect.height > 0) {
        onGridResize(initialRect.width, initialRect.height);
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
