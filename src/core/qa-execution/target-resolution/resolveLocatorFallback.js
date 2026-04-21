import { buildLocator, safeCount } from './locatorBuilders.js';

/**
 * Try each locator in the fallback list in declaration order.
 * Returns the first one that resolves to at least one element.
 *
 * @param {import('playwright').Page} page
 * @param {object|object[]} locatorFallback  – from step.resolution.locatorFallback
 * @param {string|null} nodeId               – for result metadata
 * @returns {Promise<{ locator, resolutionResult } | null>}
 */
export async function resolveLocatorFallback(page, locatorFallback, nodeId = null) {
  const candidates = Array.isArray(locatorFallback) ? locatorFallback : [locatorFallback];

  for (const fb of candidates) {
    if (!fb?.strategy || !fb?.value) continue;
    const locator = buildLocator(page, fb.strategy, fb.value);
    const count   = await safeCount(locator);
    if (count > 0) {
      return {
        locator,
        resolutionResult: {
          method:               'locatorFallback',
          nodeId,
          locatorKind:          fb.strategy,
          locatorValue:         fb.value,
          wasFallbackUsed:      true,
          resolvedElementCount: count,
        },
      };
    }
  }

  return null;
}
