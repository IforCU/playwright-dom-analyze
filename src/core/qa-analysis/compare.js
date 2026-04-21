/**
 * core/compare.js
 *
 * Before/after DOM comparison for trigger-result delta analysis.
 *
 * Two main exports:
 *
 *   computeTriggerDelta(beforeNodes, afterNodes, mutations)
 *       Rich delta: categorises each after-node as new, newlyVisible, changed,
 *       or unchanged.  Only new+newlyVisible+changed are included in
 *       deltaLabelNodes, which is the annotation input for trigger screenshots.
 *       This prevents baseline elements displaced by layout reflow (e.g. page
 *       content pushed down when a modal opens) from appearing as false-positive
 *       "new" nodes and polluting the trigger annotation.
 *
 *   compareNodeSets(beforeNodes, afterNodes)
 *       Legacy wrapper — returns { newNodes: deltaLabelNodes } for backward
 *       compatibility with callers that only use the new-node list.
 *
 *   extractNewRegions(nodes)
 *       Derive distinct rectangular regions from a node list.
 *
 * Multi-tier matching strategy (applied in priority order):
 *
 *   Tier 1 — DOM id:
 *     Elements with a DOM id (node.id set, or selectorHint starts with '#')
 *     are matched by id regardless of position.  A layout reflow that pushes
 *     an id-bearing element to a new Y coordinate does NOT create a false
 *     positive — the element is identified as unchanged (or changed, if its
 *     text/state changed).
 *
 *   Tier 2 — Unique CSS selector:
 *     Non-id selectorHint that contains '.' (class-based selector).  Only
 *     used for matching when the selector is unique in the before-set (no two
 *     before-nodes share the same selectorHint).  Non-unique selectors fall
 *     through to lower tiers.
 *
 *   Tier 3 — Unique text + tag:
 *     Same tagName + same visible text (≥ 5 chars), matched only when unique
 *     in the before-set.  Catches stable text labels that moved on the page.
 *
 *   Tier 4 — Position fingerprint:
 *     tagName + bbox rounded to 2 px.  Classic fallback.
 *
 * Meaningful change detection (for matched pairs):
 *   - text content changed significantly
 *   - class list gained/lost a state-indicating keyword
 *   - the element's DOM id appears in mutation records for state attributes
 */

// ── State keywords used for change detection ─────────────────────────────────
const STATE_CLASS_RE = /\b(open|active|selected|expanded|visible|show|checked|pressed|current|is-open|is-active|is-visible|is-expanded|is-selected|menu-open|tab-active|panel-visible)\b/i;
const HIDE_CLASS_RE  = /\b(hide|hidden|d-none|is-hidden|ng-hide|collapse|collapsed)\b/i;
const STATE_ATTRS    = new Set([
  'aria-expanded', 'aria-selected', 'aria-checked', 'aria-pressed',
  'aria-hidden', 'aria-current', 'class', 'open',
  'data-state', 'data-open', 'data-active',
]);

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Compute a structured delta between before and after DOM snapshots.
 *
 * @param {Array}  beforeNodes - visible nodes extracted before the trigger
 * @param {Array}  afterNodes  - visible nodes extracted after the trigger
 * @param {Array}  [mutations] - MutationObserver records (optional but improves accuracy)
 * @returns {{
 *   newNodes:            Array,   // truly new elements (no before-match at any tier)
 *   newlyVisibleNodes:   Array,   // previously hidden, now visible (mutation-confirmed)
 *   changedNodes:        Array,   // matched before→after with meaningful state change
 *   unchangedNodes:      Array,   // matched before→after with no meaningful change
 *   deltaLabelNodes:     Array,   // newNodes + newlyVisibleNodes + changedNodes
 *   unchangedNodesCount: number,
 * }}
 */
export function computeTriggerDelta(beforeNodes, afterNodes, mutations = []) {
  // ── Build multi-tier before-lookups ──────────────────────────────────────
  const beforeByFp       = new Map(); // positionFingerprint → node
  const beforeById       = new Map(); // '#id'       → node
  const beforeBySelector = new Map(); // 'tag.cls'   → node | null  (null = non-unique)
  const beforeByText     = new Map(); // 'tag|text'  → node | null  (null = non-unique)

  for (const n of beforeNodes) {
    // Tier 4: position fingerprint (used as fallback)
    const fp = _fingerprint(n);
    if (!beforeByFp.has(fp)) beforeByFp.set(fp, n);

    // Tier 1: DOM id (both node.id and selectorHint starting with '#')
    const idHint = _idHint(n);
    if (idHint && !beforeById.has(idHint)) beforeById.set(idHint, n);

    // Tier 2: class selector — mark non-unique with null sentinel
    if (n.selectorHint && n.selectorHint.includes('.') && !n.selectorHint.startsWith('#')) {
      beforeBySelector.set(
        n.selectorHint,
        beforeBySelector.has(n.selectorHint) ? null : n,
      );
    }

    // Tier 3: text + tag — mark non-unique with null sentinel
    if (n.text && n.text.length >= 5) {
      const key = `${n.tagName}|${n.text.slice(0, 60).trim()}`;
      beforeByText.set(key, beforeByText.has(key) ? null : n);
    }
  }

  // ── Build mutation-derived helper sets ───────────────────────────────────
  // IDs of elements whose state attributes changed → flag as changedNode when matched
  const mutatedDomIds  = _buildMutatedIdSet(mutations);
  // IDs of elements that became visible according to mutations → newlyVisibleNode
  const revealedDomIds = _buildRevealedIdSet(mutations);

  // ── Classify each after-node ─────────────────────────────────────────────
  const provisionalNew  = []; // no before-match; will be reclassified below
  const changedNodes    = [];
  const unchangedNodes  = [];

  for (const afterNode of afterNodes) {
    const matchedBefore = _findBeforeMatch(
      afterNode, beforeByFp, beforeById, beforeBySelector, beforeByText,
    );

    if (!matchedBefore) {
      provisionalNew.push(afterNode);
    } else if (_hasMeaningfulChange(matchedBefore, afterNode, mutatedDomIds)) {
      changedNodes.push(afterNode);
    } else {
      unchangedNodes.push(afterNode);
    }
  }

  // ── Reclassify provisional new nodes → newlyVisible vs truly new ─────────
  // A provisional-new node whose DOM id appears in revealedDomIds was present
  // in the DOM before the trigger but hidden; it became visible due to the
  // trigger action.  This is distinct from a truly injected new element.
  const newNodes          = [];
  const newlyVisibleNodes = [];

  for (const n of provisionalNew) {
    const domId = n.id || (n.selectorHint?.startsWith('#') ? n.selectorHint.slice(1) : null);
    if (domId && revealedDomIds.has(domId)) {
      newlyVisibleNodes.push(n);
    } else {
      newNodes.push(n);
    }
  }

  const deltaLabelNodes = [...newNodes, ...newlyVisibleNodes, ...changedNodes];

  return {
    newNodes,
    newlyVisibleNodes,
    changedNodes,
    unchangedNodes,
    deltaLabelNodes,
    unchangedNodesCount: unchangedNodes.length,
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Find the best matching before-node for an after-node using the four-tier
 * strategy.  Returns null when no tier matches.
 */
function _findBeforeMatch(afterNode, byFp, byId, bySelector, byText) {
  // Tier 1: DOM id
  const idHint = _idHint(afterNode);
  if (idHint) {
    const m = byId.get(idHint);
    if (m) return m;
    // id is present in after but not in before → genuinely new element; fall through
  }

  // Tier 2: unique class selector
  if (afterNode.selectorHint?.includes('.') && !afterNode.selectorHint.startsWith('#')) {
    const m = bySelector.get(afterNode.selectorHint);
    if (m !== undefined && m !== null) return m; // m===null means non-unique → skip tier
  }

  // Tier 3: unique text + tag
  if (afterNode.text?.length >= 5) {
    const key = `${afterNode.tagName}|${afterNode.text.slice(0, 60).trim()}`;
    const m = byText.get(key);
    if (m !== undefined && m !== null) return m;
  }

  // Tier 4: position fingerprint (fallback)
  return byFp.get(_fingerprint(afterNode)) ?? null;
}

/**
 * Return true when a matched (before→after) pair shows a meaningful state change
 * that warrants labeling in the trigger-result annotation.
 */
function _hasMeaningfulChange(before, after, mutatedDomIds) {
  // 1. Text changed significantly (more than trivial whitespace)
  const bt = (before.text || '').trim();
  const at = (after.text  || '').trim();
  if (bt !== at) {
    if (Math.abs(bt.length - at.length) > 5 || bt.slice(0, 20) !== at.slice(0, 20)) {
      return true;
    }
  }

  // 2. Class list changed: a state-indicator or hide keyword was toggled
  const bcls = Array.isArray(before.classList) ? before.classList.join(' ') : (before.selectorHint ?? '');
  const acls = Array.isArray(after.classList)  ? after.classList.join(' ')  : (after.selectorHint  ?? '');
  if (bcls !== acls) {
    if (STATE_CLASS_RE.test(bcls) !== STATE_CLASS_RE.test(acls)) return true;
    if (HIDE_CLASS_RE.test(bcls)  !== HIDE_CLASS_RE.test(acls))  return true;
  }

  // 3. Element's DOM id appears in mutation records for state-change attributes
  const domId = before.id || (before.selectorHint?.startsWith('#') ? before.selectorHint.slice(1) : null);
  if (domId && mutatedDomIds.has(domId)) return true;

  return false;
}

/**
 * Collect DOM ids targeted by attribute mutations that indicate state changes.
 * These ids are checked during matched-pair comparison to flag changedNodes.
 */
function _buildMutatedIdSet(mutations) {
  const ids = new Set();
  for (const m of mutations) {
    if (m.type === 'attributes' && m.targetId && STATE_ATTRS.has(m.attributeName)) {
      ids.add(m.targetId);
    }
  }
  return ids;
}

/**
 * Collect DOM ids of elements that became visible according to mutation records.
 * An element is "revealed" when a visibility-controlling attribute was changed
 * from a hide value (e.g. aria-hidden="true" → removed, or display:none removed).
 */
function _buildRevealedIdSet(mutations) {
  const ids = new Set();
  for (const m of mutations) {
    if (m.type !== 'attributes' || !m.targetId) continue;
    const attr = m.attributeName;
    const old  = m.oldValue ?? '';

    if (attr === 'aria-hidden' && old === 'true') { ids.add(m.targetId); continue; }
    if (attr === 'hidden') { ids.add(m.targetId); continue; }
    if (attr === 'style'  && /display\s*:\s*none|visibility\s*:\s*hidden/.test(old)) {
      ids.add(m.targetId); continue;
    }
    if (attr === 'class' && HIDE_CLASS_RE.test(old)) { ids.add(m.targetId); continue; }
  }
  return ids;
}

/** Derive the '#id' hint string from a node, or null. */
function _idHint(node) {
  if (node.id) return `#${node.id}`;
  if (node.selectorHint?.startsWith('#')) return node.selectorHint;
  return null;
}

/** Tier-4 position fingerprint — same logic as original fingerprint(). */
function _fingerprint(node) {
  // Still prefer id-based fingerprint for Tier 1 nodes as a quick-lookup key,
  // but this function is only called as a Tier-4 fallback; for id-nodes Tier 1
  // has already matched or determined the element is new.
  const { x, y, width, height } = node.bbox;
  return `${node.tagName}|${Math.round(x / 2) * 2}|${Math.round(y / 2) * 2}|${Math.round(width / 2) * 2}|${Math.round(height / 2) * 2}`;
}

// ── Legacy API (backward compatibility) ──────────────────────────────────────

/**
 * Legacy comparison: returns { newNodes } = all delta-label nodes.
 * deltaLabelNodes replaces the old simple "not in before-set" result, giving
 * callers that only inspect newNodes the improved delta at no API change cost.
 *
 * @param {Array} beforeNodes
 * @param {Array} afterNodes
 * @returns {{ newNodes: Array }}
 */
export function compareNodeSets(beforeNodes, afterNodes) {
  const { deltaLabelNodes } = computeTriggerDelta(beforeNodes, afterNodes, []);
  return { newNodes: deltaLabelNodes };
}

/**
 * From a node list, extract distinct rectangular regions large enough to be
 * meaningful UI blocks (e.g. popup panels, dropdowns, toasts).
 *
 * @param {Array} nodes
 * @returns {Array<{x,y,width,height,nodeId,tagName,text}>}
 */
export function extractNewRegions(nodes) {
  return nodes
    .filter((n) => n.bbox.width >= 10 && n.bbox.height >= 10)
    .slice(0, 20)
    .map((n) => ({
      x:       n.bbox.x,
      y:       n.bbox.y,
      width:   n.bbox.width,
      height:  n.bbox.height,
      nodeId:  n.nodeId,
      tagName: n.tagName,
      text:    n.text,
    }));
}
