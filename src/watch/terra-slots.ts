/**
 * Terra worldtime ring slot validation.
 *
 * Implements the iOS ECGeoNames.m logic for determining which ring
 * slot(s) a timezone can occupy. Each slot's label is centered at
 * offsetHour + 0.5 UTC hours; a timezone is valid for a slot if its
 * "center" (average of standard and DST offsets) is within ±30 minutes
 * of the slot center.
 */

import type { TerraSlot } from './watch-env.js';
import { TERRA_RING_DEFAULTS } from './watch-env.js';

// Constants matching iOS ECFactoryUI.m
const FIRST_ENV_SLOT = 5;
const UTC_SECTOR_NUMBER = 11;

/**
 * Convert env slot number (5–28) to UTC offset hour (-11 to +12).
 */
export function getSlotOffsetHour(envSlot: number): number {
    return envSlot - FIRST_ENV_SLOT - UTC_SECTOR_NUMBER;
}

/**
 * Compute the timezone's "center" in minutes from UTC.
 *
 * For DST zones: average of standard and DST offsets.
 * For non-DST zones: the single offset.
 *
 * Uses Intl.DateTimeFormat to determine offsets at January and July,
 * matching the approach in watch-env.ts.
 */
export function computeTzCenter(olsonId: string): number {
    try {
        const now = new Date();
        const jan = new Date(now.getFullYear(), 0, 1);
        const jul = new Date(now.getFullYear(), 6, 1);
        const janOff = getTzOffsetMinutes(olsonId, jan);
        const julOff = getTzOffsetMinutes(olsonId, jul);
        if (janOff === julOff) {
            // No DST
            return janOff;
        }
        // DST zone: return average of std and dst offsets
        return (janOff + julOff) / 2;
    } catch {
        return 0;
    }
}

/**
 * Get UTC offset in minutes for a timezone at a given date.
 */
function getTzOffsetMinutes(olsonId: string, date: Date): number {
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonId,
            timeZoneName: 'longOffset',
        });
        const parts = fmt.formatToParts(date);
        const tzPart = parts.find(p => p.type === 'timeZoneName');
        if (!tzPart) return 0;
        const tzStr = tzPart.value;
        if (tzStr === 'GMT' || tzStr === 'UTC') return 0;
        const m = tzStr.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
        if (!m) return 0;
        const sign = m[1] === '+' ? 1 : -1;
        const hours = parseInt(m[2], 10);
        const minutes = m[3] ? parseInt(m[3], 10) : 0;
        return sign * (hours * 60 + minutes);
    } catch {
        return 0;
    }
}

/**
 * Check if a timezone with the given center (in minutes) is valid for a slot.
 * Ported from iOS ECGeoNames.m `validTZCenteredAt:forSlot:`.
 *
 * @param tzCenter  Timezone center in minutes from UTC
 * @param offsetHours  Slot's UTC offset hour (-11 to +12)
 */
export function validTZCenteredAt(tzCenter: number, offsetHours: number): boolean {
    const centerSlotMinutes = offsetHours * 60 + 30;
    let distance = centerSlotMinutes - tzCenter;
    if (distance > 12 * 60) {
        distance -= 24 * 60;
    } else if (distance < -12 * 60) {
        distance += 24 * 60;
    }
    return Math.abs(distance) <= 30;
}

/**
 * Return the list of valid env slot numbers (5–28) for a given timezone.
 */
export function validSlotsForTz(olsonId: string): number[] {
    const tzCenter = computeTzCenter(olsonId);
    const result: number[] = [];
    for (let slot = 5; slot <= 28; slot++) {
        const offsetHour = getSlotOffsetHour(slot);
        if (validTZCenteredAt(tzCenter, offsetHour)) {
            result.push(slot);
        }
    }
    return result;
}

/**
 * Format a human-readable UTC offset label for a slot.
 * e.g., slot 11 → "UTC-5", slot 16 → "UTC±0", slot 21 → "UTC+5:30"
 */
export function formatSlotOffset(envSlot: number): string {
    const h = getSlotOffsetHour(envSlot);
    if (h === 0) return 'UTC±0';
    const sign = h > 0 ? '+' : '';
    return `UTC${sign}${h}`;
}

/**
 * Check if the device timezone is represented on the ring.
 * If not, find the best slot to temporarily override.
 *
 * @param deviceOlsonId  The device's (or globally overridden) timezone
 * @param slots          Current ring slot data (defaults + user overrides)
 * @returns Override info if needed, or null if device TZ is already on ring
 */
export function ensureDeviceTzOnRing(
    deviceOlsonId: string,
    slots: Record<number, TerraSlot>,
): { overriddenSlot: number; originalCity: string; newCityName: string; newSlot: TerraSlot } | null {
    // Check if device TZ is already represented
    for (const [, data] of Object.entries(slots)) {
        if (data.olsonId === deviceOlsonId) {
            return null; // Already on ring
        }
    }

    // Check by offset match (same offset = compatible)
    const deviceCenter = computeTzCenter(deviceOlsonId);
    for (const [, data] of Object.entries(slots)) {
        const slotCenter = computeTzCenter(data.olsonId);
        if (Math.abs(slotCenter - deviceCenter) < 1) {
            return null; // Close enough offset match
        }
    }

    // Device TZ not on ring — find valid slots
    const validSlots = validSlotsForTz(deviceOlsonId);
    if (validSlots.length === 0) {
        // Shouldn't happen for any real Olson timezone
        console.warn(`[TerraSlots] No valid slot for device timezone ${deviceOlsonId}`);
        return null;
    }

    // Pick the first valid slot
    const targetSlot = validSlots[0];
    const originalCity = slots[targetSlot]?.cityName ?? 'Unknown';

    // Look up a city name for the device timezone
    const deviceCityName = olsonIdToCityName(deviceOlsonId);

    return {
        overriddenSlot: targetSlot,
        originalCity,
        newCityName: deviceCityName,
        newSlot: {
            cityName: deviceCityName,
            olsonId: deviceOlsonId,
            lat: 0,  // These will be refined when the location is known
            lon: 0,
        },
    };
}

/**
 * Extract a reasonable city name from an Olson timezone ID.
 * e.g., "America/New_York" → "New York", "Asia/Kolkata" → "Kolkata"
 */
function olsonIdToCityName(olsonId: string): string {
    const parts = olsonId.split('/');
    const city = parts[parts.length - 1];
    return city.replace(/_/g, ' ');
}
