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
  it('upgrades a completed medium analysis to high with only missing and selected review paragraphs', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-fact-upgrade-'));
    cleanupPaths.push(tempRoot);
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, ['第一章 青石镇', '陆沉是青石镇的年轻捕快，与林烟是朋友。',
      ...Array.from({ length: 20 }, (_, index) => [
        `陆沉在青石镇巡查第${index + 1}条街道。${'他沿街核对门牌和巡夜记录。'.repeat(12)}`,
        `这一天的街道旁有一段未直接提到人物的环境说明，第${index + 1}处。`,
      ]).flat()].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('增量档位', path.join(tempRoot, '增量档位.novelworld'));
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 5000, softLimit: 6000, hardLimit: 7000, overlapBefore: 0, overlapAfter: 0 });
      const first = editor.listParagraphs().find(item => item.text.includes('年轻捕快'))!;
      const characters = new CharacterService(store);
      const scan = characters.createScan('test-model', 'character_scan.v1');
      const scanWork = characters.nextChunk(scan.jobId)!;
      const scanOutput: CharacterScanOutput = { characters: [{
        local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }],
        entity_kind: 'human', role_hints: [], has_dialogue: false, participates_in_event: true,
        evidence: [{ paragraph_id: first.id, exact_quote: first.text, supports: 'identity' }],
        confidence: 0.99, uncertainty: '',
      }], identity_claims: [] };
      characters.ingest(scan.jobId, scanWork.chunkId, scanOutput, JSON.stringify(scanOutput), 10, 10);
      characters.nextChunk(scan.jobId);
      const identity = characters.listCharacters()[0];
      characters.review(identity.id, { status: 'confirmed' });
      const facts = new CharacterFactService(store);
      const fullHigh = facts.createRun(identity.id, 'test-model', 'character_facts.v3.high', 2);
      const fullWork = facts.nextBatch(fullHigh.jobId)!;
      const low = facts.createRun(identity.id, 'test-model', 'character_facts.v3.low');
      const lowWork = facts.nextBatch(low.jobId)!;
      const supported = (category: CharacterFactOutput['facts'][number]['category'], predicate: string, value: string) => ({
        category, predicate, value, source_type: 'explicit' as const, confidence: 0.99,
        visibility: 'public' as const, valid_from_paragraph_id: null, valid_to_paragraph_id: null,
        evidence: [{ paragraph_id: first.id, exact_quote: first.text, role: 'support' as const }], reasoning_note: '',
      });
      const output: CharacterFactOutput = { facts: [supported('identity', '职业', '青石镇捕快'),
        supported('status', '年龄描述', '年轻'), supported('relationship', '朋友', '林烟')] };
      facts.ingest(low.jobId, lowWork.batchOrdinal, output, JSON.stringify(output), 100, 30);
      expect(facts.nextBatch(low.jobId)).toBeNull();
      const reviewed = facts.listFacts(identity.id)[0];
      facts.reviewFact(reviewed.id, 'confirmed');
      const medium = facts.createRun(identity.id, 'test-model', 'character_facts.v3.medium');
      if (medium.jobId !== low.jobId) {
        for (let work = facts.nextBatch(medium.jobId); work; work = facts.nextBatch(medium.jobId)) {
          facts.ingest(medium.jobId, work.batchOrdinal, { facts: [] }, '{"facts":[]}', 10, 2);
        }
      }
      const upgradedHigh = facts.createRun(identity.id, 'test-model', 'character_facts.v3.high', 2);
      expect(upgradedHigh.jobId).not.toBe(fullHigh.jobId);
      const upgradeWork = facts.nextBatch(upgradedHigh.jobId)!;
      expect(upgradeWork.extractionPasses).toBe(2);
      expect(upgradeWork.paragraphs.length).toBeLessThan(fullWork.paragraphs.length);
      expect(facts.listFacts(identity.id).find(item => item.id === reviewed.id)?.reviewStatus).toBe('confirmed');
    } finally { await store.close(); }
  });

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
      const lowRun = factService.createRun(identity.id, 'test-model', 'character_facts.v3.low');
      const highRun = factService.createRun(identity.id, 'test-model', 'character_facts.v3.high', 2);
      const lowMaterial = factService.nextBatch(lowRun.jobId)!;
      const highMaterial = factService.nextBatch(highRun.jobId)!;
      expect(lowMaterial.paragraphs.length).toBeLessThan(highMaterial.paragraphs.length);
      expect(highMaterial.extractionPasses).toBe(2);
      expect(lowRun.jobId).not.toBe(highRun.jobId);
      factService.ingest(lowRun.jobId, lowMaterial.batchOrdinal, { facts: [] }, '{"facts":[]}', 50, 5);
      expect(factService.nextBatch(lowRun.jobId)).toBeNull();
      const mediumRun = factService.createRun(identity.id, 'test-model', 'character_facts.v3.medium');
      if (mediumRun.jobId !== lowRun.jobId) {
        const mediumMaterial = factService.nextBatch(mediumRun.jobId)!;
        expect(mediumMaterial.paragraphs.map((paragraph) => paragraph.paragraphId))
          .not.toContain(lowMaterial.paragraphs[0].paragraphId);
      } else {
        expect(mediumRun).toMatchObject({ state: 'completed', reused: true });
      }
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
