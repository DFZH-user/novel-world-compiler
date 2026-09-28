import { createHash } from 'node:crypto';
import type {
  ArtifactFoundationDashboard,
  ArtifactFoundationGate,
  ArtifactFoundationGenerationResult,
  ArtifactFoundationIssue,
  CharacterCardBatchItem,
} from '../../src/shared/contracts';
import { CharacterCardService } from './character-card-service';
import { PlaceMapExportService } from './place-map-export-service';
import type { ProjectStore } from './project-store';
import { RefinementDashboardService } from './refinement-dashboard-service';
import { RelationshipGraphExportService } from './relationship-graph-export-service';
import type { SQLiteDatabase } from './sqlite-db';

const POLICY_VERSION = 'artifact-foundation.v1';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type EntryEvent = { id: string; title: string; narrativeOrdinal: number };

export class ArtifactFoundationService {
  private readonly cards: CharacterCardService;
  private readonly graphExports: RelationshipGraphExportService;
  private readonly mapExports: PlaceMapExportService;
  private readonly refinement: RefinementDashboardService;

  constructor(private readonly store: ProjectStore) {
    this.cards = new CharacterCardService(store);
    this.graphExports = new RelationshipGraphExportService(store);
    this.mapExports = new PlaceMapExportService(store);
    this.refinement = new RefinementDashboardService(store);
  }

  status(entryEventId?: string): ArtifactFoundationDashboard {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const refinement = this.refinement.getDashboard();
    const entryEvent = entryEventId ? this.entryEvent(db, revisionId, entryEventId) : null;
    const prerequisiteIssues = this.prerequisiteIssues(refinement.readyForArtifactDrafts, Boolean(entryEvent));
    const cardItems = this.cards.batchStatus();
    const gates: ArtifactFoundationGate[] = [this.cardGate(cardItems, entryEvent, prerequisiteIssues)];

    if (entryEvent) {
      const graph = this.graphExports.build(entryEvent.narrativeOrdinal);
      const map = this.mapExports.build(entryEvent.narrativeOrdinal);
      const graphConflicts = graph.relationships.filter((item) => item.active_at_entry && item.has_conflict).length;
      const mapConflicts = map.nodes.filter((item) => item.hierarchy_conflict).length;
      gates.push(this.projectionGate({
        kind: 'relationship-graph', title: '人物关系图基础稿', targetView: 'relationship-graph',
        prerequisiteIssues, nodeCount: graph.nodes.length,
        edgeLabel: '当前关系', edgeCount: graph.relationships.filter((item) => item.active_at_entry).length,
        historyLabel: '关系历史', historyCount: graph.relationships.length,
        evidenceCount: graph.evidence.length, conflictCount: graphConflicts,
        emptyMessage: '当前进入位置还没有已确认人物节点，无法形成关系图基础稿。',
        thinMessage: '当前没有已确认且已揭示的人物关系；仍可生成只有人物节点的基础稿。',
        conflictMessage: '当前关系投影存在冲突标记，导出前建议到关系图谱核对。',
        sourceFingerprint: graph.extensions.novel_world_compiler.source_fingerprint,
      }));
      gates.push(this.projectionGate({
        kind: 'narrative-map', title: '世界地图基础稿', targetView: 'narrative-map',
        prerequisiteIssues, nodeCount: map.nodes.length,
        edgeLabel: '当前空间关系', edgeCount: map.relations.filter((item) => item.active_at_entry).length,
        historyLabel: '地点事件', historyCount: map.events.length,
        evidenceCount: map.evidence.length, conflictCount: mapConflicts,
        emptyMessage: '当前进入位置还没有已确认地点节点，无法形成世界地图基础稿。',
        thinMessage: '当前没有已确认空间关系；仍可生成只有地点节点的拓扑基础稿。',
        conflictMessage: '地点包含层级存在冲突，导出前建议到叙事地图核对。',
        sourceFingerprint: map.extensions.novel_world_compiler.source_fingerprint,
      }));
    } else {
      gates.push(this.blockedProjectionGate('relationship-graph', '人物关系图基础稿', 'relationship-graph', prerequisiteIssues));
      gates.push(this.blockedProjectionGate('narrative-map', '世界地图基础稿', 'narrative-map', prerequisiteIssues));
    }

    return {
      revisionId,
      policyVersion: POLICY_VERSION,
      generatedAt: now(),
      refinementReady: refinement.readyForArtifactDrafts,
      canGenerate: refinement.readyForArtifactDrafts && Boolean(entryEvent) && gates.some((gate) => gate.canGenerate),
      entryEvent,
      gates,
    };
  }

  generate(entryEventId: string): ArtifactFoundationGenerationResult {
    const before = this.status(entryEventId);
    if (!before.refinementReady) throw new Error('统一精修仍有必须处理项，不能生成基础稿');
    if (!before.entryEvent) throw new Error('请选择当前修订中已确认的进入事件');
    const characterCards = this.cards.generateMissing(before.entryEvent.id);
    const graph = this.graphExports.build(before.entryEvent.narrativeOrdinal);
    const map = this.mapExports.build(before.entryEvent.narrativeOrdinal);
    return {
      generatedAt: now(),
      entryEvent: before.entryEvent,
      characterCards,
      relationshipGraph: {
        nodeCount: graph.nodes.length,
        relationshipCount: graph.relationships.filter((item) => item.active_at_entry).length,
        evidenceCount: graph.evidence.length,
        sourceFingerprint: graph.extensions.novel_world_compiler.source_fingerprint,
      },
      narrativeMap: {
        nodeCount: map.nodes.length,
        relationCount: map.relations.filter((item) => item.active_at_entry).length,
        eventCount: map.events.length,
        evidenceCount: map.evidence.length,
        sourceFingerprint: map.extensions.novel_world_compiler.source_fingerprint,
      },
      dashboard: this.status(entryEventId),
    };
  }

  private entryEvent(db: SQLiteDatabase, revisionId: string, entryEventId: string): EntryEvent {
    const row = db.prepare(`SELECT id, title, narrative_start_ordinal AS narrativeOrdinal FROM timeline_events
      WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`).get(entryEventId, revisionId) as EntryEvent | undefined;
    if (!row) throw new Error('进入事件必须属于当前修订且已经确认');
    return row;
  }

  private prerequisiteIssues(refinementReady: boolean, hasEntryEvent: boolean): ArtifactFoundationIssue[] {
    const issues: ArtifactFoundationIssue[] = [];
    if (!refinementReady) issues.push({ severity: 'blocker', code: 'refinement-blocked', message: '统一精修仍有必须处理项。', count: 1 });
    if (!hasEntryEvent) issues.push({ severity: 'blocker', code: 'entry-event-required', message: '请选择一个已确认事件作为统一防剧透进入点。', count: 1 });
    return issues;
  }

  private cardGate(items: CharacterCardBatchItem[], entryEvent: EntryEvent | null, prerequisiteIssues: ArtifactFoundationIssue[]): ArtifactFoundationGate {
    const targetCount = items.length;
    const missing = items.filter((item) => !item.hasDraft);
    const missingWithoutFacts = missing.filter((item) => item.confirmedFactCount === 0).length;
    const mismatched = entryEvent ? items.filter((item) => item.hasDraft && item.entryEventId !== entryEvent.id).length : 0;
    const qualityReady = items.filter((item) => item.quality?.contentReady).length;
    const reviewed = items.filter((item) => item.reviewStatus === 'reviewed').length;
    const exportReady = items.filter((item) => item.exportReady && (!entryEvent || item.entryEventId === entryEvent.id)).length;
    const issues = [...prerequisiteIssues];
    if (!targetCount) issues.push({ severity: 'blocker', code: 'no-card-targets', message: '没有已确认的核心或重要人物。', count: 1 });
    if (missing.length) issues.push({ severity: 'info', code: 'missing-card-drafts', message: '仍有角色卡尚未生成，本次只补缺失项。', count: missing.length });
    if (missingWithoutFacts) issues.push({ severity: 'blocker', code: 'missing-confirmed-facts', message: '这些人物没有已确认事实，无法生成有来源的角色卡。', count: missingWithoutFacts });
    if (mismatched) issues.push({ severity: 'blocker', code: 'entry-event-mismatch', message: '已有角色卡使用了其他进入事件；统一生成不会覆盖，请到角色卡页人工决定是否重建。', count: mismatched });
    const weakQuality = items.filter((item) => item.hasDraft && !item.quality?.contentReady).length;
    if (weakQuality) issues.push({ severity: 'warning', code: 'card-quality-gate', message: '这些草稿尚未达到角色卡内容质量门槛。', count: weakQuality });
    const awaitingReview = items.filter((item) => item.hasDraft && item.reviewStatus !== 'reviewed').length;
    if (awaitingReview) issues.push({ severity: 'info', code: 'card-review-required', message: '这些草稿仍需人工审阅后才能正式导出。', count: awaitingReview });
    const foundationReady = targetCount > 0 && missing.length === 0 && mismatched === 0;
    const finalExportReady = targetCount > 0 && exportReady === targetCount;
    const hardBlocked = prerequisiteIssues.length > 0 || targetCount === 0 || mismatched > 0;
    const status = hardBlocked ? 'blocked' : missing.length > 0 ? 'missing' : finalExportReady ? 'ready' : 'needs-review';
    const fingerprints = items.filter((item) => item.hasDraft && item.entryEventId === entryEvent?.id)
      .map((item) => {
        const draft = this.cards.getDraft(item.identityId);
        return draft ? `${item.identityId}:${draft.sourceSummary.sourceFingerprint}:${item.reviewStatus}` : '';
      }).filter(Boolean).sort();
    return {
      kind: 'character-cards', title: '角色卡基础稿', status,
      canGenerate: !hardBlocked && missing.some((item) => item.confirmedFactCount > 0),
      foundationReady, exportReady: finalExportReady, targetView: 'character-cards',
      metrics: [
        { label: '目标人物', value: targetCount }, { label: '已有草稿', value: targetCount - missing.length },
        { label: '质量达标', value: qualityReady }, { label: '已审阅', value: reviewed },
      ],
      issues,
      sourceFingerprint: fingerprints.length ? hash(JSON.stringify({ entryEventId: entryEvent?.id, fingerprints })) : null,
    };
  }

  private projectionGate(input: {
    kind: 'relationship-graph' | 'narrative-map'; title: string; targetView: 'relationship-graph' | 'narrative-map';
    prerequisiteIssues: ArtifactFoundationIssue[]; nodeCount: number; edgeLabel: string; edgeCount: number;
    historyLabel: string; historyCount: number; evidenceCount: number; conflictCount: number;
    emptyMessage: string; thinMessage: string; conflictMessage: string; sourceFingerprint: string;
  }): ArtifactFoundationGate {
    const issues = [...input.prerequisiteIssues];
    if (!input.nodeCount) issues.push({ severity: 'blocker', code: 'empty-projection', message: input.emptyMessage, count: 1 });
    if (input.nodeCount > 0 && !input.edgeCount) issues.push({ severity: 'warning', code: 'thin-projection', message: input.thinMessage, count: 1 });
    if (input.conflictCount) issues.push({ severity: 'warning', code: 'projection-conflicts', message: input.conflictMessage, count: input.conflictCount });
    const foundationReady = input.nodeCount > 0 && input.prerequisiteIssues.length === 0;
    return {
      kind: input.kind, title: input.title,
      status: foundationReady ? 'ready' : 'blocked',
      canGenerate: input.prerequisiteIssues.length === 0,
      foundationReady, exportReady: foundationReady, targetView: input.targetView,
      metrics: [
        { label: '节点', value: input.nodeCount }, { label: input.edgeLabel, value: input.edgeCount },
        { label: input.historyLabel, value: input.historyCount }, { label: '来源证据', value: input.evidenceCount },
      ],
      issues,
      sourceFingerprint: input.sourceFingerprint,
    };
  }

  private blockedProjectionGate(
    kind: 'relationship-graph' | 'narrative-map',
    title: string,
    targetView: 'relationship-graph' | 'narrative-map',
    issues: ArtifactFoundationIssue[],
  ): ArtifactFoundationGate {
    return {
      kind, title, status: 'blocked', canGenerate: false, foundationReady: false, exportReady: false, targetView,
      metrics: [{ label: '节点', value: 0 }, { label: '当前关系', value: 0 }, { label: '历史', value: 0 }, { label: '来源证据', value: 0 }],
      issues: [...issues], sourceFingerprint: null,
    };
  }
}