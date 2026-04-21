import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';
import { ERROR_CODES }              from '../errors/errorCodes.js';

export async function executeCheckStep(_page, step, _state, _elementMap, _policy, locator) {
  if (!locator) {
    const msg = 'Could not resolve element for "check" step';
    return { status: 'failed', errorCode: ERROR_CODES.TARGET_NOT_FOUND, error: msg, logs: [msg] };
  }
  const timeout = step.timeoutMs ?? 10000;
  try {
    await locator.check({ timeout });
    return { status: 'passed', logs: [] };
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    return { status: 'failed', errorCode: code, error: message, logs: [message] };
  }
}
