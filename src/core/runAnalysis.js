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
         installMutationTracker }                        from './phase1/mutationTracker.js';
import { extractStaticNodes,
         getPageMeta,
         getPageLinks }                                  from './phase1/staticAnalysis.js';
import { findTriggerCandidates }                         from './phase1/triggerDiscovery.js';
import { runTriggersParallel }                           from './phase1/parallelTriggerRunner.js';
import { detectAutoDynamicRegions }                      from './phase1/autoDynamicDetector.js';

// ── Shared core utilities ──────────────────────────────────────────────────────
import { annotateScreenshot }                            from './annotate.js';
import { jobOutputDir, toRelPath }                       from './utils.js';

// ── Phase 3 modules ────────────────────────────────────────────────────────────
import { extractUrls }                                   from './phase3/extractUrls.js';
import { filterUrls }                                    from './phase3/filterUrls.js';
import { checkReachability }                             from './phase3/reachabilityChecker.js';
import { loadAuthRules,
         matchAuthRule,
         retryWithStorageState }                         from './phase3/authRuleEngine.js';
import { buildQueue }                                    from './phase3/buildQueue.js';

// ── Graph modules ──────────────────────────────────────────────────────────────
import { computePageIdentity }                           from './graph/graphModel.js';
import { loadGraph, saveGraph, saveSnapshot }            from './graph/graphStore.js';
import { findNode, upsertNode, upsertEdge,
         markNodeAnalyzed,
         updateNodeReachability }                        from './graph/graphUpdater.js';

// ── Playwright request API ─────────────────────────────────────────────────────
import { request as playwrightRequest }                  from 'playwright';

// ── Runtime configuration ──────────────────────────────────────────────────────

const CONFIG = {
  MAX_TRIGGERS:                    parseInt(process.env.MAX_TRIGGERS        || '10',  10),
  ANNOTATION_LIMIT:                300,
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
  NODE_FILTER: {
    minTextLength:    parseInt(process.env.NODE_MIN_TEXT   || '3',   10),
    minArea:          parseInt(process.env.NODE_MIN_AREA   || '200', 10),
    qualityThreshold: parseInt(process.env.NODE_MIN_SCORE  || '3',   10),
    debugDrop:        process.env.DEBUG_NODES === 'true',
  },
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
export async function runAnalysis({ jobId, originalUrl, requestUrl }) {
  const outDir        = jobOutputDir(jobId);
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

  // ── 2. Load persistent graph ─────────────────────────────────────────────────
  const graph = await loadGraph();
  console.log(`[graph]  loaded  nodes=${Object.keys(graph.nodes).length}  edges=${Object.keys(graph.edges).length}`);

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
  let browser = null;
  try {
    browser = await launchBrowser();

    // ════════════════════════════════════════════════════════════════════════════
    // PHASE 1  —  Static analysis + dynamic trigger exploration
    // ════════════════════════════════════════════════════════════════════════════

    console.log('[phase1] ── starting ─────────────────────────');

    const baseCtx  = await createFreshContext(browser);
    await baseCtx.addInitScript(MUTATION_TRACKER_SCRIPT);
    const basePage = await baseCtx.newPage();
    await navigateTo(basePage, requestUrl);
    await installMutationTracker(basePage);

    const baselinePng = path.join(outDir, 'baseline.png');
    await basePage.screenshot({ path: baselinePng, fullPage: true });
    console.log('[phase1]  baseline.png saved');

    console.log('[phase1]  extracting static nodes, metadata and links …');
    const [pageMeta, nodeResult, pageLinks] = await Promise.all([
      getPageMeta(basePage),
      extractStaticNodes(basePage, CONFIG.NODE_FILTER),
      getPageLinks(basePage),
    ]);
    const allNodes     = nodeResult.nodes;
    const droppedNodes = nodeResult.droppedNodes;

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

    const baselineAnnotatedPng = path.join(outDir, 'baseline-annotated.png');
    await annotateScreenshot(basePage, allNodes.slice(0, CONFIG.ANNOTATION_LIMIT), baselineAnnotatedPng);
    console.log('[phase1]  baseline-annotated.png saved');

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

    console.log(`[phase1]  running trigger exploration … (workers=${CONFIG.MAX_PARALLEL_TRIGGER_WORKERS} mode=${CONFIG.TRIGGER_SCREENSHOT_MODE})`);
    const { results: triggerResults, metrics: triggerMetrics } = await runTriggersParallel(
      browser, requestUrl, candidates, outDir, {
        maxWorkers:                      CONFIG.MAX_PARALLEL_TRIGGER_WORKERS,
        screenshotMode:                  CONFIG.TRIGGER_SCREENSHOT_MODE,
        fallbackToFullPageOnClipFailure: true,
        autoDynamicRegions,
        autoDynamicOverlapThreshold:     CONFIG.AUTO_DYNAMIC_OVERLAP_THRESHOLD,
        freezeCss:                       CONFIG.FREEZE_CSS_DURING_TRIGGERS,
      });

    // Write per-trigger JSON artifacts (independent files — safe to parallelise)
    await Promise.all(
      triggerResults.map((r) => writeJson(path.join(trigResultDir, `${r.triggerId}.json`), r)));

    let executedCount = 0, changedCount = 0, navigatedAwayCount = 0;
    for (const result of triggerResults) {
      if (result.status === 'navigated_away')                        navigatedAwayCount++;
      else if (result.status !== 'skipped')                          executedCount++;
      if (result.newNodes.length > 0 || result.mutationCount > 0)    changedCount++;
      console.log(`[phase1]   trigger ${result.triggerId} → ${result.status} (${result.durationMs ?? '?'}ms) | ${result.summary}`);
    }

    const phase1Summary = {
      staticComponentCount:   allNodes.length,
      triggerCandidateCount:  allCandidates.length,
      triggerExecutedCount:   executedCount,
      changedTriggerCount:    changedCount,
      navigatedAwayCount,
      autoDynamicRegionCount: autoDynamicRegions.length,
      triggerPerformance:     triggerMetrics,
    };

    console.log('[phase1] ── complete ──────────────────────────');

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
    console.log(`[phase3]  ${rawCandidates.length} raw candidates`);

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

    const apiCtx = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });

    for (let i = 0, pfNum = 0; i < classifiedCandidates.length; i++) {
      const candidate = classifiedCandidates[i];
      if (!candidate.needsPreflight) continue;

      pfNum++;
      console.log(`[phase3]  preflight ${pfNum}/${newCount} — ${candidate.normalizedUrl}`);

      let pf = await checkReachability(candidate.normalizedUrl, apiCtx);

      // Auth rule matching
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

      // Map pre-flight result → enqueue decision vocabulary
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
          candidate.decision  = 'hold_auth_required';
          candidate.skipReason = `held because pre-flight indicates authentication required: ${pf.reason || 'no rule matched'}`;
          break;
        default:
          candidate.decision  = 'hold_unreachable';
          candidate.skipReason = `held because pre-flight failed: ${pf.reason || 'unknown error'}`;
      }

      console.log(`[phase3]   → ${candidate.decision}`);
    }

    await apiCtx.dispose();

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
        });
        edgeCreated ? graphEdgeCreatedCount++ : graphEdgeReusedCount++;
      }
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

    console.log(`[phase3]  ${queueReadyCount} enqueue_now | ${holdCount} held | ${skippedCount} skipped`);
    console.log('[phase3] ── complete ──────────────────────────');

    // ── 7. Mark input node as fully analyzed ─────────────────────────────────
    markNodeAnalyzed(graph, inputIdentity.dedupKey, 'success');

    // ── 8. Persist graph and write snapshot ──────────────────────────────────
    await saveGraph(graph);
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
        })),
        triggerResults,
        summary: phase1Summary,
      },

      // ── Graph update summary ───────────────────────────────────────────────
      graphUpdate: {
        inputNodeCreated:        inputNodeCreated,
        inputNodeReused:         !inputNodeCreated,
        candidateNodeCreated:    graphNodeCreatedCount,
        candidateNodeReused:     graphNodeReusedCount,
        graphEdgeCreatedCount,
        graphEdgeReusedCount,
        totalGraphNodes:         Object.keys(graph.nodes).length,
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
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}
