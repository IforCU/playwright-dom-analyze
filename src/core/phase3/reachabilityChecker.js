/**
 * core/phase3/reachabilityChecker.js
 *
 * WHERE REACHABILITY PRE-FLIGHT HAPPENS.
 *
 * Sends a lightweight HTTP HEAD request (falling back to GET) for each
 * candidate URL using Playwright's APIRequestContext.
 *
 * Classification is HEURISTIC — it is based on HTTP status codes and URL
 * patterns, not authoritative knowledge. All results should be treated as
 * estimates and labelled accordingly in consumer code.
 *
 * Heuristic classification table:
 *   reachable_now          — 2xx with no suspicious redirect
 *   redirect_but_reachable — 2xx after redirect to a non-auth URL
 *   auth_required          — HTTP 401, or redirect whose final URL matches
 *                            a known login path pattern
 *   blocked_or_unknown     — 403, 404, 5xx, repeated loop, timeout, or
 *                            network failure
 */

// Login-like path patterns used to heuristically detect auth redirects
const LOGIN_PATTERNS = [/\/login/i, /\/signin/i, /\/auth\b/i, /\/oauth/i, /\/sso\b/i];

/**
 * Run a single pre-flight check for `url` using an existing APIRequestContext.
 * The caller is responsible for creating and disposing the context.
 *
 * @param {string}              url
 * @param {import('playwright').APIRequestContext} apiCtx
 * @returns {Promise<PreflightResult>}
 */
export async function checkReachability(url, apiCtx) {
  let response;
  let usedMethod = 'HEAD';

  try {
    response = await apiCtx.fetch(url, {
      method:           'HEAD',
      failOnStatusCode: false,
      timeout:          10_000,
    });

    // Some servers reject HEAD with 405; fall back to GET in that case
    if (response.status() === 405) {
      usedMethod = 'GET';
      response   = await apiCtx.fetch(url, {
        method:           'GET',
        failOnStatusCode: false,
        timeout:          15_000,
      });
    }
  } catch {
    // HEAD network error — try GETusedMethod = 'GET';
    usedMethod = 'GET';
    try {
      response = await apiCtx.fetch(url, {
        method:           'GET',
        failOnStatusCode: false,
        timeout:          15_000,
      });
    } catch (err) {
      return {
        requestedUrl:   url,
        finalUrl:       url,
        status:         null,
        contentType:    null,
        reachable:      false,
        // Heuristic classification
        reachableClass: 'blocked_or_unknown',
        reason:         `Network error: ${err.message}`,
      };
    }
  }

  const status      = response.status();
  const finalUrl    = response.url();
  const contentType = response.headers()['content-type'] || null;

  // Heuristic: detect redirect
  let wasRedirected = false;
  try {
    wasRedirected = new URL(finalUrl).href !== new URL(url).href;
  } catch { /* ignore comparison failure */ }

  // Heuristic: detect login-page redirect
  const isLoginRedirect = wasRedirected && LOGIN_PATTERNS.some((p) => {
    try { return p.test(new URL(finalUrl).pathname); } catch { return false; }
  });

  // Heuristic status → class mapping
  let reachableClass;
  let reachable = false;

  if (status >= 200 && status < 300) {
    if (isLoginRedirect) {
      reachableClass = 'auth_required';       // 2xx but landed on login page
    } else if (wasRedirected) {
      reachableClass = 'redirect_but_reachable';
      reachable      = true;
    } else {
      reachableClass = 'reachable_now';
      reachable      = true;
    }
  } else if (status === 401) {
    reachableClass = 'auth_required';
  } else {
    // 403, 404, 5xx, 3xx that wasn't followed…
    reachableClass = 'blocked_or_unknown';
  }

  const redirectNote = wasRedirected ? ` → ${finalUrl}` : '';

  return {
    requestedUrl: url,
    finalUrl,
    status,
    contentType,
    reachable,
    // Heuristic classification — not authoritative
    reachableClass,
    reason: `${usedMethod} ${status}${redirectNote}`,
  };
}
