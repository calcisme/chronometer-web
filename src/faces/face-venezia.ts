/**
 * Face data for Venezia I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/venezia/Venezia-I.xml';

// Planet icons (36px series) — different sizes, apply appropriate scale
import sun36Url from '../watch/assets/parts-bin/planets/sun36-4x.png';
import mercury36Url from '../watch/assets/parts-bin/planets/mercury36-4x.png';
import venus36Url from '../watch/assets/parts-bin/planets/venus36.png';
import mars36Url from '../watch/assets/parts-bin/planets/mars36-2x.png';
import jupiter36Url from '../watch/assets/parts-bin/planets/jupiter36.png';
import saturn36Url from '../watch/assets/parts-bin/planets/saturn36-2x.png';
import uranus36Url from '../watch/assets/parts-bin/planets/uranus36-4x.png';
import neptune36Url from '../watch/assets/parts-bin/planets/neptune36-4x.png';

// Moon
import moonES36Url from '../watch/assets/parts-bin/moonES36-2x.png';

// Logos
import emeraldLogoUrl from '../watch/assets/parts-bin/logos/EmeraldOnlyFrom192.png';
import sequoiaLogoUrl from '../watch/assets/parts-bin/logos/SequoiaOnlyFrom192.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Venezia',
    xml,
    images: {
        '../partsBin/planets/sun36.png':     { dataUrl: sun36Url, scale: 0.25 },
        '../partsBin/planets/mercury36.png': { dataUrl: mercury36Url, scale: 0.25 },
        '../partsBin/planets/venus36.png':   { dataUrl: venus36Url, scale: 1 },
        '../partsBin/planets/mars36.png':    { dataUrl: mars36Url, scale: 0.5 },
        '../partsBin/planets/jupiter36.png': { dataUrl: jupiter36Url, scale: 1 },
        '../partsBin/planets/saturn36.png':  { dataUrl: saturn36Url, scale: 0.5 },
        '../partsBin/planets/uranus36.png':  { dataUrl: uranus36Url, scale: 0.25 },
        '../partsBin/planets/neptune36.png': { dataUrl: neptune36Url, scale: 0.25 },
        '../partsBin/moonES36.png':          { dataUrl: moonES36Url, scale: 0.5 },
        '../partsBin/logos/EmeraldOnlyFrom192.png':  { dataUrl: emeraldLogoUrl, scale: 1 },
        '../partsBin/logos/SequoiaOnlyFrom192.png':  { dataUrl: sequoiaLogoUrl, scale: 1 },
    },
});
