/**
 * Timezone resolver — determines the IANA timezone for a given location.
 *
 * Two tiers:
 *  1. If a city was selected from search, use its known timezone.
 *  2. Otherwise, use the closest city in our GeoNames database.
 *  3. Last resort: browser timezone.
 */

import { findClosestCity } from './city-search';

/**
 * Resolve the IANA timezone for a location.
 *
 * @param lat       Latitude in degrees
 * @param lon       Longitude in degrees
 * @param cityTz    If the user selected a city from search, that city's timezone; otherwise null
 * @returns         IANA timezone string (e.g. "America/Los_Angeles")
 */
export function resolveTimezone(lat: number, lon: number, cityTz: string | null): string {
    // Tier 1: explicit city timezone from search selection
    if (cityTz) return cityTz;

    // Tier 2: closest city in our 167K-city database
    const closest = findClosestCity(lat, lon);
    if (closest?.timezone) return closest.timezone;

    // Tier 3: browser timezone fallback
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
        return 'Etc/UTC';
    }
}
