import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { CharacterService } from '../../electron/worker/character-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';
import { FactConsolidationService } from '../../electron/worker/fact-consolidation-service';
import type { CharacterFactOutput, CharacterScanOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

describe('phase 1C local fact consolidation', () => {
  it('groups exact facts, proposes temporal/source relations and creates reviewed state transitions', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-fact-consolidation-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '事实整理.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 行踪',
      '陆沉站在青石镇城门外。',
      '陆沉随后走进客栈。',
      '坊间传言陆沉已经死了。',
      '旁白说明陆沉仍然活着。',
    ].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('事实整理', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const paragraphs = editor.listParagraphs();
      const gate = paragraphs.find((paragraph) => paragraph.text.includes('城门外'))!;
      const inn = paragraphs.find((paragraph) => paragraph.text.includes('走进客栈'))!;
      const rumor = paragraphs.find((paragraph) => paragraph.text.includes('坊间传言'))!;
      const alive = paragraphs.find((paragraph) => paragraph.text.includes('仍然活着'))!;
      const characters = new CharacterService(store);
      const scan = characters.createScan('test-model', 'character_scan.v1');
      const work = characters.nextChunk(scan.jobId)!;
      const scanOutput: CharacterScanOutput = {
        characters: [{
          local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }], entity_kind: 'human',
          role_hints: [], has_dialogue: false, participates_in_event: true, confidence: 0.99, uncertainty: '',
          evidence: [
            { paragraph_id: gate.id, exact_quote: gate.text, supports: 'event' },
            { paragraph_id: inn.id, exact_quote: inn.text, supports: 'event' },
            { paragraph_id: rumor.id, exact_quote: rumor.text, supports: 'event' },
            { paragraph_id: alive.id, exact_quote: alive.text, supports: 'event' },
          ],
        }], identity_claims: [],
      };
      characters.ingest(scan.jobId, work.chunkId, scanOutput, JSON.stringify(scanOutput), 60, 20);
      characters.nextChunk(scan.jobId);
      const identity = characters.listCharacters().find((character) => character.canonicalName === '陆沉')!;
      characters.review(identity.id, { status: 'confirmed' });
      const facts = new CharacterFactService(store);
      const run = facts.createRun(identity.id, 'test-model', 'character_facts.v2');
      const batch = facts.nextBatch(run.jobId)!;
      const output: CharacterFactOutput = { facts: [
        {
          category: 'status', predicate: '所在地点', value: '青石镇城门外', source_type: 'explicit', assertion_mode: 'narrator_assertion', truth_status: 'asserted',
          confidence: 0.99, visibility: 'public', valid_from_paragraph_id: gate.id, valid_to_paragraph_id: gate.id,
          evidence: [{ paragraph_id: gate.id, exact_quote: gate.text, role: 'support' }], reasoning_note: '',
        },
        {
          category: 'status', predicate: '所在地点', value: '客栈', source_type: 'explicit', assertion_mode: 'narrator_assertion', truth_status: 'asserted',
          confidence: 0.99, visibility: 'public', valid_from_paragraph_id: inn.id, valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: inn.id, exact_quote: inn.text, role: 'support' }], reasoning_note: '',
        },
        {
          category: 'status', predicate: '所在地点', value: '客栈', source_type: 'inferred', assertion_mode: 'behavior_inference', truth_status: 'asserted',
          confidence: 0.8, visibility: 'public', valid_from_paragraph_id: inn.id, valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: inn.id, exact_quote: inn.text, role: 'support' }], reasoning_note: '根据进入客栈的动作推断',
        },
        {
          category: 'status', predicate: '生死状态', value: '已经死亡', source_type: 'explicit', assertion_mode: 'rumor', truth_status: 'suspected', attributed_source_name: '坊间传言',
          confidence: 0.65, visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: rumor.id, exact_quote: rumor.text, role: 'support' }], reasoning_note: '仅为传闻',
        },
        {
          category: 'status', predicate: '生死状态', value: '仍然活着', source_type: 'explicit', assertion_mode: 'narrator_assertion', truth_status: 'asserted',
          confidence: 0.99, visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: alive.id, exact_quote: alive.text, role: 'support' }], reasoning_note: '',
        },
      ] };
      facts.ingest(run.jobId, batch.batchOrdinal, output, JSON.stringify(output), 120, 70);
      facts.nextBatch(run.jobId);

      const consolidation = new FactConsolidationService(store);
      expect(consolidation.consolidate()).toEqual({ clusterCount: 4, memberCount: 5, pendingRelationCount: 2, transitionCount: 0 });
      expect(consolidation.consolidate()).toEqual({ clusterCount: 4, memberCount: 5, pendingRelationCount: 2, transitionCount: 0 });
      const clusters = consolidation.listClusters(identity.id);
      const innCluster = clusters.find((cluster) => cluster.canonicalValue === '客栈')!;
      expect(innCluster.memberCount).toBe(2);
      expect(consolidation.listClusterMembers(innCluster.id)).toHaveLength(2);
      let relations = consolidation.listRelations(identity.id);
      expect(relations).toHaveLength(2);
      expect(relations.find((relation) => relation.predicate === '所在地点')?.proposedRelation).toBe('coexists_by_time');
      expect(relations.find((relation) => relation.predicate === '生死状态')?.proposedRelation).toBe('rumor_correction');
      const location = relations.find((relation) => relation.predicate === '所在地点')!;
      relations = consolidation.reviewRelation(location.id, 'confirmed', 'state_change');
      expect(relations.find((relation) => relation.id === location.id)).toMatchObject({ reviewStatus: 'confirmed', resolvedRelation: 'state_change' });
      expect(consolidation.listTransitions(identity.id)[0]).toMatchObject({
        predicate: '所在地点', fromValue: '青石镇城门外', toValue: '客栈', observedFromOrdinal: gate.ordinal, observedToOrdinal: inn.ordinal,
      });
      consolidation.reviewRelation(location.id, 'pending');
      expect(consolidation.listTransitions(identity.id)).toHaveLength(0);
      const life = relations.find((relation) => relation.predicate === '生死状态')!;
      consolidation.reviewRelation(life.id, 'confirmed');
      expect(consolidation.listRelations(identity.id).find((relation) => relation.id === life.id)).toMatchObject({ resolvedRelation: 'rumor_correction' });
    } finally {
      await store.close();
    }
  });
});
