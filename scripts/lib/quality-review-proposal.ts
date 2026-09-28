import { z } from 'zod';
import { reviewSchema, validateReview, type ReviewDataset } from './quality-review';

const proposalSchema = z.strictObject({
  format: z.literal('novel-quality-review-proposal'), version: z.literal('1.0'),
  authorType: z.literal('assistant'), status: z.literal('pending-human-review'),
  baseReviewSha256: z.string().regex(/^[a-f0-9]{64}$/), notes: z.string().trim().min(1),
  review: reviewSchema,
});

/** Structural/evidence checks only. A proposal never approves a sample or produces a score. */
export function validateReviewProposal(dataset: ReviewDataset, input: unknown, currentReviewSha256: string) {
  const parsed = proposalSchema.safeParse(input);
  if (!parsed.success) return { valid: false, readyForManualScoring: false, score: null,
    errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  const proposal = parsed.data;
  const checked = validateReview(dataset, proposal.review);
  const errors = [...checked.errors];
  if (proposal.baseReviewSha256 !== currentReviewSha256) errors.push('人工标注底稿已变化，候选需要重新对照，不可覆盖人工修改');
  for (const row of [...proposal.review.checkpoints, ...proposal.review.samples]) {
    if (row.status !== 'pending' || row.reviewer !== null) errors.push(`${row.id}: 助手候选不得自称人工已审核或填写审核人`);
  }
  for (const sample of proposal.review.samples) {
    if (sample.minutes !== null) errors.push(`${sample.id}: 助手候选不得虚构人工审核耗时`);
  }
  return { ...checked, valid: errors.length === 0, readyForManualScoring: false, score: null, errors };
}
