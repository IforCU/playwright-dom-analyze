import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';

/**
 * Press a keyboard key.
 *
 * When a locator is resolved (element-scoped press), the key is dispatched
 * on that element. When there is no targetRef, the key goes to page.keyboard.
 */
export async function executePressStep(page, step, _state, _elementMap, _policy, locator) {
  const key     = step.key ?? '';
  const timeout = step.timeoutMs ?? 10000;
  try {
    if (locator) {
      await locator.press(key, { timeout });
    } else {
      await page.keyboard.press(key);
    }
    return { status: 'passed', logs: [], extra: { key } };
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    return { status: 'failed', errorCode: code, error: message, logs: [message] };
  }
}
