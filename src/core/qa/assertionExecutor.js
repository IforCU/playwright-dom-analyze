/**
 * core/qa/assertionExecutor.js
 *
 * Dispatches `expect` step assertions to registered matchers.
 *
 * Matchers are defined in config/qa-matcher-registry.json.
 * This file implements the runtime behavior of each registered matcher.
 *
 * Error classification codes returned on failure:
 *   assertion_failed     – the condition evaluated and did not match
 *   target_not_found     – could not resolve element locator
 *   timeout              – timed out waiting for condition
 *   unsupported_matcher  – matcher name not in registry
 */

import { resolveTarget } from './locatorResolver.js';

// ── Matcher implementations ───────────────────────────────────────────────────

const MATCHERS = {

  // ── Page scope ─────────────────────────────────────────────────────────────

  async toHaveURL(page, _locator, assertion, _context, timeout) {
    const { value } = assertion;
    const current = page.url();
    if (current.includes(value)) {
      return ok({ actual: current, expected: value });
    }
    try {
      await page.waitForURL(url => url.href.includes(value), { timeout });
      return ok({ actual: page.url(), expected: value });
    } catch {
      return fail('assertion_failed',
        `Expected page URL to contain "${value}" but got "${page.url()}"`,
        { actual: page.url(), expected: value });
    }
  },

  async toContainURL(page, _locator, assertion, _context, timeout) {
    // Alias for toHaveURL
    return MATCHERS.toHaveURL(page, _locator, assertion, _context, timeout);
  },

  async toHaveScrollYLessThanOrEqual(page, _locator, assertion, _context, _timeout) {
    const { value } = assertion;
    const scrollY = await page.evaluate(() => window.scrollY).catch(() => null);
    if (scrollY === null) {
      return fail('assertion_failed', 'Could not read window.scrollY', {});
    }
    if (scrollY <= value) {
      return ok({ actual: scrollY, expected: `<= ${value}` });
    }
    return fail('assertion_failed',
      `Expected scrollY <= ${value} but got ${scrollY}`,
      { actual: scrollY, expected: value });
  },

  async toSatisfyAny(page, _locator, assertion, _context, _timeout) {
    const conditions = Array.isArray(assertion.value) ? assertion.value : [];
    for (const cond of conditions) {
      if (cond.type === 'urlContains') {
        if (page.url().includes(cond.value)) {
          return ok({ satisfiedCondition: cond });
        }
      } else if (cond.type === 'textVisible') {
        try {
          const loc = page.getByText(cond.value, { exact: false });
          const visible = await loc.isVisible();
          if (visible) return ok({ satisfiedCondition: cond });
        } catch { /* continue */ }
      }
    }
    return fail('assertion_failed',
      `None of the ${conditions.length} condition(s) were satisfied`,
      { conditions });
  },

  // ── Element scope ──────────────────────────────────────────────────────────

  async toBeVisible(_page, locator, _assertion, _context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toBeVisible', {});
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return ok({});
    } catch {
      return fail('assertion_failed', 'Element is not visible', {});
    }
  },

  async toBeHidden(_page, locator, _assertion, _context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toBeHidden', {});
    try {
      await locator.waitFor({ state: 'hidden', timeout });
      return ok({});
    } catch {
      return fail('assertion_failed', 'Element is not hidden', {});
    }
  },

  async toHaveText(_page, locator, assertion, _context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toHaveText', {});
    const { value, exact = false } = assertion;
    try {
      const text = (await locator.textContent({ timeout })) ?? '';
      const actual = text.trim();
      const matched = exact ? actual === value : actual === value;
      if (matched) return ok({ actual, expected: value });
      return fail('assertion_failed',
        `Expected element text to equal "${value}" but got "${actual}"`,
        { actual, expected: value });
    } catch (e) {
      return fail('timeout', e.message, {});
    }
  },

  async toContainText(_page, locator, assertion, _context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toContainText', {});
    const { value } = assertion;
    try {
      const text = (await locator.textContent({ timeout })) ?? '';
      const actual = text.trim();
      if (actual.includes(value)) return ok({ actual, expected: value });
      return fail('assertion_failed',
        `Expected element text to contain "${value}" but got "${actual}"`,
        { actual, expected: value });
    } catch (e) {
      return fail('timeout', e.message, {});
    }
  },

  async toHaveValue(_page, locator, assertion, _context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toHaveValue', {});
    const { value } = assertion;
    try {
      const actual = await locator.inputValue({ timeout });
      if (actual === value) return ok({ actual, expected: value });
      return fail('assertion_failed',
        `Expected element value to equal "${value}" but got "${actual}"`,
        { actual, expected: value });
    } catch (e) {
      return fail('timeout', e.message, {});
    }
  },

  async toHaveAttribute(_page, locator, assertion, _context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toHaveAttribute', {});
    const { attribute, value } = assertion;
    if (!attribute) {
      return fail('assertion_failed', 'toHaveAttribute requires "attribute" field in assertion', {});
    }
    try {
      const actual = await locator.getAttribute(attribute, { timeout });
      if (actual === value) return ok({ actual, expected: value, attribute });
      return fail('assertion_failed',
        `Expected attribute "${attribute}" to equal "${value}" but got "${actual}"`,
        { actual, expected: value, attribute });
    } catch (e) {
      return fail('timeout', e.message, {});
    }
  },

  async toHaveCountGreaterThan(_page, locator, assertion, _context, _timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toHaveCountGreaterThan', {});
    const { value } = assertion;
    try {
      const count = await locator.count();
      if (count > value) return ok({ actual: count, expected: `> ${value}` });
      return fail('assertion_failed',
        `Expected element count > ${value} but got ${count}`,
        { actual: count, expected: value });
    } catch (e) {
      return fail('assertion_failed', e.message, {});
    }
  },

  async toChangeFromStored(_page, locator, assertion, context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for toChangeFromStored', {});
    const { storedKey } = assertion;
    if (!storedKey) {
      return fail('assertion_failed', 'toChangeFromStored requires "storedKey" in assertion', {});
    }
    const stored = context.getCaptured(storedKey);
    if (stored === undefined) {
      return fail('assertion_failed',
        `No captured value found for storedKey "${storedKey}"`, {});
    }
    try {
      const current = ((await locator.textContent({ timeout })) ?? '').trim();
      if (current !== String(stored)) {
        return ok({ actual: current, stored });
      }
      return fail('assertion_failed',
        `Expected element to have changed from stored value "${stored}" but it still shows "${current}"`,
        { actual: current, stored });
    } catch (e) {
      return fail('timeout', e.message, {});
    }
  },

  async textOrAriaStateChanged(_page, locator, assertion, context, timeout) {
    if (!locator) return fail('target_not_found', 'Could not resolve element for textOrAriaStateChanged', {});

    // Determine the nodeId to look up the auto-captured pre-action state
    const nodeId = assertion.targetRef?.nodeId ?? null;
    const storedKey = assertion.storedKey ?? null;

    let before;
    if (storedKey) {
      before = context.getCaptured(storedKey);
    } else if (nodeId) {
      before = context.getRuntime(`_autoCapture_${nodeId}`);
    }

    if (before === undefined || before === null) {
      return fail('assertion_failed',
        'textOrAriaStateChanged: no before-state found. Ensure a capture step or a click on the same node precedes this assertion.',
        {});
    }

    try {
      const current = await _captureAriaAndText(locator, timeout);
      const currentStr = JSON.stringify(current);
      const beforeStr  = typeof before === 'string' ? before : JSON.stringify(before);
      if (currentStr !== beforeStr) {
        return ok({ before, current });
      }
      return fail('assertion_failed',
        'Expected element text or aria state to have changed after the action',
        { before, current });
    } catch (e) {
      return fail('timeout', e.message, {});
    }
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a single assertion from an `expect` step.
 *
 * @param {import('playwright').Page}   page
 * @param {object}                      assertion       – step.assertion
 * @param {import('./runtimeContext.js').RuntimeContext} context
 * @param {object|null}                 analysisElementMap
 * @param {number}                      defaultTimeoutMs
 * @returns {Promise<{ passed: boolean, actual?, expected?, error?, errorCode? }>}
 */
export async function executeAssertion(page, assertion, context, analysisElementMap, defaultTimeoutMs) {
  const { matcher } = assertion;
  const timeout = assertion.timeoutMs ?? defaultTimeoutMs ?? 5000;

  if (!MATCHERS[matcher]) {
    return fail('unsupported_matcher',
      `Matcher "${matcher}" is not registered in the executor.`, {});
  }

  // Resolve element locator if this is an element-scoped assertion
  let locator = null;
  let resolutionResult = null;

  const targetRef = assertion.targetRef ?? null;
  if (targetRef) {
    const resolved = await resolveTarget(
      page,
      { targetRef, resolution: assertion.resolution },
      analysisElementMap,
    );
    locator = resolved.locator;
    resolutionResult = resolved.resolutionResult;

    if (!locator) {
      return {
        passed: false,
        errorCode: 'target_not_found',
        error: `Could not resolve element for nodeId "${targetRef.nodeId}" in assertion "${matcher}"`,
        resolutionResult,
      };
    }
  }

  const result = await MATCHERS[matcher](page, locator, assertion, context, timeout);
  return { ...result, resolutionResult };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ok(data) {
  return { passed: true, ...data };
}

function fail(errorCode, error, data) {
  return { passed: false, errorCode, error, ...data };
}

/**
 * Capture a snapshot of an element's text and aria attributes.
 * Used for textOrAriaStateChanged pre-action auto-capture.
 *
 * @param {import('playwright').Locator} locator
 * @param {number} timeout
 * @returns {Promise<object>}
 */
export async function _captureAriaAndText(locator, timeout = 5000) {
  const text = ((await locator.textContent({ timeout }).catch(() => '')) ?? '').trim();
  const aria = await locator.evaluate(el => ({
    pressed:  el.getAttribute('aria-pressed'),
    expanded: el.getAttribute('aria-expanded'),
    selected: el.getAttribute('aria-selected'),
    label:    el.getAttribute('aria-label'),
    checked:  el.getAttribute('aria-checked'),
  })).catch(() => ({}));
  return { text, aria };
}

/**
 * Capture an aria+text snapshot and store it in the runtime context under
 * `_autoCapture_{nodeId}`. Called by the step executor before a click action.
 *
 * @param {import('playwright').Locator} locator
 * @param {string}  nodeId
 * @param {import('./runtimeContext.js').RuntimeContext} context
 */
export async function autoCapturePreClickState(locator, nodeId, context) {
  if (!locator || !nodeId) return;
  try {
    const snapshot = await _captureAriaAndText(locator, 3000);
    context.setRuntime(`_autoCapture_${nodeId}`, snapshot);
  } catch {
    // Non-fatal — pre-click state is best-effort
  }
}
