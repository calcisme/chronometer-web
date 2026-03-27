/**
 * Standalone entry point — embeds the Haleakala XML at build time
 * so no fetch() is needed. Works from file:// protocol.
 */

// esbuild imports this as a string with --loader:.xml=text
import haleakalaXML from './watch/__tests__/fixtures/Haleakala.xml';
import { parseWatchXML } from './watch/xml-parser.js';
import { createWatchEnvironment } from './watch/watch-env.js';
import { renderWatch } from './watch/renderer.js';
import { loadWatchImages } from './watch/image-loader.js';

async function main() {
    const canvas = document.getElementById('watch') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.error('Could not get canvas 2d context');
        return;
    }

    // Parse for front side only
    const watch = parseWatchXML(haleakalaXML, 'front');

    // Create expression environment and evaluate init blocks
    const env = createWatchEnvironment(watch);

    // Load watch face images
    const images = await loadWatchImages();

    // Scale: Haleakala is designed for ~290px diameter (r=143),
    // so scale to fit the canvas
    const scale = canvas.width / 290;

    // Placeholder face background — lighter cream so gray subdials (0xffe0e0e0)
    // appear darker by contrast, matching the original Haleakala face image
    ctx.fillStyle = '#f0ead8';
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2, 0, 2 * Math.PI);
    ctx.fill();

    // Render the watch
    renderWatch(ctx, watch, env, scale, images);
}

// Run when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => main().catch(console.error));
} else {
    main().catch(console.error);
}
