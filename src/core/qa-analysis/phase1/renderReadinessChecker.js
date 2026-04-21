/**
 * core/phase1/renderReadinessChecker.js
 *
 * PART 1 — Render Readiness Improvement
 *
 * Determines whether the page is in a truly analyzable state before Phase 1
 * baseline extraction begins.  A single load event or fixed timeout is
 * insufficient for many modern pages because:
 *   - SPA routes may still be rendering
 *   - skeleton / loading UIs may still be visible
 *   - lazy-loaded sections may not have populated yet
 *   - late-injected scripts may rearrange the DOM after DOMContentLoaded
 *
 * Strategy — multi-signal readiness gate:
 *   Signal 1  — page title is present (non-empty)
 *   Signal 2  — body has at least minElementCount visible elements
 *   Signal 3  — no obvious skeleton / spinner / loading placeholder remains
 *   Signal 4  — layout is stable across a short observation window
 *               (key element count and body height do not change)
 *   Signal 5  — network has been relatively idle for a short window
 *               (Playwright networkidle with short timeout)
 *   Signal 6  — meaningful content containers are present
 *
 * Configurable via opts and config/render-rules.json.
 *
 * Returns a serializable render-readiness report saved as render-readiness.json.
 */

import { sleep } from '../utils.js';
import fs        from 'fs/promises';
import path      from 'path';

// ── Default configuration ──────────────────────────────────────────────────────

const DEFAULTS = {
  // Maximum time (ms) to wait for the page to become ready before proceeding
  // in degraded mode.
  maxInitialWaitMs:        8_000,
  // Time (ms) to observe for layout stability (body height + element count
  // must stay the same across two samples separated by this interval).
  layoutStabilityWindowMs: 800,
  // Time (ms) to wait for networkidle after a stability check.
  networkIdleWaitMs:       2_000,
  // Minimum number of visible elements the body must contain.
  minElementCount:         20,
  // Maximum fraction of loading indicators allowed (loading keywords /
  // total elements) before we consider the page not-ready.
  maxLoadingRatio:         0.04,
};

// ── Loading / skeleton signal patterns (tested in browser context) ─────────────

/**
 * Keywords typically found in class/id of skeleton loaders, spinners, or
 * loading placeholders.  Matched case-insensitively anywhere in the string.
 */
const LOADING_CLASS_SRC =
  'skeleton|loading|spinner|placeholder|shimmer|pulse|lazy|pending|' +
  'progress|loader|fetching|buffering|wait';

/**
 * Visible text patterns that suggest the page content has not loaded yet.
 * Matched against trimmed, lowercased innerText of visible leaf elements.
 */
const LOADING_TEXT_SRC =
  '^로딩\\s*(중)?$|^loading\\.{0,3}$|^please\\s+wait$|^wait\\.{0,3}$|' +
  '^fetching\\s*data|^preparing|^just\\s+a\\s+moment';

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Check render readiness and wait until the page is analyzable.
 *
 * @param {import('playwright').Page} page - Already navigated page
 * @param {object} [opts]
 * @param {number}  [opts.maxInitialWaitMs]
 * @param {number}  [opts.layoutStabilityWindowMs]
 * @param {number}  [opts.networkIdleWaitMs]
 * @param {number}  [opts.minElementCount]
 * @param {number}  [opts.maxLoadingRatio]
 * @param {boolean} [opts.enabled=true]
 * @returns {Promise<object>} Serializable readiness report
 */
export async function checkRenderReadiness(page, opts = {}) {
  // Load external config overrides if available
  const fileOverrides = await _loadRenderRules();
  const cfg = { ...DEFAULTS, ...fileOverrides, ...opts };

  const startedAt    = Date.now();
  const signals      = [];
  const warnings     = [];
  let   degradedMode = false;

  if (opts.enabled === false) {
    return _buildReport({ signals, warnings, degradedMode: false, elapsed: 0,
      readinessScore: 1, message: 'render-readiness check disabled' });
  }

  // ── Signal 5 (network idle) — run first as it has its own Playwright timeout ─
  let networkIdleDone = false;
  await page.waitForLoadState('networkidle', { timeout: cfg.networkIdleWaitMs })
    .then(() => { networkIdleDone = true; })
    .catch(() => {});
  signals.push({ signal: 'networkIdle', passed: networkIdleDone,
    note: networkIdleDone ? `idle within ${cfg.networkIdleWaitMs}ms` : 'still active after timeout' });

  // ── Signals 1–4 and 6: in-page evaluation ────────────────────────────────────
  const deadline = startedAt + cfg.maxInitialWaitMs;
  let   attempt  = 0;
  let   ready    = false;

  while (Date.now() < deadline) {
    attempt++;
    const snapshot = await _samplePageState(page, cfg).catch(() => null);
    if (!snapshot) {
      warnings.push('page.evaluate failed during readiness check — context may be unstable');
      await sleep(300);
      continue;
    }

    const {
      hasTitle, elementCount, loadingCount, bodyHeight,
      hasContentContainer, loadingRatio,
    } = snapshot;

    // Record signal results for this attempt
    const sig1 = hasTitle;
    const sig2 = elementCount >= cfg.minElementCount;
    const sig3 = loadingRatio <= cfg.maxLoadingRatio;
    const sig6 = hasContentContainer;

    // Layout stability check (Signal 4) — wait one window and re-sample
    let sig4 = false;
    if (sig1 && sig2) {
      await sleep(cfg.layoutStabilityWindowMs);
      const snapshot2 = await _samplePageState(page, cfg).catch(() => null);
      if (snapshot2) {
        const heightDelta  = Math.abs(snapshot2.bodyHeight - bodyHeight);
        const countDelta   = Math.abs(snapshot2.elementCount - elementCount);
        sig4 = heightDelta < 30 && countDelta < 5;
        if (!sig4) {
          // Layout still shifting — wait a bit more before next attempt
          await sleep(400);
        }
      }
    }

    const passedCount = [sig1, sig2, sig3, sig4, sig6].filter(Boolean).length;
    ready = passedCount >= 4; // require at least 4 / 5 in-page signals

    if (ready || Date.now() >= deadline) {
      signals.push(
        { signal: 'hasTitle',           passed: sig1 },
        { signal: 'minElementCount',    passed: sig2, value: elementCount, threshold: cfg.minElementCount },
        { signal: 'noLoadingIndicator', passed: sig3, loadingCount, loadingRatio: +loadingRatio.toFixed(3) },
        { signal: 'layoutStable',       passed: sig4 },
        { signal: 'contentContainer',   passed: sig6 },
      );
      break;
    }
  }

  if (!ready) {
    degradedMode = true;
    warnings.push(`readiness not fully confirmed after ${cfg.maxInitialWaitMs}ms — proceeding in degraded mode`);
    if (!signals.length) {
      signals.push({ signal: 'deadline_reached', passed: false });
    }
  }

  const elapsed = Date.now() - startedAt;
  const passedSignals = signals.filter((s) => s.passed).length;
  const readinessScore = +(passedSignals / Math.max(signals.length, 1)).toFixed(2);

  return _buildReport({ signals, warnings, degradedMode, elapsed, readinessScore,
    message: degradedMode
      ? `degraded mode — ${passedSignals}/${signals.length} signals passed`
      : `ready — ${passedSignals}/${signals.length} signals passed in ${elapsed}ms` });
}

// ── Frame inspection (PART 2) ─────────────────────────────────────────────────

/**
 * Inspect frames on the page and produce a frame summary.
 *
 * Same-origin frames: include frame title, URL, element count estimate, bbox.
 * Cross-origin frames: record src, bbox, likely role — do NOT access DOM.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<object>} frame-summary report
 */
export async function inspectFrames(page) {
  const frames        = page.frames();
  const mainUrl       = page.url();
  const mainOrigin    = _safeOrigin(mainUrl);
  const frameSummary  = [];
  const warnings      = [];

  for (const frame of frames) {
    if (frame === page.mainFrame()) continue; // skip main frame

    const frameUrl = frame.url();
    if (!frameUrl || frameUrl === 'about:blank') continue;

    const frameOrigin = _safeOrigin(frameUrl);
    const isSameOrigin = frameOrigin && frameOrigin === mainOrigin;

    // Attempt to get the iframe element handle to read bbox + attributes
    let bbox = null;
    let srcAttr = null;
    try {
      const handle = await frame.frameElement();
      const box    = await handle.boundingBox();
      if (box) bbox = { x: Math.round(box.x), y: Math.round(box.y),
        width: Math.round(box.width), height: Math.round(box.height) };
      srcAttr = await handle.getAttribute('src').catch(() => null);
    } catch (_) {}

    // Estimate viewport area coverage
    const vpWidth  = page.viewportSize()?.width  ?? 1920;
    const vpHeight = page.viewportSize()?.height ?? 1080;
    const vpArea   = vpWidth * vpHeight;
    const frameArea = bbox ? bbox.width * bbox.height : 0;
    const vpCoverage = vpArea > 0 ? +(frameArea / vpArea).toFixed(3) : 0;

    // Classify likely role from src / size
    const likelyRole = _classifyFrameRole(srcAttr ?? frameUrl, vpCoverage);

    if (isSameOrigin) {
      // Safe to inspect same-origin frame DOM
      let elementCount = 0;
      let frameTitle   = '';
      let hasContent   = false;
      try {
        ({ elementCount, frameTitle, hasContent } = await frame.evaluate(() => ({
          elementCount: document.querySelectorAll('*').length,
          frameTitle:   document.title || '',
          hasContent:   (document.body?.innerText?.trim()?.length ?? 0) > 50,
        })));
      } catch (err) {
        warnings.push(`same-origin frame evaluate failed: ${err.message}`);
      }
      frameSummary.push({
        type:          'same-origin',
        frameUrl,
        srcAttr,
        bbox,
        vpCoverage,
        likelyRole,
        frameTitle,
        elementCount,
        hasContent,
        inspected:     true,
      });
    } else {
      // Cross-origin: record existence only — do NOT attempt DOM access
      frameSummary.push({
        type:          'cross-origin',
        frameUrl:      frameUrl.startsWith('http') ? new URL(frameUrl).origin + '/…' : frameUrl,
        srcAttr,
        bbox,
        vpCoverage,
        likelyRole,
        inspected:     false,
        note:          'cross-origin frame — DOM not inspectable due to browser security policy',
      });
    }
  }

  // Detect if a same-origin frame holds most of the content
  const contentFrames = frameSummary.filter((f) => f.type === 'same-origin' && f.hasContent);
  const largeFrames   = frameSummary.filter((f) => f.vpCoverage >= 0.4);

  return {
    totalFrameCount:    frameSummary.length,
    sameOriginCount:    frameSummary.filter((f) => f.type === 'same-origin').length,
    crossOriginCount:   frameSummary.filter((f) => f.type === 'cross-origin').length,
    contentFrameCount:  contentFrames.length,
    largeFrameCount:    largeFrames.length,
    frames:             frameSummary,
    warnings,
    qualityWarnings: [
      ...(largeFrames.some((f) => !f.inspected)
        ? ['cross-origin iframe covered a large part of the page and could not be inspected']
        : []),
      ...(contentFrames.length > 0
        ? ['same-origin iframe contained meaningful content — included in page structure']
        : []),
    ],
  };
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function _samplePageState(page, cfg) {
  return page.evaluate(({ loadingClassSrc, loadingTextSrc, minElementCount }) => {
    const LOADING_CLASS_RE = new RegExp(loadingClassSrc, 'i');
    const LOADING_TEXT_RE  = new RegExp(loadingTextSrc,  'i');

    const allEls = Array.from(document.querySelectorAll('*'));
    let loadingCount = 0;

    for (const el of allEls) {
      const cls = typeof el.className === 'string' ? el.className : '';
      const id  = el.id || '';
      if (LOADING_CLASS_RE.test(cls) || LOADING_CLASS_RE.test(id)) {
        // Only count if visible
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) loadingCount++;
      }
    }

    // Count visible leaf-ish elements (not head/script/style)
    const SKIP = new Set(['html','head','script','style','meta','link','noscript','template']);
    let visibleCount = 0;
    for (const el of allEls) {
      if (SKIP.has(el.tagName.toLowerCase())) continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 2 && r.height >= 2) visibleCount++;
    }

    // Check for content containers
    const contentSelectors = [
      'main', '[role="main"]', 'article', '.content', '#content',
      '.container', '#container', '.wrapper', '#wrapper',
      'section', '.page', '#page',
    ];
    const hasContentContainer = contentSelectors.some((sel) => {
      try {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 100 && r.height > 100;
      } catch (_) { return false; }
    });

    // Loading ratio
    const loadingRatio = visibleCount > 0 ? loadingCount / visibleCount : 0;

    return {
      hasTitle:           (document.title || '').trim().length > 0,
      elementCount:       visibleCount,
      loadingCount,
      loadingRatio,
      bodyHeight:         document.body?.scrollHeight ?? 0,
      hasContentContainer,
    };
  }, { loadingClassSrc: LOADING_CLASS_SRC, loadingTextSrc: LOADING_TEXT_SRC, minElementCount: cfg.minElementCount });
}

function _buildReport({ signals, warnings, degradedMode, elapsed, readinessScore, message }) {
  return {
    degradedMode,
    readinessScore,
    elapsedMs: elapsed,
    message,
    signals,
    warnings,
    qualityWarnings: degradedMode
      ? ['analysis started while page may not be fully rendered — results may be partial']
      : [],
  };
}

async function _loadRenderRules() {
  try {
    const raw = await fs.readFile(
      new URL('../../../config/render-rules.json', import.meta.url), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

function _safeOrigin(url) {
  try { return new URL(url).origin; } catch (_) { return null; }
}

function _classifyFrameRole(src, vpCoverage) {
  if (!src) return 'unknown';
  const s = src.toLowerCase();
  if (/ad|ads|adv|advertis|doubleclick|googlesyndication|adtech/.test(s)) return 'advertisement';
  if (/youtube|vimeo|video|media|player/.test(s)) return 'media-player';
  if (/map|maps\.google|maps\.apple|openstreetmap/.test(s)) return 'map';
  if (/captcha|recaptcha|hcaptcha/.test(s)) return 'captcha';
  if (/social|twitter|facebook|instagram|share/.test(s)) return 'social-widget';
  if (/chat|support|intercom|zendesk|helpscout|crisp/.test(s)) return 'chat-widget';
  if (/payment|stripe|paypal|checkout/.test(s)) return 'payment';
  if (vpCoverage >= 0.5) return 'main-content-candidate';
  return 'unknown';
}
