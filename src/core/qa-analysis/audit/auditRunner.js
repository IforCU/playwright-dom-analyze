/**
 * core/audit/auditRunner.js
 *
 * PART 6 — Self-review / Self-improvement Loop
 * PART 7 — Safe auto-tuning support
 *
 * Reads previous analysis outputs and produces quality audit reports that
 * identify patterns of poor analysis:
 *   - page analyzed while skeleton/loading UI was still visible
 *   - blocking modal remained after stabilization
 *   - focus score dominated by low-value wrapper nodes
 *   - too many dropped nodes vs. kept (over-filtering)
 *   - zero-change trigger results (missed interactions)
 *   - cross-origin iframes covering large areas
 *   - low static component count (page may have been empty)
 *
 * Outputs:
 *   outputs/audit/analysis-quality-audit.json
 *   outputs/audit/analysis-quality-audit.md
 *
 * Safe auto-tuning (PART 7):
 *   When --apply-tuning flag is passed, conservative threshold updates
 *   are written to config/ files — source code is NEVER modified.
 *
 * Usage (CLI):
 *   node src/core/audit/auditRunner.js [--apply-tuning]
 *
 * Usage (API):
 *   import { runAudit } from './core/audit/auditRunner.js';
 *   const report = await runAudit({ applyTuning: false });
 */

import fs   from 'fs/promises';
import path from 'path';

// auditRunner.js is at src/core/qa-analysis/audit/ — need 4 levels up to reach project root,
// then into outputs/web/ (the canonical analysis output base)
const OUTPUTS_DIR = new URL('../../../../outputs/web', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const AUDIT_DIR   = path.join(new URL('../../../../outputs/audit', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const CONFIG_DIR  = new URL('../../../config',  import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

// ── Thresholds for detecting quality problems ─────────────────────────────────
const QUALITY_THRESHOLDS = {
  minStaticComponentCount:  15,   // below this → likely empty / not rendered
  maxZeroChangeTriggerRatio: 0.7, // >70% triggers with no changes → poor interaction
  minMeanFocusScore:         1.0, // below this → dominated by low-value nodes
  maxLowFocusRatio:          0.6, // >60% nodes with focusScore <= 0 → low quality
  minReadinessScore:         0.6, // below this → page was partially rendered
  maxPartialBlockRate:       0.4, // >40% of runs partially blocked → blocker issue
};

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * Run quality audit over all available output directories.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.applyTuning=false] - Write conservative config updates
 * @param {number}  [opts.maxSamples=20]     - Max output directories to audit
 * @returns {Promise<object>} Audit report
 */
export async function runAudit(opts = {}) {
  const { applyTuning = false, maxSamples = 20 } = opts;

  await fs.mkdir(AUDIT_DIR, { recursive: true });

  console.log('[audit]  scanning output directories …');
  const jobDirs = await _listJobDirs(OUTPUTS_DIR, maxSamples);
  console.log(`[audit]  found ${jobDirs.length} job output(s) to audit`);

  const jobAudits  = [];
  const allIssues  = [];
  const statsAccum = {
    totalJobs:           0,
    degradedModeCount:   0,
    partiallyBlockedCount: 0,
    lowStaticCount:      0,
    highZeroChangeTrigCount: 0,
    lowFocusCount:       0,
    largeUnreachableFrameCount: 0,
  };

  for (const dir of jobDirs) {
    const jobAudit = await _auditJobDir(dir);
    if (!jobAudit) continue;

    jobAudits.push(jobAudit);
    statsAccum.totalJobs++;
    if (jobAudit.renderDegradedMode)        statsAccum.degradedModeCount++;
    if (jobAudit.partiallyBlocked)          statsAccum.partiallyBlockedCount++;
    if (jobAudit.staticComponentCount < QUALITY_THRESHOLDS.minStaticComponentCount)
                                             statsAccum.lowStaticCount++;
    if (jobAudit.zeroChangeTriggerRatio > QUALITY_THRESHOLDS.maxZeroChangeTriggerRatio)
                                             statsAccum.highZeroChangeTrigCount++;
    if (jobAudit.meanFocusScore < QUALITY_THRESHOLDS.minMeanFocusScore)
                                             statsAccum.lowFocusCount++;
    if (jobAudit.largeUnreachableFrameCount > 0)
                                             statsAccum.largeUnreachableFrameCount++;

    allIssues.push(...jobAudit.issues.map((i) => ({ ...i, jobId: jobAudit.jobId })));
  }

  // ── Aggregate failure patterns ─────────────────────────────────────────────
  const failurePatterns = _detectFailurePatterns(jobAudits, statsAccum);

  // ── Suggested improvements ─────────────────────────────────────────────────
  const suggestions = _buildSuggestions(statsAccum, failurePatterns);

  const auditReport = {
    auditedAt:       new Date().toISOString(),
    totalJobsAudited: statsAccum.totalJobs,
    statistics:       statsAccum,
    failurePatterns,
    suggestions,
    jobAudits,
    qualityWarnings:  _buildTopWarnings(allIssues),
  };

  // ── Write audit artifacts ──────────────────────────────────────────────────
  const jsonPath = path.join(AUDIT_DIR, 'analysis-quality-audit.json');
  const mdPath   = path.join(AUDIT_DIR, 'analysis-quality-audit.md');

  await fs.writeFile(jsonPath, JSON.stringify(auditReport, null, 2), 'utf8');
  await fs.writeFile(mdPath, _buildMarkdownReport(auditReport), 'utf8');

  console.log(`[audit]  report written → ${jsonPath}`);
  console.log(`[audit]  report written → ${mdPath}`);

  // ── Optional safe auto-tuning ──────────────────────────────────────────────
  if (applyTuning && suggestions.tuningUpdates?.length > 0) {
    await _applyTuning(suggestions.tuningUpdates);
    console.log('[audit]  conservative config tuning applied');
  } else if (applyTuning) {
    console.log('[audit]  no tuning updates needed');
  }

  return auditReport;
}

// ── Per-job audit ──────────────────────────────────────────────────────────────

async function _auditJobDir(dir) {
  try {
    const issues = [];

    // Load available artifacts
    const finalReport      = await _readJson(path.join(dir, 'final-report.json'));
    const stabilization    = await _readJson(path.join(dir, 'initial-stabilization.json'));
    const readiness        = await _readJson(path.join(dir, 'render-readiness.json'));
    const frameSummary     = await _readJson(path.join(dir, 'frame-summary.json'));
    const staticJson       = await _readJson(path.join(dir, 'static.json'));
    const trigCandidates   = await _readJson(path.join(dir, 'trigger-candidates.json'));

    if (!finalReport) return null; // no final report → skip

    const jobId   = finalReport.jobId ?? path.basename(dir);
    const p1      = finalReport.phase1;
    const summary = p1?.summary;

    // ── Render readiness ────────────────────────────────────────────────────
    let renderDegradedMode  = false;
    let renderReadinessScore = 1;
    if (readiness) {
      renderDegradedMode  = readiness.degradedMode === true;
      renderReadinessScore = readiness.readinessScore ?? 1;
      if (renderDegradedMode) {
        issues.push({
          severity: 'high',
          category: 'render_readiness',
          message:  'analysis started while page may not be fully rendered',
          detail:   readiness.message,
        });
      } else if (renderReadinessScore < QUALITY_THRESHOLDS.minReadinessScore) {
        issues.push({
          severity: 'medium',
          category: 'render_readiness',
          message:  `low readiness score: ${renderReadinessScore}`,
        });
      }
    }

    // ── Stabilization ───────────────────────────────────────────────────────
    const partiallyBlocked = stabilization?.partiallyBlocked === true
      || finalReport.initialStabilization?.partiallyBlocked === true;
    if (partiallyBlocked) {
      issues.push({
        severity: 'high',
        category: 'blocker_modal',
        message:  'blocking modal remained visible after stabilization',
        detail:   stabilization?.warnings?.join('; ') ?? '',
      });
    }
    const pausedMedia = stabilization?.pausedMediaCount ?? 0;
    if (pausedMedia === 0 && (summary?.initialStabilization?.blockerCount ?? 0) > 0) {
      issues.push({
        severity: 'low',
        category: 'autoplay_media',
        message:  'blockers detected but no autoplay media was paused — may indicate banner noise',
      });
    }

    // ── Static component count ──────────────────────────────────────────────
    const staticComponentCount = summary?.staticComponentCount ?? staticJson?.nodeCount ?? 0;
    if (staticComponentCount < QUALITY_THRESHOLDS.minStaticComponentCount) {
      issues.push({
        severity: 'high',
        category: 'low_content',
        message:  `very low static component count (${staticComponentCount}) — page may not have rendered`,
      });
    }

    // ── Focus score analysis ────────────────────────────────────────────────
    const nodes = staticJson?.nodes ?? [];
    let meanFocusScore  = 0;
    let lowFocusRatio   = 0;
    if (nodes.length > 0) {
      const scores = nodes.map((n) => n.focusScore ?? 0);
      meanFocusScore = +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2);
      const lowCount = scores.filter((s) => s <= 0).length;
      lowFocusRatio  = +(lowCount / scores.length).toFixed(2);

      if (meanFocusScore < QUALITY_THRESHOLDS.minMeanFocusScore) {
        issues.push({
          severity: 'medium',
          category: 'focus_quality',
          message:  `focus score dominated by low-value nodes (mean=${meanFocusScore}, lowRatio=${lowFocusRatio})`,
        });
      }
    }

    // ── Trigger quality ─────────────────────────────────────────────────────
    const trigResults = p1?.triggerResults ?? [];
    const zeroChangeTriggers = trigResults.filter(
      (r) => r.status === 'success' && (r.newNodes?.length ?? 0) === 0 && (r.mutationCount ?? 0) === 0);
    const executedTriggers = trigResults.filter((r) => r.status === 'success');
    const zeroChangeTriggerRatio = executedTriggers.length > 0
      ? +(zeroChangeTriggers.length / executedTriggers.length).toFixed(2)
      : 0;

    if (zeroChangeTriggerRatio > QUALITY_THRESHOLDS.maxZeroChangeTriggerRatio && executedTriggers.length >= 3) {
      issues.push({
        severity: 'medium',
        category: 'trigger_quality',
        message:  `high zero-change trigger ratio (${zeroChangeTriggerRatio}) — interactions may not be reaching rendered content`,
      });
    }

    // ── Frame quality ───────────────────────────────────────────────────────
    let largeUnreachableFrameCount = 0;
    if (frameSummary) {
      const largeUnreachable = (frameSummary.frames ?? []).filter(
        (f) => f.type === 'cross-origin' && f.vpCoverage >= 0.3);
      largeUnreachableFrameCount = largeUnreachable.length;
      if (largeUnreachableFrameCount > 0) {
        issues.push({
          severity: 'medium',
          category: 'frame_coverage',
          message:  `cross-origin iframe covered a large part of the page and could not be inspected`,
          detail:   largeUnreachable.map((f) => `${f.likelyRole} vpCoverage=${f.vpCoverage}`).join(', '),
        });
      }
    }

    return {
      jobId,
      jobDir:                   dir,
      url:                      finalReport.input?.requestUrl ?? '',
      analyzedAt:               finalReport.finishedAt ?? '',
      renderDegradedMode,
      renderReadinessScore,
      partiallyBlocked,
      staticComponentCount,
      meanFocusScore,
      lowFocusRatio,
      zeroChangeTriggerRatio,
      largeUnreachableFrameCount,
      issueCount:               issues.length,
      issues,
    };
  } catch (err) {
    console.log(`[audit]  error auditing ${dir}: ${err.message}`);
    return null;
  }
}

// ── Pattern detection ──────────────────────────────────────────────────────────

function _detectFailurePatterns(jobAudits, stats) {
  const patterns = [];
  const n = stats.totalJobs || 1;

  if (stats.degradedModeCount / n > 0.3) {
    patterns.push({
      pattern: 'frequent_degraded_render',
      rate:    +(stats.degradedModeCount / n).toFixed(2),
      note:    'More than 30% of runs started before page was fully rendered. Consider increasing maxInitialWaitMs.',
    });
  }
  if (stats.partiallyBlockedCount / n > QUALITY_THRESHOLDS.maxPartialBlockRate) {
    patterns.push({
      pattern: 'frequent_partial_block',
      rate:    +(stats.partiallyBlockedCount / n).toFixed(2),
      note:    'Many runs had blocking UI that was not fully dismissed. Review blockerKeywords in blocker-rules.json.',
    });
  }
  if (stats.lowStaticCount / n > 0.3) {
    patterns.push({
      pattern: 'frequent_low_content',
      rate:    +(stats.lowStaticCount / n).toFixed(2),
      note:    'Many pages had very few static components. Page may be loading content slowly — increase maxInitialWaitMs.',
    });
  }
  if (stats.lowFocusCount / n > 0.4) {
    patterns.push({
      pattern: 'frequent_low_focus_quality',
      rate:    +(stats.lowFocusCount / n).toFixed(2),
      note:    'Focus score dominated by low-value nodes in many runs. Review keepClassKeywords in dom-filter-rules.json.',
    });
  }
  if (stats.highZeroChangeTrigCount / n > 0.4) {
    patterns.push({
      pattern: 'frequent_zero_change_triggers',
      rate:    +(stats.highZeroChangeTrigCount / n).toFixed(2),
      note:    'Triggers rarely cause DOM changes. Check TRIGGER_SETTLE_MAX_MS and TRIGGER_QUIET_MS settings.',
    });
  }

  return patterns;
}

// ── Suggestion builder ────────────────────────────────────────────────────────

function _buildSuggestions(stats, failurePatterns) {
  const suggestions = [];
  const tuningUpdates = [];

  for (const p of failurePatterns) {
    switch (p.pattern) {
      case 'frequent_degraded_render':
        suggestions.push('Increase RENDER_READINESS_MAX_MS or maxInitialWaitMs in render-rules.json');
        tuningUpdates.push({
          file:  'config/render-rules.json',
          field: 'maxInitialWaitMs',
          from:  8000,
          to:    12000,
          reason: p.note,
        });
        break;
      case 'frequent_partial_block':
        suggestions.push('Add site-specific blockerKeywords to config/blocker-rules.json');
        suggestions.push('Review STABILIZE_COVERAGE_THRESHOLD — may be too high');
        break;
      case 'frequent_low_content':
        suggestions.push('Increase RENDER_READINESS_MAX_MS — SPA pages may need more time');
        suggestions.push('Check if page requires JS-rendered content (SPA route)');
        break;
      case 'frequent_low_focus_quality':
        suggestions.push('Add content-specific keywords to keepClassKeywords in dom-filter-rules.json');
        suggestions.push('Increase NODE_MIN_SCORE to filter more low-quality generic nodes');
        break;
      case 'frequent_zero_change_triggers':
        suggestions.push('Increase TRIGGER_SETTLE_MAX_MS for heavier pages');
        suggestions.push('Consider setting FREEZE_CSS_TRIGGERS=true to reduce animation noise');
        break;
    }
  }

  if (!suggestions.length) {
    suggestions.push('No critical patterns detected. Analysis quality appears acceptable.');
  }

  return { suggestions, tuningUpdates };
}

// ── Markdown report ────────────────────────────────────────────────────────────

function _buildMarkdownReport(report) {
  const lines = [
    '# Analysis Quality Audit Report',
    '',
    `**Audited at:** ${report.auditedAt}`,
    `**Jobs audited:** ${report.totalJobsAudited}`,
    '',
    '## Summary Statistics',
    '',
    `| Metric | Count | Rate |`,
    `|---|---|---|`,
    `| Degraded render mode | ${report.statistics.degradedModeCount} | ${pct(report.statistics.degradedModeCount, report.statistics.totalJobs)} |`,
    `| Partially blocked | ${report.statistics.partiallyBlockedCount} | ${pct(report.statistics.partiallyBlockedCount, report.statistics.totalJobs)} |`,
    `| Low static component count | ${report.statistics.lowStaticCount} | ${pct(report.statistics.lowStaticCount, report.statistics.totalJobs)} |`,
    `| High zero-change trigger ratio | ${report.statistics.highZeroChangeTrigCount} | ${pct(report.statistics.highZeroChangeTrigCount, report.statistics.totalJobs)} |`,
    `| Low focus score | ${report.statistics.lowFocusCount} | ${pct(report.statistics.lowFocusCount, report.statistics.totalJobs)} |`,
    `| Large unreachable cross-origin frames | ${report.statistics.largeUnreachableFrameCount} | — |`,
    '',
    '## Detected Failure Patterns',
    '',
    ...(report.failurePatterns.length
      ? report.failurePatterns.map((p) =>
          `- **${p.pattern}** (rate=${p.rate}): ${p.note}`)
      : ['- No critical patterns detected.']),
    '',
    '## Suggestions',
    '',
    ...(report.suggestions.suggestions.map((s) => `- ${s}`)),
    '',
    '## Top Quality Warnings',
    '',
    ...(report.qualityWarnings.length
      ? report.qualityWarnings.slice(0, 10).map((w) => `- ${w.count}× [${w.category}] ${w.message}`)
      : ['- No warnings.']),
    '',
    '## Per-Job Issues',
    '',
    ...report.jobAudits.flatMap((j) =>
      j.issueCount > 0
        ? [
            `### ${j.jobId} (${j.url})`,
            ...j.issues.map((i) => `- [${i.severity}] [${i.category}] ${i.message}`),
            '',
          ]
        : [`### ${j.jobId} — no issues`, '']
    ),
  ];
  return lines.join('\n');
}

function pct(n, total) {
  if (!total) return '—';
  return `${Math.round((n / total) * 100)}%`;
}

// ── Auto-tuning ───────────────────────────────────────────────────────────────

async function _applyTuning(updates) {
  for (const upd of updates) {
    const filePath = path.join(
      new URL('../../../', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'),
      upd.file,
    );
    try {
      let config = {};
      try { config = JSON.parse(await fs.readFile(filePath, 'utf8')); } catch (_) {}
      // Only update if the current value matches the expected "from" value
      // (conservative — never override manual user changes)
      if (config[upd.field] !== undefined && config[upd.field] === upd.from) {
        config[upd.field] = upd.to;
        await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf8');
        console.log(`[audit]  tuned ${upd.file}: ${upd.field} ${upd.from} → ${upd.to}`);
      }
    } catch (err) {
      console.log(`[audit]  tuning ${upd.file} failed: ${err.message}`);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _listJobDirs(outputsDir, maxSamples) {
  try {
    const entries = await fs.readdir(outputsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name !== 'audit' && !e.name.startsWith('.'))
      .sort((a, b) => b.name.localeCompare(a.name)) // newest first
      .slice(0, maxSamples)
      .map((e) => path.join(outputsDir, e.name));
  } catch (_) {
    return [];
  }
}

async function _readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function _buildTopWarnings(allIssues) {
  // Count by (category, message) pair and return top N
  const counts = {};
  for (const issue of allIssues) {
    const key = `${issue.category}::${issue.message}`;
    if (!counts[key]) counts[key] = { category: issue.category, message: issue.message, count: 0 };
    counts[key].count++;
  }
  return Object.values(counts)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith('auditRunner.js')) {
  const applyTuning = process.argv.includes('--apply-tuning');
  runAudit({ applyTuning })
    .then((r) => console.log(`[audit]  done — ${r.totalJobsAudited} jobs, ${r.qualityWarnings.length} warnings`))
    .catch((err) => { console.error('[audit]  FATAL:', err); process.exit(1); });
}
