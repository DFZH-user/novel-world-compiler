import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { CharacterService } from '../../electron/worker/character-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';
import { CharacterCardService } from '../../electron/worker/character-card-service';
import { FactConsolidationService } from '../../electron/worker/fact-consolidation-service';
import { StoryStateService } from '../../electron/worker/story-state-service';
import type { CharacterFactOutput, CharacterScanOutput } from '../../src/shared/contracts';

describe('character card narrative boundary', () => {
  let store: ProjectStore;
  let root: string;
  let identityId: string;
  let cards: CharacterCardService;
  let revisionId: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-card-boundary-'));
    store = new ProjectStore();
    const source = path.join(root, 'source.txt');
    await fs.writeFile(source, [
      '第一章 城门',
      '陆沉是巡夜人，站在城门。他说：“今夜风凉。”',
      '林月的私密住址是松林暗室；陆沉并不知道。',
      '陆沉走向值房，这是故事的进入点。',
      '第二章 真相',
      '陆沉终于公开自己是失踪皇子。他说：“本座正是最终的新帝！”',
      '往事：陆沉幼时已继承苍龙印，早于城门值守。',
    ].join('\n'), 'utf8');
    await store.create('边界回归', path.join(root, 'test.novelworld'));
    const imported = await new Importer(store).run(source, 'utf8');
    revisionId = imported.revisionId;
    const editor = new EditorService(store);
    editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
    const paragraphs = editor.listParagraphs();
    const early = paragraphs.find((p) => p.text.includes('今夜风凉'))!;
    const secret = paragraphs.find((p) => p.text.includes('松林暗室'))!;
    const entry = paragraphs.find((p) => p.text.includes('进入点'))!;
    const late = paragraphs.find((p) => p.text.includes('最终的新帝'))!;
    const flashback = paragraphs.find((p) => p.text.includes('苍龙印'))!;
    const characters = new CharacterService(store);
    const run = characters.createScan('test', 'character_scan.v1');
    const chunk = characters.nextChunk(run.jobId)!;
    const scan: CharacterScanOutput = { characters: [{
      local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }],
      entity_kind: 'human', role_hints: [], has_dialogue: true, participates_in_event: true,
      confidence: 1, uncertainty: '', evidence: paragraphs.filter((p) => p.text.includes('陆沉')).map((p) => ({
        paragraph_id: p.id, exact_quote: p.text, supports: 'event' as const,
      })),
    }], identity_claims: [] };
    characters.ingest(run.jobId, chunk.chunkId, scan, JSON.stringify(scan), 0, 0);
    characters.nextChunk(run.jobId);
    identityId = characters.listCharacters()[0].id;
    characters.review(identityId, { status: 'confirmed', importanceTier: 'core' });
    const facts = new CharacterFactService(store);
    const factRun = facts.createRun(identityId, 'test', 'character_facts.v2');
    const batch = facts.nextBatch(factRun.jobId)!;
    const fact = (predicate: string, value: string, paragraph: typeof early,
      visibility: 'public' | 'private' | 'secret' = 'public'): CharacterFactOutput['facts'][number] => ({
      category: 'background', predicate, value, source_type: 'explicit', assertion_mode: 'narrator_assertion',
      truth_status: 'asserted', confidence: 1, visibility,
      valid_from_paragraph_id: null, valid_to_paragraph_id: null,
      evidence: [{ paragraph_id: paragraph.id, exact_quote: paragraph.text, role: 'support' }], reasoning_note: '',
    });
    const output: CharacterFactOutput = { facts: [
      fact('身份', '巡夜人', early), fact('身份', '失踪皇子', late),
      fact('晚期唯一秘密', '最终的新帝', late),
      { ...fact('幼年经历', '继承苍龙印', flashback), valid_from_paragraph_id: early.id },
      fact('他人住址', '松林暗室', secret, 'private'),
      fact('保密事项', '暗室密钥', secret, 'secret'),
      { ...fact('缺少支持证据', '未获证实的宝藏', late), evidence: [
        { paragraph_id: early.id, exact_quote: early.text, role: 'context' },
        { paragraph_id: late.id, exact_quote: late.text, role: 'support' },
      ] },
    ] };
    facts.ingest(factRun.jobId, batch.batchOrdinal, output, JSON.stringify(output), 0, 0);
    facts.nextBatch(factRun.jobId);
    facts.listFacts(identityId).forEach((f) => facts.reviewFact(f.id, 'confirmed'));
    const consolidation = new FactConsolidationService(store);
    consolidation.consolidate();
    const relation = consolidation.listRelations(identityId).find((r) => r.predicate === '身份')!;
    consolidation.reviewRelation(relation.id, 'confirmed', 'state_change');
    const { db } = store.get();
    const timestamp = new Date().toISOString();
    const insertEvent = db.prepare(`INSERT INTO timeline_events
      (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal,
       extraction_method, confidence, review_status, uncertainty, created_at, updated_at)
      VALUES (?, ?, ?, '', 'action', ?, ?, 'user', 1, 'confirmed', '', ?, ?)`);
    for (const [id, paragraph] of [['early', entry], ['late', flashback]] as const) {
      insertEvent.run(id, revisionId, `${id}进入点`, paragraph.ordinal, paragraph.ordinal, timestamp, timestamp);
    }
    insertEvent.run('reveal', revisionId, '揭晓身份', late.ordinal, late.ordinal, timestamp, timestamp);
    db.prepare(`INSERT INTO timeline_event_evidence
      (id, event_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
      VALUES ('reveal-evidence', 'reveal', ?, ?, 'support', 'exact', ?)`)
      .run(late.id, late.text, timestamp);
    const insertQuote = db.prepare(`INSERT INTO character_quotes
      (id, revision_id, paragraph_id, start_offset, end_offset, quote_text, quote_type, detection_method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'curly_double', 'user', ?)`);
    const insertAttribution = db.prepare(`INSERT INTO character_quote_attributions
      (id, quote_id, identity_id, role, method, confidence, review_status, evidence_paragraph_id, created_at, updated_at)
      VALUES (?, ?, ?, 'speaker', 'user', 1, 'confirmed', ?, ?, ?)`);
    for (const [id, paragraph, quote] of [
      ['q-early', early, '今夜风凉。'], ['q-late', late, '本座正是最终的新帝！'],
    ] as const) {
      const start = paragraph.text.indexOf(quote);
      insertQuote.run(id, revisionId, paragraph.id, start, start + quote.length, quote, timestamp);
      insertAttribution.run(`a-${id}`, id, identityId, paragraph.id, timestamp, timestamp);
    }
    // Simulate a previously built whole-book style cache; export must not read it.
    db.prepare(`INSERT INTO character_speech_profiles
      (id, revision_id, identity_id, quote_count, character_count, average_length, question_rate,
       exclamation_rate, ellipsis_rate, first_person_rate, sentence_particle_rate, politeness_rate,
       classical_rate, favorite_markers_json, sample_quote_ids_json, updated_at)
      VALUES ('profile', ?, ?, 2, 20, 10, 0, 1, 0, 0, 0, 0, 1, '["本座"]', '[]', ?)`)
      .run(revisionId, identityId, timestamp);
    cards = new CharacterCardService(store);
  });

  afterEach(async () => {
    await store?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  const saveReviewed = () => {
    const draft = cards.getDraft(identityId)!;
    return cards.save(identityId, draft, 'reviewed');
  };

  it('keeps known facts but excludes future facts, flashbacks, private information and late dialogue', () => {
    const draft = cards.generate(identityId, 'early');
    expect(draft.description).toContain('巡夜人');
    expect(draft.mesExample).toContain('今夜风凉');
    const text = JSON.stringify(draft);
    for (const forbidden of ['失踪皇子', '最终的新帝', '苍龙印', '松林暗室', '暗室密钥', '未获证实的宝藏', '本座']) {
      expect(text).not.toContain(forbidden);
    }
    expect(draft.sourceSummary).toMatchObject({ confirmedFactCount: 1, quoteSampleCount: 1 });
    expect(draft.personality).toContain('已确认对白 1 条');
  });

  it('filters model refinement sources before assembling prompts', () => {
    cards.generate(identityId, 'early');
    saveReviewed();
    const work = cards.prepareRefinement(identityId, 'test', 'character_card_refine.v1');
    expect(work.sources.filter((s) => s.kind === 'fact').map((s) => s.content)).toEqual(['巡夜人']);
    expect(work.sources.filter((s) => s.kind === 'quote').map((s) => s.content)).toEqual(['今夜风凉。']);
    expect(JSON.stringify(work)).not.toMatch(/失踪皇子|最终的新帝|苍龙印|松林暗室|暗室密钥|本座/u);
  });

  it('allows later public evidence at a later entry without deleting editorial facts', () => {
    cards.generate(identityId, 'late');
    saveReviewed();
    const work = cards.prepareRefinement(identityId, 'test', 'character_card_refine.v1');
    expect(work.sources.map((s) => s.content)).toEqual(expect.arrayContaining(['最终的新帝', '继承苍龙印']));
    expect(JSON.stringify(work)).not.toMatch(/松林暗室|暗室密钥/u);
    const editorial = new StoryStateService(store).snapshot('late', identityId);
    expect(JSON.stringify(editorial)).toContain('松林暗室');
    expect(store.get().db.prepare('SELECT COUNT(*) AS n FROM character_facts').get()?.n).toBe(7);
  });

  it('excludes a quote whose attribution is only established after the entry', () => {
    const { db } = store.get();
    db.prepare(`UPDATE character_quote_attributions SET evidence_paragraph_id =
      (SELECT paragraph_id FROM character_quotes WHERE id = 'q-late') WHERE quote_id = 'q-early'`).run();
    const draft = cards.generate(identityId, 'early');
    expect(draft.mesExample).toBe('');
    expect(draft.sourceSummary.quoteSampleCount).toBe(0);
  });

  it('blocks old unbounded drafts without overwriting their reviewed text', () => {
    cards.generate(identityId, 'early');
    const reviewed = saveReviewed();
    const summary = { ...reviewed.sourceSummary } as Record<string, unknown>;
    delete summary.projectionPolicyVersion;
    store.get().db.prepare('UPDATE character_card_drafts SET source_summary_json = ? WHERE identity_id = ?')
      .run(JSON.stringify(summary), identityId);
    expect(() => cards.prepareRefinement(identityId, 'test', 'v1')).toThrow('资料投影');
    expect(() => cards.buildCard(identityId)).toThrow('资料投影');
    expect(cards.getDraft(identityId)?.description).toBe(reviewed.description);
    expect(cards.batchStatus()[0].exportReady).toBe(false);
  });

  it('invalidates a reviewed draft when its entry boundary changes', () => {
    cards.generate(identityId, 'early');
    saveReviewed();
    store.get().db.prepare(`UPDATE timeline_events SET narrative_start_ordinal = 0 WHERE id = 'early'`).run();
    expect(() => cards.prepareRefinement(identityId, 'test', 'v1')).toThrow('资料投影');
    expect(() => cards.buildCard(identityId)).toThrow('资料投影');
    expect(cards.getDraft(identityId)?.reviewStatus).toBe('reviewed');
  });

  it('does not silently restore a stale public value when the changed state is private', () => {
    const { db } = store.get();
    db.prepare(`UPDATE character_facts SET visibility = 'private' WHERE value = '失踪皇子'`).run();
    const projected = new StoryStateService(store).snapshot('late', identityId, 'public-entry');
    const identity = projected.characters[0].values.find((value) => value.predicate === '身份');
    expect(identity).toMatchObject({ value: null, resolution: 'ambiguous', alternatives: ['巡夜人'] });
    expect(JSON.stringify(projected)).not.toContain('失踪皇子');
  });

  it('invalidates changed visible fact content even when the fact ID is unchanged', () => {
    cards.generate(identityId, 'early');
    const reviewed = saveReviewed();
    store.get().db.prepare(`UPDATE character_facts SET value = '守城人' WHERE value = '巡夜人'`).run();
    expect(() => cards.buildCard(identityId)).toThrow('资料投影');
    expect(cards.batchStatus()[0].quality?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stale_knowledge_projection', severity: 'error' }),
    ]));
    expect(cards.getDraft(identityId)?.description).toBe(reviewed.description);
  });

  it('does not invalidate an early card just because an excluded future fact changes', () => {
    cards.generate(identityId, 'early');
    const reviewed = saveReviewed();
    store.get().db.prepare(`UPDATE character_facts SET value = '后续的新称号' WHERE value = '最终的新帝'`).run();
    expect(cards.buildCard(identityId).data.description).toBe(reviewed.description);
    expect(cards.prepareRefinement(identityId, 'test', 'v1').sources.filter((s) => s.kind === 'fact'))
      .toHaveLength(1);
  });
});
