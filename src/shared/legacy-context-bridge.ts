import { z } from 'zod';
import { pointInTimeEvidenceSchema, worldClaimSchema, type WorldClaim } from './point-in-time-context';

export const legacyPublicFactSchema = z.object({
  id: z.string().min(1),
  identityId: z.string().min(1),
  category: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  visibility: z.literal('public'),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().positive(),
  evidence: z.array(pointInTimeEvidenceSchema),
  validFromOrdinal: z.number().int().positive().nullable(),
  validToOrdinalExclusive: z.number().int().positive().nullable(),
});

export type LegacyPublicFact = z.infer<typeof legacyPublicFactSchema>;

export type LegacyBridgeWarning = {
  factId: string;
  code: 'missing-evidence' | 'unknown-world-validity' | 'evidence-count-mismatch';
  message: string;
};

export type LegacyBridgeResult = {
  policy: 'legacy-public-fact-bridge.v1';
  claims: WorldClaim[];
  characterBeliefs: [];
  readerDisclosures: [];
  warnings: LegacyBridgeWarning[];
};

/**
 * Converts the current conservative public projection into candidate world claims.
 * It intentionally creates no reader disclosure and no character belief grants.
 */
export function bridgeLegacyPublicFacts(input: unknown[]): LegacyBridgeResult {
  const facts = z.array(legacyPublicFactSchema).parse(input);
  if (new Set(facts.map((fact) => fact.id)).size !== facts.length) throw new Error('旧公开事实 ID 不能重复');
  const warnings: LegacyBridgeWarning[] = [];
  const claims: WorldClaim[] = [];
  for (const fact of [...facts].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!fact.evidence.length) {
      warnings.push({ factId: fact.id, code: 'missing-evidence', message: '缺少逐字证据，不能提升为候选世界命题' });
      continue;
    }
    if (fact.evidence.length !== fact.evidenceCount) {
      warnings.push({ factId: fact.id, code: 'evidence-count-mismatch', message: '投影证据计数与实际提供的证据不一致' });
    }
    const validityKnown = fact.validFromOrdinal !== null;
    if (!validityKnown) warnings.push({
      factId: fact.id,
      code: 'unknown-world-validity',
      message: '现有公开投影没有明确世界有效起点；以最早证据位置建立待核候选，不声称已经确认实际生效时间',
    });
    const fallbackFrom = Math.min(...fact.evidence.map((evidence) => evidence.ordinal));
    const fromOrdinal = fact.validFromOrdinal ?? fallbackFrom;
    const toOrdinalExclusive = fact.validToOrdinalExclusive;
    if (toOrdinalExclusive !== null && toOrdinalExclusive <= fromOrdinal) throw new Error(`${fact.id}: 世界有效区间非法`);
    claims.push(worldClaimSchema.parse({
      id: `legacy:${fact.id}`,
      proposition: `${fact.predicate}：${fact.value}`,
      subject: fact.identityId,
      predicate: fact.predicate,
      object: fact.value,
      truthStatus: validityKnown ? 'true' : 'unresolved',
      validDuring: { fromOrdinal, toOrdinalExclusive },
      evidence: fact.evidence,
    }));
  }
  return {
    policy: 'legacy-public-fact-bridge.v1',
    claims,
    characterBeliefs: [],
    readerDisclosures: [],
    warnings,
  };
}
