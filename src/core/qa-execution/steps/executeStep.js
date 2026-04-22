import { resolveTarget }              from '../target-resolution/resolveTarget.js';
import { setupSignals, collectSignals } from '../signals/waitForSignals.js';
import { ERROR_CODES }                 from '../errors/errorCodes.js';
import { normalizePlaywrightError }    from '../errors/normalizePlaywrightError.js';
import { showStepFocus }               from '../visual/focusIndicator.js';

import { executeGotoStep }          from './executeGotoStep.js';
import { executeFillStep }          from './executeFillStep.js';
import { executeClickStep }         from './executeClickStep.js';
import { executeExpectStep }        from './executeExpectStep.js';
import { executeCaptureStep }       from './executeCaptureStep.js';
import { executeScrollStep }        from './executeScrollStep.js';
import { executeScrollToElementStep } from './executeScrollToElementStep.js';
import { executeWaitForStep }       from './executeWaitForStep.js';
import { executeSelectStep }        from './executeSelectStep.js';
import { executeCheckStep }         from './executeCheckStep.js';
import { executeUncheckStep }       from './executeUncheckStep.js';
import { executePressStep }         from './executePressStep.js';

/** Steps that do NOT need an element locator. */
const PAGE_SCOPE_TYPES = new Set(['goto', 'scroll', 'expect', 'press', 'waitFor']);

const HANDLERS = {
  goto:            executeGotoStep,
  fill:            executeFillStep,
  click:           executeClickStep,
  expect:          executeExpectStep,
  capture:         executeCaptureStep,
  scroll:          executeScrollStep,
  scrollToElement: executeScrollToElementStep,
  waitFor:         executeWaitForStep,
  select:          executeSelectStep,
  check:           executeCheckStep,
  uncheck:         executeUncheckStep,
  press:           executePressStep,
};

/**
 * Execute a single step end-to-end:
 *   1. Look up the step handler.
 *   2. Resolve element locator (unless page-scope step with no targetRef).
 *   3. Register expected signals before the action.
 *   4. Run the handler.
 *   5. Collect signal results.
 *   6. Build and return a StepResult object.
 *
 * @param {import('playwright').Page} page
 * @param {object} step
 * @param {import('../runtime/runtimeState.js').RuntimeState} state
 * @param {object|null} elementMap
 * @param {object} policy
 * @param {object} [ctx]           – extra context passed to step handlers (e.g. { outputDir })
 * @returns {Promise<object>}  StepResult
 */
export async function executeStep(page, step, state, elementMap, policy, ctx = {}) {
  const startedAt = new Date().toISOString();
  const t0        = Date.now();
  const handler   = HANDLERS[step.type];

  if (!handler) {
    const msg = `지원하지 않는 스텝 유형: "${step.type}"`;
    return buildResult(step, 'failed', startedAt, 0, {
      errorCode: ERROR_CODES.UNSUPPORTED_STEP, error: msg, logs: [msg],
    });
  }

  // ── Resolve element locator ──────────────────────────────────────────────
  let locator          = null;
  let resolutionResult = null;

  const needsLocator = step.targetRef && !(PAGE_SCOPE_TYPES.has(step.type) && !step.targetRef?.nodeId);
  if (needsLocator) {
    const resolved = await resolveTarget(page, step, elementMap);
    locator          = resolved.locator;
    resolutionResult = resolved.resolutionResult;

    if (!locator && step.type !== 'expect' && step.type !== 'waitFor') {
      return buildResult(step, 'failed', startedAt, elapsed(t0), {
        errorCode: ERROR_CODES.TARGET_NOT_FOUND,
        error: `요소를 찾을 수 없음: 스텝 "${step.stepId ?? step.type}" — analysisRef 및 locatorFallback 모두 실패`,
        logs: [`[target] nodeId=${resolutionResult?.nodeId}  locatorKind=${resolutionResult?.locatorKind}  value=${resolutionResult?.locatorValue}`],
        resolutionResult,
        logs: [],
      });
    }
  }

  // ── Setup signals (registered before action) ─────────────────────────────
  const urlBefore   = page.url();
  const observations = await setupSignals(page, step.expectedSignals, urlBefore);

  // ── Visual focus indicator (best-effort, captured by video) ──────────────
  // 화면 녹화를 보는 사람이 "지금 어떤 요소에 액션이 들어가는지" 한눈에 알 수
  // 있도록 캡션 + 펄스 링을 잠깐 띄웁니다. goto/스크롤처럼 navigation 이
  // 발생하는 스텝은 어차피 직후 페이지가 갈아엎이므로 페이지 컨텍스트
  // 손실에 안전한 best-effort 호출입니다.
  await showStepFocus(page, step, locator);

  // ── Run the step handler ─────────────────────────────────────────────────
  let handlerResult;
  try {
    handlerResult = await handler(page, step, state, elementMap, policy, locator, ctx);
  } catch (e) {
    const { code, message } = normalizePlaywrightError(e);
    handlerResult = {
      status: 'failed',
      errorCode: code,
      error: message,
      logs: [],
    };
  }

  // ── Collect signal results ───────────────────────────────────────────────
  const signalResults = await collectSignals(observations);

  // Required signal failures degrade the step status.
  const failedRequired = signalResults.filter(s => s.required && !s.passed);
  if (handlerResult.status === 'passed' && failedRequired.length > 0) {
    handlerResult.status    = 'failed';
    handlerResult.errorCode = ERROR_CODES.ASSERTION_FAILED;
    handlerResult.error     = `필수 시그널 미관측: ${failedRequired.map(s => s.type).join(', ')} — 동작 후 예상 변화가 발생하지 않음`;
  }

  return buildResult(step, handlerResult.status, startedAt, elapsed(t0), {
    ...handlerResult,
    resolutionResult: resolutionResult ?? handlerResult.resolutionResult ?? null,
    expectedSignalResults: signalResults,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function elapsed(t0) { return Date.now() - t0; }

function buildResult(step, status, startedAt, durationMs, extra = {}) {
  const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  return {
    stepId:               step.stepId   ?? null,
    name:                 step.name     ?? step.type,
    type:                 step.type,
    required:             step.required ?? true,
    status,
    startedAt,
    finishedAt,
    durationMs,
    logs:                 extra.logs            ?? [],
    error:                extra.error           ?? null,
    errorCode:            extra.errorCode       ?? null,
    resolutionResult:     extra.resolutionResult ?? null,
    capturedOutput:       extra.capturedOutput  ?? null,
    assertionResult:      extra.assertionResult ?? null,
    expectedSignalResults: extra.expectedSignalResults ?? [],
    artifacts:            extra.artifacts       ?? [],
  };
}
