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

      // 고유 XPath 생성
      function buildXPath(element) {
        if (element.id && /^[a-zA-Z]/.test(element.id)) {
          return `//*[@id="${element.id}"]`;
        }
        const parts = [];
        let cur = element;
        while (cur && cur.nodeType === Node.ELEMENT_NODE) {
          const tag = cur.tagName.toLowerCase();
          let idx = 1;
          let sib = cur.previousElementSibling;
          while (sib) {
            if (sib.tagName.toLowerCase() === tag) idx++;
            sib = sib.previousElementSibling;
          }
          parts.unshift(idx > 1 ? `${tag}[${idx}]` : tag);
          cur = cur.parentElement;
        }
        return '/' + parts.join('/');
      }

      return buildXPath(el);
    }, [cx, cy]);

    if (!xpath) return null;

    const locator = page.locator(`xpath=${xpath}`);
    const count   = await safeCount(locator);
    if (count === 0) return null;

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
