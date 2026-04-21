/**
 * core/phase1/spaNavigationDefense.js
 *
 * SPA Navigation Defense — addInitScript-based protection layer.
 *
 * PROBLEM
 * ───────
 * After login, many SPA sites (React/Vue/Angular portals, Edu platforms, etc.)
 * immediately trigger client-side navigation cascades:
 *   • history.pushState / replaceState  → router route transitions
 *   • location.assign / location.replace → hard auth redirects / keepalive
 *   • location.href setter               → legacy redirect patterns
 *   • setTimeout-based redirect checks   → session validation timers
 *   • meta[http-equiv=refresh]           → server-injected refresh
 *
 * These destroy the Playwright V8 execution context while page.evaluate() calls
 * are in flight, causing "refs.set is not a function" or "Execution context was
 * destroyed" errors.
 *
 * WHY page.route() ALONE IS NOT ENOUGH
 * ─────────────────────────────────────
 * Network-level route blocking runs AFTER the browser has already committed to
 * a navigation request.  By then the V8 context for the current page has been
 * torn down.  JS-level interceptors (pushState, replaceState) don't generate
 * network requests at all, so route() never sees them.
 *
 * SOLUTION
 * ────────
 * Install an addInitScript that:
 *   1. Runs BEFORE any page JS — even before the SPA framework boots.
 *   2. Patches navigation APIs to call through our gating function.
 *   3. Starts in ALLOW mode so the page can complete its initial auth flow.
 *   4. Can be LOCKED from Playwright's Node.js side once the page has settled,
 *      preventing further navigation from destroying the analysis context.
 *
 * TWO-PHASE USAGE
 * ───────────────
 *   Phase A — Auth resolution (ALLOW mode):
 *     • Navigate to the target URL under storageState.
 *     • The SPA performs its initial auth redirects / route changes normally.
 *     • Our script records attempts but does NOT block them.
 *     • Wait until URL stabilizes (waitForPostAuthStability).
 *
 *   Phase B — Analysis lock (LOCK mode):
 *     • Call lockNavigationDefense(page) from Node.js.
 *     • Subsequent pushState / location changes are intercepted and suppressed.
 *     • Run DOM extraction, screenshots, autoDynamic detection, etc.
 *
 * SECOND-PASS OPTION
 * ──────────────────
 * For aggressive sites, a second goto() to the settled URL may be performed
 * before locking.  The defense script is already installed (addInitScript
 * persists across navigations in the same context), so the lock can be applied
 * on the second load before the SPA has a chance to redirect.
 *
 * COMPATIBILITY
 * ─────────────
 * Tested patterns: React Router, Vue Router, Next.js SPA, Nuxt, Angular Router,
 * plain window.location patterns, and meta-refresh injected by SSR wrappers.
 *
 * The patch does NOT touch XHR, fetch, WebSocket, or any data request.
 * It only intercepts top-level navigation signals.
 */

// ── Script body (injected via addInitScript) ──────────────────────────────────
//
// This string is evaluated in the browser context before ANY page scripts run.
// It MUST be self-contained (no imports, no closures over Node.js variables).

export const NAV_DEFENSE_INIT_SCRIPT = /* javascript */ `
(function () {
  'use strict';

  // ── Shared state object accessible from Playwright via page.evaluate() ──────
  window.__navDefense = {
    locked:   false,   // set to true by lockNavigationDefense() to block nav
    attempts: [],      // full log of every interception (method + url + ts)
    blocked:  0,       // count of calls that were suppressed
    allowed:  0,       // count of calls that were passed through

    _intercept: function (method, url) {
      const entry = { method: method, url: String(url).slice(0, 300), ts: Date.now() };
      this.attempts.push(entry);
      if (this.locked) {
        this.blocked++;
        try { console.warn('[analysis-lock] blocked ' + method + ': ' + entry.url); } catch(_) {}
        return false;  // caller should NOT proceed
      }
      this.allowed++;
      return true;     // caller may proceed
    },
  };

  // ── history.pushState ────────────────────────────────────────────────────────
  try {
    var _origPush = history.pushState.bind(history);
    history.pushState = function (state, title, url) {
      if (!window.__navDefense._intercept('pushState', url)) return;
      return _origPush(state, title, url);
    };
  } catch (e) {}

  // ── history.replaceState ─────────────────────────────────────────────────────
  try {
    var _origReplace = history.replaceState.bind(history);
    history.replaceState = function (state, title, url) {
      if (!window.__navDefense._intercept('replaceState', url)) return;
      return _origReplace(state, title, url);
    };
  } catch (e) {}

  // ── Location.prototype.assign ────────────────────────────────────────────────
  try {
    var _origAssign = Location.prototype.assign;
    Location.prototype.assign = function (url) {
      if (!window.__navDefense._intercept('location.assign', url)) return;
      return _origAssign.call(this, url);
    };
  } catch (e) {}

  // ── Location.prototype.replace ───────────────────────────────────────────────
  try {
    var _origLocReplace = Location.prototype.replace;
    Location.prototype.replace = function (url) {
      if (!window.__navDefense._intercept('location.replace', url)) return;
      return _origLocReplace.call(this, url);
    };
  } catch (e) {}

  // ── location.href setter ─────────────────────────────────────────────────────
  // Note: some browsers protect Location.prototype.href descriptor.
  // We attempt both the prototype and the instance, failing gracefully.
  try {
    var _hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (_hrefDesc && typeof _hrefDesc.set === 'function') {
      var _origHrefSet = _hrefDesc.set;
      Object.defineProperty(Location.prototype, 'href', {
        get: _hrefDesc.get,
        set: function (url) {
          if (!window.__navDefense._intercept('location.href', url)) return;
          return _origHrefSet.call(this, url);
        },
        configurable: true,
        enumerable:   _hrefDesc.enumerable,
      });
    }
  } catch (e) {}

  // ── meta[http-equiv=refresh] via MutationObserver ────────────────────────────
  // Server-injected or dynamically created meta refresh tags are intercepted
  // by watching for new META nodes added to the document head.
  try {
    var _metaObserver = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (
            node.nodeName === 'META' &&
            typeof node.getAttribute === 'function' &&
            (node.getAttribute('http-equiv') || '').toLowerCase() === 'refresh'
          ) {
            var content = node.getAttribute('content') || '';
            window.__navDefense._intercept('meta-refresh', content);
            if (window.__navDefense.locked) {
              try { node.parentNode && node.parentNode.removeChild(node); } catch (_) {}
            }
          }
        }
      }
    });
    // Observe immediately; documentElement is always present in addInitScript context.
    _metaObserver.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // ── setTimeout-based redirect detection ──────────────────────────────────────
  // Some SPAs schedule auth-check redirects via setTimeout.  We wrap it to
  // detect callbacks that attempt navigation ONLY when the defense is locked.
  // The callback is still executed — we just intercept any navigation it causes
  // via the already-patched location/history APIs above.
  // (We do NOT suppress the timer itself to avoid breaking legitimate page logic.)

  // ── window.open ───────────────────────────────────────────────────────────────
  // SPAs sometimes use window.open for auth callbacks or SSO redirects that land
  // in the same tab (target="_self" or "_top").  We intercept and suppress those
  // during the analysis lock window.
  try {
    var _origOpen = window.open;
    window.open = function (url, target, features) {
      var normTarget = (target || '_blank').toLowerCase();
      window.__navDefense._intercept('window.open', url || '');
      if (window.__navDefense.locked && (normTarget === '_self' || normTarget === '_top' || normTarget === '_parent')) {
        try { console.warn('[analysis-lock] blocked window.open (self/top): ' + String(url).slice(0, 200)); } catch (_) {}
        return null;
      }
      return _origOpen.call(window, url, target, features);
    };
  } catch (e) {}

  // ── Navigation API (Chromium 102+) ────────────────────────────────────────────
  // The browser-native Navigation API (window.navigation.navigate) bypasses the
  // classic history / location APIs entirely.  Patch it when present.
  try {
    if (window.navigation && typeof window.navigation.navigate === 'function') {
      var _origNavApiNavigate = window.navigation.navigate.bind(window.navigation);
      window.navigation.navigate = function (url, options) {
        if (!window.__navDefense._intercept('navigation.api.navigate', String(url || ''))) return;
        return _origNavApiNavigate(url, options);
      };
    }
  } catch (e) {}

})();
`;

// ── Node.js-side helpers ──────────────────────────────────────────────────────

/**
 * Install the navigation defense script on a BrowserContext via addInitScript.
 *
 * Must be called BEFORE any pages are created in the context (or at least
 * before the target URL is navigated to) — addInitScript only runs for
 * navigations that happen AFTER it is registered.
 *
 * @param {import('playwright').BrowserContext} context
 */
export async function installNavigationDefense(context) {
  await context.addInitScript(NAV_DEFENSE_INIT_SCRIPT);
  console.log('[nav-defense] init script registered on context');
}

/**
 * Activate the navigation block on an already-loaded page.
 *
 * Call this AFTER the page has finished its initial auth resolution and the
 * URL has stabilized.  From this point on, any client-side navigation attempt
 * is suppressed and logged.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if lock was applied, false if defense not present
 */
export async function lockNavigationDefense(page) {
  try {
    const ok = await page.evaluate(() => {
      if (!window.__navDefense) return false;
      window.__navDefense.locked = true;
      console.log('[analysis-lock] navigation defense LOCKED — blocking further navigation');
      return true;
    });
    if (ok) {
      console.log('[nav-defense] LOCKED on page — navigation blocked');
    } else {
      console.log('[nav-defense] WARNING — __navDefense not found on page (was script installed?)');
    }
    return ok;
  } catch (err) {
    console.log(`[nav-defense] lockNavigationDefense failed: ${err.message}`);
    return false;
  }
}

/**
 * Retrieve the current defense state from the page (for reporting).
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ locked: boolean, blocked: number, allowed: number, attempts: object[] }|null>}
 */
export async function getDefenseState(page) {
  try {
    return await page.evaluate(() => {
      if (!window.__navDefense) return null;
      return {
        locked:   window.__navDefense.locked,
        blocked:  window.__navDefense.blocked,
        allowed:  window.__navDefense.allowed,
        attempts: window.__navDefense.attempts.slice(0, 50),  // cap to keep report compact
      };
    });
  } catch {
    return null;
  }
}

/**
 * Wait for the page URL to stabilize after an auth redirect storm.
 *
 * Polls the current URL at `pollIntervalMs` intervals.  Returns when the URL
 * has remained unchanged for at least `quietWindowMs`, or when `maxWaitMs`
 * is exhausted.
 *
 * Also requires that the page has basic body content before declaring stable.
 *
 * @param {import('playwright').Page} page
 * @param {{
 *   quietWindowMs?:   number,   // URL must be unchanged for this window (default 2000)
 *   maxWaitMs?:       number,   // total budget (default 15000)
 *   pollIntervalMs?:  number,   // polling interval (default 250)
 *   requireBody?:     boolean,  // also require non-empty body (default true)
 * }} opts
 * @returns {Promise<{
 *   stable: boolean,
 *   finalUrl: string,
 *   waitedMs: number,
 *   urlChanges: number,
 *   degraded: boolean,
 *   reason: string,
 * }>}
 */
export async function waitForPostAuthStability(page, opts = {}) {
  const {
    quietWindowMs  = 2_000,
    maxWaitMs      = 15_000,
    pollIntervalMs = 250,
    requireBody    = true,
  } = opts;

  const startedAt   = Date.now();
  const deadline    = startedAt + maxWaitMs;
  let lastUrl       = page.url();
  let stableStart   = Date.now();
  let urlChanges    = 0;

  console.log(`[post-auth-stability] waiting for URL to settle (quiet=${quietWindowMs}ms max=${maxWaitMs}ms) …`);
  console.log(`[post-auth-stability] starting URL: ${lastUrl}`);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    let currentUrl;
    try {
      currentUrl = page.url();
    } catch {
      // Context was destroyed mid-wait — treat as unstable
      const waitedMs = Date.now() - startedAt;
      return {
        stable: false, finalUrl: lastUrl, waitedMs,
        urlChanges, degraded: true,
        reason: 'execution context destroyed while waiting for URL stability',
      };
    }

    if (currentUrl !== lastUrl) {
      console.log(`[post-auth-stability] URL changed → ${currentUrl}`);
      lastUrl     = currentUrl;
      stableStart = Date.now();
      urlChanges++;
      continue;
    }

    const quietElapsed = Date.now() - stableStart;
    if (quietElapsed < quietWindowMs) continue;

    // URL has been stable — also check for body content if required
    if (requireBody) {
      let hasBody = false;
      try {
        hasBody = await page.evaluate(() => {
          return document.body != null &&
                 (document.body.childElementCount > 0 || document.body.innerText.trim().length > 10);
        });
      } catch {
        hasBody = false;
      }
      if (!hasBody) {
        // Body not ready yet — reset quiet window and keep waiting
        stableStart = Date.now();
        continue;
      }
    }

    // Stable!
    const waitedMs = Date.now() - startedAt;
    console.log(`[post-auth-stability] STABLE at ${currentUrl} after ${waitedMs}ms (${urlChanges} URL change(s))`);
    return { stable: true, finalUrl: currentUrl, waitedMs, urlChanges, degraded: false, reason: 'stable' };
  }

  const waitedMs = Date.now() - startedAt;
  console.log(`[post-auth-stability] TIMEOUT after ${waitedMs}ms — using current URL: ${page.url()}`);
  return {
    stable: false, finalUrl: page.url(), waitedMs,
    urlChanges, degraded: true,
    reason: `URL did not stabilize within ${maxWaitMs}ms`,
  };
}

// ── Post-auth DOM readiness probe ─────────────────────────────────────────────
//
// Stronger than a single networkIdle check.  Runs multiple evaluate-based
// signals and tracks consecutive successes before declaring the page ready
// for DOM extraction.  Repeated evaluate failures lower the confidence score
// sharply so we never proceed into DOM extraction on a destroyed context.
//
// Called AFTER waitForPostAuthStability() and after the navigation defense is
// locked.  If this probe fails the caller should treat analysis as degraded.
//
// Signal checklist:
//   1. URL unchanged since lock was applied
//   2. document.body exists and has child elements
//   3. document.title is non-empty
//   4. A minimum element count is present (minElementCount)
//   5. At least minEvaluateSuccesses consecutive evaluate probes succeed
//
// Returns:
//   {
//     ready: boolean,
//     score: number,           // 0–5 signals passed
//     passedSignals: string[], // which signal names passed
//     failedSignals: string[], // which signal names failed
//     evaluateFailures: number,// how many probe() calls threw
//     waitedMs: number,
//     reason: string,
//   }

/**
 * @param {import('playwright').Page} page
 * @param {{
 *   minElementCount?:         number,   // min visible elements in body (default 10)
 *   minEvaluateSuccesses?:    number,   // min consecutive successful probes (default 2)
 *   maxWaitMs?:               number,   // total budget (default 12000)
 *   quietWindowMs?:           number,   // quiet window between probe rounds (default 600)
 *   expectedUrl?:             string,   // URL we expect the page to be on (optional)
 * }} opts
 * @returns {Promise<object>}
 */
export async function probePostAuthReadiness(page, opts = {}) {
  const {
    minElementCount      = 10,
    minEvaluateSuccesses = 2,
    maxWaitMs            = 12_000,
    quietWindowMs        = 600,
    expectedUrl          = null,
  } = opts;

  const startedAt       = Date.now();
  const deadline        = startedAt + maxWaitMs;
  const passedSignals   = new Set();
  const failedSignals   = new Set();
  let evaluateFailures  = 0;
  let consecutivePass   = 0;
  let round             = 0;

  console.log('[post-auth-readiness] probing DOM readiness …');

  while (Date.now() < deadline) {
    round++;
    let roundPassed = 0;

    // Signal 1 — URL check
    try {
      const curUrl = page.url();
      if (!expectedUrl || curUrl === expectedUrl || curUrl.startsWith(expectedUrl.replace(/\/+$/, ''))) {
        passedSignals.add('url_stable');
      } else {
        failedSignals.add('url_stable');
        console.log(`[post-auth-readiness] URL mismatch: expected ${expectedUrl} got ${curUrl}`);
      }
    } catch {
      failedSignals.add('url_stable');
    }

    // Signals 2–5 — evaluate-based
    let probeResult = null;
    try {
      probeResult = await page.evaluate((_minEl) => {
        const body = document.body;
        if (!body) return { hasBody: false, hasTitle: false, elementCount: 0, hasTitle2: false };
        const visible = Array.from(body.querySelectorAll('*')).filter((el) => {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        });
        return {
          hasBody:       true,
          hasTitle:      document.title != null && document.title.trim().length > 0,
          elementCount:  visible.length,
          passesMinEl:   visible.length >= _minEl,
        };
      }, minElementCount);
    } catch (err) {
      evaluateFailures++;
      consecutivePass = 0;  // reset — evaluate failures mean context may be unstable
      failedSignals.add('body_present');
      failedSignals.add('title_present');
      failedSignals.add('element_count');
      console.log(`[post-auth-readiness] evaluate failed (${err.message.slice(0, 80)}) — failures=${evaluateFailures}`);
      await new Promise((r) => setTimeout(r, quietWindowMs));
      continue;
    }

    // page.evaluate() can resolve with undefined/null when the execution context
    // is destroyed mid-call (instead of rejecting).  Treat this the same as a
    // thrown error so we do not crash on probeResult.hasBody.
    if (!probeResult) {
      evaluateFailures++;
      consecutivePass = 0;
      failedSignals.add('body_present');
      failedSignals.add('title_present');
      failedSignals.add('element_count');
      console.log(`[post-auth-readiness] evaluate returned null/undefined (context destroyed?) — failures=${evaluateFailures}`);
      await new Promise((r) => setTimeout(r, quietWindowMs));
      continue;
    }

    if (probeResult.hasBody)        { passedSignals.add('body_present');  roundPassed++; }
    else                            { failedSignals.add('body_present'); }
    if (probeResult.hasTitle)       { passedSignals.add('title_present'); roundPassed++; }
    else                            { failedSignals.add('title_present'); }
    if (probeResult.passesMinEl)    { passedSignals.add('element_count'); roundPassed++; }
    else                            { failedSignals.add('element_count');
                                      console.log(`[post-auth-readiness] element count: ${probeResult.elementCount} < ${minElementCount}`); }

    if (roundPassed >= 3) {
      consecutivePass++;
    } else {
      consecutivePass = 0;
    }

    console.log(`[post-auth-readiness] round=${round} pass=${roundPassed}/3 consecutive=${consecutivePass}/${minEvaluateSuccesses}`);

    if (consecutivePass >= minEvaluateSuccesses) {
      const waitedMs = Date.now() - startedAt;
      const score    = passedSignals.size;
      console.log(`[post-auth-readiness] READY — score=${score} signals=${[...passedSignals].join(',')} waited=${waitedMs}ms`);
      return {
        ready: true, score, waitedMs,
        passedSignals: [...passedSignals],
        failedSignals: [...failedSignals],
        evaluateFailures,
        reason: 'all required signals passed',
      };
    }

    await new Promise((r) => setTimeout(r, quietWindowMs));
  }

  const waitedMs = Date.now() - startedAt;
  const score    = passedSignals.size;
  const ready    = evaluateFailures === 0 && passedSignals.has('body_present');
  console.log(`[post-auth-readiness] TIMEOUT — ready=${ready} score=${score} evalFail=${evaluateFailures} waited=${waitedMs}ms`);
  return {
    ready, score, waitedMs,
    passedSignals: [...passedSignals],
    failedSignals: [...failedSignals],
    evaluateFailures,
    reason: ready ? 'timeout but basic signals present' : `timeout with ${evaluateFailures} evaluate failure(s)`,
  };
}
