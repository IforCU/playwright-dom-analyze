/**
 * core/crawl/crawlRunner.js
 *
 * BFS multi-page crawl orchestrator.
 *
 * DESIGN
 * ──────
 * Given a starting URL the runner explores as many reachable in-scope pages
 * as possible within the configured limits using a breadth-first queue.
 *
 * One shared Browser instance is reused across all pages to avoid the startup
 * overhead of launching a new process per page.  Each page analysis still gets
 * its own BrowserContext (fresh cookies, localStorage) as required by runAnalysis.
 *
 * A single in-memory graph object is shared across all pages and persisted once
 * after the crawl completes (plus a per-page snapshot for debugging).
 *
 * SCOPE RULE
 * ──────────
 * Only URLs whose hostname EXACTLY matches the hostname of originalUrl are
 * eligible for analysis.  Subdomains are treated as separate hosts and are
 * never enqueued as content pages (they may still be auth helpers).
 *
 * CREDENTIAL SAFETY
 * ─────────────────
 * Credentials passed via the API are never written to any output file.
 * They are only forwarded to authFlow.attemptGenericLogin() which uses them
 * exclusively for in-page form filling.  All log lines reference only the
 * auth host name and outcome, never the credential values themselves.
 *
 * AUTH FLOW
 * ─────────
 * If credentials are provided and a trigger navigation discovers an auth-gated
 * page, a single login attempt is made.  On success the resulting storageState
 * is applied to all subsequent page contexts.  If the attempt fails the crawl
 * continues unauthenticated.  Only one login attempt is made per crawl run.
 *
 * PER-PAGE ARTIFACTS
 * ──────────────────
 * Each page's analysis artifacts are written to:
 *   outputs/{jobId}/pages/{pageIndex}_{slug}/
 *
 * The crawl-level final report is written to:
 *   outputs/{jobId}/final-report.json
 */

import fsp  from 'fs/promises';
import path from 'path';

import { launchBrowser }                from '../browser.js';
import { createGraph,
         saveSnapshot }                  from '../graph/graphStore.js';
import { computePageIdentity }           from '../graph/graphModel.js';
import { runAnalysis }                   from '../runAnalysis.js';
import { jobOutputDir, toRelPath }       from '../utils.js';
import { attemptGenericLogin }           from './authFlow.js';
import { runPreAuthBootstrap }           from './authBootstrap.js';
import { writeCrawlGraphArtifacts }      from './graphVisualizer.js';
import { processWithConcurrency }        from '../../shared/concurrencyPool.js';

// ── Defaults ──────────────────────────────────────────────────────────────────
//
// All defaults read from environment variables so they can be tuned per
// deployment without code changes.  Request-level crawlOptions override them.

const CRAWL_DEFAULTS = {
  maxPages:                   parseInt(process.env.MAX_PAGES                      || '20', 10),
  maxDepth:                   parseInt(process.env.MAX_DEPTH                      || '5',  10),
  // Concurrency within one BFS frontier level (pages analyzed in parallel)
  maxParallelPages:           parseInt(process.env.MAX_PARALLEL_PAGES             || '3',  10),
  // Concurrent trigger workers forwarded to runAnalysis → runTriggersParallel
  // Falls back to MAX_PARALLEL_WORKERS for backward compatibility
  maxParallelTriggers:        parseInt(
    process.env.MAX_PARALLEL_TRIGGERS ?? process.env.MAX_PARALLEL_WORKERS ?? '4', 10),
  // Concurrent HTTP preflight checks forwarded to runAnalysis phase3
  maxParallelPreflightChecks: parseInt(process.env.MAX_PARALLEL_PREFLIGHT_CHECKS  || '8',  10),
};

// ── Bounded-concurrency worker pool ───────────────────────────────────────────
// Implementation moved to src/core/shared/concurrencyPool.js so that the QA
// execution engine can reuse the same primitive for parallel scenarios.
// Local alias preserved for readability of historical call sites.
const _processFrontierLevel = processWithConcurrency;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a BFS multi-page crawl starting at `originalUrl`.
 *
 * @param {{
 *   jobId:        string,
 *   originalUrl:  string,
 *   requestUrl?:  string|null,
 *   crawlOptions: {
 *     maxPages?:            number,
 *     maxDepth?:            number,
 *     maxParallelPages?:    number,
 *     maxParallelTriggers?: number,
 *   },
 *   credentials:  { username: string, password: string }|null,
 *   authHints?:   {
 *     usernameSelector?:           string,
 *     passwordSelector?:           string,
 *     submitSelector?:             string,
 *     loginUrlPattern?:            string,
 *     postLoginSuccessUrlPattern?: string,
 *   }|null,
 * }} params
 *
 * @returns {Promise<{
 *   jobId:        string,
 *   outputPath:   string,
 *   finalReport:  object,
 * }>}
 */
export async function runCrawl({ jobId, originalUrl, requestUrl = null, crawlOptions = {}, credentials = null, authHints = null }) {
  const opts       = { ...CRAWL_DEFAULTS, ...crawlOptions };
  const crawlOutDir = jobOutputDir(jobId);
  const pagesDir   = path.join(crawlOutDir, 'pages');

  await fsp.mkdir(pagesDir, { recursive: true });

  const rootHost  = new URL(originalUrl).hostname;
  const startUrl  = requestUrl ?? originalUrl;
  const startedAt = new Date().toISOString();

  console.log('\n[crawl] ═════════════════════════════════════════════════');
  console.log(`[crawl] JOB              : ${jobId}`);
  console.log(`[crawl] originalUrl      : ${originalUrl}`);
  console.log(`[crawl] startUrl         : ${startUrl}`);
  console.log(`[crawl] rootHost         : ${rootHost}`);
  console.log(`[crawl] maxPages         : ${opts.maxPages}  maxDepth: ${opts.maxDepth}  parallelPages: ${opts.maxParallelPages}`);
  console.log(`[crawl] parallelTriggers : ${opts.maxParallelTriggers}  parallelPreflight: ${opts.maxParallelPreflightChecks}`);
  console.log(`[crawl] auth             : ${credentials ? 'credentials provided' : 'unauthenticated'}`);
  console.log('[crawl] ═════════════════════════════════════════════════\n');

  // ── Frontier-based BFS state ─────────────────────────────────────────────────
  //
  // Three separate sets track page lifecycle:
  //   discovered  — dedupKeys ever added to any frontier; prevents double-enqueuing
  //                 even when multiple parallel pages discover the same child URL
  //   processing  — currently in-flight (diagnostic only, not used for dedup)
  //   visited     — completed analysis (success OR failure) — superset of processing
  //
  // Using `discovered` for dedup (not `visited`) is the key to correctness under
  // parallelism: a child URL is reserved as soon as any parent notices it, before
  // any async work begins for that child.  This is safe because JS is
  // single-threaded — the reservations happen synchronously between awaits.
  const discovered = new Set();  // dedupKey
  const visited    = new Set();  // dedupKey
  const pageResults = [];        // summary entries for final-report

  // ── Counters ─────────────────────────────────────────────────────────────────
  let pageCountAnalyzed    = 0;
  let pageCountSkipped     = 0;  // skipped (already in graph from prior run)
  let pageCountFailed      = 0;
  let pageCountOutOfScope  = 0;
  let pageCountDuplicate   = 0;
  let pageCountDepthCapped = 0;
  let maxDepthReached      = 0;
  let totalQueueEnqueued   = 0;
  let totalAuthRequired    = 0;
  let authAttempted        = 0;
  let authSucceeded        = 0;
  let authFailed           = 0;
  let pageIndex            = 0;  // monotonic counter used for directory naming
  let stopReason           = 'queue_exhausted';

  // ── Seed the first frontier ───────────────────────────────────────────────────
  let currentFrontier = [];
  {
    const startIdentity = computePageIdentity(startUrl);
    if (startIdentity && startIdentity.hostname === rootHost) {
      discovered.add(startIdentity.dedupKey);
      pageIndex++;
      const slugRaw  = startIdentity.dedupKey.replace(/[^a-zA-Z0-9]/g, '_');
      const slug     = slugRaw.length > 70 ? slugRaw.slice(0, 70) : slugRaw;
      const pageSlug = `p${String(pageIndex).padStart(3, '0')}_${slug}`;
      currentFrontier.push({
        url:      startUrl,
        depth:    0,
        identity: startIdentity,
        pageSlug,
        pageDir:  path.join(pagesDir, pageSlug),
        pageIndex,
      });
      totalQueueEnqueued = 1;
    }
  }
  let currentDepth = 0;

  // ── Shared resources (lifecycle owned here, not by runAnalysis) ──────────────
  const browser = await launchBrowser();
  const graph   = createGraph();

  // Per-crawl auth session.  Populated by bootstrap or mid-crawl auth attempt.
  let sessionStorageStatePath = null;

  // ── Pre-crawl auth bootstrap result ─────────────────────────────────────────
  // Populated below; always an object so finalReport fields are always set.
  let bootstrapResult = {
    preAuthRequired:               false,
    preAuthAttempted:              false,
    preAuthSucceeded:              false,
    preAuthFailed:                 false,
    preAuthReason:                 'skipped_no_credentials',
    preAuthLoginUrl:               null,
    preAuthAuthHost:               null,
    authenticatedSessionEstablished: false,
    storageStateGenerated:         false,
    storageStatePath:              null,
    crawlStartedAfterAuth:         false,
    stopReason:                    null,
  };

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // PRE-CRAWL AUTH BOOTSTRAP
    // ─────────────────────────────────────────────────────────────────────────
    //
    // Before BFS starts, open the starting page once to decide whether login
    // is required.  If it is and credentials are available, attempt login now.
    // Only after a successful authenticated session is established (or when no
    // auth is needed) does the BFS frontier processing begin.
    //
    // This prevents the failure mode where the crawler enqueues auth-gated
    // pages as normal work items and produces analyzed=0 / authAttempted=0.
    // ─────────────────────────────────────────────────────────────────────────

    if (credentials) {
      // Always run bootstrap when credentials are provided so we detect
      // auth-gated starts even before the first BFS page fails.
      const ssPath = path.join(crawlOutDir, `session-${jobId}.json`);
      bootstrapResult = await runPreAuthBootstrap({
        browser,
        startUrl,
        rootHost,
        credentials,
        authHints,
        storageStatePath: ssPath,
      });

      if (bootstrapResult.storageStatePath) {
        sessionStorageStatePath = bootstrapResult.storageStatePath;
        authAttempted++;
        authSucceeded++;
        console.log('[crawl] pre-auth bootstrap succeeded — BFS will use authenticated contexts');
      } else if (bootstrapResult.preAuthAttempted && bootstrapResult.preAuthFailed) {
        authAttempted++;
        authFailed++;
        console.log('[crawl] pre-auth bootstrap failed — BFS will proceed unauthenticated');
      }

      // Hard stop: auth is required and NO credentials exist — cannot proceed at all.
      // For all other bootstrap outcomes (login attempt failed, error, etc.) we
      // continue BFS unauthenticated so public pages are still crawled.
      if (bootstrapResult.stopReason === 'auth_required_no_credentials') {
        stopReason = bootstrapResult.stopReason;
        console.log('[crawl] stopping before BFS — auth required but no credentials provided');
        // Skip the BFS entirely; fall through to finally + report
        currentFrontier = [];
      } else if (bootstrapResult.stopReason) {
        // Bootstrap failed for another reason (login attempt failed, error, etc.)
        // Log it but let BFS proceed — unauthenticated crawl is still useful.
        console.log(`[crawl] pre-auth bootstrap: ${bootstrapResult.stopReason} — continuing BFS unauthenticated`);
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FRONTIER-BASED PARALLEL BFS
    // ─────────────────────────────────────────────────────────────────────────
    //
    // Outer loop: one iteration per BFS depth level.
    //   currentFrontier = all pages discovered at the current depth.
    //   nextFrontier    = pages discovered BY processing currentFrontier
    //                     (will become currentFrontier for the next depth level)
    //
    // Within one frontier level all pages are processed concurrently, bounded
    // by maxParallelPages.  The nextFrontier is only populated AFTER the entire
    // current level finishes, preserving strict BFS depth semantics.
    //
    // Deduplication is done via the `discovered` set.  A child URL is reserved
    // synchronously (JS single-threaded) as soon as any parent notices it —
    // before any async work starts for that child — so two parallel parents
    // discovering the same child URL cannot both enqueue it.
    // ─────────────────────────────────────────────────────────────────────────

    while (
      currentFrontier.length > 0 &&
      currentDepth <= opts.maxDepth &&
      (pageCountAnalyzed + pageCountFailed) < opts.maxPages
    ) {
      // Trim frontier to remaining page budget (pages already in flight don't count
      // yet, but we cap optimistically to keep the run bounded).
      const budgetRemaining = opts.maxPages - (pageCountAnalyzed + pageCountFailed);
      const activeFrontier  = currentFrontier.slice(0, budgetRemaining);
      const deferredItems   = currentFrontier.slice(budgetRemaining);
      if (deferredItems.length > 0) {
        pageCountDepthCapped += deferredItems.length;
        stopReason = 'max_pages_reached';
      }

      const depthLabel = `depth ${currentDepth}`;
      console.log(`\n[crawl] ── ${depthLabel}: ${activeFrontier.length} page(s) ── parallel≤${opts.maxParallelPages} ──────────`);
      for (const b of activeFrontier) {
        console.log(`[crawl]   page ${b.pageIndex}  depth=${b.depth}  ${b.url}`);
      }

      // ── Run all pages in this frontier level with bounded concurrency ──────
      const nextFrontier       = [];
      const levelAuthGatedUrls = [];

      const levelResults = await _processFrontierLevel(
        activeFrontier,
        opts.maxParallelPages,
        async (item, workerSlot) => {
          const startedAt = new Date().toISOString();
          const t0        = Date.now();
          try {
            const result = await runAnalysis({
              jobId,
              originalUrl,
              requestUrl:                item.url,
              sharedBrowser:             browser,
              sharedGraph:               graph,
              pageOutDir:                item.pageDir,
              storageStatePath:          sessionStorageStatePath,
              maxParallelTriggers:       opts.maxParallelTriggers,
              maxParallelPreflightChecks: opts.maxParallelPreflightChecks,
            });
            return {
              item, result, error: null, workerSlot,
              startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
            };
          } catch (err) {
            return {
              item, result: null, error: err, workerSlot,
              startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - t0,
            };
          }
        }
      );

      // ── Aggregate depth-level results ──────────────────────────────────────
      for (const { item, result, error, workerSlot, startedAt, finishedAt, durationMs } of levelResults) {
        const { url, depth, identity, pageSlug, pageIndex: bIdx } = item;
        visited.add(identity.dedupKey);

        if (error) {
          console.error(`[crawl] page ${url} FAILED: ${error.message}`);
          console.error(`[crawl]   stack: ${error.stack ?? '(no stack)'}`);
          pageCountFailed++;
          pageResults.push({
            pageIndex:       bIdx,
            url,
            depth,
            status:          'failed',
            dedupKey:        identity.dedupKey,
            // internalPageId / artifactSafeName: machine-oriented identifiers.
            // Not intended for display in graph labels or UI — use node.displayPath instead.
            internalPageId:  pageSlug,
            artifactSafeName: pageSlug,
            artifactDir:     toRelPath('outputs', jobId, 'pages', pageSlug),
            error:           error.message,
            startedAt, finishedAt, durationMs, workerSlot,
          });
          continue;
        }

        switch (result.currentPageStatus) {
          case 'analyzed_new_page':        // legacy — kept for backward compat
          case 'analyzed_successfully':
          case 'analyzed_partially':
          case 'screenshot_only_no_dom':
          case 'context_destroyed_mid_analysis':
          case 'post_auth_unstable':
          case 'auth_succeeded_but_post_auth_unstable':  // legacy alias
            // All of the above mean "we attempted analysis and produced some output."
            // Degraded results are still counted as analyzed so BFS can discover
            // any URLs that were found (even from a partially empty DOM extraction).
            pageCountAnalyzed++;
            break;
          case 'skipped_existing_page':
            pageCountSkipped++;
            pageResults.push({
              pageIndex: bIdx, url, depth,
              status:     'skipped_prior_run',
              dedupKey:   identity.dedupKey,
              internalPageId:  pageSlug,
              artifactSafeName: pageSlug,
              artifactDir: toRelPath('outputs', jobId, 'pages', pageSlug),
              startedAt, finishedAt, durationMs, workerSlot,
            });
            console.log(`[crawl] page ${bIdx} already analyzed in a prior run — skipping`);
            continue;
          case 'stopped_out_of_scope':
          case 'stopped_redirect_out_of_scope':
            pageCountOutOfScope++;
            pageResults.push({
              pageIndex: bIdx, url, depth,
              status:     result.currentPageStatus,
              dedupKey:   identity.dedupKey,
              internalPageId:  pageSlug,
              artifactSafeName: pageSlug,
              reason:     result.reason ?? null,
              artifactDir: toRelPath('outputs', jobId, 'pages', pageSlug),
              startedAt, finishedAt, durationMs, workerSlot,
            });
            continue;
          default:
            pageCountAnalyzed++;
        }

        // Collect auth-gated URLs — handled post-level to avoid auth races
        const authGated = result.authGatedUrls ?? [];
        levelAuthGatedUrls.push(...authGated);
        totalAuthRequired += authGated.length;

        // Discover next-level pages.
        // All reservations happen synchronously (JS single-threaded) so two
        // parallel workers processing the same depth level cannot both enqueue
        // the same child — the second one will find it already in `discovered`.
        const nextUrls   = result.nextQueueUrls ?? [];
        let enqueuedThis = 0;
        for (const nextUrl of nextUrls) {
          const nextId = computePageIdentity(nextUrl);
          if (!nextId)                          continue;
          if (nextId.hostname !== rootHost)     continue;
          if (discovered.has(nextId.dedupKey))  continue;  // already in a frontier or visited

          // Synchronously reserve this page identity
          discovered.add(nextId.dedupKey);
          pageIndex++;
          const slugRaw  = nextId.dedupKey.replace(/[^a-zA-Z0-9]/g, '_');
          const slug     = slugRaw.length > 70 ? slugRaw.slice(0, 70) : slugRaw;
          const pg2Slug  = `p${String(pageIndex).padStart(3, '0')}_${slug}`;
          nextFrontier.push({
            url:      nextUrl,
            depth:    depth + 1,
            identity: nextId,
            pageSlug: pg2Slug,
            pageDir:  path.join(pagesDir, pg2Slug),
            pageIndex,
          });
          totalQueueEnqueued++;
          enqueuedThis++;
        }

        const p3 = result.summary?.phase3 ?? {};
        pageResults.push({
          pageIndex:       bIdx,
          url,
          depth,
          status:          result.currentPageStatus,  // analyzed_successfully | analyzed_partially | screenshot_only_no_dom | context_destroyed_mid_analysis | post_auth_unstable | failed_analysis
          dedupKey:        identity.dedupKey,
          nodeId:          result.inputPage?.nodeId ?? null,
          // internalPageId / artifactSafeName: machine-oriented artifact directory
          // identifiers.  Not intended as display labels — use node.displayPath.
          internalPageId:  pageSlug,
          artifactSafeName: pageSlug,
          artifactDir:     toRelPath('outputs', jobId, 'pages', pageSlug),
          phase1Summary:   result.summary?.phase1 ?? null,
          nextQueueCount:  enqueuedThis,
          queueReadyCount: p3.queueReadyCount ?? 0,
          holdCount:       p3.holdCount       ?? 0,
          startedAt, finishedAt, durationMs, workerSlot,
        });

        console.log(`[crawl] page ${bIdx} analyzed — next frontier: +${enqueuedThis}  total: ${nextFrontier.length}`);
      }

      // ── Auth handling (post-level, single attempt per crawl) ──────────────
      // Collected from all pages in this level; attempt login once after all
      // results are in to avoid any parallel auth race.
      if (levelAuthGatedUrls.length > 0 && credentials && !sessionStorageStatePath && authAttempted === 0) {
        console.log(`[crawl] ${levelAuthGatedUrls.length} auth-gated URL(s) found — attempting login …`);
        for (const authUrl of levelAuthGatedUrls) {
          authAttempted++;
          const ssPath      = path.join(crawlOutDir, `session-${jobId}.json`);
          const loginResult = await attemptGenericLogin(browser, authUrl, credentials, ssPath);
          if (loginResult.success) {
            sessionStorageStatePath = loginResult.storageStatePath;
            authSucceeded++;
            console.log(`[crawl] auth succeeded via ${loginResult.authHost}`);
            break;
          } else {
            authFailed++;
            console.log(`[crawl] auth failed: ${loginResult.reason}`);
          }
        }
      }

      maxDepthReached = Math.max(maxDepthReached, currentDepth);
      currentFrontier = nextFrontier;
      currentDepth++;
    }

    // Determine stop reason from final state
    if (stopReason === 'queue_exhausted') {
      if (currentDepth > opts.maxDepth && currentFrontier.length > 0) {
        stopReason = 'max_depth_reached';
      } else if ((pageCountAnalyzed + pageCountFailed) >= opts.maxPages && currentFrontier.length > 0) {
        stopReason = 'max_pages_reached';
      }
    }

  } finally {
    // ── Persist shared resources ────────────────────────────────────────────────
    // ── Write crawl-level graph snapshot and close browser ──────────────────────
    await saveSnapshot(crawlOutDir, graph).catch(() => {});
    await browser.close().catch(() => {});
  }

  // ── Build aggregated final report ─────────────────────────────────────────────
  const finishedAt  = new Date().toISOString();
  const durationMs  = Date.now() - new Date(startedAt).getTime();

  const finalReport = {
    jobId,
    startedAt,
    finishedAt,
    durationMs,
    originalUrl,
    rootHost,
    stopReason,
    crawlOptions:        opts,
    authUsed:            !!sessionStorageStatePath,
    pageTraversalMode:   'frontier_bfs_parallel',

    // ── Pre-crawl auth bootstrap ──────────────────────────────────────────────
    preAuthRequired:               bootstrapResult.preAuthRequired,
    preAuthAttempted:              bootstrapResult.preAuthAttempted,
    preAuthSucceeded:              bootstrapResult.preAuthSucceeded,
    preAuthFailed:                 bootstrapResult.preAuthFailed,
    preAuthReason:                 bootstrapResult.preAuthReason,
    preAuthLoginUrl:               bootstrapResult.preAuthLoginUrl,
    preAuthAuthHost:               bootstrapResult.preAuthAuthHost,
    authenticatedSessionEstablished: bootstrapResult.authenticatedSessionEstablished,
    storageStateGenerated:         bootstrapResult.storageStateGenerated,
    crawlStartedAfterAuth:         bootstrapResult.crawlStartedAfterAuth,

    crawlSummary: {
      totalPagesAnalyzed:    pageCountAnalyzed,
      totalPagesSkipped:     pageCountSkipped,
      totalPagesFailed:      pageCountFailed,
      totalPagesOutOfScope:  pageCountOutOfScope,
      totalDuplicatesFound:  pageCountDuplicate,
      totalDepthCapped:      pageCountDepthCapped,
      maxDepthReached,
      totalQueueEnqueued,
      totalAuthRequired,
      authAttempted,
      authSucceeded,
      authFailed,
    },

    graphStats: {
      totalNodes: Object.keys(graph.nodes).length,
      totalEdges: Object.keys(graph.edges).length,
    },

    pages: pageResults,
  };

  await fsp.writeFile(
    path.join(crawlOutDir, 'final-report.json'),
    JSON.stringify(finalReport, null, 2),
    'utf8',
  );

  // ── Generate graph visualization artifacts ────────────────────────────────
  // Runs after the final report is built so graphData can reference its stats,
  // then the report is patched and re-written with the artifact paths.
  try {
    const vizArtifacts = await writeCrawlGraphArtifacts({
      graph,
      finalReport,
      originalUrl,
      outDir: crawlOutDir,
    });
    finalReport.graphVisualization = {
      ...vizArtifacts,
      boilerplateEdgeCount:    vizArtifacts.graphStats?.boilerplateEdgeCount    ?? 0,
      meaningfulEdgeCount:     vizArtifacts.graphStats?.meaningfulEdgeCount     ?? 0,
      hiddenBoilerplateEdgeCount: vizArtifacts.graphStats?.boilerplateEdgeCount ?? 0,
      graphVisualizationMode:  'frontier_bfs_parallel_boilerplate_suppressed',
      note: 'Open crawl-graph.html in a browser. Boilerplate nav edges are hidden by default; use the toggle button to show them.',
    };
    // Re-write final report with visualization paths included
    await fsp.writeFile(
      path.join(crawlOutDir, 'final-report.json'),
      JSON.stringify(finalReport, null, 2),
      'utf8',
    );
  } catch (vizErr) {
    console.error('[crawl] graph visualization failed (non-fatal):', vizErr.message);
  }

  console.log('\n[crawl] ══ COMPLETE ════════════════════════════════════════');
  console.log(`[crawl] pages analyzed  : ${pageCountAnalyzed}`);
  console.log(`[crawl] pages skipped   : ${pageCountSkipped}`);
  console.log(`[crawl] pages failed    : ${pageCountFailed}`);
  console.log(`[crawl] stop reason     : ${stopReason}`);
  console.log(`[crawl] duration        : ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`[crawl] output          : ${crawlOutDir}`);
  console.log('[crawl] ════════════════════════════════════════════════════\n');

  return {
    jobId,
    outputPath:  crawlOutDir,
    finalReport,
  };
}
