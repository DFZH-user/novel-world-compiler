import { createHash, randomUUID } from 'node:crypto';
import type {
  AutomationDraftPlaceRunRecord,
  PlaceAliasRecord,
  PlaceBootstrapSummary,
  PlaceIdentityLinkRecord,
  PlaceIdentityOperationRecord,
  PlaceMentionRecord,
  NarrativeMapEdge,
  NarrativeMapEventRecord,
  NarrativeMapNode,
  NarrativeMapProjection,
  NarrativeMapTopologyClass,
  PlaceRecord,
  PlaceRelationCandidateRecord,
  PlaceRelationEvidenceRecord,
  PlaceRelationModelSuggestionRecord,
  PlaceRelationRecord,
  PlaceReviewStatus,
  PlaceSuggestionEvidenceRecord,
  PlaceType,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

type EventLocationEvidenceRow = {
  sourceEventLocationId: string;
  eventId: string;
  surfaceName: string;
  normalizedName: string | null;
  confidence: number;
  paragraphId: string;
  paragraphOrdinal: number;
  paragraphText: string;
  exactQuote: string;
};

const PLACE_TYPES = new Set<PlaceType>([
  'realm', 'region', 'country', 'city', 'settlement', 'district',
  'route', 'natural', 'building', 'room', 'landmark', 'other',
]);

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().replace(/[\s\u3000]+/gu, '').toLowerCase();
}
function normalizedEvidenceText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]/gu, '').replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

function findOccurrences(text: string, needles: string[]): Array<{ surfaceText: string; charStart: number; charEnd: number }> {
  const result = new Map<string, { surfaceText: string; charStart: number; charEnd: number }>();
  for (const needle of [...new Set(needles.map((value) => value.trim()).filter(Boolean))]) {
    for (let start = text.indexOf(needle); start >= 0; start = text.indexOf(needle, start + Math.max(needle.length, 1))) {
      result.set(`${start}:${start + needle.length}`, { surfaceText: needle, charStart: start, charEnd: start + needle.length });
    }
  }
  return [...result.values()].sort((left, right) => left.charStart - right.charStart || left.charEnd - right.charEnd);
}

export class PlaceService {
  constructor(private readonly store: ProjectStore) {}

  bootstrapFromConfirmedEvents(): PlaceBootstrapSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const rows = db.prepare(`SELECT l.id AS sourceEventLocationId, e.id AS eventId,
      l.surface_name AS surfaceName, l.normalized_name AS normalizedName, l.confidence,
      v.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, p.text AS paragraphText, v.exact_quote AS exactQuote
      FROM timeline_event_locations l
      JOIN timeline_events e ON e.id = l.event_id
      JOIN timeline_event_evidence v ON v.event_id = e.id AND v.evidence_role != 'contradict'
      JOIN paragraphs p ON p.id = v.paragraph_id
      WHERE e.revision_id = ? AND e.review_status = 'confirmed' AND l.review_status != 'rejected'
      ORDER BY e.narrative_start_ordinal, l.id, p.ordinal`).all(revisionId) as unknown as EventLocationEvidenceRow[];
    let summary!: PlaceBootstrapSummary;
    withTransaction(db, () => { summary = this.bootstrapRows(db, revisionId, rows); });
    return summary;
  }

  bootstrapFromDraftEvents(selectionRunId: string, eventRunId: string): AutomationDraftPlaceRunRecord {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const selection = db.prepare(`SELECT id, revision_id AS revisionId, input_hash AS inputHash, state
      FROM automation_draft_selection_runs WHERE id = ? AND project_id = ?`).get(selectionRunId, projectId) as
      { id: string; revisionId: string; inputHash: string; state: string } | undefined;
    if (!selection || selection.state !== 'completed') throw new Error('自动草稿选择尚未完成，不能生成地点草稿');
    if (selection.revisionId !== revisionId) throw new Error('自动草稿选择不属于当前正文修订');
    const eventRun = db.prepare(`SELECT id, revision_id AS revisionId, input_hash AS inputHash, status,
      input_mode AS inputMode, draft_selection_run_id AS draftSelectionRunId
      FROM timeline_event_runs WHERE id = ? AND project_id = ?`).get(eventRunId, projectId) as
      { id: string; revisionId: string; inputHash: string; status: string; inputMode: string; draftSelectionRunId: string | null } | undefined;
    if (!eventRun || eventRun.status !== 'completed') throw new Error('事件草稿尚未完成，不能生成地点草稿');
    if (eventRun.revisionId !== revisionId || eventRun.inputMode !== 'automation-draft-selection' || eventRun.draftSelectionRunId !== selectionRunId) {
      throw new Error('事件草稿与当前自动草稿选择不匹配');
    }
    const rows = db.prepare(`SELECT l.id AS sourceEventLocationId, e.id AS eventId,
      l.surface_name AS surfaceName, l.normalized_name AS normalizedName, l.confidence,
      v.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, p.text AS paragraphText, v.exact_quote AS exactQuote
      FROM timeline_event_sources s JOIN timeline_events e ON e.id = s.event_id
      JOIN timeline_event_locations l ON l.event_id = e.id
      JOIN timeline_event_evidence v ON v.event_id = e.id AND v.evidence_role != 'contradict'
      JOIN paragraphs p ON p.id = v.paragraph_id
      WHERE s.run_id = ? AND e.revision_id = ? AND e.review_status != 'rejected' AND l.review_status != 'rejected'
      ORDER BY e.narrative_start_ordinal, l.id, p.ordinal`).all(eventRunId, revisionId) as unknown as EventLocationEvidenceRow[];
    const algorithmVersion = 'draft-event-places.v1';
    const inputHash = hash(JSON.stringify({ revisionId, selectionRunId, selectionInputHash: selection.inputHash,
      eventRunId, eventInputHash: eventRun.inputHash, algorithmVersion,
      rows: rows.map((row) => [row.sourceEventLocationId, row.eventId, row.surfaceName, row.normalizedName,
        row.confidence, row.paragraphId, row.exactQuote]) }));
    const existing = db.prepare(`SELECT id, revision_id AS revisionId, selection_run_id AS selectionRunId,
      event_run_id AS eventRunId, algorithm_version AS algorithmVersion, input_hash AS inputHash,
      source_location_count AS sourceLocationCount, created_place_count AS createdPlaceCount,
      created_mention_count AS createdMentionCount, skipped_unaligned_count AS skippedUnalignedCount,
      created_at AS createdAt FROM automation_draft_place_runs
      WHERE project_id = ? AND revision_id = ? AND selection_run_id = ? AND event_run_id = ?
      AND algorithm_version = ? AND input_hash = ?`).get(projectId, revisionId, selectionRunId, eventRunId,
        algorithmVersion, inputHash) as Omit<AutomationDraftPlaceRunRecord, 'reused'> | undefined;
    if (existing) return { ...existing, reused: true };

    const id = randomUUID();
    const timestamp = now();
    let summary!: PlaceBootstrapSummary;
    withTransaction(db, () => {
      summary = this.bootstrapRows(db, revisionId, rows);
      db.prepare(`INSERT INTO automation_draft_place_runs
        (id, project_id, revision_id, selection_run_id, event_run_id, algorithm_version, input_hash,
         source_location_count, created_place_count, created_mention_count, skipped_unaligned_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, projectId, revisionId, selectionRunId, eventRunId, algorithmVersion, inputHash,
          summary.sourceLocationCount, summary.createdPlaceCount, summary.createdMentionCount, summary.skippedUnalignedCount, timestamp);
    });
    return { id, revisionId, selectionRunId, eventRunId, algorithmVersion, inputHash, ...summary, reused: false, createdAt: timestamp };
  }

  private bootstrapRows(db: SQLiteDatabase, revisionId: string, rows: EventLocationEvidenceRow[]): PlaceBootstrapSummary {
    const sourceIds = [...new Set(rows.map((row) => row.sourceEventLocationId))];
    let createdPlaceCount = 0;
    let createdMentionCount = 0;
    let skippedUnalignedCount = 0;
    for (const sourceLocationId of sourceIds) {
      const sourceRows = rows.filter((row) => row.sourceEventLocationId === sourceLocationId);
      const source = sourceRows[0];
      const canonicalName = source.normalizedName?.trim() || source.surfaceName.trim();
      if (!canonicalName) { skippedUnalignedCount += 1; continue; }
      const aligned = sourceRows.flatMap((row) => {
        const surfaceOccurrences = findOccurrences(row.paragraphText, [row.surfaceName]);
        const occurrences = surfaceOccurrences.length ? surfaceOccurrences : findOccurrences(row.paragraphText, [canonicalName]);
        return occurrences.map((occurrence) => ({ row, occurrence }));
      }).filter((item, index, all) => all.findIndex((candidate) => candidate.row.paragraphId === item.row.paragraphId
        && candidate.occurrence.charStart === item.occurrence.charStart && candidate.occurrence.charEnd === item.occurrence.charEnd) === index);
      if (aligned.length === 0) { skippedUnalignedCount += 1; continue; }
      aligned.sort((left, right) => left.row.paragraphOrdinal - right.row.paragraphOrdinal || left.occurrence.charStart - right.occurrence.charStart);
      const fingerprint = hash(`${revisionId}:event-location:${sourceLocationId}`);
      let place = db.prepare('SELECT id, review_status AS reviewStatus FROM place_identities WHERE revision_id = ? AND source_fingerprint = ?')
        .get(revisionId, fingerprint) as { id: string; reviewStatus: PlaceReviewStatus } | undefined;
      if (!place) {
        const first = aligned[0];
        const placeId = `plc_${hash(`${revisionId}:${sourceLocationId}`).slice(0, 32)}`;
        const timestamp = now();
        db.prepare(`INSERT INTO place_identities
          (id, revision_id, canonical_name, normalized_name, place_type, description, importance_score,
           first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method, source_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'other', '', ?, ?, ?, 'pending', 'rule', ?, ?, ?)`)
          .run(placeId, revisionId, canonicalName, normalizedName(canonicalName), Math.max(0, Math.min(1, Number(source.confidence))),
            first.row.paragraphId, first.row.paragraphOrdinal, fingerprint, timestamp, timestamp);
        place = { id: placeId, reviewStatus: 'pending' };
        createdPlaceCount += 1;
      }
      if (place.reviewStatus === 'rejected') continue;
      const timestamp = now();
      if (normalizedName(source.surfaceName) !== normalizedName(canonicalName)) {
        const aliasId = `pla_${hash(`${place.id}:${normalizedName(source.surfaceName)}`).slice(0, 32)}`;
        db.prepare(`INSERT OR IGNORE INTO place_aliases
          (id, place_id, alias, normalized_alias, source, review_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'event', 'pending', ?, ?)`)
          .run(aliasId, place.id, source.surfaceName.trim(), normalizedName(source.surfaceName), timestamp, timestamp);
      }
      for (const item of aligned) {
        const mentionId = `plm_${hash(`${place.id}:${item.row.paragraphId}:${item.occurrence.charStart}:${item.occurrence.charEnd}`).slice(0, 32)}`;
        const inserted = db.prepare(`INSERT OR IGNORE INTO place_mentions
          (id, revision_id, place_id, paragraph_id, surface_text, char_start, char_end, source_event_location_id,
           extraction_method, confidence, review_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?, 'pending', ?, ?)`)
          .run(mentionId, revisionId, place.id, item.row.paragraphId, item.occurrence.surfaceText,
            item.occurrence.charStart, item.occurrence.charEnd, sourceLocationId,
            Math.max(0, Math.min(1, Number(source.confidence))), timestamp, timestamp);
        createdMentionCount += inserted.changes;
      }
    }
    return { sourceLocationCount: sourceIds.length, createdPlaceCount, createdMentionCount, skippedUnalignedCount };
  }
  listPlaces(status?: PlaceReviewStatus): PlaceRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT i.id, i.canonical_name AS canonicalName, i.normalized_name AS normalizedName,
      i.place_type AS placeType, i.description, i.importance_score AS importanceScore,
      i.first_revealed_paragraph_id AS firstRevealedParagraphId, i.first_revealed_ordinal AS firstRevealedOrdinal,
      c.title AS chapterTitle, i.review_status AS reviewStatus, i.extraction_method AS extractionMethod,
      (SELECT COUNT(*) FROM place_mentions m WHERE m.place_id = i.id AND m.review_status != 'rejected') AS mentionCount,
      (SELECT COUNT(DISTINCT l.event_id) FROM place_mentions m
        JOIN timeline_event_locations l ON l.id = m.source_event_location_id
        WHERE m.place_id = i.id AND m.review_status != 'rejected') AS sourceEventCount
      FROM place_identities i JOIN paragraphs p ON p.id = i.first_revealed_paragraph_id
      LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE i.revision_id = ? ${status ? 'AND i.review_status = ?' : ''}
      ORDER BY i.review_status = 'rejected', i.first_revealed_ordinal, i.canonical_name, i.id`)
      .all(...(status ? [revisionId, status] : [revisionId])) as unknown as PlaceRecord[];
  }

  listMentions(placeId: string): PlaceMentionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT m.id, m.source_span_id AS sourceSpanId,
      m.place_id AS placeId, m.paragraph_id AS paragraphId,
      p.ordinal AS paragraphOrdinal, c.title AS chapterTitle, m.surface_text AS surfaceText,
      m.char_start AS charStart, m.char_end AS charEnd, m.source_event_location_id AS sourceEventLocationId,
      m.extraction_method AS extractionMethod, m.confidence, m.review_status AS reviewStatus, p.text AS paragraphText
      FROM place_mentions m JOIN place_identities i ON i.id = m.place_id
      JOIN paragraphs p ON p.id = m.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE m.place_id = ? AND i.revision_id = ? ORDER BY p.ordinal, m.char_start`)
      .all(placeId, revisionId) as unknown as PlaceMentionRecord[];
  }

  listAliases(placeId: string): PlaceAliasRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT a.id, a.place_id AS placeId, a.alias, a.normalized_alias AS normalizedAlias,
      a.source, a.review_status AS reviewStatus FROM place_aliases a
      JOIN place_identities i ON i.id = a.place_id
      WHERE a.place_id = ? AND i.revision_id = ? ORDER BY a.review_status = 'rejected', a.alias, a.id`)
      .all(placeId, revisionId) as unknown as PlaceAliasRecord[];
  }

  reviewAlias(aliasId: string, status: PlaceReviewStatus): PlaceAliasRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const alias = db.prepare(`SELECT a.id, a.place_id AS placeId, a.alias, a.review_status AS reviewStatus
      FROM place_aliases a JOIN place_identities i ON i.id = a.place_id
      WHERE a.id = ? AND i.revision_id = ?`).get(aliasId, revisionId) as {
        id: string; placeId: string; alias: string; reviewStatus: PlaceReviewStatus;
      } | undefined;
    if (!alias) throw new Error('找不到该地点别名');
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare('UPDATE place_aliases SET review_status = ?, updated_at = ? WHERE id = ?').run(status, timestamp, aliasId);
      this.insertOperation(db, revisionId, 'alias_review', `将地点别名“${alias.alias}”标记为${status === 'confirmed' ? '已确认' : status === 'rejected' ? '已排除' : '待审核'}`, {
        aliasId, placeId: alias.placeId, previousStatus: alias.reviewStatus,
      });
    });
    return this.listAliases(alias.placeId);
  }

  listAliasEvidence(aliasId: string): PlaceSuggestionEvidenceRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT e.id, e.source_span_id AS sourceSpanId,
      e.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      e.exact_quote AS exactQuote, NULL AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM place_alias_evidence e JOIN place_aliases a ON a.id = e.alias_id JOIN place_identities i ON i.id = a.place_id
      JOIN paragraphs p ON p.id = e.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE e.alias_id = ? AND i.revision_id = ? ORDER BY p.ordinal, e.id`).all(aliasId, revisionId) as unknown as PlaceSuggestionEvidenceRecord[];
  }

  merge(sourcePlaceId: string, targetPlaceId: string): PlaceRecord[] {
    if (sourcePlaceId === targetPlaceId) throw new Error('不能把地点合并到自己');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const source = this.placeForEdit(db, revisionId, sourcePlaceId);
    const target = this.placeForEdit(db, revisionId, targetPlaceId);
    if (source.reviewStatus === 'rejected' || target.reviewStatus === 'rejected') throw new Error('已排除的地点不能参与合并，请先恢复为待审核');
    const [leftPlaceId, rightPlaceId] = [sourcePlaceId, targetPlaceId].sort();
    const blocked = db.prepare(`SELECT reason FROM place_identity_links WHERE revision_id = ? AND left_place_id = ?
      AND right_place_id = ? AND relation = 'cannot_link' AND review_status = 'confirmed'`)
      .get(revisionId, leftPlaceId, rightPlaceId) as { reason: string } | undefined;
    if (blocked) throw new Error(`这两个地点已被明确标记为不同地点：${blocked.reason}`);
    const relationCount = db.prepare(`SELECT
      (SELECT COUNT(*) FROM place_relation_candidates WHERE revision_id = ? AND (source_place_id = ? OR target_place_id = ?)) +
      (SELECT COUNT(*) FROM place_relations WHERE revision_id = ? AND (source_place_id = ? OR target_place_id = ?)) AS value`)
      .get(revisionId, sourcePlaceId, sourcePlaceId, revisionId, sourcePlaceId, sourcePlaceId) as { value: number };
    if (Number(relationCount.value) > 0) throw new Error('该地点已经参与空间关系；请先审核或迁移关系，系统不会静默改写拓扑端点');

    const mentions = db.prepare('SELECT * FROM place_mentions WHERE place_id = ? ORDER BY id').all(sourcePlaceId) as Array<Record<string, string | number | null>>;
    const aliases = db.prepare('SELECT * FROM place_aliases WHERE place_id = ? ORDER BY id').all(sourcePlaceId) as Array<Record<string, string | number | null>>;
    const movedMentionIds: string[] = [];
    const deletedMentions: Array<Record<string, string | number | null>> = [];
    const movedAliasIds: string[] = [];
    const deletedAliases: Array<Record<string, string | number | null>> = [];
    let addedCanonicalAliasId: string | null = null;
    const timestamp = now();
    withTransaction(db, () => {
      for (const mention of mentions) {
        const duplicate = db.prepare(`SELECT id FROM place_mentions WHERE place_id = ? AND paragraph_id = ?
          AND char_start = ? AND char_end = ? LIMIT 1`).get(targetPlaceId, mention.paragraph_id, mention.char_start, mention.char_end) as { id: string } | undefined;
        if (duplicate) {
          deletedMentions.push(mention);
          db.prepare('DELETE FROM place_mentions WHERE id = ?').run(mention.id);
        } else {
          db.prepare('UPDATE place_mentions SET place_id = ?, updated_at = ? WHERE id = ?').run(targetPlaceId, timestamp, mention.id);
          movedMentionIds.push(String(mention.id));
        }
      }
      for (const alias of aliases) {
        const duplicate = db.prepare('SELECT id FROM place_aliases WHERE place_id = ? AND normalized_alias = ? LIMIT 1')
          .get(targetPlaceId, alias.normalized_alias) as { id: string } | undefined;
        if (duplicate) {
          deletedAliases.push(alias);
          db.prepare('DELETE FROM place_aliases WHERE id = ?').run(alias.id);
        } else {
          db.prepare('UPDATE place_aliases SET place_id = ?, updated_at = ? WHERE id = ?').run(targetPlaceId, timestamp, alias.id);
          movedAliasIds.push(String(alias.id));
        }
      }
      if (source.normalizedName !== target.normalizedName) {
        const duplicate = db.prepare('SELECT id FROM place_aliases WHERE place_id = ? AND normalized_alias = ? LIMIT 1')
          .get(targetPlaceId, source.normalizedName) as { id: string } | undefined;
        if (!duplicate) {
          addedCanonicalAliasId = `pla_${randomUUID()}`;
          db.prepare(`INSERT INTO place_aliases
            (id, place_id, alias, normalized_alias, source, review_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'user', 'confirmed', ?, ?)`)
            .run(addedCanonicalAliasId, targetPlaceId, source.canonicalName, source.normalizedName, timestamp, timestamp);
        }
      }
      db.prepare(`UPDATE place_identities SET review_status = 'rejected', updated_at = ? WHERE id = ?`).run(timestamp, sourcePlaceId);
      this.recalculatePlace(db, targetPlaceId, timestamp);
      this.insertOperation(db, revisionId, 'merge', `将地点“${source.canonicalName}”合并到“${target.canonicalName}”`, {
        sourcePlaceId, targetPlaceId, movedMentionIds, deletedMentions, movedAliasIds, deletedAliases,
        addedCanonicalAliasId, sourceReviewStatus: source.reviewStatus,
      });
    });
    return this.listPlaces();
  }

  split(sourcePlaceId: string, mentionIdsInput: string[], canonicalNameInput: string): PlaceRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const source = this.placeForEdit(db, revisionId, sourcePlaceId);
    if (source.reviewStatus === 'rejected') throw new Error('已排除的地点不能拆分');
    const canonicalName = canonicalNameInput.trim().slice(0, 200);
    if (!canonicalName || !normalizedName(canonicalName)) throw new Error('新地点名称不能为空');
    const requested = [...new Set(mentionIdsInput)].slice(0, 500);
    if (!requested.length) throw new Error('请至少选择一条需要拆出的原文证据');
    const placeholders = requested.map(() => '?').join(',');
    const mentions = db.prepare(`SELECT m.*, p.ordinal AS paragraph_ordinal FROM place_mentions m JOIN paragraphs p ON p.id = m.paragraph_id
      WHERE m.place_id = ? AND m.id IN (${placeholders}) ORDER BY p.ordinal, m.char_start`)
      .all(sourcePlaceId, ...requested) as Array<Record<string, string | number | null>>;
    if (mentions.length !== requested.length) throw new Error('部分证据已经不属于当前地点，请刷新后重试');
    const total = db.prepare('SELECT COUNT(*) AS value FROM place_mentions WHERE place_id = ?').get(sourcePlaceId) as { value: number };
    if (mentions.length >= Number(total.value)) throw new Error('不能把全部证据拆走；如需改名，请直接修改规范地点名');
    const first = mentions[0];
    const newPlaceId = `plc_${randomUUID()}`;
    const linkId = `pll_${randomUUID()}`;
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO place_identities
        (id, revision_id, canonical_name, normalized_name, place_type, description, importance_score,
         first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method, source_fingerprint, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 'pending', 'user', NULL, ?, ?)`)
        .run(newPlaceId, revisionId, canonicalName, normalizedName(canonicalName), source.placeType,
          Math.max(...mentions.map((mention) => Number(mention.confidence))), first.paragraph_id, first.paragraph_ordinal, timestamp, timestamp);
      for (const mention of mentions) db.prepare('UPDATE place_mentions SET place_id = ?, review_status = \'pending\', updated_at = ? WHERE id = ?')
        .run(newPlaceId, timestamp, mention.id);
      const seen = new Set<string>();
      for (const mention of mentions) {
        const alias = String(mention.surface_text);
        const normalizedAlias = normalizedName(alias);
        if (!normalizedAlias || normalizedAlias === normalizedName(canonicalName) || seen.has(normalizedAlias)) continue;
        seen.add(normalizedAlias);
        db.prepare(`INSERT INTO place_aliases
          (id, place_id, alias, normalized_alias, source, review_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'user', 'pending', ?, ?)`)
          .run(`pla_${randomUUID()}`, newPlaceId, alias, normalizedAlias, timestamp, timestamp);
      }
      const [leftPlaceId, rightPlaceId] = [sourcePlaceId, newPlaceId].sort();
      db.prepare(`INSERT INTO place_identity_links
        (id, revision_id, left_place_id, right_place_id, relation, reason, confidence, review_status, created_at)
        VALUES (?, ?, ?, ?, 'cannot_link', '用户从同一地点候选中按原文证据拆分', 1, 'confirmed', ?)`)
        .run(linkId, revisionId, leftPlaceId, rightPlaceId, timestamp);
      this.recalculatePlace(db, sourcePlaceId, timestamp);
      this.insertOperation(db, revisionId, 'split', `从地点“${source.canonicalName}”拆出“${canonicalName}”`, {
        sourcePlaceId, newPlaceId, mentionIds: mentions.map((mention) => mention.id), linkId,
      });
    });
    return this.listPlaces();
  }

  link(leftPlaceIdInput: string, rightPlaceIdInput: string, relation: 'cannot_link' | 'must_link', reasonInput: string): PlaceIdentityLinkRecord[] {
    if (leftPlaceIdInput === rightPlaceIdInput) throw new Error('不能给同一个地点建立身份约束');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const left = this.placeForEdit(db, revisionId, leftPlaceIdInput);
    const right = this.placeForEdit(db, revisionId, rightPlaceIdInput);
    const [leftPlaceId, rightPlaceId] = [leftPlaceIdInput, rightPlaceIdInput].sort();
    const existing = db.prepare(`SELECT id FROM place_identity_links WHERE revision_id = ? AND left_place_id = ?
      AND right_place_id = ? AND relation = ?`).get(revisionId, leftPlaceId, rightPlaceId, relation) as { id: string } | undefined;
    if (existing) throw new Error('相同的地点身份约束已经存在');
    const reason = reasonInput.trim().slice(0, 500) || (relation === 'cannot_link' ? '用户确认这是两个不同地点' : '用户认为这是同一地点');
    const linkId = `pll_${randomUUID()}`;
    withTransaction(db, () => {
      db.prepare(`INSERT INTO place_identity_links
        (id, revision_id, left_place_id, right_place_id, relation, reason, confidence, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'confirmed', ?)`)
        .run(linkId, revisionId, leftPlaceId, rightPlaceId, relation, reason, now());
      this.insertOperation(db, revisionId, relation, `将“${left.canonicalName}”与“${right.canonicalName}”标记为${relation === 'cannot_link' ? '不同地点' : '同一地点候选'}`, { linkId });
    });
    return this.listLinks();
  }

  listLinks(placeId?: string): PlaceIdentityLinkRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT l.id, l.left_place_id AS leftPlaceId, a.canonical_name AS leftName,
      l.right_place_id AS rightPlaceId, b.canonical_name AS rightName, l.relation, l.reason, l.confidence,
      l.review_status AS reviewStatus, l.created_at AS createdAt FROM place_identity_links l
      JOIN place_identities a ON a.id = l.left_place_id JOIN place_identities b ON b.id = l.right_place_id
      WHERE l.revision_id = ? ${placeId ? 'AND (l.left_place_id = ? OR l.right_place_id = ?)' : ''}
      ORDER BY l.created_at DESC, l.id`)
      .all(...(placeId ? [revisionId, placeId, placeId] : [revisionId])) as unknown as PlaceIdentityLinkRecord[];
  }

  reviewLink(linkId: string, status: PlaceReviewStatus): PlaceIdentityLinkRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    const link = db.prepare('SELECT id FROM place_identity_links WHERE id = ? AND revision_id = ?').get(linkId, revisionId);
    if (!link) throw new Error('找不到该地点身份建议');
    db.prepare('UPDATE place_identity_links SET review_status = ? WHERE id = ?').run(status, linkId);
    return this.listLinks();
  }

  listLinkEvidence(linkId: string): PlaceSuggestionEvidenceRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT e.id, e.source_span_id AS sourceSpanId,
      e.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      e.exact_quote AS exactQuote, e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM place_identity_link_evidence e JOIN place_identity_links l ON l.id = e.link_id
      JOIN paragraphs p ON p.id = e.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE e.link_id = ? AND l.revision_id = ? ORDER BY p.ordinal, e.id`).all(linkId, revisionId) as unknown as PlaceSuggestionEvidenceRecord[];
  }

  listRelationCandidates(status?: PlaceReviewStatus): PlaceRelationCandidateRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT r.id, r.source_place_id AS sourcePlaceId, s.canonical_name AS sourceName,
      r.target_place_id AS targetPlaceId, t.canonical_name AS targetName, r.candidate_method AS candidateMethod,
      r.proposed_relation_kind AS proposedRelationKind, r.proposed_direction AS proposedDirection, r.confidence,
      r.review_status AS reviewStatus, (SELECT COUNT(*) FROM place_relation_candidate_evidence e WHERE e.candidate_id = r.id) AS evidenceCount
      FROM place_relation_candidates r JOIN place_identities s ON s.id = r.source_place_id JOIN place_identities t ON t.id = r.target_place_id
      WHERE r.revision_id = ? ${status ? 'AND r.review_status = ?' : ''}
      ORDER BY r.review_status = 'rejected', r.created_at DESC, r.id`).all(...(status ? [revisionId, status] : [revisionId])) as unknown as PlaceRelationCandidateRecord[];
  }

  listRelationCandidateEvidence(candidateId: string): PlaceSuggestionEvidenceRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT e.id, e.source_span_id AS sourceSpanId,
      e.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      e.exact_quote AS exactQuote, e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM place_relation_candidate_evidence e JOIN place_relation_candidates r ON r.id = e.candidate_id
      JOIN paragraphs p ON p.id = e.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE e.candidate_id = ? AND r.revision_id = ? ORDER BY p.ordinal, e.id`).all(candidateId, revisionId) as unknown as PlaceSuggestionEvidenceRecord[];
  }

  getRelationModelSuggestion(candidateId: string): PlaceRelationModelSuggestionRecord | null {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    const row = db.prepare(`SELECT m.candidate_id AS candidateId, m.direction, m.information_source_type AS informationSourceType,
      m.information_source_identity_id AS informationSourceIdentityId, i.canonical_name AS informationSourceName,
      m.truth_status AS truthStatus, m.valid_from_event_id AS validFromEventId, f.title AS validFromEventTitle,
      m.valid_to_event_id AS validToEventId, t.title AS validToEventTitle, m.reasoning_note AS reasoningNote, m.uncertainty
      FROM place_relation_model_suggestions m JOIN place_relation_candidates r ON r.id = m.candidate_id
      LEFT JOIN person_identities i ON i.id = m.information_source_identity_id LEFT JOIN timeline_events f ON f.id = m.valid_from_event_id
      LEFT JOIN timeline_events t ON t.id = m.valid_to_event_id WHERE m.candidate_id = ? AND r.revision_id = ?`)
      .get(candidateId, revisionId) as unknown as PlaceRelationModelSuggestionRecord | undefined;
    return row ?? null;
  }

  reviewRelationCandidate(candidateId: string, status: PlaceReviewStatus): PlaceRelationCandidateRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    const candidate = db.prepare('SELECT id FROM place_relation_candidates WHERE id = ? AND revision_id = ?').get(candidateId, revisionId);
    if (!candidate) throw new Error('找不到该空间关系建议');
    db.prepare('UPDATE place_relation_candidates SET review_status = ?, updated_at = ? WHERE id = ?').run(status, now(), candidateId);
    return this.listRelationCandidates();
  }

  createRelationFromCandidate(candidateId: string): PlaceRelationRecord {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    const existing = db.prepare(`SELECT id FROM place_relations WHERE candidate_id = ? AND revision_id = ? AND review_status != 'rejected'`)
      .get(candidateId, revisionId) as { id: string } | undefined;
    if (existing) return this.getRelation(db, revisionId, existing.id);
    const candidate = db.prepare(`SELECT id, source_place_id AS sourcePlaceId, target_place_id AS targetPlaceId,
      candidate_method AS candidateMethod, proposed_relation_kind AS relationKind, proposed_direction AS proposedDirection,
      confidence, review_status AS reviewStatus FROM place_relation_candidates WHERE id = ? AND revision_id = ?`)
      .get(candidateId, revisionId) as { id: string; sourcePlaceId: string; targetPlaceId: string; candidateMethod: 'rule' | 'model' | 'user';
        relationKind: string | null; proposedDirection: 'directed' | 'undirected' | null; confidence: number; reviewStatus: PlaceReviewStatus } | undefined;
    if (!candidate) throw new Error('找不到该空间关系候选');
    if (candidate.reviewStatus !== 'confirmed') throw new Error('空间关系候选必须先经过人工确认');
    this.requireConfirmedPlace(db, revisionId, candidate.sourcePlaceId);
    this.requireConfirmedPlace(db, revisionId, candidate.targetPlaceId);
    const relationKind = candidate.relationKind?.trim();
    if (!relationKind) throw new Error('空间关系类型不能为空');
    const suggestion = db.prepare(`SELECT direction, information_source_type AS informationSourceType,
      information_source_identity_id AS informationSourceIdentityId, truth_status AS truthStatus,
      valid_from_event_id AS validFromEventId, valid_to_event_id AS validToEventId, reasoning_note AS reasoningNote
      FROM place_relation_model_suggestions WHERE candidate_id = ?`).get(candidateId) as {
        direction: 'directed' | 'undirected'; informationSourceType: 'narrator' | 'character' | 'unknown';
        informationSourceIdentityId: string | null; truthStatus: PlaceRelationRecord['truthStatus'];
        validFromEventId: string | null; validToEventId: string | null; reasoningNote: string;
      } | undefined;
    const informationSourceType = suggestion?.informationSourceType ?? 'narrator';
    const informationSourceIdentityId = suggestion?.informationSourceIdentityId ?? null;
    if (informationSourceType === 'character') {
      if (!informationSourceIdentityId) throw new Error('人物来源必须指定已确认人物');
      const identity = db.prepare(`SELECT id FROM person_identities WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`)
        .get(informationSourceIdentityId, revisionId);
      if (!identity) throw new Error('空间关系的人物来源必须是当前版本已确认人物');
    } else if (informationSourceIdentityId) throw new Error('只有人物来源可以指定来源人物');
    const from = this.resolveRelationEventBound(db, revisionId, suggestion?.validFromEventId ?? null, 'from');
    const to = this.resolveRelationEventBound(db, revisionId, suggestion?.validToEventId ?? null, 'to');
    if (from.ordinal !== null && to.ordinal !== null && from.ordinal > to.ordinal) throw new Error('空间关系有效期起点不能晚于终点');
    const evidence = db.prepare(`SELECT e.paragraph_id AS paragraphId, e.exact_quote AS exactQuote, e.evidence_role AS evidenceRole,
      p.ordinal, p.text FROM place_relation_candidate_evidence e JOIN paragraphs p ON p.id = e.paragraph_id
      WHERE e.candidate_id = ? AND p.revision_id = ? ORDER BY p.ordinal, e.created_at`).all(candidateId, revisionId) as Array<{
        paragraphId: string; exactQuote: string; evidenceRole: 'clue' | 'support' | 'context' | 'contradict'; ordinal: number; text: string;
      }>;
    const acceptedEvidence = evidence.filter((item) => item.evidenceRole !== 'clue').map((item) => {
      const normalizedQuote = normalizedEvidenceText(item.exactQuote);
      const alignmentStatus = item.text.includes(item.exactQuote) ? 'exact' as const
        : normalizedQuote && normalizedEvidenceText(item.text).includes(normalizedQuote) ? 'normalized' as const : null;
      if (!alignmentStatus) throw new Error('空间关系证据无法继续对齐当前原文');
      return { ...item, alignmentStatus };
    });
    const supporting = acceptedEvidence.filter((item) => item.evidenceRole === 'support');
    if (supporting.length === 0) throw new Error('正式空间关系必须包含能够对齐原文的支持证据');
    const firstReveal = supporting.reduce((left, right) => right.ordinal < left.ordinal ? right : left);
    const timestamp = now(); const relationId = randomUUID();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO place_relations
        (id, revision_id, source_place_id, target_place_id, relation_kind, direction, information_source_type,
         information_source_identity_id, truth_status, valid_from_event_id, valid_to_event_id, valid_from_ordinal, valid_to_ordinal,
         first_revealed_paragraph_id, first_revealed_ordinal, confidence, review_status, extraction_method, candidate_id,
         supersedes_relation_id, reasoning_note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, ?)`)
        .run(relationId, revisionId, candidate.sourcePlaceId, candidate.targetPlaceId, relationKind,
          suggestion?.direction ?? candidate.proposedDirection ?? 'directed', informationSourceType, informationSourceIdentityId,
          suggestion?.truthStatus ?? 'asserted', from.eventId, to.eventId, from.ordinal, to.ordinal,
          firstReveal.paragraphId, firstReveal.ordinal, Number(candidate.confidence), candidate.candidateMethod,
          candidateId, suggestion?.reasoningNote ?? '', timestamp, timestamp);
      for (const item of acceptedEvidence) db.prepare(`INSERT INTO place_relation_evidence
        (id, relation_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(`pre_${createHash('sha256').update(`${relationId}:${item.paragraphId}:${item.exactQuote}:${item.evidenceRole}`).digest('hex').slice(0, 32)}`,
          relationId, item.paragraphId, item.exactQuote, item.evidenceRole, item.alignmentStatus, timestamp);
    });
    return this.getRelation(db, revisionId, relationId);
  }

  listRelations(status?: PlaceReviewStatus): PlaceRelationRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    return db.prepare(`${this.relationSelectSql()} WHERE r.revision_id = ? ${status ? 'AND r.review_status = ?' : ''}
      ORDER BY r.first_revealed_ordinal, r.created_at`).all(...(status ? [revisionId, status] : [revisionId])) as unknown as PlaceRelationRecord[];
  }

  listRelationsAtEntry(entryOrdinal: number): PlaceRelationRecord[] {
    if (!Number.isInteger(entryOrdinal) || entryOrdinal < 0) throw new Error('进入位置必须是非负段落序号');
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    return db.prepare(`${this.relationSelectSql()} WHERE r.revision_id = ? AND r.review_status = 'confirmed'
      AND r.first_revealed_ordinal <= ? AND (r.valid_from_ordinal IS NULL OR r.valid_from_ordinal <= ?)
      AND (r.valid_to_ordinal IS NULL OR r.valid_to_ordinal >= ?) ORDER BY r.first_revealed_ordinal, r.created_at`)
      .all(revisionId, entryOrdinal, entryOrdinal, entryOrdinal) as unknown as PlaceRelationRecord[];
  }

  getNarrativeMapProjection(entryOrdinal: number): NarrativeMapProjection {
    if (!Number.isInteger(entryOrdinal) || entryOrdinal < 0) throw new Error('进入位置必须是非负段落序号');
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    const maximumRow = db.prepare(`SELECT COALESCE(MAX(ordinal), 0) AS maximumOrdinal FROM paragraphs WHERE revision_id = ?`)
      .get(revisionId) as { maximumOrdinal: number };
    const maximumOrdinal = Number(maximumRow.maximumOrdinal);
    const boundedEntry = Math.min(entryOrdinal, maximumOrdinal);

    const placeRows = db.prepare(`SELECT i.id, i.canonical_name AS name, i.place_type AS placeType,
      i.importance_score AS importanceScore, i.first_revealed_ordinal AS firstRevealedOrdinal,
      (SELECT COUNT(*) FROM place_mentions m JOIN paragraphs mp ON mp.id = m.paragraph_id
        WHERE m.place_id = i.id AND m.review_status != 'rejected' AND mp.ordinal <= ?) AS mentionCount
      FROM place_identities i WHERE i.revision_id = ? AND i.review_status = 'confirmed'
      AND i.first_revealed_ordinal <= ? ORDER BY i.first_revealed_ordinal, i.canonical_name`)
      .all(boundedEntry, revisionId, boundedEntry) as Array<{
        id: string; name: string; placeType: NarrativeMapNode['placeType']; importanceScore: number;
        firstRevealedOrdinal: number; mentionCount: number;
      }>;
    const knownPlaceIds = new Set(placeRows.map((place) => place.id));
    const aliasRows = placeRows.length === 0 ? [] : db.prepare(`SELECT DISTINCT a.place_id AS placeId, a.alias
      FROM place_aliases a WHERE a.place_id IN (${placeRows.map(() => '?').join(',')}) AND a.review_status = 'confirmed'
      AND (EXISTS (SELECT 1 FROM place_alias_evidence ae JOIN paragraphs ap ON ap.id = ae.paragraph_id
        WHERE ae.alias_id = a.id AND ap.ordinal <= ?)
        OR EXISTS (SELECT 1 FROM place_mentions am JOIN paragraphs amp ON amp.id = am.paragraph_id
          WHERE am.place_id = a.place_id AND am.review_status != 'rejected' AND am.surface_text = a.alias AND amp.ordinal <= ?))
      ORDER BY a.alias`).all(...placeRows.map((place) => place.id), boundedEntry, boundedEntry) as Array<{ placeId: string; alias: string }>;
    const aliasesByPlace = new Map<string, string[]>();
    for (const alias of aliasRows) aliasesByPlace.set(alias.placeId, [...(aliasesByPlace.get(alias.placeId) ?? []), alias.alias]);
    const historyRows = (db.prepare(`${this.relationSelectSql()} WHERE r.revision_id = ? AND r.review_status = 'confirmed'
      AND r.first_revealed_ordinal <= ? ORDER BY r.first_revealed_ordinal, r.created_at`)
      .all(revisionId, boundedEntry) as unknown as PlaceRelationRecord[])
      .filter((relation) => knownPlaceIds.has(relation.sourcePlaceId) && knownPlaceIds.has(relation.targetPlaceId));
    const activeRows = historyRows.filter((relation) => (relation.validFromOrdinal === null || relation.validFromOrdinal <= boundedEntry)
      && (relation.validToOrdinal === null || relation.validToOrdinal >= boundedEntry));
    const revealedIds = historyRows.map((relation) => relation.id);
    const evidence = revealedIds.length === 0 ? [] : db.prepare(`SELECT e.id, e.relation_id AS relationId,
      e.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      e.exact_quote AS exactQuote, e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM place_relation_evidence e JOIN paragraphs p ON p.id = e.paragraph_id
      LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE e.relation_id IN (${revealedIds.map(() => '?').join(',')}) AND p.revision_id = ? AND p.ordinal <= ?
      ORDER BY p.ordinal, e.created_at`).all(...revealedIds, revisionId, boundedEntry) as unknown as PlaceRelationEvidenceRecord[];
    const visibleEvidenceCount = new Map<string, number>();
    for (const item of evidence) visibleEvidenceCount.set(item.relationId, (visibleEvidenceCount.get(item.relationId) ?? 0) + 1);
    const futureEvidenceRows = revealedIds.length === 0 ? [] : db.prepare(`SELECT DISTINCT e.relation_id AS relationId
      FROM place_relation_evidence e JOIN paragraphs p ON p.id = e.paragraph_id
      WHERE e.relation_id IN (${revealedIds.map(() => '?').join(',')}) AND p.revision_id = ? AND p.ordinal > ?`)
      .all(...revealedIds, revisionId, boundedEntry) as Array<{ relationId: string }>;
    const futureEvidenceIds = new Set(futureEvidenceRows.map((row) => row.relationId));
    const knownSourceRows = db.prepare(`SELECT DISTINCT m.identity_id AS identityId FROM person_mentions m
      JOIN paragraphs p ON p.id = m.paragraph_id WHERE m.revision_id = ? AND p.ordinal <= ? AND m.identity_id IS NOT NULL`)
      .all(revisionId, boundedEntry) as Array<{ identityId: string }>;
    const knownSourceIds = new Set(knownSourceRows.map((row) => row.identityId));
    const sanitize = (relation: PlaceRelationRecord): PlaceRelationRecord => {
      let result = { ...relation, evidenceCount: visibleEvidenceCount.get(relation.id) ?? 0 };
      if (result.validToOrdinal !== null && result.validToOrdinal > boundedEntry) result = {
        ...result, validToEventId: null, validToEventTitle: null, validToOrdinal: null,
      };
      if (result.informationSourceType === 'character' && result.informationSourceIdentityId
        && !knownSourceIds.has(result.informationSourceIdentityId)) result = {
        ...result, informationSourceType: 'unknown', informationSourceIdentityId: null, informationSourceName: null,
      };
      if (futureEvidenceIds.has(result.id)) result = { ...result, reasoningNote: '' };
      return result;
    };
    const history = historyRows.map(sanitize);
    const active = activeRows.map(sanitize);
    const pairGroups = new Map<string, PlaceRelationRecord[]>();
    for (const relation of active) {
      const pairKey = this.placeRelationPairKey(relation);
      pairGroups.set(pairKey, [...(pairGroups.get(pairKey) ?? []), relation]);
    }
    const edges: NarrativeMapEdge[] = active.map((relation) => {
      const pairKey = this.placeRelationPairKey(relation);
      return {
        ...relation,
        pairKey,
        topologyClass: this.classifyPlaceRelation(relation.relationKind),
        hasConflict: this.placePairHasConflict(pairGroups.get(pairKey) ?? []),
      };
    });

    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.sourcePlaceId, (degree.get(edge.sourcePlaceId) ?? 0) + 1);
      degree.set(edge.targetPlaceId, (degree.get(edge.targetPlaceId) ?? 0) + 1);
    }
    const componentByPlace = this.placeConnectedComponents(placeRows.map((place) => place.id), edges);
    const parentCandidates = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (edge.topologyClass !== 'hierarchy' || edge.truthStatus !== 'asserted') continue;
      const pair = this.containmentParent(edge);
      if (!pair || pair.parentId === pair.childId || !knownPlaceIds.has(pair.parentId) || !knownPlaceIds.has(pair.childId)) continue;
      const candidates = parentCandidates.get(pair.childId) ?? new Set<string>();
      candidates.add(pair.parentId); parentCandidates.set(pair.childId, candidates);
    }
    const parentByPlace = new Map<string, string>();
    const hierarchyConflicts = new Set<string>();
    for (const [childId, candidates] of parentCandidates) {
      if (candidates.size === 1) parentByPlace.set(childId, [...candidates][0]);
      else hierarchyConflicts.add(childId);
    }
    for (const start of parentByPlace.keys()) {
      const path: string[] = []; const indexById = new Map<string, number>(); let cursor: string | undefined = start;
      while (cursor && parentByPlace.has(cursor)) {
        const cycleAt = indexById.get(cursor);
        if (cycleAt !== undefined) {
          for (const id of path.slice(cycleAt)) hierarchyConflicts.add(id);
          break;
        }
        indexById.set(cursor, path.length); path.push(cursor); cursor = parentByPlace.get(cursor);
      }
    }
    for (const id of hierarchyConflicts) parentByPlace.delete(id);
    const nodes: NarrativeMapNode[] = placeRows.map((place) => ({
      ...place,
      aliases: aliasesByPlace.get(place.id) ?? [],
      importanceScore: Number(place.importanceScore),
      mentionCount: Number(place.mentionCount),
      degree: degree.get(place.id) ?? 0,
      componentId: componentByPlace.get(place.id) ?? 0,
      parentId: parentByPlace.get(place.id) ?? null,
      hierarchyConflict: hierarchyConflicts.has(place.id),
    })).sort((left, right) => right.degree - left.degree || right.importanceScore - left.importanceScore
      || left.name.localeCompare(right.name, 'zh-CN'));

    const eventLocationRows = db.prepare(`SELECT DISTINCT e.id, e.title, e.event_type AS eventType,
      e.narrative_start_ordinal AS narrativeStartOrdinal, e.narrative_end_ordinal AS narrativeEndOrdinal,
      m.place_id AS placeId, l.location_role AS locationRole
      FROM timeline_events e JOIN timeline_event_locations l ON l.event_id = e.id
      JOIN place_mentions m ON m.source_event_location_id = l.id
      JOIN place_identities i ON i.id = m.place_id
      WHERE e.revision_id = ? AND e.review_status = 'confirmed' AND e.narrative_end_ordinal <= ?
      AND l.review_status != 'rejected' AND m.review_status != 'rejected'
      AND i.review_status = 'confirmed' AND i.first_revealed_ordinal <= ?
      AND NOT EXISTS (SELECT 1 FROM timeline_event_evidence future_evidence
        JOIN paragraphs future_paragraph ON future_paragraph.id = future_evidence.paragraph_id
        WHERE future_evidence.event_id = e.id AND future_paragraph.ordinal > ?)
      ORDER BY e.narrative_start_ordinal, e.id, m.place_id`)
      .all(revisionId, boundedEntry, boundedEntry, boundedEntry) as Array<{
        id: string; title: string; eventType: NarrativeMapEventRecord['eventType']; narrativeStartOrdinal: number;
        narrativeEndOrdinal: number; placeId: string; locationRole: NarrativeMapEventRecord['places'][number]['locationRole'];
      }>;
    const eventIds = [...new Set(eventLocationRows.map((row) => row.id))];
    const participantRows = eventIds.length === 0 ? [] : db.prepare(`SELECT p.event_id AS eventId, p.identity_id AS identityId,
      i.canonical_name AS name, p.role FROM timeline_event_participants p
      JOIN person_identities i ON i.id = p.identity_id
      WHERE p.event_id IN (${eventIds.map(() => '?').join(',')}) AND p.review_status != 'rejected'
      AND i.revision_id = ? AND i.review_status = 'confirmed' ORDER BY p.event_id, p.confidence DESC`)
      .all(...eventIds, revisionId) as Array<{
        eventId: string; identityId: string; name: string; role: NarrativeMapEventRecord['participants'][number]['role'];
      }>;
    const eventById = new Map<string, NarrativeMapEventRecord>();
    for (const row of eventLocationRows) {
      const event = eventById.get(row.id) ?? {
        id: row.id, title: row.title, eventType: row.eventType,
        narrativeStartOrdinal: Number(row.narrativeStartOrdinal), narrativeEndOrdinal: Number(row.narrativeEndOrdinal),
        places: [], participants: [],
      };
      if (!event.places.some((place) => place.placeId === row.placeId && place.locationRole === row.locationRole)) {
        event.places.push({ placeId: row.placeId, locationRole: row.locationRole });
      }
      eventById.set(row.id, event);
    }
    for (const row of participantRows) {
      if (!knownSourceIds.has(row.identityId)) continue;
      const event = eventById.get(row.eventId); if (!event) continue;
      if (!event.participants.some((participant) => participant.identityId === row.identityId && participant.role === row.role)) {
        event.participants.push({ identityId: row.identityId, name: row.name, role: row.role });
      }
    }
    const events = [...eventById.values()].sort((left, right) => left.narrativeStartOrdinal - right.narrativeStartOrdinal
      || left.title.localeCompare(right.title, 'zh-CN'));

    return {
      entryOrdinal: boundedEntry,
      maximumOrdinal,
      nodes,
      edges,
      history,
      evidence,
      events,
      revealedRelationCount: history.length,
      temporallyInactiveRelationCount: Math.max(0, history.length - edges.length),
      hierarchyConflictCount: hierarchyConflicts.size,
      coordinateSemantics: 'topology-only',
    };
  }

  reviewRelation(relationId: string, status: PlaceReviewStatus): PlaceRelationRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    const relation = this.getRelation(db, revisionId, relationId);
    if (status === 'confirmed') {
      this.requireConfirmedPlace(db, revisionId, relation.sourcePlaceId);
      this.requireConfirmedPlace(db, revisionId, relation.targetPlaceId);
      const support = db.prepare(`SELECT COUNT(*) AS value FROM place_relation_evidence WHERE relation_id = ? AND evidence_role = 'support'`)
        .get(relationId) as { value: number };
      if (Number(support.value) === 0) throw new Error('正式空间关系缺少支持证据');
    }
    db.prepare(`UPDATE place_relations SET review_status = ?, updated_at = ? WHERE id = ? AND revision_id = ?`)
      .run(status, now(), relationId, revisionId);
    return this.listRelations();
  }

  listRelationEvidence(relationId: string): PlaceRelationEvidenceRecord[] {
    const { db, projectId } = this.store.get(); const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT e.id, e.source_span_id AS sourceSpanId,
      e.relation_id AS relationId, e.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal,
      c.title AS chapterTitle, e.exact_quote AS exactQuote, e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM place_relation_evidence e JOIN place_relations r ON r.id = e.relation_id JOIN paragraphs p ON p.id = e.paragraph_id
      LEFT JOIN chapters c ON c.id = p.chapter_id WHERE e.relation_id = ? AND r.revision_id = ? ORDER BY p.ordinal, e.created_at`)
      .all(relationId, revisionId) as unknown as PlaceRelationEvidenceRecord[];
  }

  private requireConfirmedPlace(db: SQLiteDatabase, revisionId: string, placeId: string): void {
    const row = db.prepare(`SELECT id FROM place_identities WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`)
      .get(placeId, revisionId);
    if (!row) throw new Error('正式空间关系只能引用当前版本中已确认的地点');
  }

  private resolveRelationEventBound(db: SQLiteDatabase, revisionId: string, eventId: string | null, side: 'from' | 'to'):
    { eventId: string | null; ordinal: number | null } {
    if (!eventId) return { eventId: null, ordinal: null };
    const event = db.prepare(`SELECT narrative_start_ordinal AS startOrdinal, narrative_end_ordinal AS endOrdinal
      FROM timeline_events WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`).get(eventId, revisionId) as
      { startOrdinal: number; endOrdinal: number } | undefined;
    if (!event) throw new Error('空间关系有效期只能引用已确认事件');
    return { eventId, ordinal: side === 'from' ? Number(event.startOrdinal) : Number(event.endOrdinal) };
  }

  private relationSelectSql(): string {
    return `SELECT r.id, r.source_place_id AS sourcePlaceId, s.canonical_name AS sourceName,
      r.target_place_id AS targetPlaceId, t.canonical_name AS targetName, r.relation_kind AS relationKind,
      r.direction, r.information_source_type AS informationSourceType,
      r.information_source_identity_id AS informationSourceIdentityId, narrator.canonical_name AS informationSourceName,
      r.truth_status AS truthStatus, r.valid_from_event_id AS validFromEventId, from_event.title AS validFromEventTitle,
      r.valid_to_event_id AS validToEventId, to_event.title AS validToEventTitle,
      r.valid_from_ordinal AS validFromOrdinal, r.valid_to_ordinal AS validToOrdinal,
      r.first_revealed_paragraph_id AS firstRevealedParagraphId, r.first_revealed_ordinal AS firstRevealedOrdinal,
      r.confidence, r.review_status AS reviewStatus, r.extraction_method AS extractionMethod,
      r.candidate_id AS candidateId, r.supersedes_relation_id AS supersedesRelationId, r.reasoning_note AS reasoningNote,
      (SELECT COUNT(*) FROM place_relation_evidence e WHERE e.relation_id = r.id) AS evidenceCount
      FROM place_relations r JOIN place_identities s ON s.id = r.source_place_id
      JOIN place_identities t ON t.id = r.target_place_id
      LEFT JOIN person_identities narrator ON narrator.id = r.information_source_identity_id
      LEFT JOIN timeline_events from_event ON from_event.id = r.valid_from_event_id
      LEFT JOIN timeline_events to_event ON to_event.id = r.valid_to_event_id`;
  }

  private classifyPlaceRelation(relationKind: string): NarrativeMapTopologyClass {
    const kind = relationKind.normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/gu, '_');
    if (/^(contains?|inside|within|in|part_of|belongs?_to|located_in|includes?)$/u.test(kind)
      || /包含|包括|位于|坐落|属于|内部/u.test(kind)) return 'hierarchy';
    if (/route|road|path|passage|connect|through|accessible|entrance|exit|通往|连接|道路|路径|入口|出口/u.test(kind)) return 'connection';
    if (/north|south|east|west|above|below|left|right|upstream|downstream|方向|东|西|南|北|上方|下方|上游|下游/u.test(kind)) return 'direction';
    if (/near|far|distance|adjacent|beside|close|附近|邻近|相邻|远离|距离/u.test(kind)) return 'proximity';
    return 'other';
  }

  private containmentParent(relation: PlaceRelationRecord): { parentId: string; childId: string } | null {
    const kind = relation.relationKind.normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/gu, '_');
    if (/^(contains?|includes?)$/u.test(kind) || /包含|包括/u.test(kind)) {
      return { parentId: relation.sourcePlaceId, childId: relation.targetPlaceId };
    }
    if (/^(inside|within|in|part_of|belongs?_to|located_in)$/u.test(kind) || /位于|坐落|属于|内部/u.test(kind)) {
      return { parentId: relation.targetPlaceId, childId: relation.sourcePlaceId };
    }
    return null;
  }

  private placeRelationPairKey(relation: Pick<PlaceRelationRecord, 'sourcePlaceId' | 'targetPlaceId' | 'direction'>): string {
    if (relation.direction === 'directed') return `${relation.sourcePlaceId}>${relation.targetPlaceId}`;
    return [relation.sourcePlaceId, relation.targetPlaceId].sort().join('~');
  }

  private placePairHasConflict(group: PlaceRelationRecord[]): boolean {
    if (group.length < 2) return false;
    const truthClasses = new Set(group.map((item) => item.truthStatus === 'asserted' ? 'positive'
      : item.truthStatus === 'false' || item.truthStatus === 'disputed' ? 'negative' : 'uncertain'));
    const activeIds = new Set(group.map((item) => item.id));
    return (truthClasses.has('positive') && truthClasses.has('negative'))
      || group.some((item) => item.supersedesRelationId !== null && activeIds.has(item.supersedesRelationId));
  }

  private placeConnectedComponents(placeIds: string[], edges: PlaceRelationRecord[]): Map<string, number> {
    const parent = new Map(placeIds.map((id) => [id, id]));
    const find = (id: string): string => {
      const current = parent.get(id) ?? id;
      if (current === id) return id;
      const root = find(current); parent.set(id, root); return root;
    };
    const union = (left: string, right: string): void => {
      const leftRoot = find(left); const rightRoot = find(right);
      if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
    };
    for (const edge of edges) union(edge.sourcePlaceId, edge.targetPlaceId);
    const componentByRoot = new Map<string, number>(); let nextId = 1;
    return new Map(placeIds.map((id) => {
      const root = find(id);
      if (!componentByRoot.has(root)) componentByRoot.set(root, nextId++);
      return [id, componentByRoot.get(root)!];
    }));
  }

  private getRelation(db: SQLiteDatabase, revisionId: string, relationId: string): PlaceRelationRecord {
    const row = db.prepare(`${this.relationSelectSql()} WHERE r.id = ? AND r.revision_id = ?`).get(relationId, revisionId);
    if (!row) throw new Error('正式空间关系不存在');
    return row as unknown as PlaceRelationRecord;
  }

  listOperations(): PlaceIdentityOperationRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const rows = db.prepare(`SELECT id, operation, description, state, created_at AS createdAt, undone_at AS undoneAt
      FROM place_identity_operations WHERE revision_id = ? ORDER BY id DESC LIMIT 100`).all(revisionId) as unknown as Array<Omit<PlaceIdentityOperationRecord, 'id'> & { id: number }>;
    return rows.map((row) => ({ ...row, id: String(row.id) }));
  }

  undoLatest(): { operation: PlaceIdentityOperationRecord; places: PlaceRecord[] } {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const operation = db.prepare(`SELECT id, operation, description, payload_json AS payloadJson, created_at AS createdAt
      FROM place_identity_operations WHERE revision_id = ? AND state = 'applied' ORDER BY id DESC LIMIT 1`)
      .get(revisionId) as { id: number; operation: PlaceIdentityOperationRecord['operation']; description: string; payloadJson: string; createdAt: string } | undefined;
    if (!operation) throw new Error('没有可以撤销的地点身份操作');
    const payload = JSON.parse(operation.payloadJson) as Record<string, unknown>;
    const timestamp = now();
    withTransaction(db, () => {
      if (operation.operation === 'merge') {
        const sourcePlaceId = String(payload.sourcePlaceId);
        for (const id of payload.movedMentionIds as string[]) db.prepare('UPDATE place_mentions SET place_id = ?, updated_at = ? WHERE id = ?').run(sourcePlaceId, timestamp, id);
        for (const raw of payload.deletedMentions as Array<Record<string, string | number | null>>) this.restoreMention(db, raw);
        for (const id of payload.movedAliasIds as string[]) db.prepare('UPDATE place_aliases SET place_id = ?, updated_at = ? WHERE id = ?').run(sourcePlaceId, timestamp, id);
        for (const raw of payload.deletedAliases as Array<Record<string, string | number | null>>) this.restoreAlias(db, raw);
        if (payload.addedCanonicalAliasId) db.prepare('DELETE FROM place_aliases WHERE id = ?').run(String(payload.addedCanonicalAliasId));
        db.prepare('UPDATE place_identities SET review_status = ?, updated_at = ? WHERE id = ?').run(payload.sourceReviewStatus, timestamp, sourcePlaceId);
        this.recalculatePlace(db, sourcePlaceId, timestamp);
        this.recalculatePlace(db, String(payload.targetPlaceId), timestamp);
      } else if (operation.operation === 'split') {
        const sourcePlaceId = String(payload.sourcePlaceId);
        for (const id of payload.mentionIds as string[]) db.prepare('UPDATE place_mentions SET place_id = ?, updated_at = ? WHERE id = ?').run(sourcePlaceId, timestamp, id);
        db.prepare('DELETE FROM place_identities WHERE id = ?').run(String(payload.newPlaceId));
        this.recalculatePlace(db, sourcePlaceId, timestamp);
      } else if (operation.operation === 'alias_review') {
        db.prepare('UPDATE place_aliases SET review_status = ?, updated_at = ? WHERE id = ?').run(payload.previousStatus, timestamp, payload.aliasId);
      } else {
        db.prepare('DELETE FROM place_identity_links WHERE id = ?').run(payload.linkId);
      }
      db.prepare(`UPDATE place_identity_operations SET state = 'undone', undone_at = ? WHERE id = ?`).run(timestamp, operation.id);
    });
    return {
      operation: { id: String(operation.id), operation: operation.operation, description: operation.description, state: 'undone', createdAt: operation.createdAt, undoneAt: timestamp },
      places: this.listPlaces(),
    };
  }

  review(placeId: string, changes: {
    status: PlaceReviewStatus;
    placeType?: PlaceType;
    canonicalName?: string;
  }): PlaceRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const current = db.prepare('SELECT id, canonical_name AS canonicalName, place_type AS placeType FROM place_identities WHERE id = ? AND revision_id = ?')
      .get(placeId, revisionId) as { id: string; canonicalName: string; placeType: PlaceType } | undefined;
    if (!current) throw new Error('找不到该地点候选');
    const canonicalName = (changes.canonicalName ?? current.canonicalName).trim();
    if (!canonicalName || canonicalName.length > 200) throw new Error('地点名称必须为 1 到 200 个字符');
    const placeType = changes.placeType ?? current.placeType;
    if (!PLACE_TYPES.has(placeType)) throw new Error('地点类型无效');
    const mentionCount = db.prepare('SELECT COUNT(*) AS value FROM place_mentions WHERE place_id = ?').get(placeId) as { value: number };
    if (changes.status === 'confirmed' && Number(mentionCount.value) === 0) throw new Error('地点必须至少有一条可对齐原文的提及才能确认');
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare(`UPDATE place_identities SET canonical_name = ?, normalized_name = ?, place_type = ?,
        review_status = ?, updated_at = ? WHERE id = ? AND revision_id = ?`)
        .run(canonicalName, normalizedName(canonicalName), placeType, changes.status, timestamp, placeId, revisionId);
      db.prepare('UPDATE place_mentions SET review_status = ?, updated_at = ? WHERE place_id = ?')
        .run(changes.status, timestamp, placeId);
      db.prepare('UPDATE place_aliases SET review_status = ?, updated_at = ? WHERE place_id = ?')
        .run(changes.status, timestamp, placeId);
    });
    return this.listPlaces();
  }

  private placeForEdit(db: SQLiteDatabase, revisionId: string, placeId: string): {
    id: string; canonicalName: string; normalizedName: string; placeType: PlaceType; reviewStatus: PlaceReviewStatus;
  } {
    const row = db.prepare(`SELECT id, canonical_name AS canonicalName, normalized_name AS normalizedName,
      place_type AS placeType, review_status AS reviewStatus FROM place_identities WHERE id = ? AND revision_id = ?`)
      .get(placeId, revisionId) as { id: string; canonicalName: string; normalizedName: string; placeType: PlaceType; reviewStatus: PlaceReviewStatus } | undefined;
    if (!row) throw new Error('找不到该地点');
    return row;
  }

  private insertOperation(db: SQLiteDatabase, revisionId: string, operation: PlaceIdentityOperationRecord['operation'], description: string, payload: unknown): void {
    db.prepare(`INSERT INTO place_identity_operations
      (revision_id, operation, description, payload_json, state, created_at)
      VALUES (?, ?, ?, ?, 'applied', ?)`).run(revisionId, operation, description, JSON.stringify(payload), now());
  }

  private recalculatePlace(db: SQLiteDatabase, placeId: string, timestamp: string): void {
    const first = db.prepare(`SELECT m.paragraph_id AS paragraphId, p.ordinal, MAX(m.confidence) OVER () AS importance
      FROM place_mentions m JOIN paragraphs p ON p.id = m.paragraph_id WHERE m.place_id = ?
      ORDER BY p.ordinal, m.char_start LIMIT 1`).get(placeId) as { paragraphId: string; ordinal: number; importance: number } | undefined;
    if (!first) return;
    db.prepare(`UPDATE place_identities SET first_revealed_paragraph_id = ?, first_revealed_ordinal = ?,
      importance_score = ?, updated_at = ? WHERE id = ?`).run(first.paragraphId, first.ordinal, Number(first.importance), timestamp, placeId);
  }

  private restoreMention(db: SQLiteDatabase, raw: Record<string, string | number | null>): void {
    db.prepare(`INSERT OR IGNORE INTO place_mentions
      (id, revision_id, place_id, paragraph_id, surface_text, char_start, char_end, source_event_location_id,
       extraction_method, confidence, review_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(raw.id, raw.revision_id, raw.place_id, raw.paragraph_id, raw.surface_text, raw.char_start, raw.char_end,
        raw.source_event_location_id, raw.extraction_method, raw.confidence, raw.review_status, raw.created_at, raw.updated_at);
  }

  private restoreAlias(db: SQLiteDatabase, raw: Record<string, string | number | null>): void {
    db.prepare(`INSERT OR IGNORE INTO place_aliases
      (id, place_id, alias, normalized_alias, source, review_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(raw.id, raw.place_id, raw.alias, raw.normalized_alias, raw.source, raw.review_status, raw.created_at, raw.updated_at);
  }
}
