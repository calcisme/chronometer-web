# Face Porting Guide

Step-by-step procedure for porting a watch face from the iOS/Android Chronometer app to this TypeScript web application.

> **Prerequisites**: Run `scripts/clone-refs.sh` to clone the reference repos. See [ios-reference.md](ios-reference.md).

> **Rules**: Before starting, read [Development Rules](development-rules.md) — especially §2 (never simplify iOS algorithms) and §9 (if blocked, ask).

## 1. Locate the Source XML

- **Standard location**: `.chronometer-ref/Watches/Builtin-Android/<Face> I/<Face> I.xml`
- **Naming**: Face "Foo" → directory `Foo I/` with file `Foo I.xml`
- **Variant II**: Some faces use `Foo II/Foo II.xml`. We never use "II" names in the web app. If you're porting a "II" face and the user hasn't specified a web app name, **stop and ask**.

## 2. Copy and Clean the XML

1. **Copy** the Android XML file to `src/watch/assets/<face_name>/`
2. **Remove night mode**: Delete any parts with `modes='night'`, night-mode terminators, or night-specific QWheels. Night mode is not implemented.
3. **Add `bezelColor`**: Always add a `bezelColor` attribute to the `<watch>` tag. If there's a "case" image, use its bezel color and delete/skip the image part. Example: `bezelColor='rgb(160,160,160)'`

## 3. Set Up Image Assets

- Use **`4x` or `2x`** high-resolution assets where available (e.g., `faceFront-4x.png`)
- Apply scaling in the face setup file: `scale: 1/4` for 4x images
- **Check `parts-bin/` first** — common images shared across faces live in `src/watch/assets/parts-bin/`. Only add to per-face directory if the asset is unique to this face.

## 4. Port C++ Logic to TypeScript

When the XML uses expression functions not yet in the web app:

1. **Trace the function** through the iOS code (see [iOS Reference — Tracing](ios-reference.md#tracing-an-expression-to-its-implementation))
2. **Define the function** in `watch-env.ts` or a related module, strictly following the C++ implementation
3. **Never simplify** — see [Development Rules §2](development-rules.md#2-never-simplify-ios-algorithms)
4. **If blocked, ask** — see [Development Rules §9](development-rules.md#9-if-blocked-ask)

Remember that `watch-env.ts` is bundled into `chronometer-engine.js` (the shared engine). Adding new environment functions requires a full `bash build.sh` rebuild.

## 5. Create the Face Registration File

Use an existing `src/faces/face-*.ts` file (e.g., `face-geneva.ts`) as a template:

```typescript
import faceXML from '../watch/assets/<name>/<Name>-I.xml';
import faceImage from '../watch/assets/<name>/faceFront-4x.png';
// ... more imports

registerFace('<name>', faceXML, {
    'faceFront': { data: faceImage, scale: 1/4 },
    // ... more images
});
```

## 6. Update the Build System

When adding a new face, `build.sh` must be updated in **three places**:

1. **`FACES` variable** — list of face basenames to build
2. **`get_title()` function** — maps basename → display title
3. **`ALL_SCRIPTS` variable** — list of face scripts for the all-faces page

See [Build System](build-system.md) for full details.

## 7. Verify Rendering

Build the project:
```bash
bash build.sh
```

Open the face directly via `file://` URL with location parameters:
```
file:///path/to/dist/<face-name>.html?lat=37.33182&lon=-122.03118
```

Check:
- All dials, text, and ticks render correctly
- No overlapping artifacts or orphaned windows
- No text misalignments
- Browser console is free of rendering errors or unimplemented function errors
- Drawing order matches the iOS app (parts layer correctly)

## 8. Offset-Radius Hands

If the face has hands with `offsetRadius > 0` (e.g., moon orbit, subdial hands), verify the polar-offset rendering matches iOS behavior. See [Rendering — Offset-Radius](rendering.md#offset-radius-hand-rendering).

## 9. Thumbnails and Index Page

- **Thumbnail**: Wait for the user to supply a screenshot. Scale it: `sips -z 400 400 --out src/faces/thumb-<name>.png <screenshot>.png`
- **Index card**: Add to `src/index.html` in the `face-grid` div. "All Faces" card should always be first.
- **Description**: Use a short phrase describing the face's distinguishing feature (e.g., "Planetary positions", "Giant moonphase with alt/az dots")

## 10. Interactive Features

If the face has interactive features (body selector, city picker), see [Development Rules §7–§8](development-rules.md#7-interactive-controller-patterns) for the URL parameter and animation-preserving patterns.

## 11. Help Content

Each face should have a help file that describes what the face displays. Help content is sourced from the Android (Wear OS) help files.

1. **Find the source**: Locate the Android help file in `/Users/spucci/aw/<dir>/<face>_i.html` (see [Help System](help-system.md) for the directory mapping)
2. **Extract the body**: Copy only the content between the `<!-- Boilerplate code above here -->` and `<!-- Boilerplate code below here -->` markers
3. **Adapt the content**:
   - Strip Android-specific text (ambient mode, gear button, long press instructions)
   - Strip the banner image and any buy/download links
   - Rewrite cross-face links to point to our pages (e.g., `../miami/venezia_i.html` → `venezia.html`)
   - Rewrite image `src` paths to `help/images/<dir>/imagename.png`
   - Remove or rewrite links to `emeraldsequoia.com`
   - Keep Wikipedia and other educational external links (with `extlink.png` icon)
4. **Save as fragment**: Write the adapted HTML (no `<html>`/`<head>`/`<body>` tags) to `src/help/<face-slug>.html`
5. **Copy images**: Copy any referenced inline images from the Android directory to `src/help/images/<dir>/`
6. **Verify**: Run `bash build.sh`, open the face page, click ℹ, and confirm the help content appears correctly below the separator

See [Help System](help-system.md) for the full architecture and extraction rules.

## Related Docs

- [XML Parsing](xml-parsing.md) — Part type taxonomy and attribute conventions
- [Rendering](rendering.md) — How parts are drawn
- [Animation](animation.md) — Update intervals, animation speed
- [iOS Reference](ios-reference.md) — Navigating the reference repos
- [Build System](build-system.md) — Three-place registration
- [Development Rules](development-rules.md) — Critical invariants
- [Help System](help-system.md) — Help content architecture and source material
