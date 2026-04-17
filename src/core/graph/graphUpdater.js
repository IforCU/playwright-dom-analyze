/**
 * core/graph/graphUpdater.js
 *
 * Mutates the in-memory graph produced by graphStore.createGraph().
 * All functions accept the graph as first parameter and mutate it in-place.
 * The graph is per-request; call graphStore.saveSnapshot() to write a
 * point-in-time artifact for debugging — no global file is ever written.
 *
 * DUPLICATE PREVENTION (within a single request/crawl run)
 * ─────────────────────────────────────────────────────────
 * findNode() + node.analyzed lets the caller skip Phase 1 for pages that
 * have already been analyzed within the same run.  Because the graph is
 * per-request, this only prevents revisits inside one crawl, not across runs.
 */

import { createNode, createEdge } from './graphModel.js';

// ── Node operations ───────────────────────────────────────────────────────────

/**
 * Look up a node by dedupKey.
 * Returns null if not found.
 *
 * @param {{ nodes: object, edges: object }} graph
 * @param {string} dedupKey
 * @returns {object|null}
 */
export function findNode(graph, dedupKey) {
  return graph.nodes[dedupKey] ?? null;
}

/**
 * Create a new node or update an existing one.
 *
 * If the node does not exist: create it.
 * If the node already exists:
 *   - update lastSeenAt
 *   - append jobId if not already present
 *   - append representativeUrl to discoveredVariants if not already present
 *
 * @param {{ nodes: object, edges: object }} graph
 * @param {{ hostname, normalizedPath, dedupKey, representativeUrl, jobId }} opts
 * @returns {{ node: object, created: boolean }}
 */
export function upsertNode(graph, { hostname, normalizedPath, dedupKey, representativeUrl, jobId, authGated = false }) {
  const existing = graph.nodes[dedupKey];
  if (existing) {
    existing.lastSeenAt = new Date().toISOString();
    if (!existing.discoveredByJobIds.includes(jobId)) {
      existing.discoveredByJobIds.push(jobId);
    }
    if (!existing.discoveredVariants.includes(representativeUrl)) {
      existing.discoveredVariants.push(representativeUrl);
    }
    // Promote authGated flag if new discovery reveals auth nature
    if (authGated && !existing.authGated) {
      existing.authGated = true;
    }
    return { node: existing, created: false };
  }

  const node = createNode({ hostname, normalizedPath, dedupKey, representativeUrl, jobId, authGated });
  graph.nodes[dedupKey] = node;
  return { node, created: true };
}

/**
 * Mark a node as having been fully analyzed (Phase 1 complete).
 * Sets analyzed=true, analyzedAt, and analysisStatus.
 *
 * @param {{ nodes: object }} graph
 * @param {string} dedupKey
 * @param {'success'|'failed'} [status='success']
 */
export function markNodeAnalyzed(graph, dedupKey, status = 'success') {
  const node = graph.nodes[dedupKey];
  if (!node) return;
  node.analyzed       = true;
  node.analyzedAt     = new Date().toISOString();
  node.analysisStatus = status;
}

/**
 * Record the most recent reachability status from a pre-flight check.
 *
 * @param {{ nodes: object }} graph
 * @param {string} dedupKey
 * @param {string} reachabilityStatus  - e.g. 'reachable_now', 'auth_required'
 */
export function updateNodeReachability(graph, dedupKey, reachabilityStatus) {
  const node = graph.nodes[dedupKey];
  if (!node) return;
  node.lastReachabilityStatus = reachabilityStatus;
}

// ── Edge operations ───────────────────────────────────────────────────────────

/**
 * Create a directed edge or reuse an existing one for the same (from, to) pair.
 * Only one edge is kept per directed pair regardless of how many times the
 * link is discovered.
 *
 * @param {{ nodes: object, edges: object }} graph
 * @param {{ fromNodeId, toNodeId, jobId, discoverySource, triggerId?, representativeUrl }} opts
 * @returns {{ edge: object, created: boolean }}
 */
export function upsertEdge(graph, {
  fromNodeId, toNodeId, jobId, discoverySource, triggerId,
  representativeUrl, edgeType, requiresAuth, authDetected, authScore, navigationStatus,
}) {
  // Linear scan — acceptable for a local toy-project graph
  const existing = Object.values(graph.edges).find(
    (e) => e.fromNodeId === fromNodeId && e.toNodeId === toNodeId,
  );
  if (existing) {
    return { edge: existing, created: false };
  }

  const edge = createEdge({
    fromNodeId, toNodeId, jobId, discoverySource, triggerId,
    representativeUrl, edgeType, requiresAuth, authDetected, authScore, navigationStatus,
  });
  graph.edges[edge.edgeId] = edge;
  return { edge, created: true };
}
