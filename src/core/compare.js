/**
 * core/compare.js
 *
 * Compares two snapshots of DOM nodes (before vs after a trigger action)
 * to identify newly appeared elements and meaningful new bounding regions.
 *
 * Identity fingerprint strategy (two-tier):
 *
 *   Tier 1 — ID-based: when selectorHint starts with '#', the element is
 *     uniquely identified by its id.  Position is ignored so that layout
 *     reflows (the element moves but keeps its id) do not create false
 *     positives.  Size is still included so a genuinely replaced element
 *     (same id, different dimensions) is still detected.
 *
 *   Tier 2 — Position-based: for all other elements, uses tagName + bbox
 *     rounded to the nearest 2 px.  The 2-pixel tolerance absorbs sub-pixel
 *     rendering differences between the before- and after-snapshots without
 *     masking meaningful position changes.
 */

/**
 * @param {Array} beforeNodes - Node list extracted before the trigger
 * @param {Array} afterNodes  - Node list extracted after the trigger
 * @returns {{ newNodes: Array }}
 */
export function compareNodeSets(beforeNodes, afterNodes) {
  const beforeSet = new Set(beforeNodes.map(fingerprint));
  const newNodes  = afterNodes.filter((n) => !beforeSet.has(fingerprint(n)));
  return { newNodes };
}

/**
 * From new nodes, extract distinct rectangular regions large enough to be
 * meaningful UI blocks (e.g. popup panels, dropdowns, toasts).
 *
 * @param {Array} newNodes
 * @returns {Array<{x,y,width,height,nodeId,tagName,text}>}
 */
export function extractNewRegions(newNodes) {
  return newNodes
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

/** Stable identity string for a node based on position and tag */
function fingerprint(node) {
  // Tier 1 — ID-based identity.
  // An element identified by a unique id is the same element regardless of
  // where it moved on the page (layout reflows, pushed-down content, etc.).
  // We still embed rounded width+height so a genuinely replaced element with
  // the same id but different dimensions is not silently discarded.
  if (node.selectorHint && node.selectorHint.startsWith('#')) {
    const { width, height } = node.bbox;
    return `id:${node.selectorHint}|${Math.round(width / 2) * 2}|${Math.round(height / 2) * 2}`;
  }

  // Tier 2 — Position-based identity.
  // Round all coordinates to the nearest 2 px to absorb sub-pixel rendering
  // differences (anti-aliasing, fractional DPR) without masking real changes.
  const { x, y, width, height } = node.bbox;
  return `${node.tagName}|${Math.round(x / 2) * 2}|${Math.round(y / 2) * 2}|${Math.round(width / 2) * 2}|${Math.round(height / 2) * 2}`;
}
