/**
 * core/graph/graphStore.js
 *
 * Per-request in-memory graph.
 *
 * The graph is no longer persisted to disk between requests.
 * Each job starts with a fresh empty graph.
 * The only disk artefact is the per-job snapshot written by saveSnapshot().
 *
 * GRAPH FORMAT
 * ────────────
 * {
 *   "nodes": { "<dedupKey>": NodeObject, ... },
 *   "edges": { "<edgeId>":  EdgeObject, ... }
 * }
 *
 * Nodes are keyed by dedupKey (`${hostname}${normalizedPath}`) for O(1) lookup.
 * Edges are keyed by edgeId (UUID) and found via linear scan on (from, to) pairs.
 */

import fs   from 'fs/promises';
import path from 'path';

const _empty = () => ({ nodes: {}, edges: {} });

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Return a brand-new empty graph for a single job/request.
 * No file I/O — the graph lives only in memory for the duration of the request.
 *
 * @returns {{ nodes: object, edges: object }}
 */
export function createGraph() {
  return _empty();
}

// ── Snapshot ──────────────────────────────────────────────────────────────────

/**
 * Write a point-in-time snapshot of the graph to the job output directory.
 * Useful for inspecting the graph state that existed during a specific job.
 *
 * @param {string} outDir - Absolute path to the job output directory
 * @param {{ nodes: object, edges: object }} graph
 */
export async function saveSnapshot(outDir, graph) {
  const snapshotPath = path.join(outDir, 'graph-snapshot.json');
  const nodeCount    = Object.keys(graph.nodes).length;
  const edgeCount    = Object.keys(graph.edges).length;
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({ nodeCount, edgeCount, nodes: graph.nodes, edges: graph.edges }, null, 2),
    'utf8',
  );
}
