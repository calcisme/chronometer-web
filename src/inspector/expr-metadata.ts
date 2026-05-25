/**
 * Metadata for expression evaluator functions and constants.
 * Used by autocomplete and the reference panel in Inspector.
 *
 * Entries are curated (not auto-generated from the env) so they can have
 * human-friendly descriptions and grouping. The autocomplete also falls back
 * to env.functions/env.variables for anything not listed here.
 */

export interface ExprEntry {
    /** The name as used in expressions. */
    name: string;
    /** Category for grouping in the reference panel. */
    category: string;
    /** One-line description. */
    desc: string;
    /** 'fn' for functions (with parens), 'const' for constants/variables. */
    kind: 'fn' | 'const';
    /** Signature hint shown in autocomplete, e.g. "(planetNum)". Empty for zero-arg. */
    sig?: string;
}

// Ordered by category, then by name within category.
export const EXPR_METADATA: ExprEntry[] = [
    // ── Constants: Planets ──────────────────────────────────────────────
    { name: 'Sun',     category: 'Planet Constants', desc: 'Sun (0)',     kind: 'const' },
    { name: 'Moon',    category: 'Planet Constants', desc: 'Moon (1)',    kind: 'const' },
    { name: 'Mercury', category: 'Planet Constants', desc: 'Mercury (2)', kind: 'const' },
    { name: 'Venus',   category: 'Planet Constants', desc: 'Venus (3)',   kind: 'const' },
    { name: 'Mars',    category: 'Planet Constants', desc: 'Mars (5)',    kind: 'const' },
    { name: 'Jupiter', category: 'Planet Constants', desc: 'Jupiter (6)', kind: 'const' },
    { name: 'Saturn',  category: 'Planet Constants', desc: 'Saturn (7)',  kind: 'const' },
    { name: 'Uranus',  category: 'Planet Constants', desc: 'Uranus (8)',  kind: 'const' },
    { name: 'Neptune', category: 'Planet Constants', desc: 'Neptune (9)', kind: 'const' },
    { name: 'Pluto',   category: 'Planet Constants', desc: 'Pluto (10)',  kind: 'const' },

    // ── Constants: Math ─────────────────────────────────────────────────
    { name: 'pi',    category: 'Math Constants', desc: 'π ≈ 3.14159',  kind: 'const' },
    { name: 'true',  category: 'Math Constants', desc: '1',            kind: 'const' },
    { name: 'false', category: 'Math Constants', desc: '0',            kind: 'const' },

    // ── Sun Times ───────────────────────────────────────────────────────
    { name: 'nextSunrise',        category: 'Sun Times',  desc: 'Next sunrise (date interval)',            kind: 'fn' },
    { name: 'nextSunset',         category: 'Sun Times',  desc: 'Next sunset (date interval)',             kind: 'fn' },
    { name: 'nextSunTransit',     category: 'Sun Times',  desc: 'Next solar noon (date interval)',         kind: 'fn' },
    { name: 'prevSunrise',        category: 'Sun Times',  desc: 'Previous sunrise (date interval)',        kind: 'fn' },
    { name: 'prevSunset',         category: 'Sun Times',  desc: 'Previous sunset (date interval)',         kind: 'fn' },
    { name: 'prevSunTransit',     category: 'Sun Times',  desc: 'Previous solar noon (date interval)',     kind: 'fn' },
    { name: 'sunriseForDayTime',  category: 'Sun Times',  desc: 'Today\'s sunrise (NaN if none)',          kind: 'fn' },
    { name: 'sunsetForDayTime',   category: 'Sun Times',  desc: 'Today\'s sunset (NaN if none)',           kind: 'fn' },
    { name: 'sunTransitForDayTime', category: 'Sun Times', desc: 'Today\'s solar noon (NaN if none)',      kind: 'fn' },

    // ── Moon Times ──────────────────────────────────────────────────────
    { name: 'nextMoonrise',       category: 'Moon Times', desc: 'Next moonrise (date interval)',           kind: 'fn' },
    { name: 'nextMoonset',        category: 'Moon Times', desc: 'Next moonset (date interval)',            kind: 'fn' },
    { name: 'nextMoonTransit',    category: 'Moon Times', desc: 'Next moon transit (date interval)',       kind: 'fn' },
    { name: 'prevMoonrise',       category: 'Moon Times', desc: 'Previous moonrise (date interval)',      kind: 'fn' },
    { name: 'prevMoonset',        category: 'Moon Times', desc: 'Previous moonset (date interval)',       kind: 'fn' },
    { name: 'prevMoonTransit',    category: 'Moon Times', desc: 'Previous moon transit (date interval)',  kind: 'fn' },
    { name: 'moonriseForDayTime', category: 'Moon Times', desc: 'Today\'s moonrise (NaN if none)',        kind: 'fn' },
    { name: 'moonsetForDayTime',  category: 'Moon Times', desc: 'Today\'s moonset (NaN if none)',         kind: 'fn' },
    { name: 'moonTransitForDayTime', category: 'Moon Times', desc: 'Today\'s moon transit (NaN if none)', kind: 'fn' },

    // ── Planet Times ────────────────────────────────────────────────────
    { name: 'nextRiseOfPlanet',       category: 'Planet Times', desc: 'Next rise of planet',          kind: 'fn', sig: '(planet)' },
    { name: 'nextSetOfPlanet',        category: 'Planet Times', desc: 'Next set of planet',           kind: 'fn', sig: '(planet)' },
    { name: 'nextTransitOfPlanet',    category: 'Planet Times', desc: 'Next transit of planet',       kind: 'fn', sig: '(planet)' },
    { name: 'prevRiseOfPlanet',       category: 'Planet Times', desc: 'Previous rise of planet',      kind: 'fn', sig: '(planet)' },
    { name: 'prevSetOfPlanet',        category: 'Planet Times', desc: 'Previous set of planet',       kind: 'fn', sig: '(planet)' },
    { name: 'prevTransitOfPlanet',    category: 'Planet Times', desc: 'Previous transit of planet',   kind: 'fn', sig: '(planet)' },
    { name: 'riseOfPlanetForDayTime', category: 'Planet Times', desc: 'Today\'s rise of planet',      kind: 'fn', sig: '(planet)' },
    { name: 'setOfPlanetForDayTime',  category: 'Planet Times', desc: 'Today\'s set of planet',       kind: 'fn', sig: '(planet)' },
    { name: 'transitOfPlanetForDayTime', category: 'Planet Times', desc: 'Today\'s transit of planet', kind: 'fn', sig: '(planet)' },

    // ── Sun Position ────────────────────────────────────────────────────
    { name: 'sunAltitude',        category: 'Sun Position',  desc: 'Sun altitude (radians)',           kind: 'fn' },
    { name: 'sunAzimuth',         category: 'Sun Position',  desc: 'Sun azimuth (radians)',            kind: 'fn' },
    { name: 'sunRA',              category: 'Sun Position',  desc: 'Sun right ascension (radians)',    kind: 'fn' },
    { name: 'sunDecl',            category: 'Sun Position',  desc: 'Sun declination (radians)',        kind: 'fn' },
    { name: 'sunEclipticLongitude', category: 'Sun Position', desc: 'Sun ecliptic longitude (radians)', kind: 'fn' },

    // ── Moon Position ───────────────────────────────────────────────────
    { name: 'moonAltitude',       category: 'Moon Position', desc: 'Moon altitude (radians)',          kind: 'fn' },
    { name: 'moonAzimuth',        category: 'Moon Position', desc: 'Moon azimuth (radians)',           kind: 'fn' },
    { name: 'moonAgeAngle',       category: 'Moon Position', desc: 'Moon phase angle (radians, 0=new)', kind: 'fn' },
    { name: 'realMoonAgeAngle',   category: 'Moon Position', desc: 'Moon age in days since new moon', kind: 'fn' },
    { name: 'moonRelativeAngle',  category: 'Moon Position', desc: 'Moon relative angle (radians)',   kind: 'fn' },

    // ── Clock / Calendar ────────────────────────────────────────────────
    { name: 'hour24Value',        category: 'Clock',     desc: 'Current hour (0–23, fractional)',   kind: 'fn' },
    { name: 'hour24Number',       category: 'Clock',     desc: 'Current hour (integer 0–23)',       kind: 'fn' },
    { name: 'minuteValue',        category: 'Clock',     desc: 'Current minute (fractional)',       kind: 'fn' },
    { name: 'secondValue',        category: 'Clock',     desc: 'Current second (fractional)',       kind: 'fn' },
    { name: 'dayOfWeekNumber',    category: 'Clock',     desc: 'Day of week (0=Sun, 6=Sat)',        kind: 'fn' },
    { name: 'dayOfMonthNumber',   category: 'Clock',     desc: 'Day of month (1–31)',               kind: 'fn' },
    { name: 'monthOfYearNumber',  category: 'Clock',     desc: 'Month of year (1–12)',              kind: 'fn' },
    { name: 'yearNumber',         category: 'Clock',     desc: 'Current year',                      kind: 'fn' },
    { name: 'dayOfYear',          category: 'Clock',     desc: 'Day of year (1–366)',               kind: 'fn' },
    { name: 'leapYear',           category: 'Clock',     desc: '1 if leap year, 0 otherwise',       kind: 'fn' },
    { name: 'tzOffset',           category: 'Clock',     desc: 'Timezone offset in hours',          kind: 'fn' },

    // ── Sidereal / Astronomical ─────────────────────────────────────────
    { name: 'siderealTime',       category: 'Astronomical', desc: 'Local sidereal time (radians)',   kind: 'fn' },
    { name: 'julianDayNumber',    category: 'Astronomical', desc: 'Julian day number',               kind: 'fn' },
    { name: 'eot',                category: 'Astronomical', desc: 'Equation of time (radians)',      kind: 'fn' },
    { name: 'precession',         category: 'Astronomical', desc: 'General precession since J2000',  kind: 'fn' },
    { name: 'obliquity',          category: 'Astronomical', desc: 'Obliquity of ecliptic (radians)', kind: 'fn' },

    // ── Math Functions ──────────────────────────────────────────────────
    { name: 'sin',   category: 'Math', desc: 'Sine',                      kind: 'fn', sig: '(x)' },
    { name: 'cos',   category: 'Math', desc: 'Cosine',                    kind: 'fn', sig: '(x)' },
    { name: 'tan',   category: 'Math', desc: 'Tangent',                   kind: 'fn', sig: '(x)' },
    { name: 'asin',  category: 'Math', desc: 'Arc sine',                  kind: 'fn', sig: '(x)' },
    { name: 'acos',  category: 'Math', desc: 'Arc cosine',                kind: 'fn', sig: '(x)' },
    { name: 'atan',  category: 'Math', desc: 'Arc tangent',               kind: 'fn', sig: '(x)' },
    { name: 'atan2', category: 'Math', desc: 'Two-argument arc tangent',  kind: 'fn', sig: '(y, x)' },
    { name: 'sqrt',  category: 'Math', desc: 'Square root',               kind: 'fn', sig: '(x)' },
    { name: 'abs',   category: 'Math', desc: 'Absolute value',            kind: 'fn', sig: '(x)' },
    { name: 'floor', category: 'Math', desc: 'Floor (round down)',        kind: 'fn', sig: '(x)' },
    { name: 'ceil',  category: 'Math', desc: 'Ceiling (round up)',        kind: 'fn', sig: '(x)' },
    { name: 'round', category: 'Math', desc: 'Round to nearest',          kind: 'fn', sig: '(x)' },
    { name: 'log',   category: 'Math', desc: 'Natural logarithm',         kind: 'fn', sig: '(x)' },
    { name: 'exp',   category: 'Math', desc: 'Exponential (e^x)',         kind: 'fn', sig: '(x)' },
    { name: 'pow',   category: 'Math', desc: 'Power',                     kind: 'fn', sig: '(base, exp)' },
    { name: 'min',   category: 'Math', desc: 'Minimum',                   kind: 'fn', sig: '(a, b)' },
    { name: 'max',   category: 'Math', desc: 'Maximum',                   kind: 'fn', sig: '(a, b)' },
    { name: 'fmod',  category: 'Math', desc: 'Floating-point modulus',    kind: 'fn', sig: '(a, b)' },
];

/**
 * Category display order. Categories not listed here appear at the end.
 */
export const CATEGORY_ORDER = [
    'Sun Times',
    'Moon Times',
    'Planet Times',
    'Sun Position',
    'Moon Position',
    'Clock',
    'Astronomical',
    'Planet Constants',
    'Math Constants',
    'Math',
];
