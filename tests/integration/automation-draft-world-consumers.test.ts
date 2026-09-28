import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { CharacterService } from '../../electron/worker/character-service';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { AutomationDraftSelectionService } from '../../electron/worker/automation-draft-selection-service';
import { TimelineService } from '../../electron/worker/timeline-service';
import { TimelineEventService } from '../../electron/worker/timeline-event-service';
import { PlaceService } from '../../electron/worker/place-service';
import { RelationshipScanService } from '../../electron/worker/relationship-scan-service';
import { RelationshipService } from '../../electron/worker/relationship-service';
import { generateLocalRelationshipCandidates } from '../../electron/main/relationship-candidate-generator';
import type { CharacterScanOutput, TimelineEventOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

async function setupDraftWorldProject() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-draft-world-'));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, '草稿世界.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, [
    '第一章 同行',
    '二〇二四年三月五日，陆沉与林月在青石镇结伴守城，顾遥独自离开。',
    '后来，林月告诉旁人，陆沉一直是她最信任的朋友。',
  ].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('草稿世界', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  const editor = new EditorService(store);
  editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
  const paragraphs = editor.listParagraphs();
  const first = paragraphs.find((paragraph) => paragraph.text.includes('青石镇'))!;
  const second = paragraphs.find((paragraph) => paragraph.text.includes('最信任的朋友'))!;
  const characters = new CharacterService(store);
  const scan = characters.createScan('test-model', 'draft-world-fixture.v1');
  const work = characters.nextChunk(scan.jobId)!;
  const output: CharacterScanOutput = { characters: [
    { local_key: 'lu', display_name: '陆沉', entity_kind: 'human', role_hints: [], mention_forms: [{ text: '陆沉', kind: 'name' }],
      has_dialogue: false, participates_in_event: true, confidence: 0.99, uncertainty: '',
      evidence: [{ paragraph_id: first.id, exact_quote: first.text, supports: 'existence' }, { paragraph_id: second.id, exact_quote: second.text, supports: 'existence' }] },
    { local_key: 'lin', display_name: '林月', entity_kind: 'human', role_hints: [], mention_forms: [{ text: '林月', kind: 'name' }],
      has_dialogue: true, participates_in_event: true, confidence: 0.99, uncertainty: '',
      evidence: [{ paragraph_id: first.id, exact_quote: first.text, supports: 'existence' }, { paragraph_id: second.id, exact_quote: second.text, supports: 'dialogue' }] },
    { local_key: 'gu', display_name: '顾遥', entity_kind: 'human', role_hints: [], mention_forms: [{ text: '顾遥', kind: 'name' }],
      has_dialogue: false, participates_in_event: true, confidence: 0.8, uncertainty: '',
      evidence: [{ paragraph_id: first.id, exact_quote: first.text, supports: 'existence' }] },
  ], identity_claims: [] };
  characters.ingest(scan.jobId, work.chunkId, output, JSON.stringify(output), 0, 0);
  characters.nextChunk(scan.jobId);
  const byName = new Map(characters.listCharacters().map((character) => [character.canonicalName, character]));

  const workflowService = new FoundationWorkflowService(store);
  const workflow = workflowService.create('test-model');
  workflowService.updateStep(workflow.runId, 'character_scan', 'completed', 'fixture', { progress: 1 });
  const selections = new AutomationDraftSelectionService(store);
  const selectionStart = selections.create(workflow.runId, 'foundation-v1');
  let selection = selections.get(selectionStart.runId);
  while (selection.state === 'running') selection = selections.processNext(selection.jobId);
  const unselectedId = byName.get('顾遥')!.id;
  store.get().db.prepare('UPDATE automation_draft_selection_items SET selected = 0, reason_code = ?, reason = ? WHERE run_id = ? AND identity_id = ?')
    .run('automatic-limit', '测试夹具：不进入本次草稿集合', selection.id, unselectedId);
  store.get().db.prepare('UPDATE automation_draft_selection_runs SET selected_count = 2 WHERE id = ?').run(selection.id);
  return { store, editor, first, selectionId: selection.id, selectedIds: [byName.get('陆沉')!.id, byName.get('林月')!.id], unselectedId };
}

describe('Batch 4 automation draft world consumers', () => {
  it('binds time, event and place drafts to one completed selection without confirming outputs', async () => {
    const { store, first, selectionId, selectedIds, unselectedId } = await setupDraftWorldProject();
    try {
      const timeline = new TimelineService(store);
      const firstTimeRun = timeline.scanDraftTimeExpressions(selectionId);
      expect(firstTimeRun).toMatchObject({ reused: false, detectedCount: 1, insertedCount: 1, pendingCount: 1 });
      expect(timeline.scanDraftTimeExpressions(selectionId)).toMatchObject({ id: firstTimeRun.id, reused: true });
      const timeId = timeline.listTimeExpressions()[0].id;

      const events = new TimelineEventService(store);
      const started = events.createDraftRun(selectionId, 'test-model', 'timeline_events.draft.v1');
      const work = events.nextChunk(started.jobId)!;
      expect(work).toMatchObject({ inputMode: 'automation-draft-selection', draftSelectionRunId: selectionId });
      expect(new Set(work.characters.map((character) => character.identityId))).toEqual(new Set(selectedIds));
      expect(work.characters.some((character) => character.identityId === unselectedId)).toBe(false);
      const eventOutput: TimelineEventOutput = { events: [{
        local_key: 'guard', title: '陆沉与林月守城', summary: '陆沉与林月在青石镇结伴守城。', event_type: 'action',
        participants: [
          { identity_id: selectedIds[0], surface_name: '陆沉', role: 'actor', action_text: '守城', confidence: 0.99 },
          { identity_id: unselectedId, surface_name: '顾遥', role: 'witness', action_text: '离开', confidence: 0.8 },
        ],
        locations: [{ surface_name: '青石镇', normalized_name: '青石镇', role: 'at', confidence: 0.99 }],
        time_links: [{ time_expression_id: timeId, relation: 'occurs_at', confidence: 0.95 }],
        evidence: [{ paragraph_id: first.id, exact_quote: first.text, role: 'support' }], confidence: 0.98, uncertainty: '',
      }] };
      events.ingest(started.jobId, work.chunkId, eventOutput, JSON.stringify(eventOutput), 10, 5);
      expect(events.nextChunk(started.jobId)).toBeNull();
      const event = events.listEvents()[0];
      expect(event.reviewStatus).toBe('pending');
      expect(events.listParticipants(event.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ identityId: selectedIds[0], reviewStatus: 'pending' }),
        expect.objectContaining({ identityId: null, surfaceName: '顾遥', reviewStatus: 'pending' }),
      ]));
      expect(store.get().db.prepare('SELECT input_mode AS inputMode, draft_selection_run_id AS selectionRunId FROM timeline_event_runs WHERE id = ?')
        .get(started.runId)).toMatchObject({ inputMode: 'automation-draft-selection', selectionRunId: selectionId });

      const places = new PlaceService(store);
      expect(places.bootstrapFromConfirmedEvents().sourceLocationCount).toBe(0);
      const placeRun = places.bootstrapFromDraftEvents(selectionId, started.runId);
      expect(placeRun).toMatchObject({ reused: false, sourceLocationCount: 1, createdPlaceCount: 1, createdMentionCount: 1 });
      expect(places.bootstrapFromDraftEvents(selectionId, started.runId)).toMatchObject({ id: placeRun.id, reused: true });
      expect(places.listPlaces()).toEqual([expect.objectContaining({ canonicalName: '青石镇', reviewStatus: 'pending' })]);
    } finally {
      await store.close();
    }
  });

  it('runs local relationship drafts only inside the selected pending identities and reuses the completed input', async () => {
    const { store, selectionId, selectedIds, unselectedId } = await setupDraftWorldProject();
    try {
      const scans = new RelationshipScanService(store);
      expect(() => scans.createRun('ordinary-local.v1')).toThrow('已确认人物');
      const started = scans.createDraftRun(selectionId, 'relationship-draft-local.v1');
      const work = scans.nextChunk(started.jobId)!;
      expect(work).toMatchObject({ inputMode: 'automation-draft-selection', draftSelectionRunId: selectionId });
      expect(new Set(work.characters.map((character) => character.identityId))).toEqual(new Set(selectedIds));
      expect(work.characters.some((character) => character.identityId === unselectedId)).toBe(false);
      const output = generateLocalRelationshipCandidates(work);
      expect(output.candidates.length).toBeGreaterThan(0);
      expect(output.candidates.every((candidate) => selectedIds.includes(candidate.sourceIdentityId) && selectedIds.includes(candidate.targetIdentityId))).toBe(true);
      expect(scans.ingest(started.jobId, work.chunkId, output, JSON.stringify(output))).toMatchObject({ state: 'completed', progress: 1 });
      const candidates = new RelationshipService(store).listCandidates();
      expect(candidates.length).toBe(output.candidates.length);
      expect(candidates.every((candidate) => candidate.reviewStatus === 'pending')).toBe(true);
      expect(scans.createDraftRun(selectionId, 'relationship-draft-local.v1')).toMatchObject({ jobId: started.jobId, runId: started.runId, reused: true, state: 'completed' });
      expect(store.get().db.prepare('SELECT input_mode AS inputMode, draft_selection_run_id AS selectionRunId FROM relationship_scan_runs WHERE id = ?')
        .get(started.runId)).toMatchObject({ inputMode: 'automation-draft-selection', selectionRunId: selectionId });
    } finally {
      await store.close();
    }
  });
});