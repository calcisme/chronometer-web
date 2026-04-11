# City Location Picker — Implementation Plan

## Goal

Add a "Search by city" capability to the location picker so users can select a city name (with autocomplete) instead of entering raw lat/lon coordinates. The city database must be bundled into the app for offline use.

## Data Source

**GeoNames `cities1000.txt`** — ~130,000 populated places with population > 1,000 or seats of administrative divisions down to PPLA3.

- License: Creative Commons Attribution 4.0
- Includes: name, ASCII name, alternate names, lat, lon, country code, admin1 code, admin2 code, population, **IANA timezone ID**
- Supplementary files:
  - `admin1CodesASCII.txt` — human-readable state/province names
  - `alternateNamesV2.zip` — IATA airport codes and airport features

## Resolved Decisions

1. **Alternate names**: Include — allows searching "Peking" to find "Beijing", etc.
2. **IATA airports**: Include as **separate entries** with their own coordinates (not as city aliases). Displayed as "SFO San Francisco airport". Multiple codes per city are all included (JFK, LGA, EWR for NYC).
3. **tz-lookup**: Defer — not needed until the timezone override feature. For now, timezone comes from GeoNames data when a city is selected.

## Data Pipeline (Build-Time)

### Input files (checked into repo or downloaded by a setup script)

| File | Purpose |
|------|---------|
| `cities1000.txt` | Main city data (~130K cities) |
| `admin1CodesASCII.txt` | State/province name lookup |
| `alternateNamesV2.txt` | IATA codes + airport geoname linking |
| Country-code airports from `allCountries.txt` or per-country extracts | Airport lat/lon + nearest city association |

### Processing steps

A Node.js build script (`scripts/build-cities.js`) will:

1. **Parse** `cities1000.txt` (tab-delimited, 19 columns)
2. **Join admin1** names from `admin1CodesASCII.txt` (key: `CC.admin1code` → name)
3. **Extract airports**: from `alternateNamesV2.txt`, find entries with `isolanguage = 'iata'` to get airport geonameid → IATA code mapping. Then look up those geonameids in the full GeoNames data to get airport coordinates, and associate each airport with the nearest city in cities1000.
4. **Include alternate names** from the `alternatenames` column in cities1000.txt for search indexing (comma-separated, ASCII-folded)
5. **Detect duplicates**: group by `(name, countryCode, admin1Code)`. Where multiple entries share the same group but have different `admin2Code` values, include the admin2 name for disambiguation
6. **Build lookup tables**:
   - Timezone strings → numeric index (~400 unique)
   - Country codes → numeric index (~250 unique)
   - Admin1 names → numeric index (~3500 unique)
7. **Sort** by population descending (so autocomplete results show larger cities first)
8. **Output** a JS module containing:
   - Compact city array (positional fields)
   - Airport entries (IATA code, display name, lat, lon, tz)
   - Lookup tables
   - Search-ready ASCII name fields

### Output format (conceptual)

```typescript
// Lookup tables
const TZ = ["America/New_York", "America/Chicago", ...];
const CC = ["US", "GB", "DE", ...];
const AD = ["California", "Texas", ...];

// City: [name, asciiName, countryIdx, admin1Idx, lat, lon, tzIdx, pop, altNames?, admin2?]
const CITIES = [
  ["New York", "New York", 0, 32, 40.714, -74.006, 0, 8336817, "nueva york,..."],
  ["San Francisco", "San Francisco", 0, 4, 37.775, -122.419, 7, 873965],
  // ...
];

// Airport: [iata, displayName, lat, lon, tzIdx]
const AIRPORTS = [
  ["SFO", "San Francisco airport", 37.619, -122.379, 7],
  ["JFK", "New York airport", 40.640, -73.779, 0],
  // ...
];
```

### Estimated sizes

| Stage | Size |
|-------|------|
| Raw `cities1000.txt` | ~25 MB |
| Stripped to essential fields, compact JS | ~4-6 MB |
| With alternate names for search | ~6-8 MB |
| Gzipped (served from HTTP) | ~2-3 MB |
| In standalone HTML build | ~6-8 MB added to bundle |

**Note**: The standalone HTML build will grow by ~6-8 MB. The HTTP-served version benefits from gzip and only adds ~2-3 MB to the transfer.

## Search Implementation

### Matching strategy

- **Prefix match** on ASCII-folded name (diacritics-insensitive)
- Also match against the original UTF-8 name (for users typing "München")
- Also match alternate names (e.g., "Peking" finds Beijing)
- Also match IATA codes (typing "SFO" finds the SFO airport entry)
- Results sorted by: exact prefix match first, then by population descending
- Airport matches shown when IATA code matches
- Cap results at ~20 suggestions for performance

### ASCII folding

```typescript
function toASCII(s: string): string {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
```

GeoNames provides an `asciiname` column; user input is also ASCII-folded before comparison.

### Timezone handling

- When the user selects a city or airport, the IANA timezone from GeoNames is stored alongside the lat/lon
- Timezone will be used in the future for a timezone override feature
- `tz-lookup` for raw lat/lon is deferred to later

## UI Design

### Entry point

Add a **"Search city"** button next to "Set location" in `#location-panel`, or integrate into the existing location prompt dialog.

### City picker UI

Search input with autocomplete dropdown:

```
┌──────────────────────────────────────┐
│  🔍  Type a city name...             │
├──────────────────────────────────────┤
│  San Francisco, California, US       │
│  SFO  San Francisco airport          │
│  San Fernando, Pampanga, PH          │
│  San Fernando, La Union, PH          │
│  Santa Fe, New Mexico, US            │
└──────────────────────────────────────┘
```

### Display format

- City: `City, State, Country`
- City with admin2 disambiguation: `City (County), State, Country`
- Airport: `IATA  CityName airport`

### Integration with existing location system

- Selecting a city/airport calls the same location update path as manual coordinate entry
- The selected entry's timezone is saved (in URL state and/or memory) for later use
- The location display updates to show the city name instead of (or alongside) raw coordinates

## Implementation Steps

### Phase 1: Data Pipeline
1. Download GeoNames source files
2. Write `scripts/build-cities.js` to process and output compact JS
3. Integrate into `build.sh`

### Phase 2: Search Engine
1. Implement ASCII-folded prefix search over the city + airport arrays
2. Ranking: exact prefix > starts-with > population
3. Cap at 20 results

### Phase 3: UI
1. Add city search button/input to the location panel
2. Build autocomplete dropdown
3. Wire selection to location update + timezone storage

## Verification Plan

### Automated
- Build script produces valid JS output
- TypeScript compiles without errors
- Search returns expected results:
  - "San Fran" → San Francisco, CA, US
  - "München" → München, Bavaria, DE
  - "SFO" → SFO San Francisco airport
  - "Springfield" → multiple states (IL, MO, MA, OH, etc.)
  - "Portland" → Portland, OR and Portland, ME
  - "Peking" → Beijing (via alternate names)

### Manual
- Test on iPhone (layout)
- Test offline (city search works after caching)
- Test in standalone HTML build
