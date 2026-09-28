import { createHash, randomUUID } from 'node:crypto';
import type {
  CharacterScanStart,
  JobRecord,
  TimelineEventEstimate,
  TimelineEventEvidenceRecord,
  TimelineEventLocationRecord,
  TimelineEventOutput,
  TimelineEventParticipantRecord,
  TimelineEventRecord,
  TimelineEventWorkItem,
  TimeExpressionReviewStatus,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedText(value: string): string { return value.normalize('NFKC').replace(/[\s\u3000]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); }
function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type RunRow = {
  id: string; jobId: string; revisionId: string; chunkPlanId: string; model: string; promptVersion: string;
  inputMode: 'standard' | 'automation-draft-selection'; draftSelectionRunId: string | null;
  totalChunks: number; completedChunks: number; status: string;
};

export class TimelineEventService {
  constructor(private readonly store: ProjectStore) {}

  estimate(): TimelineEventEstimate {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const plan = db.prepare('SELECT id FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1').get(revisionId) as { id: string } | undefined;
    if (!plan) return { chunkPlanId: null, chunkCount: 0, characterCount: 0, approximateInputTokens: 0, ready: false };
    const row = db.prepare(`SELECT COUNT(DISTINCT c.id) AS chunkCount,
      COALESCE(SUM(CASE WHEN cm.role = 'core' THEN length(p.text) ELSE 0 END), 0) AS characterCount
      FROM chunks c LEFT JOIN chunk_members cm ON cm.chunk_id = c.id LEFT JOIN paragraphs p ON p.id = cm.paragraph_id
      WHERE c.plan_id = ?`).get(plan.id) as { chunkCount: number; characterCount: number };
    const characterCount = Number(row.characterCount ?? 0);
    return {
      chunkPlanId: plan.id,
      chunkCount: Number(row.chunkCount ?? 0),
      characterCount,
      approximateInputTokens: Math.ceil(characterCount / 1.7),
      ready: Number(row.chunkCount ?? 0) > 0,
    };
  }

  createRun(modelInput: string, promptVersionInput: string): CharacterScanStart {
    return this.createRunInternal(modelInput, promptVersionInput, null);
  }

  createDraftRun(selectionRunId: string, modelInput: string, promptVersionInput: string): CharacterScanStart {
    return this.createRunInternal(modelInput, promptVersionInput, selectionRunId);
  }

  private createRunInternal(modelInput: string, promptVersionInput: string, selectionRunId: string | null): CharacterScanStart {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const inputMode = selectionRunId ? 'automation-draft-selection' as const : 'standard' as const;
    const selection = selectionRunId ? db.prepare(`SELECT id, revision_id AS revisionId, input_hash AS inputHash, state
      FROM automation_draft_selection_runs WHERE id = ? AND project_id = ?`).get(selectionRunId, projectId) as
      { id: string; revisionId: string; inputHash: string; state: string } | undefined : null;
    if (selectionRunId && (!selection || selection.state !== 'completed')) throw new Error('自动草稿选择尚未完成，不能启动事件草稿');
    if (selection && selection.revisionId !== revisionId) throw new Error('自动草稿选择不属于当前正文修订');
    const model = modelInput.trim().slice(0, 100);
    const promptVersion = promptVersionInput.trim().slice(0, 100);
    if (!model || !promptVersion) throw new Error('模型和提示词版本不能为空');
    const plan = db.prepare(`SELECT id, version, settings_json AS settingsJson FROM chunk_plans
      WHERE revision_id = ? ORDER BY version DESC LIMIT 1`).get(revisionId) as { id: string; version: number; settingsJson: string } | undefined;
    if (!plan) throw new Error('请先生成分析分块');
    const chunks = db.prepare(`SELECT id, ordinal, core_start_ordinal AS coreStart, core_end_ordinal AS coreEnd
      FROM chunks WHERE plan_id = ? ORDER BY ordinal`).all(plan.id) as Array<{ id: string; ordinal: number; coreStart: number; coreEnd: number }>;
    if (!chunks.length) throw new Error('当前分块方案没有可分析内容');
    const selectedInputs = selectionRunId ? db.prepare(`SELECT s.identity_id AS identityId, s.input_hash AS inputHash,
      i.updated_at AS identityUpdatedAt FROM automation_draft_selection_items s JOIN person_identities i ON i.id = s.identity_id
      WHERE s.run_id = ? AND s.status = 'completed' AND s.selected = 1
      AND i.revision_id = ? AND i.review_status != 'rejected' ORDER BY s.ordinal`).all(selectionRunId, revisionId) : [];
    const inputHash = hash(JSON.stringify({ revisionId, plan, model, promptVersion, chunks, inputMode,
      selectionRunId, selectionInputHash: selection?.inputHash ?? null, selectedInputs }));
    const existing = db.prepare(`SELECT r.id, r.job_id AS jobId, j.state FROM timeline_event_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.project_id = ? AND r.revision_id = ? AND r.chunk_plan_id = ? AND r.model = ? AND r.prompt_version = ? AND r.input_hash = ?`)
      .get(projectId, revisionId, plan.id, model, promptVersion, inputHash) as { id: string; jobId: string; state: JobRecord['state'] } | undefined;
    if (existing) {
      if (existing.state !== 'completed' && existing.state !== 'running') {
        withTransaction(db, () => {
          db.prepare(`UPDATE timeline_event_chunk_results SET status = 'pending', error = NULL, updated_at = ?
            WHERE run_id = ? AND status IN ('running','failed')`).run(now(), existing.id);
          db.prepare(`UPDATE jobs SET state = 'running', message = '正在恢复事件抽取', updated_at = ? WHERE id = ?`).run(now(), existing.jobId);
          db.prepare(`UPDATE timeline_event_runs SET status = 'running', updated_at = ? WHERE id = ?`).run(now(), existing.id);
          if (existing.state !== 'paused') {
            const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?').get(existing.jobId) as { value: number };
            db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`)
              .run(randomUUID(), existing.jobId, Number(attempt.value), now());
          }
        });
      }
      return { jobId: existing.jobId, runId: existing.id, state: existing.state === 'completed' ? 'completed' : 'running', reused: true };
    }
    const jobId = randomUUID();
    const runId = randomUUID();
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO jobs
        (id, project_id, type, state, progress, message, input_json, input_hash, lease_owner, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, 'timeline-events', 'running', 0, '正在准备事件抽取', ?, ?, ?, ?, ?, ?)`)
        .run(jobId, projectId, JSON.stringify({ runId, model, promptVersion, inputMode, selectionRunId }), inputHash, process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp);
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, 1, ?, 'running')`).run(randomUUID(), jobId, timestamp);
      db.prepare(`INSERT INTO timeline_event_runs
        (id, project_id, revision_id, chunk_plan_id, job_id, model, prompt_version, input_hash, status, total_chunks,
         input_mode, draft_selection_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
        .run(runId, projectId, revisionId, plan.id, jobId, model, promptVersion, inputHash, chunks.length,
          inputMode, selectionRunId, timestamp, timestamp);
      const insert = db.prepare(`INSERT INTO timeline_event_chunk_results (run_id, chunk_id, status, input_hash, updated_at)
        VALUES (?, ?, 'pending', ?, ?)`);
      for (const chunk of chunks) insert.run(runId, chunk.id, hash(`${inputHash}:${chunk.id}`), timestamp);
    });
    return { jobId, runId, state: 'running', reused: false };
  }

  nextChunk(jobId: string): TimelineEventWorkItem | null {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return null;
    const chunk = db.prepare(`SELECT c.id, c.ordinal FROM timeline_event_chunk_results r JOIN chunks c ON c.id = r.chunk_id
      WHERE r.run_id = ? AND r.status = 'pending' ORDER BY c.ordinal LIMIT 1`).get(run.id) as { id: string; ordinal: number } | undefined;
    if (!chunk) { this.finishIfDone(db, run); return null; }
    db.prepare(`UPDATE timeline_event_chunk_results SET status = 'running', attempts = attempts + 1, updated_at = ?
      WHERE run_id = ? AND chunk_id = ?`).run(now(), run.id, chunk.id);
    const paragraphs = db.prepare(`SELECT p.id AS paragraphId, p.ordinal, ch.title AS chapterTitle, cm.role, p.text
      FROM chunk_members cm JOIN paragraphs p ON p.id = cm.paragraph_id LEFT JOIN chapters ch ON ch.id = p.chapter_id
      WHERE cm.chunk_id = ? ORDER BY cm.ordinal_in_chunk`).all(chunk.id) as TimelineEventWorkItem['paragraphs'];
    const paragraphIds = paragraphs.map((paragraph) => paragraph.paragraphId);
    const placeholders = paragraphIds.map(() => '?').join(',');
    const timeExpressions = paragraphIds.length ? db.prepare(`SELECT id, paragraph_id AS paragraphId, surface_text AS surfaceText,
      expression_type AS expressionType, normalized_value AS normalizedValue, review_status AS reviewStatus
      FROM timeline_time_expressions WHERE revision_id = ? AND paragraph_id IN (${placeholders}) AND review_status != 'rejected'
      ORDER BY paragraph_id, start_offset`).all(run.revisionId, ...paragraphIds) as TimelineEventWorkItem['timeExpressions'] : [];
    const characterRows = (run.inputMode === 'automation-draft-selection'
      ? db.prepare(`SELECT i.id AS identityId, i.canonical_name AS name,
          GROUP_CONCAT(CASE WHEN a.review_status = 'confirmed' THEN a.alias END) AS aliases
          FROM automation_draft_selection_items s JOIN person_identities i ON i.id = s.identity_id
          LEFT JOIN person_aliases a ON a.identity_id = i.id
          WHERE s.run_id = ? AND s.status = 'completed' AND s.selected = 1
          AND i.revision_id = ? AND i.review_status != 'rejected'
          GROUP BY i.id ORDER BY s.ordinal`).all(run.draftSelectionRunId, run.revisionId)
      : db.prepare(`SELECT i.id AS identityId, i.canonical_name AS name,
          GROUP_CONCAT(CASE WHEN a.review_status = 'confirmed' THEN a.alias END) AS aliases
          FROM person_identities i LEFT JOIN person_aliases a ON a.identity_id = i.id
          WHERE i.revision_id = ? AND i.review_status != 'rejected' GROUP BY i.id ORDER BY i.importance_score DESC, i.canonical_name`)
          .all(run.revisionId)) as Array<{ identityId: string; name: string; aliases: string | null }>;
    return {
      jobId, runId: run.id, inputMode: run.inputMode, draftSelectionRunId: run.draftSelectionRunId,
      chunkId: chunk.id, chunkOrdinal: Number(chunk.ordinal), model: run.model, promptVersion: run.promptVersion,
      paragraphs,
      characters: characterRows.map((row) => ({ identityId: row.identityId, name: row.name, aliases: row.aliases?.split(',').filter(Boolean) ?? [] })),
      timeExpressions,
    };
  }

  ingest(jobId: string, chunkId: string, output: TimelineEventOutput, rawJson: string, inputTokens: number, outputTokens: number): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (job?.state === 'cancelled') return this.jobProgress(db, jobId);
    const result = db.prepare('SELECT status FROM timeline_event_chunk_results WHERE run_id = ? AND chunk_id = ?').get(run.id, chunkId) as { status: string } | undefined;
    if (!result) throw new Error('该分块不属于当前事件抽取任务');
    if (result.status === 'completed') return this.jobProgress(db, jobId);
    const rows = db.prepare(`SELECT p.id, p.text, p.ordinal, cm.role FROM chunk_members cm JOIN paragraphs p ON p.id = cm.paragraph_id
      WHERE cm.chunk_id = ?`).all(chunkId) as Array<{ id: string; text: string; ordinal: number; role: string }>;
    const paragraphs = new Map(rows.map((row) => [row.id, row]));
    const identityRows = run.inputMode === 'automation-draft-selection'
      ? db.prepare(`SELECT i.id FROM automation_draft_selection_items s JOIN person_identities i ON i.id = s.identity_id
          WHERE s.run_id = ? AND s.status = 'completed' AND s.selected = 1
          AND i.revision_id = ? AND i.review_status != 'rejected'`).all(run.draftSelectionRunId, run.revisionId)
      : db.prepare(`SELECT id FROM person_identities WHERE revision_id = ? AND review_status != 'rejected'`).all(run.revisionId);
    const identities = new Set((identityRows as Array<{ id: string }>).map((row) => row.id));
    const validTimes = new Set((db.prepare(`SELECT id FROM timeline_time_expressions WHERE revision_id = ? AND review_status != 'rejected'`).all(run.revisionId) as Array<{ id: string }>).map((row) => row.id));
    const timestamp = now();
    withTransaction(db, () => {
      for (const event of output.events) {
        const aligned = event.evidence.flatMap((evidence) => {
          const paragraph = paragraphs.get(evidence.paragraph_id);
          if (!paragraph) return [];
          const alignment = paragraph.text.includes(evidence.exact_quote) ? 'exact' as const
            : normalizedText(paragraph.text).includes(normalizedText(evidence.exact_quote)) ? 'normalized' as const : null;
          return alignment ? [{ evidence, paragraph, alignment }] : [];
        });
        const supporting = aligned.filter((item) => item.evidence.role === 'support');
        if (!supporting.some((item) => item.paragraph.role === 'core')) continue;
        const ordinals = supporting.map((item) => Number(item.paragraph.ordinal));
        const narrativeStart = Math.min(...ordinals);
        const narrativeEnd = Math.max(...ordinals);
        const fingerprint = supporting.map((item) => `${item.evidence.paragraph_id}:${normalizedText(item.evidence.exact_quote)}`).sort().join('|');
        const eventId = `evt_${hash(`${run.revisionId}:${event.event_type}:${normalizedText(event.title)}:${fingerprint}`).slice(0, 32)}`;
        db.prepare(`INSERT OR IGNORE INTO timeline_events
          (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal, extraction_method,
           confidence, review_status, uncertainty, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'model', ?, 'pending', ?, ?, ?)`)
          .run(eventId, run.revisionId, event.title, event.summary, event.event_type, narrativeStart, narrativeEnd, event.confidence, event.uncertainty, timestamp, timestamp);
        db.prepare(`INSERT OR IGNORE INTO timeline_event_sources (event_id, run_id, chunk_id, local_key, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(eventId, run.id, chunkId, event.local_key, timestamp);
        for (const item of aligned) {
          const evidenceId = `eve_${hash(`${eventId}:${item.evidence.paragraph_id}:${item.evidence.exact_quote}:${item.evidence.role}`).slice(0, 32)}`;
          db.prepare(`INSERT OR IGNORE INTO timeline_event_evidence
            (id, event_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(evidenceId, eventId, item.evidence.paragraph_id, item.evidence.exact_quote, item.evidence.role, item.alignment, timestamp);
        }
        for (const participant of event.participants) {
          const identityId = participant.identity_id && identities.has(participant.identity_id) ? participant.identity_id : null;
          const participantId = `evp_${hash(`${eventId}:${identityId ?? normalizedText(participant.surface_name)}:${participant.role}:${participant.action_text}`).slice(0, 32)}`;
          db.prepare(`INSERT OR IGNORE INTO timeline_event_participants
            (id, event_id, identity_id, surface_name, role, action_text, confidence, review_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(participantId, eventId, identityId, participant.surface_name, participant.role, participant.action_text, participant.confidence, timestamp, timestamp);
        }
        for (const location of event.locations) {
          const locationId = `evl_${hash(`${eventId}:${normalizedText(location.surface_name)}:${location.role}`).slice(0, 32)}`;
          db.prepare(`INSERT OR IGNORE INTO timeline_event_locations
            (id, event_id, surface_name, normalized_name, location_role, confidence, review_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(locationId, eventId, location.surface_name, location.normalized_name, location.role, location.confidence, timestamp, timestamp);
        }
        for (const link of event.time_links) {
          if (!validTimes.has(link.time_expression_id)) continue;
          const timeLinkId = `evtl_${hash(`${eventId}:${link.time_expression_id}:${link.relation}`).slice(0, 32)}`;
          db.prepare(`INSERT OR IGNORE INTO timeline_event_time_links
            (id, event_id, time_expression_id, relation, confidence, review_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
            .run(timeLinkId, eventId, link.time_expression_id, link.relation, link.confidence, timestamp, timestamp);
        }
      }
      db.prepare(`UPDATE timeline_event_chunk_results SET status = 'completed', raw_json = ?, error = NULL,
        input_tokens = ?, output_tokens = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`)
        .run(rawJson, Math.max(0, inputTokens), Math.max(0, outputTokens), timestamp, run.id, chunkId);
      this.updateProgress(db, run, timestamp);
    });
    return this.jobProgress(db, jobId);
  }

  recordError(jobId: string, chunkId: string, message: string, terminal: boolean): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (job?.state === 'cancelled') return this.jobProgress(db, jobId);
    db.prepare(`UPDATE timeline_event_chunk_results SET status = ?, error = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`)
      .run(terminal ? 'failed' : 'pending', message.slice(0, 2000), now(), run.id, chunkId);
    if (terminal) {
      const clean = message.slice(0, 2000);
      const timestamp = now();
      const completed = db.prepare(`SELECT COUNT(*) AS value FROM timeline_event_chunk_results WHERE run_id = ? AND status = 'completed'`)
        .get(run.id) as { value: number };
      db.prepare(`UPDATE timeline_event_runs SET status = 'failed', completed_chunks = ?, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value), timestamp, run.id);
      db.prepare(`UPDATE jobs SET state = 'failed', progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value) / Math.max(run.totalChunks, 1), `事件抽取已停止：${clean}。可在任务中心重试`, timestamp, run.jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'running'`)
        .run(timestamp, clean, run.jobId);
    }
    return this.jobProgress(db, jobId);
  }

  listEvents(status?: TimeExpressionReviewStatus): TimelineEventRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const filter = status ? 'AND e.review_status = ?' : '';
    const values = status ? [revisionId, status] : [revisionId];
    return db.prepare(`SELECT e.id, e.title, e.summary, e.event_type AS eventType,
      e.narrative_start_ordinal AS narrativeStartOrdinal, e.narrative_end_ordinal AS narrativeEndOrdinal,
      c.title AS chapterTitle, e.extraction_method AS extractionMethod, e.confidence, e.review_status AS reviewStatus, e.uncertainty,
      (SELECT COUNT(*) FROM timeline_event_participants p WHERE p.event_id = e.id AND p.review_status != 'rejected') AS participantCount,
      (SELECT COUNT(*) FROM timeline_event_locations l WHERE l.event_id = e.id AND l.review_status != 'rejected') AS locationCount,
      (SELECT COUNT(*) FROM timeline_event_evidence v WHERE v.event_id = e.id) AS evidenceCount,
      (SELECT COUNT(*) FROM timeline_event_time_links t WHERE t.event_id = e.id AND t.review_status != 'rejected') AS timeLinkCount
      FROM timeline_events e LEFT JOIN paragraphs p0 ON p0.revision_id = e.revision_id AND p0.ordinal = e.narrative_start_ordinal
      LEFT JOIN chapters c ON c.id = p0.chapter_id WHERE e.revision_id = ? ${filter}
      ORDER BY e.narrative_start_ordinal, e.narrative_end_ordinal, e.title`).all(...values) as unknown as TimelineEventRecord[];
  }

  reviewEvent(eventId: string, status: TimeExpressionReviewStatus): TimelineEventRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare('SELECT id FROM timeline_events WHERE id = ? AND revision_id = ?').get(eventId, revisionId);
    if (!row) throw new Error('找不到该事件');
    db.prepare('UPDATE timeline_events SET review_status = ?, updated_at = ? WHERE id = ?').run(status, now(), eventId);
    return this.listEvents();
  }

  listEvidence(eventId: string): TimelineEventEvidenceRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT v.id, v.source_span_id AS sourceSpanId,
      v.event_id AS eventId, v.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal,
      c.title AS chapterTitle, v.exact_quote AS exactQuote, v.evidence_role AS evidenceRole, v.alignment_status AS alignmentStatus
      FROM timeline_event_evidence v JOIN timeline_events e ON e.id = v.event_id JOIN paragraphs p ON p.id = v.paragraph_id
      LEFT JOIN chapters c ON c.id = p.chapter_id WHERE v.event_id = ? AND e.revision_id = ? ORDER BY p.ordinal`)
      .all(eventId, revisionId) as unknown as TimelineEventEvidenceRecord[];
  }

  listParticipants(eventId: string): TimelineEventParticipantRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT p.id, p.event_id AS eventId, p.identity_id AS identityId, i.canonical_name AS identityName,
      p.surface_name AS surfaceName, p.role, p.action_text AS actionText, p.confidence, p.review_status AS reviewStatus
      FROM timeline_event_participants p JOIN timeline_events e ON e.id = p.event_id LEFT JOIN person_identities i ON i.id = p.identity_id
      WHERE p.event_id = ? AND e.revision_id = ? ORDER BY p.review_status = 'rejected', p.confidence DESC`).all(eventId, revisionId) as unknown as TimelineEventParticipantRecord[];
  }

  listLocations(eventId: string): TimelineEventLocationRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT l.id, l.event_id AS eventId, l.surface_name AS surfaceName, l.normalized_name AS normalizedName,
      l.location_role AS locationRole, l.confidence, l.review_status AS reviewStatus
      FROM timeline_event_locations l JOIN timeline_events e ON e.id = l.event_id WHERE l.event_id = ? AND e.revision_id = ?
      ORDER BY l.review_status = 'rejected', l.confidence DESC`).all(eventId, revisionId) as unknown as TimelineEventLocationRecord[];
  }

  private getRun(db: SQLiteDatabase, projectId: string, jobId: string): RunRow {
    const row = db.prepare(`SELECT id, job_id AS jobId, revision_id AS revisionId, chunk_plan_id AS chunkPlanId,
      model, prompt_version AS promptVersion, input_mode AS inputMode, draft_selection_run_id AS draftSelectionRunId,
      total_chunks AS totalChunks, completed_chunks AS completedChunks, status
      FROM timeline_event_runs WHERE job_id = ? AND project_id = ?`).get(jobId, projectId) as RunRow | undefined;
    if (!row) throw new Error('找不到事件抽取任务');
    return row;
  }

  private updateProgress(db: SQLiteDatabase, run: RunRow, timestamp: string): void {
    const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM timeline_event_chunk_results WHERE run_id = ?`).get(run.id) as { total: number; completed: number; inputTokens: number; outputTokens: number };
    const progress = Number(counts.total) ? Number(counts.completed) / Number(counts.total) : 0;
    db.prepare(`UPDATE timeline_event_runs SET completed_chunks = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?`)
      .run(Number(counts.completed), Number(counts.inputTokens), Number(counts.outputTokens), timestamp, run.id);
    db.prepare(`UPDATE jobs SET progress = ?, message = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(progress, `事件抽取：已完成 ${Number(counts.completed)}/${Number(counts.total)} 个分块`, new Date(Date.now() + 60_000).toISOString(), timestamp, run.jobId);
  }

  private finishIfDone(db: SQLiteDatabase, run: RunRow): void {
    const counts = db.prepare(`SELECT SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM timeline_event_chunk_results WHERE run_id = ?`).get(run.id) as { remaining: number; failed: number; completed: number };
    if (Number(counts.remaining) > 0) return;
    const timestamp = now();
    const failed = Number(counts.failed);
    const state = failed ? 'failed' : 'completed';
    db.prepare(`UPDATE timeline_event_runs SET status = ?, completed_chunks = ?, updated_at = ? WHERE id = ?`).run(state, Number(counts.completed), timestamp, run.id);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(state, failed ? Number(counts.completed) / Math.max(run.totalChunks, 1) : 1,
        failed ? `事件抽取有 ${failed} 个分块失败，可在任务中心重试` : '事件抽取完成，候选事件等待审核', timestamp, run.jobId);
    db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`).run(state, timestamp, run.jobId);
  }

  private jobProgress(db: SQLiteDatabase, jobId: string): { state: JobRecord['state']; progress: number } {
    const row = db.prepare('SELECT state, progress FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state']; progress: number } | undefined;
    if (!row) throw new Error('找不到事件抽取任务');
    return { state: row.state, progress: Number(row.progress) };
  }
}
