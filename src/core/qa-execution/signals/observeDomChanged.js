/**
 * Observes a DOM mutation signal using MutationObserver injected into the page.
 *
 * Must be called BEFORE the action that is expected to trigger the mutation.
 *
 * @param {import('playwright').Page} page
 * @param {number} timeout
 * @returns {Promise<{ observed: boolean, reason?: string }>}
 */
export function observeDomChanged(page, timeout) {
  return page
    .evaluate((ms) => {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          mo.disconnect();
          resolve(false);
        }, ms);
        const mo = new MutationObserver(() => {
          clearTimeout(timer);
          mo.disconnect();
          resolve(true);
        });
        mo.observe(document.body, {
          childList: true, subtree: true, attributes: true, characterData: true,
        });
      });
    }, timeout)
    .then(changed => ({
      observed: changed,
      reason: changed ? undefined : 'DOM 변경이 감지되지 않음 (제한 시간 내)',
    }))
    .catch(() => ({ observed: false, reason: 'DOM 감시 오류가 발생함' }));
}
