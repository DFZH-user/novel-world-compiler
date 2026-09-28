import { describe, expect, it } from 'vitest';
import { assembleDryRunContext, estimateDryRunTokens, type ContextAssemblyItem } from '../../src/shared/dry-run-context-assembler';
import { projectPointInTimeKnowledge, type CharacterBelief, type WorldClaim } from '../../src/shared/point-in-time-context';

const revisionId = 'rev-1';
const evidence = (ordinal: number) => ({ sourceRevisionId: revisionId, paragraphId: `p-${ordinal}`, ordinal, exactQuote: `第${ordinal}段证据` });
const claims: WorldClaim[] = [
  { id: 'known', proposition: '已知事实', subject: '甲', predicate: '状态', object: '已知', truthStatus: 'true', validDuring: { fromOrdinal: 1, toOrdinalExclusive: null }, evidence: [evidence(1)] },
  { id: 'belief', proposition: '错误信念', subject: '乙', predicate: '状态', object: '错误', truthStatus: 'false', validDuring: { fromOrdinal: 1, toOrdinalExclusive: null }, evidence: [evidence(8)] },
  { id: 'future', proposition: '未来信息', subject: '甲', predicate: '未来', object: '未知', truthStatus: 'true', validDuring: { fromOrdinal: 20, toOrdinalExclusive: null }, evidence: [evidence(20)] },
  { id: 'secret', proposition: '保密信息', subject: '甲', predicate: '秘密', object: '内容', truthStatus: 'true', validDuring: { fromOrdinal: 1, toOrdinalExclusive: null }, evidence: [evidence(2)] },
];
const beliefs: CharacterBelief[] = [
  { id: 'b-known', claimId: 'known', subjectId: '甲', state: 'known', acquiredAtOrdinal: 2, effectiveDuring: { fromOrdinal: 2, toOrdinalExclusive: null }, mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(2)] },
  { id: 'b-belief', claimId: 'belief', subjectId: '甲', state: 'believed', acquiredAtOrdinal: 8, effectiveDuring: { fromOrdinal: 8, toOrdinalExclusive: null }, mayDisclose: 'yes', acquiredFrom: 'inference', evidence: [evidence(8)] },
  { id: 'b-future', claimId: 'future', subjectId: '甲', state: 'known', acquiredAtOrdinal: 20, effectiveDuring: { fromOrdinal: 20, toOrdinalExclusive: null }, mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [evidence(20)] },
  { id: 'b-secret', claimId: 'secret', subjectId: '甲', state: 'known', acquiredAtOrdinal: 2, effectiveDuring: { fromOrdinal: 2, toOrdinalExclusive: null }, mayDisclose: 'no', acquiredFrom: 'conversation', evidence: [evidence(2)] },
];

function projection() {
  return projectPointInTimeKnowledge({
    request: {
      id: 'projection-request', policyVersion: 'point-in-time-context.v1',
      snapshot: {
        id: 'scene-1', sourceRevisionId: revisionId, boundary: { startOrdinal: 1, endOrdinalInclusive: 30 },
        entry: { anchorParagraphId: 'p-10', anchorOrdinal: 10, semantics: 'before_anchor_paragraph', knownThroughOrdinal: 9 },
        primaryCharacterId: '甲', presentCharacterIds: ['甲'], locationIds: [], priorEventIds: [], objectives: [], conflicts: [],
        prohibitedFuture: { fromOrdinal: 10, reason: '未来禁止' },
      },
      targetCharacterId: '甲', requiredClaimIds: ['known', 'secret'], candidateClaimIds: claims.map((claim) => claim.id),
      budget: { totalTokens: 100, buckets: { characterCore: 20, sceneSnapshot: 20, activatedLore: 20, retrievedMemory: 20, conversationMemory: 20 } },
    },
    claims, readerDisclosures: [], characterBeliefs: beliefs,
  });
}

const items = (): ContextAssemblyItem[] => [
  { id: 'core', kind: 'direct' as const, bucket: 'characterCore' as const, priority: 'critical' as const, dedupeKey: 'core', text: '甲是谨慎的人。', sourceRefs: [], retrieval: null, directPolicy: 'must_include' as const, directReason: 'character_core' as const },
  { id: 'known', kind: 'claim' as const, claimId: 'known', bucket: 'activatedLore' as const, priority: 'high' as const, dedupeKey: 'known', text: '已知事实成立。', sourceRefs: [{ paragraphId: 'p-2', ordinal: 2 }], retrieval: { method: 'keyword' as const, score: 0.9, trigger: '已知', path: [] } },
  { id: 'belief', kind: 'claim' as const, claimId: 'belief', bucket: 'retrievedMemory' as const, priority: 'normal' as const, dedupeKey: 'belief', text: '乙已经离开。', sourceRefs: [{ paragraphId: 'p-8', ordinal: 8 }], retrieval: { method: 'hybrid' as const, score: 0.8, trigger: null, path: [] } },
  { id: 'future', kind: 'claim' as const, claimId: 'future', bucket: 'retrievedMemory' as const, priority: 'high' as const, dedupeKey: 'future', text: '未来发生某事。', sourceRefs: [{ paragraphId: 'p-20', ordinal: 20 }], retrieval: { method: 'vector' as const, score: 0.99, trigger: null, path: [] } },
  { id: 'secret', kind: 'claim' as const, claimId: 'secret', bucket: 'sceneSnapshot' as const, priority: 'critical' as const, dedupeKey: 'secret', text: '甲掌握一项秘密。', sourceRefs: [{ paragraphId: 'p-2', ordinal: 2 }], retrieval: null },
];

function input(customItems = items(), totalTokens = 100, bucketLimit = 20) {
  return {
    id: 'assembly-1', policyVersion: 'dry-run-context-assembler.v1', projectionReceipt: projection(),
    budget: { totalTokens, buckets: { characterCore: bucketLimit, sceneSnapshot: bucketLimit, activatedLore: bucketLimit, retrievedMemory: bucketLimit, conversationMemory: bucketLimit } },
    items: customItems,
  };
}

describe('dry-run context assembler', () => {
  it('uses deterministic CJK-aware estimates', () => {
    expect(estimateDryRunTokens('你好 world')).toBe(4);
    expect(estimateDryRunTokens('')).toBe(0);
  });

  it('renders beliefs and withheld secrets without converting them to world truth', () => {
    const receipt = assembleDryRunContext(input());
    expect(receipt.status).toBe('assembled');
    expect(receipt.included.find((item) => item.itemId === 'belief')).toMatchObject({ renderAs: 'character_belief' });
    expect(receipt.included.find((item) => item.itemId === 'belief')?.renderedText).toContain('不代表世界真相');
    expect(receipt.included.find((item) => item.itemId === 'secret')).toMatchObject({ renderAs: 'withheld_secret' });
    expect(receipt.finalPromptPreview).toContain('不得主动透露');
  });

  it('excludes future knowledge even when retrieval gives it the highest score', () => {
    const receipt = assembleDryRunContext(input());
    expect(receipt.excluded.find((item) => item.itemId === 'future')).toMatchObject({ reason: 'projection_denied', projectionReason: 'future_knowledge' });
    expect(receipt.finalPromptPreview).not.toContain('未来发生某事');
    expect(receipt.modelCalls).toBe(0);
    expect(receipt.budget.actualInputTokens).toBeNull();
  });

  it('deduplicates before budgeting and records the discarded item', () => {
    const duplicate = { ...items()[1], id: 'known-copy', priority: 'low' as const };
    const receipt = assembleDryRunContext(input([...items(), duplicate]));
    expect(receipt.included.filter((item) => item.claimId === 'known')).toHaveLength(1);
    expect(receipt.excluded.find((item) => item.itemId === 'known-copy')).toMatchObject({ reason: 'duplicate' });
  });

  it('blocks the entire preview instead of silently dropping required content', () => {
    const receipt = assembleDryRunContext(input(items(), 20, 4));
    expect(receipt.status).toBe('blocked_required_budget');
    expect(receipt.included).toEqual([]);
    expect(receipt.finalPromptPreview).toBeNull();
    expect(receipt.excluded.some((item) => item.reason === 'required_budget_overflow')).toBe(true);
  });

  it('is deterministic across input order and rejects duplicate item IDs', () => {
    const forward = assembleDryRunContext(input(items()));
    const reversed = assembleDryRunContext(input([...items()].reverse()));
    expect(reversed).toEqual(forward);
    expect(() => assembleDryRunContext(input([items()[0], items()[0]]))).toThrow('上下文条目 ID 不能重复');
  });
});
