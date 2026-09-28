import type { SQLiteDatabase } from './sqlite-db';

export const CHARACTER_LITERAL_METRICS_VERSION = 'literal-v1';

export function characterLiteralMetricsVersionKey(revisionId: string): string {
  return `character_literal_metrics_version:${revisionId}`;
}

export function invalidateCharacterLiteralMetrics(db: SQLiteDatabase, revisionId: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(characterLiteralMetricsVersionKey(revisionId));
}

export type CharacterLiteralMetric = {
  mentionCount: number;
  chapterCount: number;
  firstOrdinal: number;
  lastOrdinal: number;
};

type IdentityFormRow = {
  identityId: string;
  surface: string;
  normalizedSurface: string;
};

type ParagraphRow = {
  chapterId: string | null;
  ordinal: number;
  text: string;
};

type MutableMetric = {
  mentionCount: number;
  chapterIds: Set<string>;
  firstOrdinal: number;
  lastOrdinal: number;
};

function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Counts conservative, unambiguous name mentions across the active source text.
 * Canonical names are eligible; aliases only after review and only when they are
 * proper-name-like. Shared, one-character and generic title forms are excluded.
 */
export function calculateCharacterLiteralMetrics(
  db: SQLiteDatabase,
  revisionId: string,
): Map<string, CharacterLiteralMetric> {
  const rows = db.prepare(`SELECT i.id AS identityId, i.canonical_name AS surface, i.normalized_name AS normalizedSurface
    FROM person_identities i
    WHERE i.revision_id = ? AND i.review_status != 'rejected'
    UNION ALL
    SELECT i.id, a.alias, a.normalized_alias
    FROM person_aliases a JOIN person_identities i ON i.id = a.identity_id
    WHERE a.revision_id = ? AND a.review_status = 'confirmed' AND a.alias_type IN ('name', 'alias')
      AND i.review_status != 'rejected'`)
    .all(revisionId, revisionId) as IdentityFormRow[];

  const formOwners = new Map<string, Set<string>>();
  for (const row of rows) {
    const surface = row.surface.trim();
    const normalized = row.normalizedSurface.trim();
    if (!normalized || codePointLength(surface) < 2) continue;
    const owners = formOwners.get(normalized) ?? new Set<string>();
    owners.add(row.identityId);
    formOwners.set(normalized, owners);
  }

  const seen = new Set<string>();
  const forms = rows.flatMap((row) => {
    const surface = row.surface.trim();
    const normalized = row.normalizedSurface.trim();
    if (!normalized || codePointLength(surface) < 2 || formOwners.get(normalized)?.size !== 1) return [];
    const key = `${row.identityId}\0${surface}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ identityId: row.identityId, surface }];
  });

  const paragraphs = db.prepare(`SELECT p.chapter_id AS chapterId, p.ordinal, p.text
    FROM paragraphs p LEFT JOIN paragraph_exclusions e ON e.paragraph_id = p.id
    WHERE p.revision_id = ? AND COALESCE(e.excluded, 0) = 0 ORDER BY p.ordinal`)
    .all(revisionId) as ParagraphRow[];
  const metrics = new Map<string, MutableMetric>();

  for (const paragraph of paragraphs) {
    const occurrences: Array<{ identityId: string; start: number; end: number }> = [];
    const occurrenceKeys = new Set<string>();
    for (const form of forms) {
      for (let start = paragraph.text.indexOf(form.surface); start >= 0;
        start = paragraph.text.indexOf(form.surface, start + Math.max(form.surface.length, 1))) {
        const end = start + form.surface.length;
        const key = `${form.identityId}:${start}:${end}`;
        if (!occurrenceKeys.has(key)) {
          occurrenceKeys.add(key);
          occurrences.push({ identityId: form.identityId, start, end });
        }
      }
    }
    occurrences.sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start));

    let occupiedUntil = -1;
    for (const occurrence of occurrences) {
      if (occurrence.start < occupiedUntil) continue;
      occupiedUntil = occurrence.end;
      const metric = metrics.get(occurrence.identityId) ?? {
        mentionCount: 0,
        chapterIds: new Set<string>(),
        firstOrdinal: paragraph.ordinal,
        lastOrdinal: paragraph.ordinal,
      };
      metric.mentionCount += 1;
      if (paragraph.chapterId) metric.chapterIds.add(paragraph.chapterId);
      metric.firstOrdinal = Math.min(metric.firstOrdinal, paragraph.ordinal);
      metric.lastOrdinal = Math.max(metric.lastOrdinal, paragraph.ordinal);
      metrics.set(occurrence.identityId, metric);
    }
  }

  return new Map([...metrics.entries()].map(([identityId, metric]) => [identityId, {
    mentionCount: metric.mentionCount,
    chapterCount: metric.chapterIds.size,
    firstOrdinal: metric.firstOrdinal,
    lastOrdinal: metric.lastOrdinal,
  }]));
}
