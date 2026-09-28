import type {
  CharacterRuntimeRetrievalItem,
  CharacterRuntimeRetrievalTrace,
} from '../../src/shared/contracts';
import { literalFtsPhrase } from './full-text-search';
import type { SQLiteDatabase } from './sqlite-db';

export const CHARACTER_RUNTIME_RETRIEVAL_VERSION = 'character-runtime-retrieval.v1' as const;
export const CHARACTER_RUNTIME_RETRIEVAL_BUDGET = 600;

type Candidate = Omit<CharacterRuntimeRetrievalItem, 'rank' | 'approxTokens'> & { score: number };
type NamedEntity = { id: string; name: string; kind: 'person' | 'place'; firstOrdinal: number | null };

const stopTerms = new Set(['什么', '怎么', '为什么', '可以', '是否', '一个', '这个', '那个', '还是', '现在', '然后', '我们', '你们', '他们']);

function chars(value: string): string[] { return Array.from(value.normalize('NFKC')); }
function approxTokens(value: string): number {
  const units = chars(value);
  const han = units.filter((item) => /\p{Script=Han}/u.test(item)).length;
  return Math.max(1, Math.ceil(han / 1.2 + (units.length - han) / 4));
}
function clip(value: string, limit = 560): string {
  const units = chars(value.trim());
  return units.length <= limit ? units.join('') : `${units.slice(0, limit).join('')}……`;
}
function includesTerm(value: string, term: string): boolean {
  return value.normalize('NFKC').toLocaleLowerCase().includes(term.toLocaleLowerCase());
}
function baseTerms(question: string): string[] {
  const normalized = question.normalize('NFKC');
  const result: string[] = [];
  const push = (term: string) => {
    const clean = term.trim();
    if (chars(clean).length < 2 || stopTerms.has(clean) || result.includes(clean)) return;
    result.push(clean);
  };
  for (const match of normalized.matchAll(/[“「『"']([^”」』"']{2,20})[”」』"']/gu)) push(match[1]);
  for (const segment of normalized.match(/[\p{Script=Han}A-Za-z0-9]{2,12}/gu) ?? []) {
    push(segment);
    if (chars(segment).length > 6) {
      const units = chars(segment);
      for (let index = 0; index <= units.length - 3; index += 2) push(units.slice(index, index + 3).join(''));
    }
  }
  return result.slice(0, 12);
}

function entityLexicon(db: SQLiteDatabase, revisionId: string, entryOrdinal: number): NamedEntity[] {
  const people = db.prepare(`SELECT i.id, i.canonical_name AS name, 'person' AS kind, NULL AS firstOrdinal
    FROM person_identities i WHERE i.revision_id = ? AND i.review_status = 'confirmed'
    UNION ALL
    SELECT a.identity_id AS id, a.alias AS name, 'person' AS kind, p.ordinal AS firstOrdinal
    FROM person_aliases a JOIN person_identities i ON i.id = a.identity_id
    LEFT JOIN paragraphs p ON p.id = a.evidence_paragraph_id
    WHERE a.revision_id = ? AND a.review_status = 'confirmed' AND i.review_status = 'confirmed'
      AND (p.ordinal IS NULL OR p.ordinal <= ?)`)
    .all(revisionId, revisionId, entryOrdinal) as NamedEntity[];
  const places = db.prepare(`SELECT p.id, p.canonical_name AS name, 'place' AS kind, p.first_revealed_ordinal AS firstOrdinal
    FROM place_identities p WHERE p.revision_id = ? AND p.review_status = 'confirmed'
      AND p.first_revealed_ordinal <= ?
    UNION ALL
    SELECT a.place_id AS id, a.alias AS name, 'place' AS kind, p.first_revealed_ordinal AS firstOrdinal
    FROM place_aliases a JOIN place_identities p ON p.id = a.place_id
    WHERE p.revision_id = ? AND p.review_status = 'confirmed' AND a.review_status = 'confirmed'
      AND p.first_revealed_ordinal <= ?`)
    .all(revisionId, entryOrdinal, revisionId, entryOrdinal) as NamedEntity[];
  return [...people, ...places];
}

function paragraphCandidates(
  db: SQLiteDatabase,
  revisionId: string,
  entryOrdinal: number,
  terms: string[],
  entityTerms: Set<string>,
): Candidate[] {
  const rows = new Map<string, Candidate>();
  for (const term of terms.slice(0, 10)) {
    const units = chars(term);
    const query = units.length >= 3
      ? `SELECT p.id AS sourceId, p.ordinal AS sourceOrdinal, COALESCE(c.title, '原文') AS title, p.text AS content
          FROM paragraph_fts f JOIN paragraphs p ON p.id = f.paragraph_id
          LEFT JOIN chapters c ON c.id = p.chapter_id LEFT JOIN paragraph_exclusions x ON x.paragraph_id = p.id
          WHERE paragraph_fts MATCH ? AND p.revision_id = ? AND p.ordinal <= ?
            AND instr(p.text, ?) > 0 AND COALESCE(x.excluded, 0) = 0 ORDER BY p.ordinal DESC LIMIT 3`
      : `SELECT p.id AS sourceId, p.ordinal AS sourceOrdinal, COALESCE(c.title, '原文') AS title, p.text AS content
          FROM paragraphs p LEFT JOIN chapters c ON c.id = p.chapter_id
          LEFT JOIN paragraph_exclusions x ON x.paragraph_id = p.id
          WHERE p.revision_id = ? AND p.ordinal <= ? AND instr(p.text, ?) > 0
            AND COALESCE(x.excluded, 0) = 0 ORDER BY p.ordinal DESC LIMIT 3`;
    const values = units.length >= 3
      ? [literalFtsPhrase(term), revisionId, entryOrdinal, term]
      : [revisionId, entryOrdinal, term];
    const hits = db.prepare(query).all(...values) as Array<{ sourceId: string; sourceOrdinal: number; title: string; content: string }>;
    for (const hit of hits) {
      const existing = rows.get(hit.sourceId);
      const matchedTerms = [...new Set([...(existing?.matchedTerms ?? []), term])];
      rows.set(hit.sourceId, {
        kind: 'paragraph', sourceId: hit.sourceId, sourceOrdinal: hit.sourceOrdinal,
        title: `${hit.title} · 段落 ${hit.sourceOrdinal}`, content: clip(hit.content), matchedTerms,
        reason: `${entityTerms.has(term) ? '问题提到已确认实体' : '问题关键词'}“${term}”命中进入点之前的原文`,
        score: (existing?.score ?? 0) + (entityTerms.has(term) ? 80 : 35),
      });
    }
  }
  return [...rows.values()];
}

function structuredCandidates(
  db: SQLiteDatabase,
  revisionId: string,
  identityId: string,
  entryOrdinal: number,
  question: string,
  terms: string[],
  entities: NamedEntity[],
): Candidate[] {
  const candidates: Candidate[] = [];
  const personIds = new Set(entities.filter((item) => item.kind === 'person' && includesTerm(question, item.name)).map((item) => item.id));
  personIds.add(identityId);
  const factRows = db.prepare(`SELECT f.id AS sourceId, f.identity_id AS identityId, i.canonical_name AS identityName,
      f.category, f.predicate, f.value, MIN(p.ordinal) AS sourceOrdinal
    FROM character_facts f JOIN person_identities i ON i.id = f.identity_id
    LEFT JOIN character_fact_claim_metadata m ON m.fact_id = f.id
    JOIN character_fact_evidence e ON e.fact_id = f.id AND e.evidence_role = 'support'
      AND e.alignment_status IN ('exact','normalized')
    JOIN paragraphs p ON p.id = e.paragraph_id AND p.revision_id = f.revision_id
    WHERE f.revision_id = ? AND f.review_status = 'confirmed' AND f.visibility = 'public'
      AND COALESCE(m.truth_status, 'asserted') = 'asserted' AND p.ordinal <= ?
      AND f.identity_id IN (SELECT value FROM json_each(?))
    GROUP BY f.id ORDER BY MIN(p.ordinal) DESC LIMIT 80`)
    .all(revisionId, entryOrdinal, JSON.stringify([...personIds])) as Array<{
      sourceId: string; identityId: string; identityName: string; category: string;
      predicate: string; value: string; sourceOrdinal: number;
    }>;
  for (const row of factRows) {
    const content = `${row.identityName}｜${row.predicate}：${row.value}`;
    const matched = terms.filter((term) => includesTerm(content, term));
    const identityQuestion = row.identityId === identityId && /谁|身份|职业|做什么|情况/u.test(question);
    if (!matched.length && !identityQuestion) continue;
    candidates.push({
      kind: 'fact', sourceId: row.sourceId, sourceOrdinal: row.sourceOrdinal,
      title: `已确认事实 · ${row.identityName}`, content, matchedTerms: matched,
      reason: matched.length ? `问题关键词命中已确认事实：${matched.join('、')}` : '问题询问当前人物身份或状态',
      score: 120 + matched.length * 20,
    });
  }

  const relationshipRows = db.prepare(`SELECT r.id AS sourceId, r.source_identity_id AS sourceIdentityId,
      r.target_identity_id AS targetIdentityId, s.canonical_name AS sourceName, t.canonical_name AS targetName,
      r.relationship_type AS relationshipType, r.first_revealed_ordinal AS sourceOrdinal,
      (SELECT e.exact_quote FROM character_relationship_evidence e JOIN paragraphs p ON p.id = e.paragraph_id
        WHERE e.relationship_id = r.id AND p.ordinal <= ? AND e.evidence_role != 'contradict'
        ORDER BY p.ordinal LIMIT 1) AS evidence
    FROM character_relationships r JOIN person_identities s ON s.id = r.source_identity_id
    JOIN person_identities t ON t.id = r.target_identity_id
    WHERE r.revision_id = ? AND r.review_status = 'confirmed' AND r.truth_status = 'asserted'
      AND r.first_revealed_ordinal <= ? AND (r.valid_from_ordinal IS NULL OR r.valid_from_ordinal <= ?)
      AND (r.valid_to_ordinal IS NULL OR r.valid_to_ordinal >= ?)
      AND (r.source_identity_id = ? OR r.target_identity_id = ?)`)
    .all(entryOrdinal, revisionId, entryOrdinal, entryOrdinal, entryOrdinal, identityId, identityId) as Array<{
      sourceId: string; sourceIdentityId: string; targetIdentityId: string; sourceName: string;
      targetName: string; relationshipType: string; sourceOrdinal: number; evidence: string | null;
    }>;
  for (const row of relationshipRows) {
    const otherId = row.sourceIdentityId === identityId ? row.targetIdentityId : row.sourceIdentityId;
    const content = `${row.sourceName} —${row.relationshipType}— ${row.targetName}${row.evidence ? `；证据：${row.evidence}` : ''}`;
    const matched = terms.filter((term) => includesTerm(content, term));
    if (!personIds.has(otherId) && !matched.length && !/关系|认识|朋友|敌人|同伴/u.test(question)) continue;
    candidates.push({
      kind: 'relationship', sourceId: row.sourceId, sourceOrdinal: row.sourceOrdinal,
      title: '一跳确认关系', content: clip(content), matchedTerms: matched,
      reason: personIds.has(otherId) ? '问题提到相关人物，命中与当前人物的一跳确认关系' : '关系类问题命中当前人物的一跳确认关系',
      score: 150 + matched.length * 20,
    });
  }

  const placeIds = [...new Set(entities.filter((item) => item.kind === 'place' && includesTerm(question, item.name)).map((item) => item.id))];
  if (placeIds.length) {
    const places = db.prepare(`SELECT p.id AS sourceId, p.canonical_name AS name, p.place_type AS placeType,
      p.description, p.first_revealed_ordinal AS sourceOrdinal
      FROM place_identities p WHERE p.revision_id = ? AND p.review_status = 'confirmed'
        AND p.first_revealed_ordinal <= ? AND p.id IN (SELECT value FROM json_each(?))`)
      .all(revisionId, entryOrdinal, JSON.stringify(placeIds)) as Array<{
        sourceId: string; name: string; placeType: string; description: string; sourceOrdinal: number;
      }>;
    for (const row of places) candidates.push({
      kind: 'place', sourceId: row.sourceId, sourceOrdinal: row.sourceOrdinal,
      title: `已确认地点 · ${row.name}`, content: `${row.name}（${row.placeType}）${row.description ? `：${row.description}` : ''}`,
      matchedTerms: entities.filter((item) => item.id === row.sourceId && includesTerm(question, item.name)).map((item) => item.name),
      reason: '问题提到进入点之前已经公开的确认地点', score: 110,
    });
  }
  return candidates;
}

export function retrieveCharacterRuntimeContext(input: {
  db: SQLiteDatabase;
  revisionId: string;
  identityId: string;
  entryOrdinal: number;
  question: string;
  budgetTokens?: number;
}): CharacterRuntimeRetrievalTrace {
  const budgetTokens = Math.min(1_200, Math.max(120, Math.trunc(input.budgetTokens ?? CHARACTER_RUNTIME_RETRIEVAL_BUDGET)));
  const entities = entityLexicon(input.db, input.revisionId, input.entryOrdinal);
  const matchedEntities = entities.filter((item) => includesTerm(input.question, item.name));
  const entityTerms = new Set(matchedEntities.map((item) => item.name));
  const terms = [...new Set([...entityTerms, ...baseTerms(input.question)])].slice(0, 16);
  const candidates = [
    ...structuredCandidates(input.db, input.revisionId, input.identityId, input.entryOrdinal, input.question, terms, entities),
    ...paragraphCandidates(input.db, input.revisionId, input.entryOrdinal, terms, entityTerms),
  ].sort((left, right) => right.score - left.score || (right.sourceOrdinal ?? -1) - (left.sourceOrdinal ?? -1) || left.sourceId.localeCompare(right.sourceId));
  const seen = new Set<string>();
  const selected: CharacterRuntimeRetrievalItem[] = [];
  let used = 0;
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const itemTokens = approxTokens(`${candidate.title}\n${candidate.content}\n${candidate.reason}`);
    if (selected.length >= 8 || used + itemTokens > budgetTokens) continue;
    used += itemTokens;
    selected.push({
      rank: selected.length + 1, kind: candidate.kind, sourceId: candidate.sourceId,
      sourceOrdinal: candidate.sourceOrdinal, title: candidate.title, content: candidate.content,
      reason: candidate.reason, matchedTerms: candidate.matchedTerms, approxTokens: itemTokens,
    });
  }
  return {
    version: CHARACTER_RUNTIME_RETRIEVAL_VERSION,
    query: input.question,
    entryOrdinal: input.entryOrdinal,
    budgetTokens,
    approxTokens: used,
    candidateCount: seen.size,
    omittedCount: Math.max(0, seen.size - selected.length),
    items: selected,
  };
}
