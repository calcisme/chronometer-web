/**
 * Observatory — astronomical clock web app.
 *
 * Entry point for the Observatory app. Imports ONLY from:
 *   - src/shared/   (astro-env, url-state, tz-resolve, city-search, location-dialog, time-controller)
 *   - src/expr/     (parser, evaluator)
 *   - src/astronomy/ (rise/set, time, astro-constants)
 *   - src/observatory/ (layout, draw-utils, and future view modules)
 *
 * Does NOT import from src/watch/ — keeps the bundle clean of
 * Chronometer-specific code (renderer, XML parser, Terra slots, etc.)
 */

import { createAstroEnvironment, computeTzDeltaMs } from '../shared/astro-env.js';
import type { Environment } from '../expr/evaluator.js';
import { readUrlState, writeUrlState } from '../shared/url-state.js';
import { resolveTimezone } from '../shared/tz-resolve.js';
import { findClosestCity } from '../shared/city-search.js';
import { initLocationDialog, requestBrowserLocation } from '../shared/location-dialog.js';
import { TimeController } from '../shared/time-controller.js';
import { initTimeControls } from '../shared/time-controls-ui.js';
import type { TimeControlsAPI } from '../shared/time-controls-ui.js';
import { computeLayout, type LayoutParams } from './layout.js';
import { getMainDialCache, invalidateMainDialCache, waitForImages } from './main-dial.js';
import { drawPlanetHands, waitForPlanetImages } from './planet-hands.js';
import { drawRiseSetRings, invalidateRingCache } from './ring-view.js';
import { drawClockHands, drawSubdialHands } from './hand-views.js';
import { initEarthView, drawEarthView } from './earth-view.js';
import { initMoonView, drawMoonView } from './moon-view.js';
import { getPeripheralDialsCache, invalidatePeripheralDialsCache } from './peripheral-dials.js';
import { drawPeripheralHands, cycleSelectablePlanet } from './peripheral-hands.js';
import { drawDateView } from './date-view.js';

import { type ObsValueName, buildObsValues } from './obs-values.js';
import { Updater, makeOverridableGetNow, timingContextForFrame } from '../shared/updater.js';
import { createFpsIndicator, type FpsIndicator } from '../shared/fps-indicator.js';

// ============================================================================
// State
// ============================================================================

/** Noon-on-top toggle: when true, 12 is at top; when false, 24 is at top. */
let noonOnTop = false;

/** RAF id for the render loop; null means the loop is idle (stopped + settled). */
let rafId: number | null = null;

/**
 * True while tick() is executing. scheduleFrame() must not queue a frame during
 * a tick — tick()'s own re-arm handles continuation. Without this guard, a
 * scheduleFrame() called synchronously from within a tick (e.g. timeController
 * `onTick` → rebuildEnv() during scrubbing) queues a duplicate rAF every frame,
 * compounding into hundreds of redundant ticks per frame.
 */
let inTick = false;
/** Set when scheduleFrame() is called during a tick, so the tick re-arms even if it would otherwise idle. */
let frameRequestedDuringTick = false;

/** Page-level FPS indicator overlay (created when the ?fps URL param is set). */
let fpsIndicator: FpsIndicator | null = null;

/** Current layout parameters (recomputed on resize) */
let layout: LayoutParams;

/** The canvas element */
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

/** Time controller (shared with Chronometer for scrubbing/stepping) */
const timeController = new TimeController();

// --- Location state ---
const urlState = readUrlState();
const hasUrlLocation = urlState.lat !== null && urlState.lon !== null;
let lat = urlState.lat ?? 0;
let lon = urlState.lon ?? 0;
let locationTimezone: string | undefined = urlState.tz || undefined;
let needsPrompt = !hasUrlLocation && !urlState.bloc;

// Restore time state from URL (so deep-links carry the time too — matching
// Chronometer and the Inspector's "open in <app>" links).
if (urlState.off !== null && !isNaN(urlState.off)) {
    timeController.setOffset(urlState.off);
} else if (urlState.t !== null && !isNaN(urlState.t)) {
    timeController.setTime(new Date(urlState.t));
    if (urlState.dir === 1) { timeController.setDirection(1); timeController.setRate(null); }
    else if (urlState.dir === -1) { timeController.setDirection(-1); timeController.setRate(null); }
    // dir === 0 stays stopped (setTime already stops)
}

// If no timezone in URL, resolve it from lat/lon (only if we have a location)
if (!locationTimezone && hasUrlLocation) {
    locationTimezone = resolveTimezone(lat, lon, null);
}

let tzDeltaMs = computeTzDeltaMs(locationTimezone);

// --- Astronomy environment ---
// makeOverridableGetNow lets the Updater's eval-ahead pass temporarily evaluate
// expressions at a *future* display time (via withDisplayTime) without disturbing
// the live time source. env captures this getNow, so every astro function reads
// through the same override seam.
const { getNow, withDisplayTime } = makeOverridableGetNow(() => timeController.getDisplayTime());
let env: Environment = createAstroEnvironment(lat, lon, getNow, locationTimezone);


let updater: Updater<ObsValueName> | null = null;

/** Time controller UI handle (null until DOM is ready) */
let timeUI: TimeControlsAPI | null = null;

/**
 * Body shown on the altitude/azimuth dials (ECPlanetNumber). Click either dial
 * to cycle; persisted in the URL `op` param. Invalid/absent → Sun (0).
 */
const SELECTABLE_PLANETS = new Set([0, 1, 2, 3, 5, 6, 7]);
let selectedPlanet: number =
    urlState.op !== null && SELECTABLE_PLANETS.has(urlState.op) ? urlState.op : 0;

// ============================================================================
// Canvas setup
// ============================================================================

function initCanvas(): void {
    canvas = document.getElementById('observatory-canvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2D context');
    ctx = context;

    // Click either the altitude or azimuth dial to cycle the displayed body.
    canvas.addEventListener('click', onCanvasClick);

    // Initial size
    resizeCanvas();
}

/** Cycle the alt/az body when the user clicks within either dial. */
function onCanvasClick(ev: MouseEvent): void {
    if (!layout) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const L = layout;
    const hit = (cx: number, cy: number, r: number) => Math.hypot(x - cx, y - cy) <= r;
    // iOS: the altitude dial cycles forward, the azimuth dial backward, so you
    // can "go back" by clicking the other dial (EOClock.mm:739-762).
    const onAlt = hit(L.altCX, L.altCY, L.altR);
    const onAz = hit(L.azCX, L.azCY, L.azR);
    if (onAlt || onAz) {
        selectedPlanet = cycleSelectablePlanet(selectedPlanet, onAlt ? 1 : -1);
        // Move the dial target, then reset so dialAlt/dialAz re-evaluate and
        // animate to the new body (same sweep as a location change).
        env.variables.set('dialPlanet', selectedPlanet);
        writeUrlState({ op: selectedPlanet });
        updater?.reset();
        scheduleFrame();
    }
}

function resizeCanvas(): void {
    const dpr = devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    // Recompute layout
    layout = computeLayout(w, h);

    // Invalidate static caches so they rebuild at new size
    invalidateMainDialCache();
    invalidateRingCache();
    invalidatePeripheralDialsCache();
    needsStaticRedraw = true;
    // The loop may be idle (stopped); a resize must trigger a redraw.
    scheduleFrame();
}

let needsStaticRedraw = true;

// Debounced resize handler
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const ro = new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        resizeCanvas();
    }, 100);
});

/**
 * Draw the current frame.
 * Phase 1: draws the main dial static cache + placeholder outlines for
 * peripheral elements not yet implemented.
 */
function drawFrame(): void {
    const dpr = devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;

    // Clear to black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

    const L = layout;

    // ================================================================
    // 1. Draw static main dial cache (composited at native resolution)
    // ================================================================
    const dialCache = getMainDialCache(L, noonOnTop);
    if (dialCache) {
        // Cache is already at DPR resolution — draw 1:1 into the canvas
        ctx.drawImage(dialCache, 0, 0);
    }

    // Peripheral dial backgrounds (static, DPR-resolution full-viewport cache).
    ctx.drawImage(getPeripheralDialsCache(L), 0, 0);

    // Scale for DPR for all remaining drawing
    ctx.save();
    ctx.scale(dpr, dpr);

    // ================================================================
    // 2. Rise/set rings (dynamic — recomputed hourly)
    //    Draw after static dial but before planet hands so arcs
    //    appear between the orbit circles and the planet icons.
    // ================================================================
    const now = getNow();
    const tzOffsetSec = env.tzOffsetSec ?? 0;
    if (updater) {
        drawRiseSetRings(ctx, L, env, noonOnTop, now, lat, lon, tzOffsetSec, updater);
    }

    // ================================================================
    // 3. Planet hands (dynamic — values update hourly via ObsValues)
    // ================================================================
    if (updater) {
        drawPlanetHands(ctx, L, updater);
    }

    // ================================================================
    // 3b. Subdial hands (UTC, Solar, Sidereal)
    //     Drawn before main clock hands so main hands appear on top.
    // ================================================================
    if (updater) {
        drawSubdialHands(ctx, L, updater);
    }

    // ================================================================
    // 3c. Clock hands (24h, 12h, minute, second, sun events)
    //     Drawn last so the three main hands (h, m, s) are on top of
    //     everything else, as they would be physically.
    // ================================================================
    if (updater) {
        drawClockHands(ctx, L, updater);
    }

    // ================================================================
    // 4. Peripheral dial hands + labels (backgrounds are in the static cache;
    //    the eclipse slot is intentionally empty, deferred to its own plan)
    // ================================================================
    if (updater) {
        drawPeripheralHands(ctx, L, updater, selectedPlanet);
    }

    // ================================================================
    // 5. Header: moon, earth map, date display
    // ================================================================
    // Moon phase display (Phase 6)
    if (updater) {
        drawMoonView(ctx, L, updater);
    }

    // Earth map (Phase 5: day/night terminator)
    if (updater) {
        drawEarthView(ctx, L, updater, lat, lon, getNow);
    }

    // Date display (Phase 7)
    drawDateView(ctx, L, now, locationTimezone);

    // ================================================================
    // 6. Logo
    // ================================================================
    ctx.font = '12px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fillText('EMERALD ✦ SEQUOIA', L.logoCX, L.logoCY);

    // ================================================================
    // 7. Debug status overlay (top-left)
    // ================================================================
    ctx.font = '11px "JetBrains Mono", monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const timeStr = now.toLocaleTimeString('en-US', {
        hour12: false,
        timeZone: locationTimezone,
    });
    ctx.fillText(`Observatory · ${timeStr}`, 10, 10);
    ctx.fillText(`${layout.viewW}×${layout.viewH} · mainR=${L.mainR.toFixed(0)}`, 10, 24);
    // FPS is shown via the shared DOM overlay (createFpsIndicator), bottom-left.

    ctx.restore();
}

/** Start the render loop if it is currently idle (no-op if already running). */
function scheduleFrame(): void {
    if (inTick) {
        // The running tick will decide whether to re-arm; just record the request.
        frameRequestedDuringTick = true;
        return;
    }
    if (rafId === null) rafId = requestAnimationFrame(tick);
}

function tick(): void {
    rafId = null;
    inTick = true;
    frameRequestedDuringTick = false;
    const perfNow = performance.now();

    // Check for quantized tick (time controller)
    timeController.checkTick(perfNow);

    // Begin frame snapshot (all parts see same time)
    timeController.beginFrame();

    let animating = false;

    // Pass 1 & 2: Update + animate Observatory values. The TimingContext (tick
    // rate, per-tick display delta, direction) is derived generically from the
    // controller — the shared updater seam, no hand-rolled glue here.
    if (updater) {
        updater.tick(env, perfNow, getNow, withDisplayTime,
            timingContextForFrame(timeController));
        animating = updater.anyAnimating();
    }

    drawFrame();

    // Update time controller UI display
    timeUI?.updateTimeUI();

    timeController.endFrame();

    // Keep rendering while running (the second-hand sweep needs it) or while an
    // animation is still settling; otherwise go fully idle. A stopped, settled
    // clock has nothing to re-render — display time is frozen. The loop is
    // restarted by scheduleFrame()/ensureSchedulerRunning() on the next change.
    const continuous = !timeController.isStopped || animating;
    fpsIndicator?.recordFrame(continuous);
    inTick = false;
    if (continuous || frameRequestedDuringTick) {
        rafId = requestAnimationFrame(tick);
    }
}

// ============================================================================
// Location dialog
// ============================================================================

function updateLocationDisplay(): void {
    const nameEl = document.getElementById('location-name');
    if (!nameEl) return;

    if (lat === 0 && lon === 0 && needsPrompt) {
        nameEl.textContent = 'No location set';
        return;
    }
    const cityName = urlState.city || null;
    if (cityName) {
        nameEl.textContent = cityName;
    } else {
        const closest = findClosestCity(lat, lon);
        nameEl.textContent = closest?.shortLabel ?? `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
    }
}

function rebuildEnv(): void {
    tzDeltaMs = computeTzDeltaMs(locationTimezone);
    env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
    // Preserve env variables across the re-created environment.
    env.variables.set('noonOnTop', noonOnTop ? 1 : 0);
    env.variables.set('dialPlanet', selectedPlanet);
    invalidateRingCache();
    needsStaticRedraw = true;
    // The loop may be idle (stopped); env changes must trigger a redraw.
    scheduleFrame();
}

function setupLocationDialog(): void {
    const setLocationBtn = document.getElementById('set-location-btn');
    const locationDialog = initLocationDialog({
        initialLat: lat,
        initialLon: lon,
        needsPrompt,
        onLocationChange: (info) => {
            lat = info.lat;
            lon = info.lon;
            locationTimezone = info.timezone;
            needsPrompt = false;

            if (info.sourceType === 'browser') {
                writeUrlState({ bloc: true, lat: null, lon: null, city: null, tz: null });
            } else {
                writeUrlState({ lat: info.lat, lon: info.lon, city: info.source || null, tz: info.timezone || null });
            }

            // Re-evaluate all values at the new location: sentinel-scheduled
            // values (Sun ring, planet rings) hold a nextUpdateTime computed for
            // the old location and won't recompute otherwise. (The ring caches
            // clear implicitly via this reset — see ring-view.invalidateRingCache.)
            updater?.reset();
            rebuildEnv();
            updateLocationDisplay();
            timeUI?.updateTimezoneDisplay();
        },
    });

    if (locationDialog && setLocationBtn) {
        setLocationBtn.addEventListener('click', () => locationDialog.show());

        if (needsPrompt) {
            locationDialog.show();
        }

        // Handle bloc=1: request browser location on startup.
        //
        // Timing: only show the compact "locating…" panel if the request is still
        // pending after LOCATING_SHOW_DELAY_MS — a fast geolocation response should
        // never flash the panel. If we do show it, keep it up for at least
        // LOCATING_MIN_VISIBLE_MS so it doesn't vanish in a blink (the rings
        // animate behind it meanwhile).
        if (urlState.bloc && !hasUrlLocation) {
            const LOCATING_SHOW_DELAY_MS = 1000;
            const LOCATING_MIN_VISIBLE_MS = 2000;
            let shownAt: number | null = null;
            let showTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
                showTimer = null;
                locationDialog.showLocating();
                shownAt = performance.now();
            }, LOCATING_SHOW_DELAY_MS);

            // Run `apply` now if the panel was never shown, otherwise once it has
            // been visible for the minimum duration.
            const afterMinVisible = (apply: () => void) => {
                if (showTimer !== null) {
                    clearTimeout(showTimer);   // result beat the show delay — never show
                    showTimer = null;
                    apply();
                } else {
                    const remaining = LOCATING_MIN_VISIBLE_MS - (performance.now() - (shownAt ?? 0));
                    if (remaining > 0) setTimeout(apply, remaining);
                    else apply();
                }
            };

            requestBrowserLocation(10000).then(result => {
                if (result.status === 'success') {
                    afterMinVisible(() => {
                        // If we showed the panel and the user switched to manual
                        // entry, don't override their flow with the late result.
                        if (shownAt !== null && !locationDialog.isLocating()) return;
                        const tz = resolveTimezone(result.lat, result.lon, null);
                        lat = result.lat;
                        lon = result.lon;
                        locationTimezone = tz;
                        needsPrompt = false;
                        locationDialog.updateState(lat, lon, 'browser', '', '');
                        // Async location arrived after buildObsValues ran at the
                        // startup default — re-evaluate everything (esp. the
                        // sentinel-scheduled Sun/planet rings) at the real location.
                        updater?.reset();
                        rebuildEnv();
                        updateLocationDisplay();
                        locationDialog.dismiss();
                    });
                } else {
                    afterMinVisible(() => {
                        // Browser location failed/timed out — show the full dialog
                        // (non-dismissable until a location is chosen).
                        needsPrompt = true;
                        locationDialog.setNeedsPrompt(true);
                        if (result.status === 'denied') {
                            locationDialog.setGeoPermission('denied');
                        }
                        locationDialog.show();
                    });
                }
            });
        }
    }
}

// ============================================================================
// Initialization
// ============================================================================

function init(): void {
    initCanvas();
    ro.observe(document.documentElement);
    setupLocationDialog();
    updateLocationDisplay();

    // Wire up time controller env rebuild on tick. The controller fires onTick on
    // every transition (reset/stop/setTime/setOffset/setRate/setDirection) as well
    // as on each quantized tick, so this keeps env (timezone offset, DST) fresh
    // across both continuous advance and discrete jumps — which is why the time
    // controls need no transition callbacks of their own (see below).
    timeController.onTick = () => rebuildEnv();

    // Initialize Observatory value system
    env.variables.set('noonOnTop', noonOnTop ? 1 : 0);
    env.variables.set('dialPlanet', selectedPlanet);
    updater = buildObsValues(env, performance.now(), getNow);

    // Initialize earth view (altitude table + Blue Marble images)
    initEarthView();

    // Initialize moon view (moon image)
    initMoonView();

    // --- Wire time controller UI ---
    // No transition callbacks: handing the Updater to the shared controls means
    // every transport transition auto-resets the value schedules, and
    // `timeController.onTick → rebuildEnv()` (above) refreshes env. The default
    // writeTimeState persists the t/off/dir params, completing the deep-link
    // round-trip. ensureSchedulerRunning restarts the idle-parked render loop.
    timeUI = initTimeControls({
        timeController,
        updater,
        getTimezone: () => locationTimezone,
        getTzDeltaMs: () => tzDeltaMs,
        getLat: () => lat,
        getLon: () => lon,
        ensureSchedulerRunning: () => {
            // The loop idles when stopped + settled; restart it on transport changes.
            scheduleFrame();
        },
    });

    // Show time controller if URL says so
    if (urlState.tc) {
        timeUI?.showPopover();
    }

    console.log('[Observatory] Initialized — lat:', lat, 'lon:', lon, 'tz:', locationTimezone);

    // Page-level FPS overlay (enabled via ?fps) — shared with Chronometer.
    fpsIndicator = createFpsIndicator(urlState.fps);

    // Wait for images to load, then invalidate cache so first real draw occurs
    Promise.all([waitForImages(), waitForPlanetImages()]).then(() => {
        invalidateMainDialCache();
        // Image load can complete after the loop has idled — kick it so the
        // first real frame draws.
        scheduleFrame();
        console.log('[Observatory] All images loaded');
    });

    // Start render loop
    scheduleFrame();
}

// Boot when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
