/**
 * core/crawl/graphVisualizer.js
 *
 * Generates human-readable visualization artifacts from BFS crawl results.
 *
 * OUTPUTS
 * ───────
 * outputs/{jobId}/crawl-graph.json   machine-readable node/edge data
 * outputs/{jobId}/crawl-graph.mmd    Mermaid flowchart source
 * outputs/{jobId}/crawl-graph.html   interactive HTML (vis-network, CDN)
 *
 * INPUT SOURCES
 * ─────────────
 * graph       — in-memory graph populated by graphUpdater during the crawl.
 *               Contains all discovered nodes (analyzed, queued, auth-gated)
 *               and all directed edges between them.
 * finalReport — aggregated crawl result with per-page status and BFS depth.
 *
 * NODE STATUS MAPPING
 * ───────────────────
 *   start        — the seed URL (originalUrl, depth 0)
 *   analyzed     — successfully crawled and fully analyzed
 *   failed       — threw an error during crawl attempt
 *   auth_gated   — login / auth-provider page discovered via trigger navigation
 *   queued       — discovered as a candidate but not visited (maxPages cap, etc.)
 *   out_of_scope — page that moved outside rootHost scope (redirect, etc.)
 *   duplicate    — seen in a prior crawl run (skipped)
 *   unknown      — in graph but cannot be classified by available data
 *
 * EDGE TYPE MAPPING
 * ─────────────────
 *   normal_discovery   — static link (a[href], form[action], meta, etc.)
 *   navigation_trigger — trigger click led to a content page
 *   auth_gate          — trigger click led to a login / auth page
 */

import fsp  from 'fs/promises';
import path from 'path';
import { computePageIdentity } from '../graph/graphModel.js';

// ── Style constants ───────────────────────────────────────────────────────────

const STATUS_FILL = {
  start:        '#FF6B9D',
  analyzed:     '#2ecc71',
  failed:       '#e74c3c',
  auth_gated:   '#FFB347',
  queued:       '#3498db',
  out_of_scope: '#95a5a6',
  duplicate:    '#7f8c8d',
  unknown:      '#f39c12',
};

const STATUS_BORDER = {
  start:        '#c0392b',
  analyzed:     '#27ae60',
  failed:       '#c0392b',
  auth_gated:   '#e67e22',
  queued:       '#2980b9',
  out_of_scope: '#7f8c8d',
  duplicate:    '#636e72',
  unknown:      '#e67e22',
};

const STATUS_FONT_COLOR = {
  start:      '#fff',
  analyzed:   '#fff',
  failed:     '#fff',
  auth_gated: '#333',
  queued:     '#fff',
  out_of_scope: '#fff',
  duplicate:  '#fff',
  unknown:    '#333',
};

const STATUS_SHAPE = {
  start:        'ellipse',
  analyzed:     'box',
  failed:       'box',
  auth_gated:   'diamond',
  queued:       'box',
  out_of_scope: 'box',
  duplicate:    'box',
  unknown:      'box',
};

const EDGE_COLOR = {
  // Meaningful discovery edges (prominent, default visible)
  content_link:          '#74C0FC',  // blue — static link from page content
  trigger_navigation:    '#2ecc71',  // green — link discovered via trigger click
  form_navigation:       '#a29bfe',  // lavender — form action destination
  auth_gate:             '#FFB347',  // orange — link leading to a login page

  // Boilerplate / repeated site-wide nav (suppressed by default)
  boilerplate_navigation: '#3a3a5c', // very dark blue-gray — barely visible
  out_of_scope_reference: '#636e72', // gray — external / out-of-scope reference

  // Aliases for backward compat with edgeType field
  normal_discovery:      '#74C0FC',
  navigation_trigger:    '#2ecc71',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Sanitize a dedupKey for use as a Mermaid node identifier. */
function mmdId(dedupKey) {
  return 'n_' + dedupKey.replace(/[^a-zA-Z0-9]/g, '_');
}

// ── Node status resolution ────────────────────────────────────────────────────

function resolveNodeStatus(dedupKey, startDedupKey, gNode, pageResult) {
  if (dedupKey === startDedupKey) return 'start';
  if (gNode.authGated) return 'auth_gated';
  if (pageResult) {
    switch (pageResult.status) {
      case 'analyzed':                          return 'analyzed';
      case 'failed':                            return 'failed';
      case 'skipped_prior_run':                 return 'duplicate';
      case 'stopped_out_of_scope':
      case 'stopped_redirect_out_of_scope':     return 'out_of_scope';
    }
  }
  if (gNode.analyzed) return 'analyzed';
  // Node is in the graph (pre-flighted, enqueue_now) but BFS never dequeued it
  return 'queued';
}

// ── Edge label ────────────────────────────────────────────────────────────────

function resolveEdgeLabel(edge) {
  if (edge.edgeType === 'auth_gate')          return 'auth gate';
  if (edge.edgeType === 'navigation_trigger') return 'trigger nav';
  const src = edge.discoverySource ?? '';
  if (src.includes('form'))    return 'form';
  if (src.includes('trigger')) return 'trigger nav';
  if (src.includes('area'))    return 'area link';
  return 'link';
}

// ── BFS depth computation ─────────────────────────────────────────────────────

/**
 * Compute BFS depths for all reachable nodes starting from startDedupKey.
 * Auth-gate edges are excluded from the traversal so auth nodes receive
 * depth from the graph topology rather than the normal content BFS tree.
 *
 * @param {object} graph
 * @param {string|null} startDedupKey
 * @param {Map<string,string>} nodeIdToDedupKey
 * @returns {Map<string,number>}
 */
function computeBfsDepths(graph, startDedupKey, nodeIdToDedupKey) {
  const depths = new Map();
  if (!startDedupKey) return depths;

  depths.set(startDedupKey, 0);

  // Build forward adjacency (non-auth edges only)
  const adj = new Map();
  for (const edge of Object.values(graph.edges)) {
    if (edge.edgeType === 'auth_gate') continue;
    const from = nodeIdToDedupKey.get(edge.fromNodeId);
    const to   = nodeIdToDedupKey.get(edge.toNodeId);
    if (!from || !to) continue;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push(to);
  }

  const queue = [startDedupKey];
  while (queue.length > 0) {
    const cur = queue.shift();
    const d   = depths.get(cur);
    for (const neighbor of (adj.get(cur) ?? [])) {
      if (!depths.has(neighbor)) {
        depths.set(neighbor, d + 1);
        queue.push(neighbor);
      }
    }
  }

  return depths;
}

// ── Core graph data builder ───────────────────────────────────────────────────

/**
 * Build a normalized { nodes, edges, stats } object from the raw in-memory
 * graph and the aggregated crawl final-report.
 *
 * @param {object} graph        - in-memory graph (createGraph + graphUpdater)
 * @param {object} finalReport  - crawlRunner final-report object
 * @param {string} originalUrl  - crawl seed URL
 * @returns {{ nodes: object[], edges: object[], stats: object, startDedupKey: string|null }}
 */
export function buildGraphData(graph, finalReport, originalUrl) {
  const startIdentity = computePageIdentity(originalUrl);
  const startDedupKey = startIdentity?.dedupKey ?? null;

  // UUID → dedupKey map for edge resolution
  const nodeIdToDedupKey = new Map();
  for (const [dk, n] of Object.entries(graph.nodes)) {
    nodeIdToDedupKey.set(n.nodeId, dk);
  }

  // dedupKey → page result from finalReport
  const pageResultMap = new Map();
  for (const page of (finalReport.pages ?? [])) {
    if (page.dedupKey) pageResultMap.set(page.dedupKey, page);
  }

  // Compute BFS depths from the graph edge structure
  const bfsDepths = computeBfsDepths(graph, startDedupKey, nodeIdToDedupKey);

  // ── Nodes ─────────────────────────────────────────────────────────────────
  const nodes = [];
  for (const [dk, gNode] of Object.entries(graph.nodes)) {
    const pageResult  = pageResultMap.get(dk);
    const depth       = pageResult?.depth ?? bfsDepths.get(dk) ?? -1;
    const status      = resolveNodeStatus(dk, startDedupKey, gNode, pageResult);

    // displayPath: human-readable label for this node.
    // Priority: gNode.displayPath (set at crawl-time from computePageIdentity)
    //   > decoded normalizedPath (fallback for older snapshots)
    //   > raw normalizedPath
    //   > '/'
    // NEVER use dedupKey, nodeId, or artifactSafeName as the display label.
    const rawDisplay  = gNode.displayPath ?? gNode.normalizedPath ?? '/';
    const p = (() => { try { return decodeURIComponent(rawDisplay); } catch { return rawDisplay; } })();
    const ph1         = pageResult?.phase1Summary ?? null;

    // Rich tooltip (HTML shown on hover in the interactive graph)
    const fillColor = STATUS_FILL[status] ?? STATUS_FILL.unknown;
    const tooltipLines = [
      `<b style="font-size:13px">${escHtml(p)}</b>`,
      `<i style="color:#aaa">${escHtml(gNode.hostname)}</i>`,
      `Status: <b style="color:${fillColor}">${status}</b>`,
      `Depth: <b>${depth >= 0 ? depth : 'unknown'}</b>`,
      gNode.authGated           ? `<span style="color:#FFB347">🔒 Auth-gated page</span>` : null,
      gNode.representativeUrl   ? `<br/><small style="color:#74C0FC">${escHtml(gNode.representativeUrl)}</small>` : null,
      ph1 ? `<br/>Components: <b>${ph1.staticComponentCount ?? 0}</b>` : null,
      ph1 ? `Triggers found: <b>${ph1.triggerCandidateCount ?? 0}</b>  run: <b>${ph1.triggerExecutedCount ?? 0}</b>` : null,
      ph1 ? `Auth-triggered: <b>${ph1.authDetectedTriggerCount ?? 0}</b>` : null,
      pageResult?.error ? `<br/><span style="color:#e74c3c">⚠ ${escHtml(String(pageResult.error).slice(0, 120))}</span>` : null,
    ].filter(Boolean).join('<br/>');

    const shortPath = p.length > 40 ? p.slice(0, 37) + '…' : p;

    nodes.push({
      id:               dk,
      nodeId:           gNode.nodeId,
      hostname:         gNode.hostname,
      normalizedPath:   gNode.normalizedPath ?? '/',
      displayPath:      p,             // human-readable label — decoded, never an internal id
      dedupKey:         dk,
      depth,
      status,
      authGated:        gNode.authGated ?? false,
      analyzed:         gNode.analyzed  ?? false,
      representativeUrl: gNode.representativeUrl ?? null,
      label:            shortPath,     // shown in graph nodes (displayPath, possibly truncated)
      depthLabel:       depth >= 0 ? `d${depth}` : '?',
      tooltip:          tooltipLines,
      phase1Summary:    ph1,
      error:            pageResult?.error ?? null,
    });
  }

  // ── Edges ─────────────────────────────────────────────────────────────────
  const rawEdges  = [];
  const seenPairs = new Set();
  for (const [edgeKey, edge] of Object.entries(graph.edges)) {
    const from = nodeIdToDedupKey.get(edge.fromNodeId);
    const to   = nodeIdToDedupKey.get(edge.toNodeId);
    if (!from || !to || from === to) continue;

    // Keep only the first edge per directed pair + type combination
    const pairKey = `${from}→${to}→${edge.edgeType ?? ''}`;
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    rawEdges.push({
      id:              edge.edgeId ?? edgeKey,
      from,
      to,
      edgeType:        edge.edgeType        ?? 'normal_discovery',
      discoverySource: edge.discoverySource ?? '',
      label:           resolveEdgeLabel(edge),
      authDetected:    edge.authDetected    ?? false,
      requiresAuth:    edge.requiresAuth    ?? false,
    });
  }

  // ── Boilerplate navigation detection ─────────────────────────────────────
  //
  // HEURISTIC (clearly labeled as such — not authoritative):
  //   A link edge is classified as boilerplate_navigation when the same
  //   destination page is referenced by many distinct source pages.
  //   This pattern is characteristic of site-wide header/footer/sidebar
  //   menus that appear on every page and create visual noise in the graph.
  //
  // Trigger edges and auth-gate edges are never boilerplate: they represent
  // meaningful exploration actions, not repeated menu decoration.
  //
  // Threshold: a target is boilerplate when it has incoming edges from
  //   >= max(2, floor(analyzedPageCount × 0.25)) distinct source pages.
  // Minimum analyzed pages to enable detection: 3 (need enough context).
  const analyzedPageCount = pageResultMap.size;

  // Count distinct source pages per target (excluding trigger/auth edges)
  const targetIncomingCount = new Map();  // to-dedupKey → count of distinct from
  for (const e of rawEdges) {
    if (e.edgeType === 'auth_gate' || e.edgeType === 'navigation_trigger') continue;
    targetIncomingCount.set(e.to, (targetIncomingCount.get(e.to) ?? 0) + 1);
  }

  const boilerplateThreshold = analyzedPageCount >= 3
    ? Math.max(2, Math.floor(analyzedPageCount * 0.25))
    : Infinity;  // not enough data to classify boilerplate

  // Out-of-scope node set for category assignment
  const outOfScopeKeys = new Set(
    nodes.filter((n) => n.status === 'out_of_scope').map((n) => n.id)
  );

  const edges = rawEdges.map((e) => {
    let edgeCategory;
    let isBoilerplateNav = false;
    let navConfidence    = 0;

    if (e.edgeType === 'auth_gate') {
      edgeCategory = 'auth_gate';
    } else if (e.edgeType === 'navigation_trigger') {
      edgeCategory = 'trigger_navigation';
    } else if (e.discoverySource?.includes('form')) {
      edgeCategory = 'form_navigation';
    } else if (outOfScopeKeys.has(e.to)) {
      edgeCategory = 'out_of_scope_reference';
    } else {
      const inCount = targetIncomingCount.get(e.to) ?? 0;
      if (inCount >= boilerplateThreshold) {
        // HEURISTIC: repeated cross-page reference — likely site-wide nav
        edgeCategory    = 'boilerplate_navigation';
        isBoilerplateNav = true;
        navConfidence    = Math.min(1.0, Math.round((inCount / Math.max(1, analyzedPageCount)) * 100) / 100);
      } else {
        edgeCategory = 'content_link';
      }
    }

    return { ...e, edgeCategory, isBoilerplateNav, navConfidence };
  });

  // ── Stats ──────────────────────────────────────────────────────────────────
  const byStatus = {};
  for (const n of nodes) byStatus[n.status] = (byStatus[n.status] ?? 0) + 1;
  const byEdgeType = {};
  for (const e of edges) byEdgeType[e.edgeType] = (byEdgeType[e.edgeType] ?? 0) + 1;
  const byEdgeCategory = {};
  for (const e of edges) byEdgeCategory[e.edgeCategory] = (byEdgeCategory[e.edgeCategory] ?? 0) + 1;

  const boilerplateEdgeCount = edges.filter((e) => e.isBoilerplateNav).length;
  const meaningfulEdgeCount  = edges.length - boilerplateEdgeCount;

  const stats = {
    totalNodes:             nodes.length,
    analyzedNodes:          (byStatus.analyzed    ?? 0) + (byStatus.start ?? 0),
    queuedNodes:            byStatus.queued       ?? 0,
    authGatedNodes:         byStatus.auth_gated   ?? 0,
    failedNodes:            byStatus.failed       ?? 0,
    outOfScopeNodes:        byStatus.out_of_scope ?? 0,
    duplicateNodes:         byStatus.duplicate    ?? 0,
    unknownNodes:           byStatus.unknown      ?? 0,
    totalEdges:             edges.length,
    meaningfulEdgeCount,
    boilerplateEdgeCount,
    contentLinkEdges:       byEdgeCategory.content_link          ?? 0,
    triggerEdges:           byEdgeCategory.trigger_navigation     ?? 0,
    formEdges:              byEdgeCategory.form_navigation        ?? 0,
    authGatedEdges:         byEdgeCategory.auth_gate              ?? 0,
    outOfScopeRefEdges:     byEdgeCategory.out_of_scope_reference ?? 0,
    // Legacy aliases kept for backward compat
    normalEdges:            byEdgeType.normal_discovery   ?? 0,
    maxDepthReached:        finalReport.crawlSummary?.maxDepthReached ?? 0,
    boilerplateThreshold:   isFinite(boilerplateThreshold) ? boilerplateThreshold : null,
    boilerplateNote:        'Edges are classified as boilerplate_navigation when the same destination ' +
                            'is linked from many pages (heuristic). They are hidden by default in the ' +
                            'HTML visualization but can be toggled on.',
  };

  return {
    jobId:        finalReport.jobId,
    originalUrl,
    generatedAt:  new Date().toISOString(),
    nodes,
    edges,
    stats,
    startDedupKey,
  };
}

// ── Mermaid generation ────────────────────────────────────────────────────────

function mmdNodeDef(node) {
  const id   = mmdId(node.id);
  // Use displayPath (already decoded, human-readable) for Mermaid labels.
  // Never use node.id (dedupKey) or internal artifact names.
  const p     = node.displayPath ?? node.normalizedPath ?? '/';
  const pDisp = p.length > 36 ? p.slice(0, 33) + '...' : p;
  const line2 = `${node.status}${node.depth >= 0 ? ' · d' + node.depth : ''}`;
  const label = `${pDisp}<br/><small>${line2}</small>`;

  switch (node.status) {
    case 'start':      return `  ${id}(["${label}"])`;
    case 'auth_gated': return `  ${id}{{"${label}"}}`;
    case 'failed':     return `  ${id}["${label}"]`;
    default:           return `  ${id}["${label}"]`;
  }
}

function mmdEdgeDef(edge) {
  const from  = mmdId(edge.from);
  const to    = mmdId(edge.to);
  const label = edge.label.replace(/"/g, "'");

  switch (edge.edgeCategory ?? edge.edgeType) {
    case 'trigger_navigation':
    case 'navigation_trigger':    return `  ${from} ==>|"${label}"| ${to}`;
    case 'auth_gate':             return `  ${from} -. "${label}" .-> ${to}`;
    case 'form_navigation':       return `  ${from} -->|"${label}"| ${to}`;
    case 'boilerplate_navigation':return `  %% [boilerplate] ${from} -.-> ${to}`;
    default:                      return `  ${from} -->|"${label}"| ${to}`;
  }
}

/**
 * Generate a Mermaid flowchart source string from graph data.
 * Nodes are grouped by BFS depth into subgraphs.
 * Auth-gated and out-of-scope nodes have their own subgraphs.
 *
 * @param {object} graphData  - output of buildGraphData()
 * @returns {string}
 */
export function generateMermaid(graphData) {
  const { nodes, edges, stats, startDedupKey, jobId, originalUrl } = graphData;
  const lines = [
    `%%{init: {'theme': 'dark', 'flowchart': {'curve': 'basis', 'diagramPadding': 20}}}%%`,
    `%% Crawl Traversal Graph`,
    `%% jobId       : ${jobId}`,
    `%% originUrl   : ${originalUrl}`,
    `%% generated   : ${new Date().toISOString()}`,
    `%%`,
    `%% NODE STATUS LEGEND`,
    `%%   start        — seed page (pink ellipse)`,
    `%%   analyzed     — successfully crawled (green)`,
    `%%   queued       — discovered but not visited (blue)`,
    `%%   auth_gated   — login / auth-provider page (orange diamond)`,
    `%%   failed       — error during crawl (red)`,
    `%%   out_of_scope — redirect left rootHost scope (gray)`,
    `%%   duplicate    — seen in prior run, skipped (dark gray)`,
    `%%`,
    `%% EDGE LEGEND`,
    `%%   -->    content link`,
    `%%   ==>    trigger navigation  (thick arrow)`,
    `%%   -.->   auth gate           (dashed)`,
    `%%   %% [boilerplate]  boilerplate nav edge (commented out, not rendered)`,
    `%%`,
    `%% STATS: nodes=${stats.totalNodes} analyzed=${stats.analyzedNodes} queued=${stats.queuedNodes} auth=${stats.authGatedNodes} failed=${stats.failedNodes} edges=${stats.totalEdges} meaningful=${stats.meaningfulEdgeCount} boilerplate=${stats.boilerplateEdgeCount}`,
    `%%`,
    `flowchart LR`,
    ``,
    `  classDef start        fill:#FF6B9D,color:#fff,stroke:#c0392b,stroke-width:3px`,
    `  classDef analyzed     fill:#2ecc71,color:#fff,stroke:#27ae60`,
    `  classDef failed       fill:#e74c3c,color:#fff,stroke:#c0392b`,
    `  classDef auth_gated   fill:#FFB347,color:#333,stroke:#e67e22`,
    `  classDef queued       fill:#3498db,color:#fff,stroke:#2980b9`,
    `  classDef out_of_scope fill:#95a5a6,color:#fff,stroke:#7f8c8d`,
    `  classDef duplicate    fill:#7f8c8d,color:#fff,stroke:#636e72`,
    `  classDef unknown      fill:#f39c12,color:#333,stroke:#e67e22`,
    ``,
  ];

  // Separate nodes into depth groups / auth group / out-of-scope group
  const depthGroups   = new Map();
  const authNodes     = [];
  const outScopeNodes = [];

  for (const node of nodes) {
    if (node.status === 'auth_gated') {
      authNodes.push(node);
    } else if (node.status === 'out_of_scope') {
      outScopeNodes.push(node);
    } else {
      const d = node.depth >= 0 ? node.depth : 999;
      if (!depthGroups.has(d)) depthGroups.set(d, []);
      depthGroups.get(d).push(node);
    }
  }

  // Depth subgraphs
  const sortedDepths = [...depthGroups.keys()].sort((a, b) => a - b);
  for (const d of sortedDepths) {
    const label = d === 999 ? 'Unknown Depth'
      : d === 0 ? `Depth 0 — Start`
      : `Depth ${d}`;
    lines.push(`  subgraph d${d}["📄 ${label}"]`);
    for (const node of depthGroups.get(d)) {
      lines.push(mmdNodeDef(node));
    }
    lines.push(`  end`);
    lines.push(``);
  }

  // Auth gateway subgraph
  if (authNodes.length > 0) {
    lines.push(`  subgraph authGroup["🔒 Auth Gateways"]`);
    for (const node of authNodes) lines.push(mmdNodeDef(node));
    lines.push(`  end`);
    lines.push(``);
  }

  // Out-of-scope subgraph
  if (outScopeNodes.length > 0) {
    lines.push(`  subgraph outGroup["⚠ Out-of-Scope / Stopped"]`);
    for (const node of outScopeNodes) lines.push(mmdNodeDef(node));
    lines.push(`  end`);
    lines.push(``);
  }

  // Edges
  lines.push(`  %% ── Edges ──────────────────────────────────`);
  for (const edge of edges) {
    lines.push(mmdEdgeDef(edge));
  }
  lines.push(``);

  // Class assignments
  lines.push(`  %% ── Class assignments ──────────────────────`);
  for (const node of nodes) {
    lines.push(`  class ${mmdId(node.id)} ${node.status}`);
  }

  return lines.join('\n');
}

// ── HTML generation ───────────────────────────────────────────────────────────

/**
 * Generate a self-contained HTML file with an interactive D3.js force graph.
 *
 * Features:
 * - D3 v7 force simulation (reliable zoom/pan/drag in any browser)
 * - BFS depth → weak forceX column layout (depth 0 left, deeper pages right)
 * - Node colors / sizes by crawl status
 * - Edge colors / dash patterns by edge category; SVG arrow markers
 * - Boilerplate edges hidden by default (auto-shown when no meaningful edges)
 * - Hover tooltip; click detail panel; double-click opens URL
 * - Sidebar: stats + legend + filter controls
 * - Node drag (click to pin, click again to unpin)
 * - Hover highlights connected nodes/edges
 * - Window resize handler
 *
 * Works as a local file:// HTML (D3 loaded from CDN).
 *
 * @param {object} graphData  - output of buildGraphData()
 * @returns {string}  complete HTML document
 */
export function generateHtml(graphData) {
  const { nodes, edges, stats, jobId, originalUrl } = graphData;

  // ── Build D3-ready node / edge data ────────────────────────────────────────
  const nodesSrc = nodes.map((n) => ({
    id:               n.id,
    label:            n.label,          // displayPath (possibly truncated) — shown on node
    depthLabel:       n.depthLabel,
    depth:            n.depth >= 0 ? n.depth : 0,
    status:           n.status,
    tooltip:          n.tooltip,
    representativeUrl: n.representativeUrl ?? null,
    hostname:         n.hostname ?? '',
    normalizedPath:   n.normalizedPath ?? '/',
    displayPath:      n.displayPath ?? n.normalizedPath ?? '/',  // human-readable path
    color:            STATUS_FILL[n.status]   ?? STATUS_FILL.unknown,
    strokeColor:      STATUS_BORDER[n.status] ?? STATUS_BORDER.unknown,
    // Visual radius per status
    radius: n.status === 'start'      ? 16
          : n.status === 'auth_gated' ? 12
          : n.status === 'analyzed'   ? 11
          : n.status === 'queued'     ? 9
          : n.status === 'failed'     ? 11
          : 8,
  }));

  // D3 forceLink uses source/target (not from/to)
  const edgesSrc = edges.map((e) => ({
    id:               e.id,
    source:           e.from,
    target:           e.to,
    label:            e.label,
    edgeCategory:     e.edgeCategory,
    isBoilerplateNav: e.isBoilerplateNav,
    isOutOfScopeRef:  e.edgeCategory === 'out_of_scope_reference',
  }));

  const safeJson = (obj) =>
    JSON.stringify(obj, null, 0).replace(/<\/script>/gi, '<\\/script>');

  const nodesSrcJson = safeJson(nodesSrc);
  const edgesSrcJson = safeJson(edgesSrc);

  const meaningfulCount   = edges.filter(e => !e.isBoilerplateNav && e.edgeCategory !== 'out_of_scope_reference').length;
  const boilerplateCount  = edges.filter(e => e.isBoilerplateNav).length;
  const outOfScopeCount   = edges.filter(e => e.edgeCategory === 'out_of_scope_reference').length;
  // When no meaningful edges, auto-show boilerplate so the graph isn't empty
  const initShowBp = meaningfulCount === 0 && boilerplateCount > 0 ? 'true' : 'false';

  // ── Legend / stat rows ──────────────────────────────────────────────────────
  const statusLegend = [
    { status: 'start',        label: 'Start page (seed URL)',       shape: 'circle' },
    { status: 'analyzed',     label: 'Analyzed (crawled)',           shape: 'box'    },
    { status: 'queued',       label: 'Queued / not visited',         shape: 'box'    },
    { status: 'auth_gated',   label: 'Auth gateway / login page',    shape: 'box'    },
    { status: 'failed',       label: 'Failed / error',               shape: 'box'    },
    { status: 'out_of_scope', label: 'Out-of-scope / stopped',       shape: 'box'    },
    { status: 'duplicate',    label: 'Duplicate (prior run)',         shape: 'box'    },
  ].map(({ status, label }) => {
    const fill   = STATUS_FILL[status]   ?? STATUS_FILL.unknown;
    const border = STATUS_BORDER[status] ?? STATUS_BORDER.unknown;
    return `<div class="legend-item">
      <div class="legend-dot" style="background:${fill};border:2px solid ${border};border-radius:${status==='start'?'50%':'3px'}"></div>
      <span>${label}</span>
    </div>`;
  }).join('\n');

  const edgeLegend = `
    <div class="edge-legend-item"><div class="edge-line" style="background:#74C0FC"></div><span>Content link</span></div>
    <div class="edge-legend-item"><div class="edge-line thick" style="background:#2ecc71"></div><span>Trigger navigation</span></div>
    <div class="edge-legend-item"><div class="edge-line" style="background:#a29bfe"></div><span>Form navigation</span></div>
    <div class="edge-legend-item"><div class="edge-line dashed-auth"></div><span>Auth gate</span></div>
    <div class="edge-legend-item"><div class="edge-line dashed-oos"></div><span style="color:#666">Out-of-scope ref <i>(hidden)</i></span></div>
    <div class="edge-legend-item"><div class="edge-line" style="background:#4a4a7c;opacity:0.5"></div><span style="color:#666">Boilerplate nav <i>(dim)</i></span></div>
  `;

  const statRows = [
    ['Total nodes',         stats.totalNodes,           ''],
    ['Analyzed',            stats.analyzedNodes,        'color:#2ecc71'],
    ['Queued/not visited',  stats.queuedNodes,          'color:#3498db'],
    ['Auth-gated',          stats.authGatedNodes,       'color:#FFB347'],
    ['Failed',              stats.failedNodes,          'color:#e74c3c'],
    ['Out-of-scope',        stats.outOfScopeNodes,      'color:#95a5a6'],
    ['Total edges',         stats.totalEdges,           ''],
    ['  Meaningful',        meaningfulCount - outOfScopeCount, 'color:#74C0FC'],
    ['  Out-of-scope refs', outOfScopeCount,            'color:#636e72;font-style:italic'],
    ['  Boilerplate (nav)', boilerplateCount,           'color:#555577;font-style:italic'],
    ['  Trigger nav',       stats.triggerEdges,         'color:#2ecc71'],
    ['  Form nav',          stats.formEdges,            'color:#a29bfe'],
    ['  Auth gate',         stats.authGatedEdges,       'color:#FFB347'],
    ['Max BFS depth',       stats.maxDepthReached,      ''],
  ].map(([k, v, style]) =>
    `<div class="stat-row"><span>${k}</span><span class="stat-val" style="${style}">${v}</span></div>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Crawl Graph — ${escHtml(jobId)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 100%; height: 100%; overflow: hidden; }
body {
  background: #0f0f1a;
  color: #e0e0e0;
  font-family: 'Segoe UI', system-ui, sans-serif;
}
#app { display: flex; flex-direction: column; height: 100vh; }

/* ── Header ── */
#header {
  padding: 7px 14px;
  background: #1a1a2e;
  border-bottom: 1px solid #2d2d4e;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
#header h1 { font-size: 13px; font-weight: 700; color: #FF6B9D; white-space: nowrap; }
#header .sub { font-size: 11px; color: #74C0FC; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── Main area ── */
#main { display: flex; flex: 1; min-height: 0; overflow: hidden; }

/* ── Graph container ── */
#graph-wrap { flex: 1; position: relative; min-width: 0; min-height: 0; background: #0f0f1a; }
#graph-svg  { position: absolute; inset: 0; width: 100%; height: 100%; cursor: grab; }
#graph-svg:active { cursor: grabbing; }

/* ── SVG styles (used by D3-rendered elements) ── */
.link { fill: none; }
.node-circle { transition: opacity 0.15s; }
.node-label  {
  font-family: 'Cascadia Code', 'Fira Mono', monospace;
  pointer-events: none;
  user-select: none;
  paint-order: stroke fill;
  stroke: #0f0f1a;
  stroke-width: 3px;
  stroke-linejoin: round;
}
.node-g { cursor: pointer; }
.node-g.pinned .node-circle { stroke-dasharray: 4 2; }

/* ── Tooltip ── */
#tooltip {
  position: fixed;
  display: none;
  background: rgba(10, 10, 28, 0.97);
  border: 1px solid #3d3d6e;
  border-radius: 7px;
  padding: 9px 13px;
  font-size: 11px;
  line-height: 1.65;
  max-width: 320px;
  max-height: 240px;
  overflow-y: auto;
  pointer-events: none;
  z-index: 100;
  word-break: break-word;
}
#tooltip b     { font-weight: 700; }
#tooltip i     { color: #999; }
#tooltip small { font-size: 10px; }

/* ── Detail panel ── */
#detail-panel {
  position: absolute;
  bottom: 12px;
  left: 12px;
  background: rgba(10, 10, 28, 0.97);
  border: 1px solid #3d3d6e;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 11px;
  line-height: 1.7;
  max-width: 340px;
  max-height: 260px;
  overflow-y: auto;
  display: none;
  z-index: 20;
  pointer-events: auto;
}
#detail-panel b     { font-weight: 700; }
#detail-panel i     { color: #999; }
#detail-panel small { font-size: 10px; word-break: break-all; }
#detail-close { float: right; cursor: pointer; font-size: 13px; opacity: 0.6; margin-left: 8px; }
#detail-close:hover { opacity: 1; }

/* ── Hint text ── */
#hint {
  position: absolute;
  bottom: 12px;
  right: 12px;
  font-size: 10px;
  color: #444;
  pointer-events: none;
  line-height: 1.7;
  text-align: right;
}

/* ── Sidebar ── */
#sidebar {
  width: 240px;
  background: #1a1a2e;
  border-left: 1px solid #2d2d4e;
  overflow-y: auto;
  padding: 10px 12px;
  flex-shrink: 0;
  font-size: 11px;
}
.sb-title {
  font-size: 10px;
  color: #FF6B9D;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin: 12px 0 6px;
  font-weight: 700;
}
.sb-title:first-child { margin-top: 0; }
.sb-hr { border: none; border-top: 1px solid #2d2d4e; margin: 8px 0; }

.stat-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 3px;
  padding-bottom: 3px;
  border-bottom: 1px solid #1e1e34;
}
.stat-val { font-weight: 700; }

.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.legend-dot { width: 13px; height: 13px; flex-shrink: 0; }

.edge-legend-item { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.edge-line { width: 28px; height: 2px; flex-shrink: 0; }
.edge-line.thick { height: 3px; }
.edge-line.dashed-auth {
  background: repeating-linear-gradient(to right, #FFB347 0, #FFB347 5px, transparent 5px, transparent 9px);
  height: 2px;
}
.edge-line.dashed-oos {
  background: repeating-linear-gradient(to right, #636e72 0, #636e72 5px, transparent 5px, transparent 9px);
  height: 2px;
}

/* ── Controls bar ── */
#controls {
  padding: 6px 12px;
  background: #1a1a2e;
  border-top: 1px solid #2d2d4e;
  display: flex;
  gap: 6px;
  align-items: center;
  flex-shrink: 0;
  flex-wrap: wrap;
}
button {
  background: #2d2d4e;
  border: 1px solid #444;
  color: #e0e0e0;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}
button:hover { background: #3d3d6e; }
#edge-count-label { font-size: 10px; color: #555; margin-left: auto; }
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <h1>🕸 Crawl Traversal Graph</h1>
    <span class="sub">Job: ${escHtml(jobId)} &nbsp;·&nbsp; ${escHtml(originalUrl)}</span>
  </div>

  <div id="main">
    <div id="graph-wrap">
      <svg id="graph-svg"></svg>
      <div id="tooltip"></div>
      <div id="detail-panel">
        <span id="detail-close" title="닫기" onclick="document.getElementById('detail-panel').style.display='none'">✕</span>
        <div id="detail-content"></div>
      </div>
      <div id="hint">드래그: 이동&nbsp;·&nbsp;스크롤: 줌<br/>클릭: 상세정보&nbsp;·&nbsp;더블클릭: URL 열기<br/>노드 드래그: 위치 고정</div>
    </div>

    <div id="sidebar">
      <div class="sb-title">Stats</div>
      ${statRows}

      <hr class="sb-hr"/>
      <div class="sb-title">Node Legend</div>
      ${statusLegend}

      <hr class="sb-hr"/>
      <div class="sb-title">Edge Legend</div>
      ${edgeLegend}

      <hr class="sb-hr"/>
      <div class="sb-title">레이아웃</div>
      <p style="font-size:10px;color:#666;line-height:1.5;margin-top:4px">
        D3 포스 레이아웃<br/>
        BFS 깊이 → 좌우 배치<br/>
        줌·패닝·드래그 지원
      </p>
    </div>
  </div>

  <div id="controls">
    <button onclick="resetZoom()">⊞ 뷰 리셋</button>
    <button onclick="toggleLabels()">🏷 라벨 토글</button>
    <button id="btn-bp"  onclick="toggleBP()"  title="Boilerplate = global nav/header/footer links (heuristic)">🔕 Show Boilerplate</button>
    <button id="btn-oos" onclick="toggleOOS()" title="Edges to out-of-scope pages — hidden by default">🔗 Show OOS Refs</button>
    <span id="edge-count-label"></span>
  </div>
</div>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
// ── Graph data ────────────────────────────────────────────────────────────────
// nodes: id, label, depth, status, color, strokeColor, radius, tooltip, representativeUrl
const NODES_SRC = ${nodesSrcJson};
// edges: id, source, target, edgeCategory, isBoilerplateNav, isOutOfScopeRef
const EDGES_SRC = ${edgesSrcJson};

// Decode any percent-encoded labels / tooltips (Korean, CJK, etc.)
(function _decode() {
  function _d(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }
  NODES_SRC.forEach(n => {
    if (n.label)          n.label          = _d(n.label);
    if (n.normalizedPath) n.normalizedPath = _d(n.normalizedPath);
    if (n.tooltip)        n.tooltip        = n.tooltip.replace(/(%[0-9A-Fa-f]{2})+/g, _d);
  });
})();

// ── Edge classification buckets ───────────────────────────────────────────────
const MEANINGFUL_EDGES  = EDGES_SRC.filter(e => !e.isBoilerplateNav && !e.isOutOfScopeRef);
const BOILERPLATE_EDGES = EDGES_SRC.filter(e =>  e.isBoilerplateNav);
const OOS_EDGES         = EDGES_SRC.filter(e =>  e.isOutOfScopeRef);

// ── State ─────────────────────────────────────────────────────────────────────
let showBP   = ${initShowBp};  // auto-true when no meaningful edges exist
let showOOS  = false;
let labelsOn = true;

// ── Edge visual styles ────────────────────────────────────────────────────────
const EDGE_STYLE = {
  content_link:           { color: '#74C0FC', width: 1.5, dash: null,    opacity: 0.75 },
  trigger_navigation:     { color: '#2ecc71', width: 3.0, dash: null,    opacity: 0.85 },
  form_navigation:        { color: '#a29bfe', width: 1.5, dash: null,    opacity: 0.75 },
  auth_gate:              { color: '#FFB347', width: 2.0, dash: '6,4',   opacity: 0.85 },
  out_of_scope_reference: { color: '#636e72', width: 1.0, dash: '5,4',   opacity: 0.55 },
  boilerplate_navigation: { color: '#4a4a7c', width: 0.8, dash: null,    opacity: 0.30 },
  normal_discovery:       { color: '#74C0FC', width: 1.5, dash: null,    opacity: 0.75 },
  navigation_trigger:     { color: '#2ecc71', width: 3.0, dash: null,    opacity: 0.85 },
};
function edgeStyle(cat) { return EDGE_STYLE[cat] || EDGE_STYLE.content_link; }

// ── SVG + Zoom setup ──────────────────────────────────────────────────────────
const svgEl  = document.getElementById('graph-svg');
const svg    = d3.select(svgEl);
const gMain  = svg.append('g').attr('id', 'g-main');
const gLinks = gMain.append('g').attr('id', 'g-links');
const gNodes = gMain.append('g').attr('id', 'g-nodes');

const zoomBehavior = d3.zoom()
  .scaleExtent([0.03, 12])
  .on('zoom', ev => gMain.attr('transform', ev.transform));
svg.call(zoomBehavior);

// ── Arrow marker defs ─────────────────────────────────────────────────────────
const defs = svg.append('defs');
const ARROW_CATS = Object.keys(EDGE_STYLE);
ARROW_CATS.forEach(cat => {
  const color = EDGE_STYLE[cat].color;
  defs.append('marker')
    .attr('id',          \`arrow-\${cat}\`)
    .attr('viewBox',     '0 -5 10 10')
    .attr('refX',        10)
    .attr('refY',        0)
    .attr('markerWidth', 6)
    .attr('markerHeight',6)
    .attr('orient',      'auto')
    .append('path')
      .attr('d',    'M0,-5L10,0L0,5')
      .attr('fill', color);
});

// ── Working node objects (D3 simulation mutates x, y, vx, vy) ────────────────
const simNodes = NODES_SRC.map(d => ({ ...d }));
const nodeById = new Map(simNodes.map(n => [n.id, n]));

// ── Force simulation ──────────────────────────────────────────────────────────
const DEPTH_SPACING = 230;  // px between BFS depth columns
const LEFT_PAD      = 180;  // px from left edge for depth-0 nodes

function svgW() { return svgEl.clientWidth  || window.innerWidth  || 800; }
function svgH() { return svgEl.clientHeight || window.innerHeight || 600; }

const simulation = d3.forceSimulation(simNodes)
  .force('link',      d3.forceLink([]).id(d => d.id).distance(110).strength(0.4))
  .force('charge',    d3.forceManyBody().strength(-480).distanceMax(700))
  .force('center',    d3.forceCenter(svgW() / 2, svgH() / 2))
  .force('collision', d3.forceCollide().radius(d => (d.radius || 10) + 20))
  // Weak X force groups nodes by BFS depth (depth 0 far left)
  .force('x_depth',   d3.forceX(d => LEFT_PAD + (d.depth || 0) * DEPTH_SPACING).strength(0.10))
  // Weak Y force keeps nodes vertically centered
  .force('y_center',  d3.forceY(svgH() / 2).strength(0.04))
  .on('tick', ticked);

// ── Tooltip ───────────────────────────────────────────────────────────────────
const tooltip = d3.select('#tooltip');

function showTip(ev, html) {
  tooltip.html(html).style('display', 'block')
    .style('left', (ev.clientX + 16) + 'px')
    .style('top',  (ev.clientY - 12) + 'px');
}
function moveTip(ev) {
  tooltip.style('left', (ev.clientX + 16) + 'px').style('top', (ev.clientY - 12) + 'px');
}
function hideTip() { tooltip.style('display', 'none'); }

// ── Detail panel ──────────────────────────────────────────────────────────────
function showDetail(d) {
  document.getElementById('detail-content').innerHTML = d.tooltip || \`<b>\${d.label}</b>\`;
  document.getElementById('detail-panel').style.display = 'block';
}

// ── Drag behavior ─────────────────────────────────────────────────────────────
const drag = d3.drag()
  .on('start', (ev, d) => {
    if (!ev.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
    hideTip();
  })
  .on('drag', (ev, d) => {
    d.fx = ev.x;
    d.fy = ev.y;
  })
  .on('end', (ev, d) => {
    if (!ev.active) simulation.alphaTarget(0);
    // Node stays pinned (fx/fy set). Click the node to unpin it.
  });

// ── Active link builder ───────────────────────────────────────────────────────
function buildLinks() {
  let src = [...MEANINGFUL_EDGES];
  if (showBP)  src = src.concat(BOILERPLATE_EDGES);
  if (showOOS) src = src.concat(OOS_EDGES);
  // Return fresh copies so D3 forceLink can mutate source/target to object refs
  return src.map(e => ({ ...e }));
}

// ── D3 selection references (updated by render) ───────────────────────────────
let linkSel = gLinks.selectAll('.link');
let nodeSel = gNodes.selectAll('.node-g');

// ── Render function ───────────────────────────────────────────────────────────
function render(activeLinks) {
  // ── Links ──
  linkSel = gLinks.selectAll('.link')
    .data(activeLinks, d => d.id)
    .join(
      enter => enter.append('line')
        .attr('class', 'link')
        .style('pointer-events', 'visibleStroke')
        .on('mouseenter', (ev, d) => {
          const s = edgeStyle(d.edgeCategory);
          const lines = [
            \`<b>Edge:</b> \${d.edgeCategory || 'link'}\`,
            d.label ? \`<b>Label:</b> \${d.label}\` : null,
            d.isBoilerplateNav ? '<i style="color:#888">boilerplate (heuristic: repeated global nav)</i>' : null,
            d.isOutOfScopeRef  ? '<i style="color:#888">out-of-scope reference</i>' : null,
          ].filter(Boolean).join('<br/>');
          showTip(ev, lines);
        })
        .on('mousemove', moveTip)
        .on('mouseleave', hideTip),
      update => update,
      exit   => exit.remove()
    );

  // Apply styles to all active links
  linkSel
    .attr('stroke',           d => edgeStyle(d.edgeCategory).color)
    .attr('stroke-width',     d => edgeStyle(d.edgeCategory).width)
    .attr('stroke-dasharray', d => edgeStyle(d.edgeCategory).dash)
    .attr('opacity',          d => edgeStyle(d.edgeCategory).opacity)
    .attr('marker-end',       d => \`url(#arrow-\${d.edgeCategory || 'content_link'})\`);

  // ── Nodes ──
  nodeSel = gNodes.selectAll('.node-g')
    .data(simNodes, d => d.id)
    .join(
      enter => {
        const g = enter.append('g').attr('class', 'node-g').call(drag);

        g.append('circle').attr('class', 'node-circle');
        g.append('text').attr('class', 'node-label')
          .attr('text-anchor', 'middle');

        g.on('click', (ev, d) => {
            ev.stopPropagation();
            // Toggle pin state
            if (d.fx !== null && d.fx !== undefined) {
              d.fx = null; d.fy = null;
              d3.select(ev.currentTarget).classed('pinned', false);
            } else {
              d.fx = d.x; d.fy = d.y;
              d3.select(ev.currentTarget).classed('pinned', true);
            }
            showDetail(d);
          })
          .on('dblclick', (ev, d) => {
            if (d.representativeUrl) window.open(d.representativeUrl, '_blank');
          })
          .on('mouseenter', (ev, d) => {
            // Highlight this node + connected edges + neighbors
            const connectedIds = new Set([d.id]);
            linkSel.each(l => {
              const srcId = typeof l.source === 'object' ? l.source.id : l.source;
              const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
              if (srcId === d.id || tgtId === d.id) {
                connectedIds.add(srcId);
                connectedIds.add(tgtId);
              }
            });
            nodeSel.select('.node-circle').attr('opacity', n => connectedIds.has(n.id) ? 1 : 0.15);
            nodeSel.select('.node-label').attr('opacity',  n => connectedIds.has(n.id) ? 1 : 0.1);
            linkSel.attr('opacity', l => {
              const srcId = typeof l.source === 'object' ? l.source.id : l.source;
              const tgtId = typeof l.target === 'object' ? l.target.id : l.target;
              return (srcId === d.id || tgtId === d.id) ? 1 : 0.04;
            });
            showTip(ev, d.tooltip || \`<b>\${d.label}</b>\`);
          })
          .on('mousemove', moveTip)
          .on('mouseleave', () => {
            // Restore all opacities
            nodeSel.select('.node-circle').attr('opacity', null);
            nodeSel.select('.node-label').attr('opacity',  null);
            linkSel.attr('opacity', l => edgeStyle(l.edgeCategory).opacity);
            hideTip();
          });

        return g;
      },
      update => update,
      exit   => exit.remove()
    );

  // Sync circle + label attributes for all nodes (enter + update)
  nodeSel.select('.node-circle')
    .attr('r',            d => d.radius || 10)
    .attr('fill',         d => d.color || '#74C0FC')
    .attr('stroke',       d => d.strokeColor || '#2980b9')
    .attr('stroke-width', d => d.status === 'start' ? 3.5 : 2);

  nodeSel.select('.node-label')
    .attr('dy',      d => -(d.radius || 10) - 5)
    .attr('fill',    '#e0e0e0')
    .attr('font-size', d => d.status === 'start' ? 12 : 10)
    .attr('font-weight', d => d.status === 'start' ? '700' : '400')
    .attr('display', labelsOn ? null : 'none')
    .text(d => d.label);
}

// ── Tick handler ──────────────────────────────────────────────────────────────
function ticked() {
  // Position links: start at source-node edge, end before target-node edge (arrow gap)
  linkSel.each(function(d) {
    const src = d.source, tgt = d.target;
    if (!src || !tgt || typeof src !== 'object' || typeof tgt !== 'object') return;
    const dx = tgt.x - src.x, dy = tgt.y - src.y;
    const dist = Math.hypot(dx, dy) || 1;
    const sr = src.radius || 10;
    const tr = tgt.radius || 10;
    d3.select(this)
      .attr('x1', src.x + (dx / dist) * sr)
      .attr('y1', src.y + (dy / dist) * sr)
      .attr('x2', tgt.x - (dx / dist) * (tr + 9))
      .attr('y2', tgt.y - (dy / dist) * (tr + 9));
  });

  nodeSel.attr('transform', d => \`translate(\${d.x || 0},\${d.y || 0})\`);
}

// ── Zoom to fit ───────────────────────────────────────────────────────────────
function zoomToFit(ms) {
  const bounds = gMain.node().getBBox();
  if (!bounds.width || !bounds.height) return;
  const w = svgW(), h = svgH();
  const pad = 60;
  const scale = Math.min(8, 0.9 / Math.max(
    (bounds.width  + pad * 2) / w,
    (bounds.height + pad * 2) / h
  ));
  const tx = w / 2 - scale * (bounds.x + bounds.width  / 2);
  const ty = h / 2 - scale * (bounds.y + bounds.height / 2);
  svg.transition().duration(ms || 600)
    .call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
}

// ── Edge count label ──────────────────────────────────────────────────────────
function updateEdgeCountLabel() {
  const vis = MEANINGFUL_EDGES.length
    + (showBP  ? BOILERPLATE_EDGES.length : 0)
    + (showOOS ? OOS_EDGES.length         : 0);
  const hid = (showBP  ? 0 : BOILERPLATE_EDGES.length)
            + (showOOS ? 0 : OOS_EDGES.length);
  const el = document.getElementById('edge-count-label');
  if (el) el.textContent = \`\${simNodes.length} nodes · \${vis} edges visible\`
    + (hid ? \` (\${hid} hidden)\` : '');
}

// ── Full rebuild (re-filter links + restart simulation) ───────────────────────
function rebuild() {
  const activeLinks = buildLinks();
  render(activeLinks);
  simulation.force('link').links(activeLinks);
  simulation.alpha(0.5).restart();
  updateEdgeCountLabel();
}

// ── Controls ──────────────────────────────────────────────────────────────────
function resetZoom()    { zoomToFit(600); }

function toggleLabels() {
  labelsOn = !labelsOn;
  nodeSel.select('.node-label').attr('display', labelsOn ? null : 'none');
}

function toggleBP() {
  showBP = !showBP;
  const btn = document.getElementById('btn-bp');
  btn.textContent = showBP ? '🔔 Hide Boilerplate' : '🔕 Show Boilerplate';
  btn.style.color = showBP ? '#FFB347' : '';
  rebuild();
}

function toggleOOS() {
  showOOS = !showOOS;
  const btn = document.getElementById('btn-oos');
  btn.textContent = showOOS ? '🔗 Hide OOS Refs' : '🔗 Show OOS Refs';
  btn.style.color = showOOS ? '#95a5a6' : '';
  rebuild();
}

// Background click closes detail panel
svg.on('click.bg', () => {
  document.getElementById('detail-panel').style.display = 'none';
});

// ── Window resize ─────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  simulation
    .force('center',   d3.forceCenter(svgW() / 2, svgH() / 2))
    .force('y_center', d3.forceY(svgH() / 2).strength(0.04))
    .alpha(0.1).restart();
});

// ── Expose controls to HTML onclick ──────────────────────────────────────────
window.resetZoom    = resetZoom;
window.toggleLabels = toggleLabels;
window.toggleBP     = toggleBP;
window.toggleOOS    = toggleOOS;

// ── Initial render ────────────────────────────────────────────────────────────
// Sync boilerplate button label on first load
(function _initBtnState() {
  if (showBP) {
    const btn = document.getElementById('btn-bp');
    if (btn) { btn.textContent = '🔔 Hide Boilerplate'; btn.style.color = '#FFB347'; }
  }
})();

rebuild();

// Zoom to fit once simulation settles (end event + timed fallback)
simulation.on('end', () => setTimeout(() => zoomToFit(600), 80));
setTimeout(() => zoomToFit(700), 2400);
</script>
</body>
</html>`;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Build all visualization artifacts and write them to disk.
 *
 * @param {{
 *   graph:       object,  - in-memory graph from createGraph + graphUpdater
 *   finalReport: object,  - crawlRunner final-report (before file write)
 *   originalUrl: string,
 *   outDir:      string,  - absolute path to job output directory
 * }} params
 *
 * @returns {Promise<{
 *   graphJsonPath:    string,
 *   graphMermaidPath: string,
 *   graphHtmlPath:    string,
 *   graphStats:       object,
 * }>}
 */
export async function writeCrawlGraphArtifacts({ graph, finalReport, originalUrl, outDir }) {
  const graphData  = buildGraphData(graph, finalReport, originalUrl);
  const jsonPath = path.join(outDir, 'crawl-graph.json');
  const mmdPath  = path.join(outDir, 'crawl-graph.mmd');
  const htmlPath = path.join(outDir, 'crawl-graph.html');

  const [mmd, html] = [generateMermaid(graphData), generateHtml(graphData)];

  await Promise.all([
    fsp.writeFile(jsonPath, JSON.stringify(graphData, null, 2), 'utf8'),
    fsp.writeFile(mmdPath,  mmd,                                'utf8'),
    fsp.writeFile(htmlPath, html,                               'utf8'),
  ]);

  console.log(`[visualizer] crawl-graph.json  (${graphData.nodes.length} nodes, ${graphData.edges.length} edges)`);
  console.log(`[visualizer] crawl-graph.mmd   (Mermaid flowchart)`);
  console.log(`[visualizer] crawl-graph.html  (interactive 3D force-graph)`);

  // outDir 의 절대 경로에서 프로젝트 루트(= outputs 의 부모) 기준 상대 경로를 추출합니다.
  // outputs/ 가 포함된 위치부터 잘라 쓰면 경로 하드코딩 없이 어디에 저장돼도 올바른
  // URL 경로를 만들 수 있습니다. (e.g. outputs/web/<jobId>/crawl-graph.html)
  const normalizedOutDir = outDir.replace(/\\/g, '/');
  const outputsIdx = normalizedOutDir.lastIndexOf('/outputs/');
  const relBase = outputsIdx >= 0
    ? normalizedOutDir.slice(outputsIdx + 1)         // "outputs/web/<jobId>"
    : `outputs/${path.basename(outDir)}`;             // 만약 경로에 outputs가 없으면 폴백
  const rel = (f) => `${relBase}/${f}`.replace(/\\/g, '/');

  return {
    graphJsonPath:    rel('crawl-graph.json'),
    graphMermaidPath: rel('crawl-graph.mmd'),
    graphHtmlPath:    rel('crawl-graph.html'),
    graphStats:       graphData.stats,
  };
}
