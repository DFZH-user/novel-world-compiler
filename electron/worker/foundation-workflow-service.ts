import { createHash, randomUUID } from 'node:crypto';
import type {
  FoundationWorkflowControlAction,
  FoundationWorkflowRunRecord,
  FoundationWorkflowStart,
  FoundationWorkflowStepKey,
  FoundationWorkflowStepRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';

const stepDefinitions: Array<{ key: FoundationWorkflowStepKey; label: string }> = [
  { key: 'preflight', label: '工程预检' },
  { key: 'chunks', label: '分析分块' },
  { key: 'character_scan', label: '人物普查' },
  { key: 'draft_selection', label: '自动草稿选择' },
  { key: 'character_facts', label: '人物事实草稿' },
  { key: 'dialogue_scan', label: '对白草稿' },
  { key: 'time_expressions', label: '时间表达式草稿' },
  { key: 'event_drafts', label: '事件草稿' },
  { key: 'place_drafts', label: '地点草稿' },
  { key: 'relationship_drafts', label: '关系草稿' },
  { key: 'summary', label: '基础汇总' },
];

type RunRow = Omit<FoundationWorkflowRunRecord, 'steps'>;

function now(): string {
  return new Date().toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class FoundationWorkflowService {
  constructor(private readonly store: ProjectStore) {}

  create(modelInput: string, profileInput = 'foundation-v1'): FoundationWorkflowStart {
    const { db, projectId } = this.store.get();
    const model = modelInput.trim();
    const profile = profileInput.trim() || 'foundation-v1';
    if (!model) throw new Error('请先配置并选择人物普查模型');
    const revision = db.prepare('SELECT active_revision_id AS revisionId FROM projects WHERE id = ?')
      .get(projectId) as { revisionId: string | null } | undefined;
    if (!revision?.revisionId) throw new Error('请先导入小说，建立活动原文修订');

    const existing = db.prepare(`SELECT id, job_id AS jobId, state
      FROM foundation_workflow_runs
      WHERE project_id = ? AND revision_id = ? AND profile = ? AND model = ?
        AND state IN ('queued','running','paused')
      ORDER BY created_at DESC LIMIT 1`).get(projectId, revision.revisionId, profile, model) as
      { id: string; jobId: string; state: FoundationWorkflowRunRecord['state'] } | undefined;
    if (existing) return { runId: existing.id, jobId: existing.jobId, state: existing.state, reused: true };

    const plan = db.prepare(`SELECT id, COALESCE(input_hash, '') AS inputHash
      FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1`)
      .get(revision.revisionId) as { id: string; inputHash: string } | undefined;
    const inputHash = hash(JSON.stringify({
      revisionId: revision.revisionId,
      profile,
      model,
      chunkPlanId: plan?.id ?? null,
      chunkInputHash: plan?.inputHash ?? null,
    }));
    const runId = randomUUID();
    const jobId = randomUUID();
    const timestamp = now();

    db.transaction(() => {
      db.prepare(`INSERT INTO jobs
        (id, project_id, type, state, progress, message, input_json, input_hash, checkpoint_json, lease_owner, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, 'foundation-workflow', 'running', 0, '正在准备一键基础流程', ?, ?, ?, 'main', ?, ?, ?)`)
        .run(
          jobId,
          projectId,
          JSON.stringify({ runId, revisionId: revision.revisionId, profile, model }),
          inputHash,
          JSON.stringify({ runId, stepKey: null }),
          new Date(Date.now() + 60_000).toISOString(),
          timestamp,
          timestamp,
        );
      db.prepare(`INSERT INTO job_attempts
        (id, job_id, attempt, started_at, state) VALUES (?, ?, 1, ?, 'running')`)
        .run(randomUUID(), jobId, timestamp);
      db.prepare(`INSERT INTO foundation_workflow_runs
        (id, project_id, revision_id, job_id, profile, model, input_hash, state, total_steps, message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, '正在准备一键基础流程', ?, ?)`)
        .run(runId, projectId, revision.revisionId, jobId, profile, model, inputHash, stepDefinitions.length, timestamp, timestamp);
      const insertStep = db.prepare(`INSERT INTO foundation_workflow_steps
        (run_id, step_key, ordinal, state, progress, message, updated_at)
        VALUES (?, ?, ?, 'pending', 0, ?, ?)`);
      stepDefinitions.forEach((step, ordinal) => insertStep.run(runId, step.key, ordinal, `${step.label}等待执行`, timestamp));
    });
    return { runId, jobId, state: 'running', reused: false };
  }

  list(): FoundationWorkflowRunRecord[] {
    const { db, projectId } = this.store.get();
    const rows = db.prepare(`${this.runSelect()} WHERE r.project_id = ? ORDER BY r.created_at DESC LIMIT 20`)
      .all(projectId) as RunRow[];
    return rows.map((row) => ({ ...row, progress: Number(row.progress), steps: this.steps(db, row.id) }));
  }

  get(runId: string): FoundationWorkflowRunRecord {
    const { db, projectId } = this.store.get();
    const row = db.prepare(`${this.runSelect()} WHERE r.id = ? AND r.project_id = ?`)
      .get(runId, projectId) as RunRow | undefined;
    if (!row) throw new Error('找不到一键基础流程');
    return { ...row, progress: Number(row.progress), steps: this.steps(db, row.id) };
  }

  updateStep(
    runId: string,
    stepKey: FoundationWorkflowStepKey,
    state: FoundationWorkflowStepRecord['state'],
    message: string,
    options: { progress?: number; childJobId?: string | null; output?: unknown; error?: string | null } = {},
  ): FoundationWorkflowRunRecord {
    const { db, projectId } = this.store.get();
    const run = db.prepare(`SELECT id, job_id AS jobId, state FROM foundation_workflow_runs
      WHERE id = ? AND project_id = ?`).get(runId, projectId) as
      { id: string; jobId: string; state: FoundationWorkflowRunRecord['state'] } | undefined;
    if (!run) throw new Error('找不到一键基础流程');
    if (['completed', 'cancelled'].includes(run.state)) return this.get(runId);
    const progress = Math.min(1, Math.max(0, options.progress ?? (state === 'completed' || state === 'skipped' ? 1 : 0)));
    const timestamp = now();
    db.prepare(`UPDATE foundation_workflow_steps SET
      state = ?, progress = ?, message = ?,
      child_job_id = COALESCE(?, child_job_id),
      output_json = COALESCE(?, output_json),
      error = ?,
      started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
      finished_at = CASE WHEN ? IN ('completed','failed','skipped','cancelled') THEN ? ELSE finished_at END,
      updated_at = ?
      WHERE run_id = ? AND step_key = ?`)
      .run(
        state,
        progress,
        message.slice(0, 1000),
        options.childJobId ?? null,
        options.output === undefined ? null : JSON.stringify(options.output),
        options.error ?? null,
        state,
        timestamp,
        state,
        timestamp,
        timestamp,
        runId,
        stepKey,
      );
    this.refreshRun(db, runId, run.jobId, stepKey, message);
    return this.get(runId);
  }

  fail(runId: string, errorInput: string): FoundationWorkflowRunRecord {
    const { db, projectId } = this.store.get();
    const run = db.prepare(`SELECT job_id AS jobId, current_step_key AS currentStepKey
      FROM foundation_workflow_runs WHERE id = ? AND project_id = ?`).get(runId, projectId) as
      { jobId: string; currentStepKey: FoundationWorkflowStepKey | null } | undefined;
    if (!run) throw new Error('找不到一键基础流程');
    const error = errorInput.trim().slice(0, 2000) || '一键基础流程失败';
    const timestamp = now();
    db.transaction(() => {
      if (run.currentStepKey) {
        db.prepare(`UPDATE foundation_workflow_steps SET state = 'failed', error = ?, message = ?, finished_at = ?, updated_at = ?
          WHERE run_id = ? AND step_key = ?`).run(error, error, timestamp, timestamp, runId, run.currentStepKey);
      }
      db.prepare(`UPDATE foundation_workflow_runs SET state = 'failed', message = ?, updated_at = ? WHERE id = ?`)
        .run(error, timestamp, runId);
      db.prepare(`UPDATE jobs SET state = 'failed', message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(error, timestamp, run.jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', error = ?, finished_at = ?
        WHERE job_id = ? AND state = 'running'`).run(error, timestamp, run.jobId);
    });
    return this.get(runId);
  }

  control(runId: string, action: FoundationWorkflowControlAction): FoundationWorkflowRunRecord {
    const { db, projectId } = this.store.get();
    const run = db.prepare(`SELECT job_id AS jobId, state, current_step_key AS currentStepKey
      FROM foundation_workflow_runs WHERE id = ? AND project_id = ?`).get(runId, projectId) as
      { jobId: string; state: FoundationWorkflowRunRecord['state']; currentStepKey: FoundationWorkflowStepKey | null } | undefined;
    if (!run) throw new Error('找不到一键基础流程');
    const allowed: Record<FoundationWorkflowControlAction, FoundationWorkflowRunRecord['state'][]> = {
      pause: ['running'],
      resume: ['paused', 'queued'],
      cancel: ['queued', 'running', 'paused'],
      retry: ['failed'],
    };
    if (!allowed[action].includes(run.state)) throw new Error(`流程状态 ${run.state} 不能执行 ${action}`);
    const timestamp = now();
    const target: FoundationWorkflowRunRecord['state'] =
      action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'running';
    const message = action === 'pause' ? '一键基础流程已暂停'
      : action === 'cancel' ? '一键基础流程已取消'
        : action === 'retry' ? '正在重试失败步骤'
          : '一键基础流程继续运行';
    db.transaction(() => {
      if (action === 'retry') {
        db.prepare(`UPDATE foundation_workflow_steps SET state = 'pending', progress = 0, error = NULL,
          message = '等待重新执行', finished_at = NULL, updated_at = ?
          WHERE run_id = ? AND state = 'failed'`).run(timestamp, runId);
      } else if (run.currentStepKey && action === 'pause') {
        db.prepare(`UPDATE foundation_workflow_steps SET state = 'paused', message = ?, updated_at = ?
          WHERE run_id = ? AND step_key = ? AND state = 'running'`).run(message, timestamp, runId, run.currentStepKey);
      } else if (run.currentStepKey && action === 'resume') {
        db.prepare(`UPDATE foundation_workflow_steps SET state = 'running', message = ?, updated_at = ?
          WHERE run_id = ? AND step_key = ? AND state = 'paused'`).run(message, timestamp, runId, run.currentStepKey);
      } else if (action === 'cancel') {
        db.prepare(`UPDATE foundation_workflow_steps SET state = 'cancelled', message = ?, finished_at = ?, updated_at = ?
          WHERE run_id = ? AND state IN ('pending','running','paused')`).run(message, timestamp, timestamp, runId);
      }
      db.prepare(`UPDATE foundation_workflow_runs SET state = ?, message = ?, updated_at = ? WHERE id = ?`)
        .run(target, message, timestamp, runId);
      db.prepare(`UPDATE jobs SET state = ?, message = ?, updated_at = ? WHERE id = ?`)
        .run(target, message, timestamp, run.jobId);
      if (action === 'retry' || action === 'resume') {
        const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?')
          .get(run.jobId) as { value: number };
        db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state)
          VALUES (?, ?, ?, ?, 'running')`).run(randomUUID(), run.jobId, Number(attempt.value), timestamp);
      }
      if (action === 'cancel') {
        db.prepare(`UPDATE job_attempts SET state = 'cancelled', finished_at = ?
          WHERE job_id = ? AND state = 'running'`).run(timestamp, run.jobId);
      }
    });
    return this.get(runId);
  }

  private refreshRun(db: SQLiteDatabase, runId: string, jobId: string, stepKey: FoundationWorkflowStepKey, message: string): void {
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN state IN ('completed','skipped') THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN state = 'running' THEN progress ELSE 0 END) AS runningProgress
      FROM foundation_workflow_steps WHERE run_id = ?`).get(runId) as
      { total: number; completed: number; runningProgress: number };
    const total = Math.max(1, Number(counts.total));
    const completed = Number(counts.completed);
    const progress = Math.min(1, (completed + Number(counts.runningProgress)) / total);
    const finished = completed === total;
    const timestamp = now();
    db.prepare(`UPDATE foundation_workflow_runs SET state = ?, current_step_key = ?,
      completed_steps = ?, message = ?, updated_at = ? WHERE id = ?`)
      .run(finished ? 'completed' : 'running', stepKey, completed, message.slice(0, 1000), timestamp, runId);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, checkpoint_json = ?,
      lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(
        finished ? 'completed' : 'running',
        progress,
        message.slice(0, 1000),
        JSON.stringify({ runId, stepKey }),
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

  private steps(db: SQLiteDatabase, runId: string): FoundationWorkflowStepRecord[] {
    return db.prepare(`SELECT step_key AS stepKey, ordinal, state, progress, message,
      child_job_id AS childJobId, output_json AS outputJson, error,
      started_at AS startedAt, finished_at AS finishedAt, updated_at AS updatedAt
      FROM foundation_workflow_steps WHERE run_id = ? ORDER BY ordinal`)
      .all(runId) as FoundationWorkflowStepRecord[];
  }

  private runSelect(): string {
    return `SELECT r.id, r.job_id AS jobId, r.revision_id AS revisionId, r.profile, r.model,
      r.input_hash AS inputHash, r.state, r.current_step_key AS currentStepKey,
      r.total_steps AS totalSteps, r.completed_steps AS completedSteps,
      j.progress, r.message, r.created_at AS createdAt, r.updated_at AS updatedAt
      FROM foundation_workflow_runs r JOIN jobs j ON j.id = r.job_id`;
  }
}
