/**
 * core/phase3/authRuleEngine.js
 *
 * WHERE AUTH RULE MATCHING AND STORAGE-STATE RETRY HAPPEN.
 *
 * Loads a local rule set from config/auth-rules.json and, when a URL appears
 * to be blocked by authentication, attempts to match it against a saved
 * storageState to re-run the reachability check.
 *
 * This module does NOT implement:
 *   - credential collection
 *   - login form automation
 *   - user-facing auth UI
 *
 * If no rule matches, the URL is classified as user_input_required so that a
 * human can provide credentials before the next crawl attempt.
 */

import fs   from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname       = path.dirname(fileURLToPath(import.meta.url));
// config/auth-rules.json is at project-root/config/
const AUTH_RULES_PATH = path.resolve(__dirname, '..', '..', '..', 'config', 'auth-rules.json');

// ── Rule loading ─────────────────────────────────────────────────────────────

/**
 * Read and parse config/auth-rules.json.
 * Returns an empty array if the file is missing or malformed.
 *
 * @returns {Promise<Array>}
 */
export async function loadAuthRules() {
  try {
    const raw = await fs.readFile(AUTH_RULES_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return []; // missing config is not an error — just no rules
  }
}

// ── Rule matching ────────────────────────────────────────────────────────────

/**
 * Find the first auth rule that matches `url`.
 *
 * A rule matches when:
 *   1. The URL's origin is in rule.match.origins AND
 *   2. IF rule.match.loginPathPatterns is non-empty, the URL's pathname
 *      contains at least one of those patterns.
 *
 * @param {string} url
 * @param {Array}  rules
 * @returns {object|null} matching rule, or null
 */
export function matchAuthRule(url, rules) {
  if (!rules || rules.length === 0) return null;

  let u;
  try { u = new URL(url); } catch { return null; }

  for (const rule of rules) {
    const { origins = [], loginPathPatterns = [] } = rule.match || {};

    // Check origin match
    const originMatch = origins.some((o) => {
      try { return new URL(o).origin === u.origin; } catch { return false; }
    });
    if (!originMatch) continue;

    // If no path patterns are specified, the origin match alone is enough
    if (loginPathPatterns.length === 0) return rule;

    // Check whether the URL path contains any of the listed patterns
    const pathMatch = loginPathPatterns.some((p) => u.pathname.includes(p));
    if (pathMatch) return rule;
  }

  return null;
}

// ── Storage-state retry ──────────────────────────────────────────────────────

/**
 * Attempt to reach `url` using the storageState specified in `rule`.
 *
 * Creates a fresh browser context with the saved auth state, navigates to the
 * URL, and checks whether we land on the target page or bounce to a login page.
 *
 * Resulting reachableClass:
 *   reachable_with_auth — auth state granted access
 *   auth_rule_failed    — auth state was present but access was not granted
 *
 * @param {string}  url
 * @param {object}  rule    - matched auth rule
 * @param {import('playwright').Browser} browser
 * @returns {Promise<{reachableClass, reason, finalUrl, status}>}
 */
export async function retryWithStorageState(url, rule, browser) {
  // Validate that a storageStatePath is configured
  if (!rule.storageStatePath) {
    return {
      reachableClass: 'auth_rule_failed',
      reason:         `Rule "${rule.ruleId}" has no storageStatePath configured`,
      finalUrl:       url,
      status:         null,
    };
  }

  // Resolve path relative to project root (same directory as auth-rules.json)
  const resolvedPath = path.resolve(
    path.dirname(AUTH_RULES_PATH),
    '..', // go up from config/ to project-root
    rule.storageStatePath,
  );

  // Check file existence before creating a context
  try {
    await fs.access(resolvedPath);
  } catch {
    return {
      reachableClass: 'auth_rule_failed',
      reason:         `storageState file not found: ${resolvedPath}`,
      finalUrl:       url,
      status:         null,
    };
  }

  let context;
  try {
    context = await browser.newContext({
      storageState:    resolvedPath,
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    let response;
    try {
      response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout:   20_000,
      });
    } catch (navErr) {
      return {
        reachableClass: 'auth_rule_failed',
        reason:         `Navigation failed during auth retry: ${navErr.message}`,
        finalUrl:       url,
        status:         null,
      };
    }

    const finalUrl = page.url();
    const status   = response?.status() ?? null;

    // Heuristic: did we land on a login page instead of the target?
    const isLoginPage = /\/login|\/signin|\/auth/i.test(
      (() => { try { return new URL(finalUrl).pathname; } catch { return finalUrl; } })()
    );

    if (status !== null && status >= 200 && status < 300 && !isLoginPage) {
      return {
        reachableClass: 'reachable_with_auth',
        reason:         `Auth rule "${rule.ruleId}" granted access`,
        finalUrl,
        status,
      };
    }

    return {
      reachableClass: 'auth_rule_failed',
      reason:         `Auth rule "${rule.ruleId}" did not grant access — status ${status}, landed on: ${finalUrl}`,
      finalUrl,
      status,
    };

  } catch (err) {
    return {
      reachableClass: 'auth_rule_failed',
      reason:         `Exception during auth retry: ${err.message}`,
      finalUrl:       url,
      status:         null,
    };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
