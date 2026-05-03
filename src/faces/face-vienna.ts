/**
 * Face data for Vienna I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/vienna/Vienna-I.xml';
import faceUrl from '../watch/assets/vienna/face-4x.png';
import blankerUrl from '../watch/assets/vienna/blanker-2x.png';
import logoUrl from '../watch/assets/parts-bin/logos/black-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Vienna',
    urlAbbrev: 'vi',
    xml,
    images: {
        'face.png':                    { dataUrl: faceUrl, scale: 0.25 },
        'blanker.png':                 { dataUrl: blankerUrl, scale: 0.5 },
        '../partsBin/logos/black.png': { dataUrl: logoUrl, scale: 0.25 },
    },
});
