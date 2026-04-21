/**
 * core/labelFilter.js
 *
 * WHERE LABEL-WORTHINESS SCORING AND FILTERING HAPPENS.
 *
 * Implements the two-layer annotation output model:
 *
 *   rawNodes           — full extraction output from staticAnalysis (unchanged)
 *   labelEligibleNodes — subset that should receive visible screenshot labels
 *
 * DESIGN GOAL
 * ───────────
 * Optimize for labeling what is meaningful to a QA-oriented human reviewer,
 * not for labeling everything that is visible.
 *
 * A visible element is not automatically a good label target.
 * A div container is not automatically useless either.
 *
 * FILTERING PIPELINE (applied in order)
 * ──────────────────────────────────────
 * 1. labelScore computation  — category base score + confidence/focus adjustments
 * 2. Minimum score threshold — controlled by labelMode or explicit labelMinScore
 * 3. Parent-child dedup      — suppress lower-value nodes substantially contained
 *                              by a higher-scoring accepted ancestor node
 * 4. Repeated-item dedup     — cap representative labels for card/link/media grids
 *                              that exceed a threshold count
 * 5. maxLabelsPerViewport cap — hard upper bound on annotation count
 *
 * ALWAYS-PRESERVED CATEGORIES (never suppressed by any rule):
 *   login, modal, search, form, button, input, checkbox, dropdown, tab
 *
 * EXPORTS
 * ───────
 *   LABEL_FILTER_DEFAULTS                         — default config object
 *   computeLabelScore(node)                       → { score, reasons }
 *   applyLabelFilter(classifiedNodes, opts)
 *       → { labelEligibleNodes, debugEntries, filterStats }
 */

// ── Category base scores for label worthiness ─────────────────────────────────
//
// Higher = more important to a QA reviewer.
// Designed so that actionable / task-critical elements score high,
// and pure structural/decorative elements score low by default.
const CATEGORY_LABEL_BASE_SCORE = {
  login:      8,  // critical: auth testing, user registration
  modal:      7,  // critical: dialog/overlay testing
  search:     7,  // key user task: search is always QA-relevant
  input:      6,  // form field: always QA-relevant
  form:       6,  // form container: critical for form testing
  tab:        5,  // state testing: tabs/accordions change visible content
  dropdown:   5,  // interaction testing: select affects state/results
  checkbox:   5,  // state testing: toggle/filter controls
  button:     5,  // actionable: CTAs, actions, controls
  nav:        4,  // navigation context: menus, site structure
  pagination: 4,  // navigation: paging through results
  card:       4,  // repeated content: product cards, article items, etc.
  link:       3,  // navigation/content: may or may not be meaningful
  heading:    2,  // structural text: often just visual hierarchy
  media:      2,  // informational: images/video rarely the QA target
  banner:     1,  // often decorative: ads, promo banners rarely need labels
  layout:     1,  // mostly structural: header/footer regions evident
  unknown:    0,  // no classification found: usually noise
};

// ── labelMode to minimum label score mapping ──────────────────────────────────
const LABEL_MODE_MIN_SCORE = {
  dense:    2,   // keep most elements; only obvious noise removed
  balanced: 4,   // default: remove clear noise, preserve QA-relevant elements
  minimal:  7,   // strict: only high-confidence QA-critical elements
};

// ── Maximum representative labels per repeated-item group ─────────────────────
const REPEATED_ITEM_MAX_REPRESENTATIVES = {
  dense:    8,
  balanced: 5,
  minimal:  2,
};

// ── Minimum group size to trigger repeated-item dedup ─────────────────────────
const REPEATED_ITEM_THRESHOLD = 7;

// ── Categories never suppressed by parent/child or repeated-item rules ────────
// These represent high-confidence QA targets that must always be labeled.
const ALWAYS_PRESERVE_CATEGORIES = new Set([
  'login', 'modal', 'search', 'form', 'button', 'input', 'checkbox', 'dropdown', 'tab',
]);

// ── Container categories that may suppress low-value children ─────────────────
const CONTAINER_CATEGORIES = new Set([
  'nav', 'card', 'form', 'modal', 'layout', 'tab', 'banner', 'unknown',
]);

// ── Low-value child categories that can be suppressed by a container parent ───
const LOW_VALUE_CHILD_CATEGORIES = new Set([
  'unknown', 'layout', 'link', 'heading', 'media', 'banner',
]);

// ── Categories eligible for repeated-item deduplication ───────────────────────
const REPEATABLE_CATEGORIES = new Set(['card', 'link', 'media', 'heading', 'nav']);

// ── Default configuration ──────────────────────────────────────────────────────
export const LABEL_FILTER_DEFAULTS = {
  // 'dense' | 'balanced' | 'minimal'
  labelMode:                               'balanced',
  // Override the minimum score directly (null = derived from labelMode)
  labelMinScore:                            null,
  // Suppress lower-value nodes whose bbox is substantially inside a higher-scoring node
  suppressChildLabelsWhenParentIsSufficient: true,
  // Cap repeated card/link/media grids to a small number of representative labels
  preferGroupLabelingForRepeatedItems:       true,
  // Hard cap on total labeled nodes per page
  maxLabelsPerViewport:                     200,
  // Write per-node filtering decision to label-filter-debug.json
  debugFilter:                              false,
};

// ── Label score computation ───────────────────────────────────────────────────

/**
 * Compute a label-worthiness score for a single classified DOM node.
 *
 * Uses functional category, classification confidence, focusScore (from
 * staticAnalysis), qualityReasons (for div/span/p), and bbox area.
 *
 * Score range: typically −6 to +12. Positive = worth labeling.
 *
 * @param {object} node — classified DOM node (after classifyNodes)
 * @returns {{ score: number, reasons: string[] }}
 */
export function computeLabelScore(node) {
  const category   = node.functionalCategory             ?? 'unknown';
  const confidence = node.functionalCategoryConfidence   ?? 0.5;
  const focusScore = node.focusScore                     ?? 0;
  const text       = (node.text                          ?? '').trim();
  const qReasons   = node.qualityReasons                 ?? [];
  const bbox       = node.bbox                           ?? { x: 0, y: 0, width: 0, height: 0 };
  const area       = bbox.width * bbox.height;

  const reasons = [];

  // ── 1. Base score from functional category ─────────────────────────────────
  const base = CATEGORY_LABEL_BASE_SCORE[category] ?? 0;
  let score  = base;
  reasons.push(`base(${category})=${base}`);

  // ── 2. Classification confidence bonus ─────────────────────────────────────
  if      (confidence >= 0.85) { score += 2; reasons.push('high_confidence+2');  }
  else if (confidence >= 0.70) { score += 1; reasons.push('good_confidence+1');  }
  else if (confidence <  0.50) { score -= 1; reasons.push('low_confidence-1');   }

  // ── 3. Focus score adjustment ──────────────────────────────────────────────
  // focusScore (from staticAnalysis.computeFocusScore) encodes interactivity,
  // viewport centrality, text richness, and semantic tag importance.
  if      (focusScore >= 7)  { score += 2; reasons.push('high_focus+2');   }
  else if (focusScore >= 4)  { score += 1; reasons.push('med_focus+1');    }
  else if (focusScore <= -2) { score -= 2; reasons.push('neg_focus-2');    }
  else if (focusScore <  0)  { score -= 1; reasons.push('low_focus-1');    }

  // ── 4. Quality reason penalties ────────────────────────────────────────────
  // These come from scoreGenericNode and only appear on div/span/p nodes.
  if (qReasons.includes('duplicate_bbox_parent')) { score -= 2; reasons.push('dup_bbox-2');      }
  if (qReasons.includes('single_child_wrapper'))  { score -= 1; reasons.push('single_child-1');  }
  if (qReasons.includes('empty_container'))       { score -= 1; reasons.push('empty-1');          }

  // ── 5. Tiny area penalty ───────────────────────────────────────────────────
  // Small elements are usually decorative icons or badge indicators — but
  // interactive small elements (button, input, checkbox) are still meaningful.
  const SMALL_EXEMPT = new Set(['button', 'input', 'checkbox', 'link', 'login']);
  if (area < 200 && !SMALL_EXEMPT.has(category)) {
    score -= 1;
    reasons.push('tiny_area-1');
  }

  // ── 6. Category-specific corrections ──────────────────────────────────────
  // unknown with poor focus is almost always decorative noise.
  if (category === 'unknown' && focusScore < 2) {
    score -= 2;
    reasons.push('unknown_low_focus-2');
  }

  // layout containers are structural frames — only label them when they have
  // meaningful content (substantive text or reasonable focus score).
  if (category === 'layout' && focusScore <= 1 && text.length < 10) {
    score -= 2;
    reasons.push('layout_no_content-2');
  }

  // heading/media with no visible text and low focus: informational value is low.
  if ((category === 'heading' || category === 'media') && text.length < 3 && focusScore <= 1) {
    score -= 1;
    reasons.push('heading_media_empty-1');
  }

  return { score, reasons };
}

// ── Bbox overlap helper ───────────────────────────────────────────────────────

/**
 * Return what fraction (0.0–1.0) of `inner` bbox is covered by `outer` bbox.
 *
 * @param {{ x:number, y:number, width:number, height:number }} inner
 * @param {{ x:number, y:number, width:number, height:number }} outer
 */
function bboxOverlapFraction(inner, outer) {
  if (!inner || !outer) return 0;
  const ix1 = Math.max(inner.x,              outer.x);
  const iy1 = Math.max(inner.y,              outer.y);
  const ix2 = Math.min(inner.x + inner.width,  outer.x + outer.width);
  const iy2 = Math.min(inner.y + inner.height, outer.y + outer.height);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const interArea = (ix2 - ix1) * (iy2 - iy1);
  const innerArea = inner.width * inner.height;
  return innerArea > 0 ? interArea / innerArea : 0;
}

// ── Main filter function ──────────────────────────────────────────────────────

/**
 * Apply the full label-worthiness filtering pipeline.
 *
 * Mutates each node to add:
 *   labelScore      — computed label-worthiness score
 *   labelEligible   — boolean: true if node survives all filter stages
 *   labelDropReason — string explaining why it was dropped (null if kept)
 *
 * @param {object[]} classifiedNodes — nodes already processed by classifyNodes()
 * @param {object}   opts            — see LABEL_FILTER_DEFAULTS
 * @returns {{
 *   labelEligibleNodes: object[],
 *   debugEntries:       object[],
 *   filterStats:        object,
 * }}
 */
export function applyLabelFilter(classifiedNodes, opts = {}) {
  const cfg = { ...LABEL_FILTER_DEFAULTS, ...opts };
  const {
    labelMode,
    labelMinScore: overrideMinScore,
    suppressChildLabelsWhenParentIsSufficient,
    preferGroupLabelingForRepeatedItems,
    maxLabelsPerViewport,
    debugFilter,
  } = cfg;

  const effectiveMinScore =
    overrideMinScore != null
      ? overrideMinScore
      : (LABEL_MODE_MIN_SCORE[labelMode] ?? LABEL_MODE_MIN_SCORE.balanced);

  const maxReps = REPEATED_ITEM_MAX_REPRESENTATIVES[labelMode]
    ?? REPEATED_ITEM_MAX_REPRESENTATIVES.balanced;

  // ── Step 1: Compute score for every node ───────────────────────────────────
  const scored = classifiedNodes.map((node) => {
    const { score, reasons } = computeLabelScore(node);
    return { node, score, reasons };
  });

  // Start with all nodes eligible; remove as rules fire.
  const eligible = new Set(classifiedNodes.map((n) => n.nodeId));
  const dropInfo = new Map(); // nodeId → { type, reason }

  // ── Step 2: Score threshold gate ──────────────────────────────────────────
  for (const { node, score } of scored) {
    if (ALWAYS_PRESERVE_CATEGORIES.has(node.functionalCategory)) continue;
    if (score < effectiveMinScore) {
      eligible.delete(node.nodeId);
      dropInfo.set(node.nodeId, {
        type:   'low_qa_value',
        reason: `labelScore=${score} < threshold=${effectiveMinScore} (mode=${labelMode})`,
      });
    }
  }

  // ── Step 3: Parent-child deduplication ────────────────────────────────────
  //
  // Sort eligible nodes by bbox area descending (larger node = more likely parent).
  // For each node, check if any already-accepted larger ancestor substantially
  // contains it (≥ 82% overlap).  If so, apply suppression rules:
  //
  //   Rule A: low-value child inside an equal-or-better-scoring parent → suppress
  //   Rule B: any child inside a container parent with score gap ≥ 2  → suppress
  //
  // ALWAYS_PRESERVE categories are never suppressed regardless of overlap.
  if (suppressChildLabelsWhenParentIsSufficient) {
    const eligibleScored = scored
      .filter(({ node }) => eligible.has(node.nodeId))
      .sort((a, b) => {
        const areaA = (a.node.bbox?.width ?? 0) * (a.node.bbox?.height ?? 0);
        const areaB = (b.node.bbox?.width ?? 0) * (b.node.bbox?.height ?? 0);
        return areaB - areaA; // descending: parents first
      });

    const accepted = []; // { node, score } — accepted nodes in area-descending order

    for (const { node, score } of eligibleScored) {
      const isAlwaysPreserve = ALWAYS_PRESERVE_CATEGORIES.has(node.functionalCategory);
      const bbox             = node.bbox;

      if (isAlwaysPreserve || !bbox) {
        accepted.push({ node, score });
        continue;
      }

      let suppressed     = false;
      let suppressReason = null;

      for (const { node: parentNode, score: parentScore } of accepted) {
        const parentBbox = parentNode.bbox;
        if (!parentBbox) continue;

        const overlap = bboxOverlapFraction(bbox, parentBbox);
        if (overlap < 0.82) continue; // not substantially contained

        const childIsLowValue   = LOW_VALUE_CHILD_CATEGORIES.has(node.functionalCategory);
        const parentIsContainer = CONTAINER_CATEGORIES.has(parentNode.functionalCategory);

        // Rule A: low-value child contained by equal-or-better parent
        if (childIsLowValue && parentScore >= score) {
          suppressed     = true;
          suppressReason = `low-value child(${node.functionalCategory} s=${score}) inside ` +
                           `parent(${parentNode.functionalCategory} s=${parentScore}) overlap=${Math.round(overlap * 100)}%`;
          break;
        }
        // Rule B: any child dominated by a container parent (score gap ≥ 2)
        if (parentIsContainer && parentScore >= score + 2) {
          suppressed     = true;
          suppressReason = `container parent(${parentNode.functionalCategory} s=${parentScore}) ` +
                           `dominates child(${node.functionalCategory} s=${score}) overlap=${Math.round(overlap * 100)}%`;
          break;
        }
      }

      if (suppressed) {
        eligible.delete(node.nodeId);
        dropInfo.set(node.nodeId, { type: 'duplicate_parent_child', reason: suppressReason });
      } else {
        accepted.push({ node, score });
      }
    }
  }

  // ── Step 4: Repeated-item deduplication ────────────────────────────────────
  //
  // For categories that commonly appear in repetitive grids (card, link, etc.),
  // group nodes by category + area bucket (~2000 px² resolution).
  // When a group exceeds REPEATED_ITEM_THRESHOLD, keep only the top-scoring
  // maxReps representatives.
  if (preferGroupLabelingForRepeatedItems) {
    const groups = new Map(); // groupKey → [{ nodeId, score }]

    for (const { node, score } of scored) {
      if (!eligible.has(node.nodeId))                            continue;
      if (!REPEATABLE_CATEGORIES.has(node.functionalCategory))   continue;
      if (ALWAYS_PRESERVE_CATEGORIES.has(node.functionalCategory)) continue;

      const area      = (node.bbox?.width ?? 0) * (node.bbox?.height ?? 0);
      const areaBucket = Math.round(area / 2000) * 2000;
      const groupKey   = `${node.functionalCategory}_${areaBucket}`;

      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push({ nodeId: node.nodeId, score });
    }

    for (const [groupKey, items] of groups) {
      if (items.length <= REPEATED_ITEM_THRESHOLD) continue;

      items.sort((a, b) => b.score - a.score); // keep highest-scoring
      for (let i = maxReps; i < items.length; i++) {
        const { nodeId } = items[i];
        eligible.delete(nodeId);
        dropInfo.set(nodeId, {
          type:   'repeated_item_deduped',
          reason: `group ${groupKey} has ${items.length} items; keeping top ${maxReps} representatives`,
        });
      }
    }
  }

  // ── Step 5: maxLabelsPerViewport cap ───────────────────────────────────────
  if (eligible.size > maxLabelsPerViewport) {
    const eligibleSorted = scored
      .filter(({ node }) => eligible.has(node.nodeId))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Tie-break: prefer smaller area (more specific / leaf-like element)
        const areaA = (a.node.bbox?.width ?? 0) * (a.node.bbox?.height ?? 0);
        const areaB = (b.node.bbox?.width ?? 0) * (b.node.bbox?.height ?? 0);
        return areaA - areaB;
      });
    for (let i = maxLabelsPerViewport; i < eligibleSorted.length; i++) {
      const { node } = eligibleSorted[i];
      eligible.delete(node.nodeId);
      dropInfo.set(node.nodeId, {
        type:   'max_labels_cap',
        reason: `exceeded maxLabelsPerViewport=${maxLabelsPerViewport}`,
      });
    }
  }

  // ── Collect results, mutate nodes, build debug/stats ──────────────────────
  const labelEligibleNodes = [];
  const debugEntries       = debugFilter ? [] : null;
  let droppedLowQaValue    = 0;
  let droppedDecorative    = 0;
  let droppedDuplicate     = 0;
  let droppedRepeated      = 0;
  let droppedCapped        = 0;

  for (const { node, score, reasons } of scored) {
    const isEligible  = eligible.has(node.nodeId);
    const drop        = dropInfo.get(node.nodeId) ?? null;
    const isDecorative =
      drop?.type === 'low_qa_value' &&
      ['layout', 'unknown', 'banner'].includes(node.functionalCategory);

    // Mutate node in-place — adds label metadata visible to annotation + reports
    node.labelScore      = score;
    node.labelEligible   = isEligible;
    node.labelDropReason = drop?.reason ?? null;

    if (isEligible) {
      labelEligibleNodes.push(node);
    } else {
      switch (drop?.type) {
        case 'low_qa_value':
          if (isDecorative) droppedDecorative++; else droppedLowQaValue++;
          break;
        case 'duplicate_parent_child': droppedDuplicate++; break;
        case 'repeated_item_deduped':  droppedRepeated++;  break;
        case 'max_labels_cap':         droppedCapped++;     break;
        default:                       droppedDecorative++; break;
      }
    }

    if (debugFilter) {
      debugEntries.push({
        nodeId:                    node.nodeId,
        tagName:                   node.tagName,
        selectorHint:              node.selectorHint,
        text:                      (node.text ?? '').slice(0, 80),
        functionalCategory:        node.functionalCategory,
        functionalCategoryCode:    node.functionalCategoryCode,
        labelScore:                score,
        labelScoreReasons:         reasons,
        focusScore:                node.focusScore  ?? null,
        qualityScore:              node.qualityScore ?? null,
        labelEligible:             isEligible,
        keepOrDropReason:          isEligible ? 'kept' : (drop?.reason ?? 'filtered'),
        droppedBecauseDecorative:  isDecorative,
        droppedBecauseDuplicate:   drop?.type === 'duplicate_parent_child',
        droppedBecauseLowQaValue:  drop?.type === 'low_qa_value' && !isDecorative,
        droppedBecauseRepeated:    drop?.type === 'repeated_item_deduped',
        droppedBecauseCapped:      drop?.type === 'max_labels_cap',
        bbox:                      node.bbox,
      });
    }
  }

  const filterStats = {
    rawCount:            classifiedNodes.length,
    labelEligibleCount:  labelEligibleNodes.length,
    droppedTotal:        classifiedNodes.length - labelEligibleNodes.length,
    droppedLowQaValue,
    droppedDecorative,
    droppedDuplicate,
    droppedRepeated,
    droppedCapped,
    labelMode,
    effectiveMinScore,
    maxLabelsPerViewport,
    suppressChildLabels: suppressChildLabelsWhenParentIsSufficient,
    preferGroupLabels:   preferGroupLabelingForRepeatedItems,
  };

  return {
    labelEligibleNodes,
    debugEntries: debugEntries ?? [],
    filterStats,
  };
}
