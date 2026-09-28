import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AutomationDraftQuoteService } from '../../electron/worker/automation-draft-quote-service';
import { AutomationDraftSelectionService } from '../../electron/worker/automation-draft-selection-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import type { CharacterFactOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function createDraftConsumerProject(prefix: string) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, 'draft-consumers.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, [
    '第一章 山门',
    '沈青说道：“我先进去。”',
    '林月说道：“且慢，里面有埋伏。”',
    '守门弟子退到石阶旁。',
  ].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('草稿消费通道测试', projectRoot);
  const imported = await new Importer(store).run(sourcePath, 'utf8');
  const workflow = new FoundationWorkflowService(store);
  const workflowStart = workflow.create('test-model');
  workflow.updateStep(workflowStart.runId, 'preflight', 'completed', '通过');
  workflow.updateStep(workflowStart.runId, 'chunks', 'completed', '通过');
  workflow.updateStep(workflowStart.runId, 'character_scan', 'completed', '通过');

  const { db } = store.get();
  const timestamp = new Date().toISOString();
  const identities = { confirmed: randomUUID(), pending: randomUUID(), unselected: randomUUID() };
  const insertIdentity = db.prepare(`INSERT INTO person_identities
    (id, revision_id, canonical_name, normalized_name, entity_type, importance_tier, importance_score,
     review_status, uncertainty, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'human', ?, ?, ?, '', ?, ?)`);
  insertIdentity.run(identities.confirmed, imported.revisionId, '沈青', '沈青', 'important', 70, 'confirmed', timestamp, timestamp);
  insertIdentity.run(identities.pending, imported.revisionId, '林月', '林月', 'core', 85, 'pending', timestamp, timestamp);
  insertIdentity.run(identities.unselected, imported.revisionId, '守门弟子', '守门弟子', 'minor', 10, 'pending', timestamp, timestamp);
  const insertMetrics = db.prepare(`INSERT INTO person_metrics
    (identity_id, mention_count, chapter_count, dialogue_count, event_count, first_ordinal, last_ordinal, updated_at)
    VALUES (?, ?, 1, ?, 1, 1, 4, ?)`);
  insertMetrics.run(identities.confirmed, 8, 3, timestamp);
  insertMetrics.run(identities.pending, 9, 4, timestamp);
  insertMetrics.run(identities.unselected, 1, 0, timestamp);

  const selections = new AutomationDraftSelectionService(store);
  const selectionStart = selections.create(workflowStart.runId);
  let selection = selections.get(selectionStart.runId);
  while (selection.state === 'running') selection = selections.processNext(selection.jobId);
  expect(selection).toMatchObject({ state: 'completed', selectedCount: 2 });
  return { store, projectRoot, identities, selection, imported };
}

function finishQuotes(service: AutomationDraftQuoteService, jobId: string) {
  let run = service.getByJob(jobId);
  while (run.state === 'running') run = service.processNext(jobId);
  return run;
}

describe('batch 3 automation draft consumers', () => {
  it('allows selected pending identities to produce pending facts without weakening the ordinary review gate', async () => {
    const { store, identities, selection } = await createDraftConsumerProject('novel-draft-facts-');
    try {
      const facts = new CharacterFactService(store);
      expect(() => facts.createRun(identities.pending, 'test-model', 'character_facts.v2')).toThrow(/确认人物/);
      expect(() => facts.createDraftRun(selection.id, identities.unselected, 'test-model', 'character_facts.v2')).toThrow(/不在已完成/);

      const started = facts.createDraftRun(selection.id, identities.pending, 'test-model', 'character_facts.v2');
      const work = facts.nextBatch(started.jobId)!;
      expect(work).toMatchObject({
        identityId: identities.pending,
        inputMode: 'automation-draft-selection',
        draftSelectionRunId: selection.id,
      });
      const paragraph = work.paragraphs.find((item) => item.text.includes('林月说道'))!;
      const output: CharacterFactOutput = {
        facts: [{
          category: 'speech', predicate: '警告内容', value: '提醒同伴里面有埋伏', source_type: 'explicit',
          assertion_mode: 'narrator_assertion', truth_status: 'asserted', attributed_source_name: null,
          extraction_pass: 1, confidence: 0.99, visibility: 'public', valid_from_paragraph_id: null,
          valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: paragraph.paragraphId, exact_quote: paragraph.text, role: 'support' }],
          reasoning_note: '',
        }],
      };
      facts.ingest(started.jobId, work.batchOrdinal, output, JSON.stringify(output), 20, 10);
      expect(facts.nextBatch(started.jobId)).toBeNull();
      expect(facts.listFacts(identities.pending)).toEqual([
        expect.objectContaining({ predicate: '警告内容', reviewStatus: 'pending' }),
      ]);
      expect(facts.createDraftRun(selection.id, identities.pending, 'test-model', 'character_facts.v2'))
        .toMatchObject({ runId: started.runId, jobId: started.jobId, state: 'completed', reused: true });
      expect(store.get().db.prepare('SELECT review_status AS reviewStatus FROM person_identities WHERE id = ?')
        .get(identities.pending)).toMatchObject({ reviewStatus: 'pending' });

      store.get().db.prepare(`UPDATE person_identities SET review_status = 'rejected' WHERE id = ?`).run(identities.pending);
      expect(() => facts.createDraftRun(selection.id, identities.pending, 'test-model', 'character_facts.v2')).toThrow(/用户排除/);
    } finally {
      await store.close();
    }
  });

  it('scans dialogue resumably for selected identities and keeps even explicit speakers pending', async () => {
    const { store, identities, selection } = await createDraftConsumerProject('novel-draft-dialogue-');
    try {
      const quotes = new AutomationDraftQuoteService(store);
      const started = quotes.create(selection.id);
      expect(started).toMatchObject({ state: 'running', reused: false });
      const firstProgress = quotes.processNext(started.jobId);
      expect(firstProgress.completedParagraphs).toBe(1);
      expect(firstProgress.items).toEqual([]);
      expect(quotes.getByJob(started.jobId).items.length).toBeGreaterThan(0);
      expect(quotes.controlJob(started.jobId, 'pause').state).toBe('paused');
      expect(quotes.controlJob(started.jobId, 'resume').state).toBe('running');
      const completed = finishQuotes(quotes, started.jobId);
      expect(completed).toMatchObject({ state: 'completed', quoteCount: 2, attributionCount: 2, progress: 1 });
      expect(quotes.create(selection.id)).toMatchObject({ runId: started.runId, state: 'completed', reused: true });

      const attributions = store.get().db.prepare(`SELECT a.identity_id AS identityId, a.method, a.review_status AS reviewStatus
        FROM character_quote_attributions a JOIN character_quotes q ON q.id = a.quote_id ORDER BY a.identity_id`).all() as
        Array<{ identityId: string; method: string; reviewStatus: string }>;
      expect(attributions).toHaveLength(2);
      expect(attributions.every((item) => item.method === 'explicit_cue' && item.reviewStatus === 'pending')).toBe(true);
      expect(new Set(attributions.map((item) => item.identityId))).toEqual(new Set([identities.confirmed, identities.pending]));
      expect(attributions.map((item) => item.identityId)).not.toContain(identities.unselected);

      const paragraph = store.get().db.prepare(`SELECT id FROM paragraphs WHERE revision_id = ? ORDER BY ordinal LIMIT 1`)
        .get(completed.revisionId) as { id: string };
      store.get().db.prepare(`UPDATE paragraphs SET text = text || ' ', content_hash = content_hash || '-changed' WHERE id = ?`).run(paragraph.id);
      const changed = quotes.create(selection.id);
      expect(changed.reused).toBe(false);
      store.get().db.prepare(`UPDATE automation_draft_quote_items SET input_hash = 'tampered'
        WHERE run_id = ? AND paragraph_ordinal = (SELECT MIN(paragraph_ordinal) FROM automation_draft_quote_items WHERE run_id = ?)`)
        .run(changed.runId, changed.runId);
      expect(quotes.processNext(changed.jobId)).toMatchObject({ state: 'failed', error: expect.stringContaining('输入指纹不一致') });
    } finally {
      await store.close();
    }
  });

  it('recovers an interrupted paragraph checkpoint after reopening', async () => {
    const { store: first, projectRoot, selection } = await createDraftConsumerProject('novel-draft-dialogue-recovery-');
    const firstQuotes = new AutomationDraftQuoteService(first);
    const started = firstQuotes.create(selection.id);
    expect(firstQuotes.processNext(started.jobId).completedParagraphs).toBe(1);
    await first.close();

    const reopened = new ProjectStore();
    try {
      await reopened.open(projectRoot);
      const quotes = new AutomationDraftQuoteService(reopened);
      expect(quotes.getByJob(started.jobId)).toMatchObject({ state: 'paused', completedParagraphs: 1 });
      expect(quotes.controlJob(started.jobId, 'resume').state).toBe('running');
      expect(finishQuotes(quotes, started.jobId)).toMatchObject({ state: 'completed', quoteCount: 2, attributionCount: 2 });
    } finally {
      await reopened.close();
    }
  });
});
