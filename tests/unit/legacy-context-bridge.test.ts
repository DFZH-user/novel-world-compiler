import { describe, expect, it } from 'vitest';
import { bridgeLegacyPublicFacts } from '../../src/shared/legacy-context-bridge';

const evidence = (ordinal: number) => ({
  sourceRevisionId: 'rev-1', paragraphId: `p-${ordinal}`, ordinal, exactQuote: `第 ${ordinal} 段证据`,
});

describe('legacy public fact bridge', () => {
  it('creates candidate claims but never manufactures character knowledge', () => {
    const result = bridgeLegacyPublicFacts([{
      id: 'fact-1', identityId: 'character-1', category: 'identity', predicate: '身份', value: '使者',
      visibility: 'public', confidence: 0.9, evidenceCount: 1, evidence: [evidence(10)], validFromOrdinal: 5, validToOrdinalExclusive: null,
    }]);
    expect(result.claims[0]).toMatchObject({ id: 'legacy:fact-1', truthStatus: 'true', validDuring: { fromOrdinal: 5 } });
    expect(result.characterBeliefs).toEqual([]);
    expect(result.readerDisclosures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('keeps unknown validity unresolved instead of confusing reveal time with world time', () => {
    const result = bridgeLegacyPublicFacts([{
      id: 'fact-1', identityId: 'character-1', category: 'state', predicate: '立场', value: '支持联盟',
      visibility: 'public', confidence: 0.8, evidenceCount: 2, evidence: [evidence(20)], validFromOrdinal: null, validToOrdinalExclusive: null,
    }]);
    expect(result.claims[0]).toMatchObject({ truthStatus: 'unresolved', validDuring: { fromOrdinal: 20 } });
    expect(result.warnings.map((warning) => warning.code)).toEqual(['evidence-count-mismatch', 'unknown-world-validity']);
  });

  it('refuses duplicate IDs and skips facts without supplied evidence', () => {
    const empty = { id: 'fact-1', identityId: 'character-1', category: 'state', predicate: '状态', value: '未知', visibility: 'public', confidence: 0.5, evidenceCount: 1, evidence: [], validFromOrdinal: null, validToOrdinalExclusive: null } as const;
    expect(bridgeLegacyPublicFacts([empty])).toMatchObject({ claims: [], warnings: [{ code: 'missing-evidence' }] });
    expect(() => bridgeLegacyPublicFacts([empty, empty])).toThrow('旧公开事实 ID 不能重复');
  });
});
