/**
 * DST transition detection utilities.
 *
 * Provides functions to find the exact next DST transition for any IANA
 * timezone by probing the UTC offset via the Intl.DateTimeFormat API
 * and binary-searching to minute-level precision.
 */

/**
 * Get the UTC offset (in minutes, east-positive) for a timezone at a
 * specific instant.  Uses Intl.DateTimeFormat with longOffset parsing.
 *
 * Examples:
 *   getTimezoneOffsetMinutes('America/New_York', someDateInEST) → -300
 *   getTimezoneOffsetMinutes('Asia/Kolkata', anyDate)           → 330
 *   getTimezoneOffsetMinutes('Australia/Lord_Howe', inDST)      → 660
 */
export function getTimezoneOffsetMinutes(
    olsonId: string,
    date: Date,
): number {
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: olsonId,
            timeZoneName: 'longOffset',
        });
        const parts = fmt.formatToParts(date);
        const tzStr = parts.find(p => p.type === 'timeZoneName')?.value || '';

        if (tzStr === 'GMT' || tzStr === 'UTC' || !tzStr) {
            return 0;
        }

        const m = tzStr.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
        if (m) {
            const sign = m[1] === '+' ? 1 : -1;
            return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
        }

        return 0;
    } catch {
        return 0;
    }
}

/**
 * Find the next DST transition in a given IANA timezone.
 *
 * Returns the Date of the transition (snapped to the top of the minute,
 * i.e. XX:XX:00.000), or null if no DST transition is found within the
 * next ~400 days.
 *
 * Algorithm:
 *  1. Probe forward at 14-day intervals for up to 400 days
 *  2. When offset changes between two probes, binary search between them
 *  3. Converge to two adjacent minutes with different offsets
 *  4. Return the top of the later minute
 */
export function findNextDstTransition(
    olsonId: string,
    from: Date,
): Date | null {
    const startMs = from.getTime();
    const currentOffset = getTimezoneOffsetMinutes(olsonId, from);

    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
    const MAX_PROBES = 30;  // 14 days × 30 = 420 days

    let loMs = startMs;

    for (let i = 1; i <= MAX_PROBES; i++) {
        const hiMs = startMs + i * FOURTEEN_DAYS_MS;
        const hiOffset = getTimezoneOffsetMinutes(olsonId, new Date(hiMs));

        if (hiOffset !== currentOffset) {
            // Transition happened between loMs and hiMs — binary search
            return binarySearchTransition(olsonId, loMs, hiMs, currentOffset);
        }

        loMs = hiMs;
    }

    // No transition found in ~420 days — timezone doesn't observe DST
    return null;
}

/**
 * Find the most recent past DST transition in a given IANA timezone.
 *
 * Returns the Date of the transition (snapped to the top of the minute,
 * i.e. XX:XX:00.000), or null if no DST transition is found within the
 * past ~400 days.
 *
 * Used when time is running backward (-1× mode) to detect when the
 * displayed time crosses a DST boundary into the past.
 */
export function findPrevDstTransition(
    olsonId: string,
    from: Date,
): Date | null {
    const startMs = from.getTime();
    const currentOffset = getTimezoneOffsetMinutes(olsonId, from);

    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
    const MAX_PROBES = 30;  // 14 days × 30 = 420 days

    let hiMs = startMs;

    for (let i = 1; i <= MAX_PROBES; i++) {
        const loMs = startMs - i * FOURTEEN_DAYS_MS;
        const loOffset = getTimezoneOffsetMinutes(olsonId, new Date(loMs));

        if (loOffset !== currentOffset) {
            // Transition happened between loMs and hiMs — binary search.
            // loMs has loOffset (different), hiMs has currentOffset.
            // binarySearchTransition expects lo=baseOffset, hi=different,
            // so pass loOffset as the base.
            return binarySearchTransition(olsonId, loMs, hiMs, loOffset);
        }

        hiMs = loMs;
    }

    // No transition found in ~420 days
    return null;
}

/**
 * Binary search for the exact minute boundary of a DST transition.
 *
 * Precondition: getTimezoneOffsetMinutes(olsonId, loMs) === baseOffset
 *               getTimezoneOffsetMinutes(olsonId, hiMs) !== baseOffset
 *
 * Converges until hiMs - loMs <= 60_000 ms (1 minute), then returns
 * the top of the minute containing hiMs (snapped to XX:XX:00.000).
 */
function binarySearchTransition(
    olsonId: string,
    loMs: number,
    hiMs: number,
    baseOffset: number,
): Date {
    const ONE_MINUTE_MS = 60_000;

    while (hiMs - loMs > ONE_MINUTE_MS) {
        const midMs = Math.floor((loMs + hiMs) / 2);
        const midOffset = getTimezoneOffsetMinutes(olsonId, new Date(midMs));

        if (midOffset === baseOffset) {
            loMs = midMs;
        } else {
            hiMs = midMs;
        }
    }

    // Snap to top of the minute: floor hiMs down to XX:XX:00.000
    const snapped = Math.floor(hiMs / ONE_MINUTE_MS) * ONE_MINUTE_MS;
    return new Date(snapped);
}
