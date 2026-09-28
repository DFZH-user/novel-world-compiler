import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { blankReview, buildReviewDataset, digest } from '../../scripts/lib/quality-review';
import { validateReviewProposal } from '../../scripts/lib/quality-review-proposal';
import { checkQualityReview } from '../../scripts/lib/prepare-quality-review-entry';
import { fileURLToPath } from 'node:url';

function fixture() {
  const dataset = buildReviewDataset({ source: { name: 'test.txt', sha256: digest('test'), revisionId: 'revision', encoding: 'utf8', bytes: 100 },
    subject: '人物甲', seed: 'test', paragraphs: Array.from({ length: 30 }, (_, i) => ({
      id: `p${i + 1}`, ordinal: i + 1, text: `人物甲在这里说话，这是测试段落${i + 1}。`, chapterTitle: null, utf8Start: i * 100, utf8End: i * 100 + 60,
    })) });
  const proposal = { format: 'novel-quality-review-proposal', version: '1.0', authorType: 'assistant', status: 'pending-human-review',
    baseReviewSha256: digest('original'), notes: '仅为候选', review: blankReview(dataset) };
  return { dataset, proposal };
}

describe('assistant quality-review proposal isolation', () => {
  it('accepts pending proposals without a score or approval', () => {
    const { dataset, proposal } = fixture();
    expect(validateReviewProposal(dataset, proposal, digest('original'))).toMatchObject({ valid: true, readyForManualScoring: false, score: null });
  });

  it('rejects fabricated human review and elapsed time', () => {
    const { dataset, proposal } = fixture();
    proposal.review.samples[0].status = 'reviewed';
    proposal.review.samples[0].reviewer = 'pretend human';
    proposal.review.samples[0].minutes = 3;
    const result = validateReviewProposal(dataset, proposal, digest('original'));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('不得自称人工');
    expect(result.errors.join(' ')).toContain('不得虚构人工审核耗时');
  });

  it('detects a stale proposal after manual annotations change', () => {
    const { dataset, proposal } = fixture();
    expect(validateReviewProposal(dataset, proposal, digest('edited')).errors.join(' ')).toContain('人工标注底稿已变化');
  });

  it('rejects wrong provenance, dataset drift, and removed samples', () => {
    const { dataset, proposal } = fixture();
    expect(validateReviewProposal(dataset, { ...proposal, authorType: 'human' }, digest('original')).valid).toBe(false);
    expect(validateReviewProposal(dataset, { ...proposal, status: 'approved' }, digest('original')).valid).toBe(false);
    proposal.review.samples.pop();
    expect(validateReviewProposal(dataset, proposal, digest('original')).valid).toBe(false);
    dataset.subject = '被篡改的人物';
    expect(validateReviewProposal(dataset, proposal, digest('original')).errors.join(' ')).toContain('指纹不匹配');
  });

  it('checks all real candidate evidence while leaving the human baseline byte-identical', async () => {
    const directory = new URL('../../verification-results/real-quality-review/quality-review-73b4d2be9471/', import.meta.url);
    const proposalPath = new URL('assistant-proposal-v1.json', directory);
    const before = await fs.readFile(new URL('review.json', directory));
    const datasetBefore = await fs.readFile(new URL('dataset.json', directory));
    const result = await checkQualityReview(fileURLToPath(directory), fileURLToPath(proposalPath));
    expect(result).toMatchObject({ valid: true, readyForManualScoring: false, score: null, claimCount: 24, pendingSamples: 18, pendingCheckpoints: 3 });
    expect(await fs.readFile(new URL('review.json', directory))).toEqual(before);
    expect(await fs.readFile(new URL('dataset.json', directory))).toEqual(datasetBefore);
    const dataset = JSON.parse(datasetBefore.toString('utf8'));
    const proposal = JSON.parse(await fs.readFile(proposalPath, 'utf8'));
    proposal.review.samples[0].claims[0].evidence[0].exactQuote = '不属于小说原文的假引文';
    expect(validateReviewProposal(dataset, proposal, digest(before)).errors.join(' ')).toContain('逐字对齐');
  });
});
