# Shadows

The shadow system synthesizes three types of shadows at runtime, replacing the iOS app's build-time shadow generation via Henry/ImageMagick.

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.chronometer-ref/` | `scripts/makeOneShadow.pl` (shadow bitmap generation), `Classes/ECWatchController.m` lines 335–336 (shadow offset formula), `Classes/ECGLPart.m` (shadow compositing) |

## Three Shadow Mechanisms

1. **Window inner shadows** — darkening along the inside edges of window openings, simulating the bezel casting a shadow onto a recessed wheel
2. **Image-based shadows** — pre-rendered shadow PNGs in the iOS texture archive; replaced by runtime synthesis in the web app
3. **Hand shadows** — blurred, offset, semi-transparent copies of hand bitmaps, rendered dynamically as hands rotate

## Window Inner Shadows

### XML Attributes

| Attribute | Range | Meaning |
|-----------|-------|---------|
| `shadowOpacity` | 0–1 | Maximum darkness at the edge |
| `shadowSigma` | > 0 | Blur radius / how far shadow fades inward |
| `shadowOffset` | any | Vertical offset (positive = light from above) |
| `shadowOffsetX` | any | Horizontal offset (negative = light from right) |

### Rendering Pipeline Integration

The inner shadow is drawn as part of the static cache, **after** the window hole is cut. This ordering is critical because `cutWindowHole()` uses `destination-out` to erase the window interior — any shadow drawn before would be wiped out.

Order in all three call sites (`buildStaticBlockCaches`, `renderPartsWithWindows`, `renderWithWindowCutouts`):

1. `drawWindowBorder()` — stroke the border
2. `cutWindowHole()` — erase window interior to transparent
3. `drawWindowInnerShadow()` — paint semi-transparent gradients onto the transparent hole

When the static cache composites onto the main canvas, the semi-transparent shadow pixels correctly darken whatever wheel content shows through the window. **No per-frame cost.**

### Gradient Technique

**Rectangular windows**: Four linear gradients (top, bottom, left, right) fade from `rgba(0,0,0,opacity)` at the edge to transparent inward. Each gradient uses `addGaussianStops()` which samples `e^(-x²/2)` at 8 points across 4σ, producing a smooth Gaussian falloff. Corners naturally receive double-darkening where gradients overlap, mimicking real shadow behavior.

**Porthole windows**: A radial gradient from the edge inward (same Gaussian stops). Currently untested — no porthole windows have shadow attributes.

The `shadowOffset` parameter adjusts per-edge opacity multipliers: positive offset increases bottom-edge opacity and decreases top-edge (light from above). `shadowOffsetX` does the same for left/right.

### Tuning

A global intensity multiplier of `0.5` is applied to all shadow opacities, tuned by visual comparison against the iOS app on Terra.

## Hand Shadows

Hand shadows are **dynamic** — they rotate with their parent hand on every frame.

### iOS Formula (from `makeOneShadow.pl`)

```
sigma = (z + 2) / 2

if (thick < 3.0):
    sigma *= thick / 3.0            # thinner hands → sharper shadows
    opacity = 50 + 50 * (3.0 - thick) / 3.0  # thinner hands → darker (50→100%)
else:
    opacity = 50%
```

Shadow offset (from `ECWatchController.m`):
- **X offset**: `+z / 4.3` (rightward — light from the left)
- **Y offset**: `-z / 2.15` (downward in screen coords — light from above)

### Web Implementation (Canvas `shadowBlur`)

The web app uses Canvas shadow properties (`shadowBlur`, `shadowOffsetX`, `shadowOffsetY`, `shadowColor`) set before each hand draw call. The `setupHandShadow()` helper configures these properties; shadow is cleared by `ctx.restore()`.

### Thin-Hand Tuning Differences

The iOS formula was designed for pre-rendered bitmaps where shadow is generated from the entire hand as a single unit. With Canvas `shadowBlur`, each stroke/fill gets its own shadow, making thin hands look too harsh. The web app **inverts** the thin-hand behavior:

| Parameter | iOS (thick < 3) | Web (thick < 3) |
|-----------|-----------------|-----------------|
| Sigma | Reduced (`× thick/3`) — sharper | Increased (`× 1.25`) — more diffuse |
| Opacity | Increased (50→100%) — darker | Reduced (`× thick/3`) — lighter |
| Base opacity | 50% | 40% |

This produces a softer, more natural look that closely matches iOS at the visual level.

### Coordinate Scaling

Canvas `shadowBlur` and `shadowOffset` values are in **untransformed CSS pixel space**, not the current coordinate system. Since we draw in XML units with `ctx.scale(scale, scale)`, shadow parameters must be multiplied by `scale` (extracted from `ctx.getTransform().a`).

## Calendar Wheel & Row Cover Shadows

### Calendar Row Covers (Babylon)

The `CalendarRowCover` parts slide horizontally to reveal/hide calendar rows during month transitions. They have a `z` attribute (`calRowCoverZ=1.0`).

**Layer distinction**:
- **Top covers** (`row1Left`, `row1Right`): "Underlays" — sit below the calendar wheels. **No shadow** (they're recessed).
- **Bottom covers** (`row6Left`, `row56Right`): True "covers" on top of the wheels. **Shadow enabled.**

**Unified shadow technique**: Each cover draws one solid background rectangle with shadow enabled, then clears shadow and draws text labels on top. This prevents individual `fillRect`/`fillText` calls from each creating their own shadow.

### Calendar SWheels (Babylon)

The three calendar SWheels have `z='calWheelZ'` (1.5) and float above the underlays.

**L-shaped path for cutout shadow**: Each wheel quadrant has a cutout in its first row. Instead of two separate `fillRect` calls, the background is drawn as a single L-shaped `beginPath()` path:

```
    ┌──────────┐
    │  cutout  │ first row (startColumn → 7)
    │          │
┌───┤          │
│              │ rows 1+ (full width)
│              │
└──────────────┘
```

This ensures the shadow follows the actual wheel shape. Shadow is applied per-quadrant for correct animation during month-boundary transitions.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/renderer.ts` | `setupHandShadow()`, `drawWindowInnerShadow()`, `drawCalendarWheel()`, `drawCalendarRowCover()` |
| `src/watch/types.ts` | `z` on `WheelPart`, shadow attributes on `WindowPart` |
| `src/watch/xml-parser.ts` | Parsing `z`, `shadowOpacity`, `shadowSigma`, `shadowOffset`, `shadowOffsetX` |

## Related Docs

- [Rendering](rendering.md) — Window cutout mechanism (prerequisite for inner shadows)
- [iOS Reference](ios-reference.md) — `makeOneShadow.pl` and shadow offset origins
