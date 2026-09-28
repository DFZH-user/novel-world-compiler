import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCalibrationAbPackageV3, EPISTEMIC_GUARD_V3 } from '../../scripts/lib/calibration-ab-pack-v3';
import type { SceneCalibrationDataset } from '../../scripts/lib/scene-calibration';

const root = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1');

describe('Stage 4 epistemic guard v3 package', () => {
  it('prevents both belief promotion and known-fact demotion', async () => {
    const [dataset, projection, dryRun] = await Promise.all([
      fs.readFile(path.join(root, 'dataset.json'), 'utf8').then(JSON.parse) as Promise<SceneCalibrationDataset>,
      fs.readFile(path.join(root, 'projection-run-v1.json'), 'utf8').then(JSON.parse) as Promise<unknown>,
      fs.readFile(path.join(root, 'dry-run-context-v1.json'), 'utf8').then(JSON.parse) as Promise<unknown>,
    ]);
    const built = buildCalibrationAbPackageV3(dataset, projection, dryRun);
    expect(built.packageData).toMatchObject({ version: '1.2', promptPolicyVersion: EPISTEMIC_GUARD_V3, modelCalls: 0 });
    expect(built.packageData.packageId).not.toBe(built.packageData.derivedFromPackageId);
    for (const item of built.packageData.cases) {
      for (const prompt of [item.prompts.A, item.prompts.B]) {
        expect(prompt).toContain('[角色已知]、[公开事实基线]必须作为当前已经确定的信息表达');
        expect(prompt).toContain('将其降级');
        expect(prompt).toContain('不得说“我认定 / 我敢肯定 / 已确定 / 已证实”');
      }
    }
  });
});
