import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRobustnessPlan } from '../../scripts/lib/deepseek-ab-robustness';

const root = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1/stage4-ab-wang-v2');

describe('DeepSeek stochastic robustness plan', () => {
  it('plans 100 calls across five cases with balanced blind order', async () => {
    const [manifest, blindKey] = await Promise.all([
      fs.readFile(path.join(root, 'manifest.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(root, 'blind-key.json'), 'utf8').then(JSON.parse),
    ]);
    const plan = buildRobustnessPlan(manifest, blindKey, 10);
    expect(plan).toHaveLength(50);
    expect(new Set(plan.map((item) => item.replicateId)).size).toBe(50);
    const grouped = new Map<string, typeof plan>();
    for (const item of plan) grouped.set(item.caseId, [...(grouped.get(item.caseId) ?? []), item]);
    for (const group of grouped.values()) {
      expect(group).toHaveLength(10);
      expect(group.filter((item) => item.sourceTrialId.endsWith('run-1'))).toHaveLength(5);
      expect(group.filter((item) => item.sourceTrialId.endsWith('run-2'))).toHaveLength(5);
    }
  });

  it('rejects an excessive repeat count', () => {
    expect(() => buildRobustnessPlan({ cases: [] }, {}, 11)).toThrow('1–10');
  });
});
