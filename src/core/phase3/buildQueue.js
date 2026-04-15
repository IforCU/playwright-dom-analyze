/**
 * core/phase3/buildQueue.js
 *
 * Assembles next-queue.json from graph-classified URL candidates.
 *
 * ROLE IN THE ANALYZE WORKER
 * ──────────────────────────
 * The queue file is a LOCAL ARTIFACT ONLY. This toy project does not consume
 * it recursively. In the production Spring + Kafka architecture, the Analyze
 * Worker would publish enqueue_now items to the analyze-topic so the next
 * worker can pick them up.
 *
 * ENQUEUE DECISION VOCABULARY
 * ───────────────────────────
 *   enqueue_now              new path, pre-flight reachable → eligible for future analysis
 *   hold_auth_required       new path, pre-flight returned auth challenge
 *   hold_unreachable         new path, pre-flight failed, blocked, or timed out
 *   skip_already_analyzed    path fully analyzed in a previous run (graph node.analyzed=true)
 *   skip_existing_known_page path known in graph but not yet analyzed (avoid duplicate queue)
 *   skip_duplicate_path      path is the same as the currently analyzed page
 */

import { randomUUID } from 'crypto';

/**
 * Build the next-queue.json artifact.
 *
 * @param {object}  opts
 * @param {Array}   opts.candidates         - Graph-classified candidates (from runAnalysis)
 * @param {string}  opts.sourceNodeId       - Graph nodeId of the analyzed (source) page
 * @param {string}  opts.jobId
 * @param {string}  opts.discoveredFromUrl  - Final URL of the analyzed page
 * @returns {Array<QueueItem>}
 */
export function buildQueue({ candidates, sourceNodeId, jobId, discoveredFromUrl }) {
  return candidates.map((candidate) => {
    const pf          = candidate.preflightResult;
    const isEnqueued  = candidate.decision === 'enqueue_now';

    return {
      queueItemId:        randomUUID(),
      parentJobId:        jobId,
      sourceNodeId,
      targetNodeId:       candidate.targetNode?.nodeId ?? null,
      discoveredFromUrl,
      targetUrl:          candidate.normalizedUrl,
      hostname:           candidate.hostname,
      normalizedPath:     candidate.normalizedPath,
      dedupKey:           candidate.dedupKey,
      discoveredVariants: candidate.discoveredVariants ?? [candidate.normalizedUrl],
      originType:         candidate.originType,
      discoverySource:    candidate.discoverySource,
      preflight: pf ? {
        status:             pf.status            ?? null,
        finalUrl:           pf.finalUrl           ?? candidate.normalizedUrl,
        reachable:          isEnqueued,
        reachabilityClass:  pf.reachableClass     ?? null,
        reachabilityReason: candidate.enqueueReason ?? candidate.skipReason ?? null,
        reason:             pf.reason             ?? null,
        matchedRuleId:      pf.matchedRuleId      ?? null,
        recheckedWithAuth:  pf.recheckedWithAuth   ?? false,
      } : {
        status:             null,
        finalUrl:           null,
        reachable:          false,
        reachabilityClass:  null,
        reachabilityReason: candidate.skipReason ?? 'Pre-flight not executed',
        reason:             candidate.skipReason ?? 'Skipped before pre-flight',
        matchedRuleId:      null,
        recheckedWithAuth:  false,
      },
      enqueueDecision: candidate.decision,
      enqueueReason:   candidate.enqueueReason ?? null,
      skipReason:      candidate.skipReason    ?? null,
      depth:           1,
    };
  });
}
