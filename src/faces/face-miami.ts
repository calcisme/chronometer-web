/**
 * Face data for Miami I — registers XML and image assets on window.ChronometerFaces.
 */
import xml from '../watch/assets/miami/Miami-I.xml';
import faceUrl from '../watch/assets/miami/face-4x.png';
import sunLabelUrl from '../watch/assets/miami/SunLabel-4x.png';
import saturnLabelUrl from '../watch/assets/miami/SaturnLabel-4x.png';
import jupiterLabelUrl from '../watch/assets/miami/JupiterLabel-4x.png';
import marsLabelUrl from '../watch/assets/miami/MarsLabel-4x.png';
import venusLabelUrl from '../watch/assets/miami/VenusLabel-4x.png';
import mercuryLabelUrl from '../watch/assets/miami/MercuryLabel-4x.png';
import moonLabelUrl from '../watch/assets/miami/MoonLabel-4x.png';

window.ChronometerFaces = window.ChronometerFaces || [];
window.ChronometerFaces.push({
    name: 'Miami',
    urlAbbrev: 'mi',
    xml,
    images: {
        'face.png':          { dataUrl: faceUrl, scale: 0.25 },
        'SunLabel.png':      { dataUrl: sunLabelUrl, scale: 0.25 },
        'SaturnLabel.png':   { dataUrl: saturnLabelUrl, scale: 0.25 },
        'JupiterLabel.png':  { dataUrl: jupiterLabelUrl, scale: 0.25 },
        'MarsLabel.png':     { dataUrl: marsLabelUrl, scale: 0.25 },
        'VenusLabel.png':    { dataUrl: venusLabelUrl, scale: 0.25 },
        'MercuryLabel.png':  { dataUrl: mercuryLabelUrl, scale: 0.25 },
        'MoonLabel.png':     { dataUrl: moonLabelUrl, scale: 0.25 },
    },
});
