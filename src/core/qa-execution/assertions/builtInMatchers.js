import { resolveTarget } from '../target-resolution/resolveTarget.js';
import { ERROR_CODES }   from '../errors/errorCodes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok   = (data = {}) => ({ passed: true,  ...data });
const fail = (code, msg, data = {}) => ({ passed: false, errorCode: code, error: msg, ...data });

// ── Built-in matcher implementations ─────────────────────────────────────────

/**
 * Each matcher receives:
 *   (page, locator, assertion, runtimeState, elementMap, timeout)
 * and returns:
 *   { passed, errorCode?, error?, actual?, expected? }
 */
const MATCHERS = {

  // ── Page-scope matchers ───────────────────────────────────────────────────

  async toHaveURL(page, _locator, assertion, _state, _map, timeout) {
    const { value } = assertion;
    if (page.url().includes(value)) return ok({ actual: page.url(), expected: value });
    try {
      await page.waitForURL(url => url.href.includes(value), { timeout });
      return ok({ actual: page.url(), expected: value });
    } catch {
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected URL to contain "${value}" but got "${page.url()}"`,
        { actual: page.url(), expected: value });
    }
  },

  async toContainURL(page, locator, assertion, state, map, timeout) {
    // Alias — same implementation as toHaveURL
    return MATCHERS.toHaveURL(page, locator, assertion, state, map, timeout);
  },

  async toHaveScrollYLessThanOrEqual(page, _l, assertion) {
    const { value } = assertion;
    const scrollY = await page.evaluate(() => window.scrollY).catch(() => null);
    if (scrollY === null) return fail(ERROR_CODES.ASSERTION_FAILED, 'Could not read window.scrollY');
    if (scrollY <= value)  return ok({ actual: scrollY, expected: `<= ${value}` });
    return fail(ERROR_CODES.ASSERTION_FAILED,
      `Expected scrollY <= ${value} but got ${scrollY}`, { actual: scrollY, expected: value });
  },

  async toSatisfyAny(page, _l, assertion) {
    const conditions = Array.isArray(assertion.value) ? assertion.value : [];
    for (const cond of conditions) {
      if (cond.type === 'urlContains' && page.url().includes(cond.value))
        return ok({ satisfiedCondition: cond });
      if (cond.type === 'textVisible') {
        const visible = await page.getByText(cond.value, { exact: false }).isVisible().catch(() => false);
        if (visible) return ok({ satisfiedCondition: cond });
      }
    }
    return fail(ERROR_CODES.ASSERTION_FAILED,
      `None of the ${conditions.length} condition(s) satisfied`, { conditions });
  },

  // ── Element-scope matchers ────────────────────────────────────────────────

  async toBeVisible(_p, locator, _a, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toBeVisible');
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return ok({});
    } catch {
      return fail(ERROR_CODES.ASSERTION_FAILED, 'Element is not visible');
    }
  },

  async toBeHidden(_p, locator, _a, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toBeHidden');
    try {
      await locator.waitFor({ state: 'hidden', timeout });
      return ok({});
    } catch {
      return fail(ERROR_CODES.ASSERTION_FAILED, 'Element is not hidden');
    }
  },

  async toHaveText(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveText');
    const { value } = assertion;
    try {
      const actual = ((await locator.textContent({ timeout })) ?? '').trim();
      if (actual === value) return ok({ actual, expected: value });
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected text "${value}" but got "${actual}"`, { actual, expected: value });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toContainText(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toContainText');
    const { value } = assertion;
    try {
      const actual = ((await locator.textContent({ timeout })) ?? '').trim();
      if (actual.includes(value)) return ok({ actual, expected: value });
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected text to contain "${value}" but got "${actual}"`, { actual, expected: value });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toHaveValue(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveValue');
    const { value } = assertion;
    try {
      const actual = await locator.inputValue({ timeout });
      if (actual === value) return ok({ actual, expected: value });
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected input value "${value}" but got "${actual}"`, { actual, expected: value });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toHaveAttribute(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveAttribute');
    const { attribute, value } = assertion;
    if (!attribute) return fail(ERROR_CODES.ASSERTION_FAILED, 'toHaveAttribute requires "attribute" field');
    try {
      const actual = await locator.getAttribute(attribute, { timeout });
      if (actual === value) return ok({ actual, expected: value, attribute });
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected attribute "${attribute}" to be "${value}" but got "${actual}"`,
        { actual, expected: value, attribute });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toHaveCountGreaterThan(_p, locator, assertion) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveCountGreaterThan');
    const { value } = assertion;
    const count = await locator.count().catch(() => 0);
    if (count > value) return ok({ actual: count, expected: `> ${value}` });
    return fail(ERROR_CODES.ASSERTION_FAILED,
      `Expected count > ${value} but got ${count}`, { actual: count, expected: value });
  },

  async toChangeFromStored(_p, locator, assertion, state, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toChangeFromStored');
    const { storedKey } = assertion;
    if (!storedKey) return fail(ERROR_CODES.ASSERTION_FAILED, 'toChangeFromStored requires "storedKey"');
    const stored = state.getCaptured(storedKey);
    if (stored === undefined)
      return fail(ERROR_CODES.ASSERTION_FAILED, `No captured value found for key "${storedKey}"`);
    try {
      const current = ((await locator.textContent({ timeout })) ?? '').trim();
      if (current !== String(stored)) return ok({ actual: current, stored });
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Element still shows stored value "${stored}"`, { actual: current, stored });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async textOrAriaStateChanged(_p, locator, assertion, state, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for textOrAriaStateChanged');

    const nodeId    = assertion.targetRef?.nodeId ?? null;
    const storedKey = assertion.storedKey ?? null;
    const before    = storedKey
      ? state.getCaptured(storedKey)
      : (nodeId ? state.getRuntime(`_autoCapture_${nodeId}`) : undefined);

    if (before == null)
      return fail(ERROR_CODES.ASSERTION_FAILED,
        'textOrAriaStateChanged: no before-state found. A prior click or capture step is required.');

    try {
      const current    = await captureAriaAndText(locator, timeout);
      const beforeStr  = typeof before === 'string' ? before : JSON.stringify(before);
      const currentStr = JSON.stringify(current);
      if (currentStr !== beforeStr) return ok({ before, current });
      return fail(ERROR_CODES.ASSERTION_FAILED,
        'Expected element text or aria state to have changed', { before, current });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },
};

// ── Auto-capture helper (called by click step before action) ─────────────────

export async function captureAriaAndText(locator, timeout = 5000) {
  const [text, aria] = await Promise.all([
    locator.textContent({ timeout }).then(t => (t ?? '').trim()).catch(() => ''),
    locator.evaluate(el => ({
      pressed:  el.getAttribute('aria-pressed'),
      expanded: el.getAttribute('aria-expanded'),
      selected: el.getAttribute('aria-selected'),
      label:    el.getAttribute('aria-label'),
      checked:  el.getAttribute('aria-checked'),
    })).catch(() => ({})),
  ]);
  return { text, aria };
}

export async function autoCapturePre(locator, nodeId, runtimeState, timeout = 5000) {
  if (!locator || !nodeId) return;
  try {
    const snapshot = await captureAriaAndText(locator, timeout);
    runtimeState.setRuntime(`_autoCapture_${nodeId}`, snapshot);
  } catch { /* non-fatal — missing snapshot degrades textOrAriaStateChanged gracefully */ }
}

// ── Public dispatch ───────────────────────────────────────────────────────────

/**
 * Execute a single assertion from an `expect` step.
 *
 * @param {import('playwright').Page} page
 * @param {object} assertion
 * @param {import('../runtime/runtimeState.js').RuntimeState} runtimeState
 * @param {object|null} elementMap
 * @param {number} defaultTimeoutMs
 * @returns {Promise<{ passed, errorCode?, error?, actual?, expected? }>}
 */
export async function runAssertion(page, assertion, runtimeState, elementMap, defaultTimeoutMs) {
  const { matcher } = assertion;
  const timeout = assertion.timeoutMs ?? defaultTimeoutMs ?? 5000;

  const impl = MATCHERS[matcher];
  if (!impl) {
    return fail(ERROR_CODES.UNSUPPORTED_MATCHER, `Matcher "${matcher}" is not registered`);
  }

  // Resolve element locator for element-scoped matchers
  let locator = null;
  if (assertion.targetRef) {
    const { resolveTarget } = await import('../target-resolution/resolveTarget.js');
    const result = await resolveTarget(page, { targetRef: assertion.targetRef, resolution: assertion.resolution }, elementMap);
    locator = result.locator;
    if (!locator) {
      return fail(ERROR_CODES.TARGET_NOT_FOUND,
        `Could not resolve element for matcher "${matcher}"`,
        { resolutionResult: result.resolutionResult });
    }
  }

  return impl(page, locator, assertion, runtimeState, elementMap, timeout);
}
