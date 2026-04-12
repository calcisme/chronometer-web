# Watch Face Porting Skill

When tasked with porting a new watch face from the existing Objective-C/C++ iOS codebase to this TypeScript web application, follow the procedures and guidelines outlined below.

## 1. Locating the Source XML

* **Standard Location**: A watch face to be ported is nearly always found in the `.chronometer-ref/Watches/Builtin-Android/` directory.
* **Naming Convention**: If the face to be ported is "Foo", there will be a directory named `Foo I` and a file within it named `Foo I.xml`.
* **Variant II**: For a few faces, the face to port will be found in `Foo II/Foo II.xml`. **Important rule**: We will never use the "II" names directly in the web app. The user will instruct you what name for the face we should use in the web app instead of "Foo II". If they don't, **stop and ask** what the name should be.

## 2. Porting the XML Definition

1. **Copy the XML file**: Copy the Android XML file (`Foo I.xml` or equivalent) to the appropriate directory in `src/watch/assets/<face_name>/`.
2. **Remove Night Mode**: After copying the XML file, **delete any watch parts which only apply to "night" mode** (e.g. `modes='night'`, terminators, or QWheels specific to night mode). We will not be implementing night mode in the TypeScript version, and these parts will clash with the front-mode render or take up unnecessary space.
3. **Bezel Color**: **Always add a `bezelColor` attribute** to the `<watch>` tag when copying it. If the XML file defines a "case" image (e.g. `<Image name='case' ... />`), delete it or skip using it. Instead, use the typical color of the bezel within that image to decide what `bezelColor` value to pick (e.g. `bezelColor='rgb(160,160,160)'`).

## 3. High-Resolution Assets

* Where possible, utilize the `4x` or `2x` high-resolution image assets for backgrounds, subdials, and hands (e.g. `faceFront-4x.png`).
* When integrating a high-resolution asset into the TypeScript face setup file (`src/faces/face-<name>.ts`), be sure to apply the appropriate scaling factor to the image (e.g., `scale: 1/4` for a `4x` image) to ensure the bounding boxes and rendering correctly align with the standard coordinates.

## 4. Porting C++ Logic to TypeScript

* **Reference Directories**: Look at the original iOS code to determine how functions work that are not yet implemented in the TypeScript environment. The reference directories are:
  * `.chronometer-ref/` (Chronometer app code)
  * `.astro-ref/` (Astronomy logic)
  * `.estime-ref/` (Time and calendar logic)
* **Never Simplify iOS Algorithms**: **IMPORTANT**: NEVER simplify the logic found in the iOS reference code when implementing the TypeScript version. Sometimes code there that appears like it could be simplified is actually handling an edge case that is not immediately obvious. 
* **If Blocked, Ask**: If you *cannot* implement the iOS algorithm directly for technical or structural reasons, **stop and ask the user how to proceed**. Do not attempt to design a novel approximation on your own.
* **Environment Functions**: If the XML relies on astronomical or time functions that the web app's expression parser doesn't recognize (e.g. `GregorianEra()`, `moonSet()`), define and export those helper functions in `watch-env.ts` or a related astronomy module, strictly following the C++ implementation.

## 5. Visual Parity & Rendering

* **Drawing Order**: The renderer must process XML parts strictly in document order. Z-index ordering is not fully implemented, meaning if `Part A` is listed before `Part B` in the XML, `B` will render on top of `A`.
* **Verification**: Build the project (`bash build.sh`). It is not necessary to run a local web server to test the file; instead you can simply use a `file://` URL pointing at the appropriate `.html` file in the `dist/` directory. This app is designed to work using `file://` URLs. Check the browser console for rendering errors or unimplemented function errors. Ensure that there are no overlapping artifacts, orphaned windows, or text misalignments.
