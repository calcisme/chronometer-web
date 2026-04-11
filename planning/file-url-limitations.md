# file:// URL Limitations

When the app is opened by double-clicking an HTML file (loading via `file://` protocol rather than a web server), some features are unavailable or degraded due to browser security restrictions.

## Known Limitations

### 1. No detailed map in location picker
- **What**: The OSM (OpenStreetMap) tile map in the "Set Location" dialog is not shown.
- **Why**: OSM's tile servers require a valid HTTP `Referer` header. Browsers do not send a `Referer` for `file://` URLs, so OSM returns 403 Forbidden.
- **Fallback**: The Blue Marble globe is shown instead — enlarged to 160px — giving a "where on Earth" view without street-level detail.

### 2. Browser geolocation may not work
- **What**: The "Use browser location" button may be unavailable.
- **Why**: Some browsers restrict the Geolocation API to "secure contexts" (`https://` and `localhost`). `file://` URLs are not considered secure in all browsers.
- **Fallback**: Users can search for a city/airport by name or enter coordinates manually.

## Unaffected Features

The following all work normally from `file://`:

- Watch face rendering (all faces)
- City/airport search (data is bundled in `cities-data.js`)
- Manual lat/lon coordinate entry
- Time controller (forward/reverse/step)
- URL state persistence (lat, lon, city, time settings)
- Navigation between watch faces
- All astronomical calculations
