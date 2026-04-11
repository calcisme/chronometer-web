/**
 * City search engine for the location picker.
 * Provides prefix-based autocomplete over GeoNames cities1000 + IATA airports.
 */

// These will be populated by importing cities-data.js
let TZ: string[] = [];
let CC: string[] = [];
let AD: string[] = [];
let CITIES: any[][] = [];
let AIRPORTS: any[][] = [];
let loaded = false;

/** City search result. */
export interface CityResult {
    /** Display label: "City, State, Country" or "IATA CityName airport" */
    label: string;
    /** Short label for the location bar, e.g. "San Francisco" */
    shortLabel: string;
    lat: number;
    lon: number;
    timezone: string;
    /** True if this is an airport entry */
    isAirport: boolean;
}

// City row indices
const C_NAME = 0;
const C_ASCII = 1;
const C_CC = 2;
const C_AD1 = 3;
const C_LAT = 4;
const C_LON = 5;
const C_TZ = 6;
const C_POP = 7;
const C_ALT = 8;
const C_AD2 = 9;

// Airport row indices
const A_IATA = 0;
const A_CITY = 1;
const A_LAT = 2;
const A_LON = 3;
const A_TZ = 4;
const A_CC = 5;

/** ASCII-fold a string for diacritics-insensitive search. */
function toASCII(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Load the city database. Must be called before search().
 * Loads cities-data.js via a script tag (works from file:// too).
 */
/** Error message from last load attempt, if any. */
export let loadError: string = '';

export function loadCityData(): Promise<void> {
    if (loaded) return Promise.resolve();
    if (loadError) return Promise.reject(new Error(loadError));

    return new Promise((resolve, reject) => {
        // Check if already loaded (e.g., bundled in standalone HTML)
        const existing = (window as any).ChronometerCities;
        if (existing) {
            TZ = existing.TZ;
            CC = existing.CC;
            AD = existing.AD;
            CITIES = existing.CITIES;
            AIRPORTS = existing.AIRPORTS;
            loaded = true;
            console.log(`[CitySearch] Loaded ${CITIES.length} cities, ${AIRPORTS.length} airports`);
            resolve();
            return;
        }

        // Register a callback that the data file will invoke on execution.
        // This is more reliable than checking a global after onload,
        // because script.onload fires on download success — not execution success.
        (window as any)._chronCitiesCallback = (data: any) => {
            if (data) {
                TZ = data.TZ;
                CC = data.CC;
                AD = data.AD;
                CITIES = data.CITIES;
                AIRPORTS = data.AIRPORTS;
                loaded = true;
                console.log(`[CitySearch] Loaded ${CITIES.length} cities, ${AIRPORTS.length} airports`);
            }
        };

        const script = document.createElement('script');
        script.src = 'cities-data.js?v=' + Date.now();

        // Catch JS parse/runtime errors from the script
        const errorHandler = (evt: ErrorEvent) => {
            if (evt.filename && evt.filename.includes('cities-data')) {
                window.removeEventListener('error', errorHandler);
                loadError = `JS error in cities-data.js: ${evt.message} (line ${evt.lineno})`;
                console.error(`[CitySearch] ${loadError}`);
                reject(new Error(loadError));
            }
        };
        window.addEventListener('error', errorHandler);

        script.onload = () => {
            window.removeEventListener('error', errorHandler);
            delete (window as any)._chronCitiesCallback;
            if (loaded) {
                resolve();
            } else {
                // Callback was never invoked — script parsed but didn't execute properly
                loadError = 'cities-data.js loaded but data callback was not invoked';
                console.error(`[CitySearch] ${loadError}`);
                reject(new Error(loadError));
            }
        };
        script.onerror = (evt) => {
            window.removeEventListener('error', errorHandler);
            delete (window as any)._chronCitiesCallback;
            loadError = `Failed to download cities-data.js`;
            console.error(`[CitySearch] ${loadError}`, evt);
            reject(new Error(loadError));
        };
        document.head.appendChild(script);
    });
}

/** Check if city data is loaded. */
export function isCityDataLoaded(): boolean {
    return loaded;
}

/**
 * Search for cities matching the given query string.
 * Returns up to `limit` results sorted by relevance (exact prefix first, then population).
 */
export function searchCities(query: string, limit: number = 20): CityResult[] {
    if (!loaded || !query || query.length < 2) return [];

    const q = toASCII(query.trim());
    if (!q) return [];

    const qUpper = query.trim().toUpperCase();
    const results: { result: CityResult; priority: number; pop: number }[] = [];

    // Search airports by IATA code (exact prefix match)
    for (const a of AIRPORTS) {
        const iata: string = a[A_IATA];
        if (iata.startsWith(qUpper) || iata === qUpper) {
            results.push({
                result: {
                    label: `${iata}  ${a[A_CITY]} airport`,
                    shortLabel: `${iata} ${a[A_CITY]} airport`,
                    lat: a[A_LAT],
                    lon: a[A_LON],
                    timezone: TZ[a[A_TZ]] || '',
                    isAirport: true,
                },
                priority: iata === qUpper ? 0 : 1,  // exact match first
                pop: 0,
            });
        }
    }

    // Search cities
    for (const c of CITIES) {
        const asciiName: string = c[C_ASCII];
        const name: string = c[C_NAME];
        const pop: number = c[C_POP];

        let matched = false;
        let priority = 3;  // default: alt name match

        // Check primary ASCII name (prefix match)
        if (asciiName.startsWith(q)) {
            matched = true;
            priority = asciiName === q ? 0 : 1;  // exact match first
        }

        // Check original UTF-8 name
        if (!matched) {
            const nameLower = name.toLowerCase();
            if (nameLower.startsWith(q) || toASCII(name).startsWith(q)) {
                matched = true;
                priority = 2;
            }
        }

        // Check alternate names
        if (!matched && c[C_ALT]) {
            const alts: string = c[C_ALT];
            // Quick check before splitting
            if (alts.includes(q)) {
                for (const alt of alts.split(',')) {
                    if (alt.startsWith(q)) {
                        matched = true;
                        priority = 3;
                        break;
                    }
                }
            }
        }

        if (matched) {
            // Build display label
            const cc = CC[c[C_CC]] || '';
            const admin1 = AD[c[C_AD1]] || '';
            let label = name;
            if (c[C_AD2]) {
                label += ` (${c[C_AD2]})`;
            }
            if (admin1) {
                label += `, ${admin1}`;
            }
            if (cc) {
                label += `, ${cc}`;
            }

            results.push({
                result: {
                    label,
                    shortLabel: name,
                    lat: c[C_LAT],
                    lon: c[C_LON],
                    timezone: TZ[c[C_TZ]] || '',
                    isAirport: false,
                },
                priority,
                pop,
            });
        }
    }

    // Sort: lower priority first, then by population descending
    results.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return b.pop - a.pop;
    });

    return results.slice(0, limit).map(r => r.result);
}
