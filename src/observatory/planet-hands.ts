/**
 * Observatory planet hand rendering.
 *
 * Draws planet icon images rotated to their heliocentric longitude on the
 * concentric orbit circles of the orrery dial.
 *
 * Port of:
 *   EOHandImageView.mm  — image drawing
 *   EOHandView.mm L353–373 — angle computation per planet kind
 *   EOClock.mm L1983–1997 — planet configuration (radii, images)
 *
 * Planet hands are dynamic — they update hourly (planetUpdate=3600s).
 * The Moon is a sub-hand of Earth, offset from the Earth hand by its
 * moon age angle + π (matching iOS: angle = -moonAgeAngle() + π).
 *
 * Uses 'lighten' compositing for all planet images since the PNGs
 * have opaque black backgrounds (RGB, no alpha channel).
 */

import type { LayoutParams } from './layout.js';
import type { ObsValueSet } from './obs-values.js';
import { ECPlanetNumber } from '../astronomy/astro-constants.js';

// Image asset imports (bundled as data URLs by esbuild)
import saturnPng from '../../.observatory-ref/Resources/saturn.png';
import jupiterPng from '../../.observatory-ref/Resources/jupiter.png';
import marsPng from '../../.observatory-ref/Resources/mars.png';
import earthPng from '../../.observatory-ref/Resources/earth.png';
import venusPng from '../../.observatory-ref/Resources/venus.png';
import mercuryPng from '../../.observatory-ref/Resources/mercury.png';
import moonPng from '../../.observatory-ref/Resources/moon75.png';

// ---------------------------------------------------------------------------
// Image loading
// ---------------------------------------------------------------------------

interface PlanetConfig {
    planet: ECPlanetNumber;
    /** Orbit index from outermost (0=Saturn at plR2, 1=Jupiter at plR2-orbitInc, ...) */
    orbitIndex: number;
    src: string;
    img: HTMLImageElement | null;
}

/**
 * Moon hand config — special: it orbits the Earth hand as a sub-view.
 * iOS: moonHand = initWithKind:EOMoon name:"moon75.png" x:earthHand.width/2 y:-earthHand.length/2 radius:22
 */
interface MoonConfig {
    src: string;
    img: HTMLImageElement | null;
    /** Radius from Earth center to Moon center (iOS: 22) */
    moonOrbitRadius: number;
}

const planets: PlanetConfig[] = [
    { planet: ECPlanetNumber.Saturn,  orbitIndex: 0, src: saturnPng,  img: null },
    { planet: ECPlanetNumber.Jupiter, orbitIndex: 1, src: jupiterPng, img: null },
    { planet: ECPlanetNumber.Mars,    orbitIndex: 2, src: marsPng,    img: null },
    { planet: ECPlanetNumber.Earth,   orbitIndex: 3, src: earthPng,   img: null },
    { planet: ECPlanetNumber.Venus,   orbitIndex: 4, src: venusPng,   img: null },
    { planet: ECPlanetNumber.Mercury, orbitIndex: 5, src: mercuryPng, img: null },
];

const moonConfig: MoonConfig = {
    src: moonPng,
    img: null,
    moonOrbitRadius: 22,
};

let imagesLoaded = false;

function loadPlanetImages(): Promise<void> {
    if (imagesLoaded) return Promise.resolve();

    const promises: Promise<void>[] = [];

    for (const p of planets) {
        p.img = new Image();
        const img = p.img;
        promises.push(new Promise<void>((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => { console.warn(`[PlanetHands] Failed to load planet image: ${p.planet}`); resolve(); };
        }));
        p.img.src = p.src;
    }

    moonConfig.img = new Image();
    const moonImg = moonConfig.img;
    promises.push(new Promise<void>((resolve) => {
        moonImg.onload = () => resolve();
        moonImg.onerror = () => { console.warn('[PlanetHands] Failed to load moon75.png'); resolve(); };
    }));
    moonConfig.img.src = moonConfig.src;

    return Promise.all(promises).then(() => { imagesLoaded = true; });
}

// Start loading on import
const imageLoadPromise = loadPlanetImages();

/**
 * Returns a promise that resolves when planet images are loaded.
 */
export function waitForPlanetImages(): Promise<void> {
    return imageLoadPromise;
}



// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Map from ECPlanetNumber to ObsValueSet field name. */
const planetValueMap: { planet: ECPlanetNumber; key: keyof ObsValueSet }[] = [
    { planet: ECPlanetNumber.Saturn,  key: 'saturnHand' },
    { planet: ECPlanetNumber.Jupiter, key: 'jupiterHand' },
    { planet: ECPlanetNumber.Mars,    key: 'marsHand' },
    { planet: ECPlanetNumber.Earth,   key: 'earthHand' },
    { planet: ECPlanetNumber.Venus,   key: 'venusHand' },
    { planet: ECPlanetNumber.Mercury, key: 'mercuryHand' },
];

export function drawPlanetHands(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    vs: ObsValueSet,
): void {
    if (!imagesLoaded) return;

    const cx = L.mainCX;
    const cy = L.mainCY;

    for (const p of planets) {
        const img = p.img;
        if (!img || !img.complete) continue;

        // Look up the pre-computed angle from ObsValueSet
        const mapping = planetValueMap.find(m => m.planet === p.planet);
        const angle = mapping ? (vs[mapping.key] as { currentValue: number }).currentValue : 0;

        // Orbit radius: plR2 - orbitIndex * orbitInc (matching iOS L1983-1997)
        const orbitR = L.plR2 - p.orbitIndex * L.orbitInc;

        ctx.save();
        ctx.translate(cx, cy);

        // iOS: the view's layer transform is a rotation by `angle`,
        // and the image is drawn at y=+radius (downward from center in UIKit).
        // Since we draw at +orbitR (downward), we add π to keep the planet
        // at the same angular position on the dial while the image is right-side-up.
        ctx.rotate(angle + Math.PI);

        // Image size: use natural image dimensions, scaled proportionally
        const s = L.mainR / 365;
        const imgW = img.naturalWidth * s;
        const imgH = img.naturalHeight * s;

        // iOS: [img drawInRect:CGRectMake(-width/2, radius-length/2, width, length)]
        // In UIKit Y-down, this draws the image centered at +radius (downward
        // from the rotation center). Canvas is also Y-down, so we draw at
        // +orbitR to match iOS exactly. The scale(-1,1) corrects for the
        // tangential mirror introduced by the π rotation offset.
        ctx.scale(-1, 1);
        ctx.globalCompositeOperation = 'lighten';
        ctx.drawImage(img, -imgW / 2, orbitR - imgH / 2, imgW, imgH);

        // Draw Moon sub-hand if this is Earth
        if (p.planet === ECPlanetNumber.Earth) {
            drawMoonSubHand(ctx, L, s, orbitR, vs.moonOffset.currentValue);
        }

        // Reset compositing before restore
        ctx.globalCompositeOperation = 'source-over';
        ctx.restore();
    }
}

/**
 * Draw the Moon as a sub-hand of Earth.
 *
 * iOS: moonHand is a child view of earthHand, initialized with:
 *   kind=EOMoon, x=earthHand.width/2, y=-earthHand.length/2, radius=22
 * Moon angle = -moonAgeAngle() + π
 *
 * The Moon orbits the Earth icon at a small radius (22 iOS px).
 *
 * Context state when called: already translated to dial center,
 * rotated to the Earth's heliocentric longitude.
 */
function drawMoonSubHand(
    ctx: CanvasRenderingContext2D,
    L: LayoutParams,
    s: number,
    earthOrbitR: number,
    moonAngle: number,
): void {
    const moonImg = moonConfig.img;
    if (!moonImg || !moonImg.complete) return;

    const moonR = moonConfig.moonOrbitRadius * s;
    const moonW = moonImg.naturalWidth * s;
    const moonH = moonImg.naturalHeight * s;

    ctx.save();

    // Move to the Earth position on its orbit (positive Y = downward, matching iOS)
    ctx.translate(0, earthOrbitR);

    // Rotate by the Moon's angle (relative to Earth).
    // Negated to compensate for the inherited scale(-1,1) from Earth's context,
    // which mirrors the rotation direction.
    ctx.rotate(-moonAngle);

    // Draw moon image at moonOrbitRadius offset (positive Y, matching iOS)
    // scale(-1,1) undoes the inherited X-flip from the Earth drawing context.
    ctx.scale(-1, 1);
    ctx.globalCompositeOperation = 'lighten';
    ctx.drawImage(moonImg, -moonW / 2, moonR - moonH / 2, moonW, moonH);

    ctx.restore();
}
