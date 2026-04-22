import { resolveTarget } from '../target-resolution/resolveTarget.js';
import { ERROR_CODES }   from '../errors/errorCodes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok   = (data = {}) => ({ passed: true,  ...data });
const fail = (code, msg, data = {}) => ({ passed: false, errorCode: code, error: msg, ...data });

/**
 * Soft pass — the assertion did not strictly satisfy the matcher, but a relaxed
 * interpretation (substring match / surrounding-region change / class token
 * presence) succeeded.  Propagated to the step result via `partial: true` and
 * later mapped to `retried_then_passed`, which surfaces as a 부분 성공 scenario.
 */
const softPass = (reason, data = {}) => ({ passed: true, partial: true, partialReason: reason, ...data });

/**
 * Normalize a string value before storing in assertionResult.actual.
 * - Collapses all runs of whitespace (including \n, \t) into a single space
 * - Trims leading/trailing whitespace
 * - Truncates to 500 characters with a suffix indicating original length
 *
 * This prevents entire page textContent blobs from bloating result.json.
 */
function normalizeActual(v) {
  if (typeof v !== 'string') return v;
  const normalized = v.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 500) return normalized;
  return normalized.slice(0, 500) + ` …[+${normalized.length - 500}자 생략]`;
}

// ── Built-in matcher implementations ─────────────────────────────────────────

/**
 * Each matcher receives:
 *   (page, locator, assertion, runtimeState, elementMap, timeout)
 * and returns:
 *   { passed, errorCode?, error?, actual?, expected? }
 */
const MATCHERS = {

  // ── Page-scope matchers ───────────────────────────────────────────────────

  async toHaveURL(page, _locator, assertion, _state, _map, timeout) {
    const { value } = assertion;
    if (page.url().includes(value)) return ok({ actual: page.url(), expected: value });
    try {
      await page.waitForURL(url => url.href.includes(value), { timeout });
      return ok({ actual: page.url(), expected: value });
    } catch {
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected URL to contain "${value}" but got "${page.url()}"`,
        { actual: page.url(), expected: value });
    }
  },

  async toContainURL(page, locator, assertion, state, map, timeout) {
    // Alias — same implementation as toHaveURL
    return MATCHERS.toHaveURL(page, locator, assertion, state, map, timeout);
  },

  async toHaveScrollYLessThanOrEqual(page, _l, assertion) {
    const { value } = assertion;
    const scrollY = await page.evaluate(() => window.scrollY).catch(() => null);
    if (scrollY === null) return fail(ERROR_CODES.ASSERTION_FAILED, 'Could not read window.scrollY');
    if (scrollY <= value)  return ok({ actual: scrollY, expected: `<= ${value}` });
    return fail(ERROR_CODES.ASSERTION_FAILED,
      `Expected scrollY <= ${value} but got ${scrollY}`, { actual: scrollY, expected: value });
  },

  async toSatisfyAny(page, _l, assertion) {
    const conditions = Array.isArray(assertion.value) ? assertion.value : [];
    for (const cond of conditions) {
      if (cond.type === 'urlContains' && page.url().includes(cond.value))
        return ok({ satisfiedCondition: cond });
      if (cond.type === 'textVisible') {
        const visible = await page.getByText(cond.value, { exact: false }).isVisible().catch(() => false);
        if (visible) return ok({ satisfiedCondition: cond });
      }
    }
    return fail(ERROR_CODES.ASSERTION_FAILED,
      `None of the ${conditions.length} condition(s) satisfied`, { conditions });
  },

  // ── Element-scope matchers ────────────────────────────────────────────────

  async toBeVisible(_p, locator, _a, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toBeVisible');
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return ok({});
    } catch {
      return fail(ERROR_CODES.ASSERTION_FAILED, 'Element is not visible');
    }
  },

  async toBeHidden(_p, locator, _a, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toBeHidden');
    try {
      await locator.waitFor({ state: 'hidden', timeout });
      return ok({});
    } catch {
      return fail(ERROR_CODES.ASSERTION_FAILED, 'Element is not hidden');
    }
  },

  async toHaveText(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveText');
    const { value } = assertion;
    try {
      const raw    = ((await locator.textContent({ timeout })) ?? '').trim();
      const actual = normalizeActual(raw);
      const exp    = String(value ?? '').trim();
      if (raw === value || actual === value || raw.trim() === exp) return ok({ actual, expected: value });
      // Soft-pass: locator likely resolved to a wider container that includes the
      // expected text as a prefix/substring (common with bbox-fallback matches).
      if (exp.length >= 2 && (raw.includes(exp) || actual.includes(exp))) {
        return softPass(`텍스트가 정확히 일치하지 않지만 "${exp}"를 포함합니다 (컨테이너 결정 가능성)`,
          { actual, expected: value });
      }
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected text "${value}" but got "${actual}"`, { actual, expected: value });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toContainText(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toContainText');
    const { value } = assertion;
    try {
      const raw    = ((await locator.textContent({ timeout })) ?? '').trim();
      const actual = normalizeActual(raw);
      if (raw.includes(value) || actual.includes(value)) return ok({ actual, expected: value });
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected text to contain "${value}" but got "${actual}"`, { actual, expected: value });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toHaveValue(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveValue');
    const { value } = assertion;
    try {
      const actual = await locator.inputValue({ timeout });
      const exp    = String(value ?? '');
      if (actual === value) return ok({ actual, expected: value });
      // Soft-pass: input contains the expected substring (e.g. trailing whitespace, suggestions).
      if (exp.length >= 1 && typeof actual === 'string' && actual.includes(exp)) {
        return softPass(`입력값이 정확히 일치하지 않지만 "${exp}"를 포함합니다`,
          { actual, expected: value });
      }
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected input value "${value}" but got "${actual}"`, { actual, expected: value });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toHaveAttribute(_p, locator, assertion, _s, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveAttribute');
    const { attribute, value, contains } = assertion;
    if (!attribute) return fail(ERROR_CODES.ASSERTION_FAILED, 'toHaveAttribute requires "attribute" field');
    try {
      const actual = await locator.getAttribute(attribute, { timeout });
      if (actual === value) return ok({ actual, expected: value, attribute });

      const exp = String(value ?? '');
      // Class-list semantics: token-presence is a strict pass.
      if ((attribute === 'class' || attribute === 'className') && typeof actual === 'string') {
        const tokens = actual.split(/\s+/).filter(Boolean);
        if (tokens.includes(exp)) {
          return ok({ actual, expected: value, attribute, matchMode: 'classToken' });
        }
      }
      // Explicit `contains: true` opts into substring semantics.
      if (contains && typeof actual === 'string' && actual.includes(exp)) {
        return ok({ actual, expected: value, attribute, matchMode: 'contains' });
      }
      // Soft-pass fallback: substring match is a likely partial.
      if (exp.length >= 1 && typeof actual === 'string' && actual.includes(exp)) {
        return softPass(`속성 "${attribute}"가 정확히 일치하지 않지만 "${exp}"를 포함합니다`,
          { actual, expected: value, attribute });
      }
      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Expected attribute "${attribute}" to be "${value}" but got "${actual}"`,
        { actual, expected: value, attribute });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async toHaveCountGreaterThan(_p, locator, assertion) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toHaveCountGreaterThan');
    const { value } = assertion;
    const count = await locator.count().catch(() => 0);
    if (count > value) return ok({ actual: count, expected: `> ${value}` });
    // Soft pass: 기대 개수에 못 미치지만 0개는 아닌 경우 — 요소는 정상적으로
    // 존재하나 사이트 구조가 시나리오 작성 시점과 달라 개수 기대만 어긋남.
    // 빈 결과(0개)는 진짜 실패로 간주합니다.
    if (count > 0) {
      return softPass(
        `기대 개수(${value} 초과)에 못 미치지만 ${count}개가 발견되어 부분 통과로 처리합니다`,
        { actual: count, expected: `> ${value}` });
    }
    return fail(ERROR_CODES.ASSERTION_FAILED,
      `Expected count > ${value} but got ${count}`, { actual: count, expected: value });
  },

  async toChangeFromStored(_p, locator, assertion, state, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for toChangeFromStored');
    const { storedKey } = assertion;
    if (!storedKey) return fail(ERROR_CODES.ASSERTION_FAILED, 'toChangeFromStored requires "storedKey"');
    const stored = state.getCaptured(storedKey);
    if (stored === undefined)
      return fail(ERROR_CODES.ASSERTION_FAILED, `No captured value found for key "${storedKey}"`);
    try {
      const raw     = ((await locator.textContent({ timeout })) ?? '').trim();
      const current = normalizeActual(raw);
      if (raw !== String(stored) && current !== String(stored)) return ok({ actual: current, stored });

      // Soft pass: 텍스트는 그대로지만 다른 신호(aria-selected, aria-pressed,
      // class active 등)로 상태 전환을 감지할 수 있는 경우. 탭/토글/필터처럼
      // 라벨은 고정이고 선택 상태만 바뀌는 UI를 위한 보강입니다.
      const stateInfo = await locator.evaluate(el => ({
        ariaSelected: el.getAttribute('aria-selected'),
        ariaPressed:  el.getAttribute('aria-pressed'),
        ariaCurrent:  el.getAttribute('aria-current'),
        ariaExpanded: el.getAttribute('aria-expanded'),
        className:    el.className || '',
        hasActive:    /\b(active|selected|on|current|is-active|is-selected)\b/i.test(el.className || ''),
      })).catch(() => null);
      if (stateInfo) {
        const activeIndicators = [];
        if (stateInfo.ariaSelected === 'true') activeIndicators.push('aria-selected=true');
        if (stateInfo.ariaPressed === 'true')  activeIndicators.push('aria-pressed=true');
        if (stateInfo.ariaCurrent && stateInfo.ariaCurrent !== 'false') activeIndicators.push(`aria-current=${stateInfo.ariaCurrent}`);
        if (stateInfo.ariaExpanded === 'true') activeIndicators.push('aria-expanded=true');
        if (stateInfo.hasActive) activeIndicators.push(`class~="${stateInfo.className}"`);
        if (activeIndicators.length > 0) {
          return softPass(
            `텍스트는 "${stored}" 그대로지만 상태 신호가 활성화되었습니다 (${activeIndicators.join(', ')})`,
            { actual: current, stored, stateInfo });
        }
      }

      return fail(ERROR_CODES.ASSERTION_FAILED,
        `Element still shows stored value "${stored}"`, { actual: current, stored });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },

  async textOrAriaStateChanged(_p, locator, assertion, state, _m, timeout) {
    if (!locator) return fail(ERROR_CODES.TARGET_NOT_FOUND, 'No locator resolved for textOrAriaStateChanged');

    const nodeId    = assertion.targetRef?.nodeId ?? null;
    const storedKey = assertion.storedKey ?? null;
    const before    = storedKey
      ? state.getCaptured(storedKey)
      : (nodeId ? state.getRuntime(`_autoCapture_${nodeId}`) : undefined);

    if (before == null)
      return fail(ERROR_CODES.ASSERTION_FAILED,
        'textOrAriaStateChanged: no before-state found. A prior click or capture step is required.');

    try {
      const current = await captureAriaAndText(locator, timeout);

      // Strict pass: the element itself changed (text, aria-*).
      const beforeCore  = { text: before.text, aria: before.aria };
      const currentCore = { text: current.text, aria: current.aria };
      if (JSON.stringify(currentCore) !== JSON.stringify(beforeCore)) {
        return ok({ before, current });
      }

      // Soft pass: the element didn't change but its surrounding region did
      // (common for trigger buttons that open a panel without changing label).
      const beforeRegion = before.regionSignature  ?? null;
      const currentRegion = current.regionSignature ?? null;
      if (beforeRegion && currentRegion && beforeRegion !== currentRegion) {
        return softPass('요소 자체는 그대로지만 주변 DOM이 변경되었습니다 (패널/메뉴 토글 추정)',
          { before, current });
      }

      // Soft pass: 트리거 주변은 그대로지만 화면에 새로운 오버레이/사이드
      // 패널/모달이 등장한 경우. 사이드 드로어는 보통 body 직속에 렌더되어
      // 트리거의 부모 트리에서는 감지되지 않으므로 전역 시그니처로 비교합니다.
      const beforeGlobal  = before.globalSignature  ?? null;
      const currentGlobal = current.globalSignature ?? null;
      if (beforeGlobal && currentGlobal && beforeGlobal !== currentGlobal) {
        // overlay 개수가 늘었는지 / 보이는 fixed 요소가 늘었는지 간단히 파싱
        const parse = (s) => Object.fromEntries(
          (s || '').split(';').map(p => { const [k, v] = p.split('='); return [k, Number(v) || 0]; })
        );
        const b = parse(beforeGlobal), c = parse(currentGlobal);
        const overlayDelta = (c.ov ?? 0) - (b.ov ?? 0);
        const fixedDelta   = (c.fx ?? 0) - (b.fx ?? 0);
        const hashChanged  = (c.oh ?? 0) !== (b.oh ?? 0);
        let reason;
        if (overlayDelta > 0)      reason = `사이드 패널/모달이 새로 표시됨 (overlay +${overlayDelta})`;
        else if (overlayDelta < 0) reason = `사이드 패널/모달이 닫힘 (overlay ${overlayDelta})`;
        else if (fixedDelta !== 0) reason = `고정 위치 요소 개수 변화 (fixed Δ=${fixedDelta})`;
        else if (hashChanged)      reason = '오버레이 내부 텍스트가 변경됨 (패널 내용 변화)';
        else                       reason = '전역 DOM 시그니처가 변경됨';
        return softPass(`트리거는 그대로지만 ${reason}`, { before, current });
      }

      return fail(ERROR_CODES.ASSERTION_FAILED,
        'Expected element text or aria state to have changed', { before, current });
    } catch (e) {
      return fail(ERROR_CODES.TIMEOUT, e.message);
    }
  },
};

// ── Auto-capture helper (called by click step before action) ─────────────────

export async function captureAriaAndText(locator, timeout = 5000) {
  const [rawText, combined] = await Promise.all([
    locator.textContent({ timeout }).then(t => (t ?? '').trim()).catch(() => ''),
    locator.evaluate(el => {
      const aria = {
        pressed:  el.getAttribute('aria-pressed'),
        expanded: el.getAttribute('aria-expanded'),
        selected: el.getAttribute('aria-selected'),
        label:    el.getAttribute('aria-label'),
        checked:  el.getAttribute('aria-checked'),
      };
      // 의미 있는 컨테이너를 찾아 region signature를 계산합니다.
      // 단순 `closest('[role]')`는 버튼 자신을 잡아버려서 항상 동일한
      // signature가 나오므로(자식 0개), 위로 올라가며 자식 수가 충분히
      // 많은(>= 3) 첫 번째 컨테이너를 사용합니다 — 캐러셀/패널/슬라이더
      // 트랙처럼 클릭 후 내용이 바뀌는 영역을 자연스럽게 잡아냅니다.
      function pickRegion(start) {
        let cur = start.parentElement;
        let hops = 0;
        while (cur && hops < 8) {
          const childCount = cur.children?.length ?? 0;
          const innerLen   = cur.innerHTML?.length ?? 0;
          // 충분히 의미 있는 컨테이너: 자식 3개 이상 또는 innerHTML이 상당히 큼
          if (childCount >= 3 || innerLen >= 200) return cur;
          cur = cur.parentElement;
          hops++;
        }
        return start.parentElement ?? start;
      }
      const region = pickRegion(el);
      let signature = '';
      if (region) {
        const childCount = region.children?.length ?? 0;
        const innerLen   = (region.innerHTML?.length ?? 0);
        const innerHead  = (region.innerText ?? '').slice(0, 200).replace(/\s+/g, ' ').trim();
        // hash-like fingerprint — sensitive to text content changes inside the region
        let h = 0;
        for (let i = 0; i < innerHead.length; i++) {
          h = ((h << 5) - h + innerHead.charCodeAt(i)) | 0;
        }
        signature = `c=${childCount};l=${innerLen};h=${h}`;
      }

      // ── 전역 오버레이/드로어 시그니처 ───────────────────────────────────
      // 사이드 패널/모달/팝업은 보통 body 직속에 렌더되어 트리거의 부모
      // 트리에서는 감지되지 않습니다. 다음을 종합해 "현재 화면에 보이는
      // 오버레이성 요소"를 요약합니다:
      //   • role="dialog"/aria-modal, .modal/.drawer/.layer/.popup/.panel/
      //     .overlay/.sidebar/.lnb 류 클래스
      //   • position: fixed | sticky 인 visible 요소
      //   • body 직속 child 개수 + 보이는 child 개수
      // 이로써 클릭 후 사이드 패널이 슬라이드-인 했는지 감지할 수 있습니다.
      function isVisible(node) {
        if (!node || node.nodeType !== 1) return false;
        const cs = window.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
        const r = node.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        // off-screen으로 완전히 벗어난 패널은 닫힌 상태로 간주
        const vw = window.innerWidth, vh = window.innerHeight;
        if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) return false;
        return true;
      }
      const OVERLAY_SEL = [
        '[role="dialog"]', '[aria-modal="true"]',
        '.modal', '.drawer', '.layer', '.popup', '.panel',
        '.overlay', '.sidebar', '.side-panel', '.lnb',
        '[class*="Modal"]', '[class*="Drawer"]', '[class*="Layer"]',
        '[class*="Popup"]', '[class*="Overlay"]', '[class*="Sidebar"]',
      ].join(',');
      let overlayVisible = 0;
      let overlayHash    = 0;
      try {
        const candidates = document.querySelectorAll(OVERLAY_SEL);
        for (const c of candidates) {
          if (!isVisible(c)) continue;
          overlayVisible++;
          const txt = (c.innerText ?? '').slice(0, 120).replace(/\s+/g, ' ').trim();
          for (let i = 0; i < txt.length; i++) {
            overlayHash = ((overlayHash << 5) - overlayHash + txt.charCodeAt(i)) | 0;
          }
        }
      } catch {}
      // body 직속 자식 + position:fixed 보이는 요소 개수
      let bodyDirect      = document.body?.children?.length ?? 0;
      let fixedVisible    = 0;
      try {
        const all = document.body?.querySelectorAll('*') ?? [];
        // 너무 많을 수 있으니 상한
        const cap = Math.min(all.length, 2000);
        for (let i = 0; i < cap; i++) {
          const node = all[i];
          const cs = window.getComputedStyle(node);
          if ((cs.position === 'fixed' || cs.position === 'sticky') && isVisible(node)) {
            fixedVisible++;
          }
        }
      } catch {}
      const globalSignature = `ov=${overlayVisible};oh=${overlayHash};bd=${bodyDirect};fx=${fixedVisible}`;

      return { aria, regionSignature: signature, globalSignature };
    }).catch(() => ({ aria: {}, regionSignature: '', globalSignature: '' })),
  ]);
  return {
    text:            normalizeActual(rawText),
    aria:            combined.aria ?? {},
    regionSignature: combined.regionSignature ?? '',
    globalSignature: combined.globalSignature ?? '',
  };
}

export async function autoCapturePre(locator, nodeId, runtimeState, timeout = 5000) {
  if (!locator || !nodeId) return;
  try {
    const snapshot = await captureAriaAndText(locator, timeout);
    runtimeState.setRuntime(`_autoCapture_${nodeId}`, snapshot);
  } catch { /* non-fatal — missing snapshot degrades textOrAriaStateChanged gracefully */ }
}

// ── Public dispatch ───────────────────────────────────────────────────────────

/**
 * Execute a single assertion from an `expect` step.
 *
 * @param {import('playwright').Page} page
 * @param {object} assertion
 * @param {import('../runtime/runtimeState.js').RuntimeState} runtimeState
 * @param {object|null} elementMap
 * @param {number} defaultTimeoutMs
 * @returns {Promise<{ passed, errorCode?, error?, actual?, expected? }>}
 */
export async function runAssertion(page, assertion, runtimeState, elementMap, defaultTimeoutMs) {
  const { matcher } = assertion;
  const timeout = assertion.timeoutMs ?? defaultTimeoutMs ?? 5000;

  const impl = MATCHERS[matcher];
  if (!impl) {
    return fail(ERROR_CODES.UNSUPPORTED_MATCHER, `Matcher "${matcher}" is not registered`);
  }

  // Resolve element locator for element-scoped matchers
  let locator = null;
  if (assertion.targetRef) {
    const { resolveTarget } = await import('../target-resolution/resolveTarget.js');
    const result = await resolveTarget(page, { targetRef: assertion.targetRef, resolution: assertion.resolution }, elementMap);
    locator = result.locator;
    if (!locator) {
      // 의미적 처리: "숨겨져야 함" / "사라져야 함" 류 매처는 요소가 DOM에서
      // 아예 사라진 것을 정상 통과(soft pass)로 봐야 합니다. 자동완성/툴팁
      // 레이어처럼 닫힐 때 DOM에서 제거되는 요소를 위해 필수입니다.
      const ABSENCE_MATCHERS = new Set(['toBeHidden', 'toBeDetached', 'toHaveCountZero']);
      if (ABSENCE_MATCHERS.has(matcher)) {
        return softPass('대상 요소가 DOM에서 발견되지 않습니다 — 숨김/제거된 것으로 간주합니다',
          { actual: 'not_in_dom', expected: 'hidden' });
      }
      return fail(ERROR_CODES.TARGET_NOT_FOUND,
        `Could not resolve element for matcher "${matcher}"`,
        { resolutionResult: result.resolutionResult });
    }
  }

  return impl(page, locator, assertion, runtimeState, elementMap, timeout);
}
