/**
 * core/qa/reportBuilder.js
 *
 * Assembles the final run report for a QA scenario execution.
 *
 * Report schema (stable):
 * {
 *   reportVersion:    string,
 *   runId:            string,
 *   suiteId:          string,
 *   scenarioId:       string,
 *   scenarioTitle:    string,
 *   status:           "passed" | "failed" | "skipped" | "blocked",
 *   startedAt:        ISO string,
 *   finishedAt:       ISO string,
 *   durationMs:       number,
 *   environment:      object,
 *   analysisContext:  object,
 *   inputData:        object,
 *   summary:          { totals, errorClassification, fallbackLocatorUsageCount, ... },
 *   stepResults:      StepResult[],
 *   capturedValues:   object,
 *   artifacts:        { path, type, stepId }[],
 *   warnings:         string[],
 *   humanNotes:       string[],
 * }
 */

import { randomUUID } from 'crypto';

export const REPORT_VERSION = '2.0';

/**
 * Build a complete run report for one scenario execution.
 *
 * @param {object} opts
 * @param {object}   opts.suite              - full scenario suite JSON
 * @param {object}   opts.scenario           - scenario definition
 * @param {object[]} opts.preconditionResults - step results from preconditions
 * @param {object[]} opts.stepResults         - step results from main steps
 * @param {import('./runtimeContext.js').RuntimeContext} opts.context
 * @param {string}   opts.startedAt
 * @param {string[]} opts.validationWarnings
 * @returns {object} Final run report
 */
export function buildScenarioReport({
  suite,
  scenario,
  preconditionResults = [],
  stepResults         = [],
  context,
  startedAt,
  validationWarnings  = [],
}) {
  const finishedAt  = new Date().toISOString();
  const durationMs  = new Date(finishedAt) - new Date(startedAt);
  const allResults  = [...preconditionResults, ...stepResults];

  const summary   = buildSummary(allResults);
  const artifacts = collectArtifacts(allResults);
  const status    = deriveScenarioStatus(scenario, allResults);

  return {
    reportVersion:   REPORT_VERSION,
    runId:           randomUUID(),
    suiteId:         suite.suiteId,
    scenarioId:      scenario.scenarioId,
    scenarioTitle:   scenario.title,
    status,
    startedAt,
    finishedAt,
    durationMs,

    environment:     suite.environment ?? {},
    analysisContext: suite.analysisContext ?? {},
    inputData:       context.serializeData(),

    summary,

    preconditionResults,
    stepResults,

    capturedValues:  context.serializeCaptured(),
    artifacts,
    warnings:        validationWarnings,
    humanNotes:      buildHumanNotes(scenario, status, summary, allResults),
  };
}

/**
 * Build a suite-level aggregate report from individual scenario reports.
 *
 * @param {object}   suite
 * @param {object[]} scenarioReports
 * @param {string}   startedAt
 * @returns {object}
 */
export function buildSuiteReport(suite, scenarioReports, startedAt) {
  const finishedAt = new Date().toISOString();
  const durationMs = new Date(finishedAt) - new Date(startedAt);

  const totalScenarios  = scenarioReports.length;
  const passedScenarios = scenarioReports.filter(r => r.status === 'passed').length;
  const failedScenarios = scenarioReports.filter(r => r.status === 'failed').length;
  const skippedScenarios = scenarioReports.filter(r => r.status === 'skipped').length;

  const allErrorCodes = scenarioReports.flatMap(r =>
    [...(r.preconditionResults ?? []), ...(r.stepResults ?? [])]
      .map(s => s.errorCode).filter(Boolean)
  );

  const errorClassification = categorizeErrors(allErrorCodes);

  return {
    reportVersion: REPORT_VERSION,
    runId:         randomUUID(),
    suiteId:       suite.suiteId,
    suiteTitle:    suite.title,
    status:        failedScenarios > 0 ? 'failed' : 'passed',
    startedAt,
    finishedAt,
    durationMs,
    environment:   suite.environment ?? {},
    analysisContext: suite.analysisContext ?? {},

    summary: {
      totalScenarios,
      passedScenarios,
      failedScenarios,
      skippedScenarios,
      passRate: totalScenarios > 0
        ? `${Math.round((passedScenarios / totalScenarios) * 100)}%`
        : 'N/A',
      errorClassification,
    },

    scenarioReports,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildSummary(allResults) {
  const total   = allResults.length;
  const passed  = allResults.filter(r => r.status === 'passed' || r.status === 'retried_then_passed').length;
  const failed  = allResults.filter(r => r.status === 'failed' || r.status === 'retried_then_failed').length;
  const skipped = allResults.filter(r => r.status === 'skipped').length;
  const blocked = allResults.filter(r => r.status === 'blocked').length;
  const retried = allResults.filter(r => r.status?.startsWith('retried')).length;

  const assertionPassed = allResults.filter(r => r.assertionResult?.passed === true).length;
  const assertionFailed = allResults.filter(r => r.assertionResult?.passed === false).length;

  const durations = allResults.map(r => r.durationMs ?? 0);
  const avgDurationMs = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;

  const slowestStep = allResults.reduce(
    (acc, r) => (!acc || r.durationMs > acc.durationMs) ? r : acc, null,
  );

  const fallbackCount = allResults.filter(
    r => r.resolutionResult?.wasFallbackUsed === true,
  ).length;

  const errorCodes = allResults.map(r => r.errorCode).filter(Boolean);
  const errorClassification = categorizeErrors(errorCodes);

  return {
    totalSteps:                 total,
    passedSteps:                passed,
    failedSteps:                failed,
    skippedSteps:               skipped,
    blockedSteps:               blocked,
    retriedSteps:               retried,
    assertionPassedCount:       assertionPassed,
    assertionFailedCount:       assertionFailed,
    averageStepDurationMs:      avgDurationMs,
    slowestStepId:              slowestStep?.stepId ?? null,
    slowestStepDurationMs:      slowestStep?.durationMs ?? null,
    fallbackLocatorUsageCount:  fallbackCount,
    errorClassification,
  };
}

function categorizeErrors(errorCodes) {
  const counts = {};
  const KNOWN = [
    'target_not_found', 'target_not_visible', 'timeout', 'assertion_failed',
    'navigation_blocked', 'out_of_scope', 'auth_required', 'context_destroyed',
    'render_unstable', 'modal_blocked', 'capture_failed', 'unsupported_step',
    'unsupported_matcher',
  ];
  for (const code of KNOWN) counts[code] = 0;
  for (const code of errorCodes) {
    if (code in counts) counts[code]++;
    else counts[code] = (counts[code] ?? 0) + 1;
  }
  // Remove zero-count entries for brevity
  return Object.fromEntries(Object.entries(counts).filter(([, v]) => v > 0));
}

function collectArtifacts(allResults) {
  return allResults.flatMap(r => r.artifacts ?? []);
}

function deriveScenarioStatus(scenario, allResults) {
  const criteria = scenario.successCriteria ?? {};

  // Check required steps
  const requiredResults = allResults.filter((_, i) => {
    const allSteps = [
      ...(scenario.preconditions ?? []),
      ...(scenario.steps ?? []),
    ];
    return allSteps[i]?.required !== false;
  });

  const anyRequiredFailed = requiredResults.some(
    r => r.status === 'failed' || r.status === 'retried_then_failed',
  );

  if (anyRequiredFailed && criteria.allRequiredStepsPassed !== false) {
    return 'failed';
  }

  // Check final assertions
  if (criteria.finalAssertionsPassed !== false) {
    const expectResults = allResults.filter(r => r.type === 'expect');
    const anyAssertionFailed = expectResults.some(r => r.assertionResult?.passed === false);
    if (anyAssertionFailed) return 'failed';
  }

  return 'passed';
}

function buildHumanNotes(scenario, status, summary, allResults) {
  const notes = [];

  if (status === 'passed') {
    notes.push(`Scenario "${scenario.title}" completed successfully.`);
  } else {
    notes.push(`Scenario "${scenario.title}" FAILED.`);
  }

  if (summary.fallbackLocatorUsageCount > 0) {
    notes.push(`${summary.fallbackLocatorUsageCount} step(s) used fallback locators instead of analysisRef. Consider updating the analysis.`);
  }

  if (summary.retriedSteps > 0) {
    notes.push(`${summary.retriedSteps} step(s) were retried before final result.`);
  }

  const failedSteps = allResults.filter(r =>
    r.status === 'failed' || r.status === 'retried_then_failed',
  );
  for (const s of failedSteps) {
    notes.push(`Step "${s.stepId}" (${s.type}) failed: [${s.errorCode}] ${s.error}`);
  }

  const errorEntries = Object.entries(summary.errorClassification ?? {});
  if (errorEntries.length > 0) {
    notes.push(`Error summary: ${errorEntries.map(([k,v]) => `${k}×${v}`).join(', ')}`);
  }

  return notes;
}
