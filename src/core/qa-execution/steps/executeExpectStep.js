import { runAssertion } from '../assertions/builtInMatchers.js';
import { ERROR_CODES }  from '../errors/errorCodes.js';

export async function executeExpectStep(page, step, state, elementMap, _policy, _locator) {
  const assertion      = step.assertion;
  const defaultTimeout = step.timeoutMs ?? 10000;

  if (!assertion) {
    return {
      status:    'failed',
      errorCode: ERROR_CODES.UNSUPPORTED_MATCHER,
      error:     'expect step is missing an "assertion" field',
      logs:      [],
    };
  }

  const result = await runAssertion(page, assertion, state, elementMap, defaultTimeout);

  // Soft pass (partial) — matcher accepted the assertion under a relaxed
  // interpretation (substring match, surrounding-region change, etc.). We map
  // it to `retried_then_passed` so the scenario report surfaces it as 부분 성공.
  let status;
  if (result.passed && result.partial) {
    status = 'retried_then_passed';
  } else if (result.passed) {
    status = 'passed';
  } else {
    status = 'failed';
  }

  const logs = [];
  if (result.partial && result.partialReason) {
    logs.push(`[partial] ${result.partialReason}`);
  }

  return {
    status,
    errorCode:       result.errorCode,
    error:           result.error,
    assertionResult: result,
    logs,
  };
}
