import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationDraftSelectionService } from '../../electron/worker/automation-draft-selection-service';
import { AutomaticFinalizationService } from '../../electron/worker/automatic-finalization-service';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import { RefinementDashboardService } from '../../electron/worker/refinement-dashboard-service';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function createImportedProject(prefix: string): Promise<ProjectStore> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, 'refinement.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, '第一章 山门\n沈青走进山门。\n“且慢。”林月说道。\n', 'utf8');
  const store = new ProjectStore();
  await store.create('统一精修测试', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  return store;
}

function finishSelection(service: AutomationDraftSelectionService, jobId: string) {
  let run = service.getByJob(jobId);
  while (run.state === 'running') run = service.processNext(jobId);
  return run;
}

function completeWorkflow(service: FoundationWorkflowService, runId: string): void {
  const steps = ['preflight', 'chunks', 'character_scan', 'draft_selection', 'character_facts', 'dialogue_scan',
    'time_expressions', 'event_drafts', 'place_drafts', 'relationship_drafts', 'summary'] as const;
  for (const step of steps) service.updateStep(runId, step, 'completed', `${step} completed`, { progress: 1 });
}

describe('refinement dashboard', () => {
  it('derives a versioned optional quality list and never mutates review state', async () => {
    const store = await createImportedProject('novel-refinement-dashboard-');
    try {
      const { db, projectId } = store.get();
      const revision = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string };
      const timestamp = new Date().toISOString();
      const identityId = randomUUID();
      db.prepare(`INSERT INTO person_identities
        (id, revision_id, canonical_name, normalized_name, entity_type, importance_tier, importance_score,
         review_status, uncertainty, created_at, updated_at)
        VALUES (?, ?, '林月', '林月', 'human', 'core', 82, 'pending', '', ?, ?)`)
        .run(identityId, revision.id, timestamp, timestamp);
      db.prepare(`INSERT INTO person_metrics
        (identity_id, mention_count, chapter_count, dialogue_count, event_count, first_ordinal, last_ordinal, updated_at)
        VALUES (?, 12, 3, 4, 1, 1, 3, ?)`).run(identityId, timestamp);
      const paragraphs = db.prepare('SELECT id FROM paragraphs WHERE revision_id = ? ORDER BY ordinal LIMIT 2')
        .all(revision.id) as Array<{ id: string }>;
      const insertAlias = db.prepare(`INSERT INTO person_aliases
        (id, identity_id, revision_id, alias, normalized_alias, alias_type, confidence, review_status, evidence_paragraph_id, created_at)
        VALUES (?, ?, ?, '月儿', '月儿', 'nickname', 0.8, 'pending', ?, ?)`);
      insertAlias.run(randomUUID(), identityId, revision.id, paragraphs[0].id, timestamp);
      insertAlias.run(randomUUID(), identityId, revision.id, paragraphs[1].id, timestamp);

      const workflow = new FoundationWorkflowService(store);
      const started = workflow.create('test-model');
      workflow.updateStep(started.runId, 'preflight', 'completed', '通过', { progress: 1 });
      workflow.updateStep(started.runId, 'chunks', 'completed', '通过', { progress: 1 });
      workflow.updateStep(started.runId, 'character_scan', 'completed', '通过', { progress: 1 });
      const selectionService = new AutomationDraftSelectionService(store);
      const selectionStarted = selectionService.create(started.runId);
      const selection = finishSelection(selectionService, selectionStarted.jobId);
      expect(selection).toMatchObject({ state: 'completed', selectedCount: 1 });
      completeWorkflow(workflow, started.runId);

      const service = new RefinementDashboardService(store);
      const changesBefore = (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value;
      const blocked = service.getDashboard();
      const changesAfter = (db.prepare('SELECT total_changes() AS value').get() as { value: number }).value;
      expect(changesAfter).toBe(changesBefore);
      expect(blocked).toMatchObject({
        policyVersion: 'refinement-quality-center.v2',
        revisionId: revision.id,
        foundationRunId: started.runId,
        selectionRunId: selectionStarted.runId,
        readyForArtifactDrafts: true,
      });
      expect(blocked.issues.find((issue) => issue.kind === 'selected-character-review')).toMatchObject({
        severity: 'recommended', count: 1, targetView: 'characters', samples: ['林月'],
      });
      expect(blocked.issues.find((issue) => issue.kind === 'character-alias-review')).toMatchObject({
        severity: 'recommended', count: 1, targetView: 'characters', samples: ['林月 · 月儿'],
      });

      db.prepare(`UPDATE person_identities SET review_status = 'confirmed', updated_at = ? WHERE id = ?`).run(timestamp, identityId);
      const paragraph = paragraphs[0];
      db.prepare(`INSERT INTO timeline_time_expressions
        (id, revision_id, paragraph_id, start_offset, end_offset, surface_text, expression_type,
         normalized_value, calendar_system, detection_method, confidence, review_status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 3, '第一章', 'unknown', NULL, 'unspecified', 'rule', 0.5, 'pending', ?, ?)`)
        .run(randomUUID(), revision.id, paragraph.id, timestamp, timestamp);
      const ready = service.getDashboard();
      expect(ready.readyForArtifactDrafts).toBe(true);
      expect(ready.counts.must).toBe(0);
      expect(ready.issues.find((issue) => issue.kind === 'time-expression-review')).toMatchObject({
        severity: 'later', count: 1, targetView: 'timeline',
      });
    } finally {
      await store.close();
    }
  });

  it('auto-finalizes only pending decisions and preserves manual exclusions', async () => {
    const store = await createImportedProject('novel-auto-finalization-');
    try {
      const { db, projectId } = store.get();
      const revision = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string };
      const timestamp = new Date().toISOString();
      const identityId = randomUUID();
      db.prepare(`INSERT INTO person_identities
        (id, revision_id, canonical_name, normalized_name, entity_type, importance_tier, importance_score,
         review_status, uncertainty, created_at, updated_at)
        VALUES (?, ?, '林月', '林月', 'human', 'core', 82, 'pending', '', ?, ?)`).run(identityId, revision.id, timestamp, timestamp);
      db.prepare(`INSERT INTO person_metrics
        (identity_id, mention_count, chapter_count, dialogue_count, event_count, first_ordinal, last_ordinal, updated_at)
        VALUES (?, 12, 3, 4, 1, 1, 3, ?)`).run(identityId, timestamp);
      const paragraph = db.prepare('SELECT id FROM paragraphs WHERE revision_id = ? ORDER BY ordinal LIMIT 1')
        .get(revision.id) as { id: string };
      const pendingAliasId = randomUUID();
      const rejectedAliasId = randomUUID();
      const insertAlias = db.prepare(`INSERT INTO person_aliases
        (id, identity_id, revision_id, alias, normalized_alias, alias_type, confidence, review_status, evidence_paragraph_id, created_at)
        VALUES (?, ?, ?, ?, ?, 'nickname', ?, ?, ?, ?)`);
      insertAlias.run(pendingAliasId, identityId, revision.id, '月儿', '月儿', 0.8, 'pending', paragraph.id, timestamp);
      insertAlias.run(rejectedAliasId, identityId, revision.id, '错误别名', '错误别名', 0.99, 'rejected', paragraph.id, timestamp);

      const workflow = new FoundationWorkflowService(store);
      const started = workflow.create('test-model');
      workflow.updateStep(started.runId, 'preflight', 'completed', '通过', { progress: 1 });
      workflow.updateStep(started.runId, 'chunks', 'completed', '通过', { progress: 1 });
      workflow.updateStep(started.runId, 'character_scan', 'completed', '通过', { progress: 1 });
      const selectionService = new AutomationDraftSelectionService(store);
      const selectionStarted = selectionService.create(started.runId);
      const selection = finishSelection(selectionService, selectionStarted.jobId);
      completeWorkflow(workflow, started.runId);

      const result = await new AutomaticFinalizationService(store).finalize(selection.id);
      expect(result).toMatchObject({ revisionId: revision.id, selectionRunId: selection.id, entryEvent: null });
      expect((db.prepare('SELECT review_status AS status FROM person_identities WHERE id = ?').get(identityId) as { status: string }).status)
        .toBe('confirmed');
      expect((db.prepare('SELECT review_status AS status FROM person_aliases WHERE id = ?').get(pendingAliasId) as { status: string }).status)
        .toBe('confirmed');
      expect((db.prepare('SELECT review_status AS status FROM person_aliases WHERE id = ?').get(rejectedAliasId) as { status: string }).status)
        .toBe('rejected');
    } finally {
      await store.close();
    }
  });

  it('reports an incomplete workflow and isolates all counts to the active revision', async () => {
    const store = await createImportedProject('novel-refinement-scope-');
    try {
      const { db, projectId } = store.get();
      const active = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string };
      const timestamp = new Date().toISOString();
      const oldRevisionId = randomUUID();
      db.prepare(`INSERT INTO source_revisions
        (id, project_id, original_name, original_path, normalized_path, encoding, sha256, byte_size,
         character_count, status, created_at, completed_at)
        VALUES (?, ?, 'old.txt', 'old.txt', 'old.txt', 'utf8', ?, 0, 0, 'ready', ?, ?)`)
        .run(oldRevisionId, projectId, randomUUID(), timestamp, timestamp);
      db.prepare(`INSERT INTO person_identities
        (id, revision_id, canonical_name, normalized_name, entity_type, importance_tier, importance_score,
         review_status, uncertainty, created_at, updated_at)
        VALUES (?, ?, '旧修订人物', '旧修订人物', 'human', 'core', 99, 'pending', '', ?, ?)`)
        .run(randomUUID(), oldRevisionId, timestamp, timestamp);

      const dashboard = new RefinementDashboardService(store).getDashboard();
      expect(dashboard.revisionId).toBe(active.id);
      expect(dashboard.issues.find((issue) => issue.kind === 'workflow-incomplete')).toMatchObject({
        severity: 'must', targetView: 'foundation-workflow', count: 1,
      });
      expect(dashboard.issues.flatMap((issue) => issue.samples)).not.toContain('旧修订人物');
      expect(dashboard.issues.find((issue) => issue.kind === 'remaining-character-review')).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
