import { createHash, randomUUID } from 'node:crypto';
import type {
  AutomationDraftSelectionItemRecord,
  AutomationDraftSelectionReasonCode,
  AutomationDraftSelectionRunRecord,
  AutomationDraftSelectionStart,
  CharacterCandidate,
  JobRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';

export const AUTOMATION_DRAFT_SELECTION_POLICY_VERSION = 'character-draft-selection.v2';

type CandidateSnapshot = {
  identityId: string;
  identityName: string;
  reviewStatus: CharacterCandidate['reviewStatus'];
  importanceTier: CharacterCandidate['importanceTier'];
  importanceScore: number;
  mentionCount: number;
  chapterCount: number;
  dialogueCount: number;
  eventCount: number;
  firstOrdinal: number;
  lastOrdinal: number;
};

type PlannedDecision = {
  selected: boolean;
  reasonCode: AutomationDraftSelectionReasonCode;
  reason: string;
};

type ItemSnapshot = {
  candidate: CandidateSnapshot;
  decision: PlannedDecision;
};

type RunRow = Omit<AutomationDraftSelectionRunRecord, 'items'>;

function now(): string {
  return new Date().toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function candidateOrder(left: CandidateSnapshot, right: CandidateSnapshot): number {
  return right.importanceScore - left.importanceScore
    || right.mentionCount - left.mentionCount
    || right.chapterCount - left.chapterCount
    || left.identityName.localeCompare(right.identityName, 'zh-CN')
    || left.identityId.localeCompare(right.identityId);
}

function buildPlan(candidates: CandidateSnapshot[]): Map<string, PlannedDecision> {
  const pendingWithEvidence = candidates
    .filter((candidate) => candidate.reviewStatus === 'pending' && candidate.mentionCount > 0)
    .sort(candidateOrder);
  const highImportance = pendingWithEvidence
    .filter((candidate) => candidate.importanceTier === 'core' || candidate.importanceTier === 'important');
  const selectedPending = new Set(highImportance.map((candidate) => candidate.identityId));
  let fallbackIdentityId: string | null = null;
  if (!selectedPending.size && pendingWithEvidence.length) {
    fallbackIdentityId = pendingWithEvidence[0].identityId;
    selectedPending.add(fallbackIdentityId);
  }

  return new Map(candidates.map((candidate): [string, PlannedDecision] => {
    if (candidate.reviewStatus === 'confirmed') {
      return [candidate.identityId, {
        selected: true,
        reasonCode: 'human-confirmed',
        reason: '人物已经由用户确认；自动流程仅复用该人工结论，不创建新的确认。',
      }];
    }
    if (candidate.reviewStatus === 'rejected') {
      return [candidate.identityId, {
        selected: false,
        reasonCode: 'human-rejected',
        reason: '人物已经由用户排除，自动流程不会重新纳入。',
      }];
    }
    if (candidate.mentionCount <= 0) {
      return [candidate.identityId, {
        selected: false,
        reasonCode: 'no-evidence',
        reason: '当前候选没有可用人物提及证据，暂不进入自动基础稿。',
      }];
    }
    if (candidate.identityId === fallbackIdentityId) {
      return [candidate.identityId, {
        selected: true,
        reasonCode: 'fallback-with-evidence',
        reason: '当前没有核心或重要待审候选；选择证据和重要度最高的一人作为最小基础稿对象。',
      }];
    }
    if (selectedPending.has(candidate.identityId)) {
      return [candidate.identityId, {
        selected: true,
        reasonCode: 'high-importance',
        reason: `候选仍待人工审核，但当前重要度为${candidate.importanceTier === 'core' ? '核心' : '重要'}，进入自动草稿分析集合。`,
      }];
    }
    return [candidate.identityId, {
      selected: false,
      reasonCode: 'low-importance',
      reason: '当前重要度不足以进入自动基础稿；候选仍保留给用户审核。',
    }];
  }));
}

export class AutomationDraftSelectionService {
  constructor(private readonly store: ProjectStore) {}

  create(workflowRunId: string, profileInput = 'foundation-v1'): AutomationDraftSelectionStart {
    const { db, projectId } = this.store.get();
    const workflow = db.prepare(`SELECT revision_id AS revisionId FROM foundation_workflow_runs
      WHERE id = ? AND project_id = ?`).get(workflowRunId, projectId) as { revisionId: string } | undefined;
    if (!workflow) throw new Error('找不到自动草稿选择所属的一键流程');
    const scanStep = db.prepare(`SELECT state FROM foundation_workflow_steps
      WHERE run_id = ? AND step_key = 'character_scan'`).get(workflowRunId) as { state: string } | undefined;
    if (!scanStep || !['completed', 'skipped'].includes(scanStep.state)) throw new Error('请先完成人物普查，再生成自动草稿选择');
    const profile = profileInput.trim() || 'foundation-v1';
    const candidates = this.candidates(db, workflow.revisionId);
    const inputHash = hash(JSON.stringify({
      revisionId: workflow.revisionId,
      profile,
      policyVersion: AUTOMATION_DRAFT_SELECTION_POLICY_VERSION,
      selectionScope: 'all-evidenced-core-and-important',
      candidates,
    }));
    const existing = db.prepare(`SELECT id, job_id AS jobId, state FROM automation_draft_selection_runs
      WHERE project_id = ? AND revision_id = ? AND profile = ? AND policy_version = ? AND input_hash = ?`)
      .get(projectId, workflow.revisionId, profile, AUTOMATION_DRAFT_SELECTION_POLICY_VERSION, inputHash) as
      { id: string; jobId: string; state: JobRecord['state'] } | undefined;
    if (existing) return { runId: existing.id, jobId: existing.jobId, state: existing.state, reused: true };

    const plan = buildPlan(candidates);
    const ordered = [...candidates].sort((left, right) => {
      const leftSelected = plan.get(left.identityId)?.selected ? 1 : 0;
      const rightSelected = plan.get(right.identityId)?.selected ? 1 : 0;
      return rightSelected - leftSelected || candidateOrder(left, right);
    });
    const runId = randomUUID();
    const jobId = randomUUID();
    const timestamp = now();
    const empty = ordered.length === 0;
    db.transaction(() => {
      db.prepare(`INSERT INTO jobs
        (id, project_id, type, state, progress, message, input_json, input_hash, checkpoint_json,
         lease_owner, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, 'automation-draft-selection', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          jobId,
          projectId,
          empty ? 'completed' : 'running',
          empty ? 1 : 0,
          empty ? '没有人物候选可供自动草稿选择' : '正在准备自动草稿选择',
          JSON.stringify({ workflowRunId, runId, revisionId: workflow.revisionId, profile, policyVersion: AUTOMATION_DRAFT_SELECTION_POLICY_VERSION }),
          inputHash,
          JSON.stringify({ runId, processedCandidates: 0 }),
          empty ? null : 'main',
          empty ? null : new Date(Date.now() + 60_000).toISOString(),
          timestamp,
          timestamp,
        );
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, finished_at, state)
        VALUES (?, ?, 1, ?, ?, ?)`)
        .run(randomUUID(), jobId, timestamp, empty ? timestamp : null, empty ? 'completed' : 'running');
      db.prepare(`INSERT INTO automation_draft_selection_runs
        (id, project_id, revision_id, job_id, profile, policy_version, input_hash, state,
         total_candidates, processed_candidates, selected_count, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`)
        .run(
          runId,
          projectId,
          workflow.revisionId,
          jobId,
          profile,
          AUTOMATION_DRAFT_SELECTION_POLICY_VERSION,
          inputHash,
          empty ? 'completed' : 'running',
          ordered.length,
          empty ? '没有人物候选可供自动草稿选择' : '正在准备自动草稿选择',
          timestamp,
          timestamp,
        );
      const insertItem = db.prepare(`INSERT INTO automation_draft_selection_items
        (run_id, identity_id, ordinal, identity_name, input_snapshot_json, input_hash, status,
         review_status_snapshot, importance_tier_snapshot, importance_score_snapshot, mention_count_snapshot, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`);
      ordered.forEach((candidate, index) => {
        const snapshot = JSON.stringify({ candidate, decision: plan.get(candidate.identityId)! } satisfies ItemSnapshot);
        insertItem.run(
          runId,
          candidate.identityId,
          index + 1,
          candidate.identityName,
          snapshot,
          hash(snapshot),
          candidate.reviewStatus,
          candidate.importanceTier,
          candidate.importanceScore,
          candidate.mentionCount,
          timestamp,
        );
      });
    });
    return { runId, jobId, state: empty ? 'completed' : 'running', reused: false };
  }

  processNext(jobId: string): AutomationDraftSelectionRunRecord {
    const { db, projectId } = this.store.get();
    const run = db.prepare(`SELECT id FROM automation_draft_selection_runs WHERE job_id = ? AND project_id = ?`)
      .get(jobId, projectId) as { id: string } | undefined;
    if (!run) throw new Error('找不到自动草稿选择任务');
    const job = db.prepare('SELECT state FROM jobs WHERE id = ? AND project_id = ?').get(jobId, projectId) as
      { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return this.get(run.id);
    const item = db.prepare(`SELECT identity_id AS identityId, input_snapshot_json AS inputSnapshotJson, input_hash AS inputHash
      FROM automation_draft_selection_items WHERE run_id = ? AND status = 'pending' ORDER BY ordinal LIMIT 1`)
      .get(run.id) as { identityId: string; inputSnapshotJson: string; inputHash: string } | undefined;
    if (!item) {
      this.finishIfDone(db, run.id, jobId);
      return this.get(run.id);
    }
    const timestamp = now();
    db.prepare(`UPDATE automation_draft_selection_items SET status = 'running', updated_at = ?
      WHERE run_id = ? AND identity_id = ? AND status = 'pending'`).run(timestamp, run.id, item.identityId);
    try {
      if (hash(item.inputSnapshotJson) !== item.inputHash) throw new Error('自动草稿选择项输入指纹不一致');
      const snapshot = JSON.parse(item.inputSnapshotJson) as ItemSnapshot;
      if (snapshot.candidate.identityId !== item.identityId) throw new Error('自动草稿选择项人物引用不一致');
      db.transaction(() => {
        db.prepare(`UPDATE automation_draft_selection_items SET status = 'completed', selected = ?, reason_code = ?, reason = ?,
          error = NULL, updated_at = ? WHERE run_id = ? AND identity_id = ?`)
          .run(snapshot.decision.selected ? 1 : 0, snapshot.decision.reasonCode, snapshot.decision.reason, timestamp, run.id, item.identityId);
        this.refreshProgress(db, run.id, jobId, timestamp);
      });
    } catch (error) {
      this.fail(db, run.id, jobId, item.identityId, error instanceof Error ? error.message : String(error));
    }
    return this.get(run.id);
  }

  get(runId: string): AutomationDraftSelectionRunRecord {
    const { db, projectId } = this.store.get();
    const row = db.prepare(`${this.runSelect()} WHERE r.id = ? AND r.project_id = ?`).get(runId, projectId) as RunRow | undefined;
    if (!row) throw new Error('找不到自动草稿选择运行');
    return {
      ...row,
      totalCandidates: Number(row.totalCandidates),
      processedCandidates: Number(row.processedCandidates),
      selectedCount: Number(row.selectedCount),
      progress: Number(row.progress),
      items: this.items(db, runId),
    };
  }

  getByJob(jobId: string): AutomationDraftSelectionRunRecord {
    const { db, projectId } = this.store.get();
    const row = db.prepare(`SELECT id FROM automation_draft_selection_runs WHERE job_id = ? AND project_id = ?`)
      .get(jobId, projectId) as { id: string } | undefined;
    if (!row) throw new Error('找不到自动草稿选择任务');
    return this.get(row.id);
  }

  controlJob(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): AutomationDraftSelectionRunRecord {
    const { db, projectId } = this.store.get();
    const row = db.prepare(`SELECT r.id, j.state FROM automation_draft_selection_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.job_id = ? AND r.project_id = ?`).get(jobId, projectId) as { id: string; state: JobRecord['state'] } | undefined;
    if (!row) throw new Error('找不到自动草稿选择任务');
    const transitions: Record<typeof action, JobRecord['state'][]> = {
      pause: ['running'],
      resume: ['paused', 'queued'],
      cancel: ['queued', 'running', 'paused'],
      retry: ['failed'],
    };
    if (!transitions[action].includes(row.state)) throw new Error(`任务状态 ${row.state} 不能执行 ${action}`);
    const timestamp = now();
    const target: JobRecord['state'] = action === 'pause' ? 'paused'
      : action === 'cancel' ? 'cancelled'
        : action === 'retry' ? 'queued'
          : 'running';
    const message = action === 'pause' ? '自动草稿选择已暂停'
      : action === 'cancel' ? '自动草稿选择已取消'
        : action === 'retry' ? '自动草稿选择等待重试'
          : '自动草稿选择继续运行';
    db.transaction(() => {
      if (action === 'retry') {
        db.prepare(`UPDATE automation_draft_selection_items SET status = 'pending', error = NULL, updated_at = ?
          WHERE run_id = ? AND status IN ('running','failed')`).run(timestamp, row.id);
      } else if (action === 'pause') {
        db.prepare(`UPDATE automation_draft_selection_items SET status = 'pending', updated_at = ?
          WHERE run_id = ? AND status = 'running'`).run(timestamp, row.id);
      } else if (action === 'cancel') {
        db.prepare(`UPDATE automation_draft_selection_items SET status = 'cancelled', updated_at = ?
          WHERE run_id = ? AND status IN ('pending','running')`).run(timestamp, row.id);
      }
      db.prepare(`UPDATE automation_draft_selection_runs SET state = ?, message = ?, error = NULL, updated_at = ? WHERE id = ?`)
        .run(target, message, timestamp, row.id);
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
        db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`)
          .run(randomUUID(), jobId, Number(attempt.value), timestamp);
      }
    });
    return this.get(row.id);
  }

  selectedForAutomation(runId: string): AutomationDraftSelectionItemRecord[] {
    const { db, projectId } = this.store.get();
    const run = db.prepare(`SELECT r.id FROM automation_draft_selection_runs r
      WHERE r.id = ? AND r.project_id = ? AND r.state = 'completed'`).get(runId, projectId);
    if (!run) throw new Error('自动草稿选择尚未完成');
    return db.prepare(`SELECT s.identity_id AS identityId, s.identity_name AS identityName, s.ordinal, s.status,
      CAST(s.selected AS INTEGER) AS selected, s.reason_code AS reasonCode, s.reason,
      s.review_status_snapshot AS reviewStatusSnapshot, s.importance_tier_snapshot AS importanceTierSnapshot,
      s.importance_score_snapshot AS importanceScoreSnapshot, s.mention_count_snapshot AS mentionCountSnapshot,
      s.updated_at AS updatedAt
      FROM automation_draft_selection_items s JOIN person_identities i ON i.id = s.identity_id
      WHERE s.run_id = ? AND s.status = 'completed' AND s.selected = 1 AND i.review_status != 'rejected'
      ORDER BY s.ordinal`).all(runId).map((item) => this.mapItem(item as Record<string, unknown>));
  }

  private candidates(db: SQLiteDatabase, revisionId: string): CandidateSnapshot[] {
    const rows = db.prepare(`SELECT i.id AS identityId, i.canonical_name AS identityName,
      i.review_status AS reviewStatus, i.importance_tier AS importanceTier,
      i.importance_score AS importanceScore, COALESCE(m.mention_count, 0) AS mentionCount,
      COALESCE(m.chapter_count, 0) AS chapterCount, COALESCE(m.dialogue_count, 0) AS dialogueCount,
      COALESCE(m.event_count, 0) AS eventCount, COALESCE(m.first_ordinal, 0) AS firstOrdinal,
      COALESCE(m.last_ordinal, 0) AS lastOrdinal
      FROM person_identities i LEFT JOIN person_metrics m ON m.identity_id = i.id
      WHERE i.revision_id = ? ORDER BY i.id`).all(revisionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      identityId: String(row.identityId),
      identityName: String(row.identityName),
      reviewStatus: row.reviewStatus as CandidateSnapshot['reviewStatus'],
      importanceTier: row.importanceTier as CandidateSnapshot['importanceTier'],
      importanceScore: Number(row.importanceScore),
      mentionCount: Number(row.mentionCount),
      chapterCount: Number(row.chapterCount),
      dialogueCount: Number(row.dialogueCount),
      eventCount: Number(row.eventCount),
      firstOrdinal: Number(row.firstOrdinal),
      lastOrdinal: Number(row.lastOrdinal),
    }));
  }

  private refreshProgress(db: SQLiteDatabase, runId: string, jobId: string, timestamp: string): void {
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS processed,
      SUM(CASE WHEN status = 'completed' AND selected = 1 THEN 1 ELSE 0 END) AS selected,
      SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining
      FROM automation_draft_selection_items WHERE run_id = ?`).get(runId) as
      { total: number; processed: number; selected: number; remaining: number };
    const total = Number(counts.total);
    const processed = Number(counts.processed);
    const selected = Number(counts.selected);
    const finished = Number(counts.remaining) === 0;
    const progress = total ? processed / total : 1;
    const message = finished
      ? `自动草稿选择完成：从 ${total} 个人物候选中选择 ${selected} 人继续分析`
      : `自动草稿选择：已处理 ${processed}/${total} 个人物候选`;
    db.prepare(`UPDATE automation_draft_selection_runs SET state = ?, processed_candidates = ?, selected_count = ?,
      message = ?, error = NULL, updated_at = ? WHERE id = ?`)
      .run(finished ? 'completed' : 'running', processed, selected, message, timestamp, runId);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, checkpoint_json = ?,
      lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(
        finished ? 'completed' : 'running',
        progress,
        message,
        JSON.stringify({ runId, processedCandidates: processed }),
        finished ? null : 'main',
        finished ? null : new Date(Date.now() + 60_000).toISOString(),
        timestamp,
        jobId,
      );
    if (finished) {
      db.prepare(`UPDATE job_attempts SET state = 'completed', finished_at = ?
        WHERE job_id = ? AND state = 'running'`).run(timestamp, jobId);
    }
  }

  private finishIfDone(db: SQLiteDatabase, runId: string, jobId: string): void {
    const remaining = db.prepare(`SELECT COUNT(*) AS value FROM automation_draft_selection_items
      WHERE run_id = ? AND status IN ('pending','running')`).get(runId) as { value: number };
    if (Number(remaining.value) === 0) this.refreshProgress(db, runId, jobId, now());
  }

  private fail(db: SQLiteDatabase, runId: string, jobId: string, identityId: string, errorInput: string): void {
    const timestamp = now();
    const error = errorInput.trim().slice(0, 2000) || '自动草稿选择失败';
    db.transaction(() => {
      db.prepare(`UPDATE automation_draft_selection_items SET status = 'failed', error = ?, updated_at = ?
        WHERE run_id = ? AND identity_id = ?`).run(error, timestamp, runId, identityId);
      db.prepare(`UPDATE automation_draft_selection_runs SET state = 'failed', message = ?, error = ?, updated_at = ? WHERE id = ?`)
        .run(error, error, timestamp, runId);
      db.prepare(`UPDATE jobs SET state = 'failed', message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(error, timestamp, jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', error = ?, finished_at = ?
        WHERE job_id = ? AND state = 'running'`).run(error, timestamp, jobId);
    });
  }

  private items(db: SQLiteDatabase, runId: string): AutomationDraftSelectionItemRecord[] {
    return (db.prepare(`SELECT identity_id AS identityId, identity_name AS identityName, ordinal, status,
      selected, reason_code AS reasonCode, reason, review_status_snapshot AS reviewStatusSnapshot,
      importance_tier_snapshot AS importanceTierSnapshot, importance_score_snapshot AS importanceScoreSnapshot,
      mention_count_snapshot AS mentionCountSnapshot, updated_at AS updatedAt
      FROM automation_draft_selection_items WHERE run_id = ? ORDER BY ordinal`).all(runId) as Array<Record<string, unknown>>)
      .map((item) => this.mapItem(item));
  }

  private mapItem(item: Record<string, unknown>): AutomationDraftSelectionItemRecord {
    return {
      identityId: String(item.identityId),
      identityName: String(item.identityName),
      ordinal: Number(item.ordinal),
      status: item.status as AutomationDraftSelectionItemRecord['status'],
      selected: item.selected === null || item.selected === undefined ? null : Number(item.selected) === 1,
      reasonCode: item.reasonCode as AutomationDraftSelectionReasonCode | null,
      reason: item.reason === null || item.reason === undefined ? null : String(item.reason),
      reviewStatusSnapshot: item.reviewStatusSnapshot as AutomationDraftSelectionItemRecord['reviewStatusSnapshot'],
      importanceTierSnapshot: item.importanceTierSnapshot as AutomationDraftSelectionItemRecord['importanceTierSnapshot'],
      importanceScoreSnapshot: Number(item.importanceScoreSnapshot),
      mentionCountSnapshot: Number(item.mentionCountSnapshot),
      updatedAt: String(item.updatedAt),
    };
  }

  private runSelect(): string {
    return `SELECT r.id, r.job_id AS jobId, r.revision_id AS revisionId, r.profile,
      r.policy_version AS policyVersion, r.input_hash AS inputHash, r.state,
      r.total_candidates AS totalCandidates, r.processed_candidates AS processedCandidates,
      r.selected_count AS selectedCount, j.progress, r.message, r.error,
      r.created_at AS createdAt, r.updated_at AS updatedAt
      FROM automation_draft_selection_runs r JOIN jobs j ON j.id = r.job_id`;
  }
}
