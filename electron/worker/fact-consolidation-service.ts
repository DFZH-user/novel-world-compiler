import { createHash } from 'node:crypto';
import type {
  CharacterFactRecord,
  CharacterStateTransitionRecord,
  FactClusterRecord,
  FactConsolidationSummary,
  FactRelationKind,
  FactRelationRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizeFactText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\u3000\p{P}\p{S}]+/gu, '');
}

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type FactRow = {
  id: string;
  identityId: string;
  category: CharacterFactRecord['category'];
  predicate: string;
  value: string;
  confidence: number;
  reviewStatus: CharacterFactRecord['reviewStatus'];
  assertionMode: CharacterFactRecord['assertionMode'];
  truthStatus: CharacterFactRecord['truthStatus'];
  validFromOrdinal: number | null;
  validToOrdinal: number | null;
  observedOrdinal: number | null;
};

type ClusterBuild = {
  id: string;
  identityId: string;
  category: CharacterFactRecord['category'];
  predicate: string;
  value: string;
  normalizedPredicate: string;
  normalizedValue: string;
  firstObservedOrdinal: number | null;
  lastObservedOrdinal: number | null;
  validFromOrdinal: number | null;
  validToOrdinal: number | null;
  members: FactRow[];
};

const VOLATILE_PREDICATE = /状态|位置|地点|所在|阵营|身份|职业|等级|境界|伤势|健康|生死|年龄|关系|态度|目标|所属/u;

export class FactConsolidationService {
  constructor(private readonly store: ProjectStore) {}

  consolidate(): FactConsolidationSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const timestamp = now();
    const facts = db.prepare(`SELECT f.id, f.identity_id AS identityId, f.category, f.predicate, f.value, f.confidence,
      f.review_status AS reviewStatus, COALESCE(m.assertion_mode, CASE WHEN f.source_type = 'inferred' THEN 'behavior_inference' ELSE 'narrator_assertion' END) AS assertionMode,
      COALESCE(m.truth_status, 'asserted') AS truthStatus, f.valid_from_ordinal AS validFromOrdinal,
      f.valid_to_ordinal AS validToOrdinal, MIN(p.ordinal) AS observedOrdinal
      FROM character_facts f LEFT JOIN character_fact_claim_metadata m ON m.fact_id = f.id
      LEFT JOIN character_fact_evidence e ON e.fact_id = f.id LEFT JOIN paragraphs p ON p.id = e.paragraph_id
      WHERE f.revision_id = ? AND f.review_status != 'rejected' GROUP BY f.id`)
      .all(revisionId) as unknown as FactRow[];
    const grouped = new Map<string, FactRow[]>();
    for (const fact of facts) {
      const normalizedPredicate = normalizeFactText(fact.predicate);
      const normalizedValue = normalizeFactText(fact.value);
      if (!normalizedPredicate || !normalizedValue) continue;
      const key = `${fact.identityId}:${fact.category}:${normalizedPredicate}:${normalizedValue}`;
      const values = grouped.get(key) ?? [];
      values.push(fact);
      grouped.set(key, values);
    }
    const clusters: ClusterBuild[] = [];
    for (const members of grouped.values()) {
      members.sort((left, right) => Number(right.reviewStatus === 'confirmed') - Number(left.reviewStatus === 'confirmed')
        || Number(right.confidence) - Number(left.confidence) || String(left.id).localeCompare(String(right.id)));
      const canonical = members[0];
      const normalizedPredicate = normalizeFactText(canonical.predicate);
      const normalizedValue = normalizeFactText(canonical.value);
      const observed = members.map((fact) => fact.observedOrdinal).filter((value): value is number => value !== null).map(Number);
      const validFrom = members.map((fact) => fact.validFromOrdinal).filter((value): value is number => value !== null).map(Number);
      const validTo = members.map((fact) => fact.validToOrdinal).filter((value): value is number => value !== null).map(Number);
      clusters.push({
        id: `cfc_${hash(`${revisionId}:${canonical.identityId}:${canonical.category}:${normalizedPredicate}:${normalizedValue}`).slice(0, 32)}`,
        identityId: canonical.identityId, category: canonical.category, predicate: canonical.predicate, value: canonical.value,
        normalizedPredicate, normalizedValue, firstObservedOrdinal: observed.length ? Math.min(...observed) : null,
        lastObservedOrdinal: observed.length ? Math.max(...observed) : null,
        validFromOrdinal: validFrom.length ? Math.min(...validFrom) : null, validToOrdinal: validTo.length ? Math.max(...validTo) : null,
        members,
      });
    }

    withTransaction(db, () => {
      db.prepare(`DELETE FROM character_fact_cluster_members WHERE fact_id IN
        (SELECT id FROM character_facts WHERE revision_id = ? AND review_status = 'rejected')`).run(revisionId);
      for (const cluster of clusters) {
        db.prepare(`INSERT INTO character_fact_clusters
          (id, revision_id, identity_id, category, canonical_predicate, canonical_value, normalized_predicate,
           normalized_value, first_observed_ordinal, last_observed_ordinal, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(revision_id, identity_id, category, normalized_predicate, normalized_value) DO UPDATE SET
            canonical_predicate = excluded.canonical_predicate, canonical_value = excluded.canonical_value,
            first_observed_ordinal = excluded.first_observed_ordinal, last_observed_ordinal = excluded.last_observed_ordinal,
            updated_at = excluded.updated_at`)
          .run(cluster.id, revisionId, cluster.identityId, cluster.category, cluster.predicate, cluster.value,
            cluster.normalizedPredicate, cluster.normalizedValue, cluster.firstObservedOrdinal, cluster.lastObservedOrdinal, timestamp, timestamp);
        for (const fact of cluster.members) db.prepare(`INSERT OR IGNORE INTO character_fact_cluster_members
          (cluster_id, fact_id, membership_method, created_at) VALUES (?, ?, 'exact_normalized', ?)`)
          .run(cluster.id, fact.id, timestamp);
      }

      const byPredicate = new Map<string, ClusterBuild[]>();
      for (const cluster of clusters) {
        const key = `${cluster.identityId}:${cluster.category}:${cluster.normalizedPredicate}`;
        const values = byPredicate.get(key) ?? [];
        values.push(cluster);
        byPredicate.set(key, values);
      }
      for (const values of byPredicate.values()) {
        values.sort((left, right) => (left.firstObservedOrdinal ?? Number.MAX_SAFE_INTEGER) - (right.firstObservedOrdinal ?? Number.MAX_SAFE_INTEGER)
          || left.id.localeCompare(right.id));
        for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
            const left = values[leftIndex];
            const right = values[rightIndex];
            const proposal = this.proposeRelation(left, right);
            const relationId = `cfr_${hash(`${left.id}:${right.id}`).slice(0, 32)}`;
            db.prepare(`INSERT OR IGNORE INTO character_fact_relations
              (id, revision_id, identity_id, left_cluster_id, right_cluster_id, proposed_relation, confidence, reason, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(relationId, revisionId, left.identityId, left.id, right.id, proposal.relation, proposal.confidence, proposal.reason, timestamp, timestamp);
          }
        }
      }
    });
    return this.summary(db, revisionId);
  }

  listClusters(identityId?: string): FactClusterRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const filter = identityId ? 'AND c.identity_id = ?' : '';
    const params = identityId ? [revisionId, identityId] : [revisionId];
    return db.prepare(`SELECT c.id, c.identity_id AS identityId, i.canonical_name AS identityName, c.category,
      c.canonical_predicate AS canonicalPredicate, c.canonical_value AS canonicalValue,
      c.first_observed_ordinal AS firstObservedOrdinal, c.last_observed_ordinal AS lastObservedOrdinal,
      c.review_status AS reviewStatus, COUNT(f.id) AS memberCount,
      SUM(CASE WHEN f.review_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmedMemberCount
      FROM character_fact_clusters c JOIN person_identities i ON i.id = c.identity_id
      JOIN character_fact_cluster_members cm ON cm.cluster_id = c.id JOIN character_facts f ON f.id = cm.fact_id AND f.review_status != 'rejected'
      WHERE c.revision_id = ? ${filter} GROUP BY c.id ORDER BY i.canonical_name, c.category, c.canonical_predicate, c.first_observed_ordinal`)
      .all(...params) as unknown as FactClusterRecord[];
  }

  listClusterMembers(clusterId: string): CharacterFactRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT f.id, f.identity_id AS identityId, f.category, f.predicate, f.value,
      f.source_type AS sourceType, f.confidence, f.visibility, f.valid_from_ordinal AS validFromOrdinal,
      f.valid_to_ordinal AS validToOrdinal, f.review_status AS reviewStatus, f.reasoning_note AS reasoningNote,
      COALESCE(m.assertion_mode, CASE WHEN f.source_type = 'inferred' THEN 'behavior_inference' ELSE 'narrator_assertion' END) AS assertionMode,
      COALESCE(m.truth_status, 'asserted') AS truthStatus, m.attributed_source_name AS attributedSourceName,
      COALESCE(m.extraction_pass, 1) AS extractionPass, COUNT(e.id) AS evidenceCount
      FROM character_fact_cluster_members cm JOIN character_fact_clusters c ON c.id = cm.cluster_id
      JOIN character_facts f ON f.id = cm.fact_id LEFT JOIN character_fact_claim_metadata m ON m.fact_id = f.id
      LEFT JOIN character_fact_evidence e ON e.fact_id = f.id
      WHERE cm.cluster_id = ? AND c.revision_id = ? GROUP BY f.id ORDER BY f.review_status = 'rejected', f.confidence DESC`)
      .all(clusterId, revisionId) as unknown as CharacterFactRecord[];
  }

  listRelations(identityId?: string): FactRelationRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const filter = identityId ? 'AND r.identity_id = ?' : '';
    const params = identityId ? [revisionId, identityId] : [revisionId];
    return db.prepare(`SELECT r.id, r.identity_id AS identityId, i.canonical_name AS identityName, l.category,
      l.canonical_predicate AS predicate, r.left_cluster_id AS leftClusterId, l.canonical_value AS leftValue,
      l.first_observed_ordinal AS leftObservedOrdinal, r.right_cluster_id AS rightClusterId,
      rr.canonical_value AS rightValue, rr.first_observed_ordinal AS rightObservedOrdinal,
      r.proposed_relation AS proposedRelation, r.resolved_relation AS resolvedRelation, r.confidence, r.reason,
      r.review_status AS reviewStatus FROM character_fact_relations r JOIN person_identities i ON i.id = r.identity_id
      JOIN character_fact_clusters l ON l.id = r.left_cluster_id JOIN character_fact_clusters rr ON rr.id = r.right_cluster_id
      WHERE r.revision_id = ? ${filter}
      AND EXISTS (SELECT 1 FROM character_fact_cluster_members cm JOIN character_facts f ON f.id = cm.fact_id WHERE cm.cluster_id = l.id AND f.review_status != 'rejected')
      AND EXISTS (SELECT 1 FROM character_fact_cluster_members cm JOIN character_facts f ON f.id = cm.fact_id WHERE cm.cluster_id = rr.id AND f.review_status != 'rejected')
      ORDER BY r.review_status = 'rejected', r.review_status = 'confirmed' DESC, i.canonical_name, l.canonical_predicate, l.first_observed_ordinal`)
      .all(...params) as unknown as FactRelationRecord[];
  }

  reviewRelation(relationId: string, status: FactRelationRecord['reviewStatus'], resolvedRelation?: Exclude<FactRelationKind, 'uncertain'>): FactRelationRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const relation = db.prepare(`SELECT r.id, r.identity_id AS identityId, r.proposed_relation AS proposedRelation,
      r.left_cluster_id AS leftClusterId, r.right_cluster_id AS rightClusterId, r.confidence,
      l.category, l.canonical_predicate AS predicate, l.canonical_value AS leftValue,
      l.first_observed_ordinal AS leftObservedOrdinal, rr.canonical_value AS rightValue,
      rr.first_observed_ordinal AS rightObservedOrdinal FROM character_fact_relations r
      JOIN character_fact_clusters l ON l.id = r.left_cluster_id JOIN character_fact_clusters rr ON rr.id = r.right_cluster_id
      WHERE r.id = ? AND r.revision_id = ?`).get(relationId, revisionId) as Record<string, string | number | null> | undefined;
    if (!relation) throw new Error('找不到该事实关系候选');
    const proposed = String(relation.proposedRelation) as FactRelationKind;
    const chosen = resolvedRelation ?? (proposed === 'uncertain' ? undefined : proposed);
    if (status === 'confirmed' && !chosen) throw new Error('请先选择这两条事实之间的关系类型');
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare(`UPDATE character_fact_relations SET review_status = ?, resolved_relation = ?, updated_at = ? WHERE id = ?`)
        .run(status, status === 'confirmed' ? chosen : null, timestamp, relationId);
      db.prepare('DELETE FROM character_state_transitions WHERE relation_id = ?').run(relationId);
      if (status === 'confirmed' && chosen === 'state_change') {
        const trigger = db.prepare(`SELECT e.paragraph_id AS paragraphId FROM character_fact_cluster_members cm
          JOIN character_fact_evidence e ON e.fact_id = cm.fact_id JOIN paragraphs p ON p.id = e.paragraph_id
          WHERE cm.cluster_id = ? ORDER BY p.ordinal LIMIT 1`).get(String(relation.rightClusterId)) as { paragraphId: string } | undefined;
        db.prepare(`INSERT INTO character_state_transitions
          (id, revision_id, identity_id, relation_id, category, predicate, from_cluster_id, to_cluster_id,
           from_value, to_value, observed_from_ordinal, observed_to_ordinal, trigger_paragraph_id, confidence, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`cst_${hash(relationId).slice(0, 32)}`, revisionId, relation.identityId, relationId, relation.category,
            relation.predicate, relation.leftClusterId, relation.rightClusterId, relation.leftValue, relation.rightValue,
            relation.leftObservedOrdinal, relation.rightObservedOrdinal, trigger?.paragraphId ?? null, relation.confidence, timestamp, timestamp);
      }
    });
    return this.listRelations(String(relation.identityId));
  }

  listTransitions(identityId?: string): CharacterStateTransitionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const filter = identityId ? 'AND t.identity_id = ?' : '';
    const params = identityId ? [revisionId, identityId] : [revisionId];
    return db.prepare(`SELECT t.id, t.identity_id AS identityId, i.canonical_name AS identityName, t.category, t.predicate,
      t.from_value AS fromValue, t.to_value AS toValue, t.observed_from_ordinal AS observedFromOrdinal,
      t.observed_to_ordinal AS observedToOrdinal, t.trigger_paragraph_id AS triggerParagraphId, t.confidence
      FROM character_state_transitions t JOIN person_identities i ON i.id = t.identity_id
      WHERE t.revision_id = ? ${filter} ORDER BY i.canonical_name, t.observed_to_ordinal, t.predicate`)
      .all(...params) as unknown as CharacterStateTransitionRecord[];
  }

  private proposeRelation(left: ClusterBuild, right: ClusterBuild): { relation: FactRelationKind; confidence: number; reason: string } {
    if (left.validToOrdinal !== null && right.validFromOrdinal !== null && left.validToOrdinal < right.validFromOrdinal) {
      return { relation: 'coexists_by_time', confidence: 0.9, reason: '两条事实带有不重叠的明确生效区间，可能分别适用于不同剧情阶段' };
    }
    const leftSourceClaim = left.members.some((fact) => ['rumor', 'other_report', 'belief'].includes(fact.assertionMode) || fact.truthStatus !== 'asserted');
    const rightNarrator = right.members.some((fact) => fact.assertionMode === 'narrator_assertion' && fact.truthStatus === 'asserted');
    if (leftSourceClaim && rightNarrator && (left.firstObservedOrdinal ?? 0) <= (right.firstObservedOrdinal ?? Number.MAX_SAFE_INTEGER)) {
      return { relation: 'rumor_correction', confidence: 0.82, reason: '较早信息来自传闻、他人陈述或存疑主张，较晚信息由旁白明确断言' };
    }
    if (left.category === 'status' || VOLATILE_PREDICATE.test(left.predicate)) {
      return { relation: 'state_change', confidence: 0.72, reason: '同一可变属性在不同原文位置出现不同值，可能是人物状态随剧情变化' };
    }
    return { relation: 'uncertain', confidence: 0.45, reason: '同一规范属性出现不同值；可能是矛盾、多值属性、观点差异或状态变化，需要人工判断' };
  }

  private summary(db: SQLiteDatabase, revisionId: string): FactConsolidationSummary {
    const row = db.prepare(`SELECT
      (SELECT COUNT(*) FROM character_fact_clusters c WHERE c.revision_id = ? AND EXISTS
        (SELECT 1 FROM character_fact_cluster_members cm JOIN character_facts f ON f.id = cm.fact_id WHERE cm.cluster_id = c.id AND f.review_status != 'rejected')) AS clusterCount,
      (SELECT COUNT(*) FROM character_fact_cluster_members cm JOIN character_facts f ON f.id = cm.fact_id WHERE f.revision_id = ? AND f.review_status != 'rejected') AS memberCount,
      (SELECT COUNT(*) FROM character_fact_relations WHERE revision_id = ? AND review_status = 'pending') AS pendingRelationCount,
      (SELECT COUNT(*) FROM character_state_transitions WHERE revision_id = ?) AS transitionCount`)
      .get(revisionId, revisionId, revisionId, revisionId) as Record<string, number>;
    return { clusterCount: Number(row.clusterCount), memberCount: Number(row.memberCount), pendingRelationCount: Number(row.pendingRelationCount), transitionCount: Number(row.transitionCount) };
  }
}
