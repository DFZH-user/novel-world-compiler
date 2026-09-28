import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ArtifactFoundationService } from '../../electron/worker/artifact-foundation-service';
import { CharacterCardService } from '../../electron/worker/character-card-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';
import { CharacterService } from '../../electron/worker/character-service';
import { EditorService } from '../../electron/worker/editor-service';
import { FactConsolidationService } from '../../electron/worker/fact-consolidation-service';
import { FoundationWorkflowService } from '../../electron/worker/foundation-workflow-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import { PlayableBundleService } from '../../electron/worker/playable-bundle-service';
import { RelationshipService } from '../../electron/worker/relationship-service';
import type { CharacterScanOutput, CharacterFactOutput, FoundationWorkflowStepKey } from '../../src/shared/contracts';
function completeWorkflow(service: FoundationWorkflowService, runId: string): void {
  const steps: FoundationWorkflowStepKey[] = [
    'preflight', 'chunks', 'character_scan', 'draft_selection', 'character_facts', 'dialogue_scan',
    'time_expressions', 'event_drafts', 'place_drafts', 'relationship_drafts', 'summary',
  ];
  for (const step of steps) service.updateStep(runId, step, 'completed', `${step} completed`, { progress: 1 });
}

const output = process.env.NOVEL_CROSS_BOOK_FIXTURE;
const withHierarchy = process.env.NOVEL_MAP_FIXTURE === '1';
test.skipIf(!output)('builds a self-contained second book without any model calls', async () => {
  const parent = path.resolve(output!);
  if (!parent.includes('.codex-redesign-audit')) throw new Error('Fixture output must use the audit directory');
  await fs.mkdir(parent, {recursive:true});
  const tempRoot = await fs.mkdtemp(path.join(parent, 'cross-book-'));
  const projectRoot = path.join(tempRoot, 'qing-shi.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, ['第一章 入城', '陆沉是青石镇的巡夜人。', '林月在城门等候陆沉。', ...(withHierarchy ? ['青石镇属于东境，城门位于青石镇内。'] : []), '陆沉走进青石镇。', '后来陆沉成为青石镇主。'].join('\n'), 'utf8');
  const store = new ProjectStore();
  try {
      await store.create('跨书验收·青石镇', projectRoot);
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

      if (withHierarchy) {
        const geography = paragraphs.find(item => item.text.includes('青石镇属于东境'))!;
        const addPlace = db.prepare(`INSERT INTO place_identities
          (id, revision_id, canonical_name, normalized_name, place_type, description, importance_score,
           first_revealed_paragraph_id, first_revealed_ordinal, review_status, extraction_method, source_fingerprint, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '', 0.9, ?, ?, 'confirmed', 'user', ?, ?, ?)`);
        for (const [id, name, type] of [['place-region','东境','region'], ['place-gate','城门','building']]) {
          addPlace.run(id, imported.revisionId, name, name, type, geography.id, geography.ordinal, id, timestamp, timestamp);
        }
        for (const [id, parent, child] of [['region-town','place-region','place-town'], ['town-gate','place-town','place-gate']]) {
          db.prepare(`INSERT INTO place_relations
            (id, revision_id, source_place_id, target_place_id, relation_kind, direction, information_source_type,
             truth_status, first_revealed_paragraph_id, first_revealed_ordinal, confidence, review_status, extraction_method, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'contains', 'directed', 'narrator', 'asserted', ?, ?, 1, 'confirmed', 'user', ?, ?)`)
            .run(id, imported.revisionId, parent, child, geography.id, geography.ordinal, timestamp, timestamp);
          db.prepare(`INSERT INTO place_relation_evidence (id, relation_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at)
            VALUES (?, ?, ?, ?, 'support', 'exact', ?)`)
            .run(id+'-evidence', id, geography.id, geography.text, timestamp);
        }
      }

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
      completeWorkflow(workflow, workflowRun.runId);
      service.generate('entry-event');
      const cards = new CharacterCardService(store);
      const draft = cards.getDraft(identity.id)!;
      cards.save(identity.id, {
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

      const bundle = await new PlayableBundleService(store).export('entry-event', path.join(projectRoot, 'exports'));
      expect(bundle.manifest.character_count).toBe(1);
      await fs.writeFile(path.join(parent, withHierarchy ? 'map-hierarchy-fixture.json' : 'cross-book-fixture.json'), JSON.stringify(store.getSummary(), null, 2));
  } finally { await store.close(); }
});
