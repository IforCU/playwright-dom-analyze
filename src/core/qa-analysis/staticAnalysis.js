/**
 * core/staticAnalysis.js
 *
 * WHERE STATIC PARSING HAPPENS.
 *
 * Runs entirely inside page.evaluate() so we have direct DOM access without
 * serialization round-trips per element.  Returns plain serializable objects —
 * no DOM handles leak out of this module.
 *
 * Each visible node gets:
 *   - identity: nodeId, tagName, id, classList, role
 *   - content:  text, href, type
 *   - geometry: bbox (document-absolute coordinates)
 *   - context:  selectorHint, group (landmark classification)
 */

/**
 * Extract all visible DOM nodes and classify them in one evaluate call.
 * Coordinates are document-absolute (rect + scrollOffset).
 */
export async function extractStaticNodes(page) {
  return page.evaluate(() => {
    // Tags we never want to report as components
    const SKIP_TAGS = new Set([
      'html', 'head', 'script', 'style', 'meta', 'link',
      'noscript', 'template', 'base', 'title',
    ]);

    // Landmark tags used for group classification
    const LANDMARK_TAGS = new Set(['header', 'nav', 'main', 'section', 'aside', 'footer']);

    // ── Helpers ──────────────────────────────────────────────────────────────

    function buildSelectorHint(el) {
      const tag = el.tagName.toLowerCase();
      try {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const cls = Array.from(el.classList).slice(0, 2);
        if (cls.length) return `${tag}.${cls.map((c) => CSS.escape(c)).join('.')}`;
      } catch (_) { /* CSS.escape unavailable — fall through */ }
      return tag;
    }

    /** Only direct text-node children to avoid duplicating child element text */
    function getDirectText(el) {
      return Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .filter(Boolean)
        .join(' ')
        .slice(0, 120);
    }

    /** Walk ancestor chain to find the nearest landmark group */
    function classifyElement(el) {
      const tag = el.tagName.toLowerCase();
      if (LANDMARK_TAGS.has(tag)) return tag;

      const role = el.getAttribute('role');
      if (role === 'banner')       return 'header';
      if (role === 'navigation')   return 'nav';
      if (role === 'main')         return 'main';
      if (role === 'complementary') return 'aside';
      if (role === 'contentinfo')  return 'footer';
      if (role === 'dialog' || role === 'alertdialog') return 'modal-like';

      if (el.getAttribute('aria-modal') === 'true') return 'modal-like';

      const classStr = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      if (/\b(modal|dialog|overlay|popup|lightbox)\b/.test(classStr)) return 'modal-like';

      // Walk up to body
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

    // ── Main extraction loop ──────────────────────────────────────────────────

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const results = [];
    let counter = 0;

    for (const el of document.querySelectorAll('*')) {
      if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue;

      const rect = el.getBoundingClientRect();
      // Skip zero-size or near-zero elements
      if (rect.width < 2 || rect.height < 2) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none')        continue;
      if (style.visibility === 'hidden')   continue;
      if (parseFloat(style.opacity) < 0.05) continue;

      const tag  = el.tagName.toLowerCase();
      const text = getDirectText(el);
      const role = el.getAttribute('role') || null;

      results.push({
        nodeId:       `node-${++counter}`,
        tagName:      tag,
        text,
        role,
        id:           el.id || null,
        classList:    Array.from(el.classList).slice(0, 10),
        href:         el.getAttribute('href') || null,
        type:         el.getAttribute('type') || null,
        bbox: {
          x:      Math.round(rect.x + scrollX),
          y:      Math.round(rect.y + scrollY),
          width:  Math.round(rect.width),
          height: Math.round(rect.height),
        },
        isVisible:    true,
        selectorHint: buildSelectorHint(el),
        group:        classifyElement(el),
      });
    }

    return results;
  });
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
