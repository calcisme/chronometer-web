/**
 * Face data for Basel — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/basel/Basel-I.xml';
import faceBackUrl from '../watch/assets/basel/faceBack-4x.png';
import zodiacUrl from '../watch/assets/basel/zodiac-4x.png';
import dateRingUrl from '../watch/assets/basel/dateRing-4x.png';
import moonUrl from '../watch/assets/basel/moon25-4x.png';
import nodeUrl from '../watch/assets/basel/Node-4x.png';
import berryUrl from '../watch/assets/basel/berry-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Basel',
    urlAbbrev: 'bs',
    xml,
    images: {
        'faceBack.png':           { dataUrl: faceBackUrl, scale: 0.25 },
        'zodiac.png':             { dataUrl: zodiacUrl, scale: 0.25 },
        'dateRing.png':           { dataUrl: dateRingUrl, scale: 0.25 },
        'moon25.png':             { dataUrl: moonUrl, scale: 0.25 },
        'Node.png':               { dataUrl: nodeUrl, scale: 0.25 },
        '../partsBin/berry.png':  { dataUrl: berryUrl, scale: 0.25 },
    },
});
