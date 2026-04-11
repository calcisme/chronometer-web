/**
 * es-calendar.ts — Hybrid Julian/Gregorian calendar system.
 *
 * Ported from ESCalendar.cpp in the estime library.
 *
 * Calendar convention (from iOS help file):
 *   Emerald Chronometer uses the Gregorian calendar for future dates and for
 *   past dates back to 1582, and the Julian calendar from 1 BCE to 1582 CE.
 *   Prior to 1 BCE it uses a proleptic Julian calendar, with leap years on
 *   1 BCE, 5 BCE, etc, back every four years.
 *
 * Times are in ESTimeInterval format (seconds since Jan 1, 2001 00:00:00 UTC,
 * same as Apple's NSTimeInterval / Cocoa reference date).
 *
 * The switchover from Julian to Gregorian occurs at Oct 15, 1582.
 * Days Oct 5–14 1582 do not exist in this hybrid calendar.
 */

// ============================================================================
// Constants from ESCalendarPvt.hpp
// ============================================================================

/** Julian Day number of the 1990 epoch (Dec 31 1989 / Jan 0.0 1990) */
const kECJulianDayOf1990Epoch = 2447891.5;

/** ESTimeInterval of 1990 epoch: Dec 31, 1989 GMT relative to Jan 1, 2001 GMT.
 *  Calculated as -24*3600*(365*8 + 366*3 + 1) [1992,1996,2000 are leap years] */
const kEC1990Epoch = -347241600.0;

/** Average days in a Gregorian year */
const kECAverageDaysInGregorianYear = 365.2425;

/** Days in a 400-year Gregorian cycle */
const kECDaysInGregorianCycle = kECAverageDaysInGregorianYear * 400;  // 146097

/** Days in a 4-year Julian cycle */
const kECDaysInJulianCycle = 365.25 * 4;  // 1461

/** Days in a non-leap century (for Gregorian calculation) */
const kECDaysInNonLeapCentury = 36525;

/**
 * ESTimeInterval for Oct 15, 1582 00:00:00 UTC — the Julian/Gregorian switchover.
 * From ESConstants.h: ECGregorianStartDate = -13197600000.0
 */
export const kECJulianGregorianSwitchoverTimeInterval = -13197600000.0;

// ============================================================================
// Date components interface
// ============================================================================

export interface ESDateComponents {
    era: number;      // 0 = BCE, 1 = CE
    year: number;     // Always positive; era disambiguates
    month: number;    // 1–12
    day: number;      // 1–31
    hour: number;     // 0–23
    minute: number;   // 0–59
    seconds: number;  // 0–59.999...
}

// ============================================================================
// Time interval → components (hybrid calendar decomposition)
// ============================================================================

/**
 * Decompose an ESTimeInterval (UTC) into calendar components.
 * Uses Julian calendar before Oct 15 1582, Gregorian after.
 *
 * Ported from ESCalendar_UTCComponentsFromTimeInterval() in ESCalendar.cpp.
 */
export function utcComponentsFromTimeInterval(timeInterval: number): ESDateComponents {
    let xRemainder: number;
    let signedYear: number;
    let x0: number;

    if (timeInterval < kECJulianGregorianSwitchoverTimeInterval) {
        // Julian calendar
        const x1F = 730793 + timeInterval / (24 * 3600);
        const x1 = Math.floor(x1F);
        xRemainder = x1F - x1;
        signedYear = Math.floor((4 * x1 + 3) / kECDaysInJulianCycle);
        x0 = x1 - Math.floor(kECDaysInJulianCycle * signedYear / 4.0);
    } else {
        // Gregorian calendar
        const x2F = 730791 + timeInterval / (24 * 3600);
        const x2 = Math.floor(x2F);
        xRemainder = x2F - x2;

        const century = Math.floor((4 * x2 + 3) / kECDaysInGregorianCycle);
        const x1 = x2 - Math.floor(kECDaysInGregorianCycle * century / 4.0);
        const yearWithinCentury = Math.floor((100 * x1 + 99) / kECDaysInNonLeapCentury);
        signedYear = (100 * century) + yearWithinCentury;
        x0 = x1 - Math.floor(kECDaysInNonLeapCentury * yearWithinCentury / 100.0);
    }

    let monthI = Math.floor((5 * x0 + 461) / 153);
    let month: number;
    if (monthI > 12) {
        month = monthI - 12;
        signedYear++;
    } else {
        month = monthI;
    }

    let era: number;
    let year: number;
    if (signedYear <= 0) {
        era = 0;
        year = 1 - signedYear;
    } else {
        era = 1;
        year = signedYear;
    }

    const dayF = x0 - Math.floor((153 * monthI - 457) / 5.0) + 1;
    const day = Math.round(dayF);

    const hoursF = xRemainder * 24;
    const hoursI = Math.floor(hoursF);
    const minutesF = (hoursF - hoursI) * 60;
    const minutesI = Math.floor(minutesF);
    const seconds = (minutesF - minutesI) * 60;

    return { era, year, month, day, hour: hoursI, minute: minutesI, seconds };
}

// ============================================================================
// Components → time interval
// ============================================================================

/**
 * Convert calendar components (UTC) to an ESTimeInterval.
 * Uses Julian calendar for dates before Oct 15 1582, Gregorian after.
 *
 * Ported from ESCalendar_timeIntervalFromUTCComponents() in ESCalendar.cpp.
 */
export function timeIntervalFromUTCComponents(
    era: number, year: number, month: number, day: number,
    hour: number, minute: number, seconds: number,
): number {
    let signedYear = era === 0 ? 1 - year : year;
    let monthI: number;
    if (month < 3) {
        monthI = month + 12;
        signedYear--;
    } else {
        monthI = month;
    }

    let J: number;
    if (era === 0 ||
        year < 1582 ||
        (year === 1582 &&
         (month < 10 ||
          (month === 10 && day < 15)))) {
        // Julian
        J = 1721116.5 + Math.floor(1461 * signedYear / 4.0);
    } else {
        // Gregorian
        const c = Math.floor(signedYear / 100.0);
        const x = signedYear - 100 * c;
        J = 1721118.5 + Math.floor(146097 * c / 4.0) + Math.floor(36525 * x / 100);
    }
    J += Math.floor((153 * monthI - 457) / 5.0) + day;

    return (J - kECJulianDayOf1990Epoch) * 24 * 3600 + kEC1990Epoch
         + hour * 3600 + minute * 60 + seconds;
}

// ============================================================================
// Days in month
// ============================================================================

/**
 * Return the number of days in the given month.
 * February uses the calendar system to determine leap year status.
 *
 * Ported from ESCalendar_daysInMonth() in ESCalendar.cpp.
 */
export function daysInMonth(eraNumber: number, yearNumber: number, monthNumber: number): number {
    switch (monthNumber) {
        case  1: return 31;  // Jan
        case  2: {
            // Compute Feb 1 → Mar 1 difference to determine 28 or 29
            const firstOfFeb = timeIntervalFromUTCComponents(eraNumber, yearNumber, 2, 1, 0, 0, 0);
            const firstOfMar = timeIntervalFromUTCComponents(eraNumber, yearNumber, 3, 1, 0, 0, 0);
            return Math.round((firstOfMar - firstOfFeb) / (24 * 3600));
        }
        case  3: return 31;
        case  4: return 30;
        case  5: return 31;
        case  6: return 30;
        case  7: return 31;
        case  8: return 31;
        case  9: return 30;
        case 10: return 31;
        case 11: return 30;
        case 12: return 31;
        default: return 0;
    }
}

// ============================================================================
// Gregorian ↔ Hybrid (Julian) conversion
// ============================================================================

/**
 * Convert a Gregorian date to the hybrid calendar (Julian before Oct 15 1582).
 * If the date is already in the Gregorian section, no change is made.
 *
 * Ported from ESCalendar_gregorianToHybrid() in ESCalendar.cpp.
 */
export function gregorianToHybrid(cs: ESDateComponents): ESDateComponents {
    // If in the Gregorian section, nothing to do
    if (cs.era === 1 &&
        (cs.year > 1582 ||
         (cs.year === 1582 &&
          (cs.month > 10 ||
           (cs.month === 10 && cs.day >= 15))))) {
        return { ...cs };
    }

    // Convert from Gregorian date to Julian day number
    let signedYear = cs.era === 0 ? 1 - cs.year : cs.year;
    let monthI: number;
    if (cs.month < 3) {
        monthI = cs.month + 12;
        signedYear--;
    } else {
        monthI = cs.month;
    }
    const c = Math.floor(signedYear / 100.0);
    const x = signedYear - 100 * c;
    let J = 1721118.5 + Math.floor(146097 * c / 4) + Math.floor(36525 * x / 100);
    J += Math.floor((153 * monthI - 457) / 5.0) + cs.day;

    // Then from Julian day number to Julian date
    const x1F = J - 1721117.5;
    const x1 = Math.floor(x1F);
    signedYear = Math.floor((4 * x1 + 3) / kECDaysInJulianCycle);
    const x0 = x1 - Math.floor(kECDaysInJulianCycle * signedYear / 4.0);
    monthI = Math.floor((5 * x0 + 461) / 153);

    let month: number;
    if (monthI > 12) {
        month = monthI - 12;
        signedYear++;
    } else {
        month = monthI;
    }

    let era: number;
    let year: number;
    if (signedYear <= 0) {
        era = 0;
        year = 1 - signedYear;
    } else {
        era = 1;
        year = signedYear;
    }
    const dayF = x0 - Math.floor((153 * monthI - 457) / 5.0) + 1;
    const day = Math.round(dayF);

    return { era, year, month, day, hour: cs.hour, minute: cs.minute, seconds: cs.seconds };
}

/**
 * Convert a hybrid (Julian) date to Gregorian.
 * If the date is already in the Gregorian section, no change is made.
 *
 * Ported from ESCalendar_hybridToGregorian() in ESCalendar.cpp.
 */
export function hybridToGregorian(cs: ESDateComponents): ESDateComponents {
    // If in the Gregorian section, nothing to do
    if (cs.era === 1 &&
        (cs.year > 1582 ||
         (cs.year === 1582 &&
          (cs.month > 10 ||
           (cs.month === 10 && cs.day >= 15))))) {
        return { ...cs };
    }

    // Convert from Julian date to Julian day number
    let signedYear = cs.era === 0 ? 1 - cs.year : cs.year;
    let monthI: number;
    if (cs.month < 3) {
        monthI = cs.month + 12;
        signedYear--;
    } else {
        monthI = cs.month;
    }
    let J = 1721116.5 + Math.floor(1461 * signedYear / 4.0);
    J += Math.floor((153 * monthI - 457) / 5.0) + cs.day;

    // Then from Julian day number to Gregorian date
    const x2F = J - 1721119.5;
    const x2 = Math.floor(x2F);
    const century = Math.floor((4 * x2 + 3) / kECDaysInGregorianCycle);
    const x1 = x2 - Math.floor(kECDaysInGregorianCycle * century / 4.0);
    const yearWithinCentury = Math.floor((100 * x1 + 99) / kECDaysInNonLeapCentury);
    signedYear = (100 * century) + yearWithinCentury;
    const x0 = x1 - Math.floor(kECDaysInNonLeapCentury * yearWithinCentury / 100.0);
    monthI = Math.floor((5 * x0 + 461) / 153);

    let month: number;
    if (monthI > 12) {
        month = monthI - 12;
        signedYear++;
    } else {
        month = monthI;
    }

    let era: number;
    let year: number;
    if (signedYear <= 0) {
        era = 0;
        year = 1 - signedYear;
    } else {
        era = 1;
        year = signedYear;
    }
    const dayF = x0 - Math.floor((153 * monthI - 457) / 5.0) + 1;
    const day = Math.round(dayF);

    return { era, year, month, day, hour: cs.hour, minute: cs.minute, seconds: cs.seconds };
}

// ============================================================================
// Local time helpers
// ============================================================================

/**
 * Decompose an ESTimeInterval into local calendar components using
 * a timezone offset in seconds (east-positive).
 */
export function localComponentsFromTimeInterval(
    timeInterval: number, tzOffsetSeconds: number,
): ESDateComponents {
    return utcComponentsFromTimeInterval(timeInterval + tzOffsetSeconds);
}

/**
 * Convert local calendar components back to an ESTimeInterval.
 * Uses two-pass offset correction for DST boundary handling,
 * matching the iOS ESCalendar_timeIntervalFromLocalComponents.
 */
export function timeIntervalFromLocalComponents(
    tzOffsetSeconds: number,
    era: number, year: number, month: number, day: number,
    hour: number, minute: number, seconds: number,
): number {
    const localT = timeIntervalFromUTCComponents(era, year, month, day, hour, minute, seconds);
    return localT - tzOffsetSeconds;
}
