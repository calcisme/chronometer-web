/**
 * Standalone entry point — embeds the Haleakala XML at build time
 * so no fetch() is needed. Works from file:// protocol.
 *
 * Architecture:
 *  - Each active face is a FaceInstance with its own Environment,
 *    StaticCache, and HandState array.
 *  - A shared scheduler handles all faces: setTimeout fires for the
 *    next due update, rAF handles active animation frames.
 *  - A ResizeObserver on the grid container triggers debounced
 *    StaticCache rebuilds when the window changes size.
 */

// esbuild imports this as a string with --loader:.xml=text
import haleakalaXML from './watch/assets/haleakala/Haleakala-android.xml';
import hanaXML from './watch/assets/hana/Hana-I-android.xml';
import { parseWatchXML } from './watch/xml-parser.js';
import { createWatchEnvironment } from './watch/watch-env.js';
import { buildStaticCache, renderFrame, BEZEL_THICKNESS_XML } from './watch/renderer.js';
import { loadWatchImages } from './watch/image-loader.js';
import type { LoadedImage } from './watch/image-loader.js';
import { initHandStates, tickAnimations, nextWakeupTime, anyAnimating, SCHEDULER_LOOKAHEAD_MS } from './watch/animation.js';
import type { HandState } from './watch/animation.js';
import type { Watch } from './watch/types.js';
import type { Environment } from './expr/evaluator.js';
import type { TerminatorLeafState } from './watch/terminator.js';
import { expandTerminatorToLeaves, updateLeafAngles } from './watch/terminator.js';

// ============================================================================
// Location persistence
// ============================================================================

const DEFAULT_LAT = 37.205;
const DEFAULT_LON = -121.954;
const STORAGE_KEY = 'chronometer-location';

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

/**
 * Request the user's location from the browser.
 * Returns { lat, lon } in degrees, or null if unavailable/denied.
 */
function requestLocation(): Promise<{ lat: number; lon: number } | null> {
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            () => resolve(null),   // denied or error → fall back to default
            { timeout: 5000 },
        );
    });
}

// ============================================================================
// Grid layout maths
// ============================================================================

/** Compute (cols, rows) such that cols × rows >= count, most "squarish". */
function gridDimensions(count: number): { cols: number; rows: number } {
    if (count <= 0) return { cols: 1, rows: 1 };
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    return { cols, rows };
}

/**
 * Given the grid container size (px), gap (px), padding (px) and desired grid
 * dimensions, return the size (px) of a single square face cell.
 */
function cellSize(
    containerW: number, containerH: number,
    cols: number, rows: number,
    gap: number, padding: number,
): number {
    const usableW = containerW - 2 * padding - gap * (cols - 1);
    const usableH = containerH - 2 * padding - gap * (rows - 1);
    return Math.floor(Math.min(usableW / cols, usableH / rows));
}

// ============================================================================
// Per-face instance
// ============================================================================

interface FaceInstance {
    /** Parsed watch model. */
    watch: Watch;
    /** Live expression environment. */
    env: Environment;
    /** Rendered static background (or null while being built). */
    staticCache: OffscreenCanvas | null;
    /** Animation states for dynamic hands. */
    handStates: HandState[];
    /** The canvas element for this face. */
    canvas: HTMLCanvasElement;
    /** 2D rendering context for the canvas. */
    ctx: CanvasRenderingContext2D;
    /** Current logical square size (device-independent pixels). */
    sizePx: number;
    /** Images loaded for this face. */
    images: Map<string, LoadedImage>;
    /** Whether this face is "enabled" (StaticCache allocated). */
    enabled: boolean;
    /** Scale factor: internal drawing units → canvas pixels. */
    scale: number;
    /** Expanded terminator leaves (empty if no terminator parts). */
    terminatorLeaves: TerminatorLeafState[];
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    // --- UI elements ---
    const grid = document.getElementById('watch-grid') as HTMLDivElement;
    const latInput = document.getElementById('lat-input') as HTMLInputElement;
    const lonInput = document.getElementById('lon-input') as HTMLInputElement;
    const sourceLabel = document.getElementById('location-source')!;
    const resetLink = document.getElementById('reset-location')!;

    // --- Resolve location ---
    const loc = await requestLocation();
    let lat: number, lon: number;
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
    latInput.value = lat.toFixed(3);
    lonInput.value = lon.toFixed(3);

    // --- Load shared assets ---
    const images = await loadWatchImages();

    // --- Describe the set of faces to show ---
    const FACE_XMLS: string[] = [haleakalaXML, hanaXML];

    // --- Parse all watch models up front (read-only after this point) ---
    const parsedWatches: Watch[] = FACE_XMLS.map(xml => parseWatchXML(xml, 'front'));

    // --- Build the DOM: one cell + canvas per face ---
    const { cols, rows } = gridDimensions(parsedWatches.length);
    grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

    const faces: FaceInstance[] = [];

    for (let i = 0; i < parsedWatches.length; i++) {
        const cell = document.createElement('div');
        cell.className = 'face-cell';

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d')!;
        cell.appendChild(canvas);
        grid.appendChild(cell);

        const watch = parsedWatches[i];
        const env = createWatchEnvironment(watch, lat, lon);

        const face: FaceInstance = {
            watch,
            env,
            staticCache: null,
            handStates: [],
            canvas,
            ctx,
            sizePx: 0,
            images,
            enabled: true,
            scale: 1,
            terminatorLeaves: [],
        };
        faces.push(face);
    }

    // --- Size all canvases to match the grid container ---
    function applySize(face: FaceInstance, size: number) {
        const dpr = window.devicePixelRatio || 1;
        const physPx = Math.round(size * dpr);
        face.canvas.width = physPx;
        face.canvas.height = physPx;
        // CSS size stays at logical pixels so it fits the cell
        face.canvas.style.width = `${size}px`;
        face.canvas.style.height = `${size}px`;
        // Scale so the face + bezel ring fills the canvas exactly.
        // totalDiameter = faceWidth + 2 * bezelThickness (0 if no bezel).
        const bezel = face.watch.bezelColor ? BEZEL_THICKNESS_XML : 0;
        const totalDiameter = face.watch.faceWidth + 2 * bezel;
        face.sizePx = size;
        face.scale = physPx / totalDiameter;
    }

    // --- Build (or rebuild) the StaticCache for a face ---
    function buildCache(face: FaceInstance) {
        if (!face.enabled || face.sizePx === 0) return;
        const { canvas, watch, env, images, scale } = face;
        // Expand terminator parts into leaf states
        face.terminatorLeaves = [];
        for (const part of watch.parts) {
            if (part.type === 'Terminator') {
                face.terminatorLeaves.push(...expandTerminatorToLeaves(part, env));
            }
        }
        // Update leaf angles before building the cache
        if (face.terminatorLeaves.length > 0) {
            updateLeafAngles(face.terminatorLeaves, face.env);
        }
        face.staticCache = buildStaticCache(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
        face.handStates = initHandStates(watch, env, performance.now());
    }

    // --- Sequential (microtask-queue) cache build for all faces ---
    function buildAllCachesSequentially(facesToBuild: FaceInstance[], onDone: () => void) {
        let idx = 0;
        function buildNext() {
            if (idx >= facesToBuild.length) { onDone(); return; }
            buildCache(facesToBuild[idx++]);
            // Yield to let the browser paint before building the next face
            setTimeout(buildNext, 0);
        }
        buildNext();
    }

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

        for (const face of faces) {
            if (!face.enabled || !face.staticCache) continue;
            tickAnimations(face.handStates, face.env, now);
            // Update terminator leaves and rebuild cache if angles changed
            if (face.terminatorLeaves.length > 0) {
                const prevAngles = face.terminatorLeaves.map(l => l.currentAngle + l.currentRotation);
                updateLeafAngles(face.terminatorLeaves, face.env);
                const changed = face.terminatorLeaves.some((l, i) =>
                    l.currentAngle + l.currentRotation !== prevAngles[i]
                );
                if (changed) {
                    face.staticCache = buildStaticCache(
                        face.watch, face.env, face.canvas.width, face.canvas.height,
                        face.scale, face.images, face.terminatorLeaves
                    );
                }
            }
            renderFrame(face.ctx, face.staticCache, face.watch, face.env, face.scale);
            if (anyAnimating(face.handStates)) stillAnimating = true;
        }

        if (stillAnimating) {
            rafId = requestAnimationFrame(frame);
        } else {
            armIdle();
        }
    }

    function armIdle() {
        if (idleTimerId !== null) return;
        // Find the nearest next update across all faces
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
        const size = cellSize(W, H, cols, rows, GAP_PX, PADDING_PX);
        if (size <= 0) return;

        // Check if the size actually changed meaningfully (>1 device px)
        const dpr = window.devicePixelRatio || 1;
        const newPhys = Math.round(size * dpr);
        if (newPhys === faces[0]?.canvas.width) return;  // no change

        stopScheduler();

        // Resize all canvases immediately (shows at new size on next paint)
        for (const face of faces) {
            applySize(face, size);
            // Invalidate old static cache while we rebuild
            face.staticCache = null;
        }

        // Rebuild all static caches one by one, then restart scheduler
        buildAllCachesSequentially(faces.filter(f => f.enabled), startScheduler);
    }

    const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
        // Debounce: wait 150ms of quiet before rebuilding (avoids rebuilding on every pixel)
        if (resizeDebounceTimer !== null) clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
            resizeDebounceTimer = null;
            onGridResize(width, height);
        }, 150);
    });
    resizeObserver.observe(grid);

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
            // Re-parse to clear dynamicState
            const freshWatch = parseWatchXML(FACE_XMLS[faces.indexOf(face)], 'front');
            face.watch.parts = freshWatch.parts;
            face.watch.initExprs = freshWatch.initExprs;
            face.env = createWatchEnvironment(face.watch, newLat, newLon);
            face.staticCache = null;
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
    // Initial build — the ResizeObserver fires once synchronously after observe,
    // which triggers onGridResize → buildAllCachesSequentially → startScheduler.
    // If for some reason it doesn't fire, kick off manually.
    // =========================================================================
    const initialRect = grid.getBoundingClientRect();
    if (initialRect.width > 0 && initialRect.height > 0) {
        onGridResize(initialRect.width, initialRect.height);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(console.error));
} else {
    main().catch(console.error);
}
