/**
 * core/phase1/triggerRunner.js
 *
 * WHERE SINGLE-TRIGGER EXPLORATION HAPPENS.
 *
 * For each trigger candidate this module:
 *   1.  Opens a FRESH browser context (no state contamination from prior runs)
 *   2.  Installs the MutationObserver init script
 *   3.  Navigates to the URL
 *   4.  Optionally captures a "before" screenshot (fullPage mode only)
 *   5.  Takes a DOM snapshot (beforeNodes) for comparison
 *   6.  Performs the trigger action (click or hover) at stored coordinates
 *   7.  Waits for DOM to settle
 *   8.  Takes a DOM snapshot (afterNodes) for comparison
 *   9.  Collects mutation records
 *  10.  Compares before/after to find newly appeared nodes and regions
 *  11.  Captures after-state screenshot using the configured screenshotMode
 *  12.  Closes the context
 *
 * SCREENSHOT MODES
 * ────────────────
 * fullPage      — before (fullPage) + after (fullPage) + annotated (fullPage overlay)
 *                 Same as original behaviour. Maximum detail, highest cost.
 *
 * viewport      — skip before; after + annotated both use viewport-only screenshot.
 *                 Fastest; drops off-viewport content.
 *
 * changedRegion — skip before; after uses viewport; annotated clips to the union
 *                 bounding box of changed nodes (+ padding). DEFAULT.
 *                 Good balance of detail vs. cost.
 *
 * element       — skip before; after uses viewport; annotated clips to changed
 *                 region (same as changedRegion). Intended for future element-level
 *                 screenshot using a selector, falls back identically for now.
 *
 * Each trigger still runs in isolation — we NEVER reuse a dirty page state.
 */

import path from 'path';
import fs   from 'fs/promises';

import { createFreshContext, navigateTo }                          from '../browser.js';
import { MUTATION_TRACKER_SCRIPT, installMutationTracker,
         getMutations, resetMutations }                            from './mutationTracker.js';
import { extractStaticNodes }                                      from './staticAnalysis.js';
import { annotateScreenshot }                                      from '../annotate.js';
import { compareNodeSets, extractNewRegions }                      from '../compare.js';
import { sleep }                                                   from '../utils.js';
import { isInAutoDynamicRegion, freezeCssAnimations }              from './autoDynamicDetector.js';

// ── Config ─────────────────────────────────────────────────────────────────

const TRIGGER_SETTLE_MS = 2_000;
const NAV_TIMEOUT_MS    = 4_000;

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * Run one trigger candidate in a fresh browser context, collect changes.
 *
 * @param {import('playwright').Browser} browser
 * @param {string}  url        - Original page URL (re-navigated for isolation)
 * @param {object}  candidate  - Trigger candidate from phase1/triggerDiscovery
 * @param {string}  outDir     - Absolute job output directory path
 * @param {{        screenshotMode?: 'fullPage'|'viewport'|'changedRegion'|'element',
 *                  fallbackToFullPageOnClipFailure?: boolean }} opts
 * @returns {Promise<object>}  - Serializable trigger result object
 */
export async function runTrigger(browser, url, candidate, outDir, opts = {}) {
  const {
    screenshotMode                  = 'changedRegion',
    fallbackToFullPageOnClipFailure = true,
    // Auto-dynamic region overlap filtering:
    // newNodes that overlap known auto-dynamic regions are treated as background
    // noise and removed from the trigger result to reduce false positives.
    autoDynamicRegions              = [],
    autoDynamicOverlapThreshold     = 0.3,
    // Optional CSS stabilisation: pauses animations before trigger execution.
    // Reduces animation-driven mutation noise.  Does not replace classification.
    freezeCss                       = false,
  } = opts;

  const { triggerId, triggerType, bbox } = candidate;
  const resultsDir = path.join(outDir, 'trigger-results');

  let context;
  try {
    // ── 1. Fresh context with mutation observer ───────────────────────────────
    context = await createFreshContext(browser);
    await context.addInitScript(MUTATION_TRACKER_SCRIPT);

    const page = await context.newPage();
    await navigateTo(page, url);
    await installMutationTracker(page);

    // Optional CSS freeze — pauses animations before the trigger fires so that
    // background carousel transitions do not add false mutations.
    // Applied after navigation but before resetMutations so any style-injection
    // mutations are cleared in the same reset call.
    if (freezeCss) {
      await freezeCssAnimations(page).catch(() => {});
    }
    await resetMutations(page);

    // ── 2. Before-state DOM snapshot (screenshot only in fullPage mode) ────────
    const beforePath = path.join(resultsDir, `${triggerId}-before.png`);
    if (screenshotMode === 'fullPage') {
      // Before screenshot is only worthwhile when we also take a full after shot
      await page.screenshot({ path: beforePath, fullPage: true });
    }
    const { nodes: beforeNodes } = await extractStaticNodes(page);

    // ── 3. Trigger action ─────────────────────────────────────────────────────
    const cx = bbox.x + Math.round(bbox.width  / 2);
    const cy = bbox.y + Math.round(bbox.height / 2);

    let actionError = null;
    try {
      if (triggerType === 'hover') {
        await page.mouse.move(cx, cy, { steps: 5 });
        await sleep(300);
      } else {
        await page.mouse.click(cx, cy, { delay: 60 });
      }
      await sleep(TRIGGER_SETTLE_MS);
      await page
        .waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS })
        .catch(() => {});
    } catch (err) {
      actionError = err.message;
    }

    // ── 3b. Navigation-away fast exit ─────────────────────────────────────────
    // If the trigger caused a page navigation (URL changed) we know that:
    //   • The execution context is destroyed — further evaluate() calls will fail
    //   • There are no in-page newNodes to report
    //   • Any remaining wait time would be wasted (~20 s)
    // Return immediately with status 'navigated_away' so the parallel pool
    // can reclaim this worker slot without burning through the settle timeout.
    const pageUrlAfter = page.url();
    if (pageUrlAfter !== url) {
      await context.close();
      return {
        triggerId,
        action:              triggerType,
        status:              'navigated_away',
        screenshotMode,
        beforeScreenshot:    null,
        afterScreenshot:     null,
        annotatedScreenshot: null,
        mutationCount:       0,
        mutations:           [],
        newNodes:            [],
        backgroundNoiseCount: 0,
        newRegions:          [],
        navigatedToUrl:      pageUrlAfter,
        summary:             `Trigger caused page navigation to ${pageUrlAfter}`,
      };
    }

    // ── 4. After-state DOM snapshot ───────────────────────────────────────────
    const { nodes: afterNodes } = await extractStaticNodes(page);

    // ── 5. Collect mutations ──────────────────────────────────────────────────
    await installMutationTracker(page).catch(() => {});
    const mutations = await getMutations(page).catch(() => []);

    // ── 6. Compare before / after ─────────────────────────────────────────────
    const { newNodes: rawNewNodes } = compareNodeSets(beforeNodes, afterNodes);
    // Filter out nodes that overlap known auto-dynamic regions.
    // These represent background changes (e.g. carousel slide rotation) that
    // happened independently of the trigger and would inflate newNodes counts.
    const newNodes = autoDynamicRegions.length
      ? rawNewNodes.filter(
          (n) => !isInAutoDynamicRegion(n.bbox, autoDynamicRegions, autoDynamicOverlapThreshold),
        )
      : rawNewNodes;
    const backgroundNoiseCount = rawNewNodes.length - newNodes.length;
    const newRegions   = extractNewRegions(newNodes);

    // ── 7. Screenshots (mode-dependent) ──────────────────────────────────────
    const afterPath     = path.join(resultsDir, `${triggerId}-after.png`);
    const annotatedPath = path.join(resultsDir, `${triggerId}-annotated.png`);
    await _captureAfterScreenshots(
      page, newNodes, afterPath, annotatedPath,
      screenshotMode, fallbackToFullPageOnClipFailure,
    );

    await context.close();

    // ── 8. Result object ──────────────────────────────────────────────────────
    const relBase = path.join('outputs', path.basename(outDir), 'trigger-results');
    return {
      triggerId,
      action:              triggerType,
      status:              actionError ? 'failed' : 'success',
      screenshotMode,
      beforeScreenshot:    screenshotMode === 'fullPage'
        ? _unix(path.join(relBase, `${triggerId}-before.png`))
        : null, // not captured — saves one fullPage screenshot per trigger
      afterScreenshot:     _unix(path.join(relBase, `${triggerId}-after.png`)),
      annotatedScreenshot: _unix(path.join(relBase, `${triggerId}-annotated.png`)),
      mutationCount:       mutations.length,
      mutations:           mutations.slice(0, 100),
      newNodes:            newNodes.slice(0, 50),
      backgroundNoiseCount,
      newRegions,
      summary:             _buildSummary(candidate, newNodes, mutations, actionError),
      ...(actionError ? { error: actionError } : {}),
    };

  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      triggerId,
      action:              candidate.triggerType,
      status:              'failed',
      screenshotMode,
      beforeScreenshot:    null,
      afterScreenshot:     null,
      annotatedScreenshot: null,
      mutationCount:       0,
      mutations:           [],
      newNodes:            [],
      backgroundNoiseCount: 0,
      newRegions:          [],
      summary:             `Exception: ${err.message}`,
      error:               err.message,
    };
  }
}

// ── Screenshot helpers ────────────────────────────────────────────────────────

/**
 * Capture after-action screenshots according to the configured mode.
 *
 * fullPage      — full-page after + full-page annotated overlay (original behaviour)
 * viewport      — viewport after + viewport annotated (fastest)
 * changedRegion — viewport after + clipped changed-region annotated (default)
 * element       — viewport after + clipped changed-region annotated (same as changedRegion;
 *                 reserved for element-level screenshot in future)
 */
async function _captureAfterScreenshots(page, newNodes, afterPath, annotatedPath, mode, fallback) {
  switch (mode) {
    case 'fullPage': {
      await page.screenshot({ path: afterPath, fullPage: true });
      if (newNodes.length > 0) {
        await annotateScreenshot(page, newNodes.slice(0, 60), annotatedPath);
      } else {
        await fs.copyFile(afterPath, annotatedPath);
      }
      break;
    }

    case 'viewport': {
      // Viewport-only: cheap, no region clipping
      await page.screenshot({ path: afterPath, fullPage: false });
      await fs.copyFile(afterPath, annotatedPath);
      break;
    }

    case 'element':
    case 'changedRegion':
    default: {
      // Viewport after-shot (fast); clipped annotated if changes found
      await page.screenshot({ path: afterPath, fullPage: false });
      if (newNodes.length > 0) {
        await _captureClippedOrCopy(page, newNodes, annotatedPath, fallback, afterPath);
      } else {
        await fs.copyFile(afterPath, annotatedPath);
      }
      break;
    }
  }
}

/**
 * Clip screenshot to the union bounding box of changed nodes (+ padding).
 * Falls back to copying afterPath if clipping fails or bbox is degenerate.
 */
async function _captureClippedOrCopy(page, nodes, outPath, fallback, afterPath) {
  const clip = _computeUnionBbox(nodes, 24);
  if (!clip) {
    await fs.copyFile(afterPath, outPath);
    return;
  }
  try {
    await page.screenshot({ path: outPath, clip });
  } catch {
    if (fallback) await fs.copyFile(afterPath, outPath);
  }
}

/**
 * Compute the union bounding box of all nodes that have a non-zero bbox,
 * expanded by `padding` pixels on every side. Returns null when no valid
 * bboxes exist.
 */
function _computeUnionBbox(nodes, padding = 0) {
  const valid = nodes.filter((n) => n.bbox && n.bbox.width > 0 && n.bbox.height > 0);
  if (!valid.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of valid) {
    minX = Math.min(minX, n.bbox.x);
    minY = Math.min(minY, n.bbox.y);
    maxX = Math.max(maxX, n.bbox.x + n.bbox.width);
    maxY = Math.max(maxY, n.bbox.y + n.bbox.height);
  }

  return {
    x:      Math.max(0, minX - padding),
    y:      Math.max(0, minY - padding),
    width:  Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  };
}

// ── Other private helpers ─────────────────────────────────────────────────────

function _unix(p) {
  return p.replace(/\\/g, '/');
}

function _buildSummary(candidate, newNodes, mutations, error) {
  if (error)                                              return `Action failed: ${error}`;
  if (newNodes.length === 0 && mutations.length === 0)    return 'No visible DOM changes detected.';
  const parts = [];
  if (newNodes.length)  parts.push(`${newNodes.length} new node(s)`);
  if (mutations.length) parts.push(`${mutations.length} mutation(s)`);
  return `Detected ${parts.join(' and ')}.`;
}
