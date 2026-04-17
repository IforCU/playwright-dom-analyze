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

    // ── PART 5: Focus score patterns ──────────────────────────────────────────
    // Tags that strongly signal human-meaningful interactive content
    const INTERACTIVE_TAGS    = new Set(['a','button','input','select','textarea','summary','label','details']);
    const MEDIA_TAGS           = new Set(['img','video','canvas','svg','picture','iframe']);
    const STRUCTURAL_TAGS      = new Set(['form','table','ul','ol','dl','nav','header','main','footer','section','article','aside','dialog']);
    const HEADING_TAGS         = new Set(['h1','h2','h3','h4','h5','h6']);
    // Class/id patterns that penalize ad / low-value nodes
    const AD_KW_RE             = /\b(ad|ads|advert|adsense|adroll|banner-ad|sponsored|promo-box|tracking|pixel|beacon)\b/i;
    // Class/id patterns that reward semantically meaningful nodes
    const CONTENT_KW_RE        = /\b(hero|feature|highlight|product|card|item|result|article|post|news|story|listing|search|form|filter|tab|accordion|modal|dialog|price|rating|review|breadcrumb|pagination|cta|action)\b/i;

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
      // Any meaningful aria-* attribute.
      // Explicitly excludes aria-hidden: aria-hidden="false" must not inflate
      // quality scores — it is not proof the element is visible or meaningful.
      const hasAria = Array.from(el.attributes).some(
        (a) => a.name.startsWith('aria-') && a.name !== 'aria-hidden'
      );
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

    /**
     * PART 5 — Compute a human-aligned focus score for a visible element.
     *
     * The focus score estimates how likely a human reviewer would consider this
     * element meaningful / worth inspecting.  It is independent of the quality
     * gate (which controls keep/drop); it is stored as focusScore on every kept
     * node and used to:
     *   - improve annotation priority (high-focus nodes annotated first)
     *   - improve trigger candidate ranking
     *   - surface quality warnings in the report when focus is dominated by
     *     low-value nodes
     *
     * Score range: typically −4 to +10.  Positive = meaningful.
     *
     * Factors:
     *   Visual importance:     size, centrality, viewport position
     *   Semantic importance:   tag category, role, heading, form, landmark
     *   Interactivity:         interactive tag, pointer cursor, focusable
     *   Content richness:      text length, child count, content keyword hints
     *   Noise penalties:       ad keyword, purely decorative, off-center tiny
     */
    function computeFocusScore(el, tag, rect, directText, role, style) {
      let score       = 0;
      const reasons   = [];
      const vw        = window.innerWidth  || 1920;
      const vh        = window.innerHeight || 1080;
      const area      = rect.width * rect.height;

      // ── Visual importance ──────────────────────────────────────────────────
      // Large visible area
      if (area >= 60_000) { score += 2; reasons.push('vis_large'); }
      else if (area >= 10_000) { score += 1; reasons.push('vis_medium'); }

      // Upper 60 % of viewport — primary reading zone
      const relTop = rect.top / vh;
      if (relTop < 0.6 && rect.top >= 0) { score += 1; reasons.push('vis_above_fold'); }

      // Horizontally central (between 10 % – 90 % viewport width)
      const relLeft  = rect.left  / vw;
      const relRight = rect.right / vw;
      if (relLeft > 0.05 && relRight < 0.95) { score += 1; reasons.push('vis_central'); }

      // ── Semantic importance ────────────────────────────────────────────────
      if (INTERACTIVE_TAGS.has(tag))   { score += 3; reasons.push('sem_interactive'); }
      else if (HEADING_TAGS.has(tag))  { score += 3; reasons.push('sem_heading');     }
      else if (MEDIA_TAGS.has(tag))    { score += 2; reasons.push('sem_media');       }
      else if (STRUCTURAL_TAGS.has(tag)) { score += 1; reasons.push('sem_structural'); }

      if (role === 'dialog' || role === 'alertdialog') { score += 2; reasons.push('sem_dialog'); }
      if (role === 'navigation')                        { score += 1; reasons.push('sem_nav');    }
      if (role === 'search')                            { score += 2; reasons.push('sem_search'); }
      if (role === 'form' || role === 'main')           { score += 1; reasons.push('sem_landmark');}

      // Meaningful class/id keyword
      const hint = [typeof el.className === 'string' ? el.className : '', el.id || ''].join(' ');
      if (CONTENT_KW_RE.test(hint)) { score += 1; reasons.push('sem_content_kw'); }

      // ── Content richness ───────────────────────────────────────────────────
      if (directText.length >= 20) { score += 2; reasons.push('rich_text'); }
      else if (directText.length >= cfg.minTextLength) { score += 1; reasons.push('has_text'); }

      const childCount = el.children.length;
      if (childCount >= 5) { score += 1; reasons.push('rich_children'); }

      // ── Interactivity ──────────────────────────────────────────────────────
      if (style.cursor === 'pointer')  { score += 1; reasons.push('int_pointer'); }
      if (el.tabIndex >= 0 && !INTERACTIVE_TAGS.has(tag)) {
        score += 1; reasons.push('int_focusable');
      }

      // ── Noise penalties ────────────────────────────────────────────────────
      if (AD_KW_RE.test(hint))        { score -= 3; reasons.push('noise_ad_kw');     }
      if (area < 400)                  { score -= 1; reasons.push('noise_tiny');      }
      if (childCount === 0 && directText.length < cfg.minTextLength && !INTERACTIVE_TAGS.has(tag) && !MEDIA_TAGS.has(tag)) {
        score -= 2; reasons.push('noise_empty_leaf');
      }
      // Purely decorative fixed element (very high z-index but tiny)
      const zIndex = parseInt(style.zIndex) || 0;
      if (zIndex > 1000 && area < 2000) { score -= 2; reasons.push('noise_decorative_fixed'); }

      return { focusScore: score, focusReasons: reasons };
    }

    /**
     * Check whether an element is visually clipped outside an overflow:hidden
     * ancestor's visible rect (e.g. items in a horizontal carousel that are
     * scrolled off the visible portion of the container).
     *
     * Walks up to 5 parent levels and checks if the element's rect overlaps
     * with any overflow:hidden / overflow:clip ancestor.  Returns true when
     * the element is fully outside such an ancestor's visible area.
     *
     * IMPORTANT: We stop the walk when we hit a parent with position:absolute
     * or position:fixed, because that parent is the CSS containing block for
     * any absolute/fixed descendants inside it.  overflow:hidden on ancestors
     * *above* that containing block does not clip elements within it.
     * This prevents dropdown panels and tooltips (which live inside an
     * overflow:hidden menu container but are absolutely positioned) from being
     * incorrectly filtered out.
     */
    function isClippedByParent(el, elRect) {
      // position:fixed elements are never clipped by any overflow:hidden ancestor.
      // position:absolute elements are only clipped up to their containing block;
      // we handle this via the break inside the walk below, so no early return
      // is needed here — but fixed is always safe to skip.
      const elPos = window.getComputedStyle(el).position;
      if (elPos === 'fixed') return false;

      let parent = el.parentElement;
      let depth  = 0;
      while (parent && parent !== document.body && parent !== document.documentElement && depth < 5) {
        const pStyle = window.getComputedStyle(parent);
        // A parent with position:absolute or position:fixed is the CSS
        // containing block boundary.  overflow:hidden on ancestors above this
        // parent does not clip our element, so stop the walk here.
        const pPos = pStyle.position;
        if (pPos === 'absolute' || pPos === 'fixed') break;

        const ovX = pStyle.overflowX;
        const ovY = pStyle.overflowY;
        const clips = (ovX === 'hidden' || ovX === 'clip' || ovY === 'hidden' || ovY === 'clip');
        if (clips) {
          const pr = parent.getBoundingClientRect();
          // Element is fully outside the clipping ancestor → visually invisible
          if (
            elRect.right  <= pr.left  ||
            elRect.left   >= pr.right ||
            elRect.bottom <= pr.top   ||
            elRect.top    >= pr.bottom
          ) {
            return true;
          }
        }
        parent = parent.parentElement;
        depth++;
      }
      return false;
    }

    // ── Three-tier visibility model ───────────────────────────────────────────
    //
    // Separates three distinct concepts that are often confused:
    //
    //   visuallyVisible      — the element is CSS-rendered and has real geometry
    //   accessibilityVisible — the element is exposed to the accessibility tree
    //   interactiveVisible   — the element is currently actionable by a user
    //
    // DESIGN RULE: aria-hidden="false" is NOT treated as a positive keep signal.
    // ARIA is advisory metadata; actual rendering and geometry take priority.
    //
    // Pre-build ancestor-lookup sets once per page.evaluate() call.
    // This avoids re-querying the DOM for every element in the main loop.
    const _ariaHiddenTrueRoots = new Set(document.querySelectorAll('[aria-hidden="true"]'));
    const _inertRoots          = new Set(document.querySelectorAll('[inert]'));

    /** Walk up: return true if any ancestor has aria-hidden="true". */
    function isInAriaHiddenSubtree(el) {
      let p = el.parentElement;
      while (p && p !== document.documentElement) {
        if (_ariaHiddenTrueRoots.has(p)) return true;
        p = p.parentElement;
      }
      return false;
    }

    /** Walk up (inclusive of self): return true if any ancestor/self has inert. */
    function isInInertSubtree(el) {
      let p = el;
      while (p && p !== document.documentElement) {
        if (_inertRoots.has(p)) return true;
        p = p.parentElement;
      }
      return false;
    }

    /**
     * Detect top-layer overlays (open dialogs, large fixed sheets, aria-modal).
     * Called once before the main extraction loop — not per element.
     * Returns an array sorted by z-index descending.
     */
    function detectTopLayerOverlays() {
      const overlays = [];
      const vw = window.innerWidth, vh = window.innerHeight;
      const vpArea = vw * vh || 1;

      // 1. Native <dialog open> — the browser's actual top-layer mechanism
      for (const dlg of document.querySelectorAll('dialog[open]')) {
        const s = window.getComputedStyle(dlg);
        if (s.display === 'none') continue;
        const r = dlg.getBoundingClientRect();
        if (r.width * r.height < vpArea * 0.04) continue;
        overlays.push({ el: dlg, rect: r, zIndex: 999999, isNativeDialog: true });
      }

      // 2. ARIA modal roles / aria-modal=true with significant coverage
      for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"]')) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const pos = s.position;
        if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
        const zi = parseInt(s.zIndex) || 0;
        if (zi < 20) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < vpArea * 0.04) continue;
        if (!overlays.some((o) => o.el === el))
          overlays.push({ el, rect: r, zIndex: zi, isNativeDialog: false });
      }

      // 3. Fixed direct body-children with high z-index + large coverage
      for (const el of document.body.children) {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        if (s.position !== 'fixed') continue;
        const zi = parseInt(s.zIndex) || 0;
        if (zi < 100) continue;
        if (parseFloat(s.opacity) < 0.05) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < vpArea * 0.04) continue;
        if (!overlays.some((o) => o.el === el))
          overlays.push({ el, rect: r, zIndex: zi, isNativeDialog: false });
      }

      overlays.sort((a, b) => b.zIndex - a.zIndex);
      return overlays;
    }

    /**
     * Return true if el's center point is covered by any detected overlay,
     * excluding the overlay itself and its own descendants.
     */
    function isBlockedByOverlay(el, rect, overlays) {
      const cx = rect.left + rect.width  / 2;
      const cy = rect.top  + rect.height / 2;
      for (const ov of overlays) {
        if (ov.el === el || ov.el.contains(el)) continue;
        const o = ov.rect;
        if (cx >= o.left && cx <= o.right && cy >= o.top && cy <= o.bottom) return true;
      }
      return false;
    }

    /**
     * Compute the three-tier visibility model for one element.
     *
     *   visuallyVisible      — element is CSS-rendered, not hidden, has geometry
     *   accessibilityVisible — element is exposed to the accessibility tree
     *   interactiveVisible   — element is currently actionable
     *
     * PRIORITY: rendering > interactability > ARIA hints
     *
     * aria-hidden="false" gives NO positive signal — it only overrides an ancestor
     * aria-hidden="true" for accessibility purposes and does NOT imply the element
     * is rendered or interactable.  Real geometry and CSS always take priority.
     */
    function computeVisibility(el, rect, style, topLayerOverlays) {
      const reasons = [];

      // ── 1. CSS / HTML attribute rendering checks ──────────────────────────
      let hiddenByCss = false;
      if (style.display === 'none')          { hiddenByCss = true; reasons.push('css_display_none'); }
      if (style.visibility === 'hidden')     { hiddenByCss = true; reasons.push('css_visibility_hidden'); }
      if (parseFloat(style.opacity) < 0.05)  { hiddenByCss = true; reasons.push('css_opacity_zero'); }
      // html `hidden` attribute maps to display:none via UA stylesheet; record
      // it explicitly so debug output shows the true cause.
      if (el.hasAttribute('hidden'))         { hiddenByCss = true; reasons.push('attr_html_hidden'); }

      // ── 2. Size ───────────────────────────────────────────────────────────
      const tooSmall = rect.width < 2 || rect.height < 2;
      if (tooSmall) reasons.push('too_small');

      // ── 3. Inert subtree ──────────────────────────────────────────────────
      const isInert = isInInertSubtree(el);
      if (isInert) reasons.push('inert_subtree');

      // ── 4. Overlay occlusion ──────────────────────────────────────────────
      // The element IS CSS-rendered but is occluded by a top-layer overlay.
      // We track this separately from visuallyVisible (the element has real
      // geometry) — overlay-awareness is mainly used by trigger candidate logic.
      let blockedByOverlay = false;
      if (!hiddenByCss && !tooSmall && topLayerOverlays.length > 0) {
        blockedByOverlay = isBlockedByOverlay(el, rect, topLayerOverlays);
        if (blockedByOverlay) reasons.push('blocked_by_overlay');
      }

      // ── 5. ARIA model (advisory only) ─────────────────────────────────────
      const ariaHiddenValue      = el.getAttribute('aria-hidden'); // "true"|"false"|null
      const hiddenByAncestorAria = isInAriaHiddenSubtree(el);
      let accessibilityVisible   = true;
      if (ariaHiddenValue === 'true')  { accessibilityVisible = false; reasons.push('aria_hidden_true_self'); }
      if (hiddenByAncestorAria)        { accessibilityVisible = false; reasons.push('aria_hidden_ancestor'); }
      // aria-hidden="false" gives NO keep bonus — it is not a positive visibility
      // signal in this model.  It only weakly overrides an ancestor aria-hidden="true"
      // at the accessibility tree level, and has no effect on rendering.

      // ── 6. Composed visuallyVisible ───────────────────────────────────────
      // blockedByOverlay is intentionally NOT included: the element IS rendered
      // (it has real CSS geometry), it is just visually occluded.  Callers that
      // need overlay-awareness check vis.blockedByOverlay explicitly.
      const visuallyVisible = !hiddenByCss && !tooSmall && !isInert;

      // ── 7. interactiveVisible ─────────────────────────────────────────────
      const isDisabled    = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      const noPointerEvts = style.pointerEvents === 'none';
      const interactiveVisible = visuallyVisible && !isDisabled && !isInert && !blockedByOverlay && !noPointerEvts;

      // ── 8. Mismatch annotations ───────────────────────────────────────────
      // Surface cases where ARIA state contradicts actual rendering.
      // These are kept as debug tokens on visibilityReasons.
      if (ariaHiddenValue === 'false') {
        if (!visuallyVisible)       reasons.push('mismatch__aria_false_but_not_rendered');
        if (tooSmall)               reasons.push('mismatch__aria_false_but_zero_area');
        if (blockedByOverlay)       reasons.push('mismatch__aria_false_but_overlay_blocked');
        if (hiddenByAncestorAria)   reasons.push('mismatch__aria_false_but_ancestor_aria_true');
      }
      if (ariaHiddenValue === 'true' && visuallyVisible) {
        reasons.push('mismatch__aria_true_but_visually_present');
      }

      return {
        visuallyVisible,
        accessibilityVisible,
        interactiveVisible,
        ariaHiddenValue,
        hiddenByAncestorAria,
        hiddenByCss,
        blockedByOverlay,
        isInert,
        visibilityReasons: reasons,
      };
    }

    // ── Main extraction loop ──────────────────────────────────────────────────

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const vw      = window.innerWidth;
    const nodes             = [];
    const droppedNodes      = [];
    const visibilityMismatches = [];
    let counter = 0;

    // Detect top-layer overlays once before the loop.
    const topLayerOverlays = detectTopLayerOverlays();

    for (const el of document.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      // Always skip the body element — it is too coarse to be a useful component
      if (el === document.body) continue;

      const rect = el.getBoundingClientRect();

      // Quick positional pre-filters (cheap) before the full visibility model.
      // isClippedByParent also uses rect, so keep it here.
      if (rect.right < 0 || rect.left > vw) continue;
      if (isClippedByParent(el, rect)) continue;

      const style = window.getComputedStyle(el);

      // ── Three-tier visibility check ────────────────────────────────────────
      // Replaces the old flat CSS-only checks.  visuallyVisible is the gate;
      // the full vis object is stored on the node for audit / Phase 2 use.
      const vis = computeVisibility(el, rect, style, topLayerOverlays);

      if (!vis.visuallyVisible) {
        // Collect aria-hidden mismatch cases for outputs/{jobId}/visibility-debug.json
        if (vis.visibilityReasons.some((r) => r.startsWith('mismatch__'))) {
          visibilityMismatches.push({
            selectorHint:     buildSelectorHint(el),
            tagName:          tag,
            ariaHiddenValue:  vis.ariaHiddenValue,
            visibilityReasons: vis.visibilityReasons,
            bbox: {
              x:      Math.round(rect.x + scrollX),
              y:      Math.round(rect.y + scrollY),
              width:  Math.round(rect.width),
              height: Math.round(rect.height),
            },
          });
        }
        continue;
      }

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

      // ── PART 5: Focus score (all nodes) ───────────────────────────────────
      const { focusScore, focusReasons } = computeFocusScore(el, tag, rect, text, role, style);

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
        isVisible:     vis.visuallyVisible,
        selectorHint:  buildSelectorHint(el),
        group:         classifyElement(el),
        qualityScore,
        qualityReasons,
        focusScore,
        focusReasons,
        // Three-tier visibility model metadata — kept on every node for
        // audit, quality reporting, and future Phase 2 / VLM consumption.
        visibility: {
          visuallyVisible:      vis.visuallyVisible,
          accessibilityVisible: vis.accessibilityVisible,
          interactiveVisible:   vis.interactiveVisible,
          ariaHiddenValue:      vis.ariaHiddenValue,
          hiddenByAncestorAria: vis.hiddenByAncestorAria,
          hiddenByCss:          vis.hiddenByCss,
          blockedByOverlay:     vis.blockedByOverlay,
          isInert:              vis.isInert,
          visibilityReasons:    vis.visibilityReasons,
        },
      };

      if (keep) {
        nodes.push(nodeData);
      } else if (cfg.debugDrop) {
        droppedNodes.push({ ...nodeData, dropReason });
      }
    }

    return { nodes, droppedNodes, visibilityMismatches };

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
