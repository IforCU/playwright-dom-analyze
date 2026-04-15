/**
 * core/phase3/filterUrls.js
 *
 * WHERE URL FILTERING HAPPENS.
 *
 * Applies filtering and deduplication rules to the normalised URL candidates
 * produced by extractUrls.js.
 *
 * Rules applied (in order):
 *   1. Drop candidates without a normalizedUrl
 *   2. Drop URLs that do NOT share the exact same hostname as the base page
 *      (subdomains such as www., m., api. are excluded)
 *   3. Drop URLs whose pathname ends with a common asset extension
 *   4. Path-based deduplication:
 *      dedupKey = `${hostname}${normalizedPath}` (query + hash ignored)
 *      → multiple query/hash variants of the same path collapse into ONE entry
 *      → the first-seen URL becomes the representative targetUrl
 *      → subsequent variants are collected in `discoveredVariants`
 *   5. Cap result count at maxDiscoveredUrlsPerPage
 *
 * NOTE: `includeExternal` and `includeQueryVariants` options are kept for
 * interface compatibility but the hostname-exact rule takes precedence.
 */

import { isSameHostname, pathDedupKey } from './normalizeUrl.js';

// Common static asset extensions to skip (not pages)
const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.avif',
  '.css', '.js', '.mjs', '.map',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.ico', '.pdf', '.zip', '.tar', '.gz',
]);

/**
 * @param {Array<{normalizedUrl, originType, discoverySource}>} candidates
 * @param {object} config
 * @param {string} config.baseUrl                    - The page URL being analysed (required for hostname check)
 * @param {boolean} [config.includeExternal=false]   - Kept for compatibility; hostname rule supersedes
 * @param {number}  [config.maxDiscoveredUrlsPerPage=50]
 * @returns {Array}  Each entry has an extra `discoveredVariants` and `normalizedPath` / `dedupKey` field
 */
export function filterUrls(candidates, config = {}) {
  const {
    baseUrl,
    maxDiscoveredUrlsPerPage = 50,
  } = config;

  // Map<dedupKey, index in results> for variant accumulation
  const keyToIndex = new Map();
  const results    = [];

  for (const candidate of candidates) {
    const { normalizedUrl } = candidate;
    if (!normalizedUrl) continue;

    // ── Exact-hostname filter ─────────────────────────────────────────────────
    // Only keep URLs on the exact same hostname as the analysed page.
    // Subdomains (www., m., api., …) are excluded.
    if (baseUrl && !isSameHostname(normalizedUrl, baseUrl)) continue;

    let u;
    try {
      u = new URL(normalizedUrl);
    } catch {
      continue; // malformed — skip
    }

    // ── Asset extension filter ────────────────────────────────────────────────
    const extMatch = u.pathname.match(/(\.[a-z0-9]+)$/i);
    if (extMatch && ASSET_EXTENSIONS.has(extMatch[1].toLowerCase())) continue;

    // ── Path-based deduplication ──────────────────────────────────────────────
    // Two URLs with the same hostname+pathname but different query strings or
    // fragments are considered the same crawl target.
    const dedup = pathDedupKey(normalizedUrl);
    if (!dedup) continue;
    const { dedupKey, normalizedPath } = dedup;

    if (keyToIndex.has(dedupKey)) {
      // Already have a representative — just accumulate the variant
      const idx = keyToIndex.get(dedupKey);
      results[idx].discoveredVariants.push(normalizedUrl);
      continue;
    }

    if (results.length >= maxDiscoveredUrlsPerPage) continue;

    keyToIndex.set(dedupKey, results.length);
    results.push({
      ...candidate,
      normalizedPath,
      dedupKey,
      discoveredVariants: [normalizedUrl],
    });
  }

  return results;
}
