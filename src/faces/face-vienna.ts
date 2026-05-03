/**
 * Face data for Vienna I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/vienna/Vienna-I.xml';
import faceUrl from '../watch/assets/vienna/face-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Vienna',
    urlAbbrev: 'vi',
    xml,
    images: {
        'face.png':                    { dataUrl: faceUrl, scale: 0.25 },
    },
});
