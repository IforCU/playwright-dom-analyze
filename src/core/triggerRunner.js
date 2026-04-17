/**
 * core/triggerRunner.js
 *
 * WHERE DYNAMIC TRIGGER EXPLORATION HAPPENS.
 *
 * For each trigger candidate, this module:
 *   1. Opens a FRESH browser context (no state contamination from prior runs)
 *   2. Installs the MutationObserver init script
 *   3. Navigates to the URL
 *   4. Captures "before" screenshot and node snapshot
 *   5. Performs the trigger action (click or hover) at the stored coordinates
 *   6. Waits for DOM to settle
 *   7. Captures "after" screenshot and node snapshot
 *   8. Collects mutation records
 *   9. Compares before/after to find newly appeared nodes and regions
 *  10. Saves an annotated screenshot highlighting the changes
 *
 * Each trigger runs in isolation — we never reuse a dirty page state.
 */

import path from 'path';
import fs from 'fs/promises';
import { createFreshContext, navigateTo } from './browser.js';
import { MUTATION_TRACKER_SCRIPT, installMutationTracker, getMutations, resetMutations } from './mutationTracker.js';
import { extractStaticNodes } from './staticAnalysis.js';
import { annotateScreenshot } from './annotate.js';
import { computeTriggerDelta, extractNewRegions } from './compare.js';
import { sleep } from './utils.js';

// ── Config ─────────────────────────────────────────────────────────────────

const TRIGGER_SETTLE_MS = 2_000;  // wait after action for DOM to settle
const NAV_TIMEOUT_MS    = 4_000;  // max time to wait for post-click navigation

/**
 * Run a single trigger candidate against the page and return a structured result.
 *
 * @param {import('playwright').Browser} browser
 * @param {string}  url         - Original URL (page is re-navigated fresh)
 * @param {object}  candidate   - Trigger candidate object from triggerDiscovery
 * @param {string}  outDir      - Absolute path to job output directory
 * @returns {Promise<object>}   - Trigger result (fully serializable)
 */
export async function runTrigger(browser, url, candidate, outDir) {
  const { triggerId, triggerType, selectorHint, bbox, text } = candidate;
  const resultsDir = path.join(outDir, 'trigger-results');

  let context;
  try {
    // ── 1. Fresh context + mutation observer ─────────────────────────────────
    context = await createFreshContext(browser);
    // Install mutation tracker BEFORE page navigation (init script)
    // plus an explicit post-navigation injection for system-Chrome reliability
    await context.addInitScript(MUTATION_TRACKER_SCRIPT);

    const page = await context.newPage();
    await navigateTo(page, url);

    // Guarantee the tracker is active regardless of addInitScript execution
    await installMutationTracker(page);

    // Discard any mutations that occurred during the initial page load
    await resetMutations(page);

    // ── 2. Before-state capture ───────────────────────────────────────────────
    const beforePath = path.join(resultsDir, `${triggerId}-before.png`);
    await page.screenshot({ path: beforePath, fullPage: true });
    const beforeNodes = await extractStaticNodes(page);

    // ── 3. Perform trigger action ─────────────────────────────────────────────
    // Use document-absolute centre coordinates stored in the candidate bbox
    const cx = bbox.x + Math.round(bbox.width  / 2);
    const cy = bbox.y + Math.round(bbox.height / 2);

    let actionError = null;
    try {
      if (triggerType === 'hover') {
        await page.mouse.move(cx, cy, { steps: 5 });
        await sleep(300); // hover dwell
      } else {
        await page.mouse.click(cx, cy, { delay: 60 });
      }

      // Allow time for DOM mutations / micro-animations
      await sleep(TRIGGER_SETTLE_MS);

      // If a click caused navigation, wait for the new page to load
      await page
        .waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS })
        .catch(() => { /* no navigation is fine */ });
    } catch (err) {
      actionError = err.message;
    }

    // ── 4. After-state capture ────────────────────────────────────────────────
    const afterPath = path.join(resultsDir, `${triggerId}-after.png`);
    await page.screenshot({ path: afterPath, fullPage: true });
    const afterNodes = await extractStaticNodes(page);

    // ── 5. Collect mutations ──────────────────────────────────────────────────
    // Navigation may have cleared the window; re-install tracker before reading
    await installMutationTracker(page).catch(() => {});
    const mutations = await getMutations(page).catch(() => []);

    // ── 6. Delta analysis (delta-only labeling) ───────────────────────────────
    const rawDelta      = computeTriggerDelta(beforeNodes, afterNodes, mutations);
    const deltaLabelNodes   = rawDelta.deltaLabelNodes;
    const newNodes          = rawDelta.newNodes;
    const newlyVisibleNodes = rawDelta.newlyVisibleNodes;
    const changedNodes      = rawDelta.changedNodes;
    const newRegions        = extractNewRegions(deltaLabelNodes);

    // ── 7. Annotated screenshot of changed area ──────────────────────────────
    // Annotate only deltaLabelNodes — NOT the full afterNodes list.
    // Trigger-result annotations must show only what the trigger changed.
    const annotatedPath = path.join(resultsDir, `${triggerId}-annotated.png`);
    if (deltaLabelNodes.length > 0) {
      await annotateScreenshot(page, deltaLabelNodes.slice(0, 60), annotatedPath);
    } else {
      // Nothing changed — copy the after screenshot as the annotated one
      await fs.copyFile(afterPath, annotatedPath);
    }

    // ── 6b. Diff-debug output ─────────────────────────────────────────────────
    const debugPath = path.join(resultsDir, `${triggerId}-diff-debug.json`);
    await fs.writeFile(debugPath, JSON.stringify({
      triggerId,
      _note: 'Delta computed by computeTriggerDelta multi-tier matching. Unchanged baseline nodes excluded from annotation.',
      baselineVisibleNodeCount:  beforeNodes.length,
      afterVisibleNodeCount:     afterNodes.length,
      newNodeCount:              newNodes.length,
      newlyVisibleNodeCount:     newlyVisibleNodes.length,
      changedNodeCount:          changedNodes.length,
      unchangedNodesCount:       rawDelta.unchangedNodesCount,
      deltaLabelNodesCount:      deltaLabelNodes.length,
      newNodeIds:                newNodes.map((n) => n.nodeId),
      newlyVisibleNodeIds:       newlyVisibleNodes.map((n) => n.nodeId),
      changedNodeIds:            changedNodes.map((n) => n.nodeId),
      finalLabeledDeltaNodeIds:  deltaLabelNodes.map((n) => n.nodeId),
      ignoredUnchangedNodeCount: rawDelta.unchangedNodesCount,
    }, null, 2));

    await context.close();

    // ── 8. Build result object ────────────────────────────────────────────────
    const relBase = path.join('outputs', path.basename(outDir), 'trigger-results');
    return {
      triggerId,
      action:               triggerType,
      status:               actionError ? 'failed' : 'success',
      beforeScreenshot:     toUnix(path.join(relBase, `${triggerId}-before.png`)),
      afterScreenshot:      toUnix(path.join(relBase, `${triggerId}-after.png`)),
      annotatedScreenshot:  toUnix(path.join(relBase, `${triggerId}-annotated.png`)),
      diffDebug:            toUnix(path.join(relBase, `${triggerId}-diff-debug.json`)),
      mutationCount:        mutations.length,
      mutations:            mutations.slice(0, 100),
      newNodes:             newNodes.slice(0, 50),
      newlyVisibleNodes:    newlyVisibleNodes.slice(0, 50),
      changedNodes:         changedNodes.slice(0, 50),
      deltaLabelNodes:      deltaLabelNodes.slice(0, 50),
      unchangedNodesCount:  rawDelta.unchangedNodesCount,
      deltaLabelNodesCount: deltaLabelNodes.length,
      newRegions,
      summary:              buildSummary(candidate, deltaLabelNodes, mutations, actionError),
      ...(actionError ? { error: actionError } : {}),
    };

  } catch (err) {
    if (context) await context.close().catch(() => {});

    return {
      triggerId,
      action:               candidate.triggerType,
      status:               'failed',
      beforeScreenshot:     null,
      afterScreenshot:      null,
      annotatedScreenshot:  null,
      mutationCount:        0,
      mutations:            [],
      newNodes:             [],
      newlyVisibleNodes:    [],
      changedNodes:         [],
      deltaLabelNodes:      [],
      unchangedNodesCount:  0,
      deltaLabelNodesCount: 0,
      newRegions:           [],
      summary:              `Exception: ${err.message}`,
      error:                err.message,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function toUnix(p) {
  return p.replace(/\\/g, '/');
}

function buildSummary(candidate, newNodes, mutations, error) {
  if (error) return `Action failed: ${error}`;
  if (newNodes.length === 0 && mutations.length === 0) {
    return 'No visible DOM changes detected after trigger.';
  }
  const parts = [];
  if (newNodes.length)   parts.push(`${newNodes.length} new node(s)`);
  if (mutations.length)  parts.push(`${mutations.length} mutation(s)`);
  return `Detected ${parts.join(' and ')}.`;
}
