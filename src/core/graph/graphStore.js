/**
 * core/graph/graphStore.js
 *
 * Persistent graph storage.
 *
 * STORAGE LOCATIONS
 * ─────────────────
 * Persistent graph  : data/page-graph.json          (project root, survives across runs)
 * Per-job snapshot  : outputs/{jobId}/graph-snapshot.json  (point-in-time for debugging)
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
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// src/core/graph/ → 3 levels up → project root
export const GRAPH_PATH = path.resolve(__dirname, '..', '..', '..', 'data', 'page-graph.json');

const _empty = () => ({ nodes: {}, edges: {} });

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load the persistent graph.
 * Returns an empty graph structure if the file does not yet exist.
 *
 * @returns {Promise<{ nodes: object, edges: object }>}
 */
export async function loadGraph() {
  try {
    const raw = await fs.readFile(GRAPH_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return _empty();
    throw err;
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

/**
 * Persist the graph to disk.
 * Creates the data/ directory if it does not exist.
 *
 * @param {{ nodes: object, edges: object }} graph
 */
export async function saveGraph(graph) {
  await fs.mkdir(path.dirname(GRAPH_PATH), { recursive: true });
  await fs.writeFile(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf8');
}

/**
 * Write a point-in-time snapshot of the graph to the job output directory.
 * Useful for inspecting which graph state existed at the time of a specific job.
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
