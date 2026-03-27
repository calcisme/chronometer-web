/**
 * Main entry point — loads and renders Haleakala watch face.
 */

import { parseWatchXML } from './watch/xml-parser.js';
import { createWatchEnvironment } from './watch/watch-env.js';
import { renderWatch } from './watch/renderer.js';

async function main() {
    const canvas = document.getElementById('watch') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        console.error('Could not get canvas 2d context');
        return;
    }

    // Fetch the Haleakala XML (served as a static file by Vite)
    const response = await fetch('/src/watch/__tests__/fixtures/Haleakala.xml');
    const xmlText = await response.text();

    // Parse for front side only
    const watch = parseWatchXML(xmlText, 'front');

    // Create expression environment and evaluate init blocks
    const env = createWatchEnvironment(watch);

    // Scale: Haleakala is designed for ~290px diameter (r=143),
    // so scale to fit the 640px canvas
    const scale = canvas.width / 290;

    // Draw a dark background circle as the watch face base
    ctx.fillStyle = '#f0ead8';
    ctx.beginPath();
    ctx.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2, 0, 2 * Math.PI);
    ctx.fill();

    // Render the watch
    renderWatch(ctx, watch, env, scale);
}

main().catch(console.error);
