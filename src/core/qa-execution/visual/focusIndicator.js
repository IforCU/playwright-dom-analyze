/**
 * src/core/qa-execution/visual/focusIndicator.js
 *
 * 화면 녹화(.webm) 안에서 "지금 컴퓨터가 어떤 요소에 집중하고 있는지"를
 * 시각적으로 보여주기 위한 가벼운 오버레이입니다.
 *
 * 그리는 것:
 *   1) 우측 상단 캡션 배지   — 현재 스텝 정보 (type / id / 액션)
 *   2) 대상 요소 위 펄스 링  — bbox 주변에 두 겹의 애니메이션 링
 *   3) 마우스 커서 점         — bbox 중앙으로 이동하는 가짜 커서 (페이지 좌표)
 *
 * 모든 함수는 best-effort, 절대 throw 하지 않습니다. 페이지 컨텍스트가
 * 사라졌거나(navigation), evaluate 실패해도 조용히 무시됩니다.
 */

const BANNER_ID    = '__qa_focus_banner__';
const RING_ID      = '__qa_focus_ring__';
const CURSOR_ID    = '__qa_focus_cursor__';
const STYLE_ID     = '__qa_focus_style__';

const STEP_TYPE_KO = {
  goto:            '이동',
  fill:            '입력',
  click:           '클릭',
  expect:          '검증',
  capture:         '캡처',
  scroll:          '스크롤',
  scrollToElement: '요소로 스크롤',
  waitFor:         '대기',
  select:          '선택',
  check:           '체크',
  uncheck:         '체크해제',
  press:           '키 입력',
};

const STEP_TYPE_COLOR = {
  goto:    '#3b82f6',   // blue
  fill:    '#06b6d4',   // cyan
  click:   '#22c55e',   // green
  press:   '#22c55e',
  expect:  '#a855f7',   // purple
  capture: '#eab308',   // amber
  scroll:  '#64748b',   // slate
  scrollToElement: '#64748b',
  waitFor: '#94a3b8',
  select:  '#06b6d4',
  check:   '#22c55e',
  uncheck: '#f97316',   // orange
};

/**
 * 스텝 시작 직전에 호출. 캡션을 띄우고, locator 가 있으면 해당 요소를
 * 펄스 링으로 강조합니다. 약 600ms 정도 화면에 남아 비디오에 잡힙니다.
 *
 * @param {import('playwright').Page} page
 * @param {object} step  — 현재 스텝 정의
 * @param {import('playwright').Locator|null} locator  — 해석된 로케이터 (있을 수도/없을 수도)
 */
export async function showStepFocus(page, step, locator) {
  if (!page || page.isClosed?.()) return;
  const type   = step?.type ?? 'unknown';
  const stepId = step?.stepId ?? '';
  const name   = step?.name ?? '';
  const labelKo = STEP_TYPE_KO[type] ?? type;
  const color   = STEP_TYPE_COLOR[type] ?? '#3b82f6';

  // 1) 페이지 좌표계의 bbox 계산 (스크롤 보정)
  let bbox = null;
  if (locator) {
    try {
      const live = await locator.first().boundingBox({ timeout: 250 }).catch(() => null);
      if (live) {
        const offset = await page.evaluate(() => ({
          sx: window.scrollX || 0,
          sy: window.scrollY || 0,
        })).catch(() => ({ sx: 0, sy: 0 }));
        bbox = {
          x: Math.round(live.x + offset.sx),
          y: Math.round(live.y + offset.sy),
          w: Math.round(live.width),
          h: Math.round(live.height),
        };
      }
    } catch { /* ignore */ }
  }

  try {
    await page.evaluate(({ stepId, name, labelKo, color, bbox }) => {
      const STYLE_ID  = '__qa_focus_style__';
      const BANNER_ID = '__qa_focus_banner__';
      const RING_ID   = '__qa_focus_ring__';

      // 스타일은 한 번만 주입
      if (!document.getElementById(STYLE_ID)) {
        const st = document.createElement('style');
        st.id = STYLE_ID;
        st.textContent = `
          @keyframes __qa_pulse_ring__ {
            0%   { transform: scale(0.85); opacity: 1; }
            70%  { transform: scale(1.25); opacity: 0; }
            100% { transform: scale(1.25); opacity: 0; }
          }
          @keyframes __qa_pulse_inner__ {
            0%   { transform: scale(0.95); opacity: 0.9; }
            100% { transform: scale(1.02); opacity: 0.6; }
          }
          @keyframes __qa_banner_in__ {
            from { transform: translateY(-12px); opacity: 0; }
            to   { transform: translateY(0);     opacity: 1; }
          }
        `;
        document.documentElement.appendChild(st);
      }

      // 기존 인디케이터 제거
      document.getElementById(BANNER_ID)?.remove();
      document.getElementById(RING_ID)?.remove();

      // 2) 우측 상단 캡션 배지
      const banner = document.createElement('div');
      banner.id = BANNER_ID;
      banner.style.cssText = `
        position: fixed;
        top: 18px;
        right: 18px;
        z-index: 2147483646;
        max-width: 640px;
        padding: 14px 22px;
        background: rgba(15, 23, 42, 0.94);
        color: #fff;
        font: 700 18px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        border-left: 7px solid ${color};
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.45);
        pointer-events: none;
        animation: __qa_banner_in__ 220ms ease-out;
      `;
      const safe = (s) => String(s ?? '').replace(/[<>&]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;' })[c]);
      banner.innerHTML = `
        <div style="display:flex; align-items:center; gap:12px;">
          <span style="background:${color}; color:#0f172a; padding:5px 14px; border-radius:6px; font-size:16px; font-weight:800; letter-spacing:0.4px;">${safe(labelKo)}</span>
          <span style="opacity:0.85; font-size:15px; font-weight:600;">${safe(stepId)}</span>
        </div>
        ${name ? `<div style="margin-top:8px; font-weight:600; opacity:0.96; font-size:16px;">${safe(name).slice(0, 160)}</div>` : ''}
      `;
      document.documentElement.appendChild(banner);

      // 3) 펄스 링 (bbox 가 있을 때만)
      if (bbox && bbox.w > 0 && bbox.h > 0) {
        const wrap = document.createElement('div');
        wrap.id = RING_ID;
        wrap.style.cssText = `
          position: absolute;
          left: ${bbox.x - 12}px;
          top: ${bbox.y - 12}px;
          width: ${bbox.w + 24}px;
          height: ${bbox.h + 24}px;
          z-index: 2147483645;
          pointer-events: none;
        `;
        // inner 레이어 — 항상 보이는 박스 강조
        const inner = document.createElement('div');
        inner.style.cssText = `
          position: absolute;
          inset: 0;
          border: 4px solid ${color};
          border-radius: 10px;
          box-shadow: 0 0 0 3px rgba(255,255,255,0.6) inset, 0 0 22px ${color};
          background: ${color}26;
          animation: __qa_pulse_inner__ 750ms ease-out alternate infinite;
        `;
        // outer 펄스 링
        const outer = document.createElement('div');
        outer.style.cssText = `
          position: absolute;
          inset: -8px;
          border: 5px solid ${color};
          border-radius: 14px;
          opacity: 0;
          animation: __qa_pulse_ring__ 950ms ease-out infinite;
        `;
        wrap.appendChild(outer);
        wrap.appendChild(inner);
        document.documentElement.appendChild(wrap);
      }
    }, { stepId, name, labelKo, color, bbox }).catch(() => {});
  } catch { /* ignore */ }
}

/**
 * 스텝 종료 직후 호출. 인디케이터를 정리하지만 다음 스텝이 곧 새 인디케이터를
 * 띄우므로 굳이 즉시 지우지 않아도 됩니다. 시나리오 마지막에 한 번 정리하는
 * 용도로도 사용합니다.
 *
 * @param {import('playwright').Page} page
 */
export async function clearStepFocus(page) {
  if (!page || page.isClosed?.()) return;
  try {
    await page.evaluate(() => {
      document.getElementById('__qa_focus_banner__')?.remove();
      document.getElementById('__qa_focus_ring__')?.remove();
      document.getElementById('__qa_focus_cursor__')?.remove();
    }).catch(() => {});
  } catch { /* ignore */ }
}
