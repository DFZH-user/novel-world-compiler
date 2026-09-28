import { describe, expect, it } from 'vitest';
import {
  contextAssemblyRequestSchema,
  projectPointInTimeKnowledge,
  sceneSnapshotSchema,
  type CharacterBelief,
  type ReaderDisclosure,
  type WorldClaim,
} from '../../src/shared/point-in-time-context';

const revisionId = 'rev-calibration';
const evidence = (ordinal: number, quote = `P${ordinal} 的证据`) => ({
  sourceRevisionId: revisionId,
  paragraphId: `p-${ordinal}`,
  ordinal,
  exactQuote: quote,
});

const claim = (overrides: Partial<WorldClaim> = {}): WorldClaim => ({
  id: 'claim-1', proposition: '测试命题', subject: '主体', predicate: '状态', object: '成立', truthStatus: 'true',
  validDuring: { fromOrdinal: 1, toOrdinalExclusive: null }, evidence: [evidence(1)], ...overrides,
});

const snapshot = (anchorOrdinal: number, primaryCharacterId = '王扬') => ({
  id: `scene-at-${anchorOrdinal}`,
  sourceRevisionId: revisionId,
  boundary: { startOrdinal: 1, endOrdinalInclusive: 30000 },
  entry: { anchorParagraphId: `p-${anchorOrdinal}`, anchorOrdinal, semantics: 'before_anchor_paragraph' as const, knownThroughOrdinal: anchorOrdinal - 1 },
  primaryCharacterId,
  presentCharacterIds: [primaryCharacterId],
  locationIds: [], priorEventIds: [], objectives: [], conflicts: [],
  prohibitedFuture: { fromOrdinal: anchorOrdinal, reason: '入口及其后属于未来' },
});

const request = (anchorOrdinal: number, candidateClaimIds = ['claim-1'], requiredClaimIds = ['claim-1'], primaryCharacterId = '王扬') => ({
  id: `request-at-${anchorOrdinal}`,
  policyVersion: 'point-in-time-context.v1' as const,
  snapshot: snapshot(anchorOrdinal, primaryCharacterId),
  targetCharacterId: primaryCharacterId,
  requiredClaimIds,
  candidateClaimIds,
  budget: { totalTokens: 1000, buckets: { characterCore: 100, sceneSnapshot: 200, activatedLore: 200, retrievedMemory: 300, conversationMemory: 200 } },
});

const belief = (overrides: Partial<CharacterBelief> = {}): CharacterBelief => ({
  id: 'belief-1', claimId: 'claim-1', subjectId: '王扬', state: 'known', acquiredAtOrdinal: 2,
  effectiveDuring: { fromOrdinal: 2, toOrdinalExclusive: null }, mayDisclose: 'yes', acquiredFrom: 'observation',
  evidence: [evidence(2)], ...overrides,
});

function project(options: {
  anchorOrdinal: number;
  claims?: WorldClaim[];
  disclosures?: ReaderDisclosure[];
  beliefs?: CharacterBelief[];
  candidateClaimIds?: string[];
  requiredClaimIds?: string[];
  primaryCharacterId?: string;
}) {
  return projectPointInTimeKnowledge({
    request: request(options.anchorOrdinal, options.candidateClaimIds, options.requiredClaimIds, options.primaryCharacterId),
    claims: options.claims ?? [claim()],
    readerDisclosures: options.disclosures ?? [],
    characterBeliefs: options.beliefs ?? [],
  });
}

describe('point-in-time context contracts', () => {
  it('keeps a false world claim separate from an attacker belief', () => {
    const falseClaim = claim({ id: 'wang-unconscious', proposition: '王扬已经昏迷', truthStatus: 'false', evidence: [evidence(25020)] });
    const attackerBelief = belief({
      id: 'attackers-believe-unconscious', claimId: falseClaim.id, subjectId: '埋伏者', state: 'believed', acquiredAtOrdinal: 25018,
      effectiveDuring: { fromOrdinal: 25018, toOrdinalExclusive: 25020 }, evidence: [evidence(25018)],
    });
    const receipt = project({ anchorOrdinal: 25020, claims: [falseClaim], beliefs: [attackerBelief], candidateClaimIds: [falseClaim.id], requiredClaimIds: [falseClaim.id], primaryCharacterId: '埋伏者' });
    expect(receipt.projections[0]).toMatchObject({
      world: { truthStatus: 'false', active: true },
      character: { epistemicState: 'believed' },
      runtime: { policy: 'must_include', renderAs: 'character_belief', reason: 'character_belief' },
    });
  });

  it('does not give a character information merely because the reader has seen it', () => {
    const mechanism = claim({ id: 'salt-mechanism', proposition: '盐晶体帮助绳索维持结构', evidence: [evidence(27445)] });
    const disclosures: ReaderDisclosure[] = [{
      id: 'reader-sees-mechanism', claimId: mechanism.id, state: 'disclosed', effectiveDuring: { fromOrdinal: 27445, toOrdinalExclusive: null }, evidence: [evidence(27445)],
    }];
    const receipt = project({ anchorOrdinal: 27447, claims: [mechanism], disclosures, beliefs: [], candidateClaimIds: [mechanism.id], requiredClaimIds: [], primaryCharacterId: '普通围观者' });
    expect(receipt.projections[0]).toMatchObject({
      readerDisclosure: 'disclosed', character: { epistemicState: 'unknown' },
      runtime: { policy: 'must_exclude', reason: 'unknown_to_character', renderAs: 'excluded' },
    });
  });

  it('can include a secret for behavior while forbidding the character from revealing it', () => {
    const secretBelief = belief({ mayDisclose: 'no', acquiredFrom: 'conversation' });
    const receipt = project({ anchorOrdinal: 10, beliefs: [secretBelief] });
    expect(receipt.projections[0].runtime).toEqual({
      policy: 'must_include', reason: 'known_but_must_not_disclose', renderAs: 'withheld_secret', responseDisclosure: 'forbidden',
    });
  });

  it('changes the same character belief across entry points without back-propagating future knowledge', () => {
    const identity = claim({ id: 'attacker-identity', proposition: '袭击者属于宜都蛮', truthStatus: 'unresolved', evidence: [evidence(25039)] });
    const laterBelief = belief({
      id: 'wang-infers-yidu', claimId: identity.id, state: 'believed', acquiredAtOrdinal: 25039,
      effectiveDuring: { fromOrdinal: 25039, toOrdinalExclusive: null }, acquiredFrom: 'inference', evidence: [evidence(25039)],
    });
    const early = project({ anchorOrdinal: 25009, claims: [identity], beliefs: [laterBelief], candidateClaimIds: [identity.id], requiredClaimIds: [] });
    const late = project({ anchorOrdinal: 25040, claims: [identity], beliefs: [laterBelief], candidateClaimIds: [identity.id], requiredClaimIds: [] });
    expect(early.projections[0].runtime).toMatchObject({ policy: 'must_exclude', reason: 'future_knowledge' });
    expect(late.projections[0].runtime).toMatchObject({ policy: 'eligible', reason: 'character_belief', renderAs: 'character_belief' });
  });

  it('selects the active belief interval and explains irrelevant exclusions', () => {
    const changingBeliefs: CharacterBelief[] = [
      belief({ id: 'belief-doubt', state: 'doubted', acquiredAtOrdinal: 5, effectiveDuring: { fromOrdinal: 5, toOrdinalExclusive: 15 }, evidence: [evidence(5)] }),
      belief({ id: 'belief-known', state: 'known', acquiredAtOrdinal: 15, effectiveDuring: { fromOrdinal: 15, toOrdinalExclusive: null }, evidence: [evidence(15)] }),
    ];
    expect(project({ anchorOrdinal: 10, beliefs: changingBeliefs }).projections[0].runtime.renderAs).toBe('uncertainty');
    expect(project({ anchorOrdinal: 20, beliefs: changingBeliefs }).projections[0].runtime.renderAs).toBe('world_truth');
    expect(project({ anchorOrdinal: 20, beliefs: changingBeliefs, candidateClaimIds: [], requiredClaimIds: [] }).projections[0].runtime)
      .toMatchObject({ policy: 'must_exclude', reason: 'irrelevant' });
  });

  it('rejects ambiguous entry semantics and invalid token budgets', () => {
    expect(() => sceneSnapshotSchema.parse({ ...snapshot(10), entry: { ...snapshot(10).entry, knownThroughOrdinal: 10 } })).toThrow();
    expect(() => contextAssemblyRequestSchema.parse({
      ...request(10), budget: { totalTokens: 10, buckets: { characterCore: 10, sceneSnapshot: 10, activatedLore: 0, retrievedMemory: 0, conversationMemory: 0 } },
    })).toThrow();
  });

  it('rejects backdated reader disclosure and keeps receipt order deterministic', () => {
    const invalidDisclosure = {
      id: 'late-reader-evidence', claimId: 'claim-1', state: 'disclosed',
      effectiveDuring: { fromOrdinal: 5, toOrdinalExclusive: null }, evidence: [evidence(6)],
    };
    expect(() => project({ anchorOrdinal: 10, disclosures: [invalidDisclosure as ReaderDisclosure], beliefs: [belief()] })).toThrow('读者公开状态不能由生效时点之后的证据建立');
    const second = claim({ id: 'claim-2', proposition: '第二命题' });
    const beliefs = [belief(), belief({ id: 'belief-2', claimId: 'claim-2' })];
    const firstOrder = project({ anchorOrdinal: 10, claims: [second, claim()], beliefs, candidateClaimIds: ['claim-1', 'claim-2'], requiredClaimIds: [] });
    const reverseOrder = project({ anchorOrdinal: 10, claims: [claim(), second], beliefs: [...beliefs].reverse(), candidateClaimIds: ['claim-1', 'claim-2'], requiredClaimIds: [] });
    expect(firstOrder).toEqual(reverseOrder);
    expect(firstOrder.projections.map((projection) => projection.claimId)).toEqual(['claim-1', 'claim-2']);
  });
});
