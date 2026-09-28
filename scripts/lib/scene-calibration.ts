import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SCENE_CALIBRATION_POLICY = 'scene-calibration.v1';
export const sceneDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

const rangeSchema = z.object({
  startOrdinal: z.number().int().positive(),
  endOrdinal: z.number().int().positive(),
  purpose: z.string().min(1),
});

export const sceneSelectionSchema = z.object({
  format: z.literal('scene-calibration-selection'),
  version: z.literal('1.0'),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entrySemantics: z.literal('before_anchor_paragraph'),
  cases: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    startOrdinal: z.number().int().positive(),
    endOrdinal: z.number().int().positive(),
    boundaryConfidence: z.enum(['high', 'medium', 'low']),
    boundaryRationale: z.string().min(1),
    primarySubject: z.string().min(1),
    comparisonSubjects: z.array(z.string().min(1)),
    previousContext: z.array(rangeSchema),
    entries: z.array(z.object({
      id: z.string().min(1),
      anchorOrdinal: z.number().int().positive(),
      purpose: z.string().min(1),
    })).min(1),
  })).min(1),
}).superRefine((selection, context) => {
  const caseIds = new Set<string>();
  const entryIds = new Set<string>();
  for (const [caseIndex, item] of selection.cases.entries()) {
    if (caseIds.has(item.id)) context.addIssue({ code: 'custom', path: ['cases', caseIndex, 'id'], message: '场景 ID 重复' });
    caseIds.add(item.id);
    if (item.startOrdinal > item.endOrdinal) context.addIssue({ code: 'custom', path: ['cases', caseIndex], message: '场景起点不能晚于终点' });
    for (const [entryIndex, entry] of item.entries.entries()) {
      if (entryIds.has(entry.id)) context.addIssue({ code: 'custom', path: ['cases', caseIndex, 'entries', entryIndex, 'id'], message: '入口 ID 必须全局唯一' });
      entryIds.add(entry.id);
      if (entry.anchorOrdinal < item.startOrdinal || entry.anchorOrdinal > item.endOrdinal + 1) {
        context.addIssue({ code: 'custom', path: ['cases', caseIndex, 'entries', entryIndex, 'anchorOrdinal'], message: '入口锚点必须位于场景内或紧随场景末尾' });
      }
    }
    for (const [rangeIndex, range] of item.previousContext.entries()) {
      if (range.startOrdinal > range.endOrdinal || range.endOrdinal >= item.startOrdinal) {
        context.addIssue({ code: 'custom', path: ['cases', caseIndex, 'previousContext', rangeIndex], message: '前置上下文必须位于场景开始之前' });
      }
    }
  }
});

export type SceneSelection = z.infer<typeof sceneSelectionSchema>;
export type SceneParagraph = {
  id: string;
  ordinal: number;
  text: string;
  chapterTitle: string | null;
  utf8Start: number;
  utf8End: number;
};

export function buildSceneCalibrationDataset(input: {
  source: { name: string; sha256: string; revisionId: string; encoding: string; bytes: number };
  paragraphs: SceneParagraph[];
  selection: unknown;
}) {
  const selection = sceneSelectionSchema.parse(input.selection);
  if (selection.sourceSha256 !== input.source.sha256) throw new Error('场景选择文件与原文 SHA-256 不匹配');
  const paragraphs = [...input.paragraphs].sort((left, right) => left.ordinal - right.ordinal);
  if (!paragraphs.length || paragraphs.some((paragraph, index) => paragraph.ordinal !== index + 1)) {
    throw new Error('需要完整且连续的规范段落');
  }
  const paragraphByOrdinal = new Map(paragraphs.map((paragraph) => [paragraph.ordinal, paragraph]));
  const resolveRange = (startOrdinal: number, endOrdinal: number) => {
    const resolved = Array.from({ length: endOrdinal - startOrdinal + 1 }, (_, index) => paragraphByOrdinal.get(startOrdinal + index));
    if (resolved.some((paragraph) => !paragraph)) throw new Error(`段落范围不存在：P${startOrdinal}–P${endOrdinal}`);
    return resolved.map((paragraph) => ({ ...paragraph!, textSha256: sceneDigest(paragraph!.text) }));
  };
  const cases = selection.cases.map((item) => ({
    id: item.id,
    title: item.title,
    status: 'proposed' as const,
    boundary: {
      startOrdinal: item.startOrdinal,
      endOrdinal: item.endOrdinal,
      startParagraphId: paragraphByOrdinal.get(item.startOrdinal)?.id,
      endParagraphId: paragraphByOrdinal.get(item.endOrdinal)?.id,
      confidence: item.boundaryConfidence,
      rationale: item.boundaryRationale,
    },
    primarySubject: item.primarySubject,
    comparisonSubjects: item.comparisonSubjects,
    previousContext: item.previousContext.map((range) => ({ ...range, paragraphs: resolveRange(range.startOrdinal, range.endOrdinal) })),
    entries: item.entries.map((entry) => {
      const anchor = paragraphByOrdinal.get(entry.anchorOrdinal);
      if (!anchor && entry.anchorOrdinal !== item.endOrdinal + 1) throw new Error(`入口段落不存在：${entry.id}`);
      return {
        ...entry,
        anchorParagraphId: anchor?.id ?? null,
        chapterTitle: anchor?.chapterTitle ?? paragraphByOrdinal.get(item.endOrdinal)?.chapterTitle ?? null,
      };
    }),
    paragraphs: resolveRange(item.startOrdinal, item.endOrdinal),
  }));
  const payload = {
    format: 'scene-calibration-dataset' as const,
    version: '1.0' as const,
    policy: SCENE_CALIBRATION_POLICY,
    source: input.source,
    entrySemantics: selection.entrySemantics,
    selectionSha256: sceneDigest(JSON.stringify(selection)),
    cases,
  };
  return { ...payload, datasetId: sceneDigest(JSON.stringify(payload)) };
}

export type SceneCalibrationDataset = ReturnType<typeof buildSceneCalibrationDataset>;

const evidenceSchema = z.object({ paragraphId: z.string().min(1), exactQuote: z.string().min(1) });
const projectionSchema = z.object({
  entryId: z.string().min(1),
  subject: z.string().min(1),
  readerDisclosure: z.enum(['disclosed', 'hinted', 'not_disclosed', 'unknown']),
  epistemicState: z.enum(['known', 'believed', 'doubted', 'disbelieved', 'unknown']),
  mayDisclose: z.enum(['yes', 'no', 'unknown']),
  runtimePolicy: z.enum(['must_include', 'eligible', 'must_exclude']),
  reason: z.string().min(1),
});

export const sceneReviewSchema = z.object({
  format: z.literal('scene-calibration-review'),
  version: z.literal('1.0'),
  datasetId: z.string().min(1),
  reviewLane: z.enum(['a', 'b', 'adjudication']),
  reviewer: z.string().nullable(),
  status: z.enum(['pending', 'reviewed']),
  notes: z.string(),
  cases: z.array(z.object({
    caseId: z.string().min(1),
    status: z.enum(['pending', 'reviewed', 'ambiguous']),
    boundary: z.object({
      decision: z.enum(['pending', 'accept', 'revise', 'ambiguous']),
      startOrdinal: z.number().int().positive().nullable(),
      endOrdinal: z.number().int().positive().nullable(),
      rationale: z.string(),
    }),
    notes: z.string(),
    entries: z.array(z.object({
      entryId: z.string().min(1),
      status: z.enum(['pending', 'reviewed', 'ambiguous']),
      notes: z.string(),
    })),
    claims: z.array(z.object({
      id: z.string().min(1),
      proposition: z.string().min(1),
      worldTruthStatus: z.enum(['true', 'false', 'disputed', 'unresolved']),
      evidence: z.array(evidenceSchema).min(1),
      projections: z.array(projectionSchema).min(1),
      notes: z.string(),
    })),
    questions: z.array(z.object({
      id: z.string().min(1),
      entryId: z.string().min(1),
      subject: z.string().min(1),
      text: z.string().min(1),
      expectedBehavior: z.enum(['answer', 'answer_as_belief', 'express_uncertainty', 'deny_knowledge', 'refuse_disclosure', 'stay_silent']),
      requiredPoints: z.array(z.string()),
      forbiddenPoints: z.array(z.string()),
      evidence: z.array(evidenceSchema),
      severityIfFailed: z.enum(['critical', 'major', 'minor']),
      notes: z.string(),
    })),
  })),
});

export type SceneCalibrationReview = z.infer<typeof sceneReviewSchema>;

export const OWNER_PROVISIONAL_DECISION_KEYS = [
  'accept_selected_scene_boundaries',
  'use_before_anchor_semantics',
  'preserve_night_ambush_temporal_updates',
  'preserve_attackers_false_unconscious_belief',
  'separate_rope_result_from_mechanism_knowledge',
  'separate_miracle_belief_from_world_truth',
  'restrict_dataset_to_prototype_development',
] as const;

export const ownerProvisionalApprovalSchema = z.object({
  format: z.literal('scene-calibration-owner-provisional-approval'),
  version: z.literal('1.0'),
  datasetId: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal('provisional-single-owner-approved'),
  approvedAt: z.string().date(),
  approvedBy: z.literal('project-owner'),
  confirmation: z.literal('确认按这个临时基准通过'),
  decisions: z.array(z.object({
    key: z.enum(OWNER_PROVISIONAL_DECISION_KEYS),
    accepted: z.literal(true),
    note: z.string().min(1),
  })),
  limitations: z.object({
    formalGoldStandard: z.literal(false),
    secondIndependentReviewPending: z.literal(true),
    qualityScoreAvailable: z.literal(false),
    allowedUse: z.literal('stage-1-contract-prototype'),
  }),
  deferredUntilSecondReview: z.array(z.enum(['public-quality-claims', 'final-benchmark-freeze', 'production-autonomy-gate'])).min(1),
}).superRefine((approval, context) => {
  const actual = approval.decisions.map((decision) => decision.key);
  if (actual.length !== OWNER_PROVISIONAL_DECISION_KEYS.length || new Set(actual).size !== actual.length
    || OWNER_PROVISIONAL_DECISION_KEYS.some((key) => !actual.includes(key))) {
    context.addIssue({ code: 'custom', path: ['decisions'], message: '必须逐项确认完整的临时基准决策' });
  }
});

export type OwnerProvisionalApproval = z.infer<typeof ownerProvisionalApprovalSchema>;

export function blankSceneReview(dataset: SceneCalibrationDataset, reviewLane: 'a' | 'b' | 'adjudication'): SceneCalibrationReview {
  return {
    format: 'scene-calibration-review',
    version: '1.0',
    datasetId: dataset.datasetId,
    reviewLane,
    reviewer: null,
    status: 'pending',
    notes: '',
    cases: dataset.cases.map((item) => ({
      caseId: item.id,
      status: 'pending',
      boundary: { decision: 'pending', startOrdinal: null, endOrdinal: null, rationale: '' },
      notes: '',
      entries: item.entries.map((entry) => ({ entryId: entry.id, status: 'pending', notes: '' })),
      claims: [],
      questions: [],
    })),
  };
}

function exactIds(actual: string[], expected: string[]) {
  return actual.length === new Set(actual).size && actual.length === expected.length && expected.every((id) => actual.includes(id));
}

export function validateSceneReview(dataset: SceneCalibrationDataset, input: unknown) {
  const errors: string[] = [];
  const { datasetId, ...payload } = dataset;
  if (sceneDigest(JSON.stringify(payload)) !== datasetId) errors.push('dataset 指纹不匹配，不能改写场景底稿');
  const parsed = sceneReviewSchema.safeParse(input);
  if (!parsed.success) return { valid: false, readyForAdjudication: false, score: null, errors: [...errors, ...parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)] };
  const review = parsed.data;
  if (review.datasetId !== dataset.datasetId) errors.push('标注所属 dataset 不匹配');
  if (!exactIds(review.cases.map((item) => item.caseId), dataset.cases.map((item) => item.id))) errors.push('场景 ID 缺失、重复或不属于当前 dataset');
  const claimIds = new Set<string>();
  const questionIds = new Set<string>();
  for (const item of review.cases) {
    const sourceCase = dataset.cases.find((candidate) => candidate.id === item.caseId);
    if (!sourceCase) continue;
    if (!exactIds(item.entries.map((entry) => entry.entryId), sourceCase.entries.map((entry) => entry.id))) errors.push(`${item.caseId}: 入口 ID 缺失、重复或不属于当前场景`);
    if (item.status === 'reviewed' && !item.claims.length && !item.notes.trim()) errors.push(`${item.caseId}: 无命题的已审核场景必须说明原因`);
    if (item.boundary.decision === 'revise' && (!item.boundary.startOrdinal || !item.boundary.endOrdinal || !item.boundary.rationale.trim())) {
      errors.push(`${item.caseId}: 修改边界必须填写新范围和理由`);
    }
    const paragraphs = new Map(sourceCase.paragraphs.map((paragraph) => [paragraph.id, paragraph]));
    const entryIds = new Set(sourceCase.entries.map((entry) => entry.id));
    const subjects = new Set([sourceCase.primarySubject, ...sourceCase.comparisonSubjects, 'reader']);
    const checkEvidence = (owner: string, evidence: Array<{ paragraphId: string; exactQuote: string }>) => {
      const ordinals: number[] = [];
      for (const itemEvidence of evidence) {
        const paragraph = paragraphs.get(itemEvidence.paragraphId);
        if (!paragraph || paragraph.textSha256 !== sceneDigest(paragraph.text) || !paragraph.text.includes(itemEvidence.exactQuote)) {
          errors.push(`${owner}: 引用未逐字对齐当前场景`);
        } else ordinals.push(paragraph.ordinal);
      }
      return ordinals;
    };
    for (const claim of item.claims) {
      if (claimIds.has(claim.id)) errors.push(`${claim.id}: 命题 ID 重复`);
      claimIds.add(claim.id);
      const evidenceOrdinals = checkEvidence(claim.id, claim.evidence);
      for (const projection of claim.projections) {
        const entry = sourceCase.entries.find((candidate) => candidate.id === projection.entryId);
        if (!entryIds.has(projection.entryId)) errors.push(`${claim.id}: 投影引用了未知入口`);
        if (!subjects.has(projection.subject)) errors.push(`${claim.id}: 投影引用了未声明主体`);
        if (entry && projection.runtimePolicy !== 'must_exclude' && evidenceOrdinals.some((ordinal) => ordinal >= entry.anchorOrdinal)) {
          errors.push(`${claim.id}: 可进入运行时的信息不能依赖入口锚点或其后的证据`);
        }
      }
    }
    for (const question of item.questions) {
      if (questionIds.has(question.id)) errors.push(`${question.id}: 问题 ID 重复`);
      questionIds.add(question.id);
      if (!entryIds.has(question.entryId)) errors.push(`${question.id}: 问题引用了未知入口`);
      if (!subjects.has(question.subject)) errors.push(`${question.id}: 问题引用了未声明主体`);
      checkEvidence(question.id, question.evidence);
    }
  }
  if (review.status === 'reviewed' && !review.reviewer?.trim()) errors.push('完成审核必须填写审核人');
  const pendingCases = review.cases.filter((item) => item.status === 'pending').length;
  const pendingEntries = review.cases.flatMap((item) => item.entries).filter((item) => item.status === 'pending').length;
  const readyForAdjudication = errors.length === 0 && review.status === 'reviewed' && pendingCases === 0 && pendingEntries === 0 && claimIds.size > 0 && questionIds.size > 0;
  return { valid: errors.length === 0, readyForAdjudication, score: null, pendingCases, pendingEntries, claimCount: claimIds.size, questionCount: questionIds.size, errors };
}

export function validateOwnerProvisionalApproval(dataset: SceneCalibrationDataset, input: unknown) {
  const errors: string[] = [];
  const { datasetId, ...payload } = dataset;
  if (sceneDigest(JSON.stringify(payload)) !== datasetId) errors.push('dataset 指纹不匹配，不能批准已改写的场景底稿');
  const parsed = ownerProvisionalApprovalSchema.safeParse(input);
  if (!parsed.success) return {
    valid: false, provisionalReadyForStage1: false, formalGoldStandard: false, score: null,
    errors: [...errors, ...parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)],
  };
  if (parsed.data.datasetId !== dataset.datasetId) errors.push('临时批准所属 dataset 不匹配');
  if (parsed.data.sourceSha256 !== dataset.source.sha256) errors.push('临时批准所属原文 SHA-256 不匹配');
  return {
    valid: errors.length === 0,
    provisionalReadyForStage1: errors.length === 0,
    formalGoldStandard: false,
    secondIndependentReviewPending: true,
    score: null,
    errors,
  };
}

export function renderSceneCalibrationGuide(dataset: SceneCalibrationDataset): string {
  const lines = [
    '# 场景 Calibration 标注包（待双人独立审核）', '',
    `来源：${dataset.source.name}`,
    `来源 SHA-256：${dataset.source.sha256}`,
    `数据集：${dataset.datasetId}`, '',
    'dataset.json 是不可改写的场景与原文底稿。reviewer-a.json 和 reviewer-b.json 必须由两名审核者独立填写；在独立审核完成前不要互相查看。',
    '这两个审核文件当前全部为 pending，没有模型结论、人工金标准或质量分数。助手建议见 docs/CALIBRATION-SCENE-SELECTION-2026-09-10.md，只能作为待核对假设。',
    '入口语义统一为 before_anchor_paragraph：锚点段落本身及其后内容都属于未来。所有 evidence 必须逐字来自本场景 dataset 段落。',
    'reviewed 只表示人工完成，不表示自动判定正确；两份审核完成后还需要单独的 adjudication 裁决文件。', '',
    '## 场景', '',
  ];
  for (const item of dataset.cases) {
    lines.push(`### ${item.id} · ${item.title}`, '',
      `- 范围：P${item.boundary.startOrdinal}–P${item.boundary.endOrdinal}`,
      `- 主体：${item.primarySubject}`,
      `- 对照：${item.comparisonSubjects.join('、')}`,
      `- 建议边界置信度：${item.boundary.confidence}`,
      `- 建议依据：${item.boundary.rationale}`,
      `- 入口：${item.entries.map((entry) => `${entry.id}=P${entry.anchorOrdinal}`).join('；')}`, '');
  }
  return `${lines.join('\n')}\n`;
}
