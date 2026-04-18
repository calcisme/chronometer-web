/**
 * Face data for Gaia I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/gaia/Gaia-I.xml';
import faceUrl from '../watch/assets/gaia/face-4x.png';
import gridUrl from '../watch/assets/gaia/holeyLatLongGrid-4x.png';
import berryUrl from '../watch/assets/parts-bin/berry-4x.png';
import moonUrl from '../watch/assets/parts-bin/moonES28-4x.png';
import roseDial104Url from '../watch/assets/parts-bin/rose-dial104-4x.png';
import roseDial158Url from '../watch/assets/parts-bin/rose-dial158-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Gaia',
    xml,
    images: {
        'face.png':              { dataUrl: faceUrl, scale: 0.25 },
        'holeyLatLongGrid.png':  { dataUrl: gridUrl, scale: 0.25 },
        'berry.png':             { dataUrl: berryUrl, scale: 0.25 },
        'moonES28.png':          { dataUrl: moonUrl, scale: 0.25 },
        'rose-dial104.png':      { dataUrl: roseDial104Url, scale: 0.25 },
        'rose-dial158.png':      { dataUrl: roseDial158Url, scale: 0.25 },
    },
});
