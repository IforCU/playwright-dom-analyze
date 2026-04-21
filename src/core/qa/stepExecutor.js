/**
 * core/qa/stepExecutor.js
 *
 * Executes a single scenario step using Playwright.
 *
 * Responsibilities:
 *  - resolve the step's targetRef to a Playwright locator
 *  - interpolate runtime variables in input values
 *  - set up signal observations before the action
 *  - execute the correct Playwright method for each step type
 *  - collect signal results after the action
 *  - run assertions for `expect` steps
 *  - store captured values in RuntimeContext
 *  - return a structured StepResult with full metadata
 *
 * Error classification codes:
 *   target_not_found   – locator resolution failed
 *   target_not_visible – element resolved but not visible/actionable
 *   timeout            – Playwright timeout
 *   assertion_failed   – expect matcher returned false
 *   navigation_blocked – safety policy rejected external navigation
 *   capture_failed     – capture step evaluation error
 *   unsupported_step   – step type not registered
 *   out_of_scope       – safety policy flag blocked execution
 */

import { resolveTarget }                          from './locatorResolver.js';
import { SignalObserver }                          from './signalObserver.js';
import { executeAssertion, autoCapturePreClickState } from './assertionExecutor.js';

// ── Capture implementation ────────────────────────────────────────────────────

async function runCapture(page, locator, captureSpec, context, timeout) {
  const kind          = captureSpec?.kind ?? 'text';
  const attributeName = captureSpec?.attributeName ?? null;

  switch (kind) {
    case 'text':
    case 'innerText':
    case 'textContent': {
      const method = kind === 'innerText' ? 'innerText' : 'textContent';
      const raw    = method === 'innerText'
        ? await locator.innerText({ timeout })
        : await locator.textContent({ timeout });
      return (raw ?? '').trim();
    }
    case 'value':
      return await locator.inputValue({ timeout });
    case 'attribute': {
      if (!attributeName) throw new Error('capture kind=attribute requires attributeName');
      return await locator.getAttribute(attributeName, { timeout });
    }
    case 'aria':
      return await locator.evaluate(el => ({
        pressed:  el.getAttribute('aria-pressed'),
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
        label:    el.getAttribute('aria-label'),
        checked:  el.getAttribute('aria-checked'),
      }));
    case 'screenshot':
      return await locator.screenshot();
    case 'visible':
      return await locator.isVisible();
    case 'url':
      return page.url();
    case 'scrollY':
      return await page.evaluate(() => window.scrollY);
    default:
      throw new Error(`Unsupported capture kind: "${kind}"`);
  }
}

// ── Step type handlers ────────────────────────────────────────────────────────

const STEP_HANDLERS = {

  // ── goto ────────────────────────────────────────────────────────────────────
  async goto(page, step, _locator, _resolutionResult, context, _analysisElementMap, policy) {
    const rawUrl   = step.url ?? '/';
    const url      = rawUrl.startsWith('http') ? rawUrl : (policy.baseURL ?? '') + rawUrl;
    const timeout  = step.timeoutMs ?? 30000;
    const waitUntil = step.waitUntil ?? 'domcontentloaded';

    // Safety: external navigation check
    if (!policy.allowExternalNavigation && rawUrl.startsWith('http')) {
      const baseHost = new URL(policy.baseURL ?? 'http://localhost').hostname;
      const targetHost = new URL(url).hostname;
      if (targetHost !== baseHost) {
        return stepFail('navigation_blocked',
          `External navigation blocked by safety policy: ${url}`);
      }
    }

    await page.goto(url, { timeout, waitUntil });
    return stepOk({ navigatedTo: page.url() });
  },

  // ── fill ────────────────────────────────────────────────────────────────────
  async fill(_page, step, locator, resolutionResult, context) {
    if (!locator) {
      return stepFail('target_not_found', 'Could not resolve element for fill', resolutionResult);
    }
    const template = step.input?.valueTemplate ?? step.input?.value ?? '';
    const value    = context.interpolate(template);
    const timeout  = step.timeoutMs ?? 10000;
    try {
      await locator.fill(value, { timeout });
      return stepOk({ filledValue: value });
    } catch (e) {
      return classifyPlaywrightError(e, resolutionResult);
    }
  },

  // ── click ───────────────────────────────────────────────────────────────────
  async click(_page, step, locator, resolutionResult, context, _analysisElementMap) {
    if (!locator) {
      return stepFail('target_not_found', 'Could not resolve element for click', resolutionResult);
    }
    const timeout = step.timeoutMs ?? 10000;

    // Auto-capture pre-click aria/text state for textOrAriaStateChanged assertions
    const nodeId = step.targetRef?.nodeId ?? null;
    if (nodeId) {
      await autoCapturePreClickState(locator, nodeId, context);
    }

    try {
      await locator.click({ timeout });
      // Allow page to settle after click
      await _page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return stepOk({});
    } catch (e) {
      return classifyPlaywrightError(e, resolutionResult);
    }
  },

  // ── expect ──────────────────────────────────────────────────────────────────
  async expect(page, step, _locator, _resolutionResult, context, analysisElementMap) {
    const assertion     = step.assertion;
    const defaultTimeout = step.timeoutMs ?? 5000;
    const result = await executeAssertion(
      page, assertion, context, analysisElementMap, defaultTimeout,
    );
    if (result.passed) {
      return {
        status:          'passed',
        assertionResult: result,
        logs:            [`Assertion "${assertion.matcher}" passed`],
      };
    }
    return {
      status:          'failed',
      errorCode:       result.errorCode ?? 'assertion_failed',
      error:           result.error,
      assertionResult: result,
      logs:            [`Assertion "${assertion.matcher}" failed: ${result.error}`],
    };
  },

  // ── capture ─────────────────────────────────────────────────────────────────
  async capture(page, step, locator, resolutionResult, context) {
    if (!locator) {
      return stepFail('target_not_found', 'Could not resolve element for capture', resolutionResult);
    }
    // Support both legacy top-level saveAs and new capture object
    const captureSpec = step.capture ?? { kind: 'text' };
    const saveAs      = captureSpec.saveAs ?? step.saveAs ?? null;
    const timeout     = step.timeoutMs ?? 5000;

    try {
      const value = await runCapture(page, locator, captureSpec, context, timeout);
      if (saveAs) {
        context.setCaptured(saveAs, value);
      }
      return stepOk({ capturedValue: Buffer.isBuffer(value) ? '<screenshot>' : value, saveAs });
    } catch (e) {
      return stepFail('capture_failed', e.message, resolutionResult);
    }
  },

  // ── scroll ──────────────────────────────────────────────────────────────────
  async scroll(page, step) {
    const { direction = 'down', pixels = 0 } = step.scroll ?? {};
    let dx = 0;
    let dy = 0;
    if (direction === 'down')  dy =  pixels;
    if (direction === 'up')    dy = -pixels;
    if (direction === 'right') dx =  pixels;
    if (direction === 'left')  dx = -pixels;
    await page.evaluate(([x, y]) => window.scrollBy(x, y), [dx, dy]);
    return stepOk({ direction, pixels });
  },

  // ── scrollToElement ─────────────────────────────────────────────────────────
  async scrollToElement(_page, step, locator, resolutionResult) {
    if (!locator) {
      return stepFail('target_not_found', 'Could not resolve element for scrollToElement', resolutionResult);
    }
    const timeout = step.timeoutMs ?? 10000;
    try {
      await locator.scrollIntoViewIfNeeded({ timeout });
      return stepOk({});
    } catch (e) {
      return classifyPlaywrightError(e, resolutionResult);
    }
  },

  // ── waitFor ─────────────────────────────────────────────────────────────────
  async waitFor(page, step, locator) {
    const waitSpec = step.waitFor ?? {};
    const kind     = waitSpec.kind ?? 'visible';
    const timeout  = step.timeoutMs ?? 10000;

    if (kind === 'timeout') {
      await page.waitForTimeout(waitSpec.ms ?? 1000);
      return stepOk({});
    }
    if (locator) {
      await locator.waitFor({ state: kind, timeout });
      return stepOk({});
    }
    return stepOk({});
  },

  // ── select ──────────────────────────────────────────────────────────────────
  async select(_page, step, locator, resolutionResult, context) {
    if (!locator) {
      return stepFail('target_not_found', 'Could not resolve element for select', resolutionResult);
    }
    const rawValue = step.input?.value ?? step.input?.valueTemplate ?? '';
    const value    = context.interpolate(rawValue);
    const timeout  = step.timeoutMs ?? 10000;
    try {
      await locator.selectOption(value, { timeout });
      return stepOk({ selectedValue: value });
    } catch (e) {
      return classifyPlaywrightError(e, resolutionResult);
    }
  },

  // ── check ───────────────────────────────────────────────────────────────────
  async check(_page, step, locator, resolutionResult) {
    if (!locator) {
      return stepFail('target_not_found', 'Could not resolve element for check', resolutionResult);
    }
    try {
      await locator.check({ timeout: step.timeoutMs ?? 10000 });
      return stepOk({});
    } catch (e) {
      return classifyPlaywrightError(e, resolutionResult);
    }
  },

  // ── uncheck ─────────────────────────────────────────────────────────────────
  async uncheck(_page, step, locator, resolutionResult) {
    if (!locator) {
      return stepFail('target_not_found', 'Could not resolve element for uncheck', resolutionResult);
    }
    try {
      await locator.uncheck({ timeout: step.timeoutMs ?? 10000 });
      return stepOk({});
    } catch (e) {
      return classifyPlaywrightError(e, resolutionResult);
    }
  },

  // ── press ───────────────────────────────────────────────────────────────────
  async press(page, step, locator) {
    const key     = step.key ?? '';
    const timeout = step.timeoutMs ?? 10000;
    if (locator) {
      await locator.press(key, { timeout });
    } else {
      await page.keyboard.press(key);
    }
    return stepOk({ key });
  },
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Execute a single step and return a StepResult.
 *
 * @param {import('playwright').Page} page
 * @param {object} step
 * @param {import('./runtimeContext.js').RuntimeContext} context
 * @param {object|null} analysisElementMap
 * @param {object} policy  – suite defaults: safety, baseURL, executionPolicy
 * @param {number} maxRetries
 * @returns {Promise<object>} StepResult
 */
export async function executeStep(page, step, context, analysisElementMap, policy = {}, maxRetries = 0) {
  const startedAt = new Date().toISOString();
  const startMs   = Date.now();

  // Enforce safety flags
  const safetyError = checkSafetyPolicy(step, policy);
  if (safetyError) {
    return buildResult(step, 'failed', startedAt, Date.now() - startMs, {
      errorCode: 'out_of_scope',
      error:     safetyError,
      logs:      [`Safety policy blocked this step: ${safetyError}`],
    });
  }

  const handler = STEP_HANDLERS[step.type];
  if (!handler) {
    return buildResult(step, 'failed', startedAt, Date.now() - startMs, {
      errorCode: 'unsupported_step',
      error:     `Step type "${step.type}" is not supported by this executor.`,
      logs:      [],
    });
  }

  // Resolve locator (for target-requiring steps)
  let locator          = null;
  let resolutionResult = null;

  if (step.targetRef || step.resolution) {
    const resolved = await resolveTarget(page, step, analysisElementMap);
    locator          = resolved.locator;
    resolutionResult = resolved.resolutionResult;
  }

  // Set up signal observations before the action
  const observer = new SignalObserver(page);
  const urlBefore = page.url();
  await observer.setup(step.expectedSignals ?? [], urlBefore);

  // Execute with retry support
  let result;
  let attempt = 0;
  let finalStatus = 'failed';

  while (attempt <= maxRetries) {
    try {
      result = await handler(page, step, locator, resolutionResult, context, analysisElementMap, policy);
      finalStatus = result.status ?? 'passed';
      if (finalStatus !== 'failed') break;
    } catch (e) {
      result = classifyPlaywrightError(e, resolutionResult);
      finalStatus = 'failed';
    }
    if (attempt < maxRetries) {
      attempt++;
      finalStatus = 'retried_then_failed'; // tentative until next loop
      await page.waitForTimeout(500).catch(() => {});
    } else {
      break;
    }
  }

  // If retried and eventually passed
  if (attempt > 0 && finalStatus === 'passed') {
    finalStatus = 'retried_then_passed';
  }

  // Collect signal results after the action
  const expectedSignalResults = await observer.collect();

  // Check if any required signal failed
  const blockedBySignal = expectedSignalResults.find(s => s.required && !s.passed);
  if (blockedBySignal && finalStatus === 'passed') {
    finalStatus = 'failed';
    result = {
      ...result,
      errorCode: 'assertion_failed',
      error:     `Required signal "${blockedBySignal.type}" was not observed: ${blockedBySignal.detail?.reason ?? ''}`,
    };
  }

  const durationMs = Date.now() - startMs;
  return buildResult(step, finalStatus, startedAt, durationMs, {
    ...result,
    resolutionResult,
    expectedSignalResults,
  });
}

// ── Result builders ───────────────────────────────────────────────────────────

function stepOk(data) {
  return { status: 'passed', ...data };
}

function stepFail(errorCode, error, resolutionResult = null) {
  return { status: 'failed', errorCode, error, resolutionResult, logs: [error] };
}

function classifyPlaywrightError(e, resolutionResult) {
  const msg  = e?.message ?? String(e);
  let code   = 'assertion_failed';
  if (msg.includes('Timeout'))    code = 'timeout';
  if (msg.includes('not visible') || msg.includes('hidden')) code = 'target_not_visible';
  if (msg.includes('not found') || msg.includes('no element')) code = 'target_not_found';
  return { status: 'failed', errorCode: code, error: msg, resolutionResult, logs: [msg] };
}

function buildResult(step, status, startedAt, durationMs, extra = {}) {
  const finishedAt = new Date(new Date(startedAt).getTime() + durationMs).toISOString();
  return {
    stepId:    step.stepId,
    name:      step.name,
    type:      step.type,
    status,
    startedAt,
    finishedAt,
    durationMs,
    logs:                 extra.logs                 ?? [],
    error:                extra.error                ?? null,
    errorCode:            extra.errorCode            ?? null,
    resolutionResult:     extra.resolutionResult     ?? null,
    capturedOutput:       extra.saveAs ? { key: extra.saveAs, value: extra.capturedValue } : null,
    assertionResult:      extra.assertionResult      ?? null,
    expectedSignalResults: extra.expectedSignalResults ?? [],
    artifacts:            [],
  };
}

// ── Safety policy check ───────────────────────────────────────────────────────

function checkSafetyPolicy(step, policy) {
  const safety = policy.safety ?? {};
  if (step.type === 'goto' && step.url?.startsWith('http')) {
    if (!safety.allowExternalNavigation) {
      const targetHost = (() => {
        try { return new URL(step.url).hostname; } catch { return null; }
      })();
      const baseHost = (() => {
        try { return new URL(policy.baseURL ?? 'http://localhost').hostname; } catch { return null; }
      })();
      if (targetHost && baseHost && targetHost !== baseHost) {
        return `External navigation to "${step.url}" is blocked by safety policy.`;
      }
    }
  }
  return null;
}
