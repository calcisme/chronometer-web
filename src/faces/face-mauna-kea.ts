/**
 * Face data for Mauna Kea — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/mauna-kea/MaunaKea-I.xml';
import faceUrl from '../watch/assets/mauna-kea/astro-face-4x.png';
import eotUrl from '../watch/assets/mauna-kea/EOT-4x.png';
import morningUrl from '../watch/assets/mauna-kea/morningHD-4x.png';
import eveningUrl from '../watch/assets/mauna-kea/eveningHD-4x.png';
import zodiacUrl from '../watch/assets/mauna-kea/zodiacWheel-4x.png';
import moonUrl from '../watch/assets/mauna-kea/moon25-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Mauna Kea',
    xml,
    images: {
        'astro-face.png':    { dataUrl: faceUrl, scale: 0.25 },
        'EOT.png':           { dataUrl: eotUrl, scale: 0.25 },
        'morningHD.png':     { dataUrl: morningUrl, scale: 0.25 },
        'eveningHD.png':     { dataUrl: eveningUrl, scale: 0.25 },
        'zodiacWheel.png':   { dataUrl: zodiacUrl, scale: 0.25 },
        'moon25.png':        { dataUrl: moonUrl, scale: 0.25 },
    },
});
