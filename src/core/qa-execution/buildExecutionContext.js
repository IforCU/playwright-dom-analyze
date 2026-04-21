import { chromium } from 'playwright';

/**
 * Launch a bare browser instance (reused across scenarios).
 * @param {object} defaults
 * @returns {Promise<import('playwright').Browser>}
 */
export async function launchBrowser(defaults) {
  return chromium.launch({ headless: defaults.headless ?? true });
}

/**
 * Create a new browser context + page for one scenario run.
 * Optionally sets up video recording into `videoDir`.
 *
 * @param {import('playwright').Browser} browser
 * @param {object} defaults
 * @param {object} [opts]
 * @param {string} [opts.videoDir]       – directory for recordVideo output
 * @param {string} [opts.traceOutputPath] – path for trace zip file
 * @returns {Promise<{ context, page, closeContext }>}
 */
export async function createScenarioContext(browser, defaults, opts = {}) {
  const contextOptions = {
    viewport:          defaults.viewport   ?? { width: 1280, height: 800 },
    locale:            defaults.locale     ?? 'ko-KR',
    timezoneId:        defaults.timezone   ?? 'Asia/Seoul',
    baseURL:           defaults.baseURL    || undefined,
    ignoreHTTPSErrors: true,
  };

  if (defaults.credentials) {
    contextOptions.httpCredentials = {
      username: defaults.credentials.username,
      password: defaults.credentials.password,
    };
  }

  if (opts.videoDir) {
    contextOptions.recordVideo = {
      dir:  opts.videoDir,
      size: defaults.viewport ?? { width: 1280, height: 800 },
    };
  }

  const context = await browser.newContext(contextOptions);

  if (opts.traceOutputPath) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  }

  const page = await context.newPage();

  async function closeContext() {
    let videoPath = null;
    try {
      if (opts.traceOutputPath) {
        await context.tracing.stop({ path: opts.traceOutputPath }).catch(() => {});
      }
      // Must get video path BEFORE closing the page/context
      const video = page.video?.();
      await context.close();   // this triggers video file save
      if (video) {
        videoPath = await video.path().catch(() => null);
      }
    } catch { /* ignore */ }
    return { videoPath };
  }

  return { context, page, closeContext };
}

/**
 * Legacy convenience: launch browser + single context + page (no per-scenario video).
 * Kept for backwards compatibility with existing callers.
 */
export async function buildExecutionContext(defaults) {
  const browser = await launchBrowser(defaults);
  const { context, page, closeContext } = await createScenarioContext(browser, defaults);

  async function teardown() {
    await closeContext();
    await browser.close().catch(() => {});
  }

  return { browser, context, page, teardown };
}
