/**
 * core/crawl/authFlow.js
 *
 * Generic login-form automation for crawl sessions.
 *
 * CREDENTIAL SAFETY RULES
 * ────────────────────────
 * - Credentials are NEVER logged (only host name and outcome are logged).
 * - Credentials are NEVER written to disk (only the post-login storageState
 *   containing cookies and localStorage is saved).
 * - Credentials are used exclusively inside the Playwright page context to
 *   fill form fields.
 * - The local credentials reference is nulled after use so GC can reclaim it.
 *
 * HEURISTIC NATURE
 * ────────────────
 * This module uses heuristic selector patterns to locate username and password
 * fields.  It will not work on every site — login flows that require CAPTCHA,
 * OTP, device approval, or fully custom JS-rendered forms are out of scope.
 * Failure is always non-fatal: the crawl continues without authentication.
 */

import path from 'path';
import fs   from 'fs/promises';

import { createFreshContext, navigateTo } from '../browser.js';

// ── Field selector heuristics ────────────────────────────────────────────────
// Tried in order; the first visible element wins.

const USERNAME_SELECTORS = [
  'input[type="email"]',
  'input[autocomplete="email"]',
  'input[autocomplete="username"]',
  'input[name="email"]',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="id"]',
  'input[name="loginId"]',
  'input[name="userId"]',
  'input[id*="email" i]',
  'input[id*="user" i]',
];

const PASSWORD_SELECTORS = [
  'input[type="password"]',
];

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("로그인")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("Log in")',
  'button:has-text("Continue")',
  '[role="button"]:has-text("로그인")',
  '[role="button"]:has-text("Login")',
];

// Keywords in page content that suggest a successful login error
const ERROR_KEYWORDS = [
  '비밀번호가 틀렸', 'incorrect password', 'wrong password',
  'invalid credentials', 'login failed', '로그인 실패',
  '아이디 또는 비밀번호', 'invalid username', 'account not found',
  'authentication failed',
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to log in at `loginUrl` using heuristic form detection.
 *
 * The function opens a fresh browser context, navigates to the login URL,
 * finds username/password fields, fills them, submits the form, then checks
 * for success heuristically (URL changed + no obvious error text).
 *
 * On success the session storageState (cookies + localStorage) is saved to
 * `storageStatePath`.  Credentials are never written to any file.
 *
 * @param {import('playwright').Browser} browser
 * @param {string} loginUrl             - URL of the login page
 * @param {{ username: string, password: string }} credentials
 * @param {string} storageStatePath     - Destination path for the session state
 * @returns {Promise<{
 *   success:          boolean,
 *   reason:           string,
 *   storageStatePath: string|null,
 *   authHost:         string|null,
 * }>}
 */
export async function attemptGenericLogin(browser, loginUrl, credentials, storageStatePath) {
  // Validate — do not attempt with incomplete credentials
  if (!credentials?.username || !credentials?.password) {
    return { success: false, reason: 'credentials_incomplete', storageStatePath: null, authHost: null };
  }

  let authHost;
  try { authHost = new URL(loginUrl).hostname; } catch {
    return { success: false, reason: 'invalid_login_url', storageStatePath: null, authHost: null };
  }

  // Log only the host — never the credentials or full URL
  console.log(`[authFlow] attempting generic login on ${authHost} …`);

  let ctx = null;
  try {
    ctx = await createFreshContext(browser);
    const page = await ctx.newPage();

    await navigateTo(page, loginUrl);
    await page.waitForTimeout(600);

    // ── Locate username field ──────────────────────────────────────────────────
    let usernameField = null;
    for (const sel of USERNAME_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && await el.isVisible()) {
          usernameField = el;
          break;
        }
      } catch (_) {}
    }

    if (!usernameField) {
      console.log(`[authFlow] no username field found on ${authHost}`);
      return { success: false, reason: 'no_username_field_found', storageStatePath: null, authHost };
    }

    // ── Locate password field ──────────────────────────────────────────────────
    let passwordField = null;
    for (const sel of PASSWORD_SELECTORS) {
      try {
        const el = page.locator(sel).first();
        if ((await el.count()) > 0 && await el.isVisible()) {
          passwordField = el;
          break;
        }
      } catch (_) {}
    }

    if (!passwordField) {
      console.log(`[authFlow] no password field found on ${authHost}`);
      return { success: false, reason: 'no_password_field_found', storageStatePath: null, authHost };
    }

    // ── Fill fields (values are never echoed in logs) ────────────────────────
    await usernameField.click();
    await usernameField.fill(credentials.username);
    await page.waitForTimeout(150);
    await passwordField.click();
    await passwordField.fill(credentials.password);
    await page.waitForTimeout(150);

    // ── Submit ────────────────────────────────────────────────────────────────
    let submitted = false;
    for (const sel of SUBMIT_SELECTORS) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0 && await btn.isVisible()) {
          await Promise.all([
            page.waitForNavigation({ timeout: 15_000, waitUntil: 'load' }).catch(() => {}),
            btn.click(),
          ]);
          submitted = true;
          break;
        }
      } catch (_) {}
    }

    if (!submitted) {
      // Fallback: submit via Enter key on the password field
      await Promise.all([
        page.waitForNavigation({ timeout: 10_000, waitUntil: 'load' }).catch(() => {}),
        passwordField.press('Enter'),
      ]).catch(() => {});
    }

    await page.waitForTimeout(800);

    // ── Heuristic success check ────────────────────────────────────────────────
    const currentUrl  = page.url();
    const urlChanged  = currentUrl !== loginUrl;
    const bodyText    = await page.textContent('body').catch(() => '');
    const lower       = bodyText.toLowerCase();
    const hasError    = ERROR_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
    const success     = urlChanged && !hasError;

    if (success) {
      // Save session cookies + localStorage — no credentials here
      await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
      await ctx.storageState({ path: storageStatePath });
      console.log(`[authFlow] login succeeded on ${authHost}, session saved`);
      return { success: true, reason: 'login_succeeded', storageStatePath, authHost };
    }

    const reason = hasError ? 'login_form_showed_error' : 'url_unchanged_after_submit';
    console.log(`[authFlow] login heuristic failed on ${authHost}: ${reason}`);
    return { success: false, reason, storageStatePath: null, authHost };

  } catch (err) {
    console.log(`[authFlow] login error on ${authHost}: ${err.message}`);
    return { success: false, reason: `error:${err.message}`, storageStatePath: null, authHost };
  } finally {
    // Null the local reference to help GC — the actual credential strings are
    // held by the caller; this only drops the local binding.
    // eslint-disable-next-line no-param-reassign
    credentials = null;
    if (ctx) await ctx.close().catch(() => {});
  }
}
