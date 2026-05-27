/**
 * Utility functions for calculating bezel-matched backgrounds
 * and dynamically generating composite home screen/browser icons.
 */

/**
 * Calculates a background color that is 2/3 of the way towards black
 * from the watch's bezel color (preserving the hue).
 * Supports rgb(r, g, b) and hex colors. Falls back to black.
 */
/**
 * Helper to parse standard hex or rgb color strings into numeric R, G, B channels.
 */
export function parseColorToRgb(color: string): { r: number; g: number; b: number } | null {
    if (!color) return null;
    const rgbMatch = color.match(/rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
    if (rgbMatch) {
        return {
            r: parseInt(rgbMatch[1], 10),
            g: parseInt(rgbMatch[2], 10),
            b: parseInt(rgbMatch[3], 10)
        };
    }
    if (color.startsWith('#')) {
        const hex = color.substring(1);
        if (hex.length === 3) {
            return {
                r: parseInt(hex[0] + hex[0], 16),
                g: parseInt(hex[1] + hex[1], 16),
                b: parseInt(hex[2] + hex[2], 16)
            };
        } else if (hex.length === 6) {
            return {
                r: parseInt(hex.substring(0, 2), 16),
                g: parseInt(hex.substring(2, 4), 16),
                b: parseInt(hex.substring(4, 6), 16)
            };
        }
    }
    return null;
}

/**
 * Calculates a background color that is 2/3 of the way towards black
 * from the watch's bezel color (preserving the hue).
 * Supports rgb(r, g, b) and hex colors. Falls back to black.
 */
export function getBezelBackgroundColor(bezelColor: string): string {
    const parsed = parseColorToRgb(bezelColor);
    if (!parsed) return '#000000';

    // Scale RGB values by 1/3 (making them 2/3 closer to black)
    const newR = Math.round(parsed.r / 3);
    const newG = Math.round(parsed.g / 3);
    const newB = Math.round(parsed.b / 3);

    return `rgb(${newR}, ${newG}, ${newB})`;
}

/**
 * Loads an image from the given source URL.
 */
function loadImg(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`Failed to load ${src}`));
        img.src = src;
    });
}

/**
 * Helper to draw an image clipped to a circle to remove baked-in corner backgrounds.
 */
function drawClippedImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, size: number) {
    ctx.save();
    const r = size / 2;
    ctx.beginPath();
    ctx.arc(x + r, y + r, r - 0.5, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, x, y, size, size);
    ctx.restore();
}

/**
 * Calculates the average background color for a single bezel color or a list of bezel colors.
 * If no valid colors are provided, falls back to the default dark blue theme color '#1a1a2e'.
 */
export function getAverageBezelBackgroundColor(bezelColors?: string | string[]): string {
    let bg = '#1a1a2e';
    if (bezelColors) {
        const colors = typeof bezelColors === 'string' ? [bezelColors] : bezelColors;
        let sumR = 0, sumG = 0, sumB = 0, validCount = 0;
        for (const color of colors) {
            if (!color || parseColorToRgb(color) === null) {
                continue;
            }
            const bgColor = getBezelBackgroundColor(color);
            const parsed = parseColorToRgb(bgColor);
            if (parsed) {
                sumR += parsed.r;
                sumG += parsed.g;
                sumB += parsed.b;
                validCount++;
            }
        }
        if (validCount > 0) {
            bg = `rgb(${Math.round(sumR / validCount)}, ${Math.round(sumG / validCount)}, ${Math.round(sumB / validCount)})`;
        }
    }
    return bg;
}

/**
 * Dynamically composites the first 1-4 selected watch face thumbnails
 * into a single PNG icon and updates the DOM's apple-touch-icon and icon links.
 */
export async function updateDynamicCompositeIcon(
    thumbDataUrls: string[],
    bezelColors?: string | string[]
): Promise<void> {
    if (typeof document === 'undefined') return; // Guard for non-DOM environments

    const appleLink = document.querySelector('link[rel~="apple-touch-icon"]');
    const iconLink = document.querySelector('link[rel~="icon"]');

    if (!appleLink && !iconLink) return;

    // Determine the background color
    const bg = getAverageBezelBackgroundColor(bezelColors);

    if (thumbDataUrls.length === 0) {
        // Fallback to all faces icon
        updateLinks('thumb-all-faces.png', 'thumb-all-faces.png');
        return;
    }

    try {
        const canvas = document.createElement('canvas');
        canvas.width = 400;
        canvas.height = 400;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Draw watch faces first (leaving background transparent and clipping corners)
        if (thumbDataUrls.length === 1) {
            // Draw single face over transparent canvas, clipped to a circle
            const img = await loadImg(thumbDataUrls[0]);
            drawClippedImage(ctx, img, 0, 0, 400);
        } else if (thumbDataUrls.length === 2) {
            // Diagonal layout (Top-Left and Bottom-Right) scaled to 230x230
            const imgs = await Promise.all(thumbDataUrls.slice(0, 2).map(url => loadImg(url)));
            drawClippedImage(ctx, imgs[0], 0, 0, 230);
            drawClippedImage(ctx, imgs[1], 170, 170, 230);
        } else if (thumbDataUrls.length === 3) {
            // Asymmetric Hex Close Packing (1 larger face at top, 2 smaller at bottom)
            const imgs = await Promise.all(thumbDataUrls.slice(0, 3).map(url => loadImg(url)));
            drawClippedImage(ctx, imgs[0], 87.5, 0, 225); // Top-center face (225x225)
            drawClippedImage(ctx, imgs[1], 0, 200, 200);   // Bottom-left face (200x200)
            drawClippedImage(ctx, imgs[2], 200, 200, 200); // Bottom-right face (200x200)
        } else {
            // 4+ faces: Standard 2x2 grid (200x200 each)
            const imgs = await Promise.all(thumbDataUrls.slice(0, 4).map(url => loadImg(url)));
            drawClippedImage(ctx, imgs[0], 0, 0, 200);
            drawClippedImage(ctx, imgs[1], 200, 0, 200);
            drawClippedImage(ctx, imgs[2], 0, 200, 200);
            drawClippedImage(ctx, imgs[3], 200, 200, 200);
        }

        // Get the transparent data URL for the browser favicon (rel="icon")
        const iconHref = canvas.toDataURL('image/png');

        // Draw background color behind the already drawn watch faces for apple-touch-icon (opaque)
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, 400, 400);
        ctx.globalCompositeOperation = 'source-over'; // Reset to default

        const appleHref = canvas.toDataURL('image/png');

        updateLinks(appleHref, iconHref);
    } catch (err) {
        console.error('Error compositing picks icon:', err);
    }

    function updateLinks(appleHref: string, iconHref: string) {
        const head = document.head;

        // Update Apple Touch Icon: must remove and append to force Safari registration
        const existingApple = document.querySelector('link[rel~="apple-touch-icon"]');
        if (existingApple) {
            head.removeChild(existingApple);
        }
        const newApple = document.createElement('link');
        newApple.rel = 'apple-touch-icon';
        newApple.href = appleHref;
        head.appendChild(newApple);

        // Update Icon (favicon): must remove and append to force browser update
        const existingIcon = document.querySelector('link[rel~="icon"]');
        if (existingIcon) {
            head.removeChild(existingIcon);
        }
        const newIcon = document.createElement('link');
        newIcon.rel = 'icon';
        newIcon.type = 'image/png';
        newIcon.href = iconHref;
        head.appendChild(newIcon);
    }
}
