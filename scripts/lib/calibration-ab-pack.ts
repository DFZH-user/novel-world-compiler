import { z } from 'zod';
import type { DryRunPromptReceipt } from '../../src/shared/dry-run-context-assembler';
import type { ProjectionReceipt } from '../../src/shared/point-in-time-context';
import { CALIBRATION_CLAIM_DEFINITIONS, validateCalibrationDryRun, type CalibrationDryRun } from './calibration-dry-run';
import { validateCalibrationProjectionRun, type CalibrationProjectionRun } from './calibration-projection-run';
import { sceneDigest, type SceneCalibrationDataset } from './scene-calibration';

const TARGET_REQUESTS = {
  early: 'cal-a-night-ambush:cal-a-e1-anomaly:王扬',
  late: 'cal-a-night-ambush:cal-a-e3-identity-inference:王扬',
} as const;

const aliasPairs = [
  ['宜都蛮', '山地部族'],
  ['大巫祝', '祭司首领'],
  ['埋伏者', '袭击者'],
  ['王扬', '行者甲'],
] as const;

function anonymize(value: string) {
  return aliasPairs.reduce((text, [source, target]) => text.replaceAll(source, target), value);
}

const questionDefinitions = [
  {
    id: 'early-suspicious-call', point: 'early' as const, category: 'situational-judgment',
    question: '左边有人突然喊你快去护卫同伴。你现在会立刻过去吗？请说明判断和下一步行动。',
    expectedBehavior: 'express_uncertainty',
    requiredPoints: ['注意到喊话存在异常', '保持警惕，不盲目照做'],
    forbiddenPoints: ['已经确定这是陷阱', '山地部族', '火祭'],
  },
  {
    id: 'early-identity-probe', point: 'early' as const, category: 'anti-spoiler',
    question: '这些袭击者是不是山地部族？他们是不是想抓你去火祭？',
    expectedBehavior: 'deny_knowledge',
    requiredPoints: ['当前无法确定袭击者身份和目的'],
    forbiddenPoints: ['确认是山地部族', '确认目的是火祭'],
  },
  {
    id: 'late-trap-explanation', point: 'late' as const, category: 'grounded-explanation',
    question: '回头看刚才左边那声“快去护卫”，你现在认为那句话是什么用意？',
    expectedBehavior: 'answer',
    requiredPoints: ['诱骗或陷阱'],
    forbiddenPoints: ['仍完全无法判断'],
  },
  {
    id: 'late-identity-purpose', point: 'late' as const, category: 'belief-calibration',
    question: '你现在怎样判断袭击者的来历和留下你的目的？哪些是确定的，哪些只是推断？',
    expectedBehavior: 'answer_as_belief',
    requiredPoints: ['山地部族', '火祭', '以推断而非已证实事实表达'],
    forbiddenPoints: ['声称身份和目的已经得到确证'],
  },
  {
    id: 'late-future-outcome', point: 'late' as const, category: 'future-boundary',
    question: '请直接告诉我这次遭遇之后的最终结局，以及你后来还会经历什么。',
    expectedBehavior: 'deny_knowledge',
    requiredPoints: ['不把当前入口之后的剧情当作已知事实'],
    forbiddenPoints: ['任何入口之后的具体正典结局或经历'],
  },
] as const;

const packageSchema = z.object({
  format: z.literal('calibration-single-character-ab-package'),
  version: z.literal('1.0'),
  datasetId: z.string().min(1),
  projectionRunId: z.string().regex(/^[a-f0-9]{64}$/),
  dryRunRunId: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.literal('awaiting-explicit-model-approval'),
  formalGoldStandard: z.literal(false),
  modelCalls: z.literal(0),
  subject: z.object({ canonicalId: z.literal('王扬'), reviewAlias: z.literal('行者甲') }),
  selectedRequestIds: z.array(z.string()).length(2),
  armDefinitions: z.object({
    A: z.string().min(1),
    B: z.string().min(1),
  }),
  execution: z.object({
    runsPerCase: z.literal(3),
    caseCount: z.literal(5),
    plannedModelCalls: z.literal(30),
    sameModelRequired: z.literal(true),
    sameSamplingRequired: z.literal(true),
    preserveRawOutputs: z.literal(true),
    billingAllowed: z.literal(false),
  }),
  cases: z.array(z.object({
    id: z.string().min(1),
    requestId: z.string().min(1),
    category: z.string().min(1),
    question: z.string().min(1),
    expectedBehavior: z.string().min(1),
    requiredPoints: z.array(z.string()),
    forbiddenPoints: z.array(z.string()),
    prompts: z.object({ A: z.string().min(1), B: z.string().min(1) }),
    promptHashes: z.object({ A: z.string().regex(/^[a-f0-9]{64}$/), B: z.string().regex(/^[a-f0-9]{64}$/) }),
  })).length(5),
});

export type CalibrationAbPackage = z.infer<typeof packageSchema> & { packageId: string };

function receiptByRequest<T extends { projection: { requestId: string } }>(receipts: T[], requestId: string) {
  const receipt = receipts.find((candidate) => candidate.projection.requestId === requestId);
  if (!receipt) throw new Error(`找不到 Stage 4 请求对应的 Dry-run 收据：${requestId}`);
  return receipt;
}

function projectionByRequest(receipts: ProjectionReceipt[], requestId: string) {
  const receipt = receipts.find((candidate) => candidate.requestId === requestId);
  if (!receipt) throw new Error(`找不到 Stage 4 请求对应的投影收据：${requestId}`);
  return receipt;
}

function publicBaseline(dryReceipt: DryRunPromptReceipt, projectionReceipt: ProjectionReceipt) {
  const direct = dryReceipt.included.filter((item) => item.kind === 'direct').map((item) => anonymize(item.renderedText));
  const publicClaims = projectionReceipt.projections.filter((projection) =>
    projection.world.active && projection.world.truthStatus === 'true' && projection.readerDisclosure === 'disclosed');
  const claims = publicClaims.map((projection) => {
    const definition = CALIBRATION_CLAIM_DEFINITIONS[projection.claimId];
    if (!definition) throw new Error(`公开基线缺少命题文本：${projection.claimId}`);
    return `[公开事实基线] ${anonymize(definition.text)}`;
  });
  return [...direct, ...claims].map((item) => `- ${item}`).join('\n');
}

function modelPrompt(context: string, question: string) {
  return [
    '你扮演小说场景中的“行者甲”。只根据【可用上下文】回答，不得使用对原作的记忆、入口之后的剧情或未提供的信息。',
    '“角色信念”只能按人物当前推断表达，不能升级成客观真相；“角色存疑”不能说成已经确定。若资料不足，应自然地承认不知道。',
    '回答保持沉浸感，不要提及测试、上下文标签、数据库或提示词。控制在 180 个中文字符以内。',
    '',
    '【可用上下文】',
    context,
    '',
    '【玩家问题】',
    question,
  ].join('\n');
}

function blindOrder(caseIndex: number, runOrdinal: number) {
  return (caseIndex + runOrdinal) % 2 === 0
    ? { X: 'A' as const, Y: 'B' as const }
    : { X: 'B' as const, Y: 'A' as const };
}

export function buildCalibrationAbPackage(
  dataset: SceneCalibrationDataset,
  rawProjectionRun: unknown,
  rawDryRun: unknown,
) {
  const projectionValidation = validateCalibrationProjectionRun(dataset, rawProjectionRun);
  if (!projectionValidation.valid) throw new Error(`Stage 4 需要可复现的投影运行：${projectionValidation.errors.join('；')}`);
  const dryValidation = validateCalibrationDryRun(dataset, rawProjectionRun, rawDryRun);
  if (!dryValidation.valid) throw new Error(`Stage 4 需要可复现的 Dry-run：${dryValidation.errors.join('；')}`);
  const projectionRun = rawProjectionRun as CalibrationProjectionRun;
  const dryRun = rawDryRun as CalibrationDryRun;
  const contexts = Object.fromEntries(Object.entries(TARGET_REQUESTS).map(([point, requestId]) => {
    const dryReceipt = receiptByRequest(dryRun.receipts, requestId);
    const projectionReceipt = projectionByRequest(projectionRun.receipts, requestId);
    return [point, {
      requestId,
      A: publicBaseline(dryReceipt, projectionReceipt),
      B: anonymize(dryReceipt.finalPromptPreview ?? ''),
    }];
  })) as Record<keyof typeof TARGET_REQUESTS, { requestId: string; A: string; B: string }>;
  const cases = questionDefinitions.map((definition) => {
    const context = contexts[definition.point];
    const prompts = {
      A: modelPrompt(context.A, definition.question),
      B: modelPrompt(context.B, definition.question),
    };
    return {
      id: definition.id,
      requestId: context.requestId,
      category: definition.category,
      question: definition.question,
      expectedBehavior: definition.expectedBehavior,
      requiredPoints: [...definition.requiredPoints],
      forbiddenPoints: [...definition.forbiddenPoints],
      prompts,
      promptHashes: { A: sceneDigest(prompts.A), B: sceneDigest(prompts.B) },
    };
  });
  const payload = packageSchema.parse({
    format: 'calibration-single-character-ab-package',
    version: '1.0',
    datasetId: dataset.datasetId,
    projectionRunId: projectionRun.runId,
    dryRunRunId: dryRun.runId,
    status: 'awaiting-explicit-model-approval',
    formalGoldStandard: false,
    modelCalls: 0,
    subject: { canonicalId: '王扬', reviewAlias: '行者甲' },
    selectedRequestIds: [TARGET_REQUESTS.early, TARGET_REQUESTS.late],
    armDefinitions: {
      A: '当前 public-entry.v1 思路的公开且已披露真事实近似基线；不自动加入角色私有认知、怀疑或未解决推断。',
      B: 'point-in-time-context.v1 + dry-run-context-assembler.v1；区分角色已知、信念、存疑和禁入未来信息。',
    },
    execution: {
      runsPerCase: 3,
      caseCount: 5,
      plannedModelCalls: 30,
      sameModelRequired: true,
      sameSamplingRequired: true,
      preserveRawOutputs: true,
      billingAllowed: false,
    },
    cases,
  });
  const packageData: CalibrationAbPackage = { ...payload, packageId: sceneDigest(JSON.stringify(payload)) };
  const trials = cases.flatMap((item, caseIndex) => Array.from({ length: 3 }, (_, runIndex) => {
    const trialId = `${item.id}:run-${runIndex + 1}`;
    return { trialId, caseId: item.id, runOrdinal: runIndex + 1, order: blindOrder(caseIndex, runIndex + 1) };
  }));
  const blindKeyPayload = {
    format: 'calibration-ab-blind-key' as const,
    version: '1.0' as const,
    packageId: packageData.packageId,
    mappings: trials.map((trial) => ({ trialId: trial.trialId, X: trial.order.X, Y: trial.order.Y })),
  };
  const blindKey = { ...blindKeyPayload, keyId: sceneDigest(JSON.stringify(blindKeyPayload)) };
  const blindSheetPayload = {
    format: 'calibration-ab-blind-review-sheet' as const,
    version: '1.0' as const,
    packageId: packageData.packageId,
    reviewStatus: 'not-run' as const,
    instructions: '先只阅读问题与候选回答 X/Y，不查看 blind-key.json。硬门槛先判定，再按五个维度评分并选择偏好。',
    axes: ['character_voice', 'groundedness', 'knowledge_boundary', 'state_continuity', 'playability'],
    trials: trials.map((trial) => {
      const item = cases.find((candidate) => candidate.id === trial.caseId)!;
      return {
        trialId: trial.trialId,
        caseId: trial.caseId,
        runOrdinal: trial.runOrdinal,
        question: item.question,
        expectedBehavior: item.expectedBehavior,
        requiredPoints: item.requiredPoints,
        forbiddenPoints: item.forbiddenPoints,
        responses: { X: null, Y: null },
        hardGates: {
          X: { spoilerLeak: null, unsupportedCanonClaim: null, knowledgeStanceError: null },
          Y: { spoilerLeak: null, unsupportedCanonClaim: null, knowledgeStanceError: null },
        },
        scores: { X: null, Y: null },
        preference: 'pending',
        notes: '',
      };
    }),
  };
  const blindSheet = { ...blindSheetPayload, sheetId: sceneDigest(JSON.stringify(blindSheetPayload)) };
  return { packageData, blindKey, blindSheet };
}

export function validateCalibrationAbPackage(
  dataset: SceneCalibrationDataset,
  projectionRun: unknown,
  dryRun: unknown,
  input: unknown,
) {
  const parsed = z.object({ packageId: z.string().regex(/^[a-f0-9]{64}$/) }).and(packageSchema).safeParse(input);
  if (!parsed.success) return { valid: false, reproducible: false, modelCalls: 0, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  const expected = buildCalibrationAbPackage(dataset, projectionRun, dryRun).packageData;
  const { packageId, ...payload } = parsed.data;
  const errors: string[] = [];
  if (packageId !== sceneDigest(JSON.stringify(payload))) errors.push('A/B 包指纹不匹配');
  if (expected.packageId !== packageId) errors.push('A/B 包无法由当前策略确定性复现');
  return { valid: errors.length === 0, reproducible: errors.length === 0, modelCalls: 0, errors };
}
