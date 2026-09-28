import type { CharacterFactRecord } from '../../src/shared/contracts';
import type { SQLiteDatabase } from './sqlite-db';

export const CHARACTER_KNOWLEDGE_POLICY = 'public-entry.v1';

export type ProjectedFact = {
  id: string;
  identityId: string;
  category: CharacterFactRecord['category'];
  predicate: string;
  value: string;
  visibility: 'public';
  confidence: number;
  evidenceCount: number;
};

export type ProjectedQuote = { id: string; text: string; ordinal: number; startOffset: number };

/** Conservative export policy, NOT a claim that every character knows all public facts.
 * Narrative disclosure is inclusive at paragraph granularity. Story chronology is
 * resolved separately by StoryStateService; valid_from_ordinal cannot disclose a flashback.
 * Private/secret facts require a future explicit knowledge-grant model.
 */
export class StoryKnowledgeProjection {
  readonly entry: { id: string; title: string; narrativeOrdinal: number };

  constructor(private readonly db: SQLiteDatabase, readonly revisionId: string, entryEventId: string) {
    const entry = db.prepare(`SELECT id, title, narrative_start_ordinal AS narrativeOrdinal
      FROM timeline_events WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`)
      .get(entryEventId, revisionId) as typeof this.entry | undefined;
    if (!entry) throw new Error('请先确认进入事件');
    this.entry = entry;
  }

  facts(identityId?: string): ProjectedFact[] {
    return this.db.prepare(`SELECT f.id, f.identity_id AS identityId, f.category, f.predicate, f.value,
      f.visibility, f.confidence, COUNT(e.id) AS evidenceCount
      FROM character_facts f
      LEFT JOIN character_fact_claim_metadata m ON m.fact_id = f.id
      JOIN character_fact_evidence e ON e.fact_id = f.id AND e.evidence_role = 'support'
        AND e.alignment_status IN ('exact', 'normalized')
      JOIN paragraphs p ON p.id = e.paragraph_id AND p.revision_id = f.revision_id
      WHERE f.revision_id = ? AND f.review_status = 'confirmed' AND f.visibility = 'public'
        AND COALESCE(m.truth_status, 'asserted') = 'asserted' AND p.ordinal <= ?
        ${identityId ? 'AND f.identity_id = ?' : ''}
      GROUP BY f.id ORDER BY f.identity_id, f.category, f.predicate, f.id`)
      .all(this.revisionId, this.entry.narrativeOrdinal, ...(identityId ? [identityId] : [])) as ProjectedFact[];
  }

  quotes(identityId: string): ProjectedQuote[] {
    return this.db.prepare(`SELECT DISTINCT q.id, q.quote_text AS text, p.ordinal, q.start_offset AS startOffset
      FROM character_quote_attributions a
      JOIN character_quotes q ON q.id = a.quote_id
      JOIN paragraphs p ON p.id = q.paragraph_id AND p.revision_id = q.revision_id
      JOIN paragraphs evidence ON evidence.id = a.evidence_paragraph_id AND evidence.revision_id = q.revision_id
      WHERE q.revision_id = ? AND a.identity_id = ? AND a.role = 'speaker' AND a.review_status = 'confirmed'
        AND p.ordinal <= ? AND evidence.ordinal <= ?
      ORDER BY p.ordinal, q.start_offset, q.id`)
      .all(this.revisionId, identityId, this.entry.narrativeOrdinal, this.entry.narrativeOrdinal) as ProjectedQuote[];
  }

  eventIds(): Set<string> {
    return new Set((this.db.prepare(`SELECT id FROM timeline_events
      WHERE revision_id = ? AND review_status = 'confirmed' AND narrative_start_ordinal <= ?`)
      .all(this.revisionId, this.entry.narrativeOrdinal) as Array<{ id: string }>).map((row) => row.id));
  }

  transitionIds(facts: ProjectedFact[]): Set<string> {
    // A transition must not reintroduce hidden values through alternatives or graph paths.
    const ids = JSON.stringify(facts.map((fact) => fact.id));
    return new Set((this.db.prepare(`SELECT t.id FROM character_state_transitions t
      JOIN paragraphs p ON p.id = t.trigger_paragraph_id AND p.revision_id = t.revision_id
      WHERE t.revision_id = ? AND p.ordinal <= ?
        AND EXISTS (SELECT 1 FROM character_fact_cluster_members cm
          JOIN character_facts f ON f.id = cm.fact_id
          WHERE cm.cluster_id = t.from_cluster_id AND f.value = t.from_value
            AND f.id IN (SELECT value FROM json_each(?)))
        AND EXISTS (SELECT 1 FROM character_fact_cluster_members cm
          JOIN character_facts f ON f.id = cm.fact_id
          WHERE cm.cluster_id = t.to_cluster_id AND f.value = t.to_value
            AND f.id IN (SELECT value FROM json_each(?)))`)
      .all(this.revisionId, this.entry.narrativeOrdinal, ids, ids) as Array<{ id: string }>).map((row) => row.id));
  }

  maskedTransitionProperties(allowedIds: Set<string>): Array<Pick<ProjectedFact, 'identityId' | 'category' | 'predicate'>> {
    // A disclosed but withheld state change must not turn an obsolete public value
    // into a timeless current fact. Return property keys only, never hidden values.
    return this.db.prepare(`SELECT t.identity_id AS identityId, t.category, t.predicate
      FROM character_state_transitions t
      JOIN character_fact_relations r ON r.id = t.relation_id
      JOIN paragraphs p ON p.id = t.trigger_paragraph_id AND p.revision_id = t.revision_id
      WHERE t.revision_id = ? AND p.ordinal <= ?
        AND r.review_status = 'confirmed' AND r.resolved_relation = 'state_change'
        AND t.id NOT IN (SELECT value FROM json_each(?))`)
      .all(this.revisionId, this.entry.narrativeOrdinal, JSON.stringify([...allowedIds])) as Array<Pick<ProjectedFact, 'identityId' | 'category' | 'predicate'>>;
  }
}
