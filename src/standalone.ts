/**
 * Standalone entry point — embeds the Haleakala XML at build time
 * so no fetch() is needed. Works from file:// protocol.
 */

// esbuild imports this as a string with --loader:.xml=text
import haleakalaXML from './watch/__tests__/fixtures/Haleakala.xml';
import { parseWatchXML } from './watch/xml-parser.js';
import { createWatchEnvironment } from './watch/watch-env.js';
import { buildStaticCache, renderFrame } from './watch/renderer.js';
import { loadWatchImages } from './watch/image-loader.js';
import { initHandStates, tickAnimations } from './watch/animation.js';

// Default observer location: Steve's house
const DEFAULT_LAT = 37.205;
const DEFAULT_LON = -121.954;

/**
 * Request the user's location from the browser.
 * Returns { lat, lon } in degrees, or null if unavailable/denied.
 */
function requestLocation(): Promise<{ lat: number; lon: number } | null> {
    if (!navigator.geolocation) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        navigator.geolocation.getCurrentPosition(
            (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
            () => resolve(null),   // denied or error → fall back to default
            { timeout: 5000 },
        );
    });
}

async function main() {
    const canvas = document.getElementById('watch') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.error('Could not get canvas 2d context');
        return;
    }

    // Location UI elements
    const latInput = document.getElementById('lat-input') as HTMLInputElement;
    const lonInput = document.getElementById('lon-input') as HTMLInputElement;
    const sourceLabel = document.getElementById('location-source')!;

    // Request user location (falls back to default if unavailable)
    const loc = await requestLocation();
    let lat: number, lon: number;
    if (loc) {
        lat = loc.lat;
        lon = loc.lon;
        sourceLabel.textContent = '(from browser)';
    } else {
        lat = DEFAULT_LAT;
        lon = DEFAULT_LON;
        sourceLabel.textContent = "(Steve's house)";
    }

    // Populate inputs
    latInput.value = lat.toFixed(3);
    lonInput.value = lon.toFixed(3);

    // Parse for front side only
    const watch = parseWatchXML(haleakalaXML, 'front');

    // Load watch face images
    const images = await loadWatchImages();

    // Scale: Haleakala is designed for ~290px diameter (r=143),
    // so scale to fit the canvas
    const scale = canvas.width / 290;

    // --- Mutable state that gets rebuilt on location change ---
    let env = createWatchEnvironment(watch, lat, lon);
    let staticCache = buildStaticCache(
        watch, env, canvas.width, canvas.height, scale, images,
    );
    let handStates = initHandStates(watch, env, performance.now());

    // Rebuild watch when location changes
    function rebuildForLocation(newLat: number, newLon: number) {
        // Re-parse to get a fresh part tree (clears old dynamicState)
        const freshWatch = parseWatchXML(haleakalaXML, 'front');
        // Copy fresh parts into our watch object so renderer references stay valid
        watch.parts = freshWatch.parts;
        watch.initExprs = freshWatch.initExprs;

        env = createWatchEnvironment(watch, newLat, newLon);
        staticCache = buildStaticCache(
            watch, env, canvas.width, canvas.height, scale, images,
        );
        handStates = initHandStates(watch, env, performance.now());
    }

    // Handle input changes (on Enter or blur)
    function onLocationChange() {
        const newLat = parseFloat(latInput.value);
        const newLon = parseFloat(lonInput.value);
        if (isNaN(newLat) || isNaN(newLon)) return;
        sourceLabel.textContent = '(manual)';
        rebuildForLocation(newLat, newLon);
    }

    latInput.addEventListener('change', onLocationChange);
    lonInput.addEventListener('change', onLocationChange);

    // Animation loop
    function tick() {
        const now = performance.now();
        tickAnimations(handStates, env, now);
        renderFrame(ctx!, staticCache, watch, env, scale);
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

// Run when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(console.error));
} else {
    main().catch(console.error);
}
