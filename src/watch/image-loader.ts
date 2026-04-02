/**
 * Image loader for watch face assets.
 *
 * Maps XML `src` paths to actual image URLs. For standalone builds,
 * images are embedded as base64 data URLs via esbuild. For Vite dev
 * mode, they're served as regular URLs.
 *
 * All images are loaded asynchronously; the renderer receives a
 * Map<string, ImageBitmap> to draw from.
 */

// Import images — esbuild bundles these as base64 with --loader:.png=dataurl
// Vite similarly handles ?url imports
import faceUrl from './assets/haleakala/Haleakala-face-android.png';
import logoUrl from './assets/haleakala/logos-black-4x.png';
import bandUrl from './assets/haleakala/band-front-4x.png';
import caseUrl from './assets/haleakala/case-front-4x.png';

/**
 * Map from XML src paths to their imported URLs and scale factors.
 * The scale factor converts from image pixels to 1x coordinate units.
 * For 4x images, scale = 0.25 (draw at 1/4 size); for 1x, scale = 1.
 */
const IMAGE_MAP: Record<string, { url: string; scale: number }> = {
    // Builtin-Android Haleakala I face image (1x scale — same coordinate space as XML)
    'Haleakala-face.png':                                { url: faceUrl, scale: 1 },
    '../partsBin/logos/black.png':                        { url: logoUrl, scale: 0.25 },
    '../partsBin/HD/brown/front/straight/narrow/band.png': { url: bandUrl, scale: 0.25 },
    '../partsBin/HD/yellow/front/narrow/case.png':        { url: caseUrl, scale: 0.25 },
};

/** Loaded image with its scale factor */
export interface LoadedImage {
    bitmap: ImageBitmap;
    /** Scale from image pixels to 1x XML coordinate units */
    scale: number;
}

/**
 * Load all images for the Haleakala watch face.
 * Returns a Map keyed by the XML `src` path.
 */
export async function loadWatchImages(): Promise<Map<string, LoadedImage>> {
    const result = new Map<string, LoadedImage>();

    const entries = Object.entries(IMAGE_MAP);
    const loadPromises = entries.map(async ([src, { url, scale }]) => {
        try {
            const response = await fetch(url);
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
