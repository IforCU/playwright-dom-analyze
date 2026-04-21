import { normalizePlaywrightError } from '../errors/normalizePlaywrightError.js';
import { ERROR_CODES }              from '../errors/errorCodes.js';
import { autoCapturePre }           from '../assertions/builtInMatchers.js';
import { dismissOverlay }           from './dismissOverlay.js';

/** 이 오류 메시지가 포함된 경우 오버레이 차단으로 판단합니다. */
const INTERCEPT_PATTERNS = [
  'intercepts pointer events',
  'element is not visible',
  'element is outside of the viewport',
  'element is covered by another',
];

function isInterceptError(msg) {
  return INTERCEPT_PATTERNS.some(p => msg.includes(p));
}

/**
 * Click a resolved element.
 *
 * Pre-click aria/text state is automatically captured for every click that has
 * a nodeId, enabling the `textOrAriaStateChanged` matcher in a later step.
 *
 * 팝업/모달 차단 감지 시:
 *   1. dismissOverlay()로 닫기 시도 (ESC → 닫기버튼 → 배경 클릭)
 *   2. 닫기 성공 시 300ms 대기 후 클릭 재시도 1회
 */
export async function executeClickStep(page, step, state, _elementMap, _policy, locator) {
  if (!locator) {
    return noLocator('click');
  }

  const nodeId  = step.targetRef?.nodeId ?? null;
  const timeout = step.timeoutMs ?? 10000;

  await autoCapturePre(locator, nodeId, state, timeout);

  try {
    await locator.click({ timeout });
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    return { status: 'passed', logs: [] };
  } catch (e) {
    const rawMsg = e?.message ?? String(e);

    // 오버레이/팝업 차단 감지 → 닫고 재시도
    if (isInterceptError(rawMsg)) {
      const { dismissed, method } = await dismissOverlay(page);

      if (dismissed) {
        try {
          await locator.click({ timeout });
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          return {
            status: 'passed',
            logs:   [`[overlay] 팝업 닫은 후 재시도 성공 (방법: ${method})`],
          };
        } catch (e2) {
          // 재시도도 실패 → 원래 오버레이 오류로 반환
          const { code, message } = normalizePlaywrightError(e2);
          return {
            status:    'failed',
            errorCode: code,
            error:     `${message} (오버레이 닫기 후 재시도 실패)`,
            logs:      [`[overlay] 닫기 방법: ${method} → 재시도 후에도 실패`],
          };
        }
      }

      // 닫지 못한 경우
      const { code, message } = normalizePlaywrightError(e);
      return {
        status:    'failed',
        errorCode: code,
        error:     `${message} (오버레이 자동 닫기 실패)`,
        logs:      ['[overlay] ESC·닫기버튼·배경 클릭 시도했으나 팝업을 닫지 못했습니다.'],
      };
    }

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
