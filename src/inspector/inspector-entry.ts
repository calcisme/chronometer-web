/**
 * Inspector — live astronomy data explorer.
 *
 * Entry point for the Inspector app. Imports ONLY from:
 *   - src/shared/   (astro-env, url-state, tz-resolve, city-search)
 *   - src/expr/     (parser, evaluator)
 *   - src/astronomy/ (rise/set for sunrise/sunset)
 *
 * Does NOT import from src/watch/ — keeps the bundle clean of
 * Chronometer-specific code (renderer, XML parser, Terra slots, etc.)
 */

import { createAstroEnvironment, computeTzDeltaMs } from '../shared/astro-env.js';
import { evaluate, type Environment } from '../expr/evaluator.js';
import { parse } from '../expr/parser.js';
import type { ASTNode } from '../expr/parser.js';
import { readUrlState, writeUrlState } from '../shared/url-state.js';
import { resolveTimezone } from '../shared/tz-resolve.js';
import { findClosestCity } from '../shared/city-search.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { planetaryRiseSetTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet } from '../astronomy/astro-constants.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';

// ============================================================================
// Initialization
// ============================================================================

// Default observer location (San Jose, CA)
const DEFAULT_LAT = 37.205;
const DEFAULT_LON = -121.954;

// DOM references
const timeDisplay = document.getElementById('time-display')!;
const dateDisplay = document.getElementById('date-display')!;
const locationName = document.getElementById('location-name')!;
const locationDetail = document.getElementById('location-detail')!;
const setLocationBtn = document.getElementById('set-location-btn')!;
const sunriseValue = document.getElementById('sunrise-value')!;
const sunsetValue = document.getElementById('sunset-value')!;
const exprInput = document.getElementById('expr-input') as HTMLInputElement;
const exprResults = document.getElementById('expr-results')!;
const exprNumber = document.getElementById('expr-number')!;
const exprAngle = document.getElementById('expr-angle')!;
const exprDate = document.getElementById('expr-date')!;
const exprError = document.getElementById('expr-error')!;

// --- Resolve location from URL params ---
const urlState = readUrlState();
let lat = urlState.lat ?? DEFAULT_LAT;
let lon = urlState.lon ?? DEFAULT_LON;
let locationTimezone = urlState.tz || undefined;

// If no timezone in URL, resolve it from lat/lon
if (!locationTimezone) {
    locationTimezone = resolveTimezone(lat, lon, null);
}

const tzDeltaMs = computeTzDeltaMs(locationTimezone);

// Display location
function updateLocationDisplay(): void {
    const cityName = urlState.city || null;
    if (cityName) {
        locationName.textContent = cityName;
    } else {
        // Try to find the closest city
        const closest = findClosestCity(lat, lon);
        if (closest) {
            locationName.textContent = closest.shortLabel;
        } else {
            locationName.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}°`;
        }
    }
    locationDetail.textContent = `${lat.toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}  ·  ${locationTimezone || 'Browser TZ'}`;
}
updateLocationDisplay();

// --- Location dialog (simplified — just opens Chronometer's location page) ---
setLocationBtn.addEventListener('click', () => {
    // Open the location prompt if it exists (injected by build.sh)
    const prompt = document.getElementById('location-prompt');
    if (prompt) {
        prompt.style.display = 'flex';
    }
});

// --- Create the astronomy environment ---
// getNow returns real time for now (Phase 4 will add time controller)
const getNow = (): Date => new Date();

let env = createAstroEnvironment(lat, lon, getNow, locationTimezone);

// ============================================================================
// Time display
// ============================================================================

function formatTime(date: Date): string {
    const h = date.getHours().toString().padStart(2, '0');
    const m = date.getMinutes().toString().padStart(2, '0');
    const s = date.getSeconds().toString().padStart(2, '0');
    return `${h}:${m}:${s}`;
}

function formatDate(date: Date): string {
    const options: Intl.DateTimeFormatOptions = {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: locationTimezone,
    };
    return date.toLocaleDateString('en-US', options);
}

function updateTimeDisplay(): void {
    const now = getNow();
    // Shift to target timezone for display
    const shifted = tzDeltaMs !== 0 ? new Date(now.getTime() + tzDeltaMs) : now;
    timeDisplay.textContent = formatTime(shifted);
    dateDisplay.textContent = formatDate(now);
}

// ============================================================================
// Sunrise / Sunset
// ============================================================================

/** Epoch reference for date interval conversion: 2001-01-01T00:00:00Z */
const EPOCH_2001_MS = 978307200000;

/**
 * Find today's sunrise or sunset time. Returns a Date, or null if
 * no event occurs today (polar conditions).
 */
function findTodayRiseSet(riseNotSet: boolean): Date | null {
    const now = getNow();
    const di = dateToDateInterval(now);
    const observerLatRad = lat * Math.PI / 180;
    const observerLonRad = lon * Math.PI / 180;
    const tzOffsetSeconds = (new Date().getTimezoneOffset() * -60) + tzDeltaMs / 1000;

    // Create a temporary cache pool for the calculation
    const pool = new AstroCachePool();
    initializeCachePool(pool, di, observerLatRad, observerLonRad, false, tzOffsetSeconds);

    // Compute local noon in the target timezone
    const shifted = tzDeltaMs !== 0 ? new Date(now.getTime() + tzDeltaMs) : now;
    const localNoon = new Date(
        shifted.getFullYear(), shifted.getMonth(), shifted.getDate(), 12, 0, 0,
    );
    const noonDI = dateToDateInterval(new Date(localNoon.getTime() - tzDeltaMs));

    // Search from local noon
    const fwdResult = planetaryRiseSetTimeRefined(
        noonDI, observerLatRad, observerLonRad,
        riseNotSet, ECPlanetNumber.Sun, NaN, pool,
    ).riseSetTime;

    releaseCachePool(pool);

    if (isNoRiseSet(fwdResult)) return null;

    // Check if result is on the same local day
    const resultDate = new Date(fwdResult * 1000 + EPOCH_2001_MS + tzDeltaMs);
    if (resultDate.getDate() !== shifted.getDate() ||
        resultDate.getMonth() !== shifted.getMonth()) {
        // Try searching from previous noon
        const pool2 = new AstroCachePool();
        initializeCachePool(pool2, di, observerLatRad, observerLonRad, false, tzOffsetSeconds);
        const bwdResult = planetaryRiseSetTimeRefined(
            noonDI - 24 * 3600, observerLatRad, observerLonRad,
            riseNotSet, ECPlanetNumber.Sun, NaN, pool2,
        ).riseSetTime;
        releaseCachePool(pool2);

        if (isNoRiseSet(bwdResult)) return null;
        const bwdDate = new Date(bwdResult * 1000 + EPOCH_2001_MS + tzDeltaMs);
        if (bwdDate.getDate() !== shifted.getDate() ||
            bwdDate.getMonth() !== shifted.getMonth()) {
            return null;
        }
        return new Date(bwdResult * 1000 + EPOCH_2001_MS);
    }

    return new Date(fwdResult * 1000 + EPOCH_2001_MS);
}

function formatRiseSetTime(date: Date | null): string {
    if (!date) return '—';
    const options: Intl.DateTimeFormatOptions = {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: locationTimezone,
        hour12: false,
    };
    return date.toLocaleTimeString('en-US', options);
}

function updateSunData(): void {
    const sunrise = findTodayRiseSet(true);
    const sunset = findTodayRiseSet(false);
    sunriseValue.textContent = formatRiseSetTime(sunrise);
    sunsetValue.textContent = formatRiseSetTime(sunset);
}

// ============================================================================
// Expression evaluator
// ============================================================================

let lastExprText = '';
let lastExprAST: ASTNode | null = null;
let lastExprError = false;

function updateExpressionEvaluator(): void {
    const text = exprInput.value.trim();

    if (!text) {
        exprResults.classList.remove('visible');
        exprError.classList.remove('visible');
        lastExprText = '';
        lastExprAST = null;
        lastExprError = false;
        return;
    }

    // Re-parse only if text changed
    if (text !== lastExprText) {
        lastExprText = text;
        try {
            lastExprAST = parse(text);
            lastExprError = false;
        } catch (e: any) {
            lastExprAST = null;
            lastExprError = true;
            exprResults.classList.remove('visible');
            exprError.textContent = e.message || 'Parse error';
            exprError.classList.add('visible');
            return;
        }
    }

    if (lastExprError || !lastExprAST) return;

    try {
        const value = evaluate(lastExprAST, env);
        exprError.classList.remove('visible');
        exprResults.classList.add('visible');

        // Number format
        if (Number.isInteger(value) && Math.abs(value) < 1e15) {
            exprNumber.textContent = value.toString();
        } else {
            exprNumber.textContent = value.toPrecision(10);
        }

        // Angle format (radians → degrees)
        const degrees = value * 180 / Math.PI;
        exprAngle.textContent = `${degrees.toFixed(4)}°`;

        // Date format: interpret as a dateInterval (seconds since 2001-01-01T00:00:00Z)
        const dateMs = value * 1000 + EPOCH_2001_MS;
        if (isFinite(dateMs) && dateMs > -6.2e13 && dateMs < 2.5e14) {
            const d = new Date(dateMs);
            exprDate.textContent = d.toISOString().replace('T', ' ').replace('Z', ' UTC');
        } else {
            exprDate.textContent = '—';
        }
    } catch (e: any) {
        exprResults.classList.remove('visible');
        exprError.textContent = e.message || 'Evaluation error';
        exprError.classList.add('visible');
    }
}

// Listen for input changes
exprInput.addEventListener('input', updateExpressionEvaluator);

// ============================================================================
// Main update loop
// ============================================================================

let lastSunUpdateMinute = -1;

function tick(): void {
    updateTimeDisplay();

    // Update expression evaluator (live, every tick)
    if (lastExprText) {
        updateExpressionEvaluator();
    }

    // Update sunrise/sunset only when the minute changes (they're daily values)
    const now = getNow();
    const currentMinute = now.getMinutes();
    if (currentMinute !== lastSunUpdateMinute) {
        lastSunUpdateMinute = currentMinute;
        updateSunData();
    }

    requestAnimationFrame(tick);
}

// Initial update
updateSunData();
updateTimeDisplay();
requestAnimationFrame(tick);

console.log('[Inspector] Initialized — lat:', lat, 'lon:', lon, 'tz:', locationTimezone);
