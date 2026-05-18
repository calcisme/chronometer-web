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

`build.sh` must be updated in **three places** (plus an optional fourth for help):

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

### 4. Help Content (if applicable)

If the new face has a help file in `src/help/<face>.html`, the `get_help_file()` function will automatically find it by convention (it looks for `src/help/<face-slug>.html`). No explicit mapping is needed — just place the help fragment file with the correct slug name. See [Help System](help-system.md) for details on creating help files.

## Engine Bundling Implications

Since `watch-env.ts` is bundled into the shared engine:
- Adding new environment functions (astronomy, time, etc.) requires a full `bash build.sh` rebuild
- Changes to `watch-env.ts` affect **all** faces
- Per-face changes (XML, images, registration) only require rebuilding that face's bundle

## Versioning

The build system automatically tracks and increments the build number. This is driven by a `version.txt` file in the repository root.

- **`version.txt`**: A required file containing the current version string in `<major>.<minor>.<build>` format (e.g., `1.4.1`), along with instructional comments. Blank lines and comment lines (starting with `#`) are preserved.
- **Auto-increment**: Each time `build.sh` is run, it reads `version.txt`, increments the `<build>` component by 1, and updates `version.txt` in place without destroying the comments.
- **HTML Injection**: The computed version is injected via a `{{VERSION}}` placeholder into the HTML templates, making it visible at the bottom of the help modals and the general `help.html` page.

If you need to bump the major or minor version (e.g., from `1.4.x` to `1.5.1`), manually edit the version number inside `version.txt` before running the build script.

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
├── help/
│   └── images/                  # Help content images (copied from src/help/images/)
│       ├── extlink.png
│       ├── geneva/
│       ├── terra/
│       └── ...
├── apple-touch-icon.png         # PWA icon
└── *.png                        # Thumbnail images
```

Note: Help HTML fragments are injected directly into each face's HTML file at build time (inside a `<template>` element), so they do not appear as separate files in `dist/`.

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

TypeScript type checking runs automatically as the first step of `build.sh` (via `npx tsc --noEmit`). The build will abort on any type error. To run it standalone:
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
| `src/help/*.html` | Per-face help content fragments (injected at build time) |
| `src/help/images/` | Help content images (copied to `dist/help/images/`) |
| `version.txt` | Current build version, read and updated by `build.sh` |
| `tsconfig.json` | TypeScript configuration |
| `package.json` | Dependencies (esbuild) |

## Related Docs

- [Face Porting Guide](face-porting-guide.md) — How to add a new face (includes build steps)
- [Architecture Overview](architecture-overview.md) — Overall app structure
- [Help System](help-system.md) — Help content architecture
