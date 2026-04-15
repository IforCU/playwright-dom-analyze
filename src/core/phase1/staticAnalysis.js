/**
 * core/phase1/staticAnalysis.js
 *
 * WHERE STATIC PARSING HAPPENS.
 *
 * All extraction runs inside page.evaluate() so we have direct DOM access
 * without per-element serialization round-trips. Returns plain serializable
 * objects — no DOM handles leak out of this module.
 *
 * Exports:
 *   extractStaticNodes(page, opts)
 *       — visible DOM nodes after quality filtering, plus debug info
 *       Returns: { nodes: [...], droppedNodes: [...] }
 *   getPageMeta(page)  — title, URL, viewport, document dimensions
 *   getPageLinks(page) — anchors, forms, canonical, og:url for Phase 3
 *
 * Quality filtering:
 *   High-value semantic tags are always kept when visible and sized.
 *   Generic containers (div / span / p) must pass a heuristic quality score
 *   above NODE_QUALITY_THRESHOLD to be included.
 *   The goal is to improve signal-to-noise ratio for future VLM consumption.
 */

// ── Configurable thresholds (can be overridden via opts) ──────────────────────
const DEFAULTS = {
  minTextLength:       3,    // minimum direct-text chars to earn text bonus
  minArea:          200,    // px² below which a node earns a size penalty
  qualityThreshold:   3,    // min quality score for generic tag nodes
  debugDrop:       false,   // when true, return dropped nodes too
};

/**
 * Extract visible DOM nodes, apply quality filtering, and classify them.
 * Coordinates are document-absolute (rect + scrollOffset).
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number}  [opts.minTextLength]
 * @param {number}  [opts.minArea]
 * @param {number}  [opts.qualityThreshold]
 * @param {boolean} [opts.debugDrop]   — include dropped nodes in result
 * @returns {Promise<{ nodes: object[], droppedNodes: object[] }>}
 */
export async function extractStaticNodes(page, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  return page.evaluate((cfg) => {

    // ── Constants ─────────────────────────────────────────────────────────────

    const SKIP_TAGS = new Set([
      'html', 'head', 'script', 'style', 'meta', 'link',
      'noscript', 'template', 'base', 'title',
    ]);

    // Tags that are inherently meaningful — always kept when visible & sized
    const HIGH_VALUE_TAGS = new Set([
      'header', 'nav', 'main', 'section', 'article', 'aside', 'footer',
      'form', 'button', 'a', 'input', 'select', 'textarea', 'label',
      'summary', 'dialog', 'details', 'table', 'ul', 'ol', 'li',
      'img', 'video', 'iframe', 'canvas', 'svg',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ]);

    // Generic containers that need extra checks
    const GENERIC_TAGS = new Set(['div', 'span', 'p']);

    const LANDMARK_TAGS = new Set(['header', 'nav', 'main', 'section', 'aside', 'footer']);

    // Semantic class/id hint patterns → bonus
    const SEMANTIC_HINT_RE = /\b(header|nav|menu|sidebar|content|article|modal|dialog|popup|tooltip|tab|panel|card|list|item|breadcrumb|pagination|search|filter|dropdown|banner|hero|section|footer|wrapper|container|layout)\b/i;

    // ── Helpers ───────────────────────────────────────────────────────────────

    function buildSelectorHint(el) {
      const tag = el.tagName.toLowerCase();
      try {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const cls = Array.from(el.classList).slice(0, 2);
        if (cls.length) return `${tag}.${cls.map((c) => CSS.escape(c)).join('.')}`;
      } catch (_) {}
      return tag;
    }

    function getDirectText(el) {
      return Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 120);
    }

    function classifyElement(el) {
      const tag = el.tagName.toLowerCase();
      if (LANDMARK_TAGS.has(tag)) return tag;

      const role = el.getAttribute('role');
      if (role === 'banner')        return 'header';
      if (role === 'navigation')    return 'nav';
      if (role === 'main')          return 'main';
      if (role === 'complementary') return 'aside';
      if (role === 'contentinfo')   return 'footer';
      if (role === 'dialog' || role === 'alertdialog') return 'modal-like';
      if (el.getAttribute('aria-modal') === 'true')    return 'modal-like';

      const classStr = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      if (/\b(modal|dialog|overlay|popup|lightbox)\b/.test(classStr)) return 'modal-like';

      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.body) {
        const aTag = ancestor.tagName.toLowerCase();
        if (LANDMARK_TAGS.has(aTag)) return aTag;
        const aRole = ancestor.getAttribute('role');
        if (aRole === 'banner')        return 'header';
        if (aRole === 'navigation')    return 'nav';
        if (aRole === 'main')          return 'main';
        if (aRole === 'complementary') return 'aside';
        if (aRole === 'contentinfo')   return 'footer';
        if (aRole === 'dialog' || aRole === 'alertdialog') return 'modal-like';
        ancestor = ancestor.parentElement;
      }
      return 'unknown';
    }

    /**
     * Heuristic quality score for generic container tags.
     * Returns { score: number, reasons: string[] }.
     *
     * Positive signals (bonuses):
     *   +3  meaningful direct text above minTextLength
     *   +2  semantic role attribute
     *   +2  any aria-* attribute
     *   +2  semantic class/id hint
     *   +1  pointer cursor (interactive)
     *   +1  onclick / event handler attributes
     *   +1  tabIndex >= 0 (focusable)
     *   +2  multiple meaningful children (>=3 child elements)
     *   +2  visually large area (>= 40000 px²)
     *   +1  medium area (>= 5000 px²)
     *   +1  top-level layout block (direct child of body or landmark)
     *
     * Negative signals (penalties):
     *   -2  single child element only (pure wrapper)
     *   -1  no children at all (empty container)
     *   -1  area < minArea
     *   -1  duplicate bbox with parent (within 2px tolerance)
     */
    function scoreGenericNode(el, rect, directText, role, style) {
      let score = 0;
      const reasons = [];

      // ── Bonuses ──────────────────────────────────────────────────────────────
      if (directText.length >= cfg.minTextLength) {
        score += 3;
        reasons.push('has_text');
      }
      if (role) {
        score += 2;
        reasons.push('has_role');
      }
      // Any aria-* attribute
      const hasAria = Array.from(el.attributes).some((a) => a.name.startsWith('aria-'));
      if (hasAria) {
        score += 2;
        reasons.push('has_aria');
      }
      // Semantic class or id hint
      const hintStr = [
        typeof el.className === 'string' ? el.className : '',
        el.id || '',
      ].join(' ');
      if (SEMANTIC_HINT_RE.test(hintStr)) {
        score += 2;
        reasons.push('semantic_hint');
      }
      // Pointer cursor → likely interactive
      if (style.cursor === 'pointer') {
        score += 1;
        reasons.push('pointer_cursor');
      }
      // Inline event or tabIndex
      if (el.hasAttribute('onclick') || el.hasAttribute('onkeydown') ||
          el.hasAttribute('onkeyup') || el.hasAttribute('onmousedown')) {
        score += 1;
        reasons.push('event_attr');
      }
      if (el.tabIndex >= 0) {
        score += 1;
        reasons.push('focusable');
      }
      // Multiple meaningful children
      const childCount = el.children.length;
      if (childCount >= 3) {
        score += 2;
        reasons.push('multi_children');
      }
      // Visual area
      const area = rect.width * rect.height;
      if (area >= 40_000) {
        score += 2;
        reasons.push('large_area');
      } else if (area >= 5_000) {
        score += 1;
        reasons.push('medium_area');
      }
      // Top-level layout block
      const parent = el.parentElement;
      if (parent) {
        const pTag = parent.tagName.toLowerCase();
        if (pTag === 'body' || LANDMARK_TAGS.has(pTag)) {
          score += 1;
          reasons.push('top_level_block');
        }
      }

      // ── Penalties ─────────────────────────────────────────────────────────────
      if (childCount === 1) {
        score -= 2;
        reasons.push('single_child_wrapper');
      } else if (childCount === 0) {
        score -= 1;
        reasons.push('empty_container');
      }
      if (area < cfg.minArea) {
        score -= 1;
        reasons.push('tiny_area');
      }
      // Duplicate bbox with direct parent (within 2px tolerance)
      if (parent) {
        const pr = parent.getBoundingClientRect();
        if (
          Math.abs(pr.x - rect.x) <= 2 && Math.abs(pr.y - rect.y) <= 2 &&
          Math.abs(pr.width - rect.width) <= 2 && Math.abs(pr.height - rect.height) <= 2
        ) {
          score -= 1;
          reasons.push('duplicate_bbox_parent');
        }
      }

      return { score, reasons };
    }

    // ── Main extraction loop ──────────────────────────────────────────────────

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const nodes       = [];
    const droppedNodes = [];
    let counter = 0;

    for (const el of document.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none')         continue;
      if (style.visibility === 'hidden')    continue;
      if (parseFloat(style.opacity) < 0.05) continue;

      const text = getDirectText(el);
      const role = el.getAttribute('role') || null;

      const bbox = {
        x:      Math.round(rect.x + scrollX),
        y:      Math.round(rect.y + scrollY),
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
      };

      // ── Quality gate for generic container tags ───────────────────────────
      let qualityScore = null;
      let qualityReasons = [];
      let keep = true;
      let dropReason = null;

      if (GENERIC_TAGS.has(tag)) {
        const { score, reasons } = scoreGenericNode(el, rect, text, role, style);
        qualityScore   = score;
        qualityReasons = reasons;
        if (score < cfg.qualityThreshold) {
          keep       = false;
          dropReason = `quality_score_${score}<${cfg.qualityThreshold}`;
        }
      }
      // High-value tags always pass — no quality gate

      const nodeData = {
        nodeId:        `node-${++counter}`,
        tagName:       tag,
        text,
        role,
        id:            el.id || null,
        classList:     Array.from(el.classList).slice(0, 10),
        href:          el.getAttribute('href') || null,
        type:          el.getAttribute('type') || null,
        bbox,
        isVisible:     true,
        selectorHint:  buildSelectorHint(el),
        group:         classifyElement(el),
        qualityScore,
        qualityReasons,
      };

      if (keep) {
        nodes.push(nodeData);
      } else if (cfg.debugDrop) {
        droppedNodes.push({ ...nodeData, dropReason });
      }
    }

    return { nodes, droppedNodes };

  }, cfg);
}

/** Collect page-level metadata (URL, title, viewport, document dimensions) */
export async function getPageMeta(page) {
  return page.evaluate(() => ({
    finalUrl: location.href,
    title:    document.title,
    viewport: { width: window.innerWidth,  height: window.innerHeight },
    document: {
      width:  document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
  }));
}

/**
 * Collect all raw navigable links from the page for Phase 3 URL extraction.
 * Includes non-visible elements (canonical, og:url, form actions, all anchors).
 */
export async function getPageLinks(page) {
  return page.evaluate(() => {
    const anchors     = [];
    const areas       = [];
    const formActions = [];
    let canonical     = null;
    let ogUrl         = null;

    for (const el of document.querySelectorAll('a[href]')) {
      const href = el.getAttribute('href');
      if (href) anchors.push(href);
    }
    for (const el of document.querySelectorAll('area[href]')) {
      const href = el.getAttribute('href');
      if (href) areas.push(href);
    }
    for (const el of document.querySelectorAll('form[action]')) {
      const action = el.getAttribute('action');
      if (action) formActions.push(action);
    }
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    if (canonicalEl) canonical = canonicalEl.getAttribute('href');

    const ogEl = document.querySelector('meta[property="og:url"]');
    if (ogEl) ogUrl = ogEl.getAttribute('content');

    return { anchors, areas, formActions, canonical, ogUrl };
  });
}
