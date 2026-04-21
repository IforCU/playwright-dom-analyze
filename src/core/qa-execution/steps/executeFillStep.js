import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';
import { ERROR_CODES }              from '../errors/errorCodes.js';

export async function executeFillStep(page, step, state, _elementMap, _policy, locator) {
  if (!locator) {
    return noLocator('fill');
  }
  const template = step.input?.valueTemplate ?? step.input?.value ?? '';
  const value    = state.interpolate(template);
  const timeout  = step.timeoutMs ?? 10000;
  try {
    await locator.fill(value, { timeout });
    return { status: 'passed', logs: [], extra: { filledValue: value } };
  } catch (e) {
    return fromError(e);
  }
}

function noLocator(type) {
  const msg = `Could not resolve element for "${type}" step`;
  return { status: 'failed', errorCode: ERROR_CODES.TARGET_NOT_FOUND, error: msg, logs: [msg] };
}

function fromError(e) {
  const { code, message } = normalizePlaywrightError(e);
  return { status: 'failed', errorCode: code, error: message, logs: [message] };
}
