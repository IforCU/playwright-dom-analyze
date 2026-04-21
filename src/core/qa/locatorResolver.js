/**
 * core/qa/locatorResolver.js
 *
 * Resolves a step's targetRef to a Playwright Locator.
 *
 * Resolution order (per contract):
 *  1. analysisRef lookup by nodeId in the loaded analysis element map
 *     → sorts node's locator array by LOCATOR_KIND_PRIORITY
 *     → returns first locator that resolves to ≥1 element on the page
 *  2. locatorFallback (single object or array) in declared order
 *  3. Returns { locator: null, resolutionResult: { method: 'failed', ... } }
 *
 * Locator kind priority (highest → lowest):
 *   testId > role > label > placeholder > text > css > xpath
 */

// Priority order: lower index = higher priority
const LOCATOR_KIND_PRIORITY = ['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'];

/**
 * Map analysis JSON locator strategy names to Playwright builder methods.
 */
const STRATEGY_TO_KIND = {
  testId:      'testId',
  role:        'role',
  label:       'label',
  placeholder: 'placeholder',
  text:        'text',
  css:         'css',
  xpath:       'xpath',
};

/**
 * Build a Playwright Locator from a kind + value pair.
 *
 * @param {import('playwright').Page} page
 * @param {string} kind
 * @param {string} value
 * @returns {import('playwright').Locator}
 */
export function buildLocator(page, kind, value) {
  switch (kind) {
    case 'testId':      return page.getByTestId(value);
    case 'role':        return page.getByRole(value);
    case 'label':       return page.getByLabel(value);
    case 'placeholder': return page.getByPlaceholder(value);
    case 'text':        return page.getByText(value, { exact: false });
    case 'css':         return page.locator(value);
    case 'xpath':       return page.locator(`xpath=${value}`);
    default:            return page.locator(value);
  }
}

/**
 * Attempt to use a locator and return count if successful.
 * Returns -1 on any error.
 *
 * @param {import('playwright').Locator} locator
 * @returns {Promise<number>}
 */
async function tryCount(locator) {
  try {
    return await locator.count();
  } catch {
    return -1;
  }
}

/**
 * Resolve a step's targetRef to a Playwright locator + resolution metadata.
 *
 * @param {import('playwright').Page} page
 * @param {object} step  – the step (or sub-object with targetRef / resolution)
 * @param {object|null} analysisElementMap  – map of nodeId → element from final-report.json
 * @returns {Promise<{ locator: import('playwright').Locator|null, resolutionResult: object }>}
 */
export async function resolveTarget(page, step, analysisElementMap) {
  // Support targetRef at step level or inside assertion (for expect steps)
  const targetRef = step.targetRef ?? step.assertion?.targetRef ?? null;
  if (!targetRef) {
    return { locator: null, resolutionResult: null };
  }

  const nodeId     = targetRef.nodeId ?? null;
  const resolution = step.resolution ?? {};
  const preferred  = resolution.preferred ?? 'analysisRef';
  const strict     = resolution.strict ?? false;

  // ── 1. analysisRef ────────────────────────────────────────────────────────
  if (preferred === 'analysisRef' && nodeId && analysisElementMap) {
    const node = analysisElementMap[nodeId];
    if (node && Array.isArray(node.locators) && node.locators.length > 0) {
      const sorted = [...node.locators].sort((a, b) => {
        const ai = LOCATOR_KIND_PRIORITY.indexOf(a.strategy);
        const bi = LOCATOR_KIND_PRIORITY.indexOf(b.strategy);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

      for (const loc of sorted) {
        const kind    = STRATEGY_TO_KIND[loc.strategy] ?? 'css';
        const locator = buildLocator(page, kind, loc.value);
        const count   = await tryCount(locator);
        if (count > 0) {
          return {
            locator,
            resolutionResult: {
              method:               'analysisRef',
              nodeId,
              locatorKind:          kind,
              locatorValue:         loc.value,
              wasFallbackUsed:      false,
              strictMatch:          strict,
              resolvedElementCount: count,
            },
          };
        }
      }
    }
  }

  // ── 2. locatorFallback ────────────────────────────────────────────────────
  const fallbacks = normalizeFallbacks(resolution.locatorFallback);
  for (const fb of fallbacks) {
    const kind    = STRATEGY_TO_KIND[fb.strategy] ?? 'css';
    const locator = buildLocator(page, kind, fb.value);
    const count   = await tryCount(locator);
    if (count > 0) {
      return {
        locator,
        resolutionResult: {
          method:               'locatorFallback',
          nodeId,
          locatorKind:          kind,
          locatorValue:         fb.value,
          wasFallbackUsed:      true,
          strictMatch:          false,
          resolvedElementCount: count,
        },
      };
    }
  }

  // ── 3. Failed ─────────────────────────────────────────────────────────────
  return {
    locator: null,
    resolutionResult: {
      method:               'failed',
      nodeId,
      locatorKind:          null,
      locatorValue:         null,
      wasFallbackUsed:      fallbacks.length > 0,
      strictMatch:          false,
      resolvedElementCount: 0,
    },
  };
}

/**
 * Normalize locatorFallback to always be an array.
 * @param {object|object[]|undefined} locatorFallback
 * @returns {object[]}
 */
function normalizeFallbacks(locatorFallback) {
  if (!locatorFallback) return [];
  if (Array.isArray(locatorFallback)) return locatorFallback;
  return [locatorFallback];
}

/**
 * Build the analysis element map (nodeId → element) from a loaded final-report JSON.
 * @param {object} finalReport
 * @returns {object}
 */
export function buildAnalysisElementMap(finalReport) {
  const map = {};
  if (!finalReport?.elements) return map;
  for (const el of finalReport.elements) {
    if (el.id) map[el.id] = el;
  }
  return map;
}
