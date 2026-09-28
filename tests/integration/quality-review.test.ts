import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { blankReview, buildReviewDataset, digest, renderReviewGuide, validateReview, type QualityReview } from '../../scripts/lib/quality-review';
import { checkQualityReview, prepareQualityReview } from '../../scripts/lib/prepare-quality-review-entry';

function fixture(count = 90) {
  return { source: { name: 'fixture.txt', sha256: digest('fixture'), revisionId: 'revision-fixture', encoding: 'utf8', bytes: 1000 },
    subject: '王扬', seed: 'reproducible', paragraphs: Array.from({ length: count }, (_, index) => ({
      id: `p-${index + 1}`, ordinal: index + 1, chapterTitle: `第${Math.floor(index / 10) + 1}章`,
      text: `${index % 2 ? '路人' : '王扬'}在第${index + 1}段说：这是一段用于单元测试的虚构原文。`, utf8Start: index * 100, utf8End: index * 100 + 90,
    })) };
}

function oneClaim(dataset = buildReviewDataset(fixture())) {
  const review = blankReview(dataset);
  const sample = dataset.samples[0];
  const p = sample.paragraphs[0];
  const claim: QualityReview['samples'][number]['claims'][number] = {
    id: 'claim-1', kind: 'fact', statement: '测试断言，支持关系需要人工确认', truthStatus: 'asserted', visibility: 'public', knownBy: ['王扬'],
    evidence: [{ paragraphId: p.id, exactQuote: p.text }],
    decisions: dataset.checkpoints.map((e) => ({ checkpointId: e.id, decision: p.ordinal <= e.ordinal ? 'allow' : 'forbid', subjectKnowledge: 'known', reason: '人工审核测试占位说明' })),
  };
  review.samples[0].claims.push(claim);
  return { dataset, review, claim };
}

describe('quality review preparation', () => {
  it('is reproducible, stratified and independent of predictions', () => {
    const input = fixture();
    const dataset = buildReviewDataset(input);
    expect(buildReviewDataset({ ...input, paragraphs: [...input.paragraphs].reverse() })).toEqual(dataset);
    expect(dataset.samples).toHaveLength(18);
    expect(dataset.coverage.map((c) => c.selected)).toEqual([6, 6, 6]);
    expect(dataset.samples.filter((s) => s.basis === 'uniform-control')).toHaveLength(6);
    expect(new Set(dataset.samples.map((s) => s.anchorOrdinal)).size).toBe(18);
    expect(buildReviewDataset({ ...input, seed: 'another-seed' }).datasetId).not.toBe(dataset.datasetId);
    for (const sample of dataset.samples) for (const p of sample.paragraphs) expect(p.textSha256).toBe(digest(p.text));
  });

  it('fills absent name matches with controls and reports small populations honestly', () => {
    const dataset = buildReviewDataset({ ...fixture(4), subject: '不存在的人物' });
    expect(dataset.samples).toHaveLength(4);
    expect(dataset.samples.every((s) => s.basis === 'uniform-control')).toBe(true);
    expect(dataset.coverage.reduce((sum, c) => sum + c.population, 0)).toBe(4);
    expect(() => buildReviewDataset({ ...fixture(), perStratum: 100 })).toThrow();
    expect(() => buildReviewDataset({ ...fixture(), radius: -1 })).toThrow();
    expect(() => buildReviewDataset({ ...fixture(), paragraphs: fixture().paragraphs.slice(1) })).toThrow('完整且连续');
  });

  it('does not manufacture reviews or a quality score', () => {
    const dataset = buildReviewDataset(fixture());
    expect(validateReview(dataset, blankReview(dataset))).toMatchObject({
      valid: true, readyForManualScoring: false, pendingSamples: 18, pendingCheckpoints: 3, claimCount: 0, score: null,
    });
    expect(renderReviewGuide(dataset)).toContain('没有模型预测、人工金标准或质量分数');
  });

  it('rejects changed excerpts, missing IDs and wrong dataset identity', () => {
    const { dataset, review } = oneClaim();
    const changed = structuredClone(dataset);
    changed.samples[0].paragraphs[0].text += '改写';
    expect(validateReview(changed, review).valid).toBe(false);
    review.samples.pop();
    review.datasetId = 'another';
    expect(validateReview(dataset, review).errors.join(' ')).toMatch(/dataset 不匹配/);
    expect(validateReview(dataset, review).errors.join(' ')).toMatch(/样本 ID/);
  });

  it('rejects invented quotes and evidence outside the selected sample', () => {
    const { dataset, review, claim } = oneClaim();
    claim.evidence[0].exactQuote = '这不是原文中的文字';
    expect(validateReview(dataset, review).errors.join(' ')).toContain('逐字对齐');
    claim.evidence[0] = { paragraphId: 'not-in-sample', exactQuote: '王扬' };
    expect(validateReview(dataset, review).valid).toBe(false);
  });

  it('rejects late evidence allowed at an earlier entry', () => {
    const dataset = buildReviewDataset(fixture());
    const review = blankReview(dataset);
    const sample = dataset.samples.at(-1)!;
    const p = sample.paragraphs.at(-1)!;
    const { claim } = oneClaim(dataset);
    claim.evidence = [{ paragraphId: p.id, exactQuote: p.text }];
    claim.decisions = dataset.checkpoints.map((e) => ({ checkpointId: e.id, decision: 'allow', subjectKnowledge: 'known', reason: '测试越界' }));
    review.samples.at(-1)!.claims = [claim];
    expect(validateReview(dataset, review).errors.join(' ')).toContain('进入点之后');
  });

  it('does not equate a reader seeing something with a character knowing it', () => {
    const { dataset, review, claim } = oneClaim();
    claim.knownBy = [];
    expect(validateReview(dataset, review).errors.join(' ')).toContain('这个进入点已知情');
    claim.knownBy = ['王扬'];
    claim.decisions.forEach((decision) => { decision.subjectKnowledge = 'unknown'; });
    expect(validateReview(dataset, review).errors.join(' ')).toContain('这个进入点已知情');
    review.audience = 'reader';
    expect(validateReview(dataset, review).valid).toBe(true);
    claim.truthStatus = 'rumor';
    expect(validateReview(dataset, review).errors.join(' ')).toContain('传闻或非公开');
    claim.truthStatus = 'asserted';
    claim.visibility = 'private';
    expect(validateReview(dataset, review).valid).toBe(false);
  });

  it('requires reviewers, all checkpoints and reasons for reviewed empty samples', () => {
    const { dataset, review, claim } = oneClaim();
    review.samples[1].status = 'reviewed';
    claim.decisions.pop();
    const errors = validateReview(dataset, review).errors.join(' ');
    expect(errors).toContain('审核人');
    expect(errors).toContain('说明原因');
    expect(errors).toContain('全部进入点');
  });

  it('can become annotation-ready but still never assigns a score', () => {
    const { dataset, review } = oneClaim();
    for (const row of [...review.samples, ...review.checkpoints]) {
      row.status = 'reviewed'; row.reviewer = 'unit-test reviewer'; row.notes = '虚构测试，不是真实小说金标准';
    }
    expect(validateReview(dataset, review)).toMatchObject({ valid: true, readyForManualScoring: true, score: null });
  });

  it('uses the real importer, verifies UTF-8 spans, and never overwrites annotations', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'quality-review-test-'));
    try {
      const source = path.join(temporaryRoot, '测试小说.txt');
      const raw = '\uFEFF第一章 初见\r\n\r\n  王扬说：“这里是测试文本。”\r\n旁白继续描述眼前发生的事情。\r\n第二章 再见\r\n王扬来到另一处地方继续说话。\r\n';
      await fs.writeFile(source, raw);
      const options = { source, output: path.join(temporaryRoot, 'out'), subject: '王扬', seed: 'integration' };
      const result = await prepareQualityReview(options);
      expect(result.sourceSha256).toBe(digest(Buffer.from(raw)));
      expect(result.sourceUnchanged).toBe(true);
      expect(result.verifiedExcerptCount).toBeGreaterThan(0);
      expect(await fs.readFile(source, 'utf8')).toBe(raw);
      expect(await checkQualityReview(result.outputPath)).toMatchObject({ valid: true, readyForManualScoring: false, score: null });
      const reviewPath = path.join(result.outputPath, 'review.json');
      const original = await fs.readFile(reviewPath, 'utf8');
      await expect(prepareQualityReview(options)).rejects.toMatchObject({ code: 'EEXIST' });
      expect(await fs.readFile(reviewPath, 'utf8')).toBe(original);
    } finally {
      const resolved = path.resolve(temporaryRoot);
      if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('quality-review-test-')) {
        await fs.rm(resolved, { recursive: true, force: true });
      }
    }
  });
});
