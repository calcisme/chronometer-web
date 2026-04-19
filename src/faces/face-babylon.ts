/**
 * Face data for Babylon I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/babylon/Babylon-I.xml';
import roseFaceUrl from '../watch/assets/parts-bin/rose-face-4x.png';
import moonUrl from '../watch/assets/parts-bin/moonES80-4x.png';
import logoUrl from '../watch/assets/parts-bin/logos/black-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Babylon',
    xml,
    images: {
        '../partsBin/HD/rose/face.png': { dataUrl: roseFaceUrl, scale: 0.25 },
        '../partsBin/moonES80.png':     { dataUrl: moonUrl, scale: 0.25 },
        '../partsBin/logos/black.png':  { dataUrl: logoUrl, scale: 0.25 },
    },
});
