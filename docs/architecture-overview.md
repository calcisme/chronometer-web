# Architecture Overview

Chronometer Web is a pure client-side watch-face renderer that reads XML watch definitions and draws animated watch faces onto HTML Canvas elements. It requires no backend server — it runs entirely in the browser using only the device's clock and location.

## Design Decision: XML-to-Canvas

The original iOS app used a two-part architecture:
1. **Henry** (preprocessor): reads XML watch definitions, parses C expressions, renders pixel assets into texture atlases, and creates binary archive files
2. **Chronometer** (runtime): reads Henry's artifacts and renders using OpenGL 1.x

The web app chose **direct XML-to-Canvas rendering**, eliminating Henry entirely:

- The Cocoa drawing primitives used by Henry map directly to Canvas 2D APIs
- C expressions are simple enough to parse and evaluate at runtime in TypeScript
- No iOS SDK / Xcode dependency for watch face changes — just edit the XML
- The binary archive format was an optimization for 128MB iPhones and early OpenGL, neither of which applies to modern browsers

### Cocoa → Canvas 2D Mapping

| Cocoa API | Canvas 2D equivalent |
|-----------|---------------------|
| `CGContextAddArc` | `ctx.arc()` |
| `CGContextAddLineToPoint` | `ctx.lineTo()` |
| `CGContextMoveToPoint` | `ctx.moveTo()` |
| `CGContextFillPath` / `CGContextStrokePath` | `ctx.fill()` / `ctx.stroke()` |
| `CGContextDrawImage` | `ctx.drawImage()` |
| `CGContextSetAlpha` | `ctx.globalAlpha` |
| `CGContextSaveGState` / `CGContextRestoreGState` | `ctx.save()` / `ctx.restore()` |
| `CGContextScaleCTM` / `CGContextTranslateCTM` | `ctx.scale()` / `ctx.translate()` |
| `CGContextEOClip` | `ctx.clip()` with `evenodd` |
| Text drawing | `ctx.fillText()` / `ctx.strokeText()` |

## Part Classification

Each XML part type is classified as static (drawn once, cached) or dynamic (redrawn per frame):

| Part Type | Classification | Notes |
|-----------|---------------|-------|
| QDial | Static | Fixed dials, tick marks, text |
| QRect | Static | Date window backgrounds |
| QText | Static | Labels |
| Image | Static | Face, band, case images |
| Window | Static | Clips the following part |
| Wheel | Mostly static | Static between date changes; animated during transitions |
| Static | Static | Container of static parts |
| QHand | **Dynamic** | Moves per-frame |
| QWedge | **Dynamic** | Moves per-frame (filled arc segments) |
| Terminator | **Dynamic** | Moon phase leaves animate |
| Analemma | **Dynamic** | Pure blitting: 3 pre-rendered bitmaps (bg+border, channel+ticks, Sun+shadow) |
| EotDial | Static | Procedural EOT subdial (arc, ticks, labels) drawn once into cache |
| CalendarRowCover | **Dynamic** | Slides during month transitions |
| Button | Dynamic | Not drawn yet, but will need per-frame position |

## Multi-Face Grid Architecture

The app displays 20–25 watch faces simultaneously in a CSS grid:

- Column/row count determined by `ceil(sqrt(N))` heuristic
- Each face is a `FaceInstance` with its own `Environment`, `OffscreenCanvas` (static cache), and `HandState[]`
- `ResizeObserver` triggers debounced static cache rebuilds when the window resizes
- Each canvas is sized to fill its grid cell at device pixel ratio

## Energy-Efficient Rendering

The renderer uses a two-state system to minimize CPU usage:

| State | What's happening | Render behavior |
|-------|-----------------|-----------------|
| **Idle** | All hands at rest | `setTimeout` to next boundary; zero drawing |
| **Animating** | Hands sweeping | `requestAnimationFrame` at full monitor rate (up to 240fps) |

A shared scheduler tracks `min(handState.nextUpdateTime)` across all active faces and arms a single `setTimeout`. Outside animation windows (~250ms per second-hand tick), the tab is completely idle — roughly 2.5% CPU duty cycle vs. 100%.

## Memory Budget (25 Faces at 2× DPR)

| Component | Per face | 25 faces total |
|-----------|---------|----------------|
| Static cache OffscreenCanvas | ~1.2 MB | ~31 MB |
| Shadow bitmap caches | ~0.8 MB | ~20 MB |
| Watch AST / model objects | ~0.1 MB | ~2.5 MB |
| Watch Environment | ~0.05 MB | ~1.25 MB |
| JS heap, GPU textures, fonts | — | ~20 MB |
| **Estimated total** | | **~75 MB** |

Well within the 100 MB budget target.

## Source File Map

| Directory | Purpose |
|-----------|---------|
| `src/watch/` | Core rendering engine: XML parsing, expression evaluation, Canvas compositing |
| `src/expr/` | Expression tokenizer, parser, evaluator |
| `src/astronomy/` | Ported astronomical routines (sun/moon/planet positions, rise/set, twilight) |
| `src/faces/` | Per-face entry points that bundle XML and image assets |
| `src/` (root) | Engine entry point, time controller, location/URL state, city search |

## Related Docs

- [Rendering](rendering.md) — Static cache and window cutout details
- [Animation](animation.md) — Two-time-base system and scrubbing
- [Timezone & DST](timezone-and-dst.md) — DST transition detection and timezone offset handling
- [Build System](build-system.md) — How face bundles are built
