/**
 * core/graph/graphModel.js
 *
 * Pure graph data model — no I/O, no side-effects.
 *
 * PAGE IDENTITY RULE
 * ──────────────────
 * A page is uniquely identified by:
 *   exact hostname  +  normalized pathname
 *
 * Query strings and fragments are IGNORED for page identity.
 *
 *   https://example.com/about
 *   https://example.com/about?tab=1
 *   https://example.com/about?tab=2
 *   https://example.com/about#team
 *
 * All four above share the same identity:
 *   hostname      : example.com
 *   normalizedPath: /about
 *   dedupKey      : example.com/about
 *
 * SUBDOMAIN RULE
 * ──────────────
 * Subdomains are treated as separate hosts.
 * example.com ≠ www.example.com ≠ m.example.com
 */

import { randomUUID } from 'crypto';

// ── Page identity ─────────────────────────────────────────────────────────────

/**
 * Compute the canonical page identity from any URL string.
 * Returns null for non-HTTP/HTTPS or unparseable inputs.
 *
 * Normalization:
 *   - uses URL.hostname (no port included for default ports)
 *   - uses URL.pathname only (search and hash are ignored)
 *   - collapses duplicate slashes
 *   - strips trailing slash except for root '/'
 *   - preserves path case
 *
 * @param {string} rawUrl
 * @returns {{ hostname: string, normalizedPath: string, dedupKey: string }|null}
 */
export function computePageIdentity(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;

    // Normalize path: collapse slashes, strip trailing slash (except root)
    let p = u.pathname.replace(/\/+/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

    const hostname       = u.hostname;
    const normalizedPath = p || '/';
    const dedupKey       = `${hostname}${normalizedPath}`;

    return { hostname, normalizedPath, dedupKey };
  } catch {
    return null;
  }
}

// ── Node factory ──────────────────────────────────────────────────────────────

/**
 * Create a new graph node representing a unique page.
 *
 * @param {{ hostname, normalizedPath, dedupKey, representativeUrl, jobId }} opts
 * @returns {object}
 */
export function createNode({ hostname, normalizedPath, dedupKey, representativeUrl, jobId, authGated = false }) {
  const now = new Date().toISOString();
  return {
    nodeId:                 randomUUID(),
    hostname,
    normalizedPath,
    dedupKey,
    representativeUrl,
    discoveredVariants:     [representativeUrl],  // query/hash variants of the same path
    firstSeenAt:            now,
    lastSeenAt:             now,
    discoveredByJobIds:     [jobId],
    analyzed:               false,                // true once Phase 1 has run for this page
    analyzedAt:             null,
    analysisStatus:         null,                 // 'success' | 'failed'
    lastReachabilityStatus: null,
    // true when this node represents an authentication page (login / consent)
    // rather than a normal content page.  authGated nodes are NOT enqueued for
    // content exploration — they are preserved only as graph discoveries.
    authGated,
    notes:                  null,
  };
}

// ── Edge factory ──────────────────────────────────────────────────────────────

/**
 * Create a new directed edge from one page node to another.
 * Edges represent discovered navigation links.
 *
 * @param {{ fromNodeId, toNodeId, jobId, discoverySource, triggerId?,
 *           representativeUrl, edgeType?, requiresAuth?, authDetected?,
 *           authScore?, navigationStatus? }} opts
 * @returns {object}
 */
export function createEdge({
  fromNodeId, toNodeId, jobId, discoverySource,
  triggerId        = null,
  representativeUrl,
  // Edge type classifies how this link was discovered / what it represents:
  //   normal_discovery   — found via static DOM link or Phase 3 URL extraction
  //   navigation_trigger — discovered when a trigger led to a content page
  //   auth_gate          — trigger led to a login / auth-provider page
  edgeType         = 'normal_discovery',
  requiresAuth     = false,
  authDetected     = false,
  authScore        = null,
  navigationStatus = null,
}) {
  return {
    edgeId:            randomUUID(),
    fromNodeId,
    toNodeId,
    discoveredAt:      new Date().toISOString(),
    discoveredByJobId: jobId,
    discoverySource,
    triggerId,
    representativeUrl,
    edgeType,
    requiresAuth,
    authDetected,
    authScore,
    navigationStatus,
  };
}
