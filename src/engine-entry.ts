

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
import { createWatchEnvironment, computeTzDeltaMs, GAIA_SUBDIAL_DEFAULTS } from './watch/watch-env.js';
import type { TerraSlot } from './watch/watch-env.js';
import { TERRA_RING_DEFAULTS } from './watch/watch-env.js';
import { validSlotsForTz, formatSlotOffset, getStandardOffsetMinutes, olsonIdToCityName } from './watch/terra-slots.js';
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
import { readUrlState, writeUrlState, initNavigationLinks, updateNavigationLinks } from './url-state.js';
import { loadCityData, searchCities, findClosestCity, isCityDataLoaded, loadError } from './city-search.js';
import type { CityResult } from './city-search.js';
import { renderGlobe, loadOSMTile } from './mini-map.js';
import { resolveTimezone } from './tz-resolve.js';

// ============================================================================
// Location helpers
// ============================================================================

const DEMO_LAT = 37.3349;   // Apple Park, Cupertino
const DEMO_LON = -122.0090;

type GeoResult =
    | { status: 'success'; lat: number; lon: number }
    | { status: 'denied' }
    | { status: 'timeout' }
    | { status: 'unavailable' };

/**
 * Request the device location via the browser geolocation API.
 * @param timeoutMs  If provided, give up after this many ms (TIMEOUT).
 *                   If omitted, wait indefinitely for user response.
 */
function requestBrowserLocation(timeoutMs?: number): Promise<GeoResult> {
    if (!navigator.geolocation) return Promise.resolve({ status: 'unavailable' });
    return new Promise((resolve) => {
        const options: PositionOptions = {};
        if (timeoutMs != null) options.timeout = timeoutMs;
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ status: 'success', lat: pos.coords.latitude, lon: pos.coords.longitude }),
            (err) => {
                if (err.code === err.PERMISSION_DENIED) resolve({ status: 'denied' });
                else if (err.code === err.TIMEOUT) resolve({ status: 'timeout' });
                else resolve({ status: 'unavailable' });
            },
            options,
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
    /** Per-face slot overrides for Terra/Gaia world-clock faces. */
    terraSlotOverrides?: Record<number, TerraSlot>;
    /** For worldTimeRing faces: which ring slot holds the global location (1–24). */
    globalLocationSlot?: number;
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
    const locationTzLabel = document.getElementById('location-tz')!;
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
    const lpLocationTz = document.getElementById('lp-location-tz')!;
    const lpOsmAttribution = document.getElementById('lp-osm-attribution')!;
    const lpDoneBtn = document.getElementById('lp-done')!;
    const lpDialogFooter = lpDoneBtn.parentElement!;

    // Initialize link preservation
    initNavigationLinks();

    // Preload city database in the background so it's ready when the user
    // opens the location dialog. Once loaded, update the location display
    // to show the nearest city name for browser/manual locations.
    loadCityData().then(() => {
        updateLocationDisplay();
        // Update Gaia-style observer slot names now that city data is available
        for (const face of faces) {
            if (face.watch.worldTimeSubdials && face.terraSlotOverrides?.[1]?.cityName === 'Observer') {
                const closest = findClosestCity(lat, lon);
                if (closest) {
                    face.terraSlotOverrides[1].cityName = closest.shortLabel;
                }
            }
            // Update Terra global-location slot city name if it fell back to Olson
            if (face.watch.worldTimeRing && face.globalLocationSlot !== undefined) {
                const glSlot = face.terraSlotOverrides?.[face.globalLocationSlot];
                if (glSlot && !locationSource && (lat !== 0 || lon !== 0)) {
                    const closest = findClosestCity(lat, lon);
                    if (closest) {
                        glSlot.cityName = closest.shortLabel;
                    }
                }
            }
        }
    }).catch(() => {});

    // --- Resolve location ---
    const urlState = readUrlState();
    let lat: number, lon: number;
    let locationSource = '';
    let locationFullLabel = '';  // Full "City, State, Country" for dialog display
    // Track how the location was obtained for display purposes
    let locationSourceType: 'url-city' | 'browser' | 'manual' | 'none' = 'none';
    let needsPrompt = false;
    // Resolved IANA timezone for the current location (e.g. "America/Los_Angeles")
    let locationTimezone: string | undefined = urlState.tz || undefined;
    let tzDeltaMs = computeTzDeltaMs(locationTimezone);
    // Track whether browser geolocation is available
    // 'granted' = we got a position, 'denied' = user rejected or unavailable, 'unknown' = never tried
    let geoPermission: 'granted' | 'denied' | 'unknown' = 'unknown';

    if (urlState.lat !== null && urlState.lon !== null) {
        lat = urlState.lat;
        lon = urlState.lon;
        locationSource = urlState.city || '';
        locationSourceType = urlState.city ? 'url-city' : 'manual';
        // If no tz in URL (old link), resolve it now
        if (!locationTimezone) {
            locationTimezone = resolveTimezone(lat, lon, null);
            tzDeltaMs = computeTzDeltaMs(locationTimezone);
            writeUrlState({ tz: locationTimezone });
        }
        // We haven't tried geolocation — check the Permissions API if available
        if (navigator.permissions) {
            try {
                const status = await navigator.permissions.query({ name: 'geolocation' });
                geoPermission = status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown';
            } catch { /* ignore — not all browsers support this */ }
        }
    } else if (urlState.bloc) {
        // bloc=1 set — ask browser for location with 10s timeout
        const result = await requestBrowserLocation(10000);
        if (result.status === 'success') {
            lat = result.lat; lon = result.lon;
            locationSource = '';
            locationSourceType = 'browser';
            geoPermission = 'granted';
            locationTimezone = resolveTimezone(lat, lon, null);
            tzDeltaMs = computeTzDeltaMs(locationTimezone);
        } else if (result.status === 'denied') {
            // User explicitly denied — show prompt with button disabled
            lat = 0; lon = 0;
            locationSource = '';
            locationSourceType = 'none';
            needsPrompt = true;
            geoPermission = 'denied';
        } else {
            // Timeout or unavailable — show prompt as if user opened it
            // (browser button stays enabled so they can try again)
            lat = 0; lon = 0;
            locationSource = '';
            locationSourceType = 'none';
            needsPrompt = true;
            geoPermission = 'unknown';
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
        // Show city name or "X mi DIR of CityName" for all source types
        if (locationSource) {
            // User picked a city from search — use the short label directly
            sourceLabel.textContent = locationSource;
        } else if (isCityDataLoaded() && (lat !== 0 || lon !== 0)) {
            // Manual or browser location — find closest city and describe
            const closest = findClosestCity(lat, lon);
            if (closest) {
                const distKm = haversineKm(lat, lon, closest.lat, closest.lon);
                const THRESHOLD_KM = 16; // ~10 miles
                if (distKm > THRESHOLD_KM) {
                    const dir = compassBearing(closest.lat, closest.lon, lat, lon);
                    if (useImperial()) {
                        sourceLabel.textContent = `${Math.round(distKm * 0.621371)}\u00a0mi ${dir} of ${closest.shortLabel}`;
                    } else {
                        sourceLabel.textContent = `${Math.round(distKm)}\u00a0km ${dir} of ${closest.shortLabel}`;
                    }
                } else {
                    sourceLabel.textContent = closest.shortLabel;
                }
            } else {
                sourceLabel.textContent = '';
            }
        } else {
            sourceLabel.textContent = '';
        }
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

    // --- Per-face slot overrides helper ---
    // Builds slot overrides based on watch feature flags:
    // - worldTimeRing: reads r1..r24 from URL, then injects the global
    //   location into the best matching slot (placed at top of dial).
    // - worldTimeSubdials: reads d2..dN from URL, slot 1 = observer (Gaia-style)
    // Other faces get no overrides.
    // URL prefixes: 'r' = ring, 'd' = dial/subdial (avoids collision).
    interface SlotOverrideResult {
        overrides: Record<number, TerraSlot>;
        globalLocationSlot?: number;
    }
    function buildSlotOverrides(watch: Watch): SlotOverrideResult | undefined {
        const params = new URLSearchParams(window.location.search);
        if (watch.worldTimeRing) {
            // Collect user overrides from URL
            const userOverrides: Record<number, TerraSlot> = {};
            for (let slot = 1; slot <= 24; slot++) {
                const name = params.get(`r${slot}`);
                const tz = params.get(`r${slot}tz`);
                const latStr = params.get(`r${slot}lat`);
                const lonStr = params.get(`r${slot}lon`);
                if (name && tz) {
                    userOverrides[slot] = {
                        cityName: name,
                        olsonId: tz,
                        lat: latStr ? parseFloat(latStr) : 0,
                        lon: lonStr ? parseFloat(lonStr) : 0,
                    };
                }
            }

            // Start with user overrides
            const overrides: Record<number, TerraSlot> = { ...userOverrides };

            // Determine which slot to use for the global location
            let globalSlot: number | undefined;
            if (locationTimezone && (lat !== 0 || lon !== 0)) {
                const validSlots = validSlotsForTz(locationTimezone);
                if (validSlots.length === 1) {
                    globalSlot = validSlots[0];
                } else if (validSlots.length > 1) {
                    // Tie-break: prefer the slot NOT overridden by the user
                    const nonOverridden = validSlots.filter(s => !(s in userOverrides));
                    const overridden = validSlots.filter(s => s in userOverrides);
                    if (nonOverridden.length >= 1 && overridden.length >= 1) {
                        // Only one is non-overridden → pick it
                        globalSlot = nonOverridden[0];
                    } else {
                        // Neither or both overridden → pick by standard-time match
                        const globalStdOff = getStandardOffsetMinutes(locationTimezone);
                        let bestSlot = validSlots[0];
                        let bestDiff = Infinity;
                        for (const s of validSlots) {
                            const slotCity = userOverrides[s] || TERRA_RING_DEFAULTS[s];
                            if (!slotCity) continue;
                            const slotStdOff = getStandardOffsetMinutes(slotCity.olsonId);
                            const diff = Math.abs(slotStdOff - globalStdOff);
                            if (diff < bestDiff) {
                                bestDiff = diff;
                                bestSlot = s;
                            }
                        }
                        globalSlot = bestSlot;
                    }
                } else if (validSlots.length === 0) {
                    // Shouldn't happen for real timezones — fall back to offset match
                    console.warn(`[Terra] No valid slot for timezone ${locationTimezone}`);
                }

                // Inject the global location into the chosen slot
                if (globalSlot !== undefined) {
                    let cityName = locationSource;
                    if (!cityName && isCityDataLoaded() && (lat !== 0 || lon !== 0)) {
                        const closest = findClosestCity(lat, lon);
                        if (closest) cityName = closest.shortLabel;
                    }
                    if (!cityName && locationTimezone) {
                        cityName = olsonIdToCityName(locationTimezone);
                    }
                    overrides[globalSlot] = {
                        cityName: cityName || 'Local',
                        olsonId: locationTimezone,
                        lat, lon,
                    };
                }
            }

            return {
                overrides: Object.keys(overrides).length > 0 ? overrides : {},
                globalLocationSlot: globalSlot,
            };
        }
        if (watch.worldTimeSubdials) {
            const nSubdials = watch.maxSeparateLoc || 4;
            const overrides: Record<number, TerraSlot> = {};
            // Slot 1 = observer location — use city name from URL or closest city
            let observerName = locationSource;
            if (!observerName && isCityDataLoaded() && (lat !== 0 || lon !== 0)) {
                const closest = findClosestCity(lat, lon);
                if (closest) observerName = closest.shortLabel;
            }
            overrides[1] = {
                cityName: observerName || 'Observer',
                olsonId: locationTimezone,
                lat, lon,
            };
            // Slots 2–N: URL overrides or defaults
            for (let slot = 2; slot <= nSubdials; slot++) {
                const name = params.get(`d${slot}`);
                const tz = params.get(`d${slot}tz`);
                const latStr = params.get(`d${slot}lat`);
                const lonStr = params.get(`d${slot}lon`);
                if (name && tz) {
                    overrides[slot] = {
                        cityName: name,
                        olsonId: tz,
                        lat: latStr ? parseFloat(latStr) : 0,
                        lon: lonStr ? parseFloat(lonStr) : 0,
                    };
                } else {
                    const def = GAIA_SUBDIAL_DEFAULTS[slot];
                    if (def) overrides[slot] = { ...def };
                }
            }
            return { overrides };
        }
        return undefined;
    }

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
        const slotResult = buildSlotOverrides(watch);
        const faceOverrides = slotResult?.overrides;
        const env = createWatchEnvironment(watch, lat, lon, getNow, locationTimezone, faceOverrides, slotResult?.globalLocationSlot);

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
            terraSlotOverrides: faceOverrides,
            globalLocationSlot: slotResult?.globalLocationSlot,
        };
        faces.push(face);
    }

    // On multi-face pages (all.html), make each face clickable → navigate to its page
    const isMultiFace = faceDataArray.length > 1;
    if (isMultiFace) {
        // Hide the all-faces grid icon on the all-faces page itself
        document.body.classList.add('is-all-faces');
        /** Convert a face name like "Mauna Kea" or "Haleakalā" to a filename like "mauna-kea" */
        function faceNameToSlug(name: string): string {
            return name
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip diacritics
                .toLowerCase()
                .replace(/\s+/g, '-');
        }

        for (let i = 0; i < faces.length; i++) {
            const face = faces[i];
            const slug = faceNameToSlug(faceDataArray[i].name);
            face.canvas.style.cursor = 'pointer';
            face.canvas.addEventListener('click', () => {
                // Preserve location/time state in the URL
                const params = new URLSearchParams(window.location.search);
                window.location.href = `${slug}.html${params.toString() ? '?' + params.toString() : ''}`;
            });
        }
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
            face.env = createWatchEnvironment(face.watch, lat, lon, getNow, locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
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

            // Gaia: draw city name labels and 24-hour numbers on each subdial
            if (face.watch.worldTimeSubdials && face.terraSlotOverrides) {
                const ctx2d = face.ctx;
                const fw = face.env.variables.get('faceWidth') || 278;
                ctx2d.save();
                // Transform to watch coordinates: center of canvas, scale
                ctx2d.translate(face.canvas.width / 2, face.canvas.height / 2);
                const pxPerUnit = face.canvas.width / (fw + 2 * BEZEL_THICKNESS_XML);
                ctx2d.scale(pxPerUnit, pxPerUnit);

                // Subdial positions, label radii, and 24-hour number radii
                // labelR: city name arc radius; numR: 24-hour number radius; numFS: number font size
                const subdials = [
                    { slot: 1, x: -58.5, y: 0, labelR: 82.5, fs: 12.5, numR: 72, numFS: 9, sp: 0 },   // local (W)
                    { slot: 2, x: 32.19, y: 77.716, labelR: 54.5, fs: 11, numR: 45, numFS: 7, sp: 1 },  // s1 (N)
                    { slot: 3, x: 84.12, y: 0, labelR: 54.5, fs: 11, numR: 45, numFS: 7, sp: 2 },       // s2 (E)
                    { slot: 4, x: 32.19, y: -77.72, labelR: 54.5, fs: 11, numR: 45, numFS: 7, sp: 3 },  // s3 (S)
                ];

                for (const sd of subdials) {
                    const slotData = face.terraSlotOverrides[sd.slot];
                    if (!slotData) continue;
                    const text = slotData.cityName;

                    ctx2d.save();
                    // Move to subdial center (Y-flip: negate y)
                    ctx2d.translate(sd.x, -sd.y);

                    // --- City name (curved along bottom arc) ---
                    ctx2d.fillStyle = 'black';
                    ctx2d.font = `${sd.fs}px Arial`;
                    ctx2d.textAlign = 'center';
                    ctx2d.textBaseline = 'alphabetic';

                    const radius = sd.labelR;
                    const charWidths: number[] = [];
                    let totalWidth = 0;
                    for (let i = 0; i < text.length; i++) {
                        const w = ctx2d.measureText(text[i]).width;
                        charWidths.push(w);
                        totalWidth += w;
                    }
                    const cityTotalAngle = totalWidth / radius;
                    // Bottom half: chars flip π, step counter-clockwise
                    let currentAngle = Math.PI + cityTotalAngle / 2;
                    for (let i = 0; i < text.length; i++) {
                        const charAngle = charWidths[i] / radius;
                        const midAngle = currentAngle - charAngle / 2;
                        ctx2d.save();
                        ctx2d.rotate(midAngle);
                        ctx2d.translate(0, -radius + sd.fs / 2);
                        ctx2d.rotate(Math.PI);  // flip for bottom-half readability
                        ctx2d.fillText(text[i], 0, 0);
                        ctx2d.restore();
                        currentAngle -= charAngle;
                    }

                    // --- 24-hour markers (numbers + dots, matching iOS specialSubdial) ---
                    const cityExclusionHalf = cityTotalAngle / 2 + 10 / radius;

                    // Hardcoded inter-dial occlusion skips (from iOS specialParameter)
                    // sp=0: local/W, sp=1: N, sp=2: E, sp=3: S
                    const skipSet = new Set<number>(
                        sd.sp === 0 ? [15, 16] :
                        sd.sp === 2 ? [9, 10, 11] :
                        sd.sp === 3 ? [8, 9, 10, 13, 14, 15] :
                        []  // sp=1 (N): no skips
                    );

                    ctx2d.font = `${sd.numFS}px Arial`;
                    ctx2d.textAlign = 'center';
                    ctx2d.textBaseline = 'middle';

                    for (let i = 1; i < 24; i++) {
                        // Hardcoded inter-dial skip
                        if (skipSet.has(i)) continue;

                        // iOS angle: pointAngle = π * (18 - i) / 12
                        const pointAngle = Math.PI * (18 - i) / 12;

                        // City text exclusion: angular distance from bottom (hour 0)
                        const angularDistFromBottom = (i < 12 ? i : (24 - i)) * Math.PI / 12;
                        if (angularDistFromBottom <= cityExclusionHalf) continue;

                        if (i % 2 === 1) {
                            // Odd hours: small dot (half-alpha)
                            const dotX = sd.numR * Math.cos(pointAngle);
                            const dotY = -sd.numR * Math.sin(pointAngle); // canvas Y-flip
                            ctx2d.save();
                            ctx2d.globalAlpha = 0.5;
                            ctx2d.beginPath();
                            ctx2d.arc(dotX, dotY, 0.5, 0, 2 * Math.PI);
                            ctx2d.fill();
                            ctx2d.restore();
                        } else {
                            // Even hours: upright number
                            const numX = sd.numR * Math.cos(pointAngle);
                            const numY = -sd.numR * Math.sin(pointAngle); // canvas Y-flip
                            ctx2d.fillText(i.toString(), numX, numY);
                        }
                    }

                    ctx2d.restore();
                }

                ctx2d.restore();
            }
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
        const changeCitiesBtnEl = document.getElementById('change-cities-btn');
        const panelH = locationPanel ? locationPanel.offsetHeight : 0;
        const timeBarH = timeBarEl ? timeBarEl.offsetHeight : 0;
        const planetSelH = planetSelectorEl ? planetSelectorEl.offsetHeight : 0;
        const changeCitiesH = changeCitiesBtnEl ? changeCitiesBtnEl.offsetHeight : 0;
        const height = entry.contentRect.height - panelH - timeBarH - planetSelH - changeCitiesH;
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
        lat = newLat;
        lon = newLon;
        for (const face of faces) {
            if (!face.enabled) continue;
            // Re-run slot overrides for Terra (worldTimeRing) faces — the global
            // location slot may change when the user changes their location.
            if (face.watch.worldTimeRing) {
                const slotResult = buildSlotOverrides(face.watch);
                face.terraSlotOverrides = slotResult?.overrides;
                face.globalLocationSlot = slotResult?.globalLocationSlot;
            }
            // Update Gaia slot 1 to match new observer location
            if (face.watch.worldTimeSubdials && face.terraSlotOverrides) {
                let obsName = locationSource;
                if (!obsName && isCityDataLoaded() && (newLat !== 0 || newLon !== 0)) {
                    const closest = findClosestCity(newLat, newLon);
                    if (closest) obsName = closest.shortLabel;
                }
                face.terraSlotOverrides[1] = {
                    cityName: obsName || 'Observer',
                    olsonId: locationTimezone,
                    lat: newLat, lon: newLon,
                };
            }
            // Fresh environment with new lat/lon/tz — same watch/parts
            face.env = createWatchEnvironment(face.watch, newLat, newLon, getNow, locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
            // Update terminator leaves (preserve for animation interpolation)
            if (face.terminatorLeaves.length > 0) {
                updateLeafAngles(face.terminatorLeaves, face.env);
                resetLeafSchedules(face.terminatorLeaves);
                face.lastTerminatorRebuild = 0;
            }
            // Rebuild static caches (day/night rings, sunrise marks, etc.)
            const { canvas, watch, env, images, scale } = face;
            buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
            // Reset hand schedules so they re-evaluate immediately and animate to new targets
            for (const hs of face.handStates) {
                hs.nextUpdateTime = 0;
            }
        }
        updateLocationDisplay();
        updateTimezoneDisplay();
        // The location panel may have changed height (e.g. city name now shown).
        // The ResizeObserver watches #app (viewport-sized) so it won't fire.
        // Defer a manual resize recalc so the face size accounts for the new panel height.
        requestAnimationFrame(() => {
            const appEl = grid.parentElement!;
            const W = appEl.clientWidth;
            const totalH = appEl.clientHeight;
            const locPanelH = document.getElementById('location-panel')?.offsetHeight ?? 0;
            const tbH = document.getElementById('time-bar')?.offsetHeight ?? 0;
            const psH = document.getElementById('planet-selector')?.offsetHeight ?? 0;
            const ccH = document.getElementById('change-cities-btn')?.offsetHeight ?? 0;
            onGridResize(W, totalH - locPanelH - tbH - psH - ccH);
        });
        // Kick the scheduler to start animating immediately
        stopScheduler();
        startScheduler();
    }
    // Capture the browser button's label from the HTML (single source of truth)
    const browserBtnLabel = (lpUseBrowser as HTMLButtonElement).textContent || 'Use device location via browser';

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
            btn.textContent = browserBtnLabel + ' (unavailable)';
        } else {
            btn.disabled = false;
            delete btn.dataset.tooltip;
            btn.textContent = browserBtnLabel;
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
    /**
     * Detect whether the browser locale prefers miles (US, UK, Myanmar, Liberia)
     * or kilometers (everyone else).
     */
    function useImperial(): boolean {
        const locale = navigator.language || 'en-US';
        const region = locale.split('-')[1]?.toUpperCase() || '';
        // US, UK (road signs in miles), Myanmar, Liberia
        return ['US', 'GB', 'MM', 'LR'].includes(region);
    }

    /**
     * Compute great-circle distance in km using the Haversine formula.
     */
    function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371; // Earth radius in km
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const a = Math.sin(dLat / 2) ** 2 +
                  Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                  Math.sin(dLon / 2) ** 2;
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    /**
     * Compute initial bearing from point 1 to point 2, returned as a
     * 16-point compass direction (N, NNE, NE, ENE, E, ...).
     */
    function compassBearing(lat1: number, lon1: number, lat2: number, lon2: number): string {
        const toRad = Math.PI / 180;
        const dLon = (lon2 - lon1) * toRad;
        const y = Math.sin(dLon) * Math.cos(lat2 * toRad);
        const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
                  Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLon);
        let bearing = Math.atan2(y, x) * 180 / Math.PI;
        bearing = (bearing + 360) % 360;

        const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                      'S','SSW','SW','WSW','W','WNW','NW','NNW'];
        return dirs[Math.round(bearing / 22.5) % 16];
    }

    function buildLocationNameHTML(): string {
        if (locationSourceType === 'url-city' && locationFullLabel) {
            return `${locationFullLabel} <span class="lp-loc-source">(from cities database)</span>`;
        }
        // For browser or manual, find closest city
        if (locationSourceType === 'browser' || locationSourceType === 'manual') {
            const closest = findClosestCity(lat, lon);
            const sourceLabel = locationSourceType === 'browser' ? '(from browser)' : '(manually entered)';
            if (closest) {
                const distKm = haversineKm(lat, lon, closest.lat, closest.lon);
                const THRESHOLD_KM = 16; // ~10 miles
                if (distKm > THRESHOLD_KM) {
                    // "253 mi NNE of Princeville, HA, US (manually entered)"
                    const dir = compassBearing(closest.lat, closest.lon, lat, lon);
                    let distStr: string;
                    if (useImperial()) {
                        const mi = Math.round(distKm * 0.621371);
                        distStr = `${mi}\u00a0mi`;
                    } else {
                        distStr = `${Math.round(distKm)}\u00a0km`;
                    }
                    return `${distStr} ${dir} of ${closest.label} <span class="lp-loc-source">${sourceLabel}</span>`;
                }
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
    function applyLocation(newLat: number, newLon: number, source: string, fullLabel: string, sourceType: typeof locationSourceType, writeToUrl: boolean, cityTz: string | null = null) {
        locationSource = source;
        locationFullLabel = fullLabel;
        locationSourceType = sourceType;
        // Resolve timezone for this location
        locationTimezone = resolveTimezone(newLat, newLon, cityTz);
        tzDeltaMs = computeTzDeltaMs(locationTimezone);
        rebuildAllForLocation(newLat, newLon);
        if (writeToUrl) {
            writeUrlState({ lat: newLat, lon: newLon, city: source || null, tz: locationTimezone || null });
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
        const result = await requestBrowserLocation();  // no timeout — wait indefinitely
        if (result.status === 'success') {
            lpUseBrowser.textContent = browserBtnLabel;
            applyLocation(result.lat, result.lon, '', '', 'browser', false, null);
            // Write bloc=1 and clear lat/lon/city so next reload asks browser again
            writeUrlState({ bloc: true, lat: null, lon: null, city: null });
        } else if (result.status === 'denied') {
            // User denied — disable the button
            geoPermission = 'denied';
            const btn = lpUseBrowser as HTMLButtonElement;
            btn.disabled = true;
            btn.textContent = browserBtnLabel + ' (unavailable)';
            const isFileUrl = window.location.protocol === 'file:';
            btn.dataset.tooltip = isFileUrl
                ? 'Not all browsers support location access from file:// URLs'
                : 'Browser location was not granted — check your browser settings to allow it';
        } else {
            lpUseBrowser.textContent = browserBtnLabel;
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

    // Close any open modal dialog with Escape key (topmost first)
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;

        // 1. Reset confirm overlay (inside city dialog)
        const confirmOverlay = document.getElementById('tc-confirm-overlay');
        if (confirmOverlay && confirmOverlay.style.display !== 'none') {
            confirmOverlay.style.display = 'none';
            return;
        }

        // 2. Terra/Gaia city dialog
        const tcDialog = document.getElementById('terra-city-dialog');
        if (tcDialog && tcDialog.style.display !== 'none') {
            tcDialog.style.display = 'none';
            grid.classList.remove('blurred');
            return;
        }

        // 3. Info overlay
        if (infoOverlay && infoOverlay.classList.contains('visible')) {
            infoOverlay.classList.remove('visible');
            return;
        }

        // 4. Time popover
        if (popoverOpen) {
            hidePopover();
            return;
        }

        // 5. Location prompt
        if (locationPrompt.style.display !== 'none') {
            if (!needsPrompt || (lat !== 0 || lon !== 0)) {
                dismissLocationPrompt();
            }
            return;
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
                applyLocation(r.lat, r.lon, r.shortLabel, r.label, 'url-city', true, r.timezone);
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

    /** Format the current timezone for display in the time bar.
     *  Output: "America/Los_Angeles\u00a0(PDT)\u00a0UTC-7:00" with non-breaking spaces. */
    function formatTimezoneDisplay(olsonId: string | undefined): string {
        if (!olsonId) return '';
        try {
            const now = new Date();
            // Get short abbreviation like "PDT", "EST"
            const shortFmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                timeZoneName: 'short',
            });
            const shortParts = shortFmt.formatToParts(now);
            const abbr = shortParts.find(p => p.type === 'timeZoneName')?.value || '';

            // Get UTC offset like "GMT-07:00"
            const longFmt = new Intl.DateTimeFormat('en-US', {
                timeZone: olsonId,
                timeZoneName: 'longOffset',
            });
            const longParts = longFmt.formatToParts(now);
            const offsetStr = longParts.find(p => p.type === 'timeZoneName')?.value || '';
            // Convert "GMT-07:00" to "UTC-7:00", "GMT+05:30" to "UTC+5:30", "GMT" to "UTC"
            let utcStr = offsetStr.replace('GMT', 'UTC');
            // Remove leading zero: UTC-07:00 → UTC-7:00, UTC+05:30 → UTC+5:30
            utcStr = utcStr.replace(/([+-])0(\d)/, '$1$2');

            // Use non-breaking spaces within to prevent internal wrapping
            // but the span itself allows line wrap before it
            return `${olsonId}\u00a0(${abbr})\u00a0${utcStr}`;
        } catch {
            return olsonId;
        }
    }

    function updateTimezoneDisplay() {
        const formatted = formatTimezoneDisplay(locationTimezone);
        locationTzLabel.innerHTML = formatted;
        lpLocationTz.innerHTML = formatted;
    }
    updateTimezoneDisplay();

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

    /** Shift a Date to the target timezone for display purposes. */
    function toTzDate(d: Date): Date {
        return tzDeltaMs !== 0 ? new Date(d.getTime() + tzDeltaMs) : d;
    }

    /** Convert a Date entered in target-timezone values back to a real UTC instant. */
    function fromTzDate(d: Date): Date {
        return tzDeltaMs !== 0 ? new Date(d.getTime() - tzDeltaMs) : d;
    }

    function formatSimTime(d: Date): string {
        const td = toTzDate(d);
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const mo = months[td.getMonth()];
        const day = td.getDate();
        const yr = td.getFullYear();
        const h = td.getHours().toString().padStart(2, '0');
        const m = td.getMinutes().toString().padStart(2, '0');
        const s = td.getSeconds().toString().padStart(2, '0');
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
        const tzSim = toTzDate(sim);
        (document.getElementById('tp-year') as HTMLInputElement).value = tzSim.getFullYear().toString();
        (document.getElementById('tp-month') as HTMLInputElement).value = (tzSim.getMonth() + 1).toString();
        (document.getElementById('tp-day') as HTMLInputElement).value = tzSim.getDate().toString();
        (document.getElementById('tp-hour') as HTMLInputElement).value = tzSim.getHours().toString();
        (document.getElementById('tp-minute') as HTMLInputElement).value = tzSim.getMinutes().toString();
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
            // One-shot: re-evaluate all hands with natural speed animation
            // (null tickIntervalMs = no compression, unlike continuous scrub)
            timeController.beginFrame();
            const stepNow = performance.now();
            for (const face of faces) {
                if (!face.enabled || !face.cachesBuilt) continue;
                resetHandSchedules(face.handStates);
                resetLeafSchedules(face.terminatorLeaves);
                tickAnimations(face.handStates, face.env, stepNow, null, 0);
                tickLeafAnimations(face.terminatorLeaves, face.env, stepNow, null, 0);
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
            // One-shot: re-evaluate all hands with natural speed animation
            // (null tickIntervalMs = no compression, unlike continuous scrub)
            timeController.beginFrame();
            const stepNow = performance.now();
            for (const face of faces) {
                if (!face.enabled || !face.cachesBuilt) continue;
                resetHandSchedules(face.handStates);
                resetLeafSchedules(face.terminatorLeaves);
                tickAnimations(face.handStates, face.env, stepNow, null, 0);
                tickLeafAnimations(face.terminatorLeaves, face.env, stepNow, null, 0);
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
        const d = fromTzDate(new Date(yr, mo, dy, hr, mn, 0, 0));
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
            const d = fromTzDate(new Date(yr, mo, dy, hr, mn, 0, 0));
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

    // --- Info button & popup ---
    const infoBtn = document.getElementById('info-btn');
    const infoOverlay = document.getElementById('info-overlay');
    const infoClose = document.getElementById('info-close');
    const helpContent = document.getElementById('help-content');
    const helpTemplate = document.getElementById('help-template') as HTMLTemplateElement | null;
    let helpLoaded = false;
    if (infoBtn && infoOverlay && infoClose) {
        infoBtn.addEventListener('click', () => {
            infoOverlay.classList.add('visible');
            // Clone help template into DOM on first open
            // (images only start loading once cloned into the live DOM)
            if (!helpLoaded && helpContent && helpTemplate?.content) {
                helpLoaded = true;
                helpContent.appendChild(helpTemplate.content.cloneNode(true));
            }
        });
        infoClose.addEventListener('click', () => {
            infoOverlay.classList.remove('visible');
        });
        infoOverlay.addEventListener('click', (e) => {
            if (e.target === infoOverlay) {
                infoOverlay.classList.remove('visible');
            }
        });
    }


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
    // Planet selector (for faces with planetSelector flag)
    // =========================================================================
    const isSingleFace = faceDataArray.length === 1;
    const planetSelectorFace = faces.find(f => f.watch.planetSelector);

    if (planetSelectorFace && isSingleFace) {
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
                    face.env = createWatchEnvironment(face.watch, lat, lon, getNow, locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
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
    // Terra city customization (for faces with worldTimeRing flag, single-face mode)
    // =========================================================================
    const terraFace = faces.find(f => f.watch.worldTimeRing);
    if (terraFace && isSingleFace) {
        const tcDialog = document.getElementById('terra-city-dialog');
        const tcCityInput = document.getElementById('tc-city-input') as HTMLInputElement | null;
        const tcCityResults = document.getElementById('tc-city-results');
        const tcSlotPicker = document.getElementById('tc-slot-picker');
        const tcSlotChoices = document.getElementById('tc-slot-choices');
        const tcMessage = document.getElementById('tc-message');
        const tcNoSelection = document.getElementById('tc-no-selection');
        const tcSelectedCity = document.getElementById('tc-selected-city');
        const tcCityName = document.getElementById('tc-city-name');
        const tcCityTz = document.getElementById('tc-city-tz');
        const tcResetBtn = document.getElementById('tc-reset');
        const tcCancelBtn = document.getElementById('tc-cancel');
        const tcDoneBtn = document.getElementById('tc-done');

        if (tcDialog && tcCityInput && tcCityResults && tcSlotPicker &&
            tcSlotChoices && tcMessage && tcDoneBtn && tcResetBtn) {

            // Add "Change cities" button below the watch grid
            const changeCitiesBtn = document.createElement('button');
            changeCitiesBtn.className = 'change-cities-btn';
            changeCitiesBtn.textContent = 'Change cities';
            changeCitiesBtn.id = 'change-cities-btn';
            const timeBarEl = document.getElementById('time-bar');
            if (timeBarEl) {
                timeBarEl.parentElement!.insertBefore(changeCitiesBtn, timeBarEl);
            }

            /** Get current effective slot data (defaults + overrides) */
            function getCurrentSlots(): Record<number, TerraSlot> {
                const slots: Record<number, TerraSlot> = {};
                for (const [k, v] of Object.entries(TERRA_RING_DEFAULTS)) {
                    slots[Number(k)] = { ...v };
                }
                if (terraFace.terraSlotOverrides) {
                    for (const [k, v] of Object.entries(terraFace.terraSlotOverrides)) {
                        slots[Number(k)] = { ...v };
                    }
                }
                return slots;
            }

            /** Write slot overrides to URL */
            function writeTerraOverridesToUrl() {
                const params = new URLSearchParams(window.location.search);
                for (let slot = 1; slot <= 24; slot++) {
                    params.delete(`r${slot}`);
                    params.delete(`r${slot}tz`);
                    params.delete(`r${slot}lat`);
                    params.delete(`r${slot}lon`);
                }
                if (terraFace.terraSlotOverrides) {
                    for (const [slotStr, data] of Object.entries(terraFace.terraSlotOverrides)) {
                        params.set(`r${slotStr}`, data.cityName);
                        params.set(`r${slotStr}tz`, data.olsonId);
                        params.set(`r${slotStr}lat`, data.lat.toFixed(3));
                        params.set(`r${slotStr}lon`, data.lon.toFixed(3));
                    }
                }
                params.delete('long');
                params.delete('loc');
                const qs = params.toString();
                const newUrl = window.location.pathname + (qs ? '?' + qs : '');
                history.replaceState(null, '', newUrl);
                updateNavigationLinks();
            }

            /** Rebuild the Terra face after a slot change */
            function rebuildTerraForSlotChange() {
                // Re-run buildSlotOverrides to re-inject the global location
                // override on top of whatever the user just changed.
                const slotResult = buildSlotOverrides(terraFace.watch);
                if (slotResult) {
                    terraFace.terraSlotOverrides = slotResult.overrides;
                    terraFace.globalLocationSlot = slotResult.globalLocationSlot;
                }
                for (const face of faces) {
                    if (!face.enabled) continue;
                    face.env = createWatchEnvironment(face.watch, lat, lon, getNow, locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
                    if (face.terminatorLeaves.length > 0) {
                        updateLeafAngles(face.terminatorLeaves, face.env);
                        resetLeafSchedules(face.terminatorLeaves);
                        face.lastTerminatorRebuild = 0;
                    }
                    (face.env as any)._terraCityKnockout = null;
                    const { canvas, watch, env, images, scale } = face;
                    buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
                    for (const hs of face.handStates) {
                        hs.nextUpdateTime = 0;
                    }
                }
                stopScheduler();
                startScheduler();
            }

            /** Assign a city to a slot */
            function assignCityToSlot(slot: number, city: CityResult) {
                const currentSlots = getCurrentSlots();
                const previousCity = currentSlots[slot]?.cityName || 'Unknown';
                // Check if this is the global-location slot BEFORE rebuild changes it
                const isGlobalSlot = slot === terraFace.globalLocationSlot;
                if (!terraFace.terraSlotOverrides) {
                    terraFace.terraSlotOverrides = {};
                }
                terraFace.terraSlotOverrides[slot] = {
                    cityName: city.shortLabel,
                    olsonId: city.timezone,
                    lat: city.lat,
                    lon: city.lon,
                };
                writeTerraOverridesToUrl();
                rebuildTerraForSlotChange();
                if (isGlobalSlot) {
                    showTcMessage(`${city.shortLabel} saved for ${formatSlotOffset(slot)}, but your location may override this slot`, 'warn');
                } else {
                    showTcMessage(`${city.shortLabel} replaces ${previousCity} (${formatSlotOffset(slot)})`, 'info');
                }
            }

            function showTcMessage(text: string, type: 'info' | 'warn' | 'error') {
                tcMessage!.textContent = text;
                tcMessage!.className = `tc-message tc-message-${type}`;
                tcMessage!.style.display = '';
            }

            function hideTcMessage() {
                tcMessage!.style.display = 'none';
            }

            function showCityStatus(city: CityResult) {
                if (tcNoSelection) tcNoSelection.style.display = 'none';
                if (tcSelectedCity) tcSelectedCity.style.display = '';
                if (tcCityName) tcCityName.textContent = city.shortLabel;
                if (tcCityTz) tcCityTz.textContent = city.timezone;
            }

            function resetCityStatus() {
                if (tcNoSelection) tcNoSelection.style.display = '';
                if (tcSelectedCity) tcSelectedCity.style.display = 'none';
            }

            function showTerraDialog() {
                tcDialog!.style.display = '';
                grid.classList.add('blurred');
                tcCityInput!.value = '';
                tcCityResults!.innerHTML = '';
                tcSlotPicker!.style.display = 'none';
                hideTcMessage();
                resetCityStatus();
                setTimeout(() => tcCityInput?.focus(), 50);
            }

            function hideTerraDialog() {
                tcDialog!.style.display = 'none';
                grid.classList.remove('blurred');
            }

            changeCitiesBtn.addEventListener('click', showTerraDialog);
            tcDoneBtn.addEventListener('click', hideTerraDialog);
            if (tcCancelBtn) tcCancelBtn.addEventListener('click', hideTerraDialog);
            tcDialog!.querySelector('.tc-backdrop')?.addEventListener('click', hideTerraDialog);

            tcResetBtn.addEventListener('click', () => {
                const overlay = document.getElementById('tc-confirm-overlay');
                if (overlay) overlay.style.display = '';
            });

            const confirmYes = document.getElementById('tc-confirm-yes');
            const confirmNo = document.getElementById('tc-confirm-no');
            const confirmOverlay = document.getElementById('tc-confirm-overlay');

            if (confirmYes && confirmNo && confirmOverlay) {
                confirmNo.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                });
                confirmYes.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                    terraFace.terraSlotOverrides = undefined;
                    writeTerraOverridesToUrl();
                    rebuildTerraForSlotChange();
                    showTcMessage('All cities reset to defaults', 'info');
                    resetCityStatus();
                    tcSlotPicker!.style.display = 'none';
                });
            }

            // --- City search ---
            let tcSearchDebounce: ReturnType<typeof setTimeout> | null = null;

            function renderTcSearchResults(results: CityResult[]) {
                tcCityResults!.innerHTML = '';
                if (results.length === 0) {
                    tcCityResults!.innerHTML = '<div class="tc-city-loading">No results found</div>';
                    return;
                }
                const max = Math.min(results.length, 50);
                for (let i = 0; i < max; i++) {
                    const r = results[i];
                    const div = document.createElement('div');
                    div.className = 'tc-city-item';
                    if (r.isAirport) {
                        div.innerHTML = `<span class="iata-tag">${r.label.split(' ')[0]}</span>${r.label.split(' ').slice(1).join(' ')}`;
                    } else {
                        div.textContent = r.label;
                    }
                    div.addEventListener('click', () => {
                        tcCityInput!.value = '';
                        tcCityResults!.innerHTML = '';
                        onCitySelected(r);
                    });
                    tcCityResults!.appendChild(div);
                }
            }

            async function onTcCityInput() {
                const query = tcCityInput!.value.trim();
                if (query.length === 0) {
                    tcCityResults!.innerHTML = '';
                    return;
                }
                try {
                    if (!isCityDataLoaded()) {
                        if (loadError) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">City search unavailable: ${loadError}</div>`;
                            return;
                        }
                        tcCityResults!.innerHTML = '<div class="tc-city-loading">Loading city database…</div>';
                        try {
                            await loadCityData();
                        } catch (err) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">Failed to load: ${(err as Error).message}</div>`;
                            return;
                        }
                        const currentQuery = tcCityInput!.value.trim();
                        if (currentQuery.length === 0) {
                            tcCityResults!.innerHTML = '';
                            return;
                        }
                    }
                    const results = searchCities(query, lat, lon);
                    renderTcSearchResults(results);
                } catch (err) {
                    tcCityResults!.innerHTML = `<div class="tc-city-loading">Error: ${(err as Error).message}</div>`;
                }
            }

            function debounceTcSearch() {
                if (tcSearchDebounce) clearTimeout(tcSearchDebounce);
                tcSearchDebounce = setTimeout(onTcCityInput, 150);
            }

            tcCityInput.addEventListener('input', debounceTcSearch);
            tcCityInput.addEventListener('keyup', debounceTcSearch);
            tcCityInput.addEventListener('compositionend', debounceTcSearch);

            tcCityInput.addEventListener('keydown', (e: KeyboardEvent) => {
                const items = tcCityResults!.querySelectorAll('.tc-city-item');
                if (items.length === 0) return;
                const current = tcCityResults!.querySelector('.tc-city-item.selected');
                const idx = current ? Array.from(items).indexOf(current) : -1;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const next = idx < items.length - 1 ? idx + 1 : 0;
                    current?.classList.remove('selected');
                    items[next].classList.add('selected');
                    items[next].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prev = idx > 0 ? idx - 1 : items.length - 1;
                    current?.classList.remove('selected');
                    items[prev].classList.add('selected');
                    items[prev].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'Enter' && current) {
                    (current as HTMLElement).click();
                }
            });

            /** Handle a city selection from search results */
            function onCitySelected(city: CityResult) {
                showCityStatus(city);
                hideTcMessage();
                tcSlotPicker!.style.display = 'none';

                const validSlots = validSlotsForTz(city.timezone);

                if (validSlots.length === 0) {
                    showTcMessage(`${city.shortLabel}'s timezone (${city.timezone}) cannot fit on any ring slot.`, 'error');
                    return;
                }

                if (validSlots.length === 1) {
                    // If the only valid slot is the global-location slot, warn
                    if (validSlots[0] === terraFace.globalLocationSlot) {
                        showTcMessage(`Note: this slot currently shows your location`, 'warn');
                    }
                    assignCityToSlot(validSlots[0], city);
                } else {
                    // Multiple valid slots — show slot picker
                    tcSlotPicker!.style.display = '';
                    tcSlotChoices!.innerHTML = '';
                    const currentSlots = getCurrentSlots();
                    for (const slot of validSlots) {
                        const currentCity = currentSlots[slot]?.cityName || 'Unknown';
                        const isGlobalSlot = slot === terraFace.globalLocationSlot;
                        const btn = document.createElement('button');
                        btn.className = 'tc-slot-btn';
                        const label = isGlobalSlot ? `${currentCity} ★` : currentCity;
                        btn.innerHTML = `<span class="tc-slot-city">${label}</span><span class="tc-slot-offset">${formatSlotOffset(slot)}${isGlobalSlot ? ' (your location)' : ''}</span>`;
                        btn.addEventListener('click', () => {
                            tcSlotPicker!.style.display = 'none';
                            assignCityToSlot(slot, city);
                        });
                        tcSlotChoices!.appendChild(btn);
                    }
                }
            }
        }
    }

    // =========================================================================
    // Gaia subdial city customization (for faces with worldTimeSubdials, single-face)
    // =========================================================================
    const gaiaFace = faces.find(f => f.watch.worldTimeSubdials);
    if (gaiaFace && isSingleFace && !terraFace) {
        // Reuse the same terra-city-dialog HTML elements
        const tcDialog = document.getElementById('terra-city-dialog');
        const tcCityInput = document.getElementById('tc-city-input') as HTMLInputElement | null;
        const tcCityResults = document.getElementById('tc-city-results');
        const tcSlotPicker = document.getElementById('tc-slot-picker');
        const tcSlotChoices = document.getElementById('tc-slot-choices');
        const tcMessage = document.getElementById('tc-message');
        const tcNoSelection = document.getElementById('tc-no-selection');
        const tcSelectedCity = document.getElementById('tc-selected-city');
        const tcCityName = document.getElementById('tc-city-name');
        const tcCityTz = document.getElementById('tc-city-tz');
        const tcResetBtn = document.getElementById('tc-reset');
        const tcCancelBtn = document.getElementById('tc-cancel');
        const tcDoneBtn = document.getElementById('tc-done');
        const tcTitle = tcDialog?.querySelector('.tc-title');

        if (tcDialog && tcCityInput && tcCityResults && tcSlotPicker &&
            tcSlotChoices && tcMessage && tcDoneBtn && tcResetBtn) {

            // Customize the title for Gaia
            if (tcTitle) tcTitle.textContent = 'Change subdial cities';

            // Subdial slot labels
            const subdialLabels: Record<number, string> = { 2: 'Upper', 3: 'Right', 4: 'Lower' };

            // Add "Change cities" button
            const changeCitiesBtn = document.createElement('button');
            changeCitiesBtn.className = 'change-cities-btn';
            changeCitiesBtn.textContent = 'Change cities';
            changeCitiesBtn.id = 'change-cities-btn';
            const timeBarEl = document.getElementById('time-bar');
            if (timeBarEl) {
                timeBarEl.parentElement!.insertBefore(changeCitiesBtn, timeBarEl);
            }

            /** Write Gaia subdial overrides to URL */
            function writeGaiaOverridesToUrl() {
                const params = new URLSearchParams(window.location.search);
                const nSubdials = gaiaFace.watch.maxSeparateLoc || 4;
                for (let slot = 2; slot <= nSubdials; slot++) {
                    params.delete(`d${slot}`);
                    params.delete(`d${slot}tz`);
                    params.delete(`d${slot}lat`);
                    params.delete(`d${slot}lon`);
                }
                if (gaiaFace.terraSlotOverrides) {
                    for (const [slotStr, data] of Object.entries(gaiaFace.terraSlotOverrides)) {
                        const s = Number(slotStr);
                        if (s < 2) continue; // don't write observer slot
                        params.set(`d${slotStr}`, data.cityName);
                        params.set(`d${slotStr}tz`, data.olsonId);
                        params.set(`d${slotStr}lat`, data.lat.toFixed(3));
                        params.set(`d${slotStr}lon`, data.lon.toFixed(3));
                    }
                }
                params.delete('long');
                params.delete('loc');
                const qs = params.toString();
                const newUrl = window.location.pathname + (qs ? '?' + qs : '');
                history.replaceState(null, '', newUrl);
                updateNavigationLinks();
            }

            /** Rebuild Gaia after a slot change */
            function rebuildGaiaForSlotChange() {
                for (const face of faces) {
                    if (!face.enabled) continue;
                    face.env = createWatchEnvironment(face.watch, lat, lon, getNow, locationTimezone, face.terraSlotOverrides, face.globalLocationSlot);
                    if (face.terminatorLeaves.length > 0) {
                        updateLeafAngles(face.terminatorLeaves, face.env);
                        resetLeafSchedules(face.terminatorLeaves);
                        face.lastTerminatorRebuild = 0;
                    }
                    const { canvas, watch, env, images, scale } = face;
                    buildStaticBlockCaches(watch, env, canvas.width, canvas.height, scale, images, face.terminatorLeaves);
                    for (const hs of face.handStates) {
                        hs.nextUpdateTime = 0;
                    }
                }
                stopScheduler();
                startScheduler();
            }

            function assignCityToGaiaSlot(slot: number, city: CityResult) {
                const previousCity = gaiaFace.terraSlotOverrides?.[slot]?.cityName || GAIA_SUBDIAL_DEFAULTS[slot]?.cityName || 'Unknown';
                if (!gaiaFace.terraSlotOverrides) {
                    gaiaFace.terraSlotOverrides = {};
                }
                gaiaFace.terraSlotOverrides[slot] = {
                    cityName: city.shortLabel,
                    olsonId: city.timezone,
                    lat: city.lat,
                    lon: city.lon,
                };
                writeGaiaOverridesToUrl();
                rebuildGaiaForSlotChange();
                showGaiaMessage(`${city.shortLabel} replaces ${previousCity} (${subdialLabels[slot]} subdial)`, 'info');
            }

            function showGaiaMessage(text: string, type: 'info' | 'warn' | 'error') {
                tcMessage!.textContent = text;
                tcMessage!.className = `tc-message tc-message-${type}`;
                tcMessage!.style.display = '';
            }

            function hideGaiaMessage() {
                tcMessage!.style.display = 'none';
            }

            function showGaiaCityStatus(city: CityResult) {
                if (tcNoSelection) tcNoSelection.style.display = 'none';
                if (tcSelectedCity) tcSelectedCity.style.display = '';
                if (tcCityName) tcCityName.textContent = city.shortLabel;
                if (tcCityTz) tcCityTz.textContent = city.timezone;
            }

            function resetGaiaCityStatus() {
                if (tcNoSelection) tcNoSelection.style.display = '';
                if (tcSelectedCity) tcSelectedCity.style.display = 'none';
            }

            function showGaiaDialog() {
                tcDialog!.style.display = '';
                grid.classList.add('blurred');
                tcCityInput!.value = '';
                tcCityResults!.innerHTML = '';
                tcSlotPicker!.style.display = 'none';
                hideGaiaMessage();
                resetGaiaCityStatus();
                setTimeout(() => tcCityInput?.focus(), 50);
            }

            function hideGaiaDialog() {
                tcDialog!.style.display = 'none';
                grid.classList.remove('blurred');
            }

            changeCitiesBtn.addEventListener('click', showGaiaDialog);
            tcDoneBtn.addEventListener('click', hideGaiaDialog);
            if (tcCancelBtn) tcCancelBtn.addEventListener('click', hideGaiaDialog);
            tcDialog!.querySelector('.tc-backdrop')?.addEventListener('click', hideGaiaDialog);

            tcResetBtn.addEventListener('click', () => {
                const overlay = document.getElementById('tc-confirm-overlay');
                if (overlay) overlay.style.display = '';
            });

            const confirmYes = document.getElementById('tc-confirm-yes');
            const confirmNo = document.getElementById('tc-confirm-no');
            const confirmOverlay = document.getElementById('tc-confirm-overlay');

            if (confirmYes && confirmNo && confirmOverlay) {
                confirmNo.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                });
                confirmYes.addEventListener('click', () => {
                    confirmOverlay.style.display = 'none';
                    // Reset slots 2-4 to defaults, keep slot 1 (observer)
                    if (gaiaFace.terraSlotOverrides) {
                        const slot1 = gaiaFace.terraSlotOverrides[1];
                        gaiaFace.terraSlotOverrides = slot1 ? { 1: slot1 } : {};
                        for (const [k, v] of Object.entries(GAIA_SUBDIAL_DEFAULTS)) {
                            gaiaFace.terraSlotOverrides[Number(k)] = { ...v };
                        }
                    }
                    writeGaiaOverridesToUrl();
                    rebuildGaiaForSlotChange();
                    showGaiaMessage('All subdials reset to defaults', 'info');
                    resetGaiaCityStatus();
                    tcSlotPicker!.style.display = 'none';
                });
            }

            // --- City search ---
            let gaiaSearchDebounce: ReturnType<typeof setTimeout> | null = null;

            function renderGaiaSearchResults(results: CityResult[]) {
                tcCityResults!.innerHTML = '';
                if (results.length === 0) {
                    tcCityResults!.innerHTML = '<div class="tc-city-loading">No results found</div>';
                    return;
                }
                const max = Math.min(results.length, 50);
                for (let i = 0; i < max; i++) {
                    const r = results[i];
                    const div = document.createElement('div');
                    div.className = 'tc-city-item';
                    if (r.isAirport) {
                        div.innerHTML = `<span class="iata-tag">${r.label.split(' ')[0]}</span>${r.label.split(' ').slice(1).join(' ')}`;
                    } else {
                        div.textContent = r.label;
                    }
                    div.addEventListener('click', () => {
                        tcCityInput!.value = '';
                        tcCityResults!.innerHTML = '';
                        onGaiaCitySelected(r);
                    });
                    tcCityResults!.appendChild(div);
                }
            }

            async function onGaiaCityInput() {
                const query = tcCityInput!.value.trim();
                if (query.length === 0) {
                    tcCityResults!.innerHTML = '';
                    return;
                }
                try {
                    if (!isCityDataLoaded()) {
                        if (loadError) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">City search unavailable: ${loadError}</div>`;
                            return;
                        }
                        tcCityResults!.innerHTML = '<div class="tc-city-loading">Loading city database…</div>';
                        try {
                            await loadCityData();
                        } catch (err) {
                            tcCityResults!.innerHTML = `<div class="tc-city-loading">Failed to load: ${(err as Error).message}</div>`;
                            return;
                        }
                        const currentQuery = tcCityInput!.value.trim();
                        if (currentQuery.length === 0) {
                            tcCityResults!.innerHTML = '';
                            return;
                        }
                    }
                    const results = searchCities(query, lat, lon);
                    renderGaiaSearchResults(results);
                } catch (err) {
                    tcCityResults!.innerHTML = `<div class="tc-city-loading">Error: ${(err as Error).message}</div>`;
                }
            }

            function debounceGaiaSearch() {
                if (gaiaSearchDebounce) clearTimeout(gaiaSearchDebounce);
                gaiaSearchDebounce = setTimeout(onGaiaCityInput, 150);
            }

            tcCityInput.addEventListener('input', debounceGaiaSearch);
            tcCityInput.addEventListener('keyup', debounceGaiaSearch);
            tcCityInput.addEventListener('compositionend', debounceGaiaSearch);

            tcCityInput.addEventListener('keydown', (e: KeyboardEvent) => {
                const items = tcCityResults!.querySelectorAll('.tc-city-item');
                if (items.length === 0) return;
                const current = tcCityResults!.querySelector('.tc-city-item.selected');
                const idx = current ? Array.from(items).indexOf(current) : -1;
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    const next = idx < items.length - 1 ? idx + 1 : 0;
                    current?.classList.remove('selected');
                    items[next].classList.add('selected');
                    items[next].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    const prev = idx > 0 ? idx - 1 : items.length - 1;
                    current?.classList.remove('selected');
                    items[prev].classList.add('selected');
                    items[prev].scrollIntoView({ block: 'nearest' });
                } else if (e.key === 'Enter' && current) {
                    (current as HTMLElement).click();
                }
            });

            /** Handle a city selection — always show subdial picker */
            function onGaiaCitySelected(city: CityResult) {
                showGaiaCityStatus(city);
                hideGaiaMessage();

                // Show subdial picker (slots 2-4)
                tcSlotPicker!.style.display = '';
                tcSlotChoices!.innerHTML = '';
                const slotLabel = tcSlotPicker!.querySelector('.tc-slot-label');
                if (slotLabel) slotLabel.textContent = 'Which subdial should this city replace?';

                const nSubdials = gaiaFace.watch.maxSeparateLoc || 4;
                for (let slot = 2; slot <= nSubdials; slot++) {
                    const currentCity = gaiaFace.terraSlotOverrides?.[slot]?.cityName
                        || GAIA_SUBDIAL_DEFAULTS[slot]?.cityName || 'Unknown';
                    const btn = document.createElement('button');
                    btn.className = 'tc-slot-btn';
                    btn.innerHTML = `<span class="tc-slot-city">${currentCity}</span><span class="tc-slot-offset">${subdialLabels[slot] || `Subdial ${slot}`}</span>`;
                    btn.addEventListener('click', () => {
                        tcSlotPicker!.style.display = 'none';
                        assignCityToGaiaSlot(slot, city);
                    });
                    tcSlotChoices!.appendChild(btn);
                }
            }
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
