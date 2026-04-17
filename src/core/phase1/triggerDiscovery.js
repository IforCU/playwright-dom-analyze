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
import { AUTH_SENSITIVE_TEXT_HINTS }           from './authNavigationClassifier.js';

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

    // ── Three-tier visibility model ───────────────────────────────────────────
    //
    // Mirrors the model in staticAnalysis.js.  Built inside page.evaluate()
    // so it has direct DOM access without a serialisation round-trip.
    //
    // Key rule: aria-hidden="false" is NOT a positive visibility signal.
    // Real rendering and interactability take priority over ARIA hints.
    //
    // Pre-built lookup sets (one querySelectorAll each, amortised across all
    // elements visited in the candidate loop below).
    const _ariaHiddenTrueRoots = new Set(document.querySelectorAll('[aria-hidden="true"]'));
    const _inertRoots          = new Set(document.querySelectorAll('[inert]'));

    function _isInAriaHiddenSubtree(el) {
      let p = el.parentElement;
      while (p && p !== document.documentElement) {
        if (_ariaHiddenTrueRoots.has(p)) return true;
        p = p.parentElement;
      }
      return false;
    }

    function _isInInertSubtree(el) {
      let p = el;
      while (p && p !== document.documentElement) {
        if (_inertRoots.has(p)) return true;
        p = p.parentElement;
      }
      return false;
    }

    // Overlay detection — one-time call, result reused for every element below.
    const _topLayerOverlays = (() => {
      const result = [];
      const vw = window.innerWidth, vh = window.innerHeight;
      const vpArea = vw * vh || 1;
      for (const dlg of document.querySelectorAll('dialog[open]')) {
        const s = window.getComputedStyle(dlg);
        if (s.display === 'none') continue;
        const r = dlg.getBoundingClientRect();
        if (r.width * r.height >= vpArea * 0.04)
          result.push({ el: dlg, rect: r, zIndex: 999999 });
      }
      for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const pos = s.position;
        if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
        const zi = parseInt(s.zIndex) || 0;
        if (zi < 20) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < vpArea * 0.04) continue;
        if (!result.some((o) => o.el === el)) result.push({ el, rect: r, zIndex: zi });
      }
      for (const el of document.body.children) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        if (s.position !== 'fixed') continue;
        const zi = parseInt(s.zIndex) || 0;
        if (zi < 100 || parseFloat(s.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < vpArea * 0.04) continue;
        if (!result.some((o) => o.el === el)) result.push({ el, rect: r, zIndex: zi });
      }
      result.sort((a, b) => b.zIndex - a.zIndex);
      return result;
    })();

    /**
     * Compute trigger-candidate visibility — three separate concerns.
     *
     *   visuallyVisible    — element is CSS-rendered and has real geometry
     *   interactiveVisible — element is currently actionable (not disabled /
     *                        inert / overlay-blocked / pointer-events:none)
     *   rect               — cached bounding rect (avoids a second call)
     *
     * Trigger discovery requires BOTH visuallyVisible AND interactiveVisible.
     * aria-hidden="false" is explicitly not used as a positive signal.
     */
    function computeTriggerVisibility(el) {
      const rect  = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const reasons = [];

      // ── Rendering (visuallyVisible) ──────────────────────────────────────
      let hiddenByCss = false;
      if (style.display === 'none')         { hiddenByCss = true; reasons.push('css_display_none'); }
      if (style.visibility === 'hidden')    { hiddenByCss = true; reasons.push('css_visibility_hidden'); }
      if (parseFloat(style.opacity) < 0.05) { hiddenByCss = true; reasons.push('css_opacity_zero'); }
      if (el.hasAttribute('hidden'))         { hiddenByCss = true; reasons.push('attr_html_hidden'); }

      const tooSmall = rect.width < 2 || rect.height < 2;
      if (tooSmall) reasons.push('too_small');

      const isInert = _isInInertSubtree(el);
      if (isInert) reasons.push('inert_subtree');

      const visuallyVisible = !hiddenByCss && !tooSmall && !isInert;

      // ── ARIA (advisory only, no positive signal from aria-hidden="false") ─
      const ariaHiddenValue      = el.getAttribute('aria-hidden');
      const hiddenByAncestorAria = _isInAriaHiddenSubtree(el);
      // Track mismatches for debug output but do NOT gate on accessibilityVisible —
      // rendering is authoritative.
      if (ariaHiddenValue === 'false' && !visuallyVisible)
        reasons.push('mismatch__aria_false_but_not_rendered');
      if (ariaHiddenValue === 'false' && tooSmall)
        reasons.push('mismatch__aria_false_but_zero_area');
      if (ariaHiddenValue === 'false' && hiddenByAncestorAria)
        reasons.push('mismatch__aria_false_but_ancestor_aria_true');

      // ── Overlay occlusion ────────────────────────────────────────────────
      let blockedByOverlay = false;
      if (visuallyVisible && _topLayerOverlays.length > 0) {
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;
        for (const ov of _topLayerOverlays) {
          if (ov.el === el || ov.el.contains(el)) continue;
          const o = ov.rect;
          if (cx >= o.left && cx <= o.right && cy >= o.top && cy <= o.bottom) {
            blockedByOverlay = true;
            reasons.push(ariaHiddenValue === 'false'
              ? 'mismatch__aria_false_but_overlay_blocked'
              : 'blocked_by_overlay');
            break;
          }
        }
      }

      // ── Interactability (interactiveVisible) ──────────────────────────────
      const isDisabled    = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      const noPointerEvts = style.pointerEvents === 'none';
      const interactiveVisible = visuallyVisible && !isDisabled && !isInert && !blockedByOverlay && !noPointerEvts;

      return { rect, visuallyVisible, interactiveVisible, reasons };
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
        const _vis = computeTriggerVisibility(el);
        if (!_vis.visuallyVisible || !_vis.interactiveVisible) { seen.add(el); continue; }
        seen.add(el);

        const tag  = el.tagName.toLowerCase();

        // ── FILTER 1: Skip text-entry input fields ─────────────────────────────
        // Clicking text/search/email inputs just focuses the cursor — it does
        // not reveal new DOM structure.  Only action inputs (button, submit) and
        // toggle inputs (checkbox, radio) are meaningful trigger candidates.
        if (tag === 'input') {
          const itype = (el.getAttribute('type') || 'text').toLowerCase();
          if (!['button', 'submit', 'reset', 'image', 'checkbox', 'radio'].includes(itype)) continue;
        }

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

        // ── FILTER 2: Skip advertisement containers ──────────────────────────
        // Ad slots produce noise mutations and yield no structural discovery value.
        // Matches id/class patterns like ad_timeboard, advert_slot, adsense, etc.
        const _hintId  = el.id || '';
        const _hintCls = typeof el.className === 'string' ? el.className : '';
        // \bads?[_-] catches ad_foo and ads_foo; individual terms catch well-known
        // ad vendor class names.  The pattern intentionally avoids 'ad' alone to
        // prevent false-positives on words like 'adapt', 'add', 'addon', etc.
        const AD_NODE_RE = /\bads?[_-]|advert|adsense|adroll|adslot|sponsored|banner[_-]ad/i;
        if (AD_NODE_RE.test(_hintId) || AD_NODE_RE.test(_hintCls)) continue;

        // ── FILTER 3: Skip scroll-navigation and content-rotation utilities ──
        // These buttons scroll the page, refresh widget content in-place, or
        // rotate recommendation lists — none reveal new hidden DOM sections.
        // Match is anchored (^ $) to avoid false-positives on longer labels.
        const UTILITY_TEXT_RE = /^(새로고침|refresh|reload|최상단(으로\s*이동)?|go\s+to\s+top|back\s+to\s+top|scroll\s+to\s+top|입력도구|input\s+tool|다음\s+페이지|이전\s+페이지|다른\s+추천\s+보기|see\s+(other|more)\s+recommend(ation)?)$/i;
        if (text && UTILITY_TEXT_RE.test(text)) continue;

        // ── FILTER 4: Skip micro-icon elements ───────────────────────────────
        // Elements smaller than 22×22 px in BOTH dimensions are typically
        // icon-only decorators or status indicators (info icons, tiny badges)
        // rather than content-expansion triggers.
        // Reuse the rect already computed by computeTriggerVisibility().
        if (_vis.rect.width < 22 && _vis.rect.height < 22) continue;

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

  if (!autoDynamicRegions.length) return _tagAuthSensitive(_dedupBySelectorHint(rawCandidates));

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
  return _tagAuthSensitive(_dedupBySelectorHint(interactiveCandidates));
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

/**
 * Tag candidates whose visible text matches common auth-sensitive patterns.
 *
 * Auth-sensitive candidates (login, cart, my page, checkout, etc.) are NOT
 * excluded — they are still explored because they reveal auth-gated flows.
 * The tag is used by downstream reporting and Phase 3 classification.
 *
 * @param {object[]} candidates
 * @returns {object[]} Same array, mutated in-place with `.authSensitiveHint` set
 */
function _tagAuthSensitive(candidates) {
  for (const c of candidates) {
    const txt = (c.text || '').toLowerCase();
    c.authSensitiveHint = AUTH_SENSITIVE_TEXT_HINTS.some((kw) => txt.includes(kw.toLowerCase()));
  }
  return candidates;
}
