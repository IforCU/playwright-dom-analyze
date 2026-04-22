import { safeCount } from './locatorBuilders.js';

/**
 * bbox 좌표(분석 리포트의 x/y/width/height)를 이용해 Playwright Locator를 생성합니다.
 *
 * 1. bbox 중심 좌표(cx, cy)를 계산합니다.
 * 2. 해당 좌표가 뷰포트 밖이면 스크롤 이동 후 document.elementFromPoint()를 호출합니다.
 * 3. 발견된 요소의 고유 XPath를 생성하고 Playwright Locator로 반환합니다.
 *
 * @param {import('playwright').Page} page
 * @param {string} nodeId
 * @param {{ x: number, y: number, width: number, height: number }} bbox
 * @returns {Promise<{ locator, resolutionResult } | null>}
 */
export async function resolveBboxCoordinate(page, nodeId, bbox) {
  if (!bbox || bbox.width == null || bbox.height == null) return null;

  const cx = Math.round(bbox.x + bbox.width / 2);
  const cy = Math.round(bbox.y + bbox.height / 2);

  try {
    const xpath = await page.evaluate(async ([px, py]) => {
      // 뷰포트 기준 좌표 계산
      let vx = px - window.scrollX;
      let vy = py - window.scrollY;

      // 뷰포트 밖이면 해당 위치로 스크롤
      if (vx < 0 || vx > window.innerWidth || vy < 0 || vy > window.innerHeight) {
        window.scrollTo({
          left: Math.max(0, px - window.innerWidth / 2),
          top:  Math.max(0, py - window.innerHeight / 2),
          behavior: 'instant',
        });
        await new Promise(r => setTimeout(r, 80));
        vx = px - window.scrollX;
        vy = py - window.scrollY;
      }

      const el = document.elementFromPoint(vx, vy);
      if (!el || el === document.documentElement || el === document.body) return null;

      // 고유 XPath 생성 — 모든 단계에 인덱스를 포함시켜야 일치 요소가 1개로
      // 보장됩니다. (`/ul/li/a`는 모든 li/a를 매칭하므로 클릭이 strict-mode
      // 타임아웃을 일으킵니다.)
      function buildXPath(element) {
        if (element.id && /^[a-zA-Z][\w-]*$/.test(element.id)) {
          return `//*[@id="${element.id}"]`;
        }
        const parts = [];
        let cur = element;
        while (cur && cur.nodeType === Node.ELEMENT_NODE && cur !== document.documentElement) {
          const tag = cur.tagName.toLowerCase();
          let idx = 1;
          let sib = cur.previousElementSibling;
          while (sib) {
            if (sib.tagName.toLowerCase() === tag) idx++;
            sib = sib.previousElementSibling;
          }
          parts.unshift(`${tag}[${idx}]`);
          cur = cur.parentElement;
        }
        return '/html/' + parts.join('/');
      }

      return buildXPath(el);
    }, [cx, cy]);

    if (!xpath) return null;

    let locator = page.locator(`xpath=${xpath}`);
    let count   = await safeCount(locator);
    if (count === 0) return null;
    // 안전망: 동일 XPath가 여러 요소에 매칭되면 (xpath가 충분히 고유하지 않은
    // 드문 경우) `.first()`로 좁혀서 strict-mode 타임아웃을 방지합니다.
    if (count > 1) {
      locator = locator.first();
    }

    return {
      locator,
      resolutionResult: {
        method:               'bboxCoordinate',
        nodeId,
        locatorKind:          'xpath',
        locatorValue:         xpath,
        wasFallbackUsed:      true,
        resolvedElementCount: count,
        bboxCenter:           { x: cx, y: cy },
      },
    };
  } catch {
    return null;
  }
}
