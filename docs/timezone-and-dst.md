# Timezone & DST Transition Detection

The timezone system translates between the browser's local time and the location's timezone, and detects DST (Daylight Saving Time) transitions to trigger environment rebuilds so astronomical calculations, day/night rings, and timezone display labels stay accurate.

## Timezone Offset Model

### `tzDeltaMs` — The Core Offset

The watch environment uses a millisecond delta (`tzDeltaMs`) to shift the browser's local time to the location's timezone:

```
target local time = browser local time + tzDeltaMs
```

This is computed by `computeTzDeltaMs(olsonTimezone, referenceDate?)` in `watch-env.ts`:

1. Get the browser's UTC offset at the reference date (`-Date.getTimezoneOffset() * 60`)
2. Get the target timezone's UTC offset at the same date (via `Intl.DateTimeFormat` with `longOffset`)
3. Return the difference in milliseconds

The reference date matters because UTC offsets change at DST boundaries. When displayed time is offset from real time (1× with offset, scrubbing), the reference date must be the **displayed** time, not the real time.

### `tzOffsetSec` — Baked Into Environments

`tzOffsetSec` is the target timezone's total UTC offset in seconds (east-positive), captured as a constant when the environment is created. It's used by:

- Day/night ring sunrise/sunset calculations
- Calendar date computations
- Any astronomy expression that needs local time

Because it's a snapshot, it becomes **stale** when the displayed time crosses a DST boundary. The DST detection system triggers an environment rebuild at that moment.

### `liveDate()` — Real-Time Clock Hands

Clock hand expressions use `liveDate()`, which applies `tzDeltaMs` to the current `getNow()` result. For the special case where `tzDeltaMs === 0` (browser TZ equals location TZ), `liveDate()` passes through `getNow()` directly, and JavaScript's `Date.getHours()` applies the correct DST rules for the represented date automatically. This is why **clock hands update correctly at DST boundaries even before the environment rebuild fires**.

## DST Detection Architecture

The system uses two complementary mechanisms:

### 1. Precision Timer (`scheduleDstRebuild`)

For expected DST transitions, a `setTimeout` fires at the exact moment the displayed time crosses the boundary.

**Forward search** (`findNextDstTransition` in `dst-detect.ts`):
1. Probe forward from the displayed time at 14-day intervals (up to ~420 days)
2. When the UTC offset changes between two probes, binary search between them
3. Converge to two adjacent minutes with different offsets
4. Return the top of the later minute (snapped to `XX:XX:00.000`)

**Backward search** (`findPrevDstTransition`):
- Same algorithm but probing backward — used when time is running in reverse (-1× mode)
- The binary search convergence and minute-snapping logic are identical

**Direction awareness**: `scheduleDstRebuild()` checks `timeController.currentDirection`:
- Forward (1×): uses `findNextDstTransition`
- Backward (-1×): uses `findPrevDstTransition`

**Delay computation**: `Math.abs(transitionTime - displayedNow)` — works for both directions since in 1× or -1× mode, display-time delta equals real-time delta.

**Chaining**: If the transition is more than ~24.8 days away (exceeding `setTimeout`'s `2^31 - 1` ms limit), a chain timer wakes at 24 days to re-evaluate.

**Rescheduling**: `scheduleDstRebuild()` is called from `rebuildEnvironments()`, which runs on every `onTick` callback (direction changes, rate changes, steps, quantized ticks). This ensures the timer is always set for the correct transition relative to the current displayed time and direction.

### 2. Lightweight Browser TZ Poll

For unanticipated timezone changes (user manually changes OS timezone), a 1-second `setInterval` compares `Intl.DateTimeFormat().resolvedOptions().timeZone` against a cached value. If the IANA timezone *name* changes:

1. Log the change
2. Call `handleDstTransition()` (immediate env rebuild)
3. Call `scheduleDstRebuild()` (reschedule for the new TZ)

This poll only checks the string name — it's extremely lightweight. It does **not** detect DST transitions within the same timezone (that's the precision timer's job).

## Environment Rebuild (`handleDstTransition`)

When a DST transition is detected, the rebuild follows the animation-preserving pattern (§3 from development rules):

1. Recompute `tzDeltaMs` using the **displayed** time as reference
2. For each face:
   - Create a fresh `Environment` (new `tzOffsetSec`, updated astronomy closures)
   - Invalidate `QDayNightRing` render caches
   - Update terminator leaf angles and reset their schedules
   - Rebuild static block caches
   - Reset hand schedules (forces immediate re-evaluation)
3. Update the timezone display label
4. Restart the scheduler (cancel stale idle timers, start fresh rAF)

Hand states, animation state, and part trees are **preserved** — only the environment and caches are replaced.

## Timezone Display Label

The time bar shows the location's timezone as: `America/Los_Angeles (PDT) UTC-7:00`

`formatTimezoneDisplay(olsonId, referenceDate?)` formats this using `Intl.DateTimeFormat`:
- `timeZoneName: 'short'` → abbreviation (e.g., "PDT", "EST")
- `timeZoneName: 'longOffset'` → UTC offset (e.g., "GMT-07:00")

The `referenceDate` parameter ensures the abbreviation and offset reflect the **displayed** date, not the current date. When the user scrubs to January (PST), the label correctly shows "PST" and "UTC-8:00" even though the real date might be in PDT.

`updateTimezoneDisplay()` is called from:
- `updateTimeUI()` — on every time scrub step
- `handleDstTransition()` — after environment rebuild
- `applyLocation()` — after location change

## Time Step Arithmetic

`advanceByUnit()` in `time-controller.ts` uses **absolute millisecond arithmetic** for sub-day units:

```typescript
case 'hour': return new Date(date.getTime() + direction * 3_600_000);
```

This avoids `Date.setHours()` which applies the **browser's** DST rules — problematic because:
1. The browser timezone may differ from the location timezone
2. At spring-forward, `setHours(getHours() + 1)` skips 2 absolute hours instead of 1

Absolute arithmetic always advances by exactly 3,600,000 ms regardless of DST boundaries. The display layer then shows the correct local time via `liveDate()`.

Month and year steps remain calendar-aware (variable-length arithmetic).

## Key Source Files

| File | Purpose |
|------|---------|
| `src/dst-detect.ts` | `findNextDstTransition`, `findPrevDstTransition`, `getTimezoneOffsetMinutes` |
| `src/__tests__/dst-detect.test.ts` | 70 tests covering forward/backward search, 30+ timezones, Lord Howe Island |
| `src/engine-entry.ts` | `handleDstTransition`, `scheduleDstRebuild`, browser TZ poll, `formatTimezoneDisplay` |
| `src/watch/watch-env.ts` | `computeTzDeltaMs`, `registerTimeFunctions` (captures `tzDeltaMs`/`tzOffsetSec`) |
| `src/time-controller.ts` | `advanceByUnit` (absolute ms arithmetic), `TimeController` |

## Related Docs

- [Location & Cities](location-and-cities.md) — How observer position feeds into timezone resolution
- [Animation](animation.md) — Two-time-base architecture, schedule resets
- [Architecture Overview](architecture-overview.md) — No-backend design constraint
