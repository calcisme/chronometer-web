# Observatory Phase 8B — Layout Refinement Plan

**Date:** 2026-06-10
**Status:** ✅ Implemented — awaiting user visual verification & tuning.
Notes vs plan: the popover exclusion is implemented conservatively — the
vertical arm narrows the effective layout width and the lower arm bottom-clamps
right-side elements; the "rim tucks into the L's notch" refinement is deferred
to tuning. On windows too short to absorb the popover (e.g. phone landscape,
where the popover is taller than the window) it falls back to plain overlay.
Verified at 768×1024, 390×844, 900×900, 1280×800, 844×390, and popover open at
1280×800 + 768×1024 (re-solve + toggle-back). Pre-existing, unrelated Milano
regression failures at HEAD flagged separately.
**Parent:** [2026-06-06-observatory-phase-8-layout.md](2026-06-06-observatory-phase-8-layout.md)
(the adaptive two-template layout, now functional)

---

## 1. What we keep (confirmed good)

1. **iPad-portrait relative positioning** — header (moon ◂ map ▸ date) over a
   near-full-width dial with corner-gap peripheral dials.
2. **iPhone-portrait dial** — full-width main dial.
3. **Wide-landscape dial + dial sizes** — near-full-height main dial; outer
   dials approximately right.

## 2. What changes (the six improvements)

| # | Improvement | Summary of approach |
|---|-------------|---------------------|
| R1 | Moon ≥ outer dial | Hard constraint `moonR ≥ extR`; aesthetic target `moonR ≈ 1.25·extR` (portrait) / `1.5·extR` (landscape), per iOS |
| R2 | Date area too small | Layout allocates a date **box**; date rendering scales to fill it, with the **full weekday name as the most prominent element** (glance-for-weekday is a UX goal) |
| R3 | iPhone-portrait blank space | Header becomes two bands (moon+map grow; date gets its own row); block stays centered |
| R4 | Dials too close | Universal gap `g = max(6px, k·extR)` — bigger dials push farther apart |
| R5 | Time-bar shows date again | Observatory-scoped CSS hides date/rate/Now; keep button + red offset |
| R6 | Layout ignores bottom chrome | One combined footer row, measured and **reserved**; popover = exclusion rect |

---

## 3. iOS aesthetic reference ratios

From `EOClock.mm initializeConstantsForOrientation:` — these are the balance
targets, not exact values to reproduce.

| Ratio | iOS portrait (768×1024) | iOS landscape (1024×768) |
|---|---|---|
| dial Ø ÷ shorter dim | 730/768 = **0.95** | 657/768 = **0.855** |
| extR ÷ mainR | 60/365 = **0.164** | 60/328.5 = **0.183** |
| moonR ÷ extR | 75/60 = **1.25** | 90/60 = **1.5** |
| map width ÷ dial Ø | 300/730 = **0.41** | 270/657 = **0.41** ← invariant! |
| map width ÷ window W | 0.39 | 0.26 |
| date box | 228×75 (≈ 0.30·W × half the header) | **split**: weekday bottom-left, date+year bottom-right (dateH=75) |
| gap, dial rim ↔ ext dial | ≈ 38 px (≈ 0.63·extR) | side-margin placement |

Notable: iOS keeps **mapW ≈ 0.41·D** in both orientations, and its gaps are
much more generous than our current 8px-clamped-to-2px rule. The moon is
*always* substantially bigger than an ext dial.

**Date typography (EOClock.mm L1941–1947, L374–382):** the weekday
(`EEEE` — "Saturday", shrink-to-fit) and the month/day (`MMM dd` — "Jun 10")
are both **48 pt** (Heiti J → Arial); the year is **20 pt** (0.42×); "leap" is
**10 pt** (0.21×). Relative scale to adopt:

| Element | Format | Relative size |
|---|---|---|
| Weekday | `Saturday` (full name) | **1.0** (shrink-to-fit its box) |
| Month + day | `Jun 10` | **1.0** |
| Year | `2026` | 0.42 |
| Leap indicator | `leap` — **shown only in leap years**, nothing otherwise | 0.21 |
| TZ abbrev | `PDT` | 0.21 |

Our current `date-view.ts` has the hierarchy inverted (weekday 11·s is the
*smallest*, month/day bold 16·s) and shows "not leap" — both get fixed here.
In iOS portrait the vertical stack is month/day (top), year+leap (middle),
weekday (bottom); we may instead put the weekday on top since it's the
glanceable element — decide by eye during implementation.

---

## 4. Inputs the layout must now consume

The canvas layout currently pretends the DOM overlays don't exist. New inputs
to `computeLayout`:

```
computeLayout(viewW, viewH, chrome: {
    footerH: number;          // measured height of the combined footer row
    popoverRect: Rect | null; // bounding box of #time-popover when open
})
```

- **Footer row** (always present): merge today's two strips — `#time-bar`
  (bottom:36px, full-width) and `#observatory-controls` (bottom:12px, right) —
  into **one** fixed bottom row, height ≈ 30 px:

  ```
  [fps?]   [⏱ Show time controller] [+2:00:00]        [San Francisco · SET LOCATION]
  left            center-left (red offset)                        right
  ```

  The fps label (`?fps` only) already sits bottom-left at the same height; it
  joins this row visually and needs no extra reserve. Layout uses
  `H' = H − footerH` everywhere it used `H`.

- **Time controller popover** (when open; persists via `?tc=1`, so it is a
  stable mode, not a transient flash): the goal is that **the entire display
  remains visible** while the controller is up — elements **resize/reflow to
  fit**, including the main dial if necessary. The popover is **L-shaped**
  (`#tp-upper` = narrow vertical column on the right, `#tp-lower` = wide bar
  along the bottom, notch at the L's upper-left), so model it as **two
  exclusion rects**, not one bounding box — the dial's circular rim can tuck
  into the notch, often costing little or no dial size. Layout solves exactly
  as if those two rects were outside the window. Relayout hook already exists
  (`onPopoverToggle` in `initTimeControls`); the two arm rects come from
  `getBoundingClientRect()` on `#tp-upper`/`#tp-lower`. The resize on toggle is
  instant (no animation), matching how window resizes behave.

- **R5 (time-bar contents):** hide `#time-bar-date`, `#time-bar-rate`, and the
  `Now` button via Observatory-scoped CSS in `observatory.html` (the partial is
  shared with Chronometer — don't touch the shared CSS/markup). Keep
  `#time-bar-offset` (the red offset). Add a comment in `observatory.html`
  explaining the rule so it doesn't regress again. (Returning to real time then
  happens via the popover's `Now▶` — acceptable.)

---

## 5. Universal sizing rules

Let `S = min(W, H')`, `L = max(W, H')`, `D` = dial diameter.

1. **Gap** (R4): `g = clamp(0.4·extR, 6, 24)` — never below 6 px; grows with
   the outer dials. (Replaces the old 8px→2px dpr rule; iOS uses ≈ 0.6·extR.)
2. **Dial** (unchanged): `D = clamp(min(0.95·S, fit), 0.75·S, 0.95·S)` against
   `H'`, not `H`.
3. **Map**: target `mapW ≈ 0.41·D` (the iOS invariant), allowed to grow beyond
   when its region permits (it's priority #2), fixed 2:1 aspect.
4. **Moon** (R1): `moonR = clamp(c·extR, extR, space)` with `c = 1.25`
   (portrait) / `1.5` (landscape). If the moon's region can't hold `extR`,
   **shrink extR** (the dials yield to the moon, not vice versa).
5. **Date box** (R2): layout emits `dateX/dateY/dateW/dateH` + a mode
   (`stack`, `row`, or `split` — see §6.4). `date-view.ts` scales its font
   block uniformly to fit the box, using the iOS hierarchy from §3: weekday and
   month/day at full size (weekday shrink-to-fit), year at 0.42×, leap/tz at
   0.21×; "leap" appears only in leap years. The date may **split into two
   blocks** (weekday | month-day+year) when that packs better — iOS landscape
   precedent. *Note:* scaling here does not violate the "no responsive font
   scaling" decision — that rule protects dial labels from swamping functional
   elements; the date area is pure text in its own region, and expanding it is
   the explicit goal.
6. **Priority cascade** (unchanged): dial → map → moon → ext dials → date
   grows last but has a guaranteed minimum (its current size).

---

## 6. Per-regime layouts

### 6.1 iPad portrait (e.g. 768×1024) — keep, polish

```
┌──────────────────────────────────────┐
│   ◐      ┌─────────────┐  SATURDAY   │  header ≈ mapH + 2g
│  moon    │  world map  │  Jun 10     │  mapW ≈ 0.41·D; moon centered in
│ Ø≈1.25·  │   (2:1)     │  (both big) │  left gap; date box fills right
│  extØ    └─────────────┘  2026 ·PDT  │  gap (≈0.3·W), iOS 48/48/20 ratios
│      ╭─────────────────────╮         │
│ (alt)│                     │(ecl)    │  dial D = min(0.95·W, H'−header)
│      │                     │         │
│      │      main dial      │         │  ext dials in the corner gaps,
│      │                     │         │  extR ≈ 0.165·mainR (iOS ratio),
│ (az) │                     │(eot)    │  ≥ g from rim and edges
│      ╰─────────────────────╯         │
│ [fps] [⏱ controller] [+off]  [SF·SET]│  footer row (reserved, ≈30px)
└──────────────────────────────────────┘
```

Changes vs today: date box ~3× larger (fills its slot like iOS's 228×75),
gaps ≥ 6px via the new rule, footer reserved (dial no longer collides with the
bottom strips), moon already ≥ extR here.

### 6.2 iPhone portrait (e.g. 390×844) — use the vertical surplus (R3)

```
┌──────────────────┐
│  ◐    ┌────────┐ │  band 1: moon + map share the width:
│ moon  │  map   │ │   2·moonR + mapW ≈ W − 3g, map priority,
│       │ (2:1)  │ │   moonR ≥ extR floor → map ≈ 0.7·W → H ≈ 0.35·W
│       └────────┘ │
│ SATURDAY         │  band 2: date as a single ROW (mode: row),
│  Jun 10 · 2026   │   full width; weekday dominant, may wrap
│                  │   to two lines on the narrowest windows
│ ╭──────────────╮ │
│ │              │ │  dial D = 0.95·W (unchanged)
│ │  main dial   │ │
│ │              │ │  ext dials stay in the corner gaps
│ ╰──────────────╯ │
│                  │  leftover surplus → padding between bands
│ [⏱][+off][SF·SET]│  footer row
└──────────────────┘
```

The vertical surplus goes: (1) map+moon grow until band 1 fills the width,
(2) date gets its own row, (3) remaining surplus becomes even padding between
bands (block stays centered, as today). The map roughly doubles in height
(164→~270 wide on a 390 window).

### 6.3 Square-ish (e.g. 900×900) — portrait template at the floor

Same structure as 6.1 with `D = 0.75·S`; header compresses to its minimums
(map at 0.41·D, moon at 1.25·extR, date at minimum scale). No structural
change from today besides gaps/footer/date-box.

### 6.4 iPad landscape (e.g. 1024×768) — margins get column packing

```
┌────────────────────────────────────────────────┐
│  ◐ moon      ╭───────────────╮   ┌──────────┐  │
│  Ø=1.5·extØ  │               │   │ map (2:1)│  │  map = corner box,
│              │               │   └──────────┘  │  target ≥ 0.41·D
│  (alt)       │   main dial   │       (ecl)     │
│              │  D = 0.95·H'  │                 │  inner columns: dials
│  (az)        │               │       (eot)     │  nestled beside circle
│              │               │                 │
│ SATURDAY     ╰───────────────╯       Jun 10    │  date SPLITS (iOS):
│  (big)                              2026 leap  │  weekday BL corner,
│ [fps] [⏱ controller] [+off]          [SF·SET] │  month/day+year BR corner
└────────────────────────────────────────────────┘
```

Left margin = two logical slots: **moon** (top corner) and **weekday** (bottom
corner) on the outside; **alt/az** nestled against the circle. Right margin:
**map** (top corner), **ecl/eot** beside the circle, **month/day + year**
(bottom corner). The date **split** (iOS landscape precedent: weekday
bottom-left at 48 pt, date+year bottom-right) halves the vertical demand on
each margin — that flexibility is what lets the moon rule and the dial sizes
coexist in short windows. The packing solve:

```
extR = min( 0.45·mainR,                          // absolute cap (current)
            (H' − 2·moonR − dateH − 5g) / 4,     // vertical fit, left stack
            horizontal fit when moon and dials share the margin width )
with moonR = 1.5·extR  →  one linear solve, e.g. vertical:
            extR ≤ (H' − dateH − 5g) / 7
```

### 6.5 iPhone landscape (e.g. 844×390) — same rules, tighter numbers

```
┌──────────────────────────────────────────────────┐
│  ◐ moon   (alt) ╭──────────╮ (ecl)  ┌─────────┐  │
│  ≥ extØ         │   main   │        │ map 2:1 │  │
│                 │   dial   │        └─────────┘  │
│ SATURDAY  (az)  │ D≈0.95·H'│ (eot)    Jun 10     │
│ [⏱][+off]      ╰──────────╯          2026 [SF·SET]│
└──────────────────────────────────────────────────┘
```

Here the margins are wide (≈250px each side) but short; moon and the dial
column sit **side by side** (moon outer, dials inner). The joint horizontal
solve `2·moonR + 2·extR + 3g ≤ sideMargin` with `moonR = 1.25–1.5·extR` gives
`extR ≈ 50` (vs 74 today) and `moonR ≈ 65` — the moon rule trades a little
dial size for a properly-sized moon. The split date follows iOS: weekday under
the moon (bottom-left), month/day + year under the map (bottom-right).

### 6.6 Popover open (any regime) — everything stays visible

The popover is an **L** hugging the bottom-right: a narrow vertical column
(`#tp-upper`) plus a wide bottom bar (`#tp-lower`), with a free notch at the
L's inside corner that a circle's rim can occupy:

```
┌──────────────────────────────────────┐
│  ◐    [ map ]   SATURDAY …           │   Layout re-solves with the two
│    ╭───────────────────╮             │   arm rects excluded — as if the
│ (a)│                   │(ecl)        │   window were notched. The dial
│    │     main dial     │      ┌────┐ │   may shrink a step; its round
│ (z)│   (may shrink     │      │ tp │ │   rim tucks into the L's notch,
│    │    slightly)      │(eot) │ up │ │   so the cost is small. Dials
│    ╰───────────────────╯      │    │ │   that intersected the arms
│              ┌────────────────┴────┤ │   relocate (ecl/eot slide up/in).
│              │      tp-lower       │ │
│ [⏱ Hide controller] [+off] [SF·SET]│ │   Everything remains visible —
└──────────────────────────────────────┘   scrub while watching any dial.
```

Rules: the two arm rects are exclusions in the **same** layout solve as
everything else (no special-case shifting); since `?tc=1` persists, the
popover-open arrangement is a first-class stable layout, not a degraded
overlay. The re-solve happens instantly on toggle (like a window resize).
The scrub-to-an-eclipse use case is why the eclipse dial must stay visible.

---

## 7. Implementation sketch (no code yet)

| File | Change |
|---|---|
| `observatory.html` | Merge the two bottom strips into one footer row; scoped CSS hiding `#time-bar-date/-rate/-now` (+ regression comment); popover anchored above the footer |
| `layout.ts` | `chrome` input (footerH, popover arm rects); gap rule; moon-≥-dial constraint + landscape packing solves; date box + mode (incl. `split`); popover arms as exclusions in the main solve |
| `observatory-entry.ts` | Measure footer (ResizeObserver already debounces); pass `#tp-upper`/`#tp-lower` rects via `onPopoverToggle` → recompute layout; relayout on fps creation |
| `date-view.ts` | iOS hierarchy (weekday/month-day 1.0, year 0.42, leap/tz 0.21); full weekday name, shrink-to-fit; "leap" only in leap years (drop "not leap"); box + `stack`/`row`/`split` modes |
| `peripheral-*/eclipse-view` | No changes expected (they read `LayoutParams` fields) |

Verification: screenshot matrix at 768×1024, 390×844, 900×900, 1024×768,
844×390, each ± popover open, plus `?fps`. Pixel-probe for the moon/dial size
constraint and min-gap assertions (could be a small unit test on
`computeLayout` outputs — gaps and `moonR ≥ extR` are pure geometry).

---

## 8. Resolved in review (2026-06-10)

1. **Landscape date** — split per iOS: weekday bottom-left, month/day + year
   bottom-right; splitting is also available to other regimes when it packs
   better.
2. **Date content** — full weekday name, prominent (glance-for-weekday UX
   goal); iOS font hierarchy 48/48/20/10; "leap" shown only in leap years,
   never "not leap".
3. **Popover** — entire display stays visible; layout re-solves with the two
   L-arm rects as exclusions and elements (including the main dial) resize to
   fit; the dial's rim tucks into the L's notch.
4. **Gap constant** — start at `g = 0.4·extR` clamped [6, 24]; tune by eye.

No open questions remain — next step is implementation, then a visual-tuning
pass with the user.
