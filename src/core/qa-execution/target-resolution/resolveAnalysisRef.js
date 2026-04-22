import { buildLocatorFromSpec, safeCount, STRATEGY_PRIORITY } from './locatorBuilders.js';
import { resolveBboxCoordinate } from './resolveBboxCoordinate.js';

/**
 * Attempt to resolve a targetRef against the loaded analysis element map.
 *
 * Resolution strategy:
 *   1. Sort locators by STRATEGY_PRIORITY.
 *   2. Collect all locators with count > 0.
 *   3. Prefer exact matches (count === 1). If no exact match exists, use the
 *      first locator with count > 1 as a last resort before bbox fallback.
 *      This prevents ambiguous text locators (e.g. "검색" count=7) from
 *      being used when a more specific CSS locator would match uniquely.
 *
 * @param {import('playwright').Page} page
 * @param {string} nodeId
 * @param {object} analysisElementMap  – built by buildAnalysisElementMap()
 * @returns {Promise<{ locator, resolutionResult } | null>}
 *   Returns null if the node is not found in the map or no locator resolves.
 */
export async function resolveAnalysisRef(page, nodeId, analysisElementMap) {
  const node = analysisElementMap?.[nodeId];
  if (!node || !Array.isArray(node.locators) || node.locators.length === 0) return null;

  const sorted = [...node.locators].sort((a, b) => {
    const ai = STRATEGY_PRIORITY.indexOf(a.strategy);
    const bi = STRATEGY_PRIORITY.indexOf(b.strategy);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  let firstMultiMatch = null; // fallback: first locator with count > 1

  for (const loc of sorted) {
    const locator = buildLocatorFromSpec(page, loc);
    const count   = await safeCount(locator);

    if (count === 1) {
      // Exact unique match — preferred
      return {
        locator,
        resolutionResult: {
          method:               'analysisRef',
          nodeId,
          locatorKind:          loc.strategy,
          locatorValue:         loc.value ?? loc.name,
          wasFallbackUsed:      false,
          resolvedElementCount: count,
        },
      };
    }

    if (count > 1 && !firstMultiMatch) {
      firstMultiMatch = { locator, loc, count };
    }
  }

  // No unique match found — try bbox coordinate resolution first (more precise)
  if (node.bbox) {
    const hit = await resolveBboxCoordinate(page, nodeId, node.bbox);
    if (hit) return hit;
  }

  // Last resort: use the first multi-match locator
  if (firstMultiMatch) {
    const { locator, loc, count } = firstMultiMatch;
    return {
      locator: locator.first(),
      resolutionResult: {
        method:               'analysisRef',
        nodeId,
        locatorKind:          loc.strategy,
        locatorValue:         loc.value ?? loc.name,
        wasFallbackUsed:      false,
        resolvedElementCount: count,
      },
    };
  }

  return null;
}

/**
 * Build a flat map of nodeId → element from a final-report JSON.
 *
 * @param {object} finalReport
 * @returns {object}
 */
export function buildAnalysisElementMap(finalReport) {
  const map = {};
  for (const el of (finalReport?.elements ?? [])) {
    if (el.id) map[el.id] = el;
  }
  return map;
}
