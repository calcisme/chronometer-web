/**
 * Face data for Haleakalā — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/haleakala/Haleakala-android.xml';
import faceUrl from '../watch/assets/haleakala/Haleakala-face-android.png';
import logoUrl from '../watch/assets/haleakala/logos-black-4x.png';
import bandUrl from '../watch/assets/haleakala/band-front-4x.png';
import caseUrl from '../watch/assets/haleakala/case-front-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Haleakalā',
    urlAbbrev: 'hk',
    xml,
    images: {
        'Haleakala-face.png':                                { dataUrl: faceUrl, scale: 1 },
        '../partsBin/logos/black.png':                        { dataUrl: logoUrl, scale: 0.25 },
        '../partsBin/HD/brown/front/straight/narrow/band.png': { dataUrl: bandUrl, scale: 0.25 },
        '../partsBin/HD/yellow/front/narrow/case.png':        { dataUrl: caseUrl, scale: 0.25 },
    },
});
