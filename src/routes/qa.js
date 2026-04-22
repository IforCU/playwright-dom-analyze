/**
 * routes/qa.js
 *
 * POST /qa/run  — Validate and execute a QA scenario suite.
 * POST /qa/validate — Validate only (no browser launched).
 *
 * Request body for /qa/run  (accepts 2 JSON inputs):
 * {
 *   "suite":          { ...QA_senario.json 전체 },           // required — 시나리오 스위트
 *   "analysisReport": { ...final-report.json 전체 } | null,  // 권장 — DOM 분석 리포트를 직접 전달
 *                       // null이면 suite.analysisContext.analysisJobId로 디스크에서 자동 로드
 *   "scenarioIds":    ["11ST-HOME-SEARCH-001"],               // optional — 특정 시나리오만 실행
 *   "credentials":    { "username": "...", ... },             // optional
 *   "headless":       true,                                   // optional (기본값 true)
 *   "stopOnFailure":  true                                    // optional override
 * }
 *
 * Response for /qa/run:
 * {
 *   "status":       "passed" | "failed",
 *   "runId":        "uuid",
 *   "outputPath":   "outputs/qa-runs/{runId}/",
 *   "suiteReport":  { ...fullReport }
 * }
 *
 * Response for /qa/validate:
 * {
 *   "valid":    boolean,
 *   "errors":   string[],
 *   "warnings": string[]
 * }
 */

import express               from 'express';
import { readdir, readFile }  from 'node:fs/promises';
import { join }               from 'node:path';
import { runScenarioSuite }  from '../core/qa-execution/index.js';
import { validateSuite }     from '../core/qa/validator.js';

const router = express.Router();
const QA_RUNS_DIR = 'outputs/qa-runs';

// ── POST /qa/validate ─────────────────────────────────────────────────────────
router.post('/qa/validate', (req, res) => {
  const { suite } = req.body ?? {};
  if (!suite) {
    return res.status(400).json({ status: 'error', error: 'Request body must include "suite"' });
  }

  try {
    const result = validateSuite(suite);
    res.json(result);
  } catch (err) {
    console.error('[qa/validate] Unexpected error:', err.message);
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── POST /qa/run ──────────────────────────────────────────────────────────────
router.post('/qa/run', async (req, res) => {
  const {
    suite,
    analysisReport       = null,
    scenarioIds          = null,
    credentials          = {},
    headless             = true,
    stopOnFailure        = null,
    maxParallelScenarios = null,
  } = req.body ?? {};

  if (!suite) {
    return res.status(400).json({ status: 'error', error: 'Request body must include "suite"' });
  }

  console.log(`[qa/run] Received suite "${suite.suiteId}" with ${suite.scenarios?.length ?? 0} scenario(s)`);

  try {
    const { suiteReport, runId, executionLog } = await runScenarioSuite({
      suite,
      analysisReport,
      scenarioIds:  Array.isArray(scenarioIds) ? scenarioIds : null,
      credentials,
      headless:     headless !== false,
      stopOnFailure,
      maxParallelScenarios: Number.isFinite(+maxParallelScenarios) && +maxParallelScenarios > 0
        ? Math.floor(+maxParallelScenarios)
        : null,
    });

    res.json({
      status:       suiteReport.status,
      runId:        runId,
      outputPath:   `outputs/qa-runs/${runId}/`,
      executionLog: executionLog ?? [],
      suiteReport,
    });
  } catch (err) {
    console.error('[qa/run] Error:', err.message, err.stack);

    // Validation failures return 422 with structured error list
    if (err.validationErrors) {
      return res.status(422).json({
        status:           'validation_failed',
        error:            err.message,
        validationErrors: err.validationErrors,
        warnings:         err.validationWarnings ?? [],
      });
    }

    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── GET /qa/runs ──────────────────────────────────────────────────────────────
// Returns a list of past QA runs sorted ascending by runId (= time prefix).
// Each entry contains lightweight metadata read from suite-report.json.
router.get('/qa/runs', async (_req, res) => {
  try {
    let entries;
    try {
      entries = await readdir(QA_RUNS_DIR, { withFileTypes: true });
    } catch {
      return res.json({ runs: [] }); // directory doesn't exist yet
    }

    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort(); // lexicographic = chronological because runId starts with timestamp

    const runs = await Promise.all(dirs.map(async (runId) => {
      const reportPath = join(QA_RUNS_DIR, runId, 'suite-report.json');
      try {
        const raw    = await readFile(reportPath, 'utf8');
        const report = JSON.parse(raw);
        return {
          runId,
          status:      report.status ?? 'unknown',
          suiteId:     report.suiteId ?? null,
          suiteName:   report.suiteName ?? null,
          startedAt:   report.startedAt ?? null,
          durationMs:  report.durationMs ?? null,
          summary:     report.summary ?? {},
        };
      } catch {
        // suite-report.json not yet written (run in progress) or corrupt
        return { runId, status: 'unknown' };
      }
    }));

    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
