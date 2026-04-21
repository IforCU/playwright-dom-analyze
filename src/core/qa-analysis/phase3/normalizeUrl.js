/**
 * core/phase3/normalizeUrl.js
 *
 * Pure URL resolution and origin classification utilities.
 *
 * normalizeUrl  — resolves a raw href/action string against a base URL,
 *                 strips the fragment (server never sees it),
 *                 returns null for non-HTTP/HTTPS or unparseable inputs.
 *
 * classifyOrigin — classifies the relationship between a target URL and the
 *                  base page URL as same-origin, same-site, or external.
 *
 * These are intentionally free of side-effects so they can be tested or
 * reused in any context.
 */

/**
 * Resolve `rawUrl` against `baseUrl` and normalise.
 * Returns null when the URL is unparseable or uses a non-HTTP/HTTPS scheme.
 *
 * @param {string} rawUrl
 * @param {string} baseUrl
 * @returns {string|null}
 */
export function normalizeUrl(rawUrl, baseUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed, baseUrl);
    // Only allow HTTP/HTTPS; drop mailto:, tel:, javascript:, etc.
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // Strip fragment — the server never receives the hash portion
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Classify the relationship between a fully-normalised target URL and the
 * base page URL.
 *
 * - same-origin : same protocol + host + port
 * - same-site   : same eTLD+1 (rough heuristic — last 2 hostname parts)
 * - external    : everything else
 *
 * NOTE: The same-site heuristic uses the last 2 hostname segments which is
 * incorrect for ccTLD second-level domains (.co.uk, .com.au, etc.).
 * Sufficient for a local prototype.
 *
 * @param {string} normalizedUrl
 * @param {string} baseUrl
 * @returns {'same-origin'|'same-site'|'external'}
 */
export function classifyOrigin(normalizedUrl, baseUrl) {
  try {
    const u = new URL(normalizedUrl);
    const b = new URL(baseUrl);

    if (u.origin === b.origin) return 'same-origin';

    // Rough same-site check: compare last two hostname segments
    const uSite = u.hostname.split('.').slice(-2).join('.');
    const bSite = b.hostname.split('.').slice(-2).join('.');
    if (uSite === bSite) return 'same-site';

    return 'external';
  } catch {
    return 'external';
  }
}

/**
 * Return true only when the target URL shares the exact same hostname as the
 * base URL.
 *
 * Phase 3 queue expansion rule: we restrict crawl candidates to the exact
 * same hostname. Subdomains (www., m., api., …) are treated as separate
 * hosts and must be excluded.
 *
 * Examples (base: https://example.com):
 *   https://example.com/about     → true
 *   https://www.example.com/about → false
 *   https://m.example.com/about   → false
 *
 * @param {string} normalizedUrl
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isSameHostname(normalizedUrl, baseUrl) {
  try {
    const u = new URL(normalizedUrl);
    const b = new URL(baseUrl);
    return u.hostname === b.hostname;
  } catch {
    return false;
  }
}

/**
 * Replace "parametric" path segments with an `{id}` placeholder so that
 * URLs that differ only in a numeric product/item identifier are treated as
 * the same crawl target.
 *
 * Parametric segments:
 *   - pure numeric with 5 or more digits  (e.g. 5374944091 — product IDs)
 *   - UUID / GUID patterns                (e.g. 550e8400-e29b-41d4-a716-446655440000)
 *
 * Examples:
 *   /products/5374944091        → /products/{id}
 *   /products/2763013060        → /products/{id}   (same key as above)
 *   /category/12345/item/67890  → /category/{id}/item/{id}
 *   /page/abc                   → /page/abc         (unchanged — not numeric)
 *
 * @param {string} pathname  — already-normalised path (no duplicate slashes)
 * @returns {string}
 */
export function parametrizePath(pathname) {
  return pathname
    .split('/')
    .map((seg) => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{id}';
      if (/^\d{5,}$/.test(seg)) return '{id}';
      return seg;
    })
    .join('/');
}

/**
 * Compute a path-based deduplication key and the normalised path string.
 *
 * Rules:
 *   - key = `${hostname}${patternPath}` where patternPath has parametric
 *     segments replaced with `{id}` (see parametrizePath)
 *   - query string is ignored
 *   - hash fragment is ignored (already stripped by normalizeUrl)
 *   - collapse duplicate slashes
 *   - remove trailing slash except for root '/'
 *   - path case is preserved
 *
 * The returned `normalizedPath` is the parametrized form (`/products/{id}`)
 * so that graph nodes for different product IDs share the same path label.
 * The original URL is preserved as `representativeUrl` on the graph node.
 *
 * @param {string} normalizedUrl
 * @returns {{ dedupKey: string, normalizedPath: string }|null}
 */
export function pathDedupKey(normalizedUrl) {
  try {
    const u    = new URL(normalizedUrl);
    // Collapse duplicate slashes and strip trailing slash (unless root)
    let p      = u.pathname.replace(/\/+/g, '/');
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    const patternPath = parametrizePath(p);
    return { dedupKey: `${u.hostname}${patternPath}`, normalizedPath: patternPath };
  } catch {
    return null;
  }
}
