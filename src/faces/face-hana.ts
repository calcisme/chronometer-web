/**
 * Face data for Hana — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/hana/Hana-I-android.xml';
import backFaceUrl from '../watch/assets/hana/Haleakala-back.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Hana',
    urlAbbrev: 'hn',
    xml,
    images: {
        'Haleakala-back.png': { dataUrl: backFaceUrl, scale: 1 },
    },
});
