/**
 * phase1/analysisQuality.js
 *
 * Phase 1 quality classification and annotation-node selection helpers.
 *
 * Separate from runAnalysis.js so quality logic can be read and tested
 * in isolation from the browser orchestration.
 */

/**
 * Classify Phase 1 extraction results into one of six quality states.
 *
 * States:
 *   analyzed_successfully         — all steps passed, DOM and links extracted
 *   analyzed_partially            — some steps degraded but data was recovered
 *   screenshot_only_no_dom        — screenshot exists but DOM empty (render not ready)
 *   context_destroyed_mid_analysis — context destroyed during evaluate, 0 nodes
 *   post_auth_unstable            — same as above but inside a post-auth context
 *   failed_analysis               — no screenshot, no DOM, no links
 */
export function computePhase1Quality({ evaluateDegradation, allNodes, pageLinks, screenshotExists, postAuthMode }) {
  const rawNodeCount  = allNodes?.length ?? 0;
  const totalLinks    = (pageLinks?.anchors?.length ?? 0) +
                        (pageLinks?.areas?.length ?? 0) +
                        (pageLinks?.formActions?.length ?? 0);
  const anyDegraded   = Object.values(evaluateDegradation).some((v) => v.degraded);
  const nodesDegraded = evaluateDegradation?.extractStaticNodes?.degraded === true;
  const linksDegraded = evaluateDegradation?.getPageLinks?.degraded === true;

  let phase1QualityState;
  let emptyResultCause = null;

  if (rawNodeCount === 0 && totalLinks === 0) {
    if (nodesDegraded) {
      if (postAuthMode) {
        phase1QualityState = 'post_auth_unstable';
        emptyResultCause   = 'empty_due_to_post_auth_instability';
      } else {
        phase1QualityState = 'context_destroyed_mid_analysis';
        emptyResultCause   = 'empty_due_to_context_destruction';
      }
    } else if (screenshotExists) {
      // Screenshot present but DOM empty — likely CSP, skeleton loaders, or JS not mounted
      phase1QualityState = 'screenshot_only_no_dom';
      emptyResultCause   = 'empty_due_to_render_not_ready';
    } else {
      phase1QualityState = 'failed_analysis';
      emptyResultCause   = 'empty_due_to_no_meaningful_nodes';
    }
  } else if (rawNodeCount > 0 && !anyDegraded) {
    phase1QualityState = 'analyzed_successfully';
  } else if (rawNodeCount > 0 || totalLinks > 0) {
    phase1QualityState = 'analyzed_partially';
    if (nodesDegraded || linksDegraded) {
      emptyResultCause = 'empty_due_to_context_destruction';
    }
  } else {
    phase1QualityState = 'failed_analysis';
    emptyResultCause   = 'empty_due_to_no_meaningful_nodes';
  }

  return {
    phase1QualityState,
    domExtractionSucceeded:   rawNodeCount > 0,
    linksExtractionSucceeded: totalLinks > 0,
    rawNodeCount,
    totalLinks,
    emptyResultCause,
  };
}

/**
 * Build human-readable diagnostic notes for the final report.
 * Returns plain English strings that explain what happened during Phase 1.
 */
export function buildHumanReadableNotes({ phase1QualityState, screenshotExists,
  analysisRetryAttempted, analysisRetrySucceeded, emptyResultCause, postAuthMode }) {
  const notes = [];

  switch (phase1QualityState) {
    case 'analyzed_successfully':
      notes.push('Phase 1 analysis completed successfully — DOM, links, and structural data extracted.');
      break;
    case 'analyzed_partially':
      notes.push('Phase 1 analysis partially succeeded — some extraction steps degraded, but data was recovered.');
      break;
    case 'screenshot_only_no_dom':
      notes.push('Baseline screenshot was captured, but DOM extraction failed — the page was visually loaded but the DOM was empty or not ready.');
      notes.push('This may indicate aggressive CSP, skeleton-loader patterns, or JS mounting not yet complete at extraction time.');
      break;
    case 'context_destroyed_mid_analysis':
      notes.push('Baseline screenshot was captured, but DOM extraction failed due to execution context destruction.');
      notes.push('The SPA navigation defense was active, but the V8 context was destroyed before or during page.evaluate() calls.');
      break;
    case 'post_auth_unstable':
      notes.push('Post-auth SPA navigation caused instability that prevented DOM extraction.');
      notes.push('The page appeared to navigate repeatedly after login, preventing a stable evaluate window.');
      break;
    case 'failed_analysis':
      notes.push('Analysis failed catastrophically — no screenshot, no DOM data, and no links were extracted.');
      break;
  }

  const degradedButHasScreenshot = screenshotExists &&
    ['context_destroyed_mid_analysis', 'post_auth_unstable', 'screenshot_only_no_dom']
      .includes(phase1QualityState);
  if (degradedButHasScreenshot) {
    notes.push('The existence of a baseline screenshot does NOT mean the page was successfully analyzed — DOM extraction failed independently.');
  }

  if (analysisRetryAttempted) {
    notes.push(analysisRetrySucceeded
      ? 'Analysis was retried once in a fresh authenticated context — retry improved the DOM extraction result.'
      : 'Analysis was retried once in a fresh authenticated context — retry did not improve the result.');
  }

  if (postAuthMode && ['context_destroyed_mid_analysis', 'post_auth_unstable'].includes(phase1QualityState)) {
    notes.push('Page was marked partial/failed instead of success because structural DOM was empty despite a valid authenticated session.');
  }

  return notes;
}

/**
 * Select up to `limit` nodes from `allNodes` for baseline screenshot annotation.
 *
 * Priority order (lower = annotated first):
 *   1 — interactive leaf elements (a, button, input, select, textarea, summary, label)
 *   2 — media elements (img, video, canvas, svg, picture)
 *   3 — headings (h1–h6)
 *   4 — list items (li)
 *   5 — semantic blocks (header, nav, main, footer, section, article, aside, form, ...)
 *   6 — everything else
 *
 * Within each group, nodes are sorted by focusScore descending then bbox area ascending.
 */
export function selectAnnotationNodes(allNodes, limit) {
  const INTERACTIVE = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'label']);
  const MEDIA       = new Set(['img', 'video', 'canvas', 'svg', 'picture']);
  const HEADING     = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  const LIST_ITEM   = new Set(['li']);
  const SEMANTIC    = new Set([
    'header', 'nav', 'main', 'footer', 'section', 'article',
    'aside', 'form', 'table', 'ul', 'ol', 'dialog', 'details',
  ]);
  const SKIP        = new Set(['body', 'html']);

  function priority(n) {
    const tag = n.tagName;
    if (SKIP.has(tag))        return 99;
    if (INTERACTIVE.has(tag)) return 1;
    if (MEDIA.has(tag))       return 2;
    if (HEADING.has(tag))     return 3;
    if (LIST_ITEM.has(tag))   return 4;
    if (SEMANTIC.has(tag))    return 5;
    return 6;
  }

  return allNodes
    .filter((n) => !SKIP.has(n.tagName))
    .sort((a, b) => {
      const pd = priority(a) - priority(b);
      if (pd !== 0) return pd;
      const fd = (b.focusScore ?? 0) - (a.focusScore ?? 0);
      if (fd !== 0) return fd;
      return (a.bbox.width * a.bbox.height) - (b.bbox.width * b.bbox.height);
    })
    .slice(0, limit);
}
