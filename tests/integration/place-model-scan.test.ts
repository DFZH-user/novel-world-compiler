import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { PlaceModelScanService } from '../../electron/worker/place-model-scan-service';
import { PlaceService } from '../../electron/worker/place-service';
import { PlaceMapExportService } from '../../electron/worker/place-map-export-service';
import { backfillSourceSpans } from '../../electron/worker/source-span-service';
import { narrativeMapExportSchema, sillyTavernPlaceWorldInfoExportSchema, type PlaceModelOutput } from '../../src/shared/contracts';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'place-model-scan-')); cleanup.push(root);
  const projectRoot = path.join(root, 'map.novelworld'); const source = path.join(root, 'novel.txt');
  await fs.writeFile(source, '第一章\n青石镇东的归雁客栈又称雁归店。归雁客栈坐落在青石镇。', 'utf8');
  const store = new ProjectStore(); await store.create('地图模型', projectRoot);
  const imported = await new Importer(store).run(source, 'utf8');
  const editor = new EditorService(store); editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 100, overlapAfter: 100 });
  const paragraph = editor.listParagraphs().find((p) => p.text.includes('归雁客栈'))!; const timestamp = new Date().toISOString();
  const town = randomUUID(); const inn = randomUUID();
  const insertPlace = store.get().db.prepare(`INSERT INTO place_identities (id, revision_id, canonical_name, normalized_name, place_type, description, importance_score,
    first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', 0.5, ?, ?, 'confirmed', 'user', ?, ?)`);
  insertPlace.run(town, imported.revisionId, '青石镇', '青石镇', 'settlement', paragraph.id, paragraph.ordinal, timestamp, timestamp);
  insertPlace.run(inn, imported.revisionId, '归雁客栈', '归雁客栈', 'building', paragraph.id, paragraph.ordinal, timestamp, timestamp);
  const insertMention = store.get().db.prepare(`INSERT INTO place_mentions (id, revision_id, place_id, paragraph_id, surface_text, char_start, char_end, extraction_method, confidence, review_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 1, 'confirmed', ?, ?)`);
  for (const [placeId, surface] of [[town, '青石镇'], [inn, '归雁客栈']] as const) {
    const start = paragraph.text.indexOf(surface); insertMention.run(randomUUID(), imported.revisionId, placeId, paragraph.id, surface, start, start + surface.length, timestamp, timestamp);
  }
  return { store, projectRoot, paragraph, town, inn };
}

describe('phase 3 recoverable place model scan', () => {
  it('ingests only supplied IDs with aligned core evidence as pending suggestions', async () => {
    const { store, projectRoot, paragraph, town, inn } = await setup();
    try {
      const scans = new PlaceModelScanService(store);
      expect(scans.estimate()).toMatchObject({ confirmedPlaceCount: 2, ready: true });
      const start = scans.createRun('temporary-model', 'place-model.v1', 'model:temporary-model:place-model.v1');
      const item = scans.nextChunk(start.jobId)!;
      expect(item.places.map((p) => p.placeId).sort()).toEqual([town, inn].sort());
      const output: PlaceModelOutput = {
        aliases: [{ place_id: inn, alias: '雁归店', confidence: 0.9, evidence: [{ paragraph_id: paragraph.id, exact_quote: '归雁客栈又称雁归店' }] }],
        identity_links: [],
        relations: [{ source_place_id: town, target_place_id: inn, relation_kind: 'contains', direction: 'directed',
          information_source_type: 'narrator', information_source_identity_id: null, truth_status: 'asserted', valid_from_event_id: null,
          valid_to_event_id: null, confidence: 0.95, evidence: [{ paragraph_id: paragraph.id, exact_quote: '归雁客栈坐落在青石镇', role: 'support' }],
          reasoning_note: '原文明示坐落关系', uncertainty: '' }],
      };
      expect(scans.ingest(start.jobId, item.chunkId, output, JSON.stringify(output), 20, 10)).toMatchObject({ state: 'completed', progress: 1 });
      expect(store.get().db.prepare(`SELECT source, review_status AS reviewStatus FROM place_aliases WHERE alias = '雁归店'`).get()).toMatchObject({ source: 'model', reviewStatus: 'pending' });
      expect(store.get().db.prepare(`SELECT candidate_method AS method, review_status AS reviewStatus FROM place_relation_candidates`).get()).toMatchObject({ method: 'model', reviewStatus: 'pending' });
      expect(store.get().db.prepare(`SELECT truth_status AS truthStatus FROM place_relation_model_suggestions`).get()).toMatchObject({ truthStatus: 'asserted' });
      backfillSourceSpans(store.get().db);
      const places = new PlaceService(store); const alias = places.listAliases(inn).find((value) => value.alias === '雁归店')!;
      expect(places.listAliasEvidence(alias.id)[0]).toMatchObject({ exactQuote: '归雁客栈又称雁归店', evidenceRole: null, sourceSpanId: expect.any(String) });
      places.reviewAlias(alias.id, 'confirmed');
      const candidate = places.listRelationCandidates('pending')[0];
      expect(places.listRelationCandidateEvidence(candidate.id)[0]).toMatchObject({ evidenceRole: 'support', sourceSpanId: expect.any(String) });
      expect(places.getRelationModelSuggestion(candidate.id)).toMatchObject({ truthStatus: 'asserted', informationSourceType: 'narrator' });
      expect(() => places.createRelationFromCandidate(candidate.id)).toThrow(/必须先经过人工确认/);
      expect(places.reviewRelationCandidate(candidate.id, 'confirmed')[0].reviewStatus).toBe('confirmed');
      const assertion = places.createRelationFromCandidate(candidate.id);
      expect(assertion).toMatchObject({ relationKind: 'contains', reviewStatus: 'pending', candidateId: candidate.id, evidenceCount: 1 });
      expect(places.createRelationFromCandidate(candidate.id).id).toBe(assertion.id);
      expect(places.listRelationsAtEntry(paragraph.ordinal)).toEqual([]);
      expect(places.getNarrativeMapProjection(paragraph.ordinal)).toMatchObject({
        coordinateSemantics: 'topology-only', nodes: expect.arrayContaining([
          expect.objectContaining({ id: town, parentId: null }),
          expect.objectContaining({ id: inn, parentId: null }),
        ]), edges: [], revealedRelationCount: 0,
      });
      expect(places.reviewRelation(assertion.id, 'confirmed')[0].reviewStatus).toBe('confirmed');
      expect(places.listRelationsAtEntry(Math.max(0, paragraph.ordinal - 1))).toEqual([]);
      expect(places.listRelationsAtEntry(paragraph.ordinal)[0]).toMatchObject({ id: assertion.id, sourceName: '青石镇', targetName: '归雁客栈' });
      backfillSourceSpans(store.get().db);
      expect(places.listRelationEvidence(assertion.id)[0]).toMatchObject({ exactQuote: '归雁客栈坐落在青石镇', evidenceRole: 'support', sourceSpanId: expect.any(String) });
      expect(places.getNarrativeMapProjection(Math.max(0, paragraph.ordinal - 1))).toMatchObject({ edges: [], evidence: [] });
      const map = places.getNarrativeMapProjection(paragraph.ordinal);
      expect(map).toMatchObject({
        entryOrdinal: paragraph.ordinal,
        coordinateSemantics: 'topology-only',
        revealedRelationCount: 1,
        temporallyInactiveRelationCount: 0,
        hierarchyConflictCount: 0,
        edges: [expect.objectContaining({ id: assertion.id, topologyClass: 'hierarchy', hasConflict: false, evidenceCount: 1 })],
        evidence: [expect.objectContaining({ relationId: assertion.id, exactQuote: '归雁客栈坐落在青石镇' })],
      });
      expect(map.nodes.find((node) => node.id === town)).toMatchObject({ parentId: null, degree: 1, hierarchyConflict: false });
      expect(map.nodes.find((node) => node.id === inn)).toMatchObject({ parentId: town, degree: 1, hierarchyConflict: false });
      const exporter = new PlaceMapExportService(store);
      const built = exporter.build(paragraph.ordinal);
      expect(built).toMatchObject({
        format: 'novel-world-narrative-map',
        spec_version: '1.0',
        coordinate_semantics: 'topology-only',
        fence: { entry_ordinal: paragraph.ordinal },
        relations: [expect.objectContaining({ id: assertion.id, topology_class: 'hierarchy', active_at_entry: true })],
      });
      expect(built.relations[0].evidence_ids).toEqual([map.evidence[0].id]);
      expect(built.nodes.find((node) => node.id === inn)?.aliases).toEqual(['雁归店']);
      const outputPath = path.join(path.dirname(projectRoot), 'world_map.json');
      const exported = await exporter.export(paragraph.ordinal, outputPath);
      const serialized = await fs.readFile(outputPath, 'utf8');
      expect(narrativeMapExportSchema.parse(JSON.parse(serialized))).toMatchObject({ format: 'novel-world-narrative-map' });
      expect(exported.checksum).toBe(createHash('sha256').update(serialized).digest('hex'));
      expect(serialized).not.toContain('coordinates');
      const worldInfoPath = path.join(path.dirname(projectRoot), 'places_world_info.json');
      const worldInfoResult = await exporter.exportWorldInfo(paragraph.ordinal, worldInfoPath);
      const worldInfoSerialized = await fs.readFile(worldInfoPath, 'utf8');
      const worldInfo = sillyTavernPlaceWorldInfoExportSchema.parse(JSON.parse(worldInfoSerialized));
      expect(worldInfoResult.checksum).toBe(createHash('sha256').update(worldInfoSerialized).digest('hex'));
      expect(worldInfo.extensions.novel_world_compiler).toMatchObject({
        narrative_map_spec_version: '1.0', coordinate_semantics: 'topology-only', entry_ordinal: paragraph.ordinal,
      });
      const worldEntries = Object.values(worldInfo.entries);
      expect(worldEntries).toHaveLength(3);
      expect(worldEntries.find((entry) => entry.comment === '地点：归雁客栈')?.key).toEqual(expect.arrayContaining(['归雁客栈', '雁归店']));
      expect(worldEntries.find((entry) => entry.extensions.novel_world_compiler.entry_kind === 'spatial_relation')?.extensions.novel_world_compiler)
        .toMatchObject({ source_relation_ids: [assertion.id], source_evidence_ids: [map.evidence[0].id] });
      for (const [status, label] of [['rumor', '传闻'], ['false', '已否定'], ['disputed', '有争议'], ['suspected', '疑似'], ['unknown', '未知']] as const) {
        store.get().db.prepare('UPDATE place_relations SET truth_status = ? WHERE id = ?').run(status, assertion.id);
        const qualified = Object.values(exporter.buildWorldInfo(paragraph.ordinal).entries);
        for (const entry of qualified) expect(entry.content).toContain(label);
        expect(qualified.find((entry) => entry.comment === '地点：归雁客栈')?.content).not.toContain('已确认所属地点');
      }
    } finally { await store.close(); }
  });

  it('rejects invented place IDs and restores interrupted chunks as paused work', async () => {
    const { store, projectRoot, paragraph, inn } = await setup(); const scans = new PlaceModelScanService(store);
    const start = scans.createRun('temporary-model', 'place-model.v1', 'model:temporary-model:place-model.v1'); const item = scans.nextChunk(start.jobId)!;
    expect(() => scans.ingest(start.jobId, item.chunkId, { aliases: [{ place_id: 'invented', alias: '假名', confidence: 1, evidence: [{ paragraph_id: paragraph.id, exact_quote: '归雁客栈' }] }], identity_links: [], relations: [] }, '{}')).toThrow(/本分块提供/);
    await store.close(); const reopened = new ProjectStore(); await reopened.open(projectRoot);
    try {
      expect(reopened.get().db.prepare(`SELECT status FROM place_model_scan_chunk_results WHERE run_id = ?`).get(start.runId)).toMatchObject({ status: 'pending' });
      expect(reopened.get().db.prepare(`SELECT status FROM place_model_scan_runs WHERE id = ?`).get(start.runId)).toMatchObject({ status: 'paused' });
      const resumed = new PlaceModelScanService(reopened);
      resumed.controlJob(start.jobId, 'resume');
      expect(reopened.get().db.prepare(`SELECT COUNT(*) AS value FROM job_attempts WHERE job_id = ? AND state = 'running'`).get(start.jobId))
        .toMatchObject({ value: 1 });
    } finally { await reopened.close(); }
  });
});
