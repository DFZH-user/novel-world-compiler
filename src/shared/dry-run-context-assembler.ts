import { createHash } from 'node:crypto';
import { z } from 'zod';
import { contextBudgetSchema, projectionReceiptSchema } from './point-in-time-context';

export const contextBucketSchema = z.enum(['characterCore', 'sceneSnapshot', 'activatedLore', 'retrievedMemory', 'conversationMemory']);
export const contextPrioritySchema = z.enum(['critical', 'high', 'normal', 'low']);

const sourceRefSchema = z.object({
  paragraphId: z.string().min(1),
  ordinal: z.number().int().positive(),
});

const retrievalTraceSchema = z.object({
  method: z.enum(['deterministic', 'keyword', 'vector', 'hybrid', 'graph']),
  score: z.number().finite().nullable(),
  trigger: z.string().nullable(),
  path: z.array(z.string()),
}).nullable();

const itemBase = {
  id: z.string().min(1),
  bucket: contextBucketSchema,
  priority: contextPrioritySchema,
  dedupeKey: z.string().min(1),
  text: z.string().min(1),
  sourceRefs: z.array(sourceRefSchema),
  retrieval: retrievalTraceSchema,
};

export const directContextItemSchema = z.object({
  ...itemBase,
  kind: z.literal('direct'),
  directPolicy: z.enum(['must_include', 'eligible']),
  directReason: z.enum(['character_core', 'scene_state', 'conversation_memory']),
});

export const claimContextItemSchema = z.object({
  ...itemBase,
  kind: z.literal('claim'),
  claimId: z.string().min(1),
});

export const contextAssemblyItemSchema = z.discriminatedUnion('kind', [directContextItemSchema, claimContextItemSchema]);

export const dryRunAssemblyInputSchema = z.object({
  id: z.string().min(1),
  policyVersion: z.literal('dry-run-context-assembler.v1'),
  projectionReceipt: projectionReceiptSchema,
  budget: contextBudgetSchema,
  items: z.array(contextAssemblyItemSchema),
}).superRefine((input, context) => {
  if (new Set(input.items.map((item) => item.id)).size !== input.items.length) {
    context.addIssue({ code: 'custom', path: ['items'], message: '上下文条目 ID 不能重复' });
  }
});

const decisionBase = {
  itemId: z.string().min(1),
  kind: z.enum(['direct', 'claim']),
  claimId: z.string().nullable(),
  bucket: contextBucketSchema,
  priority: contextPrioritySchema,
  estimatedTokens: z.number().int().nonnegative(),
  policy: z.enum(['must_include', 'eligible', 'must_exclude']),
  projectionReason: z.string().nullable(),
  sourceRefs: z.array(sourceRefSchema),
  retrieval: retrievalTraceSchema,
  renderAs: z.enum(['direct', 'world_truth', 'character_belief', 'uncertainty', 'counterbelief', 'withheld_secret', 'excluded']),
};

const includedItemSchema = z.object({
  ...decisionBase,
  renderedText: z.string().min(1),
  reason: z.enum(['required', 'eligible']),
});

const excludedItemSchema = z.object({
  ...decisionBase,
  reason: z.enum(['projection_denied', 'missing_projection', 'duplicate', 'bucket_budget', 'total_budget', 'required_budget_overflow', 'assembly_blocked']),
});

export const dryRunPromptReceiptSchema = z.object({
  format: z.literal('dry-run-prompt-receipt'),
  version: z.literal('1.0'),
  receiptId: z.string().regex(/^[a-f0-9]{64}$/),
  assemblyId: z.string().min(1),
  policyVersion: z.literal('dry-run-context-assembler.v1'),
  status: z.enum(['assembled', 'blocked_required_budget']),
  projection: z.object({
    requestId: z.string().min(1),
    policyVersion: z.literal('point-in-time-context.v1'),
    sourceRevisionId: z.string().min(1),
    sceneId: z.string().min(1),
    targetCharacterId: z.string().min(1),
    anchorOrdinal: z.number().int().positive(),
    knownThroughOrdinal: z.number().int().nonnegative(),
  }),
  budget: z.object({
    totalTokens: z.number().int().positive(),
    buckets: z.record(contextBucketSchema, z.object({ limit: z.number().int().nonnegative(), used: z.number().int().nonnegative() })),
    estimatedInputTokens: z.number().int().nonnegative(),
    actualInputTokens: z.null(),
  }),
  included: z.array(includedItemSchema),
  excluded: z.array(excludedItemSchema),
  finalPromptPreview: z.string().nullable(),
  modelCalls: z.literal(0),
});

export type ContextAssemblyItem = z.infer<typeof contextAssemblyItemSchema>;
export type DryRunAssemblyInput = z.infer<typeof dryRunAssemblyInputSchema>;
export type DryRunPromptReceipt = z.infer<typeof dryRunPromptReceiptSchema>;
type IncludedItem = z.infer<typeof includedItemSchema>;
type ExcludedItem = z.infer<typeof excludedItemSchema>;

const bucketOrder = ['characterCore', 'sceneSnapshot', 'activatedLore', 'retrievedMemory', 'conversationMemory'] as const;
const bucketLabels: Record<(typeof bucketOrder)[number], string> = {
  characterCore: '角色核心',
  sceneSnapshot: '当前场景',
  activatedLore: '激活设定',
  retrievedMemory: '检索记忆',
  conversationMemory: '对话记忆',
};
const priorityRank = { critical: 0, high: 1, normal: 2, low: 3 } as const;
const bucketRank = Object.fromEntries(bucketOrder.map((bucket, index) => [bucket, index])) as Record<(typeof bucketOrder)[number], number>;

export function estimateDryRunTokens(text: string): number {
  const compact = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (!compact) return 0;
  const cjk = compact.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const other = compact.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\s]/gu, '').length;
  return Math.max(1, cjk + Math.ceil(other / 4));
}

function renderClaim(text: string, renderAs: 'world_truth' | 'character_belief' | 'uncertainty' | 'counterbelief' | 'withheld_secret') {
  const prefix = {
    world_truth: '[角色已知]',
    character_belief: '[角色信念，不代表世界真相]',
    uncertainty: '[角色存疑]',
    counterbelief: '[角色不相信]',
    withheld_secret: '[角色知道，但不得主动透露]',
  }[renderAs];
  return `${prefix} ${text.trim()}`;
}

function renderDirect(item: z.infer<typeof directContextItemSchema>) {
  const prefix = { character_core: '[角色核心]', scene_state: '[当前场景]', conversation_memory: '[对话记忆]' }[item.directReason];
  return `${prefix} ${item.text.trim()}`;
}

type Candidate = {
  item: ContextAssemblyItem;
  policy: 'must_include' | 'eligible';
  projectionReason: string | null;
  renderAs: IncludedItem['renderAs'];
  renderedText: string;
  estimatedTokens: number;
};

function sortCandidates(left: Candidate, right: Candidate) {
  const policy = (left.policy === 'must_include' ? 0 : 1) - (right.policy === 'must_include' ? 0 : 1);
  if (policy) return policy;
  const bucket = bucketRank[left.item.bucket] - bucketRank[right.item.bucket];
  if (bucket) return bucket;
  const priority = priorityRank[left.item.priority] - priorityRank[right.item.priority];
  if (priority) return priority;
  const score = (right.item.retrieval?.score ?? -Infinity) - (left.item.retrieval?.score ?? -Infinity);
  if (score) return score;
  return left.item.id.localeCompare(right.item.id);
}

function excluded(item: ContextAssemblyItem, reason: ExcludedItem['reason'], projectionReason: string | null, estimatedTokens = 0): ExcludedItem {
  return {
    itemId: item.id,
    kind: item.kind,
    claimId: item.kind === 'claim' ? item.claimId : null,
    bucket: item.bucket,
    priority: item.priority,
    estimatedTokens,
    policy: 'must_exclude',
    projectionReason,
    sourceRefs: item.sourceRefs,
    retrieval: item.retrieval,
    renderAs: 'excluded',
    reason,
  };
}

function receiptPayload(input: DryRunAssemblyInput, status: DryRunPromptReceipt['status'], includedItems: IncludedItem[], excludedItems: ExcludedItem[], preview: string | null) {
  const used = Object.fromEntries(bucketOrder.map((bucket) => [bucket, includedItems.filter((item) => item.bucket === bucket).reduce((sum, item) => sum + item.estimatedTokens, 0)])) as Record<(typeof bucketOrder)[number], number>;
  return {
    format: 'dry-run-prompt-receipt' as const,
    version: '1.0' as const,
    assemblyId: input.id,
    policyVersion: input.policyVersion,
    status,
    projection: {
      requestId: input.projectionReceipt.requestId,
      policyVersion: input.projectionReceipt.policyVersion,
      sourceRevisionId: input.projectionReceipt.sourceRevisionId,
      sceneId: input.projectionReceipt.sceneId,
      targetCharacterId: input.projectionReceipt.targetCharacterId,
      anchorOrdinal: input.projectionReceipt.anchorOrdinal,
      knownThroughOrdinal: input.projectionReceipt.knownThroughOrdinal,
    },
    budget: {
      totalTokens: input.budget.totalTokens,
      buckets: Object.fromEntries(bucketOrder.map((bucket) => [bucket, { limit: input.budget.buckets[bucket], used: used[bucket] }])),
      estimatedInputTokens: includedItems.reduce((sum, item) => sum + item.estimatedTokens, 0),
      actualInputTokens: null,
    },
    included: includedItems,
    excluded: excludedItems.sort((left, right) => left.itemId.localeCompare(right.itemId)),
    finalPromptPreview: preview,
    modelCalls: 0 as const,
  };
}

export function assembleDryRunContext(rawInput: unknown): DryRunPromptReceipt {
  const input = dryRunAssemblyInputSchema.parse(rawInput);
  const projections = new Map(input.projectionReceipt.projections.map((projection) => [projection.claimId, projection]));
  const candidates: Candidate[] = [];
  const excludedItems: ExcludedItem[] = [];
  for (const item of input.items) {
    if (item.kind === 'direct') {
      const renderedText = renderDirect(item);
      candidates.push({ item, policy: item.directPolicy, projectionReason: item.directReason, renderAs: 'direct', renderedText, estimatedTokens: estimateDryRunTokens(renderedText) });
      continue;
    }
    const projection = projections.get(item.claimId);
    if (!projection) {
      excludedItems.push(excluded(item, 'missing_projection', null));
      continue;
    }
    if (projection.runtime.policy === 'must_exclude' || projection.runtime.renderAs === 'excluded') {
      excludedItems.push(excluded(item, 'projection_denied', projection.runtime.reason));
      continue;
    }
    const renderedText = renderClaim(item.text, projection.runtime.renderAs);
    candidates.push({
      item,
      policy: projection.runtime.policy,
      projectionReason: projection.runtime.reason,
      renderAs: projection.runtime.renderAs,
      renderedText,
      estimatedTokens: estimateDryRunTokens(renderedText),
    });
  }
  const ordered = candidates.sort(sortCandidates);
  const deduped: Candidate[] = [];
  const seenDedupeKeys = new Set<string>();
  for (const candidate of ordered) {
    if (seenDedupeKeys.has(candidate.item.dedupeKey)) {
      excludedItems.push(excluded(candidate.item, 'duplicate', candidate.projectionReason, candidate.estimatedTokens));
    } else {
      seenDedupeKeys.add(candidate.item.dedupeKey);
      deduped.push(candidate);
    }
  }
  const required = deduped.filter((candidate) => candidate.policy === 'must_include');
  const requiredTotal = required.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0);
  const requiredByBucket = Object.fromEntries(bucketOrder.map((bucket) => [bucket, required.filter((candidate) => candidate.item.bucket === bucket).reduce((sum, candidate) => sum + candidate.estimatedTokens, 0)])) as Record<(typeof bucketOrder)[number], number>;
  const requiredOverflow = requiredTotal > input.budget.totalTokens || bucketOrder.some((bucket) => requiredByBucket[bucket] > input.budget.buckets[bucket]);
  if (requiredOverflow) {
    for (const candidate of deduped) excludedItems.push(excluded(candidate.item, candidate.policy === 'must_include' ? 'required_budget_overflow' : 'assembly_blocked', candidate.projectionReason, candidate.estimatedTokens));
    const payload = receiptPayload(input, 'blocked_required_budget', [], excludedItems, null);
    return dryRunPromptReceiptSchema.parse({ receiptId: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), ...payload });
  }
  const includedItems: IncludedItem[] = [];
  const usedByBucket = Object.fromEntries(bucketOrder.map((bucket) => [bucket, 0])) as Record<(typeof bucketOrder)[number], number>;
  let usedTotal = 0;
  for (const candidate of deduped) {
    if (usedByBucket[candidate.item.bucket] + candidate.estimatedTokens > input.budget.buckets[candidate.item.bucket]) {
      excludedItems.push(excluded(candidate.item, 'bucket_budget', candidate.projectionReason, candidate.estimatedTokens));
      continue;
    }
    if (usedTotal + candidate.estimatedTokens > input.budget.totalTokens) {
      excludedItems.push(excluded(candidate.item, 'total_budget', candidate.projectionReason, candidate.estimatedTokens));
      continue;
    }
    includedItems.push({
      itemId: candidate.item.id,
      kind: candidate.item.kind,
      claimId: candidate.item.kind === 'claim' ? candidate.item.claimId : null,
      bucket: candidate.item.bucket,
      priority: candidate.item.priority,
      estimatedTokens: candidate.estimatedTokens,
      policy: candidate.policy,
      projectionReason: candidate.projectionReason,
      sourceRefs: candidate.item.sourceRefs,
      retrieval: candidate.item.retrieval,
      renderAs: candidate.renderAs,
      renderedText: candidate.renderedText,
      reason: candidate.policy === 'must_include' ? 'required' : 'eligible',
    });
    usedByBucket[candidate.item.bucket] += candidate.estimatedTokens;
    usedTotal += candidate.estimatedTokens;
  }
  const preview = bucketOrder.flatMap((bucket) => {
    const items = includedItems.filter((item) => item.bucket === bucket);
    return items.length ? [`## ${bucketLabels[bucket]}`, ...items.map((item) => `- ${item.renderedText}`)] : [];
  }).join('\n');
  const payload = receiptPayload(input, 'assembled', includedItems, excludedItems, preview);
  return dryRunPromptReceiptSchema.parse({ receiptId: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), ...payload });
}
