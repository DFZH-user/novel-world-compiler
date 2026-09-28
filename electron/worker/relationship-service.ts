import { createHash, randomUUID } from 'node:crypto';
import type {
  CharacterRelationshipAssertionInput,
  CharacterRelationshipCandidateInput,
  CharacterRelationshipCandidateEvidenceRecord,
  CharacterRelationshipCandidateRecord,
  CharacterRelationshipEvidenceInput,
  CharacterRelationshipEvidenceRecord,
  CharacterRelationshipRecord,
  CharacterRelationshipReviewStatus,
  RelationshipGraphEdge,
  RelationshipGraphNode,
  RelationshipGraphProjection,
  RelationshipModelSuggestionRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';
import { relationshipEventTimeline } from './relationship-event-timeline';

type ParagraphRow = { id: string; revisionId: string; ordinal: number; text: string };
type AlignedEvidence<T extends { paragraphId: string; exactQuote: string }> = {
  input: T;
  paragraph: ParagraphRow;
  alignmentStatus: 'exact' | 'normalized';
};

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]/gu, '').replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

function bounded(value: number | null | undefined, minimum: number, maximum: number, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label}必须在 ${minimum} 到 ${maximum} 之间`);
  return value;
}

export class RelationshipService {
  constructor(private readonly store: ProjectStore) {}

  createCandidate(input: CharacterRelationshipCandidateInput): CharacterRelationshipCandidateRecord {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    this.requireDistinctConfirmedPair(db, revisionId, input.sourceIdentityId, input.targetIdentityId);
    const confidence = bounded(input.confidence, 0, 1, '候选置信度')!;
    const aligned = this.alignEvidence(db, revisionId, input.evidence);
    if (aligned.length === 0) throw new Error('关系候选必须包含能够对齐原文的证据');
    const timestamp = now();
    const candidateId = randomUUID();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO character_relationship_candidates
        (id, revision_id, source_identity_id, target_identity_id, candidate_method, proposed_type, confidence, review_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(candidateId, revisionId, input.sourceIdentityId, input.targetIdentityId, input.method,
          input.proposedType?.trim() || null, confidence, timestamp, timestamp);
      for (const item of aligned) {
        const id = `rce_${hash(`${candidateId}:${item.paragraph.id}:${item.input.exactQuote}:${item.input.role}`).slice(0, 32)}`;
        db.prepare(`INSERT INTO character_relationship_candidate_evidence
          (id, candidate_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, candidateId, item.paragraph.id, item.input.exactQuote, item.input.role, item.alignmentStatus, timestamp);
      }
    });
    return this.getCandidate(db, revisionId, candidateId);
  }

  reviewCandidate(candidateId: string, status: CharacterRelationshipReviewStatus): CharacterRelationshipCandidateRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const result = db.prepare(`UPDATE character_relationship_candidates SET review_status = ?, updated_at = ?
      WHERE id = ? AND revision_id = ?`).run(status, now(), candidateId, revisionId);
    if (result.changes !== 1) throw new Error('关系候选不存在');
    return this.listCandidates();
  }

  listCandidates(status?: CharacterRelationshipReviewStatus): CharacterRelationshipCandidateRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`${this.candidateSelectSql()} WHERE c.revision_id = ? ${status ? 'AND c.review_status = ?' : ''}
      ORDER BY c.review_status = 'rejected', c.confidence DESC, c.created_at`)
      .all(...(status ? [revisionId, status] : [revisionId])) as unknown as CharacterRelationshipCandidateRecord[];
  }

  listCandidateEvidence(candidateId: string): CharacterRelationshipCandidateEvidenceRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT e.id, e.source_span_id AS sourceSpanId,
      e.candidate_id AS candidateId, e.paragraph_id AS paragraphId,
      p.ordinal AS paragraphOrdinal, ch.title AS chapterTitle, e.exact_quote AS exactQuote,
      e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM character_relationship_candidate_evidence e
      JOIN character_relationship_candidates c ON c.id = e.candidate_id
      JOIN paragraphs p ON p.id = e.paragraph_id LEFT JOIN chapters ch ON ch.id = p.chapter_id
      WHERE e.candidate_id = ? AND c.revision_id = ? ORDER BY p.ordinal, e.created_at`)
      .all(candidateId, revisionId) as unknown as CharacterRelationshipCandidateEvidenceRecord[];
  }

  getModelSuggestion(candidateId: string): RelationshipModelSuggestionRecord | null {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return (db.prepare(`SELECT s.candidate_id AS candidateId, s.direction, s.strength, s.polarity,
      s.information_source_type AS informationSourceType, s.information_source_identity_id AS informationSourceIdentityId,
      source.canonical_name AS informationSourceName, s.truth_status AS truthStatus,
      s.valid_from_event_id AS validFromEventId, from_event.title AS validFromEventTitle,
      s.valid_to_event_id AS validToEventId, to_event.title AS validToEventTitle,
      s.reasoning_note AS reasoningNote, s.uncertainty
      FROM relationship_model_suggestions s
      JOIN character_relationship_candidates c ON c.id = s.candidate_id
      LEFT JOIN person_identities source ON source.id = s.information_source_identity_id
      LEFT JOIN timeline_events from_event ON from_event.id = s.valid_from_event_id
      LEFT JOIN timeline_events to_event ON to_event.id = s.valid_to_event_id
      WHERE s.candidate_id = ? AND c.revision_id = ?`).get(candidateId, revisionId)
      ?? null) as RelationshipModelSuggestionRecord | null;
  }

  createRelationship(input: CharacterRelationshipAssertionInput): CharacterRelationshipRecord {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    this.requireDistinctConfirmedPair(db, revisionId, input.sourceIdentityId, input.targetIdentityId);
    const relationshipType = input.relationshipType.trim();
    if (!relationshipType) throw new Error('关系类型不能为空');
    const confidence = bounded(input.confidence, 0, 1, '关系置信度')!;
    const strength = bounded(input.strength, 0, 1, '关系强度');
    const polarity = bounded(input.polarity, -1, 1, '关系极性');
    const informationSourceId = input.informationSourceIdentityId ?? null;
    if (input.informationSourceType === 'character') {
      if (!informationSourceId) throw new Error('人物来源必须指定已确认人物');
      this.requireConfirmedIdentity(db, revisionId, informationSourceId);
    } else if (informationSourceId) {
      throw new Error('只有人物来源可以指定来源人物');
    }
    if (input.candidateId) this.requireConfirmedCandidate(db, revisionId, input.candidateId, input.sourceIdentityId, input.targetIdentityId);
    if (input.supersedesRelationshipId) {
      const previous = db.prepare(`SELECT source_identity_id AS sourceIdentityId, target_identity_id AS targetIdentityId
        FROM character_relationships WHERE id = ? AND revision_id = ?`).get(input.supersedesRelationshipId, revisionId) as
        { sourceIdentityId: string; targetIdentityId: string } | undefined;
      if (!previous || previous.sourceIdentityId !== input.sourceIdentityId || previous.targetIdentityId !== input.targetIdentityId) {
        throw new Error('被替代的关系必须属于同一人物方向对');
      }
    }
    const aligned = this.alignEvidence(db, revisionId, input.evidence);
    const supporting = aligned.filter((item) => item.input.role === 'support');
    if (supporting.length === 0) throw new Error('关系断言必须包含能够对齐原文的支持证据');
    const firstReveal = supporting.reduce((earliest, item) => item.paragraph.ordinal < earliest.ordinal ? item.paragraph : earliest, supporting[0].paragraph);
    const from = this.resolveTemporalBound(db, revisionId, input.validFromEventId, input.validFromTimeExpressionId, 'from');
    const to = this.resolveTemporalBound(db, revisionId, input.validToEventId, input.validToTimeExpressionId, 'to');
    if (from.ordinal !== null && to.ordinal !== null && from.ordinal > to.ordinal) throw new Error('关系有效期起点不能晚于终点');
    const timestamp = now();
    const relationshipId = randomUUID();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO character_relationships
        (id, revision_id, source_identity_id, target_identity_id, relationship_type, direction, strength, polarity,
         information_source_type, information_source_identity_id, truth_status, valid_from_event_id, valid_to_event_id,
         valid_from_time_expression_id, valid_to_time_expression_id, valid_from_ordinal, valid_to_ordinal,
         first_revealed_paragraph_id, first_revealed_ordinal, confidence, review_status, extraction_method,
         candidate_id, supersedes_relationship_id, reasoning_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
        .run(relationshipId, revisionId, input.sourceIdentityId, input.targetIdentityId, relationshipType, input.direction,
          strength, polarity, input.informationSourceType, informationSourceId, input.truthStatus,
          from.eventId, to.eventId, from.timeExpressionId, to.timeExpressionId, from.ordinal, to.ordinal,
          firstReveal.id, firstReveal.ordinal, confidence, input.extractionMethod, input.candidateId ?? null,
          input.supersedesRelationshipId ?? null, input.reasoningNote?.trim() ?? '', timestamp, timestamp);
      for (const item of aligned) {
        const id = `rle_${hash(`${relationshipId}:${item.paragraph.id}:${item.input.exactQuote}:${item.input.role}`).slice(0, 32)}`;
        db.prepare(`INSERT INTO character_relationship_evidence
          (id, relationship_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(id, relationshipId, item.paragraph.id, item.input.exactQuote, item.input.role, item.alignmentStatus, timestamp);
      }
    });
    return this.getRelationship(db, revisionId, relationshipId);
  }

  reviewRelationship(relationshipId: string, status: CharacterRelationshipReviewStatus): CharacterRelationshipRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const result = db.prepare(`UPDATE character_relationships SET review_status = ?, updated_at = ? WHERE id = ? AND revision_id = ?`)
      .run(status, now(), relationshipId, revisionId);
    if (result.changes !== 1) throw new Error('人物关系不存在');
    return this.listRelationships();
  }

  listRelationships(status?: CharacterRelationshipReviewStatus): CharacterRelationshipRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`${this.relationshipSelectSql()} WHERE r.revision_id = ? ${status ? 'AND r.review_status = ?' : ''}
      ORDER BY r.first_revealed_ordinal, r.created_at`)
      .all(...(status ? [revisionId, status] : [revisionId])) as unknown as CharacterRelationshipRecord[];
  }

  listAtEntry(entryOrdinal: number): CharacterRelationshipRecord[] {
    if (!Number.isInteger(entryOrdinal) || entryOrdinal < 0) throw new Error('进入位置必须是非负段落序号');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`${this.relationshipSelectSql()} WHERE r.revision_id = ? AND r.review_status = 'confirmed'
      AND r.first_revealed_ordinal <= ?
      AND (r.valid_from_ordinal IS NULL OR r.valid_from_ordinal <= ?)
      AND (r.valid_to_ordinal IS NULL OR r.valid_to_ordinal >= ?)
      ORDER BY r.first_revealed_ordinal, r.created_at`).all(revisionId, entryOrdinal, entryOrdinal, entryOrdinal) as unknown as CharacterRelationshipRecord[];
  }

  getGraphProjection(entryOrdinal: number): RelationshipGraphProjection {
    if (!Number.isInteger(entryOrdinal) || entryOrdinal < 0) throw new Error('进入位置必须是非负段落序号');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const maximumOrdinalRow = db.prepare(`SELECT COALESCE(MAX(ordinal), 0) AS maximumOrdinal
      FROM paragraphs WHERE revision_id = ?`).get(revisionId) as { maximumOrdinal: number };
    const maximumOrdinal = Number(maximumOrdinalRow.maximumOrdinal);
    const boundedEntry = Math.min(entryOrdinal, maximumOrdinal);
    const activeRows = this.listAtEntry(boundedEntry);
    const historyRows = db.prepare(`${this.relationshipSelectSql()} WHERE r.revision_id = ? AND r.review_status = 'confirmed'
      AND r.first_revealed_ordinal <= ? ORDER BY r.first_revealed_ordinal, r.created_at`)
      .all(revisionId, boundedEntry) as unknown as CharacterRelationshipRecord[];
    const knownIdentityIds = new Set(historyRows.flatMap((relationship) => [relationship.sourceIdentityId, relationship.targetIdentityId]));
    const mentionedIdentityRows = db.prepare(`SELECT DISTINCT m.identity_id AS identityId FROM person_mentions m
      JOIN paragraphs p ON p.id = m.paragraph_id WHERE m.revision_id = ? AND p.ordinal <= ?`)
      .all(revisionId, boundedEntry) as Array<{ identityId: string }>;
    mentionedIdentityRows.forEach((row) => knownIdentityIds.add(row.identityId));
    const futureEvidenceRows = db.prepare(`SELECT DISTINCT e.relationship_id AS relationshipId
      FROM character_relationship_evidence e JOIN paragraphs p ON p.id = e.paragraph_id
      JOIN character_relationships r ON r.id = e.relationship_id
      WHERE r.revision_id = ? AND r.review_status = 'confirmed' AND r.first_revealed_ordinal <= ? AND p.ordinal > ?`)
      .all(revisionId, boundedEntry, boundedEntry) as Array<{ relationshipId: string }>;
    const futureEvidenceIds = new Set(futureEvidenceRows.map((row) => row.relationshipId));
    const active = activeRows.map((relationship) => this.sanitizeForEntry(relationship, boundedEntry, knownIdentityIds, futureEvidenceIds));
    const history = historyRows.map((relationship) => this.sanitizeForEntry(relationship, boundedEntry, knownIdentityIds, futureEvidenceIds));

    const pairGroups = new Map<string, CharacterRelationshipRecord[]>();
    for (const relationship of active) {
      const key = this.relationshipPairKey(relationship);
      const group = pairGroups.get(key) ?? [];
      group.push(relationship);
      pairGroups.set(key, group);
    }
    const edges: RelationshipGraphEdge[] = active.map((relationship) => {
      const pairKey = this.relationshipPairKey(relationship);
      return { ...relationship, pairKey, hasConflict: this.pairHasConflict(pairGroups.get(pairKey) ?? []) };
    });
    const revealedIds = history.map((relationship) => relationship.id);
    const evidence = revealedIds.length === 0 ? [] : db.prepare(`SELECT e.id, e.relationship_id AS relationshipId,
      e.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      e.exact_quote AS exactQuote, e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM character_relationship_evidence e
      JOIN paragraphs p ON p.id = e.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE e.relationship_id IN (${revealedIds.map(() => '?').join(',')}) AND p.revision_id = ? AND p.ordinal <= ?
      ORDER BY p.ordinal, e.created_at`).all(...revealedIds, revisionId, boundedEntry) as unknown as CharacterRelationshipEvidenceRecord[];

    const events = relationshipEventTimeline(db, revisionId, boundedEntry);
    for (const event of events) for (const person of event.participants) knownIdentityIds.add(person.identityId);
    const identityIds = [...knownIdentityIds];
    const identityRows = identityIds.length === 0 ? [] : db.prepare(`SELECT id, canonical_name AS name,
      importance_tier AS importanceTier, importance_score AS importanceScore
      FROM person_identities WHERE revision_id = ? AND review_status = 'confirmed'
      AND id IN (${identityIds.map(() => '?').join(',')})`).all(revisionId, ...identityIds) as Array<{
        id: string;
        name: string;
        importanceTier: RelationshipGraphNode['importanceTier'];
        importanceScore: number;
      }>;
    const degree = new Map<string, number>();
    const firstReveal = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.sourceIdentityId, (degree.get(edge.sourceIdentityId) ?? 0) + 1);
      degree.set(edge.targetIdentityId, (degree.get(edge.targetIdentityId) ?? 0) + 1);
      for (const identityId of [edge.sourceIdentityId, edge.targetIdentityId]) {
        firstReveal.set(identityId, Math.min(firstReveal.get(identityId) ?? edge.firstRevealedOrdinal, edge.firstRevealedOrdinal));
      }
    }
    const firstMentions = db.prepare(`SELECT m.identity_id AS identityId, MIN(p.ordinal) AS ordinal
      FROM person_mentions m JOIN paragraphs p ON p.id = m.paragraph_id
      WHERE m.revision_id = ? AND p.revision_id = ? AND p.ordinal <= ? GROUP BY m.identity_id`)
      .all(revisionId, revisionId, boundedEntry) as Array<{ identityId: string; ordinal: number }>;
    for (const mention of firstMentions) firstReveal.set(mention.identityId, Math.min(firstReveal.get(mention.identityId) ?? mention.ordinal, mention.ordinal));
    for (const event of events) for (const person of event.participants) {
      const reveal = Math.max(event.endOrdinal, ...event.evidence.map(quote => quote.paragraphOrdinal));
      firstReveal.set(person.identityId, Math.min(firstReveal.get(person.identityId) ?? reveal, reveal));
    }
    const componentByIdentity = this.connectedComponents(identityIds, edges);
    const nodes: RelationshipGraphNode[] = identityRows.map((identity) => ({
      ...identity,
      importanceScore: Number(identity.importanceScore),
      degree: degree.get(identity.id) ?? 0,
      firstRevealedOrdinal: firstReveal.get(identity.id) ?? boundedEntry,
      componentId: componentByIdentity.get(identity.id) ?? 0,
    })).sort((left, right) => right.degree - left.degree || right.importanceScore - left.importanceScore || left.name.localeCompare(right.name, 'zh-CN'));

    return {
      entryOrdinal: boundedEntry,
      events,
      maximumOrdinal,
      nodes,
      edges,
      history,
      evidence,
      revealedRelationshipCount: history.length,
      temporallyInactiveRelationshipCount: Math.max(0, history.length - edges.length),
    };
  }

  listEvidence(relationshipId: string): CharacterRelationshipEvidenceRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT e.id, e.source_span_id AS sourceSpanId,
      e.relationship_id AS relationshipId, e.paragraph_id AS paragraphId,
      p.ordinal AS paragraphOrdinal, c.title AS chapterTitle, e.exact_quote AS exactQuote,
      e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM character_relationship_evidence e
      JOIN character_relationships r ON r.id = e.relationship_id
      JOIN paragraphs p ON p.id = e.paragraph_id
      LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE e.relationship_id = ? AND r.revision_id = ? ORDER BY p.ordinal`)
      .all(relationshipId, revisionId) as unknown as CharacterRelationshipEvidenceRecord[];
  }

  private alignEvidence<T extends { paragraphId: string; exactQuote: string }>(db: SQLiteDatabase, revisionId: string, evidence: T[]): Array<AlignedEvidence<T>> {
    if (evidence.length === 0) return [];
    return evidence.map((input) => {
      if (!input.exactQuote.trim()) throw new Error('证据原文不能为空');
      const paragraph = db.prepare(`SELECT id, revision_id AS revisionId, ordinal, text FROM paragraphs
        WHERE id = ? AND revision_id = ?`).get(input.paragraphId, revisionId) as ParagraphRow | undefined;
      if (!paragraph) throw new Error('证据段落不属于当前版本');
      const normalizedQuote = normalizedText(input.exactQuote);
      const alignmentStatus = paragraph.text.includes(input.exactQuote) ? 'exact' as const
        : normalizedQuote && normalizedText(paragraph.text).includes(normalizedQuote) ? 'normalized' as const : null;
      if (!alignmentStatus) throw new Error('关系证据无法对齐原文');
      return { input, paragraph, alignmentStatus };
    });
  }

  private requireDistinctConfirmedPair(db: SQLiteDatabase, revisionId: string, sourceId: string, targetId: string): void {
    if (sourceId === targetId) throw new Error('人物关系两端不能是同一身份');
    this.requireConfirmedIdentity(db, revisionId, sourceId);
    this.requireConfirmedIdentity(db, revisionId, targetId);
  }

  private requireConfirmedIdentity(db: SQLiteDatabase, revisionId: string, identityId: string): void {
    const row = db.prepare(`SELECT id FROM person_identities WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`)
      .get(identityId, revisionId);
    if (!row) throw new Error('人物关系只能引用当前版本中已确认的人物');
  }

  private requireConfirmedCandidate(db: SQLiteDatabase, revisionId: string, candidateId: string, sourceId: string, targetId: string): void {
    const row = db.prepare(`SELECT source_identity_id AS sourceIdentityId, target_identity_id AS targetIdentityId, review_status AS reviewStatus
      FROM character_relationship_candidates WHERE id = ? AND revision_id = ?`).get(candidateId, revisionId) as
      { sourceIdentityId: string; targetIdentityId: string; reviewStatus: CharacterRelationshipReviewStatus } | undefined;
    if (!row || row.sourceIdentityId !== sourceId || row.targetIdentityId !== targetId) throw new Error('关系候选与人物方向对不匹配');
    if (row.reviewStatus !== 'confirmed') throw new Error('关系候选必须先经过人工确认');
  }

  private resolveTemporalBound(db: SQLiteDatabase, revisionId: string, eventId: string | null | undefined,
    timeExpressionId: string | null | undefined, side: 'from' | 'to'):
    { eventId: string | null; timeExpressionId: string | null; ordinal: number | null } {
    const ordinals: number[] = [];
    if (eventId) {
      const event = db.prepare(`SELECT narrative_start_ordinal AS startOrdinal, narrative_end_ordinal AS endOrdinal
        FROM timeline_events WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`).get(eventId, revisionId) as
        { startOrdinal: number; endOrdinal: number } | undefined;
      if (!event) throw new Error('关系有效期只能引用已确认事件');
      ordinals.push(side === 'from' ? Number(event.startOrdinal) : Number(event.endOrdinal));
    }
    if (timeExpressionId) {
      const expression = db.prepare(`SELECT p.ordinal FROM timeline_time_expressions t JOIN paragraphs p ON p.id = t.paragraph_id
        WHERE t.id = ? AND t.revision_id = ? AND t.review_status = 'confirmed'`).get(timeExpressionId, revisionId) as { ordinal: number } | undefined;
      if (!expression) throw new Error('关系有效期只能引用已确认时间表达');
      ordinals.push(Number(expression.ordinal));
    }
    return {
      eventId: eventId ?? null,
      timeExpressionId: timeExpressionId ?? null,
      ordinal: ordinals.length === 0 ? null : side === 'from' ? Math.max(...ordinals) : Math.min(...ordinals),
    };
  }

  private candidateSelectSql(): string {
    return `SELECT c.id, c.source_identity_id AS sourceIdentityId, s.canonical_name AS sourceName,
      c.target_identity_id AS targetIdentityId, t.canonical_name AS targetName, c.candidate_method AS candidateMethod,
      c.proposed_type AS proposedType, c.confidence, c.review_status AS reviewStatus,
      (SELECT COUNT(*) FROM character_relationship_candidate_evidence e WHERE e.candidate_id = c.id) AS evidenceCount
      FROM character_relationship_candidates c JOIN person_identities s ON s.id = c.source_identity_id
      JOIN person_identities t ON t.id = c.target_identity_id`;
  }

  private relationshipSelectSql(): string {
    return `SELECT r.id, r.source_identity_id AS sourceIdentityId, s.canonical_name AS sourceName,
      r.target_identity_id AS targetIdentityId, t.canonical_name AS targetName, r.relationship_type AS relationshipType,
      r.direction, r.strength, r.polarity, r.information_source_type AS informationSourceType,
      r.information_source_identity_id AS informationSourceIdentityId, narrator.canonical_name AS informationSourceName,
      r.truth_status AS truthStatus, r.valid_from_event_id AS validFromEventId, r.valid_to_event_id AS validToEventId,
      r.valid_from_time_expression_id AS validFromTimeExpressionId, r.valid_to_time_expression_id AS validToTimeExpressionId,
      r.valid_from_ordinal AS validFromOrdinal, r.valid_to_ordinal AS validToOrdinal,
      r.first_revealed_paragraph_id AS firstRevealedParagraphId, r.first_revealed_ordinal AS firstRevealedOrdinal,
      r.confidence, r.review_status AS reviewStatus, r.extraction_method AS extractionMethod,
      r.candidate_id AS candidateId, r.supersedes_relationship_id AS supersedesRelationshipId,
      r.reasoning_note AS reasoningNote,
      (SELECT COUNT(*) FROM character_relationship_evidence e WHERE e.relationship_id = r.id) AS evidenceCount
      FROM character_relationships r JOIN person_identities s ON s.id = r.source_identity_id
      JOIN person_identities t ON t.id = r.target_identity_id
      LEFT JOIN person_identities narrator ON narrator.id = r.information_source_identity_id`;
  }

  private relationshipPairKey(relationship: Pick<CharacterRelationshipRecord, 'sourceIdentityId' | 'targetIdentityId' | 'direction'>): string {
    if (relationship.direction === 'directed') return `${relationship.sourceIdentityId}>${relationship.targetIdentityId}`;
    return [relationship.sourceIdentityId, relationship.targetIdentityId].sort().join('~');
  }

  private pairHasConflict(group: CharacterRelationshipRecord[]): boolean {
    if (group.length < 2) return false;
    const truthClasses = new Set(group.map((item) => item.truthStatus === 'asserted' ? 'positive'
      : item.truthStatus === 'false' || item.truthStatus === 'disputed' ? 'negative' : 'uncertain'));
    const polarityClasses = new Set(group.map((item) => item.polarity === null || item.polarity === 0 ? 'neutral' : item.polarity > 0 ? 'positive' : 'negative'));
    const activeIds = new Set(group.map((item) => item.id));
    return (truthClasses.has('positive') && truthClasses.has('negative'))
      || (polarityClasses.has('positive') && polarityClasses.has('negative'))
      || group.some((item) => item.supersedesRelationshipId !== null && activeIds.has(item.supersedesRelationshipId));
  }

  private sanitizeForEntry(relationship: CharacterRelationshipRecord, entryOrdinal: number, knownIdentityIds: Set<string>,
    futureEvidenceIds: Set<string>): CharacterRelationshipRecord {
    let sanitized = relationship;
    if (relationship.validToOrdinal !== null && relationship.validToOrdinal > entryOrdinal) sanitized = {
      ...relationship,
      validToEventId: null,
      validToTimeExpressionId: null,
      validToOrdinal: null,
    };
    if (sanitized.informationSourceType === 'character' && sanitized.informationSourceIdentityId
      && !knownIdentityIds.has(sanitized.informationSourceIdentityId)) sanitized = {
      ...sanitized,
      informationSourceType: 'unknown',
      informationSourceIdentityId: null,
      informationSourceName: null,
    };
    if (futureEvidenceIds.has(sanitized.id)) sanitized = { ...sanitized, reasoningNote: '' };
    return sanitized;
  }

  private connectedComponents(identityIds: string[], edges: CharacterRelationshipRecord[]): Map<string, number> {
    const parent = new Map(identityIds.map((id) => [id, id]));
    const find = (id: string): string => {
      const current = parent.get(id) ?? id;
      if (current === id) return id;
      const root = find(current);
      parent.set(id, root);
      return root;
    };
    const join = (left: string, right: string): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    for (const edge of edges) join(edge.sourceIdentityId, edge.targetIdentityId);
    const componentIds = new Map<string, number>();
    const result = new Map<string, number>();
    for (const identityId of identityIds) {
      const root = find(identityId);
      if (!componentIds.has(root)) componentIds.set(root, componentIds.size + 1);
      result.set(identityId, componentIds.get(root)!);
    }
    return result;
  }

  private getCandidate(db: SQLiteDatabase, revisionId: string, candidateId: string): CharacterRelationshipCandidateRecord {
    const row = db.prepare(`${this.candidateSelectSql()} WHERE c.id = ? AND c.revision_id = ?`).get(candidateId, revisionId);
    if (!row) throw new Error('关系候选不存在');
    return row as unknown as CharacterRelationshipCandidateRecord;
  }

  private getRelationship(db: SQLiteDatabase, revisionId: string, relationshipId: string): CharacterRelationshipRecord {
    const row = db.prepare(`${this.relationshipSelectSql()} WHERE r.id = ? AND r.revision_id = ?`).get(relationshipId, revisionId);
    if (!row) throw new Error('人物关系不存在');
    return row as unknown as CharacterRelationshipRecord;
  }
}
