import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';

export async function executeWaitForStep(page, step, _state, _elementMap, _policy, locator) {
  const waitFor = step.waitFor ?? {};
  const kind    = waitFor.kind    ?? 'timeout';
  const ms      = waitFor.ms      ?? 1000;
  const timeout = step.timeoutMs  ?? ms + 5000;

  try {
    if (kind === 'timeout') {
      await page.waitForTimeout(ms);
    } else if (locator) {
      await locator.waitFor({ state: kind, timeout });
    } else {
      await page.waitForTimeout(ms);
    }
    return { status: 'passed', logs: [] };
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    return { status: 'failed', errorCode: code, error: message, logs: [message] };
  }
}
