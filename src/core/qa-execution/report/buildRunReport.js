import { buildSummary }  from './buildSummary.js';
import { buildNotes }    from './buildHumanReadableNotes.js';
import { randomUUID }    from 'node:crypto';

const REPORT_VERSION = '2.0';

/**
 * Assemble the final scenario report from runtime artefacts.
 */
export function buildScenarioReport({
  suite,
  scenario,
  preconditionResults = [],
  stepResults         = [],
  state,
  startedAt,
  validationWarnings  = [],
}) {
  const allResults = [...preconditionResults, ...stepResults];
  const summary    = buildSummary(allResults);
  const status     = deriveScenarioStatus(scenario, allResults, summary);
  const notes      = buildNotes(scenario, status, summary, allResults);
  const finishedAt = new Date().toISOString();

  return {
    reportVersion:     REPORT_VERSION,
    scenarioId:        scenario.scenarioId,
    scenarioName:      scenario.name ?? scenario.title ?? '',
    description:       scenario.description ?? '',
    tags:              scenario.tags ?? [],
    status,
    startedAt,
    finishedAt,
    durationMs:        Date.parse(finishedAt) - Date.parse(startedAt),
    summary,
    capturedValues:    state?.serializeCaptured() ?? {},
    stepResults:       allResults,
    validationWarnings,
    humanNotes:        notes,
    suiteId:           suite?.suiteId ?? null,
    analysisJobId:     suite?.analysisJobId ?? suite?.analysisContext?.analysisJobId ?? null,
    baseURL:           suite?.environment?.baseURL ?? suite?.baseURL ?? null,
  };
}

/**
 * Assemble the top-level suite report from individual scenario reports.
 */
export function buildSuiteReport(suite, scenarioReports, startedAt) {
  const finishedAt    = new Date().toISOString();
  const totalScenarios = scenarioReports.length;
  const passed        = scenarioReports.filter(r => r.status === 'passed').length;
  const failed        = scenarioReports.filter(r => r.status === 'failed').length;
  const skipped       = scenarioReports.filter(r => r.status === 'skipped').length;
  const blocked       = scenarioReports.filter(r => r.status === 'blocked').length;

  return {
    reportVersion:   REPORT_VERSION,
    runId:           randomUUID(),
    suiteId:         suite?.suiteId ?? null,
    suiteName:       suite?.name ?? suite?.title ?? '',
    baseURL:         suite?.environment?.baseURL ?? suite?.baseURL ?? '',
    analysisJobId:   suite?.analysisJobId ?? suite?.analysisContext?.analysisJobId ?? null,
    status:          failed > 0 ? 'failed' : (blocked > 0 ? 'blocked' : 'passed'),
    startedAt,
    finishedAt,
    durationMs:      Date.parse(finishedAt) - Date.parse(startedAt),
    summary: {
      totalScenarios,
      passed,
      failed,
      skipped,
      blocked,
    },
    scenarioReports,
  };
}

// ── Status derivation ─────────────────────────────────────────────────────────

function deriveScenarioStatus(scenario, allResults, summary) {
  const required = allResults.filter(r => r.required !== false);
  const anyRequiredFailed = required.some(r => r.status === 'failed' || r.status === 'blocked');

  if (anyRequiredFailed) return 'failed';
  if (summary.skipped   === allResults.length) return 'skipped';
  if (summary.blocked   > 0) return 'blocked';
  return 'passed';
}
