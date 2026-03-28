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

    // Request user location (falls back to default if unavailable)
    const loc = await requestLocation();
    if (loc) {
        console.log(`Using browser location: ${loc.lat.toFixed(3)}°N, ${loc.lon.toFixed(3)}°`);
    } else {
        console.log('Geolocation unavailable — using default location');
    }

    // Parse for front side only
    const watch = parseWatchXML(haleakalaXML, 'front');

    // Create expression environment with observer location
    const env = loc
        ? createWatchEnvironment(watch, loc.lat, loc.lon)
        : createWatchEnvironment(watch);

    // Load watch face images
    const images = await loadWatchImages();

    // Scale: Haleakala is designed for ~290px diameter (r=143),
    // so scale to fit the canvas
    const scale = canvas.width / 290;

    // Build static cache (dials, images, text, windows — rendered once)
    const staticCache = buildStaticCache(
        watch, env, canvas.width, canvas.height, scale, images,
    );

    // Initialize animation state for all dynamic parts (hands + wheels)
    const handStates = initHandStates(watch, env, performance.now());

    // Animation loop:
    //   1. Tick animations — re-evaluate expressions at each part's update
    //      interval and interpolate toward new targets
    //   2. Render — blit static cache + draw hands at their animated angles
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
