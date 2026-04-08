# Emerald Chronometer — Web Edition

A web port of [Emerald Chronometer](https://github.com/EmeraldSequoia/Chronometer), an astronomical watch-face app originally built for iPhone and iPad in Objective-C, C++, and C.

This project re-implements the app entirely in TypeScript, rendering animated watch faces to HTML Canvas. Like the original iOS app, it requires **no backend server** — it runs completely in the browser using only the device's clock and location.

## Watch Faces

The current build includes four faces:

| Face | Description |
|------|-------------|
| **Haleakalā** | Sunrise & sunset times with altitude/azimuth |
| **Hana** | Moonrise & moonset times, lunar phase, and altitude/azimuth |
| **Chandra** | Giant moon-phase display with altitude/azimuth dots |
| **Selene** | Comprehensive lunar information |

## Prerequisites

- **Node.js** (v18 or later) — only needed for the `npx` command, which invokes [esbuild](https://esbuild.github.io/) to bundle TypeScript into browser-ready JavaScript.
- **Bash** — the build script is a short shell script.
- **zip** — used by the build script to create a distributable archive (pre-installed on macOS and most Linux distributions).

There are no runtime server dependencies. The build output is a set of static files.

## Building

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run the build script:

   ```bash
   npm run build
   ```

   This produces the `dist/` directory containing:
   - `index.html` — face-selector page with thumbnails
   - `haleakala.html`, `hana.html`, `chandra.html`, `selene.html` — individual face viewers
   - `all.html` — a grid view of all faces at once
   - `chronometer-engine.js` — the shared rendering engine
   - `face-*.js` — per-face data (XML definitions and image assets, all inlined)
   - `thumb-*.png` — thumbnail images for the selector page

   It also creates `dist.zip` at the project root — a zip archive of the entire `dist/` directory.

## Running

The built app is entirely self-contained — no web server is required. To use it:

1. Open the `dist/` directory in Finder (or your file manager).
2. Double-click **`index.html`** to open it in your default browser.
3. Select a watch face from the grid, or open any individual face HTML file directly.

The watch faces will animate in real time using your system clock. If your browser supports the Geolocation API and you grant permission, astronomical calculations (sunrise, moonrise, etc.) will use your current location; otherwise they default to a built-in location.

## Development

For iterative development with hot reload:

```bash
npm run dev
```

This starts a [Vite](https://vite.dev/) dev server. Other useful commands:

| Command | Description |
|---------|-------------|
| `npm run typecheck` | Run the TypeScript compiler in check-only mode |
| `npm test` | Run the test suite (Vitest) |
| `npm run test:watch` | Run tests in watch mode |

## Architecture

The app is structured as a pure client-side renderer:

- **`src/watch/`** — Core rendering engine: parses watch-face XML, evaluates dynamic expressions, composites layers onto Canvas.
- **`src/expr/`** — Expression tokenizer and parser for the arithmetic expressions embedded in watch-face definitions.
- **`src/astronomy/`** — Ported astronomical routines (sun/moon positions, rise/set times, twilight, lunar phase).
- **`src/faces/`** — Per-face entry points that bundle the XML definition and image assets for each watch face.

## Provenance

The original Emerald Chronometer was created by [Emerald Sequoia LLC](https://github.com/EmeraldSequoia) and has been available on the iOS App Store since 2008. The source code for the iOS app and its supporting libraries is available on GitHub:

- [Chronometer](https://github.com/EmeraldSequoia/Chronometer) — the iOS app
- [esastro](https://github.com/EmeraldSequoia/esastro) — the astronomical calculation library

This web edition is a ground-up rewrite in TypeScript. It reads the same XML watch-face definitions as the iOS app but replaces the OpenGL rendering pipeline with Canvas 2D, and replaces the binary expression evaluator with a TypeScript implementation.

## License

MIT
