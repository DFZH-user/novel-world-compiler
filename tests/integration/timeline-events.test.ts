import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { TimelineService } from '../../electron/worker/timeline-service';
import { TimelineEventService } from '../../electron/worker/timeline-event-service';
import { backfillSourceSpans } from '../../electron/worker/source-span-service';
import type { TimelineEventOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

async function setupProject() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-events-'));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, '事件.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, [
    '第一章 归来',
    '二〇二四年三月五日，陆沉回到青石镇。',
    '他在城门外遇见林月，两人决定前往客栈。',
  ].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('事件', projectRoot);
  const imported = await new Importer(store).run(sourcePath, 'utf8');
  const editor = new EditorService(store);
  editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 100, overlapAfter: 100 });
  const identityId = randomUUID();
  const timestamp = new Date().toISOString();
  store.get().db.prepare(`INSERT INTO person_identities
    (id, revision_id, canonical_name, normalized_name, entity_type, review_status, created_at, updated_at)
    VALUES (?, ?, '陆沉', '陆沉', 'human', 'confirmed', ?, ?)`).run(identityId, imported.revisionId, timestamp, timestamp);
  const timeline = new TimelineService(store);
  timeline.scanTimeExpressions();
  const time = timeline.listTimeExpressions()[0];
  timeline.reviewTimeExpression(time.id, 'confirmed', '2024-03-05');
  return { store, editor, identityId, timeId: time.id };
}

describe('phase 1C recoverable event extraction foundation', () => {
  it('accepts only aligned core evidence and preserves participants, locations and time links for review', async () => {
    const { store, editor, identityId, timeId } = await setupProject();
    try {
      const events = new TimelineEventService(store);
      expect(events.estimate()).toMatchObject({ chunkCount: 1, ready: true });
      const run = events.createRun('test-model', 'timeline_events.v1');
      const work = events.nextChunk(run.jobId)!;
      expect(work.characters).toContainEqual({ identityId, name: '陆沉', aliases: [] });
      expect(work.timeExpressions[0]).toMatchObject({ id: timeId, reviewStatus: 'confirmed' });
      const arrival = editor.listParagraphs().find((paragraph) => paragraph.text.includes('回到青石镇'))!;
      const output: TimelineEventOutput = { events: [
        {
          local_key: 'arrival', title: '陆沉返回青石镇', summary: '陆沉在明确日期返回青石镇。', event_type: 'movement',
          participants: [
            { identity_id: identityId, surface_name: '陆沉', role: 'actor', action_text: '回到青石镇', confidence: 0.99 },
            { identity_id: randomUUID(), surface_name: '未知同行者', role: 'witness', action_text: '', confidence: 0.4 },
          ],
          locations: [{ surface_name: '青石镇', normalized_name: '青石镇', role: 'to', confidence: 0.99 }],
          time_links: [{ time_expression_id: timeId, relation: 'occurs_at', confidence: 0.98 }],
          evidence: [{ paragraph_id: arrival.id, exact_quote: arrival.text, role: 'support' }], confidence: 0.98, uncertainty: '',
        },
        {
          local_key: 'fabricated', title: '不存在的战斗', summary: '没有原文证据。', event_type: 'conflict', participants: [], locations: [], time_links: [],
          evidence: [{ paragraph_id: arrival.id, exact_quote: '陆沉与巨龙大战三百回合', role: 'support' }], confidence: 0.9, uncertainty: '',
        },
      ] };
      expect(events.ingest(run.jobId, work.chunkId, output, JSON.stringify(output), 100, 50)).toMatchObject({ progress: 1 });
      expect(events.nextChunk(run.jobId)).toBeNull();
      const records = events.listEvents();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ title: '陆沉返回青石镇', participantCount: 2, locationCount: 1, evidenceCount: 1, timeLinkCount: 1 });
      backfillSourceSpans(store.get().db);
      expect(events.listEvidence(records[0].id)[0]).toMatchObject({ exactQuote: arrival.text, alignmentStatus: 'exact', sourceSpanId: expect.any(String) });
      expect(events.listParticipants(records[0].id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ identityId, identityName: '陆沉', surfaceName: '陆沉' }),
        expect.objectContaining({ identityId: null, surfaceName: '未知同行者' }),
      ]));
      expect(events.listLocations(records[0].id)[0]).toMatchObject({ surfaceName: '青石镇', locationRole: 'to' });
      expect(events.reviewEvent(records[0].id, 'confirmed').find((event) => event.id === records[0].id)?.reviewStatus).toBe('confirmed');
    } finally {
      await store.close();
    }
  });

  it('reuses a failed run and resets its failed chunk for retry', async () => {
    const { store } = await setupProject();
    try {
      const events = new TimelineEventService(store);
      const first = events.createRun('test-model', 'timeline_events.v1');
      const work = events.nextChunk(first.jobId)!;
      expect(events.recordError(first.jobId, work.chunkId, 'temporary failure', true).state).toBe('failed');
      const resumed = events.createRun('test-model', 'timeline_events.v1');
      expect(resumed).toMatchObject({ jobId: first.jobId, runId: first.runId, state: 'running', reused: true });
      expect(events.nextChunk(resumed.jobId)?.chunkId).toBe(work.chunkId);
    } finally {
      await store.close();
    }
  });
});
