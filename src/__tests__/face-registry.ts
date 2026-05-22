/**
 * Face registry — maps face names to XML asset paths and configuration.
 *
 * Used by the test framework to load face definitions without the
 * browser-based face-*.ts entry points (which require Vite imports).
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', 'watch', 'assets');
const FACES_TXT_PATH = join(__dirname, '..', '..', 'faces.txt');

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

function slugToKey(slug: string): string {
    return slug
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Dynamically constructed face registry based on active faces.
 */
export const FACE_CONFIGS: Record<string, FaceConfig> = {};

if (existsSync(FACES_TXT_PATH)) {
    const slugs = readFileSync(FACES_TXT_PATH, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

    for (const slug of slugs) {
        const slugDir = join(ASSETS_DIR, slug);
        if (!existsSync(slugDir)) continue;
        const xmlFiles = readdirSync(slugDir).filter(f => f.endsWith('.xml'));
        if (xmlFiles.length !== 1) continue;
        const xmlFile = xmlFiles[0];
        const xmlRelativePath = `${slug}/${xmlFile}`;
        const xmlText = readFileSync(join(ASSETS_DIR, xmlRelativePath), 'utf8');

        // Extract beatsPerSecond with a fast regexp
        const bpsMatch = xmlText.match(/beatsPerSecond=['"]([^'"]+)['"]/);
        const beatsPerSecond = bpsMatch ? parseInt(bpsMatch[1], 10) : 1;

        const nameKey = slugToKey(slug);
        FACE_CONFIGS[nameKey] = {
            name: nameKey,
            xmlPath: xmlRelativePath,
            beatsPerSecond
        };
    }
}

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
