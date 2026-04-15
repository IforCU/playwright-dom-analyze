/**
 * core/phase1/triggerDiscovery.js
 *
 * WHERE DYNAMIC TRIGGER CANDIDATES ARE DISCOVERED.
 *
 * Scans the baseline page for interactive elements that are likely to reveal
 * hidden content when clicked or hovered. Runs inside page.evaluate() for
 * direct DOM inspection.
 *
 * Scoring heuristics:
 *   - aria-expanded / aria-haspopup  → highest (explicit expandable intent)
 *   - summary / details              → high (native disclosure widget)
 *   - button / role=button           → medium-high
 *   - a[href], submit inputs         → medium
 *   - onclick, tabindex              → base
 *   Bonus: dropdown/toggle/menu class hints, non-empty text content
 *
 * Auto-dynamic exclusion:
 *   Candidates whose bounding box overlaps a known auto-dynamic region by more
 *   than `overlapThreshold` are excluded.  These are typically carousel nav dots,
 *   prev/next buttons, or ad-slot controls — they advance passive rotation rather
 *   than revealing hidden interactive content.
 */

import { isInAutoDynamicRegion, overlapRatio } from './autoDynamicDetector.js';

/**
 * Find interactive trigger candidates on the page, excluding elements that
 * belong to auto-dynamic (passively rotating) regions.
 *
 * @param {import('playwright').Page} page
 * @param {object[]} autoDynamicRegions  - Output of detectAutoDynamicRegions() (default [])
 * @param {number}   overlapThreshold    - Overlap fraction above which a candidate
 *                                         is classified as inside an auto-dynamic
 *                                         region and excluded (default 0.3)
 * @returns {Promise<object[]>}  Sorted, filtered interactive candidate list
 */
export async function findTriggerCandidates(page, autoDynamicRegions = [], overlapThreshold = 0.3) {
  const rawCandidates = await page.evaluate(() => {
    // ── Helpers ──────────────────────────────────────────────────────────────

    function buildSelectorHint(el) {
      const tag = el.tagName.toLowerCase();
      try {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const cls = Array.from(el.classList).slice(0, 2);
        if (cls.length) return `${tag}.${cls.map((c) => CSS.escape(c)).join('.')}`;
      } catch (_) {}
      return tag;
    }

    function isVisible(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none')          return false;
      if (style.visibility === 'hidden')     return false;
      if (parseFloat(style.opacity) < 0.05)  return false;
      return true;
    }

    function getBbox(el) {
      const rect = el.getBoundingClientRect();
      return {
        x:      Math.round(rect.x + window.scrollX),
        y:      Math.round(rect.y + window.scrollY),
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }

    // ── Candidate collection ─────────────────────────────────────────────────

    const candidates = [];
    let counter = 0;
    const seen = new WeakSet();

    const queries = [
      { sel: '[aria-expanded]',                      reason: 'has aria-expanded',        baseScore: 5 },
      { sel: '[aria-haspopup]',                      reason: 'has aria-haspopup',        baseScore: 5 },
      { sel: 'summary',                              reason: 'details/summary expander', baseScore: 4 },
      { sel: 'button:not([disabled])',               reason: 'button element',           baseScore: 3 },
      { sel: '[role="button"]',                      reason: 'role=button',              baseScore: 3 },
      { sel: 'input[type="button"]:not([disabled])', reason: 'input[type=button]',       baseScore: 2 },
      { sel: 'input[type="submit"]:not([disabled])', reason: 'input[type=submit]',       baseScore: 2 },
      { sel: 'a[href]',                              reason: 'anchor link',              baseScore: 2 },
      { sel: '[onclick]',                            reason: 'inline onclick',           baseScore: 2 },
      { sel: '[tabindex]:not([tabindex="-1"])',       reason: 'tabindex >= 0',            baseScore: 1 },
    ];

    for (const { sel, reason, baseScore } of queries) {
      let elements;
      try {
        elements = document.querySelectorAll(sel);
      } catch (_) {
        continue; // invalid selector — skip safely
      }

      for (const el of elements) {
        if (seen.has(el)) continue;
        if (!isVisible(el)) { seen.add(el); continue; }
        seen.add(el);

        const tag  = el.tagName.toLowerCase();
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const role = el.getAttribute('role') || null;

        // ── Anchor-link interactivity filter ─────────────────────────────────
        // Exclude plain navigation anchors whose only effect is navigating to
        // another page.  Such anchors cause page-navigation on click, which
        // destroys the execution context and wastes ~20 s per trigger.
        //
        // Keep an anchor when ANY of these are true:
        //   (a) href starts with '#'           → in-page content reveal
        //   (b) no href at all                 → used as button
        //   (c) href starts with 'javascript:' → inline script
        //   (d) has aria-expanded / haspopup   → explicitly interactive
        //   (e) has onclick attribute           → scripted behaviour
        //   (f) role=button                    → semantic button override
        //   (g) has data-toggle / data-bs-toggle → Bootstrap/custom toggle
        if (tag === 'a') {
          const href = (el.getAttribute('href') || '').trim();
          const isInPage = href === '' || href.startsWith('#') || href.startsWith('javascript:');
          const hasInteractivity = (
            el.getAttribute('aria-expanded') !== null ||
            el.getAttribute('aria-haspopup') !== null ||
            el.getAttribute('onclick') !== null ||
            (role === 'button') ||
            el.getAttribute('data-toggle') !== null ||
            el.getAttribute('data-bs-toggle') !== null
          );
          if (!isInPage && !hasInteractivity) {
            seen.add(el);
            continue; // skip pure navigation link
          }
        }

        // Prefer hover for tooltip-style elements (non-button, non-link, has title)
        let triggerType = 'click';
        if (el.getAttribute('title') && !['button', 'a', 'input', 'summary'].includes(tag)) {
          triggerType = 'hover';
        }

        // Bonus scoring
        let priority = baseScore;
        if (el.getAttribute('aria-expanded')  !== null) priority += 2;
        if (el.getAttribute('aria-haspopup')  !== null) priority += 2;
        const classStr = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        if (/\b(dropdown|toggle|collapse|menu|tab|accordion)\b/.test(classStr)) priority += 1;
        if (text.length > 0) priority += 1;

        candidates.push({
          triggerId:    `trigger-${++counter}`,
          triggerType,
          text,
          role,
          id:           el.id || null,
          selectorHint: buildSelectorHint(el),
          bbox:         getBbox(el),
          priority,
          reason,
        });
      }
    }

    // Sort highest priority first
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates;
  });

  if (!autoDynamicRegions.length) return _dedupBySelectorHint(rawCandidates);

  // ── Filter out candidates inside auto-dynamic regions ─────────────────────
  // Carousel nav dots, prev/next arrows, and ad-slot controls commonly appear
  // inside auto-dynamic containers.  They trigger passive rotation, not content
  // reveal, and would only generate noise during trigger exploration.
  const interactiveCandidates = [];
  for (const c of rawCandidates) {
    if (isInAutoDynamicRegion(c.bbox, autoDynamicRegions, overlapThreshold)) {
      // Track how many candidates each region is responsible for excluding
      // (used for auto-dynamic-regions.json debug output).
      for (const region of autoDynamicRegions) {
        if (overlapRatio(c.bbox, region.bbox) > overlapThreshold) {
          region.excludedTriggerCount++;
        }
      }
    } else {
      interactiveCandidates.push(c);
    }
  }
  return _dedupBySelectorHint(interactiveCandidates);
}

/**
 * Deduplicate candidates that share the same selectorHint.
 *
 * When many elements share the same CSS class pattern (e.g. 12 × a.link_service,
 * 13 × a.link_partner), exploring each one separately is redundant — they
 * represent the same interaction pattern and would produce equivalent results
 * (or all navigate away).  Keep only the first (highest-priority) representative.
 *
 * Generic selectors ('a', 'button', 'div', 'span') are intentionally exempt:
 * they may contain truly distinct controls that happen to share a tag name.
 */
function _dedupBySelectorHint(candidates) {
  const GENERIC = new Set(['a', 'button', 'input', 'div', 'span', 'li', 'p']);
  const seen = new Set();
  const result = [];
  for (const c of candidates) {
    if (!GENERIC.has(c.selectorHint) && seen.has(c.selectorHint)) {
      // skip — same class pattern already represented
      continue;
    }
    seen.add(c.selectorHint);
    result.push(c);
  }
  return result;
}
