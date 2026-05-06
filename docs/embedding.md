# Embedding

Chronometer's **Terra** face can be embedded in other websites via an iframe. The
embedded face shows only the watch — no controls, no location bar, no navigation
— on a fully transparent background.

## Quick Start

Basic embed (uses the visitor's browser timezone automatically):

```html
<iframe
  src="https://your-host/terra.html?embed=1"
  style="width: 300px; height: 300px; border: none;"
  loading="lazy"
></iframe>
```

With an explicit timezone override:

```html
<iframe
  src="https://your-host/terra.html?embed=1&tz=Europe/London"
  style="width: 300px; height: 300px; border: none;"
  loading="lazy"
></iframe>
```

The iframe dimensions control the face size. The face scales to fit the
smallest dimension, so square iframes work best.

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `embed`   | Yes      | Set to `1` to activate embed mode |
| `tz`      | No       | IANA timezone override (e.g. `America/New_York`). If omitted, the visitor's browser timezone is used automatically |

## Styling Notes

- The background is fully transparent — the face floats over whatever is behind
  the iframe.
- The canvas retains `border-radius: 50%` for circular clipping. The embedding
  page can add its own `box-shadow`, border, or background.
- Set `border: none` on the iframe to avoid the default browser border.

## Design Rationale

### Why Only Terra?

Terra is the only face that does not require a real geographic location to
function correctly. All it needs is a **timezone** — the world-time ring
positions each city by UTC offset, and the clock hands show the local time
for that timezone.

All other faces use the observer's latitude and longitude for astronomical
calculations: sunrise/sunset times, moon altitude, terminator angles, planet
positions, etc. These computations require actual coordinates, which in turn
require either:
- A geolocation permission prompt — unacceptable for an embed, where the
  visitor hasn't chosen to interact with the page
- Explicit `lat`/`lon` URL parameters — this would impose a complexity
  requirement on the embedding page, and would likely produce a surprising
  user experience. If the embedding page hardcoded a location, it would not
  match most visitors' actual location. If it instead requested the browser's
  geolocation, visitors would see an unexpected permission prompt from an
  embedded iframe they didn't ask to interact with.

Since Terra avoids this requirement, it can run with hardcoded `(0, 0)`
coordinates and a timezone detected from the browser's `Intl` API — no
permissions, no prompts, no user interaction needed.

### Implementation Details

When `embed=1` is set:

1. **Location**: Hardcoded to `(0, 0)`. Timezone detected via
   `Intl.DateTimeFormat().resolvedOptions().timeZone`, or overridden by `?tz=`.
2. **City database**: Not loaded (~19 MB saved).
3. **UI chrome**: All non-face DOM elements are removed (not just hidden).
4. **Background**: Transparent via `body.embed-mode` CSS class.
5. **Sizing**: Face fills the full viewport; the iframe dimensions determine
   the rendered size.

## Related Docs

- [World-Time Slots](world-time-slots.md) — How Terra's 24-city ring works
- [Location & Cities](location-and-cities.md) — Normal location resolution flow
- [Development Rules §8](development-rules.md#8-interactive-controller-patterns) — URL parameter patterns
