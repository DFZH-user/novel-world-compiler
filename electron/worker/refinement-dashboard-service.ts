import type { RefinementDashboard, RefinementIssue, RefinementSeverity, RefinementTargetView, RefinementIssueKind } from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';

const POLICY_VERSION = 'refinement-quality-center.v2';

function now(): string { return new Date().toISOString(); }

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

export class RefinementDashboardService {
  constructor(private readonly store: ProjectStore) {}

  getDashboard(): RefinementDashboard {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const latestWorkflow = db.prepare(`SELECT id, state, current_step_key AS currentStepKey FROM foundation_workflow_runs
      WHERE project_id = ? AND revision_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(projectId, revisionId) as { id: string; state: string; currentStepKey: string | null } | undefined;
    const selection = db.prepare(`SELECT id FROM automation_draft_selection_runs
      WHERE project_id = ? AND revision_id = ? AND state = 'completed' ORDER BY created_at DESC LIMIT 1`)
      .get(projectId, revisionId) as { id: string } | undefined;
    const selectionRunId = selection?.id ?? null;
    const issues: RefinementIssue[] = [];
    const add = (
      severity: RefinementSeverity,
      kind: RefinementIssueKind,
      title: string,
      summary: string,
      count: number,
      targetView: RefinementTargetView,
      samples: string[],
      rule: string,
    ) => {
      if (count <= 0) return;
      issues.push({ id: `refine:${kind}`, severity, kind, title, summary, count, targetView, samples, rule });
    };

    const finalizing = latestWorkflow?.state === 'running' && latestWorkflow.currentStepKey === 'summary';
    if (!latestWorkflow || (latestWorkflow.state !== 'completed' && !finalizing)) {
      const state = latestWorkflow?.state ?? 'missing';
      add('must', 'workflow-incomplete', '先完成一键基础流程',
        latestWorkflow ? `当前修订最近的一键流程状态为 ${state}。` : '当前修订还没有一键基础流程记录。',
        1, 'foundation-workflow', [], '当前修订最近的一键流程必须完成，精修台才具备完整候选范围。');
    }

    const alignmentCount = this.count(db, `SELECT COUNT(*) AS value FROM source_spans
      WHERE revision_id = ? AND alignment_status IN ('ambiguous','invalid')`, revisionId);
    add('recommended', 'source-alignment', '复核无法唯一定位的原文证据',
      '系统保留了这些证据及歧义状态；它们不会进入高置信自动结论，可在需要时继续校正。', alignmentCount, 'diagnostics',
      this.samples(db, `SELECT exact_quote AS label FROM source_spans
        WHERE revision_id = ? AND alignment_status IN ('ambiguous','invalid') ORDER BY validated_at DESC LIMIT 5`, revisionId),
      'SourceSpan 为 ambiguous 或 invalid 时保留为质量提示，不再阻断一键成品。');

    const selectedCharacterWhere = selectionRunId ? `EXISTS (SELECT 1 FROM automation_draft_selection_items s
      WHERE s.run_id = ? AND s.identity_id = i.id AND s.status = 'completed' AND s.selected = 1)` : '0';
    const selectedCharacterArgs = selectionRunId ? [revisionId, selectionRunId] : [revisionId];
    const selectedCharacterCount = this.count(db, `SELECT COUNT(*) AS value FROM person_identities i
      WHERE i.revision_id = ? AND i.review_status = 'pending' AND ${selectedCharacterWhere}`, ...selectedCharacterArgs);
    add('recommended', 'selected-character-review', '复核草稿集合中的人物身份',
      '这些人物已经驱动下游草稿，但仍未由人工确认或排除。', selectedCharacterCount, 'characters',
      this.samples(db, `SELECT i.canonical_name AS label FROM person_identities i
        WHERE i.revision_id = ? AND i.review_status = 'pending' AND ${selectedCharacterWhere}
        ORDER BY i.importance_score DESC, i.canonical_name LIMIT 5`, ...selectedCharacterArgs),
      '一键流程会自动裁决；若仍有 pending，作为可选质量提示保留。');

    const factConflictCount = this.count(db, `SELECT COUNT(*) AS value FROM character_fact_relations
      WHERE revision_id = ? AND review_status = 'pending'`, revisionId);
    add('recommended', 'fact-conflict-review', '复核事实冲突与状态变化',
      '未裁决的矛盾、阶段并存或状态变化会让角色状态和时间切片不确定。', factConflictCount, 'fact-review',
      this.samples(db, `SELECT i.canonical_name || ' · ' || r.reason AS label
        FROM character_fact_relations r JOIN person_identities i ON i.id = r.identity_id
        WHERE r.revision_id = ? AND r.review_status = 'pending' ORDER BY r.confidence DESC LIMIT 5`, revisionId),
      '一键流程会按置信度处理冲突；剩余项只作为可选质量提示。');

    const factCount = this.count(db, `SELECT COUNT(*) AS value FROM character_facts WHERE revision_id = ? AND review_status = 'pending'`, revisionId);
    add('recommended', 'character-fact-review', '审核人物事实候选',
      '确认高价值事实可显著改善角色卡和进入时间状态。', factCount, 'characters',
      this.samples(db, `SELECT i.canonical_name || ' · ' || f.predicate || '：' || f.value AS label
        FROM character_facts f JOIN person_identities i ON i.id = f.identity_id
        WHERE f.revision_id = ? AND f.review_status = 'pending' ORDER BY f.confidence DESC LIMIT 5`, revisionId),
      '待审事实不会进入正式角色状态，但不阻断先生成可继续精修的草稿。');

    const characterAliasCount = this.count(db, `SELECT COUNT(*) AS value FROM (
      SELECT 1 FROM person_aliases WHERE revision_id = ? AND review_status = 'pending'
      GROUP BY identity_id, normalized_alias)`, revisionId);
    add('recommended', 'character-alias-review', '审核人物别名',
      '确认别名可改善人物归并和后续扫描的召回率。', characterAliasCount, 'characters',
      this.samples(db, `SELECT i.canonical_name || ' · ' || MIN(a.alias) AS label FROM person_aliases a
        JOIN person_identities i ON i.id = a.identity_id WHERE a.revision_id = ? AND a.review_status = 'pending'
        GROUP BY a.identity_id, a.normalized_alias ORDER BY MAX(a.confidence) DESC LIMIT 5`, revisionId),
      '同一人物的同一规范化别名按一个审核单位计数，与人物页的去重及联动审核一致。');

    const quoteCount = this.count(db, `SELECT COUNT(*) AS value FROM character_quote_attributions a
      JOIN character_quotes q ON q.id = a.quote_id WHERE q.revision_id = ? AND a.role = 'speaker' AND a.review_status = 'pending'`, revisionId);
    add('recommended', 'quote-attribution-review', '审核对白说话人',
      '确认说话人可改善语言画像与角色卡对白样本。', quoteCount, 'quotes',
      this.samples(db, `SELECT substr(q.quote_text, 1, 80) AS label FROM character_quote_attributions a
        JOIN character_quotes q ON q.id = a.quote_id WHERE q.revision_id = ? AND a.role = 'speaker'
        AND a.review_status = 'pending' ORDER BY a.confidence DESC LIMIT 5`, revisionId),
      '待审 speaker 归属不进入正式语言画像，属于高价值但非完整性阻断项。');

    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'event-review', '审核事件候选',
      '确认事件后才能稳定生成时间关系、进入点和叙事投影。', 'timeline',
      'timeline_events', 'title', 'confidence DESC, narrative_start_ordinal',
      '事件保持 pending 时不会进入正式时间线；可先生成草稿，但建议在导出前处理。');
    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'place-review', '审核地点身份',
      '确认地点后才能进入正式叙事地图与地点世界书。', 'places',
      'place_identities', 'canonical_name', 'importance_score DESC, first_revealed_ordinal',
      '待审地点不会进入正式地图投影，属于导出前建议处理项。');

    const typedRelationshipCount = this.count(db, `SELECT COUNT(*) AS value FROM character_relationship_candidates
      WHERE revision_id = ? AND review_status = 'pending' AND (candidate_method != 'cooccurrence' OR proposed_type IS NOT NULL)`, revisionId);
    add('recommended', 'relationship-candidate-review', '审核有类型线索的人物关系',
      '规则或模型已提出关系类型，确认候选后仍需创建并二次审核正式关系。', typedRelationshipCount, 'relationships',
      this.samples(db, `SELECT s.canonical_name || ' ↔ ' || t.canonical_name || COALESCE(' · ' || c.proposed_type, '') AS label
        FROM character_relationship_candidates c JOIN person_identities s ON s.id = c.source_identity_id
        JOIN person_identities t ON t.id = c.target_identity_id WHERE c.revision_id = ? AND c.review_status = 'pending'
        AND (c.candidate_method != 'cooccurrence' OR c.proposed_type IS NOT NULL) ORDER BY c.confidence DESC LIMIT 5`, revisionId),
      '带类型的规则/模型候选信息量较高，优先于纯共现候选。');

    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'formal-relationship-review', '二次审核正式人物关系',
      '这些断言已经从候选生成，但尚未进入正式关系图。', 'relationships',
      'character_relationships', 'relationship_type', 'confidence DESC, first_revealed_ordinal',
      '正式关系仍为 pending 时不会入图，必须由用户执行第二审核闸门。');
    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'timeline-relation-review', '审核事件时间关系',
      '确认前后、同时或包含关系后，故事时间拓扑才会稳定。', 'timeline',
      'timeline_event_relations', 'relation', 'confidence DESC, created_at',
      '待审事件关系不会进入正式时间拓扑。');
    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'identity-link-review', '审核人物身份连接建议',
      '处理可能同人或明确不同人的建议，可避免重复身份传播到下游。', 'characters',
      'person_identity_links', 'reason', 'confidence DESC, created_at',
      '待审身份连接建议可能影响人物去重，建议在角色卡批量生成前处理。');
    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'place-identity-link-review', '审核地点身份连接建议',
      '处理同名地点的合并或分离建议，避免地图节点重复。', 'places',
      'place_identity_links', 'reason', 'confidence DESC, created_at',
      '待审地点身份建议可能影响地图节点去重。');
    const placeAliasCount = this.count(db, `SELECT COUNT(*) AS value FROM place_aliases a
      JOIN place_identities i ON i.id = a.place_id WHERE i.revision_id = ? AND a.review_status = 'pending'`, revisionId);
    add('recommended', 'place-alias-review', '审核地点别名',
      '模型或事件回收的别名需要独立确认，避免同名地点错误归并。', placeAliasCount, 'places',
      this.samples(db, `SELECT i.canonical_name || ' · ' || a.alias AS label FROM place_aliases a
        JOIN place_identities i ON i.id = a.place_id WHERE i.revision_id = ? AND a.review_status = 'pending'
        ORDER BY a.created_at DESC LIMIT 5`, revisionId),
      '地点别名有独立审核动作，确认后才参与正式地点检索与投影。');
    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'place-relation-candidate-review', '审核空间关系候选',
      '确认候选后仍需创建并二次审核正式空间关系。', 'places',
      'place_relation_candidates', "COALESCE(proposed_relation_kind, '未定类型')", 'confidence DESC, created_at',
      '空间候选不会自动进入地图，先处理高置信候选。');
    this.addSimpleRevisionIssue(db, issues, revisionId, 'recommended', 'formal-place-relation-review', '二次审核正式空间关系',
      '这些空间断言尚未进入正式地图投影。', 'places',
      'place_relations', 'relation_kind', 'confidence DESC, created_at',
      '正式空间关系仍为 pending 时不会入图。');

    const remainingCharacterWhere = selectionRunId ? `NOT EXISTS (SELECT 1 FROM automation_draft_selection_items s
      WHERE s.run_id = ? AND s.identity_id = i.id AND s.status = 'completed' AND s.selected = 1)` : '1';
    const remainingCharacterArgs = selectionRunId ? [revisionId, selectionRunId] : [revisionId];
    const remainingCharacterCount = this.count(db, `SELECT COUNT(*) AS value FROM person_identities i
      WHERE i.revision_id = ? AND i.review_status = 'pending' AND ${remainingCharacterWhere}`, ...remainingCharacterArgs);
    add('later', 'remaining-character-review', '整理未进入草稿集合的人物候选',
      '这些人物当前没有驱动自动基础稿，可在核心对象处理完后再整理。', remainingCharacterCount, 'characters',
      this.samples(db, `SELECT i.canonical_name AS label FROM person_identities i
        WHERE i.revision_id = ? AND i.review_status = 'pending' AND ${remainingCharacterWhere}
        ORDER BY i.importance_score DESC, i.canonical_name LIMIT 5`, ...remainingCharacterArgs),
      '未被最新草稿选择纳入的 pending 人物不会阻断当前基础稿。');
    this.addSimpleRevisionIssue(db, issues, revisionId, 'later', 'time-expression-review', '整理时间表达式',
      '模糊时间可按需要修正或排除，不必在第一轮全部清空。', 'timeline',
      'timeline_time_expressions', 'surface_text', 'confidence DESC, created_at',
      '单独的待审时间表达不阻断基础稿；只有形成事实冲突时才升级。');

    const geometryCount = this.count(db, `SELECT COUNT(*) AS value FROM place_geometries
      WHERE revision_id = ? AND review_status = 'pending'`, revisionId);
    add('later', 'place-geometry-review', '审核真实坐标候选',
      '真实坐标只用于可选 GeoJSON 和真实地图，不影响小说内部空间拓扑。', geometryCount, 'places',
      this.samples(db, `SELECT i.canonical_name || ' · ' || printf('%.5f, %.5f', g.longitude, g.latitude) AS label
        FROM place_geometries g JOIN place_identities i ON i.id = g.place_id
        WHERE g.revision_id = ? AND g.review_status = 'pending' ORDER BY g.updated_at DESC LIMIT 5`, revisionId),
      'WGS84 坐标与小说拓扑隔离，默认不阻断世界地图基础稿。');

    const cooccurrenceCount = this.count(db, `SELECT COUNT(*) AS value FROM character_relationship_candidates
      WHERE revision_id = ? AND review_status = 'pending' AND candidate_method = 'cooccurrence' AND proposed_type IS NULL`, revisionId);
    add('later', 'cooccurrence-review', '整理纯共现关系线索',
      '纯共现只表示人物在附近出现，不应被当成正式关系。', cooccurrenceCount, 'relationships',
      this.samples(db, `SELECT s.canonical_name || ' ↔ ' || t.canonical_name AS label
        FROM character_relationship_candidates c JOIN person_identities s ON s.id = c.source_identity_id
        JOIN person_identities t ON t.id = c.target_identity_id WHERE c.revision_id = ? AND c.review_status = 'pending'
        AND c.candidate_method = 'cooccurrence' AND c.proposed_type IS NULL ORDER BY c.confidence DESC LIMIT 5`, revisionId),
      '没有关系类型的共现候选信号较弱，默认放入稍后处理。');

    const order: Record<RefinementSeverity, number> = { must: 0, recommended: 1, later: 2 };
    issues.sort((left, right) => order[left.severity] - order[right.severity] || right.count - left.count || left.id.localeCompare(right.id));
    const counts = issues.reduce<Record<RefinementSeverity, number>>((result, issue) => {
      result[issue.severity] += issue.count;
      return result;
    }, { must: 0, recommended: 0, later: 0 });
    return {
      revisionId,
      policyVersion: POLICY_VERSION,
      generatedAt: now(),
      foundationRunId: latestWorkflow?.id ?? null,
      selectionRunId,
      readyForArtifactDrafts: counts.must === 0,
      counts,
      issues,
    };
  }

  private addSimpleRevisionIssue(
    db: SQLiteDatabase,
    issues: RefinementIssue[],
    revisionId: string,
    severity: RefinementSeverity,
    kind: RefinementIssueKind,
    title: string,
    summary: string,
    targetView: RefinementTargetView,
    table: string,
    labelExpression: string,
    orderBy: string,
    rule: string,
  ): void {
    const count = this.count(db, `SELECT COUNT(*) AS value FROM ${table} WHERE revision_id = ? AND review_status = 'pending'`, revisionId);
    if (!count) return;
    const samples = this.samples(db, `SELECT ${labelExpression} AS label FROM ${table}
      WHERE revision_id = ? AND review_status = 'pending' ORDER BY ${orderBy} LIMIT 5`, revisionId);
    issues.push({ id: `refine:${kind}`, severity, kind, title, summary, count, targetView, samples, rule });
  }

  private count(db: SQLiteDatabase, sql: string, ...values: unknown[]): number {
    const row = db.prepare(sql).get(...values) as { value: number | null } | undefined;
    return Number(row?.value ?? 0);
  }

  private samples(db: SQLiteDatabase, sql: string, ...values: unknown[]): string[] {
    return (db.prepare(sql).all(...values) as Array<{ label: string | null }>)
      .map((row) => String(row.label ?? '').trim()).filter(Boolean);
  }
}
