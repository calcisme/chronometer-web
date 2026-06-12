# Observatory Phase 8 — Layout (from scratch)

**Date:** 2026-06-06
**Status:** ✅ Implemented (Alternative B) — superseded in part by
[2026-06-10-observatory-phase-8b-layout-refinement.md](2026-06-10-observatory-phase-8b-layout-refinement.md)
(moon/date sizing, gap rule, footer-chrome integration, iPhone-portrait
vertical fill). Rewrote `src/observatory/layout.ts` from scratch; removed the logo
from `observatory-entry.ts`. `tsc`/`build`/tests all clean.
**Revised:** 2026-06-06 (post-review) — §1, §6, §7 updated after feedback;
dial sizing is now *adaptive* (slack-driven), not a fixed per-template constant.

## Implementation notes (2026-06-06)

- `layout.ts`: `chooseTemplate()` (aspect switch with 1.05/1.15 hysteresis),
  adaptive `D = clamp(min(0.95·S, long − reserve), 0.75·S, 0.95·S)`, separate
  `computePortrait()` / `computeLandscape()`, shared `innerDialGeometry()`
  (unchanged `s`-scaled internals), `largestCornerRect()` for the map/moon.
- **Portrait**: header (moon ◂ map ▸ date) on top; dial fills the width; four
  dials in the corner gaps (iOS proportions, since the gaps are narrow); the
  whole block is vertically centered when the window has spare height (phones).
- **Landscape**: dial centered; left column = moon → altitude → azimuth → date,
  right column = map → eclipse → EOT; dials nestled beside the circle and pushed
  below the corner element so they never collide.
- Peripheral-dial size decoupled from the main dial (fills margin, capped at
  0.45·mainR in landscape; ~iOS size in the narrow portrait gaps). Ext fonts +
  eclipse annulus derived from `extR`, not `mainR`.
- Verified at 390×844, 768×1024, 900×900, 1280×800: dial = 0.95·short on phone
  & iPad-portrait & wide; 0.75·short floor at square; no overlaps.
- **Tuning TODO** (the §7 open knobs): crossover feel, peripheral margin floor,
  and whether to use the empty bottom band on phones for larger peripherals.
**Parent plan:** [2026-05-26-observatory-port.md](2026-05-26-observatory-port.md) (Phase 8 = "Tune the layout")

> Note: Phase 7B (eclipse simulator) is functionally complete but its visual
> verification against the iOS app / Selene is still pending (no iPad access at
> time of writing). This phase can proceed in parallel; nothing here depends on
> the eclipse geometry being pixel-confirmed, only on the eclipse *dial slot*
> existing (it does).

---

## 1. Goals (from the request, as refined in review)

1. **Start the layout from scratch.** Don't iterate on the current ad-hoc
   responsive math — re-derive the arrangement from the iOS app's two real
   layouts.
2. **Borrow the iOS arrangement.** All else equal, reuse the *portrait* or
   *landscape* iOS layout rather than inventing a new composition. **We do not
   need to match iOS proportions exactly** — only to look good at those aspect
   ratios (iPad portrait/landscape, iPhone).
3. **Maximize the central ring view — adaptively.** The 75 % figure is a *floor*
   for the worst (near-square) case only. The real goal: **push the dial toward
   ~95 % of the shorter dimension whenever the window's aspect ratio frees up
   room on the long axis** to hold the other elements. The dial may **grow
   without bound** with the window — if the user made the window bigger, they
   want a bigger dial.
4. **Maximize the map too.** The map is second-most-important: place it where it
   can be **biggest** while satisfying the dial and spacing constraints, and let
   it **grow on wider screens**. Keep a little breathing room around it.
5. **Peripherals fill the leftover.** The four outer dials (and moon/date) may
   grow as needed, but the **only** hard constraint is that they must never
   consume space the main dial or the map could use. Priority cascade:
   **dial → map → peripherals.** Peripheral-dial size is **not** tied to the main
   dial — they fill the margin space the layout leaves them (bounded above at
   ≈ half the main-dial radius), which gives them more usable resolution.
6. **Target the iPhone aspect ratio for readability.** Tall, narrow phone
   windows are a priority. It will be impossible to make *everything* legible at
   that size, but we should get as close as possible by maximizing the dial. We
   treat a small *window* on a large monitor exactly like a small device — no
   distinction — but we **do** factor in `devicePixelRatio` (see §6.3).

**Resolved decisions:**

- **Drop the logo entirely.** The "Emerald ✦ Sequoia" mark had nostalgic value
  but the company is gone and the design no longer needs IP protection. Remove
  it from the layout and the render loop.
- **No font-size scaling.** Label sizes were deliberately fixed early in the port
  because scaling them made labels swamp the functional elements (hands, ticks).
  Layout changes must not reintroduce responsive font scaling.
- **Don't drop any elements** (other than the logo) at small sizes — render
  everything, just smaller.

---

## 2. Current state (measured 2026-06-06)

Built `dist/observatory.html`, served it statically, and screenshotted three
window shapes (location = San Francisco so the dialog is dismissed). The single
`computeLayout()` path in [layout.ts](../src/observatory/layout.ts) produces:

| Window (W×H)   | `mainR` | Dial Ø ÷ shorter dim | Verdict |
|----------------|---------|----------------------|---------|
| 768 × 1024 (portrait) | 304 | 608 / 768 = **79 %** | OK — map a touch small, big gap between map and dial, moon overlaps dial top |
| 900 × 900 (square)    | 360 | 720 / 900 = **80 %** | Good — corner dials sit naturally in the circle's corner gaps |
| 1280 × 800 (wide)     | 320 | 640 / 800 = **80 %** | **Broken** — see below |

**The wide-window failure is the main thing to fix.** The current layout always
uses the *portrait* arrangement (header on top; the four dials tucked into the
**top/bottom** corners of the dial's bounding box). In a wide window that means:

- The entire extra width (left + right of the circle, ~320 px each side) is
  **dead black space**.
- The four dials are crammed into the narrow top/bottom corner gaps instead of
  living in the roomy side margins.
- The map is stranded, small, at top-center.

This is exactly the case iOS handles by **switching to its landscape layout**,
where the dial is centered and the dials + map move into the side/top margins.
The web app never makes that switch — it has one layout for all aspect ratios.

So Phase 8 is really: **bring back the iOS orientation switch**, and size/anchor
everything so no axis is wasted.

---

## 3. The two iOS reference layouts

From [`EOClock.mm` `initializeConstantsForOrientation:`](../.observatory-ref/Classes/EOClock.mm#L1519-L1720)
(coordinates are CG **Y-up**, origin at screen center):

### Portrait — 768 × 1024 (aspect 0.75)

```
 ┌─────────────────────────────┐
 │  moon      [ world map ]  date │   header band ≈150px tall, pinned top
 │                                │
 │  ╭───────────────────────╮     │
 │ az│      24h DIAL         │ecl  │   dial Ø=730 (95% of width!)
 │   │   UTC                 │     │   centered, pushed DOWN 77px
 │   │  solar  ☉  sidereal   │     │   ext dials in the 4 corner gaps:
 │ alt│                      │eot  │     alt/az LEFT,  ecl/eot RIGHT
 │  ╰───────────────────────╯     │
 │          logo                  │   footer
 └─────────────────────────────┘
```

Key numbers: `mainR=365` (Ø 730 ≈ **0.95 × shorterDim**); dial center pushed
down `77px`; map `bmw=300` (0.39 × width) centered at top; moon top-left, date
top-right; ext dials `R=60`, offset `(±305, ±348)` from dial center — i.e. tucked
into the corner gaps the circle leaves. `ringMasterScale = 1.0`.

### Landscape — 1024 × 768 (aspect 1.33)

```
 ┌────────────────────────────────────────────┐
 │  moon          ╭───────────╮   [world map]  │  moon top-left (1.2× bigger),
 │             az │  24h DIAL  │ eot            │  map top-RIGHT corner
 │                │ UTC        │                │  dial Ø≈657 centered (mainY≈0)
 │             alt│ sol ☉ sid  │ ecl            │  4 dials in LEFT / RIGHT margins
 │                ╰───────────╯                 │  (offX=420)
 │                    logo                       │
 └────────────────────────────────────────────┘
```

Key numbers: `mainR=365` but **`ringMasterScale = 0.9`** → effective Ø ≈ 657
(**0.855 × shorterDim**); dial centered (`mainY=-13`); map `earthMasterScale 0.9`
in the **top-right corner**; moon `moonMasterScale 1.2` top-left; ext dials at
`offX=420` (far left/right), spread vertically (`offY` 50 / 175).

### What changes between the two

| Element | Portrait | Landscape |
|---------|----------|-----------|
| Dial size (÷ shorter dim) | 0.95 | 0.855 |
| Dial vertical position | pushed down 77px | centered |
| Map | top-center, big | top-right corner, slightly smaller |
| Moon | top-left, 1.0× | top-left, 1.2× |
| 4 ext dials | top/bottom **corner gaps** | left/right **margins** |

The decisive structural difference is **where the four dials live** (corner gaps
of a near-full-width circle vs. dedicated side margins) and **whether the map
stacks above the dial or sits beside it in a corner**.

---

## 4. Design space — the one real decision

For a web window of *arbitrary* aspect ratio, we must answer two coupled
questions:

**Q1 — Which iOS template, and when?**
Switch on window aspect ratio `a = W/H`, mirroring iOS's orientation flip.
Portrait template for tall/square windows, landscape template for wide ones,
with a crossover near `a ≈ 1.1`.

**Q2 — How do we handle aspect ratios that don't match iOS's fixed 0.75 / 1.33?**
This is the crux, and it's where the three alternatives below differ:

- **A. Letterbox** the chosen iOS template at its native proportions.
- **B. Anchored reflow** — keep the iOS *arrangement* but re-anchor elements to
  the actual window edges and size the dial to the window.
- **C. Continuous morph** — one layout with no discrete switch.

---

## 5. Alternatives

### Alternative A — Faithful letterbox

Render the chosen orientation at its exact native proportions (768×1024 or
1024×768), uniformly scaled to fit inside the window, centered, with black bars
filling the rest. Pixel-identical to iOS.

- ✅ Maximum fidelity; zero new layout math (reuse iOS constants verbatim).
- ✅ Every element stays exactly where a returning iOS user expects.
- ❌ **Fails the size goal at mismatched aspects.** A square window using the
  portrait template is height-limited: scale = W/1024, so the dial is only
  `730 × W/1024 = 0.71 × W` — **below the 75 % floor.** Wide windows letterboxed
  with the landscape template waste even more.
- ❌ Big black bars feel unfinished on a desktop browser; the map stays small.

**Verdict:** rejected as the primary mode — it can't satisfy goal 3 across the
range of window shapes. (Still useful as a *fallback/debug* mode and as the
source of truth for proportions.)

### Alternative B — Anchored reflow (recommended)

Two templates selected by aspect ratio (Q1). Within each template we keep the
iOS *arrangement* but:

1. Size the dial **adaptively** (see §6.1): grow it toward ~0.95 × min(W,H) as
   the long-axis slack grows, dropping toward the 0.75 floor only near square.
2. Anchor the four ext dials and the map/moon/date to the **actual window
   edges/corners**, not to fixed pixel offsets from the dial. The extra space on
   the long axis is absorbed by the margins, never left as a dead bar.
3. Scale ext-dial radius, fonts, and the map with the dial (one scale factor
   `s = mainR / 365`, as today), clamped to sane min/max so they don't get
   comical on extreme windows. Peripherals yield to the dial and map, never the
   reverse (priority cascade, goal 5).

Concretely:

- **Tall / square windows (`a < ~1.1`) → portrait arrangement.** Dial centered
  horizontally, nudged down to open a header band; map centered in that band
  (target width ≈ `0.42 × W`, clamped), moon top-left, date top-right; the four
  ext dials ride the **left and right edges**, vertically near the dial's
  top/bottom (the corner-gap idea, but pinned to the window so they breathe as
  the window grows). Logo bottom-center.

- **Wide windows (`a ≥ ~1.1`) → landscape arrangement.** Dial centered; the four
  ext dials move into the **left/right side margins** (two per side, spread
  vertically); the map goes to the **top-right corner** at a comfortable size
  with padding; moon top-left (slightly enlarged, per iOS 1.2×). This reclaims
  the wasted side space that breaks the current build.

- **Map breathing room (goal 4):** reserve a fixed padding ring (≈ `0.5 × extR`)
  between the map's bounding box and both the nearest window edge and the
  nearest ext dial; if the map's target size would violate it, shrink the map
  first (it yields before the dials do).

- ✅ Always meets the dial-size floor; no wasted axis; map stays prominent.
- ✅ Reuses iOS proportions (`s`-scaling) so the dial internals are untouched —
  only outer-element *anchoring* is new.
- ✅ Degrades gracefully to any window shape, including ultrawide / very tall.
- ⚠️ Moderate new code: an aspect switch plus edge-anchoring math, and a
  crossover that must not visibly "pop". Needs the clamps tuned by eye.
- ⚠️ Two arrangements to verify instead of one.

**Verdict:** recommended. It honors the iOS look, satisfies all four goals, and
fixes the wide-window failure.

### Alternative C — Continuous morph (single layout)

One layout, no discrete portrait/landscape switch. The dial is always
`f × min(W,H)`, centered; the four dials and the header are distributed to
*whichever margins are largest* by a continuous rule (e.g. dials slide from
top/bottom corners toward the side margins as `a` grows).

- ✅ No crossover pop; mathematically elegant; one code path.
- ❌ The in-between states (near-square) are exactly where a continuous rule
  looks worst — dials half-way between "corner gap" and "side margin" with no
  natural home. iOS deliberately uses two *hand-tuned* arrangements for this
  reason.
- ❌ Hardest to make look as polished as B; most tuning risk.

**Verdict:** keep in reserve. If B's crossover proves jarring we can revisit, but
the discrete switch matches iOS and is the safer first cut.

---

## 6. Recommendation

**Alternative B — anchored reflow with an aspect-ratio template switch and
*slack-driven* dial sizing.**

### 6.1 Adaptive dial size (the core of the revision)

Let `S = min(W,H)` (short axis), `L = max(W,H)` (long axis). The dial is a circle
of diameter `D ≤ S` (it can never exceed the short axis without clipping).

The peripherals naturally want to live on the **long axis** — the four ext dials
in the long-axis margins, the map in a long-axis corner. So the dial can be as
big as the short axis allows *as long as the long-axis margins leave the
peripherals a usable minimum*. That gives a single sizing rule:

```
D = clamp( min( 0.95·S,  L − 2·mPeriph ),  0.75·S,  0.95·S )
```

- `mPeriph` = the **minimum** long-axis band the peripherals need to remain
  usable (a small floor, not proportional to `D`). It is *not* a reserved
  proportional band — see the peripheral-sizing note below.
- **Wide/tall windows** (`L` large): `L − 2·mPeriph > 0.95·S`, so `D = 0.95·S` —
  the dial fills the short axis and peripherals get the deep long-axis margins,
  where they can grow large (more resolution). ✔ goal 3.
- **Near-square** (`L ≈ S`): the long-axis margins are too thin, so `D` is pulled
  down toward the `0.75·S` floor and peripherals fall back to the **corner gaps**
  of the circle. ✔ goal 3 floor.
- **No upper cap on absolute size** — `D` grows with the window without bound
  (goal 3); only the *fraction* is clamped.

This makes `f` a smooth function of aspect ratio (≈0.75 at square → 0.95 once the
long axis has slack) instead of a per-template constant.

**Peripheral-dial sizing (decoupled from the main dial).** Once `D` is fixed,
each of the four ext dials is sized to **fill the margin space the layout leaves
it**, capped above at ≈ `0.5 × (D/2)` (half the main-dial radius) so it never
looks oversized, and separated from its neighbours, the main dial, and the
window edge by the §6.5 gap minimum. Because they track *available space* rather
than a fixed fraction of `D`, the peripheral dials get noticeably more usable
resolution in wide/tall windows than the old `60·s` rule gave. The three **inner**
subdials (UTC/Solar/Sidereal) stay proportional to the main dial as before —
they live inside it and have no choice.

### 6.2 Map sizing & placement (goal 4)

Place the map **after** the dial, as the **largest 2:1 rectangle** that fits in
the remaining free space, minus the §6.5 gap from the nearest window edge, the
dial, and any ext dial:

- **Wide windows:** the deep side margin + top sliver form an L-shaped free
  region; the biggest 2:1 box sits in a **top corner** (per iOS landscape) and
  **grows with window width**. ✔ "biggest, grows on wider screens."
- **Tall / square windows:** the free region is the **top band** above the dial;
  the map centers there and grows with width until the padding ring or the floor
  dial size stops it.
- The map yields to the dial (cascade): if the only way to grow the map is to
  shrink `D` below its §6.1 value, **don't** — shrink the map instead.

### 6.3 Small windows & devicePixelRatio (goal 6)

Tall narrow windows hit the tall-template path: dial → ~0.95·W, with map/moon/date
stacked above and the four dials below (lots of vertical slack). That maximizes
the dial, which is the main lever for phone readability. Beyond that:

- **No screen-vs-window distinction.** A 390-wide window on a 5K monitor behaves
  exactly like a 390-wide phone. Layout keys off the CSS viewport size only.
- **No responsive font scaling** (resolved decision, §1) — labels stay at their
  fixed sizes; only geometry reflows.
- **No dropping elements** (other than the logo). Everything renders, just
  smaller.
- **Use `devicePixelRatio`** in two ways: (a) always size the canvas backing
  store at `dpr` so the dial stays crisp; (b) let `dpr` govern how far the §6.5
  gaps may shrink — a higher `dpr` keeps a 2-px apparent gap visually clean
  (it's 4–6 physical px), so dense displays can pack tighter than 1× displays.

### 6.4 Implementation shape (one file, `layout.ts`)

- Add `chooseTemplate(W, H): 'portrait' | 'landscape'` (aspect switch, §7-Q1).
- Add `solveDialDiameter(W, H)` implementing the §6.1 clamp.
- Split `computeLayout` into `computePortrait()` / `computeLandscape()` that
  share the existing `s`-based **inner**-subdial math (untouched) plus shared
  `placeExtDials()` / `placeMap()` helpers that anchor to window edges (§6.2) and
  size the four ext dials from available margin space (§6.1), not from `s`.
- The `LayoutParams` interface stays the same shape (renderers keep reading
  `altR`, `azR`, `eclipseR*`, `eotR`, `mapW`…), so the only **renderer** change
  is **removing the logo draw call** and its `logoCX/logoCY` fields. Otherwise a
  pure layout refactor on the existing `ResizeObserver`.

This keeps the change surface almost entirely inside `layout.ts`, consistent with
the "Phase 8 = tune the layout" scope.

### 6.5 Gap minimums

Every gap (dial↔ext-dial, ext-dial↔ext-dial, anything↔window-edge, map↔neighbour)
has a minimum **apparent** size of **8 px**. On small / dense windows this single
floor may relax toward **~2 px**, governed by `devicePixelRatio` (§6.3) so the gap
stays visually clean. This is the one spacing quantity allowed to nearly vanish to
buy room for the dial and map.

---

## 7. Open questions / settled calls

**Settled in review:**

- **Dial size** — adaptive 0.75→0.95 (§6.1); no absolute cap; grows with window.
- **Peripheral-dial size** — decoupled from the main dial; fills available margin,
  capped at ≈ half the main-dial radius (§6.1).
- **Map** — sized to the largest fitting 2:1 box, grows on wider screens (§6.2).
- **Extremes** — dial grows unbounded; peripherals grow but never steal dial/map
  space (priority cascade).
- **Small windows** — no screen/window distinction; no font scaling; nothing
  dropped (except the logo); `dpr` used for crispness + gap floor (§6.3).
- **Logo** — removed entirely.
- **Gap minimum** — 8 px apparent, relaxing toward ~2 px on small/dense windows
  (§6.5).
- **iOS fidelity** — not a goal; just look good at those aspect ratios.

**Still open (will tune visually, not blockers):**

1. **Crossover point.** Start at `a = W/H = 1.1` for the portrait↔landscape
   switch, with a small dead-band (down-switch ~1.05, up-switch ~1.15) to avoid
   flicker near square. You'll confirm by eye.
2. **`mPeriph` floor.** How small may the peripheral band get before the dial
   stops growing — i.e. how aggressively does the dial win near square? Tune live.

---

## 8. Appendix — current vs. target (wide window)

Current `1280 × 800` (the failure): dial 640 Ø centered, **~320 px dead black on
each side**, four dials jammed into top/bottom corner gaps, map ~230 px wide
stranded top-center.

Target (landscape template): dial ≈ 0.95·H Ø centered, four dials living in the
left/right margins sized to fill them (well above the old `60·s`), map as large
as the top-corner free region allows and growing with width, moon enlarged
top-left. No logo, no dead axis.
