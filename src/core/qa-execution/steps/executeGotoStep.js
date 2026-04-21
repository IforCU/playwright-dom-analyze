import { ERROR_CODES } from '../errors/errorCodes.js';
import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';

/**
 * Navigate to a URL, resolving relative paths against the policy baseURL.
 * Blocks external navigation when the safety policy requires it.
 */
export async function executeGotoStep(page, step, _state, _elementMap, policy) {
  const rawUrl    = step.url ?? '/';
  const baseURL   = policy.baseURL ?? '';
  const resolved  = rawUrl.startsWith('http') ? rawUrl : baseURL + rawUrl;
  const timeout   = step.timeoutMs ?? 30000;
  const waitUntil = step.waitUntil ?? 'load';

  if (rawUrl.startsWith('http') && !policy.safety?.allowExternalNavigation) {
    const targetHost = hostnameOf(resolved);
    const baseHost   = hostnameOf(baseURL || 'http://localhost');
    if (targetHost && baseHost && targetHost !== baseHost) {
      return {
        status:    'failed',
        errorCode: ERROR_CODES.NAVIGATION_BLOCKED,
        error:     `External navigation to "${resolved}" is blocked by safety policy`,
        logs:      [],
      };
    }
  }

  try {
    await page.goto(resolved, { timeout, waitUntil });
    return { status: 'passed', logs: [], extra: { navigatedTo: page.url() } };
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    return { status: 'failed', errorCode: code, error: message, logs: [message] };
  }
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
