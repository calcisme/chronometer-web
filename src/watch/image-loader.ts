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
import backFaceUrl from './assets/hana/Haleakala-back.png';
import logoUrl from './assets/haleakala/logos-black-4x.png';
import bandUrl from './assets/haleakala/band-front-4x.png';
import caseUrl from './assets/haleakala/case-front-4x.png';
import moonESUrl from './assets/chandra/moonES-4x.png';
import whiteLogoUrl from './assets/chandra/logos-white-4x.png';
import redStarUrl from './assets/chandra/redStar.png';
import blueStarUrl from './assets/chandra/blueStar.png';
// Selene assets
import seleneFaceUrl from './assets/selene/face-white-trim-4x.png';
import seleneMoonUrl from './assets/selene/moonES72-4x.png';
import phaseNUrl from './assets/selene/phaseN.png';
import phase1Url from './assets/selene/phase1.png';
import phase3Url from './assets/selene/phase3.png';
import phaseFUrl from './assets/selene/phaseF.png';

/**
 * Map from XML src paths to their imported URLs and scale factors.
 * The scale factor converts from image pixels to 1x coordinate units.
 * For 4x images, scale = 0.25 (draw at 1/4 size); for 1x, scale = 1.
 */
const IMAGE_MAP: Record<string, { url: string; scale: number }> = {
    // Builtin-Android Haleakala I face image (1x scale — same coordinate space as XML)
    'Haleakala-face.png':                                { url: faceUrl, scale: 1 },
    // Hana I face background — a light gray moon face
    'Haleakala-back.png':                                { url: backFaceUrl, scale: 1 },
    '../partsBin/logos/black.png':                        { url: logoUrl, scale: 0.25 },
    '../partsBin/HD/brown/front/straight/narrow/band.png': { url: bandUrl, scale: 0.25 },
    '../partsBin/HD/yellow/front/narrow/case.png':        { url: caseUrl, scale: 0.25 },
    // Chandra assets
    '../partsBin/moonES.png':                             { url: moonESUrl, scale: 0.25 },
    '../partsBin/logos/white.png':                         { url: whiteLogoUrl, scale: 0.25 },
    'redStar.png':                                        { url: redStarUrl, scale: 1 },
    'blueStar.png':                                       { url: blueStarUrl, scale: 1 },
    // Selene assets (4x images)
    'face-white-trim.png':                                { url: seleneFaceUrl, scale: 0.25 },
    '../partsBin/moonES72.png':                           { url: seleneMoonUrl, scale: 0.25 },
    'phaseN.png':                                         { url: phaseNUrl, scale: 1 },
    'phase1.png':                                         { url: phase1Url, scale: 1 },
    'phase3.png':                                         { url: phase3Url, scale: 1 },
    'phaseF.png':                                         { url: phaseFUrl, scale: 1 },
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
