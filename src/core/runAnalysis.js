/**
 * core/runAnalysis.js
 *
 * Analyze Worker orchestrator — Phase 1 → Graph update → Phase 3.
 *
 * ROLE IN THE FUTURE SPRING + KAFKA ARCHITECTURE
 * ───────────────────────────────────────────────
 * This module simulates the responsibility of one Analyze Worker node:
 *   1. Receive one URL to analyze (here: via HTTP API / direct call)
 *   2. Check graph — skip if already analyzed (no revisit)
 *   3. Run Phase 1: open page, extract DOM, execute triggers
 *   4. Update graph: create/reuse node for analyzed page
 *   5. Run Phase 3: extract next candidate URLs from Phase 1 output
 *   6. Classify candidates against graph state
 *   7. Pre-flight only truly new candidates
 *   8. Update graph: create/reuse nodes and edges for candidates
 *   9. Mark analyzed page node as done
 *  10. Write artifacts: next-queue.json, graph-snapshot.json, final-report.json
 *
 * WHAT THIS WORKER DOES NOT DO
 * ────────────────────────────
 * - Does NOT recursively analyze any next pages
 * - Does NOT consume the queue it produces
 * - Does NOT use Kafka, Spring, or a database
 * - Phase 2 (VLM analysis) is intentionally excluded
 *
 * Pipeline:
 *   Graph check  → skip if page already analyzed
 *   Phase 1      → baseline DOM + trigger exploration
 *   Graph update → upsert analyzed page node
 *   Phase 3      → URL extraction → graph-aware candidate classification
 *                  → pre-flight new candidates → upsert candidate nodes+edges
 *   Final        → mark node analyzed, persist graph, write artifacts
 */

import fs   from 'fs/promises';
import path from 'path';

// ── Browser ────────────────────────────────────────────────────────────────────
import { launchBrowser, createFreshContext, navigateTo } from './browser.js';

// ── Phase 1 modules ────────────────────────────────────────────────────────────
import { MUTATION_TRACKER_SCRIPT,
         installMutationTracker,
         resetMutations }                                from './phase1/mutationTracker.js';
import { stabilizePage }                                 from './phase1/pageStabilizer.js';
import { checkRenderReadiness,
         inspectFrames }                                 from './phase1/renderReadinessChecker.js';
import { extractStaticNodes,
         getPageMeta,
         getPageLinks }                                  from './phase1/staticAnalysis.js';
import { findTriggerCandidates }                         from './phase1/triggerDiscovery.js';
import { runTriggersParallel }                           from './phase1/parallelTriggerRunner.js';
import { detectAutoDynamicRegions }                      from './phase1/autoDynamicDetector.js';

// ── Shared core utilities ──────────────────────────────────────────────────────
import { annotateScreenshot }                            from './annotate.js';
import { classifyNodes, buildLegend }                    from './functionalClassifier.js';
import { applyLabelFilter }                              from './labelFilter.js';
import { jobOutputDir, toRelPath }                       from './utils.js';

// ── Phase 3 modules ────────────────────────────────────────────────────────────
import { extractUrls }                                   from './phase3/extractUrls.js';
import { filterUrls }                                    from './phase3/filterUrls.js';
import { normalizeUrl }                                  from './phase3/normalizeUrl.js';
import { checkReachability }                             from './phase3/reachabilityChecker.js';
import { loadAuthRules,
         matchAuthRule,
         retryWithStorageState }                         from './phase3/authRuleEngine.js';
import { buildQueue }                                    from './phase3/buildQueue.js';

// ── Graph modules ──────────────────────────────────────────────────────────────
import { computePageIdentity }                           from './graph/graphModel.js';
import { saveSnapshot }                               from './graph/graphStore.js';
import { createGraph }                                from './graph/graphStore.js';
import { findNode, upsertNode, upsertEdge,
         markNodeAnalyzed,
         updateNodeReachability }                        from './graph/graphUpdater.js';

// ── Playwright request API ─────────────────────────────────────────────────────
import { request as playwrightRequest }                  from 'playwright';

// ── Runtime configuration ──────────────────────────────────────────────────────

const CONFIG = {
  MAX_TRIGGERS:                    parseInt(process.env.MAX_TRIGGERS        || '10',  10),
  ANNOTATION_LIMIT:                parseInt(process.env.ANNOTATION_LIMIT    || '400', 10),
  MAX_URLS:                        parseInt(process.env.MAX_URLS            || '50',  10),
  MAX_REACHABILITY_CHECKS:         parseInt(process.env.MAX_CHECKS          || '20',  10),
  MAX_PARALLEL_TRIGGER_WORKERS:    parseInt(process.env.MAX_PARALLEL_WORKERS || '4',   10),
  // screenshotMode for trigger exploration: fullPage | viewport | changedRegion | element
  // changedRegion (default) skips before-screenshot and clips annotated to changed nodes.
  TRIGGER_SCREENSHOT_MODE:         process.env.TRIGGER_SCREENSHOT_MODE      || 'changedRegion',
  // Passive auto-dynamic region detection:
  // Observe the page silently for AUTO_DYNAMIC_OBSERVATION_MS ms before trigger
  // candidate exploration.  Regions that change without user interaction (carousels,
  // banners, rolling ads) are excluded from trigger candidates and overlap-filtered
  // from trigger results.
  DETECT_AUTO_DYNAMIC:             process.env.DETECT_AUTO_DYNAMIC             !== 'false',
  AUTO_DYNAMIC_OBSERVATION_MS:     parseInt(process.env.AUTO_DYNAMIC_OBSERVATION_MS  || '3000', 10),
  AUTO_DYNAMIC_OVERLAP_THRESHOLD:  parseFloat(process.env.AUTO_DYNAMIC_OVERLAP_THRESHOLD || '0.3'),
  // Optional CSS stabilisation during trigger execution.
  // Pauses CSS animations so background transitions do not add noise mutations.
  // Complements classification-based exclusion but does not replace it.
  FREEZE_CSS_DURING_TRIGGERS:      process.env.FREEZE_CSS_TRIGGERS === 'true',
  // Generic auth-gateway detection for trigger-driven navigations.
  // When a trigger click navigates away from the page, the classifier inspects
  // the destination URL, title, visible text, and form structure to determine
  // whether it looks like a login / auth-provider page.
  AUTH_DETECTION_ENABLED:          process.env.AUTH_DETECTION_ENABLED !== 'false',
  AUTH_SCORE_THRESHOLD:            parseInt(process.env.AUTH_SCORE_THRESHOLD || '5', 10),
  AUTH_MAYBE_THRESHOLD:            parseInt(process.env.AUTH_MAYBE_THRESHOLD || '3', 10),
  // Initial page stabilization — dismiss overlays / pause media before Phase 1.
  // Runs between page load and baseline screenshot/extraction.
  STABILIZE_PAGE:                  process.env.STABILIZE_PAGE !== 'false',
  STABILIZE_COVERAGE_THRESHOLD:    parseFloat(process.env.STABILIZE_COVERAGE_THRESHOLD || '0.30'),
  STABILIZE_MIN_ZINDEX:            parseInt(process.env.STABILIZE_MIN_ZINDEX || '50', 10),
  NODE_FILTER: {
    minTextLength:    parseInt(process.env.NODE_MIN_TEXT   || '3',   10),
    minArea:          parseInt(process.env.NODE_MIN_AREA   || '200', 10),
    qualityThreshold: parseInt(process.env.NODE_MIN_SCORE  || '3',   10),
    debugDrop:        process.env.DEBUG_NODES === 'true',
  },
  // ── Label filter config ────────────────────────────────────────────────────
  // Controls the two-layer annotation model: raw extraction vs. labeled output.
  // See src/core/labelFilter.js for full description of each option.
  LABEL_FILTER: {
    // 'dense' | 'balanced' | 'minimal'
    labelMode:                               process.env.LABEL_MODE              || 'balanced',
    // Explicit score override (null = derived from labelMode)
    labelMinScore:                           process.env.LABEL_MIN_SCORE != null && process.env.LABEL_MIN_SCORE !== ''
                                               ? parseInt(process.env.LABEL_MIN_SCORE, 10) : null,
    // Suppress lower-value nodes whose bbox is mostly inside a higher-scoring node
    suppressChildLabelsWhenParentIsSufficient: process.env.SUPPRESS_CHILD_LABELS !== 'false',
    // Cap repeated card/link/media grids to a small number of representatives
    preferGroupLabelingForRepeatedItems:       process.env.PREFER_GROUP_LABELS    !== 'false',
    // Hard cap on total annotation labels per page
    maxLabelsPerViewport:                     parseInt(process.env.MAX_LABELS_VIEWPORT || '200', 10),
    // Write per-node filtering decisions to label-filter-debug.json
    debugFilter:                              process.env.DEBUG_LABEL_FILTER      === 'true',
  },
  // ── Async worker counts ────────────────────────────────────────────────────
  // Per-request overrides are accepted via runAnalysis params.
  // These CONFIG values are the env-backed fallback defaults.
  MAX_PARALLEL_PREFLIGHT_CHECKS: parseInt(process.env.MAX_PARALLEL_PREFLIGHT_CHECKS || '8', 10),
};

// ── Entry point ────────────────────────────────────────────────────────────────

/**
 * Analyze one page — the core Analyze Worker behavior.
 *
 * @param {{ jobId: string, originalUrl: string, requestUrl: string }} params
 *   originalUrl — defines the root exploration scope (rootHost)
 *   requestUrl  — the specific page being analyzed in this execution
 * @returns {Promise<{ outputPath: string, currentPageStatus: string, summary: object }>}
 */
export async function runAnalysis({
  jobId,
  originalUrl,
  requestUrl,
  // ── Crawl mode overrides (all optional — safe to omit for single-page use) ──
  // sharedBrowser:    reuse an existing Browser instance; skip launchBrowser/close
  // sharedGraph:      reuse an existing in-memory graph object; a new empty
  //                   graph is created per request when this is not provided
  // pageOutDir:       override output directory (default: jobOutputDir(jobId))
  // storageStatePath: Playwright storageState file for authenticated sessions
  sharedBrowser    = null,
  sharedGraph      = null,
  pageOutDir       = null,
  storageStatePath = null,
  // ── Async worker count overrides (null → fall back to CONFIG / env defaults) ─
  // maxParallelTriggers:       concurrent trigger workers for this page
  // maxParallelPreflightChecks: concurrent preflight HTTP checks for this page
  maxParallelTriggers       = null,
  maxParallelPreflightChecks = null,
}) {
  // Resolve effective worker counts: request-level override > env default
  const effectiveMaxTriggerWorkers  = maxParallelTriggers       ?? CONFIG.MAX_PARALLEL_TRIGGER_WORKERS;
  const effectiveMaxPreflightChecks = maxParallelPreflightChecks ?? CONFIG.MAX_PARALLEL_PREFLIGHT_CHECKS;
  const outDir        = pageOutDir ?? jobOutputDir(jobId);
  const trigResultDir = path.join(outDir, 'trigger-results');
  const startedAt     = new Date().toISOString();

  await fs.mkdir(outDir,        { recursive: true });
  await fs.mkdir(trigResultDir, { recursive: true });

  // ── 0. Derive scope from originalUrl ─────────────────────────────────────────
  // rootHost is the only allowed hostname for this entire exploration lineage.
  const rootHost    = new URL(originalUrl).hostname;
  const requestHost = new URL(requestUrl).hostname;

  console.log(`[runAnalysis] job=${jobId}  rootHost=${rootHost}  requestUrl=${requestUrl}`);

  // ── 1. SCOPE VALIDATION — requestUrl must be on rootHost ──────────────────────
  // If requestHost does not exactly match rootHost, stop immediately without
  // launching a browser or updating the graph.
  if (requestHost !== rootHost) {
    const stopReason = `request host ${requestHost} does not match root host ${rootHost}`;
    console.log(`[scope]  STOP — ${stopReason}`);

    const stoppedReport = {
      jobId,
      startedAt,
      finishedAt:        new Date().toISOString(),
      currentPageStatus: 'stopped_out_of_scope',
      input:             { originalUrl, requestUrl },
      scope: {
        rootHost,
        requestHost,
        requestAllowed:       false,
        finalRenderedHost:    null,
        finalRenderedAllowed: null,
        stopReason,
      },
      phase1:           null,
      phase3:           null,
      graphUpdate:      null,
      candidateSummary: null,
      queueSummary:     null,
    };

    await writeJson(path.join(outDir, 'final-report.json'), stoppedReport);

    return {
      outputPath:        outDir,
      currentPageStatus: 'stopped_out_of_scope',
      originalUrl,
      requestUrl,
      rootHost,
      requestHost,
      reason:            stopReason,
      summary:           { phase1: null, phase3: null, graphUpdate: null },
    };
  }

  // ── 2. Initialize per-request graph ──────────────────────────────────────────
  // Graph is always scoped to the current request; there is no cross-request
  // persistence.  In crawl mode the caller passes a sharedGraph that lives for
  // the duration of the entire crawl run.
  const graph = sharedGraph ?? createGraph();
  console.log(`[graph]  ${sharedGraph ? 'shared' : 'new'}  nodes=${Object.keys(graph.nodes).length}  edges=${Object.keys(graph.edges).length}`);

  // ── 3. Compute input page identity ───────────────────────────────────────────
  const inputIdentity = computePageIdentity(requestUrl);
  if (!inputIdentity) throw new Error(`Cannot compute page identity for: ${requestUrl}`);
  console.log(`[graph]  input dedupKey=${inputIdentity.dedupKey}`);

  // ── 4. REVISIT CHECK — skip if already analyzed ───────────────────────────────
  const existingInputNode = findNode(graph, inputIdentity.dedupKey);
  if (existingInputNode?.analyzed) {
    console.log(`[graph]  SKIP — page already analyzed at ${existingInputNode.analyzedAt}`);

    const skipReason = `page ${inputIdentity.dedupKey} was already fully analyzed on ${existingInputNode.analyzedAt}`;
    const skippedReport = {
      jobId,
      startedAt,
      finishedAt:        new Date().toISOString(),
      currentPageStatus: 'skipped_existing_page',
      input:             { originalUrl, requestUrl },
      scope: {
        rootHost,
        requestHost,
        requestAllowed:       true,
        finalRenderedHost:    null,
        finalRenderedAllowed: null,
        stopReason:           null,
      },
      inputPage: {
        requestUrl,
        ...inputIdentity,
        nodeId:           existingInputNode.nodeId,
        graphNodeCreated: false,
        skipReason,
      },
      phase1:           null,
      phase3:           null,
      graphUpdate:      { graphNodeCreated: false, graphNodeReused: true, graphEdgeCreatedCount: 0, graphEdgeReusedCount: 0 },
      candidateSummary: null,
      queueSummary:     null,
    };

    await writeJson(path.join(outDir, 'final-report.json'), skippedReport);
    await saveSnapshot(outDir, graph);

    return {
      outputPath:        outDir,
      currentPageStatus: 'skipped_existing_page',
      originalUrl,
      requestUrl,
      rootHost,
      requestHost,
      reason:            skipReason,
      summary: {
        phase1:      null,
        phase3:      null,
        graphUpdate: { graphNodeCreated: false, graphNodeReused: true },
      },
    };
  }

  // ── 3. Launch browser (only for new pages) ────────────────────────────────────
  // In crawl mode (sharedBrowser provided) we reuse the caller's browser
  // instance and must NOT close it when we are done.
  let browser      = sharedBrowser ?? null;
  let _ownsBrowser = !sharedBrowser;
  if (!browser) {
    browser      = await launchBrowser();
    _ownsBrowser = true;
  }
  try {

    // ════════════════════════════════════════════════════════════════════════════
    // PHASE 1  —  Static analysis + dynamic trigger exploration
    // ════════════════════════════════════════════════════════════════════════════

    console.log('[phase1] ── starting ─────────────────────────');

    const baseCtx  = await createFreshContext(browser, { storageState: storageStatePath });
    await baseCtx.addInitScript(MUTATION_TRACKER_SCRIPT);
    const basePage = await baseCtx.newPage();
    await navigateTo(basePage, requestUrl);
    await installMutationTracker(basePage);

    // ── PART1+2: Render readiness check ──────────────────────────────────────
    // Gates Phase 1 until the page has settled sufficiently.  Results are
    // stored in render-readiness.json for audit / quality tracking.
    console.log('[render-readiness] checking …');
    const readinessResult = await checkRenderReadiness(basePage);
    await writeJson(path.join(outDir, 'render-readiness.json'), readinessResult);
    if (readinessResult.degradedMode) {
      console.log(`[render-readiness] DEGRADED — proceeding anyway: ${readinessResult.message}`);
    } else {
      console.log(`[render-readiness] OK — score=${readinessResult.readinessScore} signals=${readinessResult.passedSignals}/${readinessResult.totalSignals}`);
    }

    // ── 5. Initial render stabilization ──────────────────────────────────────
    // Dismiss overlays, pause media, and neutralize blocking UI before
    // baseline extraction.  Runs BEFORE screenshot, static node extraction,
    // auto-dynamic observation, and trigger candidate discovery.
    console.log('[stabilize] ── starting ────────────────────────');
    const stabResult = await stabilizePage(basePage, {
      enabled:           CONFIG.STABILIZE_PAGE,
      coverageThreshold: CONFIG.STABILIZE_COVERAGE_THRESHOLD,
      minZIndex:         CONFIG.STABILIZE_MIN_ZINDEX,
    });
    await writeJson(path.join(outDir, 'initial-stabilization.json'), stabResult);
    console.log(
      `[stabilize] ── complete — blockers=${stabResult.blockerCount}` +
      ` dismissed=${stabResult.dismissedCount}` +
      ` hidden=${stabResult.hiddenCount}` +
      ` mediaPaused=${stabResult.pausedMediaCount}` +
      ` succeeded=${stabResult.stabilizationSucceeded}`
    );

    // ── PART1+2: Frame inspection ─────────────────────────────────────────────
    // Inspects all iframes — same-origin frames are DOM-analysed; cross-origin
    // frames are described by role, size and viewport coverage only.
    // Results stored in frame-summary.json for audit / VLM reference.
    console.log('[frames] inspecting frames …');
    const frameSummary = await inspectFrames(basePage);
    await writeJson(path.join(outDir, 'frame-summary.json'), frameSummary);
    console.log(`[frames] ${frameSummary.totalFrameCount} frame(s) (${frameSummary.crossOriginCount} cross-origin, ${frameSummary.sameOriginCount} same-origin)`);

    // Reset mutations accumulated during stabilization so that the auto-dynamic
    // observation window starts from a clean baseline (no stabilization noise).
    await resetMutations(basePage);

    const baselinePng = path.join(outDir, 'baseline.png');
    
    // Check page dimensions before taking fullPage screenshot to avoid Skia allocation errors
    const dimensions = await basePage.evaluate(() => {
      return {
        width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth, document.body.offsetWidth, document.documentElement.offsetWidth, document.documentElement.clientWidth),
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight, document.documentElement.clientHeight)
      };
    }).catch(() => ({ width: 1920, height: 1080 }));
    
    console.log(`[phase1]  page dimensions: ${dimensions.width}x${dimensions.height}`);
    
    // If the page is excessively tall or wide, fall back to a viewport screenshot
    // to prevent SkBitmap pixel allocation crash (e.g. w:115024 h:6234).
    if (dimensions.height > 15000 || dimensions.width > 8000) {
      console.log('[phase1]  page too large for fullPage screenshot, using viewport screenshot');
      await basePage.screenshot({ path: baselinePng, fullPage: false });
    } else {
      try {
        await basePage.screenshot({ path: baselinePng, fullPage: true });
      } catch (err) {
        console.log(`[phase1]  fullPage screenshot failed (${err.message}), retrying with viewport screenshot...`);
        await basePage.screenshot({ path: baselinePng, fullPage: false });
      }
    }
    console.log('[phase1]  baseline.png saved');

    console.log('[phase1]  extracting static nodes, metadata and links …');
    const [pageMeta, nodeResult, pageLinks] = await Promise.all([
      getPageMeta(basePage),
      extractStaticNodes(basePage, CONFIG.NODE_FILTER),
      getPageLinks(basePage),
    ]);
    const allNodes             = nodeResult.nodes;
    const droppedNodes         = nodeResult.droppedNodes;
    const visibilityMismatches = nodeResult.visibilityMismatches ?? [];

    // ── REDIRECT SCOPE CHECK — final rendered URL must remain on rootHost ──────
    // A server-side redirect may navigate the browser to a different hostname.
    // Stop exploration immediately if the final rendered URL leaves the root scope.
    const finalUrl          = pageMeta.finalUrl || requestUrl;
    const finalRenderedHost = new URL(finalUrl).hostname;
    if (finalRenderedHost !== rootHost) {
      const stopReason = `final rendered URL moved to ${finalRenderedHost}, outside root host ${rootHost}`;
      console.log(`[scope]  STOP (redirect) — ${stopReason}`);
      await baseCtx.close();

      const stoppedReport = {
        jobId,
        startedAt,
        finishedAt:        new Date().toISOString(),
        currentPageStatus: 'stopped_redirect_out_of_scope',
        input:             { originalUrl, requestUrl },
        scope: {
          rootHost,
          requestHost,
          requestAllowed:       true,
          finalRenderedHost,
          finalRenderedAllowed: false,
          stopReason,
        },
        phase1:           { page: pageMeta, screenshots: { baseline: `outputs/${path.basename(outDir)}/baseline.png` } },
        phase3:           null,
        graphUpdate:      null,
        candidateSummary: null,
        queueSummary:     null,
      };

      await writeJson(path.join(outDir, 'final-report.json'), stoppedReport);

      return {
        outputPath:        outDir,
        currentPageStatus: 'stopped_redirect_out_of_scope',
        originalUrl,
        requestUrl,
        rootHost,
        requestHost,
        reason:            stopReason,
        summary:           { phase1: null, phase3: null, graphUpdate: null },
      };
    }

    console.log(`[phase1]  ${allNodes.length} kept | ${droppedNodes.length} dropped | ${
      (pageLinks.anchors?.length ?? 0) + (pageLinks.areas?.length ?? 0) + (pageLinks.formActions?.length ?? 0)
    } raw links`);

    // ── Functional category classification ────────────────────────────────────
    // Runs in Node.js space using already-extracted node metadata.
    // Adds: functionalCategory, functionalCategoryCode, labelColor, categoryReason
    classifyNodes(allNodes);
    console.log('[phase1]  functional categories classified');

    // ── Two-layer label filtering ─────────────────────────────────────────────
    // Layer 1 (rawNodes = allNodes): full extraction for reasoning/debug
    // Layer 2 (labelEligibleNodes):  only QA-meaningful nodes receive labels
    // This keeps structural context intact while reducing screenshot noise.
    const {
      labelEligibleNodes,
      debugEntries: labelDebugEntries,
      filterStats:  labelFilterStats,
    } = applyLabelFilter(allNodes, CONFIG.LABEL_FILTER);
    console.log(
      `[phase1]  label filter: ${labelEligibleNodes.length}/${allNodes.length} eligible` +
      ` (mode=${CONFIG.LABEL_FILTER.labelMode}` +
      ` drop=${labelFilterStats.droppedTotal}` +
      ` decorative=${labelFilterStats.droppedDecorative}` +
      ` dup=${labelFilterStats.droppedDuplicate})`
    );

    const baselineAnnotatedPng = path.join(outDir, 'baseline-annotated.png');
    // Use only label-eligible nodes for annotation — keeps screenshots readable
    const annotatedNodes = selectAnnotationNodes(labelEligibleNodes, CONFIG.ANNOTATION_LIMIT);
    await annotateScreenshot(basePage, annotatedNodes, baselineAnnotatedPng);
    console.log('[phase1]  baseline-annotated.png saved');

    // Write label filter debug artifact when enabled
    if (CONFIG.LABEL_FILTER.debugFilter) {
      await writeJson(path.join(outDir, 'label-filter-debug.json'), {
        generatedAt:  new Date().toISOString(),
        description:  'Per-node label filtering decisions. Use labelScore, labelEligible, and ' +
                      'keepOrDropReason to tune LABEL_MODE / LABEL_MIN_SCORE thresholds.',
        config:       CONFIG.LABEL_FILTER,
        filterStats:  labelFilterStats,
        entries:      labelDebugEntries,
      });
      console.log('[phase1]  label-filter-debug.json saved');
    }

    // Write annotation legend so consumers know what each color/code means.
    // Legend counts are based on all raw nodes (full picture, not just labeled).
    const legend = buildLegend(allNodes);
    await writeJson(path.join(outDir, 'annotation-legend.json'), legend);
    console.log('[phase1]  annotation-legend.json saved');

    await writeJson(path.join(outDir, 'static.json'), {
      pageMetadata: pageMeta,
      pageLinks,
      nodeCount:    allNodes.length,
      droppedCount: droppedNodes.length,
      nodes:        allNodes,
    });

    if (CONFIG.NODE_FILTER.debugDrop) {
      await writeJson(path.join(outDir, 'filtered-node-debug.json'), {
        keptCount: allNodes.length, droppedCount: droppedNodes.length,
        config: CONFIG.NODE_FILTER, keptNodes: allNodes, droppedNodes,
      });
      console.log('[phase1]  filtered-node-debug.json saved');
    }

    // Write visibility-debug.json whenever there are aria-hidden mismatches.
    // A mismatch means aria-hidden="false" on an element that is not actually
    // rendered, or aria-hidden="true" on an element that is visually present.
    // These are common false-positive sources and are worth surfacing always.
    if (visibilityMismatches.length > 0) {
      await writeJson(path.join(outDir, 'visibility-debug.json'), {
        generatedAt:     new Date().toISOString(),
        totalMismatches: visibilityMismatches.length,
        description:     'Elements where aria-hidden state contradicts actual CSS rendering. ' +
                         'These are potential false-positive sources in DOM extraction.',
        mismatches:      visibilityMismatches,
      });
      console.log(`[phase1]  visibility-debug.json saved — ${visibilityMismatches.length} mismatch(es)`);
    }

    console.log('[phase1]  discovering trigger candidates …');

    // ── AUTO-DYNAMIC DETECTION: observe passive mutations before candidate scan ───
    // The observation window (default 3 s) runs on the already-open basePage.
    // No user interaction happens during this window.  The mutation tracker
    // records any DOM changes caused purely by time-driven page logic.
    // Detected regions are excluded from trigger candidates and from trigger
    // result newNodes so banner/carousel noise is suppressed throughout Phase 1.
    console.log(`[phase1]  observing for auto-dynamic regions (${CONFIG.AUTO_DYNAMIC_OBSERVATION_MS}ms) …`);
    const autoDynamicRegions = await detectAutoDynamicRegions(basePage, {
      observationMs: CONFIG.AUTO_DYNAMIC_OBSERVATION_MS,
      enabled:       CONFIG.DETECT_AUTO_DYNAMIC,
    });

    const allCandidates = await findTriggerCandidates(
      basePage, autoDynamicRegions, CONFIG.AUTO_DYNAMIC_OVERLAP_THRESHOLD);

    // Write auto-dynamic-regions.json (after findTriggerCandidates so
    // excludedTriggerCount values are fully populated).
    await writeJson(path.join(outDir, 'auto-dynamic-regions.json'), {
      detectionEnabled:  CONFIG.DETECT_AUTO_DYNAMIC,
      observationMs:     CONFIG.AUTO_DYNAMIC_OBSERVATION_MS,
      overlapThreshold:  CONFIG.AUTO_DYNAMIC_OVERLAP_THRESHOLD,
      regionCount:       autoDynamicRegions.length,
      regions:           autoDynamicRegions,
    });
    if (autoDynamicRegions.length) {
      console.log(`[phase1]  ${autoDynamicRegions.length} auto-dynamic region(s) excluded from trigger exploration`);
    }
    const candidates    = allCandidates.slice(0, CONFIG.MAX_TRIGGERS);
    console.log(`[phase1]  ${allCandidates.length} candidates | exploring top ${candidates.length}`);
    await writeJson(path.join(outDir, 'trigger-candidates.json'), allCandidates);
    await baseCtx.close();

    console.log(`[phase1]  running trigger exploration … (workers=${effectiveMaxTriggerWorkers} mode=${CONFIG.TRIGGER_SCREENSHOT_MODE})`);
    const { results: triggerResults, metrics: triggerMetrics } = await runTriggersParallel(
      browser, requestUrl, candidates, outDir, {
        maxWorkers:                      effectiveMaxTriggerWorkers,
        screenshotMode:                  CONFIG.TRIGGER_SCREENSHOT_MODE,
        fallbackToFullPageOnClipFailure: true,
        autoDynamicRegions,
        autoDynamicOverlapThreshold:     CONFIG.AUTO_DYNAMIC_OVERLAP_THRESHOLD,
        freezeCss:                       CONFIG.FREEZE_CSS_DURING_TRIGGERS,
        authDetectionEnabled:            CONFIG.AUTH_DETECTION_ENABLED,
        authScoreThreshold:              CONFIG.AUTH_SCORE_THRESHOLD,
        authMaybeThreshold:              CONFIG.AUTH_MAYBE_THRESHOLD,
        storageStatePath,
      });

    // Write per-trigger JSON artifacts (independent files — safe to parallelise)
    await Promise.all(
      triggerResults.map((r) => writeJson(path.join(trigResultDir, `${r.triggerId}.json`), r)));

    let executedCount = 0, changedCount = 0, navigatedAwayCount = 0;
    let navigatedToLoginSameHostCount = 0;
    let navigatedToLoginAuthHostCount = 0;
    let navigatedToInScopePageCount   = 0;
    let navigatedOutOfScopeCount      = 0;
    let navigatedToUnknownCount       = 0;
    let authDetectedTriggerCount      = 0;

    for (const result of triggerResults) {
      switch (result.status) {
        case 'navigated_to_login_same_host': navigatedToLoginSameHostCount++; navigatedAwayCount++; break;
        case 'navigated_to_login_auth_host': navigatedToLoginAuthHostCount++; navigatedAwayCount++; break;
        case 'navigated_to_in_scope_page':   navigatedToInScopePageCount++;   navigatedAwayCount++; break;
        case 'navigated_out_of_scope':       navigatedOutOfScopeCount++;       navigatedAwayCount++; break;
        case 'navigated_to_unknown':         navigatedToUnknownCount++;        navigatedAwayCount++; break;
        // Legacy status — kept for backward compatibility with any stored results
        case 'navigated_away':               navigatedAwayCount++; break;
        default:
          if (result.status !== 'skipped') executedCount++;
      }
      if (result.authDetected)                               authDetectedTriggerCount++;
      if (result.newNodes?.length > 0 || result.mutationCount > 0) changedCount++;
      console.log(`[phase1]   trigger ${result.triggerId} → ${result.status} (${result.durationMs ?? '?'}ms) | ${result.summary}`);
    }

    const authSensitiveTriggerCount = allCandidates.filter((c) => c.authSensitiveHint).length;

    const phase1Summary = {
      // ── Raw vs. labeled node counts ─────────────────────────────────────────
      rawNodeCount:                     allNodes.length,
      labelEligibleNodeCount:           labelEligibleNodes.length,
      finalLabeledNodeCount:            annotatedNodes.length,
      decorativeNodeDroppedCount:       labelFilterStats.droppedDecorative,
      duplicateLabelDroppedCount:       labelFilterStats.droppedDuplicate,
      lowQaValueDroppedCount:           labelFilterStats.droppedLowQaValue,
      repeatedItemDroppedCount:         labelFilterStats.droppedRepeated,
      labelMode:                        CONFIG.LABEL_FILTER.labelMode,
      // ── Legacy field (kept for backward compatibility) ────────────────────
      staticComponentCount:             allNodes.length,
      // ── Trigger exploration ───────────────────────────────────────────────
      triggerCandidateCount:            allCandidates.length,
      triggerExecutedCount:             executedCount,
      changedTriggerCount:              changedCount,
      // Navigation breakdown (replaces/extends legacy navigatedAwayCount)
      navigatedAwayCount,               // total triggers that caused any navigation
      navigatedToLoginSameHostCount,    // same-host login page discovered
      navigatedToLoginAuthHostCount,    // cross-host auth provider discovered
      navigatedToInScopePageCount,      // trigger led to normal in-scope page
      navigatedOutOfScopeCount,         // trigger led outside scope (not auth)
      navigatedToUnknownCount,          // insufficient evidence to classify
      // Auth detection summary
      authSensitiveTriggerCount,        // candidates tagged with authSensitiveHint
      authDetectedTriggerCount,         // triggers where auth was positively detected
      autoDynamicRegionCount:           autoDynamicRegions.length,
      triggerPerformance:               triggerMetrics,
      // ── Async worker counts used for this page ────────────────────────────
      maxParallelTriggers:              effectiveMaxTriggerWorkers,
      maxParallelPreflightChecks:       effectiveMaxPreflightChecks,
      // Initial render stabilization summary
      initialStabilization: {
        blockerCount:          stabResult.blockerCount,
        dismissedOverlayCount: stabResult.dismissedCount,
        hiddenOverlayCount:    stabResult.hiddenCount,
        pausedMediaCount:      stabResult.pausedMediaCount,
        stabilizationSucceeded: stabResult.stabilizationSucceeded,
        partiallyBlocked:      stabResult.partiallyBlocked,
      },
    };

    console.log('[phase1] ── complete ──────────────────────────');

    // ── 5. Upsert input page node in graph (not yet marked analyzed) ──────────

    // ── Auth-gated discovery collection (Phase 1 → Phase 3 bridge) ────────────
    // Classify trigger navigation results before Phase 3 URL extraction so we
    // can:
    //   (a) Feed navigated_to_in_scope_page URLs into Phase 3 URL candidate pool
    //   (b) Upsert auth-gated graph nodes/edges for login page discoveries
    //   (c) Exclude login-page URLs from the normal Phase 3 content pipeline
    const triggerNavCandidates = [];  // fed into Phase 3 URL pool
    const authGatedDiscoveries = [];  // preserved in report metadata

    for (const result of triggerResults) {
      if (!result.navigationDetected) continue;

      if (result.status === 'navigated_to_in_scope_page' && result.navigatedToUrl) {
        // Normal in-scope navigation: add the destination URL to Phase 3
        // as a trigger-navigation discovery so it gets pre-flighted and
        // considered for future exploration.
        const normalized = normalizeUrl(result.navigatedToUrl, finalUrl);
        if (normalized) {
          triggerNavCandidates.push({
            rawUrl:          result.navigatedToUrl,
            normalizedUrl:   normalized,
            originType:      'same-origin',
            discoverySource: 'trigger-navigation',
          });
        }
      } else if (
        result.status === 'navigated_to_login_same_host' ||
        result.status === 'navigated_to_login_auth_host'
      ) {
        // Auth-gated page discovered via trigger — record metadata but do NOT
        // feed into normal Phase 3 URL exploration.
        authGatedDiscoveries.push({
          triggerId:        result.triggerId,
          targetUrl:        result.navigatedToUrl,
          targetHost:       result.navigatedToHost,
          targetPath:       result.navigatedToPath,
          navigationStatus: result.status,
          authScore:        result.authScore,
          authConfidence:   result.authConfidence,
          authSignals:      result.authSignals,
          requiresAuth:     result.requiresAuth,
          note:             result.status === 'navigated_to_login_same_host'
            ? 'In-scope login page — not enqueued as content page'
            : 'External auth provider — not added to content graph',
        });
      }
    }

    if (authGatedDiscoveries.length) {
      console.log(`[phase1]  ${authGatedDiscoveries.length} auth-gated page(s) discovered via trigger navigation`);
    }

    // ── 5. Upsert input page node in graph (not yet marked analyzed) ──────────
    const { node: inputNode, created: inputNodeCreated } = upsertNode(graph, {
      ...inputIdentity,
      representativeUrl: finalUrl,
      jobId,
    });
    console.log(`[graph]  input node ${inputNodeCreated ? 'created' : 'reused'}  nodeId=${inputNode.nodeId}`);

    // ════════════════════════════════════════════════════════════════════════════
    // PHASE 3  —  URL discovery → graph-aware classification → pre-flight
    //
    // Phase 2 (VLM semantic analysis) is intentionally excluded here.
    // Insertion point: between Phase 1 and this section.
    // ════════════════════════════════════════════════════════════════════════════

    console.log('[phase3] ── starting ─────────────────────────');

    // ── Step 1: URL extraction ─────────────────────────────────────────────────
    console.log('[phase3]  extracting URL candidates …');
    const rawCandidates = extractUrls({ pageLinks, triggerResults, baseUrl: finalUrl });

    // Add URLs discovered via trigger-driven in-scope navigation.
    // These are pages the trigger found by following a navigation link (not by
    // revealing hidden DOM nodes).  They are valid content candidates but are
    // excluded from normal static-link extraction because extractUrls() only
    // processes newNodes from successful triggers, not navigated_to_in_scope_page
    // results.
    rawCandidates.push(...triggerNavCandidates);

    console.log(`[phase3]  ${rawCandidates.length} raw candidates (${triggerNavCandidates.length} from trigger navigation)`);

    // ── Step 2: Hostname + path-based filtering & dedup ────────────────────────
    console.log('[phase3]  filtering URLs (exact hostname, path dedup) …');
    const filtered = filterUrls(rawCandidates, {
      baseUrl:                  finalUrl,
      maxDiscoveredUrlsPerPage: CONFIG.MAX_URLS,
    });
    console.log(`[phase3]  ${filtered.length} after filter`);

    // ── Step 3: Graph-aware classification ────────────────────────────────────
    // Determine which candidates are truly new vs. already known/analyzed.
    // Only truly new candidates receive a live pre-flight check.
    console.log('[phase3]  classifying against graph …');
    const classifiedCandidates = [];

    for (const candidate of filtered.slice(0, CONFIG.MAX_REACHABILITY_CHECKS)) {
      const identity = computePageIdentity(candidate.normalizedUrl);
      if (!identity) continue;

      let decision, skipReason, enqueueReason, needsPreflight;

      if (identity.dedupKey === inputIdentity.dedupKey) {
        // Same path as currently analyzed page
        decision       = 'skip_duplicate_path';
        skipReason     = `path ${identity.normalizedPath} is the same as the currently analyzed page`;
        needsPreflight = false;
      } else {
        const existingNode = findNode(graph, identity.dedupKey);
        if (existingNode?.analyzed) {
          decision       = 'skip_already_analyzed';
          skipReason     = `path ${identity.normalizedPath} was already fully analyzed on ${existingNode.analyzedAt}`;
          needsPreflight = false;
        } else if (existingNode) {
          decision       = 'skip_existing_known_page';
          skipReason     = `path ${identity.normalizedPath} is already known in the graph (not yet analyzed)`;
          needsPreflight = false;
        } else {
          decision       = null;  // determined by pre-flight
          skipReason     = null;
          needsPreflight = true;
        }
      }

      classifiedCandidates.push({
        ...candidate,
        hostname:       identity.hostname,
        normalizedPath: identity.normalizedPath,
        dedupKey:       identity.dedupKey,
        existingNode:   findNode(graph, identity.dedupKey),
        decision,
        skipReason,
        enqueueReason,
        needsPreflight,
        preflightResult: null,
        targetNode:      findNode(graph, identity.dedupKey),
      });
    }

    const newCount = classifiedCandidates.filter((c) => c.needsPreflight).length;
    const skipCount = classifiedCandidates.filter((c) => !c.needsPreflight).length;
    console.log(`[phase3]  ${newCount} new (need preflight) | ${skipCount} graph-skipped`);

    // ── Step 4: Pre-flight only new candidates ─────────────────────────────────
    const authRules = await loadAuthRules();
    console.log(`[phase3]  ${authRules.length} auth rule(s) loaded`);

    // ── Bounded concurrent preflight checks ────────────────────────────────
    // Independent HTTP checks — safe to parallelise; apiCtx is thread-safe.
    // Concurrency is bounded by effectiveMaxPreflightChecks (env or request override).
    const pfCandidates = classifiedCandidates.filter((c) => c.needsPreflight);
    const apiCtx = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    try {
      if (pfCandidates.length > 0) {
        let pfSlots   = Math.max(1, effectiveMaxPreflightChecks);
        const pfWaiters = [];
        const pfAcquire = () => {
          if (pfSlots > 0) { pfSlots--; return Promise.resolve(); }
          return new Promise((res) => pfWaiters.push(res));
        };
        const pfRelease = () => {
          if (pfWaiters.length > 0) pfWaiters.shift()();
          else pfSlots++;
        };

        await Promise.all(pfCandidates.map(async (candidate, pfIdx) => {
          await pfAcquire();
          try {
            console.log(`[phase3]  preflight ${pfIdx + 1}/${pfCandidates.length} — ${candidate.normalizedUrl}`);

            let pf = await checkReachability(candidate.normalizedUrl, apiCtx);

            if (pf.reachableClass === 'auth_required') {
              const rule = matchAuthRule(candidate.normalizedUrl, authRules);
              if (rule) {
                console.log(`[phase3]   → auth rule "${rule.ruleId}" matched, retrying …`);
                const retry = await retryWithStorageState(candidate.normalizedUrl, rule, browser);
                pf = { ...pf, ...retry, matchedRuleId: rule.ruleId, storageStatePath: rule.storageStatePath, recheckedWithAuth: true };
              } else {
                pf = { ...pf, reachableClass: 'user_input_required', reason: 'Auth required but no matching rule', matchedRuleId: null, storageStatePath: null, recheckedWithAuth: false };
              }
            } else {
              pf = { ...pf, matchedRuleId: null, storageStatePath: null, recheckedWithAuth: false };
            }

            candidate.preflightResult = pf;

            switch (pf.reachableClass) {
              case 'reachable_now':
              case 'redirect_but_reachable':
                candidate.decision      = 'enqueue_now';
                candidate.enqueueReason = 'same host and new unique path, eligible for future exploration';
                break;
              case 'reachable_with_auth':
                candidate.decision      = 'enqueue_now';
                candidate.enqueueReason = 'accessible with stored auth credentials, eligible for future exploration';
                break;
              case 'auth_required':
              case 'user_input_required':
                candidate.decision   = 'hold_auth_required';
                candidate.skipReason = `held because pre-flight indicates authentication required: ${pf.reason || 'no rule matched'}`;
                break;
              default:
                candidate.decision   = 'hold_unreachable';
                candidate.skipReason = `held because pre-flight failed: ${pf.reason || 'unknown error'}`;
            }

            console.log(`[phase3]   → ${candidate.decision}`);
          } finally {
            pfRelease();
          }
        }));
      }
    } finally {
      await apiCtx.dispose();
    }

    // ── Step 5: Upsert candidate nodes and edges in graph ─────────────────────
    let graphNodeCreatedCount = 0, graphNodeReusedCount = 0;
    let graphEdgeCreatedCount = 0, graphEdgeReusedCount = 0;

    for (const candidate of classifiedCandidates) {
      const { node: targetNode, created: nodeCreated } = upsertNode(graph, {
        hostname:           candidate.hostname,
        normalizedPath:     candidate.normalizedPath,
        dedupKey:           candidate.dedupKey,
        representativeUrl:  candidate.normalizedUrl,
        jobId,
      });
      if (candidate.preflightResult) {
        updateNodeReachability(graph, candidate.dedupKey, candidate.preflightResult.reachableClass);
      }
      candidate.targetNode = targetNode;
      nodeCreated ? graphNodeCreatedCount++ : graphNodeReusedCount++;

      // Do not create self-loop edges for the current page
      if (candidate.decision !== 'skip_duplicate_path') {
        const { created: edgeCreated } = upsertEdge(graph, {
          fromNodeId:        inputNode.nodeId,
          toNodeId:          targetNode.nodeId,
          jobId,
          discoverySource:   candidate.discoverySource,
          triggerId:         null,
          representativeUrl: candidate.normalizedUrl,
          edgeType:          candidate.discoverySource === 'trigger-navigation'
            ? 'navigation_trigger'
            : 'normal_discovery',
        });
        edgeCreated ? graphEdgeCreatedCount++ : graphEdgeReusedCount++;
      }
    }

    // ── Step 5b: Upsert auth-gated discoveries in graph ───────────────────────
    // For same-host login pages: create a graph node marked authGated=true and
    // an edge with edgeType='auth_gate'.  These nodes are NOT enqueued for
    // content exploration.
    //
    // For cross-host auth providers (navigated_to_login_auth_host): create a
    // node for the external auth hostname so the graph records the auth
    // dependency.  Cross-host nodes are never in-scope for content analysis.
    let authGatedNodeCreatedCount = 0;
    let authGatedEdgeCreatedCount = 0;

    for (const discovery of authGatedDiscoveries) {
      const identity = computePageIdentity(discovery.targetUrl);
      if (!identity) continue;

      const { node: authNode, created: nodeCreated } = upsertNode(graph, {
        hostname:          identity.hostname,
        normalizedPath:    identity.normalizedPath,
        dedupKey:          identity.dedupKey,
        representativeUrl: discovery.targetUrl,
        jobId,
        authGated:         true,
      });
      if (nodeCreated) authGatedNodeCreatedCount++;

      const { created: edgeCreated } = upsertEdge(graph, {
        fromNodeId:        inputNode.nodeId,
        toNodeId:          authNode.nodeId,
        jobId,
        discoverySource:   'trigger-navigation',
        triggerId:         discovery.triggerId,
        representativeUrl: discovery.targetUrl,
        edgeType:          'auth_gate',
        requiresAuth:      discovery.requiresAuth,
        authDetected:      true,
        authScore:         discovery.authScore,
        navigationStatus:  discovery.navigationStatus,
      });
      if (edgeCreated) authGatedEdgeCreatedCount++;
    }

    if (authGatedNodeCreatedCount > 0 || authGatedEdgeCreatedCount > 0) {
      console.log(`[graph]  auth-gated: ${authGatedNodeCreatedCount} node(s) + ${authGatedEdgeCreatedCount} edge(s) created`);
    }

    // ── Step 6: Build queue artifact ──────────────────────────────────────────
    console.log('[phase3]  building next-queue.json …');
    const queueItems = buildQueue({
      candidates:        classifiedCandidates,
      sourceNodeId:      inputNode.nodeId,
      jobId,
      discoveredFromUrl: finalUrl,
    });
    await writeJson(path.join(outDir, 'next-queue.json'), queueItems);

    const queueReadyCount = queueItems.filter((i) => i.enqueueDecision === 'enqueue_now').length;
    const holdCount       = queueItems.filter((i) => i.enqueueDecision.startsWith('hold_')).length;
    const skippedCount    = queueItems.filter((i) => i.enqueueDecision.startsWith('skip_')).length;

    // URLs immediately available for BFS enqueue (pre-flighted, same scope, new path)
    const nextQueueUrls = queueItems
      .filter((i) => i.enqueueDecision === 'enqueue_now')
      .map((i) => i.targetUrl);

    // Auth-gated URLs discovered via trigger navigation (for crawl-level auth handling)
    const authGatedUrls = authGatedDiscoveries
      .map((d) => d.targetUrl)
      .filter(Boolean);

    console.log(`[phase3]  ${queueReadyCount} enqueue_now | ${holdCount} held | ${skippedCount} skipped`);
    console.log('[phase3] ── complete ──────────────────────────');

    // ── 7. Mark input node as fully analyzed ─────────────────────────────────
    markNodeAnalyzed(graph, inputIdentity.dedupKey, 'success');

    // ── 8. Write graph snapshot ───────────────────────────────────────────────
    // Graph is per-request (in-memory only). saveGraph no longer exists.
    // When running inside a crawl, crawlRunner owns the graph lifecycle.
    await saveSnapshot(outDir, graph);
    console.log(`[graph]  saved  nodes=${Object.keys(graph.nodes).length}  edges=${Object.keys(graph.edges).length}`);

    // ── 9. Write final-report.json ────────────────────────────────────────────
    const finishedAt = new Date().toISOString();
    const jobDirName = path.basename(outDir);

    const finalReport = {
      jobId,
      startedAt,
      finishedAt,
      currentPageStatus: 'analyzed_new_page',

      // ── Input URLs and scope validation ───────────────────────────────────
      input:  { originalUrl, requestUrl },
      scope: {
        rootHost,
        requestHost,
        requestAllowed:       true,
        finalRenderedHost,
        finalRenderedAllowed: finalRenderedHost === rootHost,
        stopReason:           null,
      },

      // ── Input page identity and graph placement ────────────────────────────
      inputPage: {
        requestUrl,
        finalUrl,
        hostname:         inputIdentity.hostname,
        normalizedPath:   inputIdentity.normalizedPath,
        dedupKey:         inputIdentity.dedupKey,
        nodeId:           inputNode.nodeId,
        graphNodeCreated: inputNodeCreated,
      },

      // ── Phase 1 artifacts (VLM-ready outputs preserved) ────────────────────
      phase1: {
        page: pageMeta,
        screenshots: {
          baseline:          toRelPath('outputs', jobDirName, 'baseline.png'),
          baselineAnnotated: toRelPath('outputs', jobDirName, 'baseline-annotated.png'),
        },
        staticComponents: allNodes.map((n) => ({
          nodeId: n.nodeId, tagName: n.tagName, text: n.text,
          role: n.role, selectorHint: n.selectorHint, bbox: n.bbox, group: n.group,
        })),
        triggerCandidates: allCandidates.map((c) => ({
          triggerId: c.triggerId, action: c.triggerType, text: c.text,
          role: c.role, selectorHint: c.selectorHint, bbox: c.bbox,
          priority: c.priority, reason: c.reason,
          authSensitiveHint: c.authSensitiveHint ?? false,
        })),
        triggerResults,
        authGatedDiscoveries,
        summary: phase1Summary,
      },

      // ── Initial render stabilization ───────────────────────────────────────
      // Detail of the stabilization run that preceded Phase 1 baseline capture.
      // Full artifact: outputs/{jobId}/initial-stabilization.json
      initialStabilization: {
        enabled:               stabResult.enabled,
        blockerCount:          stabResult.blockerCount,
        blockingElements:      stabResult.blockingElements,
        actions:               stabResult.actions,
        dismissedOverlayCount: stabResult.dismissedCount,
        hiddenOverlayCount:    stabResult.hiddenCount,
        pausedMediaCount:      stabResult.pausedMediaCount,
        stabilizationSucceeded: stabResult.stabilizationSucceeded,
        partiallyBlocked:      stabResult.partiallyBlocked,
        warnings:              stabResult.warnings,
        artifactFile:          toRelPath('outputs', jobDirName, 'initial-stabilization.json'),
      },

      // ── Render readiness (PART 1) ──────────────────────────────────────────
      // Records whether the page was fully rendered before analysis began.
      // Full artifact: outputs/{jobId}/render-readiness.json
      renderReadiness: {
        degradedMode:    readinessResult.degradedMode,
        readinessScore:  readinessResult.readinessScore,
        passedSignals:   readinessResult.passedSignals,
        totalSignals:    readinessResult.totalSignals,
        message:         readinessResult.message ?? null,
        artifactFile:    toRelPath('outputs', jobDirName, 'render-readiness.json'),
      },

      // ── Frame inspection (PART 2) ──────────────────────────────────────────
      // Summarises all iframes found on the page.
      // Full artifact: outputs/{jobId}/frame-summary.json
      frameSummary: {
        totalFrameCount:    frameSummary.totalFrameCount,
        sameOriginCount:    frameSummary.sameOriginCount,
        crossOriginCount:   frameSummary.crossOriginCount,
        largeFrameCount:    frameSummary.frames?.filter((f) => f.vpCoverage >= 0.3).length ?? 0,
        artifactFile:       toRelPath('outputs', jobDirName, 'frame-summary.json'),
      },

      // ── Graph update summary ───────────────────────────────────────────────
      graphUpdate: {
        inputNodeCreated:        inputNodeCreated,
        inputNodeReused:         !inputNodeCreated,
        candidateNodeCreated:    graphNodeCreatedCount,
        candidateNodeReused:     graphNodeReusedCount,
        graphEdgeCreatedCount,
        graphEdgeReusedCount,        authGatedNodeCreatedCount,
        authGatedEdgeCreatedCount,        totalGraphNodes:         Object.keys(graph.nodes).length,
        totalGraphEdges:         Object.keys(graph.edges).length,
      },

      // ── Candidate URL summary ──────────────────────────────────────────────
      candidateSummary: {
        discoveredCandidateCount:  rawCandidates.length,
        allowedCandidateCount:     filtered.length,
        uniquePathCandidateCount:  classifiedCandidates.length,
        preflightCheckedCount:     newCount,
        queueReadyCount,
        skippedCandidateCount:     skippedCount,
        heldCandidateCount:        holdCount,
      },

      // ── Queue artifact summary ─────────────────────────────────────────────
      queueSummary: {
        queueFile:      `outputs/${jobDirName}/next-queue.json`,
        queueReadyCount,
        holdCount,
        skippedCount,
        note:           'Queue is a local artifact only. This toy project does not recursively consume it.',
      },

      // ── Phase 3 detail (all candidates with decisions) ────────────────────
      // Phase 2 section will be inserted here once VLM integration is added.
      phase3: {
        discoveredUrlCount:   rawCandidates.length,
        filteredUrlCount:     filtered.length,
        preflightCheckedCount: newCount,
        queueReadyCount,
        holdCount,
        urls: queueItems,
      },
    };

    await writeJson(path.join(outDir, 'final-report.json'), finalReport);
    console.log(`[runAnalysis] done → ${outDir}`);

    return {
      outputPath:        outDir,
      currentPageStatus: 'analyzed_new_page',
      originalUrl,
      requestUrl,
      rootHost,
      requestHost,
      reason:            'request URL is inside the original URL scope',
      // ── BFS crawl consumer helpers ────────────────────────────────────────
      // nextQueueUrls: URLs ready to be enqueued immediately (enqueue_now decision)
      // authGatedUrls: login-page URLs discovered via trigger navigation
      // inputPage:     graph identity of the page that was just analyzed
      nextQueueUrls,
      authGatedUrls,
      inputPage: {
        requestUrl,
        finalUrl,
        nodeId:           inputNode.nodeId,
        dedupKey:         inputIdentity.dedupKey,
        graphNodeCreated: inputNodeCreated,
      },
      summary: {
        phase1: phase1Summary,
        phase3: {
          discoveredUrlCount: rawCandidates.length,
          filteredUrlCount:   filtered.length,
          queueReadyCount,
          holdCount,
        },
        graphUpdate: {
          inputNodeCreated:     inputNodeCreated,
          candidateNodeCreated: graphNodeCreatedCount,
          graphEdgeCreatedCount,
        },
      },
    };

  } finally {
    if (_ownsBrowser && browser) await browser.close().catch(() => {});
  }
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Select up to `limit` nodes from `allNodes` for baseline annotation,
 * prioritizing individual interactive/media elements over large structural
 * containers.
 *
 * Priority order (lower number = annotated first):
 *   1  Interactive leaf elements — a, button, input, select, textarea,
 *      summary, label (the most valuable for VLM / human inspection)
 *   2  Media elements — img, video, canvas, svg, picture
 *   3  Heading text   — h1–h6
 *   4  List items     — li
 *   5  Semantic blocks — header, nav, main, footer, section, article,
 *      aside, form, table, ul, ol, dialog, details
 *   6  Everything else (generic divs, spans, p, etc.)
 *
 * Within each priority group nodes are sorted by bounding-box area
 * ascending (smallest = most specific / leaf-like element first).
 *
 * `body` and `html` are excluded entirely — they produce a single giant
 * border around the whole page that adds no analytical value.
 *
 * @param {object[]} allNodes  Full node list from extractStaticNodes
 * @param {number}   limit     Maximum number of nodes to annotate
 * @returns {object[]}
 */
function selectAnnotationNodes(allNodes, limit) {
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label']);
  const MEDIA       = new Set(['img', 'video', 'canvas', 'svg', 'picture']);
  const HEADING     = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const LIST_ITEM   = new Set(['li']);
  const SEMANTIC    = new Set([
    'header', 'nav', 'main', 'footer', 'section', 'article',
    'aside', 'form', 'table', 'ul', 'ol', 'dialog', 'details',
  ]);
  const SKIP_ANNOT  = new Set(['body', 'html']);

  function annotPriority(n) {
    const tag = n.tagName;
    if (SKIP_ANNOT.has(tag))  return 99;
    if (INTERACTIVE.has(tag)) return 1;
    if (MEDIA.has(tag))       return 2;
    if (HEADING.has(tag))     return 3;
    if (LIST_ITEM.has(tag))   return 4;
    if (SEMANTIC.has(tag))    return 5;
    return 6;
  }

  return allNodes
    .filter((n) => !SKIP_ANNOT.has(n.tagName))
    .sort((a, b) => {
      const pa = annotPriority(a);
      const pb = annotPriority(b);
      if (pa !== pb) return pa - pb;
      // Within same priority group: prefer higher focusScore (PART 5).
      // Fall back to smaller area (more leaf-like) when scores are equal.
      const fa = a.focusScore ?? 0;
      const fb = b.focusScore ?? 0;
      if (fb !== fa) return fb - fa;
      return (a.bbox.width * a.bbox.height) - (b.bbox.width * b.bbox.height);
    })
    .slice(0, limit);
}
