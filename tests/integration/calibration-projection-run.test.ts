import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCalibrationProjectionRun, validateCalibrationProjectionRun } from '../../scripts/lib/calibration-projection-run';
import type { SceneCalibrationDataset } from '../../scripts/lib/scene-calibration';

const datasetPath = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1/dataset.json');

describe('real calibration point-in-time projection run', () => {
  it('replays all seven entries for their declared subjects without model calls', async () => {
    const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8')) as SceneCalibrationDataset;
    const run = buildCalibrationProjectionRun(dataset);
    expect(run).toMatchObject({ formalGoldStandard: false, modelCalls: 0, summary: { caseCount: 2, entryCount: 7, subjectProjectionCount: 18 } });
    expect(run.receipts).toHaveLength(18);
    expect(run.summary.decisionCount).toBe(run.receipts.reduce((sum, receipt) => sum + receipt.projections.length, 0));
    expect(run.summary.futureKnowledgeExclusionCount).toBeGreaterThan(0);
    expect(run.summary.unknownKnowledgeExclusionCount).toBeGreaterThan(0);
    expect(validateCalibrationProjectionRun(dataset, run)).toEqual({ valid: true, reproducible: true, formalGoldStandard: false, errors: [] });
  });

  it('keeps approved temporal and epistemic distinctions in the real fixtures', async () => {
    const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8')) as SceneCalibrationDataset;
    const run = buildCalibrationProjectionRun(dataset);
    const byRequest = new Map(run.receipts.map((receipt) => [receipt.requestId, receipt]));
    const earlyWang = byRequest.get('cal-a-night-ambush:cal-a-e1-anomaly:王扬')!;
    expect(earlyWang.projections.find((projection) => projection.claimId === 'cal-a-attackers-are-yidu')?.runtime)
      .toMatchObject({ policy: 'must_exclude', reason: 'future_knowledge' });
    const lateWang = byRequest.get('cal-a-night-ambush:cal-a-e3-identity-inference:王扬')!;
    expect(lateWang.projections.find((projection) => projection.claimId === 'cal-a-attackers-are-yidu')?.runtime)
      .toMatchObject({ policy: 'must_include', renderAs: 'character_belief' });
    const attackers = byRequest.get('cal-a-night-ambush:cal-a-e2-feigned-unconscious:埋伏者')!;
    expect(attackers.projections.find((projection) => projection.claimId === 'cal-a-wang-unconscious-after-first-fall'))
      .toMatchObject({ world: { truthStatus: 'false' }, character: { epistemicState: 'believed' }, runtime: { renderAs: 'character_belief' } });
    const crowd = byRequest.get('cal-b-burning-rope:cal-b-e4-belief-update:普通围观者')!;
    expect(crowd.projections.find((projection) => projection.claimId === 'cal-b-salt-mechanism'))
      .toMatchObject({ readerDisclosure: 'disclosed', character: { epistemicState: 'unknown' }, runtime: { policy: 'must_exclude' } });
    expect(crowd.projections.find((projection) => projection.claimId === 'cal-b-wang-is-supernatural-envoy'))
      .toMatchObject({ world: { truthStatus: 'unresolved' }, character: { epistemicState: 'believed' }, runtime: { renderAs: 'character_belief' } });
  });

  it('detects modified projection receipts', async () => {
    const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8')) as SceneCalibrationDataset;
    const changed = structuredClone(buildCalibrationProjectionRun(dataset));
    changed.receipts[0].projections[0].runtime.reason = 'irrelevant';
    expect(validateCalibrationProjectionRun(dataset, changed)).toMatchObject({ valid: false, reproducible: false, formalGoldStandard: false });
  });
});
