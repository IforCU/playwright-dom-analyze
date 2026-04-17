/**
 * core/browser.js
 *
 * Manages Playwright browser lifecycle.
 * Always create a fresh BrowserContext per analysis task to ensure
 * isolated state (cookies, localStorage, DOM).
 *
 * Chromium lookup order:
 *   1. Playwright-managed Chromium binary (installed via `npm run install:browsers`)
 *   2. System Google Chrome at the standard Windows path (auto-fallback)
 *   3. CHROME_PATH environment variable
 */

import { chromium } from 'playwright';
import { existsSync } from 'fs';

const SYSTEM_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function resolveExecutablePath() {
  // Explicit override via env var
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  // Auto-detect system Chrome on Windows
  for (const p of SYSTEM_CHROME_PATHS) {
    if (existsSync(p)) return p;
  }
  // Let Playwright find its own managed binary (may throw if not installed)
  return undefined;
}

/** Launch a headless Chromium browser */
export async function launchBrowser() {
  const executablePath = resolveExecutablePath();
  if (executablePath) {
    console.log(`[browser] using executable: ${executablePath}`);
  }
  return chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

/**
 * Create a fresh BrowserContext with a 1920×1080 (FHD) viewport.
 * Use one context per page/task so state never bleeds across analyses.
 *
 * @param {import('playwright').Browser} browser
 * @param {{ storageState?: string }} [opts]  - Optional Playwright context options.
 *   storageState: path to a saved storageState file (cookies + localStorage) for
 *   authenticated sessions.  When omitted the context starts with a clean slate.
 */
export async function createFreshContext(browser, opts = {}) {
  const contextOpts = {
    viewport: { width: 1920, height: 1080 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  };
  if (opts.storageState) {
    contextOpts.storageState = opts.storageState;
  }
  return browser.newContext(contextOpts);
}

/**
 * Navigate a page to the given URL.
 *
 * Wait strategy:
 *   1. `load`       — primary gate: HTML + subresources loaded (reliable on all sites)
 *   2. `networkidle`— best-effort: silently skipped if heavy pages keep polling
 *   3. 600 ms buffer for deferred JS renders / hydration
 *
 * Heavy portals (e.g. naver.com) never reach networkidle because of persistent
 * ad/analytics requests, so using networkidle as the primary gate causes a
 * 30-second timeout.  Using `load` as the primary avoids this.
 */
export async function navigateTo(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
  // Best-effort: wait a bit longer for deferred XHR batches to settle.
  // Silently ignored on pages that never reach networkidle.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  // Extra buffer for deferred rendering (animations, lazy hydration, etc.)
  await page.waitForTimeout(600);
}
