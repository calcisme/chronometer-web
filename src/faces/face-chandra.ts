/**
 * Face data for Chandra — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/chandra/Chandra-I-android.xml';
import moonESUrl from '../watch/assets/chandra/moonES-4x.png';
import whiteLogoUrl from '../watch/assets/chandra/logos-white-4x.png';
import redStarUrl from '../watch/assets/chandra/redStar.png';
import blueStarUrl from '../watch/assets/chandra/blueStar.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Chandra',
    urlAbbrev: 'ch',
    xml,
    images: {
        '../partsBin/moonES.png':     { dataUrl: moonESUrl, scale: 0.25 },
        '../partsBin/logos/white.png': { dataUrl: whiteLogoUrl, scale: 0.25 },
        'redStar.png':                { dataUrl: redStarUrl, scale: 1 },
        'blueStar.png':               { dataUrl: blueStarUrl, scale: 1 },
    },
});
