import { z } from 'zod';
import {
  assembleDryRunContext,
  dryRunPromptReceiptSchema,
  type ContextAssemblyItem,
} from '../../src/shared/dry-run-context-assembler';
import {
  validateCalibrationProjectionRun,
  type CalibrationProjectionRun,
} from './calibration-projection-run';
import { sceneDigest, type SceneCalibrationDataset } from './scene-calibration';

export const CALIBRATION_CLAIM_DEFINITIONS: Record<string, { text: string; evidenceOrdinal: number }> = {
  'cal-a-call-is-trap': { text: '左侧“快去护卫”的喊话是诱骗王扬的陷阱', evidenceOrdinal: 25014 },
  'cal-a-wang-unconscious-after-first-fall': { text: '王扬第一次被绳套拖倒后已经昏迷', evidenceOrdinal: 25020 },
  'cal-a-attackers-are-yidu': { text: '袭击者属于宜都蛮', evidenceOrdinal: 25039 },
  'cal-a-fire-sacrifice-purpose': { text: '袭击者准备留下王扬用于火祭', evidenceOrdinal: 25039 },
  'cal-b-rope-remains-unbroken': { text: '火焰经过后麻绳焦黑但没有断', evidenceOrdinal: 27438 },
  'cal-b-salt-mechanism': { text: '盐晶体帮助燃烧后的绳索维持结构', evidenceOrdinal: 27445 },
  'cal-b-grand-shaman-wants-failure': { text: '大巫祝希望用第二题使王扬失败', evidenceOrdinal: 27421 },
  'cal-b-wang-is-supernatural-envoy': { text: '王扬是具有超自然力量的神使', evidenceOrdinal: 27440 },
};

const runSchema = z.object({
  format: z.literal('calibration-dry-run-context-run'),
  version: z.literal('1.0'),
  datasetId: z.string().min(1),
  projectionRunId: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvalStatus: z.literal('provisional-single-owner-approved'),
  formalGoldStandard: z.literal(false),
  modelCalls: z.literal(0),
  receipts: z.array(dryRunPromptReceiptSchema),
  summary: z.object({
    receiptCount: z.number().int().nonnegative(),
    assembledCount: z.number().int().nonnegative(),
    blockedCount: z.number().int().nonnegative(),
    includedItemCount: z.number().int().nonnegative(),
    excludedItemCount: z.number().int().nonnegative(),
    projectionDeniedCount: z.number().int().nonnegative(),
    futureKnowledgeDeniedCount: z.number().int().nonnegative(),
    unknownKnowledgeDeniedCount: z.number().int().nonnegative(),
    highScoreDeniedCount: z.number().int().nonnegative(),
    estimatedInputTokens: z.number().int().nonnegative(),
  }),
});

export type CalibrationDryRun = z.infer<typeof runSchema> & { runId: string };

function paragraphRef(dataset: SceneCalibrationDataset, ordinal: number) {
  const paragraph = dataset.cases.flatMap((item) => [
    ...item.paragraphs,
    ...item.previousContext.flatMap((context) => context.paragraphs),
  ]).find((candidate) => candidate.ordinal === ordinal);
  if (!paragraph) throw new Error(`找不到 Dry-run 来源段落 P${ordinal}`);
  return { paragraphId: paragraph.id, ordinal: paragraph.ordinal };
}

function locateRequest(dataset: SceneCalibrationDataset, requestId: string) {
  const scene = dataset.cases.find((item) => requestId.startsWith(`${item.id}:`));
  if (!scene) throw new Error(`Dry-run 请求未对应 calibration 场景：${requestId}`);
  const entry = scene.entries.find((item) => requestId.startsWith(`${scene.id}:${item.id}:`));
  if (!entry) throw new Error(`Dry-run 请求未对应 calibration 入口：${requestId}`);
  return { scene, entry };
}

function retrievalScore(policy: string, reason: string) {
  if (reason === 'future_knowledge') return 0.999;
  if (reason === 'unknown_to_character') return 0.998;
  return policy === 'must_include' ? 0.92 : 0.78;
}

function itemsFor(dataset: SceneCalibrationDataset, receipt: CalibrationProjectionRun['receipts'][number]): ContextAssemblyItem[] {
  const { scene, entry } = locateRequest(dataset, receipt.requestId);
  const items: ContextAssemblyItem[] = [
    {
      id: `${receipt.requestId}:character-core`,
      kind: 'direct',
      bucket: 'characterCore',
      priority: 'critical',
      dedupeKey: `character-core:${receipt.targetCharacterId}`,
      text: `${receipt.targetCharacterId} 是本次视角主体；不得把读者知识、其他角色知识或入口之后的信息当作其已知事实。`,
      sourceRefs: [],
      retrieval: null,
      directPolicy: 'must_include',
      directReason: 'character_core',
    },
    {
      id: `${receipt.requestId}:scene-snapshot`,
      kind: 'direct',
      bucket: 'sceneSnapshot',
      priority: 'critical',
      dedupeKey: `scene-snapshot:${receipt.requestId}`,
      text: `续写入口位于 P${entry.anchorOrdinal} 之前；当前内容只允许使用到 P${receipt.knownThroughOrdinal}，场景边界为 P${scene.boundary.startOrdinal}–P${scene.boundary.endOrdinal}。`,
      sourceRefs: [paragraphRef(dataset, receipt.knownThroughOrdinal)],
      retrieval: null,
      directPolicy: 'must_include',
      directReason: 'scene_state',
    },
  ];
  for (const projection of receipt.projections) {
    const definition = CALIBRATION_CLAIM_DEFINITIONS[projection.claimId];
    if (!definition) throw new Error(`Dry-run 缺少命题文本：${projection.claimId}`);
    items.push({
      id: `${receipt.requestId}:claim:${projection.claimId}`,
      kind: 'claim',
      claimId: projection.claimId,
      bucket: 'retrievedMemory',
      priority: projection.runtime.policy === 'must_include' ? 'critical' : projection.runtime.policy === 'eligible' ? 'normal' : 'low',
      dedupeKey: `claim:${projection.claimId}`,
      text: definition.text,
      sourceRefs: [paragraphRef(dataset, definition.evidenceOrdinal)],
      retrieval: {
        method: 'hybrid',
        score: retrievalScore(projection.runtime.policy, projection.runtime.reason),
        trigger: 'calibration-all-claims',
        path: ['calibration-candidate', projection.claimId],
      },
    });
  }
  return items;
}

export function buildCalibrationDryRun(dataset: SceneCalibrationDataset, rawProjectionRun: unknown): CalibrationDryRun {
  const projectionValidation = validateCalibrationProjectionRun(dataset, rawProjectionRun);
  if (!projectionValidation.valid) throw new Error(`只允许使用可复现的 Stage 1 投影：${projectionValidation.errors.join('；')}`);
  const projectionRun = rawProjectionRun as CalibrationProjectionRun;
  const receipts = projectionRun.receipts.map((projectionReceipt) => assembleDryRunContext({
    id: `${projectionReceipt.requestId}:dry-run-v1`,
    policyVersion: 'dry-run-context-assembler.v1',
    projectionReceipt,
    budget: {
      totalTokens: 800,
      buckets: { characterCore: 100, sceneSnapshot: 150, activatedLore: 100, retrievedMemory: 350, conversationMemory: 100 },
    },
    items: itemsFor(dataset, projectionReceipt),
  }));
  const included = receipts.flatMap((receipt) => receipt.included);
  const excluded = receipts.flatMap((receipt) => receipt.excluded);
  const payload = runSchema.parse({
    format: 'calibration-dry-run-context-run',
    version: '1.0',
    datasetId: dataset.datasetId,
    projectionRunId: projectionRun.runId,
    sourceSha256: dataset.source.sha256,
    approvalStatus: 'provisional-single-owner-approved',
    formalGoldStandard: false,
    modelCalls: 0,
    receipts,
    summary: {
      receiptCount: receipts.length,
      assembledCount: receipts.filter((receipt) => receipt.status === 'assembled').length,
      blockedCount: receipts.filter((receipt) => receipt.status === 'blocked_required_budget').length,
      includedItemCount: included.length,
      excludedItemCount: excluded.length,
      projectionDeniedCount: excluded.filter((item) => item.reason === 'projection_denied').length,
      futureKnowledgeDeniedCount: excluded.filter((item) => item.projectionReason === 'future_knowledge').length,
      unknownKnowledgeDeniedCount: excluded.filter((item) => item.projectionReason === 'unknown_to_character').length,
      highScoreDeniedCount: excluded.filter((item) => item.reason === 'projection_denied' && (item.retrieval?.score ?? 0) >= 0.99).length,
      estimatedInputTokens: receipts.reduce((sum, receipt) => sum + receipt.budget.estimatedInputTokens, 0),
    },
  });
  return { ...payload, runId: sceneDigest(JSON.stringify(payload)) };
}

export function validateCalibrationDryRun(dataset: SceneCalibrationDataset, projectionRun: unknown, input: unknown) {
  const parsed = z.object({ runId: z.string().regex(/^[a-f0-9]{64}$/) }).and(runSchema).safeParse(input);
  if (!parsed.success) return { valid: false, reproducible: false, formalGoldStandard: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  const { runId, ...payload } = parsed.data;
  const errors: string[] = [];
  if (runId !== sceneDigest(JSON.stringify(payload))) errors.push('Dry-run 运行指纹不匹配');
  if (payload.datasetId !== dataset.datasetId || payload.sourceSha256 !== dataset.source.sha256) errors.push('Dry-run 与 calibration 数据集不匹配');
  const expected = buildCalibrationDryRun(dataset, projectionRun);
  if (payload.projectionRunId !== expected.projectionRunId) errors.push('Dry-run 与 Stage 1 投影运行不匹配');
  if (expected.runId !== runId) errors.push('Dry-run 无法由当前策略确定性复现');
  return { valid: errors.length === 0, reproducible: errors.length === 0, formalGoldStandard: false, errors };
}
