/**
 * Observes a urlChanged / urlChangedOptional signal.
 *
 * Registers a waitForURL promise BEFORE the action, then resolves
 * (observed:true/false) after the action completes.
 *
 * @param {import('playwright').Page} page
 * @param {string} urlBefore  – URL captured before the action
 * @param {number} timeout
 * @returns {Promise<{ observed: boolean, actual?: string, reason?: string }>}
 */
export function observeUrlChanged(page, urlBefore, timeout) {
  return page
    .waitForURL(url => url.href !== urlBefore, { timeout })
    .then(() => ({ observed: true, actual: page.url() }))
    .catch(() => ({ observed: false, reason: 'URL이 변경되지 않음 (제한 시간 내)' }));
}
