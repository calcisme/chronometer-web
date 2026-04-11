#!/usr/bin/env node
/**
 * Build script: process GeoNames data into a compact JS module for the city picker.
 *
 * Input files (in scripts/geonames-data/):
 *   - cities1000.txt        — main city data
 *   - admin1CodesASCII.txt  — state/province name lookup
 *   - alternateNamesV2.txt  — IATA airport codes
 *   - allCountries.txt      — airport coordinates (for airports not in cities1000)
 *
 * Output:
 *   - src/cities-data.js    — compact JS module with city + airport data
 */

import { readFileSync, writeFileSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'geonames-data');
const OUT_FILE = join(__dirname, '..', 'src', 'cities-data.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTSV(filename) {
    const path = join(DATA_DIR, filename);
    console.log(`Reading ${filename}...`);
    const text = readFileSync(path, 'utf-8');
    return text.split('\n').filter(line => line && !line.startsWith('#'));
}

function toASCII(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Stream a large file line-by-line without loading it all into memory. */
async function forEachLine(filename, callback) {
    const path = join(DATA_DIR, filename);
    console.log(`Streaming ${filename}...`);
    const rl = createInterface({
        input: createReadStream(path, { encoding: 'utf-8' }),
        crlfDelay: Infinity,
    });
    let count = 0;
    for await (const line of rl) {
        if (!line || line.startsWith('#')) continue;
        count++;
        const stop = callback(line, count);
        if (stop === true) { rl.close(); break; }
    }
    return count;
}

// ---------------------------------------------------------------------------
// 1. Parse admin1 codes
// ---------------------------------------------------------------------------

console.log('=== Phase 1: Admin1 codes ===');
const admin1Map = new Map();  // "CC.admin1code" -> "State Name"
for (const line of readTSV('admin1CodesASCII.txt')) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
        admin1Map.set(parts[0], parts[1]);  // e.g. "US.CA" -> "California"
    }
}
console.log(`  ${admin1Map.size} admin1 codes loaded`);

// Also load admin2 codes for disambiguation
const admin2Map = new Map();  // "CC.admin1.admin2" -> "County Name"
for (const line of readTSV('admin2Codes.txt')) {
    const parts = line.split('\t');
    if (parts.length >= 2) {
        admin2Map.set(parts[0], parts[1]);  // e.g. "US.CA.085" -> "Santa Clara County"
    }
}
console.log(`  ${admin2Map.size} admin2 codes loaded`);

// ---------------------------------------------------------------------------
// 2. Parse cities1000
// ---------------------------------------------------------------------------

console.log('=== Phase 2: Cities ===');
const cities = [];
const cityById = new Map();

for (const line of readTSV('cities1000.txt')) {
    const f = line.split('\t');
    if (f.length < 18) continue;

    const geonameid = f[0];
    const name = f[1];
    const asciiname = f[2];
    const alternatenames = f[3];  // comma-separated
    const lat = parseFloat(f[4]);
    const lon = parseFloat(f[5]);
    const countryCode = f[8];
    const admin1Code = f[10];
    const admin2Code = f[11];
    const population = parseInt(f[14], 10) || 0;
    const timezone = f[17];

    const admin1Key = `${countryCode}.${admin1Code}`;
    const admin1Name = admin1Map.get(admin1Key) || admin1Code || '';

    // Resolve admin2 code to name
    const admin2Key = `${countryCode}.${admin1Code}.${admin2Code}`;
    const admin2Name = admin2Map.get(admin2Key) || admin2Code || '';

    const city = {
        geonameid,
        name,
        asciiname: asciiname.toLowerCase(),
        alternatenames,
        lat: Math.round(lat * 1000) / 1000,
        lon: Math.round(lon * 1000) / 1000,
        countryCode,
        admin1Name,
        admin2Name,
        population,
        timezone,
    };
    cities.push(city);
    cityById.set(geonameid, city);
}
console.log(`  ${cities.length} cities loaded`);

// ---------------------------------------------------------------------------
// 3. Detect duplicates needing admin2 disambiguation
// ---------------------------------------------------------------------------

console.log('=== Phase 3: Duplicate detection ===');
const groupKey = (c) => `${c.name}|${c.countryCode}|${c.admin1Name}`;
const groups = new Map();
for (const c of cities) {
    const key = groupKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
}

// For groups with >1 entry and different admin2 codes, mark them
let disambiguated = 0;
for (const [, group] of groups) {
    if (group.length > 1) {
        const admin2s = new Set(group.map(c => c.admin2Name));
        if (admin2s.size > 1) {
            // Need admin2 for disambiguation
            for (const c of group) {
                c.needsAdmin2 = true;
            }
            disambiguated += group.length;
        }
    }
}
console.log(`  ${disambiguated} cities need admin2 disambiguation`);

// ---------------------------------------------------------------------------
// 4. Parse IATA codes from alternateNamesV2
// ---------------------------------------------------------------------------

console.log('=== Phase 4: IATA codes ===');
const iataByGeonameid = new Map();  // geonameid -> [iata1, iata2, ...]

await forEachLine('alternateNamesV2.txt', (line, count) => {
    if (count % 5000000 === 0) console.log(`    ...${(count / 1000000).toFixed(0)}M lines`);
    const f = line.split('\t');
    if (f.length < 4 || f[2] !== 'iata') return;
    const geonameid = f[1];
    const iataCode = f[3].trim().toUpperCase();
    if (iataCode.length < 2 || iataCode.length > 4) return;

    if (!iataByGeonameid.has(geonameid)) {
        iataByGeonameid.set(geonameid, []);
    }
    iataByGeonameid.get(geonameid).push(iataCode);
});
console.log(`  ${iataByGeonameid.size} geonameids with IATA codes`);

// ---------------------------------------------------------------------------
// 5. Load airport coordinates from allCountries (for airports not in cities1000)
// ---------------------------------------------------------------------------

console.log('=== Phase 5: Airport coordinates ===');

// Determine which geonameids we need from allCountries
const neededIds = new Set();
for (const [gid] of iataByGeonameid) {
    if (!cityById.has(gid)) {
        neededIds.add(gid);
    }
}
console.log(`  ${neededIds.size} airport geonameids need coordinates from allCountries`);

const airportFeatures = new Map();  // geonameid -> {name, lat, lon, countryCode, timezone}

await forEachLine('allCountries.txt', (line, count) => {
    if (count % 2000000 === 0) {
        console.log(`    ...${(count / 1000000).toFixed(0)}M lines, found ${airportFeatures.size} airports, ${neededIds.size} remaining`);
    }

    const tabIdx = line.indexOf('\t');
    if (tabIdx === -1) return;
    const gid = line.slice(0, tabIdx);
    if (!neededIds.has(gid)) return;

    const f = line.split('\t');
    if (f.length < 18) return;

    airportFeatures.set(gid, {
        name: f[1],
        lat: Math.round(parseFloat(f[4]) * 1000) / 1000,
        lon: Math.round(parseFloat(f[5]) * 1000) / 1000,
        countryCode: f[8],
        timezone: f[17],
    });

    neededIds.delete(gid);
    if (neededIds.size === 0) return true;  // stop early
});
console.log(`  ${airportFeatures.size} airport features loaded`);
if (neededIds.size > 0) {
    console.log(`  WARNING: ${neededIds.size} airport geonameids not found in allCountries`);
}

// ---------------------------------------------------------------------------
// 6. Build airport entries
// ---------------------------------------------------------------------------

console.log('=== Phase 6: Building airport entries ===');
const airports = [];

for (const [gid, iataCodes] of iataByGeonameid) {
    // Try to find the associated city
    const city = cityById.get(gid);
    const airport = city ? null : airportFeatures.get(gid);

    if (!city && !airport) continue;  // skip if we can't find coordinates

    const lat = city ? city.lat : airport.lat;
    const lon = city ? city.lon : airport.lon;
    const tz = city ? city.timezone : airport.timezone;
    const cc = city ? city.countryCode : airport.countryCode;

    // Find the nearest city name for display
    let displayCity = city ? city.name : airport.name;
    // Clean up the airport name — often it's "City Airport" or "City International Airport"
    // Use the closest large city's name (weighted by population)
    if (!city) {
        // Score: lower is better. Distance penalized, large population rewarded.
        // Using population directly as divisor (not log) so NYC (8M) dominates over
        // Springfield Gardens (25K) even though it's a bit farther.
        let bestScore = Infinity;
        let nearestName = airport.name.replace(/\s+(International\s+)?Airport$/i, '');
        for (const c of cities) {
            if (c.countryCode !== cc) continue;
            const dlat = c.lat - lat;
            const dlon = c.lon - lon;
            const distSq = dlat * dlat + dlon * dlon;
            // Only consider cities within ~1 degree (~100 km)
            if (distSq > 1) continue;
            const score = distSq / Math.max(c.population, 1);
            if (score < bestScore) {
                bestScore = score;
                nearestName = c.name;
            }
        }
        displayCity = nearestName;
    }

    for (const iata of iataCodes) {
        airports.push({
            iata,
            displayCity,
            lat,
            lon,
            timezone: tz,
            countryCode: cc,
        });
    }
}
console.log(`  ${airports.length} airport entries created`);

// ---------------------------------------------------------------------------
// 7. Build lookup tables
// ---------------------------------------------------------------------------

console.log('=== Phase 7: Lookup tables ===');

// Timezone lookup
const tzSet = new Set();
for (const c of cities) tzSet.add(c.timezone);
for (const a of airports) tzSet.add(a.timezone);
const tzList = [...tzSet].sort();
const tzIndex = new Map();
tzList.forEach((tz, i) => tzIndex.set(tz, i));
console.log(`  ${tzList.length} unique timezones`);

// Country code lookup
const ccSet = new Set();
for (const c of cities) ccSet.add(c.countryCode);
for (const a of airports) ccSet.add(a.countryCode);
const ccList = [...ccSet].sort();
const ccIndex = new Map();
ccList.forEach((cc, i) => ccIndex.set(cc, i));
console.log(`  ${ccList.length} unique country codes`);

// Admin1 name lookup
const adSet = new Set();
for (const c of cities) adSet.add(c.admin1Name);
const adList = [...adSet].sort();
const adIndex = new Map();
adList.forEach((ad, i) => adIndex.set(ad, i));
console.log(`  ${adList.length} unique admin1 names`);

// ---------------------------------------------------------------------------
// 8. Sort cities by population descending
// ---------------------------------------------------------------------------

cities.sort((a, b) => b.population - a.population);

// ---------------------------------------------------------------------------
// 9. Output compact JS
// ---------------------------------------------------------------------------

console.log('=== Phase 8: Writing output ===');

// Build city array: [name, asciiName, ccIdx, ad1Idx, lat, lon, tzIdx, pop, altNames?, admin2?]
const cityRows = cities.map(c => {
    const row = [
        c.name,
        c.asciiname,
        ccIndex.get(c.countryCode),
        adIndex.get(c.admin1Name),
        c.lat,
        c.lon,
        tzIndex.get(c.timezone),
        c.population,
    ];
    // Only include alt names that would help with search:
    // keep variants whose ASCII-folded form starts differently from the primary name
    // (prefix search on asciiname already handles same-prefix variants)
    let filteredAlts = '';
    if (c.alternatenames) {
        const primaryAscii = c.asciiname;  // already lowercase
        const prefix3 = primaryAscii.substring(0, 3);
        const seen = new Set([primaryAscii]);
        const useful = [];
        for (const alt of c.alternatenames.split(',')) {
            const altAscii = toASCII(alt.trim());
            if (!altAscii || altAscii.length <= 1 || seen.has(altAscii)) continue;
            seen.add(altAscii);
            // Keep if the first 3 chars differ from the primary name
            if (altAscii.substring(0, 3) !== prefix3) {
                useful.push(altAscii);
            }
        }
        filteredAlts = useful.join(',');
    }
    if (filteredAlts || c.needsAdmin2) {
        row.push(filteredAlts || '');
    }
    if (c.needsAdmin2 && c.admin2Name) {
        row.push(c.admin2Name);
    }
    return row;
});

// Build airport array: [iata, displayCity, lat, lon, tzIdx, ccIdx]
const airportRows = airports.map(a => [
    a.iata,
    a.displayCity,
    a.lat,
    a.lon,
    tzIndex.get(a.timezone),
    ccIndex.get(a.countryCode),
]);

// Sort airports by IATA code
airportRows.sort((a, b) => a[0].localeCompare(b[0]));

// Write arrays with one entry per line to avoid iOS Safari line-length limits
function jsonArrayMultiline(arr) {
    if (arr.length === 0) return '[]';
    const lines = arr.map(row => JSON.stringify(row));
    return '[\n' + lines.join(',\n') + '\n]';
}

const output = `// Auto-generated by scripts/build-cities.js — do not edit
// Source: GeoNames cities1000 + alternateNamesV2 (CC BY 4.0)
// Generated: ${new Date().toISOString()}
//
// City row: [name, asciiName, ccIdx, ad1Idx, lat, lon, tzIdx, pop, altNames?, admin2?]
// Airport row: [iata, displayCity, lat, lon, tzIdx, ccIdx]

window.ChronometerCities = {
  TZ: ${JSON.stringify(tzList)},
  CC: ${JSON.stringify(ccList)},
  AD: ${JSON.stringify(adList)},
  CITIES: ${jsonArrayMultiline(cityRows)},
  AIRPORTS: ${jsonArrayMultiline(airportRows)}
};
`;

writeFileSync(OUT_FILE, output, 'utf-8');
const sizeMB = (Buffer.byteLength(output, 'utf-8') / (1024 * 1024)).toFixed(1);
console.log(`  Written to ${OUT_FILE} (${sizeMB} MB)`);
console.log('Done!');

