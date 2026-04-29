/**
 * Face data for Geneva I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/geneva/Geneva-I.xml';
import faceFrontUrl from '../watch/assets/geneva/faceFront-4x.png';
import moonUrl from '../watch/assets/parts-bin/moonES80-4x.png';
import moonNightUrl from '../watch/assets/geneva/moonNightcastAW80-2x.png';
import seasonrefsUrl from '../watch/assets/geneva/seasonrefs.png';
import seasonsUrl from '../watch/assets/geneva/seasons-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Geneva',
    urlAbbrev: 'gn',
    xml,
    images: {
        'faceFront.png':          { dataUrl: faceFrontUrl, scale: 0.25 },
        'moonES80.png':           { dataUrl: moonUrl, scale: 0.25 },
        'moonNightcastAW80.png':  { dataUrl: moonNightUrl, scale: 0.5 },
        'seasonrefs.png':         { dataUrl: seasonrefsUrl, scale: 1 },
        'seasons.png':            { dataUrl: seasonsUrl, scale: 0.25 },
    },
});
