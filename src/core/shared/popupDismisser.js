/**
 * src/core/shared/popupDismisser.js
 *
 * Shared popup / modal / overlay dismissal utility used by BOTH
 * web analysis (Phase 1) and QA execution.
 *
 * Why a shared module?
 *   - Cookie banners, welcome coupon popups, login walls, app-install
 *     prompts and similar overlays appear non-deterministically. They
 *     ruin baseline DOM snapshots during analysis AND time-out clicks
 *     during QA scenarios (see 11ST-SEARCH-001 failure where a delayed
 *     "웰컴 쿠폰" modal blocked the search input).
 *   - The existing `pageStabilizer.stabilizePage()` already implements
 *     a robust staged-strategy detector (heuristics + Escape + CSS hide).
 *     This file re-exports it under a clearer name and adds:
 *       1. `quickDismissPopups()`   – cheap version safe to call before
 *          every QA step (skips media pause + readiness check).
 *       2. `installPopupAutoCloser()` – attaches per-page hooks that
 *          auto-dismiss on navigation events and on a tunable interval.
 *
 * All operations are best-effort and never throw.
 */

import { stabilizePage } from '../qa-analysis/phase1/pageStabilizer.js';

/**
 * Full dismissal pass — alias for `stabilizePage()` exposing a clearer
 * name to QA-execution callers.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]  forwarded to stabilizePage()
 * @returns {Promise<object>} stabilization report
 */
export async function dismissPopups(page, opts = {}) {
  return stabilizePage(page, opts);
}

/**
 * Lightweight dismissal pass for use inside QA scenarios.
 *
 * Differs from `stabilizePage` in that it:
 *   - Skips the autoplay-media pause stage (irrelevant during QA).
 *   - Skips the secondary readiness re-scan.
 *   - Returns silently when no blocker is detected (no console spam).
 *   - Limits processing to the top 2 blockers to keep latency < 250 ms.
 *
 * Safe to call between every QA step.
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {boolean} [opts.silent=true]   – suppress console output unless a popup was actually dismissed
 * @returns {Promise<{ dismissed: number, hidden: number }>}
 */
export async function quickDismissPopups(page, opts = {}) {
  const { silent = true } = opts;
  if (!page || page.isClosed?.()) return { dismissed: 0, hidden: 0 };

  // ── 입력 보호 가드 ─────────────────────────────────────────────────────────
  // 사용자/시나리오가 input·textarea·contenteditable 에 값을 입력한 직후
  // 자동완성 드롭다운이 뜨는 사이트(Naver 검색창 등)에서, 이 함수가 그
  // 드롭다운을 "팝업"으로 오인해 Escape 키를 눌러 버리면 입력값까지 함께
  // 사라집니다. 또한 오버레이 내부 "닫기" 버튼 클릭은 포커스를 빼앗아
  // input 의 onBlur 핸들러가 값을 초기화하게 만듭니다.
  // → 활성 요소가 editable 이면 dismissal 을 건너뜁니다.
  try {
    const isEditing = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a) return false;
      if (a.isContentEditable) return true;
      const tag = a.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        const t = (a.getAttribute('type') || 'text').toLowerCase();
        // 텍스트성 입력 타입만 보호 (button/checkbox 등은 무시)
        const TEXTUAL = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);
        return TEXTUAL.has(t);
      }
      return false;
    }).catch(() => false);
    if (isEditing) {
      return { dismissed: 0, hidden: 0, skipped: 'editable-focus' };
    }
  } catch { /* ignore */ }

  try {
    const report = await stabilizePage(page, {
      enabled:           true,
      coverageThreshold: 0.30,
      minZIndex:         50,
      maxBlockers:       2,
    });

    const result = {
      dismissed: report.dismissedCount ?? 0,
      hidden:    report.hiddenCount    ?? 0,
    };

    if (!silent || result.dismissed > 0 || result.hidden > 0) {
      if (result.dismissed > 0 || result.hidden > 0) {
        console.log(`[popup] quick-dismiss: dismissed=${result.dismissed} hidden=${result.hidden}`);
      }
    }

    return result;
  } catch {
    return { dismissed: 0, hidden: 0 };
  }
}

/**
 * Install background popup auto-closer hooks on a Playwright page.
 *
 * Behaviour:
 *   1. Runs `quickDismissPopups()` immediately (best-effort).
 *   2. Subscribes to `framenavigated` (top frame only) — re-runs after
 *      each navigation since most coupon / welcome modals appear on the
 *      first idle tick after the new page loads.
 *   3. Schedules a periodic interval (default 2 s) that runs
 *      `quickDismissPopups()` while the page is open. The interval is
 *      cleared automatically when the page closes.
 *
 * Returns an `uninstall()` function so callers can stop the auto-closer
 * (e.g. before deliberately interacting with a modal during a scenario).
 *
 * @param {import('playwright').Page} page
 * @param {object} [opts]
 * @param {number}  [opts.intervalMs=2000] – polling cadence; <= 0 disables interval
 * @param {boolean} [opts.onNavigation=true] – run after each top-frame navigation
 * @returns {() => void} uninstall function
 */
export function installPopupAutoCloser(page, opts = {}) {
  const { intervalMs = 2000, onNavigation = true } = opts;

  if (!page || page.isClosed?.()) return () => {};

  let stopped     = false;
  let timer       = null;
  let inFlight    = false;
  let navHandler  = null;

  const tick = async () => {
    if (stopped || inFlight)     return;
    if (page.isClosed?.())       return uninstall();
    inFlight = true;
    try {
      await quickDismissPopups(page, { silent: true });
    } catch { /* ignore */ } finally {
      inFlight = false;
    }
  };

  // Initial pass — fire-and-forget so the caller is not blocked.
  tick();

  if (onNavigation) {
    navHandler = (frame) => {
      if (frame !== page.mainFrame()) return;
      // Wait briefly for the post-navigation modals to render before scanning.
      setTimeout(() => { tick(); }, 600);
    };
    page.on('framenavigated', navHandler);
  }

  if (intervalMs > 0) {
    timer = setInterval(tick, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // Auto-uninstall when the page closes.
  page.once('close', uninstall);

  function uninstall() {
    if (stopped) return;
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
    if (navHandler) {
      try { page.off('framenavigated', navHandler); } catch { /* noop */ }
      navHandler = null;
    }
  }

  return uninstall;
}
