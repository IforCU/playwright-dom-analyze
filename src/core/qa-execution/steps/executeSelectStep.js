import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';
import { ERROR_CODES }              from '../errors/errorCodes.js';

export async function executeSelectStep(_page, step, state, _elementMap, _policy, locator) {
  if (!locator) {
    const msg = 'Could not resolve element for "select" step';
    return { status: 'failed', errorCode: ERROR_CODES.TARGET_NOT_FOUND, error: msg, logs: [msg] };
  }
  const template = step.input?.valueTemplate ?? step.input?.value ?? '';
  const value    = state.interpolate(template);
  const timeout  = step.timeoutMs ?? 10000;
  try {
    await locator.selectOption(value, { timeout });
    return { status: 'passed', logs: [], extra: { selectedValue: value } };
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    return { status: 'failed', errorCode: code, error: message, logs: [message] };
  }
}
