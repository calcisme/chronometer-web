import xml from '../watch/assets/kyoto/Kyoto-I.xml';
import faceUrl from '../watch/assets/kyoto/face-2x.png';
import handUrl from '../watch/assets/kyoto/hand-4x.png';
import roseUrl from '../watch/assets/kyoto/rose.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Kyoto',
    urlAbbrev: 'ky',
    xml,
    images: {
        'face.png':  { dataUrl: faceUrl,  scale: 0.5 },
        'hand.png':  { dataUrl: handUrl,  scale: 0.25 },
        'rose.png':  { dataUrl: roseUrl,  scale: 1 },
    },
});
