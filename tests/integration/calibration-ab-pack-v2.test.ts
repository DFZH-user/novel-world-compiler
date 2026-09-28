import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCalibrationAbPackageV2, EPISTEMIC_GUARD_VERSION } from '../../scripts/lib/calibration-ab-pack-v2';
import type { SceneCalibrationDataset } from '../../scripts/lib/scene-calibration';

const root = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1');

async function fixtures() {
  return Promise.all([
    fs.readFile(path.join(root, 'dataset.json'), 'utf8').then(JSON.parse) as Promise<SceneCalibrationDataset>,
    fs.readFile(path.join(root, 'projection-run-v1.json'), 'utf8').then(JSON.parse) as Promise<unknown>,
    fs.readFile(path.join(root, 'dry-run-context-v1.json'), 'utf8').then(JSON.parse) as Promise<unknown>,
  ]);
}

describe('Stage 4 epistemic guard v2 package', () => {
  it('preserves the experiment while strengthening stance and evidence rules', async () => {
    const [dataset, projection, dryRun] = await fixtures();
    const built = buildCalibrationAbPackageV2(dataset, projection, dryRun);
    expect(built.packageData).toMatchObject({ version: '1.1', promptPolicyVersion: EPISTEMIC_GUARD_VERSION, modelCalls: 0 });
    expect(built.packageData.cases).toHaveLength(5);
    expect(built.blindKey.mappings).toHaveLength(15);
    expect(built.blindSheet.trials).toHaveLength(15);
    for (const item of built.packageData.cases) {
      for (const prompt of [item.prompts.A, item.prompts.B]) {
        expect(prompt).toContain('不得说“我认定 / 我敢肯定 / 已确定 / 已证实”');
        expect(prompt).toContain('不得自行补写地点、动作、外观、被捆绑、移动方向或其他证据');
      }
    }
  });

  it('is deterministic and keeps v1 immutable as its recorded parent', async () => {
    const [dataset, projection, dryRun] = await fixtures();
    const first = buildCalibrationAbPackageV2(dataset, projection, dryRun);
    const second = buildCalibrationAbPackageV2(dataset, projection, dryRun);
    expect(first.packageData.packageId).toBe(second.packageData.packageId);
    expect(first.packageData.derivedFromPackageId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.packageData.packageId).not.toBe(first.packageData.derivedFromPackageId);
  });
});
