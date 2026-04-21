import { RuntimeState }            from './runtime/runtimeState.js';
import { buildAnalysisElementMap } from './target-resolution/resolveAnalysisRef.js';
import { executeStep }             from './steps/executeStep.js';
import { buildScenarioReport }     from './report/buildRunReport.js';
import { mkdir, writeFile }        from 'node:fs/promises';
import { join }                    from 'node:path';

function log(msg) { console.log(`[qa] ${msg}`); }

/**
 * Execute a single scenario: preconditions → steps → report.
 *
 * @param {object} params
 * @param {string} [params.outputDir]  – per-scenario output directory for screenshots
 */
export async function runScenario({ suite, scenario, analysisReport, defaults, credentials, page, validationWarnings = [], outputDir }) {
  const startedAt    = new Date().toISOString();
  const elementMap   = buildAnalysisElementMap(analysisReport);
  const state        = new RuntimeState({ data: scenario.data ?? {}, credentials: credentials ?? {} });
  const policy       = defaults;

  log(`\n┏━━ Scenario: [${scenario.scenarioId}] ${scenario.title ?? scenario.name ?? ''}`);
  if (Object.keys(scenario.data ?? {}).length) {
    log(`┃  data: ${JSON.stringify(scenario.data)}`);
  }
  if (!analysisReport) {
    log(`┃  ⚠ 분석 리포트가 로드되지 않음 — analysisRef 방식은 건너때집니다`);
  }

  if (outputDir) await mkdir(outputDir, { recursive: true });

  const preconditionResults = await runSteps(page, scenario.preconditions ?? [], state, elementMap, policy, defaults, 'pre', outputDir);
  const stepResults         = await runSteps(page, scenario.steps ?? [],         state, elementMap, policy, defaults, 'step', outputDir);

  const report = buildScenarioReport({
    suite,
    scenario,
    preconditionResults,
    stepResults,
    state,
    startedAt,
    validationWarnings,
  });

  const STATUS_KO = { passed: '통과', failed: '실패', skipped: '건너뜀', blocked: '차단됨' };
  const icon = report.status === 'passed' ? '✅' : report.status === 'failed' ? '❌' : '⚠️';
  log(`┗━━ ${icon} ${STATUS_KO[report.status] ?? report.status}  [${scenario.scenarioId}]  (${report.durationMs}ms)\n`);

  return { report, state };
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function runSteps(page, steps, state, elementMap, policy, defaults, phase = 'step', outputDir) {
  const results = [];
  let blocked   = false;
  let ssIndex   = 0;

  for (const step of steps) {
    if (blocked) {
    log(`┃  ⏭ [스텝] ${step.stepId ?? step.type}  →  건너떄 (이전 실패로 차단)`);
      results.push(skippedResult(step));
      continue;
    }

    const t0 = Date.now();
    log(`┃  ▶ [${phase === 'pre' ? '사전조건' : '스텝'}] ${step.stepId ?? step.type}  (${step.type})`);

    const result = await executeStep(page, step, state, elementMap, policy);
    const ms = Date.now() - t0;
    const icon = result.status === 'passed' ? '✔' : result.status === 'failed' ? '✘' : '⏭';
    const statusKo = result.status === 'passed' ? '통과' : result.status === 'failed' ? '실패' : '건너떄';
    log(`┃     ${icon} ${statusKo}  ${ms}ms${result.error ? `  → ${result.error}` : ''}`);

    if (result.capturedOutput?.saveAs) {
      const val = result.capturedOutput.value;
      const display = Buffer.isBuffer(val)
        ? '<screenshot buffer>'
        : typeof val === 'object' ? JSON.stringify(val) : String(val ?? '');
      log(`┃     📌 캡쳐: ${result.capturedOutput.saveAs} = ${display.slice(0, 100)}`);
    }
    if (result.assertionResult && !result.assertionResult.passed) {
      log(`┃     검증 실패: 예상값=${JSON.stringify(result.assertionResult.expected)}  실제값=${JSON.stringify(result.assertionResult.actual)}`);
    }
    if (result.expectedSignalResults?.length) {
      for (const sig of result.expectedSignalResults) {
        const ok = sig.passed ? '✔' : (sig.required ? '✘' : '○');
        log(`┃     시그널 ${ok} ${sig.type}: 관측=${sig.observed}${sig.detail?.reason ? `  (이유: ${sig.detail.reason})` : ''}`);
      }
    }
    if (result.resolutionResult?.method) {
      const r = result.resolutionResult;
      if (r.method === 'failed') {
        log(`┃     ⚠ 로케이터 검색 실패 (nodeId=${r.nodeId})`);
      } else if (r.method === 'bboxCoordinate') {
        log(`┃     📍 bbox 좌표 해석 성공: (${r.bboxCenter?.x}, ${r.bboxCenter?.y}) → xpath`);
      } else {
        log(`┃     로케이터: ${r.method}  ${r.locatorKind}="${r.locatorValue}"  count=${r.resolvedElementCount}${r.wasFallbackUsed ? '  [폴백 사용]' : ''}`);
      }
    }

    // Screenshot on failure
    if (result.status === 'failed' && defaults.captureOnFailure !== false && outputDir) {
      try {
        ssIndex++;
        const ssName = `fail-${String(ssIndex).padStart(2, '0')}-${(step.stepId ?? step.type).replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
        const ssPath = join(outputDir, ssName);
        await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});
        result.artifacts = result.artifacts ?? [];
        result.artifacts.push({ type: 'screenshot', path: ssPath, label: `failure: ${step.stepId ?? step.type}` });
        log(`┃     📷 스크린샷 저장 → ${ssName}`);
      } catch { /* non-critical */ }
    }

    results.push(result);

    if (result.status === 'failed' && (result.required ?? true) && defaults.stopOnFailure) {
      log(`┃  ⛔ stopOnFailure 조건 충족 — [${step.stepId ?? step.type}] 실패 후 스키폄마캐요 중단`);
      blocked = true;
    }
  }

  return results;
}

// ── Private helpers ───────────────────────────────────────────────────────────

function skippedResult(step) {
  const now = new Date().toISOString();
  return {
    stepId:               step.stepId ?? null,
    name:                 step.name   ?? step.type,
    type:                 step.type,
    required:             step.required ?? true,
    status:               'skipped',
    startedAt:            now,
    finishedAt:           now,
    durationMs:           0,
    logs:                 ['이전 필수 스텝 실패로 인해 이 스텝이 건너뛰어졌습니다.'],
    error:                null,
    errorCode:            null,
    resolutionResult:     null,
    capturedOutput:       null,
    assertionResult:      null,
    expectedSignalResults: [],
    artifacts:            [],
  };
}
