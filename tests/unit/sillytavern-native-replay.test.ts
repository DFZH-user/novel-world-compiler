import { describe, expect, it } from 'vitest';
import { buildSillyTavernReplayFixture, compareSillyTavernReplay, extractSillyTavernReplayItems } from '../../scripts/lib/sillytavern-native-replay';
import { assembleDryRunContext } from '../../src/shared/dry-run-context-assembler';
import { projectPointInTimeKnowledge } from '../../src/shared/point-in-time-context';

function receipt() {
  const projection = projectPointInTimeKnowledge({
    request: {
      id: 'request', policyVersion: 'point-in-time-context.v1', targetCharacterId: '王扬',
      snapshot: {
        id: 'scene', sourceRevisionId: 'rev', boundary: { startOrdinal: 1, endOrdinalInclusive: 9 },
        entry: { anchorParagraphId: 'p5', anchorOrdinal: 5, semantics: 'before_anchor_paragraph', knownThroughOrdinal: 4 },
        primaryCharacterId: '王扬', presentCharacterIds: ['王扬'], locationIds: [], priorEventIds: [], objectives: [], conflicts: [],
        prohibitedFuture: { fromOrdinal: 5, reason: 'future' },
      },
      requiredClaimIds: ['known'], candidateClaimIds: ['known', 'future'],
      budget: { totalTokens: 100, buckets: { characterCore: 20, sceneSnapshot: 20, activatedLore: 20, retrievedMemory: 40, conversationMemory: 0 } },
    },
    claims: [
      { id: 'known', proposition: '已知', subject: '绳', predicate: '状态', object: '不断', truthStatus: 'true', validDuring: { fromOrdinal: 1, toOrdinalExclusive: null }, evidence: [{ sourceRevisionId: 'rev', paragraphId: 'p2', ordinal: 2, exactQuote: '已知' }] },
      { id: 'future', proposition: '未来', subject: '人', predicate: '身份', object: '未知', truthStatus: 'true', validDuring: { fromOrdinal: 1, toOrdinalExclusive: null }, evidence: [{ sourceRevisionId: 'rev', paragraphId: 'p7', ordinal: 7, exactQuote: '未来' }] },
    ],
    readerDisclosures: [],
    characterBeliefs: [
      { id: 'b1', claimId: 'known', subjectId: '王扬', state: 'known', acquiredAtOrdinal: 2, effectiveDuring: { fromOrdinal: 2, toOrdinalExclusive: null }, mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [{ sourceRevisionId: 'rev', paragraphId: 'p2', ordinal: 2, exactQuote: '已知' }] },
      { id: 'b2', claimId: 'future', subjectId: '王扬', state: 'known', acquiredAtOrdinal: 7, effectiveDuring: { fromOrdinal: 7, toOrdinalExclusive: null }, mayDisclose: 'yes', acquiredFrom: 'observation', evidence: [{ sourceRevisionId: 'rev', paragraphId: 'p7', ordinal: 7, exactQuote: '未来' }] },
    ],
  });
  return assembleDryRunContext({
    id: 'assembly', policyVersion: 'dry-run-context-assembler.v1', projectionReceipt: projection,
    budget: { totalTokens: 100, buckets: { characterCore: 20, sceneSnapshot: 20, activatedLore: 20, retrievedMemory: 40, conversationMemory: 0 } },
    items: [
      { id: 'known-item', kind: 'claim', claimId: 'known', bucket: 'retrievedMemory', priority: 'critical', dedupeKey: 'known', text: '绳索没有断', sourceRefs: [{ paragraphId: 'p2', ordinal: 2 }], retrieval: { method: 'keyword', score: 1, trigger: '绳索', path: ['known'] } },
      { id: 'future-item', kind: 'claim', claimId: 'future', bucket: 'retrievedMemory', priority: 'low', dedupeKey: 'future', text: '未来身份', sourceRefs: [{ paragraphId: 'p7', ordinal: 7 }], retrieval: { method: 'keyword', score: 1, trigger: '身份', path: ['future'] } },
    ],
  });
}

describe('SillyTavern native replay fixture', () => {
  it('exports only Stage 2 included items as deterministic keyword entries', () => {
    const source = receipt();
    const fixture = buildSillyTavernReplayFixture(source, '校准绳索入口');
    expect(fixture.card.data.character_book?.entries).toHaveLength(1);
    expect(fixture.card.data.character_book?.entries[0]).toMatchObject({ keys: ['校准绳索入口'], enabled: true, constant: false, selective: false });
    expect(fixture.expectedContents[0]).toContain('[角色已知] 绳索没有断');
    expect(JSON.stringify(fixture.card)).not.toContain('未来身份');
  });

  it('reports missing, extra, reordered and forbidden native prompt content', () => {
    const fixture = buildSillyTavernReplayFixture(receipt(), '校准绳索入口');
    expect(extractSillyTavernReplayItems(fixture.expectedContents.join('\n'))).toHaveLength(1);
    expect(compareSillyTavernReplay(fixture, fixture.expectedContents.join('\n'), [{ claimId: 'future', text: '未来身份' }]))
      .toMatchObject({ passed: true, matchingEntryCount: 1, orderMatches: true, forbiddenHits: [] });
    expect(compareSillyTavernReplay(fixture, `${fixture.expectedContents.join('\n')}\n未来身份`, [{ claimId: 'future', text: '未来身份' }]))
      .toMatchObject({ passed: false, forbiddenHits: [{ claimId: 'future', text: '未来身份' }] });
  });
});
