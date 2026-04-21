/**
 * core/phase1/compactOutput.js
 *
 * Builds a compact, QA-oriented page model from Phase 1 + Phase 3 data.
 * Used when OUTPUT_MODE=compact (the default).
 *
 * Design principle:
 *   The output is not a DOM archive. It is a task-oriented QA page model.
 *   It answers: "What can the user do? What changed? Where can they go next?"
 *
 * Two modes:
 *   compact (default) — lean functional summary, optimized for AI scenario generation
 *   debug             — full extraction detail, suitable for diagnosis
 *
 * Only compact mode logic lives here. Debug mode keeps the full existing report shape.
 */

// Functional categories to keep in compact output.
// All others (structural wrappers, decorative, unknown) are dropped.
const KEEP_CATEGORIES = new Set([
  'login', 'modal', 'search', 'form', 'tab', 'dropdown',
  'checkbox', 'button', 'nav', 'pagination', 'input',
]);

// Headings to keep as assertion targets (h1–h3 only)
const HEADING_KEEP_TAGS = new Set(['h1', 'h2', 'h3']);

// Only keep links with a real navigable href
const REAL_HREF_RE = /^https?:|^\//;

// Action type mapping per functional category
const ACTION_TYPE = {
  button:     'click',
  login:      'click',
  tab:        'click',
  modal:      'click',
  nav:        'navigate',
  link:       'navigate',
  pagination: 'click',
  search:     'fill',
  input:      'fill',
  form:       'fill',
  dropdown:   'select',
  checkbox:   'toggle',
  heading:    'assert',
};

// ── Element selection ────────────────────────────────────────────────────────

// Groups that are low-value for QA scenario generation when they only contain links
const LOW_VALUE_LINK_GROUPS = new Set(['footer']);

/**
 * Returns true when a node is QA-relevant and should appear in compact output.
 *
 * Rules:
 *  1. Any node in KEEP_CATEGORIES is kept.
 *  2. Links are kept only when they have real href + non-empty text,
 *     AND are not in a footer-only group (too low value).
 *  3. Headings are kept only for h1–h3 with non-empty text (assertion targets).
 *  4. Everything else is dropped.
 */
function isQaRelevant(node) {
  const cat  = node.functionalCategory;
  const text = (node.text ?? '').trim();

  if (KEEP_CATEGORIES.has(cat)) return true;

  if (cat === 'link') {
    const href  = node.href ?? '';
    const group = node.group ?? '';
    // Drop footer-only links — they are company info, not user flows
    if (LOW_VALUE_LINK_GROUPS.has(group)) return false;
    return text.length > 0 && REAL_HREF_RE.test(href);
  }

  if (cat === 'heading') {
    return HEADING_KEEP_TAGS.has(node.tagName) && text.length > 0;
  }

  return false;
}

// ── Importance scoring ────────────────────────────────────────────────────────

function getImportance(cat) {
  if (cat === 'login' || cat === 'modal' || cat === 'search') return 'high';
  if (cat === 'button' || cat === 'form')                      return 'high';
  if (cat === 'nav' || cat === 'tab' || cat === 'dropdown')    return 'medium';
  if (cat === 'input' || cat === 'checkbox' || cat === 'pagination') return 'medium';
  return 'low';
}

// ── Locator builder ──────────────────────────────────────────────────────────

/**
 * Build a compact, prioritized locator bundle for a node.
 * Strategies (in preference order): testId → role+name → placeholder → label → text → css
 *
 * This is intentionally small — only include what a QA engineer or AI planner
 * would reach for first in Playwright.
 */
function buildLocators(node) {
  const locators = [];
  const { tagName, role, text, selectorHint, id } = node;
  const safeText = (text ?? '').trim();

  // 1. testId (from data-testid attribute)
  const testIdMatch = selectorHint?.match(/\[data-testid="([^"]+)"\]/);
  if (testIdMatch) locators.push({ strategy: 'testId', value: testIdMatch[1] });

  // 2. role + accessible name
  if (role && safeText) {
    locators.push({ strategy: 'role', role, name: safeText.slice(0, 80) });
  }

  // 3. placeholder (for input elements)
  if (node.placeholder) locators.push({ strategy: 'placeholder', value: node.placeholder });

  // 4. label text (for labeled inputs)
  if (node.label) locators.push({ strategy: 'label', value: node.label });

  // 5. visible text (for buttons and links)
  if (safeText.length > 0 && safeText.length <= 80 && ['button', 'a', 'summary'].includes(tagName)) {
    locators.push({ strategy: 'text', value: safeText });
  }

  // 6. CSS fallback (id preferred, then selectorHint if short)
  if (id) {
    locators.push({ strategy: 'css', value: `#${id}` });
  } else if (selectorHint && selectorHint.length <= 100) {
    locators.push({ strategy: 'css', value: selectorHint });
  }

  return locators;
}

// ── Element projection ────────────────────────────────────────────────────────

function toCompactElement(node) {
  const cat      = node.functionalCategory ?? 'unknown';
  const safeText = (node.text ?? '').trim();
  // Only include non-null, non-redundant fields
  const el = {
    id:         node.nodeId,
    category:   cat,
    tag:        node.tagName,
    actionType: ACTION_TYPE[cat] ?? 'click',
    importance: getImportance(cat),
    locators:   buildLocators(node),
    bbox:       node.bbox ?? null,
  };
  if (safeText)       el.text  = safeText.slice(0, 120);
  if (node.href)      el.href  = node.href;
  if (node.type)      el.type  = node.type;
  if (node.role)      el.role  = node.role;
  if (node.group)     el.group = node.group;
  return el;
}

// ── Region grouping ──────────────────────────────────────────────────────────

/**
 * Group nodes by their layout `group` field, keeping only QA-relevant elements
 * per region. Returns a compact region summary per group.
 *
 * Repeated item groups (nav with 20 identical links, product grids, etc.) are
 * summarised: only 5 representative elements are kept, plus a totalCount.
 */
function buildRegions(allNodes) {
  const buckets = {};
  for (const node of allNodes) {
    const g = node.group ?? 'unknown';
    if (!buckets[g]) buckets[g] = [];
    buckets[g].push(node);
  }

  const regions = [];
  for (const [regionType, nodes] of Object.entries(buckets)) {
    const relevant = nodes.filter(isQaRelevant);
    if (relevant.length === 0) continue;

    // For large repeated groups, show only representative items
    const MAX_ITEMS = 8;
    const isLargeRepeated = relevant.length > MAX_ITEMS;
    const sample = isLargeRepeated ? relevant.slice(0, MAX_ITEMS) : relevant;

    regions.push({
      regionType,
      totalNodeCount:   nodes.length,
      keptElementCount: relevant.length,
      ...(isLargeRepeated ? { note: `Showing ${MAX_ITEMS} of ${relevant.length} kept elements` } : {}),
      elementIds: sample.map((n) => n.nodeId),
    });
  }

  return regions;
}

// ── Trigger result compaction ─────────────────────────────────────────────────

/**
 * Reduce trigger results to delta-only summaries.
 *
 * Excludes:
 *   - skipped triggers
 *   - successful triggers with no DOM change and no navigation
 *
 * Includes only what matters for QA:
 *   - summary text
 *   - delta element count + compact new elements
 *   - navigation if it occurred
 *   - auth signals
 *   - screenshot path (annotated preferred)
 */
function buildCompactTriggerResults(triggerResults) {
  const compact = [];

  for (const r of triggerResults) {
    if (r.status === 'skipped') continue;

    const hasNav   = r.navigationDetected;
    const hasAuth  = r.authDetected;
    // Only count QA-relevant new elements (not raw mutation noise)
    const qaNewElements = (r.deltaLabelNodes ?? []).filter(isQaRelevant);
    const hasMeaningfulDelta = qaNewElements.length > 0;

    // Drop triggers with only raw mutations but no QA-relevant new elements
    // and no navigation/auth signal — pure animation/carousel noise
    if (!hasMeaningfulDelta && !hasNav && !hasAuth) continue;

    const newElements = qaNewElements
      .slice(0, 15)
      .map((n) => {
        const el = {
          id:       n.nodeId,
          category: n.functionalCategory ?? 'unknown',
          tag:      n.tagName,
          bbox:     n.bbox ?? null,
        };
        const t = (n.text ?? '').trim();
        if (t) el.text = t.slice(0, 80);
        return el;
      });

    const entry = {
      triggerId:       r.triggerId,
      status:          r.status,
      action:          r.action,
      summary:         r.summary,
      newElementCount: qaNewElements.length,
    };
    if (r.annotatedScreenshot ?? r.afterScreenshot) {
      entry.screenshot = r.annotatedScreenshot ?? r.afterScreenshot;
    }
    if (newElements.length > 0) entry.newElements = newElements;
    if (hasNav) {
      entry.navigationDetected = true;
      if (r.navigatedToUrl) entry.navigatedToUrl = r.navigatedToUrl;
    }
    if (hasAuth) {
      entry.authDetected   = true;
      entry.authScore      = r.authScore ?? null;
      entry.authConfidence = r.authConfidence ?? null;
    }
    compact.push(entry);
  }

  return compact;
}

// ── Candidate URL list ────────────────────────────────────────────────────────

/**
 * Build lean next-candidate list from queue items.
 * Only includes fields needed for BFS planning and reporting.
 */
function buildCompactCandidates(queueItems) {
  // Drop duplicates/already-analyzed — not useful for QA planning
  const SKIP_DECISIONS = new Set(['skip_duplicate_path', 'skip_already_analyzed']);
  return queueItems
    .filter((item) => !SKIP_DECISIONS.has(item.enqueueDecision))
    .map((item) => ({
      url:          item.targetUrl,
      normalizedPath: item.normalizedPath ?? null,
      decision:     item.enqueueDecision,
      reason:       item.enqueueReason ?? item.skipReason ?? null,
      authRequired: item.enqueueDecision === 'hold_auth_required' ||
                    item.preflight?.reachabilityClass === 'auth_required' ||
                    item.preflight?.reachabilityClass === 'user_input_required',
    }));
}

// ── Warnings ─────────────────────────────────────────────────────────────────

function buildWarnings({ analysisQualityNote, evaluateDegradation, screenshotDomUrlDrift, phase1QualityState, stabilizationWarnings }) {
  const warnings = [];

  if (analysisQualityNote) {
    warnings.push(analysisQualityNote);
  }
  if (phase1QualityState && phase1QualityState !== 'analyzed_successfully') {
    warnings.push(`Phase 1 quality: ${phase1QualityState}`);
  }
  if (screenshotDomUrlDrift) {
    warnings.push(`URL drift: ${screenshotDomUrlDrift}`);
  }
  if (evaluateDegradation) {
    for (const [step, info] of Object.entries(evaluateDegradation)) {
      if (info?.degraded) {
        warnings.push(`evaluate degraded at '${step}': ${info.reason ?? 'unknown'}`);
      }
    }
  }
  if (Array.isArray(stabilizationWarnings)) {
    for (const w of stabilizationWarnings) {
      if (typeof w === 'string') warnings.push(w);
    }
  }

  // Deduplicate
  return [...new Set(warnings)].filter(Boolean);
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function buildMetrics({
  rawNodeCount,
  compactElementCount,
  droppedFromCompact,
  compactRegionCount,
  rawTriggerCount,
  compactTriggerCount,
  candidateCount,
  outputMode,
}) {
  return {
    outputMode,
    rawNodeCount,
    compactElementCount,
    droppedNodeCount:          droppedFromCompact,
    compactRegionCount,
    rawTriggerCount,
    compactTriggerResultCount: compactTriggerCount,
    candidateCount,
    estimatedReductionRatio:   rawNodeCount > 0
      ? Math.round((1 - compactElementCount / rawNodeCount) * 100) + '%'
      : null,
  };
}

// ── Main builder ─────────────────────────────────────────────────────────────

/**
 * Build the compact QA-oriented final report.
 *
 * All runtime variables are passed in explicitly so this function remains
 * pure and testable without Playwright context.
 *
 * @param {object} p
 * @returns {object}  compact final-report
 */
export function buildCompactReport({
  // Identifiers
  jobId,
  startedAt,
  finishedAt,
  currentPageStatus,
  outputMode,

  // Page identity
  originalUrl,
  requestUrl,
  finalUrl,
  rootHost,
  pageMeta,
  inputIdentity,
  inputNode,
  inputNodeCreated,

  // Phase 1 data
  allNodes,
  allCandidates,
  triggerResults,
  authGatedDiscoveries,
  phase1Summary,

  // Quality / stability signals
  finalQuality,
  analysisQualityNote,
  evaluateDegradation,
  screenshotCapturedAtUrl,
  staticNodesExtractedAtUrl,
  postAuthMode,
  analysisRetryAttempted,
  analysisRetrySucceeded,
  liteExtractionUsed,
  stabResult,

  // Phase 3 data
  queueItems,
  queueReadyCount,
  holdCount,
  skippedCount,

  // Graph / crawl metadata
  graphNodeCreatedCount,
  graphEdgeCreatedCount,

  // Output helpers
  jobDirName,
  toRelPath,
}) {
  // ── Derived signals ────────────────────────────────────────────────────────
  const screenshotDomUrlDrift =
    screenshotCapturedAtUrl && staticNodesExtractedAtUrl &&
    screenshotCapturedAtUrl !== staticNodesExtractedAtUrl
      ? `screenshot@${screenshotCapturedAtUrl} vs DOM@${staticNodesExtractedAtUrl}`
      : null;

  // ── Build compact data ─────────────────────────────────────────────────────
  const keptNodes       = allNodes.filter(isQaRelevant);
  const droppedCount    = allNodes.length - keptNodes.length;
  const compactElements = keptNodes.map(toCompactElement);
  const compactRegions  = buildRegions(allNodes);
  const compactTriggers = buildCompactTriggerResults(triggerResults);
  const compactCandidates = buildCompactCandidates(queueItems);

  const warnings = buildWarnings({
    analysisQualityNote,
    evaluateDegradation,
    screenshotDomUrlDrift,
    phase1QualityState: finalQuality.phase1QualityState,
    stabilizationWarnings: stabResult?.warnings,
  });

  const metrics = buildMetrics({
    outputMode,
    rawNodeCount:         allNodes.length,
    compactElementCount:  compactElements.length,
    droppedFromCompact:   droppedCount,
    compactRegionCount:   compactRegions.length,
    rawTriggerCount:      triggerResults.length,
    compactTriggerCount:  compactTriggers.length,
    candidateCount:       compactCandidates.length,
  });

  // ── Assemble report ────────────────────────────────────────────────────────
  return {
    jobId,
    startedAt,
    finishedAt,
    outputMode,

    // ── Page identity ─────────────────────────────────────────────────────────
    page: {
      finalUrl,
      title:          pageMeta.title ?? null,
      hostname:       inputIdentity.hostname,
      normalizedPath: inputIdentity.normalizedPath,
      status:         currentPageStatus,
      authContextUsed: postAuthMode,
      screenshots: {
        baseline:          toRelPath('outputs', jobDirName, 'baseline.png'),
        baselineAnnotated: toRelPath('outputs', jobDirName, 'baseline-annotated.png'),
      },
    },

    // ── Meaningful layout regions (grouped) ──────────────────────────────────
    regions: compactRegions,

    // ── QA-relevant interactive elements ─────────────────────────────────────
    elements: compactElements,

    // ── Trigger delta results (only meaningful changes) ──────────────────────
    triggerResults: compactTriggers,

    // ── Auth-gated discoveries from trigger navigation ────────────────────────
    ...(authGatedDiscoveries.length > 0 ? {
      authGatedDiscoveries: authGatedDiscoveries.map((d) => ({
        triggerId:        d.triggerId,
        targetUrl:        d.targetUrl,
        navigationStatus: d.navigationStatus,
        authScore:        d.authScore,
        requiresAuth:     d.requiresAuth,
      })),
    } : {}),

    // ── Next URL candidates for BFS planning ─────────────────────────────────
    nextCandidates: compactCandidates,

    // ── Warnings and quality signals ─────────────────────────────────────────
    warnings,

    // ── Reduction metrics ─────────────────────────────────────────────────────
    metrics,

    // ── Internal BFS / crawl metadata (not for QA consumption) ──────────────
    // This section is read by crawlRunner.js and route handlers to drive BFS.
    // It is kept compact but structurally stable.
    _crawl: {
      originalUrl,
      requestUrl,
      rootHost,
      inputPage: {
        requestUrl,
        finalUrl,
        nodeId:           inputNode.nodeId,
        dedupKey:         inputIdentity.dedupKey,
        normalizedPath:   inputIdentity.normalizedPath,
        displayPath:      inputIdentity.displayPath ?? inputIdentity.normalizedPath,
        graphNodeCreated: inputNodeCreated,
      },
      queueReadyCount,
      holdCount,
      skippedCount,
      graphUpdate: {
        inputNodeCreated,
        candidateNodeCreated: graphNodeCreatedCount,
        graphEdgeCreatedCount,
      },
      phase1Summary: {
        rawNodeCount:             phase1Summary.rawNodeCount,
        triggerCandidateCount:    phase1Summary.triggerCandidateCount,
        triggerExecutedCount:     phase1Summary.triggerExecutedCount,
        changedTriggerCount:      phase1Summary.changedTriggerCount,
        navigatedAwayCount:       phase1Summary.navigatedAwayCount,
        authDetectedTriggerCount: phase1Summary.authDetectedTriggerCount,
        analysisRetryAttempted,
        analysisRetrySucceeded,
        liteExtractionUsed,
      },
    },
  };
}
