# Rendering

The rendering pipeline splits work into a **static cache** (drawn once, reused across frames) and **per-frame dynamic drawing** (hands, wheels during transitions, terminator leaves).

## iOS/Android Reference

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

| Repo | Key files |
|------|-----------|
| `.chronometer-ref/` | `Classes/ECGLPart.m` (hand rendering, offset-radius mode), `Classes/ECGLWatch.m` (compositing), `Classes/ECWatchDefinitionManager.m` (window stashing) |

## Static Cache Architecture

```
                       ┌──────────────────────────────┐
                       │        Static Cache           │
     Rebuilt when:     │   (OffscreenCanvas)           │
     - mode changes    │                               │
     - date changes    │  Dials, ticks, text, images,  │
     - env changes     │  QRects, wheels, windows      │
                       │  (with holes cut out)         │
                       └──────────────┬───────────────┘
                                      │ drawImage()
                       ┌──────────────▼───────────────┐
                       │        Main Canvas            │
     Every frame       │                               │
     (up to 240fps)    │  1. Draw cached static layer  │
                       │  2. Draw dynamic hands on top │
                       └──────────────────────────────┘
```

### `buildStaticCache` → `renderFrame` Split

- **`buildStaticCache()`**: Called once (or on env change). Renders all static parts — dials, text, tick marks, images, QRects, wheels, windows, and procedural elements like `<eotDial>` — onto an `OffscreenCanvas`. Window holes are cut during this pass.
- **`renderFrame()`**: Called at up to 240fps. Blits the static cache in one `drawImage()` call, then draws only dynamic parts (hands, animated wheels, terminator leaves, analemma) on top.

### Cache Invalidation Triggers

The static cache is rebuilt when:
- The watch mode changes (front/back)
- Date-dependent values change (month, day, weekday wheels)
- Environment slot changes (timezone, location)
- Canvas resize

## Window Cutout Mechanism

Windows in the XML cut transparent holes through the part that follows them. The mechanism uses Canvas composite operations.

### How Windows Work

In the XML, `<window>` elements appear **before** the part they clip. Multiple consecutive windows accumulate and all apply to the next non-window part:

```xml
<!-- These 3 windows stash themselves -->
<window name='month win'  x='...' y='...' w='42' h='16' ... />
<window name='day win'    x='...' y='...' w='24' h='16' ... />
<window name='wkday win'  x='...' y='...' w='74' h='13' ... />

<!-- All 3 windows are cut from this static block -->
<static name='front' modes='front'>
    <Image name='face' ... />
    ...
</static>
```

### Rendering Pipeline

```
pendingWindows = []

for each part in document order:
    if part is Window:
        pendingWindows.push(part)
    else if pendingWindows is not empty:
        // render part to temp canvas, cut holes, composite
        tempCanvas = createOffscreen(...)
        drawPartToCanvas(tempCanvas, part)
        for each window in pendingWindows:
            cutHole(tempCanvas, window)     // globalCompositeOperation = 'destination-out'
        compositeOnto(staticCache, tempCanvas)
        drawWindowBorders(staticCache, pendingWindows)
        pendingWindows = []
    else:
        drawPart(staticCache.ctx, part)     // no windows — draw directly
```

### Hole Cutting

Holes are cut using `globalCompositeOperation = 'destination-out'`:
- **Rectangular windows**: `ctx.fillRect(x, y, w, h)` with `destination-out`
- **Porthole windows**: `ctx.arc(cx, cy, radius, ...)` with `destination-out`

### Windows Inside Static Blocks

Windows inside a `<static>` block clip within that block's own render context. Since the static block is already rendered to an offscreen canvas (because it has outer windows applied), inner windows naturally operate within that same buffer.

## Drawing Order

Parts must be rendered in exactly the order they appear in the XML. This is critical for correct visual layering. The renderer must **not** sort, reorder, or apply z-index logic — it must use pure document order. See [Development Rules §4](development-rules.md#4-rendering-order-is-sacred).

## Bezel Rendering

Each watch face is surrounded by a solid circular ring:
- Color specified by `bezelColor` attribute on the `<watch>` element
- Thickness: `BEZEL_THICKNESS_XML = 10` XML units (computed as `⌊2/3 × gap⌋` where `gap = faceWidth/2 − mainR`)
- Drawn as a filled annulus (even-odd fill rule) in `buildStaticCache`, after all other parts
- Canvas scale denominator is `faceWidth + 2 × bezelThickness`, ensuring the ring is fully visible

## Offset-Radius Hand Rendering

When a hand has `offsetRadius > 0`, the renderer uses polar-offset mode. The geometry must match iOS `ECGLPart.m` behavior:

1. **Position**: Hand placed at `(offsetRadius, offsetAngle)` in polar coordinates from watch center
2. **Rotation**: Image rotated by `offsetAngle + angle` around its anchor. Since `ctx.rotate(offsetAngle)` is applied for positioning, only `ctx.rotate(angle)` is needed afterward — do not double-count `offsetAngle`
3. **Y-Anchor Flip**: iOS CG uses Y-up coordinates (anchor from image bottom). Canvas uses Y-down. The offset branch uses the same CG-to-Canvas convention as the non-offset branch: `yAnchor = -evalAttr(...)` and `drawImage(bitmap, -xAnchor, -yAnchor - drawH, ...)`
4. **Orbital displacement via anchor**: E.g., Moon's `yAnchor=23` on a 20px-tall image places the rotation center 3px below the image, creating a visible orbital circle around the offset point

## QWheel Dot Positioning

The `drawWheel` function computes label Y-position as `-(tradius - maxH/2)` with `textBaseline='middle'`, where `maxH = fontSize`. iOS uses measured text height (`sizeWithAttributes`) instead of `fontSize`.

For compact glyphs like `●`, the difference `(fontSize - measuredHeight) / 2` is significant (3px on Selene's AM/PM wheel). The current fix is a per-watch XML Y-offset adjustment rather than a renderer-level change, because switching to measured height would break other wheels whose window positions were authored around the `fontSize`-based formula.

## Cross-Browser Text Positioning

**Always** use `textBaseline = 'alphabetic'` (the default) with `textVisualCenterY(ctx, label)` for vertical text positioning. **Never** use `textBaseline = 'top'` — Safari positions the "top" baseline differently from Chrome, causing text to render at the wrong vertical position.

The standard pattern for all dial/wheel text:
```typescript
ctx.textBaseline = 'alphabetic';  // set once at the top of the text section
ctx.textAlign = 'center';
ctx.fillText(label, x, centerY + textVisualCenterY(ctx, label));
```

`textVisualCenterY` caches `(fontBoundingBoxAscent - fontBoundingBoxDescent) / 2` per font, providing a consistent cross-browser Y-offset that visually centers text at the target point.

## Key Source Files

| File | Purpose |
|------|---------|
| `src/watch/renderer.ts` | All drawing functions, static cache building, per-frame rendering |
| `src/watch/types.ts` | Part type interfaces |
| `src/watch/image-loader.ts` | Image asset loading and bitmap management |

## Related Docs

- [Animation](animation.md) — How dynamic parts are updated and interpolated
- [Shadows](shadows.md) — Shadow rendering layered on top of this pipeline
- [XML Parsing](xml-parsing.md) — How parts are parsed before rendering
