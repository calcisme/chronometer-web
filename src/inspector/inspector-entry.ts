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
import { initLocationDialog, requestBrowserLocation } from '../shared/location-dialog.js';
import { dateToDateInterval } from '../astronomy/es-time.js';
import { planetaryRiseSetTimeRefined } from '../astronomy/es-riseset.js';
import { ECPlanetNumber, isNoRiseSet } from '../astronomy/astro-constants.js';
import { AstroCachePool, initializeCachePool, releaseCachePool } from '../astronomy/astro-cache.js';
import { EXPR_METADATA, CATEGORY_ORDER, type ExprEntry } from './expr-metadata.js';

// ============================================================================
// Initialization
// ============================================================================

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
const tzDisplay = document.getElementById('tz-display')!;

// --- Resolve location from URL params ---
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

/** Format timezone abbreviation and UTC offset, e.g. "(PDT) UTC-7:00". */
function formatTimezoneInfo(olsonId: string | undefined, referenceDate?: Date): string {
    if (!olsonId) return '';
    try {
        const ref = referenceDate || new Date();
        // Get short abbreviation like "PDT", "EST"
        const shortFmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonId,
            timeZoneName: 'short',
        });
        const shortParts = shortFmt.formatToParts(ref);
        const abbr = shortParts.find(p => p.type === 'timeZoneName')?.value || '';

        // Get UTC offset like "GMT-07:00"
        const longFmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonId,
            timeZoneName: 'longOffset',
        });
        const longParts = longFmt.formatToParts(ref);
        const offsetStr = longParts.find(p => p.type === 'timeZoneName')?.value || '';
        // Convert "GMT-07:00" to "UTC-7:00", "GMT+05:30" to "UTC+5:30", "GMT" to "UTC"
        let utcStr = offsetStr.replace('GMT', 'UTC');
        // Remove leading zero: UTC-07:00 → UTC-7:00, UTC+05:30 → UTC+5:30
        utcStr = utcStr.replace(/([+-])0(\d)/, '$1$2');

        return `(${abbr})\u00a0${utcStr}`;
    } catch {
        return '';
    }
}

// Display location
function updateLocationDisplay(): void {
    if (lat === 0 && lon === 0 && needsPrompt) {
        locationName.textContent = 'No location set';
        locationDetail.textContent = 'Use the Set button to choose a location';
        return;
    }
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
    const tzInfo = formatTimezoneInfo(locationTimezone);
    const tzDisplayStr = locationTimezone || 'Browser TZ';
    const detail = tzInfo
        ? `${lat.toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}  ·  ${tzDisplayStr} ${tzInfo}`
        : `${lat.toFixed(3)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}° ${lon >= 0 ? 'E' : 'W'}  ·  ${tzDisplayStr}`;
    locationDetail.textContent = detail;
}
updateLocationDisplay();

// --- Location dialog (shared module) ---
const locationDialog = initLocationDialog({
    initialLat: lat,
    initialLon: lon,
    needsPrompt,
    onLocationChange: (info) => {
        // Update our location state
        lat = info.lat;
        lon = info.lon;
        locationTimezone = info.timezone;
        tzDeltaMs = computeTzDeltaMs(locationTimezone);
        needsPrompt = false;

        // Write to URL so the location persists on reload
        if (info.sourceType === 'browser') {
            // For browser location, use bloc=1 so next reload re-asks
            writeUrlState({ bloc: true, lat: null, lon: null, city: null, tz: null });
        } else {
            writeUrlState({ lat: info.lat, lon: info.lon, city: info.source || null, tz: info.timezone || null });
        }

        // Rebuild the astronomy environment with new location
        env = createAstroEnvironment(lat, lon, getNow, locationTimezone);

        // Refresh all displays
        updateLocationDisplay();
        lastSunUpdateMinute = -1;  // force sunrise/sunset recalc
        updateSunData();
        updateTimeDisplay();
    },
});

if (locationDialog) {
    setLocationBtn.addEventListener('click', () => {
        locationDialog.show();
    });

    // Auto-show the location dialog on first visit (no URL location)
    if (needsPrompt) {
        locationDialog.show();
    }

    // Handle bloc=1: request browser location on startup
    if (urlState.bloc && !hasUrlLocation) {
        requestBrowserLocation(10000).then(result => {
            if (result.status === 'success') {
                // Apply via the same path as the dialog's onLocationChange
                const tz = resolveTimezone(result.lat, result.lon, null);
                lat = result.lat;
                lon = result.lon;
                locationTimezone = tz;
                tzDeltaMs = computeTzDeltaMs(locationTimezone);
                needsPrompt = false;
                locationDialog.updateState(lat, lon, 'browser', '', '');
                env = createAstroEnvironment(lat, lon, getNow, locationTimezone);
                updateLocationDisplay();
                lastSunUpdateMinute = -1;
                updateSunData();
                updateTimeDisplay();
            } else {
                // Browser denied or timed out — show location prompt
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
    tzDisplay.textContent = formatTimezoneInfo(locationTimezone, now);
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
            if (locationTimezone) {
                try {
                    const fmt = new Intl.DateTimeFormat('en-US', {
                        timeZone: locationTimezone,
                        year: 'numeric', month: '2-digit', day: '2-digit',
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                        hour12: false,
                    });
                    const tzAbbr = new Intl.DateTimeFormat('en-US', {
                        timeZone: locationTimezone,
                        timeZoneName: 'short',
                    }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || '';
                    exprDate.textContent = `${fmt.format(d)} ${tzAbbr}`;
                } catch {
                    exprDate.textContent = d.toISOString().replace('T', ' ').replace('Z', ' UTC');
                }
            } else {
                exprDate.textContent = d.toISOString().replace('T', ' ').replace('Z', ' UTC');
            }
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
exprInput.addEventListener('input', () => {
    updateExpressionEvaluator();
    updateAutocomplete();
});

// ============================================================================
// Autocomplete
// ============================================================================

const acDropdown = document.getElementById('expr-autocomplete')!;
let acItems: ExprEntry[] = [];
let acSelectedIdx = -1;

/** Extract the word fragment at the cursor for autocomplete matching. */
function getWordAtCursor(): { word: string; start: number; end: number } {
    const pos = exprInput.selectionStart ?? exprInput.value.length;
    const text = exprInput.value;
    // Walk backward from cursor to find word start
    let start = pos;
    while (start > 0 && /[a-zA-Z0-9_]/.test(text[start - 1])) start--;
    // Walk forward from cursor to find word end
    let end = pos;
    while (end < text.length && /[a-zA-Z0-9_]/.test(text[end])) end++;
    return { word: text.slice(start, pos), start, end };
}

/** Build the merged list of completions from metadata + env keys. */
function getAllCompletions(): ExprEntry[] {
    // Start with curated metadata
    const seen = new Set(EXPR_METADATA.map(e => e.name));
    const extras: ExprEntry[] = [];
    // Add any env functions not in metadata
    if (env) {
        for (const name of env.functions.keys()) {
            if (!seen.has(name)) {
                extras.push({ name, category: 'Other', desc: '', kind: 'fn' });
                seen.add(name);
            }
        }
        for (const name of env.variables.keys()) {
            if (!seen.has(name)) {
                extras.push({ name, category: 'Other', desc: '', kind: 'const' });
                seen.add(name);
            }
        }
    }
    return [...EXPR_METADATA, ...extras];
}

function updateAutocomplete(): void {
    const { word } = getWordAtCursor();
    if (word.length < 2) {
        acDropdown.classList.remove('visible');
        acItems = [];
        return;
    }
    const lc = word.toLowerCase();
    const all = getAllCompletions();
    // Filter: prefix match first, then substring match
    const prefixMatches = all.filter(e => e.name.toLowerCase().startsWith(lc));
    const subMatches = all.filter(e => !e.name.toLowerCase().startsWith(lc) && e.name.toLowerCase().includes(lc));
    acItems = [...prefixMatches, ...subMatches].slice(0, 20);

    if (acItems.length === 0 || (acItems.length === 1 && acItems[0].name.toLowerCase() === lc)) {
        acDropdown.classList.remove('visible');
        acItems = [];
        return;
    }

    acSelectedIdx = -1;
    renderAutocomplete();
    acDropdown.classList.add('visible');
}

function renderAutocomplete(): void {
    acDropdown.innerHTML = acItems.map((entry, i) => {
        const kindClass = entry.kind === 'fn' ? 'fn' : 'const';
        const kindLabel = entry.kind === 'fn' ? 'fn' : 'var';
        const sig = entry.kind === 'fn' ? (entry.sig || '()') : '';
        const selected = i === acSelectedIdx ? ' selected' : '';
        return `<div class="ac-item${selected}" data-idx="${i}">
            <span class="ac-kind ${kindClass}">${kindLabel}</span>
            <span class="ac-name">${entry.name}</span>
            <span class="ac-sig">${sig}</span>
            <span class="ac-desc">${entry.desc}</span>
        </div>`;
    }).join('');
}

function acceptAutocomplete(idx: number): void {
    const entry = acItems[idx];
    if (!entry) return;
    const { start, end } = getWordAtCursor();
    const text = exprInput.value;
    let insert = entry.name;
    if (entry.kind === 'fn') {
        insert += entry.sig || '()';
    }
    exprInput.value = text.slice(0, start) + insert + text.slice(end);
    // Place cursor: inside parens if fn with args, after everything otherwise
    const cursorPos = entry.kind === 'fn' && entry.sig && entry.sig !== '()'
        ? start + entry.name.length + 1  // after '('
        : start + insert.length;
    exprInput.setSelectionRange(cursorPos, cursorPos);
    acDropdown.classList.remove('visible');
    acItems = [];
    updateExpressionEvaluator();
}

// Keyboard navigation for autocomplete
exprInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!acDropdown.classList.contains('visible')) return;
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        acSelectedIdx = Math.min(acSelectedIdx + 1, acItems.length - 1);
        renderAutocomplete();
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        acSelectedIdx = Math.max(acSelectedIdx - 1, 0);
        renderAutocomplete();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (acSelectedIdx >= 0) {
            e.preventDefault();
            acceptAutocomplete(acSelectedIdx);
        }
    } else if (e.key === 'Escape') {
        acDropdown.classList.remove('visible');
        acItems = [];
    }
});

// Click on autocomplete item
acDropdown.addEventListener('mousedown', (e: MouseEvent) => {
    e.preventDefault(); // keep focus on input
    const item = (e.target as HTMLElement).closest('.ac-item') as HTMLElement;
    if (item) {
        const idx = parseInt(item.dataset.idx!, 10);
        acceptAutocomplete(idx);
    }
});

// Close autocomplete when input loses focus
exprInput.addEventListener('blur', () => {
    // Delay to allow click events on dropdown items
    setTimeout(() => {
        acDropdown.classList.remove('visible');
        acItems = [];
    }, 150);
});

// ============================================================================
// Reference Panel
// ============================================================================

const refToggle = document.getElementById('ref-toggle')!;
const refPanel = document.getElementById('ref-panel')!;

function buildReferencePanel(): void {
    const all = getAllCompletions();
    // Group by category
    const groups = new Map<string, ExprEntry[]>();
    for (const entry of all) {
        const cat = entry.category;
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat)!.push(entry);
    }

    // Sort categories by CATEGORY_ORDER, then alphabetical for unlisted
    const catOrder = [...CATEGORY_ORDER];
    for (const cat of groups.keys()) {
        if (!catOrder.includes(cat)) catOrder.push(cat);
    }

    let html = '';
    for (const cat of catOrder) {
        const entries = groups.get(cat);
        if (!entries || entries.length === 0) continue;
        html += `<div class="ref-category">`;
        html += `<div class="ref-cat-header"><span class="ref-cat-arrow">▶</span> ${cat} <span style="color:#4b5563;font-weight:400">(${entries.length})</span></div>`;
        html += `<div class="ref-cat-body">`;
        for (const entry of entries) {
            const sig = entry.kind === 'fn' ? (entry.sig || '()') : '';
            html += `<div class="ref-item" data-name="${entry.name}" data-kind="${entry.kind}" data-sig="${entry.sig || ''}">`;
            html += `<span class="ref-item-name">${entry.name}${sig}</span>`;
            html += `<span class="ref-item-desc">${entry.desc}</span>`;
            html += `</div>`;
        }
        html += `</div></div>`;
    }
    refPanel.innerHTML = html;

    // Category toggle
    refPanel.querySelectorAll('.ref-cat-header').forEach(header => {
        header.addEventListener('click', () => {
            header.parentElement!.classList.toggle('open');
        });
    });

    // Click to insert
    refPanel.querySelectorAll('.ref-item').forEach(item => {
        item.addEventListener('click', () => {
            const el = item as HTMLElement;
            const name = el.dataset.name!;
            const kind = el.dataset.kind!;
            const sig = el.dataset.sig || '';
            let insert = name;
            if (kind === 'fn') {
                insert += sig || '()';
            }
            // Append to current input (or replace if empty)
            if (exprInput.value.trim() === '') {
                exprInput.value = insert;
            } else {
                // Insert at cursor
                const pos = exprInput.selectionStart ?? exprInput.value.length;
                const text = exprInput.value;
                exprInput.value = text.slice(0, pos) + insert + text.slice(pos);
            }
            const cursorPos = kind === 'fn' && sig && sig !== '()'
                ? exprInput.value.indexOf(insert) + name.length + 1
                : exprInput.value.indexOf(insert) + insert.length;
            exprInput.setSelectionRange(cursorPos, cursorPos);
            exprInput.focus();
            updateExpressionEvaluator();
        });
    });
}

refToggle.addEventListener('click', () => {
    const isOpen = refPanel.classList.toggle('visible');
    refToggle.classList.toggle('active', isOpen);
    if (isOpen && refPanel.innerHTML === '') {
        buildReferencePanel();
    }
});

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
