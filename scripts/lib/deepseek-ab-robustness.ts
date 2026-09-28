import { selectSmokeTrial } from './deepseek-ab-smoke';

export interface RobustnessTask {
  replicateId: string;
  caseId: string;
  replicateOrdinal: number;
  sourceTrialId: string;
}

export function buildRobustnessPlan(manifest: unknown, blindKey: unknown, repeatsPerCase: number): RobustnessTask[] {
  if (!Number.isInteger(repeatsPerCase) || repeatsPerCase < 1 || repeatsPerCase > 10) {
    throw new Error('repeatsPerCase 必须是 1–10 的整数');
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray((manifest as { cases?: unknown }).cases)) {
    throw new Error('manifest 缺少 cases');
  }
  const caseIds = (manifest as { cases: Array<{ id?: unknown }> }).cases.map((item) => {
    if (typeof item.id !== 'string') throw new Error('manifest case 缺少 id');
    return item.id;
  });
  return caseIds.flatMap((caseId) => Array.from({ length: repeatsPerCase }, (_, index) => {
    const replicateOrdinal = index + 1;
    const sourceTrialId = `${caseId}:run-${replicateOrdinal % 2 === 1 ? 1 : 2}`;
    selectSmokeTrial(manifest, blindKey, sourceTrialId);
    return {
      replicateId: `${caseId}:stochastic-${String(replicateOrdinal).padStart(2, '0')}`,
      caseId,
      replicateOrdinal,
      sourceTrialId,
    };
  }));
}
