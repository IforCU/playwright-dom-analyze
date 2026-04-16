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
import { classifyAuthNavigation, collectNavPageMeta }               from './authNavigationClassifier.js';

// ── Config (env-configurable) ───────────────────────────────────────────────
// Maximum total time (ms) to wait for DOM mutations to settle after a trigger.
const TRIGGER_SETTLE_MAX_MS = parseInt(process.env.TRIGGER_SETTLE_MAX_MS || '5000', 10);
// Mutations must be quiet for this many ms before we consider the render done.
const TRIGGER_QUIET_MS      = parseInt(process.env.TRIGGER_QUIET_MS      || '600',  10);
// Initial wait (ms) after the action before polling starts
// (lets the browser start the first mutations before we measure).
const TRIGGER_INITIAL_MS    = parseInt(process.env.TRIGGER_INITIAL_MS    || '200',  10);
// Network-idle fallback timeout (ms) after mutations settle.
const TRIGGER_NETWORK_MS    = parseInt(process.env.TRIGGER_NETWORK_MS    || '2500', 10);

// Viewport width used to detect full-width layout wrappers in newNodes.
const VIEWPORT_WIDTH = 1920;

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
    // Auth-navigation classification: when enabled, a brief page-load wait is
    // added inside the navigation fast-exit path so we can collect title, text,
    // and form signals before closing the context.
    authDetectionEnabled            = true,
    authScoreThreshold              = 5,
    authMaybeThreshold              = 3,
  } = opts;

  // Derive rootHost from the page URL. requestUrl has already been validated
  // as being on rootHost before it reaches here, so this is always accurate.
  const rootHost = new URL(url).hostname;

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
        // Brief pause lets CSS :hover transitions begin before we start polling.
        await sleep(300);
      } else {
        await page.mouse.click(cx, cy, { delay: 60 });
      }
      // Wait until DOM mutations triggered by the action have settled.
      // This replaces the old fixed sleep — the page signals us when it's done.
      await waitForSettledMutations(page);
      // Secondary signal: wait for any async fetch that the action may have
      // triggered (e.g. lazy-loaded panel content).  Failure is non-fatal.
      await page
        .waitForLoadState('networkidle', { timeout: TRIGGER_NETWORK_MS })
        .catch(() => {});
    } catch (err) {
      actionError = err.message;
    }

    // ── 3b. Navigation-aware fast exit ────────────────────────────────────────
    // If the trigger caused a page navigation (URL changed):
    //   • The execution context is likely destroyed — evaluate() will fail
    //   • There are no in-page newNodes to report from the original page
    //   • Any remaining settle wait would be wasted (~20 s)
    //
    // Improvement over a plain discard:
    //   1. Briefly wait for the NEW page's domcontentloaded (max 2.5 s)
    //   2. Collect title, visible text, form structure from the new page
    //   3. Run auth classification to distinguish:
    //        • normal in-scope page navigation
    //        • same-host login page
    //        • external auth provider (IdP)
    //        • true out-of-scope navigation
    //   4. Close context and return enriched result
    const pageUrlAfter = page.url();
    if (pageUrlAfter !== url) {
      const isCrossHost = new URL(pageUrlAfter).hostname !== rootHost;

      // Collect nav page metadata for richer auth classification.
      // We allow up to 2.5 s for domcontentloaded; if it times out or fails
      // we still classify using URL signals alone.
      let navMeta = { pageTitle: '', visibleText: '', forms: {} };
      if (authDetectionEnabled) {
        await page
          .waitForLoadState('domcontentloaded', { timeout: 2500 })
          .catch(() => {});
        navMeta = await collectNavPageMeta(page).catch(() => navMeta);
      }

      const navClass = classifyAuthNavigation({
        finalUrl: pageUrlAfter,
        rootHost,
        pageTitle:   navMeta.pageTitle,
        visibleText: navMeta.visibleText,
        forms:       navMeta.forms,
        isCrossHost,
        opts: { authScoreThreshold, authMaybeThreshold },
      });

      await context.close();
      return {
        triggerId,
        action:               triggerType,
        status:               navClass.navigationStatus,
        screenshotMode,
        beforeScreenshot:     null,
        afterScreenshot:      null,
        annotatedScreenshot:  null,
        mutationCount:        0,
        mutations:            [],
        newNodes:             [],
        backgroundNoiseCount: 0,
        newRegions:           [],
        navigationDetected:   true,
        navigatedToUrl:       pageUrlAfter,
        navigatedToHost:      navClass.navigatedToHost,
        navigatedToPath:      navClass.navigatedToPath,
        authDetected:         navClass.authDetected,
        requiresAuth:         navClass.requiresAuth,
        authScore:            navClass.authScore,
        authConfidence:       navClass.authConfidence,
        authSignals:          navClass.authSignals,
        navigationReason:     navClass.navigationReason,
        classificationSource: navClass.classificationSource,
        summary:              navClass.navigationReason,
      };
    }

    // ── 4. After-state DOM snapshot ───────────────────────────────────────────
    // Guard against a late-detected navigation: page.url() (checked above) can
    // still return the original URL in the brief window between the navigation
    // being initiated and the URL being updated.  If extractStaticNodes() then
    // runs while the execution context is being torn down, it throws
    // "Execution context was destroyed".  Catch that and re-route to the same
    // navigation-result path used above.
    let afterNodes;
    try {
      ({ nodes: afterNodes } = await extractStaticNodes(page));
    } catch (extractErr) {
      const lateUrl = page.url();
      const isLateNav =
        lateUrl !== url ||
        extractErr.message.includes('Execution context was destroyed') ||
        extractErr.message.includes('context or browser has been closed');
      if (!isLateNav) throw extractErr;

      // Re-use the same nav-classification path
      const navTarget  = lateUrl !== url ? lateUrl : url;
      const isCrossHost = new URL(navTarget).hostname !== rootHost;
      let navMeta = { pageTitle: '', visibleText: '', forms: {} };
      if (authDetectionEnabled) {
        await page.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
        navMeta = await collectNavPageMeta(page).catch(() => navMeta);
      }
      const navClass = classifyAuthNavigation({
        finalUrl:    navTarget,
        rootHost,
        pageTitle:   navMeta.pageTitle,
        visibleText: navMeta.visibleText,
        forms:       navMeta.forms,
        isCrossHost,
        opts: { authScoreThreshold, authMaybeThreshold },
      });
      await context.close();
      return {
        triggerId,
        action:               triggerType,
        status:               navClass.navigationStatus,
        screenshotMode,
        beforeScreenshot:     null,
        afterScreenshot:      null,
        annotatedScreenshot:  null,
        mutationCount:        0,
        mutations:            [],
        newNodes:             [],
        backgroundNoiseCount: 0,
        newRegions:           [],
        navigationDetected:   true,
        navigatedToUrl:       navTarget,
        navigatedToHost:      navClass.navigatedToHost,
        navigatedToPath:      navClass.navigatedToPath,
        authDetected:         navClass.authDetected,
        requiresAuth:         navClass.requiresAuth,
        authScore:            navClass.authScore,
        authConfidence:       navClass.authConfidence,
        authSignals:          navClass.authSignals,
        navigationReason:     navClass.navigationReason,
        classificationSource: navClass.classificationSource,
        summary:              `Late-detected navigation: ${navClass.navigationReason}`,
      };
    }

    // ── 5. Collect mutations ──────────────────────────────────────────────────
    await installMutationTracker(page).catch(() => {});
    const mutations = await getMutations(page).catch(() => []);

    // ── 6. Compare before / after ─────────────────────────────────────────────
    const { newNodes: rawNewNodes } = compareNodeSets(beforeNodes, afterNodes);

    // ── Noise filters ──────────────────────────────────────────────────────────
    //
    // 1. Full-width layout wrappers: nodes that span ≥90 % of the viewport width
    //    and start at x≈0, y≈0 appear as "new" only because they were
    //    re-measured at a different height after the trigger (the root content
    //    div grew to accommodate an injected panel).  They carry no UI signal.
    //
    // 2. Auto-dynamic regions: nodes that overlap known background-cycling areas
    //    (e.g. carousel slides, news tickers) are background noise unrelated to
    //    the trigger.  Removed when autoDynamicRegions were detected earlier.
    const newNodes = rawNewNodes
      .filter((n) => !(n.bbox.x <= 4 && n.bbox.y <= 4 && n.bbox.width >= VIEWPORT_WIDTH * 0.9))
      .filter(
        autoDynamicRegions.length
          ? (n) => !isInAutoDynamicRegion(n.bbox, autoDynamicRegions, autoDynamicOverlapThreshold)
          : () => true,
      );
    const backgroundNoiseCount = rawNewNodes.length - newNodes.length;
    const newRegions   = extractNewRegions(newNodes);

    // ── 7. Screenshots (mode-dependent) ──────────────────────────────────────    // Wait for visual rendering to be fully committed before capturing.
    // DOM mutations settling (step 3) guarantees the DOM tree is correct but
    // the browser may still be:
    //   • running CSS transitions/animations (e.g. dropdown slide-in, fade-in)
    //   • calculating layout / painting the updated pixels
    // We wait for the “loudest” in-flight transition to end (max 800 ms) then
    // flush layout+paint with a double requestAnimationFrame before injecting
    // the red-box overlay and taking the final screenshot.
    await _waitForVisualRender(page);
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
      // Viewport-only: cheap, no region clipping.
      // Annotated uses the same viewport shot but with red-box overlay injected.
      await page.screenshot({ path: afterPath, fullPage: false });
      if (newNodes.length > 0) {
        await annotateScreenshot(page, newNodes.slice(0, 60), annotatedPath, { fullPage: false });
      } else {
        await fs.copyFile(afterPath, annotatedPath);
      }
      break;
    }

    case 'element':
    case 'changedRegion':
    default: {
      // Viewport after-shot (fast).
      // Annotated: inject red-box overlay then clip to the union bbox of changed
      // nodes so the result shows exactly the changed region with boxes visible.
      await page.screenshot({ path: afterPath, fullPage: false });
      if (newNodes.length > 0) {
        const clip = _computeUnionBbox(newNodes, 24);
        if (clip) {
          // bbox coords from extractStaticNodes are document-absolute
          // (rect.x + scrollX, rect.y + scrollY).
          //
          // For a viewport screenshot (fullPage:false) Playwright interprets the
          // clip in *viewport* coordinates, so the clip must fit within
          // [0, viewportWidth] × [0, viewportHeight].
          //
          // Trigger pages always start at scroll(0,0), so document-absolute and
          // viewport-relative are identical — UNLESS a changed node sits below
          // the viewport fold (e.g. a carousel at y=1960 on a 1080 px viewport).
          // In that case we switch to fullPage:true so the clip is resolved
          // against the full document instead.
          const vp = page.viewportSize() ?? { width: 1920, height: 1080 };
          const clipFitsViewport =
            clip.x >= 0 &&
            clip.y >= 0 &&
            clip.x + clip.width  <= vp.width &&
            clip.y + clip.height <= vp.height;
          const screenshotOpts = clipFitsViewport
            ? { clip }
            : { fullPage: true, clip };
          await annotateScreenshot(page, newNodes.slice(0, 60), annotatedPath, screenshotOpts);
        } else {
          await annotateScreenshot(page, newNodes.slice(0, 60), annotatedPath, { fullPage: false });
        }
      } else {
        await fs.copyFile(afterPath, annotatedPath);
      }
      break;
    }
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

/**
 * Wait until the browser has fully painted the page after a trigger action.
 *
 * Two-phase:
 *   Phase A — CSS transition drain
 *     Reads the longest `transition-duration` currently active on any element
 *     that gained a transition during the action (identified by a non-zero
 *     computed transition-duration).  Waits that long, capped at 800 ms.
 *     This covers dropdown slide-ins, fade-ins, and similar CSS animations that
 *     start AFTER the DOM mutation settles.
 *
 *   Phase B — paint flush
 *     Schedules two consecutive requestAnimationFrame callbacks.  The browser
 *     guarantees it has finished layout + compositing by the time the second
 *     rAF fires, so any pending repaints from the DOM change are committed.
 *
 * Falls back gracefully if page.evaluate rejects (context torn down).
 */
async function _waitForVisualRender(page) {
  // Phase A: find the longest ongoing CSS transition and wait it out.
  const maxTransitionMs = await page.evaluate(() => {
    let maxMs = 0;
    try {
      for (const el of document.querySelectorAll('*')) {
        const s = window.getComputedStyle(el);
        // transition-duration can be a comma-separated list ("0.3s, 0.1s")
        for (const token of (s.transitionDuration || '').split(',')) {
          const t = token.trim();
          const ms = t.endsWith('ms')
            ? parseFloat(t)
            : t.endsWith('s') ? parseFloat(t) * 1000 : 0;
          if (ms > maxMs) maxMs = ms;
        }
      }
    } catch (_) {}
    return Math.min(maxMs, 800); // cap at 800 ms
  }).catch(() => 0);

  if (maxTransitionMs > 0) {
    await sleep(maxTransitionMs);
  }

  // Phase B: double-rAF paint flush — ensures layout + paint are committed.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  ).catch(() => {});
}

/**
 * Wait until DOM mutations triggered by an action have settled.
 *
 * Strategy:
 *   1. Wait TRIGGER_INITIAL_MS first (allows the first mutations to arrive
 *      before we start measuring — without this, we'd see count=0 immediately
 *      and declare the page settled before anything changed).
 *   2. Poll the in-page MutationObserver buffer every 150 ms.
 *   3. Once the count has stayed the same for TRIGGER_QUIET_MS, the DOM has
 *      settled and we return early.
 *   4. Give up after TRIGGER_SETTLE_MAX_MS total (TRIGGER_INITIAL_MS included).
 *
 * Falls back gracefully when the tracker is not installed or the context
 * is being torn down (page.evaluate rejects → bail immediately).
 *
 * This replaces the old fixed sleep(2000) approach: a heavy page that fires
 * 80 mutations over 3 s will now be waited out; a lightweight hover that
 * finishes in 400 ms will exit after ~600 ms quiet instead of wasting 2 s.
 */
async function waitForSettledMutations(page) {
  const POLL_MS = 150;
  await sleep(TRIGGER_INITIAL_MS);

  const deadline  = Date.now() + TRIGGER_SETTLE_MAX_MS - TRIGGER_INITIAL_MS;
  let lastCount   = -1;
  let quietSince  = Date.now();

  while (Date.now() < deadline) {
    const count = await page.evaluate(
      () => typeof window.__getMutations__ === 'function'
        ? window.__getMutations__().length
        : -1,
    ).catch(() => -1);

    if (count < 0) break; // context destroyed or tracker missing — bail

    if (count !== lastCount) {
      lastCount  = count;
      quietSince = Date.now(); // reset the quiet clock
    } else if (Date.now() - quietSince >= TRIGGER_QUIET_MS) {
      break; // settled — no new mutations for TRIGGER_QUIET_MS ms
    }

    await sleep(POLL_MS);
  }
}

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
