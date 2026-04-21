/**
 * core/phase3/extractUrls.js
 *
 * WHERE URL EXTRACTION HAPPENS.
 *
 * Collects raw URL candidates from all Phase 1 data sources and normalises
 * them against the base page URL. Deduplication is intentionally deferred to
 * filterUrls.js so that richer source metadata is preserved per candidate.
 *
 * Sources:
 *   pageLinks.anchors        → <a href="...">          — static-link
 *   pageLinks.areas          → <area href="...">        — static-link
 *   pageLinks.formActions    → <form action="...">      — form-action
 *   pageLinks.canonical      → <link rel="canonical">   — metadata
 *   pageLinks.ogUrl          → <meta property="og:url"> — metadata
 *   triggerResults.newNodes  → nodes revealed by triggers — revealed-after-trigger
 */

import { normalizeUrl, classifyOrigin } from './normalizeUrl.js';

/**
 * @param {object} opts
 * @param {{ anchors: string[], areas: string[], formActions: string[],
 *           canonical: string|null, ogUrl: string|null }} opts.pageLinks
 * @param {Array}   opts.triggerResults - Phase 1 trigger result objects
 * @param {string}  opts.baseUrl        - Final page URL used for resolution
 * @returns {Array<{rawUrl, normalizedUrl, originType, discoverySource}>}
 */
export function extractUrls({ pageLinks, triggerResults, baseUrl }) {
  const candidates = [];

  /**
   * Resolve, classify and push one URL candidate.
   * Silently drops invalid or non-HTTP URLs (normalizeUrl returns null).
   */
  function add(rawUrl, source) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    const normalizedUrl = normalizeUrl(rawUrl.trim(), baseUrl);
    if (!normalizedUrl) return;
    const originType = classifyOrigin(normalizedUrl, baseUrl);
    candidates.push({ rawUrl, normalizedUrl, originType, discoverySource: source });
  }

  // ── Static links from the baseline page ──────────────────────────────────
  for (const href of pageLinks?.anchors     || []) add(href,   'static-link');
  for (const href of pageLinks?.areas       || []) add(href,   'static-link');
  for (const act  of pageLinks?.formActions || []) add(act,    'form-action');
  if (pageLinks?.canonical) add(pageLinks.canonical, 'metadata');
  if (pageLinks?.ogUrl)     add(pageLinks.ogUrl,     'metadata');

  // ── URLs revealed after trigger exploration ───────────────────────────────
  for (const result of triggerResults || []) {
    // Only include results where we successfully fired the trigger
    if (result.status !== 'success') continue;
    for (const node of result.newNodes || []) {
      if (node.href) add(node.href, 'revealed-after-trigger');
    }
  }

  return candidates;
}
