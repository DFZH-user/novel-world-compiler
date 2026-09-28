import { z } from 'zod';

const ordinal = z.number().int().positive();
const optionalEndOrdinal = z.number().int().positive().nullable();

export const ordinalIntervalSchema = z.object({
  fromOrdinal: ordinal,
  toOrdinalExclusive: optionalEndOrdinal,
}).superRefine((interval, context) => {
  if (interval.toOrdinalExclusive !== null && interval.toOrdinalExclusive <= interval.fromOrdinal) {
    context.addIssue({ code: 'custom', path: ['toOrdinalExclusive'], message: '区间终点必须晚于起点' });
  }
});

export const pointInTimeEvidenceSchema = z.object({
  sourceRevisionId: z.string().min(1),
  paragraphId: z.string().min(1),
  ordinal,
  exactQuote: z.string().min(1),
});

export const worldClaimSchema = z.object({
  id: z.string().min(1),
  proposition: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  truthStatus: z.enum(['true', 'false', 'disputed', 'unresolved']),
  validDuring: ordinalIntervalSchema,
  evidence: z.array(pointInTimeEvidenceSchema).min(1),
});

export const readerDisclosureSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  state: z.enum(['disclosed', 'hinted', 'not_disclosed']),
  effectiveDuring: ordinalIntervalSchema,
  evidence: z.array(pointInTimeEvidenceSchema).min(1),
}).superRefine((disclosure, context) => {
  if (disclosure.evidence.some((evidence) => evidence.ordinal > disclosure.effectiveDuring.fromOrdinal)) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: '读者公开状态不能由生效时点之后的证据建立' });
  }
});

export const characterBeliefSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  subjectId: z.string().min(1),
  state: z.enum(['known', 'believed', 'doubted', 'disbelieved', 'unknown']),
  acquiredAtOrdinal: ordinal,
  effectiveDuring: ordinalIntervalSchema,
  mayDisclose: z.enum(['yes', 'no', 'unknown']),
  acquiredFrom: z.enum(['observation', 'conversation', 'document', 'inference', 'memory', 'unknown']),
  evidence: z.array(pointInTimeEvidenceSchema).min(1),
}).superRefine((belief, context) => {
  if (belief.effectiveDuring.fromOrdinal !== belief.acquiredAtOrdinal) {
    context.addIssue({ code: 'custom', path: ['effectiveDuring', 'fromOrdinal'], message: '认知生效点必须等于获得信息的时点' });
  }
  if (belief.evidence.some((evidence) => evidence.ordinal > belief.acquiredAtOrdinal)) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: '角色认知不能由获得时点之后的证据建立' });
  }
});

export const sceneSnapshotSchema = z.object({
  id: z.string().min(1),
  sourceRevisionId: z.string().min(1),
  boundary: z.object({
    startOrdinal: ordinal,
    endOrdinalInclusive: ordinal,
  }),
  entry: z.object({
    anchorParagraphId: z.string().min(1),
    anchorOrdinal: ordinal,
    semantics: z.literal('before_anchor_paragraph'),
    knownThroughOrdinal: z.number().int().nonnegative(),
  }),
  primaryCharacterId: z.string().min(1),
  presentCharacterIds: z.array(z.string().min(1)),
  locationIds: z.array(z.string().min(1)),
  priorEventIds: z.array(z.string().min(1)),
  objectives: z.array(z.string().min(1)),
  conflicts: z.array(z.string().min(1)),
  prohibitedFuture: z.object({
    fromOrdinal: ordinal,
    reason: z.string().min(1),
  }),
}).superRefine((snapshot, context) => {
  if (snapshot.boundary.endOrdinalInclusive < snapshot.boundary.startOrdinal) {
    context.addIssue({ code: 'custom', path: ['boundary'], message: '场景终点不能早于起点' });
  }
  if (snapshot.entry.anchorOrdinal < snapshot.boundary.startOrdinal
    || snapshot.entry.anchorOrdinal > snapshot.boundary.endOrdinalInclusive + 1) {
    context.addIssue({ code: 'custom', path: ['entry', 'anchorOrdinal'], message: '入口必须位于场景内或紧随场景结束' });
  }
  if (snapshot.entry.knownThroughOrdinal !== snapshot.entry.anchorOrdinal - 1) {
    context.addIssue({ code: 'custom', path: ['entry', 'knownThroughOrdinal'], message: 'before_anchor_paragraph 必须只知道锚点前一段' });
  }
  if (snapshot.prohibitedFuture.fromOrdinal !== snapshot.entry.anchorOrdinal) {
    context.addIssue({ code: 'custom', path: ['prohibitedFuture', 'fromOrdinal'], message: '禁止未来内容必须从入口锚点开始' });
  }
  if (!snapshot.presentCharacterIds.includes(snapshot.primaryCharacterId)) {
    context.addIssue({ code: 'custom', path: ['presentCharacterIds'], message: '主要角色必须在场' });
  }
});

export const contextBudgetSchema = z.object({
  totalTokens: z.number().int().positive(),
  buckets: z.object({
    characterCore: z.number().int().nonnegative(),
    sceneSnapshot: z.number().int().nonnegative(),
    activatedLore: z.number().int().nonnegative(),
    retrievedMemory: z.number().int().nonnegative(),
    conversationMemory: z.number().int().nonnegative(),
  }),
}).superRefine((budget, context) => {
  const allocated = Object.values(budget.buckets).reduce((sum, value) => sum + value, 0);
  if (allocated > budget.totalTokens) context.addIssue({ code: 'custom', path: ['buckets'], message: '预算桶总和不能超过总预算' });
});

export const contextAssemblyRequestSchema = z.object({
  id: z.string().min(1),
  policyVersion: z.literal('point-in-time-context.v1'),
  snapshot: sceneSnapshotSchema,
  targetCharacterId: z.string().min(1),
  requiredClaimIds: z.array(z.string().min(1)),
  candidateClaimIds: z.array(z.string().min(1)),
  budget: contextBudgetSchema,
}).superRefine((request, context) => {
  if (request.targetCharacterId !== request.snapshot.primaryCharacterId) {
    context.addIssue({ code: 'custom', path: ['targetCharacterId'], message: '第一版请求主体必须等于场景主要角色' });
  }
  if (new Set(request.requiredClaimIds).size !== request.requiredClaimIds.length
    || new Set(request.candidateClaimIds).size !== request.candidateClaimIds.length) {
    context.addIssue({ code: 'custom', path: ['candidateClaimIds'], message: '命题 ID 不能重复' });
  }
  if (request.requiredClaimIds.some((claimId) => !request.candidateClaimIds.includes(claimId))) {
    context.addIssue({ code: 'custom', path: ['requiredClaimIds'], message: '必选命题必须同时属于候选集合' });
  }
});

export const pointInTimeProjectionSchema = z.object({
  claimId: z.string().min(1),
  atOrdinal: z.number().int().nonnegative(),
  world: z.object({
    truthStatus: z.enum(['true', 'false', 'disputed', 'unresolved']),
    active: z.boolean(),
  }),
  readerDisclosure: z.enum(['disclosed', 'hinted', 'not_disclosed', 'unknown']),
  character: z.object({
    subjectId: z.string().min(1),
    epistemicState: z.enum(['known', 'believed', 'doubted', 'disbelieved', 'unknown']),
    mayDisclose: z.enum(['yes', 'no', 'unknown']),
    acquiredFrom: z.enum(['observation', 'conversation', 'document', 'inference', 'memory', 'unknown']),
  }),
  runtime: z.object({
    policy: z.enum(['must_include', 'eligible', 'must_exclude']),
    reason: z.enum([
      'required_character_knowledge',
      'character_knowledge',
      'character_belief',
      'character_uncertainty',
      'character_disbelief',
      'known_but_must_not_disclose',
      'future_knowledge',
      'unknown_to_character',
      'irrelevant',
    ]),
    renderAs: z.enum(['world_truth', 'character_belief', 'uncertainty', 'counterbelief', 'withheld_secret', 'excluded']),
    responseDisclosure: z.enum(['allowed', 'forbidden', 'unknown']),
  }),
});

export const projectionReceiptSchema = z.object({
  format: z.literal('point-in-time-projection-receipt'),
  version: z.literal('1.0'),
  requestId: z.string().min(1),
  policyVersion: z.literal('point-in-time-context.v1'),
  sourceRevisionId: z.string().min(1),
  sceneId: z.string().min(1),
  targetCharacterId: z.string().min(1),
  anchorOrdinal: ordinal,
  knownThroughOrdinal: z.number().int().nonnegative(),
  projections: z.array(pointInTimeProjectionSchema),
});

export type WorldClaim = z.infer<typeof worldClaimSchema>;
export type ReaderDisclosure = z.infer<typeof readerDisclosureSchema>;
export type CharacterBelief = z.infer<typeof characterBeliefSchema>;
export type SceneSnapshot = z.infer<typeof sceneSnapshotSchema>;
export type ContextAssemblyRequest = z.infer<typeof contextAssemblyRequestSchema>;
export type PointInTimeProjection = z.infer<typeof pointInTimeProjectionSchema>;
export type ProjectionReceipt = z.infer<typeof projectionReceiptSchema>;

function activeAt(interval: z.infer<typeof ordinalIntervalSchema>, atOrdinal: number) {
  return interval.fromOrdinal <= atOrdinal && (interval.toOrdinalExclusive === null || atOrdinal < interval.toOrdinalExclusive);
}

function assertUniqueIds(label: string, values: Array<{ id: string }>) {
  if (new Set(values.map((value) => value.id)).size !== values.length) throw new Error(`${label} ID 不能重复`);
}

function groupBy<T>(values: T[], keyOf: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function assertNonOverlappingIntervals(label: string, values: Array<{ effectiveDuring: z.infer<typeof ordinalIntervalSchema> }>) {
  const ordered = [...values].sort((left, right) => left.effectiveDuring.fromOrdinal - right.effectiveDuring.fromOrdinal);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1].effectiveDuring;
    if (previous.toOrdinalExclusive === null || previous.toOrdinalExclusive > ordered[index].effectiveDuring.fromOrdinal) {
      throw new Error(`${label} 的有效区间不能重叠`);
    }
  }
}

function latestActive<T extends { effectiveDuring: z.infer<typeof ordinalIntervalSchema> }>(values: T[], atOrdinal: number): T | undefined {
  return values.filter((value) => activeAt(value.effectiveDuring, atOrdinal))
    .sort((left, right) => right.effectiveDuring.fromOrdinal - left.effectiveDuring.fromOrdinal)[0];
}

export function projectPointInTimeKnowledge(input: {
  request: unknown;
  claims: unknown[];
  readerDisclosures: unknown[];
  characterBeliefs: unknown[];
}): ProjectionReceipt {
  const request = contextAssemblyRequestSchema.parse(input.request);
  const claims = z.array(worldClaimSchema).parse(input.claims);
  const readerDisclosures = z.array(readerDisclosureSchema).parse(input.readerDisclosures);
  const characterBeliefs = z.array(characterBeliefSchema).parse(input.characterBeliefs);
  assertUniqueIds('世界命题', claims);
  assertUniqueIds('读者公开记录', readerDisclosures);
  assertUniqueIds('角色认知记录', characterBeliefs);
  const claimIds = new Set(claims.map((claim) => claim.id));
  const unknownReferences = [...readerDisclosures, ...characterBeliefs].filter((value) => !claimIds.has(value.claimId));
  if (unknownReferences.length) throw new Error(`认知或公开记录引用了未知命题：${unknownReferences[0].claimId}`);
  for (const evidence of [
    ...claims.flatMap((claim) => claim.evidence),
    ...readerDisclosures.flatMap((disclosure) => disclosure.evidence),
    ...characterBeliefs.flatMap((belief) => belief.evidence),
  ]) {
    if (evidence.sourceRevisionId !== request.snapshot.sourceRevisionId) throw new Error('世界命题证据与场景来源修订不一致');
  }
  for (const [claimId, records] of groupBy(readerDisclosures, (record) => record.claimId)) {
    assertNonOverlappingIntervals(`命题 ${claimId} 的读者公开记录`, records);
  }
  for (const [key, records] of groupBy(characterBeliefs, (record) => `${record.claimId}\u0000${record.subjectId}`)) {
    assertNonOverlappingIntervals(`命题主体 ${key} 的角色认知记录`, records);
  }
  const atOrdinal = request.snapshot.entry.knownThroughOrdinal;
  const required = new Set(request.requiredClaimIds);
  const candidates = new Set(request.candidateClaimIds);
  for (const claimId of candidates) if (!claimIds.has(claimId)) throw new Error(`请求引用了未知候选命题：${claimId}`);
  const projections: PointInTimeProjection[] = [...claims].sort((left, right) => left.id.localeCompare(right.id)).map((claim) => {
    const disclosure = latestActive(readerDisclosures.filter((record) => record.claimId === claim.id), atOrdinal);
    const subjectRecords = characterBeliefs.filter((record) => record.claimId === claim.id && record.subjectId === request.targetCharacterId);
    const belief = latestActive(subjectRecords, atOrdinal);
    const futureBelief = subjectRecords.some((record) => record.effectiveDuring.fromOrdinal > atOrdinal);
    const base = {
      claimId: claim.id,
      atOrdinal,
      world: { truthStatus: claim.truthStatus, active: activeAt(claim.validDuring, atOrdinal) },
      readerDisclosure: disclosure?.state ?? 'unknown' as const,
      character: {
        subjectId: request.targetCharacterId,
        epistemicState: belief?.state ?? 'unknown' as const,
        mayDisclose: belief?.mayDisclose ?? 'unknown' as const,
        acquiredFrom: belief?.acquiredFrom ?? 'unknown' as const,
      },
    };
    if (!candidates.has(claim.id)) return pointInTimeProjectionSchema.parse({ ...base, runtime: {
      policy: 'must_exclude', reason: 'irrelevant', renderAs: 'excluded', responseDisclosure: 'unknown',
    } });
    if (!belief || belief.state === 'unknown') return pointInTimeProjectionSchema.parse({ ...base, runtime: {
      policy: 'must_exclude', reason: futureBelief ? 'future_knowledge' : 'unknown_to_character', renderAs: 'excluded', responseDisclosure: 'unknown',
    } });
    const policy = required.has(claim.id) ? 'must_include' as const : 'eligible' as const;
    if (belief.mayDisclose === 'no') return pointInTimeProjectionSchema.parse({ ...base, runtime: {
      policy, reason: 'known_but_must_not_disclose', renderAs: 'withheld_secret', responseDisclosure: 'forbidden',
    } });
    const responseDisclosure = belief.mayDisclose === 'yes' ? 'allowed' as const : 'unknown' as const;
    if (belief.state === 'believed') return pointInTimeProjectionSchema.parse({ ...base, runtime: {
      policy, reason: 'character_belief', renderAs: 'character_belief', responseDisclosure,
    } });
    if (belief.state === 'doubted') return pointInTimeProjectionSchema.parse({ ...base, runtime: {
      policy, reason: 'character_uncertainty', renderAs: 'uncertainty', responseDisclosure,
    } });
    if (belief.state === 'disbelieved') return pointInTimeProjectionSchema.parse({ ...base, runtime: {
      policy, reason: 'character_disbelief', renderAs: 'counterbelief', responseDisclosure,
    } });
    return pointInTimeProjectionSchema.parse({ ...base, runtime: {
      policy, reason: required.has(claim.id) ? 'required_character_knowledge' : 'character_knowledge',
      renderAs: 'world_truth', responseDisclosure,
    } });
  });
  return projectionReceiptSchema.parse({
    format: 'point-in-time-projection-receipt',
    version: '1.0',
    requestId: request.id,
    policyVersion: request.policyVersion,
    sourceRevisionId: request.snapshot.sourceRevisionId,
    sceneId: request.snapshot.id,
    targetCharacterId: request.targetCharacterId,
    anchorOrdinal: request.snapshot.entry.anchorOrdinal,
    knownThroughOrdinal: atOrdinal,
    projections,
  });
}
