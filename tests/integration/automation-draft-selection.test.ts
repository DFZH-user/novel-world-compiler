import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationDraftSelectionService } from '../../electron/worker/automation-draft-selection-service';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function createSelectionProject(prefix: string): Promise<{
  store: ProjectStore;
  projectRoot: string;
  workflowRunId: string;
  identities: Record<'confirmed' | 'corePending' | 'minorPending' | 'rejected', string>;
}> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, 'selection.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, '第一章 山门\n沈青走进山门。\n“且慢。”林月说道。\n', 'utf8');
  const store = new ProjectStore();
  await store.create('自动草稿选择测试', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  const workflow = new FoundationWorkflowService(store);
  const started = workflow.create('test-model');
  workflow.updateStep(started.runId, 'preflight', 'completed', '通过', { progress: 1 });
  workflow.updateStep(started.runId, 'chunks', 'completed', '通过', { progress: 1 });
  workflow.updateStep(started.runId, 'character_scan', 'completed', '通过', { progress: 1 });

  const { db, projectId } = store.get();
  const revision = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string };
  const timestamp = new Date().toISOString();
  const identities = {
    confirmed: randomUUID(),
    corePending: randomUUID(),
    minorPending: randomUUID(),
    rejected: randomUUID(),
  };
  const insertIdentity = db.prepare(`INSERT INTO person_identities
    (id, revision_id, canonical_name, normalized_name, entity_type, importance_tier, importance_score,
     review_status, uncertainty, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'human', ?, ?, ?, '', ?, ?)`);
  insertIdentity.run(identities.confirmed, revision.id, '沈青', '沈青', 'important', 64, 'confirmed', timestamp, timestamp);
  insertIdentity.run(identities.corePending, revision.id, '林月', '林月', 'core', 78, 'pending', timestamp, timestamp);
  insertIdentity.run(identities.minorPending, revision.id, '守门弟子', '守门弟子', 'minor', 16, 'pending', timestamp, timestamp);
  insertIdentity.run(identities.rejected, revision.id, '误识别人名', '误识别人名', 'core', 90, 'rejected', timestamp, timestamp);
  const insertMetrics = db.prepare(`INSERT INTO person_metrics
    (identity_id, mention_count, chapter_count, dialogue_count, event_count, first_ordinal, last_ordinal, updated_at)
    VALUES (?, ?, 1, ?, ?, 1, 3, ?)`);
  insertMetrics.run(identities.confirmed, 9, 2, 3, timestamp);
  insertMetrics.run(identities.corePending, 12, 5, 4, timestamp);
  insertMetrics.run(identities.minorPending, 2, 0, 1, timestamp);
  insertMetrics.run(identities.rejected, 20, 8, 6, timestamp);
  return { store, projectRoot, workflowRunId: started.runId, identities };
}

function finish(service: AutomationDraftSelectionService, jobId: string) {
  let run = service.getByJob(jobId);
  while (run.state === 'running') run = service.processNext(jobId);
  return run;
}

describe('automation draft selection', () => {
  it('selects an explainable draft set without changing human review status and reuses the same fingerprint', async () => {
    const { store, workflowRunId, identities } = await createSelectionProject('novel-draft-selection-');
    try {
      const service = new AutomationDraftSelectionService(store);
      const started = service.create(workflowRunId);
      expect(started).toMatchObject({ state: 'running', reused: false });
      expect(service.create(workflowRunId)).toMatchObject({ runId: started.runId, jobId: started.jobId, reused: true });

      const firstCheckpoint = service.processNext(started.jobId);
      expect(firstCheckpoint).toMatchObject({ processedCandidates: 1, totalCandidates: 4 });
      expect(service.controlJob(started.jobId, 'pause').state).toBe('paused');
      expect(service.controlJob(started.jobId, 'resume').state).toBe('running');
      const completed = finish(service, started.jobId);
      expect(completed).toMatchObject({ state: 'completed', processedCandidates: 4, selectedCount: 2, progress: 1 });

      expect(completed.items.filter((item) => item.selected).map((item) => item.identityName).sort()).toEqual(['林月', '沈青']);
      expect(completed.items.find((item) => item.identityId === identities.confirmed)).toMatchObject({
        reasonCode: 'human-confirmed',
        reviewStatusSnapshot: 'confirmed',
      });
      expect(completed.items.find((item) => item.identityId === identities.corePending)).toMatchObject({
        reasonCode: 'high-importance',
        reviewStatusSnapshot: 'pending',
      });
      expect(completed.items.find((item) => item.identityId === identities.minorPending)?.reasonCode).toBe('low-importance');
      expect(completed.items.find((item) => item.identityId === identities.rejected)?.reasonCode).toBe('human-rejected');

      const statuses = store.get().db.prepare(`SELECT id, review_status AS reviewStatus FROM person_identities ORDER BY id`)
        .all() as Array<{ id: string; reviewStatus: string }>;
      expect(Object.fromEntries(statuses.map((item) => [item.id, item.reviewStatus]))).toMatchObject({
        [identities.confirmed]: 'confirmed',
        [identities.corePending]: 'pending',
        [identities.minorPending]: 'pending',
        [identities.rejected]: 'rejected',
      });

      expect(service.create(workflowRunId)).toMatchObject({
        runId: started.runId,
        jobId: started.jobId,
        state: 'completed',
        reused: true,
      });

      store.get().db.prepare(`UPDATE person_identities SET importance_tier = 'important', importance_score = 40 WHERE id = ?`)
        .run(identities.minorPending);
      const changedInput = service.create(workflowRunId);
      expect(changedInput.reused).toBe(false);
      expect(changedInput.runId).not.toBe(started.runId);

      store.get().db.prepare(`UPDATE person_identities SET review_status = 'rejected' WHERE id = ?`).run(identities.corePending);
      expect(service.selectedForAutomation(started.runId).map((item) => item.identityId)).not.toContain(identities.corePending);
    } finally {
      await store.close();
    }
  });

  it('recovers an interrupted per-character checkpoint after reopening the project', async () => {
    const { store: first, projectRoot, workflowRunId } = await createSelectionProject('novel-draft-selection-recovery-');
    const firstService = new AutomationDraftSelectionService(first);
    const started = firstService.create(workflowRunId);
    expect(firstService.processNext(started.jobId).processedCandidates).toBe(1);
    await first.close();

    const reopened = new ProjectStore();
    try {
      await reopened.open(projectRoot);
      const service = new AutomationDraftSelectionService(reopened);
      expect(service.getByJob(started.jobId)).toMatchObject({ state: 'paused', processedCandidates: 1 });
      expect(service.controlJob(started.jobId, 'resume').state).toBe('running');
      expect(finish(service, started.jobId)).toMatchObject({ state: 'completed', processedCandidates: 4, selectedCount: 2 });
    } finally {
      await reopened.close();
    }
  });

  it('fails closed when a persisted item no longer matches its input fingerprint', async () => {
    const { store, workflowRunId } = await createSelectionProject('novel-draft-selection-fingerprint-');
    try {
      const service = new AutomationDraftSelectionService(store);
      const started = service.create(workflowRunId);
      store.get().db.prepare(`UPDATE automation_draft_selection_items SET input_snapshot_json = '{}'
        WHERE run_id = ? AND ordinal = 1`).run(started.runId);
      const failed = service.processNext(started.jobId);
      expect(failed).toMatchObject({ state: 'failed', processedCandidates: 0 });
      expect(failed.error).toMatch(/输入指纹不一致/);
      expect(failed.items[0]).toMatchObject({ status: 'failed', selected: null });
    } finally {
      await store.close();
    }
  });
});
