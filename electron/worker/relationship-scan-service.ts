import { createHash, randomUUID } from 'node:crypto';
import type {
  CharacterScanStart,
  JobRecord,
  RelationshipScanEstimate,
  RelationshipScanOutput,
  RelationshipScanWorkItem,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
const MAX_CANDIDATES_PER_CHUNK = 5_000;
const MAX_EVIDENCE_PER_CANDIDATE = 20;
const MAX_EVIDENCE_QUOTE_LENGTH = 4_000;
const MAX_RAW_JSON_BYTES = 5 * 1024 * 1024;
function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}
function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type RunRow = {
  id: string;
  jobId: string;
  revisionId: string;
  chunkPlanId: string;
  extractorVersion: string;
  scanMode: 'local' | 'model';
  model: string | null;
  promptVersion: string;
  inputMode: 'standard' | 'automation-draft-selection';
  draftSelectionRunId: string | null;
  totalChunks: number;
  completedChunks: number;
  status: string;
};

type ParagraphRow = RelationshipScanWorkItem['paragraphs'][number];

export class RelationshipScanService {
  constructor(private readonly store: ProjectStore) {}

  getMode(jobId: string): { mode: 'local' | 'model' } {
    const { db, projectId } = this.store.get();
    return { mode: this.getRun(db, projectId, jobId).scanMode };
  }

  estimate(): RelationshipScanEstimate {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const plan = db.prepare('SELECT id FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1')
      .get(revisionId) as { id: string } | undefined;
    const characters = db.prepare(`SELECT COUNT(*) AS value FROM person_identities
      WHERE revision_id = ? AND review_status = 'confirmed'`).get(revisionId) as { value: number };
    if (!plan) return { chunkPlanId: null, chunkCount: 0, confirmedCharacterCount: Number(characters.value), ready: false };
    const chunks = db.prepare('SELECT COUNT(*) AS value FROM chunks WHERE plan_id = ?').get(plan.id) as { value: number };
    const chunkCount = Number(chunks.value);
    const confirmedCharacterCount = Number(characters.value);
    return { chunkPlanId: plan.id, chunkCount, confirmedCharacterCount, ready: chunkCount > 0 && confirmedCharacterCount >= 2 };
  }

  controlJob(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): void {
    const { db, projectId } = this.store.get();
    this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ? AND project_id = ?').get(jobId, projectId) as
      { state: JobRecord['state'] } | undefined;
    if (!job) throw new Error('找不到关系候选扫描任务');
    const transitions: Record<typeof action, JobRecord['state'][]> = {
      pause: ['running'],
      resume: ['paused', 'queued'],
      cancel: ['queued', 'running', 'paused'],
      retry: ['failed'],
    };
    if (!transitions[action].includes(job.state)) throw new Error(`任务状态 ${job.state} 不能执行 ${action}`);
    const timestamp = now();
    withTransaction(db, () => {
      if (action === 'retry') {
        db.prepare(`UPDATE relationship_scan_chunk_results SET status = 'pending', error = NULL, updated_at = ?
          WHERE run_id = (SELECT id FROM relationship_scan_runs WHERE job_id = ?) AND status IN ('failed','running')`)
          .run(timestamp, jobId);
        db.prepare(`UPDATE relationship_scan_runs SET status = 'paused', updated_at = ? WHERE job_id = ?`).run(timestamp, jobId);
        db.prepare(`UPDATE jobs SET state = 'queued', message = '等待重新执行', lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(timestamp, jobId);
        return;
      }
      if (action === 'resume') {
        db.prepare(`UPDATE relationship_scan_chunk_results SET status = 'pending', error = NULL, updated_at = ?
          WHERE run_id = (SELECT id FROM relationship_scan_runs WHERE job_id = ?) AND status IN ('failed','running')`)
          .run(timestamp, jobId);
        db.prepare(`UPDATE relationship_scan_runs SET status = 'running', updated_at = ? WHERE job_id = ?`).run(timestamp, jobId);
        db.prepare(`UPDATE jobs SET state = 'running', message = '继续运行', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
          .run(process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, jobId);
        const runningAttempt = db.prepare(`SELECT id FROM job_attempts WHERE job_id = ? AND state = 'running' LIMIT 1`)
          .get(jobId) as { id: string } | undefined;
        if (!runningAttempt) {
          const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?')
            .get(jobId) as { value: number };
          db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`)
            .run(randomUUID(), jobId, Number(attempt.value), timestamp);
        }
        return;
      }
      db.prepare(`UPDATE relationship_scan_chunk_results SET status = 'pending', updated_at = ?
        WHERE run_id = (SELECT id FROM relationship_scan_runs WHERE job_id = ?) AND status = 'running'`)
        .run(timestamp, jobId);
      db.prepare(`UPDATE relationship_scan_runs SET status = ?, updated_at = ? WHERE job_id = ?`)
        .run(action === 'pause' ? 'paused' : 'cancelled', timestamp, jobId);
      db.prepare(`UPDATE jobs SET state = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(action === 'pause' ? 'paused' : 'cancelled', action === 'pause' ? '已暂停' : '已取消', timestamp, jobId);
      db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`)
        .run(action === 'pause' ? 'paused' : 'cancelled', timestamp, jobId);
    });
  }

  createRun(
    extractorVersionInput: string,
    modeInput: 'local' | 'model' = 'local',
    modelInput = '',
    promptVersionInput = 'relationship-local.v1',
  ): CharacterScanStart {
    return this.createRunInternal(extractorVersionInput, modeInput, modelInput, promptVersionInput, null);
  }

  createDraftRun(selectionRunId: string, extractorVersionInput: string): CharacterScanStart {
    return this.createRunInternal(extractorVersionInput, 'local', '', 'relationship-draft-local.v1', selectionRunId);
  }

  private createRunInternal(
    extractorVersionInput: string,
    modeInput: 'local' | 'model',
    modelInput: string,
    promptVersionInput: string,
    selectionRunId: string | null,
  ): CharacterScanStart {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const inputMode = selectionRunId ? 'automation-draft-selection' as const : 'standard' as const;
    const selection = selectionRunId ? db.prepare(`SELECT id, revision_id AS revisionId, input_hash AS inputHash, state
      FROM automation_draft_selection_runs WHERE id = ? AND project_id = ?`).get(selectionRunId, projectId) as
      { id: string; revisionId: string; inputHash: string; state: string } | undefined : null;
    if (selectionRunId && (!selection || selection.state !== 'completed')) throw new Error('自动草稿选择尚未完成，不能启动关系草稿');
    if (selection && selection.revisionId !== revisionId) throw new Error('自动草稿选择不属于当前正文修订');
    const extractorVersion = extractorVersionInput.trim().slice(0, 100);
    const scanMode = modeInput;
    const model = scanMode === 'model' ? modelInput.trim().slice(0, 200) : null;
    const promptVersion = promptVersionInput.trim().slice(0, 100);
    if (!extractorVersion) throw new Error('关系候选生成器版本不能为空');
    if (!promptVersion || (scanMode === 'model' && !model)) throw new Error('模型关系抽取必须指定模型和提示词版本');
    const plan = db.prepare(`SELECT id, version, settings_json AS settingsJson FROM chunk_plans
      WHERE revision_id = ? ORDER BY version DESC LIMIT 1`).get(revisionId) as { id: string; version: number; settingsJson: string } | undefined;
    if (!plan) throw new Error('请先生成分析分块');
    const chunks = db.prepare(`SELECT id, ordinal, core_start_ordinal AS coreStart, core_end_ordinal AS coreEnd
      FROM chunks WHERE plan_id = ? ORDER BY ordinal`).all(plan.id) as Array<{ id: string; ordinal: number; coreStart: number; coreEnd: number }>;
    if (!chunks.length) throw new Error('当前分块方案没有可分析内容');
    const identities = (selectionRunId
      ? db.prepare(`SELECT i.id, i.canonical_name AS canonicalName, i.updated_at AS updatedAt
          FROM automation_draft_selection_items s JOIN person_identities i ON i.id = s.identity_id
          WHERE s.run_id = ? AND s.status = 'completed' AND s.selected = 1
          AND i.revision_id = ? AND i.review_status != 'rejected' ORDER BY s.ordinal`).all(selectionRunId, revisionId)
      : db.prepare(`SELECT id, canonical_name AS canonicalName, updated_at AS updatedAt
          FROM person_identities WHERE revision_id = ? AND review_status = 'confirmed' ORDER BY id`).all(revisionId)) as Array<{ id: string; canonicalName: string; updatedAt: string }>;
    if (identities.length < 2) throw new Error(selectionRunId
      ? '自动草稿集合至少需要两名当前人物才能扫描关系候选'
      : '至少需要两名已确认人物才能扫描关系候选');
    const identityIds = identities.map((identity) => identity.id);
    const identityPlaceholders = identityIds.map(() => '?').join(',');
    const aliases = identityIds.length ? db.prepare(`SELECT a.id, a.identity_id AS identityId, a.alias, a.review_status AS reviewStatus
      FROM person_aliases a WHERE a.identity_id IN (${identityPlaceholders}) AND a.review_status = 'confirmed' ORDER BY a.id`).all(...identityIds) : [];
    const cannotLinks = db.prepare(`SELECT left_identity_id AS leftIdentityId, right_identity_id AS rightIdentityId
      FROM person_identity_links WHERE revision_id = ? AND relation = 'cannot_link' AND review_status = 'confirmed'
      ORDER BY left_identity_id, right_identity_id`).all(revisionId);
    const mentionRows = identityIds.length ? db.prepare(`SELECT m.id, m.identity_id AS identityId, m.paragraph_id AS paragraphId, m.surface_text AS surfaceText
      FROM person_mentions m WHERE m.revision_id = ? AND m.identity_id IN (${identityPlaceholders}) ORDER BY m.id`)
      .all(revisionId, ...identityIds) as Array<{ id: string; identityId: string; paragraphId: string; surfaceText: string }> : [];
    const mentionFingerprintBuilder = createHash('sha256');
    for (const mention of mentionRows) {
      mentionFingerprintBuilder.update(`${mention.id}\0${mention.identityId}\0${mention.paragraphId}\0${mention.surfaceText}\n`);
    }
    const mentionFingerprint = mentionFingerprintBuilder.digest('hex');
    const modelContext = scanMode === 'model' ? {
      quotes: db.prepare(`SELECT q.id, q.paragraph_id AS paragraphId, q.quote_text AS quoteText,
        a.identity_id AS identityId, a.role, a.updated_at AS updatedAt
        FROM character_quotes q JOIN character_quote_attributions a ON a.quote_id = q.id
        JOIN person_identities i ON i.id = a.identity_id
        WHERE q.revision_id = ? AND a.review_status = 'confirmed' AND i.review_status = 'confirmed'
        ORDER BY q.id, a.id`).all(revisionId),
      events: db.prepare(`SELECT e.id, e.title, e.summary, e.narrative_start_ordinal AS narrativeStartOrdinal,
        e.narrative_end_ordinal AS narrativeEndOrdinal, e.updated_at AS updatedAt
        FROM timeline_events e WHERE e.revision_id = ? AND e.review_status = 'confirmed' ORDER BY e.id`).all(revisionId),
      eventParticipants: db.prepare(`SELECT p.event_id AS eventId, p.identity_id AS identityId, p.role, p.updated_at AS updatedAt
        FROM timeline_event_participants p JOIN timeline_events e ON e.id = p.event_id
        JOIN person_identities i ON i.id = p.identity_id
        WHERE e.revision_id = ? AND e.review_status = 'confirmed' AND p.review_status = 'confirmed'
        AND i.review_status = 'confirmed' ORDER BY p.event_id, p.id`).all(revisionId),
    } : null;
    const inputHash = hash(JSON.stringify({
      revisionId,
      planId: plan.id,
      planVersion: plan.version,
      settings: plan.settingsJson,
      extractorVersion,
      scanMode,
      model,
      promptVersion,
      chunks,
      identities,
      aliases,
      cannotLinks,
      mentionFingerprint,
      modelContext,
      inputMode,
      selectionRunId,
      selectionInputHash: selection?.inputHash ?? null,
    }));
    const existing = db.prepare(`SELECT r.id, r.job_id AS jobId, r.status, j.state
      FROM relationship_scan_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.project_id = ? AND r.revision_id = ? AND r.chunk_plan_id = ? AND r.extractor_version = ? AND r.input_hash = ?`)
      .get(projectId, revisionId, plan.id, extractorVersion, inputHash) as { id: string; jobId: string; status: string; state: JobRecord['state'] } | undefined;
    if (existing) {
      if (existing.state !== 'completed' && existing.state !== 'running') {
        withTransaction(db, () => {
          const timestamp = now();
          db.prepare(`UPDATE relationship_scan_chunk_results SET status = 'pending', error = NULL, updated_at = ?
            WHERE run_id = ? AND status IN ('running','failed')`).run(timestamp, existing.id);
          db.prepare(`UPDATE jobs SET state = 'running', message = '正在恢复关系候选扫描', lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
            .run(process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, existing.jobId);
          db.prepare(`UPDATE relationship_scan_runs SET status = 'running', updated_at = ? WHERE id = ?`).run(timestamp, existing.id);
          const runningAttempt = db.prepare(`SELECT id FROM job_attempts WHERE job_id = ? AND state = 'running' LIMIT 1`)
            .get(existing.jobId) as { id: string } | undefined;
          if (!runningAttempt) {
            const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?')
              .get(existing.jobId) as { value: number };
            db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`)
              .run(randomUUID(), existing.jobId, Number(attempt.value), timestamp);
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
        VALUES (?, ?, 'relationship-scan', 'running', 0, '正在准备关系候选扫描', ?, ?, ?, ?, ?, ?)`)
        .run(jobId, projectId, JSON.stringify({ runId, scanMode, model, promptVersion, extractorVersion, inputMode, selectionRunId }), inputHash,
          process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp);
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, 1, ?, 'running')`)
        .run(randomUUID(), jobId, timestamp);
      db.prepare(`INSERT INTO relationship_scan_runs
        (id, project_id, revision_id, chunk_plan_id, job_id, scan_mode, model, prompt_version, extractor_version,
         input_hash, status, total_chunks, input_mode, draft_selection_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
        .run(runId, projectId, revisionId, plan.id, jobId, scanMode, model, promptVersion, extractorVersion, inputHash,
          chunks.length, inputMode, selectionRunId, timestamp, timestamp);
      const insert = db.prepare(`INSERT INTO relationship_scan_chunk_results (run_id, chunk_id, status, input_hash, updated_at)
        VALUES (?, ?, 'pending', ?, ?)`);
      for (const chunk of chunks) insert.run(runId, chunk.id, hash(`${inputHash}:${chunk.id}`), timestamp);
    });
    return { jobId, runId, state: 'running', reused: false };
  }

  nextChunk(jobId: string): RelationshipScanWorkItem | null {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return null;
    const chunk = db.prepare(`SELECT c.id, c.ordinal FROM relationship_scan_chunk_results r
      JOIN chunks c ON c.id = r.chunk_id WHERE r.run_id = ? AND r.status = 'pending' ORDER BY c.ordinal LIMIT 1`)
      .get(run.id) as { id: string; ordinal: number } | undefined;
    if (!chunk) {
      this.finishIfDone(db, run);
      return null;
    }
    const paragraphs = db.prepare(`SELECT p.id AS paragraphId, p.ordinal, ch.title AS chapterTitle, cm.role, p.text
      FROM chunk_members cm JOIN paragraphs p ON p.id = cm.paragraph_id
      LEFT JOIN chapters ch ON ch.id = p.chapter_id
      WHERE cm.chunk_id = ? ORDER BY cm.ordinal_in_chunk`).all(chunk.id) as ParagraphRow[];
    const coreOrdinals = paragraphs.filter((paragraph) => paragraph.role === 'core').map((paragraph) => paragraph.ordinal);
    const minimumOrdinal = coreOrdinals.length ? Math.min(...coreOrdinals) : -1;
    const maximumOrdinal = coreOrdinals.length ? Math.max(...coreOrdinals) : -1;
    const localIdentityIds = (run.scanMode === 'model'
      ? db.prepare(`SELECT DISTINCT i.id FROM person_identities i
        WHERE i.revision_id = ? AND i.review_status = 'confirmed' AND (
          EXISTS (SELECT 1 FROM person_mentions m JOIN chunk_members cm ON cm.paragraph_id = m.paragraph_id
            WHERE m.identity_id = i.id AND cm.chunk_id = ?)
          OR EXISTS (SELECT 1 FROM character_quote_attributions a JOIN character_quotes q ON q.id = a.quote_id
            JOIN chunk_members cm ON cm.paragraph_id = q.paragraph_id
            WHERE a.identity_id = i.id AND a.review_status = 'confirmed' AND cm.chunk_id = ?)
          OR EXISTS (SELECT 1 FROM timeline_event_participants ep JOIN timeline_events e ON e.id = ep.event_id
            WHERE ep.identity_id = i.id AND ep.review_status = 'confirmed' AND e.review_status = 'confirmed'
            AND e.narrative_end_ordinal >= ? AND e.narrative_start_ordinal <= ?)
        ) ORDER BY i.id`).all(run.revisionId, chunk.id, chunk.id, minimumOrdinal, maximumOrdinal)
      : run.inputMode === 'automation-draft-selection'
        ? db.prepare(`SELECT DISTINCT i.id FROM automation_draft_selection_items s
          JOIN person_identities i ON i.id = s.identity_id JOIN person_mentions m ON m.identity_id = i.id
          JOIN chunk_members cm ON cm.paragraph_id = m.paragraph_id
          WHERE s.run_id = ? AND s.status = 'completed' AND s.selected = 1
          AND cm.chunk_id = ? AND i.revision_id = ? AND i.review_status != 'rejected'`)
          .all(run.draftSelectionRunId, chunk.id, run.revisionId)
        : db.prepare(`SELECT DISTINCT i.id FROM person_identities i
          JOIN person_mentions m ON m.identity_id = i.id
          JOIN chunk_members cm ON cm.paragraph_id = m.paragraph_id
          WHERE cm.chunk_id = ? AND i.revision_id = ? AND i.review_status = 'confirmed'`).all(chunk.id, run.revisionId)) as Array<{ id: string }>;
    const identityIds = localIdentityIds.map((row) => row.id);
    const characters = identityIds.length ? db.prepare(`SELECT id AS identityId, canonical_name AS name
      FROM person_identities WHERE revision_id = ? AND review_status ${run.inputMode === 'automation-draft-selection' ? "!= 'rejected'" : "= 'confirmed'"}
      AND id IN (${identityIds.map(() => '?').join(',')}) ORDER BY canonical_name`)
      .all(run.revisionId, ...identityIds) as Array<{ identityId: string; name: string }> : [];
    const aliases = identityIds.length ? db.prepare(`SELECT identity_id AS identityId, alias FROM person_aliases
      WHERE review_status = 'confirmed' AND identity_id IN (${identityIds.map(() => '?').join(',')}) ORDER BY alias`)
      .all(...identityIds) as Array<{ identityId: string; alias: string }> : [];
    const aliasesByIdentity = new Map<string, string[]>();
    for (const alias of aliases) aliasesByIdentity.set(alias.identityId, [...(aliasesByIdentity.get(alias.identityId) ?? []), alias.alias]);
    const cannotLinks = identityIds.length ? db.prepare(`SELECT left_identity_id AS leftIdentityId, right_identity_id AS rightIdentityId
      FROM person_identity_links WHERE revision_id = ? AND relation = 'cannot_link' AND review_status = 'confirmed'
      AND left_identity_id IN (${identityIds.map(() => '?').join(',')}) AND right_identity_id IN (${identityIds.map(() => '?').join(',')})`)
      .all(run.revisionId, ...identityIds, ...identityIds) as RelationshipScanWorkItem['cannotLinks'] : [];
    const paragraphIds = paragraphs.map((paragraph) => paragraph.paragraphId);
    const paragraphPlaceholders = paragraphIds.map(() => '?').join(',');
    const quotes = run.scanMode === 'model' && paragraphIds.length ? db.prepare(`SELECT q.paragraph_id AS paragraphId,
      q.quote_text AS exactQuote, a.identity_id AS speakerIdentityId, i.canonical_name AS speakerName
      FROM character_quotes q JOIN character_quote_attributions a ON a.quote_id = q.id
      JOIN person_identities i ON i.id = a.identity_id
      WHERE q.revision_id = ? AND q.paragraph_id IN (${paragraphPlaceholders}) AND a.role = 'speaker'
      AND a.review_status = 'confirmed' AND i.review_status = 'confirmed' ORDER BY q.paragraph_id, q.start_offset`)
      .all(run.revisionId, ...paragraphIds) as RelationshipScanWorkItem['quotes'] : [];
    const eventRows = run.scanMode === 'model' && coreOrdinals.length ? db.prepare(`SELECT id AS eventId, title, summary,
      narrative_start_ordinal AS narrativeStartOrdinal, narrative_end_ordinal AS narrativeEndOrdinal
      FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed'
      AND narrative_end_ordinal >= ? AND narrative_start_ordinal <= ? ORDER BY narrative_start_ordinal, id`)
      .all(run.revisionId, minimumOrdinal, maximumOrdinal) as Array<Omit<RelationshipScanWorkItem['events'][number], 'participantIdentityIds'>> : [];
    const eventIds = eventRows.map((event) => event.eventId);
    const participantRows = eventIds.length ? db.prepare(`SELECT event_id AS eventId, identity_id AS identityId
      FROM timeline_event_participants WHERE event_id IN (${eventIds.map(() => '?').join(',')})
      AND review_status = 'confirmed' AND identity_id IS NOT NULL ORDER BY event_id, id`)
      .all(...eventIds) as Array<{ eventId: string; identityId: string }> : [];
    const participantsByEvent = new Map<string, string[]>();
    for (const participant of participantRows) {
      participantsByEvent.set(participant.eventId, [...(participantsByEvent.get(participant.eventId) ?? []), participant.identityId]);
    }
    db.prepare(`UPDATE relationship_scan_chunk_results SET status = 'running', attempts = attempts + 1, updated_at = ?
      WHERE run_id = ? AND chunk_id = ? AND status = 'pending'`).run(now(), run.id, chunk.id);
    return {
      jobId,
      runId: run.id,
      inputMode: run.inputMode,
      draftSelectionRunId: run.draftSelectionRunId,
      chunkId: chunk.id,
      chunkOrdinal: Number(chunk.ordinal),
      extractorVersion: run.extractorVersion,
      scanMode: run.scanMode,
      model: run.model,
      promptVersion: run.promptVersion,
      characters: characters.map((character) => ({ ...character, aliases: aliasesByIdentity.get(character.identityId) ?? [] })),
      cannotLinks,
      quotes,
      events: eventRows.map((event) => ({ ...event, participantIdentityIds: participantsByEvent.get(event.eventId) ?? [] })),
      paragraphs,
    };
  }

  ingest(jobId: string, chunkId: string, output: RelationshipScanOutput, rawJson: string, inputTokens = 0, outputTokens = 0): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return this.jobProgress(db, jobId);
    const resultRow = db.prepare(`SELECT status FROM relationship_scan_chunk_results WHERE run_id = ? AND chunk_id = ?`)
      .get(run.id, chunkId) as { status: string } | undefined;
    if (!resultRow) throw new Error('该分块不属于当前关系候选扫描');
    if (resultRow.status === 'completed') return this.jobProgress(db, jobId);
    if (!output || !Array.isArray(output.candidates)) throw new Error('关系候选扫描结果格式无效');
    if (output.candidates.length > MAX_CANDIDATES_PER_CHUNK) throw new Error('单个分块的关系候选数量超过安全上限');
    if (Buffer.byteLength(rawJson, 'utf8') > MAX_RAW_JSON_BYTES) throw new Error('关系候选原始结果超过安全上限');
    const paragraphs = db.prepare(`SELECT p.id, p.text, cm.role FROM chunk_members cm
      JOIN paragraphs p ON p.id = cm.paragraph_id WHERE cm.chunk_id = ?`).all(chunkId) as Array<{ id: string; text: string; role: string }>;
    const paragraphMap = new Map(paragraphs.map((paragraph) => [paragraph.id, paragraph]));
    const identityRows = run.inputMode === 'automation-draft-selection'
      ? db.prepare(`SELECT i.id FROM automation_draft_selection_items s JOIN person_identities i ON i.id = s.identity_id
          WHERE s.run_id = ? AND s.status = 'completed' AND s.selected = 1
          AND i.revision_id = ? AND i.review_status != 'rejected'`).all(run.draftSelectionRunId, run.revisionId)
      : db.prepare(`SELECT id FROM person_identities WHERE revision_id = ? AND review_status = 'confirmed'`).all(run.revisionId);
    const identities = new Set((identityRows as Array<{ id: string }>).map((row) => row.id));
    const confirmedEvents = new Set((db.prepare(`SELECT id FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed'`)
      .all(run.revisionId) as Array<{ id: string }>).map((row) => row.id));
    const validated = output.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== 'object') throw new Error('关系候选条目格式无效');
      if (!identities.has(candidate.sourceIdentityId) || !identities.has(candidate.targetIdentityId)) throw new Error('关系候选只能引用当前版本已确认人物');
      if (candidate.sourceIdentityId === candidate.targetIdentityId) throw new Error('关系候选两端不能是同一人物');
      if (run.scanMode === 'local' && candidate.method !== 'cooccurrence' && candidate.method !== 'rule') throw new Error('本地关系候选来源无效');
      if (run.scanMode === 'model' && candidate.method !== 'model') throw new Error('模型关系候选来源无效');
      if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) throw new Error('关系候选置信度必须在 0 到 1 之间');
      if (!Array.isArray(candidate.evidence) || !candidate.evidence.length) throw new Error('关系候选必须提供原文证据');
      if (candidate.evidence.length > MAX_EVIDENCE_PER_CANDIDATE) throw new Error('单条关系候选的证据数量超过安全上限');
      const uniqueEvidence = new Map<string, {
        paragraphId: string;
        exactQuote: string;
        role: 'clue' | 'support' | 'context' | 'contradict';
        paragraphRole: string;
        alignmentStatus: 'exact' | 'normalized';
      }>();
      for (const item of candidate.evidence) {
        const paragraph = paragraphMap.get(item.paragraphId);
        if (!paragraph || (run.scanMode === 'local' && paragraph.role !== 'core')) throw new Error('关系候选必须引用当前分块允许的原文');
        const exactQuote = String(item.exactQuote ?? '').trim();
        if (!exactQuote) throw new Error('关系候选证据不能为空');
        if (exactQuote.length > MAX_EVIDENCE_QUOTE_LENGTH) throw new Error('关系候选证据文本超过安全上限');
        const alignmentStatus = paragraph.text.includes(exactQuote)
          ? 'exact' as const
          : normalizedText(paragraph.text).includes(normalizedText(exactQuote)) ? 'normalized' as const : null;
        if (!alignmentStatus) throw new Error('关系候选证据无法对齐原文');
        const evidenceRole = run.scanMode === 'local' ? 'clue' as const : item.role;
        if (run.scanMode === 'model' && !['support', 'context', 'contradict'].includes(evidenceRole)) {
          throw new Error('模型关系证据角色无效');
        }
        uniqueEvidence.set(`${paragraph.id}\0${exactQuote}\0${evidenceRole}\0${alignmentStatus}`, {
          paragraphId: paragraph.id, exactQuote, role: evidenceRole, paragraphRole: paragraph.role, alignmentStatus,
        });
      }
      const evidence = [...uniqueEvidence.values()];
      if (run.scanMode === 'model' && !evidence.some((item) => item.role === 'support' && item.paragraphRole === 'core')) {
        throw new Error('模型关系候选必须包含核心段落的支持证据');
      }
      const [sourceIdentityId, targetIdentityId] = run.scanMode === 'model' || candidate.sourceIdentityId.localeCompare(candidate.targetIdentityId) <= 0
        ? [candidate.sourceIdentityId, candidate.targetIdentityId]
        : [candidate.targetIdentityId, candidate.sourceIdentityId];
      const proposedType = String(candidate.proposedType ?? '').trim().slice(0, 120) || null;
      if (run.scanMode === 'model' && (!proposedType || !candidate.suggestion)) throw new Error('模型关系候选缺少断言建议');
      const suggestion = candidate.suggestion ?? null;
      if (suggestion?.informationSourceType === 'character') {
        if (!suggestion.informationSourceIdentityId || !identities.has(suggestion.informationSourceIdentityId)) {
          throw new Error('模型关系候选的信息来源人物无效');
        }
      } else if (suggestion?.informationSourceIdentityId) {
        throw new Error('只有人物来源可以指定来源人物');
      }
      if (suggestion?.validFromEventId && !confirmedEvents.has(suggestion.validFromEventId)) throw new Error('关系起点只能引用已确认事件');
      if (suggestion?.validToEventId && !confirmedEvents.has(suggestion.validToEventId)) throw new Error('关系终点只能引用已确认事件');
      const fingerprint = hash(JSON.stringify({
        sourceIdentityId,
        targetIdentityId,
        method: candidate.method,
        proposedType,
        suggestion,
        evidence: evidence.map((item) => [item.paragraphId, normalizedText(item.exactQuote), item.role]).sort(),
      }));
      return { sourceIdentityId, targetIdentityId, method: candidate.method, proposedType, confidence: candidate.confidence, evidence, suggestion, fingerprint };
    });
    const timestamp = now();
    let insertedCount = 0;
    withTransaction(db, () => {
      for (const candidate of validated) {
        const exists = db.prepare(`SELECT candidate_id AS candidateId FROM relationship_scan_candidate_sources
          WHERE run_id = ? AND candidate_fingerprint = ?`).get(run.id, candidate.fingerprint) as { candidateId: string } | undefined;
        if (exists) continue;
        const priorCandidate = db.prepare(`SELECT id FROM character_relationship_candidates
          WHERE revision_id = ? AND source_fingerprint = ?`).get(run.revisionId, candidate.fingerprint) as { id: string } | undefined;
        if (priorCandidate) {
          db.prepare(`UPDATE character_relationship_candidates SET confidence = MAX(confidence, ?), updated_at = ?
            WHERE id = ? AND review_status = 'pending'`).run(candidate.confidence, timestamp, priorCandidate.id);
          db.prepare(`INSERT INTO relationship_scan_candidate_sources
            (run_id, chunk_id, candidate_id, candidate_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
            .run(run.id, chunkId, priorCandidate.id, candidate.fingerprint, timestamp);
          continue;
        }
        const candidateId = randomUUID();
        db.prepare(`INSERT INTO character_relationship_candidates
          (id, revision_id, source_identity_id, target_identity_id, candidate_method, proposed_type, confidence, review_status, source_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
          .run(candidateId, run.revisionId, candidate.sourceIdentityId, candidate.targetIdentityId, candidate.method, candidate.proposedType, candidate.confidence, candidate.fingerprint, timestamp, timestamp);
        const insertEvidence = db.prepare(`INSERT INTO character_relationship_candidate_evidence
          (id, candidate_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`);
        for (const evidence of candidate.evidence) {
          insertEvidence.run(randomUUID(), candidateId, evidence.paragraphId, evidence.exactQuote, evidence.role, evidence.alignmentStatus, timestamp);
        }
        if (candidate.suggestion) {
          db.prepare(`INSERT INTO relationship_model_suggestions
            (candidate_id, direction, strength, polarity, information_source_type, information_source_identity_id,
             truth_status, valid_from_event_id, valid_to_event_id, reasoning_note, uncertainty, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(candidateId, candidate.suggestion.direction, candidate.suggestion.strength, candidate.suggestion.polarity,
              candidate.suggestion.informationSourceType, candidate.suggestion.informationSourceIdentityId,
              candidate.suggestion.truthStatus, candidate.suggestion.validFromEventId, candidate.suggestion.validToEventId,
              candidate.suggestion.reasoningNote, candidate.suggestion.uncertainty, timestamp);
        }
        db.prepare(`INSERT INTO relationship_scan_candidate_sources
          (run_id, chunk_id, candidate_id, candidate_fingerprint, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(run.id, chunkId, candidateId, candidate.fingerprint, timestamp);
        insertedCount += 1;
      }
      db.prepare(`UPDATE relationship_scan_chunk_results SET status = 'completed', raw_json = ?, error = NULL,
        candidate_count = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`)
        .run(rawJson, insertedCount, Math.max(0, inputTokens), Math.max(0, outputTokens), timestamp, run.id, chunkId);
      this.updateProgress(db, run, timestamp);
      this.finishIfDone(db, run);
    });
    return this.jobProgress(db, jobId);
  }

  recordError(jobId: string, chunkId: string, message: string, terminal: boolean): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return this.jobProgress(db, jobId);
    const timestamp = now();
    const clean = message.trim().slice(0, 2000) || '未知错误';
    db.prepare(`UPDATE relationship_scan_chunk_results SET status = ?, error = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`)
      .run(terminal ? 'failed' : 'pending', clean, timestamp, run.id, chunkId);
    if (terminal) {
      const completed = db.prepare(`SELECT COUNT(*) AS value FROM relationship_scan_chunk_results WHERE run_id = ? AND status = 'completed'`)
        .get(run.id) as { value: number };
      db.prepare(`UPDATE relationship_scan_runs SET status = 'failed', completed_chunks = ?, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value), timestamp, run.id);
      db.prepare(`UPDATE jobs SET state = 'failed', progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value) / Math.max(run.totalChunks, 1), `关系候选扫描已停止：${clean}。可在任务中心重试`, timestamp, jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'running'`)
        .run(timestamp, clean, jobId);
    }
    return this.jobProgress(db, jobId);
  }

  private getRun(db: SQLiteDatabase, projectId: string, jobId: string): RunRow {
    const run = db.prepare(`SELECT id, job_id AS jobId, revision_id AS revisionId, chunk_plan_id AS chunkPlanId,
      extractor_version AS extractorVersion, scan_mode AS scanMode, model, prompt_version AS promptVersion,
      input_mode AS inputMode, draft_selection_run_id AS draftSelectionRunId,
      total_chunks AS totalChunks, completed_chunks AS completedChunks, status
      FROM relationship_scan_runs WHERE job_id = ? AND project_id = ?`).get(jobId, projectId) as RunRow | undefined;
    if (!run) throw new Error('找不到关系候选扫描任务');
    return run;
  }

  private updateProgress(db: SQLiteDatabase, run: RunRow, timestamp: string): void {
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      COALESCE(SUM(candidate_count), 0) AS candidateCount,
      COALESCE(SUM(input_tokens), 0) AS inputTokens,
      COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM relationship_scan_chunk_results WHERE run_id = ?`).get(run.id) as {
        total: number; completed: number; candidateCount: number; inputTokens: number; outputTokens: number;
      };
    const progress = Number(counts.total) ? Number(counts.completed) / Number(counts.total) : 0;
    db.prepare(`UPDATE relationship_scan_runs SET completed_chunks = ?, candidate_count = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?`)
      .run(Number(counts.completed), Number(counts.candidateCount), Number(counts.inputTokens), Number(counts.outputTokens), timestamp, run.id);
    db.prepare(`UPDATE jobs SET progress = ?, message = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(progress, `关系候选扫描：已完成 ${Number(counts.completed)}/${Number(counts.total)} 个分块，新增 ${Number(counts.candidateCount)} 条候选`,
        new Date(Date.now() + 60_000).toISOString(), timestamp, run.jobId);
  }

  private finishIfDone(db: SQLiteDatabase, run: RunRow): void {
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(run.jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return;
    const counts = db.prepare(`SELECT
      SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      COALESCE(SUM(candidate_count), 0) AS candidateCount
      FROM relationship_scan_chunk_results WHERE run_id = ?`).get(run.id) as { remaining: number; failed: number; completed: number; candidateCount: number };
    if (Number(counts.remaining) > 0) return;
    const timestamp = now();
    const failed = Number(counts.failed);
    const state = failed ? 'failed' : 'completed';
    db.prepare(`UPDATE relationship_scan_runs SET status = ?, completed_chunks = ?, candidate_count = ?, updated_at = ? WHERE id = ?`)
      .run(state, Number(counts.completed), Number(counts.candidateCount), timestamp, run.id);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(state, failed ? Number(counts.completed) / Math.max(run.totalChunks, 1) : 1,
        failed ? `关系候选扫描有 ${failed} 个分块失败，可在任务中心重试` : `关系候选扫描完成，新增 ${Number(counts.candidateCount)} 条待审核候选`,
        timestamp, run.jobId);
    db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`)
      .run(state, timestamp, run.jobId);
  }

  private jobProgress(db: SQLiteDatabase, jobId: string): { state: JobRecord['state']; progress: number } {
    const row = db.prepare('SELECT state, progress FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state']; progress: number } | undefined;
    if (!row) throw new Error('找不到关系候选扫描任务');
    return { state: row.state, progress: Number(row.progress) };
  }
}
