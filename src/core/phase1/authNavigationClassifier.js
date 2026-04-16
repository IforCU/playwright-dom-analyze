/**
 * core/phase1/authNavigationClassifier.js
 *
 * Generic authentication-gateway detection for trigger-driven navigations.
 *
 * DESIGN
 * ──────
 * When a trigger click causes navigation away from the analyzed page, we want
 * to distinguish between:
 *   - normal in-scope content navigation
 *   - authentication-gated navigation (same host or external auth provider)
 *   - true out-of-scope navigation
 *
 * This module implements a GENERIC heuristic classifier.
 * It does not use site-specific allow-lists or domain hard-codes.
 * Classification is based purely on URL shape, page title, visible text, and
 * form structure signals.
 *
 * NAVIGATION STATUS VOCABULARY
 * ─────────────────────────────
 *   navigated_to_in_scope_page      same host, destination is not auth-like
 *   navigated_to_login_same_host    same host, destination strongly matches auth heuristics
 *   navigated_to_login_auth_host    different host, strongly matches auth heuristics
 *   navigated_out_of_scope          different host, does not look like authentication
 *   navigated_to_unknown            navigation happened but insufficient evidence to classify
 *
 * SCORING
 * ───────
 * score >= AUTH_SCORE_THRESHOLD (default 5) → auth-likely  → high confidence
 * score 3–4                                 → maybe-auth   → medium confidence
 * score < 3                                 → not-auth     → low confidence
 *
 * For same-host destinations even a medium score (3–4) is treated as login.
 * For cross-host destinations, only high score (>= 5) → auth_host; medium → unknown.
 */

// ── Default keyword tables (exported for testing and custom overrides) ────────

export const DEFAULT_AUTH_PATH_KEYWORDS = [
  // English path segments
  'login', 'signin', 'sign-in', 'auth', 'oauth', 'sso',
  'account', 'accounts', 'member', 'identity', 'verify',
  'consent', 'session', 'idp',
  // Korean transliteration commonly used as path slugs
  'nidlogin',
];

export const DEFAULT_AUTH_QUERY_KEYS = [
  // Return/redirect hints — strong signal that this is an auth intercept
  'returnUrl', 'return_url', 'redirect', 'redirectUrl',
  'redirect_uri', 'continue', 'next',
  // OAuth / OIDC parameters — near-definitive auth signals
  'state', 'client_id', 'response_type', 'scope',
  'code_challenge', 'code_challenge_method', 'prompt',
  'nonce', 'login_hint',
];

export const DEFAULT_AUTH_TITLE_KEYWORDS = [
  'login', 'sign in', 'sign-in', 'log in', 'log-in',
  'account', 'verify', 'verification',
  'authentication', 'authorization',
  'continue with', 'choose an account', 'select an account',
  '2-step', '2fa', 'otp', 'one-time', 'passkey',
  'identity', 'credential',
];

export const DEFAULT_AUTH_TEXT_KEYWORDS = [
  // Korean
  '로그인', '본인 인증', '인증 코드', '비밀번호', '이메일', '휴대폰 번호',
  '2단계 인증', '일회용 코드', '계정 선택', '아이디', '패스워드',
  // English
  'sign in', 'log in', 'login', 'forgot password', 'forgot your password',
  'continue with google', 'continue with apple', 'continue with kakao',
  'continue with naver', 'choose account', 'select account',
  'authorization', 'consent', 'enter your password',
  'enter your email', 'enter your username',
];

// ── Scoring weights ────────────────────────────────────────────────────────────
// Kept in a named object so they are easy to inspect or override in tests.

const WEIGHTS = {
  authPathKeyword:   3,  // URL pathname contains a well-known auth segment
  authQueryParam:    2,  // URL has OAuth/redirect query params
  authTitleHint:     2,  // page title contains an auth-related phrase
  authTextHint:      2,  // visible page text contains auth-related phrases
  formCredentials:   3,  // page has password / email / OTP / username inputs
  socialLoginButton: 2,  // page has a detected social login button
  crossHostRedirect: 1,  // final host is different from rootHost (additive bias)
};

const DEFAULT_SCORE_THRESHOLD = 5;  // >= 5 → auth-likely
const DEFAULT_MAYBE_THRESHOLD = 3;  // 3–4  → maybe-auth (inconclusive)

// ── Auth-sensitive trigger text hints ─────────────────────────────────────────
// Used by triggerDiscovery.js to tag candidates before execution.
// Tags only — candidates are NOT excluded based on this list.

export const AUTH_SENSITIVE_TEXT_HINTS = [
  // Korean
  '로그인', '마이페이지', '주문조회', '장바구니', '구매', '결제', '찜', '회원',
  // English
  'sign in', 'log in', 'login', 'account', 'my page', 'member',
  'cart', 'checkout', 'profile', 'settings', 'wallet', 'favorite',
];

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Classify a trigger-driven page navigation using generic auth heuristics.
 *
 * All parameters except `finalUrl` and `rootHost` are optional.
 * When called with only URL information (no page inspection), the classifier
 * still produces a useful signal from path keywords and query params alone.
 *
 * @param {object}  params
 * @param {string}  params.finalUrl       - URL the browser ended up at after the trigger
 * @param {string}  params.rootHost       - Hostname that defines in-scope content scope
 * @param {string}  [params.pageTitle]    - document.title of the final page
 * @param {string}  [params.visibleText]  - Lowercased visible body text (up to ~600 chars)
 * @param {object}  [params.forms]        - Form structure flags (see collectNavPageMeta)
 * @param {boolean} [params.isCrossHost]  - true when final host !== rootHost (pre-computed)
 * @param {object}  [params.opts]         - Config overrides (authScoreThreshold etc.)
 *
 * @returns {{
 *   navigationStatus:    string,
 *   navigatedToHost:     string,
 *   navigatedToPath:     string,
 *   authDetected:        boolean,
 *   requiresAuth:        boolean,
 *   authScore:           number,
 *   authConfidence:      'high'|'medium'|'low',
 *   authSignals:         string[],
 *   navigationReason:    string,
 *   classificationSource: string[],
 * }}
 */
export function classifyAuthNavigation({
  finalUrl,
  rootHost,
  pageTitle   = '',
  visibleText = '',
  forms       = {},
  isCrossHost = false,
  opts        = {},
}) {
  const authPathKeywords  = opts.authPathKeywords  ?? DEFAULT_AUTH_PATH_KEYWORDS;
  const authQueryKeys     = opts.authQueryKeys     ?? DEFAULT_AUTH_QUERY_KEYS;
  const authTitleKeywords = opts.authTitleKeywords ?? DEFAULT_AUTH_TITLE_KEYWORDS;
  const authTextKeywords  = opts.authTextKeywords  ?? DEFAULT_AUTH_TEXT_KEYWORDS;
  const scoreThreshold    = opts.authScoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const maybeThreshold    = opts.authMaybeThreshold ?? DEFAULT_MAYBE_THRESHOLD;

  // Parse the final URL — return unknown if it fails
  let parsed;
  try {
    parsed = new URL(finalUrl);
  } catch {
    return _unknownResult(finalUrl, 'Could not parse final URL after navigation');
  }

  const finalHost = parsed.hostname;
  const pathLower = parsed.pathname.toLowerCase();

  let score = 0;
  const signals              = [];
  const classificationSource = [];

  // ── Signal 1: URL path keyword ──────────────────────────────────────────────
  // Matches common auth path segments. Break after first match to avoid
  // inflating the score when multiple keywords appear in the same path.
  for (const kw of authPathKeywords) {
    if (pathLower.includes(kw)) {
      score += WEIGHTS.authPathKeyword;
      signals.push(`path_keyword:${kw}`);
      classificationSource.push('auth_path_heuristic');
      break;
    }
  }

  // ── Signal 2: Query-string OAuth/redirect parameters ───────────────────────
  const params           = parsed.searchParams;
  const matchedQueryKeys = authQueryKeys.filter((k) => params.has(k));
  if (matchedQueryKeys.length > 0) {
    score += WEIGHTS.authQueryParam;
    matchedQueryKeys.slice(0, 3).forEach((k) => signals.push(`query_param:${k}`));
    classificationSource.push('auth_query_heuristic');
  }

  // ── Signal 3: Page title hints ──────────────────────────────────────────────
  const titleLower = pageTitle.toLowerCase();
  if (titleLower) {
    for (const kw of authTitleKeywords) {
      if (titleLower.includes(kw)) {
        score += WEIGHTS.authTitleHint;
        signals.push(`title_hint:${kw}`);
        classificationSource.push('auth_title_heuristic');
        break; // one title match is enough
      }
    }
  }

  // ── Signal 4: Visible page text hints ──────────────────────────────────────
  const textLower = visibleText.toLowerCase();
  if (textLower) {
    let textMatchCount = 0;
    for (const kw of authTextKeywords) {
      if (textLower.includes(kw.toLowerCase())) {
        signals.push(`text_hint:${kw}`);
        textMatchCount++;
        if (textMatchCount >= 2) break; // cap to avoid inflating the score
      }
    }
    if (textMatchCount > 0) {
      score += WEIGHTS.authTextHint;
      classificationSource.push('auth_text_heuristic');
    }
  }

  // ── Signal 5: Form credential inputs ───────────────────────────────────────
  const hasCredentials = !!(
    forms.hasPasswordInput || forms.hasEmailInput ||
    forms.hasOtpInput      || forms.hasUsernameInput ||
    forms.hasTelInput
  );
  if (hasCredentials) {
    score += WEIGHTS.formCredentials;
    if (forms.hasPasswordInput)  signals.push('form_password_input');
    if (forms.hasEmailInput)     signals.push('form_email_input');
    if (forms.hasOtpInput)       signals.push('form_otp_input');
    if (forms.hasUsernameInput)  signals.push('form_username_input');
    if (forms.hasTelInput)       signals.push('form_tel_input');
    classificationSource.push('auth_form_heuristic');
  }

  // ── Signal 6: Social login buttons ─────────────────────────────────────────
  if (forms.hasSocialLoginBtn) {
    score += WEIGHTS.socialLoginButton;
    signals.push('social_login_button');
    classificationSource.push('auth_social_heuristic');
  }

  // ── Signal 7: Cross-host redirect ──────────────────────────────────────────
  // Adds a small bias when the trigger led to a different hostname.
  // Not decisive alone, but shifts borderline same-host pages toward unknown.
  if (isCrossHost) {
    score += WEIGHTS.crossHostRedirect;
    signals.push('cross_host_redirect');
    classificationSource.push('cross_host_redirect');
  }

  // ── Confidence labelling ────────────────────────────────────────────────────
  const authLikely  = score >= scoreThreshold;
  const authMaybe   = !authLikely && score >= maybeThreshold;
  const authConfidence = authLikely ? 'high' : (authMaybe ? 'medium' : 'low');

  // ── Navigation status classification ───────────────────────────────────────
  const isSameHost = finalHost === rootHost;

  let navigationStatus;
  let navigationReason;

  if (isSameHost) {
    if (authLikely || authMaybe) {
      // Same host login page — even medium auth confidence qualifies.
      // A same-host login page should not be explored as normal content.
      navigationStatus = 'navigated_to_login_same_host';
      navigationReason = 'trigger led to same-host login page';
    } else {
      // Standard in-scope page navigation — no auth signals.
      navigationStatus = 'navigated_to_in_scope_page';
      navigationReason = 'trigger led to another in-scope page';
    }
  } else {
    if (authLikely) {
      // Strong auth signals + different host → auth provider / IdP
      navigationStatus = 'navigated_to_login_auth_host';
      navigationReason = 'trigger led to likely auth provider on another host';
    } else if (authMaybe) {
      // Medium signals + different host → not enough evidence to call it auth
      navigationStatus = 'navigated_to_unknown';
      navigationReason =
        'trigger navigated outside content scope — insufficient evidence to classify as authentication';
    } else {
      // No meaningful auth signals + different host → plain out-of-scope
      navigationStatus = 'navigated_out_of_scope';
      navigationReason =
        'trigger led outside content scope and did not look like authentication';
    }
  }

  return {
    navigationStatus,
    navigatedToHost:     finalHost,
    navigatedToPath:     parsed.pathname,
    authDetected:        authLikely,
    requiresAuth:        authLikely || (authMaybe && isCrossHost),
    authScore:           score,
    authConfidence,
    authSignals:         signals,
    navigationReason,
    classificationSource: [...new Set(classificationSource)],
  };
}

/**
 * Collect lightweight navigation metadata from a Playwright Page that has just
 * navigated to a new URL following a trigger action.
 *
 * Called inside the trigger runner's fast-exit path. Intentionally minimal:
 * captures only what the auth classifier needs (title, ~600 chars of text,
 * input/button structure). Does NOT take screenshots or do deep DOM work.
 *
 * Playwright context must still be open. Call before context.close().
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ pageTitle: string, visibleText: string, forms: object }>}
 */
export async function collectNavPageMeta(page) {
  return page.evaluate(() => {
    const pageTitle = document.title || '';

    // Visible text: first ~600 characters, whitespace-collapsed, lowercased.
    // Keeps the eval fast while providing enough context for keyword matching.
    const visibleText = (document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600)
      .toLowerCase();

    // Form structure: presence flags only — no actual field values.
    const forms = {
      hasPasswordInput: !!document.querySelector('input[type="password"]'),

      hasEmailInput: !!(
        document.querySelector('input[type="email"]') ||
        document.querySelector('input[name*="email" i]') ||
        document.querySelector('input[placeholder*="email" i]') ||
        document.querySelector('input[id*="email" i]')
      ),

      hasTelInput: !!document.querySelector('input[type="tel"]'),

      hasOtpInput: !!(
        document.querySelector('input[autocomplete="one-time-code"]') ||
        document.querySelector('input[name*="otp" i]')               ||
        document.querySelector('input[name*="totp" i]')              ||
        document.querySelector('input[name*="token" i]')             ||
        document.querySelector('input[inputmode="numeric"][maxlength]')
      ),

      hasUsernameInput: !!(
        document.querySelector('input[autocomplete="username"]') ||
        document.querySelector('input[name*="user" i]')         ||
        document.querySelector('input[name*="login" i]')        ||
        document.querySelector('input[name*="account" i]')      ||
        document.querySelector('input[name*="id" i]:not([type="hidden"])')
      ),

      // Social login buttons: class/id contains major provider names.
      // Intentionally broad — false positives are acceptable here since
      // other signals will keep the overall score calibrated.
      hasSocialLoginBtn: !!(
        document.querySelector('[class*="google" i][class*="btn" i]') ||
        document.querySelector('[id*="google" i][class*="btn" i]')   ||
        document.querySelector('[class*="kakao" i]')                 ||
        document.querySelector('[class*="naver" i]')                 ||
        document.querySelector('[class*="apple" i][class*="btn" i]') ||
        document.querySelector('[class*="facebook" i][class*="btn" i]')
      ),
    };

    return { pageTitle, visibleText, forms };
  }).catch(() => ({ pageTitle: '', visibleText: '', forms: {} }));
}

// ── Private helpers ───────────────────────────────────────────────────────────

function _unknownResult(finalUrl, reason) {
  let host = '';
  let pathname = '';
  try {
    const u = new URL(finalUrl);
    host     = u.hostname;
    pathname = u.pathname;
  } catch {}
  return {
    navigationStatus:    'navigated_to_unknown',
    navigatedToHost:     host,
    navigatedToPath:     pathname,
    authDetected:        false,
    requiresAuth:        false,
    authScore:           0,
    authConfidence:      'low',
    authSignals:         [],
    navigationReason:    reason,
    classificationSource: [],
  };
}
