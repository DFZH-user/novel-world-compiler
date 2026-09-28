import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { SQLiteDatabase } from '../../electron/worker/sqlite-db';
import { BASE_SCHEMA_VERSION, SCHEMA_VERSION, schemaMigrations, schemaSql } from '../../electron/worker/schema';
import { randomUUID } from 'node:crypto';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function createImportedProject(prefix: string): Promise<{ store: ProjectStore; projectRoot: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, 'workflow.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, '第一章 山门\n沈青走进山门。\n“且慢。”林月说道。\n', 'utf8');
  const store = new ProjectStore();
  await store.create('一键流程测试', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  return { store, projectRoot };
}

describe('foundation one-click workflow', () => {
  it('tracks resumable parent steps and completes without changing review decisions', async () => {
    const { store } = await createImportedProject('novel-foundation-workflow-');
    try {
      const service = new FoundationWorkflowService(store);
      const started = service.create('test-model');
      expect(started).toMatchObject({ state: 'running', reused: false });
      expect(service.create('test-model')).toMatchObject({
        runId: started.runId,
        jobId: started.jobId,
        reused: true,
      });
      expect(service.get(started.runId).steps.map((step) => step.state)).toEqual([
        'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending',
      ]);

      service.updateStep(started.runId, 'preflight', 'completed', '工程预检通过', { progress: 1 });
      service.updateStep(started.runId, 'chunks', 'completed', '已生成 1 个分析分块', {
        progress: 1,
        output: { chunkCount: 1 },
      });
      service.updateStep(started.runId, 'character_scan', 'running', '正在执行人物普查', { progress: 0.4 });
      expect(service.control(started.runId, 'pause')).toMatchObject({ state: 'paused' });
      expect(service.get(started.runId).progress).toBeCloseTo((2 + 0.4) / 11);
      expect(service.get(started.runId).steps.find((step) => step.stepKey === 'character_scan')?.state).toBe('paused');

      expect(service.control(started.runId, 'resume').state).toBe('running');
      service.updateStep(started.runId, 'character_scan', 'completed', '人物候选等待审核', { progress: 1 });
      service.updateStep(started.runId, 'draft_selection', 'completed', '自动草稿选择完成', {
        progress: 1,
        output: { selectedCount: 1, reviewBoundary: 'selection-only-no-confirmation' },
      });
      service.updateStep(started.runId, 'character_facts', 'completed', '人物事实草稿完成', {
        progress: 1,
        output: { reviewBoundary: 'facts-remain-pending' },
      });
      service.updateStep(started.runId, 'dialogue_scan', 'completed', '对白草稿完成', {
        progress: 1,
        output: { reviewBoundary: 'all-attributions-remain-pending' },
      });
      service.updateStep(started.runId, 'time_expressions', 'completed', '时间表达式草稿完成', { progress: 1 });
      service.updateStep(started.runId, 'event_drafts', 'completed', '事件草稿完成', { progress: 1 });
      service.updateStep(started.runId, 'place_drafts', 'completed', '地点草稿完成', { progress: 1 });
      service.updateStep(started.runId, 'relationship_drafts', 'skipped', '人物不足，跳过关系草稿', { progress: 1 });
      const completed = service.updateStep(started.runId, 'summary', 'completed', '基础流程完成', {
        progress: 1,
        output: { reviewBoundary: 'pending-only' },
      });
      expect(completed).toMatchObject({ state: 'completed', progress: 1, completedSteps: 11 });
      expect(new EditorService(store).listJobs().find((job) => job.id === started.jobId))
        .toMatchObject({ type: 'foundation-workflow', state: 'completed', progress: 1 });
    } finally {
      await store.close();
    }
  });

  it('marks an interrupted workflow as paused on reopen and resumes from its recorded step', async () => {
    const { store: first, projectRoot } = await createImportedProject('novel-foundation-recovery-');
    const firstService = new FoundationWorkflowService(first);
    const started = firstService.create('test-model');
    firstService.updateStep(started.runId, 'preflight', 'running', '正在检查工程', { progress: 0.35 });
    await first.close();

    const reopened = new ProjectStore();
    try {
      await reopened.open(projectRoot);
      const service = new FoundationWorkflowService(reopened);
      const recovered = service.get(started.runId);
      expect(recovered).toMatchObject({
        state: 'paused',
        currentStepKey: 'preflight',
        message: expect.stringContaining('可继续'),
      });
      expect(recovered.steps.find((step) => step.stepKey === 'preflight')).toMatchObject({
        state: 'paused',
        progress: 0.35,
      });
      expect(new EditorService(reopened).listJobs().find((job) => job.id === started.jobId)?.state).toBe('queued');

      const resumed = service.control(started.runId, 'resume');
      expect(resumed.state).toBe('running');
      expect(resumed.steps.find((step) => step.stepKey === 'preflight')?.state).toBe('running');
    } finally {
      await reopened.close();
    }
  });

  it('migrates completed v24 workflow history without pretending the four world draft steps ran', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-foundation-v24-migration-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '旧一键流程.novelworld');
    await fs.mkdir(projectRoot);
    await fs.mkdir(path.join(projectRoot, 'backups'));
    const projectId = randomUUID();
    const revisionId = randomUUID();
    const jobId = randomUUID();
    const runId = randomUUID();
    const timestamp = new Date().toISOString();
    await fs.writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({
      format: 'novel-world-project', schemaVersion: 24, projectId, name: '旧一键流程', createdAt: timestamp,
    }, null, 2), 'utf8');
    const database = await SQLiteDatabase.open(path.join(projectRoot, 'novel.db'));
    database.exec(schemaSql);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(BASE_SCHEMA_VERSION, timestamp);
    for (const migration of schemaMigrations.filter((item) => item.version <= 24)) {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, timestamp);
    }
    database.prepare(`INSERT INTO projects (id, name, root_path, active_revision_id, created_at, updated_at)
      VALUES (?, '旧一键流程', ?, ?, ?, ?)`).run(projectId, projectRoot, revisionId, timestamp, timestamp);
    database.prepare(`INSERT INTO source_revisions
      (id, project_id, original_name, original_path, normalized_path, encoding, sha256, byte_size,
       character_count, status, created_at, completed_at)
      VALUES (?, ?, 'old.txt', 'old.txt', 'old.txt', 'utf8', 'old-sha', 0, 0, 'ready', ?, ?)`)
      .run(revisionId, projectId, timestamp, timestamp);
    database.prepare(`INSERT INTO jobs
      (id, project_id, type, state, progress, message, input_hash, created_at, updated_at)
      VALUES (?, ?, 'foundation-workflow', 'completed', 1, '第二批已完成', 'old-input', ?, ?)`)
      .run(jobId, projectId, timestamp, timestamp);
    database.prepare(`INSERT INTO foundation_workflow_runs
      (id, project_id, revision_id, job_id, profile, model, input_hash, state, current_step_key,
       total_steps, completed_steps, message, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'foundation-v1', 'test-model', 'old-input', 'completed', 'summary', 7, 7,
       '第二批已完成', ?, ?)`).run(runId, projectId, revisionId, jobId, timestamp, timestamp);
    const insertStep = database.prepare(`INSERT INTO foundation_workflow_steps
      (run_id, step_key, ordinal, state, progress, message, started_at, finished_at, updated_at)
      VALUES (?, ?, ?, 'completed', 1, '已完成', ?, ?, ?)`);
    ['preflight', 'chunks', 'character_scan', 'draft_selection', 'character_facts', 'dialogue_scan', 'summary']
      .forEach((stepKey, ordinal) => insertStep.run(runId, stepKey, ordinal, timestamp, timestamp, timestamp));
    database.close();

    const reopened = new ProjectStore();
    try {
      await reopened.open(projectRoot);
      const migrated = new FoundationWorkflowService(reopened).get(runId);
      expect(migrated).toMatchObject({ state: 'completed', totalSteps: 11, completedSteps: 11 });
      expect(migrated.steps.map((step) => [step.stepKey, step.ordinal, step.state])).toEqual([
        ['preflight', 0, 'completed'],
        ['chunks', 1, 'completed'],
        ['character_scan', 2, 'completed'],
        ['draft_selection', 3, 'completed'],
        ['character_facts', 4, 'completed'],
        ['dialogue_scan', 5, 'completed'],
        ['time_expressions', 6, 'skipped'],
        ['event_drafts', 7, 'skipped'],
        ['place_drafts', 8, 'skipped'],
        ['relationship_drafts', 9, 'skipped'],
        ['summary', 10, 'completed'],
      ]);
      expect(migrated.steps.find((step) => step.stepKey === 'time_expressions')?.message).toContain('历史运行');
      expect(migrated.steps.find((step) => step.stepKey === 'relationship_drafts')?.message).toContain('历史运行');
      expect(reopened.get().db.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'automation_draft_quote_runs'`).get()).toBeTruthy();
      const factColumns = reopened.get().db.prepare('PRAGMA table_info(character_fact_runs)').all() as Array<{ name: string }>;
      expect(factColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
        'input_mode', 'draft_selection_run_id', 'draft_selection_item_hash',
      ]));
      expect(reopened.get().db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
        .toMatchObject({ version: SCHEMA_VERSION });
      expect(JSON.parse(await fs.readFile(path.join(projectRoot, 'project.json'), 'utf8')))
        .toMatchObject({ schemaVersion: SCHEMA_VERSION });
    } finally {
      await reopened.close();
    }
  });
});
