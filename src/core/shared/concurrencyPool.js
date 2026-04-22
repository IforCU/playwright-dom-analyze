/**
 * core/shared/concurrencyPool.js
 *
 * Bounded-concurrency worker pool used by both the web-analysis crawler
 * (BFS frontier pages) and the QA execution engine (scenarios in a suite).
 *
 * USAGE
 * ─────
 *   const results = await processWithConcurrency(items, 4, async (item, slot) => {
 *     return await doWork(item);
 *   });
 *
 * GUARANTEES
 * ──────────
 * 1. At most `maxConcurrent` invocations of `fn` are in flight at any time.
 * 2. Items are dispatched as soon as a worker slot is available — there is no
 *    "wait for the whole batch" barrier between items inside one call.
 * 3. The returned `results` array is index-stable: results[i] corresponds to
 *    items[i], regardless of completion order.
 * 4. The provided `fn` MUST NEVER throw.  It should catch internally and
 *    return a result object that carries the error.  This contract preserves
 *    index-stability and keeps a single rogue task from poisoning the pool.
 *
 * OPTIONAL EARLY ABORT
 * ────────────────────
 * Pass `shouldAbort` (sync predicate over the accumulated results so far) to
 * stop dispatching NEW tasks after a condition is met.  Items already in
 * flight are still awaited — JS has no preemptive cancellation.  Items that
 * never started receive `{ skipped: true, item }` instead of being dispatched.
 *
 * @template T, R
 * @param {T[]} items                                    - work items
 * @param {number} maxConcurrent                         - upper bound on in-flight tasks (≥ 1)
 * @param {(item: T, slotIndex: number) => Promise<R>} fn - worker function (must not throw)
 * @param {{ shouldAbort?: (resultsSoFar: R[]) => boolean }} [opts]
 * @returns {Promise<Array<R | { skipped: true, item: T }>>}
 */
export async function processWithConcurrency(items, maxConcurrent, fn, opts = {}) {
  if (items.length === 0) return [];

  const { shouldAbort = null } = opts;
  let slots   = Math.max(1, Math.floor(maxConcurrent));
  const waiters = [];
  const accumulated = []; // for shouldAbort decisions only — not the final return

  function acquire() {
    if (slots > 0) { slots--; return Promise.resolve(); }
    return new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    if (waiters.length > 0) waiters.shift()();
    else slots++;
  }

  return Promise.all(
    items.map(async (item, i) => {
      await acquire();
      try {
        if (shouldAbort && shouldAbort(accumulated)) {
          return { skipped: true, item };
        }
        const result = await fn(item, i);
        accumulated.push(result);
        return result;
      } finally {
        release();
      }
    })
  );
}
