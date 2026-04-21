/**
 * core/phase1/mutationTracker.js
 *
 * WHERE MUTATION TRACKING HAPPENS.
 *
 * Installs a MutationObserver that records every DOM change from the moment
 * it is activated. Two installation paths:
 *
 *   addInitScript(MUTATION_TRACKER_SCRIPT) — IIFE string registered on the
 *     BrowserContext; runs before page scripts (catches very early mutations).
 *
 *   installMutationTracker(page) — serialises _trackerFn and runs it via
 *     page.evaluate(); the most reliable path with system Chrome.
 *
 * After installation, the page exposes:
 *   window.__getMutations__()   → snapshot of the mutation buffer
 *   window.__resetMutations__() → clears the buffer
 */

/** IIFE string for use with browserContext.addInitScript() */
export const MUTATION_TRACKER_SCRIPT = `
(function () {
  if (typeof window.__resetMutations__ === 'function') return;
  window.__mutationBuffer__ = [];
  function serializeNode(node) {
    if (!node || node.nodeType !== 1) return null;
    return {
      tag:     node.tagName ? node.tagName.toLowerCase() : null,
      id:      node.id || null,
      classes: typeof node.className === 'string' ? node.className : null,
      text:    (node.textContent || '').trim().slice(0, 120),
    };
  }
  const observer = new MutationObserver(function (mutations) {
    for (const m of mutations) {
      window.__mutationBuffer__.push({
        type:          m.type,
        targetTag:     m.target ? m.target.tagName.toLowerCase() : null,
        targetId:      m.target ? (m.target.id || null) : null,
        targetClass:   m.target ? (typeof m.target.className === 'string' ? m.target.className : null) : null,
        addedNodes:    Array.from(m.addedNodes).map(serializeNode).filter(Boolean),
        removedNodes:  Array.from(m.removedNodes).map(serializeNode).filter(Boolean),
        attributeName: m.attributeName || null,
        oldValue:      m.oldValue || null,
      });
    }
  });
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeOldValue: true,
  });
  window.__getMutations__   = function () { return window.__mutationBuffer__.slice(); };
  window.__resetMutations__ = function () { window.__mutationBuffer__ = []; };
})();
`;

/**
 * Self-contained function evaluated in the browser context via page.evaluate().
 * Must NOT reference any Node.js variables — it is serialised and sent to Chrome.
 */
function _trackerFn() {
  if (typeof window.__resetMutations__ === 'function') return; // idempotent
  window.__mutationBuffer__ = [];

  function serializeNode(node) {
    if (!node || node.nodeType !== 1) return null;
    return {
      tag:     node.tagName ? node.tagName.toLowerCase() : null,
      id:      node.id || null,
      classes: typeof node.className === 'string' ? node.className : null,
      text:    (node.textContent || '').trim().slice(0, 120),
    };
  }

  const observer = new MutationObserver(function (mutations) {
    for (const m of mutations) {
      window.__mutationBuffer__.push({
        type:          m.type,
        targetTag:     m.target ? m.target.tagName.toLowerCase() : null,
        targetId:      m.target ? (m.target.id || null) : null,
        targetClass:   m.target
          ? (typeof m.target.className === 'string' ? m.target.className : null)
          : null,
        addedNodes:    Array.from(m.addedNodes).map(serializeNode).filter(Boolean),
        removedNodes:  Array.from(m.removedNodes).map(serializeNode).filter(Boolean),
        attributeName: m.attributeName || null,
        oldValue:      m.oldValue      || null,
      });
    }
  });

  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeOldValue: true,
  });

  window.__getMutations__   = function () { return window.__mutationBuffer__.slice(); };
  window.__resetMutations__ = function () { window.__mutationBuffer__ = []; };
}

/**
 * Inject and activate the tracker in a live page via page.evaluate().
 * Call this after navigation — most reliable method, works with system Chrome.
 */
export async function installMutationTracker(page) {
  await page.evaluate(_trackerFn);
}

/** Pull the current mutation buffer from the live page */
export async function getMutations(page) {
  return page.evaluate(() => window.__getMutations__());
}

/** Clear the mutation buffer inside the live page */
export async function resetMutations(page) {
  return page.evaluate(() => window.__resetMutations__());
}
