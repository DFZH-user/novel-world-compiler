import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { TimelineRelationService } from '../../electron/worker/timeline-relation-service';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

describe('phase 1C reviewed temporal relation graph', () => {
  it('proposes evidence-based relations, orders simultaneous groups and blocks cycles', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-relations-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '关系图.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 行程',
      '二〇二四年三月五日，陆沉抵达青石镇。',
      '二〇二四年三月八日，陆沉进入客栈。',
      '与此同时，林月推开客栈后门。',
    ].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('关系图', projectRoot);
      const imported = await new Importer(store).run(sourcePath, 'utf8');
      const paragraphs = new EditorService(store).listParagraphs();
      const aParagraph = paragraphs.find((item) => item.text.includes('抵达青石镇'))!;
      const bParagraph = paragraphs.find((item) => item.text.includes('进入客栈'))!;
      const cParagraph = paragraphs.find((item) => item.text.includes('与此同时'))!;
      const { db } = store.get();
      const timestamp = new Date().toISOString();
      const insertEvent = db.prepare(`INSERT INTO timeline_events
        (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal, extraction_method,
         confidence, review_status, uncertainty, created_at, updated_at) VALUES (?, ?, ?, '', 'movement', ?, ?, 'model', 0.95, 'confirmed', '', ?, ?)`);
      insertEvent.run('event-a', imported.revisionId, '陆沉抵达青石镇', aParagraph.ordinal, aParagraph.ordinal, timestamp, timestamp);
      insertEvent.run('event-b', imported.revisionId, '陆沉进入客栈', bParagraph.ordinal, bParagraph.ordinal, timestamp, timestamp);
      insertEvent.run('event-c', imported.revisionId, '林月推开后门', cParagraph.ordinal, cParagraph.ordinal, timestamp, timestamp);
      const insertTime = db.prepare(`INSERT INTO timeline_time_expressions
        (id, revision_id, paragraph_id, start_offset, end_offset, surface_text, expression_type, normalized_value,
         calendar_system, detection_method, confidence, review_status, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'rule', 0.98, 'confirmed', ?, ?)`);
      insertTime.run('time-a', imported.revisionId, aParagraph.id, '二〇二四年三月五日'.length, '二〇二四年三月五日', 'calendar', '2024-03-05', 'gregorian', timestamp, timestamp);
      insertTime.run('time-b', imported.revisionId, bParagraph.id, '二〇二四年三月八日'.length, '二〇二四年三月八日', 'calendar', '2024-03-08', 'gregorian', timestamp, timestamp);
      insertTime.run('time-c', imported.revisionId, cParagraph.id, '与此同时'.length, '与此同时', 'relative', 'RELATIVE:SIMULTANEOUS', 'relative', timestamp, timestamp);
      const insertLink = db.prepare(`INSERT INTO timeline_event_time_links
        (id, event_id, time_expression_id, relation, confidence, review_status, created_at, updated_at)
        VALUES (?, ?, ?, 'occurs_at', 0.95, 'confirmed', ?, ?)`);
      insertLink.run('link-a', 'event-a', 'time-a', timestamp, timestamp);
      insertLink.run('link-b', 'event-b', 'time-b', timestamp, timestamp);
      insertLink.run('link-c', 'event-c', 'time-c', timestamp, timestamp);

      const service = new TimelineRelationService(store);
      expect(service.consolidate()).toMatchObject({ createdCount: 2, totalCount: 2, pendingCount: 2 });
      expect(service.consolidate().createdCount).toBe(0);
      let relations = service.listRelations();
      expect(relations.map((item) => item.proposedRelation)).toEqual(['before', 'simultaneous']);
      relations = service.reviewRelation(relations[0].id, 'confirmed');
      relations = service.reviewRelation(relations.find((item) => item.proposedRelation === 'simultaneous')!.id, 'confirmed');
      expect(service.graphSummary()).toMatchObject({ eventCount: 3, confirmedRelationCount: 2, hasCycle: false, orderedEventCount: 3 });
      const order = service.timelineOrder();
      expect(order.find((item) => item.eventId === 'event-a')?.orderLevel).toBe(0);
      expect(order.find((item) => item.eventId === 'event-b')?.orderLevel).toBe(1);
      expect(order.find((item) => item.eventId === 'event-b')?.simultaneousGroup).toBe(order.find((item) => item.eventId === 'event-c')?.simultaneousGroup);

      db.prepare(`INSERT INTO timeline_event_relations
        (id, revision_id, left_event_id, right_event_id, relation, source_type, confidence, reason, review_status, created_at, updated_at)
        VALUES ('cycle-candidate', ?, 'event-c', 'event-a', 'before', 'user', 1, '循环测试', 'pending', ?, ?)`)
        .run(imported.revisionId, timestamp, timestamp);
      expect(() => service.reviewRelation('cycle-candidate', 'confirmed', 'before')).toThrow('形成故事时间循环');
      expect(service.listRelations().find((item) => item.id === 'cycle-candidate')?.reviewStatus).toBe('pending');
      service.reviewRelation('cycle-candidate', 'confirmed', 'after');
      expect(service.graphSummary().hasCycle).toBe(false);
    } finally {
      await store.close();
    }
  });
});
