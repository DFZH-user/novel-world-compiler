import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelationshipGraphExportService } from '../../electron/worker/relationship-graph-export-service';
import { ArtifactFoundationService } from '../../electron/worker/artifact-foundation-service';
import { CharacterCardService } from '../../electron/worker/character-card-service';
import { CharacterRuntimeService } from '../../electron/worker/character-runtime-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';
import { CharacterService } from '../../electron/worker/character-service';
import { EditorService } from '../../electron/worker/editor-service';
import { FactConsolidationService } from '../../electron/worker/fact-consolidation-service';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import { PlayableBundleService } from '../../electron/worker/playable-bundle-service';
import { PlayableBundleValidationService } from '../../electron/worker/playable-bundle-validation-service';
import { PlaySessionPreparationService } from '../../electron/worker/play-session-preparation-service';
import { RelationshipService } from '../../electron/worker/relationship-service';
import type {
  CharacterFactOutput, CharacterScanOutput, FoundationWorkflowStepKey,
  SillyTavernPlaceWorldInfoExport, SillyTavernWorldInfoExport,
} from '../../src/shared/contracts';
import { buildSessionAssemblyPlan } from '../../src/shared/play-session-assembly';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

function completeWorkflow(service: FoundationWorkflowService, runId: string): void {
  const steps: FoundationWorkflowStepKey[] = [
    'preflight', 'chunks', 'character_scan', 'draft_selection', 'character_facts', 'dialogue_scan',
    'time_expressions', 'event_drafts', 'place_drafts', 'relationship_drafts', 'summary',
  ];
  for (const step of steps) service.updateStep(runId, step, 'completed', `${step} completed`, { progress: 1 });
}

describe('artifact foundation workbench', () => {
  it('keeps independent gates, builds three reproducible drafts and never overwrites an existing card', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-artifact-foundation-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, 'artifacts.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 入城', '陆沉是青石镇的巡夜人。', '林月在城门等候陆沉。', '陆沉走进青石镇。', '后来陆沉成为青石镇主。',
    ].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('三类基础稿', projectRoot);
      const imported = await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const paragraphs = editor.listParagraphs();
      const identityParagraph = paragraphs.find((item) => item.text.includes('巡夜人'))!;
      const relationParagraph = paragraphs.find((item) => item.text.includes('林月在城门'))!;
      const entryParagraph = paragraphs.find((item) => item.text.includes('走进青石镇'))!;
      const futureParagraph = paragraphs.find((item) => item.text.includes('成为青石镇主'))!;

      const characters = new CharacterService(store);
      const scan = characters.createScan('test-model', 'character_scan.v1');
      const work = characters.nextChunk(scan.jobId)!;
      const scanOutput: CharacterScanOutput = { characters: [{
        local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }],
        entity_kind: 'human', role_hints: [], has_dialogue: false, participates_in_event: true,
        confidence: 0.99, uncertainty: '', evidence: [
          { paragraph_id: identityParagraph.id, exact_quote: identityParagraph.text, supports: 'identity' },
          { paragraph_id: relationParagraph.id, exact_quote: relationParagraph.text, supports: 'event' },
          { paragraph_id: entryParagraph.id, exact_quote: entryParagraph.text, supports: 'event' },
          { paragraph_id: futureParagraph.id, exact_quote: futureParagraph.text, supports: 'event' },
        ],
      }, {
        local_key: 'lin', display_name: '林月', mention_forms: [{ text: '林月', kind: 'name' }],
        entity_kind: 'human', role_hints: [], has_dialogue: false, participates_in_event: true,
        confidence: 0.96, uncertainty: '',
        evidence: [{ paragraph_id: relationParagraph.id, exact_quote: relationParagraph.text, supports: 'event' }],
      }], identity_claims: [] };
      characters.ingest(scan.jobId, work.chunkId, scanOutput, JSON.stringify(scanOutput), 20, 10);
      characters.nextChunk(scan.jobId);
      const characterRows = characters.listCharacters();
      const identity = characterRows.find((item) => item.canonicalName === '陆沉')!;
      const companion = characterRows.find((item) => item.canonicalName === '林月')!;
      characters.review(identity.id, { status: 'confirmed', importanceTier: 'core' });
      characters.review(companion.id, { status: 'confirmed', importanceTier: 'minor' });

      const facts = new CharacterFactService(store);
      const factRun = facts.createRun(identity.id, 'test-model', 'character_facts.v2');
      const batch = facts.nextBatch(factRun.jobId)!;
      const factOutput: CharacterFactOutput = { facts: [{
        category: 'identity', predicate: '身份', value: '青石镇巡夜人', source_type: 'explicit',
        assertion_mode: 'narrator_assertion', truth_status: 'asserted', confidence: 0.99, visibility: 'public',
        valid_from_paragraph_id: null, valid_to_paragraph_id: null,
        evidence: [{ paragraph_id: identityParagraph.id, exact_quote: identityParagraph.text, role: 'support' }], reasoning_note: '',
      }, {
        category: 'status', predicate: '后来身份', value: '青石镇主', source_type: 'explicit',
        assertion_mode: 'narrator_assertion', truth_status: 'asserted', confidence: 0.99, visibility: 'public',
        valid_from_paragraph_id: futureParagraph.id, valid_to_paragraph_id: null,
        evidence: [{ paragraph_id: futureParagraph.id, exact_quote: futureParagraph.text, role: 'support' }], reasoning_note: '',
      }] };
      facts.ingest(factRun.jobId, batch.batchOrdinal, factOutput, JSON.stringify(factOutput), 20, 10);
      facts.nextBatch(factRun.jobId);
      for (const fact of facts.listFacts(identity.id)) facts.reviewFact(fact.id, 'confirmed');
      new FactConsolidationService(store).consolidate();

      const { db } = store.get();
      const timestamp = new Date().toISOString();
      db.prepare(`INSERT INTO timeline_events
        (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal,
         extraction_method, confidence, review_status, uncertainty, created_at, updated_at)
        VALUES ('entry-event', ?, '陆沉进入青石镇', '', 'movement', ?, ?, 'user', 1, 'confirmed', '', ?, ?)`)
        .run(imported.revisionId, entryParagraph.ordinal, entryParagraph.ordinal, timestamp, timestamp);
      db.prepare(`INSERT INTO timeline_events
        (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal,
         extraction_method, confidence, review_status, uncertainty, created_at, updated_at)
        VALUES ('later-event', ?, '陆沉开始巡夜', '', 'action', ?, ?, 'user', 1, 'confirmed', '', ?, ?)`)
        .run(imported.revisionId, futureParagraph.ordinal, futureParagraph.ordinal, timestamp, timestamp);
      db.prepare(`INSERT INTO place_identities
        (id, revision_id, canonical_name, normalized_name, place_type, description, importance_score,
         first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method,
         source_fingerprint, created_at, updated_at)
        VALUES ('place-town', ?, '青石镇', '青石镇', 'settlement', '', 0.9, ?, ?, 'confirmed', 'user', 'test-town', ?, ?)`)
        .run(imported.revisionId, entryParagraph.id, entryParagraph.ordinal, timestamp, timestamp);

      const relationships = new RelationshipService(store);
      const relationship = relationships.createRelationship({
        sourceIdentityId: identity.id, targetIdentityId: companion.id, relationshipType: '同镇相识', direction: 'undirected',
        informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.9, extractionMethod: 'user',
        evidence: [{ paragraphId: relationParagraph.id, exactQuote: relationParagraph.text, role: 'support' }],
      });
      relationships.reviewRelationship(relationship.id, 'confirmed');

      const workflow = new FoundationWorkflowService(store);
      const workflowRun = workflow.create('test-model');
      const service = new ArtifactFoundationService(store);
      const blocked = service.status('entry-event');
      expect(blocked).toMatchObject({ policyVersion: 'artifact-foundation.v1', refinementReady: false, canGenerate: false });
      expect(blocked.gates.every((gate) => gate.issues.some((issue) => issue.code === 'refinement-blocked'))).toBe(true);
      expect(() => service.generate('entry-event')).toThrow('统一精修仍有必须处理项');

      completeWorkflow(workflow, workflowRun.runId);
      const readyToGenerate = service.status('entry-event');
      expect(readyToGenerate.canGenerate).toBe(true);
      expect(readyToGenerate.gates.find((gate) => gate.kind === 'character-cards')).toMatchObject({
        status: 'missing', canGenerate: true, foundationReady: false, exportReady: false,
        metrics: expect.arrayContaining([{ label: '目标人物', value: 1 }, { label: '已有草稿', value: 0 }]),
      });
      expect(readyToGenerate.gates.find((gate) => gate.kind === 'relationship-graph')).toMatchObject({
        status: 'ready', foundationReady: true, exportReady: true,
        metrics: expect.arrayContaining([{ label: '节点', value: 2 }, { label: '当前关系', value: 1 }]),
      });
      expect(readyToGenerate.gates.find((gate) => gate.kind === 'narrative-map')).toMatchObject({
        status: 'ready', foundationReady: true, exportReady: true,
        metrics: expect.arrayContaining([{ label: '节点', value: 1 }, { label: '当前空间关系', value: 0 }]),
      });

      const generated = service.generate('entry-event');
      expect(generated.characterCards).toMatchObject({ targetCount: 1, generatedCount: 1, failedCount: 0 });
      expect(generated.relationshipGraph).toMatchObject({ nodeCount: 2, relationshipCount: 1, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(generated.narrativeMap).toMatchObject({ nodeCount: 1, relationCount: 0, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(generated.dashboard.gates.find((gate) => gate.kind === 'character-cards')).toMatchObject({
        status: 'needs-review', foundationReady: true, exportReady: false,
      });

      const draftBefore = db.prepare(`SELECT description, updated_at AS updatedAt FROM character_card_drafts WHERE identity_id = ?`)
        .get(identity.id) as { description: string; updatedAt: string };
      const repeated = service.generate('entry-event');
      const draftAfter = db.prepare(`SELECT description, updated_at AS updatedAt FROM character_card_drafts WHERE identity_id = ?`)
        .get(identity.id) as { description: string; updatedAt: string };
      expect(repeated.characterCards).toMatchObject({ generatedCount: 0, skippedCount: 1, failedCount: 0 });
      expect(draftAfter).toEqual(draftBefore);
      expect(repeated.relationshipGraph.sourceFingerprint).toBe(generated.relationshipGraph.sourceFingerprint);
      expect(repeated.narrativeMap.sourceFingerprint).toBe(generated.narrativeMap.sourceFingerprint);

      const bundles = new PlayableBundleService(store);
      const bundleRoot = path.join(tempRoot, 'playable-exports');
      await expect(bundles.export('entry-event', bundleRoot)).rejects.toThrow('正式导出门槛');
      const cards = new CharacterCardService(store);
      const draft = cards.getDraft(identity.id)!;
      const reviewed = cards.save(identity.id, {
        description: draft.description,
        personality: '沉着谨慎，熟悉青石镇夜间秩序。',
        scenario: draft.scenario,
        firstMes: draft.firstMes,
        mesExample: '<START>\n{{char}}: 今夜城中由我巡查。',
        creatorNotes: draft.creatorNotes,
        systemPrompt: draft.systemPrompt,
        postHistoryInstructions: draft.postHistoryInstructions,
        alternateGreetings: draft.alternateGreetings,
        tags: draft.tags,
        creator: draft.creator,
        characterVersion: '1.0',
      }, 'reviewed');
      const runtime = new CharacterRuntimeService(store);
      const runtimeWork = runtime.prepare(identity.id, '你是谁？', 'deepseek-v4-flash');
      expect(runtimeWork).toMatchObject({
        identityId: identity.id, identityName: '陆沉', entryEventId: 'entry-event',
        model: 'deepseek-v4-flash', promptVersion: 'character-runtime.v1',
      });
      expect(runtimeWork.userPrompt).toContain('[当前公开资料，角色是否知晓待核对] 身份：青石镇巡夜人');
      expect(runtimeWork.systemPrompt).toContain('【小说世界编译器·角色认知边界】');
      expect(runtimeWork.claimRules).toContainEqual(expect.objectContaining({
        stance: 'known', surfaceForms: ['青石镇巡夜人'],
      }));
      expect(runtimeWork.claimRules).toContainEqual(expect.objectContaining({
        stance: 'forbidden', surfaceForms: ['青石镇主'],
      }));
      const deliveredTurn = runtime.complete({
        runId: runtimeWork.runId,
        firstCandidate: '我是陆沉，青石镇巡夜人。',
        finalCandidate: '我是陆沉，青石镇巡夜人。',
        attempts: 1,
        inputTokens: 120,
        outputTokens: 12,
      });
      expect(deliveredTurn).toMatchObject({
        status: 'delivered', deliveredAnswer: '我是陆沉，青石镇巡夜人。',
        attempts: 1, inputTokens: 120, outputTokens: 12,
        gate: { allowed: true, action: 'allow' },
      });
      const blockedWork = runtime.prepare(identity.id, '你后来会成为什么？', 'deepseek-v4-flash');
      const blockedTurn = runtime.complete({
        runId: blockedWork.runId,
        firstCandidate: '后来我会成为青石镇主。',
        finalCandidate: '后来我会成为青石镇主。',
        attempts: 2,
        inputTokens: 240,
        outputTokens: 24,
      });
      expect(blockedTurn).toMatchObject({ status: 'blocked', deliveredAnswer: '', attempts: 2 });
      expect(blockedTurn.gate?.violations.map((item) => item.code)).toContain('forbidden_claim');
      expect(runtime.list(identity.id).map((item) => item.status)).toEqual(['blocked', 'delivered']);

      const retrievalWork = runtime.prepare(identity.id, '林月在哪里等你？', 'deepseek-flash', 'explainable-v1');
      expect(retrievalWork).toMatchObject({
        promptVersion: 'character-runtime.v3', retrievalMode: 'explainable-v1',
        retrieval: { version: 'character-runtime-retrieval.v1', entryOrdinal: entryParagraph.ordinal, budgetTokens: 600 },
      });
      expect(retrievalWork.userPrompt).toContain('【按需检索资料（已先按进入点过滤）】');
      expect(retrievalWork.retrieval?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'relationship', content: expect.stringContaining('林月') }),
        expect.objectContaining({ kind: 'paragraph', content: relationParagraph.text }),
      ]));
      expect(retrievalWork.retrieval?.items.every((item) => item.sourceOrdinal === null || item.sourceOrdinal <= entryParagraph.ordinal)).toBe(true);
      expect(JSON.stringify(retrievalWork.retrieval)).not.toContain('后来陆沉成为青石镇主');
      const persistedRetrieval = runtime.fail(retrievalWork.runId, '只验证本地检索，不调用模型');
      expect(persistedRetrieval).toMatchObject({
        retrievalMode: 'explainable-v1', retrieval: { approxTokens: expect.any(Number) }, status: 'failed',
      });

      const futureRetrievalWork = runtime.prepare(identity.id, '青石镇主是谁？', 'deepseek-flash', 'explainable-v1');
      expect(JSON.stringify(futureRetrievalWork.retrieval)).not.toContain('后来陆沉成为青石镇主');
      expect(futureRetrievalWork.retrieval?.items.every((item) => item.sourceOrdinal === null || item.sourceOrdinal <= entryParagraph.ordinal)).toBe(true);
      runtime.fail(futureRetrievalWork.runId, '只验证未来资料在召回前被排除');

      const session = runtime.createSession(identity.id, 'deepseek-flash', 'explainable-v1');
      expect(session).toMatchObject({
        identityId: identity.id, entryEventId: 'entry-event', status: 'active',
        retrievalMode: 'explainable-v1', maxHistoryTurns: 6, turnCount: 0, deliveredTurnCount: 0,
      });
      const firstSessionWork = runtime.prepareSession(session.id, '今晚由谁巡查？');
      expect(firstSessionWork).toMatchObject({
        sessionId: session.id, turnIndex: 1, historyTurnCount: 0,
        promptVersion: 'character-runtime.v3', retrievalMode: 'explainable-v1',
      });
      expect(firstSessionWork.userPrompt).toContain('（这是本次会话的第一轮）');
      runtime.complete({
        runId: firstSessionWork.runId,
        firstCandidate: '今晚由我巡查，我是青石镇巡夜人。',
        finalCandidate: '今晚由我巡查，我是青石镇巡夜人。',
        attempts: 1, inputTokens: 100, outputTokens: 12,
      });
      const blockedSessionWork = runtime.prepareSession(session.id, '你以后会成为什么？');
      runtime.complete({
        runId: blockedSessionWork.runId,
        firstCandidate: '以后我会成为青石镇主。',
        finalCandidate: '以后我会成为青石镇主。',
        attempts: 2, inputTokens: 200, outputTokens: 20,
      });
      const thirdSessionWork = runtime.prepareSession(session.id, '你刚才说今晚做什么？');
      expect(thirdSessionWork).toMatchObject({ turnIndex: 3, historyTurnCount: 1 });
      expect(thirdSessionWork.userPrompt).toContain('玩家：今晚由谁巡查？');
      expect(thirdSessionWork.userPrompt).toContain('今晚由我巡查，我是青石镇巡夜人。');
      expect(thirdSessionWork.userPrompt).not.toContain('以后我会成为青石镇主。');
      runtime.fail(thirdSessionWork.runId, '本地测试主动结束');
      expect(runtime.listSessionTurns(session.id).map((item) => item.status))
        .toEqual(['failed', 'blocked', 'delivered']);
      expect(runtime.closeSession(session.id)).toMatchObject({
        status: 'closed', turnCount: 3, deliveredTurnCount: 1, inputTokens: 300, outputTokens: 32,
      });
      expect(() => runtime.prepareSession(session.id, '还能继续吗？')).toThrow('短会话已经结束');
      expect(service.status('entry-event').gates.find((gate) => gate.kind === 'character-cards'))
        .toMatchObject({ status: 'ready', foundationReady: true, exportReady: true });

      const firstBundle = await bundles.export('entry-event', bundleRoot);
      expect(firstBundle).toMatchObject({ reused: false, bundleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(firstBundle.manifest).toMatchObject({
        format: 'novel-world-playable-bundle', spec_version: '2.0', schema_version: 28,
        entry_point: { event_id: 'entry-event', narrative_ordinal: entryParagraph.ordinal },
        character_count: 1,
      });
      const cardFile = firstBundle.manifest.files.find((file) => file.kind === 'character-card')!;
      const bundledCard = JSON.parse(await fs.readFile(path.join(firstBundle.packageDirectory, ...cardFile.path.split('/')), 'utf8')) as {
        data: {
          post_history_instructions: string;
          character_book?: unknown;
          extensions: { novel_world_compiler: {
            playable_bundle_source_fingerprint: string;
            runtime_policy: {
              version: string;
              prompt_policy_version: string;
              output_gate_policy_version: string;
              output_gate_enforcement: string;
              entry_event_id: string;
              entry_ordinal: number;
            };
          } };
        };
      };
      expect(bundledCard.data.character_book).toBeUndefined();
      const bookFile = firstBundle.manifest.files.find((file) => file.kind === 'character-book')!;
      const separateBook = JSON.parse(await fs.readFile(path.join(firstBundle.packageDirectory, ...bookFile.path.split('/')), 'utf8')) as {
        entries: Array<{ keys: string[]; extensions: { novel_world_compiler: { source_book: string } } }>;
      };
      expect(separateBook.entries.length).toBeGreaterThanOrEqual(2);
      expect(separateBook.entries.map((entry) => entry.extensions.novel_world_compiler.source_book))
        .toEqual(expect.arrayContaining(['relationship', 'place']));
      expect(separateBook.entries.flatMap((entry) => entry.keys))
        .toEqual(expect.arrayContaining(['陆沉', '林月', '青石镇']));
      expect(bundledCard.data.extensions.novel_world_compiler.playable_bundle_source_fingerprint)
        .toBe(firstBundle.bundleFingerprint);
      expect(bundledCard.data.post_history_instructions).toContain('【小说世界编译器·角色认知边界】');
      expect(bundledCard.data.post_history_instructions).toContain('“已证实”只表示叙事层真实性，不自动表示{{char}}知情');
      expect(bundledCard.data.extensions.novel_world_compiler.runtime_policy).toMatchObject({
        version: 'playable-epistemic-runtime.v1',
        prompt_policy_version: 'epistemic-guard.v3',
        output_gate_policy_version: 'epistemic-output-gate.v1',
        output_gate_enforcement: 'not_enforced_by_external_card',
        entry_event_id: 'entry-event',
        entry_ordinal: entryParagraph.ordinal,
      });
      expect(firstBundle.manifest.files.map((file) => file.kind)).toEqual(expect.arrayContaining([
        'character-card', 'character-book', 'relationship-world-info', 'place-world-info', 'entry-point',
      ]));

      const bundleValidation = new PlayableBundleValidationService(store);
      const validReport = await bundleValidation.validate(firstBundle.packageDirectory);
      expect(validReport).toMatchObject({
        valid: true, sillyTavernCompatible: true, currentProjectMatch: true,
        fileCount: firstBundle.manifest.files.length, validFileCount: firstBundle.manifest.files.length,
        characterCount: 1, characterBookEntryCount: firstBundle.manifest.character_book_entry_count,
        issues: [],
      });
      const relationshipFile = firstBundle.manifest.files.find((file) => file.kind === 'relationship-world-info')!;
      const placeFile = firstBundle.manifest.files.find((file) => file.kind === 'place-world-info')!;
      const relationshipWorldInfo = JSON.parse(await fs.readFile(
        path.join(firstBundle.packageDirectory, ...relationshipFile.path.split('/')), 'utf8',
      )) as SillyTavernWorldInfoExport;
      const places = JSON.parse(await fs.readFile(
        path.join(firstBundle.packageDirectory, ...placeFile.path.split('/')), 'utf8',
      )) as SillyTavernPlaceWorldInfoExport;
      const assembly = buildSessionAssemblyPlan(firstBundle.manifest, relationshipWorldInfo, places);
      expect(assembly.resourceKey).toContain(firstBundle.bundleFingerprint);
      expect(assembly.narratorCard.data.character_book).toBeUndefined();
      expect(Object.keys(assembly.sessionWorldBook.entries)).toHaveLength(
        Object.values(relationshipWorldInfo.entries).filter(entry =>
          entry.extensions.novel_world_compiler.entry_kind !== 'community').length
          + Object.keys(places.entries).length,
      );
      expect(assembly.sessionWorldBook.token_budget).toBeLessThanOrEqual(2048);
      for (const entry of Object.values(assembly.sessionWorldBook.entries)) {
        if (!('extensions' in entry) || entry.extensions.novel_world_compiler.entry_kind !== 'relationship') continue;
        expect(entry.selective).toBe(true);
        expect(entry.key).toHaveLength(1);
        expect(entry.keysecondary).toHaveLength(1);
      }
      const prepared = await new PlaySessionPreparationService(bundleValidation).prepare(firstBundle.packageDirectory);
      expect(prepared.resourceKey).toContain(`${assembly.resourceKey}:runtime-v1:`);
      expect(prepared.options).toEqual({ mode: 'narrator', playProfile: 'medium', persona: { name: '旅人', description: '' } });
      expect(prepared.narratorCard.data.character_book).toBeUndefined();
      expect(prepared.preview?.characters).toHaveLength(1);
      expect(prepared.sessionWorldBook.token_budget).toBeLessThanOrEqual(1024);
      const preparation = new PlaySessionPreparationService(bundleValidation);
      const low = await preparation.prepare(firstBundle.packageDirectory, { mode: 'narrator', playProfile: 'low', persona: { name: '旅人', description: '' } });
      const high = await preparation.prepare(firstBundle.packageDirectory, { mode: 'narrator', playProfile: 'high', persona: { name: '旅人', description: '' } });
      expect(low.sessionWorldBook.token_budget).toBe(512);
      expect(high.sessionWorldBook.token_budget).toBe(2048);
      expect(low.resourceKey).not.toBe(high.resourceKey);
      expect(low.preview?.playProfile).toBe('low');
      expect(high.preview?.playProfile).toBe('high');
      for (const [key, entry] of Object.entries(assembly.sessionWorldBook.entries)) {
        expect(prepared.sessionWorldBook.entries[key].content).toBe(entry.content);
      }
      expect(Object.values(prepared.sessionWorldBook.entries).some(entry => entry.comment.includes('精简运行档案'))).toBe(true);
      expect(await new PlaySessionPreparationService(bundleValidation).prepare(firstBundle.packageDirectory)).toEqual(prepared);

      const legacyDirectory = path.join(tempRoot, 'legacy-bundle-v1');
      await fs.cp(firstBundle.packageDirectory, legacyDirectory, { recursive: true });
      const legacyManifest = structuredClone(firstBundle.manifest);
      legacyManifest.spec_version = '1.0';
      const legacyCardPath = path.join(legacyDirectory, ...cardFile.path.split('/'));
      const legacyCard = JSON.parse(await fs.readFile(legacyCardPath, 'utf8'));
      legacyCard.data.character_book = separateBook;
      legacyCard.data.extensions.novel_world_compiler.playable_bundle_spec_version = '1.0';
      legacyCard.data.extensions.novel_world_compiler.character_book_source_fingerprint =
        legacyManifest.source_fingerprints.character_book;
      const legacyCardContent = `${JSON.stringify(legacyCard, null, 2)}\n`;
      await fs.writeFile(legacyCardPath, legacyCardContent, 'utf8');
      const legacyCardRecord = legacyManifest.files.find(file => file.path === cardFile.path)!;
      legacyCardRecord.checksum = createHash('sha256').update(legacyCardContent).digest('hex');
      legacyCardRecord.bytes = Buffer.byteLength(legacyCardContent);
      const entryRecord = legacyManifest.files.find(file => file.kind === 'entry-point')!;
      const legacyEntryPath = path.join(legacyDirectory, ...entryRecord.path.split('/'));
      const legacyEntry = JSON.parse(await fs.readFile(legacyEntryPath, 'utf8'));
      legacyEntry.spec_version = '1.0';
      const legacyEntryContent = `${JSON.stringify(legacyEntry, null, 2)}\n`;
      await fs.writeFile(legacyEntryPath, legacyEntryContent, 'utf8');
      entryRecord.checksum = createHash('sha256').update(legacyEntryContent).digest('hex');
      entryRecord.bytes = Buffer.byteLength(legacyEntryContent);
      await fs.writeFile(path.join(legacyDirectory, 'manifest.json'), `${JSON.stringify(legacyManifest, null, 2)}\n`, 'utf8');
      expect(await bundleValidation.validate(legacyDirectory)).toMatchObject({ valid: true, issues: [] });
      expect(await new PlaySessionPreparationService(bundleValidation).prepare(legacyDirectory))
        .toMatchObject({ resourceKey: prepared.resourceKey });

      const missingPolicyDirectory = path.join(tempRoot, 'missing-runtime-policy');
      await fs.cp(firstBundle.packageDirectory, missingPolicyDirectory, { recursive: true });
      const missingPolicyManifest = structuredClone(firstBundle.manifest);
      const missingPolicyCardFile = missingPolicyManifest.files.find((file) => file.kind === 'character-card')!;
      const missingPolicyCardPath = path.join(missingPolicyDirectory, ...missingPolicyCardFile.path.split('/'));
      const missingPolicyCard = JSON.parse(await fs.readFile(missingPolicyCardPath, 'utf8'));
      missingPolicyCard.data.post_history_instructions = '策略被外部工具删除';
      const missingPolicySerialized = `${JSON.stringify(missingPolicyCard, null, 2)}\n`;
      await fs.writeFile(missingPolicyCardPath, missingPolicySerialized, 'utf8');
      missingPolicyCardFile.checksum = createHash('sha256').update(missingPolicySerialized).digest('hex');
      missingPolicyCardFile.bytes = Buffer.byteLength(missingPolicySerialized);
      await fs.writeFile(path.join(missingPolicyDirectory, 'manifest.json'), JSON.stringify(missingPolicyManifest), 'utf8');
      const missingPolicyReport = await bundleValidation.validate(missingPolicyDirectory);
      expect(missingPolicyReport.valid).toBe(false);
      expect(missingPolicyReport.issues.map((issue) => issue.code)).toContain('runtime-policy-instructions-missing');
      await expect(new PlaySessionPreparationService(bundleValidation).prepare(missingPolicyDirectory))
        .rejects.toThrow('不能准备游玩会话');

      const stRoot = process.env.SILLYTAVERN_SOURCE_ROOT || 'E:\\SillyTavern\\SillyTavern-SillyTavern-51ad27f';
      const stValidatorPath = path.join(stRoot, 'src', 'validator', 'TavernCardValidator.js');
      if (existsSync(stValidatorPath)) {
        const module = await import(pathToFileURL(stValidatorPath).href) as {
          TavernCardValidator: new (card: unknown) => { validate(): number | boolean; lastValidationError: string | null };
        };
        const validator = new module.TavernCardValidator(bundledCard);
        expect(validator.validate()).toBe(2);
      }

      const corruptedDirectory = path.join(tempRoot, 'corrupted-playable-bundle');
      await fs.cp(firstBundle.packageDirectory, corruptedDirectory, { recursive: true });
      await fs.appendFile(path.join(corruptedDirectory, ...cardFile.path.split('/')), ' ');
      const corruptedReport = await bundleValidation.validate(corruptedDirectory);
      expect(corruptedReport).toMatchObject({ valid: false, sillyTavernCompatible: false });
      expect(corruptedReport.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['checksum-mismatch', 'size-mismatch']));
      await expect(new PlaySessionPreparationService(bundleValidation).prepare(corruptedDirectory))
        .rejects.toThrow('不能准备游玩会话');

      // Correct byte hashes cannot legitimize a worldbook from another reading point.
      const mutations = [
        { kind: 'relationship-world-info', field: 'entry_ordinal', value: entryParagraph.ordinal + 1, code: 'world-info-context-mismatch' },
        { kind: 'place-world-info', field: 'revision_id', value: 'other-revision', code: 'world-info-context-mismatch' },
        { kind: 'character-card', field: 'entry_event_id', value: 'later-event', code: 'card-context-mismatch' },
        { kind: 'character-card', field: 'identity_id', value: companion.id, code: 'card-context-mismatch' },
        { kind: 'character-book', field: 'entry_ordinal', value: entryParagraph.ordinal + 1, code: 'character-book-context-mismatch' },
        { kind: 'place-world-info', field: 'content', value: '未来结局被混入地点条目', code: 'world-info-book-mismatch' },
      ];
      for (const [index, mutation] of mutations.entries()) {
        const directory = path.join(tempRoot, `mixed-boundary-${index}`);
        await fs.cp(firstBundle.packageDirectory, directory, { recursive: true });
        const manifest = structuredClone(firstBundle.manifest);
        const asset = manifest.files.find((file) => file.kind === mutation.kind)!;
        const assetPath = path.join(directory, ...asset.path.split('/'));
        const value = JSON.parse(await fs.readFile(assetPath, 'utf8'));
        if (mutation.field === 'content') Object.values(value.entries as Record<string, { content: string }>)[0].content = mutation.value as string;
        else (mutation.kind === 'character-card' ? value.data : value).extensions.novel_world_compiler[mutation.field] = mutation.value;
        const serialized = `${JSON.stringify(value, null, 2)}\n`;
        await fs.writeFile(assetPath, serialized, 'utf8');
        asset.checksum = createHash('sha256').update(serialized).digest('hex');
        asset.bytes = Buffer.byteLength(serialized);
        await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), 'utf8');
        const report = await bundleValidation.validate(directory);
        expect(report.issues.map((issue) => issue.code)).not.toContain('checksum-mismatch');
        expect(report.issues.map((issue) => issue.code)).toContain(mutation.code);
        expect(report.valid).toBe(false);
      }

      const unsafeDirectory = path.join(tempRoot, 'unsafe-playable-bundle');
      await fs.cp(firstBundle.packageDirectory, unsafeDirectory, { recursive: true });
      const unsafeManifestPath = path.join(unsafeDirectory, 'manifest.json');
      const unsafeManifest = JSON.parse(await fs.readFile(unsafeManifestPath, 'utf8')) as typeof firstBundle.manifest;
      unsafeManifest.files[0].path = '../outside.json';
      await fs.writeFile(unsafeManifestPath, `${JSON.stringify(unsafeManifest, null, 2)}\n`, 'utf8');
      const unsafeReport = await bundleValidation.validate(unsafeDirectory);
      expect(unsafeReport).toMatchObject({ valid: false, sillyTavernCompatible: false });
      expect(unsafeReport.issues.map((issue) => issue.code)).toContain('unsafe-file-path');

      const repeatedBundle = await bundles.export('entry-event', bundleRoot);
      const originalWorldInfo = RelationshipGraphExportService.prototype.buildWorldInfo;
      const mixedScope = vi.spyOn(RelationshipGraphExportService.prototype, 'buildWorldInfo').mockImplementation(function (this: RelationshipGraphExportService, entryOrdinal) {
        const book = originalWorldInfo.call(this, entryOrdinal);
        book.extensions.novel_world_compiler.entry_ordinal += 1;
        return book;
      });
      const rejectedRoot = path.join(tempRoot, 'must-not-write-mixed-bundle');
      try {
        await expect(bundles.export('entry-event', rejectedRoot)).rejects.toThrow('未写入整合包');
        await expect(fs.stat(rejectedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { mixedScope.mockRestore(); }
      expect(repeatedBundle).toMatchObject({
        reused: true,
        packageDirectory: firstBundle.packageDirectory,
        bundleFingerprint: firstBundle.bundleFingerprint,
        manifest: firstBundle.manifest,
      });
      cards.save(identity.id, {
        description: reviewed.description,
        personality: reviewed.personality,
        scenario: reviewed.scenario,
        firstMes: reviewed.firstMes,
        mesExample: reviewed.mesExample,
        creatorNotes: `${reviewed.creatorNotes}\n人工补充使用说明。`,
        systemPrompt: reviewed.systemPrompt,
        postHistoryInstructions: reviewed.postHistoryInstructions,
        alternateGreetings: reviewed.alternateGreetings,
        tags: reviewed.tags,
        creator: reviewed.creator,
        characterVersion: reviewed.characterVersion,
      }, 'reviewed');
      const changedBundle = await bundles.export('entry-event', bundleRoot);
      expect(changedBundle.reused).toBe(false);
      expect(changedBundle.bundleFingerprint).not.toBe(firstBundle.bundleFingerprint);
      expect(changedBundle.packageDirectory).not.toBe(firstBundle.packageDirectory);
      await expect(fs.access(path.join(firstBundle.packageDirectory, 'manifest.json'))).resolves.toBeUndefined();

      const mismatched = service.status('later-event').gates.find((gate) => gate.kind === 'character-cards')!;
      expect(mismatched).toMatchObject({ status: 'blocked', foundationReady: false, canGenerate: false });
      expect(mismatched.issues.find((issue) => issue.code === 'entry-event-mismatch')).toMatchObject({ severity: 'blocker', count: 1 });
      expect(() => service.status('missing-event')).toThrow('进入事件必须属于当前修订且已经确认');
    } finally {
      await store.close();
    }
  });
});
