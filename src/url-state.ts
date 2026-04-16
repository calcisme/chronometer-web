/**
 * URL State — reads and writes application state to/from URL query parameters.
 *
 * This is the "poor-man's preference system" that works even on file:// URLs
 * where localStorage may be unavailable.
 *
 * Parameters:
 *   lat  - Observer latitude (degrees, negative = south)
 *   lon  - Observer longitude (degrees, negative = west)
 *   city - City/location label (URL-encoded, e.g. "San Francisco")
 *   bloc - Browser location: 1 = ask browser for location on startup
 *   tc   - Time controller popover visible (1 = shown, absent = hidden)
 *   t    - Display time as Unix ms (absent = real time)
 *   off  - Millisecond offset from real time (used for 1× forward with offset)
 *   dir  - Time direction: 1=forward, -1=reverse, 0=stopped (absent = 1)
 *   tz   - IANA timezone for the location (e.g. "America/Los_Angeles")
 */

export interface UrlState {
    lat: number | null;
    lon: number | null;
    city: string | null;
    bloc: boolean;
    tc: boolean;
    t: number | null;
    off: number | null;
    dir: 1 | -1 | 0;
    tz: string | null;
}

/** Parse URL query parameters into a typed state object. */
export function readUrlState(): UrlState {
    const params = new URLSearchParams(window.location.search);

    const latStr = params.get('lat');
    const lonStr = params.get('lon') || params.get('long');
    const lat = latStr !== null ? parseFloat(latStr) : NaN;
    const lon = lonStr !== null ? parseFloat(lonStr) : NaN;
    const city = params.get('city');
    const blocStr = params.get('bloc');

    const tcStr = params.get('tc');
    const tStr = params.get('t');
    const offStr = params.get('off');
    const dirStr = params.get('dir');

    let dir: 1 | -1 | 0 = 1;
    if (dirStr === '-1') dir = -1;
    else if (dirStr === '0') dir = 0;

    return {
        lat: !isNaN(lat) ? lat : null,
        lon: !isNaN(lon) ? lon : null,
        city: city || null,
        bloc: blocStr === '1',
        tc: tcStr === '1',
        t: tStr !== null ? parseInt(tStr, 10) : null,
        off: offStr !== null ? parseInt(offStr, 10) : null,
        dir,
        tz: params.get('tz') || null,
    };
}

/**
 * Merge state changes into the current URL using history.replaceState().
 * Default values are omitted from the URL to keep it clean:
 *   - tc is omitted when false
 *   - dir is omitted when 1 (forward)
 *   - t is omitted when null (real time)
 *   - lat/lon are omitted when null
 */
export function writeUrlState(changes: Partial<UrlState>): void {
    const params = new URLSearchParams(window.location.search);

    if ('lat' in changes) {
        if (changes.lat !== null && changes.lat !== undefined) {
            params.set('lat', changes.lat.toFixed(3));
        } else {
            params.delete('lat');
        }
    }
    if ('lon' in changes) {
        if (changes.lon !== null && changes.lon !== undefined) {
            params.set('lon', changes.lon.toFixed(3));
        } else {
            params.delete('lon');
        }
    }
    if ('city' in changes) {
        if (changes.city) {
            params.set('city', changes.city);
        } else {
            params.delete('city');
        }
    }
    if ('bloc' in changes) {
        if (changes.bloc) {
            params.set('bloc', '1');
        } else {
            params.delete('bloc');
        }
    }
    if ('tc' in changes) {
        if (changes.tc) {
            params.set('tc', '1');
        } else {
            params.delete('tc');
        }
    }
    if ('t' in changes) {
        if (changes.t !== null && changes.t !== undefined) {
            params.set('t', changes.t.toString());
        } else {
            params.delete('t');
        }
    }
    if ('off' in changes) {
        if (changes.off !== null && changes.off !== undefined) {
            params.set('off', changes.off.toString());
        } else {
            params.delete('off');
        }
    }
    if ('dir' in changes) {
        if (changes.dir !== undefined && changes.dir !== 1) {
            params.set('dir', changes.dir.toString());
        } else {
            params.delete('dir');
        }
    }

    if ('tz' in changes) {
        if (changes.tz) {
            params.set('tz', changes.tz);
        } else {
            params.delete('tz');
        }
    }

    // Also clean up legacy param
    params.delete('long');
    params.delete('loc');

    const qs = params.toString();
    const newUrl = window.location.pathname + (qs ? '?' + qs : '');
    history.replaceState(null, '', newUrl);

    // Update any navigation links on the page
    updateNavigationLinks();
}

/** Return the current query string (including leading '?'), or '' if none. */
export function getQueryString(): string {
    return window.location.search;
}

/**
 * Update all navigation links on the page to carry the current query params.
 * This ensures lat/lon/tc/t/dir are preserved across page transitions.
 */
export function updateNavigationLinks(): void {
    const search = window.location.search;
    // Update back-link (← Home)
    const backLink = document.getElementById('back-link') as HTMLAnchorElement | null;
    if (backLink) {
        const url = new URL(backLink.getAttribute('data-base-href') || 'index.html', window.location.href);
        url.search = search;
        backLink.href = url.toString();
    }
    // Update face-card links (index page)
    document.querySelectorAll('a.face-card').forEach((a) => {
        const anchor = a as HTMLAnchorElement;
        const url = new URL(anchor.getAttribute('data-base-href') || anchor.getAttribute('href')!, window.location.href);
        url.search = search;
        anchor.href = url.toString();
    });
}

/**
 * Initialize link preservation. Call once on page load.
 * Saves original hrefs as data-base-href so they can be re-computed
 * each time query params change.
 */
export function initNavigationLinks(): void {
    const backLink = document.getElementById('back-link') as HTMLAnchorElement | null;
    if (backLink && !backLink.hasAttribute('data-base-href')) {
        backLink.setAttribute('data-base-href', backLink.getAttribute('href') || 'index.html');
    }
    document.querySelectorAll('a.face-card').forEach((a) => {
        const anchor = a as HTMLAnchorElement;
        if (!anchor.hasAttribute('data-base-href')) {
            anchor.setAttribute('data-base-href', anchor.getAttribute('href')!);
        }
    });
    updateNavigationLinks();
}
