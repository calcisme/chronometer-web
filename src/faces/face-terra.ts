/**
 * Face data for Terra I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/terra/Terra-I.xml';
import faceUrl from '../watch/assets/terra/face-4x.png';
import continentsUrl from '../watch/assets/terra/continents-4x.png';
import worldtimeRingUrl from '../watch/assets/terra/worldtimeRingBackground-4x.png';
import blackLogoUrl from '../watch/assets/parts-bin/logos/black-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Terra',
    urlAbbrev: 'tr',
    xml,
    images: {
        '../partsBin/HD/rose/face.png':     { dataUrl: faceUrl, scale: 0.25 },
        'continents.png':                    { dataUrl: continentsUrl, scale: 0.25 },
        'worldtimeRingBackground.png':       { dataUrl: worldtimeRingUrl, scale: 0.25 },
        '../partsBin/logos/black.png':        { dataUrl: blackLogoUrl, scale: 0.25 },
    },
});
