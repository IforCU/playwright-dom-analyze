import { resolveAnalysisRef }   from './resolveAnalysisRef.js';
import { resolveLocatorFallback } from './resolveLocatorFallback.js';

const FAILED_RESULT = {
  method:               'failed',
  nodeId:               null,
  locatorKind:          null,
  locatorValue:         null,
  wasFallbackUsed:      false,
  resolvedElementCount: 0,
};

/**
 * Resolve a step's targetRef to a Playwright locator.
 *
 * Resolution order:
 *   1. analysisRef      – nodeId로 분석 리포트의 로케이터 목록 시도
 *   2. bboxCoordinate   – analysisRef 로케이터 전부 실패 시 bbox 좌표 기반 XPath 해석 (analysisRef 내부 자동 폴백)
 *   3. locatorFallback  – 스텝에 선언된 fallback 로케이터 시도
 *   4. Failed           – 모두 실패 시 { locator: null, resolutionResult: { method: 'failed' } }
 *
 * The step.resolution.preferred field can override the order:
 *   'analysisRef' (default) | 'locatorFallback'
 *
 * @param {import('playwright').Page} page
 * @param {object} step               – the full step object
 * @param {object|null} elementMap    – nodeId → element, from resolveAnalysisRef.buildAnalysisElementMap
 * @returns {Promise<{ locator: import('playwright').Locator|null, resolutionResult: object }>}
 */
export async function resolveTarget(page, step, elementMap) {
  const targetRef  = step.targetRef ?? step.assertion?.targetRef ?? null;
  const resolution = step.resolution ?? step.assertion?.resolution ?? {};

  if (!targetRef) {
    return { locator: null, resolutionResult: null };
  }

  const nodeId    = targetRef.nodeId ?? null;
  const preferred = resolution.preferred ?? 'analysisRef';
  const fallback  = resolution.locatorFallback ?? null;

  // ── 1. Try analysisRef first (unless caller prefers fallback) ────────────
  if (preferred !== 'locatorFallback' && nodeId && elementMap) {
    const hit = await resolveAnalysisRef(page, nodeId, elementMap);
    if (hit) return hit;
  }

  // ── 2. Try declared locatorFallback ─────────────────────────────────────
  if (fallback) {
    const hit = await resolveLocatorFallback(page, fallback, nodeId);
    if (hit) return hit;
  }

  // ── 3. If preferred was locatorFallback but nothing found, try analysisRef ──
  if (preferred === 'locatorFallback' && nodeId && elementMap) {
    const hit = await resolveAnalysisRef(page, nodeId, elementMap);
    if (hit) return hit;
  }

  return {
    locator:          null,
    resolutionResult: { ...FAILED_RESULT, nodeId },
  };
}
