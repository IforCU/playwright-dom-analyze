/**
 * core/runAnalysis.js
 *
 * Orchestrates a single-page analysis: Phase 1 (DOM extraction + trigger
 * exploration) → graph update → Phase 3 (URL extraction + pre-flight).
 *
 * One URL in → artifacts + graph update out.
 * Does NOT recurse into discovered URLs — that is crawlRunner's job.
 */

import fs   from 'fs/promises';
import path from 'path';

import { launchBrowser, createFreshContext, navigateTo } from './browser.js';

import { MUTATION_TRACKER_SCRIPT,
         installMutationTracker,
         resetMutations }                                from './phase1/mutationTracker.js';
import { stabilizePage }                                 from './phase1/pageStabilizer.js';
import { checkRenderReadiness,
         inspectFrames }                                 from './phase1/renderReadinessChecker.js';
import { extractStaticNodes,
         getPageMeta,
         getPageLinks,
         extractStaticNodesLite }                        from './phase1/staticAnalysis.js';
import { findTriggerCandidates, assignProbeTiers, groupAndSampleCandidates } from './phase1/triggerDiscovery.js';
import { runTriggersParallel }                           from './phase1/parallelTriggerRunner.js';
import { detectAutoDynamicRegions }                      from './phase1/autoDynamicDetector.js';
import { installNavigationDefense,
         lockNavigationDefense,
         getDefenseState,
         waitForPostAuthStability,
         probePostAuthReadiness }                        from './phase1/spaNavigationDefense.js';
import { computePhase1Quality,
         buildHumanReadableNotes,
         selectAnnotationNodes }                         from './phase1/analysisQuality.js';
import { buildCompactReport }                            from './phase1/compactOutput.js';

import { annotateScreenshot }                            from './annotate.js';
import { classifyNodes, buildLegend }                    from './functionalClassifier.js';
import { applyLabelFilter }                              from './labelFilter.js';
import { jobOutputDir, toRelPath }                       from './utils.js';

import { extractUrls }                                   from './phase3/extractUrls.js';
import { filterUrls }                                    from './phase3/filterUrls.js';
import { normalizeUrl }                                  from './phase3/normalizeUrl.js';
import { checkReachability }                             from './phase3/reachabilityChecker.js';
import { loadAuthRules,
         matchAuthRule,
         retryWithStorageState }                         from './phase3/authRuleEngine.js';
import { buildQueue }                                    from './phase3/buildQueue.js';

import { computePageIdentity }                           from './graph/graphModel.js';
import { saveSnapshot, createGraph }                     from './graph/graphStore.js';
import { findNode, upsertNode, upsertEdge,
         markNodeAnalyzed,
         updateNodeReachability }                        from './graph/graphUpdater.js';

import { request as playwrightRequest }                  from 'playwright';

const CONFIG = {
  MAX_TRIGGERS:                   parseInt(process.env.MAX_TRIGGERS        || '10',  10),
  ANNOTATION_LIMIT:               parseInt(process.env.ANNOTATION_LIMIT    || '400', 10),
  MAX_URLS:                       parseInt(process.env.MAX_URLS            || '50',  10),
  MAX_REACHABILITY_CHECKS:        parseInt(process.env.MAX_CHECKS          || '20',  10),
  MAX_PARALLEL_TRIGGER_WORKERS:   parseInt(process.env.MAX_PARALLEL_WORKERS || '4',   10),
  // 'changedRegion' (default) clips the trigger screenshot to the mutated area only
  TRIGGER_SCREENSHOT_MODE:        process.env.TRIGGER_SCREENSHOT_MODE      || 'changedRegion',
  DETECT_AUTO_DYNAMIC:            process.env.DETECT_AUTO_DYNAMIC          !== 'false',
  AUTO_DYNAMIC_OBSERVATION_MS:    parseInt(process.env.AUTO_DYNAMIC_OBSERVATION_MS  || '3000', 10),
  AUTO_DYNAMIC_OVERLAP_THRESHOLD: parseFloat(process.env.AUTO_DYNAMIC_OVERLAP_THRESHOLD || '0.3'),
  // Pauses CSS animations during trigger execution to reduce mutation noise
  FREEZE_CSS_DURING_TRIGGERS:     process.env.FREEZE_CSS_TRIGGERS          === 'true',
  AUTH_DETECTION_ENABLED:         process.env.AUTH_DETECTION_ENABLED       !== 'false',
  AUTH_SCORE_THRESHOLD:           parseInt(process.env.AUTH_SCORE_THRESHOLD || '5', 10),
  AUTH_MAYBE_THRESHOLD:           parseInt(process.env.AUTH_MAYBE_THRESHOLD || '3', 10),
  STABILIZE_PAGE:                 process.env.STABILIZE_PAGE               !== 'false',
  STABILIZE_COVERAGE_THRESHOLD:   parseFloat(process.env.STABILIZE_COVERAGE_THRESHOLD || '0.30'),
  STABILIZE_MIN_ZINDEX:           parseInt(process.env.STABILIZE_MIN_ZINDEX || '50', 10),
  NODE_FILTER: {
    minTextLength:    parseInt(process.env.NODE_MIN_TEXT  || '3',   10),
    minArea:          parseInt(process.env.NODE_MIN_AREA  || '200', 10),
    qualityThreshold: parseInt(process.env.NODE_MIN_SCORE || '3',   10),
    debugDrop:        process.env.DEBUG_NODES === 'true',
  },
  LABEL_FILTER: {
    labelMode:                               process.env.LABEL_MODE              || 'balanced',
    labelMinScore:                           process.env.LABEL_MIN_SCORE != null && process.env.LABEL_MIN_SCORE !== ''
                                               ? parseInt(process.env.LABEL_MIN_SCORE, 10) : null,
    suppressChildLabelsWhenParentIsSufficient: process.env.SUPPRESS_CHILD_LABELS !== 'false',
    preferGroupLabelingForRepeatedItems:       process.env.PREFER_GROUP_LABELS   !== 'false',
    maxLabelsPerViewport:                      parseInt(process.env.MAX_LABELS_VIEWPORT || '200', 10),
    debugFilter:                              process.env.DEBUG_LABEL_FILTER     === 'true',
  },
  MAX_PARALLEL_PREFLIGHT_CHECKS:  parseInt(process.env.MAX_PARALLEL_PREFLIGHT_CHECKS || '8', 10),
  // Trigger grouping: candidates are de-duped by structural signature before execution
  MAX_TRIGGER_GROUPS_PER_PAGE:    parseInt(process.env.MAX_TRIGGER_GROUPS  || '12', 10),
  MAX_TRIGGER_REPS_PER_GROUP:     parseInt(process.env.MAX_TRIGGER_REPS    || '3',  10),
  // 'on_delta' (default) only screenshots triggers that produce meaningful DOM changes
  TRIGGER_SCREENSHOT_POLICY:      process.env.TRIGGER_SCREENSHOT_POLICY    || 'on_delta',
  TRIGGER_MIN_DELTA_SCORE:        parseInt(process.env.TRIGGER_MIN_DELTA   || '1',  10),
  // addInitScript-based nav defense — patches pushState/location.assign/etc. to
  // block SPA navigation after the analysis lock is activated
  NAV_DEFENSE_ENABLED:            process.env.NAV_DEFENSE_ENABLED          !== 'false',
  POST_AUTH_SETTLE_MS:            parseInt(process.env.POST_AUTH_SETTLE_MS          || '15000', 10),
  ANALYSIS_READY_QUIET_WINDOW_MS: parseInt(process.env.ANALYSIS_READY_QUIET_WINDOW  || '2000',  10),
  MAX_AUTH_STABILIZATION_MS:      parseInt(process.env.MAX_AUTH_STABILIZATION_MS    || '20000', 10),
  // After URL stabilizes, re-navigate to the settled URL so the SPA starts fresh
  // under a fully locked nav defense context, preventing boot-time redirects
  SECOND_PASS_REENTRY:            process.env.SECOND_PASS_REENTRY          !== 'false',
  POST_AUTH_DOM_PROBE_ENABLED:    process.env.POST_AUTH_DOM_PROBE          !== 'false',
  POST_AUTH_READY_QUIET_WINDOW_MS:        parseInt(process.env.POST_AUTH_READY_QUIET_WINDOW || '600',   10),
  MIN_EVALUATE_SUCCESSES_BEFORE_ANALYSIS: parseInt(process.env.MIN_EVALUATE_SUCCESSES       || '2',     10),
  MAX_POST_AUTH_READINESS_WAIT_MS:        parseInt(process.env.MAX_POST_AUTH_READINESS_WAIT  || '12000', 10),
  // Attempt one fresh-context retry when DOM extraction returns 0 nodes
  ANALYSIS_RETRY_ON_EMPTY_DOM:    process.env.ANALYSIS_RETRY_ON_EMPTY_DOM !== 'false',
  // Output mode: 'compact' (default, QA-oriented) | 'debug' (full extraction detail)
  OUTPUT_MODE:                    process.env.OUTPUT_MODE || 'compact',
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

  const rootHost    = new URL(originalUrl).hostname;
  const requestHost = new URL(requestUrl).hostname;

  console.log(`[runAnalysis] job=${jobId}  rootHost=${rootHost}  requestUrl=${requestUrl}`);

  // Scope guard — requestHost must match rootHost exactly (no subdomain expansion)
  if (requestHost !== rootHost) {
    const stopReason = `request host ${requestHost} does not match root host ${rootHost}`;
    console.log(`[scope] STOP — ${stopReason}`);

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

  const graph = sharedGraph ?? createGraph();
  console.log(`[graph] ${sharedGraph ? 'shared' : 'new'}  nodes=${Object.keys(graph.nodes).length}  edges=${Object.keys(graph.edges).length}`);

  const inputIdentity = computePageIdentity(requestUrl);
  if (!inputIdentity) throw new Error(`Cannot compute page identity for: ${requestUrl}`);
  console.log(`[graph] input dedupKey=${inputIdentity.dedupKey}`);

  const existingInputNode = findNode(graph, inputIdentity.dedupKey);
  if (existingInputNode?.analyzed) {
    console.log(`[graph] SKIP — page already analyzed at ${existingInputNode.analyzedAt}`);

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

  // In crawl mode (sharedBrowser provided) we must NOT close it when we are done.
  let browser      = sharedBrowser ?? null;
  let _ownsBrowser = !sharedBrowser;
  if (!browser) {
    browser      = await launchBrowser();
    _ownsBrowser = true;
  }
  try {

    console.log('[phase1] starting');

    const navDefenseEnabled      = CONFIG.NAV_DEFENSE_ENABLED;
    let navDefenseApplied        = false;
    let blockedNavigationCount   = 0;
    const postAuthMode           = !!storageStatePath;
    let postAuthStabilizationResult = null;
    let analysisContextReused    = false;
    let finalEffectiveAnalysisUrl = requestUrl;
    let analysisQualityNote      = null;
    // URL/timestamp tracking: detect drift between screenshot and DOM extraction steps
    let screenshotCapturedAtUrl   = null;
    let screenshotCapturedAtTime  = null;
    let staticNodesExtractedAtUrl = null;
    let staticNodesExtractedAtTime= null;
    let linksExtractedAtUrl       = null;
    let linksExtractedAtTime      = null;
    let postAuthDomProbeResult    = null;

    const baseCtx  = await createFreshContext(browser, { storageState: storageStatePath });
    await baseCtx.addInitScript(MUTATION_TRACKER_SCRIPT);
    // Nav defense starts in ALLOW mode — SPA can redirect freely during initial load
    if (navDefenseEnabled) await installNavigationDefense(baseCtx);

    const basePage = await baseCtx.newPage();
    await navigateTo(basePage, requestUrl);
    await installMutationTracker(basePage);

    if (postAuthMode) {
      console.log('[post-auth] storageState active — waiting for URL to stabilize before analysis …');
      postAuthStabilizationResult = await waitForPostAuthStability(basePage, {
        quietWindowMs:  CONFIG.ANALYSIS_READY_QUIET_WINDOW_MS,
        maxWaitMs:      CONFIG.POST_AUTH_SETTLE_MS,
        pollIntervalMs: 250,
        requireBody:    true,
      });

      finalEffectiveAnalysisUrl = postAuthStabilizationResult.finalUrl;

      if (!postAuthStabilizationResult.stable) {
        console.log(`[post-auth] WARNING — page did not fully stabilize: ${postAuthStabilizationResult.reason}`);
        analysisQualityNote = 'SPA auto-navigation caused instability during post-auth settle; results may be degraded';
      } else {
        console.log(`[post-auth] page stable at: ${finalEffectiveAnalysisUrl}`);
      }

      // Second-pass re-entry: re-navigate to the settled URL so the SPA boots
      // under an already-locked defense, preventing boot-time auto-redirects
      if (CONFIG.SECOND_PASS_REENTRY) {
        const reentryUrl = postAuthStabilizationResult.finalUrl ?? requestUrl;
        console.log(`[post-auth] second-pass re-entry → ${reentryUrl}`);
        try {
          await basePage.goto(reentryUrl, { waitUntil: 'load', timeout: 35_000 });
          await basePage.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
          await basePage.waitForTimeout(800);
          analysisContextReused = true;
          finalEffectiveAnalysisUrl = basePage.url();
          console.log(`[post-auth] re-entry complete — final URL: ${finalEffectiveAnalysisUrl}`);
          await installMutationTracker(basePage).catch((err) => {
            console.log(`[post-auth] mutation tracker re-install failed (${err.message})`);
          });
        } catch (reentryErr) {
          console.log(`[post-auth] second-pass re-entry failed (${reentryErr.message}) — continuing with current page`);
        }
      }

      if (navDefenseEnabled) {
        navDefenseApplied = await lockNavigationDefense(basePage);
        if (navDefenseApplied) console.log('[nav-defense] locked — SPA navigation blocked for analysis');
      }

      if (CONFIG.POST_AUTH_DOM_PROBE_ENABLED) {
        console.log('[post-auth-readiness] running DOM readiness probe …');
        postAuthDomProbeResult = await probePostAuthReadiness(basePage, {
          minElementCount:      10,
          minEvaluateSuccesses: CONFIG.MIN_EVALUATE_SUCCESSES_BEFORE_ANALYSIS,
          maxWaitMs:            CONFIG.MAX_POST_AUTH_READINESS_WAIT_MS,
          quietWindowMs:        CONFIG.POST_AUTH_READY_QUIET_WINDOW_MS,
          expectedUrl:          finalEffectiveAnalysisUrl,
        });
        if (!postAuthDomProbeResult.ready) {
          console.log(`[post-auth-readiness] WARNING — DOM not ready: ${postAuthDomProbeResult.reason}`);
          if (!analysisQualityNote) {
            analysisQualityNote =
              `post-auth DOM readiness probe failed (${postAuthDomProbeResult.reason}); ` +
              `evaluate failures=${postAuthDomProbeResult.evaluateFailures} — extraction may be empty`;
          }
        } else {
          console.log(`[post-auth-readiness] ready — score=${postAuthDomProbeResult.score} waited=${postAuthDomProbeResult.waitedMs}ms`);
        }
      }
    }

    // Render readiness check — gates Phase 1 until the page has settled sufficiently
    console.log('[render-readiness] checking …');
    const readinessResult = await checkRenderReadiness(basePage);
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await writeJson(path.join(outDir, 'render-readiness.json'), readinessResult);
    }
    if (readinessResult.degradedMode) {
      console.log(`[render-readiness] DEGRADED — proceeding anyway: ${readinessResult.message}`);
      // In post-auth mode we have already performed the second-pass re-entry above,
      // so we skip the re-navigate here to avoid undoing the defense lock.
      // In non-auth mode, attempt a re-navigate to get a stable context.
      if (!postAuthMode) {
        console.log('[render-readiness] waiting for current navigation to settle …');
        await basePage.waitForLoadState('domcontentloaded', { timeout: 12_000 }).catch(() => {});
        await basePage.waitForTimeout(1_000).catch(() => {});

        console.log(`[render-readiness] re-navigating to ${requestUrl} for stable context …`);
        try {
          await basePage.goto(requestUrl, { waitUntil: 'load', timeout: 30_000 });
          await basePage.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
          await basePage.waitForTimeout(1_000);
        } catch (navErr) {
          console.log(`[render-readiness] re-navigate failed (${navErr.message}) — continuing`);
        }
        await installMutationTracker(basePage).catch((err) => {
          console.log(`[render-readiness] tracker re-install failed (${err.message})`);
        });
        console.log(`[render-readiness] stable context at: ${basePage.url()}`);
      } else {
        console.log('[render-readiness] skipping re-navigate (post-auth second-pass already performed)');
        if (!analysisQualityNote) analysisQualityNote = 'render readiness degraded after post-auth stabilization; results may be partial';
      }
    } else {
      console.log(`[render-readiness] OK — score=${readinessResult.readinessScore} signals=${readinessResult.passedSignals}/${readinessResult.totalSignals}`);
    }

    console.log('[stabilize] starting');
    const stabResult = await stabilizePage(basePage, {
      enabled:           CONFIG.STABILIZE_PAGE,
      coverageThreshold: CONFIG.STABILIZE_COVERAGE_THRESHOLD,
      minZIndex:         CONFIG.STABILIZE_MIN_ZINDEX,
    });
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await writeJson(path.join(outDir, 'initial-stabilization.json'), stabResult);
    }
    console.log(
      `[stabilize] done — blockers=${stabResult.blockerCount}` +
      ` dismissed=${stabResult.dismissedCount} hidden=${stabResult.hiddenCount}` +
      ` mediaPaused=${stabResult.pausedMediaCount} ok=${stabResult.stabilizationSucceeded}`
    );

    const frameSummary = await inspectFrames(basePage);
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await writeJson(path.join(outDir, 'frame-summary.json'), frameSummary);
    }
    console.log(`[frames] ${frameSummary.totalFrameCount} frame(s) (${frameSummary.crossOriginCount} cross-origin, ${frameSummary.sameOriginCount} same-origin)`);

    // Reset mutation baseline after stabilization (exclude stabilizer noise from auto-dynamic window)
    await resetMutations(basePage).catch(async (err) => {
      console.log(`[phase1] resetMutations failed (${err.message}) — re-installing tracker`);
      await installMutationTracker(basePage).catch(() => {});
    });

    const baselinePng = path.join(outDir, 'baseline.png');

    // page.evaluate() may RESOLVE undefined (not throw) when mid-navigation — apply ?? fallback after await
    const dimensions = (
      await basePage.evaluate(() => ({
        width:  Math.max(document.body.scrollWidth,  document.documentElement.scrollWidth,  document.body.offsetWidth,  document.documentElement.offsetWidth,  document.documentElement.clientWidth),
        height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, document.body.offsetHeight, document.documentElement.offsetHeight, document.documentElement.clientHeight),
      })).catch(() => null)
    ) ?? { width: 1920, height: 1080 };

    console.log(`[phase1] page dimensions: ${dimensions.width}x${dimensions.height}`);

    // fullPage screenshot with size guard (SkBitmap allocation crashes above ~15000px)
    try {
      if (dimensions.height > 15000 || dimensions.width > 8000) {
        console.log('[phase1] page too large for fullPage screenshot, using viewport screenshot');
        await basePage.screenshot({ path: baselinePng, fullPage: false });
      } else {
        try {
          await basePage.screenshot({ path: baselinePng, fullPage: true });
        } catch (err) {
          console.log(`[phase1] fullPage screenshot failed (${err.message}), retrying with viewport screenshot...`);
          await basePage.screenshot({ path: baselinePng, fullPage: false });
        }
      }
    } catch (screenshotErr) {
      // Page navigated or context was destroyed mid-screenshot.  Write an empty
      // placeholder so downstream code always finds baseline.png.
      console.log(`[phase1] screenshot failed entirely (${screenshotErr.message}) — writing placeholder`);
      await fs.writeFile(baselinePng, Buffer.alloc(0));
    }
    // Record URL/time at screenshot capture (detect cross-step URL drift)
    screenshotCapturedAtUrl  = (() => { try { return basePage.url(); } catch { return finalEffectiveAnalysisUrl; } })();
    screenshotCapturedAtTime = new Date().toISOString();
    console.log('[phase1] baseline.png saved');

    // Secondary network-level navigation block (complements addInitScript JS-level block).
    // route() catches server-triggered redirects; JS pushState/replaceState are
    // already handled by the init script defense installed above.
    console.log('[phase1] installing secondary network-level navigation block …');
    await basePage.route('**/*', (route) => {
      if (route.request().isNavigationRequest()) {
        blockedNavigationCount++;
        console.log(`[phase1] BLOCKED network navigation: ${route.request().url()}`);
        return route.abort('aborted');
      }
      return route.continue();
    });

    // DOM extraction with degradation metadata.
    // Each call is wrapped independently so a failure in one does not block the others.
    const _NAV_ERRS = ['refs.set', 'Execution context was destroyed',
                       'Target page, context or browser has been closed',
                       'navigation', 'detached'];
    const _isNavErr = (err) => _NAV_ERRS.some((s) => err.message?.toLowerCase().includes(s.toLowerCase()));

    // Degradation tracking — populated by failed evaluate calls below
    const evaluateDegradation = {
      getPageMeta:          { degraded: false, reason: null },
      extractStaticNodes:   { degraded: false, reason: null },
      getPageLinks:         { degraded: false, reason: null },
    };

    console.log('[phase1] extracting static nodes, metadata and links …');
    const pageMeta = (await getPageMeta(basePage).catch((err) => {
      if (_isNavErr(err)) {
        const msg = `navigation mid-evaluate (${err.message.slice(0, 80)})`;
        console.log(`[phase1] getPageMeta: ${msg} — using fallback`);
        evaluateDegradation.getPageMeta = { degraded: true, reason: msg };
        return null;
      }
      throw err;
    })) ?? { finalUrl: requestUrl, title: '', description: '', lang: '', canonical: null,
             ogUrl: null, viewport: null, robots: null, metaTags: [] };

    const nodeResult = (await extractStaticNodes(basePage, CONFIG.NODE_FILTER).catch((err) => {
      if (_isNavErr(err)) {
        const msg = `navigation mid-evaluate (${err.message.slice(0, 80)})`;
        console.log(`[phase1] extractStaticNodes: ${msg} — using empty result`);
        evaluateDegradation.extractStaticNodes = { degraded: true, reason: msg };
        return null;
      }
      throw err;
    })) ?? { nodes: [], droppedNodes: [], visibilityMismatches: [] };
    // Record URL/time after static node extraction
    staticNodesExtractedAtUrl  = (() => { try { return basePage.url(); } catch { return finalEffectiveAnalysisUrl; } })();
    staticNodesExtractedAtTime = new Date().toISOString();

    const pageLinks = (await getPageLinks(basePage).catch((err) => {
      if (_isNavErr(err)) {
        const msg = `navigation mid-evaluate (${err.message.slice(0, 80)})`;
        console.log(`[phase1] getPageLinks: ${msg} — using empty result`);
        evaluateDegradation.getPageLinks = { degraded: true, reason: msg };
        return null;
      }
      throw err;
    })) ?? { anchors: [], areas: [], formActions: [] };
    // Record URL/time after link extraction
    linksExtractedAtUrl  = (() => { try { return basePage.url(); } catch { return finalEffectiveAnalysisUrl; } })();
    linksExtractedAtTime = new Date().toISOString();

    // Summarize degradation for quality classification
    const anyDegraded = Object.values(evaluateDegradation).some((v) => v.degraded);
    if (anyDegraded) {
      const degradedSteps = Object.entries(evaluateDegradation)
        .filter(([, v]) => v.degraded).map(([k]) => k).join(', ');
      console.log(`[phase1] DEGRADED evaluate steps: ${degradedSteps}`);
      if (!analysisQualityNote) {
        analysisQualityNote =
          `execution-context destruction during DOM extraction (${degradedSteps}); ` +
          'analysis retried in defended context but page remained unstable';
      }
    }

    // Lite-mode fallback: when full extraction degraded, try fast semantic-only extraction on same page.
    let liteExtractionUsed = false;
    if (nodeResult.nodes.length === 0 && evaluateDegradation.extractStaticNodes.degraded) {
      console.log('[phase1-lite] full extraction degraded — trying lite semantic fallback on same page …');
      const liteResult = await extractStaticNodesLite(basePage);
      if (liteResult.nodes.length > 0) {
        nodeResult.nodes        = liteResult.nodes;
        nodeResult.droppedNodes = [];
        nodeResult.extractedVia = liteResult.extractedVia;
        liteExtractionUsed      = true;
        staticNodesExtractedAtUrl  = (() => { try { return basePage.url(); } catch { return finalEffectiveAnalysisUrl; } })();
        staticNodesExtractedAtTime = new Date().toISOString();
        // Lite recovery counts as a partial clear of the full-extraction degradation
        evaluateDegradation.extractStaticNodes.liteRecovery = true;
        console.log(`[phase1-lite] recovered ${liteResult.nodes.length} semantic nodes via lite extraction`);
      } else {
        console.log(`[phase1-lite] lite extraction also yielded 0 nodes (${liteResult.extractedVia}) — will try full retry`);
      }
    }

    // Warn if URL changed between screenshot and DOM extraction
    if (screenshotCapturedAtUrl && staticNodesExtractedAtUrl &&
        screenshotCapturedAtUrl !== staticNodesExtractedAtUrl) {
      console.log(
        `[phase1] WARNING — URL drift: screenshot@${screenshotCapturedAtUrl} ` +
        `vs DOM@${staticNodesExtractedAtUrl}`
      );
      if (!analysisQualityNote) {
        analysisQualityNote =
          'screenshot was captured on final page state, but DOM extraction happened after execution context changed';
      }
    }

    // Quality gate (first pass) — determines whether to retry
    const screenshotExists = (await fs.stat(baselinePng).then((s) => s.size > 0).catch(() => false));
    const firstPassQuality = computePhase1Quality({
      evaluateDegradation,
      allNodes: nodeResult.nodes,
      pageLinks,
      screenshotExists,
      postAuthMode,
    });
    console.log(
      `[phase1] quality gate (first pass): ${firstPassQuality.phase1QualityState}` +
      ` nodes=${firstPassQuality.rawNodeCount} links=${firstPassQuality.totalLinks}` +
      ` domOk=${firstPassQuality.domExtractionSucceeded}` +
      (firstPassQuality.emptyResultCause ? ` cause=${firstPassQuality.emptyResultCause}` : '') +
      (liteExtractionUsed ? ' [lite-mode]' : '')
    );

    // Analysis retry — when first pass yielded 0 nodes, attempt once more in a fresh defended context
    let analysisRetryAttempted    = false;
    let analysisRetrySucceeded    = false;
    let analysisRetryImprovedNodeCount = 0;
    const _shouldRetry = CONFIG.ANALYSIS_RETRY_ON_EMPTY_DOM &&
      storageStatePath &&   // only when we have auth credentials to reuse
      firstPassQuality.rawNodeCount === 0 &&   // lite fallback also failed
      ['screenshot_only_no_dom', 'context_destroyed_mid_analysis', 'post_auth_unstable']
        .includes(firstPassQuality.phase1QualityState);

    if (_shouldRetry) {
      console.log(`[phase1-retry] Attempting DOM re-extraction in fresh defended context (cause: ${firstPassQuality.emptyResultCause}) …`);
      analysisRetryAttempted = true;
      const retryUrl = finalEffectiveAnalysisUrl || requestUrl;

      let retryCtx = null;
      try {
        retryCtx = await createFreshContext(browser, { storageState: storageStatePath });
        await retryCtx.addInitScript(MUTATION_TRACKER_SCRIPT);
        if (navDefenseEnabled) {
          await installNavigationDefense(retryCtx);
        }

        const retryPage = await retryCtx.newPage();
        await navigateTo(retryPage, retryUrl);
        await installMutationTracker(retryPage).catch(() => {});

        // Wait for URL to settle with a stricter quiet window
        const retryStability = await waitForPostAuthStability(retryPage, {
          quietWindowMs:  Math.max(CONFIG.ANALYSIS_READY_QUIET_WINDOW_MS, 3000),
          maxWaitMs:      CONFIG.POST_AUTH_SETTLE_MS,
          pollIntervalMs: 250,
          requireBody:    true,
        });
        console.log(`[phase1-retry] URL stability: stable=${retryStability.stable} url=${retryStability.finalUrl}`);

        // Lock nav defense
        if (navDefenseEnabled) {
          await lockNavigationDefense(retryPage).catch(() => {});
        }

        // Stricter DOM readiness probe
        const retryReadiness = await probePostAuthReadiness(retryPage, {
          minElementCount:      10,
          minEvaluateSuccesses: Math.max(CONFIG.MIN_EVALUATE_SUCCESSES_BEFORE_ANALYSIS, 3),
          maxWaitMs:            CONFIG.MAX_POST_AUTH_READINESS_WAIT_MS,
          quietWindowMs:        CONFIG.POST_AUTH_READY_QUIET_WINDOW_MS,
          expectedUrl:          retryStability.finalUrl,
        });
        console.log(`[phase1-retry] DOM probe: ready=${retryReadiness.ready} score=${retryReadiness.score}`);

        // Install secondary network block
        await retryPage.route('**/*', (route) => {
          if (route.request().isNavigationRequest()) return route.abort('aborted');
          return route.continue();
        });

        // Re-extract DOM
        const retryMeta = await getPageMeta(retryPage).catch(() => null);
        const retryNodeResult = await extractStaticNodes(retryPage, CONFIG.NODE_FILTER).catch(() => null);
        const retryLinks      = await getPageLinks(retryPage).catch(() => null);

        const retryNodes     = retryNodeResult?.nodes ?? [];
        const retryPageLinks = retryLinks ?? { anchors: [], areas: [], formActions: [] };
        const retryLinkCount = (retryPageLinks.anchors?.length ?? 0) +
                               (retryPageLinks.areas?.length ?? 0) +
                               (retryPageLinks.formActions?.length ?? 0);

        console.log(`[phase1-retry] result: nodes=${retryNodes.length} links=${retryLinkCount}`);

        // Compare against nodeResult.nodes.length (allNodes not yet declared here)
        const _firstPassNodeCount = nodeResult.nodes.length;
        if (retryNodes.length > _firstPassNodeCount || retryLinkCount > 0) {
          // Retry produced better results — adopt them
          analysisRetrySucceeded          = true;
          analysisRetryImprovedNodeCount  = retryNodes.length - _firstPassNodeCount;

          // Patch the live variables that downstream code references
          nodeResult.nodes        = retryNodes;
          nodeResult.droppedNodes = retryNodeResult?.droppedNodes ?? [];
          if (retryMeta)  Object.assign(pageMeta, retryMeta);
          Object.assign(pageLinks, retryPageLinks);

          // Update URL tracking to retry context
          staticNodesExtractedAtUrl  = (() => { try { return retryPage.url(); } catch { return retryUrl; } })();
          staticNodesExtractedAtTime = new Date().toISOString();
          linksExtractedAtUrl        = staticNodesExtractedAtUrl;
          linksExtractedAtTime       = staticNodesExtractedAtTime;

          // Clear the degradation flags that triggered this retry
          if (evaluateDegradation.extractStaticNodes.degraded && retryNodes.length > 0) {
            evaluateDegradation.extractStaticNodes = { degraded: false, reason: 'cleared by successful retry' };
          }
          if (evaluateDegradation.getPageLinks.degraded && retryLinkCount > 0) {
            evaluateDegradation.getPageLinks = { degraded: false, reason: 'cleared by successful retry' };
          }

          console.log(`[phase1-retry] IMPROVED — adopted retry results (nodes +${analysisRetryImprovedNodeCount})`);
        } else {
          console.log('[phase1-retry] retry did not improve results — keeping first pass');
        }
      } catch (retryErr) {
        console.log(`[phase1-retry] retry failed: ${retryErr.message}`);
      } finally {
        if (retryCtx) {
          await retryCtx.close().catch(() => {});
        }
      }
    }

    // ── Refresh extracted data references after potential retry ───────────────
    // allNodes / droppedNodes / visibilityMismatches may have been patched by retry.

    // Final quality gate — re-evaluated after retry if one was attempted
    const finalQuality = analysisRetryAttempted
      ? computePhase1Quality({
          evaluateDegradation,
          allNodes: nodeResult.nodes,
          pageLinks,
          screenshotExists,
          postAuthMode,
        })
      : firstPassQuality;

    if (analysisRetryAttempted) {
      console.log(
        `[phase1] quality gate (after retry): ${finalQuality.phase1QualityState}` +
        ` nodes=${finalQuality.rawNodeCount} links=${finalQuality.totalLinks}`
      );
    }

    // ── REDIRECT SCOPE CHECK — final rendered URL must remain on rootHost ──────
    // A server-side redirect may navigate the browser to a different hostname.
    // Stop exploration immediately if the final rendered URL leaves the root scope.
    const finalUrl          = pageMeta.finalUrl || requestUrl;
    const finalRenderedHost = new URL(finalUrl).hostname;
    if (finalRenderedHost !== rootHost) {
      const stopReason = `final rendered URL moved to ${finalRenderedHost}, outside root host ${rootHost}`;
      console.log(`[scope] STOP (redirect) — ${stopReason}`);
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

    console.log(`[phase1] ${nodeResult.nodes.length} kept | ${nodeResult.droppedNodes.length} dropped | ${
      (pageLinks.anchors?.length ?? 0) + (pageLinks.areas?.length ?? 0) + (pageLinks.formActions?.length ?? 0)
    } raw links`);

    // ── Functional category classification ────────────────────────────────────
    // Runs in Node.js space using already-extracted node metadata.
    // Adds: functionalCategory, functionalCategoryCode, labelColor, categoryReason
    // Re-alias after potential retry patch so downstream uses fresh arrays.
    const allNodes             = nodeResult.nodes;
    const droppedNodes         = nodeResult.droppedNodes;
    const visibilityMismatches = nodeResult.visibilityMismatches ?? [];
    classifyNodes(allNodes);
    console.log('[phase1] functional categories classified');

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
      `[phase1] label filter: ${labelEligibleNodes.length}/${allNodes.length} eligible` +
      ` (mode=${CONFIG.LABEL_FILTER.labelMode}` +
      ` drop=${labelFilterStats.droppedTotal}` +
      ` decorative=${labelFilterStats.droppedDecorative}` +
      ` dup=${labelFilterStats.droppedDuplicate})`
    );

    const baselineAnnotatedPng = path.join(outDir, 'baseline-annotated.png');
    // Use only label-eligible nodes for annotation — keeps screenshots readable
    const annotatedNodes = selectAnnotationNodes(labelEligibleNodes, CONFIG.ANNOTATION_LIMIT);
    await annotateScreenshot(basePage, annotatedNodes, baselineAnnotatedPng);
    console.log('[phase1] baseline-annotated.png saved');

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
      console.log('[phase1] label-filter-debug.json saved');
    }

    // annotation-legend.json: written only in debug mode
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      const legend = buildLegend(allNodes);
      await writeJson(path.join(outDir, 'annotation-legend.json'), legend);
      console.log('[phase1] annotation-legend.json saved');
    }

    // static.json: written only in debug mode (compact mode has elements in final-report)
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await writeJson(path.join(outDir, 'static.json'), {
        pageMetadata: pageMeta,
        pageLinks,
        nodeCount:    allNodes.length,
        droppedCount: droppedNodes.length,
        nodes:        allNodes,
      });
    }

    if (CONFIG.NODE_FILTER.debugDrop) {
      await writeJson(path.join(outDir, 'filtered-node-debug.json'), {
        keptCount: allNodes.length, droppedCount: droppedNodes.length,
        config: CONFIG.NODE_FILTER, keptNodes: allNodes, droppedNodes,
      });
      console.log('[phase1] filtered-node-debug.json saved');
    }

    // visibility-debug.json: written only in debug mode
    if (CONFIG.OUTPUT_MODE !== 'compact' && visibilityMismatches.length > 0) {
      await writeJson(path.join(outDir, 'visibility-debug.json'), {
        generatedAt:     new Date().toISOString(),
        totalMismatches: visibilityMismatches.length,
        description:     'Elements where aria-hidden state contradicts actual CSS rendering. ' +
                         'These are potential false-positive sources in DOM extraction.',
        mismatches:      visibilityMismatches,
      });
      console.log(`[phase1] visibility-debug.json saved — ${visibilityMismatches.length} mismatch(es)`);
    }

    console.log('[phase1] discovering trigger candidates …');

    // ── AUTO-DYNAMIC DETECTION: observe passive mutations before candidate scan ───
    // The observation window (default 3 s) runs on the already-open basePage.
    // No user interaction happens during this window.  The mutation tracker
    // records any DOM changes caused purely by time-driven page logic.
    // Detected regions are excluded from trigger candidates and from trigger
    // result newNodes so banner/carousel noise is suppressed throughout Phase 1.
    console.log(`[phase1] observing for auto-dynamic regions (${CONFIG.AUTO_DYNAMIC_OBSERVATION_MS}ms) …`);
    const autoDynamicRegions = await detectAutoDynamicRegions(basePage, {
      observationMs: CONFIG.AUTO_DYNAMIC_OBSERVATION_MS,
      enabled:       CONFIG.DETECT_AUTO_DYNAMIC,
    });

    const allCandidates = await findTriggerCandidates(
      basePage, autoDynamicRegions, CONFIG.AUTO_DYNAMIC_OVERLAP_THRESHOLD);

    // ── Tiered probe assignment + representative sampling ──────────────────────
    // 1. Assign probe tier (deep / standard / lightweight) based on priority score
    // 2. Group by structural signature; sample up to MAX_TRIGGER_REPS_PER_GROUP
    //    representatives per group (auth-sensitive candidates are never dropped)
    // 3. Apply absolute ceiling MAX_TRIGGERS after sampling
    //
    // This avoids running 30+ identical nav-bar buttons or repeated card buttons
    // that all produce the same navigation-away result and waste 5–20 s each.
    assignProbeTiers(allCandidates);
    const sampledCandidates = groupAndSampleCandidates(allCandidates, {
      maxGroups:   CONFIG.MAX_TRIGGER_GROUPS_PER_PAGE,
      maxPerGroup: CONFIG.MAX_TRIGGER_REPS_PER_GROUP,
    });
    const candidates = sampledCandidates.slice(0, CONFIG.MAX_TRIGGERS);
    const droppedByGroupSampling = allCandidates.length - sampledCandidates.length;

    // Write auto-dynamic-regions.json (after findTriggerCandidates so
    // excludedTriggerCount values are fully populated).
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await writeJson(path.join(outDir, 'auto-dynamic-regions.json'), {
        detectionEnabled:  CONFIG.DETECT_AUTO_DYNAMIC,
        observationMs:     CONFIG.AUTO_DYNAMIC_OBSERVATION_MS,
        overlapThreshold:  CONFIG.AUTO_DYNAMIC_OVERLAP_THRESHOLD,
        regionCount:       autoDynamicRegions.length,
        regions:           autoDynamicRegions,
      });
    }
    if (autoDynamicRegions.length) {
      console.log(`[phase1] ${autoDynamicRegions.length} auto-dynamic region(s) excluded from trigger exploration`);
    }
    console.log(
      `[phase1] ${allCandidates.length} raw candidates` +
      ` | −${droppedByGroupSampling} group-sampled` +
      ` | ${candidates.length} selected for exploration`
    );
    // trigger-candidates.json: written only in debug mode
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await writeJson(path.join(outDir, 'trigger-candidates.json'), allCandidates);
    }
    await baseCtx.close();

    console.log(`[phase1] running trigger exploration … (workers=${effectiveMaxTriggerWorkers} mode=${CONFIG.TRIGGER_SCREENSHOT_MODE} screenshotPolicy=${CONFIG.TRIGGER_SCREENSHOT_POLICY})`);
    const { results: triggerResults, metrics: triggerMetrics } = await runTriggersParallel(
      browser, requestUrl, candidates, outDir, {
        maxWorkers:                      effectiveMaxTriggerWorkers,
        screenshotMode:                  CONFIG.TRIGGER_SCREENSHOT_MODE,
        screenshotPolicy:                CONFIG.TRIGGER_SCREENSHOT_POLICY,
        triggerMinDeltaScore:            CONFIG.TRIGGER_MIN_DELTA_SCORE,
        fallbackToFullPageOnClipFailure: true,
        autoDynamicRegions,
        autoDynamicOverlapThreshold:     CONFIG.AUTO_DYNAMIC_OVERLAP_THRESHOLD,
        freezeCss:                       CONFIG.FREEZE_CSS_DURING_TRIGGERS,
        authDetectionEnabled:            CONFIG.AUTH_DETECTION_ENABLED,
        authScoreThreshold:              CONFIG.AUTH_SCORE_THRESHOLD,
        authMaybeThreshold:              CONFIG.AUTH_MAYBE_THRESHOLD,
        storageStatePath,
        skipDiffDebug:                   CONFIG.OUTPUT_MODE === 'compact',
      });

    // Write per-trigger JSON artifacts only when the trigger produced an annotated screenshot.
    // Only fields relevant to the annotated output are kept — internal scoring, raw mutation
    // arrays, and intermediate node lists are stripped to keep the file lean.
    const compactTriggerNode = (n) => ({
      nodeId:                  n.nodeId,
      tagName:                 n.tagName,
      ...(n.id                 ? { id: n.id }         : {}),
      ...(n.classList?.length  ? { classList: n.classList } : {}),
      ...(n.text               ? { text: n.text }     : {}),
      ...(n.role               ? { role: n.role }     : {}),
      ...(n.type               ? { type: n.type }     : {}),
      ...(n.href               ? { href: n.href }     : {}),
      selectorHint:            n.selectorHint,
      group:                   n.group   ?? null,
      bbox:                    n.bbox,
      functionalCategory:      n.functionalCategory,
      functionalCategoryCode:  n.functionalCategoryCode,
      labelColor:              n.labelColor,
    });

    const compactTriggerResult = (r) => ({
      triggerId:           r.triggerId,
      action:              r.action,
      status:              r.status,
      probeMode:           r.probeMode,
      // What was clicked/hovered to produce this result
      target: r.target ? {
        ...(r.target.tagName      ? { tagName:      r.target.tagName }      : {}),
        ...(r.target.text         ? { text:         r.target.text }         : {}),
        ...(r.target.role         ? { role:         r.target.role }         : {}),
        ...(r.target.selectorHint ? { selectorHint: r.target.selectorHint } : {}),
        ...(r.target.group        ? { group:        r.target.group }        : {}),
        ...(r.target.bbox         ? { bbox:         r.target.bbox }         : {}),
      } : null,
      annotatedScreenshot: r.annotatedScreenshot,
      afterScreenshot:     r.afterScreenshot,
      mutationCount:       r.mutationCount,
      deltaLabelNodesCount: r.deltaLabelNodesCount,
      newRegions:          r.newRegions,
      deltaLabelNodes:     (r.deltaLabelNodes ?? []).map(compactTriggerNode),
      summary:             r.summary,
      durationMs:          r.durationMs,
      startedAt:           r.startedAt,
    });

    await Promise.all(
      triggerResults
        .filter((r) => r.annotatedScreenshot != null)
        .map((r) => writeJson(path.join(trigResultDir, `${r.triggerId}.json`), compactTriggerResult(r))));

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
      console.log(`[phase1] trigger ${result.triggerId} → ${result.status} (${result.durationMs ?? '?'}ms) | ${result.summary}`);
    }

    const authSensitiveTriggerCount = allCandidates.filter((c) => c.authSensitiveHint).length;

    // Collect defense state before closing context (page.evaluate may fail if locked+navigated)
    const finalDefenseState = navDefenseApplied ? (await getDefenseState(basePage)) : null;
    if (finalDefenseState) {
      blockedNavigationCount += finalDefenseState.blocked;
    }

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
      evaluateDegradation,
    };

    console.log('[phase1] complete');


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
      console.log(`[phase1] ${authGatedDiscoveries.length} auth-gated page(s) discovered via trigger navigation`);
    }

    const { node: inputNode, created: inputNodeCreated } = upsertNode(graph, {
      ...inputIdentity,
      representativeUrl: finalUrl,
      jobId,
    });
    console.log(`[graph] input node ${inputNodeCreated ? 'created' : 'reused'}  nodeId=${inputNode.nodeId}`);

    // Phase 2 (VLM) insertion point: between Phase 1 and Phase 3.
    console.log('[phase3] starting');

    // ── Step 1: URL extraction ─────────────────────────────────────────────────
    console.log('[phase3] extracting URL candidates …');
    const rawCandidates = extractUrls({ pageLinks, triggerResults, baseUrl: finalUrl });

    // Add URLs discovered via trigger-driven in-scope navigation.
    // These are pages the trigger found by following a navigation link (not by
    // revealing hidden DOM nodes).  They are valid content candidates but are
    // excluded from normal static-link extraction because extractUrls() only
    // processes newNodes from successful triggers, not navigated_to_in_scope_page
    // results.
    rawCandidates.push(...triggerNavCandidates);

    console.log(`[phase3] ${rawCandidates.length} raw candidates (${triggerNavCandidates.length} from trigger navigation)`);

    // ── Step 2: Hostname + path-based filtering & dedup ────────────────────────
    console.log('[phase3] filtering URLs (exact hostname, path dedup) …');
    const filtered = filterUrls(rawCandidates, {
      baseUrl:                  finalUrl,
      maxDiscoveredUrlsPerPage: CONFIG.MAX_URLS,
    });
    console.log(`[phase3] ${filtered.length} after filter`);

    // ── Step 3: Graph-aware classification ────────────────────────────────────
    // Determine which candidates are truly new vs. already known/analyzed.
    // Only truly new candidates receive a live pre-flight check.
    console.log('[phase3] classifying against graph …');
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
    console.log(`[phase3] ${newCount} new (need preflight) | ${skipCount} graph-skipped`);

    // ── Step 4: Pre-flight only new candidates ─────────────────────────────────
    const authRules = await loadAuthRules();
    console.log(`[phase3] ${authRules.length} auth rule(s) loaded`);

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
            console.log(`[phase3] preflight ${pfIdx + 1}/${pfCandidates.length} — ${candidate.normalizedUrl}`);

            let pf = await checkReachability(candidate.normalizedUrl, apiCtx);

            if (pf.reachableClass === 'auth_required') {
              const rule = matchAuthRule(candidate.normalizedUrl, authRules);
              if (rule) {
                console.log(`[phase3] → auth rule "${rule.ruleId}" matched, retrying …`);
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

            console.log(`[phase3] → ${candidate.decision}`);
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
      console.log(`[graph] auth-gated: ${authGatedNodeCreatedCount} node(s) + ${authGatedEdgeCreatedCount} edge(s) created`);
    }

    // ── Step 6: Build queue artifact ──────────────────────────────────────────
    console.log('[phase3] building next-queue.json …');
    const queueItems = buildQueue({
      candidates:        classifiedCandidates,
      sourceNodeId:      inputNode.nodeId,
      jobId,
      discoveredFromUrl: finalUrl,
    });
    // next-queue.json: written only in debug mode (compact mode has nextCandidates in final-report)
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await writeJson(path.join(outDir, 'next-queue.json'), queueItems);
    }

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

    console.log(`[phase3] ${queueReadyCount} enqueue_now | ${holdCount} held | ${skippedCount} skipped`);
    console.log('[phase3] complete');

    // Mark input node analyzed — use quality gate state so we never write 'success' on empty DOM
    const currentPageStatus = finalQuality.phase1QualityState;
    const graphStatusWritten = currentPageStatus;
    markNodeAnalyzed(graph, inputIdentity.dedupKey, currentPageStatus, {
      domNodeCount:                    finalQuality.rawNodeCount,
      linkCount:                       finalQuality.totalLinks,
      emptyResultCause:                finalQuality.emptyResultCause ?? null,
      degradedBecauseContextDestroyed: finalQuality.emptyResultCause === 'empty_due_to_context_destruction',
    });
    console.log(`[graph] marked analyzed — status=${currentPageStatus} nodes=${finalQuality.rawNodeCount} links=${finalQuality.totalLinks}`);

    // per-page graph snapshot: skip in compact mode (crawl-level graph-snapshot is sufficient)
    if (CONFIG.OUTPUT_MODE !== 'compact') {
      await saveSnapshot(outDir, graph);
      console.log(`[graph] saved  nodes=${Object.keys(graph.nodes).length}  edges=${Object.keys(graph.edges).length}`);
    }

    const finishedAt = new Date().toISOString();
    const jobDirName = path.basename(outDir);

    const finalReport = {
      jobId,
      startedAt,
      finishedAt,
      currentPageStatus,

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
        displayPath:      inputIdentity.displayPath ?? inputIdentity.normalizedPath,
        dedupKey:         inputIdentity.dedupKey,
        nodeId:           inputNode.nodeId,
        graphNodeCreated: inputNodeCreated,
      },

      // SPA post-auth stability + quality report
      spaStability: {
        // Whether this page was opened with an authenticated storageState
        authContextUsed:                 postAuthMode,
        storageStateApplied:             postAuthMode,
        // Whether the addInitScript navigation defense was installed
        navigationDefenseEnabled:        navDefenseEnabled,
        // Whether the defense was successfully locked before DOM extraction
        navigationDefenseLocked:         navDefenseApplied,
        // Number of navigation attempts suppressed by the JS-level defense
        // (pushState, location.assign, etc.) after the lock was activated
        blockedNavigationCountJsLevel:   finalDefenseState?.blocked ?? 0,
        // Number of navigation attempts suppressed by the network-level route()
        blockedNavigationCountNetwork:   blockedNavigationCount - (finalDefenseState?.blocked ?? 0),
        blockedNavigationTotal:          blockedNavigationCount,
        // Whether a second-pass re-entry to the settled URL was performed
        analysisRetriedAfterAuth:        analysisContextReused,
        // Whether post-auth URL stability check succeeded within time budget
        postAuthStabilizationSucceeded:  postAuthStabilizationResult?.stable ?? null,
        postAuthStabilizationWaitedMs:   postAuthStabilizationResult?.waitedMs ?? null,
        postAuthUrlChanges:              postAuthStabilizationResult?.urlChanges ?? null,
        postAuthStabilizationReason:     postAuthStabilizationResult?.reason ?? null,
        // The URL the page finally settled on before DOM analysis ran
        finalEffectiveAnalysisUrl,
        // Whether any page.evaluate() call fell back to empty due to context destruction
        degradedBecauseContextDestroyed: finalQuality.emptyResultCause === 'empty_due_to_context_destruction',
        degradedBecausePostAuthUnstable: postAuthMode && finalQuality.phase1QualityState === 'post_auth_unstable',
        evaluateDegradation,
        // Post-auth DOM readiness probe result
        postAuthDomProbe: postAuthDomProbeResult
          ? {
              ready:           postAuthDomProbeResult.ready,
              score:           postAuthDomProbeResult.score,
              waitedMs:        postAuthDomProbeResult.waitedMs,
              passedSignals:   postAuthDomProbeResult.passedSignals,
              failedSignals:   postAuthDomProbeResult.failedSignals,
              evaluateFailures:postAuthDomProbeResult.evaluateFailures,
              reason:          postAuthDomProbeResult.reason,
            }
          : null,
        // URL/time tracking — screenshot vs DOM extraction
        screenshotCapturedAtUrl,
        screenshotCapturedAtTime,
        staticNodesExtractedAtUrl,
        staticNodesExtractedAtTime,
        linksExtractedAtUrl,
        linksExtractedAtTime,
        screenshotDomUrlDrift: screenshotCapturedAtUrl && staticNodesExtractedAtUrl &&
          screenshotCapturedAtUrl !== staticNodesExtractedAtUrl
            ? `screenshot@${screenshotCapturedAtUrl} vs DOM@${staticNodesExtractedAtUrl}`
            : null,
        // Analysis retry tracking
        analysisRetryAttempted,
        analysisRetrySucceeded,
        analysisRetryImprovedNodeCount,
        // Lite-mode fallback tracking
        liteExtractionUsed,
        // Quality gate fields
        phase1QualityState:       finalQuality.phase1QualityState,
        domExtractionSucceeded:   finalQuality.domExtractionSucceeded,
        linksExtractionSucceeded: finalQuality.linksExtractionSucceeded,
        emptyResultCause:         finalQuality.emptyResultCause,
        // Graph status fields
        graphStatusWritten,
        graphStatusShouldBe:      finalQuality.phase1QualityState,
        // Human-readable quality note explaining what happened
        analysisQualityNote:             analysisQualityNote ??
          (postAuthMode
            ? 'login succeeded; analysis ran in a fresh authenticated context with navigation defense'
            : null),
        humanReadableNotes: buildHumanReadableNotes({
          phase1QualityState:    finalQuality.phase1QualityState,
          screenshotExists,
          analysisRetryAttempted,
          analysisRetrySucceeded,
          emptyResultCause:      finalQuality.emptyResultCause,
          postAuthMode,
        }),
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
          probeMode: c.probeMode ?? null,
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

      // Render readiness — Full artifact: outputs/{jobId}/render-readiness.json
      renderReadiness: {
        degradedMode:    readinessResult.degradedMode,
        readinessScore:  readinessResult.readinessScore,
        passedSignals:   readinessResult.passedSignals,
        totalSignals:    readinessResult.totalSignals,
        message:         readinessResult.message ?? null,
        artifactFile:    toRelPath('outputs', jobDirName, 'render-readiness.json'),
      },

      // Frame summary — Full artifact: outputs/{jobId}/frame-summary.json
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

    // Write the report — compact (default) gives a lean QA-oriented model;
    // debug mode writes the full extraction detail for diagnosis.
    const reportToWrite = CONFIG.OUTPUT_MODE === 'compact'
      ? buildCompactReport({
          jobId,
          startedAt,
          finishedAt,
          currentPageStatus,
          outputMode: CONFIG.OUTPUT_MODE,
          originalUrl,
          requestUrl,
          finalUrl,
          rootHost,
          pageMeta,
          inputIdentity,
          inputNode,
          inputNodeCreated,
          allNodes,
          allCandidates,
          triggerResults,
          authGatedDiscoveries,
          phase1Summary,
          finalQuality,
          analysisQualityNote,
          evaluateDegradation,
          screenshotCapturedAtUrl,
          staticNodesExtractedAtUrl,
          postAuthMode,
          analysisRetryAttempted,
          analysisRetrySucceeded,
          liteExtractionUsed,
          stabResult,
          queueItems,
          queueReadyCount,
          holdCount,
          skippedCount,
          graphNodeCreatedCount,
          graphEdgeCreatedCount,
          jobDirName,
          toRelPath,
        })
      : finalReport;

    await writeJson(path.join(outDir, 'final-report.json'), reportToWrite);
    console.log(`[runAnalysis] done → ${outDir}  outputMode=${CONFIG.OUTPUT_MODE}`);

    return {
      outputPath:        outDir,
      currentPageStatus,   // analyzed_new_page | context_destroyed_mid_analysis | auth_succeeded_but_post_auth_unstable
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
        // displayPath: human-readable decoded path, safe for graph labels and UI.
        // Never use internalPageId or artifactSafeName as a display label.
        normalizedPath:   inputIdentity.normalizedPath,
        displayPath:      inputIdentity.displayPath ?? inputIdentity.normalizedPath,
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
