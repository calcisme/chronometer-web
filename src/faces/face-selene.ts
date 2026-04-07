/**
 * Face data for Selene — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/selene/Selene-I.xml';
import seleneFaceUrl from '../watch/assets/selene/face-white-trim-4x.png';
import seleneMoonUrl from '../watch/assets/selene/moonES72-4x.png';
import phaseNUrl from '../watch/assets/selene/phaseN.png';
import phase1Url from '../watch/assets/selene/phase1.png';
import phase3Url from '../watch/assets/selene/phase3.png';
import phaseFUrl from '../watch/assets/selene/phaseF.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Selene',
    xml,
    images: {
        'face-white-trim.png':       { dataUrl: seleneFaceUrl, scale: 0.25 },
        '../partsBin/moonES72.png':   { dataUrl: seleneMoonUrl, scale: 0.25 },
        'phaseN.png':                { dataUrl: phaseNUrl, scale: 1 },
        'phase1.png':                { dataUrl: phase1Url, scale: 1 },
        'phase3.png':                { dataUrl: phase3Url, scale: 1 },
        'phaseF.png':                { dataUrl: phaseFUrl, scale: 1 },
    },
});
