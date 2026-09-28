import { createHash } from 'node:crypto';
import { z } from 'zod';

export const REVIEW_POLICY = 'stratified-review.v1';
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export type ReviewParagraph = { id: string; ordinal: number; text: string; chapterTitle: string | null; utf8Start: number; utf8End: number };

export function buildReviewDataset(input: {
  source: { name: string; sha256: string; revisionId: string; encoding: string; bytes: number };
  paragraphs: ReviewParagraph[]; subject: string; seed: string; perStratum?: number; radius?: number;
}) {
  const subject = input.subject.trim();
  const perStratum = input.perStratum ?? 6;
  const radius = input.radius ?? 1;
  if (!subject || !input.seed.trim()) throw new Error('人物和抽样种子不能为空');
  if (!Number.isInteger(perStratum) || perStratum < 2 || perStratum > 12) throw new Error('每层样本数必须为 2–12');
  if (!Number.isInteger(radius) || radius < 0 || radius > 2) throw new Error('上下文半径必须为 0–2');
  const paragraphs = [...input.paragraphs].sort((a, b) => a.ordinal - b.ordinal);
  if (!paragraphs.length || new Set(paragraphs.map((p) => p.id)).size !== paragraphs.length
    || paragraphs.some((p, i) => p.ordinal !== i + 1)) throw new Error('需要完整且连续的规范段落');
  const checkpoints = [...new Set([0.1, 0.5, 0.9].map((ratio) => Math.max(1, Math.ceil(paragraphs.length * ratio))))]
    .map((ordinal) => ({ id: `entry-p${ordinal}`, ordinal, chapterTitle: paragraphs[ordinal - 1].chapterTitle,
      status: 'proposed' as const, note: '机械抽取的候选阅读位置，不是已审核剧情事件' }));
  const samples: Array<{
    id: string; stratum: string; basis: 'subject-literal' | 'uniform-control'; anchorOrdinal: number;
    paragraphs: Array<ReviewParagraph & { textSha256: string }>;
    relativeToEntries: Array<{ checkpointId: string; relation: 'within' | 'crosses' | 'after' }>;
  }> = [];
  const coverage: Array<{ stratum: string; population: number; literalCandidates: number; selected: number }> = [];
  for (const [index, stratum] of ['early', 'middle', 'late'].entries()) {
    const pool = paragraphs.filter((p) => Math.min(2, Math.floor((p.ordinal - 1) * 3 / paragraphs.length)) === index && p.text.trim().length >= 10);
    const rank = (items: ReviewParagraph[], purpose: string) => [...items].sort((a, b) => {
      const key = (p: ReviewParagraph) => digest(`${input.source.sha256}:${input.seed}:${stratum}:${purpose}:${p.ordinal}`);
      return key(a).localeCompare(key(b)) || a.ordinal - b.ordinal;
    });
    const literal = pool.filter((p) => p.text.includes(subject));
    const focused = rank(literal, 'literal').slice(0, Math.ceil(perStratum * 2 / 3));
    const focusedIds = new Set(focused.map((p) => p.id));
    const control = rank(pool.filter((p) => !focusedIds.has(p.id)), 'control').slice(0, perStratum - focused.length);
    for (const [anchor, basis] of [
      ...focused.map((p) => [p, 'subject-literal'] as const), ...control.map((p) => [p, 'uniform-control'] as const),
    ]) {
      const window = paragraphs.slice(Math.max(0, anchor.ordinal - 1 - radius), anchor.ordinal + radius);
      samples.push({
        id: `sample-${digest(`${input.source.sha256}:${anchor.ordinal}`).slice(0, 16)}`, stratum, basis, anchorOrdinal: anchor.ordinal,
        paragraphs: window.map((p) => ({ ...p, textSha256: digest(p.text) })),
        relativeToEntries: checkpoints.map((entry) => ({ checkpointId: entry.id,
          relation: window[0].ordinal > entry.ordinal ? 'after' : window.at(-1)!.ordinal <= entry.ordinal ? 'within' : 'crosses' })),
      });
    }
    coverage.push({ stratum, population: pool.length, literalCandidates: literal.length, selected: focused.length + control.length });
  }
  const payload = {
    format: 'novel-quality-review-dataset', version: '1.0', policy: REVIEW_POLICY,
    source: input.source, subject, seed: input.seed, paragraphCount: paragraphs.length,
    sampling: { perStratum, radius, minimumAnchorCharacters: 10, literalMatchingIsNotIdentityResolution: true,
      note: '抽样不依赖模型预测；按全书段落分三层，优先约 2/3 人物名字字面命中，其余为层内随机对照。上下文允许重叠，不能视为独立统计样本。' },
    checkpoints, coverage, samples: samples.sort((a, b) => a.anchorOrdinal - b.anchorOrdinal),
  };
  return { ...payload, datasetId: digest(JSON.stringify(payload)) };
}
export type ReviewDataset = ReturnType<typeof buildReviewDataset>;

const approvalSchema = z.object({ status: z.enum(['pending', 'reviewed']), reviewer: z.string().nullable(), notes: z.string() });
export const reviewSchema = z.object({
  datasetId: z.string(), audience: z.enum(['reader', 'character']),
  checkpoints: z.array(approvalSchema.extend({ id: z.string() })),
  samples: z.array(approvalSchema.extend({
    id: z.string(), minutes: z.number().nonnegative().nullable(),
    claims: z.array(z.object({
      id: z.string().min(1), kind: z.enum(['identity', 'fact', 'quote', 'relationship', 'place']), statement: z.string().min(1),
      truthStatus: z.enum(['asserted', 'suspected', 'disputed', 'false', 'unknown', 'rumor']),
      visibility: z.enum(['public', 'private', 'secret', 'unknown']), knownBy: z.array(z.string()),
      evidence: z.array(z.object({ paragraphId: z.string(), exactQuote: z.string().min(1) })).min(1),
      decisions: z.array(z.object({ checkpointId: z.string(), decision: z.enum(['allow', 'forbid', 'unknown']),
        subjectKnowledge: z.enum(['known', 'not-known', 'unknown']), reason: z.string().min(1) })),
    })),
  })),
});
export type QualityReview = z.infer<typeof reviewSchema>;

export function blankReview(dataset: ReviewDataset): QualityReview {
  return { datasetId: dataset.datasetId, audience: 'character',
    checkpoints: dataset.checkpoints.map((entry) => ({ id: entry.id, status: 'pending', reviewer: null, notes: '' })),
    samples: dataset.samples.map((sample) => ({ id: sample.id, status: 'pending', reviewer: null, notes: '', minutes: null, claims: [] })),
  };
}

export function validateReview(dataset: ReviewDataset, input: unknown) {
  const errors: string[] = [];
  const { datasetId, ...payload } = dataset;
  if (digest(JSON.stringify(payload)) !== datasetId) errors.push('dataset 指纹不匹配，不能改写原始抽样底稿');
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) return { valid: false, readyForManualScoring: false, score: null, errors: [...errors, ...parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)] };
  const review = parsed.data;
  if (review.datasetId !== datasetId) errors.push('标注所属 dataset 不匹配');
  const exactIds = (actual: string[], expected: string[]) => actual.length === new Set(actual).size
    && actual.length === expected.length && expected.every((id) => actual.includes(id));
  if (!exactIds(review.samples.map((s) => s.id), dataset.samples.map((s) => s.id))) errors.push('样本 ID 缺失、重复或不属于当前 dataset');
  if (!exactIds(review.checkpoints.map((s) => s.id), dataset.checkpoints.map((s) => s.id))) errors.push('进入点 ID 缺失、重复或不属于当前 dataset');
  for (const row of [...review.checkpoints, ...review.samples]) {
    if (row.status === 'reviewed' && !row.reviewer?.trim()) errors.push(`${row.id}: 已审核项必须填写审核人`);
  }
  const claimIds = new Set<string>();
  for (const sample of review.samples) {
    const source = dataset.samples.find((s) => s.id === sample.id);
    if (!source) continue;
    if (sample.status === 'reviewed' && !sample.claims.length && !sample.notes.trim()) errors.push(`${sample.id}: 无断言的已审核样本必须说明原因`);
    for (const claim of sample.claims) {
      if (claimIds.has(claim.id)) errors.push(`${claim.id}: 断言 ID 重复`);
      claimIds.add(claim.id);
      const evidenceOrdinals: number[] = [];
      for (const evidence of claim.evidence) {
        const p = source.paragraphs.find((p) => p.id === evidence.paragraphId);
        if (!p || !p.text.includes(evidence.exactQuote) || digest(p.text) !== p.textSha256) errors.push(`${claim.id}: 引用未逐字对齐样本段落`);
        else evidenceOrdinals.push(p.ordinal);
      }
      if (!exactIds(claim.decisions.map((d) => d.checkpointId), dataset.checkpoints.map((e) => e.id))) errors.push(`${claim.id}: 必须逐一标注全部进入点`);
      for (const decision of claim.decisions) {
        const entry = dataset.checkpoints.find((e) => e.id === decision.checkpointId);
        if (decision.decision !== 'allow' || !entry) continue;
        if (!evidenceOrdinals.length || Math.max(...evidenceOrdinals) > entry.ordinal) errors.push(`${claim.id}: 允许信息不能依赖进入点之后的证据`);
        if (claim.truthStatus !== 'asserted' || claim.visibility !== 'public') errors.push(`${claim.id}: 当前公开事实基线不能把传闻或非公开主张标为允许事实`);
        if (review.audience === 'character' && (!claim.knownBy.includes(dataset.subject) || decision.subjectKnowledge !== 'known')) {
          errors.push(`${claim.id}: 允许人物使用的信息必须显式标注该人物在这个进入点已知情`);
        }
      }
    }
  }
  const pendingSamples = review.samples.filter((s) => s.status !== 'reviewed').length;
  const pendingCheckpoints = review.checkpoints.filter((s) => s.status !== 'reviewed').length;
  return { valid: errors.length === 0, readyForManualScoring: errors.length === 0 && dataset.samples.length > 0
    && pendingSamples === 0 && pendingCheckpoints === 0 && claimIds.size > 0,
    score: null, pendingSamples, pendingCheckpoints, claimCount: claimIds.size, errors };
}

export function renderReviewGuide(dataset: ReviewDataset): string {
  const lines = ['# 真实小说质量标注包（待审核）', '', `人物字面检索：${dataset.subject}`, `来源：${dataset.source.name}`,
    `来源 SHA-256：${dataset.source.sha256}`, `数据集：${dataset.datasetId}`, '',
    '这里只生成抽样底稿，没有模型预测、人工金标准或质量分数。阅读位置仅为候选，须审核后使用。',
    'review.json 中填写审核人、耗时、断言、逐字证据及每个进入点的 allow / forbid / unknown 与原因。不要编辑 dataset.json。',
    'allow 指当前基线允许作为已知事实使用；传闻可以被记录，但不能标为已经证实的事实。无法确定人物知情时选择 unknown。',
    '每个进入点还要填写 subjectKnowledge: known / not-known / unknown；knownBy 名单不能替代当时知情的确认。reason 应解释知情依据及不确定性。完整字段示例见 docs/REAL-QUALITY-REVIEW-2026-09-06.md。',
    '核对五类信息：人物身份/别名、事实、对白说话人、人物关系、地点。还应主动标注模型可能漏掉的信息；没有信息的窗口必须填写原因。',
    '这里只检查证据字符串和规则，不自动判定证据是否真正支持断言。候选阅读位置若不合适，应另建评测版本，不擅自改写底稿。', '',
    '## 候选进入点', '', ...dataset.checkpoints.map((e) => `- ${e.id}：段落 ${e.ordinal}，${e.chapterTitle ?? '未分章'}（待审核）`), '',
    '## 样本', ''];
  for (const sample of dataset.samples) {
    lines.push(`### ${sample.id} · ${sample.stratum} / ${sample.basis} · P${sample.anchorOrdinal}`, '',
      ...sample.relativeToEntries.map((e) => `- ${e.checkpointId}: ${e.relation}（仅表示窗口位置，不代表人物知情）`), '');
    for (const p of sample.paragraphs) lines.push(`P${p.ordinal} · ${p.id} · ${p.chapterTitle ?? '未分章'}`, '',
      ...p.text.split('\n').map((line) => `> ${line}`), '');
  }
  return `${lines.join('\n')}\n`;
}
