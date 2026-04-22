/**
 * Generate human-readable summary notes for a scenario execution.
 *
 * @param {object} scenario
 * @param {string} status   – 'passed' | 'failed' | 'skipped' | 'blocked'
 * @param {object} summary  – output of buildSummary()
 * @param {object[]} stepResults
 * @returns {string[]}
 */
const STATUS_KO = {
  passed:  '통과',
  partial: '부분 성공',
  failed:  '실패',
  skipped: '건너뜀',
  blocked: '차단됨',
};

export function buildNotes(scenario, status, summary, stepResults) {
  const notes = [];

  const { total, passed, failed, skipped, blocked } = summary;
  const statusKo = STATUS_KO[status] ?? status;
  notes.push(`시나리오 "${scenario.scenarioId}" 실행 결과: ${statusKo}`);
  notes.push(`스텝 합계: ${total}개 — 통과 ${passed}, 실패 ${failed}, 건너뜀 ${skipped}, 차단됨 ${blocked}`);

  if (summary.averageStepDurationMs > 0) {
    notes.push(`스텝 평균 소요 시간: ${summary.averageStepDurationMs}ms`);
  }
  if (summary.slowestStepId) {
    notes.push(`가장 느린 스텝: "${summary.slowestStepId}" (${findDuration(stepResults, summary.slowestStepId)}ms)`);
  }
  if (summary.fallbackLocatorUsageCount > 0) {
    notes.push(`폴백 로케이터 사용 ${summary.fallbackLocatorUsageCount}회 — 분석 데이터 업데이트를 권장합니다.`);
  }
  if (summary.retried > 0) {
    const retriedSteps = stepResults
      .filter(r => r.status === 'retried_then_passed')
      .map(r => `"${r.stepId ?? r.type}"`)
      .join(', ');
    notes.push(`재시도/완화 통과 스텝 ${summary.retried}개: ${retriedSteps}`);

    // Surface soft-pass (matcher returned `partial: true`) reasons explicitly.
    const partialReasons = stepResults
      .filter(r => r.status === 'retried_then_passed' && r.assertionResult?.partialReason)
      .map(r => `"${r.stepId ?? r.type}": ${r.assertionResult.partialReason}`);
    for (const reason of partialReasons) {
      notes.push(`부분 성공 사유 — ${reason}`);
    }
  }
  if (summary.assertionPassedCount > 0 || summary.assertionFailedCount > 0) {
    notes.push(`검증(assertion): 통과 ${summary.assertionPassedCount}, 실패 ${summary.assertionFailedCount}`);
  }

  const firstFailed = stepResults.find(r => r.status === 'failed');
  if (firstFailed) {
    notes.push(`첫 번째 실패 스텝 "${firstFailed.stepId ?? firstFailed.type}": ${firstFailed.error ?? firstFailed.errorCode ?? '알 수 없는 오류'}`);
  }

  return notes;
}

function findDuration(stepResults, stepId) {
  return stepResults.find(r => r.stepId === stepId)?.durationMs ?? 0;
}
