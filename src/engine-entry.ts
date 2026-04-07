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
// ============================================================================

function gridDimensions(count: number): { cols: number; rows: number } {
    if (count <= 0) return { cols: 1, rows: 1 };
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    return { cols, rows };
}

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
        face.handStates = initHandStates(watch, env, performance.now());
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
            renderFrame(face.ctx, face.watch, face.env, face.scale, face.terminatorLeaves);
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

        const dpr = window.devicePixelRatio || 1;
        const newPhys = Math.round(size * dpr);
        if (newPhys === faces[0]?.canvas.width) return;

        stopScheduler();

        for (const face of faces) {
            applySize(face, size);
            face.cachesBuilt = false;
        }

        buildAllCachesSequentially(faces.filter(f => f.enabled), startScheduler);
    }

    const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const { width, height } = entry.contentRect;
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
            const fd = faceDataArray[face.faceDataIndex];
            const freshWatch = parseWatchXML(fd.xml, 'front');
            face.watch.parts = freshWatch.parts;
            face.watch.initExprs = freshWatch.initExprs;
            face.env = createWatchEnvironment(face.watch, newLat, newLon);
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
