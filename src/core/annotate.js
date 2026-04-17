/**
 * core/annotate.js
 *
 * Injects an absolutely-positioned overlay of numbered bounding boxes into
 * the live page DOM, takes a full-page screenshot, then removes the overlay.
 *
 * Uses document-absolute coordinates (rect.x + scrollX, rect.y + scrollY)
 * so boxes appear at the correct position in full-page screenshots.
 * No native image-processing dependencies required.
 *
 * Multi-color support: when a node carries `labelColor` and
 * `functionalCategoryCode` fields (added by classifyNodes()) each box is
 * rendered in the category color with a label like "[BTN #3]".
 * Falls back to red "#E53E3E" and index number when these fields are absent.
 */

/** Default annotation color (red) used when no functional category is present. */
const DEFAULT_COLOR = '#E53E3E';

/**
 * @param {import('playwright').Page} page  - Live Playwright page
 * @param {Array<{bbox:{x,y,width,height}}>} nodes - Items to annotate
 * @param {string} outputPath - Absolute path to save the screenshot
 * @param {object} [screenshotOpts]  Optional screenshot options passed directly to
 *   page.screenshot().  Supported keys: `fullPage`, `clip`.
 *   When omitted the function auto-selects fullPage vs viewport based on page size.
 */
export async function annotateScreenshot(page, nodes, outputPath, screenshotOpts = {}) {
  const hasExplicitOpts = Object.keys(screenshotOpts).length > 0;

  // If nothing to annotate, just take a screenshot using caller-supplied opts
  if (!nodes || nodes.length === 0) {
    const fallbackOpts = hasExplicitOpts ? screenshotOpts : { fullPage: true };
    await page.screenshot({ path: outputPath, ...fallbackOpts });
    return;
  }

  // Prepare a minimal serializable representation.
  // Include per-node color and short code when available (from classifyNodes()).
  const items = nodes.map((n, i) => ({
    idx:      i + 1,
    x:        n.bbox.x,
    y:        n.bbox.y,
    w:        n.bbox.width,
    h:        n.bbox.height,
    color:    n.labelColor                ?? DEFAULT_COLOR,
    code:     n.functionalCategoryCode    ?? null,   // null → show only index
  }));

  await page.evaluate((items) => {
    const OVERLAY_ID = '__dom_analyzer_overlay__';
    document.getElementById(OVERLAY_ID)?.remove();

    const container = document.createElement('div');
    container.id = OVERLAY_ID;
    // Absolutely positioned at (0,0) with overflow:visible so boxes extend
    // across the full document height in a full-page screenshot
    container.style.cssText =
      'position:absolute;top:0;left:0;width:0;height:0;' +
      'pointer-events:none;z-index:2147483647;overflow:visible;';

    for (const item of items) {
      const color = item.color || '#E53E3E';

      const box = document.createElement('div');
      box.style.cssText = [
        'position:absolute',
        `left:${item.x}px`,
        `top:${item.y}px`,
        `width:${item.w}px`,
        `height:${item.h}px`,
        `border:2px solid ${color}`,
        'box-sizing:border-box',
        'overflow:visible',
      ].join(';');

      const label = document.createElement('div');
      // Label text: "[BTN #3]" when code is known, just "3" as fallback
      label.textContent = item.code
        ? `[${item.code} #${item.idx}]`
        : String(item.idx);
      label.style.cssText = [
        'position:absolute',
        'top:-1px',
        'left:-1px',
        `background:${color}`,
        'color:#fff',
        'font:bold 9px/1.3 monospace',
        'padding:1px 4px',
        'white-space:nowrap',
        'border-radius:0 0 2px 0',
      ].join(';');

      box.appendChild(label);
      container.appendChild(box);
    }

    // Append to <html> rather than <body> so it always renders on top
    document.documentElement.appendChild(container);
  }, items);

  // Determine screenshot options.
  // When the caller provides explicit opts (e.g. { clip } for changedRegion mode
  // or { fullPage: false } for viewport mode) use them directly.
  // When no opts are given, auto-detect based on page dimensions to avoid the
  // Skia SkBitmap pixel-allocation crash on oversized pages.
  let resolvedOpts;
  if (hasExplicitOpts) {
    resolvedOpts = screenshotOpts;
  } else {
    const dimensions = await page.evaluate(() => ({
      width:  Math.max(document.documentElement.scrollWidth,  document.body.scrollWidth),
      height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    })).catch(() => ({ width: 0, height: 0 }));
    resolvedOpts = (dimensions.height > 15000 || dimensions.width > 8000)
      ? { fullPage: false }
      : { fullPage: true };
  }

  let screenshotErr;
  try {
    await page.screenshot({ path: outputPath, ...resolvedOpts });
  } catch (err) {
    screenshotErr = err;
    // Viewport-only (fullPage:false) failures are unexpected — propagate.
    // For fullPage screenshots (with or without a clip region), fall back to a
    // safe viewport shot so the annotation is not lost entirely.  This covers
    // the Skia SkBitmap crash on oversized pages AND the case where a clipped
    // region turns out to be outside the rendered document bounds.
    if (!resolvedOpts.fullPage) {
      throw err; // viewport-only failure is unexpected — propagate
    }
    await page.screenshot({ path: outputPath, fullPage: false });
  }

  // Remove the overlay so subsequent page interactions are unaffected
  await page.evaluate(() => {
    document.getElementById('__dom_analyzer_overlay__')?.remove();
  });

  if (screenshotErr && resolvedOpts.fullPage) {
    // Already recovered above; swallow to prevent double-throw
  }
}
