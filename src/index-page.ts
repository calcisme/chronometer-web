/**
 * Index page logic for Emerald Chronometer.
 *
 * Built by esbuild as an IIFE — no ES modules needed.
 * Handles:
 *   - URL state management (lat/lon/city propagation to face links)
 *   - Browser geolocation check
 *   - Full location dialog with city search, globe, and OSM map
 */

import { loadCityData, searchCities, isCityDataLoaded, loadError } from './city-search.js';
import type { CityResult } from './city-search.js';
import { renderGlobe, loadOSMTile } from './mini-map.js';

// ============================================================================
// Constants
// ============================================================================

const DEMO_LAT = 37.3349;   // Apple Park, Cupertino
const DEMO_LON = -122.0090;

const isFileProtocol = window.location.protocol === 'file:';

// Preload city database in the background so it's ready when the user
// opens the location dialog. Fire-and-forget — errors are silently
// ignored here since loadCityData() will report them on actual use.
loadCityData().catch(() => {});

// ============================================================================
// URL state helpers
// ============================================================================

function readUrlState(): { lat: number | null; lon: number | null; city: string | null; bloc: boolean } {
    const params = new URLSearchParams(window.location.search);
    const latStr = params.get('lat');
    const lonStr = params.get('lon') || params.get('long');
    return {
        lat: latStr !== null && !isNaN(parseFloat(latStr)) ? parseFloat(latStr) : null,
        lon: lonStr !== null && !isNaN(parseFloat(lonStr)) ? parseFloat(lonStr) : null,
        city: params.get('city'),
        bloc: params.get('bloc') === '1',
    };
}

function writeUrlState(changes: { lat?: number | null; lon?: number | null; city?: string | null; bloc?: boolean }) {
    const params = new URLSearchParams(window.location.search);
    if ('lat' in changes) {
        if (changes.lat != null) params.set('lat', changes.lat.toFixed(3));
        else params.delete('lat');
    }
    if ('lon' in changes) {
        if (changes.lon != null) params.set('lon', changes.lon.toFixed(3));
        else params.delete('lon');
    }
    if ('city' in changes) {
        if (changes.city) params.set('city', changes.city);
        else params.delete('city');
    }
    if ('bloc' in changes) {
        if (changes.bloc) params.set('bloc', '1');
        else params.delete('bloc');
    }
    params.delete('long'); params.delete('loc');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
}

/** Update all face-card links to include the current URL search params. */
function updateLinks() {
    const search = window.location.search;
    document.querySelectorAll('a.face-card').forEach(a => {
        const baseHref = a.getAttribute('data-base-href') || a.getAttribute('href')!;
        if (!a.hasAttribute('data-base-href')) a.setAttribute('data-base-href', baseHref);
        const url = new URL(baseHref, window.location.href);
        url.search = search;
        (a as HTMLAnchorElement).href = url.toString();
    });
}

// ============================================================================
// Geolocation
// ============================================================================

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
// Location dialog
// ============================================================================

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
const lpMapLabel = document.getElementById('lp-map-label')!;
const lpDoneBtn = document.getElementById('lp-done')!;

let hasLocation = false;  // tracks whether a valid location has been set

function showPrompt(geoDenied: boolean) {
    locationPrompt.style.display = '';
    if (geoDenied) {
        (lpUseBrowser as HTMLButtonElement).disabled = true;
        lpUseBrowser.dataset.tooltip = isFileProtocol
            ? 'Not all browsers support location access from file:// URLs'
            : 'Browser location was not granted — check your browser settings to allow it';
        lpUseBrowser.textContent = 'Use browser location (unavailable)';
    }
    // Show the map with demo location initially
    updateMapPreview(DEMO_LAT, DEMO_LON, 'Cupertino, CA');
}

function hidePrompt() {
    locationPrompt.style.display = 'none';
}

function updateMapPreview(mapLat: number, mapLon: number, label: string) {
    renderGlobe(lpGlobe, mapLat, mapLon);
    if (isFileProtocol) {
        lpOsmContainer.style.display = 'none';
        lpGlobe.width = 160;
        lpGlobe.height = 160;
        lpGlobe.style.width = '160px';
        lpGlobe.style.height = '160px';
    } else {
        lpOsmContainer.style.display = '';
        lpOsmOffline.style.display = 'none';
        loadOSMTile(lpOsmContainer, lpOsmTile, lpMapMarker, mapLat, mapLon).then(ok => {
            lpOsmOffline.style.display = ok ? 'none' : '';
        });
    }
    lpMapLabel.textContent = label;
}

function applyLocation(newLat: number, newLon: number, source: string, writeToUrl: boolean) {
    hasLocation = true;
    if (writeToUrl) {
        writeUrlState({ lat: newLat, lon: newLon, city: source || null });
    }
    updateLinks();
    // Update the map preview if the dialog is still open
    if (locationPrompt.style.display !== 'none') {
        updateMapPreview(newLat, newLon, source);
        lpDoneBtn.style.display = '';
    }
}

// ============================================================================
// Button handlers
// ============================================================================

lpUseCoords.addEventListener('click', () => {
    const newLat = parseFloat(lpLatInput.value);
    const newLon = parseFloat(lpLonInput.value);
    if (isNaN(newLat) || isNaN(newLon)) return;
    applyLocation(newLat, newLon, '', true);
});

lpUseBrowser.addEventListener('click', async () => {
    lpUseBrowser.textContent = 'Requesting…';
    const loc = await requestBrowserLocation();
    lpUseBrowser.textContent = 'Use browser location';
    if (loc) {
        applyLocation(loc.lat, loc.lon, 'from browser', false);
        // Write bloc=1 and clear lat/lon/city so next reload asks browser again
        writeUrlState({ bloc: true, lat: null, lon: null, city: null });
        updateLinks();
    }
});

// Close prompt when clicking backdrop (only if we have a location)
locationPrompt.querySelector('.lp-backdrop')!.addEventListener('click', () => {
    if (hasLocation) hidePrompt();
});

// Close prompt with Escape key
document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && locationPrompt.style.display !== 'none') {
        if (hasLocation) hidePrompt();
    }
});

// Done button
lpDoneBtn.addEventListener('click', () => {
    hidePrompt();
});

// ============================================================================
// City search autocomplete
// ============================================================================

let citySearchDebounce: ReturnType<typeof setTimeout> | null = null;
let cityDataLoading = false;
let cityDataFailed = false;
let selectedCityIndex = -1;

function renderCityResults(results: CityResult[]) {
    lpCityResults.innerHTML = '';
    selectedCityIndex = -1;
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const div = document.createElement('div');
        div.className = 'lp-city-item';
        if (r.isAirport) {
            const parts = r.label.split('  ');
            div.innerHTML = `<span class="iata-tag">${parts[0]}</span>${parts.slice(1).join('  ')}`;
        } else {
            div.textContent = r.label;
        }
        div.addEventListener('click', () => {
            applyLocation(r.lat, r.lon, r.shortLabel, true);
            lpCityInput.value = '';
            lpCityResults.innerHTML = '';
            lpLatInput.value = r.lat.toFixed(3);
            lpLonInput.value = r.lon.toFixed(3);
        });
        lpCityResults.appendChild(div);
    }
}

async function onCityInput() {
    try {
        let query = lpCityInput.value.trim();
        if (query.length < 2) {
            lpCityResults.innerHTML = '';
            return;
        }

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
                query = lpCityInput.value.trim();
                if (query.length < 2) {
                    lpCityResults.innerHTML = '';
                    return;
                }
            } else {
                return;
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

lpCityInput.addEventListener('input', debounceCitySearch);
lpCityInput.addEventListener('keyup', debounceCitySearch);
lpCityInput.addEventListener('compositionend', debounceCitySearch);

lpCityInput.addEventListener('focus', () => {
    setTimeout(() => {
        lpCityInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
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

// ============================================================================
// Startup: check for existing location or prompt
// ============================================================================

(async function init() {
    const urlState = readUrlState();

    if (urlState.lat !== null && urlState.lon !== null) {
        hasLocation = true;
        updateLinks();
    } else if (urlState.bloc) {
        // bloc=1 set — ask browser for location without showing prompt
        const loc = await requestBrowserLocation();
        if (loc) {
            hasLocation = true;
            updateLinks();
        } else {
            // Browser denied — show prompt
            showPrompt(true);
            updateLinks();
        }
    } else {
        // No location and no bloc — show prompt
        showPrompt(false);
        updateLinks();
    }
})();
