import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { TimelineEventService } from '../../electron/worker/timeline-event-service';
import { PlaceService } from '../../electron/worker/place-service';
import { backfillSourceSpans } from '../../electron/worker/source-span-service';
import { SCHEMA_VERSION } from '../../electron/worker/schema';
import type { TimelineEventOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

async function setupPlaceProject() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-places-'));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, '叙事地图.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, [
    '第一章 归来',
    '陆沉回到青石镇，随后住进镇东的归雁客栈。',
    '第二天，他从归雁客栈前往北城门。',
  ].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('叙事地图', projectRoot);
  const imported = await new Importer(store).run(sourcePath, 'utf8');
  const editor = new EditorService(store);
  editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 100, overlapAfter: 100 });
  const events = new TimelineEventService(store);
  const run = events.createRun('test-model', 'timeline_events.v1');
  const work = events.nextChunk(run.jobId)!;
  const arrival = editor.listParagraphs().find((paragraph) => paragraph.text.includes('青石镇'))!;
  const output: TimelineEventOutput = { events: [{
    local_key: 'arrival', title: '陆沉抵达青石镇', summary: '陆沉回到青石镇并入住客栈。', event_type: 'movement',
    participants: [],
    locations: [
      { surface_name: '青石镇', normalized_name: '青石镇', role: 'to', confidence: 0.99 },
      { surface_name: '归雁客栈', normalized_name: '归雁客栈', role: 'at', confidence: 0.97 },
      { surface_name: '幽冥宫', normalized_name: '幽冥宫', role: 'mentioned', confidence: 0.4 },
    ],
    time_links: [],
    evidence: [{ paragraph_id: arrival.id, exact_quote: arrival.text, role: 'support' }],
    confidence: 0.98, uncertainty: '',
  }] };
  events.ingest(run.jobId, work.chunkId, output, JSON.stringify(output), 30, 20);
  const event = events.listEvents()[0];
  return { store, imported, editor, events, event, arrival };
}

describe('phase 3 place foundation and identity governance', () => {
  it('migrates to schema v19 with recoverable model scan, evidence, spatial relation and reviewed geometry tables', async () => {
    const { store } = await setupPlaceProject();
    try {
      expect(store.get().db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toMatchObject({ version: SCHEMA_VERSION });
      for (const table of ['place_identities', 'place_aliases', 'place_mentions', 'place_identity_links', 'place_identity_operations',
        'place_relation_candidates', 'place_relations', 'place_relation_evidence', 'place_model_scan_runs',
        'place_model_scan_chunk_results', 'place_alias_evidence', 'place_identity_link_evidence',
        'place_relation_model_suggestions', 'place_model_alias_sources', 'place_model_identity_link_sources',
        'place_model_relation_candidate_sources', 'place_geometries']) {
        expect(store.get().db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)).toMatchObject({ name: table });
      }
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
    } finally {
      await store.close();
    }
  });

  it('blocks known-different places and supports reversible merge, split and alias review', async () => {
    const { store, events, event } = await setupPlaceProject();
    try {
      events.reviewEvent(event.id, 'confirmed');
      const places = new PlaceService(store);
      places.bootstrapFromConfirmedEvents();
      const initial = places.listPlaces();
      const town = initial.find((place) => place.canonicalName === '青石镇')!;
      const inn = initial.find((place) => place.canonicalName === '归雁客栈')!;

      places.link(town.id, inn.id, 'cannot_link', '城镇与客栈是不同空间层级');
      expect(places.listLinks(town.id)[0]).toMatchObject({ relation: 'cannot_link', reviewStatus: 'confirmed' });
      expect(() => places.merge(inn.id, town.id)).toThrow(/不同地点/);
      expect(places.undoLatest().operation.operation).toBe('cannot_link');
      expect(places.listLinks()).toHaveLength(0);

      places.merge(inn.id, town.id);
      expect(places.listPlaces().find((place) => place.id === inn.id)?.reviewStatus).toBe('rejected');
      expect(places.listMentions(town.id)).toHaveLength(2);
      const canonicalAlias = places.listAliases(town.id).find((alias) => alias.alias === '归雁客栈')!;
      expect(canonicalAlias).toMatchObject({ source: 'user', reviewStatus: 'confirmed' });
      places.reviewAlias(canonicalAlias.id, 'rejected');
      expect(places.listAliases(town.id).find((alias) => alias.id === canonicalAlias.id)?.reviewStatus).toBe('rejected');
      expect(places.undoLatest().operation.operation).toBe('alias_review');

      const innMention = places.listMentions(town.id).find((mention) => mention.surfaceText === '归雁客栈')!;
      places.split(town.id, [innMention.id], '归雁客栈东店');
      const split = places.listPlaces().find((place) => place.canonicalName === '归雁客栈东店')!;
      expect(split).toMatchObject({ reviewStatus: 'pending', mentionCount: 1 });
      expect(places.listLinks(split.id)[0]).toMatchObject({ relation: 'cannot_link', reviewStatus: 'confirmed' });
      expect(places.undoLatest().operation.operation).toBe('split');
      expect(places.listPlaces().some((place) => place.canonicalName === '归雁客栈东店')).toBe(false);

      expect(places.undoLatest().operation.operation).toBe('merge');
      expect(places.listMentions(town.id)).toHaveLength(1);
      expect(places.listMentions(inn.id)).toHaveLength(1);
      expect(places.listPlaces().find((place) => place.id === inn.id)?.reviewStatus).toBe('pending');
    } finally {
      await store.close();
    }
  });

  it('creates only aligned pending places from confirmed event locations and remains idempotent', async () => {
    const { store, events, event, arrival } = await setupPlaceProject();
    try {
      const places = new PlaceService(store);
      expect(places.bootstrapFromConfirmedEvents()).toEqual({
        sourceLocationCount: 0, createdPlaceCount: 0, createdMentionCount: 0, skippedUnalignedCount: 0,
      });
      events.reviewEvent(event.id, 'confirmed');
      const first = places.bootstrapFromConfirmedEvents();
      expect(first).toMatchObject({ sourceLocationCount: 3, createdPlaceCount: 2, skippedUnalignedCount: 1 });
      expect(first.createdMentionCount).toBe(2);
      expect(places.listPlaces().map((place) => place.canonicalName).sort()).toEqual(['归雁客栈', '青石镇'].sort());
      expect(places.listPlaces().every((place) => place.reviewStatus === 'pending')).toBe(true);
      expect(places.listPlaces().some((place) => place.canonicalName === '幽冥宫')).toBe(false);

      expect(places.bootstrapFromConfirmedEvents()).toEqual({
        sourceLocationCount: 3, createdPlaceCount: 0, createdMentionCount: 0, skippedUnalignedCount: 1,
      });
      const town = places.listPlaces().find((place) => place.canonicalName === '青石镇')!;
      backfillSourceSpans(store.get().db);
      const mentions = places.listMentions(town.id);
      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toMatchObject({ paragraphId: arrival.id, surfaceText: '青石镇', reviewStatus: 'pending', sourceSpanId: expect.any(String) });
      expect(mentions[0].paragraphText.slice(mentions[0].charStart, mentions[0].charEnd)).toBe('青石镇');

      places.review(town.id, { status: 'confirmed', placeType: 'settlement', canonicalName: '青石镇' });
      expect(places.listPlaces('confirmed')[0]).toMatchObject({ id: town.id, placeType: 'settlement', mentionCount: 1, sourceEventCount: 1 });
      expect(places.listMentions(town.id)[0].reviewStatus).toBe('confirmed');
      expect(places.getNarrativeMapProjection(Math.max(0, arrival.ordinal - 1)).events).toEqual([]);
      expect(places.getNarrativeMapProjection(arrival.ordinal).events).toEqual([
        expect.objectContaining({
          id: event.id,
          title: '陆沉抵达青石镇',
          narrativeStartOrdinal: arrival.ordinal,
          places: [{ placeId: town.id, locationRole: 'to' }],
          participants: [],
        }),
      ]);
    } finally {
      await store.close();
    }
  });

  it('rejects confirmation without a mention and enforces spatial relation endpoint constraints', async () => {
    const { store, imported, editor, events, event } = await setupPlaceProject();
    try {
      events.reviewEvent(event.id, 'confirmed');
      const places = new PlaceService(store);
      places.bootstrapFromConfirmedEvents();
      const records = places.listPlaces();
      for (const place of records) places.review(place.id, { status: 'confirmed', placeType: 'other' });
      const paragraph = editor.listParagraphs()[1];
      const timestamp = new Date().toISOString();
      const noEvidenceId = randomUUID();
      store.get().db.prepare(`INSERT INTO place_identities
        (id, revision_id, canonical_name, normalized_name, place_type, description, importance_score,
         first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method, created_at, updated_at)
        VALUES (?, ?, '无证地点', '无证地点', 'other', '', 0.2, ?, ?, 'pending', 'user', ?, ?)`)
        .run(noEvidenceId, imported.revisionId, paragraph.id, paragraph.ordinal, timestamp, timestamp);
      expect(() => places.review(noEvidenceId, { status: 'confirmed' })).toThrow('至少有一条');

      const insertRelation = store.get().db.prepare(`INSERT INTO place_relations
        (id, revision_id, source_place_id, target_place_id, relation_kind, direction, information_source_type,
         truth_status, first_revealed_paragraph_id, first_revealed_ordinal, confidence, review_status,
         extraction_method, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'contains', 'directed', 'narrator', 'asserted', ?, ?, 0.9, 'pending', 'user', ?, ?)`);
      expect(() => insertRelation.run(randomUUID(), imported.revisionId, records[0].id, records[0].id,
        paragraph.id, paragraph.ordinal, timestamp, timestamp)).toThrow();
      expect(() => insertRelation.run(randomUUID(), imported.revisionId, records[0].id, records[1].id,
        paragraph.id, paragraph.ordinal, timestamp, timestamp)).not.toThrow();
      expect(() => places.merge(records[0].id, records[1].id)).toThrow(/空间关系/);
    } finally {
      await store.close();
    }
  });
});
