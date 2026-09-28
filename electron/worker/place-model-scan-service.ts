import { createHash, randomUUID } from 'node:crypto';
import type { CharacterScanStart, JobRecord, PlaceModelOutput, PlaceModelScanEstimate, PlaceModelScanWorkItem } from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]/gu, '').replace(/[“”]/gu, '"').replace(/[‘’]/gu, "'");
}
function normalizedName(value: string): string { return value.normalize('NFKC').trim().replace(/[\s\u3000]+/gu, '').toLowerCase(); }
function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type RunRow = { id: string; jobId: string; revisionId: string; chunkPlanId: string; model: string; promptVersion: string; extractorVersion: string; totalChunks: number };
type ParagraphRow = PlaceModelScanWorkItem['paragraphs'][number];
type ValidEvidence = { paragraphId: string; exactQuote: string; role?: 'support' | 'context' | 'contradict'; alignmentStatus: 'exact' | 'normalized'; paragraphRole: string };

export class PlaceModelScanService {
  constructor(private readonly store: ProjectStore) {}

  estimate(): PlaceModelScanEstimate {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const plan = db.prepare('SELECT id FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1').get(revisionId) as { id: string } | undefined;
    const places = db.prepare(`SELECT COUNT(*) AS value FROM place_identities WHERE revision_id = ? AND review_status = 'confirmed'`).get(revisionId) as { value: number };
    if (!plan) return { chunkPlanId: null, chunkCount: 0, confirmedPlaceCount: Number(places.value), ready: false };
    const chunks = db.prepare('SELECT COUNT(*) AS value FROM chunks WHERE plan_id = ?').get(plan.id) as { value: number };
    const chunkCount = Number(chunks.value);
    const confirmedPlaceCount = Number(places.value);
    return { chunkPlanId: plan.id, chunkCount, confirmedPlaceCount, ready: chunkCount > 0 && confirmedPlaceCount > 0 };
  }

  createRun(modelInput: string, promptVersionInput: string, extractorVersionInput: string): CharacterScanStart {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const model = modelInput.trim().slice(0, 200);
    const promptVersion = promptVersionInput.trim().slice(0, 100);
    const extractorVersion = extractorVersionInput.trim().slice(0, 100);
    if (!model || !promptVersion || !extractorVersion) throw new Error('地点模型扫描必须指定模型、提示词版本和提取器版本');
    const plan = db.prepare(`SELECT id, version, settings_json AS settingsJson FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1`)
      .get(revisionId) as { id: string; version: number; settingsJson: string } | undefined;
    if (!plan) throw new Error('请先生成分析分块');
    const chunks = db.prepare(`SELECT id, ordinal, core_start_ordinal AS coreStart, core_end_ordinal AS coreEnd FROM chunks WHERE plan_id = ? ORDER BY ordinal`)
      .all(plan.id) as Array<{ id: string; ordinal: number; coreStart: number; coreEnd: number }>;
    if (!chunks.length) throw new Error('当前分块方案没有可分析内容');
    const places = db.prepare(`SELECT id, canonical_name AS name, place_type AS placeType, updated_at AS updatedAt FROM place_identities
      WHERE revision_id = ? AND review_status = 'confirmed' ORDER BY id`).all(revisionId);
    if (!places.length) throw new Error('至少需要一个已确认地点才能启动模型扫描');
    const aliases = db.prepare(`SELECT a.id, a.place_id AS placeId, a.alias, a.review_status AS reviewStatus FROM place_aliases a
      JOIN place_identities p ON p.id = a.place_id WHERE p.revision_id = ? ORDER BY a.id`).all(revisionId);
    const mentions = db.prepare(`SELECT id, place_id AS placeId, paragraph_id AS paragraphId, surface_text AS surfaceText, review_status AS reviewStatus
      FROM place_mentions WHERE revision_id = ? ORDER BY id`).all(revisionId);
    const links = db.prepare(`SELECT id, left_place_id AS leftPlaceId, right_place_id AS rightPlaceId, relation, review_status AS reviewStatus
      FROM place_identity_links WHERE revision_id = ? ORDER BY id`).all(revisionId);
    const inputHash = hash(JSON.stringify({ revisionId, plan, chunks, places, aliases, mentions, links, model, promptVersion, extractorVersion }));
    const existing = db.prepare(`SELECT r.id, r.job_id AS jobId, j.state FROM place_model_scan_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.project_id = ? AND r.revision_id = ? AND r.chunk_plan_id = ? AND r.extractor_version = ? AND r.input_hash = ?`)
      .get(projectId, revisionId, plan.id, extractorVersion, inputHash) as { id: string; jobId: string; state: JobRecord['state'] } | undefined;
    if (existing) {
      if (existing.state !== 'completed' && existing.state !== 'running') this.resumeExisting(db, existing.id, existing.jobId);
      return { jobId: existing.jobId, runId: existing.id, state: existing.state === 'completed' ? 'completed' : 'running', reused: true };
    }
    const jobId = randomUUID(); const runId = randomUUID(); const timestamp = now();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO jobs (id, project_id, type, state, progress, message, input_json, input_hash, lease_owner, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, 'place-model-scan', 'running', 0, '正在准备地点模型扫描', ?, ?, ?, ?, ?, ?)`)
        .run(jobId, projectId, JSON.stringify({ runId, model, promptVersion, extractorVersion }), inputHash, process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp);
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, 1, ?, 'running')`).run(randomUUID(), jobId, timestamp);
      db.prepare(`INSERT INTO place_model_scan_runs (id, project_id, revision_id, chunk_plan_id, job_id, model, prompt_version, extractor_version,
        input_hash, status, total_chunks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`)
        .run(runId, projectId, revisionId, plan.id, jobId, model, promptVersion, extractorVersion, inputHash, chunks.length, timestamp, timestamp);
      const insert = db.prepare(`INSERT INTO place_model_scan_chunk_results (run_id, chunk_id, status, input_hash, updated_at) VALUES (?, ?, 'pending', ?, ?)`);
      for (const chunk of chunks) insert.run(runId, chunk.id, hash(`${inputHash}:${chunk.id}`), timestamp);
    });
    return { jobId, runId, state: 'running', reused: false };
  }

  nextChunk(jobId: string): PlaceModelScanWorkItem | null {
    const { db, projectId } = this.store.get(); const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return null;
    const chunk = db.prepare(`SELECT c.id, c.ordinal FROM place_model_scan_chunk_results r JOIN chunks c ON c.id = r.chunk_id
      WHERE r.run_id = ? AND r.status = 'pending' ORDER BY c.ordinal LIMIT 1`).get(run.id) as { id: string; ordinal: number } | undefined;
    if (!chunk) { this.finishIfDone(db, run); return null; }
    const paragraphs = db.prepare(`SELECT p.id AS paragraphId, p.ordinal, ch.title AS chapterTitle, cm.role, p.text FROM chunk_members cm
      JOIN paragraphs p ON p.id = cm.paragraph_id LEFT JOIN chapters ch ON ch.id = p.chapter_id WHERE cm.chunk_id = ? ORDER BY cm.ordinal_in_chunk`)
      .all(chunk.id) as ParagraphRow[];
    const core = paragraphs.filter((p) => p.role === 'core').map((p) => p.ordinal);
    const min = core.length ? Math.min(...core) : -1; const max = core.length ? Math.max(...core) : -1;
    const placeRows = db.prepare(`SELECT DISTINCT p.id AS placeId, p.canonical_name AS name, p.place_type AS placeType FROM place_identities p
      JOIN place_mentions m ON m.place_id = p.id JOIN chunk_members cm ON cm.paragraph_id = m.paragraph_id
      WHERE p.revision_id = ? AND p.review_status = 'confirmed' AND m.review_status != 'rejected' AND cm.chunk_id = ? ORDER BY p.canonical_name`)
      .all(run.revisionId, chunk.id) as Array<{ placeId: string; name: string; placeType: PlaceModelScanWorkItem['places'][number]['placeType'] }>;
    const placeIds = placeRows.map((p) => p.placeId); const placeholders = placeIds.map(() => '?').join(',');
    const aliases = placeIds.length ? db.prepare(`SELECT place_id AS placeId, alias FROM place_aliases WHERE review_status = 'confirmed' AND place_id IN (${placeholders}) ORDER BY alias`)
      .all(...placeIds) as Array<{ placeId: string; alias: string }> : [];
    const byPlace = new Map<string, string[]>(); for (const alias of aliases) byPlace.set(alias.placeId, [...(byPlace.get(alias.placeId) ?? []), alias.alias]);
    const identityLinks = placeIds.length ? db.prepare(`SELECT left_place_id AS leftPlaceId, right_place_id AS rightPlaceId, relation FROM place_identity_links
      WHERE revision_id = ? AND review_status = 'confirmed' AND left_place_id IN (${placeholders}) AND right_place_id IN (${placeholders})`)
      .all(run.revisionId, ...placeIds, ...placeIds) as PlaceModelScanWorkItem['identityLinks'] : [];
    const characters = db.prepare(`SELECT DISTINCT i.id AS identityId, i.canonical_name AS name FROM person_identities i JOIN person_mentions m ON m.identity_id = i.id
      JOIN chunk_members cm ON cm.paragraph_id = m.paragraph_id WHERE i.revision_id = ? AND i.review_status = 'confirmed' AND cm.chunk_id = ? ORDER BY i.canonical_name`)
      .all(run.revisionId, chunk.id) as PlaceModelScanWorkItem['characters'];
    const events = core.length ? db.prepare(`SELECT id AS eventId, title, narrative_start_ordinal AS narrativeStartOrdinal, narrative_end_ordinal AS narrativeEndOrdinal
      FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed' AND narrative_end_ordinal >= ? AND narrative_start_ordinal <= ? ORDER BY narrative_start_ordinal`)
      .all(run.revisionId, min, max) as PlaceModelScanWorkItem['events'] : [];
    db.prepare(`UPDATE place_model_scan_chunk_results SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE run_id = ? AND chunk_id = ? AND status = 'pending'`)
      .run(now(), run.id, chunk.id);
    return { jobId, runId: run.id, chunkId: chunk.id, chunkOrdinal: Number(chunk.ordinal), model: run.model, promptVersion: run.promptVersion,
      places: placeRows.map((p) => ({ ...p, aliases: byPlace.get(p.placeId) ?? [] })), identityLinks, characters, events, paragraphs };
  }

  ingest(jobId: string, chunkId: string, output: PlaceModelOutput, rawJson: string, inputTokens = 0, outputTokens = 0): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get(); const run = this.getRun(db, projectId, jobId);
    if (Buffer.byteLength(rawJson, 'utf8') > 5 * 1024 * 1024) throw new Error('地点模型原始结果超过安全上限');
    const row = db.prepare(`SELECT status FROM place_model_scan_chunk_results WHERE run_id = ? AND chunk_id = ?`).get(run.id, chunkId) as { status: string } | undefined;
    if (!row) throw new Error('该分块不属于当前地点模型扫描'); if (row.status === 'completed') return this.jobProgress(db, jobId);
    const paragraphs = db.prepare(`SELECT p.id, p.text, cm.role FROM chunk_members cm JOIN paragraphs p ON p.id = cm.paragraph_id WHERE cm.chunk_id = ?`)
      .all(chunkId) as Array<{ id: string; text: string; role: string }>;
    const paragraphMap = new Map(paragraphs.map((p) => [p.id, p]));
    const allowedPlaces = new Set((db.prepare(`SELECT DISTINCT p.id FROM place_identities p JOIN place_mentions m ON m.place_id = p.id
      JOIN chunk_members cm ON cm.paragraph_id = m.paragraph_id WHERE p.revision_id = ? AND p.review_status = 'confirmed' AND m.review_status != 'rejected' AND cm.chunk_id = ?`)
      .all(run.revisionId, chunkId) as Array<{ id: string }>).map((p) => p.id));
    const characters = new Set((db.prepare(`SELECT id FROM person_identities WHERE revision_id = ? AND review_status = 'confirmed'`).all(run.revisionId) as Array<{ id: string }>).map((p) => p.id));
    const events = new Set((db.prepare(`SELECT id FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed'`).all(run.revisionId) as Array<{ id: string }>).map((e) => e.id));
    const validateEvidence = (items: Array<{ paragraph_id: string; exact_quote: string; role?: 'support' | 'context' | 'contradict' }>, requireSupport: boolean): ValidEvidence[] => {
      const unique = new Map<string, ValidEvidence>();
      for (const item of items) {
        const paragraph = paragraphMap.get(item.paragraph_id); if (!paragraph) throw new Error('地点建议只能引用当前分块原文');
        const quote = item.exact_quote.trim(); const alignmentStatus = paragraph.text.includes(quote) ? 'exact' as const
          : normalizedText(paragraph.text).includes(normalizedText(quote)) ? 'normalized' as const : null;
        if (!alignmentStatus) throw new Error('地点建议证据无法逐字对齐原文');
        const evidence = { paragraphId: paragraph.id, exactQuote: quote, role: item.role, alignmentStatus, paragraphRole: paragraph.role };
        unique.set(`${paragraph.id}\0${quote}\0${item.role ?? ''}`, evidence);
      }
      const result = [...unique.values()];
      if (!result.some((e) => e.paragraphRole === 'core' && (!requireSupport || e.role === 'support'))) throw new Error('地点建议必须包含核心段落的支持证据');
      return result;
    };
    const aliases = output.aliases.map((item) => {
      if (!allowedPlaces.has(item.place_id)) throw new Error('别名建议只能引用本分块提供的已确认地点');
      const evidence = validateEvidence(item.evidence, false); const alias = item.alias.trim();
      const place = db.prepare('SELECT normalized_name AS name FROM place_identities WHERE id = ?').get(item.place_id) as { name: string };
      if (normalizedName(alias) === place.name) throw new Error('别名建议不能与规范名相同');
      return { ...item, alias, normalizedAlias: normalizedName(alias), evidence, fingerprint: hash(JSON.stringify([item.place_id, normalizedName(alias), evidence])) };
    });
    const links = output.identity_links.map((item) => {
      if (!allowedPlaces.has(item.left_place_id) || !allowedPlaces.has(item.right_place_id)) throw new Error('地点身份建议只能引用本分块提供的已确认地点');
      const [left, right] = item.left_place_id.localeCompare(item.right_place_id) <= 0 ? [item.left_place_id, item.right_place_id] : [item.right_place_id, item.left_place_id];
      const evidence = validateEvidence(item.evidence, true); return { ...item, left, right, evidence, fingerprint: hash(JSON.stringify([left, right, item.relation, evidence])) };
    });
    const relations = output.relations.map((item) => {
      if (!allowedPlaces.has(item.source_place_id) || !allowedPlaces.has(item.target_place_id)) throw new Error('空间关系只能引用本分块提供的已确认地点');
      if (item.information_source_type === 'character' && (!item.information_source_identity_id || !characters.has(item.information_source_identity_id))) throw new Error('空间关系来源人物无效');
      if (item.valid_from_event_id && !events.has(item.valid_from_event_id)) throw new Error('空间关系起点事件无效');
      if (item.valid_to_event_id && !events.has(item.valid_to_event_id)) throw new Error('空间关系终点事件无效');
      const evidence = validateEvidence(item.evidence, true); return { ...item, evidence, fingerprint: hash(JSON.stringify([item.source_place_id, item.target_place_id, item.relation_kind, item.direction, item.truth_status, evidence])) };
    });
    const timestamp = now(); let aliasCount = 0; let linkCount = 0; let relationCount = 0;
    withTransaction(db, () => {
      for (const item of aliases) {
        let alias = db.prepare(`SELECT id FROM place_aliases WHERE place_id = ? AND normalized_alias = ?`).get(item.place_id, item.normalizedAlias) as { id: string } | undefined;
        if (!alias) { alias = { id: randomUUID() }; db.prepare(`INSERT INTO place_aliases (id, place_id, alias, normalized_alias, source, review_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'model', 'pending', ?, ?)`)
          .run(alias.id, item.place_id, item.alias, item.normalizedAlias, timestamp, timestamp); aliasCount += 1; }
        db.prepare(`INSERT OR IGNORE INTO place_model_alias_sources (run_id, chunk_id, alias_id, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(run.id, chunkId, alias.id, item.fingerprint, timestamp);
        for (const e of item.evidence) db.prepare(`INSERT OR IGNORE INTO place_alias_evidence (id, alias_id, paragraph_id, exact_quote, alignment_status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), alias.id, e.paragraphId, e.exactQuote, e.alignmentStatus, timestamp);
      }
      for (const item of links) {
        let link = db.prepare(`SELECT id FROM place_identity_links WHERE revision_id = ? AND left_place_id = ? AND right_place_id = ? AND relation = ?`)
          .get(run.revisionId, item.left, item.right, item.relation) as { id: string } | undefined;
        if (!link) { link = { id: randomUUID() }; db.prepare(`INSERT INTO place_identity_links (id, revision_id, left_place_id, right_place_id, relation, reason, confidence, review_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`)
          .run(link.id, run.revisionId, item.left, item.right, item.relation, item.reason, item.confidence, timestamp); linkCount += 1; }
        db.prepare(`INSERT OR IGNORE INTO place_model_identity_link_sources (run_id, chunk_id, link_id, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(run.id, chunkId, link.id, item.fingerprint, timestamp);
        for (const e of item.evidence) db.prepare(`INSERT OR IGNORE INTO place_identity_link_evidence (id, link_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), link.id, e.paragraphId, e.exactQuote, e.role, e.alignmentStatus, timestamp);
      }
      for (const item of relations) {
        let candidate = db.prepare(`SELECT id FROM place_relation_candidates WHERE revision_id = ? AND source_fingerprint = ?`).get(run.revisionId, item.fingerprint) as { id: string } | undefined;
        if (!candidate) { candidate = { id: randomUUID() }; db.prepare(`INSERT INTO place_relation_candidates (id, revision_id, source_place_id, target_place_id, candidate_method, proposed_relation_kind, proposed_direction, confidence, review_status, source_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'model', ?, ?, ?, 'pending', ?, ?, ?)`).run(candidate.id, run.revisionId, item.source_place_id, item.target_place_id, item.relation_kind, item.direction, item.confidence, item.fingerprint, timestamp, timestamp);
          for (const e of item.evidence) db.prepare(`INSERT INTO place_relation_candidate_evidence (id, candidate_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), candidate.id, e.paragraphId, e.exactQuote, e.role, e.alignmentStatus, timestamp);
          db.prepare(`INSERT INTO place_relation_model_suggestions (candidate_id, direction, information_source_type, information_source_identity_id, truth_status, valid_from_event_id, valid_to_event_id, reasoning_note, uncertainty, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(candidate.id, item.direction, item.information_source_type, item.information_source_identity_id, item.truth_status, item.valid_from_event_id, item.valid_to_event_id, item.reasoning_note, item.uncertainty, timestamp); relationCount += 1; }
        db.prepare(`INSERT OR IGNORE INTO place_model_relation_candidate_sources (run_id, chunk_id, candidate_id, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(run.id, chunkId, candidate.id, item.fingerprint, timestamp);
      }
      db.prepare(`UPDATE place_model_scan_chunk_results SET status = 'completed', raw_json = ?, error = NULL, alias_count = ?, identity_link_count = ?, relation_candidate_count = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`)
        .run(rawJson, aliasCount, linkCount, relationCount, Math.max(0, inputTokens), Math.max(0, outputTokens), timestamp, run.id, chunkId);
      this.updateProgress(db, run, timestamp); this.finishIfDone(db, run);
    });
    return this.jobProgress(db, jobId);
  }

  recordError(jobId: string, chunkId: string, message: string, terminal: boolean): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get(); const run = this.getRun(db, projectId, jobId); const timestamp = now(); const clean = message.trim().slice(0, 2000) || '未知错误';
    db.prepare(`UPDATE place_model_scan_chunk_results SET status = ?, error = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`).run(terminal ? 'failed' : 'pending', clean, timestamp, run.id, chunkId);
    if (terminal) {
      const completed = db.prepare(`SELECT COUNT(*) AS value FROM place_model_scan_chunk_results WHERE run_id = ? AND status = 'completed'`).get(run.id) as { value: number };
      db.prepare(`UPDATE place_model_scan_runs SET status = 'failed', completed_chunks = ?, updated_at = ? WHERE id = ?`).run(Number(completed.value), timestamp, run.id);
      db.prepare(`UPDATE jobs SET state = 'failed', progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value) / Math.max(run.totalChunks, 1), `地点模型扫描已停止：${clean}。可在任务中心重试`, timestamp, jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'running'`).run(timestamp, clean, jobId);
    }
    return this.jobProgress(db, jobId);
  }

  controlJob(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): void {
    const { db, projectId } = this.store.get(); const run = this.getRun(db, projectId, jobId); const timestamp = now();
    if (action === 'resume' || action === 'retry') { this.resumeExisting(db, run.id, jobId); return; }
    db.prepare(`UPDATE place_model_scan_chunk_results SET status = 'pending', updated_at = ? WHERE run_id = ? AND status = 'running'`).run(timestamp, run.id);
    db.prepare(`UPDATE place_model_scan_runs SET status = ?, updated_at = ? WHERE id = ?`).run(action === 'pause' ? 'paused' : 'cancelled', timestamp, run.id);
    db.prepare(`UPDATE jobs SET state = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(action === 'pause' ? 'paused' : 'cancelled', action === 'pause' ? '已暂停' : '已取消', timestamp, jobId);
    db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`)
      .run(action === 'pause' ? 'paused' : 'cancelled', timestamp, jobId);
  }

  private resumeExisting(db: SQLiteDatabase, runId: string, jobId: string): void { const timestamp = now(); withTransaction(db, () => {
    db.prepare(`UPDATE place_model_scan_chunk_results SET status = 'pending', error = NULL, updated_at = ? WHERE run_id = ? AND status IN ('running','failed')`).run(timestamp, runId);
    db.prepare(`UPDATE place_model_scan_runs SET status = 'running', updated_at = ? WHERE id = ?`).run(timestamp, runId);
    db.prepare(`UPDATE jobs SET state = 'running', message = '正在恢复地点模型扫描', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, jobId);
    const running = db.prepare(`SELECT id FROM job_attempts WHERE job_id = ? AND state = 'running' LIMIT 1`).get(jobId) as { id: string } | undefined;
    if (!running) {
      const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?').get(jobId) as { value: number };
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`).run(randomUUID(), jobId, Number(attempt.value), timestamp);
    }
  }); }
  private getRun(db: SQLiteDatabase, projectId: string, jobId: string): RunRow { const run = db.prepare(`SELECT id, job_id AS jobId, revision_id AS revisionId, chunk_plan_id AS chunkPlanId, model, prompt_version AS promptVersion, extractor_version AS extractorVersion, total_chunks AS totalChunks FROM place_model_scan_runs WHERE job_id = ? AND project_id = ?`).get(jobId, projectId) as RunRow | undefined; if (!run) throw new Error('找不到地点模型扫描任务'); return run; }
  private updateProgress(db: SQLiteDatabase, run: RunRow, timestamp: string): void { const c = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed, COALESCE(SUM(alias_count),0) AS aliases, COALESCE(SUM(identity_link_count),0) AS links, COALESCE(SUM(relation_candidate_count),0) AS relations, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens FROM place_model_scan_chunk_results WHERE run_id = ?`).get(run.id) as Record<string, number>; const progress = Number(c.completed) / Math.max(Number(c.total), 1); db.prepare(`UPDATE place_model_scan_runs SET completed_chunks=?, alias_count=?, identity_link_count=?, relation_candidate_count=?, input_tokens=?, output_tokens=?, updated_at=? WHERE id=?`).run(Number(c.completed), Number(c.aliases), Number(c.links), Number(c.relations), Number(c.inputTokens), Number(c.outputTokens), timestamp, run.id); db.prepare(`UPDATE jobs SET progress=?, message=?, lease_expires_at=?, updated_at=? WHERE id=?`).run(progress, `地点模型扫描：已完成 ${Number(c.completed)}/${Number(c.total)} 个分块`, new Date(Date.now()+60_000).toISOString(), timestamp, run.jobId); }
  private finishIfDone(db: SQLiteDatabase, run: RunRow): void { const c = db.prepare(`SELECT SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed FROM place_model_scan_chunk_results WHERE run_id=?`).get(run.id) as Record<string, number>; if (Number(c.remaining)>0) return; const timestamp=now(); const state=Number(c.failed)>0?'failed':'completed'; db.prepare(`UPDATE place_model_scan_runs SET status=?, completed_chunks=?, updated_at=? WHERE id=?`).run(state,Number(c.completed),timestamp,run.id); db.prepare(`UPDATE jobs SET state=?, progress=?, message=?, lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`).run(state,state==='completed'?1:Number(c.completed)/Math.max(run.totalChunks,1),state==='completed'?'地点模型扫描完成，建议均等待人工审核':'地点模型扫描存在失败分块，可在任务中心重试',timestamp,run.jobId); db.prepare(`UPDATE job_attempts SET state=?, finished_at=? WHERE job_id=? AND state='running'`).run(state,timestamp,run.jobId); }
  private jobProgress(db: SQLiteDatabase, jobId: string): { state: JobRecord['state']; progress: number } { const row=db.prepare('SELECT state, progress FROM jobs WHERE id=?').get(jobId) as {state:JobRecord['state'];progress:number}|undefined; if(!row) throw new Error('找不到地点模型扫描任务'); return {state:row.state,progress:Number(row.progress)}; }
}
