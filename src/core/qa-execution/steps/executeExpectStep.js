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
  return {
    status:          result.passed ? 'passed' : 'failed',
    errorCode:       result.errorCode,
    error:           result.error,
    assertionResult: result,
    logs:            [],
  };
}
