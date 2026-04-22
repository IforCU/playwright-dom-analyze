/**
 * Merge suite-level defaults with per-scenario overrides.
 *
 * Keys from scenario.defaults (or a scenarioOverrides map keyed by scenarioId)
 * take priority over suite.defaults. Both are optional.
 *
 * @param {object} suite
 * @param {object} [scenarioOverrides]  – additional runtime overrides (e.g. from API call)
 * @returns {object}  merged defaults object
 */
export function resolveDefaults(suite, scenarioOverrides = {}) {
  const suiteDefaults = suite?.defaults ?? {};
  // Support both flat (suite.defaults.X) and nested (suite.defaults.executionPolicy.X) structures
  const policy  = suiteDefaults.executionPolicy ?? suiteDefaults;
  const safetyD = suiteDefaults.safety ?? policy.safety ?? {};
  // baseURL lives in suite.environment.baseURL (QA_senario.json structure)
  const envBaseURL = suite?.environment?.baseURL ?? suite?.baseURL ?? '';

  return {
    timeoutMs:     scenarioOverrides.timeoutMs     ?? policy.timeoutMs     ?? 10000,
    retryCount:    scenarioOverrides.retryCount    ?? policy.maxStepRetries ?? policy.retryCount ?? 0,
    stopOnFailure: scenarioOverrides.stopOnFailure ?? policy.stopOnFailure  ?? false,
    headless:      scenarioOverrides.headless      ?? suiteDefaults.headless ?? true,
    viewport:      scenarioOverrides.viewport      ?? suite?.environment?.viewport ?? suiteDefaults.viewport ?? { width: 1280, height: 800 },
    locale:        scenarioOverrides.locale        ?? suite?.environment?.locale   ?? suiteDefaults.locale   ?? 'ko-KR',
    timezone:      scenarioOverrides.timezone      ?? suite?.environment?.timezoneId ?? suiteDefaults.timezone ?? 'Asia/Seoul',
    captureOnFailure:   scenarioOverrides.captureOnFailure  ?? policy.captureOnFailure  ?? true,
    captureOnSuccess:   scenarioOverrides.captureOnSuccess  ?? policy.captureOnSuccess  ?? false,
    saveVideoOnFailure: scenarioOverrides.saveVideoOnFailure ?? suiteDefaults.reporting?.saveVideoOnFailure ?? false,
    saveTrace:          scenarioOverrides.saveTrace          ?? suiteDefaults.reporting?.saveTrace          ?? false,
    safety: {
      allowExternalNavigation:
        scenarioOverrides.safety?.allowExternalNavigation
        ?? safetyD.allowExternalNavigation
        ?? false,
    },
    baseURL: scenarioOverrides.baseURL ?? suiteDefaults.baseURL ?? envBaseURL,
    // Max scenarios executed concurrently (suite-level only — per-scenario
    // overrides are ignored for this knob since it is a suite-wide budget).
    maxParallelScenarios:
      scenarioOverrides.maxParallelScenarios
      ?? policy.maxParallelScenarios
      ?? suiteDefaults.maxParallelScenarios
      ?? parseInt(process.env.QA_MAX_PARALLEL_SCENARIOS || '1', 10),
  };
}