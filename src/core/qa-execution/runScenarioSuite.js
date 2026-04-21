import { mkdir, writeFile }      from 'node:fs/promises';
import { join }                  from 'node:path';
import { randomUUID }            from 'node:crypto';

import { validateSuite }         from '../qa/validator.js';
import { resolveDefaults }       from './defaultsResolver.js';
import { loadScenarios, loadAnalysisReport } from './scenarioLoader.js';
import { launchBrowser, createScenarioContext } from './buildExecutionContext.js';
import { runScenario }           from './runScenario.js';
import { buildSuiteReport }      from './report/buildRunReport.js';

const QA_RUNS_DIR = 'outputs/qa-runs';

function makeLogger() {
  const lines = [];
  const log = (msg) => {
    console.log(`[qa] ${msg}`);
    lines.push(msg);
  };
  return { log, lines };
}

export async function runScenarioSuite({ suite, analysisReport, scenarioIds, credentials, headless, stopOnFailure, record = true } = {}) {
  const { log, lines: executionLog } = makeLogger();

  // 1. Validate
  log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`Suite: ${suite?.suiteId ?? '(unknown)'}  ${suite?.title ?? ''}`);
  const validation = await validateSuite(suite);
  if (!validation.valid) {
    log(`❌ 유효성 검사 실패 (${validation.errors.length}개 오류):`);
    validation.errors.forEach(e => log(`   • ${e}`));
    throw new Error(`스위트 유효성 검사 실패:\n${validation.errors.join('\n')}`);
  }
  if (validation.warnings?.length) {
    validation.warnings.forEach(w => log(`   ⚠ ${w}`));
  }
  log(`✔ 유효성 검사 통과`);

  // 2. Load defaults + scenarios
  const suiteDefaults = resolveDefaults(suite, {
    headless:      headless      ?? undefined,
    stopOnFailure: stopOnFailure ?? undefined,
  });
  const scenarios = loadScenarios(suite, scenarioIds);
  if (scenarios.length === 0) throw new Error('스위트에서 매칭되는 시나리오를 찾을 수 없습니다.');
  log(`실행할 시나리오: ${scenarios.length}개  [${scenarios.map(s => s.scenarioId).join(', ')}]`);

  // 3. Load analysis report
  let analysis = analysisReport ?? null;
  let reportSource = '직접 제공';
  if (!analysis) {
    analysis = await loadAnalysisReport(suite);
    const jobId = suite?.analysisContext?.analysisJobId ?? suite?.analysisJobId;
    reportSource = analysis ? `자동 로드 (jobId=${jobId})` : '없음';
  }
  log(`분석 리포트: ${analysis ? `로드 완료 [${reportSource}]  요소 수=${analysis.elements?.length ?? 0}` : '없음 — locatorFallback 전용으로 실행'}`);

  // 4. Prepare output dirs (runId assigned now so video dirs exist before context opens)
  const runId    = randomUUID();
  const runDir   = join(QA_RUNS_DIR, runId);
  await mkdir(runDir, { recursive: true });

  // 5. Launch browser (reused, one context per scenario for video isolation)
  log(`브라우저: headless=${suiteDefaults.headless}  baseURL=${suiteDefaults.baseURL}`);
  const browser = await launchBrowser(suiteDefaults);
  log(`브라우저 실행 완료  (record=${record})`);

  const startedAt       = new Date().toISOString();
  const scenarioReports = [];
  let   aborted         = false;

  try {
    for (const [i, scenario] of scenarios.entries()) {
      if (aborted) {
        log(`⏭ 시나리오 [${scenario.scenarioId}] 건너뛰 (스위트 중단 상태)`);
        break;
      }

      const safeId      = (scenario.scenarioId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const scenarioDir = join(runDir, safeId);
      await mkdir(scenarioDir, { recursive: true });

      const scenarioDefaults = resolveDefaults(suite, {
        ...(scenario.overrides ?? {}),
        headless,
        stopOnFailure,
      });

      // Per-scenario browser context (enables video recording per scenario)
      const videoDir = record ? scenarioDir : null;
      const traceOutputPath = scenarioDefaults.saveTrace
        ? join(scenarioDir, 'trace.zip')
        : null;

      log(`\n[${i + 1}/${scenarios.length}] 시나리오: ${scenario.scenarioId}  dir=${safeId}`);

      const { page, closeContext } = await createScenarioContext(browser, scenarioDefaults, {
        videoDir,
        traceOutputPath,
      });

      let report;
      try {
        const result = await runScenario({
          suite,
          scenario,
          analysisReport:     analysis,
          defaults:           scenarioDefaults,
          credentials:        credentials ?? suite.credentials ?? {},
          page,
          validationWarnings: validation.warnings ?? [],
          outputDir:          scenarioDir,
        });
        report = result.report;
      } finally {
        const { videoPath } = await closeContext();
        if (videoPath) {
          log(`┃  🎬 영상 저장 완료 → ${videoPath}`);
          report = report ?? {};
          report.videoPath = videoPath;
        }
      }

      // Write per-scenario JSON
      report.outputDir = scenarioDir;
      await writeFile(join(scenarioDir, 'result.json'), JSON.stringify(report, null, 2));

      scenarioReports.push(report);

      if (report.status === 'failed' && scenarioDefaults.stopOnFailure) {
        log(`⛔ stopOnFailure 조건 충족 — [${scenario.scenarioId}] 실패하여 스위트 중단`);
        aborted = true;
      }
    }
  } finally {
    await browser.close().catch(() => {});
    log(`브라우저 종료`);
  }

  // 6. Build + write suite report
  const suiteReport = buildSuiteReport(suite, scenarioReports, startedAt);
  suiteReport.runId = runId;   // override with our pre-assigned runId

  await writeFile(join(runDir, 'suite-report.json'), JSON.stringify(suiteReport, null, 2));
  // Also write flat per-scenario JSONs at runDir root for backwards compatibility
  for (const sr of scenarioReports) {
    const safeId = (sr.scenarioId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    await writeFile(join(runDir, `${safeId}.json`), JSON.stringify(sr, null, 2));
  }

  const passed = scenarioReports.filter(r => r.status === 'passed').length;
  const failed = scenarioReports.filter(r => r.status === 'failed').length;
  log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`스위트 완료: 통과 ${passed} / 실패 ${failed}  →  ${runDir}`);

  return { suiteReport, runId, outputDir: runDir, executionLog };
}
