import { createHash } from 'node:crypto';
import type {
  TimelineGraphSummary,
  TimelineOrderRecord,
  TimelineRelationConsolidationSummary,
  TimelineRelationKind,
  TimelineRelationRecord,
  TimeExpressionReviewStatus,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type EventRow = { id: string; title: string; ordinal: number; reviewStatus: TimeExpressionReviewStatus };
type TimeRow = { eventId: string; paragraphId: string; surfaceText: string; expressionType: string; normalizedValue: string | null; reviewStatus: string };
type GraphRelation = { id: string; leftEventId: string; rightEventId: string; relation: TimelineRelationKind };

class UnionFind {
  private readonly parents = new Map<string, string>();
  add(value: string): void { if (!this.parents.has(value)) this.parents.set(value, value); }
  find(value: string): string {
    this.add(value);
    const parent = this.parents.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents.set(value, root);
    return root;
  }
  union(left: string, right: string): void {
    const a = this.find(left); const b = this.find(right);
    if (a !== b) this.parents.set(b, a);
  }
}

function relationEdges(eventIds: string[], relations: GraphRelation[]): { groups: UnionFind; edges: Map<string, Set<string>>; hasCycle: boolean } {
  const groups = new UnionFind();
  eventIds.forEach((id) => groups.add(id));
  relations.filter((item) => item.relation === 'simultaneous').forEach((item) => groups.union(item.leftEventId, item.rightEventId));
  const edges = new Map<string, Set<string>>();
  for (const id of eventIds) edges.set(groups.find(id), new Set());
  for (const item of relations) {
    let from: string | null = null; let to: string | null = null;
    if (item.relation === 'before') { from = groups.find(item.leftEventId); to = groups.find(item.rightEventId); }
    if (item.relation === 'after') { from = groups.find(item.rightEventId); to = groups.find(item.leftEventId); }
    if (!from || !to) continue;
    if (from === to) return { groups, edges, hasCycle: true };
    edges.get(from)?.add(to);
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of edges.get(node) ?? []) if (visit(target)) return true;
    visiting.delete(node); visited.add(node); return false;
  };
  return { groups, edges, hasCycle: [...edges.keys()].some(visit) };
}

function exactDate(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}

export class TimelineRelationService {
  constructor(private readonly store: ProjectStore) {}

  consolidate(): TimelineRelationConsolidationSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const events = db.prepare(`SELECT id, title, narrative_start_ordinal AS ordinal, review_status AS reviewStatus
      FROM timeline_events WHERE revision_id = ? AND review_status != 'rejected' ORDER BY narrative_start_ordinal, narrative_end_ordinal, id`)
      .all(revisionId) as EventRow[];
    const times = db.prepare(`SELECT l.event_id AS eventId, t.paragraph_id AS paragraphId, t.surface_text AS surfaceText,
      t.expression_type AS expressionType, t.normalized_value AS normalizedValue, t.review_status AS reviewStatus
      FROM timeline_event_time_links l JOIN timeline_time_expressions t ON t.id = l.time_expression_id
      JOIN timeline_events e ON e.id = l.event_id WHERE e.revision_id = ? AND l.review_status != 'rejected' AND t.review_status != 'rejected'
      ORDER BY e.narrative_start_ordinal, t.start_offset`).all(revisionId) as TimeRow[];
    const timesByEvent = new Map<string, TimeRow[]>();
    for (const time of times) {
      const values = timesByEvent.get(time.eventId) ?? [];
      values.push(time); timesByEvent.set(time.eventId, values);
    }
    let createdCount = 0;
    const timestamp = now();
    withTransaction(db, () => {
      for (let index = 1; index < events.length; index += 1) {
        const left = events[index - 1]; const right = events[index];
        const leftTimes = timesByEvent.get(left.id) ?? []; const rightTimes = timesByEvent.get(right.id) ?? [];
        const leftDateRow = leftTimes.find((item) => exactDate(item.normalizedValue));
        const rightDateRow = rightTimes.find((item) => exactDate(item.normalizedValue));
        let relation: TimelineRelationKind = 'unknown';
        let sourceType: TimelineRelationRecord['sourceType'] = 'inferred';
        let confidence = 0.35;
        let reason = '两个事件在原文中相邻出现，但叙述顺序不一定等于故事时间，需要人工判断';
        let evidence: TimeRow | null = rightTimes[0] ?? null;
        const leftDate = exactDate(leftDateRow?.normalizedValue ?? null);
        const rightDate = exactDate(rightDateRow?.normalizedValue ?? null);
        if (leftDate && rightDate && leftDate !== rightDate) {
          relation = leftDate < rightDate ? 'before' : 'after';
          sourceType = 'explicit'; confidence = 0.98;
          reason = `两个事件分别连接到明确日期 ${leftDate} 与 ${rightDate}`;
          evidence = rightDateRow ?? leftDateRow ?? null;
        } else {
          const relative = rightTimes.find((item) => item.expressionType === 'relative' && item.normalizedValue);
          if (relative?.normalizedValue?.startsWith('RELATIVE:AFTER') || relative?.normalizedValue === 'RELATIVE:NEXT_DAY') {
            relation = 'before'; sourceType = 'explicit'; confidence = 0.86;
            reason = `后一事件带有“${relative.surfaceText}”相对时间；以前一相邻事件为待审核锚点`;
            evidence = relative;
          } else if (relative?.normalizedValue === 'RELATIVE:SIMULTANEOUS') {
            relation = 'simultaneous'; sourceType = 'explicit'; confidence = 0.88;
            reason = `后一事件带有“${relative.surfaceText}”同时性线索；以前一相邻事件为待审核锚点`;
            evidence = relative;
          }
        }
        const id = `ter_${hash(`${revisionId}:${left.id}:${right.id}`).slice(0, 32)}`;
        const result = db.prepare(`INSERT OR IGNORE INTO timeline_event_relations
          (id, revision_id, left_event_id, right_event_id, relation, source_type, evidence_paragraph_id, exact_quote,
           confidence, reason, review_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(id, revisionId, left.id, right.id, relation, sourceType, evidence?.paragraphId ?? null,
            evidence?.surfaceText ?? '', confidence, reason, timestamp, timestamp);
        createdCount += result.changes;
      }
    });
    const rows = this.listRelations();
    return {
      createdCount,
      totalCount: rows.length,
      pendingCount: rows.filter((item) => item.reviewStatus === 'pending').length,
      confirmedCount: rows.filter((item) => item.reviewStatus === 'confirmed').length,
    };
  }

  listRelations(): TimelineRelationRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT r.id, r.left_event_id AS leftEventId, le.title AS leftTitle,
      le.narrative_start_ordinal AS leftNarrativeOrdinal, r.right_event_id AS rightEventId, re.title AS rightTitle,
      re.narrative_start_ordinal AS rightNarrativeOrdinal, r.relation AS proposedRelation,
      d.resolved_relation AS resolvedRelation, COALESCE(d.resolved_relation, r.relation) AS effectiveRelation,
      r.source_type AS sourceType, r.evidence_paragraph_id AS evidenceParagraphId, r.exact_quote AS exactQuote,
      r.confidence, r.reason, r.review_status AS reviewStatus
      FROM timeline_event_relations r JOIN timeline_events le ON le.id = r.left_event_id JOIN timeline_events re ON re.id = r.right_event_id
      LEFT JOIN timeline_event_relation_decisions d ON d.relation_id = r.id WHERE r.revision_id = ?
      ORDER BY r.review_status = 'rejected', le.narrative_start_ordinal, re.narrative_start_ordinal`)
      .all(revisionId) as unknown as TimelineRelationRecord[];
  }

  reviewRelation(relationId: string, status: TimeExpressionReviewStatus, resolvedRelation?: TimelineRelationKind): TimelineRelationRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const target = db.prepare(`SELECT r.id, r.left_event_id AS leftEventId, r.right_event_id AS rightEventId, r.relation,
      le.review_status AS leftStatus, re.review_status AS rightStatus
      FROM timeline_event_relations r JOIN timeline_events le ON le.id = r.left_event_id JOIN timeline_events re ON re.id = r.right_event_id
      WHERE r.id = ? AND r.revision_id = ?`).get(relationId, revisionId) as {
        id: string; leftEventId: string; rightEventId: string; relation: TimelineRelationKind; leftStatus: string; rightStatus: string;
      } | undefined;
    if (!target) throw new Error('找不到该事件时间关系');
    const effective = resolvedRelation ?? target.relation;
    if (status === 'confirmed') {
      if (target.leftStatus !== 'confirmed' || target.rightStatus !== 'confirmed') throw new Error('请先确认关系两端的事件');
      const events = this.confirmedEvents(db, revisionId);
      const relations = this.confirmedRelations(db, revisionId, relationId);
      relations.push({ id: relationId, leftEventId: target.leftEventId, rightEventId: target.rightEventId, relation: effective });
      if (relationEdges(events.map((event) => event.id), relations).hasCycle) throw new Error('确认后会形成故事时间循环，请先修正已有关系');
    }
    withTransaction(db, () => {
      db.prepare('UPDATE timeline_event_relations SET review_status = ?, updated_at = ? WHERE id = ?').run(status, now(), relationId);
      if (status === 'confirmed') {
        db.prepare(`INSERT INTO timeline_event_relation_decisions (relation_id, resolved_relation, reviewed_at) VALUES (?, ?, ?)
          ON CONFLICT(relation_id) DO UPDATE SET resolved_relation = excluded.resolved_relation, reviewed_at = excluded.reviewed_at`)
          .run(relationId, effective, now());
      } else {
        db.prepare('DELETE FROM timeline_event_relation_decisions WHERE relation_id = ?').run(relationId);
      }
    });
    return this.listRelations();
  }

  graphSummary(): TimelineGraphSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const events = this.confirmedEvents(db, revisionId);
    const relations = this.confirmedRelations(db, revisionId);
    const graph = relationEdges(events.map((event) => event.id), relations);
    const constrained = new Set<string>();
    for (const relation of relations) {
      if (relation.relation === 'unknown') continue;
      constrained.add(relation.leftEventId); constrained.add(relation.rightEventId);
    }
    const pending = db.prepare(`SELECT COUNT(*) AS count FROM timeline_event_relations WHERE revision_id = ? AND review_status = 'pending'`).get(revisionId) as { count: number };
    return {
      eventCount: events.length,
      confirmedRelationCount: relations.length,
      pendingRelationCount: Number(pending.count),
      hasCycle: graph.hasCycle,
      orderedEventCount: constrained.size,
      unconstrainedEventCount: Math.max(0, events.length - constrained.size),
    };
  }

  timelineOrder(): TimelineOrderRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const events = this.confirmedEvents(db, revisionId);
    const relations = this.confirmedRelations(db, revisionId);
    const graph = relationEdges(events.map((event) => event.id), relations);
    if (graph.hasCycle) throw new Error('故事时间关系存在循环，无法生成顺序');
    const members = new Map<string, EventRow[]>();
    for (const event of events) {
      const root = graph.groups.find(event.id);
      const values = members.get(root) ?? [];
      values.push(event); members.set(root, values);
    }
    const indegree = new Map<string, number>(); const levels = new Map<string, number>();
    for (const root of graph.edges.keys()) { indegree.set(root, 0); levels.set(root, 0); }
    for (const targets of graph.edges.values()) for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
    const narrative = (root: string) => Math.min(...(members.get(root) ?? []).map((event) => Number(event.ordinal)));
    const queue = [...indegree.entries()].filter(([, value]) => value === 0).map(([root]) => root).sort((a, b) => narrative(a) - narrative(b));
    while (queue.length) {
      const root = queue.shift()!;
      for (const target of graph.edges.get(root) ?? []) {
        levels.set(target, Math.max(levels.get(target) ?? 0, (levels.get(root) ?? 0) + 1));
        indegree.set(target, (indegree.get(target) ?? 0) - 1);
        if (indegree.get(target) === 0) { queue.push(target); queue.sort((a, b) => narrative(a) - narrative(b)); }
      }
    }
    const groupOrder = [...members.keys()].sort((a, b) => (levels.get(a) ?? 0) - (levels.get(b) ?? 0) || narrative(a) - narrative(b));
    const groupNumbers = new Map(groupOrder.map((root, index) => [root, index + 1]));
    const constrained = new Set<string>();
    for (const relation of relations) if (relation.relation !== 'unknown') { constrained.add(relation.leftEventId); constrained.add(relation.rightEventId); }
    return events.map((event) => {
      const root = graph.groups.find(event.id);
      return { eventId: event.id, title: event.title, narrativeOrdinal: Number(event.ordinal), orderLevel: levels.get(root) ?? 0,
        simultaneousGroup: groupNumbers.get(root) ?? 0, constrained: constrained.has(event.id) };
    }).sort((left, right) => left.orderLevel - right.orderLevel || left.narrativeOrdinal - right.narrativeOrdinal);
  }

  private confirmedEvents(db: SQLiteDatabase, revisionId: string): EventRow[] {
    return db.prepare(`SELECT id, title, narrative_start_ordinal AS ordinal, review_status AS reviewStatus
      FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed' ORDER BY narrative_start_ordinal, id`).all(revisionId) as EventRow[];
  }

  private confirmedRelations(db: SQLiteDatabase, revisionId: string, excludeId?: string): GraphRelation[] {
    const exclude = excludeId ? 'AND r.id != ?' : '';
    const values = excludeId ? [revisionId, excludeId] : [revisionId];
    return db.prepare(`SELECT r.id, r.left_event_id AS leftEventId, r.right_event_id AS rightEventId,
      COALESCE(d.resolved_relation, r.relation) AS relation FROM timeline_event_relations r
      LEFT JOIN timeline_event_relation_decisions d ON d.relation_id = r.id
      WHERE r.revision_id = ? AND r.review_status = 'confirmed' ${exclude}`).all(...values) as GraphRelation[];
  }
}
