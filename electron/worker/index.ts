import type { WorkerChannel, WorkerRequestMap, WorkerResponseMap } from '../../src/shared/contracts';
import { chunkSettingsSchema } from '../../src/shared/contracts';
import { ProjectStore } from './project-store';
import { Importer } from './importer';
import { EditorService } from './editor-service';
import { BackupService } from './backup-service';
import { CharacterService } from './character-service';
import { characterFactOutputSchema, characterScanOutputSchema, placeModelOutputSchema, timelineEventOutputSchema } from '../../src/shared/contracts';
import { randomUUID } from 'node:crypto';
import { CharacterFactService } from './character-fact-service';
import { QuoteService } from './quote-service';
import { FactConsolidationService } from './fact-consolidation-service';
import { TimelineService } from './timeline-service';
import { TimelineEventService } from './timeline-event-service';
import { TimelineRelationService } from './timeline-relation-service';
import { StoryStateService } from './story-state-service';
import { CharacterCardService } from './character-card-service';
import { RelationshipService } from './relationship-service';
import { RelationshipScanService } from './relationship-scan-service';
import { RelationshipGraphExportService } from './relationship-graph-export-service';
import { PlaceService } from './place-service';
import { PlaceModelScanService } from './place-model-scan-service';
import { PlaceMapExportService } from './place-map-export-service';
import { PlaceGeometryService } from './place-geometry-service';
import { backfillSourceSpans, inspectSourceSpan } from './source-span-service';
import { ProjectDiagnosticService } from './project-diagnostic-service';
import { FoundationWorkflowService } from './foundation-workflow-service';
import { AutomationDraftSelectionService } from './automation-draft-selection-service';
import { AutomationDraftQuoteService } from './automation-draft-quote-service';
import { RefinementDashboardService } from './refinement-dashboard-service';
import { ArtifactFoundationService } from './artifact-foundation-service';
import { PlayableBundleService } from './playable-bundle-service';
import { PlayableBundleValidationService } from './playable-bundle-validation-service';
import { PlaySessionPreparationService } from './play-session-preparation-service';
import { CharacterRuntimeService } from './character-runtime-service';
import { AutomaticFinalizationService } from './automatic-finalization-service';

type IncomingMessage<C extends WorkerChannel = WorkerChannel> = {
  requestId: string;
  channel: C;
  payload: WorkerRequestMap[C];
};

const store = new ProjectStore();
const importer = new Importer(store);
const editor = new EditorService(store);
const backup = new BackupService(store);
const characters = new CharacterService(store);
const facts = new CharacterFactService(store);
const quotes = new QuoteService(store);
const factConsolidation = new FactConsolidationService(store);
const timeline = new TimelineService(store);
const timelineEvents = new TimelineEventService(store);
const timelineRelations = new TimelineRelationService(store);
const storyState = new StoryStateService(store);
const characterCards = new CharacterCardService(store);
const relationships = new RelationshipService(store);
const relationshipScans = new RelationshipScanService(store);
const relationshipGraphExports = new RelationshipGraphExportService(store);
const placeMapExports = new PlaceMapExportService(store);
const placeGeometries = new PlaceGeometryService(store);
const places = new PlaceService(store);
const placeModelScans = new PlaceModelScanService(store);
const diagnostics = new ProjectDiagnosticService(store);
const foundationWorkflows = new FoundationWorkflowService(store);
const draftSelections = new AutomationDraftSelectionService(store);
const draftQuotes = new AutomationDraftQuoteService(store);
const refinementDashboard = new RefinementDashboardService(store);
const artifactFoundation = new ArtifactFoundationService(store);
const playableBundles = new PlayableBundleService(store);
const playableBundleValidation = new PlayableBundleValidationService(store);
const playSessionPreparation = new PlaySessionPreparationService(playableBundleValidation, store);
const characterRuntime = new CharacterRuntimeService(store);
const automaticFinalization = new AutomaticFinalizationService(store);
const sourceSpanChannels = new Set<WorkerChannel>([
  'evidence:anchor',
  'characters:scan-ingest',
  'facts:run-ingest',
  'quotes:scan',
  'quotes:assign',
  'timeline:time-scan',
  'timeline:draft-time-scan',
  'timeline:events-run-ingest',
  'timeline:relations-consolidate',
  'relationships:scan-ingest',
  'relationships:candidate-create',
  'relationships:create',
  'places:bootstrap-events',
  'places:draft-bootstrap',
  'places:model-scan-ingest',
  'places:assertion-create',
]);

async function dispatch<C extends WorkerChannel>(channel: C, rawPayload: WorkerRequestMap[C]): Promise<WorkerResponseMap[C]> {
  const payload = rawPayload as never;
  let result: unknown;
  switch (channel) {
    case 'project:create': {
      const value = payload as WorkerRequestMap['project:create'];
      result = await store.create(value.name, value.rootPath);
      break;
    }
    case 'project:open': {
      const value = payload as WorkerRequestMap['project:open'];
      result = await store.open(value.rootPath);
      break;
    }
    case 'project:get': result = store.getSummary(); break;
    case 'project:diagnostics': result = await diagnostics.run((payload as WorkerRequestMap['project:diagnostics']).mode); break;
    case 'refinement:dashboard': result = refinementDashboard.getDashboard(); break;
    case 'automation:finalize': result = automaticFinalization.finalize((payload as WorkerRequestMap['automation:finalize']).selectionRunId); break;
    case 'artifacts:foundation-status': result = artifactFoundation.status((payload as WorkerRequestMap['artifacts:foundation-status']).entryEventId); break;
    case 'artifacts:foundation-generate': result = artifactFoundation.generate((payload as WorkerRequestMap['artifacts:foundation-generate']).entryEventId); break;
    case 'artifacts:playable-bundle-export': {
      const value = payload as WorkerRequestMap['artifacts:playable-bundle-export'];
      result = playableBundles.export(value.entryEventId, value.outputDirectory);
      break;
    }
    case 'artifacts:playable-bundle-validate': {
      const value = payload as WorkerRequestMap['artifacts:playable-bundle-validate'];
      result = playableBundleValidation.validate(value.packageDirectory);
      break;
    }
    case 'artifacts:play-session-prepare': {
      const value = payload as WorkerRequestMap['artifacts:play-session-prepare'];
      result = playSessionPreparation.prepare(value.packageDirectory, value.options);
      break;
    }
    case 'artifacts:play-session-prepare-live': {
      const value = payload as WorkerRequestMap['artifacts:play-session-prepare-live'];
      result = playSessionPreparation.prepareLive(value.entryEventId, value.options);
      break;
    }
    case 'import:preview': result = await importer.preview((payload as WorkerRequestMap['import:preview']).sourcePath); break;
    case 'import:run': {
      const value = payload as WorkerRequestMap['import:run'];
      result = await importer.run(value.sourcePath, value.encoding);
      break;
    }
    case 'chapters:list': result = editor.listChapters(); break;
    case 'chapters:rename': {
      const value = payload as WorkerRequestMap['chapters:rename'];
      result = editor.renameChapter(value.chapterId, value.title);
      break;
    }
    case 'chapters:split': {
      const value = payload as WorkerRequestMap['chapters:split'];
      result = editor.splitChapter(value.chapterId, value.paragraphOrdinal, value.title);
      break;
    }
    case 'chapters:merge-next': result = editor.mergeWithNext((payload as WorkerRequestMap['chapters:merge-next']).chapterId); break;
    case 'paragraphs:list': {
      const value = payload as WorkerRequestMap['paragraphs:list'];
      result = editor.listParagraphs(value.chapterId, value.limit, value.offset);
      break;
    }
    case 'paragraphs:exclude': {
      const value = payload as WorkerRequestMap['paragraphs:exclude'];
      result = editor.setParagraphExcluded(value.paragraphId, value.excluded);
      break;
    }
    case 'chunks:build': result = editor.buildChunks(chunkSettingsSchema.parse(payload)); break;
    case 'chunks:list': result = editor.listChunks(); break;
    case 'chunks:inspect': result = editor.inspectChunk((payload as WorkerRequestMap['chunks:inspect']).chunkId); break;
    case 'search': {
      const value = payload as WorkerRequestMap['search'];
      result = editor.search(value.query, value.limit);
      break;
    }
    case 'evidence:anchor': result = editor.getEvidenceAnchor((payload as WorkerRequestMap['evidence:anchor']).paragraphId); break;
    case 'source-spans:inspect': {
      result = inspectSourceSpan(store.get().db, (payload as WorkerRequestMap['source-spans:inspect']).sourceSpanId);
      break;
    }
    case 'jobs:list': result = editor.listJobs(); break;
    case 'jobs:control': {
      const value = payload as WorkerRequestMap['jobs:control'];
      const { db, projectId } = store.get();
      const before = db.prepare('SELECT type, state, input_json AS inputJson FROM jobs WHERE id = ? AND project_id = ?')
        .get(value.jobId, projectId) as { type: string; state: string; inputJson: string | null } | undefined;
      if (before?.type === 'relationship-scan') {
        relationshipScans.controlJob(value.jobId, value.action);
        result = editor.listJobs();
        break;
      }
      if (before?.type === 'place-model-scan') {
        placeModelScans.controlJob(value.jobId, value.action);
        result = editor.listJobs();
        break;
      }
      if (before?.type === 'automation-draft-selection') {
        draftSelections.controlJob(value.jobId, value.action);
        result = editor.listJobs();
        break;
      }
      if (before?.type === 'automation-draft-quotes') {
        draftQuotes.controlJob(value.jobId, value.action);
        result = editor.listJobs();
        break;
      }
      result = editor.controlJob(value.jobId, value.action);
      if (before?.type === 'import' && (value.action === 'retry' || (value.action === 'resume' && before.state === 'queued'))) {
        if (!before.inputJson) throw new Error('该任务缺少可恢复的输入信息');
        const input = JSON.parse(before.inputJson) as { sourcePath: string; encoding: string };
        db.prepare(`UPDATE jobs SET state = 'cancelled', message = '已由新的恢复尝试替代', updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), value.jobId);
        setImmediate(() => { void importer.run(input.sourcePath, input.encoding).catch((error) => console.error(error)); });
        result = editor.listJobs();
      }
      if (before?.type === 'character-scan' && (value.action === 'retry' || value.action === 'resume')) {
        db.prepare(`UPDATE character_chunk_results SET status = 'pending', error = NULL, updated_at = ?
          WHERE run_id = (SELECT id FROM character_scan_runs WHERE job_id = ?) AND status IN ('running','failed')`)
          .run(new Date().toISOString(), value.jobId);
        db.prepare(`UPDATE character_scan_runs SET status = 'running', updated_at = ? WHERE job_id = ?`)
          .run(new Date().toISOString(), value.jobId);
        if (value.action === 'resume' && before.state === 'queued') {
          const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?')
            .get(value.jobId) as { value: number };
          const timestamp = new Date().toISOString();
          db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`)
            .run(randomUUID(), value.jobId, Number(attempt.value), timestamp);
        }
      }
      if (before?.type === 'character-facts' && (value.action === 'retry' || value.action === 'resume')) {
        const timestamp = new Date().toISOString();
        db.prepare(`UPDATE character_fact_batches SET status = 'pending', error = NULL, updated_at = ?
          WHERE run_id = (SELECT id FROM character_fact_runs WHERE job_id = ?) AND status IN ('running','failed')`).run(timestamp, value.jobId);
        db.prepare(`UPDATE character_fact_runs SET status = 'running', updated_at = ? WHERE job_id = ?`).run(timestamp, value.jobId);
        if (value.action === 'resume' && before.state === 'queued') {
          const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?').get(value.jobId) as { value: number };
          db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`)
            .run(randomUUID(), value.jobId, Number(attempt.value), timestamp);
        }
      }
      if (before?.type === 'timeline-events' && (value.action === 'retry' || value.action === 'resume')) {
        db.prepare(`UPDATE timeline_event_chunk_results SET status = 'pending', error = NULL, updated_at = ?
          WHERE run_id IN (SELECT id FROM timeline_event_runs WHERE job_id = ?) AND status IN ('failed','running')`).run(new Date().toISOString(), value.jobId);
        db.prepare(`UPDATE timeline_event_runs SET status = 'running', updated_at = ? WHERE job_id = ?`).run(new Date().toISOString(), value.jobId);
      }
      break;
    }
    case 'workflows:foundation-create': {
      const value = payload as WorkerRequestMap['workflows:foundation-create'];
      result = foundationWorkflows.create(value.model, value.profile);
      break;
    }
    case 'workflows:foundation-list': result = foundationWorkflows.list(); break;
    case 'workflows:foundation-get': {
      result = foundationWorkflows.get((payload as WorkerRequestMap['workflows:foundation-get']).runId);
      break;
    }
    case 'workflows:foundation-step': {
      const value = payload as WorkerRequestMap['workflows:foundation-step'];
      result = foundationWorkflows.updateStep(value.runId, value.stepKey, value.state, value.message, {
        progress: value.progress,
        childJobId: value.childJobId,
        output: value.output,
        error: value.error,
      });
      break;
    }
    case 'workflows:foundation-fail': {
      const value = payload as WorkerRequestMap['workflows:foundation-fail'];
      result = foundationWorkflows.fail(value.runId, value.error);
      break;
    }
    case 'workflows:foundation-control': {
      const value = payload as WorkerRequestMap['workflows:foundation-control'];
      result = foundationWorkflows.control(value.runId, value.action);
      break;
    }
    case 'draft-selections:create': {
      const value = payload as WorkerRequestMap['draft-selections:create'];
      result = draftSelections.create(value.workflowRunId, value.profile);
      break;
    }
    case 'draft-selections:process-next': {
      result = draftSelections.processNext((payload as WorkerRequestMap['draft-selections:process-next']).jobId);
      break;
    }
    case 'draft-selections:get': {
      result = draftSelections.get((payload as WorkerRequestMap['draft-selections:get']).runId);
      break;
    }
    case 'draft-selections:get-by-job': {
      result = draftSelections.getByJob((payload as WorkerRequestMap['draft-selections:get-by-job']).jobId);
      break;
    }
    case 'backup:create': result = await backup.create((payload as WorkerRequestMap['backup:create']).outputPath); break;
    case 'backup:restore': {
      const value = payload as WorkerRequestMap['backup:restore'];
      result = await backup.restore(value.inputPath, value.targetParent);
      break;
    }
    case 'characters:estimate': result = characters.estimate(); break;
    case 'characters:scan-create': {
      const value = payload as WorkerRequestMap['characters:scan-create'];
      result = characters.createScan(value.model, value.promptVersion);
      break;
    }
    case 'characters:scan-next': result = characters.nextChunk((payload as WorkerRequestMap['characters:scan-next']).jobId); break;
    case 'characters:scan-ingest': {
      const value = payload as WorkerRequestMap['characters:scan-ingest'];
      result = characters.ingest(value.jobId, value.chunkId, characterScanOutputSchema.parse(value.result), value.rawJson, value.inputTokens, value.outputTokens);
      break;
    }
    case 'characters:scan-error': {
      const value = payload as WorkerRequestMap['characters:scan-error'];
      result = characters.recordError(value.jobId, value.chunkId, value.error, value.terminal);
      break;
    }
    case 'characters:list': result = characters.listCharacters(); break;
    case 'characters:mentions': result = characters.listMentions((payload as WorkerRequestMap['characters:mentions']).identityId); break;
    case 'characters:review': {
      const value = payload as WorkerRequestMap['characters:review'];
      result = characters.review(value.identityId, { status: value.status, importanceTier: value.importanceTier });
      break;
    }
    case 'characters:aliases': result = characters.listAliases((payload as WorkerRequestMap['characters:aliases']).identityId); break;
    case 'characters:alias-review': {
      const value = payload as WorkerRequestMap['characters:alias-review'];
      result = characters.reviewAlias(value.aliasId, value.status);
      break;
    }
    case 'characters:links': result = characters.listIdentityLinks((payload as WorkerRequestMap['characters:links']).identityId); break;
    case 'characters:link-review': {
      const value = payload as WorkerRequestMap['characters:link-review'];
      result = characters.reviewIdentityLink(value.linkId, value.status);
      break;
    }
    case 'characters:merge': {
      const value = payload as WorkerRequestMap['characters:merge'];
      result = characters.merge(value.sourceIdentityId, value.targetIdentityId);
      break;
    }
    case 'characters:split': {
      const value = payload as WorkerRequestMap['characters:split'];
      result = characters.split(value.sourceIdentityId, value.mentionIds, value.canonicalName);
      break;
    }
    case 'characters:link': {
      const value = payload as WorkerRequestMap['characters:link'];
      result = characters.link(value.leftIdentityId, value.rightIdentityId, value.relation, value.reason);
      break;
    }
    case 'characters:operations': result = characters.listOperations(); break;
    case 'characters:undo': result = characters.undoLatest(); break;
    case 'facts:estimate': result = facts.estimate((payload as WorkerRequestMap['facts:estimate']).identityId); break;
    case 'facts:run-create': {
      const value = payload as WorkerRequestMap['facts:run-create'];
      result = facts.createRun(value.identityId, value.model, value.promptVersion, value.extractionPasses);
      break;
    }
    case 'facts:draft-run-create': {
      const value = payload as WorkerRequestMap['facts:draft-run-create'];
      result = facts.createDraftRun(value.selectionRunId, value.identityId, value.model, value.promptVersion, value.extractionPasses);
      break;
    }
    case 'facts:run-next': result = facts.nextBatch((payload as WorkerRequestMap['facts:run-next']).jobId); break;
    case 'facts:run-ingest': {
      const value = payload as WorkerRequestMap['facts:run-ingest'];
      result = facts.ingest(value.jobId, value.batchOrdinal, characterFactOutputSchema.parse(value.result), value.rawJson, value.inputTokens, value.outputTokens);
      break;
    }
    case 'facts:run-error': {
      const value = payload as WorkerRequestMap['facts:run-error'];
      result = facts.recordError(value.jobId, value.batchOrdinal, value.error, value.terminal);
      break;
    }
    case 'facts:list': result = facts.listFacts((payload as WorkerRequestMap['facts:list']).identityId); break;
    case 'facts:evidence': result = facts.listEvidence((payload as WorkerRequestMap['facts:evidence']).factId); break;
    case 'facts:review': {
      const value = payload as WorkerRequestMap['facts:review'];
      result = facts.reviewFact(value.factId, value.status);
      break;
    }
    case 'draft-quotes:create': {
      result = draftQuotes.create((payload as WorkerRequestMap['draft-quotes:create']).selectionRunId);
      break;
    }
    case 'draft-quotes:process-next': {
      result = draftQuotes.processNext((payload as WorkerRequestMap['draft-quotes:process-next']).jobId);
      break;
    }
    case 'draft-quotes:get': {
      result = draftQuotes.get((payload as WorkerRequestMap['draft-quotes:get']).runId);
      break;
    }
    case 'draft-quotes:get-by-job': {
      result = draftQuotes.getByJob((payload as WorkerRequestMap['draft-quotes:get-by-job']).jobId);
      break;
    }
    case 'quotes:scan': result = quotes.scan(); break;
    case 'quotes:summary': result = quotes.summary(); break;
    case 'quotes:list': {
      const value = payload as WorkerRequestMap['quotes:list'];
      result = quotes.listQuotes(value.limit, value.offset, value.unresolvedOnly);
      break;
    }
    case 'quotes:attributions': result = quotes.listAttributions((payload as WorkerRequestMap['quotes:attributions']).quoteId); break;
    case 'quotes:review': {
      const value = payload as WorkerRequestMap['quotes:review'];
      result = quotes.review(value.attributionId, value.status);
      break;
    }
    case 'quotes:assign': {
      const value = payload as WorkerRequestMap['quotes:assign'];
      result = quotes.assignSpeaker(value.quoteId, value.identityId);
      break;
    }
    case 'quotes:analyze-local': result = quotes.analyzeLocalTurns(); break;
    case 'quotes:profiles': result = quotes.listSpeechProfiles(); break;
    case 'facts:consolidate-local': result = factConsolidation.consolidate(); break;
    case 'facts:clusters': result = factConsolidation.listClusters((payload as WorkerRequestMap['facts:clusters']).identityId); break;
    case 'facts:cluster-members': result = factConsolidation.listClusterMembers((payload as WorkerRequestMap['facts:cluster-members']).clusterId); break;
    case 'facts:relations': result = factConsolidation.listRelations((payload as WorkerRequestMap['facts:relations']).identityId); break;
    case 'facts:relation-review': {
      const value = payload as WorkerRequestMap['facts:relation-review'];
      result = factConsolidation.reviewRelation(value.relationId, value.status, value.resolvedRelation);
      break;
    }
    case 'facts:transitions': result = factConsolidation.listTransitions((payload as WorkerRequestMap['facts:transitions']).identityId); break;
    case 'timeline:time-scan': result = timeline.scanTimeExpressions(); break;
    case 'timeline:draft-time-scan': result = timeline.scanDraftTimeExpressions((payload as WorkerRequestMap['timeline:draft-time-scan']).selectionRunId); break;
    case 'timeline:time-summary': result = timeline.timeExpressionSummary(); break;
    case 'timeline:time-list': result = timeline.listTimeExpressions((payload as WorkerRequestMap['timeline:time-list']).status); break;
    case 'timeline:time-review': {
      const value = payload as WorkerRequestMap['timeline:time-review'];
      result = timeline.reviewTimeExpression(value.id, value.status, value.normalizedValue);
      break;
    }
    case 'timeline:events-estimate': result = timelineEvents.estimate(); break;
    case 'timeline:events-run-create': {
      const value = payload as WorkerRequestMap['timeline:events-run-create'];
      result = timelineEvents.createRun(value.model, value.promptVersion);
      break;
    }
    case 'timeline:events-draft-run-create': {
      const value = payload as WorkerRequestMap['timeline:events-draft-run-create'];
      result = timelineEvents.createDraftRun(value.selectionRunId, value.model, value.promptVersion);
      break;
    }
    case 'timeline:events-run-next': result = timelineEvents.nextChunk((payload as WorkerRequestMap['timeline:events-run-next']).jobId); break;
    case 'timeline:events-run-ingest': {
      const value = payload as WorkerRequestMap['timeline:events-run-ingest'];
      result = timelineEvents.ingest(value.jobId, value.chunkId, timelineEventOutputSchema.parse(value.result), value.rawJson, value.inputTokens, value.outputTokens);
      break;
    }
    case 'timeline:events-run-error': {
      const value = payload as WorkerRequestMap['timeline:events-run-error'];
      result = timelineEvents.recordError(value.jobId, value.chunkId, value.error, value.terminal);
      break;
    }
    case 'timeline:events-list': result = timelineEvents.listEvents((payload as WorkerRequestMap['timeline:events-list']).status); break;
    case 'timeline:events-review': {
      const value = payload as WorkerRequestMap['timeline:events-review'];
      result = timelineEvents.reviewEvent(value.eventId, value.status);
      break;
    }
    case 'timeline:events-evidence': result = timelineEvents.listEvidence((payload as WorkerRequestMap['timeline:events-evidence']).eventId); break;
    case 'timeline:events-participants': result = timelineEvents.listParticipants((payload as WorkerRequestMap['timeline:events-participants']).eventId); break;
    case 'timeline:events-locations': result = timelineEvents.listLocations((payload as WorkerRequestMap['timeline:events-locations']).eventId); break;
    case 'places:bootstrap-events': result = places.bootstrapFromConfirmedEvents(); break;
    case 'places:draft-bootstrap': { const value = payload as WorkerRequestMap['places:draft-bootstrap']; result = places.bootstrapFromDraftEvents(value.selectionRunId, value.eventRunId); break; }
    case 'places:list': result = places.listPlaces((payload as WorkerRequestMap['places:list']).status); break;
    case 'places:mentions': result = places.listMentions((payload as WorkerRequestMap['places:mentions']).placeId); break;
    case 'places:review': {
      const value = payload as WorkerRequestMap['places:review'];
      result = places.review(value.placeId, value);
      break;
    }
    case 'places:aliases': result = places.listAliases((payload as WorkerRequestMap['places:aliases']).placeId); break;
    case 'places:alias-review': {
      const value = payload as WorkerRequestMap['places:alias-review'];
      result = places.reviewAlias(value.aliasId, value.status);
      break;
    }
    case 'places:alias-evidence': result = places.listAliasEvidence((payload as WorkerRequestMap['places:alias-evidence']).aliasId); break;
    case 'places:merge': {
      const value = payload as WorkerRequestMap['places:merge'];
      result = places.merge(value.sourcePlaceId, value.targetPlaceId);
      break;
    }
    case 'places:split': {
      const value = payload as WorkerRequestMap['places:split'];
      result = places.split(value.sourcePlaceId, value.mentionIds, value.canonicalName);
      break;
    }
    case 'places:link': {
      const value = payload as WorkerRequestMap['places:link'];
      result = places.link(value.leftPlaceId, value.rightPlaceId, value.relation, value.reason);
      break;
    }
    case 'places:links': result = places.listLinks((payload as WorkerRequestMap['places:links']).placeId); break;
    case 'places:link-review': {
      const value = payload as WorkerRequestMap['places:link-review']; result = places.reviewLink(value.linkId, value.status); break;
    }
    case 'places:link-evidence': result = places.listLinkEvidence((payload as WorkerRequestMap['places:link-evidence']).linkId); break;
    case 'places:relation-candidates': result = places.listRelationCandidates((payload as WorkerRequestMap['places:relation-candidates']).status); break;
    case 'places:relation-evidence': result = places.listRelationCandidateEvidence((payload as WorkerRequestMap['places:relation-evidence']).candidateId); break;
    case 'places:relation-suggestion': result = places.getRelationModelSuggestion((payload as WorkerRequestMap['places:relation-suggestion']).candidateId); break;
    case 'places:relation-review': {
      const value = payload as WorkerRequestMap['places:relation-review']; result = places.reviewRelationCandidate(value.candidateId, value.status); break;
    }
    case 'places:assertion-create': result = places.createRelationFromCandidate((payload as WorkerRequestMap['places:assertion-create']).candidateId); break;
    case 'places:assertions-list': result = places.listRelations((payload as WorkerRequestMap['places:assertions-list']).status); break;
    case 'places:assertions-at-entry': result = places.listRelationsAtEntry((payload as WorkerRequestMap['places:assertions-at-entry']).entryOrdinal); break;
    case 'places:map-projection': result = places.getNarrativeMapProjection((payload as WorkerRequestMap['places:map-projection']).entryOrdinal); break;
    case 'places:map-export': {
      const value = payload as WorkerRequestMap['places:map-export'];
      result = await placeMapExports.export(value.entryOrdinal, value.outputPath);
      break;
    }
    case 'artifacts:worldbook-preview': {
      const { entryOrdinal } = payload as WorkerRequestMap['artifacts:worldbook-preview'];
      result = { relationships: relationshipGraphExports.buildWorldInfo(entryOrdinal), places: placeMapExports.buildWorldInfo(entryOrdinal) };
      break;
    }
    case 'places:world-info-export': {
      const value = payload as WorkerRequestMap['places:world-info-export'];
      result = await placeMapExports.exportWorldInfo(value.entryOrdinal, value.outputPath);
      break;
    }
    case 'places:geometries-list': result = placeGeometries.list((payload as WorkerRequestMap['places:geometries-list']).status); break;
    case 'places:geometry-upsert': result = placeGeometries.upsert(payload as WorkerRequestMap['places:geometry-upsert']); break;
    case 'places:geometry-review': {
      const value = payload as WorkerRequestMap['places:geometry-review'];
      result = placeGeometries.review(value.geometryId, value.status);
      break;
    }
    case 'places:geojson-build': result = placeGeometries.buildGeoJson((payload as WorkerRequestMap['places:geojson-build']).entryOrdinal); break;
    case 'places:geojson-export': {
      const value = payload as WorkerRequestMap['places:geojson-export'];
      result = await placeGeometries.exportGeoJson(value.entryOrdinal, value.outputPath);
      break;
    }
    case 'places:assertion-review': {
      const value = payload as WorkerRequestMap['places:assertion-review']; result = places.reviewRelation(value.relationId, value.status); break;
    }
    case 'places:assertion-evidence': result = places.listRelationEvidence((payload as WorkerRequestMap['places:assertion-evidence']).relationId); break;
    case 'places:operations': result = places.listOperations(); break;
    case 'places:undo': result = places.undoLatest(); break;
    case 'places:model-scan-estimate': result = placeModelScans.estimate(); break;
    case 'places:model-scan-create': {
      const value = payload as WorkerRequestMap['places:model-scan-create'];
      result = placeModelScans.createRun(value.model, value.promptVersion, value.extractorVersion);
      break;
    }
    case 'places:model-scan-next': result = placeModelScans.nextChunk((payload as WorkerRequestMap['places:model-scan-next']).jobId); break;
    case 'places:model-scan-ingest': {
      const value = payload as WorkerRequestMap['places:model-scan-ingest'];
      result = placeModelScans.ingest(value.jobId, value.chunkId, placeModelOutputSchema.parse(value.result), value.rawJson, value.inputTokens, value.outputTokens);
      break;
    }
    case 'places:model-scan-error': {
      const value = payload as WorkerRequestMap['places:model-scan-error'];
      result = placeModelScans.recordError(value.jobId, value.chunkId, value.error, value.terminal);
      break;
    }
    case 'timeline:relations-consolidate': result = timelineRelations.consolidate(); break;
    case 'timeline:relations-list': result = timelineRelations.listRelations(); break;
    case 'timeline:relations-review': {
      const value = payload as WorkerRequestMap['timeline:relations-review'];
      result = timelineRelations.reviewRelation(value.relationId, value.status, value.resolvedRelation);
      break;
    }
    case 'timeline:graph-summary': result = timelineRelations.graphSummary(); break;
    case 'timeline:graph-order': result = timelineRelations.timelineOrder(); break;
    case 'timeline:state-snapshot': {
      const value = payload as WorkerRequestMap['timeline:state-snapshot'];
      result = storyState.snapshot(value.entryEventId, value.identityId);
      break;
    }
    case 'relationships:scan-estimate': result = relationshipScans.estimate(); break;
    case 'relationships:scan-create': {
      const value = payload as WorkerRequestMap['relationships:scan-create'];
      result = relationshipScans.createRun(value.extractorVersion, value.mode, value.model, value.promptVersion);
      break;
    }
    case 'relationships:draft-scan-create': {
      const value = payload as WorkerRequestMap['relationships:draft-scan-create'];
      result = relationshipScans.createDraftRun(value.selectionRunId, value.extractorVersion);
      break;
    }
    case 'relationships:scan-info': result = relationshipScans.getMode((payload as WorkerRequestMap['relationships:scan-info']).jobId); break;
    case 'relationships:scan-next': result = relationshipScans.nextChunk((payload as WorkerRequestMap['relationships:scan-next']).jobId); break;
    case 'relationships:scan-ingest': {
      const value = payload as WorkerRequestMap['relationships:scan-ingest'];
      result = relationshipScans.ingest(value.jobId, value.chunkId, value.result, value.rawJson, value.inputTokens, value.outputTokens);
      break;
    }
    case 'relationships:scan-error': {
      const value = payload as WorkerRequestMap['relationships:scan-error'];
      result = relationshipScans.recordError(value.jobId, value.chunkId, value.error, value.terminal);
      break;
    }
    case 'relationships:candidates-list': result = relationships.listCandidates((payload as WorkerRequestMap['relationships:candidates-list']).status); break;
    case 'relationships:candidate-evidence': result = relationships.listCandidateEvidence((payload as WorkerRequestMap['relationships:candidate-evidence']).candidateId); break;
    case 'relationships:candidate-suggestion': result = relationships.getModelSuggestion((payload as WorkerRequestMap['relationships:candidate-suggestion']).candidateId); break;
    case 'relationships:candidate-create': result = relationships.createCandidate(payload as WorkerRequestMap['relationships:candidate-create']); break;
    case 'relationships:candidate-review': {
      const value = payload as WorkerRequestMap['relationships:candidate-review'];
      result = relationships.reviewCandidate(value.candidateId, value.status);
      break;
    }
    case 'relationships:list': result = relationships.listRelationships((payload as WorkerRequestMap['relationships:list']).status); break;
    case 'relationships:list-at-entry': result = relationships.listAtEntry((payload as WorkerRequestMap['relationships:list-at-entry']).entryOrdinal); break;
    case 'relationships:graph-projection': result = relationships.getGraphProjection((payload as WorkerRequestMap['relationships:graph-projection']).entryOrdinal); break;
    case 'relationships:graph-export': {
      const value = payload as WorkerRequestMap['relationships:graph-export'];
      result = relationshipGraphExports.export(value.entryOrdinal, value.outputPath);
      break;
    }
    case 'relationships:world-info-export': {
      const value = payload as WorkerRequestMap['relationships:world-info-export'];
      result = relationshipGraphExports.exportWorldInfo(value.entryOrdinal, value.outputPath);
      break;
    }
    case 'relationships:create': result = relationships.createRelationship(payload as WorkerRequestMap['relationships:create']); break;
    case 'relationships:review': {
      const value = payload as WorkerRequestMap['relationships:review'];
      result = relationships.reviewRelationship(value.relationshipId, value.status);
      break;
    }
    case 'relationships:evidence': result = relationships.listEvidence((payload as WorkerRequestMap['relationships:evidence']).relationshipId); break;
    case 'cards:draft-get': result = characterCards.getDraft((payload as WorkerRequestMap['cards:draft-get']).identityId); break;
    case 'cards:draft-generate': {
      const value = payload as WorkerRequestMap['cards:draft-generate'];
      result = characterCards.generate(value.identityId, value.entryEventId);
      break;
    }
    case 'cards:draft-save': {
      const value = payload as WorkerRequestMap['cards:draft-save'];
      result = characterCards.save(value.identityId, value.fields, value.reviewStatus);
      break;
    }
    case 'cards:export-json': {
      const value = payload as WorkerRequestMap['cards:export-json'];
      result = characterCards.exportJson(value.identityId, value.outputPath);
      break;
    }
    case 'cards:refinement-prepare': {
      const value = payload as WorkerRequestMap['cards:refinement-prepare'];
      result = characterCards.prepareRefinement(value.identityId, value.model, value.promptVersion);
      break;
    }
    case 'cards:refinement-ingest': {
      const value = payload as WorkerRequestMap['cards:refinement-ingest'];
      result = characterCards.ingestRefinement(value.identityId, value.model, value.promptVersion, value.result,
        value.rawJson, value.inputTokens, value.outputTokens);
      break;
    }
    case 'cards:refinement-latest': result = characterCards.latestRefinement((payload as WorkerRequestMap['cards:refinement-latest']).identityId); break;
    case 'cards:refinement-review': {
      const value = payload as WorkerRequestMap['cards:refinement-review'];
      result = characterCards.reviewRefinement(value.refinementId, value.action, value.fields);
      break;
    }
    case 'cards:batch-status': result = characterCards.batchStatus(); break;
    case 'cards:batch-generate': result = characterCards.generateMissing((payload as WorkerRequestMap['cards:batch-generate']).entryEventId); break;
    case 'cards:batch-export': result = characterCards.exportReviewed((payload as WorkerRequestMap['cards:batch-export']).outputDirectory); break;
    case 'runtime:prepare': {
      const value = payload as WorkerRequestMap['runtime:prepare'];
      result = characterRuntime.prepare(value.identityId, value.question, value.model, value.retrievalMode);
      break;
    }
    case 'runtime:session-create': {
      const value = payload as WorkerRequestMap['runtime:session-create'];
      result = characterRuntime.createSession(value.identityId, value.model, value.retrievalMode);
      break;
    }
    case 'runtime:session-close': {
      result = characterRuntime.closeSession((payload as WorkerRequestMap['runtime:session-close']).sessionId);
      break;
    }
    case 'runtime:session-list': {
      const value = payload as WorkerRequestMap['runtime:session-list'];
      result = characterRuntime.listSessions(value.identityId, value.limit);
      break;
    }
    case 'runtime:session-prepare': {
      const value = payload as WorkerRequestMap['runtime:session-prepare'];
      result = characterRuntime.prepareSession(value.sessionId, value.question);
      break;
    }
    case 'runtime:session-turns': {
      const value = payload as WorkerRequestMap['runtime:session-turns'];
      result = characterRuntime.listSessionTurns(value.sessionId, value.limit);
      break;
    }
    case 'runtime:complete': result = characterRuntime.complete(payload as WorkerRequestMap['runtime:complete']); break;
    case 'runtime:fail': {
      const value = payload as WorkerRequestMap['runtime:fail'];
      result = characterRuntime.fail(value.runId, value.error);
      break;
    }
    case 'runtime:list': {
      const value = payload as WorkerRequestMap['runtime:list'];
      result = characterRuntime.list(value.identityId, value.limit);
      break;
    }
    default: throw new Error(`不支持的数据服务操作：${String(channel)}`);
  }
  if (sourceSpanChannels.has(channel)) backfillSourceSpans(store.get().db);
  return result as WorkerResponseMap[C];
}

const parentPort = process.parentPort;
if (!parentPort) throw new Error('数据服务必须由 Electron utilityProcess 启动');

parentPort.on('message', (event) => {
  const message = event.data as IncomingMessage;
  if (!message || typeof message.requestId !== 'string' || typeof message.channel !== 'string') return;
  void dispatch(message.channel, message.payload)
    .then((result) => parentPort.postMessage({ requestId: message.requestId, ok: true, result }))
    .catch((error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      parentPort.postMessage({
        requestId: message.requestId,
        ok: false,
        error: { message: normalized.message, stack: normalized.stack },
      });
    });
});

process.on('disconnect', () => { void store.close().finally(() => process.exit(0)); });
