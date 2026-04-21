/**
 * Builds a Playwright Locator from a strategy name + value pair.
 * For simple fallback locators that only have strategy + value.
 *
 * @param {import('playwright').Page} page
 * @param {string} strategy  – 'css' | 'text' | 'role' | 'label' | 'placeholder' | 'testId' | 'xpath'
 * @param {string} value
 * @returns {import('playwright').Locator}
 */
export function buildLocator(page, strategy, value) {
  switch (strategy) {
    case 'testId':      return page.getByTestId(value);
    case 'role':        return page.getByRole(value);
    case 'label':       return page.getByLabel(value);
    case 'placeholder': return page.getByPlaceholder(value);
    case 'text':        return page.getByText(value, { exact: false });
    case 'xpath':       return page.locator(`xpath=${value}`);
    case 'css':
    default:            return page.locator(value);
  }
}

/**
 * Builds a Playwright Locator from a full locator spec object.
 * Handles role locators from final-report.json that have { strategy, role, name } shape
 * instead of a plain { strategy, value } shape.
 *
 * @param {import('playwright').Page} page
 * @param {object} locSpec  – e.g. { strategy:'role', role:'button', name:'이전 프로모션' }
 *                              or  { strategy:'css',  value:'button.foo' }
 * @returns {import('playwright').Locator}
 */
export function buildLocatorFromSpec(page, locSpec) {
  const { strategy, value, role, name } = locSpec;
  switch (strategy) {
    case 'testId':      return page.getByTestId(value);
    case 'role': {
      const roleValue = role ?? value;
      if (!roleValue) return page.locator('[role]'); // fallback: won't match usefully
      return name
        ? page.getByRole(roleValue, { name })
        : page.getByRole(roleValue);
    }
    case 'label':       return page.getByLabel(value);
    case 'placeholder': return page.getByPlaceholder(value);
    case 'text':        return page.getByText(value, { exact: false });
    case 'xpath':       return page.locator(`xpath=${value}`);
    case 'css':
    default:            return page.locator(value);
  }
}

// Locators higher in this list are preferred when an analysisRef node has multiple.
export const STRATEGY_PRIORITY = ['testId', 'role', 'label', 'placeholder', 'text', 'css', 'xpath'];

/**
 * Count elements matched by a locator without throwing on zero results.
 *
 * @param {import('playwright').Locator} locator
 * @returns {Promise<number>}
 */
export async function safeCount(locator) {
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}
