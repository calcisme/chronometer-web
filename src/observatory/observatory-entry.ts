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
import { computeLayout, type LayoutParams } from './layout.js';
import { getMainDialCache, invalidateMainDialCache, waitForImages } from './main-dial.js';
import { drawPlanetHands, waitForPlanetImages } from './planet-hands.js';
import { drawRiseSetRings, invalidateRingCache } from './ring-view.js';

// ============================================================================
// State
// ============================================================================

/** Noon-on-top toggle: when true, 12 is at top; when false, 24 is at top. */
let noonOnTop = false;

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

// If no timezone in URL, resolve it from lat/lon (only if we have a location)
if (!locationTimezone && hasUrlLocation) {
    locationTimezone = resolveTimezone(lat, lon, null);
}

let tzDeltaMs = computeTzDeltaMs(locationTimezone);

// --- Astronomy environment ---
const getNow = (): Date => timeController.getDisplayTime();
let env: Environment = createAstroEnvironment(lat, lon, getNow, locationTimezone);

// ============================================================================
// Canvas setup
// ============================================================================

function initCanvas(): void {
    canvas = document.getElementById('observatory-canvas') as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not get 2D context');
    ctx = context;

    // Initial size
    resizeCanvas();
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
    needsStaticRedraw = true;
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
    drawRiseSetRings(ctx, L, env, noonOnTop, now, lat, lon, tzOffsetSec);

    // ================================================================
    // 3. Planet hands (dynamic — recomputed hourly)
    // ================================================================
    drawPlanetHands(ctx, L, now, env);

    // ================================================================
    // 4. Peripheral dial placeholders (Phase 7 will replace these)
    // ================================================================
    const peripherals = [
        { cx: L.altCX, cy: L.altCY, r: L.altR, label: 'ALT' },
        { cx: L.azCX, cy: L.azCY, r: L.azR, label: 'AZ' },
        { cx: L.eclipseCX, cy: L.eclipseCY, r: L.eclipseR2, label: 'ECL' },
        { cx: L.eotCX, cy: L.eotCY, r: L.eotR, label: 'EOT' },
    ];

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const p of peripherals) {
        ctx.beginPath();
        ctx.arc(p.cx, p.cy, p.r, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillText(p.label, p.cx, p.cy);
    }

    // ================================================================
    // 5. Header placeholders (Phase 5/6 will replace these)
    // ================================================================
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';

    // Moon placeholder
    ctx.beginPath();
    ctx.arc(L.moonCX, L.moonCY, L.moonR, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.fillText('MOON', L.moonCX, L.moonCY);

    // Earth map placeholder
    ctx.strokeRect(
        L.earthCX - L.earthW / 2, L.earthCY - L.earthH / 2,
        L.earthW, L.earthH,
    );
    ctx.fillText('EARTH', L.earthCX, L.earthCY);

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

    ctx.restore();
}

function tick(): void {
    // Check for quantized tick (time controller)
    timeController.checkTick(performance.now());

    // Begin frame snapshot (all parts see same time)
    timeController.beginFrame();

    drawFrame();

    timeController.endFrame();

    requestAnimationFrame(tick);
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
    invalidateRingCache();
    needsStaticRedraw = true;
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

            rebuildEnv();
            updateLocationDisplay();
        },
    });

    if (locationDialog && setLocationBtn) {
        setLocationBtn.addEventListener('click', () => locationDialog.show());

        if (needsPrompt) {
            locationDialog.show();
        }

        // Handle bloc=1: request browser location on startup
        if (urlState.bloc && !hasUrlLocation) {
            requestBrowserLocation(10000).then(result => {
                if (result.status === 'success') {
                    const tz = resolveTimezone(result.lat, result.lon, null);
                    lat = result.lat;
                    lon = result.lon;
                    locationTimezone = tz;
                    needsPrompt = false;
                    locationDialog.updateState(lat, lon, 'browser', '', '');
                    rebuildEnv();
                    updateLocationDisplay();
                } else {
                    needsPrompt = true;
                    locationDialog.setNeedsPrompt(true);
                    if (result.status === 'denied') {
                        locationDialog.setGeoPermission('denied');
                    }
                    locationDialog.show();
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

    // Wire up time controller env rebuild on tick
    timeController.onTick = () => rebuildEnv();

    console.log('[Observatory] Initialized — lat:', lat, 'lon:', lon, 'tz:', locationTimezone);

    // Wait for images to load, then invalidate cache so first real draw occurs
    Promise.all([waitForImages(), waitForPlanetImages()]).then(() => {
        invalidateMainDialCache();
        console.log('[Observatory] All images loaded');
    });

    // Start render loop
    requestAnimationFrame(tick);
}

// Boot when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
