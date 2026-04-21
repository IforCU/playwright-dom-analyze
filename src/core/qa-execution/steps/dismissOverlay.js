/**
 * dismissOverlay.js
 *
 * 팝업/모달/오버레이를 자동으로 닫으려 시도하는 유틸리티.
 *
 * 전략 (순서대로):
 *   1. ESC 키 전송
 *   2. 일반적인 닫기 버튼 선택자 클릭 (X 버튼, 확인, 닫기 텍스트 등)
 *   3. 오버레이 배경(dim) 영역 클릭
 *   4. 그래도 닫히지 않으면 false 반환
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}  true = 닫기 시도 완료, false = 모달 없음 또는 닫기 실패
 */

/** 닫기 버튼으로 우선 시도할 CSS 선택자 목록 (우선순위 순) */
const CLOSE_BUTTON_SELECTORS = [
  // aria 기반
  'button[aria-label="닫기"]',
  'button[aria-label="close"]',
  'button[aria-label="Close"]',
  // 텍스트/역할 기반
  'button.close',
  'button.btn-close',
  'button.modal-close',
  'button.popup-close',
  '[class*="close-btn"]',
  '[class*="closeBtn"]',
  '[class*="btn-close"]',
  '[class*="popup-close"]',
  '[class*="modal-close"]',
  '[class*="layer-close"]',
  // 일반 다이얼로그 닫기
  'dialog button[type="button"]',
  '.modal button[type="button"]',
  '.popup button[type="button"]',
  '.layer button[type="button"]',
  // 11st 특화
  '.c-modal__close',
  '.c-popup__close',
  '.c-layer__close',
];

/** 오버레이 배경(dim) 영역 선택자 */
const DIM_SELECTORS = [
  '.dim',
  '.overlay',
  '.modal-backdrop',
  '.popup-backdrop',
  '[class*="dim"]',
  '[class*="backdrop"]',
];

/**
 * 현재 페이지에 가시적인 모달/팝업이 존재하는지 확인합니다.
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function hasVisibleOverlay(page) {
  return page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('.modal, .popup, .layer, .c-modal, .c-popup, dialog[open]'),
    ];
    return candidates.some(el => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
  }).catch(() => false);
}

/**
 * 팝업/모달을 닫으려 시도합니다.
 *
 * @param {import('playwright').Page} page
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ dismissed: boolean, method: string|null }>}
 */
export async function dismissOverlay(page, { timeoutMs = 2000 } = {}) {
  // 1. ESC 키
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const gone = !(await hasVisibleOverlay(page));
    if (gone) return { dismissed: true, method: 'Escape' };
  } catch { /* continue */ }

  // 2. 닫기 버튼 클릭
  for (const sel of CLOSE_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      const count = await btn.count();
      if (count === 0) continue;
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      await btn.click({ timeout: timeoutMs, force: true });
      await page.waitForTimeout(300);
      return { dismissed: true, method: `closeBtn:${sel}` };
    } catch { /* try next */ }
  }

  // 3. 오버레이 배경 클릭
  for (const sel of DIM_SELECTORS) {
    try {
      const dim = page.locator(sel).first();
      const count = await dim.count();
      if (count === 0) continue;
      const visible = await dim.isVisible().catch(() => false);
      if (!visible) continue;
      await dim.click({ timeout: timeoutMs, force: true, position: { x: 5, y: 5 } });
      await page.waitForTimeout(300);
      return { dismissed: true, method: `dim:${sel}` };
    } catch { /* try next */ }
  }

  return { dismissed: false, method: null };
}
