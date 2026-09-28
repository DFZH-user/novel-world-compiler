import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blankSceneReview,
  buildSceneCalibrationDataset,
  sceneDigest,
  validateOwnerProvisionalApproval,
  validateSceneReview,
  type SceneCalibrationReview,
} from '../../scripts/lib/scene-calibration';
import { checkSceneCalibration, prepareSceneCalibration } from '../../scripts/lib/prepare-scene-calibration-entry';

function fixture() {
  const paragraphs = Array.from({ length: 12 }, (_, index) => ({
    id: `p-${index + 1}`,
    ordinal: index + 1,
    chapterTitle: index < 6 ? '第一章' : '第二章',
    text: `第${index + 1}段测试原文。`,
    utf8Start: index * 30,
    utf8End: index * 30 + 20,
  }));
  const source = { name: 'fixture.txt', sha256: sceneDigest('fixture'), revisionId: 'revision-fixture', encoding: 'utf8', bytes: 360 };
  const selection = {
    format: 'scene-calibration-selection', version: '1.0', sourceSha256: source.sha256,
    entrySemantics: 'before_anchor_paragraph', cases: [{
      id: 'case-1', title: '测试场景', startOrdinal: 4, endOrdinal: 9, boundaryConfidence: 'high',
      boundaryRationale: '测试边界', primarySubject: '甲', comparisonSubjects: ['乙'],
      previousContext: [{ startOrdinal: 2, endOrdinal: 3, purpose: '测试前置' }],
      entries: [{ id: 'entry-1', anchorOrdinal: 7, purpose: '测试入口' }],
    }],
  };
  return { source, paragraphs, selection };
}

function reviewedFixture() {
  const dataset = buildSceneCalibrationDataset(fixture());
  const review = blankSceneReview(dataset, 'a');
  review.reviewer = '测试审核者';
  review.status = 'reviewed';
  const item = review.cases[0];
  item.status = 'reviewed';
  item.boundary = { decision: 'accept', startOrdinal: 4, endOrdinal: 9, rationale: '边界完整' };
  item.entries[0].status = 'reviewed';
  item.entries[0].notes = '入口语义已核对';
  const paragraph = dataset.cases[0].paragraphs[0];
  item.claims.push({
    id: 'claim-1', proposition: '测试命题', worldTruthStatus: 'true',
    evidence: [{ paragraphId: paragraph.id, exactQuote: paragraph.text }], notes: '',
    projections: [{ entryId: 'entry-1', subject: '甲', readerDisclosure: 'disclosed', epistemicState: 'known', mayDisclose: 'yes', runtimePolicy: 'must_include', reason: '入口前已有证据' }],
  });
  item.questions.push({
    id: 'question-1', entryId: 'entry-1', subject: '甲', text: '测试问题', expectedBehavior: 'answer',
    requiredPoints: ['测试命题'], forbiddenPoints: [], evidence: [{ paragraphId: paragraph.id, exactQuote: paragraph.text }], severityIfFailed: 'major', notes: '',
  });
  return { dataset, review };
}

describe('scene calibration preparation', () => {
  it('builds deterministic scene ranges and blank independent reviews', () => {
    const input = fixture();
    const dataset = buildSceneCalibrationDataset(input);
    expect(buildSceneCalibrationDataset({ ...input, paragraphs: [...input.paragraphs].reverse() })).toEqual(dataset);
    expect(dataset.cases[0].paragraphs.map((paragraph) => paragraph.ordinal)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(dataset.cases[0].previousContext[0].paragraphs.map((paragraph) => paragraph.ordinal)).toEqual([2, 3]);
    expect(dataset.cases[0].entries[0]).toMatchObject({ anchorParagraphId: 'p-7', anchorOrdinal: 7 });
    expect(blankSceneReview(dataset, 'a')).not.toEqual(blankSceneReview(dataset, 'b'));
    expect(validateSceneReview(dataset, blankSceneReview(dataset, 'a'))).toMatchObject({ valid: true, readyForAdjudication: false, score: null });
  });

  it('rejects changed datasets, unknown IDs, invented quotes and future evidence inclusion', () => {
    const { dataset, review } = reviewedFixture();
    expect(validateSceneReview(dataset, review)).toMatchObject({ valid: true, readyForAdjudication: true, score: null });
    const changed = structuredClone(dataset);
    changed.cases[0].paragraphs[0].text += '改写';
    expect(validateSceneReview(changed, review).errors.join(' ')).toContain('指纹不匹配');
    const wrongId = structuredClone(review);
    wrongId.cases[0].entries[0].entryId = 'unknown';
    expect(validateSceneReview(dataset, wrongId).valid).toBe(false);
    const invented = structuredClone(review);
    invented.cases[0].claims[0].evidence[0].exactQuote = '不存在的引文';
    expect(validateSceneReview(dataset, invented).errors.join(' ')).toContain('逐字对齐');
    const future = structuredClone(review);
    const late = dataset.cases[0].paragraphs.at(-1)!;
    future.cases[0].claims[0].evidence = [{ paragraphId: late.id, exactQuote: late.text }];
    expect(validateSceneReview(dataset, future).errors.join(' ')).toContain('入口锚点或其后的证据');
  });

  it('accepts a complete owner-only provisional gate without calling it a gold standard', () => {
    const dataset = buildSceneCalibrationDataset(fixture());
    const decisions = [
      'accept_selected_scene_boundaries',
      'use_before_anchor_semantics',
      'preserve_night_ambush_temporal_updates',
      'preserve_attackers_false_unconscious_belief',
      'separate_rope_result_from_mechanism_knowledge',
      'separate_miracle_belief_from_world_truth',
      'restrict_dataset_to_prototype_development',
    ] as const;
    const approval = {
      format: 'scene-calibration-owner-provisional-approval', version: '1.0', datasetId: dataset.datasetId,
      sourceSha256: dataset.source.sha256, status: 'provisional-single-owner-approved', approvedAt: '2026-09-10',
      approvedBy: 'project-owner', confirmation: '确认按这个临时基准通过',
      decisions: decisions.map((key) => ({ key, accepted: true, note: '项目负责人确认的测试说明' })),
      limitations: { formalGoldStandard: false, secondIndependentReviewPending: true, qualityScoreAvailable: false, allowedUse: 'stage-1-contract-prototype' },
      deferredUntilSecondReview: ['public-quality-claims', 'final-benchmark-freeze', 'production-autonomy-gate'],
    };
    expect(validateOwnerProvisionalApproval(dataset, approval)).toEqual({
      valid: true, provisionalReadyForStage1: true, formalGoldStandard: false,
      secondIndependentReviewPending: true, score: null, errors: [],
    });
    approval.decisions.pop();
    expect(validateOwnerProvisionalApproval(dataset, approval).provisionalReadyForStage1).toBe(false);
  });

  it('uses the real importer, preserves the source and never overwrites review files', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-calibration-test-'));
    try {
      const sourcePath = path.join(temporaryRoot, '测试小说.txt');
      const sourceText = '\uFEFF第一章 初见\r\n\r\n甲看到灯火。\r\n乙还不知道。\r\n甲开始怀疑。\r\n事实随后揭示。\r\n第二章 后续\r\n众人得知结果。\r\n';
      await fs.writeFile(sourcePath, sourceText);
      const selectionPath = path.join(temporaryRoot, 'selection.json');
      const selection = {
        format: 'scene-calibration-selection', version: '1.0', sourceSha256: sceneDigest(Buffer.from(sourceText)), entrySemantics: 'before_anchor_paragraph',
        cases: [{ id: 'case-real', title: '真实导入测试', startOrdinal: 2, endOrdinal: 5, boundaryConfidence: 'high', boundaryRationale: '连续行动', primarySubject: '甲', comparisonSubjects: ['乙'], previousContext: [{ startOrdinal: 1, endOrdinal: 1, purpose: '章节标题' }], entries: [{ id: 'entry-real', anchorOrdinal: 4, purpose: '揭示之前' }] }],
      };
      await fs.writeFile(selectionPath, JSON.stringify(selection));
      const options = { source: sourcePath, selection: selectionPath, output: path.join(temporaryRoot, 'out') };
      const result = await prepareSceneCalibration(options);
      expect(result.sourceUnchanged).toBe(true);
      expect(result.caseCount).toBe(1);
      expect(result.entryCount).toBe(1);
      expect(await fs.readFile(sourcePath, 'utf8')).toBe(sourceText);
      expect(await checkSceneCalibration(result.outputPath)).toMatchObject({
        reviewerA: { valid: true, readyForAdjudication: false, score: null },
        reviewerB: { valid: true, readyForAdjudication: false, score: null },
      });
      const reviewPath = path.join(result.outputPath, 'reviewer-a.json');
      const original = await fs.readFile(reviewPath, 'utf8');
      await expect(prepareSceneCalibration(options)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await fs.readFile(reviewPath, 'utf8')).toBe(original);
    } finally {
      const resolved = path.resolve(temporaryRoot);
      if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('scene-calibration-test-')) {
        await fs.rm(resolved, { recursive: true, force: true });
      }
    }
  });
});
