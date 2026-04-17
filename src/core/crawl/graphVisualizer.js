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
    // Decode percent-encoded path segments so Korean/CJK characters are readable
    const rawPath = gNode.normalizedPath ?? '/';
    const p = (() => { try { return decodeURIComponent(rawPath); } catch { return rawPath; } })();
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

    const shortPath = p.length > 28 ? p.slice(0, 25) + '…' : p;

    nodes.push({
      id:               dk,
      nodeId:           gNode.nodeId,
      hostname:         gNode.hostname,
      normalizedPath:   p,
      dedupKey:         dk,
      depth,
      status,
      authGated:        gNode.authGated ?? false,
      analyzed:         gNode.analyzed  ?? false,
      representativeUrl: gNode.representativeUrl ?? null,
      label:            shortPath,
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
  const rawP = node.normalizedPath;
  const p    = (() => { try { return decodeURIComponent(rawP); } catch { return rawP; } })();
  const pDisp = p.length > 32 ? p.slice(0, 29) + '...' : p;
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
 * Generate a self-contained HTML file with an interactive vis-network graph.
 *
 * Features:
 * - Hierarchical LR layout (BFS depth = horizontal axis)
 * - Node colors / shapes by status
 * - Edge colors / styles by type
 * - Sidebar with stats + legend
 * - Click node → detail panel
 * - Double-click node → open URL in new tab
 * - Toolbar: fit, force layout, hierarchical layout, toggle labels
 *
 * The vis-network library is loaded from CDN (no build step required).
 *
 * @param {object} graphData  - output of buildGraphData()
 * @returns {string}  complete HTML document
 */
export function generateHtml(graphData) {
  const { nodes, edges, stats, jobId, originalUrl } = graphData;

  // Build vis-network node objects
  const visNodes = nodes.map((n) => {
    const fill   = STATUS_FILL[n.status]       ?? STATUS_FILL.unknown;
    const border = STATUS_BORDER[n.status]     ?? STATUS_BORDER.unknown;
    const fontC  = STATUS_FONT_COLOR[n.status] ?? '#fff';
    const shape  = STATUS_SHAPE[n.status]      ?? 'box';

    return {
      id:             n.id,
      label:          `${n.label}\n[${n.depthLabel}]`,
      title:          n.tooltip,             // HTML tooltip
      representativeUrl: n.representativeUrl,
      color: {
        background: fill,
        border,
        hover:      { background: fill, border },
        highlight:  { background: fill, border },
      },
      font:           { color: fontC, size: 12, face: 'monospace' },
      shape,
      level:          n.depth >= 0 ? n.depth : 999,
      borderWidth:    n.status === 'start' ? 4 : 2,
      shadow:         n.status === 'start' || n.status === 'analyzed',
      mass:           1,
    };
  });

  // Build vis-network edge objects.
  // edgeCategory drives color and visibility.  Boilerplate edges start hidden.
  const visEdges = edges.map((e, i) => {
    const color  = EDGE_COLOR[e.edgeCategory] ?? EDGE_COLOR.content_link;
    const dashes = e.edgeCategory === 'auth_gate' || e.edgeCategory === 'out_of_scope_reference';
    const width  = e.edgeCategory === 'trigger_navigation' ? 2.5
      : e.edgeCategory === 'boilerplate_navigation'        ? 0.6
      : 1;
    const opacity = e.isBoilerplateNav ? 0.25 : 0.85;

    return {
      id:              e.id ?? `e${i}`,
      from:            e.from,
      to:              e.to,
      label:           e.label,
      arrows:          'to',
      color:           { color, opacity },
      dashes,
      width,
      hidden:          e.isBoilerplateNav || e.edgeCategory === 'out_of_scope_reference',
      isBoilerplateNav: e.isBoilerplateNav,
      isOutOfScopeRef:  e.edgeCategory === 'out_of_scope_reference',
      edgeCategory:    e.edgeCategory,
      font:            { size: 9, color: '#aaa', align: 'middle', strokeWidth: 0 },
      smooth:          { enabled: true, type: 'curvedCW', roundness: 0.15 },
    };
  });

  // Inline JSON (escape </script> to prevent HTML parsing issue)
  const safeJson = (obj) =>
    JSON.stringify(obj, null, 0).replace(/<\/script>/gi, '<\\/script>');

  const nodesJson = safeJson(visNodes);
  const edgesJson = safeJson(visEdges);

  // Legend rows
  const statusLegend = [
    { status: 'start',        shape: 'ellipse', label: 'Start page (seed URL)' },
    { status: 'analyzed',     shape: 'box',     label: 'Analyzed (crawled)' },
    { status: 'queued',       shape: 'box',     label: 'Queued / not visited' },
    { status: 'auth_gated',   shape: 'diamond', label: 'Auth gateway / login page' },
    { status: 'failed',       shape: 'box',     label: 'Failed / error' },
    { status: 'out_of_scope', shape: 'box',     label: 'Out-of-scope / stopped' },
    { status: 'duplicate',    shape: 'box',     label: 'Duplicate (prior run)' },
  ].map(({ status, shape, label }) => {
    const fill   = STATUS_FILL[status];
    const border = STATUS_BORDER[status];
    const dotStyle = shape === 'ellipse'
      ? `border-radius:50%;border:2px solid ${border}`
      : shape === 'diamond'
      ? `transform:rotate(45deg);border:2px solid ${border}`
      : `border-radius:3px;border:2px solid ${border}`;
    return `<div class="legend-item">
      <div class="legend-dot" style="background:${fill};${dotStyle}"></div>
      <span>${label}</span>
    </div>`;
  }).join('\n');

  const statRows = [
    ['Total nodes',         stats.totalNodes,           ''],
    ['Analyzed',            stats.analyzedNodes,        'color:#2ecc71'],
    ['Queued/not visited',  stats.queuedNodes,          'color:#3498db'],
    ['Auth-gated',          stats.authGatedNodes,       'color:#FFB347'],
    ['Failed',              stats.failedNodes,          'color:#e74c3c'],
    ['Out-of-scope',        stats.outOfScopeNodes,      'color:#95a5a6'],
    ['Total edges',         stats.totalEdges,           ''],
    ['  Meaningful',        stats.meaningfulEdgeCount - stats.outOfScopeRefEdges, 'color:#74C0FC'],
    ['  Out-of-scope refs', stats.outOfScopeRefEdges,   'color:#636e72;font-style:italic'],
    ['  Boilerplate (nav)', stats.boilerplateEdgeCount, 'color:#555577;font-style:italic'],
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
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  background: #0f0f1a;
  color: #e0e0e0;
  font-family: 'Segoe UI', system-ui, sans-serif;
  height: 100vh;
  overflow: hidden;
}
#app { display: flex; flex-direction: column; height: 100vh; }

#header {
  padding: 8px 16px;
  background: #1a1a2e;
  border-bottom: 1px solid #2d2d4e;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}
#header h1 { font-size: 14px; font-weight: 700; color: #FF6B9D; white-space: nowrap; }
#header .sub {
  font-size: 11px;
  color: #74C0FC;
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#main { display: flex; flex: 1; overflow: hidden; }

#net-wrap { flex: 1; position: relative; overflow: hidden; }
#network { width: 100%; height: 100%; display: block; }

#sidebar {
  width: 230px;
  background: #1a1a2e;
  border-left: 1px solid #2d2d4e;
  overflow-y: auto;
  padding: 10px 12px;
  flex-shrink: 0;
}
.sb-title {
  font-size: 11px;
  color: #FF6B9D;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin: 12px 0 6px;
  font-weight: 700;
}
.sb-title:first-child { margin-top: 0; }

.stat-row {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-bottom: 4px;
  padding-bottom: 3px;
  border-bottom: 1px solid #222238;
}
.stat-val { font-weight: 700; }

.legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
  font-size: 11px;
}
.legend-dot {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 3px;
}
.sb-hr { border: none; border-top: 1px solid #2d2d4e; margin: 8px 0; }

.edge-legend-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 7px;
  font-size: 11px;
}
.edge-line {
  width: 28px;
  height: 2px;
  flex-shrink: 0;
}
.edge-line.thick { height: 3px; }
.edge-line.dashed {
  background: repeating-linear-gradient(
    to right,
    #FFB347 0, #FFB347 5px,
    transparent 5px, transparent 9px
  );
  height: 2px;
}

#controls {
  padding: 7px 12px;
  background: #1a1a2e;
  border-top: 1px solid #2d2d4e;
  display: flex;
  gap: 7px;
  align-items: center;
  flex-shrink: 0;
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

#detail-panel {
  position: absolute;
  bottom: 10px;
  left: 10px;
  background: rgba(15, 15, 30, 0.96);
  border: 1px solid #3d3d6e;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 11px;
  max-width: 320px;
  max-height: 260px;
  overflow-y: auto;
  display: none;
  line-height: 1.6;
  pointer-events: none;
  z-index: 10;
}
#detail-panel b { font-weight: 700; }
#detail-panel i  { color: #888; }
#detail-panel small { font-size: 10px; word-break: break-all; }

#hint {
  position: absolute;
  bottom: 10px;
  right: 10px;
  font-size: 10px;
  color: #555;
  pointer-events: none;
}
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <h1>🕸 Crawl Traversal Graph</h1>
    <span class="sub">Job: ${escHtml(jobId)} &nbsp;·&nbsp; ${escHtml(originalUrl)}</span>
  </div>

  <div id="main">
    <div id="net-wrap">
      <div id="network"></div>
      <div id="detail-panel"></div>
      <div id="hint">클릭: 상세정보 &nbsp;·&nbsp; 더블클릭: URL 열기 &nbsp;·&nbsp; 드래그: 회전 &nbsp;·&nbsp; 스크롤: 줌</div>
    </div>

    <div id="sidebar">
      <div class="sb-title">Stats</div>
      ${statRows}

      <hr class="sb-hr"/>
      <div class="sb-title">Node Legend</div>
      ${statusLegend}

      <hr class="sb-hr"/>
      <div class="sb-title">Edge Legend</div>
      <div class="edge-legend-item">
        <div class="edge-line" style="background:#74C0FC"></div>
        <span>Content link</span>
      </div>
      <div class="edge-legend-item">
        <div class="edge-line thick" style="background:#2ecc71"></div>
        <span>Trigger navigation</span>
      </div>
      <div class="edge-legend-item">
        <div class="edge-line" style="background:#a29bfe"></div>
        <span>Form navigation</span>
      </div>
      <div class="edge-legend-item">
        <div class="edge-line dashed"></div>
        <span>Auth gate</span>
      </div>
      <div class="edge-legend-item">
        <div class="edge-line" style="background:#3a3a5c;opacity:0.5"></div>
        <span style="color:#666">Boilerplate nav <i>(hidden)</i></span>
      </div>
      <div class="edge-legend-item">
        <div class="edge-line" style="background:#636e72;opacity:0.6"></div>
        <span style="color:#666">Out-of-scope ref <i>(hidden)</i></span>
      </div>

      <hr class="sb-hr"/>
      <div class="sb-title">레이아웃</div>
      <p style="font-size:10px;color:#666;line-height:1.5;margin-top:4px">
        3D 포스 레이아웃.<br/>
        드래그: 회전 / 우클릭: 패닝<br/>
        스크롤: 줌 / 클릭: 상세
      </p>
    </div>
  </div>

  <div id="controls">
    <button onclick="resetCamera()">⊞ 카메라 리셋</button>
    <button onclick="toggleLabels()">🏷 라벨 토글</button>
    <button id="btn-boilerplate" onclick="toggleBoilerplateEdges()" title="Global nav / header / footer / repeated menu links are classified as boilerplate and hidden by default">🔕 Show Boilerplate</button>
    <button id="btn-oos" onclick="toggleOutOfScopeEdges()" title="Edges to out-of-scope pages (external, policy, redirected) are hidden by default to reduce clutter">🔗 Show OOS Refs</button>
    <span id="edge-count-label" style="font-size:10px;color:#555;margin-left:auto">${nodes.length} nodes &nbsp;·&nbsp; ${edges.filter(e=>!e.isBoilerplateNav && e.edgeCategory!=='out_of_scope_reference').length} meaningful edges (${edges.filter(e=>e.isBoilerplateNav).length} bp + ${edges.filter(e=>e.edgeCategory==='out_of_scope_reference').length} oos hidden)</span>
  </div>
</div>

<script src="https://unpkg.com/three@0.167.1/build/three.min.js"></script>
<script src="https://unpkg.com/three-spritetext@1.9.0/dist/three-spritetext.min.js"></script>
<script src="https://unpkg.com/3d-force-graph@1.73.3/dist/3d-force-graph.min.js"></script>
<script>
// ── Data ─────────────────────────────────────────────────────────────────────
const NODES_SRC = ${nodesJson};
const EDGES_SRC = ${edgesJson};

// Decode Korean/CJK percent-encoded paths
function _decodePath(s) { try { return decodeURIComponent(s); } catch { return s; } }
NODES_SRC.forEach(n => {
  if (n.label) n.label = _decodePath(n.label);
  if (n.title) n.title = n.title.replace(/(%[0-9A-Fa-f]{2})+/g, m => _decodePath(m));
});

const MEANINGFUL_EDGES   = EDGES_SRC.filter(e => !e.isBoilerplateNav && !e.isOutOfScopeRef);
const BOILERPLATE_EDGES  = EDGES_SRC.filter(e =>  e.isBoilerplateNav);
const OUT_OF_SCOPE_EDGES = EDGES_SRC.filter(e =>  e.isOutOfScopeRef);

// ── State ─────────────────────────────────────────────────────────────────────
let showBoilerplate    = false;
let showOutOfScopeRefs = false;
let labelsOn           = true;

function _activeEdges() {
  let e = [...MEANINGFUL_EDGES];
  if (showBoilerplate)    e = e.concat(BOILERPLATE_EDGES);
  if (showOutOfScopeRefs) e = e.concat(OUT_OF_SCOPE_EDGES);
  return e;
}

// Color lookup by node id / edge id
const nodeColorMap = {};
NODES_SRC.forEach(n => { nodeColorMap[n.id] = (n.color?.background) ?? '#74C0FC'; });
const edgeColorMap = {};
EDGES_SRC.forEach(e => { edgeColorMap[e.id] = (e.color?.color) ?? '#74C0FC'; });

// ── 3D graph ──────────────────────────────────────────────────────────────────
const container = document.getElementById('network');

function _buildGraphData() {
  return {
    nodes: NODES_SRC.map(n => ({
      id:               n.id,
      label:            labelsOn ? (n.label || '') : '',
      tooltip:          n.title ?? '',
      representativeUrl: n.representativeUrl,
      color:            nodeColorMap[n.id],
      status:           n.status,
      level:            n.level ?? 0,
    })),
    links: _activeEdges().map(e => ({
      id:       e.id,
      source:   e.from,
      target:   e.to,
      label:    e.label ?? '',
      color:    edgeColorMap[e.id] ?? '#74C0FC',
      width:    e.width ?? 1,
      dashes:   e.dashes ?? false,
      category: e.edgeCategory ?? '',
    })),
  };
}

const Graph = ForceGraph3D({ extraRenderers: [] })(container)
  .backgroundColor('#0f0f1a')
  .showNavInfo(false)
  .nodeLabel(n => n.tooltip || n.label)
  .nodeColor(n => n.color)
  .nodeRelSize(5)
  .nodeVal(n => n.status === 'start' ? 4 : n.status === 'analyzed' ? 2.5 : 1)
  .nodeThreeObjectExtend(true)
  .nodeThreeObject(n => {
    if (!labelsOn || !n.label) return null;
    const sprite = new SpriteText(n.label);
    sprite.color = '#ffffff';
    sprite.textHeight = 3.5;
    sprite.backgroundColor = 'rgba(10,10,25,0.65)';
    sprite.padding = 1.5;
    return sprite;
  })
  .linkColor(l => l.color)
  .linkWidth(l => l.width)
  .linkOpacity(0.75)
  .linkDirectionalArrowLength(5)
  .linkDirectionalArrowRelPos(1)
  .linkDirectionalParticles(l => l.category === 'trigger_navigation' ? 3 : 0)
  .linkDirectionalParticleWidth(2)
  .linkDirectionalParticleSpeed(0.004)
  .onNodeClick(n => {
    const panel = document.getElementById('detail-panel');
    panel.innerHTML = n.tooltip || n.label;
    panel.style.display = 'block';
  })
  .onNodeDblClick(n => {
    if (n.representativeUrl) window.open(n.representativeUrl, '_blank');
  })
  .onBackgroundClick(() => {
    document.getElementById('detail-panel').style.display = 'none';
  })
  .graphData(_buildGraphData());

// Zoom to fit after physics warm-up
setTimeout(() => Graph.zoomToFit(600, 80), 1800);

// ── Controls ──────────────────────────────────────────────────────────────────
function resetCamera() { Graph.zoomToFit(600, 80); }

function toggleLabels() {
  labelsOn = !labelsOn;
  // Rebuild node objects with updated label visibility
  Graph.nodeThreeObject(n => {
    if (!labelsOn || !n.label) return null;
    const sprite = new SpriteText(n.label);
    sprite.color = '#ffffff';
    sprite.textHeight = 3.5;
    sprite.backgroundColor = 'rgba(10,10,25,0.65)';
    sprite.padding = 1.5;
    return sprite;
  });
  // Refresh data so label changes apply
  const gd = _buildGraphData();
  Graph.graphData(gd);
}

function _updateEdgeCountLabel() {
  const lbl = document.getElementById('edge-count-label');
  const visible = MEANINGFUL_EDGES.length
    + (showBoilerplate    ? BOILERPLATE_EDGES.length  : 0)
    + (showOutOfScopeRefs ? OUT_OF_SCOPE_EDGES.length : 0);
  const hidden = (showBoilerplate    ? 0 : BOILERPLATE_EDGES.length)
               + (showOutOfScopeRefs ? 0 : OUT_OF_SCOPE_EDGES.length);
  lbl.textContent = \`\${NODES_SRC.length} nodes · \${visible} edges visible\`
    + (hidden > 0 ? \` (\${hidden} hidden)\` : '');
}

function _refresh() {
  Graph.graphData(_buildGraphData());
  _updateEdgeCountLabel();
}

function toggleBoilerplateEdges() {
  showBoilerplate = !showBoilerplate;
  const btn = document.getElementById('btn-boilerplate');
  btn.textContent = showBoilerplate ? '🔔 Hide Boilerplate' : '🔕 Show Boilerplate';
  btn.style.color  = showBoilerplate ? '#FFB347' : '';
  _refresh();
}

function toggleOutOfScopeEdges() {
  showOutOfScopeRefs = !showOutOfScopeRefs;
  const btn = document.getElementById('btn-oos');
  btn.textContent = showOutOfScopeRefs ? '🔗 Hide OOS Refs' : '🔗 Show OOS Refs';
  btn.style.color  = showOutOfScopeRefs ? '#95a5a6' : '';
  _refresh();
}

window.resetCamera            = resetCamera;
window.toggleLabels           = toggleLabels;
window.toggleBoilerplateEdges = toggleBoilerplateEdges;
window.toggleOutOfScopeEdges  = toggleOutOfScopeEdges;
window.Graph                  = Graph;
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
  const jobDirName = path.basename(outDir);

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
  console.log(`[visualizer] crawl-graph.html  (interactive vis-network)`);

  const rel = (f) => `outputs/${jobDirName}/${f}`.replace(/\\/g, '/');

  return {
    graphJsonPath:    rel('crawl-graph.json'),
    graphMermaidPath: rel('crawl-graph.mmd'),
    graphHtmlPath:    rel('crawl-graph.html'),
    graphStats:       graphData.stats,
  };
}
