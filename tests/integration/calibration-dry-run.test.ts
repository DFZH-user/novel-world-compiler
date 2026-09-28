import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCalibrationDryRun, validateCalibrationDryRun } from '../../scripts/lib/calibration-dry-run';
import type { SceneCalibrationDataset } from '../../scripts/lib/scene-calibration';

const root = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1');

async function fixtures() {
  const dataset = JSON.parse(await fs.readFile(path.join(root, 'dataset.json'), 'utf8')) as SceneCalibrationDataset;
  const projection: unknown = JSON.parse(await fs.readFile(path.join(root, 'projection-run-v1.json'), 'utf8'));
  return { dataset, projection };
}

describe('real calibration dry-run context assembly', () => {
  it('assembles all Stage 1 receipts deterministically without model calls', async () => {
    const { dataset, projection } = await fixtures();
    const run = buildCalibrationDryRun(dataset, projection);
    expect(run).toMatchObject({ formalGoldStandard: false, modelCalls: 0, summary: { receiptCount: 18, assembledCount: 18, blockedCount: 0 } });
    expect(run.summary.futureKnowledgeDeniedCount).toBeGreaterThan(0);
    expect(run.summary.unknownKnowledgeDeniedCount).toBeGreaterThan(0);
    expect(run.summary.highScoreDeniedCount).toBe(run.summary.futureKnowledgeDeniedCount + run.summary.unknownKnowledgeDeniedCount);
    expect(validateCalibrationDryRun(dataset, projection, run)).toEqual({ valid: true, reproducible: true, formalGoldStandard: false, errors: [] });
  });

  it('pre-filters future and unknown knowledge before prompt rendering', async () => {
    const { dataset, projection } = await fixtures();
    const run = buildCalibrationDryRun(dataset, projection);
    const earlyWang = run.receipts.find((receipt) => receipt.projection.requestId === 'cal-a-night-ambush:cal-a-e1-anomaly:王扬')!;
    const future = earlyWang.excluded.find((item) => item.claimId === 'cal-a-attackers-are-yidu')!;
    expect(future).toMatchObject({ reason: 'projection_denied', projectionReason: 'future_knowledge', retrieval: { method: 'hybrid', score: 0.999 } });
    expect(earlyWang.finalPromptPreview).not.toContain('袭击者属于宜都蛮');

    const lateWang = run.receipts.find((receipt) => receipt.projection.requestId === 'cal-a-night-ambush:cal-a-e3-identity-inference:王扬')!;
    expect(lateWang.included.find((item) => item.claimId === 'cal-a-attackers-are-yidu'))
      .toMatchObject({ renderAs: 'character_belief', renderedText: '[角色信念，不代表世界真相] 袭击者属于宜都蛮' });

    const attackers = run.receipts.find((receipt) => receipt.projection.requestId === 'cal-a-night-ambush:cal-a-e2-feigned-unconscious:埋伏者')!;
    expect(attackers.included.find((item) => item.claimId === 'cal-a-wang-unconscious-after-first-fall'))
      .toMatchObject({ renderAs: 'character_belief', renderedText: '[角色信念，不代表世界真相] 王扬第一次被绳套拖倒后已经昏迷' });
  });

  it('keeps private knowledge present but explicitly non-disclosable', async () => {
    const { dataset, projection } = await fixtures();
    const run = buildCalibrationDryRun(dataset, projection);
    const shaman = run.receipts.find((receipt) => receipt.projection.requestId === 'cal-b-burning-rope:cal-b-e1-before-burning:大巫祝')!;
    expect(shaman.included.find((item) => item.claimId === 'cal-b-grand-shaman-wants-failure'))
      .toMatchObject({ renderAs: 'withheld_secret', renderedText: '[角色知道，但不得主动透露] 大巫祝希望用第二题使王扬失败' });
  });

  it('detects modified prompt receipts', async () => {
    const { dataset, projection } = await fixtures();
    const changed = structuredClone(buildCalibrationDryRun(dataset, projection));
    changed.receipts[0].included[0].renderedText = '被修改';
    expect(validateCalibrationDryRun(dataset, projection, changed)).toMatchObject({ valid: false, reproducible: false, formalGoldStandard: false });
  });
});
