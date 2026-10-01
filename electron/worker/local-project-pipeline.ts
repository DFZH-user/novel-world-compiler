import { createHash } from 'node:crypto';
import path from 'node:path';
import { chunkSettingsSchema, type FoundationWorkflowRunRecord } from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import { EditorService } from './editor-service';
import { QuoteService } from './quote-service';
import { FactConsolidationService } from './fact-consolidation-service';
import { TimelineService } from './timeline-service';
import { TimelineRelationService } from './timeline-relation-service';
import { RelationshipService } from './relationship-service';
import { ArtifactFoundationService } from './artifact-foundation-service';
import { CharacterCardService } from './character-card-service';
import { PlayableBundleService } from './playable-bundle-service';
import { LOCAL_PIPELINE_VERSION, activeLocalPipeline } from './local-pipeline-context';
import { rankLocalPassages } from './local-text-rank';
import { sampleEvenly } from '../../src/shared/foundation-profile';

const id = (kind: string, value: string) => `lp2_${kind}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
const now = () => new Date().toISOString();
type Entity = { name: string; kind: string };
type Evidence = { paragraphId: string; ordinal: number; start: number; end: number; text: string };

/** The same project records used by the workbench and Tavern. No model or network dependency. */
export class LocalProjectPipeline {
  constructor(private readonly store: ProjectStore) {}

  private job(key: string, type: string) {
    const { db, projectId } = this.store.get();
    const jobId = id('job', key), stamp = now();
    db.prepare(`INSERT OR IGNORE INTO jobs(id, project_id, type, state, progress, message, input_json, created_at, updated_at)
      VALUES (?, ?, ?, 'completed', 1, '极低档本地规则处理完成，API 用量为 0', ?, ?, ?)`).run(jobId, projectId, type,
        JSON.stringify({ algorithm: LOCAL_PIPELINE_VERSION }), stamp, stamp);
    return jobId;
  }
  private evidence(runId: string, name: string, limit = 12): Evidence[] {
    const { db } = this.store.get();
    const offsets = db.prepare(`SELECT v.paragraph_id AS paragraphId, v.ordinal, v.start_offset AS start,
      v.end_offset AS end FROM local_foundation_evidence v JOIN paragraphs p ON p.id = v.paragraph_id
      WHERE v.run_id = ? AND v.name = ? AND NOT EXISTS
        (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1)
      ORDER BY v.ordinal`).all(runId, name) as Array<Omit<Evidence, 'text'>>;
    return sampleEvenly(offsets, limit).map(offset => ({ ...offset, text: (db.prepare('SELECT text FROM paragraphs WHERE id = ?').get(offset.paragraphId) as { text: string }).text }));
  }
  peopleAndFacts(run: FoundationWorkflowRunRecord) {
    const { db, projectId } = this.store.get(), revisionId = run.revisionId, stamp = now();
    const editor = new EditorService(this.store);
    let chunks = editor.listChunks();
    if (!chunks.length) chunks = editor.buildChunks(chunkSettingsSchema.parse({}));
    const plan = db.prepare('SELECT id FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1').get(revisionId) as { id: string };
    const scanId = id('scan', run.id);
    db.prepare(`INSERT OR IGNORE INTO character_scan_runs(id, project_id, revision_id, chunk_plan_id, job_id,
      model, prompt_version, input_hash, status, total_chunks, completed_chunks, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'local-script', ?, ?, 'completed', ?, ?, ?, ?)`).run(scanId, projectId, revisionId, plan.id,
        this.job(`${run.id}:scan`, 'character-scan'), LOCAL_PIPELINE_VERSION, run.inputHash, chunks.length, chunks.length, stamp, stamp);
    db.prepare(`INSERT OR IGNORE INTO character_chunk_results(run_id, chunk_id, status, input_hash, raw_json, updated_at)
      SELECT ?, id, 'completed', ?, ?, ? FROM chunks WHERE plan_id = ?`).run(scanId, run.inputHash,
        JSON.stringify({ method: LOCAL_PIPELINE_VERSION, evidenceOnly: true, apiRequests: 0 }), stamp, plan.id);
    const entities = db.prepare("SELECT name, kind FROM local_foundation_entities WHERE run_id = ? AND kind = 'person' AND selected = 1 ORDER BY seeded DESC, sightings DESC, name")
      .all(run.id) as Entity[];
    const identities: string[] = [];
    db.transaction(() => {
      for (const entity of entities) {
        const candidates = this.evidence(run.id, entity.name, 64);
        const ranked = rankLocalPassages(candidates.map(e => ({ ...e, fullText: e.text, text: e.text.slice(e.start, e.end) })), 11);
        const evidence = [candidates[0], ...ranked.map(e => ({ ...e, text: e.fullText }))]
          .filter((e, index, all) => e && all.findIndex(other => other?.paragraphId === e.paragraphId) === index).sort((a, b) => a.ordinal - b.ordinal);
        if (!evidence.length) continue;
        const normalized = entity.name.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
        let identity = db.prepare('SELECT id, review_status AS status FROM person_identities WHERE revision_id = ? AND normalized_name = ? ORDER BY created_at LIMIT 1')
          .get(revisionId, normalized) as { id: string; status: string } | undefined;
        if (identity?.status === 'rejected') continue;
        if (!identity) {
          identity = { id: id('person', `${revisionId}:${normalized}`), status: 'confirmed' };
          db.prepare(`INSERT INTO person_identities(id, revision_id, canonical_name, normalized_name, importance_tier, importance_score,
            review_status, uncertainty, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0.5, 'confirmed', ?, ?, ?)`)
            .run(identity.id, revisionId, entity.name, normalized, identities.length ? 'important' : 'core',
              '极低档本地姓名匹配；基础可用，可继续审核身份和别名', stamp, stamp);
        } else if (identity.status === 'pending') {
          db.prepare("UPDATE person_identities SET review_status = 'confirmed', uncertainty = uncertainty || '；本地姓名匹配基础稿', updated_at = ? WHERE id = ?")
            .run(stamp, identity.id);
        }
        identities.push(identity.id);
        const existingTier = db.prepare('SELECT importance_tier AS tier FROM person_identities WHERE id = ?').get(identity.id) as { tier: string };
        if (existingTier.tier === 'pending' && !db.prepare('SELECT 1 FROM person_manual_tiers WHERE identity_id = ?').get(identity.id)) {
          db.prepare("UPDATE person_identities SET importance_tier = 'important', updated_at = ? WHERE id = ?").run(stamp, identity.id);
        }
        db.prepare(`INSERT OR IGNORE INTO person_mentions(id, revision_id, run_id, chunk_id, identity_id, paragraph_id,
          surface_text, mention_type, exact_quote, supports, has_dialogue, participates_in_event, confidence, alignment_status, created_at)
          SELECT ? || p.id, ?, ?, c.id, ?, p.id, ?, 'name', ?, '本地脚本逐字匹配姓名', 0, 0, 0.55, 'exact', ?
          FROM local_foundation_evidence v JOIN paragraphs p ON p.id = v.paragraph_id
          JOIN chunks c ON c.plan_id = ? AND p.ordinal BETWEEN c.core_start_ordinal AND c.core_end_ordinal
          WHERE v.run_id = ? AND v.name = ? AND NOT EXISTS
          (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1)`)
          .run(`lp2_mention_${identity.id}_`, revisionId, scanId, identity.id, entity.name, entity.name, stamp, plan.id, run.id, entity.name);
        db.prepare(`INSERT INTO person_metrics(identity_id, mention_count, chapter_count, first_ordinal, last_ordinal, updated_at)
          SELECT ?, COUNT(DISTINCT p.id), COUNT(DISTINCT p.chapter_id), MIN(p.ordinal), MAX(p.ordinal), ? FROM person_mentions m
          JOIN paragraphs p ON p.id = m.paragraph_id WHERE m.identity_id = ?
          ON CONFLICT(identity_id) DO UPDATE SET mention_count = excluded.mention_count, chapter_count = excluded.chapter_count,
            first_ordinal = excluded.first_ordinal, last_ordinal = excluded.last_ordinal, updated_at = excluded.updated_at`).run(identity.id, stamp, identity.id);
        const factRunId = id('facts', `${run.id}:${identity.id}`);
        db.prepare(`INSERT OR IGNORE INTO character_fact_runs(id, project_id, revision_id, identity_id, job_id, model,
          prompt_version, input_hash, status, total_batches, completed_batches, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'local-script', ?, ?, 'completed', 1, 1, ?, ?)`).run(factRunId, projectId, revisionId, identity.id,
            this.job(`${run.id}:${identity.id}:facts`, 'character-facts'), LOCAL_PIPELINE_VERSION, run.inputHash, stamp, stamp);
        db.prepare(`INSERT OR IGNORE INTO character_fact_batches(run_id, batch_ordinal, paragraph_ids_json, input_hash, status, raw_json, updated_at)
          VALUES (?, 0, ?, ?, 'completed', ?, ?)`).run(factRunId, JSON.stringify(evidence.map(e => e.paragraphId)), run.inputHash,
            JSON.stringify({ method: LOCAL_PIPELINE_VERSION, evidenceOnly: true }), stamp);
        const addFact = (key: string, predicate: string, value: string, source: Evidence, quote: string) => {
          const factId = id('fact', `${revisionId}:${identity!.id}:${key}`);
          db.prepare(`INSERT OR IGNORE INTO character_facts(id, revision_id, identity_id, run_id, batch_ordinal, category, predicate, value,
            source_type, confidence, visibility, valid_from_ordinal, review_status, reasoning_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, 0, 'background', ?, ?, 'generated', 0.55, 'public', ?, 'confirmed', ?, ?, ?)`)
            .run(factId, revisionId, identity!.id, factRunId, predicate, value, source.ordinal,
              '极低档：确认的是原文提及，不推断性格、内心或人物知情范围。', stamp, stamp);
          db.prepare(`INSERT OR IGNORE INTO character_fact_evidence(id, fact_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
            VALUES (?, ?, ?, ?, 'support', 'exact', ?)`).run(id('evidence', factId), factId, source.paragraphId, quote, stamp);
        };
        addFact('name', '原文姓名', entity.name, evidence[0], entity.name);
        for (const e of evidence) {
          const quote = e.text.slice(e.start, e.end);
          addFact(`paragraph:${e.paragraphId}`, `原文提及（第${e.ordinal}段）`, quote, e, quote);
        }
      }
      if (!identities.length) throw new Error('没有可接入工程的本地人物；请补充人名后重新生成');
      const selectionId = id('selection', run.id);
      db.prepare(`INSERT OR IGNORE INTO automation_draft_selection_runs(id, project_id, revision_id, job_id, profile, policy_version,
        input_hash, state, total_candidates, processed_candidates, selected_count, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'local', ?, ?, 'completed', ?, ?, ?, '本地规则已选择基础角色集合', ?, ?)`).run(selectionId,
          projectId, revisionId, this.job(`${run.id}:selection`, 'automation-draft-selection'), LOCAL_PIPELINE_VERSION,
          run.inputHash, identities.length, identities.length, identities.length, stamp, stamp);
      identities.forEach((identityId, ordinal) => {
        const person = db.prepare('SELECT canonical_name AS name FROM person_identities WHERE id = ?').get(identityId) as { name: string };
        db.prepare(`INSERT OR IGNORE INTO automation_draft_selection_items(run_id, identity_id, ordinal, identity_name,
          input_snapshot_json, input_hash, status, selected, reason_code, reason, review_status_snapshot, importance_tier_snapshot,
          importance_score_snapshot, mention_count_snapshot, updated_at)
          VALUES (?, ?, ?, ?, '{}', ?, 'completed', 1, 'fallback-with-evidence', '本地重复提及或补充姓名，有原文支持', 'confirmed', 'important', 0.5, 1, ?)`)
          .run(selectionId, identityId, ordinal, person.name, run.inputHash, stamp);
      });
      db.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(`local-pipeline:${revisionId}`, JSON.stringify({ runId: run.id, identityIds: identities }), stamp);
    });
    const consolidation = new FactConsolidationService(this.store).consolidate();
    return { people: identities.length, consolidation };
  }

  dialogue() {
    const quotes = new QuoteService(this.store);
    const scan = quotes.scan();
    const turns = quotes.analyzeLocalTurns();
    return { scan, turns };
  }
  time() { return new TimelineService(this.store).scanTimeExpressions(); }

  eventsAndPlaces(run: FoundationWorkflowRunRecord) {
    const { db, projectId } = this.store.get(), revisionId = run.revisionId, stamp = now();
    const context = activeLocalPipeline(db, revisionId);
    if (!context) throw new Error('缺少本地人物集合');
    const plan = db.prepare('SELECT id FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1').get(revisionId) as { id: string };
    const chunks = db.prepare('SELECT id FROM chunks WHERE plan_id = ?').all(plan.id) as { id: string }[];
    const eventRunId = id('event-run', run.id);
    const chapters = db.prepare('SELECT id, title, paragraph_start AS start, paragraph_end AS end FROM chapters WHERE revision_id = ? ORDER BY ordinal')
      .all(revisionId) as Array<{ id: string; title: string; start: number; end: number }>;
    const last = db.prepare(`SELECT p.id AS paragraphId, p.ordinal, 0 AS start, MIN(LENGTH(p.text), 260) AS end, p.text
      FROM paragraphs p WHERE revision_id = ? AND NOT EXISTS
      (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1) ORDER BY ordinal DESC LIMIT 1`).get(revisionId) as Evidence;
    let eventCount = 0, placeCount = 0;
    const addEvent = (e: Evidence, title: string, anchor: boolean) => {
      const eventId = id('event', `${revisionId}:${e.paragraphId}`), quote = e.text.slice(e.start, e.end);
      db.prepare(`INSERT OR IGNORE INTO timeline_events(id, revision_id, title, summary, event_type, narrative_start_ordinal,
        narrative_end_ordinal, extraction_method, confidence, review_status, uncertainty, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'other', ?, ?, 'rule', 0.55, 'confirmed', ?, ?, ?)`).run(eventId, revisionId, title, quote, e.ordinal, e.ordinal,
          anchor ? '本地原文入口锚点；不等于绝对故事时间或语义事件' : '原文场景摘录；人物和地点仅表示在文本中提及', stamp, stamp);
      db.prepare(`INSERT OR IGNORE INTO timeline_event_evidence(id, event_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
        VALUES (?, ?, ?, ?, 'support', 'exact', ?)`).run(id('event-evidence', eventId), eventId, e.paragraphId, quote, stamp);
      db.prepare(`INSERT OR IGNORE INTO timeline_event_sources(event_id, run_id, chunk_id, local_key, created_at)
        SELECT ?, ?, id, ?, ? FROM chunks WHERE plan_id = ? AND ? BETWEEN core_start_ordinal AND core_end_ordinal`)
        .run(eventId, eventRunId, e.paragraphId, stamp, plan.id, e.ordinal);
      for (const identityId of context.identityIds) {
        const person = db.prepare('SELECT canonical_name AS name FROM person_identities WHERE id = ?').get(identityId) as { name: string };
        if (!quote.includes(person.name)) continue;
        db.prepare(`INSERT OR IGNORE INTO timeline_event_participants(id, event_id, identity_id, surface_name, role, action_text,
          confidence, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'other', '原文提及，未推断参与动作', 0.55, 'confirmed', ?, ?)`)
          .run(id('participant', `${eventId}:${identityId}`), eventId, identityId, person.name, stamp, stamp);
      }
      db.prepare(`INSERT OR IGNORE INTO timeline_event_time_links(id, event_id, time_expression_id, relation, confidence, review_status, created_at, updated_at)
        SELECT ? || t.id, ?, t.id, 'occurs_at', 0.5, 'pending', ?, ? FROM timeline_time_expressions t WHERE t.paragraph_id = ? AND t.review_status != 'rejected'`)
        .run(`lp2_link_${eventId}_`, eventId, stamp, stamp, e.paragraphId);
      eventCount++;
      return eventId;
    };
    db.transaction(() => {
      db.prepare(`INSERT OR IGNORE INTO timeline_event_runs(id, project_id, revision_id, chunk_plan_id, job_id, model,
        prompt_version, input_hash, status, total_chunks, completed_chunks, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'local-script', ?, ?, 'completed', ?, ?, ?, ?)`).run(eventRunId, projectId, revisionId,
          plan.id, this.job(`${run.id}:events`, 'timeline-events'), LOCAL_PIPELINE_VERSION, run.inputHash, chunks.length, chunks.length, stamp, stamp);
      db.prepare(`INSERT OR IGNORE INTO timeline_event_chunk_results(run_id, chunk_id, status, input_hash, raw_json, updated_at)
        SELECT ?, id, 'completed', ?, ?, ? FROM chunks WHERE plan_id = ?`).run(eventRunId, run.inputHash,
          JSON.stringify({ method: LOCAL_PIPELINE_VERSION, kind: 'extractive-chapter-scenes', apiRequests: 0 }), stamp, plan.id);
      for (const chapter of chapters) {
        const offsets = db.prepare(`SELECT p.id AS paragraphId, p.ordinal
          FROM paragraphs p WHERE revision_id = ? AND ordinal BETWEEN ? AND ?
          AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1)
          AND EXISTS (SELECT 1 FROM person_mentions m WHERE m.paragraph_id = p.id AND m.identity_id IN (SELECT value FROM json_each(?)))
          ORDER BY p.ordinal`).all(revisionId, chapter.start, chapter.end, JSON.stringify(context.identityIds)) as Array<{ paragraphId: string; ordinal: number }>;
        const rows: Evidence[] = sampleEvenly(offsets, 64).map(e => {
          const { text } = db.prepare('SELECT text FROM paragraphs WHERE id = ?').get(e.paragraphId) as { text: string };
          return { ...e, start: 0, end: Math.min(text.length, 260), text };
        });
        const ranked = rankLocalPassages(rows.map(e => ({ ...e, fullText: e.text, text: e.text.slice(0, 260) })), 3);
        for (const e of ranked.sort((a, b) => a.ordinal - b.ordinal)) addEvent({ ...e, text: e.fullText }, `章节场景｜${chapter.title}｜第${e.ordinal}段`, true);
      }
      const places = db.prepare("SELECT name, kind FROM local_foundation_entities WHERE run_id = ? AND selected = 1 AND kind = 'place'").all(run.id) as Entity[];
      for (const place of places) {
        const evidence = this.evidence(run.id, place.name, 6);
        if (!evidence.length) continue;
        const existing = db.prepare('SELECT id, review_status AS status FROM place_identities WHERE revision_id = ? AND canonical_name = ? ORDER BY created_at LIMIT 1')
          .get(revisionId, place.name) as { id: string; status: string } | undefined;
        if (existing?.status === 'rejected') continue;
        const placeId = existing?.id ?? id('place', `${revisionId}:${place.name}`);
        db.prepare(`INSERT OR IGNORE INTO place_identities(id, revision_id, canonical_name, normalized_name, place_type, description,
          importance_score, first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method, source_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'other', ?, 0.5, ?, ?, 'confirmed', 'rule', ?, ?, ?)`)
          .run(placeId, revisionId, place.name, place.name.normalize('NFKC'), '极低档地点名称匹配；位置和坐标未知', evidence[0].paragraphId,
            evidence[0].ordinal, id('place-source', `${revisionId}:${place.name}`), stamp, stamp);
        if (existing?.status === 'pending') db.prepare("UPDATE place_identities SET review_status = 'confirmed', updated_at = ? WHERE id = ?").run(stamp, placeId);
        for (const e of evidence) {
          const start = e.text.indexOf(place.name);
          if (start < 0) continue;
          const eventId = addEvent(e, `地点提及｜${place.name}｜第${e.ordinal}段`, false);
          const locationId = id('location', `${eventId}:${placeId}`);
          db.prepare(`INSERT OR IGNORE INTO timeline_event_locations(id, event_id, surface_name, normalized_name, location_role,
            confidence, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'mentioned', 0.55, 'confirmed', ?, ?)`)
            .run(locationId, eventId, place.name, place.name, stamp, stamp);
          db.prepare(`INSERT OR IGNORE INTO place_mentions(id, revision_id, place_id, paragraph_id, surface_text, char_start, char_end,
            source_event_location_id, extraction_method, confidence, review_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'rule', 0.55, 'confirmed', ?, ?)`).run(id('place-mention', `${placeId}:${e.paragraphId}`),
              revisionId, placeId, e.paragraphId, place.name, start, start + place.name.length, locationId, stamp, stamp);
        }
        placeCount++;
      }
      // An unidentified scene is explicitly a placeholder, never an invented city or coordinate.
      if (!db.prepare("SELECT 1 FROM place_identities WHERE revision_id = ? AND review_status = 'confirmed' LIMIT 1").get(revisionId)) {
        const first = db.prepare(`SELECT id, ordinal FROM paragraphs p WHERE revision_id = ? AND NOT EXISTS
          (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1) ORDER BY ordinal LIMIT 1`).get(revisionId) as { id: string; ordinal: number };
        db.prepare(`INSERT OR IGNORE INTO place_identities(id, revision_id, canonical_name, normalized_name, place_type, description,
          importance_score, first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method, source_fingerprint, created_at, updated_at)
          VALUES (?, ?, '未定位场景', '未定位场景', 'other', '本地入口占位：原文尚无可靠地点名，位置、坐标与空间关系未知。',
          0.1, ?, ?, 'confirmed', 'rule', ?, ?, ?)`).run(id('unknown-place', revisionId), revisionId, first.id, first.ordinal,
            id('unknown-place-source', revisionId), stamp, stamp);
      }
      const entryEventId = addEvent(last, `本地资料入口｜截至原文第${last.ordinal}段（可另选较早章节）`, true);
      db.prepare('UPDATE settings SET value_json = ?, updated_at = ? WHERE key = ?')
        .run(JSON.stringify({ ...context, entryEventId }), stamp, `local-pipeline:${revisionId}`);
    });
    const timeline = new TimelineRelationService(this.store).consolidate();
    return { eventCount, placeCount, timeline };
  }

  relationships(run: FoundationWorkflowRunRecord) {
    const { db } = this.store.get();
    const context = activeLocalPipeline(db, run.revisionId);
    if (!context) throw new Error('缺少本地人物集合');
    const service = new RelationshipService(this.store);
    let count = 0;
    for (let a = 0; a < context.identityIds.length; a++) for (let b = a + 1; b < context.identityIds.length; b++) {
      const source = context.identityIds[a], target = context.identityIds[b];
      const evidence = db.prepare(`SELECT p.id, p.text, p.ordinal FROM person_mentions a
        JOIN person_mentions b ON b.paragraph_id = a.paragraph_id JOIN paragraphs p ON p.id = a.paragraph_id
        WHERE a.identity_id = ? AND b.identity_id = ?
        AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1)
        ORDER BY p.ordinal LIMIT 1`).get(source, target) as { id: string; text: string; ordinal: number } | undefined;
      if (!evidence) continue;
      const marker = `${LOCAL_PIPELINE_VERSION}:${source}:${target}`;
      if (db.prepare('SELECT 1 FROM character_relationships WHERE revision_id = ? AND reasoning_note = ?').get(run.revisionId, marker)) continue;
      const candidate = service.createCandidate({ sourceIdentityId: source, targetIdentityId: target, method: 'cooccurrence',
        proposedType: '原文同段共现', confidence: 0.5, evidence: [{ paragraphId: evidence.id, exactQuote: evidence.text, role: 'clue' }] });
      service.reviewCandidate(candidate.id, 'confirmed');
      const relationship = service.createRelationship({ sourceIdentityId: source, targetIdentityId: target, relationshipType: '原文同段共现（非亲属或敌友判断）',
        direction: 'undirected', informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.5,
        extractionMethod: 'rule', candidateId: candidate.id, reasoningNote: marker,
        evidence: [{ paragraphId: evidence.id, exactQuote: evidence.text, role: 'support' }] });
      service.reviewRelationship(relationship.id, 'confirmed');
      count++;
    }
    return { count };
  }

  async artifacts(run: FoundationWorkflowRunRecord) {
    const { db, rootPath } = this.store.get();
    const context = activeLocalPipeline(db, run.revisionId);
    if (!context?.entryEventId) throw new Error('本地故事入口尚未准备好');
    const cards = new CharacterCardService(this.store);
    const foundation = new ArtifactFoundationService(this.store);
    const generated = foundation.generate(context.entryEventId);
    if (generated.characterCards.failedCount) throw new Error(generated.characterCards.results.filter(r => r.status === 'failed').map(r => r.message).join('；'));
    for (const item of cards.batchStatus()) {
      const draft = cards.getDraft(item.identityId);
      if (draft?.characterVersion === LOCAL_PIPELINE_VERSION && draft.reviewStatus === 'draft') {
        if (!item.quality?.contentReady) throw new Error(`${item.identityName}未满足本地基础卡要求`);
        cards.save(item.identityId, draft, 'reviewed');
      }
    }
    const playableBundle = await new PlayableBundleService(this.store).export(context.entryEventId, path.join(rootPath, 'exports'));
    db.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(`automatic-finalization:${run.revisionId}`, JSON.stringify({ policyVersion: LOCAL_PIPELINE_VERSION, revisionId: run.revisionId,
        selectionRunId: id('selection', run.id), finalizedAt: now(), counts: { localCharacters: context.identityIds.length },
        entryEvent: generated.entryEvent, artifactGeneration: generated, playableBundle, warnings: ['极低档按原文规则生成基础资料，性格、绝对时间和复杂关系仍可精修。'] }), now());
    return { playableBundle, generated, pipelineVersion: LOCAL_PIPELINE_VERSION };
  }
}
