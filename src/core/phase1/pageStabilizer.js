/**
 * core/phase1/pageStabilizer.js
 *
 * Initial page stabilization — runs BEFORE Phase 1 baseline analysis.
 *
 * Purpose:
 *   Detect and neutralize temporary blocking UI elements (modals, cookie
 *   banners, full-screen ads, autoplay video overlays, app-install prompts,
 *   age gates, newsletter popups, etc.) that would distort baseline DOM
 *   extraction, screenshot capture, auto-dynamic detection, and trigger
 *   candidate discovery.
 *
 * This module does NOT alter site data or state permanently.
 * All DOM changes (CSS hide) are local to the analysis browser context.
 *
 * ── STAGED STRATEGY ──────────────────────────────────────────────────────────
 * Stage 3 (runs first):
 *   Pause / mute any autoplay video or audio before overlay work, so that
 *   media controls do not create false positives in the blocker detector and
 *   do not produce noise during auto-dynamic observation.
 *
 * Stage 1 (per blocker):
 *   Find dismiss/close/skip controls INSIDE the detected overlay and click
 *   them.  Only controls whose text or aria-label strongly matches safe-dismiss
 *   patterns are clicked.  Risky CTA text (buy, login, install, submit …)
 *   disqualifies a control regardless of position.
 *
 * Stage 2 (per blocker, if Stage 1 did not work):
 *   Press Escape once.  Many modal frameworks respond to this key.
 *
 * Stage 4 (per blocker, if still blocking AND high confidence):
 *   Apply CSS `visibility:hidden; pointer-events:none` to the element
 *   in the analysis context only.  This is a last-resort that does not
 *   remove the element from the DOM (no layout shift side-effects).
 *   Recorded as an explicit stabilization action.
 *
 * ── SAFETY RULES ─────────────────────────────────────────────────────────────
 * - NEVER click buttons that look like navigation, purchase, login, or form
 *   submission.
 * - Prefer Stage 4 (hide) over a risky click when confidence is low.
 * - Escape key is always safe to attempt.
 * - Stage 4 is only applied to blockers with a composite score >= HIGH_SCORE.
 */

import { sleep } from '../utils.js';

// ── Pattern sources ───────────────────────────────────────────────────────────
// These are serialized as strings and reconstructed as RegExp inside
// page.evaluate() to cross the Playwright V8 serialization boundary.

/** Keywords typically found in class / id of blocking overlay elements. */
const BLOCKER_KW_SRC =
  'modal|popup|dialog|overlay|interstitial|cookie|consent|banner|gdpr|' +
  'install|promo|subscribe|notice|dimmer|backdrop|mask|layer|lightbox|' +
  'curtain|splash|gate|wall|adslot|adsense|adroll|toast|takeover|sheet';

/**
 * Text patterns that indicate a safe dismiss control.
 * Tested against the trimmed, lowercased combined text + aria-label + title.
 * These are partial-match patterns (not anchored) so "close dialog" is caught.
 */
const DISMISS_CONTAINS_SRC =
  '닫기|close|dismiss|skip|나중에|다음에|not\\s*now|no\\s*thanks|later|' +
  'accept\\s*(all|cookies?)?|allow\\s*(all|cookies?)?|확인|got\\s*it|done|ok$|okay$|' +
  'continue without|reject all|decline all';

/**
 * Text patterns that DISQUALIFY a dismiss candidate — even if the text also
 * contains a dismiss keyword.  Risky CTAs must never be clicked.
 */
const RISKY_TEXT_SRC =
  '\\b(buy|checkout|cart|log.?in|sign.{0,4}up|install|download|' +
  'subscribe now|register|purchase|join now|submit|order now|' +
  'add to cart|apply now|start free|get started|upgrade)\\b';

// ── Scoring thresholds ────────────────────────────────────────────────────────

/** Minimum composite score for an element to be treated as a blocker. */
const MIN_BLOCKER_SCORE = 3;

/** Minimum score before Stage 4 (CSS hide) is applied. */
const HIGH_BLOCKER_SCORE = 5;

// ── Timing constants ─────────────────────────────────────────────────────────

const DISMISS_CLICK_DELAY_MS = 60;  // slow down click to let event handlers fire
const POST_ACTION_WAIT_MS    = 450; // settle time after each dismissal action

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Stabilize the page before Phase 1 analysis.
 *
 * Detects blocking overlays and intrusive media, attempts staged dismissal,
 * and returns a serializable report that is saved as initial-stabilization.json.
 *
 * @param {import('playwright').Page} page
 *   The open page — already navigated to the target URL.
 * @param {object}  opts
 * @param {boolean} [opts.enabled=true]
 *   Master switch.  When false the function returns immediately with an empty
 *   report (all counts zero, stabilizationSucceeded=true).
 * @param {number}  [opts.coverageThreshold=0.30]
 *   Viewport fraction (0–1) that an element must cover in width AND height
 *   to be scored for coverage.  Default 30 % is intentionally conservative to
 *   avoid flagging narrow sticky headers.
 * @param {number}  [opts.minZIndex=50]
 *   Minimum CSS z-index to consider when scoring a fixed/sticky element.
 * @param {number}  [opts.maxBlockers=6]
 *   Maximum number of blockers processed in a single run.
 * @returns {Promise<object>}  Serializable stabilization report.
 */
export async function stabilizePage(page, opts = {}) {
  const {
    enabled           = true,
    coverageThreshold = 0.30,
    minZIndex         = 50,
    maxBlockers       = 6,
  } = opts;

  const report = {
    enabled,
    startedAt:              new Date().toISOString(),
    blockerCount:           0,
    blockingElements:       [],
    actions:                [],
    dismissedCount:         0,
    hiddenCount:            0,
    pausedMediaCount:       0,
    stabilizationSucceeded: true,
    partiallyBlocked:       false,
    warnings:               [],
    finishedAt:             null,
  };

  if (!enabled) {
    report.finishedAt = new Date().toISOString();
    return report;
  }

  try {
    // ── Stage 3: Pause autoplay media first ─────────────────────────────────
    // Run before overlay detection so video controls do not appear as dismiss
    // buttons and so continuous playback does not cause mutation noise during
    // the subsequent auto-dynamic observation window.
    const mediaPaused = await _pauseMedia(page);
    report.pausedMediaCount = mediaPaused;
    if (mediaPaused > 0) {
      console.log(`[stabilize]  paused ${mediaPaused} autoplay media element(s)`);
      report.actions.push({
        stage:     3,
        type:      'pause_media',
        count:     mediaPaused,
        succeeded: true,
      });
    }

    // ── Detection: find blocking overlays ───────────────────────────────────
    const detectParams = {
      coverageThreshold,
      minZIndex,
      maxBlockers,
      BLOCKER_KW_SRC,
      DISMISS_CONTAINS_SRC,
      RISKY_TEXT_SRC,
    };
    
    // Initial detection
    let blockers = await _detectBlockersAndButtons(page, detectParams);
    
    // Improvement: If a blocker is detected but has NO dismiss buttons, 
    // it might be an ad/overlay that requires a few seconds before the 'skip' button appears.
    // Let's wait briefly and re-detect.
    const needsWait = blockers.some(b => b.dismissButtons.length === 0 && b.score >= MIN_BLOCKER_SCORE);
    if (needsWait) {
      console.log(`[stabilize]  blocker found without dismiss buttons, waiting 2s for potential skip button to appear...`);
      await sleep(2000);
      blockers = await _detectBlockersAndButtons(page, detectParams);
    }

    report.blockerCount     = blockers.length;
    report.blockingElements = blockers.map((b) => ({
      selector:  b.selector,
      score:     b.score,
      coverage:  b.coverage,
      zIndex:    b.zIndex,
      reasons:   b.reasons,
      dismissed: false,
      hidden:    false,
    }));

    if (blockers.length > 0) {
      console.log(`[stabilize]  ${blockers.length} potential blocking element(s) detected`);
    }

    // ── Process each blocker ─────────────────────────────────────────────────
    for (let i = 0; i < blockers.length; i++) {
      const blocker  = blockers[i];
      const reportEl = report.blockingElements[i];
      let dismissed  = false;

      // Stage 1: click safe dismiss buttons found inside the overlay
      for (const btn of (blocker.dismissButtons || [])) {
        if (dismissed) break;
        try {
          await page.mouse.click(btn.cx, btn.cy, { delay: DISMISS_CLICK_DELAY_MS });
          await sleep(POST_ACTION_WAIT_MS);
          const gone = await _isBlockerGone(page, blocker.centerX, blocker.centerY, minZIndex);
          if (gone) {
            dismissed = true;
            report.dismissedCount++;
            reportEl.dismissed = true;
            report.actions.push({
              stage:      1,
              type:       'click_dismiss',
              buttonText: btn.text,
              selector:   blocker.selector,
              succeeded:  true,
            });
            console.log(`[stabilize]  dismissed: ${blocker.selector} via "${btn.text}"`);
          }
        } catch {
          // button may have disappeared; continue to next candidate
        }
      }

      // Stage 2: Escape key (if Stage 1 did not work)
      if (!dismissed) {
        try {
          await page.keyboard.press('Escape');
          await sleep(POST_ACTION_WAIT_MS);
          const gone = await _isBlockerGone(page, blocker.centerX, blocker.centerY, minZIndex);
          if (gone) {
            dismissed = true;
            report.dismissedCount++;
            reportEl.dismissed = true;
            report.actions.push({
              stage:     2,
              type:      'escape_key',
              selector:  blocker.selector,
              succeeded: true,
            });
            console.log(`[stabilize]  dismissed: ${blocker.selector} via Escape`);
          } else {
            report.actions.push({
              stage:     2,
              type:      'escape_key',
              selector:  blocker.selector,
              succeeded: false,
            });
          }
        } catch {
          // keyboard interaction failed — continue
        }
      }

      // Stage 4: CSS hide — last resort, only for high-confidence blockers
      if (!dismissed && blocker.score >= HIGH_BLOCKER_SCORE) {
        const hidden = await _hideElement(page, blocker.selector);
        if (hidden) {
          report.hiddenCount++;
          reportEl.hidden = true;
          report.actions.push({
            stage:     4,
            type:      'css_hide',
            selector:  blocker.selector,
            succeeded: true,
            note:      'visibility:hidden applied in analysis context only — no permanent site change',
          });
          console.log(`[stabilize]  hidden (CSS): ${blocker.selector} (score=${blocker.score})`);
        }
      }

      // Record warning if blocker could not be neutralized by any stage
      if (!dismissed && !reportEl.hidden) {
        report.warnings.push(
          `Could not neutralize blocker: ${blocker.selector} (score=${blocker.score})`
        );
      }
    }

    // ── Final readiness check ────────────────────────────────────────────────
    const { ready, reason } = await _checkPageReady(page, { coverageThreshold, minZIndex });
    report.stabilizationSucceeded = ready;
    report.partiallyBlocked       = !ready;

    if (!ready) {
      report.warnings.push(`Page may still be partially blocked: ${reason}`);
      console.log(`[stabilize]  warning — ${reason}`);
    } else if (blockers.length > 0) {
      console.log('[stabilize]  page ready for analysis');
    }

  } catch (err) {
    report.warnings.push(`Stabilization exception: ${err.message}`);
    report.stabilizationSucceeded = false;
    report.partiallyBlocked       = true;
    console.log(`[stabilize]  exception: ${err.message}`);
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Run inside the browser to find fixed/sticky blocking elements and the
 * safe dismiss controls contained within them.
 *
 * Returns a serializable array of blocker descriptors sorted by score (desc).
 * Each descriptor includes pre-computed center coordinates and a list of
 * safe dismiss button coordinates — ready for Playwright mouse.click().
 *
 * @param {import('playwright').Page} page
 * @param {object} params  Serializable parameters passed into page.evaluate().
 * @returns {Promise<Array>}
 */
async function _detectBlockersAndButtons(page, params) {
  return page.evaluate(({
    coverageThreshold,
    minZIndex,
    maxBlockers,
    BLOCKER_KW_SRC,
    DISMISS_CONTAINS_SRC,
    RISKY_TEXT_SRC,
  }) => {
    const BLOCKER_KW_RE       = new RegExp(BLOCKER_KW_SRC,       'i');
    const DISMISS_CONTAINS_RE = new RegExp(DISMISS_CONTAINS_SRC, 'i');
    const RISKY_TEXT_RE       = new RegExp(RISKY_TEXT_SRC,       'i');

    const vw = window.innerWidth  || document.documentElement.clientWidth  || 800;
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;

    // ── Selector builder ───────────────────────────────────────────────────
    // Produces a CSS selector string for a DOM element.
    // Preference: id > data attributes > tag+class.
    // This is a best-effort hint; it may not be globally unique for elements
    // without ids, but is sufficient for the blocking elements we target.
    function buildSelector(el) {
      if (el.id) {
        try { return '#' + CSS.escape(el.id); } catch { /* fall through */ }
      }
      for (const attr of ['data-testid', 'data-modal', 'data-component', 'data-overlay', 'data-id']) {
        const val = el.getAttribute(attr);
        if (val) {
          try { return `[${attr}="${CSS.escape(val)}"]`; } catch { /* fall through */ }
        }
      }
      const tag = el.tagName.toLowerCase();
      try {
        const cls = Array.from(el.classList)
          .filter((c) => /[a-zA-Z]/.test(c))
          .slice(0, 2)
          .map((c) => CSS.escape(c));
        if (cls.length) return `${tag}.${cls.join('.')}`;
      } catch { /* fall through */ }
      return tag;
    }

    // ── Dismiss button scanner ─────────────────────────────────────────────
    // Scans the subtree of a candidate blocker element for controls whose
    // text, aria-label, or title matches safe-dismiss patterns and does NOT
    // match risky CTA patterns.
    function findDismissButtons(container) {
      const candidates = container.querySelectorAll(
        'button, a, [role="button"], [aria-label], [tabindex="0"], ' +
        'span[onclick], div[onclick]'
      );
      const buttons = [];
      const seenCoords = new Set();

      for (const el of candidates) {
        // Gather all text signals for the element
        const text      = (el.textContent || '').replace(/\s+/g, ' ').trim();
        const ariaLabel = (el.getAttribute('aria-label') || '').trim();
        const title     = (el.getAttribute('title')      || '').trim();
        // Check for Unicode close symbols directly on the element
        const hasCloseSymbol = /[×✕✗✖❌]/.test(text + ariaLabel + title);

        const combined = [text, ariaLabel, title].join(' ').replace(/\s+/g, ' ').trim();
        const lower    = combined.toLowerCase().slice(0, 80);

        // Disqualify if text is risky (checked first — risky wins over dismiss)
        if (RISKY_TEXT_RE.test(lower)) continue;

        // Must match either a dismiss keyword or a close symbol
        if (!DISMISS_CONTAINS_RE.test(lower) && !hasCloseSymbol) continue;

        const rect = el.getBoundingClientRect();
        // Skip invisible or zero-sized controls
        if (rect.width < 4 || rect.height < 4) continue;
        // Skip controls outside the visible viewport
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;

        const cx = Math.round(rect.left + rect.width  / 2);
        const cy = Math.round(rect.top  + rect.height / 2);
        const coordKey = `${cx},${cy}`;
        if (seenCoords.has(coordKey)) continue;
        seenCoords.add(coordKey);

        buttons.push({
          text: combined.slice(0, 40),
          cx,
          cy,
        });

        if (buttons.length >= 5) break; // cap per blocker
      }

      return buttons;
    }

    // ── Main detection loop ────────────────────────────────────────────────
    const processedEls = new WeakSet(); // avoid double-counting nested fixed els
    const results      = [];

    for (const el of document.querySelectorAll('*')) {
      if (el === document.body || el === document.documentElement) continue;
      if (processedEls.has(el)) continue;

      const style = window.getComputedStyle(el);
      const pos   = style.position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;

      // Quick visibility culls
      if (style.display     === 'none')    continue;
      if (style.visibility  === 'hidden')  continue;
      if (style.visibility  === 'collapse') continue;
      if (parseFloat(style.opacity) < 0.05) continue;

      // Skip elements we already hid in a previous stabilization run
      if (el.getAttribute('data-stabilizer-hidden')) continue;

      const rect = el.getBoundingClientRect();
      // Skip tiny or off-screen elements
      if (rect.width < 10 || rect.height < 10) continue;
      if (rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw) continue;

      const coverW = rect.width  / vw;
      const coverH = rect.height / vh;
      const zIndex = parseInt(style.zIndex) || 0;

      // ── Composite scoring ──────────────────────────────────────────────
      const reasons = [];
      let score = 0;

      if (coverW > coverageThreshold) {
        score += 2;
        reasons.push(`width_${(coverW * 100).toFixed(0)}pct`);
      }
      if (coverH > coverageThreshold) {
        score += 2;
        reasons.push(`height_${(coverH * 100).toFixed(0)}pct`);
      }
      if (zIndex > 1000) {
        score += 2;
        reasons.push(`zindex_${zIndex}_high`);
      } else if (zIndex >= minZIndex) {
        score += 1;
        reasons.push(`zindex_${zIndex}`);
      }

      const role      = (el.getAttribute('role')       || '').toLowerCase();
      const ariaModal = (el.getAttribute('aria-modal') || '').toLowerCase();
      if (role === 'dialog' || role === 'alertdialog') {
        score += 3;
        reasons.push('role_dialog');
      }
      if (ariaModal === 'true') {
        score += 3;
        reasons.push('aria_modal');
      }

      // Class and id keyword matching
      const classStr = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const idStr    = (el.id || '').toLowerCase();
      if (BLOCKER_KW_RE.test(classStr)) { score += 2; reasons.push('class_keyword'); }
      if (BLOCKER_KW_RE.test(idStr))    { score += 2; reasons.push('id_keyword'); }

      // Skip elements that scored too low
      if (score < 3) continue;

      // Mark all children as processed so nested fixed descendants are not
      // counted as separate blockers.
      for (const child of el.querySelectorAll('*')) processedEls.add(child);
      processedEls.add(el);

      // Find dismiss controls inside this blocker
      const dismissButtons = findDismissButtons(el);
      if (dismissButtons.length > 0) {
        score += 1;
        reasons.push('has_dismiss_button');
      }

      const centerX = Math.round(rect.left + rect.width  / 2);
      const centerY = Math.round(rect.top  + rect.height / 2);

      results.push({
        selector:       buildSelector(el),
        score,
        coverage:       {
          w: Math.round(coverW * 100) / 100,
          h: Math.round(coverH * 100) / 100,
        },
        zIndex,
        reasons,
        centerX,
        centerY,
        dismissButtons,
      });

      if (results.length >= maxBlockers) break;
    }

    // Return highest-scored blockers first
    results.sort((a, b) => b.score - a.score);
    return results;
  }, params);
}

// ── Media control ─────────────────────────────────────────────────────────────

/**
 * Pause and mute all auto-playing video/audio elements on the page.
 *
 * Autoplay media must be stopped before:
 *   - overlay detection (video overlays create false positives)
 *   - baseline screenshot (paused frame is more representative)
 *   - auto-dynamic region detection (continuous updates create noise)
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<number>}  Number of media elements paused.
 */
async function _pauseMedia(page) {
  return page.evaluate(() => {
    let count = 0;
    for (const media of document.querySelectorAll('video, audio')) {
      try {
        if (!media.paused) {
          media.pause();
          count++;
        }
        // Always mute — prevents audio even if pause fails
        if (!media.muted) {
          media.muted = true;
        }
      } catch {
        // best-effort; ignore individual failures
      }
    }
    return count;
  }).catch(() => 0);
}

// ── Dismiss helpers ───────────────────────────────────────────────────────────

/**
 * Check whether a previously detected blocker is still present by inspecting
 * the element at the blocker's center coordinates.
 *
 * Uses hit-testing (elementFromPoint) rather than a CSS selector query to
 * avoid selector-uniqueness issues.  Returns true (gone) if:
 *   - no element is found at those coordinates
 *   - the top-most element is body/html
 *   - the top-most element is not fixed/sticky
 *   - the top-most element has a z-index below minZIndex
 *
 * @param {import('playwright').Page} page
 * @param {number} cx  Blocker center X (viewport coordinates)
 * @param {number} cy  Blocker center Y (viewport coordinates)
 * @param {number} minZIndex
 * @returns {Promise<boolean>}  true = blocker is gone, false = still present
 */
async function _isBlockerGone(page, cx, cy, minZIndex) {
  return page.evaluate(({ cx, cy, minZIndex }) => {
    const el = document.elementFromPoint(cx, cy);
    if (!el) return true;
    if (el === document.body || el === document.documentElement) return true;

    const style  = window.getComputedStyle(el);
    const pos    = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') return true;

    const zIndex = parseInt(style.zIndex) || 0;
    return zIndex < minZIndex;
  }, { cx, cy, minZIndex }).catch(() => true); // assume gone on error
}

/**
 * Apply CSS visibility:hidden and pointer-events:none to elements matching
 * the given selector — Stage 4 last-resort neutralization.
 *
 * Uses `!important` to override site stylesheets.
 * Sets `data-stabilizer-hidden` attribute so the readiness check can skip
 * already-hidden elements.
 *
 * @param {import('playwright').Page} page
 * @param {string} selector  CSS selector for the target element(s).
 * @returns {Promise<boolean>}  true if at least one element was hidden.
 */
async function _hideElement(page, selector) {
  return page.evaluate((sel) => {
    try {
      const targets = document.querySelectorAll(sel);
      if (!targets.length) return false;
      for (const el of targets) {
        el.style.setProperty('visibility',    'hidden', 'important');
        el.style.setProperty('pointer-events', 'none',  'important');
        el.setAttribute('data-stabilizer-hidden', 'true');
      }
      return true;
    } catch {
      return false;
    }
  }, selector).catch(() => false);
}

// ── Readiness check ───────────────────────────────────────────────────────────

/**
 * Heuristic check: does the page appear ready for analysis?
 *
 * Scans all visible fixed/sticky elements again with a more lenient threshold
 * (1.5× coverageThreshold in BOTH dimensions) to identify any remaining
 * significant blocker.
 *
 * Returns { ready: true } if no high-coverage blocker remains.
 *
 * @param {import('playwright').Page} page
 * @param {{ coverageThreshold: number, minZIndex: number }} params
 * @returns {Promise<{ ready: boolean, reason: string }>}
 */
async function _checkPageReady(page, { coverageThreshold, minZIndex }) {
  return page.evaluate(({ coverageThreshold, minZIndex }) => {
    const vw = window.innerWidth  || 800;
    const vh = window.innerHeight || 600;
    // Use a slightly higher bar than detection so small sticky headers do not
    // cause false "still blocked" results.
    const threshold = coverageThreshold * 1.5;

    for (const el of document.querySelectorAll('*')) {
      if (el === document.body || el === document.documentElement) continue;
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      if (style.display    === 'none')    continue;
      if (style.visibility === 'hidden')  continue;
      if (parseFloat(style.opacity) < 0.05) continue;
      // Skip elements already neutralized by Stage 4
      if (el.getAttribute('data-stabilizer-hidden')) continue;

      const rect   = el.getBoundingClientRect();
      const coverW = rect.width  / vw;
      const coverH = rect.height / vh;
      const zIndex = parseInt(style.zIndex) || 0;

      if (coverW > threshold && coverH > threshold && zIndex >= minZIndex) {
        const tag  = el.tagName.toLowerCase();
        const hint = el.id ? `#${el.id}` : (el.className ? `.${String(el.className).split(' ')[0]}` : '');
        return {
          ready:  false,
          reason: `blocking element still present: <${tag}${hint}> z-index=${zIndex} coverage=${(coverW*100).toFixed(0)}%×${(coverH*100).toFixed(0)}%`,
        };
      }
    }

    return { ready: true, reason: 'no significant blocking elements detected' };
  }, { coverageThreshold, minZIndex })
    .catch(() => ({ ready: true, reason: 'readiness check failed — continuing in degraded mode' }));
}
