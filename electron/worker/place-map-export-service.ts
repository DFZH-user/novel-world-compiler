import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  NarrativeMapExport,
  NarrativeMapExportRelation,
  NarrativeMapExportResult,
  NarrativeMapTopologyClass,
  PlaceRelationRecord,
  SillyTavernPlaceWorldInfoEntry,
  SillyTavernPlaceWorldInfoExport,
  SillyTavernPlaceWorldInfoExportResult,
} from '../../src/shared/contracts';
import { NARRATIVE_MAP_SPEC_VERSION, narrativeMapExportSchema, sillyTavernPlaceWorldInfoExportSchema } from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import { PlaceService } from './place-service';
import { SCHEMA_VERSION } from './schema';
import { WORLD_INFO_TRUTH_LABELS } from './world-info-semantics';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export class PlaceMapExportService {
  private readonly places: PlaceService;

  constructor(private readonly store: ProjectStore) {
    this.places = new PlaceService(store);
  }

  build(entryOrdinal: number): NarrativeMapExport {
    const summary = this.store.getSummary();
    if (!summary?.activeRevisionId) throw new Error('请先导入小说');
    const projection = this.places.getNarrativeMapProjection(entryOrdinal);
    const evidenceIds = new Map<string, string[]>();
    for (const evidence of projection.evidence) {
      evidenceIds.set(evidence.relationId, [...(evidenceIds.get(evidence.relationId) ?? []), evidence.id]);
    }
    const activeEdges = new Map(projection.edges.map((edge) => [edge.id, edge]));
    const relations = projection.history.map((relation): NarrativeMapExportRelation => {
      const active = activeEdges.get(relation.id);
      return this.mapRelation(
        relation,
        active?.topologyClass ?? this.classifyRelation(relation.relationKind),
        evidenceIds.get(relation.id) ?? [],
        Boolean(active),
        active?.hasConflict ?? false,
      );
    }).sort((left, right) => left.first_revealed.ordinal - right.first_revealed.ordinal || left.id.localeCompare(right.id));
    const source = {
      format: 'novel-world-narrative-map' as const,
      spec_version: NARRATIVE_MAP_SPEC_VERSION,
      schema_version: SCHEMA_VERSION,
      project: { id: summary.id, name: summary.name, revision_id: summary.activeRevisionId },
      fence: { entry_ordinal: projection.entryOrdinal, maximum_ordinal: projection.maximumOrdinal },
      coordinate_semantics: projection.coordinateSemantics,
      nodes: projection.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        aliases: [...node.aliases].sort((left, right) => left.localeCompare(right, 'zh-CN')),
        place_type: node.placeType,
        importance_score: node.importanceScore,
        mention_count: node.mentionCount,
        degree: node.degree,
        first_revealed_ordinal: node.firstRevealedOrdinal,
        component_id: node.componentId,
        parent_id: node.parentId,
        hierarchy_conflict: node.hierarchyConflict,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      relations,
      evidence: projection.evidence.map((evidence) => ({
        id: evidence.id,
        relation_id: evidence.relationId,
        paragraph_id: evidence.paragraphId,
        paragraph_ordinal: evidence.paragraphOrdinal,
        chapter_title: evidence.chapterTitle,
        exact_quote: evidence.exactQuote,
        role: evidence.evidenceRole,
        alignment_status: evidence.alignmentStatus,
      })).sort((left, right) => left.paragraph_ordinal - right.paragraph_ordinal || left.id.localeCompare(right.id)),
      events: projection.events.map((event) => ({
        id: event.id,
        title: event.title,
        event_type: event.eventType,
        narrative_start_ordinal: event.narrativeStartOrdinal,
        narrative_end_ordinal: event.narrativeEndOrdinal,
        places: event.places.map((place) => ({ place_id: place.placeId, location_role: place.locationRole }))
          .sort((left, right) => left.place_id.localeCompare(right.place_id) || left.location_role.localeCompare(right.location_role)),
        participants: event.participants.map((participant) => ({
          identity_id: participant.identityId, name: participant.name, role: participant.role,
        })).sort((left, right) => left.identity_id.localeCompare(right.identity_id) || left.role.localeCompare(right.role)),
      })).sort((left, right) => left.narrative_start_ordinal - right.narrative_start_ordinal || left.id.localeCompare(right.id)),
    };
    const sourceFingerprint = hash(JSON.stringify(source));
    return narrativeMapExportSchema.parse({
      ...source,
      generated_at: new Date().toISOString(),
      extensions: { novel_world_compiler: { source_fingerprint: sourceFingerprint } },
    });
  }

  async export(entryOrdinal: number, outputPath: string): Promise<NarrativeMapExportResult> {
    const map = this.build(entryOrdinal);
    return { outputPath, checksum: await this.writeJson(outputPath, map), map };
  }

  buildWorldInfo(entryOrdinal: number): SillyTavernPlaceWorldInfoExport {
    const map = this.build(entryOrdinal);
    const entries: Record<string, SillyTavernPlaceWorldInfoEntry> = {};
    const typeLabels: Record<string, string> = {
      realm: '世界或界域', region: '区域', country: '国家', city: '城市', settlement: '聚落', district: '片区',
      route: '路线', natural: '自然地貌', building: '建筑', room: '房间', landmark: '地标', other: '地点',
    };
    const truthLabels = WORLD_INFO_TRUTH_LABELS;
    let uid = 0;
    for (const node of map.nodes) {
      const relations = map.relations.filter((relation) => relation.active_at_entry
        && (relation.source_place_id === node.id || relation.target_place_id === node.id));
      const events = map.events.filter((event) => event.places.some((place) => place.place_id === node.id));
      const parent = node.parent_id ? map.nodes.find((candidate) => candidate.id === node.parent_id) : null;
      const relationSummary = relations.map((relation) => {
        const claim = relation.source_place_id === node.id
          ? `${relation.relation_kind} ${relation.target_name}` : `${relation.source_name} ${relation.relation_kind} 此地`;
        return `${claim}（${truthLabels[relation.truth_status]}${relation.has_conflict ? '；存在冲突' : ''}）`;
      });
      const eventSummary = events.slice(0, 8).map((event) => `段落 ${event.narrative_start_ordinal}：${event.title}`);
      const content = [
        `地点“${node.name}”，类型：${typeLabels[node.place_type] ?? node.place_type}。首次在段落 ${node.first_revealed_ordinal} 揭示。`,
        parent ? `已确认所属地点：${parent.name}。` : '',
        relationSummary.length ? `当前已审核空间关系（请区分真实性）：${relationSummary.join('；')}。` : '',
        eventSummary.length ? `截至当前进入位置已揭示的地点事件：${eventSummary.join('；')}。` : '',
        node.hierarchy_conflict ? '包含层级存在冲突，未自动选择唯一父级。' : '',
      ].filter(Boolean).join('');
      const relationIds = relations.map((relation) => relation.id).sort();
      const evidenceIds = map.evidence.filter((evidence) => relationIds.includes(evidence.relation_id)).map((evidence) => evidence.id).sort();
      entries[String(uid)] = this.worldInfoEntry({
        uid, kind: 'place', keys: [node.name, ...node.aliases], comment: `地点：${node.name}`, content,
        order: 100, group: `place_${node.id}`, placeIds: [node.id], relationIds, evidenceIds,
        eventIds: events.map((event) => event.id).sort(),
      });
      uid += 1;
    }
    for (const relation of map.relations.filter((item) => item.active_at_entry)) {
      const sourceLabel = relation.information_source.type === 'narrator' ? '叙述者'
        : relation.information_source.type === 'character' && relation.information_source.name
          ? `人物“${relation.information_source.name}”` : '来源未知';
      const direction = relation.direction === 'directed' ? `${relation.source_name}指向${relation.target_name}` : '无向关系';
      const content = `在当前故事进入位置，${relation.source_name}与${relation.target_name}的空间关系为“${relation.relation_kind}”。`
        + `方向：${direction}；真实性：${truthLabels[relation.truth_status]}；信息来源：${sourceLabel}；`
        + `有效区间：段落 ${relation.validity.from_ordinal ?? '未限定'} 至 ${relation.validity.to_ordinal ?? '持续或终点尚未揭示'}。`;
      entries[String(uid)] = this.worldInfoEntry({
        uid, kind: 'spatial_relation', keys: [relation.source_name, relation.target_name, relation.relation_kind],
        comment: `${relation.source_name} / ${relation.target_name} · ${relation.relation_kind}`, content,
        order: 120, group: `spatial_relation_${relation.id}`,
        placeIds: [relation.source_place_id, relation.target_place_id].sort(), relationIds: [relation.id],
        evidenceIds: [...relation.evidence_ids].sort(),
        eventIds: [relation.validity.from_event_id, relation.validity.to_event_id].filter((id): id is string => Boolean(id)).sort(),
      });
      uid += 1;
    }
    return sillyTavernPlaceWorldInfoExportSchema.parse({
      name: `${map.project.name} · 地点世界书 P${map.fence.entry_ordinal}`,
      description: `由小说世界编译器生成；只包含段落 ${map.fence.entry_ordinal} 已揭示的地点、当前有效空间关系和地点事件。自动布局不代表真实坐标。`,
      scan_depth: 4,
      token_budget: Math.max(512, Math.min(4096, uid * 170)),
      recursive_scanning: false,
      entries,
      extensions: { novel_world_compiler: {
        narrative_map_spec_version: map.spec_version, schema_version: map.schema_version,
        project_id: map.project.id, revision_id: map.project.revision_id, entry_ordinal: map.fence.entry_ordinal,
        map_source_fingerprint: map.extensions.novel_world_compiler.source_fingerprint,
        coordinate_semantics: map.coordinate_semantics,
      } },
    });
  }

  async exportWorldInfo(entryOrdinal: number, outputPath: string): Promise<SillyTavernPlaceWorldInfoExportResult> {
    const worldInfo = this.buildWorldInfo(entryOrdinal);
    return { outputPath, checksum: await this.writeJson(outputPath, worldInfo), worldInfo };
  }

  private async writeJson(outputPath: string, value: unknown): Promise<string> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, serialized, 'utf8');
      await fs.rename(temporaryPath, outputPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return hash(serialized);
  }

  private worldInfoEntry(input: {
    uid: number;
    kind: 'place' | 'spatial_relation';
    keys: string[];
    comment: string;
    content: string;
    order: number;
    group: string;
    placeIds: string[];
    relationIds: string[];
    evidenceIds: string[];
    eventIds: string[];
  }): SillyTavernPlaceWorldInfoEntry {
    return {
      uid: input.uid,
      key: [...new Set(input.keys.map((key) => key.trim()).filter(Boolean))],
      keysecondary: [],
      comment: input.comment,
      content: input.content,
      constant: false,
      selective: false,
      vectorized: false,
      selectiveLogic: 0,
      order: input.order,
      position: 0,
      disable: false,
      addMemo: true,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: false,
      displayIndex: input.uid,
      probability: 100,
      useProbability: true,
      depth: 4,
      outletName: '',
      group: input.group,
      groupOverride: false,
      groupWeight: 100,
      scanDepth: null,
      caseSensitive: false,
      matchWholeWords: false,
      useGroupScoring: false,
      automationId: '',
      role: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      triggers: [],
      ignoreBudget: false,
      extensions: { novel_world_compiler: {
        entry_kind: input.kind,
        source_place_ids: [...input.placeIds].sort(),
        source_relation_ids: [...input.relationIds].sort(),
        source_evidence_ids: [...input.evidenceIds].sort(),
        source_event_ids: [...input.eventIds].sort(),
      } },
    };
  }

  private mapRelation(relation: PlaceRelationRecord, topologyClass: NarrativeMapTopologyClass, evidenceIds: string[],
    activeAtEntry: boolean, hasConflict: boolean): NarrativeMapExportRelation {
    return {
      id: relation.id,
      source_place_id: relation.sourcePlaceId,
      source_name: relation.sourceName,
      target_place_id: relation.targetPlaceId,
      target_name: relation.targetName,
      relation_kind: relation.relationKind,
      topology_class: topologyClass,
      direction: relation.direction,
      information_source: {
        type: relation.informationSourceType,
        identity_id: relation.informationSourceIdentityId,
        name: relation.informationSourceName,
      },
      truth_status: relation.truthStatus,
      validity: {
        from_event_id: relation.validFromEventId,
        from_event_title: relation.validFromEventTitle,
        to_event_id: relation.validToEventId,
        to_event_title: relation.validToEventTitle,
        from_ordinal: relation.validFromOrdinal,
        to_ordinal: relation.validToOrdinal,
      },
      first_revealed: { paragraph_id: relation.firstRevealedParagraphId, ordinal: relation.firstRevealedOrdinal },
      confidence: relation.confidence,
      extraction_method: relation.extractionMethod,
      candidate_id: relation.candidateId,
      supersedes_relation_id: relation.supersedesRelationId,
      reasoning_note: relation.reasoningNote,
      evidence_ids: [...evidenceIds].sort(),
      active_at_entry: activeAtEntry,
      has_conflict: hasConflict,
    };
  }

  private classifyRelation(relationKind: string): NarrativeMapTopologyClass {
    const kind = relationKind.normalize('NFKC').trim().toLowerCase().replace(/[\s-]+/gu, '_');
    if (/^(contains?|inside|within|in|part_of|belongs?_to|located_in|includes?)$/u.test(kind)
      || /包含|包括|位于|坐落|属于|内部/u.test(kind)) return 'hierarchy';
    if (/route|road|path|passage|connect|through|accessible|entrance|exit|通往|连接|道路|路径|入口|出口/u.test(kind)) return 'connection';
    if (/north|south|east|west|above|below|left|right|upstream|downstream|方向|东|西|南|北|上方|下方|上游|下游/u.test(kind)) return 'direction';
    if (/near|far|distance|adjacent|beside|close|附近|邻近|相邻|远离|距离/u.test(kind)) return 'proximity';
    return 'other';
  }
}
