import { readdir, readFile } from 'node:fs/promises';
import { join }              from 'node:path';

const OUTPUTS_DIR = 'outputs';

export function loadScenarios(suite, scenarioIds) {
  const all = suite?.scenarios ?? [];
  if (!scenarioIds?.length) return all;           // ← 이 줄이 없으면 항상 빈 배열 반환
  const idSet = new Set(scenarioIds);
  return all.filter(s => idSet.has(s.scenarioId));
}

export async function loadAnalysisReport(suite) {
  const jobId = suite?.analysisJobId ?? suite?.analysisContext?.analysisJobId;
  if (!jobId) return null;
  const jobDir = join(OUTPUTS_DIR, jobId);
  try {
    const pagesDir = join(jobDir, 'pages');
    const entries = await readdir(pagesDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(pagesDir, entry.name, 'final-report.json');
      const report = await tryReadJson(candidate);
      if (report) return report;
    }
  } catch { /* pages dir may not exist */ }
  const rootCandidate = join(jobDir, 'final-report.json');
  return tryReadJson(rootCandidate);
}

async function tryReadJson(p) {
  try {
    const raw = await readFile(p, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
