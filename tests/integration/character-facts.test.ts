import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { CharacterService } from '../../electron/worker/character-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';
import { backfillSourceSpans } from '../../electron/worker/source-span-service';
import type { CharacterFactOutput, CharacterScanOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

describe('phase 1B character fact extraction', () => {
  it('collects character material, rejects invented evidence and reviews explicit and inferred facts', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-character-facts-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '人物档案.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 客栈',
      '陆沉是青石镇的年轻捕快。',
      '暴雨中，他把唯一的蓑衣递给受伤的孩子。',
      '“先救人，案子以后再查。”陆沉说道。',
    ].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('人物档案', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const paragraphs = editor.listParagraphs();
      const identityParagraph = paragraphs.find((paragraph) => paragraph.text.includes('年轻捕快'))!;
      const actionParagraph = paragraphs.find((paragraph) => paragraph.text.includes('蓑衣'))!;
      const characterService = new CharacterService(store);
      const scan = characterService.createScan('test-model', 'character_scan.v1');
      const scanWork = characterService.nextChunk(scan.jobId)!;
      const scanOutput: CharacterScanOutput = {
        characters: [{
          local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }], entity_kind: 'human',
          role_hints: [], has_dialogue: true, participates_in_event: true, confidence: 0.99, uncertainty: '',
          evidence: [
            { paragraph_id: identityParagraph.id, exact_quote: identityParagraph.text, supports: 'identity' },
            { paragraph_id: actionParagraph.id, exact_quote: actionParagraph.text, supports: 'event' },
          ],
        }, {
          local_key: 'child', display_name: '受伤的孩子', mention_forms: [{ text: '受伤的孩子', kind: 'role' }], entity_kind: 'human',
          role_hints: [], has_dialogue: false, participates_in_event: true, confidence: 0.9, uncertainty: '',
          evidence: [{ paragraph_id: actionParagraph.id, exact_quote: actionParagraph.text, supports: 'event' }],
        }], identity_claims: [],
      };
      characterService.ingest(scan.jobId, scanWork.chunkId, scanOutput, JSON.stringify(scanOutput), 80, 30);
      characterService.nextChunk(scan.jobId);
      const identity = characterService.listCharacters().find((person) => person.canonicalName === '陆沉')!;
      const child = characterService.listCharacters().find((person) => person.canonicalName === '受伤的孩子')!;
      expect(() => new CharacterFactService(store).createRun(identity.id, 'test-model', 'character_facts.v1')).toThrow(/确认人物/);
      characterService.review(identity.id, { status: 'confirmed' });

      const factService = new CharacterFactService(store);
      const estimate = factService.estimate(identity.id);
      expect(estimate).toMatchObject({ ready: true, batchCount: 1 });
      expect(estimate.paragraphCount).toBeGreaterThanOrEqual(3);
      const started = factService.createRun(identity.id, 'test-model', 'character_facts.v2', 2);
      const work = factService.nextBatch(started.jobId)!;
      expect(work.extractionPasses).toBe(2);
      const factOutput: CharacterFactOutput = {
        facts: [
          {
            category: 'identity', predicate: '职业', value: '青石镇捕快', source_type: 'explicit', confidence: 0.99,
            assertion_mode: 'self_report', truth_status: 'suspected', attributed_source_name: '陆沉', extraction_pass: 1,
            visibility: 'public', valid_from_paragraph_id: identityParagraph.id, valid_to_paragraph_id: null,
            evidence: [{ paragraph_id: identityParagraph.id, exact_quote: '陆沉是青石镇的年轻捕快。', role: 'support' }], reasoning_note: '',
          },
          {
            category: 'personality', predicate: '行为倾向', value: '危急时优先保护弱者', source_type: 'inferred', confidence: 0.88,
            visibility: 'private', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
            evidence: [{ paragraph_id: actionParagraph.id, exact_quote: actionParagraph.text, role: 'support' }], reasoning_note: '根据主动让出唯一蓑衣的行为推断',
          },
          {
            category: 'ability', predicate: '武功', value: '天下第一', source_type: 'explicit', confidence: 1,
            visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
            evidence: [{ paragraph_id: identityParagraph.id, exact_quote: '原文中不存在的证据', role: 'support' }], reasoning_note: '',
          },
        ],
      };
      factService.ingest(started.jobId, work.batchOrdinal, factOutput, JSON.stringify(factOutput), 120, 70);
      expect(factService.nextBatch(started.jobId)).toBeNull();
      let facts = factService.listFacts(identity.id);
      expect(facts).toHaveLength(2);
      expect(facts.map((fact) => fact.sourceType).sort()).toEqual(['explicit', 'inferred']);
      expect(facts.find((fact) => fact.predicate === '职业')).toMatchObject({
        assertionMode: 'self_report', truthStatus: 'suspected', attributedSourceName: '陆沉', extractionPass: 1,
      });
      expect(facts.find((fact) => fact.predicate === '行为倾向')).toMatchObject({
        assertionMode: 'behavior_inference', truthStatus: 'asserted', extractionPass: 1,
      });
      backfillSourceSpans(store.get().db);
      expect(factService.listEvidence(facts[0].id)).toEqual([
        expect.objectContaining({ sourceSpanId: expect.any(String), alignmentStatus: 'exact' }),
      ]);
      facts = factService.reviewFact(facts[0].id, 'confirmed');
      expect(facts.find((fact) => fact.id === facts[0].id)?.reviewStatus).toBe('confirmed');
      expect(factService.createRun(identity.id, 'test-model', 'character_facts.v2', 2)).toMatchObject({ reused: true, state: 'completed' });
      characterService.merge(identity.id, child.id);
      expect(factService.listFacts(child.id)).toHaveLength(2);
      characterService.undoLatest();
      expect(factService.listFacts(identity.id)).toHaveLength(2);
    } finally {
      await store.close();
    }
  });
});
