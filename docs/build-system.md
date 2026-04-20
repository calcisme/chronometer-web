# Build System

The Chronometer Web build uses a bash script (`build.sh`) that invokes `esbuild` to bundle TypeScript into browser-ready JavaScript. No development server is needed — the output runs directly from `file://` URLs.

## Prerequisites

- **Node.js** v18+ (specifically `npx` for invoking esbuild)
- **Bash** and **zip** (pre-installed on macOS and most Linux)

Build command:
```bash
bash build.sh
```

This can also be run with:
```bash
PATH="/usr/local/bin:$PATH" bash build.sh
```

## Build Architecture

### Two Bundle Types

1. **`chronometer-engine.js`** (shared engine) — Contains the core systems shared by all faces:
   - Expression parser and evaluator
   - XML parser
   - Renderer
   - Animation system
   - Astronomy library
   - Watch environment (`watch-env.ts`)
   - Time controller
   - City search
   - Location/URL state management

2. **`face-<name>.js`** (per-face bundles) — Each face gets its own bundle containing:
   - The face's XML definition (imported as text)
   - Image assets (imported as data URLs or file references)
   - Face registration call

### HTML Generation

Each face gets its own HTML file generated from `src/face-template.html`. The template includes:
- The shared engine script
- The face-specific script
- Location panel, time controls, city picker UI
- Navigation elements

The all-faces page (`index.html`) includes all face scripts.

## Adding a New Face

`build.sh` must be updated in **three places**:

### 1. `FACES` Variable

Add the face basename to the `FACES` array:
```bash
FACES=(mauna-kea hana selene geneva miami ...)
```

### 2. `get_title()` Function

Map the basename to a display title:
```bash
get_title() {
    case "$1" in
        mauna-kea) echo "Mauna Kea" ;;
        hana)      echo "Hana" ;;
        ...
    esac
}
```

### 3. `ALL_SCRIPTS` Variable

Add the face script to the all-faces page script list:
```bash
ALL_SCRIPTS="dist/face-mauna-kea.js dist/face-hana.js ..."
```

## Engine Bundling Implications

Since `watch-env.ts` is bundled into the shared engine:
- Adding new environment functions (astronomy, time, etc.) requires a full `bash build.sh` rebuild
- Changes to `watch-env.ts` affect **all** faces
- Per-face changes (XML, images, registration) only require rebuilding that face's bundle

## Output Structure

```
dist/
├── index.html                    # All-faces grid page
├── mauna-kea.html               # Individual face pages
├── hana.html
├── ...
├── chronometer-engine.js         # Shared engine bundle
├── face-mauna-kea.js            # Per-face bundles
├── face-hana.js
├── ...
├── cities-data.js               # City database
├── apple-touch-icon.png         # PWA icon
└── *.png                        # Thumbnail images
```

## `file://` Deployment

The app is designed to work from `file://` URLs:
- No web server required
- Users can download `dist/` and double-click `index.html`
- Bookmarking preserves location settings via URL parameters
- See [Location & Cities — file:// Limitations](location-and-cities.md#file-url-limitations) for the few features that don't work without a server

## Verification

After building, open directly in the browser:
```bash
open dist/index.html
# or with location:
open "dist/mauna-kea.html?lat=37.33182&lon=-122.03118"
```

TypeScript type checking (no emit):
```bash
npx tsc --noEmit
```

Test suite:
```bash
npx vitest
```

## Key Source Files

| File | Purpose |
|------|---------|
| `build.sh` | Main build script |
| `src/face-template.html` | HTML template for individual face pages |
| `src/index.html` | All-faces grid page source |
| `src/faces/face-*.ts` | Per-face registration entry points |
| `tsconfig.json` | TypeScript configuration |
| `package.json` | Dependencies (esbuild) |

## Related Docs

- [Face Porting Guide](face-porting-guide.md) — How to add a new face (includes build steps)
- [Architecture Overview](architecture-overview.md) — Overall app structure
