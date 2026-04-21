/**
 * Observes a network request matching an optional URL substring filter.
 *
 * Must be registered BEFORE the action that triggers the request.
 *
 * @param {import('playwright').Page} page
 * @param {string|null} urlContains  – optional substring filter
 * @param {number} timeout
 * @returns {Promise<{ observed: boolean, requestUrl?: string, reason?: string }>}
 */
export function observeNetworkRequest(page, urlContains, timeout) {
  const predicate = urlContains
    ? req => req.url().includes(urlContains)
    : () => true;

  return page
    .waitForRequest(predicate, { timeout })
    .then(req => ({ observed: true, requestUrl: req.url() }))
    .catch(() => ({ observed: false, reason: '매칭되는 네트워크 요청이 없음 (제한 시간 내)' }));
}
