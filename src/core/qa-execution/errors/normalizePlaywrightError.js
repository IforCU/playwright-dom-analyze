import { ERROR_CODES } from './errorCodes.js';

/**
 * Playwright 원시 에러를 한국어 요약 메시지 + 에러코드로 변환합니다.
 *
 * @param {Error|unknown} err
 * @returns {{ code: string, message: string }}
 */
export function normalizePlaywrightError(err) {
  const msg = err?.message ?? String(err);

  if (msg.includes('Timeout') || msg.includes('waiting for')) {
    const ms = msg.match(/Timeout (\d+)ms/)?.[1];
    const el = msg.match(/waiting for ([^\n]+)/)?.[1]?.trim();
    const intercept = msg.includes('intercepts pointer events')
      ? ' (다른 요소가 클릭을 가로막고 있음 — 팝업/모달 확인 필요)'
      : '';
    const detail = el ? ` — 대상: ${el.slice(0, 80)}` : '';
    return {
      code: ERROR_CODES.TIMEOUT,
      message: `⏱ 타임아웃: ${ms ? ms + 'ms 초과' : '제한 시간 초과'}${detail}${intercept}`,
    };
  }

  if (msg.includes('intercepts pointer events') || msg.includes('modal') || msg.includes('overlay')) {
    return {
      code: ERROR_CODES.MODAL_BLOCKED,
      message: '🚫 팝업/모달이 대상 요소를 가리고 있어 클릭할 수 없습니다.',
    };
  }

  if (msg.includes('not visible') || msg.includes('hidden') || msg.includes('not attached')) {
    return {
      code: ERROR_CODES.TARGET_NOT_VISIBLE,
      message: '👁 요소가 화면에 보이지 않거나 DOM에 존재하지 않습니다.',
    };
  }

  if (msg.includes('no element') || msg.includes('not found') || msg.includes('failed to find')) {
    return {
      code: ERROR_CODES.TARGET_NOT_FOUND,
      message: '🔍 지정된 선택자로 요소를 찾을 수 없습니다.',
    };
  }

  if (msg.includes('Navigation') || msg.includes('net::ERR') || msg.includes('invalid URL')) {
    return {
      code: ERROR_CODES.NAVIGATION_BLOCKED,
      message: `🌐 페이지 이동 실패: ${msg.match(/net::ERR_\w+/)?.[0] ?? 'URL이 유효하지 않거나 서버에 연결할 수 없습니다.'}`,
    };
  }

  if (msg.includes('context was destroyed') || msg.includes('Target closed')) {
    return {
      code: ERROR_CODES.CONTEXT_DESTROYED,
      message: '💥 브라우저 컨텍스트가 예기치 않게 종료되었습니다.',
    };
  }

  return {
    code: ERROR_CODES.ASSERTION_FAILED,
    message: `❌ 실행 오류: ${msg.split('\n')[0].slice(0, 120)}`,
  };
}

/**
 * 고수준 스텝 실패 이유를 한국어 메시지로 분류합니다.
 *
 * @param {'out_of_scope'|'auth_required'|'unsupported_step'|'unsupported_matcher'} reason
 * @param {string} detail
 * @returns {{ code: string, message: string }}
 */
export function classifyStepFailure(reason, detail) {
  return { code: reason, message: detail };
}
