import { z } from 'zod';
import {
  projectionReceiptSchema,
  projectPointInTimeKnowledge,
  type CharacterBelief,
  type ReaderDisclosure,
  type SceneSnapshot,
  type WorldClaim,
} from '../../src/shared/point-in-time-context';
import { sceneDigest, type SceneCalibrationDataset } from './scene-calibration';

const EXPECTED_DATASET_ID = '46f60d706fb1f6f53d0ff25613791514375ece18444175a5a50bcae9a6885c85';
const EXPECTED_SOURCE_SHA256 = '4ad9c628259d8f3772ea33c1cec9ada56ce44909df6ff58df7cd053abb3439bb';

const runSchema = z.object({
  format: z.literal('calibration-point-in-time-projection-run'),
  version: z.literal('1.0'),
  datasetId: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvalStatus: z.literal('provisional-single-owner-approved'),
  formalGoldStandard: z.literal(false),
  modelCalls: z.literal(0),
  receipts: z.array(projectionReceiptSchema),
  summary: z.object({
    caseCount: z.number().int().nonnegative(),
    entryCount: z.number().int().nonnegative(),
    subjectProjectionCount: z.number().int().nonnegative(),
    decisionCount: z.number().int().nonnegative(),
    mustIncludeCount: z.number().int().nonnegative(),
    eligibleCount: z.number().int().nonnegative(),
    mustExcludeCount: z.number().int().nonnegative(),
    futureKnowledgeExclusionCount: z.number().int().nonnegative(),
    unknownKnowledgeExclusionCount: z.number().int().nonnegative(),
  }),
});

export type CalibrationProjectionRun = z.infer<typeof runSchema> & { runId: string };

function datasetIntegrity(dataset: SceneCalibrationDataset) {
  const { datasetId, ...payload } = dataset;
  if (sceneDigest(JSON.stringify(payload)) !== datasetId) throw new Error('calibration dataset 指纹不匹配');
  if (datasetId !== EXPECTED_DATASET_ID || dataset.source.sha256 !== EXPECTED_SOURCE_SHA256) {
    throw new Error('只允许使用已由项目负责人临时批准的 calibration 数据集');
  }
}

function caseById(dataset: SceneCalibrationDataset, caseId: string) {
  const item = dataset.cases.find((candidate) => candidate.id === caseId);
  if (!item) throw new Error(`找不到 calibration 场景：${caseId}`);
  return item;
}

function evidence(dataset: SceneCalibrationDataset, caseId: string, ordinal: number) {
  const item = caseById(dataset, caseId);
  const paragraph = [...item.paragraphs, ...item.previousContext.flatMap((context) => context.paragraphs)]
    .find((candidate) => candidate.ordinal === ordinal);
  if (!paragraph) throw new Error(`${caseId}: 找不到证据段落 P${ordinal}`);
  return {
    sourceRevisionId: dataset.source.revisionId,
    paragraphId: paragraph.id,
    ordinal: paragraph.ordinal,
    exactQuote: paragraph.text,
  };
}

function interval(fromOrdinal: number, toOrdinalExclusive: number | null = null) {
  return { fromOrdinal, toOrdinalExclusive };
}

function nightAmbushKnowledge(dataset: SceneCalibrationDataset) {
  const caseId = 'cal-a-night-ambush';
  const claims: WorldClaim[] = [
    {
      id: 'cal-a-call-is-trap', proposition: '左侧“快去护卫”的喊话是诱骗王扬的陷阱', subject: '左侧来人', predicate: '喊话目的', object: '诱骗王扬',
      truthStatus: 'true', validDuring: interval(25001), evidence: [evidence(dataset, caseId, 25014)],
    },
    {
      id: 'cal-a-wang-unconscious-after-first-fall', proposition: '王扬第一次被绳套拖倒后已经昏迷', subject: '王扬', predicate: '意识状态', object: '昏迷',
      truthStatus: 'false', validDuring: interval(25016, 25020), evidence: [evidence(dataset, caseId, 25020)],
    },
    {
      id: 'cal-a-attackers-are-yidu', proposition: '袭击者属于宜都蛮', subject: '袭击者', predicate: '归属', object: '宜都蛮',
      truthStatus: 'unresolved', validDuring: interval(24982), evidence: [evidence(dataset, caseId, 25039)],
    },
    {
      id: 'cal-a-fire-sacrifice-purpose', proposition: '袭击者准备留下王扬用于火祭', subject: '袭击者', predicate: '行动目的', object: '将王扬用于火祭',
      truthStatus: 'unresolved', validDuring: interval(25025), evidence: [evidence(dataset, caseId, 25039)],
    },
  ];
  const readerDisclosures: ReaderDisclosure[] = [
    { id: 'cal-a-reader-trap', claimId: 'cal-a-call-is-trap', state: 'disclosed', effectiveDuring: interval(25014), evidence: [evidence(dataset, caseId, 25014)] },
    { id: 'cal-a-reader-unconscious-false', claimId: 'cal-a-wang-unconscious-after-first-fall', state: 'disclosed', effectiveDuring: interval(25020), evidence: [evidence(dataset, caseId, 25020)] },
    { id: 'cal-a-reader-yidu-inference', claimId: 'cal-a-attackers-are-yidu', state: 'disclosed', effectiveDuring: interval(25039), evidence: [evidence(dataset, caseId, 25039)] },
    { id: 'cal-a-reader-fire-inference', claimId: 'cal-a-fire-sacrifice-purpose', state: 'disclosed', effectiveDuring: interval(25039), evidence: [evidence(dataset, caseId, 25039)] },
  ];
  const characterBeliefs: CharacterBelief[] = [
    { id: 'cal-a-wang-doubts-call', claimId: 'cal-a-call-is-trap', subjectId: '王扬', state: 'doubted', acquiredAtOrdinal: 25005, effectiveDuring: interval(25005, 25014), mayDisclose: 'yes', acquiredFrom: 'inference', evidence: [evidence(dataset, caseId, 25005)] },
    { id: 'cal-a-wang-knows-trap', claimId: 'cal-a-call-is-trap', subjectId: '王扬', state: 'known', acquiredAtOrdinal: 25014, effectiveDuring: interval(25014), mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(dataset, caseId, 25014)] },
    { id: 'cal-a-attackers-believe-unconscious', claimId: 'cal-a-wang-unconscious-after-first-fall', subjectId: '埋伏者', state: 'believed', acquiredAtOrdinal: 25018, effectiveDuring: interval(25018, 25020), mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(dataset, caseId, 25018)] },
    { id: 'cal-a-wang-infers-yidu', claimId: 'cal-a-attackers-are-yidu', subjectId: '王扬', state: 'believed', acquiredAtOrdinal: 25039, effectiveDuring: interval(25039), mayDisclose: 'yes', acquiredFrom: 'inference', evidence: [evidence(dataset, caseId, 25039)] },
    { id: 'cal-a-wang-infers-fire-sacrifice', claimId: 'cal-a-fire-sacrifice-purpose', subjectId: '王扬', state: 'believed', acquiredAtOrdinal: 25039, effectiveDuring: interval(25039), mayDisclose: 'yes', acquiredFrom: 'inference', evidence: [evidence(dataset, caseId, 25039)] },
  ];
  return { claims, readerDisclosures, characterBeliefs };
}

function burningRopeKnowledge(dataset: SceneCalibrationDataset) {
  const caseId = 'cal-b-burning-rope';
  const claims: WorldClaim[] = [
    {
      id: 'cal-b-rope-remains-unbroken', proposition: '火焰经过后麻绳焦黑但没有断', subject: '麻绳', predicate: '燃烧结果', object: '焦黑但未断',
      truthStatus: 'true', validDuring: interval(27438), evidence: [evidence(dataset, caseId, 27438)],
    },
    {
      id: 'cal-b-salt-mechanism', proposition: '盐晶体帮助燃烧后的绳索维持结构', subject: '盐水处理的麻绳', predicate: '自然机制', object: '盐晶体维持结构',
      truthStatus: 'true', validDuring: interval(27428), evidence: [evidence(dataset, caseId, 27445)],
    },
    {
      id: 'cal-b-grand-shaman-wants-failure', proposition: '大巫祝希望用第二题使王扬失败', subject: '大巫祝', predicate: '私下目标', object: '使王扬失败',
      truthStatus: 'true', validDuring: interval(27421, 27439), evidence: [evidence(dataset, caseId, 27421)],
    },
    {
      id: 'cal-b-wang-is-supernatural-envoy', proposition: '王扬是具有超自然力量的神使', subject: '王扬', predicate: '神使身份', object: '超自然神使',
      truthStatus: 'unresolved', validDuring: interval(27424), evidence: [evidence(dataset, caseId, 27440)],
    },
  ];
  const readerDisclosures: ReaderDisclosure[] = [
    { id: 'cal-b-reader-result', claimId: 'cal-b-rope-remains-unbroken', state: 'disclosed', effectiveDuring: interval(27438), evidence: [evidence(dataset, caseId, 27438)] },
    { id: 'cal-b-reader-mechanism', claimId: 'cal-b-salt-mechanism', state: 'disclosed', effectiveDuring: interval(27445), evidence: [evidence(dataset, caseId, 27445)] },
    { id: 'cal-b-reader-shaman-goal', claimId: 'cal-b-grand-shaman-wants-failure', state: 'disclosed', effectiveDuring: interval(27421, 27439), evidence: [evidence(dataset, caseId, 27421)] },
    { id: 'cal-b-reader-miracle-belief', claimId: 'cal-b-wang-is-supernatural-envoy', state: 'hinted', effectiveDuring: interval(27440), evidence: [evidence(dataset, caseId, 27440)] },
  ];
  const characterBeliefs: CharacterBelief[] = [
    { id: 'cal-b-wang-expects-rope', claimId: 'cal-b-rope-remains-unbroken', subjectId: '王扬', state: 'believed', acquiredAtOrdinal: 27428, effectiveDuring: interval(27428, 27438), mayDisclose: 'yes', acquiredFrom: 'memory', evidence: [evidence(dataset, caseId, 27428)] },
    { id: 'cal-b-wang-knows-rope', claimId: 'cal-b-rope-remains-unbroken', subjectId: '王扬', state: 'known', acquiredAtOrdinal: 27438, effectiveDuring: interval(27438), mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(dataset, caseId, 27438)] },
    { id: 'cal-b-shaman-disbelieves-rope', claimId: 'cal-b-rope-remains-unbroken', subjectId: '大巫祝', state: 'disbelieved', acquiredAtOrdinal: 27432, effectiveDuring: interval(27432, 27438), mayDisclose: 'yes', acquiredFrom: 'inference', evidence: [evidence(dataset, caseId, 27432)] },
    { id: 'cal-b-shaman-knows-rope', claimId: 'cal-b-rope-remains-unbroken', subjectId: '大巫祝', state: 'known', acquiredAtOrdinal: 27438, effectiveDuring: interval(27438), mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(dataset, caseId, 27438)] },
    { id: 'cal-b-crowd-knows-rope', claimId: 'cal-b-rope-remains-unbroken', subjectId: '普通围观者', state: 'known', acquiredAtOrdinal: 27440, effectiveDuring: interval(27440), mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(dataset, caseId, 27440)] },
    { id: 'cal-b-wang-knows-mechanism', claimId: 'cal-b-salt-mechanism', subjectId: '王扬', state: 'known', acquiredAtOrdinal: 27428, effectiveDuring: interval(27428), mayDisclose: 'unknown', acquiredFrom: 'memory', evidence: [evidence(dataset, caseId, 27428)] },
    { id: 'cal-b-shaman-knows-own-goal', claimId: 'cal-b-grand-shaman-wants-failure', subjectId: '大巫祝', state: 'known', acquiredAtOrdinal: 27421, effectiveDuring: interval(27421, 27439), mayDisclose: 'no', acquiredFrom: 'memory', evidence: [evidence(dataset, caseId, 27421)] },
    { id: 'cal-b-shaman-disbelieves-envoy', claimId: 'cal-b-wang-is-supernatural-envoy', subjectId: '大巫祝', state: 'disbelieved', acquiredAtOrdinal: 27432, effectiveDuring: interval(27432), mayDisclose: 'yes', acquiredFrom: 'memory', evidence: [evidence(dataset, caseId, 27432)] },
    { id: 'cal-b-crowd-believes-envoy', claimId: 'cal-b-wang-is-supernatural-envoy', subjectId: '普通围观者', state: 'believed', acquiredAtOrdinal: 27440, effectiveDuring: interval(27440), mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(dataset, caseId, 27440)] },
  ];
  return { claims, readerDisclosures, characterBeliefs };
}

function requiredClaims(caseId: string, entryId: string, subject: string): string[] {
  if (caseId === 'cal-a-night-ambush') {
    if (subject === '王扬' && entryId !== 'cal-a-e3-identity-inference') return ['cal-a-call-is-trap'];
    if (subject === '王扬') return ['cal-a-attackers-are-yidu', 'cal-a-fire-sacrifice-purpose'];
    if (subject === '埋伏者' && entryId === 'cal-a-e2-feigned-unconscious') return ['cal-a-wang-unconscious-after-first-fall'];
    return [];
  }
  if (subject === '王扬') return ['cal-b-rope-remains-unbroken', 'cal-b-salt-mechanism'];
  if (subject === '大巫祝') return ['cal-b-rope-remains-unbroken', 'cal-b-grand-shaman-wants-failure'];
  return ['cal-b-rope-remains-unbroken', 'cal-b-wang-is-supernatural-envoy'];
}

function snapshotFor(dataset: SceneCalibrationDataset, caseId: string, entryId: string, subject: string): SceneSnapshot {
  const item = caseById(dataset, caseId);
  const entry = item.entries.find((candidate) => candidate.id === entryId);
  if (!entry?.anchorParagraphId) throw new Error(`找不到入口锚点：${entryId}`);
  const subjects = [item.primarySubject, ...item.comparisonSubjects];
  return {
    id: `${caseId}:${entryId}:${subject}`,
    sourceRevisionId: dataset.source.revisionId,
    boundary: { startOrdinal: item.boundary.startOrdinal, endOrdinalInclusive: item.boundary.endOrdinal },
    entry: {
      anchorParagraphId: entry.anchorParagraphId,
      anchorOrdinal: entry.anchorOrdinal,
      semantics: 'before_anchor_paragraph',
      knownThroughOrdinal: entry.anchorOrdinal - 1,
    },
    primaryCharacterId: subject,
    presentCharacterIds: subjects,
    locationIds: [caseId === 'cal-a-night-ambush' ? 'night-battlefield' : 'yidu-ritual-platform'],
    priorEventIds: [],
    objectives: [],
    conflicts: [],
    prohibitedFuture: { fromOrdinal: entry.anchorOrdinal, reason: 'calibration 入口及其后内容禁止提前进入' },
  };
}

export function buildCalibrationProjectionRun(dataset: SceneCalibrationDataset): CalibrationProjectionRun {
  datasetIntegrity(dataset);
  const receipts = dataset.cases.flatMap((item) => {
    const knowledge = item.id === 'cal-a-night-ambush' ? nightAmbushKnowledge(dataset) : burningRopeKnowledge(dataset);
    const claimIds = knowledge.claims.map((claim) => claim.id);
    return item.entries.flatMap((entry) => [item.primarySubject, ...item.comparisonSubjects].map((subject) => projectPointInTimeKnowledge({
      request: {
        id: `${item.id}:${entry.id}:${subject}`,
        policyVersion: 'point-in-time-context.v1',
        snapshot: snapshotFor(dataset, item.id, entry.id, subject),
        targetCharacterId: subject,
        requiredClaimIds: requiredClaims(item.id, entry.id, subject),
        candidateClaimIds: claimIds,
        budget: { totalTokens: 1000, buckets: { characterCore: 100, sceneSnapshot: 250, activatedLore: 150, retrievedMemory: 300, conversationMemory: 200 } },
      },
      ...knowledge,
    })));
  });
  const decisions = receipts.flatMap((receipt) => receipt.projections.map((projection) => projection.runtime));
  const payload = runSchema.parse({
    format: 'calibration-point-in-time-projection-run',
    version: '1.0',
    datasetId: dataset.datasetId,
    sourceSha256: dataset.source.sha256,
    approvalStatus: 'provisional-single-owner-approved',
    formalGoldStandard: false,
    modelCalls: 0,
    receipts,
    summary: {
      caseCount: dataset.cases.length,
      entryCount: dataset.cases.reduce((sum, item) => sum + item.entries.length, 0),
      subjectProjectionCount: receipts.length,
      decisionCount: decisions.length,
      mustIncludeCount: decisions.filter((decision) => decision.policy === 'must_include').length,
      eligibleCount: decisions.filter((decision) => decision.policy === 'eligible').length,
      mustExcludeCount: decisions.filter((decision) => decision.policy === 'must_exclude').length,
      futureKnowledgeExclusionCount: decisions.filter((decision) => decision.reason === 'future_knowledge').length,
      unknownKnowledgeExclusionCount: decisions.filter((decision) => decision.reason === 'unknown_to_character').length,
    },
  });
  return { ...payload, runId: sceneDigest(JSON.stringify(payload)) };
}

export function validateCalibrationProjectionRun(dataset: SceneCalibrationDataset, input: unknown) {
  const parsed = z.object({ runId: z.string().min(1) }).and(runSchema).safeParse(input);
  if (!parsed.success) return { valid: false, reproducible: false, formalGoldStandard: false, errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  const { runId, ...payload } = parsed.data;
  const errors: string[] = [];
  if (runId !== sceneDigest(JSON.stringify(payload))) errors.push('投影运行指纹不匹配');
  if (payload.datasetId !== dataset.datasetId || payload.sourceSha256 !== dataset.source.sha256) errors.push('投影运行与 calibration 数据集不匹配');
  const expected = buildCalibrationProjectionRun(dataset);
  if (expected.runId !== runId) errors.push('投影运行无法由当前策略确定性复现');
  return { valid: errors.length === 0, reproducible: errors.length === 0, formalGoldStandard: false, errors };
}
