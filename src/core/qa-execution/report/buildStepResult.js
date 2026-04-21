/**
 * Factory for StepResult objects.
 *
 * All step executors return an ad-hoc shape; this utility normalises them
 * to the canonical StepResult schema used in reports.
 */
export function createStepResult(step, status, startedAt, durationMs, extra = {}) {
  const finishedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  return {
    stepId:               step.stepId   ?? null,
    name:                 step.name     ?? step.type,
    type:                 step.type,
    required:             step.required ?? true,
    status,               // 'passed' | 'failed' | 'skipped' | 'blocked' | 'retried'
    startedAt,
    finishedAt,
    durationMs,
    logs:                 extra.logs                ?? [],
    error:                extra.error               ?? null,
    errorCode:            extra.errorCode           ?? null,
    resolutionResult:     extra.resolutionResult    ?? null,
    capturedOutput:       extra.capturedOutput      ?? null,
    assertionResult:      extra.assertionResult     ?? null,
    expectedSignalResults: extra.expectedSignalResults ?? [],
    artifacts:            extra.artifacts           ?? [],
  };
}
