import { ERROR_CODES, ALL_KNOWN_CODES } from '../errors/errorCodes.js';

/**
 * Build a summary object from an array of StepResult objects.
 *
 * @param {object[]} stepResults
 * @returns {object}
 */
export function buildSummary(stepResults) {
  const counts = { passed: 0, failed: 0, skipped: 0, blocked: 0, retried: 0 };
  let assertionPassed = 0;
  let assertionFailed = 0;
  let totalDuration   = 0;
  let slowestStep     = null;
  let fallbackCount   = 0;

  const errorClassification = Object.fromEntries(ALL_KNOWN_CODES.map(c => [c, 0]));

  for (const r of stepResults) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    totalDuration += r.durationMs ?? 0;

    if (r.assertionResult != null) {
      if (r.assertionResult.passed) assertionPassed++;
      else                          assertionFailed++;
    }

    if (r.resolutionResult?.wasFallbackUsed) fallbackCount++;

    if (r.errorCode && r.errorCode in errorClassification) {
      errorClassification[r.errorCode]++;
    }

    if (!slowestStep || (r.durationMs ?? 0) > (slowestStep.durationMs ?? 0)) {
      slowestStep = { stepId: r.stepId, durationMs: r.durationMs };
    }
  }

  const total = stepResults.length;
  return {
    total,
    ...counts,
    assertionPassedCount:    assertionPassed,
    assertionFailedCount:    assertionFailed,
    averageStepDurationMs:   total > 0 ? Math.round(totalDuration / total) : 0,
    slowestStepId:           slowestStep?.stepId ?? null,
    fallbackLocatorUsageCount: fallbackCount,
    errorClassification,
  };
}
