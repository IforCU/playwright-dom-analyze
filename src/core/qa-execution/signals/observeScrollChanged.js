/**
 * Polls window.scrollY every 150ms until it changes or the timeout expires.
 *
 * Polling is used rather than a MutationObserver because scroll events
 * do not mutate the DOM — there is no clean event-based hook from page.evaluate.
 *
 * @param {import('playwright').Page} page
 * @param {number} timeout
 * @returns {Promise<{ observed: boolean, scrollY?: number, reason?: string }>}
 */
export async function observeScrollChanged(page, timeout) {
  const scrollYBefore = await page.evaluate(() => window.scrollY).catch(() => 0);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 150));
    const scrollY = await page.evaluate(() => window.scrollY).catch(() => scrollYBefore);
    if (scrollY !== scrollYBefore) {
      return { observed: true, scrollY };
    }
  }

  return { observed: false, reason: '스크롤 위치가 변경되지 않음 (제한 시간 내)' };
}
