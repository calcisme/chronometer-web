# Plan: Visual Ink Centering for Radial Text

## The Issue
Currently, `Qhand` elements with the `text` attribute use `ctx.textAlign = 'center'`. This natively centers the text based on its **typographical advance width** (the invisible bounding box the font designer specified). 

In fonts like *Times New Roman*, numbers are often "tabular" (they all have the exact same bounding box width so they line up neatly in spreadsheets). For a narrow digit like "1", the actual drawn ink is pushed to the right side of this wide tabular box. Therefore, centering the box makes the actual ink visually off-center to the right (clockwise on the dial).

## The Solution
Instead of trusting the font's advance width, we will measure the **exact pixels of ink** drawn by the browser.
1. We will use `ctx.measureText(part.text)`.
2. We will extract `actualBoundingBoxLeft` and `actualBoundingBoxRight` (which tell us exactly where the black pixels start and end).
3. We will set `ctx.textAlign = 'left'` and manually apply an X-offset of `(metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2`.

## Blast Radius: Affected Components
I have searched the entire XML asset database for any `Qhand` elements with `type='spoke'` and a `text=` attribute. This change will affect exactly **44 components** across two watch faces:

1. **Kyoto (`Kyoto-I.xml`)**
   - **`jh00` - `jh11` (12 elements):** Japanese Kanji hour labels. *Impact:* Since Kanji are full-width and naturally centered in their em-box, the ink offset will be ~0px. No visual change.
   - **`js00` - `js11` (12 elements):** Japanese Kanji half-hour labels. *Impact:* Same as above.
   - **`n24_00` - `n24_23` (24 elements):** Arabic numerals for the 24-hour dial. *Impact:* **The intended fix.** This will perfectly align the off-center tabular numbers (like 1, 11, 12) with the spokes.

2. **Gaia (`Gaia-I.xml`)**
   - **`lam`, `lpm`, `s1am`, `s1pm`, `s2am`, `s2pm`, `s3am`, `s3pm` (8 elements):** The AM/PM indicator text inside the rotating windows for all four time zones. *Impact:* Since "AM" and "PM" are wide and relatively symmetrical, their advance box is practically identical to their ink box. The change will be imperceptible or represent a microscopic alignment improvement inside the window.

## Implementation
I will modify the text rendering logic in `src/watch/renderer.ts` for `Qhand` (inside the `if (handType === 'spoke')` block) to implement this precision ink-centering.

This approach is highly localized to just `Qhand` spoke rendering, completely isolated from `QDial`, `SWheel`, or generic static text, making it extremely safe while perfectly solving the alignment issue.
