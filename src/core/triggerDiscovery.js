/**
 * core/triggerDiscovery.js
 *
 * WHERE DYNAMIC TRIGGER CANDIDATES ARE DISCOVERED.
 *
 * Scans the baseline page for interactive elements that are likely to reveal
 * hidden content when clicked or hovered.  Runs inside page.evaluate() for
 * direct DOM inspection.
 *
 * Scoring heuristics:
 *   - aria-expanded / aria-haspopup  → highest score (explicit expandable intent)
 *   - summary / details               → high score (native disclosure widget)
 *   - button / role=button            → medium-high
 *   - a[href], input[type=button/submit] → medium
 *   - onclick, [tabindex]             → base
 *   Bonus: dropdown/toggle/menu CSS class hints, non-empty text content
 */

export async function findTriggerCandidates(page) {
  return page.evaluate(() => {
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
      if (style.display === 'none')         return false;
      if (style.visibility === 'hidden')    return false;
      if (parseFloat(style.opacity) < 0.05) return false;
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

    // Ordered by priority (highest-value selectors first)
    const queries = [
      { sel: '[aria-expanded]',                 reason: 'has aria-expanded',       baseScore: 5 },
      { sel: '[aria-haspopup]',                 reason: 'has aria-haspopup',       baseScore: 5 },
      { sel: 'summary',                         reason: 'details/summary expander',baseScore: 4 },
      { sel: 'button:not([disabled])',          reason: 'button element',          baseScore: 3 },
      { sel: '[role="button"]',                 reason: 'role=button',             baseScore: 3 },
      { sel: 'input[type="button"]:not([disabled])', reason: 'input[type=button]', baseScore: 2 },
      { sel: 'input[type="submit"]:not([disabled])', reason: 'input[type=submit]', baseScore: 2 },
      { sel: 'a[href]',                         reason: 'anchor link',             baseScore: 2 },
      { sel: '[onclick]',                       reason: 'inline onclick',          baseScore: 2 },
      { sel: '[tabindex]:not([tabindex="-1"])', reason: 'tabindex >= 0',           baseScore: 1 },
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

        // Guess trigger type: prefer hover for tooltip-style elements
        let triggerType = 'click';
        if (
          el.getAttribute('title') &&
          !['button', 'a', 'input', 'summary'].includes(tag)
        ) {
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
}
