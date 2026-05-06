/**
 * Face registry — maps face names to XML asset paths and configuration.
 *
 * Used by the test framework to load face definitions without the
 * browser-based face-*.ts entry points (which require Vite imports).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', 'watch', 'assets');

// ============================================================================
// Face metadata
// ============================================================================

export interface FaceConfig {
    /** Display name (matches Watch.name after parsing). */
    name: string;
    /** Relative path from ASSETS_DIR to the XML file. */
    xmlPath: string;
    /** beatsPerSecond value (for constructing getNow). */
    beatsPerSecond: number;
}

/**
 * All 14 faces with their XML paths and bps values.
 * The bps values must match the `beatsPerSecond` attribute in each XML.
 */
export const FACE_CONFIGS: Record<string, FaceConfig> = {
    'Babylon':   { name: 'Babylon',   xmlPath: 'babylon/Babylon-I.xml',             beatsPerSecond: 1 },
    'Basel':     { name: 'Basel',     xmlPath: 'basel/Basel-I.xml',                  beatsPerSecond: 10 },
    'Chandra':   { name: 'Chandra',   xmlPath: 'chandra/Chandra-I-android.xml',      beatsPerSecond: 0 },
    'Firenze':   { name: 'Firenze',   xmlPath: 'firenze/Firenze-I.xml',              beatsPerSecond: 0 },
    'Gaia':      { name: 'Gaia',      xmlPath: 'gaia/Gaia-I.xml',                    beatsPerSecond: 8 },
    'Geneva':    { name: 'Geneva',    xmlPath: 'geneva/Geneva-I.xml',                beatsPerSecond: 10 },
    'Haleakala': { name: 'Haleakala', xmlPath: 'haleakala/Haleakala-android.xml',    beatsPerSecond: 1 },
    'Hana':      { name: 'Hana',      xmlPath: 'hana/Hana-I-android.xml',            beatsPerSecond: 1 },
    'Mauna Kea': { name: 'Mauna Kea', xmlPath: 'mauna-kea/MaunaKea-I.xml',          beatsPerSecond: 10 },
    'Miami':     { name: 'Miami',     xmlPath: 'miami/Miami-I.xml',                  beatsPerSecond: 0 },
    'Selene':    { name: 'Selene',    xmlPath: 'selene/Selene-I.xml',                beatsPerSecond: 0 },
    'Terra':     { name: 'Terra',     xmlPath: 'terra/Terra-I.xml',                  beatsPerSecond: 8 },
    'Venezia':   { name: 'Venezia',   xmlPath: 'venezia/Venezia-I.xml',              beatsPerSecond: 0 },
    'Vienna':    { name: 'Vienna',    xmlPath: 'vienna/Vienna-I.xml',                beatsPerSecond: 8 },
};

// ============================================================================
// Test locations
// ============================================================================

export interface TestLocation {
    name: string;
    lat: number;
    lon: number;
    olsonTimezone: string;
}

export const TEST_LOCATIONS: TestLocation[] = [
    { name: 'cupertino', lat: 37.3349,  lon: -122.0090, olsonTimezone: 'America/Los_Angeles' },
    { name: 'arctic',    lat: 85.0,     lon: 21.0,      olsonTimezone: 'Europe/Oslo' },
    { name: 'equator',   lat: -5.0,     lon: 36.8,      olsonTimezone: 'Africa/Dar_es_Salaam' },
];

// ============================================================================
// XML loading
// ============================================================================

/**
 * Load the raw XML string for a face by name.
 * Throws if the face name is not found in FACE_CONFIGS.
 */
export function loadFaceXML(faceName: string): string {
    const config = FACE_CONFIGS[faceName];
    if (!config) {
        throw new Error(`Unknown face: "${faceName}". Valid faces: ${Object.keys(FACE_CONFIGS).join(', ')}`);
    }
    return readFileSync(join(ASSETS_DIR, config.xmlPath), 'utf-8');
}

/**
 * Get the list of all registered face names.
 */
export function allFaceNames(): string[] {
    return Object.keys(FACE_CONFIGS);
}
