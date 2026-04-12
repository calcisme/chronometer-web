/**
 * Face data for Firenze I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/firenze/Firenze-I.xml';
import faceUrl from '../watch/assets/firenze/face-4x.png';
import mercuryUrl from '../watch/assets/parts-bin/planets/mercuryTransparent-4x.png';
import venusUrl from '../watch/assets/parts-bin/planets/venusTransparent-4x.png';
import earthUrl from '../watch/assets/parts-bin/planets/earthTransparent-4x.png';
import marsUrl from '../watch/assets/parts-bin/planets/marsTransparent-4x.png';
import jupiterUrl from '../watch/assets/parts-bin/planets/jupiterTransparent-4x.png';
import saturnUrl from '../watch/assets/parts-bin/planets/saturnTransparent-4x.png';
import moonUrl from '../watch/assets/parts-bin/planets/moonTransparent-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Firenze',
    xml,
    images: {
        'face.png':                                     { dataUrl: faceUrl, scale: 0.25 },
        '../partsBin/planets/mercuryTransparent.png':    { dataUrl: mercuryUrl, scale: 0.25 },
        '../partsBin/planets/venusTransparent.png':      { dataUrl: venusUrl, scale: 0.25 },
        '../partsBin/planets/earthTransparent.png':      { dataUrl: earthUrl, scale: 0.25 },
        '../partsBin/planets/marsTransparent.png':       { dataUrl: marsUrl, scale: 0.25 },
        '../partsBin/planets/jupiterTransparent.png':    { dataUrl: jupiterUrl, scale: 0.25 },
        '../partsBin/planets/saturnTransparent.png':     { dataUrl: saturnUrl, scale: 0.25 },
        '../partsBin/planets/moonTransparent.png':       { dataUrl: moonUrl, scale: 0.25 },
    },
});
