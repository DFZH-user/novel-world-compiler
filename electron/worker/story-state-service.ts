import type {
  CharacterCandidate,
  CharacterFactRecord,
  StoryCharacterSnapshot,
  StoryStateSnapshot,
  StoryStateValueRecord,
  TimelineRelationKind,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { StoryKnowledgeProjection } from './story-knowledge-projection';

type ImportanceTier = CharacterCandidate['importanceTier'];
type FactCategory = CharacterFactRecord['category'];

type IdentityRow = {
  id: string;
  name: string;
  importanceTier: ImportanceTier;
};

type FactRow = {
  identityId: string;
  category: FactCategory;
  predicate: string;
  value: string;
  visibility: StoryStateValueRecord['visibility'];
  confidence: number;
  evidenceCount: number;
};

type TransitionRow = {
  id: string;
  identityId: string;
  category: FactCategory;
  predicate: string;
  fromValue: string;
  toValue: string;
  confidence: number;
  triggerEventId: string | null;
};

type Transition = Omit<TransitionRow, 'triggerEventId'> & { triggerEventIds: string[] };
type RelationRow = { leftEventId: string; rightEventId: string; relation: TimelineRelationKind };

type AggregatedFact = {
  value: string;
  visibility: StoryStateValueRecord['visibility'];
  confidence: number;
  evidenceCount: number;
};

type PropertyGroup = {
  identityId: string;
  category: FactCategory;
  predicate: string;
  facts: AggregatedFact[];
  transitions: Transition[];
};

class UnionFind {
  private readonly parents = new Map<string, string>();

  add(value: string): void {
    if (!this.parents.has(value)) this.parents.set(value, value);
  }

  find(value: string): string {
    this.add(value);
    const parent = this.parents.get(value)!;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parents.set(value, root);
    return root;
  }

  union(left: string, right: string): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a !== b) this.parents.set(b, a);
  }
}

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function propertyKey(identityId: string, category: FactCategory, predicate: string): string {
  return `${identityId}\u0000${category}\u0000${normalize(predicate)}`;
}

const visibilityRank: Record<StoryStateValueRecord['visibility'], number> = { public: 0, private: 1, secret: 2 };

function restrictiveVisibility(values: StoryStateValueRecord['visibility'][]): StoryStateValueRecord['visibility'] {
  return values.reduce((current, value) => visibilityRank[value] > visibilityRank[current] ? value : current, 'public');
}

function uniqueValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = normalize(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function buildGraph(eventIds: string[], relations: RelationRow[]) {
  const groups = new UnionFind();
  const eventSet = new Set(eventIds);
  eventIds.forEach((id) => groups.add(id));
  relations
    .filter((relation) => relation.relation === 'simultaneous' && eventSet.has(relation.leftEventId) && eventSet.has(relation.rightEventId))
    .forEach((relation) => groups.union(relation.leftEventId, relation.rightEventId));
  const edges = new Map<string, Set<string>>();
  eventIds.forEach((id) => edges.set(groups.find(id), new Set()));
  for (const relation of relations) {
    if (!eventSet.has(relation.leftEventId) || !eventSet.has(relation.rightEventId)) continue;
    let from: string | null = null;
    let to: string | null = null;
    if (relation.relation === 'before') {
      from = groups.find(relation.leftEventId);
      to = groups.find(relation.rightEventId);
    } else if (relation.relation === 'after') {
      from = groups.find(relation.rightEventId);
      to = groups.find(relation.leftEventId);
    }
    if (from && to && from !== to) edges.get(from)?.add(to);
  }
  const reachability = new Map<string, Set<string>>();
  const reachable = (from: string, to: string): boolean => {
    if (from === to) return true;
    let cached = reachability.get(from);
    if (!cached) {
      cached = new Set<string>();
      const pending = [...(edges.get(from) ?? [])];
      while (pending.length) {
        const current = pending.pop()!;
        if (cached.has(current)) continue;
        cached.add(current);
        pending.push(...(edges.get(current) ?? []));
      }
      reachability.set(from, cached);
    }
    return cached.has(to);
  };
  return { groups, eventSet, reachable };
}

function aggregateFacts(rows: Array<Pick<FactRow, 'value' | 'visibility' | 'confidence' | 'evidenceCount'>>): AggregatedFact[] {
  const grouped = new Map<string, AggregatedFact>();
  for (const row of rows) {
    const key = normalize(row.value);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { value: row.value, visibility: row.visibility, confidence: Number(row.confidence), evidenceCount: Number(row.evidenceCount) });
      continue;
    }
    current.confidence = Math.max(current.confidence, Number(row.confidence));
    current.evidenceCount += Number(row.evidenceCount);
    current.visibility = restrictiveVisibility([current.visibility, row.visibility]);
  }
  return [...grouped.values()];
}

export class StoryStateService {
  constructor(private readonly store: ProjectStore) {}

  snapshot(entryEventId: string, identityId?: string, audience: 'editor' | 'public-entry' = 'editor'): StoryStateSnapshot {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const entry = db.prepare(`SELECT id, title, narrative_start_ordinal AS narrativeOrdinal
      FROM timeline_events WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`)
      .get(entryEventId, revisionId) as { id: string; title: string; narrativeOrdinal: number } | undefined;
    if (!entry) throw new Error('请先确认进入事件');
    const projection = audience === 'public-entry' ? new StoryKnowledgeProjection(db, revisionId, entryEventId) : null;
    const projectedFacts = projection?.facts(identityId);

    const identityRows = db.prepare(`SELECT id, canonical_name AS name, importance_tier AS importanceTier
      FROM person_identities WHERE revision_id = ? AND review_status != 'rejected' ${identityId ? 'AND id = ?' : ''}`)
      .all(...(identityId ? [revisionId, identityId] : [revisionId])) as IdentityRow[];
    if (identityId && !identityRows.length) throw new Error('找不到指定人物');

    const filterSql = identityId ? 'AND f.identity_id = ?' : '';
    const factRows = projectedFacts ?? db.prepare(`SELECT f.identity_id AS identityId, f.category, f.predicate, f.value, f.visibility,
      f.confidence, COUNT(e.id) AS evidenceCount
      FROM character_facts f
      LEFT JOIN character_fact_claim_metadata cfm ON cfm.fact_id = f.id
      LEFT JOIN character_fact_evidence e ON e.fact_id = f.id
      WHERE f.revision_id = ? AND f.review_status = 'confirmed'
        AND COALESCE(cfm.truth_status, 'asserted') = 'asserted' ${filterSql}
      GROUP BY f.id ORDER BY f.identity_id, f.category, f.predicate, f.value`)
      .all(...(identityId ? [revisionId, identityId] : [revisionId])) as FactRow[];

    const transitionFilterSql = identityId ? 'AND t.identity_id = ?' : '';
    const transitionRows = db.prepare(`SELECT t.id, t.identity_id AS identityId, t.category, t.predicate,
      t.from_value AS fromValue, t.to_value AS toValue, t.confidence, e.id AS triggerEventId
      FROM character_state_transitions t
      JOIN character_fact_relations r ON r.id = t.relation_id
      LEFT JOIN timeline_event_evidence v ON v.paragraph_id = t.trigger_paragraph_id
      LEFT JOIN timeline_events e ON e.id = v.event_id AND e.review_status = 'confirmed' AND e.revision_id = t.revision_id
      WHERE t.revision_id = ? AND r.review_status = 'confirmed' AND r.resolved_relation = 'state_change'
        AND EXISTS (SELECT 1 FROM character_fact_cluster_members cm JOIN character_facts cf ON cf.id = cm.fact_id
          LEFT JOIN character_fact_claim_metadata cfm ON cfm.fact_id = cf.id
          WHERE cm.cluster_id = t.from_cluster_id AND cf.review_status = 'confirmed'
            AND COALESCE(cfm.truth_status, 'asserted') = 'asserted')
        AND EXISTS (SELECT 1 FROM character_fact_cluster_members cm JOIN character_facts cf ON cf.id = cm.fact_id
          LEFT JOIN character_fact_claim_metadata cfm ON cfm.fact_id = cf.id
          WHERE cm.cluster_id = t.to_cluster_id AND cf.review_status = 'confirmed'
            AND COALESCE(cfm.truth_status, 'asserted') = 'asserted')
        ${transitionFilterSql}
      ORDER BY t.identity_id, t.predicate, t.observed_to_ordinal, t.id`)
      .all(...(identityId ? [revisionId, identityId] : [revisionId])) as TransitionRow[];

    const transitionsById = new Map<string, Transition>();
    const allowedTransitions = projection?.transitionIds(projectedFacts!);
    const maskedProperties = new Set((projection?.maskedTransitionProperties(allowedTransitions!) ?? [])
      .map((item) => propertyKey(item.identityId, item.category, item.predicate)));
    const allowedEvents = projection?.eventIds();
    for (const row of transitionRows) {
      if (allowedTransitions && !allowedTransitions.has(row.id)) continue;
      if (allowedEvents && row.triggerEventId && !allowedEvents.has(row.triggerEventId)) continue;
      const current = transitionsById.get(row.id) ?? { ...row, triggerEventIds: [] };
      if (row.triggerEventId && !current.triggerEventIds.includes(row.triggerEventId)) current.triggerEventIds.push(row.triggerEventId);
      transitionsById.set(row.id, current);
    }

    const eventRows = db.prepare(`SELECT id FROM timeline_events WHERE revision_id = ? AND review_status = 'confirmed'`)
      .all(revisionId) as Array<{ id: string }>;
    const relationRows = db.prepare(`SELECT r.left_event_id AS leftEventId, r.right_event_id AS rightEventId,
      COALESCE(d.resolved_relation, r.relation) AS relation
      FROM timeline_event_relations r LEFT JOIN timeline_event_relation_decisions d ON d.relation_id = r.id
      WHERE r.revision_id = ? AND r.review_status = 'confirmed'`)
      .all(revisionId) as RelationRow[];
    const graph = buildGraph(eventRows.map((event) => event.id).filter((id) => !allowedEvents || allowedEvents.has(id)), relationRows);
    const entryRoot = graph.groups.find(entry.id);

    const groups = new Map<string, PropertyGroup>();
    for (const row of factRows) {
      const key = propertyKey(row.identityId, row.category, row.predicate);
      const group = groups.get(key) ?? { identityId: row.identityId, category: row.category, predicate: row.predicate, facts: [], transitions: [] };
      group.facts.push({ value: row.value, visibility: row.visibility, confidence: Number(row.confidence), evidenceCount: Number(row.evidenceCount) });
      groups.set(key, group);
    }
    for (const transition of transitionsById.values()) {
      const key = propertyKey(transition.identityId, transition.category, transition.predicate);
      const group = groups.get(key) ?? { identityId: transition.identityId, category: transition.category, predicate: transition.predicate, facts: [], transitions: [] };
      group.transitions.push(transition);
      groups.set(key, group);
    }
    for (const group of groups.values()) group.facts = aggregateFacts(group.facts);

    const characterValues = new Map<string, StoryStateValueRecord[]>();
    for (const group of groups.values()) {
      const value: StoryStateValueRecord = maskedProperties.has(propertyKey(group.identityId, group.category, group.predicate))
        ? {
          category: group.category, predicate: group.predicate, value: null,
          alternatives: uniqueValues(group.facts.map((fact) => fact.value)), resolution: 'ambiguous',
          visibility: 'public', confidence: 0,
          evidenceCount: group.facts.reduce((sum, fact) => sum + fact.evidenceCount, 0),
          transitionId: null, triggerEventId: null,
          reason: '当前公开资料不足以完整核对状态变化，不能把已知旧值当作进入点的确定状态',
        }
        : this.resolveProperty(group, entryRoot, graph);
      const values = characterValues.get(group.identityId) ?? [];
      values.push(value);
      characterValues.set(group.identityId, values);
    }

    const importanceOrder: Record<ImportanceTier, number> = { core: 0, important: 1, minor: 2, incidental: 3, pending: 4 };
    const characters: StoryCharacterSnapshot[] = identityRows
      .filter((identity) => identityId !== undefined || (characterValues.get(identity.id)?.length ?? 0) > 0)
      .map((identity) => {
        const values = (characterValues.get(identity.id) ?? []).sort((left, right) => left.category.localeCompare(right.category) || left.predicate.localeCompare(right.predicate, 'zh-CN'));
        return {
          identityId: identity.id,
          identityName: identity.name,
          importanceTier: identity.importanceTier,
          values,
          resolvedCount: values.filter((value) => value.resolution !== 'ambiguous').length,
          ambiguousCount: values.filter((value) => value.resolution === 'ambiguous').length,
        };
      })
      .sort((left, right) => importanceOrder[left.importanceTier] - importanceOrder[right.importanceTier] || left.identityName.localeCompare(right.identityName, 'zh-CN'));

    return {
      entryEventId: entry.id,
      entryEventTitle: entry.title,
      entryNarrativeOrdinal: Number(entry.narrativeOrdinal),
      generatedAt: new Date().toISOString(),
      characters,
      resolvedValueCount: characters.reduce((sum, character) => sum + character.resolvedCount, 0),
      ambiguousValueCount: characters.reduce((sum, character) => sum + character.ambiguousCount, 0),
    };
  }

  private resolveProperty(
    group: PropertyGroup,
    entryRoot: string,
    graph: ReturnType<typeof buildGraph>,
  ): StoryStateValueRecord {
    const facts = aggregateFacts(group.facts);
    const alternatives = uniqueValues([
      ...facts.map((fact) => fact.value),
      ...group.transitions.flatMap((transition) => [transition.fromValue, transition.toValue]),
    ]);
    const fallbackVisibility = restrictiveVisibility(facts.map((fact) => fact.visibility));
    const fallbackConfidence = Math.max(0, ...facts.map((fact) => fact.confidence), ...group.transitions.map((transition) => transition.confidence));
    const ambiguous = (reason: string): StoryStateValueRecord => ({
      category: group.category,
      predicate: group.predicate,
      value: null,
      alternatives,
      resolution: 'ambiguous',
      visibility: fallbackVisibility,
      confidence: fallbackConfidence,
      evidenceCount: facts.reduce((sum, fact) => sum + fact.evidenceCount, 0),
      transitionId: null,
      triggerEventId: null,
      reason,
    });

    if (!group.transitions.length) {
      if (facts.length !== 1) return ambiguous('存在多个已确认值，但没有已确认的状态变化能够确定进入时刻的版本');
      const fact = facts[0];
      return {
        category: group.category,
        predicate: group.predicate,
        value: fact.value,
        alternatives: [],
        resolution: 'timeless',
        visibility: fact.visibility,
        confidence: fact.confidence,
        evidenceCount: fact.evidenceCount,
        transitionId: null,
        triggerEventId: null,
        reason: '该属性只有一个已确认值，当前没有已确认的时间变化',
      };
    }

    const classified = group.transitions.map((transition) => {
      if (!transition.triggerEventIds.length) return { transition, state: 'unknown' as const, roots: [] as string[] };
      const roots = uniqueValues(transition.triggerEventIds.map((eventId) => graph.groups.find(eventId)));
      const states = transition.triggerEventIds.map((eventId) => {
        if (!graph.eventSet.has(eventId)) return 'unknown';
        const root = graph.groups.find(eventId);
        const before = graph.reachable(root, entryRoot);
        const after = graph.reachable(entryRoot, root);
        if (root === entryRoot) return 'applied';
        if (before && !after) return 'applied';
        if (after && !before) return 'future';
        return 'unknown';
      });
      const state = states.every((item) => item === 'applied') ? 'applied'
        : states.every((item) => item === 'future') ? 'future' : 'unknown';
      return { transition, state, roots };
    });
    if (classified.some((item) => item.state === 'unknown')) {
      return ambiguous('至少一次状态变化缺少已确认触发事件，或与进入事件之间没有可靠先后关系');
    }

    const selectBoundary = (items: typeof classified, latest: boolean) => items.filter((candidate) => !items.some((other) => {
      if (other === candidate || candidate.roots.length !== 1 || other.roots.length !== 1) return false;
      return latest
        ? graph.reachable(candidate.roots[0], other.roots[0]) && candidate.roots[0] !== other.roots[0]
        : graph.reachable(other.roots[0], candidate.roots[0]) && candidate.roots[0] !== other.roots[0];
    }));
    const applied = classified.filter((item) => item.state === 'applied');
    const candidates = applied.length ? selectBoundary(applied, true) : selectBoundary(classified.filter((item) => item.state === 'future'), false);
    const candidateValues = uniqueValues(candidates.map((item) => applied.length ? item.transition.toValue : item.transition.fromValue));
    if (candidateValues.length !== 1 || candidates.some((item) => item.roots.length !== 1)) {
      return ambiguous(applied.length
        ? '有多次已经发生的状态变化，但确认的时间关系不足以判断哪一次最后生效'
        : '进入事件早于状态变化，但确认的时间关系不足以判断最早变化前的状态');
    }

    const selectedValue = candidateValues[0];
    const selected = candidates.find((item) => normalize(applied.length ? item.transition.toValue : item.transition.fromValue) === normalize(selectedValue))!;
    const matchingFact = facts.find((fact) => normalize(fact.value) === normalize(selectedValue));
    return {
      category: group.category,
      predicate: group.predicate,
      value: matchingFact?.value ?? selectedValue,
      alternatives: [],
      resolution: applied.length ? 'effective_after_transition' : 'effective_before_transition',
      visibility: matchingFact?.visibility ?? fallbackVisibility,
      confidence: matchingFact ? Math.min(matchingFact.confidence, selected.transition.confidence) : selected.transition.confidence,
      evidenceCount: matchingFact?.evidenceCount ?? 0,
      transitionId: selected.transition.id,
      triggerEventId: selected.transition.triggerEventIds[0] ?? null,
      reason: applied.length
        ? '已确认状态变化的触发事件不晚于进入事件，因此采用变化后的值'
        : '已确认状态变化发生在进入事件之后，因此采用变化前的值',
    };
  }
}
