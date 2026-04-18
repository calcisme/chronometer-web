# Slot Architecture for World-Time Features

**Date:** 2026-04-18

## Overview

Watch faces that display time in multiple locations use a **slot** system to
manage per-city data (city name, Olson timezone ID, latitude, longitude).
Slots are numbered starting from **1** and are managed entirely by the engine
at runtime — no hardcoded face-name checks remain.

Each face declares which features it uses via boolean attributes on the
`<watch>` root element in its XML:

| Attribute           | Description                                               |
|---------------------|-----------------------------------------------------------|
| `worldTimeRing`     | 24-city ring around the dial (Terra-style)                |
| `worldTimeSubdials` | Separate subdials for 3–4 cities (Gaia-style)             |
| `planetSelector`    | User-switchable planet display (Venezia-style)            |

These are parsed into the `Watch` TypeScript interface and used throughout the
engine to gate feature-specific logic. A hypothetical face could declare
multiple features and the engine would allocate slots for each independently.

---

## Slot Numbering (1-based)

On iOS, Terra used env slots 5–28 (inheriting from the Gaia/Terra dual-face
architecture where Gaia occupied slots 1–4). For the web app, all slot ranges
are **1-based**:

### `worldTimeRing` (e.g. Terra)

| Slots | Count | Purpose |
|-------|-------|---------|
| 1–24  | 24    | One slot per UTC hour offset (−11 to +12) |

The default city assignments are defined in `TERRA_RING_DEFAULTS` in
`watch-env.ts`. Key constants:

- `FIRST_ENV_SLOT = 1` (terra-slots.ts)
- `UTC_SECTOR_NUMBER = 11` (unchanged — sector index within the ring)
- Slot-to-offset formula: `offsetHour = slot - FIRST_ENV_SLOT - UTC_SECTOR_NUMBER`
- London (UTC±0) = **slot 12**

The XML `firstRingSlot` variable is set to `1`, and `UTRingSlot` to `12`.
All 24 QWedge date-color hands and Qhand dot references use
`firstRingSlot + N` where N ranges from 0 to 23.

### `worldTimeSubdials` (e.g. Gaia)

| Slot | Purpose                    |
|------|----------------------------|
| 1    | Observer's location (auto) |
| 2    | Upper subdial city         |
| 3    | Right subdial city         |
| 4    | Lower subdial city         |

Slot 1 is automatically populated with the device/browser location. Its city
name is resolved from `locationSource` (if available from URL `city=` param)
or via `findClosestCity()` once the city database loads.

Slots 2–4 default to `GAIA_SUBDIAL_DEFAULTS` in `watch-env.ts` (New York,
London, Sydney). The number of subdial slots is driven by
`watch.maxSeparateLoc` (from the XML attribute), defaulting to 4.

---

## URL Parameter Encoding

To avoid collisions when multiple features coexist on the same page, each
feature uses a distinct **URL prefix**:

| Feature             | Prefix | Example params                            |
|---------------------|--------|-------------------------------------------|
| `worldTimeRing`     | `r`    | `r5=Denver&r5tz=America/Denver&r5lat=...` |
| `worldTimeSubdials` | `d`    | `d2=Tokyo&d2tz=Asia/Tokyo&d2lat=...`      |

Each slot stores four URL parameters:
- `{prefix}{slot}` — city display name
- `{prefix}{slot}tz` — Olson timezone ID
- `{prefix}{slot}lat` — latitude
- `{prefix}{slot}lon` — longitude

If two faces on the same page share a feature (e.g. both declare
`worldTimeRing`), they share the same slot overrides — which is the desired
behavior.

---

## Slot Override Flow

```
URL params → buildSlotOverrides(watch)
                 ↓
         Record<number, TerraSlot> | undefined
                 ↓
         createWatchEnvironment(watch, lat, lon, getNow, tz, overrides)
                 ↓
         env._terraSlots  ← merged defaults + overrides
                 ↓
         Renderer reads _terraSlots for labels, channels, dots
         Engine reads _terraSlots for post-render overlays (Gaia 24hr labels)
```

### `buildSlotOverrides(watch: Watch)`

Located in `engine-entry.ts`. Checks the watch's feature flags:

1. **`worldTimeRing`**: Reads `r1`..`r24` from URL. Returns overrides only
   for slots that have URL data; unfilled slots use `TERRA_RING_DEFAULTS`.

2. **`worldTimeSubdials`**: Always creates slot 1 (observer), then reads
   `d2`..`dN` from URL for the remaining subdials. Slots without URL data
   fall back to `GAIA_SUBDIAL_DEFAULTS`.

3. **Neither**: Returns `undefined` (no overrides).

### City Customization Dialog

Both Terra and Gaia reuse the same `terra-city-dialog.html` partial. The
engine wires it up differently per feature:

- **Terra**: User searches for a city → engine validates which ring slots
  (UTC offsets) are compatible → assigns to slot. Uses `validSlotsForTz()`
  from `terra-slots.ts`.

- **Gaia**: User searches for a city → always shown the subdial picker
  (Upper / Right / Lower) → assigns to chosen subdial. No timezone
  validation needed since any city can go on any subdial.

Both write overrides to the URL (with `r` or `d` prefix) and rebuild the
face environment.

---

## Key Source Files

| File | Role |
|------|------|
| `src/watch/types.ts` | `Watch` interface with feature flag fields |
| `src/watch/xml-parser.ts` | Parses `worldTimeRing`, `worldTimeSubdials`, `planetSelector` from XML |
| `src/watch/watch-env.ts` | `TERRA_RING_DEFAULTS`, `GAIA_SUBDIAL_DEFAULTS`, creates environment with slot data |
| `src/watch/terra-slots.ts` | Slot↔offset conversion, timezone validation for ring slots |
| `src/watch/renderer.ts` | Reads `_terraSlots` for city labels, channel lines, dots |
| `src/engine-entry.ts` | `buildSlotOverrides()`, city dialog wiring, URL param I/O |
| `src/watch/assets/terra/Terra-I.xml` | `firstRingSlot=1`, `UTRingSlot=12`, all 24 Qhand/QWedge refs |
| `src/watch/assets/gaia/Gaia-I.xml` | `worldTimeSubdials='1'`, `maxSeparateLoc='4'` |
