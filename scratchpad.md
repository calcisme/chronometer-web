# Plan: Visual Ink Centering for Radial Text

1. **The Issue**: Currently, we use `ctx.textAlign = 'center'`, which centers the text based on its **typographical advance width**. In fonts like *Times New Roman*, numbers are often "tabular" (they all have the exact same box width so they line up in spreadsheets). For narrow digits like "1", the ink is pushed to the right side of this box. Therefore, centering the box makes the actual ink look like it's offset to the right (clockwise on the top, etc.).

2. **The Solution**: Instead of trusting the font's advance width, we will measure the **exact pixels of ink** drawn by the browser. 
   - We will use `ctx.measureText(part.text)`.
   - We will extract `actualBoundingBoxLeft` and `actualBoundingBoxRight` (which tell us exactly where the black pixels start and end).
   - We will set `ctx.textAlign = 'left'` and manually apply an X-offset of `(metrics.actualBoundingBoxLeft - metrics.actualBoundingBoxRight) / 2`.

3. **Implementation**: I will modify the text rendering logic in `renderer.ts` for `Qhand` (around line 1636) to implement this precision ink-centering.

This will guarantee that the exact visual center of the number aligns perfectly with the dynamic spoke line.
