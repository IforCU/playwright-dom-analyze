/**
 * core/compare.js
 *
 * Compares two snapshots of DOM nodes (before vs after a trigger action)
 * to identify newly appeared elements and meaningful new bounding regions.
 *
 * Identity fingerprint: tagName + viewport position + dimensions.
 * Elements that share the same tag and bounding box across snapshots are
 * considered the same element.
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
  const { x, y, width, height } = node.bbox;
  return `${node.tagName}|${x}|${y}|${width}|${height}`;
}
