import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { TimelineEventService } from '../../electron/worker/timeline-event-service';
import { PlaceService } from '../../electron/worker/place-service';
import { PlaceGeometryService } from '../../electron/worker/place-geometry-service';
import { placeGeoJsonSchema } from '../../src/shared/contracts';
import type { TimelineEventOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

async function setupGeometryProject() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-place-geometry-'));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, '真实地点.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, ['第一章 抵达', '旅人终于抵达杭州，并在西湖边停下。'].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('真实地点', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  const editor = new EditorService(store);
  editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 100, overlapAfter: 100 });
  const paragraph = editor.listParagraphs().find((item) => item.text.includes('杭州'))!;
  const events = new TimelineEventService(store);
  const run = events.createRun('test-model', 'timeline_events.v1');
  const work = events.nextChunk(run.jobId)!;
  const output: TimelineEventOutput = { events: [{
    local_key: 'arrival', title: '旅人抵达杭州', summary: '旅人抵达杭州。', event_type: 'movement', participants: [],
    locations: [{ surface_name: '杭州', normalized_name: '杭州', role: 'to', confidence: 0.99 }], time_links: [],
    evidence: [{ paragraph_id: paragraph.id, exact_quote: paragraph.text, role: 'support' }], confidence: 0.99, uncertainty: '',
  }] };
  events.ingest(run.jobId, work.chunkId, output, JSON.stringify(output), 10, 10);
  events.reviewEvent(events.listEvents()[0].id, 'confirmed');
  const places = new PlaceService(store);
  places.bootstrapFromConfirmedEvents();
  const place = places.listPlaces()[0];
  return { store, places, place, paragraph, tempRoot };
}

describe('reviewed real-world place geometry and GeoJSON export', () => {
  it('requires a confirmed place, validates WGS84 bounds and resets edited coordinates to pending', async () => {
    const { store, places, place } = await setupGeometryProject();
    try {
      const geometries = new PlaceGeometryService(store);
      const base = {
        placeId: place.id, longitude: 120.1551, latitude: 30.2741,
        sourceKind: 'manual' as const, sourceLabel: '人工核对', sourceUri: null,
        certainty: 'certain' as const, note: 'WGS84',
      };
      expect(() => geometries.upsert(base)).toThrow(/先确认地点身份/);
      places.review(place.id, { status: 'confirmed', placeType: 'city' });
      expect(() => geometries.upsert({ ...base, longitude: 181 })).toThrow(/经度/);
      expect(() => geometries.upsert({ ...base, latitude: -91 })).toThrow(/纬度/);

      const created = geometries.upsert(base);
      expect(created).toMatchObject({ placeId: place.id, coordinateSystem: 'WGS84', geometryType: 'Point', reviewStatus: 'pending' });
      expect(geometries.review(created.id, 'confirmed')[0].reviewStatus).toBe('confirmed');
      const edited = geometries.upsert({ ...base, longitude: 120.16, certainty: 'less_certain' });
      expect(edited).toMatchObject({ id: created.id, longitude: 120.16, reviewStatus: 'pending', certainty: 'less_certain' });
    } finally {
      await store.close();
    }
  });

  it('exports only confirmed and revealed WGS84 points with provenance and RFC 7946 coordinate order', async () => {
    const { store, places, place, paragraph, tempRoot } = await setupGeometryProject();
    try {
      places.review(place.id, { status: 'confirmed', placeType: 'city' });
      const geometries = new PlaceGeometryService(store);
      const pending = geometries.upsert({
        placeId: place.id, longitude: 120.1551, latitude: 30.2741,
        sourceKind: 'gazetteer', sourceLabel: 'CHGIS 示例来源', sourceUri: 'https://chgis.fas.harvard.edu/',
        certainty: 'less_certain', note: '集成测试坐标，不代表项目内置地名库结果',
      });
      expect(geometries.buildGeoJson(paragraph.ordinal).features).toEqual([]);
      expect(geometries.buildGeoJson(Math.max(0, paragraph.ordinal - 1)).features).toEqual([]);
      geometries.review(pending.id, 'confirmed');

      const geoJson = geometries.buildGeoJson(paragraph.ordinal);
      expect(() => placeGeoJsonSchema.parse(geoJson)).not.toThrow();
      expect(geoJson.bbox).toEqual([120.1551, 30.2741, 120.1551, 30.2741]);
      expect(geoJson.features).toEqual([expect.objectContaining({
        type: 'Feature', id: place.id,
        geometry: { type: 'Point', coordinates: [120.1551, 30.2741] },
        properties: expect.objectContaining({
          name: '杭州', place_type: 'city', certainty: 'less_certain', coordinate_system: 'WGS84',
          provenance: expect.objectContaining({ kind: 'gazetteer', label: 'CHGIS 示例来源' }),
        }),
      })]);
      expect(geoJson.novel_world_compiler).toMatchObject({ coordinate_semantics: 'earth-wgs84-confirmed-only', entry_ordinal: paragraph.ordinal });

      const outputPath = path.join(tempRoot, 'places.geojson');
      const exported = await geometries.exportGeoJson(paragraph.ordinal, outputPath);
      const serialized = await fs.readFile(outputPath, 'utf8');
      expect(exported.checksum).toBe(createHash('sha256').update(serialized).digest('hex'));
      expect(JSON.parse(serialized).features).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('does not confirm a gazetteer record without a source URL', async () => {
    const { store, places, place } = await setupGeometryProject();
    try {
      places.review(place.id, { status: 'confirmed' });
      const geometries = new PlaceGeometryService(store);
      const record = geometries.upsert({
        placeId: place.id, longitude: 120, latitude: 30,
        sourceKind: 'gazetteer', sourceLabel: '外部地名库', sourceUri: null,
        certainty: 'uncertain', note: '',
      });
      expect(() => geometries.review(record.id, 'confirmed')).toThrow(/来源名称和可访问链接/);
    } finally {
      await store.close();
    }
  });
});
