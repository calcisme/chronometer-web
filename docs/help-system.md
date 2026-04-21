# Help System

Per-face help content is displayed in the ℹ info popup on every single-face page. When the user clicks the ℹ button, the popup shows generic project info at the top, a separator, and then face-specific help text below.

## Source Material

The help content was ported from the **Android (Wear OS) help files** stored in `/Users/spucci/aw/`. These are HTML files that were originally part of the Emerald Chronometer for Wear OS product pages.

### Android Help Directory Structure

The Android help files use iOS-derived directory names, but the face names in the filenames are the same Android face names used in our app:

```
/Users/spucci/aw/
├── haleakala/
│   ├── haleakala_i.html    → Haleakalā face help
│   └── hana_i.html         → Hana face help
├── chandra/
│   ├── chandra_i.html      → Chandra face help
│   └── selene_i.html       → Selene face help
├── mauna_kea/
│   └── mauna_kea_i.html    → Mauna Kea face help
├── geneva/
│   ├── geneva_i.html       → Geneva face help
│   └── basel_i.html        → Basel face help
├── firenze/
│   └── firenze_i.html      → Firenze face help
├── miami/
│   ├── miami_i.html        → Miami face help
│   └── venezia_i.html      → Venezia face help
├── terra/
│   ├── terra_i.html        → Terra face help
│   └── gaia_i.html         → Gaia face help
├── babylon/
│   └── babylon_i.html      → Babylon face help
└── product.css              → Legacy Android help stylesheet (not used)
```

### Extraction Process

Each Android help file has a standard structure with boilerplate and content markers:

```html
<!-- boilerplate: nav, shutdown notice, banner, buy buttons -->
<!-- Boilerplate code above here -->

    <!-- ACTUAL HELP CONTENT - this is what we extract -->

<!-- Boilerplate code below here -->
<!-- boilerplate: face icon gallery, copyright -->
```

The help content was extracted manually (no automated script) with the following adaptations:

1. **Stripped**: All boilerplate (nav headers, shutdown notice, banner images, buy buttons, footer face gallery, copyright)
2. **Stripped**: Android/Wear OS-specific text — entire sentences or paragraphs referencing ambient mode, gear button, long press instructions
3. **Stripped**: Banner images (large Wear OS device screenshots, 200–450KB each)
4. **Stripped**: Links to `emeraldsequoia.com` product pages — text simplified (e.g., "Both are included in Emerald Chronometer" → "Terra and Gaia are world-time faces")
5. **Rewrote**: Cross-face help links to point to our pages (e.g., `../miami/venezia_i.html` → `venezia.html`)
6. **Rewrote**: Image `src` paths from relative Android paths to `help/images/<dir>/filename.png`
7. **Rewrote**: Android-specific settings instructions to reference our web app UI (e.g., "use the Change cities button below the face" instead of "long press on the center of the face, or tap the gear button")
8. **Kept**: All external educational links (Wikipedia, NIST, Montana solar, Baselworld) with `extlink.png` icons
9. **Kept**: All inline explanatory images (screenshots of watch details)
10. **Inlined**: Terra's `SlotRules.html` as a collapsible `<details>/<summary>` section (default collapsed)

### Faces with Unported Counterparts

The Android help includes faces not yet in our web app. These are **not** included:

- Alexandria, Atlantis, Milano, Paris, Vienna, McAlester, Mauna Loa, Padua

Cross-face links pointing to unported faces are rendered as plain text.

## Architecture

### Build-Time Injection

Help HTML fragments live in `src/help/<face-slug>.html` (one per face). During build, `build.sh` injects each fragment into the page inside a `<template>` element:

```html
<template id="help-template">
    <!-- face-specific help HTML injected here by build.sh -->
</template>
```

The `<template>` element is **inert** — browsers do not render its content or load any images within it.

### Runtime Lazy Cloning

On first ℹ click, `engine-entry.ts` clones the template content into the live DOM:

```typescript
const helpTemplate = document.getElementById('help-template') as HTMLTemplateElement;
helpContent.appendChild(helpTemplate.content.cloneNode(true));
```

This triggers image loading only when the user actually opens help. It also works correctly with `file://` URLs (unlike `fetch()`, which is blocked by CORS on `file://`).

### Help Images

Referenced images are stored in `src/help/images/`, organized by Android directory name:

```
src/help/images/
├── extlink.png               # External link indicator icon
├── haleakala/                 # Haleakala + Hana images
├── chandra/                   # Chandra + Selene images
├── mauna_kea/                 # Mauna Kea images
├── geneva/                    # Geneva + Basel images
├── babylon/                   # Babylon images
├── terra/                     # Terra + Gaia images + SlotRules images
├── miami/                     # Miami images
└── firenze/                   # (empty — Firenze has no inline images)
```

During build, these are copied to `dist/help/images/`.

### For `all.html`

The all-faces page receives an empty `<template>`, so the help popup shows only the generic project info with no face-specific content.

## File Inventory

| File | Purpose |
|------|---------|
| `src/help/<face>.html` | Help HTML fragment (13 files, one per face) |
| `src/help/images/` | Inline help images (47 files across 8 subdirectories) |
| `src/face-template.html` | Contains `#help-content` div, `<template>`, and help CSS |
| `build.sh` | `get_help_file()` function + `{{HELP_CONTENT}}` injection |
| `src/engine-entry.ts` | Template cloning on first ℹ click |

## Adding Help for a New Face

See [Face Porting Guide — Step 11](face-porting-guide.md#11-help-content).

## Related Docs

- [Face Porting Guide](face-porting-guide.md) — Step-by-step porting procedure (includes help step)
- [Build System](build-system.md) — How the build injects help content
