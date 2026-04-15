/**
 * core/annotate.js
 *
 * Injects an absolutely-positioned overlay of numbered bounding boxes into
 * the live page DOM, takes a full-page screenshot, then removes the overlay.
 *
 * Uses document-absolute coordinates (rect.x + scrollX, rect.y + scrollY)
 * so boxes appear at the correct position in full-page screenshots.
 * No native image-processing dependencies required.
 */

/**
 * @param {import('playwright').Page} page  - Live Playwright page
 * @param {Array<{bbox:{x,y,width,height}}>} nodes - Items to annotate
 * @param {string} outputPath - Absolute path to save the screenshot
 */
export async function annotateScreenshot(page, nodes, outputPath) {
  // If nothing to annotate, just take a regular screenshot
  if (!nodes || nodes.length === 0) {
    await page.screenshot({ path: outputPath, fullPage: true });
    return;
  }

  // Prepare a minimal serializable representation
  const items = nodes.map((n, i) => ({
    idx: i + 1,
    x:   n.bbox.x,
    y:   n.bbox.y,
    w:   n.bbox.width,
    h:   n.bbox.height,
  }));

  // Inject overlay divs into the page
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
      const box = document.createElement('div');
      box.style.cssText = [
        'position:absolute',
        `left:${item.x}px`,
        `top:${item.y}px`,
        `width:${item.w}px`,
        `height:${item.h}px`,
        'border:2px solid rgba(220,40,40,0.85)',
        'box-sizing:border-box',
        'overflow:visible',
      ].join(';');

      const label = document.createElement('div');
      label.textContent = String(item.idx);
      label.style.cssText = [
        'position:absolute',
        'top:-1px',
        'left:-1px',
        'background:rgba(220,40,40,0.85)',
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

  await page.screenshot({ path: outputPath, fullPage: true });

  // Remove the overlay so subsequent page interactions are unaffected
  await page.evaluate(() => {
    document.getElementById('__dom_analyzer_overlay__')?.remove();
  });
}
