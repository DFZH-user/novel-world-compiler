import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { readStartingScene } from '../../electron/worker/play-starting-scene';
import { RelationshipService } from '../../electron/worker/relationship-service';
import { RelationshipGraphExportService } from '../../electron/worker/relationship-graph-export-service';
import { SQLiteDatabase } from '../../electron/worker/sqlite-db';
import { BASE_SCHEMA_VERSION, SCHEMA_VERSION, schemaSql } from '../../electron/worker/schema';
import { characterGraphExportSchema, sillyTavernWorldInfoExportSchema } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

async function setupRelationshipProject() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-relationships-'));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, '人物关系.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, [
    '第一章 同行',
    '陆沉与林月结伴守城。',
    '后来，两人在议事厅发生争执。',
    '直到城门失守，旁人才知道陆沉已经背叛林月。',
  ].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('人物关系', projectRoot);
  const imported = await new Importer(store).run(sourcePath, 'utf8');
  const paragraphs = new EditorService(store).listParagraphs();
  const timestamp = new Date().toISOString();
  const identities = {
    lu: randomUUID(),
    lin: randomUUID(),
    pending: randomUUID(),
    hiddenSource: randomUUID(),
  };
  const insertIdentity = store.get().db.prepare(`INSERT INTO person_identities
    (id, revision_id, canonical_name, normalized_name, entity_type, review_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'human', ?, ?, ?)`);
  insertIdentity.run(identities.lu, imported.revisionId, '陆沉', '陆沉', 'confirmed', timestamp, timestamp);
  insertIdentity.run(identities.lin, imported.revisionId, '林月', '林月', 'confirmed', timestamp, timestamp);
  insertIdentity.run(identities.pending, imported.revisionId, '疑似同名者', '疑似同名者', 'pending', timestamp, timestamp);
  insertIdentity.run(identities.hiddenSource, imported.revisionId, '未来知情者', '未来知情者', 'confirmed', timestamp, timestamp);
  const insertEvent = store.get().db.prepare(`INSERT INTO timeline_events
    (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal, extraction_method,
     confidence, review_status, uncertainty, created_at, updated_at)
    VALUES (?, ?, ?, '', 'other', ?, ?, 'user', 1, 'confirmed', '', ?, ?)`);
  insertEvent.run('event-alliance', imported.revisionId, '结伴守城', paragraphs[1].ordinal, paragraphs[1].ordinal, timestamp, timestamp);
  insertEvent.run('event-argument', imported.revisionId, '议事厅争执', paragraphs[2].ordinal, paragraphs[2].ordinal, timestamp, timestamp);
  return { store, paragraphs, identities };
}

describe('phase 2 batch 1 relationship graph foundation', () => {
  it('withholds event summaries until every evidence paragraph is revealed', async () => {
    const { store, paragraphs, identities } = await setupRelationshipProject();
    try {
      const db = store.get().db;
      const timestamp = new Date().toISOString();
      db.prepare(`INSERT INTO timeline_event_participants
        (id,event_id,identity_id,surface_name,role,confidence,review_status,created_at,updated_at)
        VALUES ('participant-safe','event-alliance',?,'陆沉','actor',1,'confirmed',?,?)`)
        .run(identities.lu,timestamp,timestamp);
      const addQuote = db.prepare(`INSERT INTO timeline_event_evidence
        (id,event_id,paragraph_id,exact_quote,evidence_role,alignment_status,created_at)
        VALUES (?,'event-alliance',?,?,'support','exact',?)`);
      addQuote.run('evidence-early',paragraphs[1].id,paragraphs[1].text,timestamp);
      addQuote.run('evidence-late',paragraphs[3].id,paragraphs[3].text,timestamp);
      db.prepare("UPDATE timeline_events SET summary = '未来背叛信息' WHERE id = 'event-alliance'").run();
      const service = new RelationshipService(store);
      expect(service.getGraphProjection(paragraphs[1].ordinal).events).toEqual([]);
      const earlyScene = readStartingScene(store, 'event-alliance', paragraphs[1].ordinal);
      expect(earlyScene.state).toBe('partial');
      expect(earlyScene.context).toContain(paragraphs[1].text);
      expect(earlyScene.context).not.toContain('未来背叛信息');
      expect(earlyScene.locations).toEqual([]);
      expect(readStartingScene(store, 'event-alliance', paragraphs[3].ordinal)).toMatchObject({ state: 'complete', context: '未来背叛信息' });
      const revealed = service.getGraphProjection(paragraphs[3].ordinal).events!;
      expect(revealed).toHaveLength(1);
      expect(service.getGraphProjection(paragraphs[3].ordinal).nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: identities.lu, degree: 0 })]));
      expect(revealed[0].summary).toBe('未来背叛信息');
      expect(revealed[0].participants.map(person => person.identityId)).toEqual([identities.lu]);
      expect(revealed[0].evidence).toHaveLength(2);
      db.prepare("UPDATE timeline_events SET review_status = 'pending' WHERE id = 'event-alliance'").run();
      expect(service.getGraphProjection(paragraphs[3].ordinal).events).toEqual([]);
    } finally { await store.close(); }
  });

  it('migrates a v13 project transactionally without losing existing data', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-schema-v13-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '旧工程.novelworld');
    await fs.mkdir(projectRoot);
    const projectId = randomUUID();
    const createdAt = new Date().toISOString();
    await fs.writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({
      format: 'novel-world-project', schemaVersion: BASE_SCHEMA_VERSION, projectId, name: '旧工程', createdAt,
    }, null, 2), 'utf8');
    const databasePath = path.join(projectRoot, 'novel.db');
    const database = await SQLiteDatabase.open(databasePath);
    database.exec(schemaSql);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(BASE_SCHEMA_VERSION, createdAt);
    database.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, '旧工程', ?, ?, ?)`)
      .run(projectId, projectRoot, createdAt, createdAt);
    database.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('phase1-data', '{"preserved":true}', ?)`)
      .run(createdAt);
    database.close();

    const store = new ProjectStore();
    try {
      await store.open(projectRoot);
      expect(store.get().db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toMatchObject({ version: SCHEMA_VERSION });
      expect(store.get().db.prepare(`SELECT value_json AS valueJson FROM settings WHERE key = 'phase1-data'`).get())
        .toMatchObject({ valueJson: '{"preserved":true}' });
      expect(store.get().db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_relationships'`).get())
        .toMatchObject({ name: 'character_relationships' });
      expect(store.get().db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relationship_scan_runs'`).get())
        .toMatchObject({ name: 'relationship_scan_runs' });
      expect(store.get().db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relationship_model_suggestions'`).get())
        .toMatchObject({ name: 'relationship_model_suggestions' });
      const candidateColumns = store.get().db.prepare(`PRAGMA table_info(character_relationship_candidates)`).all() as Array<{ name: string }>;
      expect(candidateColumns.some((column) => column.name === 'source_fingerprint')).toBe(true);
      expect(store.get().db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_relationship_candidates_source_fingerprint'`).get())
        .toMatchObject({ name: 'idx_relationship_candidates_source_fingerprint' });
      expect(JSON.parse(await fs.readFile(path.join(projectRoot, 'project.json'), 'utf8'))).toMatchObject({ schemaVersion: SCHEMA_VERSION });
    } finally {
      await store.close();
    }
  });

  it('keeps cooccurrence as a reviewed candidate and gates assertions on identities and aligned evidence', async () => {
    const { store, paragraphs, identities } = await setupRelationshipProject();
    try {
      const service = new RelationshipService(store);
      const candidate = service.createCandidate({
        sourceIdentityId: identities.lu,
        targetIdentityId: identities.lin,
        method: 'cooccurrence',
        proposedType: '同盟',
        confidence: 0.62,
        evidence: [{ paragraphId: paragraphs[1].id, exactQuote: '陆沉与林月结伴守城', role: 'clue' }],
      });
      expect(candidate).toMatchObject({ candidateMethod: 'cooccurrence', reviewStatus: 'pending', evidenceCount: 1 });
      expect(service.listRelationships()).toHaveLength(0);

      expect(() => service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '同盟', direction: 'reciprocal',
        strength: 0.8, polarity: 0.7, informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.91,
        extractionMethod: 'model', candidateId: candidate.id,
        evidence: [{ paragraphId: paragraphs[1].id, exactQuote: paragraphs[1].text, role: 'support' }],
      })).toThrow('人工确认');
      service.reviewCandidate(candidate.id, 'confirmed');

      expect(() => service.createCandidate({
        sourceIdentityId: identities.lu, targetIdentityId: identities.pending, method: 'rule', confidence: 0.5,
        evidence: [{ paragraphId: paragraphs[1].id, exactQuote: paragraphs[1].text, role: 'clue' }],
      })).toThrow('已确认的人物');
      expect(() => service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '宿敌', direction: 'directed',
        informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.9, extractionMethod: 'model',
        evidence: [{ paragraphId: paragraphs[1].id, exactQuote: '原文中不存在的关系证据', role: 'support' }],
      })).toThrow('无法对齐原文');

      const alliance = service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '同盟', direction: 'reciprocal',
        strength: 0.8, polarity: 0.7, informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.91,
        extractionMethod: 'model', candidateId: candidate.id, validFromEventId: 'event-alliance', validToEventId: 'event-alliance',
        evidence: [{ paragraphId: paragraphs[1].id, exactQuote: paragraphs[1].text, role: 'support' }],
      });
      expect(alliance).toMatchObject({ relationshipType: '同盟', reviewStatus: 'pending', firstRevealedOrdinal: paragraphs[1].ordinal });
      service.reviewRelationship(alliance.id, 'confirmed');
      expect(service.listEvidence(alliance.id)[0]).toMatchObject({ exactQuote: paragraphs[1].text, alignmentStatus: 'exact' });
      expect(() => service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '重复证据事务测试', direction: 'directed',
        informationSourceType: 'narrator', truthStatus: 'unknown', confidence: 0.5, extractionMethod: 'user',
        evidence: [
          { paragraphId: paragraphs[2].id, exactQuote: paragraphs[2].text, role: 'support' },
          { paragraphId: paragraphs[2].id, exactQuote: paragraphs[2].text, role: 'support' },
        ],
      })).toThrow();
      expect(service.listRelationships()).toHaveLength(1);

      const betrayal = service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '背叛', direction: 'directed',
        strength: 1, polarity: -1, informationSourceType: 'character', informationSourceIdentityId: identities.lu,
        truthStatus: 'rumor', confidence: 0.78, extractionMethod: 'model', supersedesRelationshipId: alliance.id,
        validFromEventId: 'event-argument', reasoningNote: '关系从争执后发生变化，但到下一段才首次揭示。',
        evidence: [{ paragraphId: paragraphs[3].id, exactQuote: '陆沉已经背叛林月', role: 'support' }],
      });
      service.reviewRelationship(betrayal.id, 'confirmed');
      expect(service.listAtEntry(paragraphs[1].ordinal).map((item) => item.relationshipType)).toEqual(['同盟']);
      expect(service.listAtEntry(paragraphs[2].ordinal)).toHaveLength(0);
      expect(service.listAtEntry(paragraphs[3].ordinal)[0]).toMatchObject({
        relationshipType: '背叛', truthStatus: 'rumor', supersedesRelationshipId: alliance.id,
      });
    } finally {
      await store.close();
    }
  });

  it('builds graph, history, conflicts and traversal from the same spoiler-bounded projection', async () => {
    const { store, paragraphs, identities } = await setupRelationshipProject();
    try {
      const service = new RelationshipService(store);
      const ally = service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '盟友', direction: 'directed',
        strength: 0.8, polarity: 0.8, informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.94,
        extractionMethod: 'user', validToEventId: 'event-argument', reasoningNote: '后文仍有补充证据。',
        evidence: [
          { paragraphId: paragraphs[1].id, exactQuote: paragraphs[1].text, role: 'support' },
          { paragraphId: paragraphs[3].id, exactQuote: paragraphs[3].text, role: 'context' },
        ],
      });
      const enemy = service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '敌对', direction: 'directed',
        strength: 0.7, polarity: -0.9, informationSourceType: 'character', informationSourceIdentityId: identities.hiddenSource,
        truthStatus: 'disputed', confidence: 0.81,
        extractionMethod: 'user', evidence: [{ paragraphId: paragraphs[1].id, exactQuote: paragraphs[1].text, role: 'support' }],
      });
      const future = service.createRelationship({
        sourceIdentityId: identities.lin, targetIdentityId: identities.lu, relationshipType: '暗中追查', direction: 'directed',
        strength: 0.6, polarity: -0.3, informationSourceType: 'unknown', truthStatus: 'suspected', confidence: 0.72,
        extractionMethod: 'user', evidence: [{ paragraphId: paragraphs[3].id, exactQuote: paragraphs[3].text, role: 'support' }],
      });
      service.reviewRelationship(ally.id, 'confirmed');
      service.reviewRelationship(enemy.id, 'confirmed');
      service.reviewRelationship(future.id, 'confirmed');

      const early = service.getGraphProjection(paragraphs[1].ordinal);
      expect(early.entryOrdinal).toBe(paragraphs[1].ordinal);
      expect(early.maximumOrdinal).toBe(paragraphs[3].ordinal);
      expect(early.edges.map((edge) => edge.relationshipType).sort()).toEqual(['敌对', '盟友']);
      expect(early.edges.every((edge) => edge.hasConflict)).toBe(true);
      expect(early.edges.find((edge) => edge.id === ally.id)?.validToOrdinal).toBeNull();
      expect(early.edges.find((edge) => edge.id === ally.id)?.reasoningNote).toBe('');
      expect(early.edges.find((edge) => edge.id === enemy.id)).toMatchObject({
        informationSourceType: 'unknown', informationSourceIdentityId: null, informationSourceName: null,
      });
      expect(early.history.map((edge) => edge.relationshipType).sort()).toEqual(['敌对', '盟友']);
      expect(early.evidence.every((item) => item.paragraphOrdinal <= paragraphs[1].ordinal)).toBe(true);
      expect(early.nodes.map((node) => node.name).sort()).toEqual(['林月', '陆沉']);
      expect(early.nodes.every((node) => node.degree === 2 && node.componentId === 1)).toBe(true);
      expect(early.revealedRelationshipCount).toBe(2);
      expect(early.temporallyInactiveRelationshipCount).toBe(0);

      const beforeReveal = service.getGraphProjection(paragraphs[2].ordinal);
      expect(beforeReveal.edges.some((edge) => edge.id === future.id)).toBe(false);
      expect(beforeReveal.history.some((edge) => edge.id === future.id)).toBe(false);
      expect(beforeReveal.edges.find((edge) => edge.id === ally.id)?.validToOrdinal).toBe(paragraphs[2].ordinal);

      const complete = service.getGraphProjection(99_999);
      expect(complete.entryOrdinal).toBe(paragraphs[3].ordinal);
      expect(complete.edges.some((edge) => edge.id === future.id)).toBe(true);
      expect(complete.history.some((edge) => edge.id === future.id)).toBe(true);
      expect(complete.history.find((edge) => edge.id === ally.id)?.reasoningNote).toBe('后文仍有补充证据。');
      expect(complete.revealedRelationshipCount).toBe(3);
      expect(complete.temporallyInactiveRelationshipCount).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('exports a versioned and reconstructable graph without future relationships, evidence or source names', async () => {
    const { store, paragraphs, identities } = await setupRelationshipProject();
    try {
      const service = new RelationshipService(store);
      const current = service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '共同守城', direction: 'reciprocal',
        strength: 0.9, polarity: 0.7, informationSourceType: 'character', informationSourceIdentityId: identities.hiddenSource,
        truthStatus: 'asserted', confidence: 0.93, extractionMethod: 'model', validToEventId: 'event-argument',
        reasoningNote: '后文说明未来知情者参与其中。', evidence: [
          { paragraphId: paragraphs[1].id, exactQuote: paragraphs[1].text, role: 'support' },
          { paragraphId: paragraphs[3].id, exactQuote: paragraphs[3].text, role: 'context' },
        ],
      });
      const future = service.createRelationship({
        sourceIdentityId: identities.lu, targetIdentityId: identities.lin, relationshipType: '最终决裂', direction: 'directed',
        strength: 1, polarity: -1, informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.96,
        extractionMethod: 'model', evidence: [{ paragraphId: paragraphs[3].id, exactQuote: paragraphs[3].text, role: 'support' }],
      });
      service.reviewRelationship(current.id, 'confirmed');
      service.reviewRelationship(future.id, 'confirmed');
      const outputPath = path.join(path.dirname(store.get().rootPath), 'character_graph.json');
      const exporter = new RelationshipGraphExportService(store);
      const firstBuild = exporter.build(paragraphs[1].ordinal);
      const secondBuild = exporter.build(paragraphs[1].ordinal);
      expect(firstBuild.extensions.novel_world_compiler.source_fingerprint)
        .toBe(secondBuild.extensions.novel_world_compiler.source_fingerprint);

      const result = await exporter.export(paragraphs[1].ordinal, outputPath);
      const serialized = await fs.readFile(outputPath, 'utf8');
      const graph = characterGraphExportSchema.parse(JSON.parse(serialized));
      expect(result.checksum).toBe(createHash('sha256').update(serialized).digest('hex'));
      expect(graph).toMatchObject({
        format: 'novel-world-character-graph', spec_version: '1.0', schema_version: SCHEMA_VERSION,
        fence: { entry_ordinal: paragraphs[1].ordinal, maximum_ordinal: paragraphs[3].ordinal },
      });
      expect(graph.relationships).toHaveLength(1);
      expect(graph.relationships[0]).toMatchObject({
        id: current.id, active_at_entry: true, reasoning_note: '',
        information_source: { type: 'unknown', identity_id: null, name: null },
        validity: { to_event_id: null, to_ordinal: null },
      });
      expect(graph.evidence).toHaveLength(1);
      expect(graph.evidence[0]).toMatchObject({ relationship_id: current.id, paragraph_ordinal: paragraphs[1].ordinal });
      expect(graph.communities[0]).toMatchObject({
        relationship_ids: [current.id], source_relationship_ids: [current.id],
        source_evidence_ids: [graph.evidence[0].id],
      });
      expect(graph.communities[0].summary).toContain('陆沉与林月：共同守城');
      expect(serialized).not.toContain('未来知情者');
      expect(serialized).not.toContain('最终决裂');
      expect(serialized).not.toContain('后文说明');
      expect((await fs.readdir(path.dirname(outputPath))).some((name) => name.includes('character_graph.json.') && name.endsWith('.tmp'))).toBe(false);

      const worldInfoPath = path.join(path.dirname(store.get().rootPath), 'relationships_world_info.json');
      const worldInfoResult = await exporter.exportWorldInfo(paragraphs[1].ordinal, worldInfoPath);
      const worldInfoSerialized = await fs.readFile(worldInfoPath, 'utf8');
      const worldInfo = sillyTavernWorldInfoExportSchema.parse(JSON.parse(worldInfoSerialized));
      expect(worldInfoResult.checksum).toBe(createHash('sha256').update(worldInfoSerialized).digest('hex'));
      expect(worldInfo.extensions.novel_world_compiler).toMatchObject({
        character_graph_spec_version: '1.0', schema_version: SCHEMA_VERSION, entry_ordinal: paragraphs[1].ordinal,
        graph_source_fingerprint: graph.extensions.novel_world_compiler.source_fingerprint,
      });
      const entries = Object.values(worldInfo.entries);
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.matchWholeWords === false && entry.caseSensitive === false)).toBe(true);
      expect(entries.find((entry) => entry.extensions.novel_world_compiler.entry_kind === 'relationship')).toMatchObject({
        key: expect.arrayContaining(['陆沉', '林月', '共同守城']),
        extensions: { novel_world_compiler: { source_relationship_ids: [current.id], source_evidence_ids: [graph.evidence[0].id] } },
      });
      expect(worldInfoSerialized).not.toContain('未来知情者');
      expect(worldInfoSerialized).not.toContain('最终决裂');
      expect(worldInfoSerialized).not.toContain('后文说明');
      for (const [status, label] of [['rumor', '传闻'], ['false', '已否定'], ['disputed', '有争议'], ['suspected', '疑似'], ['unknown', '未知']] as const) {
        store.get().db.prepare('UPDATE character_relationships SET truth_status = ? WHERE id = ?').run(status, current.id);
        const qualified = Object.values(exporter.buildWorldInfo(paragraphs[1].ordinal).entries);
        expect(qualified.find((entry) => entry.extensions.novel_world_compiler.entry_kind === 'community')?.content).toContain(label);
        expect(qualified.find((entry) => entry.extensions.novel_world_compiler.entry_kind === 'relationship')?.content).toContain(label);
        expect(JSON.stringify(qualified)).not.toContain('最终决裂');
      }
    } finally {
      await store.close();
    }
  });
});
