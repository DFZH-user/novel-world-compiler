import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type {
  CharacterGraphExport,
  CharacterGraphExportRelationship,
  CharacterGraphExportResult,
  CharacterRelationshipRecord,
  SillyTavernWorldInfoEntry,
  SillyTavernWorldInfoExport,
  SillyTavernWorldInfoExportResult,
} from '../../src/shared/contracts';
import { CHARACTER_GRAPH_SPEC_VERSION, characterGraphExportSchema, sillyTavernWorldInfoExportSchema } from '../../src/shared/contracts';
import { detectRelationshipCommunities } from '../../src/lib/relationship-communities';
import type { ProjectStore } from './project-store';
import { RelationshipService } from './relationship-service';
import { SCHEMA_VERSION } from './schema';
import { WORLD_INFO_TRUTH_LABELS } from './world-info-semantics';

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export class RelationshipGraphExportService {
  private readonly relationships: RelationshipService;

  constructor(private readonly store: ProjectStore) {
    this.relationships = new RelationshipService(store);
  }

  build(entryOrdinal: number): CharacterGraphExport {
    const summary = this.store.getSummary();
    if (!summary?.activeRevisionId) throw new Error('请先导入小说');
    const projection = this.relationships.getGraphProjection(entryOrdinal);
    const evidenceIds = new Map<string, string[]>();
    for (const evidence of projection.evidence) {
      evidenceIds.set(evidence.relationshipId, [...(evidenceIds.get(evidence.relationshipId) ?? []), evidence.id]);
    }
    const activeEdges = new Map(projection.edges.map((edge) => [edge.id, edge]));
    const relationships = projection.history.map((relationship): CharacterGraphExportRelationship => this.mapRelationship(
      relationship,
      evidenceIds.get(relationship.id) ?? [],
      activeEdges.has(relationship.id),
      activeEdges.get(relationship.id)?.hasConflict ?? false,
    )).sort((left, right) => left.first_revealed.ordinal - right.first_revealed.ordinal || left.id.localeCompare(right.id));

    const detectedCommunities = detectRelationshipCommunities(projection.nodes, projection.edges);
    const communityByNode = new Map<string, string>();
    const communities = detectedCommunities.map((detected) => {
      const memberNodeIds = detected.memberNodeIds;
      const id = `community_${hash(memberNodeIds.join(':')).slice(0, 16)}`;
      memberNodeIds.forEach((nodeId) => communityByNode.set(nodeId, id));
      const relationshipIds = detected.relationshipIds;
      const sourceEvidenceIds = projection.evidence.filter((evidence) => relationshipIds.includes(evidence.relationshipId))
        .map((evidence) => evidence.id).sort();
      const memberNames = memberNodeIds.map((nodeId) => projection.nodes.find((node) => node.id === nodeId)!.name);
      const relationshipSummaries = relationshipIds.slice(0, 8).map((relationshipId) => {
        const relationship = projection.edges.find((edge) => edge.id === relationshipId)!;
        return `${relationship.sourceName}与${relationship.targetName}：${relationship.relationshipType}（${WORLD_INFO_TRUTH_LABELS[relationship.truthStatus]}${relationship.hasConflict ? '；存在冲突' : ''}）`;
      });
      return {
        id,
        member_node_ids: memberNodeIds,
        relationship_ids: relationshipIds,
        source_relationship_ids: relationshipIds,
        source_evidence_ids: sourceEvidenceIds,
        summary: relationshipSummaries.length
          ? `成员：${memberNames.join('、')}。当前可见关系：${relationshipSummaries.join('；')}。`
          : `成员：${memberNames.join('、')}。当前阅读位置尚无社区内部关系。`,
      };
    }).sort((left, right) => left.id.localeCompare(right.id));

    const nodes = projection.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      importance_tier: node.importanceTier,
      importance_score: node.importanceScore,
      degree: node.degree,
      first_revealed_ordinal: node.firstRevealedOrdinal,
      component_id: node.componentId,
      community_id: communityByNode.get(node.id)!,
    })).sort((left, right) => left.id.localeCompare(right.id));
    const evidence = projection.evidence.map((item) => ({
      id: item.id,
      relationship_id: item.relationshipId,
      paragraph_id: item.paragraphId,
      paragraph_ordinal: item.paragraphOrdinal,
      chapter_title: item.chapterTitle,
      exact_quote: item.exactQuote,
      role: item.evidenceRole,
      alignment_status: item.alignmentStatus,
    })).sort((left, right) => left.paragraph_ordinal - right.paragraph_ordinal || left.id.localeCompare(right.id));
    const source = {
      format: 'novel-world-character-graph' as const,
      spec_version: CHARACTER_GRAPH_SPEC_VERSION,
      schema_version: SCHEMA_VERSION,
      project: { id: summary.id, name: summary.name, revision_id: summary.activeRevisionId },
      fence: { entry_ordinal: projection.entryOrdinal, maximum_ordinal: projection.maximumOrdinal },
      nodes,
      relationships,
      evidence,
      communities,
    };
    const sourceFingerprint = hash(JSON.stringify(source));
    return characterGraphExportSchema.parse({
      ...source,
      generated_at: new Date().toISOString(),
      extensions: { novel_world_compiler: { source_fingerprint: sourceFingerprint } },
    });
  }

  async export(entryOrdinal: number, outputPath: string): Promise<CharacterGraphExportResult> {
    const graph = this.build(entryOrdinal);
    const checksum = await this.writeJson(outputPath, graph);
    return { outputPath, checksum, graph };
  }

  buildWorldInfo(entryOrdinal: number): SillyTavernWorldInfoExport {
    const graph = this.build(entryOrdinal);
    const entries: Record<string, SillyTavernWorldInfoEntry> = {};
    let uid = 0;
    for (const community of graph.communities.filter((item) => item.relationship_ids.length > 0)) {
      const names = community.member_node_ids.map((nodeId) => graph.nodes.find((node) => node.id === nodeId)?.name).filter((name): name is string => Boolean(name));
      entries[String(uid)] = this.worldInfoEntry({
        uid,
        kind: 'community',
        keys: names,
        comment: `关系社区：${names.join('、')}`,
        content: community.summary ?? `成员：${names.join('、')}。`,
        order: 90,
        group: community.id,
        relationshipIds: community.source_relationship_ids,
        evidenceIds: community.source_evidence_ids,
      });
      uid += 1;
    }
    for (const relationship of graph.relationships.filter((item) => item.active_at_entry)) {
      const sourceLabel = relationship.information_source.type === 'narrator' ? '叙述者'
        : relationship.information_source.type === 'character' && relationship.information_source.name
          ? `人物“${relationship.information_source.name}”` : '来源未知';
      const directionLabel = relationship.direction === 'directed' ? `${relationship.source_name}指向${relationship.target_name}`
        : relationship.direction === 'reciprocal' ? '双向关系' : '无向关系';
      const truthLabel = WORLD_INFO_TRUTH_LABELS[relationship.truth_status];
      const validity = `有效区间：段落 ${relationship.validity.from_ordinal ?? '未限定'} 至 ${relationship.validity.to_ordinal ?? '持续或终点尚未揭示'}`;
      entries[String(uid)] = this.worldInfoEntry({
        uid,
        kind: 'relationship',
        keys: [...new Set([relationship.source_name, relationship.target_name, relationship.relationship_type])],
        comment: `${relationship.source_name} / ${relationship.target_name} · ${relationship.relationship_type}`,
        content: `在当前故事进入位置，${relationship.source_name}与${relationship.target_name}的关系为“${relationship.relationship_type}”。方向：${directionLabel}；真实性：${truthLabel}；信息来源：${sourceLabel}；${validity}。`,
        order: 120,
        group: `relationship_${relationship.id}`,
        relationshipIds: [relationship.id],
        evidenceIds: relationship.evidence_ids,
      });
      uid += 1;
    }
    return sillyTavernWorldInfoExportSchema.parse({
      name: `${graph.project.name} · 关系图谱 P${graph.fence.entry_ordinal}`,
      description: `由小说世界编译器生成；只包含段落 ${graph.fence.entry_ordinal} 已揭示且在该位置有效的人物关系。`,
      scan_depth: 4,
      token_budget: Math.max(512, Math.min(4096, uid * 180)),
      recursive_scanning: false,
      entries,
      extensions: { novel_world_compiler: {
        character_graph_spec_version: graph.spec_version,
        schema_version: graph.schema_version,
        project_id: graph.project.id,
        revision_id: graph.project.revision_id,
        entry_ordinal: graph.fence.entry_ordinal,
        graph_source_fingerprint: graph.extensions.novel_world_compiler.source_fingerprint,
      } },
    });
  }

  async exportWorldInfo(entryOrdinal: number, outputPath: string): Promise<SillyTavernWorldInfoExportResult> {
    const worldInfo = this.buildWorldInfo(entryOrdinal);
    const checksum = await this.writeJson(outputPath, worldInfo);
    return { outputPath, checksum, worldInfo };
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
    kind: 'community' | 'relationship';
    keys: string[];
    comment: string;
    content: string;
    order: number;
    group: string;
    relationshipIds: string[];
    evidenceIds: string[];
  }): SillyTavernWorldInfoEntry {
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
        source_relationship_ids: [...input.relationshipIds].sort(),
        source_evidence_ids: [...input.evidenceIds].sort(),
      } },
    };
  }

  private mapRelationship(relationship: CharacterRelationshipRecord, evidenceIds: string[], activeAtEntry: boolean,
    hasConflict: boolean): CharacterGraphExportRelationship {
    return {
      id: relationship.id,
      source_identity_id: relationship.sourceIdentityId,
      source_name: relationship.sourceName,
      target_identity_id: relationship.targetIdentityId,
      target_name: relationship.targetName,
      relationship_type: relationship.relationshipType,
      direction: relationship.direction,
      strength: relationship.strength,
      polarity: relationship.polarity,
      information_source: {
        type: relationship.informationSourceType,
        identity_id: relationship.informationSourceIdentityId,
        name: relationship.informationSourceName,
      },
      truth_status: relationship.truthStatus,
      validity: {
        from_event_id: relationship.validFromEventId,
        to_event_id: relationship.validToEventId,
        from_time_expression_id: relationship.validFromTimeExpressionId,
        to_time_expression_id: relationship.validToTimeExpressionId,
        from_ordinal: relationship.validFromOrdinal,
        to_ordinal: relationship.validToOrdinal,
      },
      first_revealed: { paragraph_id: relationship.firstRevealedParagraphId, ordinal: relationship.firstRevealedOrdinal },
      confidence: relationship.confidence,
      extraction_method: relationship.extractionMethod,
      supersedes_relationship_id: relationship.supersedesRelationshipId,
      reasoning_note: relationship.reasoningNote,
      evidence_ids: [...evidenceIds].sort(),
      active_at_entry: activeAtEntry,
      has_conflict: hasConflict,
    };
  }
}
