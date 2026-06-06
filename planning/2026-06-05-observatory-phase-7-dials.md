# Observatory Port — Phase 7: Peripheral Dials + Date Display

> Dated planning doc for Phase 7 of the [Observatory web port](2026-05-26-observatory-port.md).
> Status: ✅ complete (verified 2026-06-06). Alt/az/EOT dials, date display, and
> animated planet switching all done and visually confirmed.
>
> **Not included — next up:** the eclipse simulator (central disc + status label,
> and later the ring-indicator hands) is **Phase 7B**, to be done as its own task
> with a dedicated plan. The eclipse layout slot (`eclipseCX/CY/R1/R2`) is
> currently left empty.

## Context

Phases 0–6 complete (orrery, planet hands, rings, clock hands, subdials, Earth map, Moon phase). Phase 7 fills in the **peripheral corner dials and the header date display**.

Scope decisions:
- **Eclipse simulator deferred entirely** to its own future plan. The eclipse layout slot stays empty.
- **Alt/Az dials interactive**: clicking the altitude dial advances the selected body and the azimuth dial reverses it (opposite directions, skipping Earth — matches iOS EOClock.mm:739-762), persisted in URL `op`, default Sun.
- **Phase 8 repurposed** → "Tune the layout" (the time controller already exists; the date display moved into Phase 7).

Delivers: Altitude dial, Azimuth dial, Equation-of-Time dial, planet selection, and the date display.

## Implementation

### New files
- **`src/observatory/peripheral-dials.ts`** — static backgrounds in a full-viewport OffscreenCanvas cache (mirrors `main-dial.ts`): `getPeripheralDialsCache(L)` / `invalidatePeripheralDialsCache()`. Ports `EOAltitudeDialShuffleView` / `EOAzimuthDialShuffleView` (EOShuffleView.mm) and a reworked **asymmetric** EOT dial (see below).
- **`src/observatory/peripheral-hands.ts`** — `drawPeripheralHands(ctx, L, u, selectedPlanet)` (alt/az/EOT triangle hands + selected-body labels) and `cycleSelectablePlanet(current, dir)` (altitude dial = +1, azimuth dial = −1).
- **`src/observatory/date-view.ts`** — `drawDateView(ctx, L, date, timezone)`: weekday, month+day, year, leap/not-leap (Gregorian %4/%100/%400), tz abbrev, via `Intl.DateTimeFormat` in the location timezone.

### Modified
- **`obs-values.ts`** — `DIAL_BODIES` table + `DialBodyKey`; two selected-body values `dialAlt` = `altitudeOfPlanet(dialPlanet) - pi/2` (linear) and `dialAz` = `azimuthOfPlanet(dialPlanet)`, driven by the `dialPlanet` env variable; `eotAngle` = `24 * EOTAngle()`.
- **`observatory-entry.ts`** — composite the peripheral cache; `drawPeripheralHands` + `drawDateView`; `selectedPlanet` module state from `urlState.op`; sets the `dialPlanet` env variable in `init()` and `rebuildEnv()`; canvas `click` handler hit-tests alt/az circles → `cycleSelectablePlanet` (forward on altitude, backward on azimuth), updates `dialPlanet`, `writeUrlState({op})`, and `updater.reset()` so the hands **animate** to the new body (same sweep as a location change); invalidate cache on resize.
- **`hand-views.ts`** — export `drawTriangleHand`.
- **`url-state.ts`** — add integer `op` key (0 omitted as default).

### Asymmetric EOT dial
Adopts the Mauna Kea / Vienna logic (`renderer.ts drawEotDial`) in the Observatory subdial style:
- `0` at top, `radPerMin = π/30` (15 min = 90°), `+` right / `−` left.
- Real extremes `EOT_MAX_MIN = 16.5`, `EOT_MIN_MIN = -14.2`.
- Solid band −14.2…+16.5; the unused **−14.2…−15** sliver (arc + −15 tick + −15 label + "−") drawn at reduced alpha (0.35), so the left edge still reaches 9 o'clock while the right side runs longer to +16.5.
- Ticks every minute (major at 0/±5/±10/±15), numbers `0/5/10/15`, `+`/`−` symbols, "Equation of Time" title, center hub + vertical baseline.
- Hand angle `24 * EOTAngle()`.

## Astronomy
No `astro-env.ts` / `es-astro.ts` changes — `altitudeOfPlanet`, `azimuthOfPlanet`, `EOTAngle` already registered.

## Out of scope
Eclipse simulator (own plan; slot empty); layout fine-tuning (Phase 8).

## Verification
- **Automated:** `npx tsc --noEmit` ✅; `./build.sh` ✅; `grep -c 'watch/' dist/observatory-engine.js` = 1 (unchanged — pre-existing `terminator.ts` comment, no new coupling).
- **Visual (user):** alt half-gauge tracks selected body; az compass tracks azimuth; click cycles body + label updates + survives reload (`op`); EOT hand within ±~15 min matching another face; date/weekday/year/leap/tz correct and update on scrub; animation smooth; eclipse corner empty.
