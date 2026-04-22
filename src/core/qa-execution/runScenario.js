import { RuntimeState }            from './runtime/runtimeState.js';
import { buildAnalysisElementMap } from './target-resolution/resolveAnalysisRef.js';
import { executeStep }             from './steps/executeStep.js';
import { buildScenarioReport }     from './report/buildRunReport.js';
import { installPopupAutoCloser, quickDismissPopups } from '../shared/popupDismisser.js';
import { clearStepFocus }          from './visual/focusIndicator.js';
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

  // Install background popup auto-closer for this scenario page so cookie
  // banners / coupon modals / consent overlays that appear AFTER navigation
  // do not block subsequent steps. Uninstalled in `finally`.
  const uninstallPopupCloser = installPopupAutoCloser(page, { intervalMs: 2000 });

  let preconditionResults, stepResults;
  try {
    preconditionResults = await runSteps(page, scenario.preconditions ?? [], state, elementMap, policy, defaults, 'pre', outputDir);
    stepResults         = await runSteps(page, scenario.steps ?? [],         state, elementMap, policy, defaults, 'step', outputDir);
  } finally {
    try { uninstallPopupCloser(); } catch { /* ignore */ }
    try { await clearStepFocus(page); } catch { /* ignore */ }
  }

  const report = buildScenarioReport({
    suite,
    scenario,
    preconditionResults,
    stepResults,
    state,
    startedAt,
    validationWarnings,
  });

  const STATUS_KO = { passed: '통과', partial: '부분 성공', failed: '실패', skipped: '건너뜀', blocked: '차단됨' };
  const icon = report.status === 'passed' ? '✅' : report.status === 'partial' ? '⚠️' : report.status === 'failed' ? '❌' : '⚠️';
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

    // Best-effort: clear any blocking modal that appeared since the previous
    // step (welcome coupon, cookie banner, app-install prompt, …).
    // This is bounded to ~250ms and never throws.
    try { await quickDismissPopups(page, { silent: true }); } catch { /* ignore */ }

    let result = await executeStep(page, step, state, elementMap, policy, { outputDir });

    // ── Retry logic ──────────────────────────────────────────────────────────
    // If the step failed and the policy allows retries, attempt the step again
    // (with popup dismissal between attempts).  A step that ultimately passes
    // after at least one retry is marked `retried_then_passed` so the report
    // can surface it as "partial success" instead of a clean pass.
    const maxRetries = defaults.retryCount ?? 0;
    let stepRetryCount = 0;
    if (result.status === 'failed' && maxRetries > 0) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        log(`┃  🔄 재시도 ${attempt}/${maxRetries} — [${step.stepId ?? step.type}]`);
        await new Promise(r => setTimeout(r, 600));
        try { await quickDismissPopups(page, { silent: true }); } catch { /* ignore */ }
        const retried = await executeStep(page, step, state, elementMap, policy, { outputDir });
        stepRetryCount = attempt;
        result = retried;
        if (retried.status !== 'failed') break;
      }
    }
    if (stepRetryCount > 0) {
      result = { ...result, retryCount: stepRetryCount };
      if (result.status === 'passed') result.status = 'retried_then_passed';
    }
    const ms = Date.now() - t0;
    const icon = result.status === 'passed' ? '✔' : result.status === 'retried_then_passed' ? '↺' : result.status === 'failed' ? '✘' : '⏭';
    const statusKo = result.status === 'passed' ? '통과' : result.status === 'retried_then_passed' ? '재시도 후 통과' : result.status === 'failed' ? '실패' : '건너뜀';
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

        // Build a Korean explanation of what failed.
        const failNotes = buildFailureExplanationKo(step, result);

        // Compute a target bbox (page-coordinate rect) we can highlight in red.
        // Priority: resolutionResult.bboxCenter → live locator.boundingBox().
        const bbox = await resolveFailureBbox(page, result.resolutionResult, step, result);

        try {
          await page.evaluate(({ msg, lines, rect }) => {
            const ID_BANNER  = '__qa_fail_banner__';
            const ID_HIGHLIGHT = '__qa_fail_highlight__';
            const ID_LABEL   = '__qa_fail_label__';
            document.getElementById(ID_BANNER)?.remove();
            document.getElementById(ID_HIGHLIGHT)?.remove();
            document.getElementById(ID_LABEL)?.remove();

            // Highlight box around the target element (page coordinates).
            if (rect && rect.w > 0 && rect.h > 0) {
              const hl = document.createElement('div');
              hl.id = ID_HIGHLIGHT;
              hl.style.cssText = [
                'position:absolute',
                `left:${rect.x}px`,
                `top:${rect.y}px`,
                `width:${rect.w}px`,
                `height:${rect.h}px`,
                'border:4px solid #ef4444',
                'box-shadow:0 0 0 3px rgba(239,68,68,0.35), 0 0 24px 4px rgba(239,68,68,0.55)',
                'background:rgba(239,68,68,0.10)',
                'border-radius:4px',
                'z-index:2147483646',
                'pointer-events:none',
              ].join(';');
              document.documentElement.appendChild(hl);

              const lbl = document.createElement('div');
              lbl.id = ID_LABEL;
              const labelTop = Math.max(0, rect.y - 28);
              lbl.style.cssText = [
                'position:absolute',
                `left:${rect.x}px`,
                `top:${labelTop}px`,
                'background:#ef4444',
                'color:#fff',
                'font:bold 12px/1 system-ui,Segoe UI,Arial,sans-serif',
                'padding:4px 8px',
                'border-radius:3px',
                'z-index:2147483647',
                'pointer-events:none',
                'white-space:nowrap',
              ].join(';');
              lbl.textContent = '⛔ 검증 실패 대상';
              document.documentElement.appendChild(lbl);
            }

            // Top banner with structured Korean explanation.
            const n = document.createElement('div');
            n.id = ID_BANNER;
            n.style.cssText = [
              'position:fixed',
              'left:0', 'top:0', 'right:0',
              'z-index:2147483647',
              'background:rgba(127,29,29,0.96)',
              'color:#fff',
              'font:14px/1.5 system-ui,Segoe UI,Arial,sans-serif',
              'padding:10px 16px',
              'pointer-events:none',
              'border-bottom:3px solid #ef4444',
              'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
            ].join(';');
            const titleHtml = `<div style="font-weight:800;font-size:15px;margin-bottom:4px">❌ ${msg}</div>`;
            const linesHtml = (lines || []).map(l =>
              `<div style="font-size:12.5px;opacity:0.95;margin-top:2px">• ${l}</div>`
            ).join('');
            n.innerHTML = titleHtml + linesHtml;
            document.documentElement.appendChild(n);
          }, {
            msg: `검증 실패: ${step.stepId ?? step.type} (${step.type})`,
            lines: failNotes,
            rect: bbox,
          }).catch(() => {});
        } catch {}

        await page.screenshot({ path: ssPath, fullPage: false }).catch(() => {});

        try {
          await page.evaluate(() => {
            document.getElementById('__qa_fail_banner__')?.remove();
            document.getElementById('__qa_fail_highlight__')?.remove();
            document.getElementById('__qa_fail_label__')?.remove();
          }).catch(() => {});
        } catch {}

        result.artifacts = result.artifacts ?? [];
        result.artifacts.push({
          type: 'screenshot',
          path: ssPath.replace(/\\/g, '/'),
          label: `failure: ${step.stepId ?? step.type}`,
          explanation: failNotes,
        });
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

// ── Failure visualization helpers ────────────────────────────────────────────

/**
 * Build a short, human-readable Korean explanation of why a step failed.
 * Returned as an array of bullet strings shown in the failure screenshot banner.
 */
function buildFailureExplanationKo(step, result) {
  const lines = [];
  const code  = result.errorCode;
  const ar    = result.assertionResult;

  if (step.name) lines.push(`스텝 설명: ${step.name}`);

  switch (code) {
    case 'target_not_found':
      lines.push('대상 요소를 화면에서 찾지 못했습니다 (analysisRef + locatorFallback 모두 실패).');
      break;
    case 'target_not_visible':
      lines.push('요소는 존재하지만 화면에 보이지 않습니다 (display:none / visibility:hidden / 뷰포트 밖).');
      break;
    case 'timeout':
      lines.push('지정된 시간 안에 동작/조건이 완료되지 않았습니다.');
      break;
    case 'assertion_failed':
      if (ar && (ar.expected !== undefined || ar.actual !== undefined)) {
        const exp = trimForBanner(ar.expected);
        const act = trimForBanner(ar.actual);
        lines.push(`기대: "${exp}"`);
        lines.push(`실제: "${act}"`);
      } else if (ar && (ar.before !== undefined || ar.current !== undefined)) {
        lines.push('이전 상태와 현재 상태가 동일합니다 — 클릭/입력 후 변화가 감지되지 않았습니다.');
      } else {
        lines.push('검증(assertion) 조건을 만족하지 않습니다.');
      }
      break;
    case 'navigation_blocked':
      lines.push('페이지 이동이 차단되었습니다 (allowExternalNavigation 정책 또는 호스트 제한).');
      break;
    case 'modal_blocked':
      lines.push('모달/팝업이 동작을 차단했습니다.');
      break;
    case 'context_destroyed':
      lines.push('실행 도중 페이지 컨텍스트가 파괴되었습니다 (예상 외 navigation).');
      break;
    case 'capture_failed':
      lines.push('값 캡처(capture)에 실패했습니다.');
      break;
    default:
      if (result.error) lines.push(`오류: ${trimForBanner(result.error)}`);
  }

  // Add resolved-locator hint when available — useful when the wrong element was hit.
  const r = result.resolutionResult;
  if (r?.method && r.method !== 'failed') {
    const fallback = r.wasFallbackUsed ? ' (폴백 로케이터)' : '';
    lines.push(`해석된 요소: ${r.locatorKind}="${trimForBanner(r.locatorValue, 60)}" cnt=${r.resolvedElementCount}${fallback}`);
  }

  return lines;
}

function trimForBanner(v, max = 120) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : JSON.stringify(v);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * Resolve a page-coordinate bounding box for the failure highlight.
 *  1. Use resolutionResult.bboxCenter if present (build a synthetic box around it).
 *  2. Otherwise re-resolve the step target and call boundingBox().
 *  3. Returns null if no box can be determined.
 */
async function resolveFailureBbox(page, resolutionResult, step, _result) {
  // Convert visible-coordinate bbox back to page coordinates by adding scrollY.
  const scroll = await page.evaluate(() => ({ x: window.scrollX || 0, y: window.scrollY || 0 })).catch(() => ({ x: 0, y: 0 }));

  // 1. resolutionResult bbox
  if (resolutionResult?.bbox && resolutionResult.bbox.width > 0) {
    const b = resolutionResult.bbox;
    return { x: b.x + scroll.x, y: b.y + scroll.y, w: b.width, h: b.height };
  }
  if (resolutionResult?.bboxCenter) {
    const c = resolutionResult.bboxCenter;
    const w = 240, h = 60;
    return { x: c.x + scroll.x - w / 2, y: c.y + scroll.y - h / 2, w, h };
  }

  // 2. Re-resolve the locator and ask Playwright for its bounding box.
  if (step.targetRef) {
    try {
      const { resolveTarget } = await import('./target-resolution/resolveTarget.js');
      const resolved = await resolveTarget(page, step, null);
      const loc = resolved.locator;
      if (loc) {
        const box = await loc.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.height > 0) {
          return { x: box.x + scroll.x, y: box.y + scroll.y, w: box.width, h: box.height };
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}
