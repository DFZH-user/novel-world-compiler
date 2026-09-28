import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCalibrationAbPackage, validateCalibrationAbPackage } from '../../scripts/lib/calibration-ab-pack';
import type { SceneCalibrationDataset } from '../../scripts/lib/scene-calibration';

const root = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1');

async function fixtures() {
  const dataset = JSON.parse(await fs.readFile(path.join(root, 'dataset.json'), 'utf8')) as SceneCalibrationDataset;
  const projection: unknown = JSON.parse(await fs.readFile(path.join(root, 'projection-run-v1.json'), 'utf8'));
  const dryRun: unknown = JSON.parse(await fs.readFile(path.join(root, 'dry-run-context-v1.json'), 'utf8'));
  return { dataset, projection, dryRun };
}

describe('calibration single-character A/B package', () => {
  it('prepares five cases and fifteen blind trials without model calls', async () => {
    const source = await fixtures();
    const built = buildCalibrationAbPackage(source.dataset, source.projection, source.dryRun);
    expect(built.packageData).toMatchObject({
      status: 'awaiting-explicit-model-approval', modelCalls: 0,
      execution: { caseCount: 5, runsPerCase: 3, plannedModelCalls: 30, billingAllowed: false },
    });
    expect(built.blindSheet.trials).toHaveLength(15);
    expect(built.blindKey.mappings).toHaveLength(15);
    expect(validateCalibrationAbPackage(source.dataset, source.projection, source.dryRun, built.packageData))
      .toEqual({ valid: true, reproducible: true, modelCalls: 0, errors: [] });
  });

  it('creates a meaningful public-only versus point-in-time comparison', async () => {
    const source = await fixtures();
    const built = buildCalibrationAbPackage(source.dataset, source.projection, source.dryRun);
    const early = built.packageData.cases.find((item) => item.id === 'early-suspicious-call')!;
    expect(early.prompts.A).not.toContain('[角色存疑]');
    expect(early.prompts.B).toContain('[角色存疑]');
    expect(early.prompts.B).not.toContain('山地部族');
    const late = built.packageData.cases.find((item) => item.id === 'late-identity-purpose')!;
    expect(late.prompts.A).not.toContain('山地部族');
    expect(late.prompts.B).toContain('[角色信念，不代表世界真相] 袭击者属于山地部族');
    expect(late.prompts.B).toContain('[角色信念，不代表世界真相] 袭击者准备留下行者甲用于火祭');
  });

  it('keeps the review sheet blind and detects manifest tampering', async () => {
    const source = await fixtures();
    const built = buildCalibrationAbPackage(source.dataset, source.projection, source.dryRun);
    expect(JSON.stringify(built.blindSheet)).not.toContain('public-entry.v1');
    expect(JSON.stringify(built.blindSheet)).not.toContain('point-in-time-context.v1');
    const changed: any = structuredClone(built.packageData);
    changed.execution.billingAllowed = true;
    expect(validateCalibrationAbPackage(source.dataset, source.projection, source.dryRun, changed))
      .toMatchObject({ valid: false, reproducible: false, modelCalls: 0 });
  });
});
