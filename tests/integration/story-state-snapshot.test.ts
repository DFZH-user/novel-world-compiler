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
import { StoryStateService } from '../../electron/worker/story-state-service';
import { CharacterCardService } from '../../electron/worker/character-card-service';
import { SCHEMA_VERSION } from '../../electron/worker/schema';
import type { CharacterFactOutput, CharacterScanOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

describe('phase 1C entry-time character state snapshot', () => {
  it('uses reviewed facts and temporal paths without guessing across disconnected events', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-story-state-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '进入状态.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 行踪',
      '陆沉作为巡夜人站在青石镇城门外。',
      '陆沉随后走进客栈。',
      '林月在远山中等待。',
    ].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('进入状态', projectRoot);
      const imported = await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const paragraphs = editor.listParagraphs();
      const gate = paragraphs.find((paragraph) => paragraph.text.includes('城门外'))!;
      const inn = paragraphs.find((paragraph) => paragraph.text.includes('走进客栈'))!;
      const mountain = paragraphs.find((paragraph) => paragraph.text.includes('远山'))!;

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
          ],
        }],
        identity_claims: [],
      };
      characters.ingest(scan.jobId, work.chunkId, scanOutput, JSON.stringify(scanOutput), 50, 20);
      characters.nextChunk(scan.jobId);
      const identity = characters.listCharacters().find((character) => character.canonicalName === '陆沉')!;
      characters.review(identity.id, { status: 'confirmed', importanceTier: 'core' });

      const factService = new CharacterFactService(store);
      const factRun = factService.createRun(identity.id, 'test-model', 'character_facts.v2');
      const batch = factService.nextBatch(factRun.jobId)!;
      const factOutput: CharacterFactOutput = { facts: [
        {
          category: 'identity', predicate: '身份', value: '巡夜人', source_type: 'explicit', assertion_mode: 'narrator_assertion', truth_status: 'asserted',
          confidence: 0.99, visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: gate.id, exact_quote: gate.text, role: 'support' }], reasoning_note: '',
        },
        {
          category: 'status', predicate: '所在地点', value: '青石镇城门外', source_type: 'explicit', assertion_mode: 'narrator_assertion', truth_status: 'asserted',
          confidence: 0.99, visibility: 'public', valid_from_paragraph_id: gate.id, valid_to_paragraph_id: gate.id,
          evidence: [{ paragraph_id: gate.id, exact_quote: gate.text, role: 'support' }], reasoning_note: '',
        },
        {
          category: 'status', predicate: '所在地点', value: '客栈', source_type: 'explicit', assertion_mode: 'narrator_assertion', truth_status: 'asserted',
          confidence: 0.99, visibility: 'private', valid_from_paragraph_id: inn.id, valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: inn.id, exact_quote: inn.text, role: 'support' }], reasoning_note: '',
        },
        {
          category: 'background', predicate: '真实来历', value: '失踪皇子', source_type: 'explicit', assertion_mode: 'rumor', truth_status: 'suspected',
          attributed_source_name: '坊间传言', confidence: 0.8, visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
          evidence: [{ paragraph_id: mountain.id, exact_quote: mountain.text, role: 'support' }], reasoning_note: '只确认小说中存在这则传闻，不代表传闻为真',
        },
      ] };
      factService.ingest(factRun.jobId, batch.batchOrdinal, factOutput, JSON.stringify(factOutput), 80, 40);
      factService.nextBatch(factRun.jobId);
      for (const fact of factService.listFacts(identity.id)) factService.reviewFact(fact.id, 'confirmed');

      const consolidation = new FactConsolidationService(store);
      consolidation.consolidate();
      const locationRelation = consolidation.listRelations(identity.id).find((relation) => relation.predicate === '所在地点')!;
      consolidation.reviewRelation(locationRelation.id, 'confirmed', 'state_change');

      const { db } = store.get();
      const timestamp = new Date().toISOString();
      const quoteTexts = ['开篇用语。', '前期语气。', '中段语气。', '后期语气。', '结尾用语。'];
      const quoteParagraphIds = [gate.id, gate.id, inn.id, inn.id, mountain.id];
      const insertQuote = db.prepare(`INSERT INTO character_quotes
        (id, revision_id, paragraph_id, start_offset, end_offset, quote_text, quote_type, detection_method, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'curly_double', 'user', ?)`);
      const insertAttribution = db.prepare(`INSERT INTO character_quote_attributions
        (id, quote_id, identity_id, role, method, confidence, review_status, evidence_paragraph_id, evidence_text, reasoning, created_at, updated_at)
        VALUES (?, ?, ?, 'speaker', 'user', 1, 'confirmed', ?, '', '测试确认说话人', ?, ?)`);
      quoteTexts.forEach((text, index) => {
        const quoteId = `quote-${index + 1}`;
        const startOffset = index * 10;
        insertQuote.run(quoteId, imported.revisionId, quoteParagraphIds[index], startOffset, startOffset + text.length, text, timestamp);
        insertAttribution.run(`attribution-${index + 1}`, quoteId, identity.id, quoteParagraphIds[index], timestamp, timestamp);
      });
      const insertEvent = db.prepare(`INSERT INTO timeline_events
        (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal, extraction_method,
         confidence, review_status, uncertainty, created_at, updated_at)
        VALUES (?, ?, ?, '', 'movement', ?, ?, 'model', 0.95, ?, '', ?, ?)`);
      insertEvent.run('event-before', imported.revisionId, '陆沉尚在城门外', gate.ordinal, gate.ordinal, 'confirmed', timestamp, timestamp);
      insertEvent.run('event-change', imported.revisionId, '陆沉进入客栈', inn.ordinal, inn.ordinal, 'confirmed', timestamp, timestamp);
      insertEvent.run('event-unrelated', imported.revisionId, '林月在远山等待', mountain.ordinal, mountain.ordinal, 'confirmed', timestamp, timestamp);
      insertEvent.run('event-pending', imported.revisionId, '尚未确认的事件', mountain.ordinal, mountain.ordinal, 'pending', timestamp, timestamp);
      db.prepare(`INSERT INTO timeline_event_evidence
        (id, event_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
        VALUES ('evidence-change', 'event-change', ?, ?, 'support', 'exact', ?)`)
        .run(inn.id, inn.text, timestamp);
      db.prepare(`INSERT INTO timeline_event_relations
        (id, revision_id, left_event_id, right_event_id, relation, source_type, confidence, reason, review_status, created_at, updated_at)
        VALUES ('relation-before-change', ?, 'event-before', 'event-change', 'before', 'user', 1, '测试确认关系', 'confirmed', ?, ?)`)
        .run(imported.revisionId, timestamp, timestamp);
      db.prepare(`INSERT INTO timeline_event_relation_decisions (relation_id, resolved_relation, reviewed_at)
        VALUES ('relation-before-change', 'before', ?)`)
        .run(timestamp);

      const service = new StoryStateService(store);
      const before = service.snapshot('event-before');
      const beforeCharacter = before.characters.find((character) => character.identityId === identity.id)!;
      expect(beforeCharacter.values.find((value) => value.predicate === '身份')).toMatchObject({ value: '巡夜人', resolution: 'timeless' });
      expect(beforeCharacter.values.find((value) => value.predicate === '所在地点')).toMatchObject({
        value: '青石镇城门外', resolution: 'effective_before_transition', triggerEventId: 'event-change',
      });

      const after = service.snapshot('event-change', identity.id);
      expect(after.characters).toHaveLength(1);
      expect(after.characters[0].values.some((value) => value.predicate === '真实来历')).toBe(false);
      expect(after.characters[0].values.find((value) => value.predicate === '所在地点')).toMatchObject({
        value: '客栈', resolution: 'effective_after_transition', visibility: 'private',
      });

      const disconnected = service.snapshot('event-unrelated');
      expect(disconnected.characters[0].values.find((value) => value.predicate === '所在地点')).toMatchObject({
        value: null, resolution: 'ambiguous', alternatives: expect.arrayContaining(['青石镇城门外', '客栈']),
      });
      expect(disconnected.ambiguousValueCount).toBe(1);
      expect(() => service.snapshot('event-pending')).toThrow('请先确认进入事件');

      // The editorial snapshot above keeps private facts. Publish the location
      // explicitly for the export happy path; private projection has its own tests.
      db.prepare(`UPDATE character_facts SET visibility = 'public' WHERE identity_id = ? AND value = '客栈'`).run(identity.id);

      const cards = new CharacterCardService(store);
      const draft = cards.generate(identity.id, 'event-change');
      expect(draft).toMatchObject({
        identityName: '陆沉', entryEventTitle: '陆沉进入客栈', reviewStatus: 'draft',
        sourceSummary: { confirmedFactCount: 3, resolvedStateCount: 2, ambiguousStateCount: 0, quoteSampleCount: 3 },
      });
      expect(draft.description).toContain('所在地点：客栈');
      expect(draft.scenario).toContain('陆沉进入客栈');
      expect(draft.mesExample).toContain('开篇用语。');
      expect(draft.mesExample).toContain('中段语气。');
      expect(draft.mesExample).toContain('后期语气。');
      expect(draft.mesExample).not.toContain('结尾用语。');
      expect(draft.mesExample).not.toContain('前期语气。');
      const reviewed = cards.save(identity.id, {
        description: draft.description, personality: draft.personality, scenario: draft.scenario,
        firstMes: '*陆沉抬眼看向来客。*', mesExample: draft.mesExample, creatorNotes: draft.creatorNotes,
        systemPrompt: draft.systemPrompt, postHistoryInstructions: draft.postHistoryInstructions,
        alternateGreetings: draft.alternateGreetings, tags: draft.tags, creator: draft.creator,
        characterVersion: '1.0',
      }, 'reviewed');
      expect(reviewed).toMatchObject({ reviewStatus: 'reviewed', firstMes: '*陆沉抬眼看向来客。*' });
      const outputPath = path.join(tempRoot, '陆沉-角色卡-v2.json');
      const exported = await cards.exportJson(identity.id, outputPath);
      expect(exported.checksum).toMatch(/^[a-f0-9]{64}$/u);
      const card = JSON.parse(await fs.readFile(outputPath, 'utf8')) as typeof exported.card;
      expect(card).toMatchObject({
        spec: 'chara_card_v2', spec_version: '2.0',
        data: { name: '陆沉', first_mes: '*陆沉抬眼看向来客。*', system_prompt: '' },
      });
      expect(card.data.extensions.novel_world_compiler).toMatchObject({ identity_id: identity.id, entry_event_id: 'event-change' });
      expect(card.data.extensions.novel_world_compiler).toMatchObject({ schema_version: SCHEMA_VERSION });

      const refinementWork = cards.prepareRefinement(identity.id, 'test-refine-model', 'character_card_refine.v1');
      expect(refinementWork.sources.some((source) => source.key.startsWith('fact:'))).toBe(true);
      expect(refinementWork.sources.some((source) => source.content === '失踪皇子')).toBe(false);
      expect(refinementWork.sources.filter((source) => source.kind === 'quote')).toHaveLength(4);
      expect(refinementWork.sources.some((source) => source.key === 'draft:firstMes')).toBe(true);
      const refinementOutput = {
        fields: {
          description: { text: `${reviewed.description}\n润色但不新增事实。`, source_keys: ['draft:description'] },
          personality: { text: reviewed.personality, source_keys: ['draft:personality'] },
          scenario: { text: reviewed.scenario, source_keys: ['draft:scenario', 'entry:event-change'] },
          first_mes: { text: '*陆沉在客栈中抬眼看向来客。*', source_keys: ['draft:firstMes', 'entry:event-change'] },
          mes_example: { text: reviewed.mesExample, source_keys: ['draft:mesExample'] },
        },
        change_summary: ['调整开场白措辞'], warnings: [],
      };
      expect(() => cards.ingestRefinement(identity.id, 'test-refine-model', 'character_card_refine.v1', {
        ...refinementOutput,
        fields: { ...refinementOutput.fields, first_mes: { ...refinementOutput.fields.first_mes, source_keys: ['fact:not-found'] } },
      }, '{}', 10, 10)).toThrow('不存在的来源键');
      const refinement = cards.ingestRefinement(identity.id, 'test-refine-model', 'character_card_refine.v1', refinementOutput, '{}', 120, 60);
      expect(refinement).toMatchObject({ status: 'pending', model: 'test-refine-model', inputTokens: 120, outputTokens: 60 });
      const applied = cards.reviewRefinement(refinement.id, 'apply', ['description', 'firstMes']);
      expect(applied.refinement).toMatchObject({ status: 'applied', appliedFields: ['description', 'firstMes'] });
      expect(applied.draft).toMatchObject({ reviewStatus: 'draft', firstMes: '*陆沉在客栈中抬眼看向来客。*' });
      await expect(cards.exportJson(identity.id, path.join(tempRoot, '未审阅.json'))).rejects.toThrow('标记角色卡为已审阅');
      cards.save(identity.id, {
        description: applied.draft.description, personality: '沉着谨慎，言语简短。', scenario: applied.draft.scenario,
        firstMes: applied.draft.firstMes, mesExample: '<START>\n{{char}}: 今夜城门由我值守。', creatorNotes: applied.draft.creatorNotes,
        systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [], tags: applied.draft.tags,
        creator: applied.draft.creator, characterVersion: '1.0',
      }, 'reviewed');
      const batchStatus = cards.batchStatus();
      expect(batchStatus).toHaveLength(1);
      expect(batchStatus[0]).toMatchObject({ identityName: '陆沉', confirmedFactCount: 3, reviewStatus: 'reviewed', exportReady: true, quality: { grade: 'B', contentReady: true } });
      expect(cards.generateMissing('event-change')).toMatchObject({ targetCount: 1, generatedCount: 0, skippedCount: 1, failedCount: 0 });
      const batchDirectory = path.join(tempRoot, '批量角色卡');
      const firstBatch = await cards.exportReviewed(batchDirectory);
      const secondBatch = await cards.exportReviewed(batchDirectory);
      expect(firstBatch.files[0].outputPath).toMatch(/陆沉-角色卡-v2\.json$/u);
      expect(secondBatch.files[0].outputPath).toMatch(/陆沉-角色卡-v2-2\.json$/u);
    } finally {
      await store.close();
    }
  });
});
