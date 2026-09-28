import path from 'node:path';
import type {
  ArtifactFoundationGenerationResult,
  AutomaticFinalizationResult,
  CharacterRelationshipAssertionInput,
  PlayableBundleExportResult,
} from '../../src/shared/contracts';
import { ArtifactFoundationService } from './artifact-foundation-service';
import { PlaceService } from './place-service';
import { PlayableBundleService } from './playable-bundle-service';
import type { ProjectStore } from './project-store';
import { RelationshipService } from './relationship-service';
import type { SQLiteDatabase } from './sqlite-db';
import { TimelineRelationService } from './timeline-relation-service';

const POLICY_VERSION = 'automatic-finalization.v1';
const stamp = () => new Date().toISOString();

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

/** Only pending rows are touched. Existing user decisions and edited card drafts survive reruns. */
export class AutomaticFinalizationService {
  private readonly relationships: RelationshipService;
  private readonly places: PlaceService;
  private readonly timeline: TimelineRelationService;
  private readonly artifacts: ArtifactFoundationService;
  private readonly bundles: PlayableBundleService;

  constructor(private readonly store: ProjectStore) {
    this.relationships = new RelationshipService(store);
    this.places = new PlaceService(store);
    this.timeline = new TimelineRelationService(store);
    this.artifacts = new ArtifactFoundationService(store);
    this.bundles = new PlayableBundleService(store);
  }

  async finalize(selectionRunId: string): Promise<AutomaticFinalizationResult> {
    const { db, projectId, rootPath } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const selection = db.prepare(`SELECT id FROM automation_draft_selection_runs
      WHERE id = ? AND project_id = ? AND revision_id = ? AND state = 'completed'`)
      .get(selectionRunId, projectId, revisionId);
    if (!selection) throw new Error('自动定稿缺少当前修订中已完成的草稿选择结果');

    const time = stamp();
    const counts: Record<string, number> = {};
    const warnings: string[] = [];
    const run = (key: string, sql: string, ...args: unknown[]) => {
      counts[key] = Number(db.prepare(sql).run(...args).changes);
    };

    db.transaction(() => {
      run('selectedCharactersConfirmed', `UPDATE person_identities SET review_status = 'confirmed', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending' AND EXISTS (
          SELECT 1 FROM automation_draft_selection_items s WHERE s.run_id = ? AND s.identity_id = person_identities.id
          AND s.status = 'completed' AND s.selected = 1)`, time, revisionId, selectionRunId);
      run('supportingCharactersConfirmed', `UPDATE person_identities SET review_status = 'confirmed', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending' AND (importance_tier IN ('core','important','minor')
          OR importance_score >= 0.25 OR EXISTS (SELECT 1 FROM person_metrics m
            WHERE m.identity_id = person_identities.id AND m.mention_count >= 2))`, time, revisionId);
      run('weakCharactersExcluded', `UPDATE person_identities SET review_status = 'rejected', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending'`, time, revisionId);
      run('aliasesConfirmed', `UPDATE person_aliases SET review_status = 'confirmed' WHERE revision_id = ?
        AND review_status = 'pending' AND confidence >= 0.45 AND identity_id IN
        (SELECT id FROM person_identities WHERE revision_id = ? AND review_status = 'confirmed')`, revisionId, revisionId);
      run('aliasesExcluded', `UPDATE person_aliases SET review_status = 'rejected'
        WHERE revision_id = ? AND review_status = 'pending'`, revisionId);
      run('identityLinksConfirmed', `UPDATE person_identity_links SET review_status = 'confirmed' WHERE revision_id = ?
        AND review_status = 'pending' AND relation = 'cannot_link' AND confidence >= 0.8`, revisionId);
      run('identityLinksExcluded', `UPDATE person_identity_links SET review_status = 'rejected'
        WHERE revision_id = ? AND review_status = 'pending'`, revisionId);

      run('factsConfirmed', `UPDATE character_facts SET review_status = 'confirmed', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending' AND confidence >= 0.45
        AND identity_id IN (SELECT id FROM person_identities WHERE revision_id = ? AND review_status = 'confirmed')
        AND EXISTS (SELECT 1 FROM character_fact_evidence e WHERE e.fact_id = character_facts.id AND e.evidence_role = 'support')`,
      time, revisionId, revisionId);
      run('factsExcluded', `UPDATE character_facts SET review_status = 'rejected', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending'`, time, revisionId);
      run('factRelationsExcluded', `UPDATE character_fact_relations SET review_status = 'rejected', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending'`, time, revisionId);

      db.prepare(`WITH ranked AS (SELECT a.id, ROW_NUMBER() OVER
        (PARTITION BY a.quote_id, a.role ORDER BY a.confidence DESC, a.created_at, a.id) AS position
        FROM character_quote_attributions a JOIN character_quotes q ON q.id = a.quote_id
        JOIN person_identities i ON i.id = a.identity_id WHERE q.revision_id = ?
        AND a.review_status = 'pending' AND i.review_status = 'confirmed' AND a.confidence >= 0.45)
        UPDATE character_quote_attributions SET review_status = 'confirmed', updated_at = ?
        WHERE id IN (SELECT id FROM ranked WHERE position = 1)`).run(revisionId, time);
      const quoteCount = db.prepare(`SELECT COUNT(*) AS value FROM character_quote_attributions a
        JOIN character_quotes q ON q.id = a.quote_id WHERE q.revision_id = ? AND a.review_status = 'confirmed'`)
        .get(revisionId) as { value: number };
      counts.quoteAttributionsConfirmed = Number(quoteCount.value);
      run('quoteAttributionsExcluded', `UPDATE character_quote_attributions SET review_status = 'rejected', updated_at = ?
        WHERE review_status = 'pending' AND quote_id IN (SELECT id FROM character_quotes WHERE revision_id = ?)`, time, revisionId);

      run('timeExpressionsConfirmed', `UPDATE timeline_time_expressions SET review_status = 'confirmed', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending' AND confidence >= 0.5`, time, revisionId);
      run('timeExpressionsExcluded', `UPDATE timeline_time_expressions SET review_status = 'rejected', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending'`, time, revisionId);
      run('eventsConfirmed', `UPDATE timeline_events SET review_status = 'confirmed', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending' AND confidence >= 0.45
        AND EXISTS (SELECT 1 FROM timeline_event_evidence e WHERE e.event_id = timeline_events.id AND e.evidence_role = 'support')`,
      time, revisionId);
      run('eventsExcluded', `UPDATE timeline_events SET review_status = 'rejected', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending'`, time, revisionId);
      this.resolveEventDetails(db, revisionId, time, counts);

      run('placesConfirmed', `UPDATE place_identities SET review_status = 'confirmed', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending' AND EXISTS
        (SELECT 1 FROM place_mentions m WHERE m.place_id = place_identities.id AND m.confidence >= 0.45)`, time, revisionId);
      run('placesExcluded', `UPDATE place_identities SET review_status = 'rejected', updated_at = ?
        WHERE revision_id = ? AND review_status = 'pending'`, time, revisionId);
      db.prepare(`UPDATE place_mentions SET review_status = CASE WHEN confidence >= 0.45 AND place_id IN
        (SELECT id FROM place_identities WHERE revision_id = ? AND review_status = 'confirmed')
        THEN 'confirmed' ELSE 'rejected' END, updated_at = ? WHERE review_status = 'pending'
        AND place_id IN (SELECT id FROM place_identities WHERE revision_id = ?)`).run(revisionId, time, revisionId);
      run('placeAliasesConfirmed', `UPDATE place_aliases SET review_status = 'confirmed', updated_at = ?
        WHERE review_status = 'pending' AND place_id IN
        (SELECT id FROM place_identities WHERE revision_id = ? AND review_status = 'confirmed')`, time, revisionId);
      db.prepare(`UPDATE place_aliases SET review_status = 'rejected', updated_at = ? WHERE review_status = 'pending'
        AND place_id IN (SELECT id FROM place_identities WHERE revision_id = ?)`).run(time, revisionId);
      db.prepare(`UPDATE place_identity_links SET review_status = CASE WHEN relation = 'cannot_link' AND confidence >= 0.8
        THEN 'confirmed' ELSE 'rejected' END WHERE revision_id = ? AND review_status = 'pending'`).run(revisionId);
    });

    this.finalizeTimeline(db, revisionId, warnings);
    this.finalizeRelationships(db, revisionId, warnings);
    this.finalizePlaceRelations(db, revisionId, warnings);
    const entryEvent = this.chooseEntry(db, revisionId);
    let artifactGeneration: ArtifactFoundationGenerationResult | null = null;
    let playableBundle: PlayableBundleExportResult | null = null;
    if (!entryEvent) warnings.push('没有足够可靠的事件可作为默认进入点，地图与图谱数据已定稿，但未生成角色卡整合包。');
    else {
      try {
        artifactGeneration = this.artifacts.generate(entryEvent.id);
        const generated = artifactGeneration.characterCards.results.filter((item) => item.status === 'generated').map((item) => item.identityId);
        if (generated.length) db.prepare(`UPDATE character_card_drafts SET review_status = 'reviewed', updated_at = ?
          WHERE revision_id = ? AND review_status = 'draft' AND identity_id IN (${generated.map(() => '?').join(',')})`)
          .run(stamp(), revisionId, ...generated);
        artifactGeneration = { ...artifactGeneration, dashboard: this.artifacts.status(entryEvent.id) };
        const blocked = artifactGeneration.dashboard.gates.filter((gate) => !gate.exportReady);
        if (!blocked.length) playableBundle = await this.bundles.export(entryEvent.id, path.join(rootPath, 'exports'));
        else warnings.push(`三类成品数据已生成；${blocked.map((gate) => gate.title).join('、')}仍有质量提示，暂未自动导出可游玩包。`);
      } catch (error) { warnings.push(`三类成品生成未完全结束：${error instanceof Error ? error.message : String(error)}`); }
    }
    const result: AutomaticFinalizationResult = { policyVersion: POLICY_VERSION, revisionId, selectionRunId,
      finalizedAt: stamp(), counts, entryEvent, artifactGeneration, playableBundle, warnings };
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(`automatic-finalization:${revisionId}`, JSON.stringify(result), result.finalizedAt);
    return result;
  }

  private resolveEventDetails(db: SQLiteDatabase, revisionId: string, time: string, counts: Record<string, number>): void {
    counts.eventParticipantsConfirmed = Number(db.prepare(`UPDATE timeline_event_participants
      SET review_status = 'confirmed', updated_at = ? WHERE review_status = 'pending' AND confidence >= 0.45
      AND event_id IN (SELECT id FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed')`)
      .run(time, revisionId).changes);
    db.prepare(`UPDATE timeline_event_participants SET review_status = 'rejected', updated_at = ? WHERE review_status = 'pending'
      AND event_id IN (SELECT id FROM timeline_events WHERE revision_id = ?)`).run(time, revisionId);
    counts.eventLocationsConfirmed = Number(db.prepare(`UPDATE timeline_event_locations SET review_status = 'confirmed', updated_at = ?
      WHERE review_status = 'pending' AND confidence >= 0.45 AND event_id IN
      (SELECT id FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed')`).run(time, revisionId).changes);
    db.prepare(`UPDATE timeline_event_locations SET review_status = 'rejected', updated_at = ? WHERE review_status = 'pending'
      AND event_id IN (SELECT id FROM timeline_events WHERE revision_id = ?)`).run(time, revisionId);
    counts.eventTimeLinksConfirmed = Number(db.prepare(`UPDATE timeline_event_time_links SET review_status = 'confirmed', updated_at = ?
      WHERE review_status = 'pending' AND confidence >= 0.5
      AND event_id IN (SELECT id FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed')
      AND time_expression_id IN (SELECT id FROM timeline_time_expressions WHERE revision_id = ? AND review_status = 'confirmed')`)
      .run(time, revisionId, revisionId).changes);
    db.prepare(`UPDATE timeline_event_time_links SET review_status = 'rejected', updated_at = ? WHERE review_status = 'pending'
      AND event_id IN (SELECT id FROM timeline_events WHERE revision_id = ?)`).run(time, revisionId);
  }

  private finalizeTimeline(db: SQLiteDatabase, revisionId: string, warnings: string[]): void {
    this.timeline.consolidate();
    const rows = db.prepare(`SELECT id, relation, confidence FROM timeline_event_relations
      WHERE revision_id = ? AND review_status = 'pending' ORDER BY confidence DESC, created_at, id`).all(revisionId) as Array<{
        id: string; relation: 'before' | 'after' | 'simultaneous' | 'includes' | 'is_included' | 'unknown'; confidence: number;
      }>;
    for (const row of rows) {
      if (row.relation === 'unknown' || Number(row.confidence) < 0.72) {
        this.timeline.reviewRelation(row.id, 'rejected');
        continue;
      }
      try { this.timeline.reviewRelation(row.id, 'confirmed', row.relation); }
      catch (error) {
        this.timeline.reviewRelation(row.id, 'rejected');
        warnings.push(`已排除一条会造成时间循环的事件关系：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private finalizeRelationships(db: SQLiteDatabase, revisionId: string, warnings: string[]): void {
    const identities = new Set((db.prepare(`SELECT id FROM person_identities WHERE revision_id = ? AND review_status = 'confirmed'`)
      .all(revisionId) as Array<{ id: string }>).map((row) => row.id));
    const events = new Set((db.prepare(`SELECT id FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed'`)
      .all(revisionId) as Array<{ id: string }>).map((row) => row.id));
    for (const candidate of this.relationships.listCandidates('pending')) {
      const evidence = this.relationships.listCandidateEvidence(candidate.id).filter((item): item is typeof item & {
        evidenceRole: 'support' | 'context' | 'contradict';
      } => item.evidenceRole !== 'clue');
      const acceptable = Boolean(candidate.proposedType?.trim()) && Number(candidate.confidence) >= 0.55
        && identities.has(candidate.sourceIdentityId) && identities.has(candidate.targetIdentityId)
        && evidence.some((item) => item.evidenceRole === 'support');
      if (!acceptable) { this.relationships.reviewCandidate(candidate.id, 'rejected'); continue; }
      try {
        this.relationships.reviewCandidate(candidate.id, 'confirmed');
        const suggestion = this.relationships.getModelSuggestion(candidate.id);
        const characterSource = suggestion?.informationSourceType === 'character'
          && suggestion.informationSourceIdentityId && identities.has(suggestion.informationSourceIdentityId);
        const input: CharacterRelationshipAssertionInput = {
          sourceIdentityId: candidate.sourceIdentityId, targetIdentityId: candidate.targetIdentityId,
          relationshipType: candidate.proposedType!, direction: suggestion?.direction ?? 'undirected',
          strength: suggestion?.strength ?? null, polarity: suggestion?.polarity ?? null,
          informationSourceType: characterSource ? 'character' : suggestion?.informationSourceType === 'unknown' ? 'unknown' : 'narrator',
          informationSourceIdentityId: characterSource ? suggestion!.informationSourceIdentityId : null,
          truthStatus: suggestion?.truthStatus ?? 'asserted',
          validFromEventId: suggestion?.validFromEventId && events.has(suggestion.validFromEventId) ? suggestion.validFromEventId : null,
          validToEventId: suggestion?.validToEventId && events.has(suggestion.validToEventId) ? suggestion.validToEventId : null,
          confidence: Number(candidate.confidence), extractionMethod: candidate.candidateMethod === 'model' ? 'model' : 'rule',
          candidateId: candidate.id, reasoningNote: suggestion?.reasoningNote ?? '',
          evidence: evidence.map((item) => ({ paragraphId: item.paragraphId, exactQuote: item.exactQuote, role: item.evidenceRole })),
        };
        const relationship = this.relationships.createRelationship(input);
        this.relationships.reviewRelationship(relationship.id, 'confirmed');
      } catch (error) {
        db.prepare(`UPDATE character_relationship_candidates SET review_status = 'rejected', updated_at = ? WHERE id = ?`)
          .run(stamp(), candidate.id);
        warnings.push(`未采用关系候选“${candidate.sourceName}—${candidate.targetName}”：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    db.prepare(`UPDATE character_relationships SET review_status = CASE WHEN confidence >= 0.55 AND candidate_id IN
      (SELECT id FROM character_relationship_candidates WHERE revision_id = ? AND review_status = 'confirmed')
      THEN 'confirmed' ELSE 'rejected' END, updated_at = ? WHERE revision_id = ? AND review_status = 'pending'`)
      .run(revisionId, stamp(), revisionId);
  }

  private finalizePlaceRelations(db: SQLiteDatabase, revisionId: string, warnings: string[]): void {
    for (const candidate of this.places.listRelationCandidates('pending')) {
      const evidence = this.places.listRelationCandidateEvidence(candidate.id);
      const acceptable = Boolean(candidate.proposedRelationKind?.trim()) && Number(candidate.confidence) >= 0.6
        && evidence.some((item) => item.evidenceRole === 'support');
      if (!acceptable) { this.places.reviewRelationCandidate(candidate.id, 'rejected'); continue; }
      try {
        this.places.reviewRelationCandidate(candidate.id, 'confirmed');
        const relation = this.places.createRelationFromCandidate(candidate.id);
        this.places.reviewRelation(relation.id, 'confirmed');
      } catch (error) {
        db.prepare(`UPDATE place_relation_candidates SET review_status = 'rejected', updated_at = ? WHERE id = ?`)
          .run(stamp(), candidate.id);
        warnings.push(`已排除一条无法形成正式地图边的空间候选：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    db.prepare(`UPDATE place_relations SET review_status = CASE WHEN confidence >= 0.6 AND candidate_id IN
      (SELECT id FROM place_relation_candidates WHERE revision_id = ? AND review_status = 'confirmed')
      THEN 'confirmed' ELSE 'rejected' END, updated_at = ? WHERE revision_id = ? AND review_status = 'pending'`)
      .run(revisionId, stamp(), revisionId);
  }

  private chooseEntry(db: SQLiteDatabase, revisionId: string): { id: string; title: string; narrativeOrdinal: number } | null {
    const row = db.prepare(`SELECT e.id, e.title, e.narrative_start_ordinal AS narrativeOrdinal,
      (SELECT COUNT(DISTINCT f.identity_id) FROM character_facts f JOIN person_identities i ON i.id = f.identity_id
        LEFT JOIN character_fact_claim_metadata m ON m.fact_id = f.id WHERE f.revision_id = e.revision_id
        AND f.review_status = 'confirmed' AND i.review_status = 'confirmed' AND i.importance_tier IN ('core','important')
        AND COALESCE(m.truth_status, 'asserted') = 'asserted'
        AND COALESCE(f.valid_from_ordinal, 0) <= e.narrative_start_ordinal) AS castCoverage
      FROM timeline_events e WHERE e.revision_id = ? AND e.review_status = 'confirmed'
      ORDER BY castCoverage DESC, e.narrative_start_ordinal, e.narrative_end_ordinal, e.id LIMIT 1`).get(revisionId) as
      { id: string; title: string; narrativeOrdinal: number } | undefined;
    return row ?? null;
  }
}
