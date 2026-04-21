/**
 * core/qa/qaRunner.js
 *
 * Main orchestrator for executing QA scenario suites.
 *
 * Execution flow:
 *  1. Load and validate the scenario suite JSON
 *  2. Load the analysis report (final-report.json) to build the element map
 *  3. Launch a Playwright browser context
 *  4. For each scenario (or a filtered subset):
 *     a. Create a fresh RuntimeContext with scenario.data
 *     b. Execute preconditions
 *     c. Execute steps (with retry, signal observation, assertions)
 *     d. Build scenario report
 *  5. Build and write a suite-level report
 *  6. Write all reports to outputs/qa-runs/{runId}/
 *
 * Usage (from route):
 *   const report = await runQASuite({ suite, analysisReport, scenarioIds, credentials });
 */

import fs   from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

import { validateSuite }                           from './validator.js';
import { buildAnalysisElementMap }                 from './locatorResolver.js';
import { RuntimeContext }                          from './runtimeContext.js';
import { executeStep }                             from './stepExecutor.js';
import { buildScenarioReport, buildSuiteReport }  from './reportBuilder.js';

const OUTPUTS_DIR = new URL('../../../outputs', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const QA_RUNS_DIR = path.join(OUTPUTS_DIR, 'qa-runs');

/**
 * Run a full QA suite (or a filtered subset of scenarios).
 *
 * @param {object} opts
 * @param {object}      opts.suite            - parsed scenario suite JSON
 * @param {object|null} opts.analysisReport   - parsed final-report.json (or null to auto-load)
 * @param {string[]}    [opts.scenarioIds]    - if provided, only run these scenarioIds
 * @param {object}      [opts.credentials]    - runtime credentials injected into context
 * @param {boolean}     [opts.headless]       - browser headless mode (default true)
 * @param {boolean}     [opts.stopOnFailure]  - override suite default
 * @returns {Promise<object>} Suite-level run report
 */
export async function runQASuite({
  suite,
  analysisReport    = null,
  scenarioIds       = null,
  credentials       = {},
  headless          = true,
  stopOnFailure     = null,
}) {
  // ── Step 1: Validate ────────────────────────────────────────────────────────
  const { valid, errors, warnings } = validateSuite(suite);
  if (!valid) {
    throw Object.assign(
      new Error(`Scenario suite validation failed:\n${errors.join('\n')}`),
      { validationErrors: errors, validationWarnings: warnings },
    );
  }

  // ── Step 2: Load analysis element map ──────────────────────────────────────
  const analysisData = analysisReport ?? await loadAnalysisReport(suite);
  const elementMap   = buildAnalysisElementMap(analysisData);

  // ── Step 3: Resolve execution policy ───────────────────────────────────────
  const defaults      = suite.defaults ?? {};
  const execPolicy    = defaults.executionPolicy ?? {};
  const safetyPolicy  = defaults.safety ?? {};
  const shouldStop    = stopOnFailure ?? execPolicy.stopOnFailure ?? true;
  const maxRetries    = execPolicy.maxStepRetries ?? 0;
  const baseURL       = suite.environment?.baseURL ?? '';

  const policy = {
    baseURL,
    safety:          safetyPolicy,
    executionPolicy: execPolicy,
  };

  // ── Step 4: Filter scenarios ────────────────────────────────────────────────
  const scenarios = scenarioIds
    ? suite.scenarios.filter(s => scenarioIds.includes(s.scenarioId))
    : suite.scenarios;

  // ── Step 5: Launch browser ──────────────────────────────────────────────────
  const browser = await chromium.launch({ headless });
  const viewport = suite.environment?.viewport ?? { width: 1280, height: 720 };
  const locale   = suite.environment?.locale ?? 'ko-KR';
  const timezone = suite.environment?.timezoneId ?? 'Asia/Seoul';

  const suiteStartedAt   = new Date().toISOString();
  const scenarioReports  = [];

  try {
    for (const scenario of scenarios) {
      const context = await browser.newContext({
        baseURL,
        viewport,
        locale,
        timezoneId: timezone,
      });
      const page = await context.newPage();

      const runtimeCtx = new RuntimeContext({
        data:        scenario.data ?? {},
        credentials,
      });

      const scenarioStartedAt   = new Date().toISOString();
      const preconditionResults = [];
      const stepResults         = [];
      let   scenarioPassed      = true;

      try {
        // ── Preconditions ─────────────────────────────────────────────────────
        for (const pre of (scenario.preconditions ?? [])) {
          const result = await executeStep(page, pre, runtimeCtx, elementMap, policy, 0);
          preconditionResults.push(result);
          if (result.status === 'failed' && pre.required !== false) {
            scenarioPassed = false;
            console.error(`[qa] [${scenario.scenarioId}] Precondition "${pre.stepId}" failed: ${result.error}`);
            break;
          }
        }

        // ── Main steps (only if preconditions passed) ─────────────────────────
        if (scenarioPassed) {
          for (const step of (scenario.steps ?? [])) {
            const result = await executeStep(page, step, runtimeCtx, elementMap, policy, maxRetries);
            stepResults.push(result);

            const failed = result.status === 'failed' || result.status === 'retried_then_failed';
            if (failed) {
              scenarioPassed = false;
              console.error(`[qa] [${scenario.scenarioId}] Step "${step.stepId}" failed: [${result.errorCode}] ${result.error}`);
              if (shouldStop && step.required !== false) break;
            }
          }
        }

      } catch (unexpectedErr) {
        console.error(`[qa] [${scenario.scenarioId}] Unexpected error:`, unexpectedErr);
        stepResults.push({
          stepId:    'unexpected',
          type:      'unknown',
          status:    'failed',
          errorCode: 'context_destroyed',
          error:     unexpectedErr.message,
          logs:      [unexpectedErr.message],
          artifacts: [],
        });
        scenarioPassed = false;
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }

      // ── Build scenario report ─────────────────────────────────────────────
      const scenarioReport = buildScenarioReport({
        suite,
        scenario,
        preconditionResults,
        stepResults,
        context:            runtimeCtx,
        startedAt:          scenarioStartedAt,
        validationWarnings: warnings,
      });

      scenarioReports.push(scenarioReport);

      console.log(`[qa] [${scenario.scenarioId}] ${scenarioReport.status.toUpperCase()} (${scenarioReport.durationMs}ms)`);

      if (!scenarioPassed && shouldStop) {
        console.warn(`[qa] Stopping suite after failed scenario "${scenario.scenarioId}"`);
        break;
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // ── Step 6: Build suite report ──────────────────────────────────────────────
  const suiteReport = buildSuiteReport(suite, scenarioReports, suiteStartedAt);

  // ── Step 7: Write reports ───────────────────────────────────────────────────
  await writeReports(suiteReport);

  return suiteReport;
}

// ── Analysis report loader ────────────────────────────────────────────────────

/**
 * Attempt to load the final-report.json for the analysis job referenced in
 * the suite's analysisContext.
 *
 * Looks in: outputs/{analysisJobId}/pages/ subdirectories (p001_, p002_, ...).
 * Returns the first final-report.json whose page.finalUrl matches suite.analysisContext.finalUrl.
 */
async function loadAnalysisReport(suite) {
  const jobId    = suite.analysisContext?.analysisJobId;
  const finalUrl = suite.analysisContext?.finalUrl;

  if (!jobId) {
    console.warn('[qa] analysisContext.analysisJobId not set; running without element map');
    return null;
  }

  const jobDir = path.join(OUTPUTS_DIR, jobId);

  try {
    await fs.access(jobDir);
  } catch {
    console.warn(`[qa] Analysis job directory not found: ${jobDir}`);
    return null;
  }

  // Try pages sub-directory first
  const pagesDir = path.join(jobDir, 'pages');
  try {
    const pageDirs = await fs.readdir(pagesDir);
    for (const pageDir of pageDirs) {
      const reportPath = path.join(pagesDir, pageDir, 'final-report.json');
      try {
        const raw    = await fs.readFile(reportPath, 'utf8');
        const report = JSON.parse(raw);
        if (!finalUrl || report.page?.finalUrl === finalUrl) {
          console.log(`[qa] Loaded analysis report: ${reportPath}`);
          return report;
        }
      } catch { /* try next */ }
    }
  } catch { /* no pages dir */ }

  // Fall back to root final-report.json
  const rootReport = path.join(jobDir, 'final-report.json');
  try {
    const raw    = await fs.readFile(rootReport, 'utf8');
    const report = JSON.parse(raw);
    console.log(`[qa] Loaded analysis report: ${rootReport}`);
    return report;
  } catch { /* not found */ }

  console.warn(`[qa] Could not locate final-report.json for job "${jobId}"`);
  return null;
}

// ── Report writer ─────────────────────────────────────────────────────────────

async function writeReports(suiteReport) {
  const runDir = path.join(QA_RUNS_DIR, suiteReport.runId);
  await fs.mkdir(runDir, { recursive: true });

  // Suite-level report
  await fs.writeFile(
    path.join(runDir, 'suite-report.json'),
    JSON.stringify(suiteReport, null, 2),
    'utf8',
  );

  // Per-scenario reports
  for (const scenarioReport of (suiteReport.scenarioReports ?? [])) {
    const safeName = (scenarioReport.scenarioId ?? 'scenario').replace(/[^a-zA-Z0-9-_]/g, '_');
    await fs.writeFile(
      path.join(runDir, `${safeName}.json`),
      JSON.stringify(scenarioReport, null, 2),
      'utf8',
    );
  }

  console.log(`[qa] Reports written to: ${runDir}`);
  return runDir;
}
