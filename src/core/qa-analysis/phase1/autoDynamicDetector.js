/**
 * core/phase1/autoDynamicDetector.js
 *
 * WHERE PASSIVE AUTO-DYNAMIC REGION DETECTION HAPPENS.
 *
 * Before finalising trigger candidates this module observes the page for a
 * short window (default 3 s) without performing any user interaction.
 * Elements that mutate on their own — rotating banners, auto-carousels,
 * rolling-ranking widgets, ad slots — are classified as "auto-dynamic regions"
 * and excluded from trigger candidate exploration so they do not produce noise.
 *
 * Detection strategy (heuristic — not exhaustive):
 *   1. Static class / id keyword scan  — containers whose class or id string
 *      contains known carousel / banner substrings are flagged immediately.
 *   2. aria-live scan                  — [aria-live], [aria-atomic],
 *      [aria-relevant] containers auto-update without user action.
 *   3. Passive mutation observation    — mutations collected during the silent
 *      observation window identify elements that rotate content on their own.
 *      Elements observed mutating ≥ AUTO_MUTATION_MIN_COUNT times are flagged.
 *   4. Ancestor promotion              — small flagged elements are walked upward
 *      to find a reasonably sized parent container.
 *
 * Output: array of AutoDynamicRegion objects (serialisable, no DOM handles).
 *
 * Separate exports:
 *   overlapRatio()          — used by triggerDiscovery + triggerRunner
 *   isInAutoDynamicRegion() — used by triggerDiscovery + triggerRunner
 *   freezeCssAnimations()   — optional stabilisation helper for trigger execution
 */

import { resetMutations, getMutations } from './mutationTracker.js';

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Minimum number of passive mutations on the same element before flagging it
 * via mutation evidence alone.  Class keyword detection has no threshold.
 */
const AUTO_MUTATION_MIN_COUNT = 2;

const MIN_REGION_W = 20;
const MIN_REGION_H = 20;

/**
 * Default class / id substrings that strongly imply an auto-playing region.
 * Matching is case-insensitive substring search (no regex special chars needed).
 * Override via autoDynamicClassKeywords config option.
 */
export const DEFAULT_AUTO_DYNAMIC_KEYWORDS = [
  'banner', 'carousel', 'slider', 'swiper', 'slick',
  'rolling', 'promo', 'autoplay', 'rotating', 'rotator',
  'marquee', 'ticker', 'mainvisual', 'main-visual', 'hero-visual',
  'visualslide', 'visual-slide', 'adslot', 'adsense', 'adroll',
];

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Observe the page passively and detect auto-dynamic (self-updating) regions.
 *
 * Call AFTER installMutationTracker() has been run on the page.
 * Internally resets the mutation buffer before the observation window starts
 * so load-time mutations do not pollute the result.
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   observationMs?:  number,    // silent watch duration in ms (default 3000)
 *   classKeywords?:  string[],  // substrings implying an auto-dynamic container
 *   enabled?:        boolean,   // false → skip entirely, return [] immediately
 * }} opts
 * @returns {Promise<object[]>}  Serialisable AutoDynamicRegion array
 */
export async function detectAutoDynamicRegions(page, opts = {}) {
  const {
    observationMs = 3_000,
    classKeywords = DEFAULT_AUTO_DYNAMIC_KEYWORDS,
    enabled       = true,
  } = opts;

  if (!enabled) return [];

  // ── Reset mutations then observe passively ────────────────────────────────
  await resetMutations(page).catch(() => {});
  await page.waitForTimeout(observationMs);
  const rawMutations = (await getMutations(page).catch(() => [])) || [];

  console.log(`[autoDynamic]  observed ${rawMutations.length} passive mutation(s) over ${observationMs}ms`);

  // ── In-page analysis: DOM scan + mutation target lookup ───────────────────
  const regions = await page.evaluate(_detectInPage, {
    mutationData:     rawMutations,
    classKeywords,
    minMutationCount: AUTO_MUTATION_MIN_COUNT,
    minW:             MIN_REGION_W,
    minH:             MIN_REGION_H,
  }).catch((err) => {
    console.log(`[autoDynamic]  evaluate failed (context likely destroyed) — using empty result`);
    return [];
  });

  console.log(`[autoDynamic]  ${(regions || []).length} auto-dynamic region(s) detected`);
  return regions || [];
}

// ── In-page detection (serialised and evaluated inside Chrome) ────────────────
//
// IMPORTANT: _detectInPage must be entirely self-contained.
// It is stringified and sent to the browser — no outer-scope references allowed.

function _detectInPage({ mutationData, classKeywords, minMutationCount, minW, minH }) {
  // ── Helpers ────────────────────────────────────────────────────────────────

  function getBbox(el) {
    const r = el.getBoundingClientRect();
    return {
      x:      Math.round(r.left + window.scrollX),
      y:      Math.round(r.top  + window.scrollY),
      width:  Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  function matchesKeyword(el) {
    const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
    const id  = (el.id || '').toLowerCase();
    return classKeywords.some((kw) => cls.includes(kw) || id.includes(kw));
  }

  function isVisible(el) {
    try {
      const s = window.getComputedStyle(el);
      return s.display !== 'none'
          && s.visibility !== 'hidden'
          && parseFloat(s.opacity || '1') > 0.05;
    } catch (_) {
      return true;
    }
  }

  /**
   * Walk up the ancestor chain (max 6 steps) to find a container sized
   * at least minW × minH.  Prevents tiny inner nodes from being the region root.
   */
  function promoteToContainer(el) {
    let node = el;
    for (let i = 0; i < 6; i++) {
      if (!node || node === document.body) break;
      const r = node.getBoundingClientRect();
      if (r.width >= minW && r.height >= minH) return node;
      node = node.parentElement;
    }
    return el;
  }

  const seen    = new WeakSet();
  const regions = [];

  function record(el, reasons, mutationCount) {
    const container = promoteToContainer(el);

    // If already seen, merge mutation count and any new reasons
    if (seen.has(container)) {
      for (const r of regions) {
        if (r._el === container) {
          r.observedMutationCount += mutationCount;
          for (const reason of reasons) {
            if (!r.reasons.includes(reason)) r.reasons.push(reason);
          }
          return;
        }
      }
      return;
    }

    seen.add(container);
    if (!isVisible(container)) return;

    const bbox = getBbox(container);
    if (bbox.width < minW || bbox.height < minH) return;

    regions.push({
      _el:                   container,   // stripped before returning to Node.js
      bbox,
      reasons,
      observedMutationCount: mutationCount,
      tagName:               container.tagName.toLowerCase(),
      id:                    container.id || null,
      classNames:            typeof container.className === 'string'
                               ? container.className.trim().split(/\s+/).filter(Boolean)
                               : [],
      excludedTriggerCount:  0,   // populated in Node.js after candidate filtering
    });
  }

  // ── Pass 1: Static class / id keyword scan ─────────────────────────────────
  try {
    for (const el of document.querySelectorAll('*')) {
      if (matchesKeyword(el)) record(el, ['class_keyword_match'], 0);
    }
  } catch (_) {}

  // ── Pass 2: aria-live containers ───────────────────────────────────────────
  try {
    for (const el of document.querySelectorAll(
      '[aria-live],[aria-atomic="true"],[aria-relevant]',
    )) {
      record(el, ['aria_live_attribute'], 0);
    }
  } catch (_) {}

  // ── Pass 3: Passive mutation targets ──────────────────────────────────────
  // Aggregate mutation counts per target identity (by id, then by first class token).
  const mutCountById    = Object.create(null);
  const mutCountByClass = Object.create(null);

  for (const m of mutationData) {
    if (m.targetId && m.targetId.length)
      mutCountById[m.targetId] = (mutCountById[m.targetId] || 0) + 1;
    if (m.targetClass && m.targetClass.length)
      mutCountByClass[m.targetClass] = (mutCountByClass[m.targetClass] || 0) + 1;
  }

  for (const [targetId, count] of Object.entries(mutCountById)) {
    if (count < minMutationCount) continue;
    try {
      const el = document.getElementById(targetId);
      if (el) record(el, ['passive_mutation'], count);
    } catch (_) {}
  }

  for (const [cls, count] of Object.entries(mutCountByClass)) {
    if (count < minMutationCount) continue;
    try {
      const firstCls = cls.trim().split(/\s+/)[0];
      if (!firstCls) continue;
      const el = document.querySelector('.' + CSS.escape(firstCls));
      if (el) record(el, ['passive_mutation'], count);
    } catch (_) {}
  }

  // Strip the non-serialisable DOM handle before sending back to Node.js
  for (const r of regions) delete r._el;
  return regions;
}

// ── Overlap utilities ─────────────────────────────────────────────────────────
// Exported for use in triggerDiscovery.js and triggerRunner.js.

/**
 * Proportion of bbox `a` covered by bbox `b`.
 * Return value is in [0, 1].  1.0 means `a` is fully contained inside `b`.
 *
 * @param {{ x, y, width, height }} a
 * @param {{ x, y, width, height }} b
 */
export function overlapRatio(a, b) {
  if (!a || !b) return 0;
  const ix = Math.max(0, Math.min(a.x + a.width,  b.x + b.width)  - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = ix * iy;
  const areaA = a.width * a.height;
  return areaA > 0 ? intersection / areaA : 0;
}

/**
 * Returns true if bbox overlaps any auto-dynamic region by more than `threshold`.
 *
 * @param {{ x, y, width, height }|null} bbox
 * @param {object[]} autoDynamicRegions  - Output of detectAutoDynamicRegions()
 * @param {number}   threshold           - Overlap fraction [0, 1] (default 0.3)
 */
export function isInAutoDynamicRegion(bbox, autoDynamicRegions, threshold = 0.3) {
  if (!autoDynamicRegions || !autoDynamicRegions.length || !bbox) return false;
  return autoDynamicRegions.some((r) => overlapRatio(bbox, r.bbox) > threshold);
}

// ── Optional CSS stabilisation ────────────────────────────────────────────────

/**
 * Inject a <style> tag that pauses all CSS animations and transitions.
 *
 * Optional helper that reduces animation-driven background mutations during
 * trigger execution.  Call AFTER navigateTo() and BEFORE resetMutations() so
 * any style-injection mutations are cleared by the subsequent reset.
 *
 * Enable via FREEZE_CSS_TRIGGERS=true in .env (default: false).
 *
 * Does NOT replace classification-based exclusion — use together, not instead.
 */
export async function freezeCssAnimations(page) {
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-play-state: paused     !important;
      animation-duration:   0.0001s   !important;
      transition-duration:  0s        !important;
    }`,
  }).catch(() => {});
}
