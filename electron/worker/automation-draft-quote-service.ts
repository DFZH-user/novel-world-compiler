import { createHash, randomUUID } from 'node:crypto';
import type {
  AutomationDraftQuoteItemRecord,
  AutomationDraftQuoteRunRecord,
  AutomationDraftQuoteStart,
  JobRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { detectChineseQuotes, explicitCandidates, type IdentityForm } from './quote-service';

export const AUTOMATION_DRAFT_QUOTE_ALGORITHM_VERSION = 'draft-quote-scan.v1';

type RunRow = Omit<AutomationDraftQuoteRunRecord, 'items'>;
type RunAccess = {
  id: string;
  jobId: string;
  revisionId: string;
  selectionRunId: string;
  inputHash: string;
  totalParagraphs: number;
};

function now(): string {
  return new Date().toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class AutomationDraftQuoteService {
  constructor(private readonly store: ProjectStore) {}

  create(selectionRunId: string): AutomationDraftQuoteStart {
    const { db, projectId } = this.store.get();
    const selection = db.prepare(`SELECT s.revision_id AS revisionId, s.input_hash AS inputHash
      FROM automation_draft_selection_runs s
      JOIN projects p ON p.id = s.project_id AND p.active_revision_id = s.revision_id
      WHERE s.id = ? AND s.project_id = ? AND s.state = 'completed'`)
      .get(selectionRunId, projectId) as { revisionId: string; inputHash: string } | undefined;
    if (!selection) throw new Error('自动草稿选择尚未完成或不属于当前原文修订');

    const selected = db.prepare(`SELECT si.identity_id AS identityId, si.input_hash AS itemInputHash
      FROM automation_draft_selection_items si
      JOIN person_identities i ON i.id = si.identity_id AND i.revision_id = ?
      WHERE si.run_id = ? AND si.status = 'completed' AND si.selected = 1 AND i.review_status != 'rejected'
      ORDER BY si.ordinal`).all(selection.revisionId, selectionRunId) as
      Array<{ identityId: string; itemInputHash: string }>;
    const paragraphs = selected.length
      ? db.prepare(`SELECT p.id, p.ordinal, p.text, p.content_hash AS contentHash
          FROM paragraphs p LEFT JOIN paragraph_exclusions x ON x.paragraph_id = p.id
          WHERE p.revision_id = ? AND COALESCE(x.excluded, 0) = 0 ORDER BY p.ordinal`)
        .all(selection.revisionId) as Array<{ id: string; ordinal: number; text: string; contentHash: string | null }>
      : [];
    const paragraphInputs = paragraphs.map((paragraph) => ({
      id: paragraph.id,
      ordinal: Number(paragraph.ordinal),
      contentHash: paragraph.contentHash || hash(paragraph.text),
    }));
    const inputHash = hash(JSON.stringify({
      revisionId: selection.revisionId,
      selectionRunId,
      selectionInputHash: selection.inputHash,
      algorithmVersion: AUTOMATION_DRAFT_QUOTE_ALGORITHM_VERSION,
      selected,
      paragraphs: paragraphInputs,
    }));
    const existing = db.prepare(`SELECT id, job_id AS jobId, state FROM automation_draft_quote_runs
      WHERE project_id = ? AND revision_id = ? AND selection_run_id = ? AND algorithm_version = ? AND input_hash = ?`)
      .get(projectId, selection.revisionId, selectionRunId, AUTOMATION_DRAFT_QUOTE_ALGORITHM_VERSION, inputHash) as
      { id: string; jobId: string; state: JobRecord['state'] } | undefined;
    if (existing) return { runId: existing.id, jobId: existing.jobId, state: existing.state, reused: true };

    const runId = randomUUID();
    const jobId = randomUUID();
    const timestamp = now();
    const empty = paragraphInputs.length === 0;
    const message = empty ? '自动草稿集合没有可扫描的对白材料' : '正在准备自动对白草稿扫描';
    db.transaction(() => {
      db.prepare(`INSERT INTO jobs
        (id, project_id, type, state, progress, message, input_json, input_hash, checkpoint_json,
         lease_owner, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, 'automation-draft-quotes', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          jobId,
          projectId,
          empty ? 'completed' : 'running',
          empty ? 1 : 0,
          message,
          JSON.stringify({ runId, selectionRunId, revisionId: selection.revisionId, algorithmVersion: AUTOMATION_DRAFT_QUOTE_ALGORITHM_VERSION }),
          inputHash,
          JSON.stringify({ runId, completedParagraphs: 0 }),
          empty ? null : 'main',
          empty ? null : new Date(Date.now() + 60_000).toISOString(),
          timestamp,
          timestamp,
        );
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, finished_at, state)
        VALUES (?, ?, 1, ?, ?, ?)`)
        .run(randomUUID(), jobId, timestamp, empty ? timestamp : null, empty ? 'completed' : 'running');
      db.prepare(`INSERT INTO automation_draft_quote_runs
        (id, project_id, revision_id, selection_run_id, job_id, algorithm_version, input_hash, state,
         total_paragraphs, completed_paragraphs, quote_count, attribution_count, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?)`)
        .run(runId, projectId, selection.revisionId, selectionRunId, jobId, AUTOMATION_DRAFT_QUOTE_ALGORITHM_VERSION,
          inputHash, empty ? 'completed' : 'running', paragraphInputs.length, message, timestamp, timestamp);
      const insert = db.prepare(`INSERT INTO automation_draft_quote_items
        (run_id, paragraph_id, paragraph_ordinal, input_hash, status, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?)`);
      paragraphInputs.forEach((paragraph) => {
        insert.run(runId, paragraph.id, paragraph.ordinal,
          hash(JSON.stringify({ runInputHash: inputHash, paragraphId: paragraph.id, contentHash: paragraph.contentHash })), timestamp);
      });
    });
    return { runId, jobId, state: empty ? 'completed' : 'running', reused: false };
  }

  processNext(jobId: string): AutomationDraftQuoteRunRecord {
    const { db, projectId } = this.store.get();
    const run = this.runAccess(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ? AND project_id = ?').get(jobId, projectId) as
      { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return this.summary(run.id);
    const item = db.prepare(`SELECT paragraph_id AS paragraphId, paragraph_ordinal AS paragraphOrdinal, input_hash AS inputHash
      FROM automation_draft_quote_items WHERE run_id = ? AND status = 'pending' ORDER BY paragraph_ordinal LIMIT 1`)
      .get(run.id) as { paragraphId: string; paragraphOrdinal: number; inputHash: string } | undefined;
    if (!item) {
      this.finishIfDone(db, run, now());
      return this.summary(run.id);
    }

    const timestamp = now();
    db.prepare(`UPDATE automation_draft_quote_items SET status = 'running', updated_at = ?
      WHERE run_id = ? AND paragraph_id = ? AND status = 'pending'`).run(timestamp, run.id, item.paragraphId);
    try {
      const paragraph = db.prepare(`SELECT id, ordinal, text, content_hash AS contentHash
        FROM paragraphs WHERE id = ? AND revision_id = ?`).get(item.paragraphId, run.revisionId) as
        { id: string; ordinal: number; text: string; contentHash: string | null } | undefined;
      if (!paragraph) throw new Error('自动对白草稿段落已经不存在');
      const contentHash = paragraph.contentHash || hash(paragraph.text);
      const expectedItemHash = hash(JSON.stringify({ runInputHash: run.inputHash, paragraphId: paragraph.id, contentHash }));
      if (expectedItemHash !== item.inputHash) throw new Error('自动对白草稿段落输入指纹不一致');

      const forms = this.identityForms(db, run.revisionId, run.selectionRunId);
      const mentions = this.nearbyMentions(db, run.revisionId, run.selectionRunId, Number(paragraph.ordinal));
      const identityNames = new Map(forms.map((form) => [form.identityId, form.identityName]));
      let quoteCount = 0;
      let attributionCount = 0;
      db.transaction(() => {
        for (const quote of detectChineseQuotes(paragraph.text)) {
          quoteCount += 1;
          const quoteId = 'cq_' + hash([
            run.revisionId,
            paragraph.id,
            quote.startOffset,
            quote.endOffset,
            quote.quoteType,
            quote.quoteText,
          ].join(':')).slice(0, 32);
          db.prepare(`INSERT OR IGNORE INTO character_quotes
            (id, revision_id, paragraph_id, start_offset, end_offset, quote_text, quote_type, detection_method, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'rule', ?)`)
            .run(quoteId, run.revisionId, paragraph.id, quote.startOffset, quote.endOffset, quote.quoteText, quote.quoteType, timestamp);
          const explicit = explicitCandidates(paragraph.text, quote, forms);
          if (explicit.length) {
            for (const candidate of explicit) {
              this.insertPendingCandidate(db, quoteId, candidate.identityId, 'explicit_cue', candidate.confidence,
                paragraph.id, candidate.evidenceText,
                candidate.reasoning + '；来自自动草稿选择，仍需人工审核', timestamp);
              attributionCount += 1;
            }
            continue;
          }
          const nearby = new Map<string, { confidence: number; distance: number }>();
          for (const mention of mentions) {
            const distance = Math.abs(mention.ordinal - Number(paragraph.ordinal));
            const confidence = Math.min(0.72, 0.5 + mention.confidence * 0.15 - distance * 0.08);
            const prior = nearby.get(mention.identityId);
            if (!prior || confidence > prior.confidence) nearby.set(mention.identityId, { confidence, distance });
          }
          for (const [identityId, candidate] of [...nearby.entries()].sort((left, right) => right[1].confidence - left[1].confidence).slice(0, 5)) {
            this.insertPendingCandidate(db, quoteId, identityId, 'nearby_context', candidate.confidence,
              paragraph.id, '', (identityNames.get(identityId) || '该人物') + '出现在对白'
                + (candidate.distance ? '相邻段落' : '所在段落') + '；来自自动草稿选择，仅作为待审核候选', timestamp);
            attributionCount += 1;
          }
        }
        db.prepare(`UPDATE automation_draft_quote_items
          SET status = 'completed', quote_count = ?, attribution_count = ?, error = NULL, updated_at = ?
          WHERE run_id = ? AND paragraph_id = ?`)
          .run(quoteCount, attributionCount, timestamp, run.id, paragraph.id);
        this.advanceProgress(db, run, timestamp, quoteCount, attributionCount);
      });
    } catch (error) {
      this.fail(db, run, item.paragraphId, error instanceof Error ? error.message : String(error));
    }
    return this.summary(run.id);
  }

  get(runId: string): AutomationDraftQuoteRunRecord {
    return this.readRun(runId, true);
  }

  private summary(runId: string): AutomationDraftQuoteRunRecord {
    return this.readRun(runId, false);
  }

  private readRun(runId: string, includeItems: boolean): AutomationDraftQuoteRunRecord {
    const { db, projectId } = this.store.get();
    const row = db.prepare(this.runSelect() + ' WHERE r.id = ? AND r.project_id = ?').get(runId, projectId) as RunRow | undefined;
    if (!row) throw new Error('找不到自动对白草稿任务');
    return {
      ...row,
      totalParagraphs: Number(row.totalParagraphs),
      completedParagraphs: Number(row.completedParagraphs),
      quoteCount: Number(row.quoteCount),
      attributionCount: Number(row.attributionCount),
      progress: Number(row.progress),
      // processNext is an internal high-frequency channel. Returning every paragraph
      // checkpoint on every call makes a full novel quadratic in both SQL and IPC size.
      // Explicit get/getByJob calls still return the complete resumable item ledger.
      items: includeItems ? this.items(db, runId) : [],
    };
  }

  getByJob(jobId: string): AutomationDraftQuoteRunRecord {
    const { db, projectId } = this.store.get();
    return this.get(this.runAccess(db, projectId, jobId).id);
  }

  controlJob(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): AutomationDraftQuoteRunRecord {
    const { db, projectId } = this.store.get();
    const run = this.runAccess(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ? AND project_id = ?').get(jobId, projectId) as
      { state: JobRecord['state'] } | undefined;
    if (!job) throw new Error('找不到自动对白草稿任务');
    const allowed: Record<typeof action, JobRecord['state'][]> = {
      pause: ['running'],
      resume: ['paused', 'queued'],
      cancel: ['queued', 'running', 'paused'],
      retry: ['failed'],
    };
    if (!allowed[action].includes(job.state)) throw new Error('任务状态 ' + job.state + ' 不能执行 ' + action);
    const timestamp = now();
    const target: JobRecord['state'] = action === 'pause' ? 'paused'
      : action === 'cancel' ? 'cancelled'
        : action === 'retry' ? 'queued'
          : 'running';
    const message = action === 'pause' ? '自动对白草稿已暂停'
      : action === 'cancel' ? '自动对白草稿已取消'
        : action === 'retry' ? '自动对白草稿等待重试'
          : '自动对白草稿继续运行';
    db.transaction(() => {
      if (action === 'retry') {
        db.prepare(`UPDATE automation_draft_quote_items SET status = 'pending', error = NULL, updated_at = ?
          WHERE run_id = ? AND status IN ('running','failed')`).run(timestamp, run.id);
      } else if (action === 'pause') {
        db.prepare(`UPDATE automation_draft_quote_items SET status = 'pending', updated_at = ?
          WHERE run_id = ? AND status = 'running'`).run(timestamp, run.id);
      } else if (action === 'cancel') {
        db.prepare(`UPDATE automation_draft_quote_items SET status = 'cancelled', updated_at = ?
          WHERE run_id = ? AND status IN ('pending','running')`).run(timestamp, run.id);
      }
      db.prepare(`UPDATE automation_draft_quote_runs SET state = ?, message = ?, error = NULL, updated_at = ? WHERE id = ?`)
        .run(target, message, timestamp, run.id);
      db.prepare(`UPDATE jobs SET state = ?, message = ?, lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
        .run(target, message, target === 'running' ? 'main' : null,
          target === 'running' ? new Date(Date.now() + 60_000).toISOString() : null, timestamp, jobId);
      if (action === 'pause' || action === 'cancel' || action === 'retry') {
        db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`)
          .run(action === 'retry' ? 'failed' : target, timestamp, jobId);
      }
      if (action === 'resume') {
        const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?')
          .get(jobId) as { value: number };
        db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state)
          VALUES (?, ?, ?, ?, 'running')`).run(randomUUID(), jobId, Number(attempt.value), timestamp);
      }
    });
    return this.get(run.id);
  }

  private runAccess(db: SQLiteDatabase, projectId: string, jobId: string): RunAccess {
    const row = db.prepare(`SELECT id, job_id AS jobId, revision_id AS revisionId,
      selection_run_id AS selectionRunId, input_hash AS inputHash, total_paragraphs AS totalParagraphs
      FROM automation_draft_quote_runs WHERE job_id = ? AND project_id = ?`).get(jobId, projectId) as RunAccess | undefined;
    if (!row) throw new Error('找不到自动对白草稿任务');
    return { ...row, totalParagraphs: Number(row.totalParagraphs) };
  }

  private identityForms(db: SQLiteDatabase, revisionId: string, selectionRunId: string): IdentityForm[] {
    const rows = db.prepare(`SELECT i.id AS identityId, i.canonical_name AS identityName,
        i.canonical_name AS form, i.review_status AS reviewStatus
      FROM automation_draft_selection_items si JOIN person_identities i ON i.id = si.identity_id
      WHERE si.run_id = ? AND si.status = 'completed' AND si.selected = 1
        AND i.revision_id = ? AND i.review_status != 'rejected'
      UNION ALL
      SELECT i.id, i.canonical_name, a.alias, i.review_status
      FROM automation_draft_selection_items si JOIN person_identities i ON i.id = si.identity_id
      JOIN person_aliases a ON a.identity_id = i.id
      WHERE si.run_id = ? AND si.status = 'completed' AND si.selected = 1
        AND i.revision_id = ? AND i.review_status != 'rejected' AND a.review_status = 'confirmed'`)
      .all(selectionRunId, revisionId, selectionRunId, revisionId) as
      Array<{ identityId: string; identityName: string; form: string; reviewStatus: string }>;
    const seen = new Set<string>();
    return rows.filter((row) => row.form.trim().length >= 2)
      .sort((left, right) => right.form.length - left.form.length)
      .flatMap((row) => {
        const key = row.identityId + ':' + row.form;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ identityId: row.identityId, identityName: row.identityName, form: row.form, confirmed: row.reviewStatus === 'confirmed' }];
      });
  }

  private nearbyMentions(
    db: SQLiteDatabase,
    revisionId: string,
    selectionRunId: string,
    paragraphOrdinal: number,
  ): Array<{ ordinal: number; identityId: string; confidence: number }> {
    return db.prepare(`SELECT p.ordinal, m.identity_id AS identityId, MAX(m.confidence) AS confidence
      FROM person_mentions m JOIN paragraphs p ON p.id = m.paragraph_id
      JOIN automation_draft_selection_items si ON si.identity_id = m.identity_id AND si.run_id = ?
      JOIN person_identities i ON i.id = m.identity_id
      WHERE m.revision_id = ? AND p.ordinal BETWEEN ? AND ?
        AND si.status = 'completed' AND si.selected = 1 AND i.review_status != 'rejected'
      GROUP BY p.ordinal, m.identity_id`)
      .all(selectionRunId, revisionId, paragraphOrdinal - 1, paragraphOrdinal + 1)
      .map((row) => {
        const value = row as { ordinal: number; identityId: string; confidence: number };
        return { ordinal: Number(value.ordinal), identityId: value.identityId, confidence: Number(value.confidence) };
      });
  }

  private insertPendingCandidate(
    db: SQLiteDatabase,
    quoteId: string,
    identityId: string,
    method: 'explicit_cue' | 'nearby_context',
    confidence: number,
    paragraphId: string,
    evidenceText: string,
    reasoning: string,
    timestamp: string,
  ): void {
    const attributionId = 'cqa_' + hash([quoteId, identityId, 'speaker', method].join(':')).slice(0, 32);
    db.prepare(`INSERT OR IGNORE INTO character_quote_attributions
      (id, quote_id, identity_id, role, method, confidence, review_status,
       evidence_paragraph_id, evidence_text, reasoning, created_at, updated_at)
      VALUES (?, ?, ?, 'speaker', ?, ?, 'pending', ?, ?, ?, ?, ?)`)
      .run(attributionId, quoteId, identityId, method, confidence, paragraphId, evidenceText, reasoning, timestamp, timestamp);
  }

  private refreshProgress(db: SQLiteDatabase, run: RunAccess, timestamp: string): void {
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'completed' THEN quote_count ELSE 0 END) AS quoteCount,
      SUM(CASE WHEN status = 'completed' THEN attribution_count ELSE 0 END) AS attributionCount,
      SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining
      FROM automation_draft_quote_items WHERE run_id = ?`).get(run.id) as
      { total: number; completed: number; quoteCount: number; attributionCount: number; remaining: number };
    const total = Number(counts.total);
    const completed = Number(counts.completed);
    const quoteCount = Number(counts.quoteCount);
    const attributionCount = Number(counts.attributionCount);
    const finished = Number(counts.remaining) === 0;
    const progress = total ? completed / total : 1;
    const message = finished
      ? '自动对白草稿完成：识别 ' + quoteCount + ' 条对白，生成 ' + attributionCount + ' 条待审归属候选'
      : '自动对白草稿：已扫描 ' + completed + '/' + total + ' 个段落';
    db.prepare(`UPDATE automation_draft_quote_runs SET state = ?, completed_paragraphs = ?,
      quote_count = ?, attribution_count = ?, message = ?, error = NULL, updated_at = ? WHERE id = ?`)
      .run(finished ? 'completed' : 'running', completed, quoteCount, attributionCount, message, timestamp, run.id);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, checkpoint_json = ?,
      lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(finished ? 'completed' : 'running', progress, message,
        JSON.stringify({ runId: run.id, completedParagraphs: completed }),
        finished ? null : 'main', finished ? null : new Date(Date.now() + 60_000).toISOString(), timestamp, run.jobId);
    if (finished) {
      db.prepare(`UPDATE job_attempts SET state = 'completed', finished_at = ?
        WHERE job_id = ? AND state = 'running'`).run(timestamp, run.jobId);
    }
  }

  private advanceProgress(
    db: SQLiteDatabase,
    run: RunAccess,
    timestamp: string,
    quoteDelta: number,
    attributionDelta: number,
  ): void {
    db.prepare(`UPDATE automation_draft_quote_runs SET
      completed_paragraphs = completed_paragraphs + 1,
      quote_count = quote_count + ?, attribution_count = attribution_count + ?, updated_at = ?
      WHERE id = ?`).run(quoteDelta, attributionDelta, timestamp, run.id);
    const counts = db.prepare(`SELECT completed_paragraphs AS completed, quote_count AS quoteCount,
      attribution_count AS attributionCount FROM automation_draft_quote_runs WHERE id = ?`).get(run.id) as
      { completed: number; quoteCount: number; attributionCount: number };
    const completed = Number(counts.completed);
    const quoteCount = Number(counts.quoteCount);
    const attributionCount = Number(counts.attributionCount);
    const finished = completed >= run.totalParagraphs;
    const progress = run.totalParagraphs ? completed / run.totalParagraphs : 1;
    const message = finished
      ? '自动对白草稿完成：识别 ' + quoteCount + ' 条对白，生成 ' + attributionCount + ' 条待审归属候选'
      : '自动对白草稿：已扫描 ' + completed + '/' + run.totalParagraphs + ' 个段落';
    db.prepare(`UPDATE automation_draft_quote_runs SET state = ?, message = ?, error = NULL, updated_at = ? WHERE id = ?`)
      .run(finished ? 'completed' : 'running', message, timestamp, run.id);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, checkpoint_json = ?,
      lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(finished ? 'completed' : 'running', progress, message,
        JSON.stringify({ runId: run.id, completedParagraphs: completed }),
        finished ? null : 'main', finished ? null : new Date(Date.now() + 60_000).toISOString(), timestamp, run.jobId);
    if (finished) {
      db.prepare(`UPDATE job_attempts SET state = 'completed', finished_at = ?
        WHERE job_id = ? AND state = 'running'`).run(timestamp, run.jobId);
    }
  }
  private finishIfDone(db: SQLiteDatabase, run: RunAccess, timestamp: string): void {
    const remaining = db.prepare(`SELECT COUNT(*) AS value FROM automation_draft_quote_items
      WHERE run_id = ? AND status IN ('pending','running')`).get(run.id) as { value: number };
    if (Number(remaining.value) === 0) this.refreshProgress(db, run, timestamp);
  }

  private fail(db: SQLiteDatabase, run: RunAccess, paragraphId: string, errorInput: string): void {
    const timestamp = now();
    const error = errorInput.trim().slice(0, 2000) || '自动对白草稿失败';
    db.transaction(() => {
      db.prepare(`UPDATE automation_draft_quote_items SET status = 'failed', error = ?, updated_at = ?
        WHERE run_id = ? AND paragraph_id = ?`).run(error, timestamp, run.id, paragraphId);
      db.prepare(`UPDATE automation_draft_quote_runs SET state = 'failed', message = ?, error = ?, updated_at = ? WHERE id = ?`)
        .run(error, error, timestamp, run.id);
      db.prepare(`UPDATE jobs SET state = 'failed', message = ?, lease_owner = NULL,
        lease_expires_at = NULL, updated_at = ? WHERE id = ?`).run(error, timestamp, run.jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', error = ?, finished_at = ?
        WHERE job_id = ? AND state = 'running'`).run(error, timestamp, run.jobId);
    });
  }

  private items(db: SQLiteDatabase, runId: string): AutomationDraftQuoteItemRecord[] {
    return (db.prepare(`SELECT paragraph_id AS paragraphId, paragraph_ordinal AS paragraphOrdinal,
      status, quote_count AS quoteCount, attribution_count AS attributionCount, error, updated_at AS updatedAt
      FROM automation_draft_quote_items WHERE run_id = ? ORDER BY paragraph_ordinal`)
      .all(runId) as Array<Record<string, unknown>>).map((row) => ({
        paragraphId: String(row.paragraphId),
        paragraphOrdinal: Number(row.paragraphOrdinal),
        status: row.status as AutomationDraftQuoteItemRecord['status'],
        quoteCount: Number(row.quoteCount),
        attributionCount: Number(row.attributionCount),
        error: row.error === null || row.error === undefined ? null : String(row.error),
        updatedAt: String(row.updatedAt),
      }));
  }

  private runSelect(): string {
    return `SELECT r.id, r.job_id AS jobId, r.revision_id AS revisionId,
      r.selection_run_id AS selectionRunId, r.algorithm_version AS algorithmVersion,
      r.input_hash AS inputHash, r.state, r.total_paragraphs AS totalParagraphs,
      r.completed_paragraphs AS completedParagraphs, r.quote_count AS quoteCount,
      r.attribution_count AS attributionCount, j.progress, r.message, r.error,
      r.created_at AS createdAt, r.updated_at AS updatedAt
      FROM automation_draft_quote_runs r JOIN jobs j ON j.id = r.job_id`;
  }
}