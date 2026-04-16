/**
 * core/phase1/parallelTriggerRunner.js
 *
 * Bounded concurrent trigger-candidate exploration.
 *
 * DESIGN
 * ──────
 * After the trigger candidate list is finalized (baseline phase is complete),
 * this module runs all candidates concurrently using a simple worker-pool
 * pattern with a configurable concurrency limit.
 *
 * Worker-pool pattern
 * ───────────────────
 * A shared index (nextIdx) is consumed synchronously by each worker:
 *   - Node.js is single-threaded: nextIdx++ is never preempted between workers.
 *   - Each worker loops: claim index → await runTrigger → write result → repeat.
 *   - Up to maxWorkers tasks run simultaneously; each awaits its own runTrigger().
 *
 * Isolation guarantee
 * ───────────────────
 * runTrigger() opens a fresh browser context per candidate every time.
 * No page or context instance is ever shared between concurrent workers.
 * A crash in one worker does not affect others; the result slot is marked failed.
 *
 * Result ordering
 * ───────────────
 * Results are written to a pre-allocated array at the pre-claimed index.
 * Output order always matches input candidate order, regardless of finish order.
 *
 * Performance metrics
 * ───────────────────
 * Returns per-run timing alongside an aggregate metrics object suitable for
 * direct inclusion in final-report.json → phase1.summary.triggerPerformance.
 */

import { runTrigger } from './triggerRunner.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run all trigger candidates concurrently with a bounded worker pool.
 *
 * @param {import('playwright').Browser} browser
 * @param {string}   url        - Page URL re-navigated independently per worker
 * @param {object[]} candidates - Frozen trigger candidate list (must not mutate during run)
 * @param {string}   outDir     - Absolute job output directory
 * @param {{
 *   maxWorkers?:                      number,   // default 4
 *   screenshotMode?:                  string,   // default 'changedRegion'
 *   fallbackToFullPageOnClipFailure?: boolean,  // default true
 *   autoDynamicRegions?:              object[], // detected auto-dynamic regions (default [])
 *   autoDynamicOverlapThreshold?:     number,   // overlap fraction for noise filtering (default 0.3)
 *   freezeCss?:                       boolean,  // pause CSS animations during trigger (default false)
 *   authDetectionEnabled?:            boolean,  // run auth classification on nav-away (default true)
 *   authScoreThreshold?:              number,   // min score for 'auth-likely' (default 5)
 *   authMaybeThreshold?:              number,   // min score for 'maybe-auth' (default 3)
 * }} config
 * @returns {Promise<{ results: object[], metrics: object }>}
 */
export async function runTriggersParallel(browser, url, candidates, outDir, config = {}) {
  const {
    maxWorkers                      = 4,
    screenshotMode                  = 'changedRegion',
    fallbackToFullPageOnClipFailure = true,
    autoDynamicRegions              = [],
    autoDynamicOverlapThreshold     = 0.3,
    freezeCss                       = false,
    authDetectionEnabled            = true,
    authScoreThreshold              = 5,
    authMaybeThreshold              = 3,
  } = config;

  if (candidates.length === 0) {
    return { results: [], metrics: _emptyMetrics(0, screenshotMode) };
  }

  const triggerOpts = {
    screenshotMode,
    fallbackToFullPageOnClipFailure,
    autoDynamicRegions,
    autoDynamicOverlapThreshold,
    freezeCss,
    authDetectionEnabled,
    authScoreThreshold,
    authMaybeThreshold,
  };

  // Pre-allocate slots — preserves input order regardless of completion order
  const results   = new Array(candidates.length).fill(null);
  const durations = new Array(candidates.length).fill(0);

  // Shared index — synchronously consumed (single-threaded JS: no race condition)
  let nextIdx = 0;

  const poolStart = Date.now();

  /**
   * One worker: claims candidates one at a time until the queue is exhausted.
   * Each claim is a synchronous nextIdx++ — safe in Node.js without a mutex.
   */
  async function worker(workerSlot) {
    while (true) {
      const myIdx = nextIdx++; // synchronous claim — another worker cannot claim the same index
      if (myIdx >= candidates.length) break;

      const candidate  = candidates[myIdx];
      const t0         = Date.now();

      // runTrigger creates its own fresh context — full isolation per candidate
      const raw        = await runTrigger(browser, url, candidate, outDir, triggerOpts);
      const durationMs = Date.now() - t0;

      results[myIdx]   = { ...raw, startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(), durationMs, workerSlot };
      durations[myIdx] = durationMs;
    }
  }

  const workerCount = Math.min(maxWorkers, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, (_, i) => worker(i)));

  const totalMs   = Date.now() - poolStart;
  const validD    = durations.filter((d) => d > 0);
  const averageMs = validD.length ? Math.round(validD.reduce((a, b) => a + b, 0) / validD.length) : 0;
  const slowestMs = validD.length ? Math.max(...validD) : 0;

  return {
    results,
    metrics: {
      triggerParallelismEnabled:  true,
      maxParallelTriggerWorkers:  workerCount,
      screenshotMode,
      triggerExecutionTotalMs:    totalMs,
      averageTriggerDurationMs:   averageMs,
      slowestTriggerDurationMs:   slowestMs,
    },
  };
}

// ── Private ────────────────────────────────────────────────────────────────────

function _emptyMetrics(workers, screenshotMode) {
  return {
    triggerParallelismEnabled:  true,
    maxParallelTriggerWorkers:  workers,
    screenshotMode,
    triggerExecutionTotalMs:    0,
    averageTriggerDurationMs:   0,
    slowestTriggerDurationMs:   0,
  };
}
