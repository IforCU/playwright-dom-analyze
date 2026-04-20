/**
 * core/crawl/authBootstrap.js
 *
 * Pre-Crawl Authentication Bootstrap
 * ───────────────────────────────────
 * Runs BEFORE normal BFS analysis begins.
 *
 * Responsibilities:
 *   1. Open the starting URL in a fresh browser context.
 *   2. Stabilize initial rendering (networkidle / timeout fallback).
 *   3. Determine whether the landing page requires authentication.
 *   4. If auth is required AND credentials are available → perform login.
 *   5. On success → save storageState for the current job and return it.
 *   6. Report the outcome so crawlRunner.js can decide whether to proceed.
 *
 * CREDENTIAL SAFETY
 * ─────────────────
 * Credentials are NEVER written to any log line, output file, or graph data.
 * Only the auth host name and the outcome are logged.
 *
 * HEURISTIC NATURE
 * ────────────────
 * Auth-required detection is heuristic.  The signals checked are documented
 * in _isAuthRequired().  False-positives (non-auth pages detected as auth)
 * are possible but rare.  False-negatives (missed login walls) may occur on
 * heavily JS-customised gates.
 */

import path from 'path';
import fsp  from 'fs/promises';

import { createFreshContext, navigateTo } from '../browser.js';
import { attemptLoginOnPage }             from './authFlow.js';

// ── Auth-detection signal weights ────────────────────────────────────────────

/**
 * URL path patterns that strongly suggest a login / auth page.
 * Evaluated against the FINAL page URL after navigation (capturing redirects).
 */
const AUTH_PATH_PATTERNS = [
  /\/login/i,
  /\/signin/i,
  /\/sign-in/i,
  /\/auth(?:\/|$)/i,
  /\/oauth/i,
  /\/sso/i,
  /\/account(?:\/login|\/signin)/i,
  /\/session(?:\/new)?/i,
  /\/users\/sign_in/i,
];

/** Hostname patterns that typically serve only authentication. */
const AUTH_HOST_PATTERNS = [
  /^accounts\./i,
  /^login\./i,
  /^auth\./i,
  /^sso\./i,
  /^id\./i,
  /^passport\./i,
];

/** Page <title> keywords that suggest a login wall. */
const AUTH_TITLE_KEYWORDS = [
  '로그인', '로그인 하기', 'log in', 'login', 'sign in', 'signin',
  'authentication', 'authenticate', '계정 선택', '본인 인증', 'account login',
];

/** Visible body-text phrases that suggest a login page / gate. */
const AUTH_BODY_KEYWORDS = [
  '로그인', '아이디', '비밀번호', '이메일로 로그인', '소셜 로그인',
  'sign in', 'log in', 'login with', 'continue with', 'sign in with',
  'forgot password', '계정이 없으신가요', 'create account',
  '본인 인증', 'otp', 'verification code', '인증번호',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Stabilize a freshly navigated page: wait for networkidle if the page
 * settles quickly, otherwise fall back to a fixed timeout.
 */
async function _stabilize(page, timeoutMs = 8_000) {
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {}),
    new Promise((r) => setTimeout(r, timeoutMs)),
  ]);
  // Small buffer for deferred JS / hydration
  await page.waitForTimeout(500).catch(() => {});
}

/**
 * Heuristic: does the current page require authentication?
 *
 * Returns an object:
 *   { required: boolean, reason: string, loginUrl: string|null }
 *
 * loginUrl is the current page URL when required=true (it is the login
 * surface we should attempt to authenticate on).
 */
async function _isAuthRequired(page, rootHost) {
  const currentUrl = page.url();
  let parsedUrl;
  try { parsedUrl = new URL(currentUrl); } catch {
    return { required: false, reason: 'url_parse_failed', loginUrl: null };
  }

  const currentHost = parsedUrl.hostname;
  const currentPath = parsedUrl.pathname;

  // ── Signal 1: redirected to a dedicated auth host ────────────────────────
  if (currentHost !== rootHost && AUTH_HOST_PATTERNS.some((p) => p.test(currentHost))) {
    return {
      required: true,
      reason:   'redirected_to_auth_host',
      loginUrl: currentUrl,
    };
  }

  // ── Signal 2: URL path matches known login patterns ───────────────────────
  if (AUTH_PATH_PATTERNS.some((p) => p.test(currentPath))) {
    return {
      required: true,
      reason:   'auth_path_pattern',
      loginUrl: currentUrl,
    };
  }

  // ── Signal 3: page title suggests login ───────────────────────────────────
  let title = '';
  try { title = (await page.title()) ?? ''; } catch (_) {}
  const titleLower = title.toLowerCase();
  if (AUTH_TITLE_KEYWORDS.some((kw) => titleLower.includes(kw.toLowerCase()))) {
    return {
      required: true,
      reason:   'auth_title_keyword',
      loginUrl: currentUrl,
    };
  }

  // ── Signal 4: visible body text contains login phrases ────────────────────
  let bodyText = '';
  try { bodyText = (await page.textContent('body', { timeout: 4_000 })) ?? ''; } catch (_) {}
  const bodyLower = bodyText.toLowerCase();

  // Check body keywords AND presence of a password input (stronger signal)
  const bodyHasAuthKeyword = AUTH_BODY_KEYWORDS.some((kw) => bodyLower.includes(kw.toLowerCase()));
  const hasPasswordInput   = await page.locator('input[type="password"]').count().then((n) => n > 0).catch(() => false);

  if (hasPasswordInput) {
    return {
      required: true,
      reason:   'password_input_present',
      loginUrl: currentUrl,
    };
  }

  // Body keyword alone is a weak signal — require email input OR very high keyword density
  // on a page with very few outbound links.
  // Portal homepages (e.g. naver.com, daum.net) have "로그인" in their nav but are NOT
  // login walls — they typically have hundreds of outbound links.
  if (bodyHasAuthKeyword) {
    const hasEmailInput = await page
      .locator('input[type="email"], input[autocomplete="email"], input[name="email"]')
      .count().then((n) => n > 0).catch(() => false);
    if (hasEmailInput) {
      return {
        required: true,
        reason:   'auth_form_detected',
        loginUrl: currentUrl,
      };
    }
    // Only treat as auth wall when keyword density is high AND the page has
    // very few links (login-only pages have minimal navigation).
    const keywordHits = AUTH_BODY_KEYWORDS.filter((kw) => bodyLower.includes(kw.toLowerCase())).length;
    const linkCount   = await page.locator('a[href]').count().catch(() => 999);
    if (keywordHits >= 5 && linkCount < 25) {
      return {
        required: true,
        reason:   'multiple_auth_body_keywords',
        loginUrl: currentUrl,
      };
    }
  }

  // ── Signal 5: blocking login modal / overlay ──────────────────────────────
  // Check for a highly-visible modal that contains a login form
  const blockingModal = await page.evaluate(() => {
    const modals = document.querySelectorAll(
      '[role="dialog"], .modal, .login-modal, .auth-modal, ' +
      '[class*="modal"], [class*="overlay"], [class*="popup"]',
    );
    for (const el of modals) {
      const r = el.getBoundingClientRect();
      // Must cover a significant portion of the viewport and be visible
      if (
        r.width > window.innerWidth * 0.3 &&
        r.height > window.innerHeight * 0.3 &&
        el.checkVisibility?.() !== false
      ) {
        if (el.querySelector('input[type="password"]')) return true;
      }
    }
    return false;
  }).catch(() => false);

  if (blockingModal) {
    return {
      required: true,
      reason:   'blocking_login_modal',
      loginUrl: currentUrl,
    };
  }

  return { required: false, reason: 'no_auth_signals', loginUrl: null };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run the pre-crawl authentication bootstrap.
 *
 * Must be called BEFORE the BFS crawl starts.
 *
 * @param {{
 *   browser:            import('playwright').Browser,
 *   startUrl:           string,           - the initial URL to open (requestUrl ?? originalUrl)
 *   rootHost:           string,           - hostname the BFS is scoped to
 *   credentials:        { username: string, password: string }|null,
 *   authHints?:         {
 *     usernameSelector?:             string,
 *     passwordSelector?:             string,
 *     submitSelector?:               string,
 *     loginUrlPattern?:              string,
 *     postLoginSuccessUrlPattern?:   string,
 *   }|null,
 *   storageStatePath:   string,           - where to save the session file
 * }} params
 *
 * @returns {Promise<{
 *   preAuthRequired:              boolean,
 *   preAuthAttempted:             boolean,
 *   preAuthSucceeded:             boolean,
 *   preAuthFailed:                boolean,
 *   preAuthReason:                string,
 *   preAuthLoginUrl:              string|null,
 *   preAuthAuthHost:              string|null,
 *   authenticatedSessionEstablished: boolean,
 *   storageStateGenerated:        boolean,
 *   storageStatePath:             string|null,
 *   crawlStartedAfterAuth:        boolean,
 *   stopReason:                   string|null,  - set only when crawl should NOT start
 * }>}
 */
export async function runPreAuthBootstrap({
  browser,
  startUrl,
  rootHost,
  credentials,
  authHints = null,
  storageStatePath,
}) {
  const result = {
    preAuthRequired:               false,
    preAuthAttempted:              false,
    preAuthSucceeded:              false,
    preAuthFailed:                 false,
    preAuthReason:                 'not_checked',
    preAuthLoginUrl:               null,
    preAuthAuthHost:               null,
    authenticatedSessionEstablished: false,
    storageStateGenerated:         false,
    storageStatePath:              null,
    crawlStartedAfterAuth:         false,
    stopReason:                    null,
  };

  console.log('\n[authBootstrap] ── Pre-Crawl Auth Bootstrap ────────────────────');
  console.log(`[authBootstrap] startUrl : ${startUrl}`);
  console.log(`[authBootstrap] rootHost : ${rootHost}`);
  console.log(`[authBootstrap] auth     : ${credentials ? 'credentials provided' : 'none'}`);

  let ctx  = null;
  let page = null;

  try {
    ctx  = await createFreshContext(browser);
    page = await ctx.newPage();

    // ── Step 1: Navigate + stabilize ─────────────────────────────────────────
    await navigateTo(page, startUrl);
    await _stabilize(page, 8_000);

    const landingUrl = page.url();
    console.log(`[authBootstrap] landing URL: ${landingUrl}`);

    // ── Step 2: Auth-required detection ──────────────────────────────────────
    const detection = await _isAuthRequired(page, rootHost);
    result.preAuthRequired  = detection.required;
    result.preAuthReason    = detection.reason;
    result.preAuthLoginUrl  = detection.loginUrl;

    if (!detection.required) {
      console.log('[authBootstrap] no auth required — proceeding to BFS');
      result.stopReason = null;
      return result;
    }

    console.log(`[authBootstrap] auth required detected: ${detection.reason}  loginUrl=${detection.loginUrl}`);

    // ── Step 3: No credentials → stop gracefully ─────────────────────────────
    if (!credentials?.username || !credentials?.password) {
      console.log('[authBootstrap] auth required but no credentials provided — stopping');
      result.stopReason = 'auth_required_no_credentials';
      return result;
    }

    // ── Step 4: Resolve actual login page ────────────────────────────────────
    // If the landing page has no login form (e.g. portal homepage detected by
    // keyword signal), try to navigate to a login link before attempting login.
    // This handles sites like Naver where the login form lives on a sub-host
    // (nid.naver.com) reachable via a nav link.
    const hasLoginForm = await _hasLoginForm(page);
    if (!hasLoginForm) {
      console.log('[authBootstrap] no login form on landing page — searching for login link …');
      const loginLink = await _findLoginNavLink(page, authHints?.loginUrlPattern ?? null);
      if (loginLink) {
        console.log(`[authBootstrap] navigating to login link: ${loginLink}`);
        try {
          await page.goto(loginLink, { waitUntil: 'load', timeout: 15_000 });
          await _stabilize(page, 5_000);
          const newUrl = page.url();
          console.log(`[authBootstrap] login page loaded: ${newUrl}`);
          result.preAuthLoginUrl = newUrl;
        } catch (navErr) {
          console.log(`[authBootstrap] login link navigation failed: ${navErr.message}`);
        }
      } else {
        console.log('[authBootstrap] no login link found — login attempt may fail');
      }
    }

    // ── Step 5: Perform login ─────────────────────────────────────────────────
    result.preAuthAttempted = true;

    let authHostForLog;
    try {
      authHostForLog = new URL(page.url()).hostname;
    } catch {
      authHostForLog = 'unknown';
    }
    result.preAuthAuthHost = authHostForLog;
    console.log(`[authBootstrap] attempting login on ${authHostForLog} …`);

    const loginResult = await attemptLoginOnPage(page, credentials, authHints ?? null, storageStatePath);

    if (loginResult.success) {
      result.preAuthSucceeded              = true;
      result.preAuthReason                 = 'pre_auth_bootstrap_succeeded';
      result.authenticatedSessionEstablished = true;
      result.storageStateGenerated         = true;
      result.storageStatePath              = loginResult.storageStatePath;
      result.crawlStartedAfterAuth         = true;
      result.stopReason                    = null;
      console.log(`[authBootstrap] ✓ login succeeded on ${authHostForLog} — session saved`);
      console.log('[authBootstrap] BFS may now proceed with authenticated contexts');
    } else {
      result.preAuthFailed  = true;
      result.preAuthReason  = `pre_auth_bootstrap_failed:${loginResult.reason}`;
      result.stopReason     = 'pre_auth_bootstrap_failed';
      console.log(`[authBootstrap] ✗ login failed on ${authHostForLog}: ${loginResult.reason}`);
    }

    return result;

  } catch (err) {
    console.error(`[authBootstrap] unexpected error: ${err.message}`);
    result.preAuthFailed  = true;
    result.preAuthReason  = `error:${err.message}`;
    // Non-fatal: BFS will proceed unauthenticated
    result.stopReason     = null;
    return result;

  } finally {
    // Always close the bootstrap context — the crawl will open its own contexts
    credentials = null; // drop local ref
    if (ctx) await ctx.close().catch(() => {});
    console.log('[authBootstrap] ──────────────────────────────────────────────\n');
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if the current page has a visible login form
 * (password input OR common username/email input).
 */
async function _hasLoginForm(page) {
  const hasPassword = await page
    .locator('input[type="password"]')
    .count().then((n) => n > 0).catch(() => false);
  if (hasPassword) return true;

  const hasUserField = await page
    .locator(
      'input[type="email"], input[autocomplete="email"], ' +
      'input[autocomplete="username"], input[name="email"], ' +
      'input[name="username"], input[name="id"], input[name="loginId"]',
    )
    .count().then((n) => n > 0).catch(() => false);
  return hasUserField;
}

/**
 * Scan the page for anchor links that point to a likely login page.
 * Returns the first matching href, or null if none found.
 *
 * @param {import('playwright').Page} page
 * @param {string|null} hintPattern  - optional substring from authHints.loginUrlPattern
 */
async function _findLoginNavLink(page, hintPattern) {
  return page.evaluate((hint) => {
    const LOGIN_PATTERNS = [
      /\/login/i, /\/signin/i, /\/sign[-_]in/i,
      /\/auth(?:\/|$)/i, /\/oauth/i, /\/sso/i,
      /\/member.*login/i, /login.*\.do/i,
      // Common Korean auth sub-hosts
      /nid\./i, /accounts\./i, /id\./i, /passport\./i,
    ];

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const candidates = [];

    for (const a of anchors) {
      const href = a.href || '';
      if (!href.startsWith('http')) continue;

      // Prefer hint pattern when provided
      if (hint && href.includes(hint)) return href;

      if (LOGIN_PATTERNS.some((p) => p.test(href))) {
        candidates.push(href);
      }
    }

    // Deduplicate and return first
    return candidates[0] ?? null;
  }, hintPattern).catch(() => null);
}
