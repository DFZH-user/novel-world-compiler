import { createHash } from 'node:crypto';
import type { SourceSpanAlignment, SourceSpanInspection } from '../../src/shared/contracts';
import type { SQLiteDatabase } from './sqlite-db';

export type SourceSpanRecord = {
  id: string;
  revisionId: string;
  paragraphId: string;
  startUtf16: number | null;
  endUtf16: number | null;
  exactQuote: string;
  quoteSha256: string;
  prefixText: string;
  suffixText: string;
  alignmentStatus: SourceSpanAlignment;
};

export function inspectSourceSpan(db: SQLiteDatabase, sourceSpanId: string): SourceSpanInspection {
  const span = db.prepare(`SELECT s.id, s.revision_id AS revisionId, s.paragraph_id AS paragraphId,
    p.ordinal AS paragraphOrdinal, ch.title AS chapterTitle, p.text AS paragraphText,
    s.start_utf16 AS startUtf16, s.end_utf16 AS endUtf16, s.exact_quote AS exactQuote,
    s.quote_sha256 AS quoteSha256, s.prefix_text AS prefixText, s.suffix_text AS suffixText,
    s.alignment_status AS alignmentStatus
    FROM source_spans s JOIN paragraphs p ON p.id = s.paragraph_id
    LEFT JOIN chapters ch ON ch.id = p.chapter_id WHERE s.id = ?`)
    .get(sourceSpanId) as unknown as SourceSpanInspection | undefined;
  if (!span) throw new Error('找不到该原文定位记录');
  if (span.alignmentStatus === 'exact') {
    const validRange = span.startUtf16 !== null && span.endUtf16 !== null
      && span.startUtf16 >= 0 && span.endUtf16 > span.startUtf16
      && span.paragraphText.slice(span.startUtf16, span.endUtf16) === span.exactQuote;
    if (!validRange) return { ...span, alignmentStatus: 'invalid' };
  }
  return span;
}

type EvidenceTable = {
  table: string;
  paragraphColumn: string;
  quoteColumn: string;
  startColumn?: string;
  endColumn?: string;
};

const evidenceTables: EvidenceTable[] = [
  { table: 'evidence_anchors', paragraphColumn: 'paragraph_id', quoteColumn: 'quote' },
  { table: 'person_aliases', paragraphColumn: 'evidence_paragraph_id', quoteColumn: 'alias' },
  { table: 'person_mentions', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'character_fact_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'character_quotes', paragraphColumn: 'paragraph_id', quoteColumn: 'quote_text', startColumn: 'start_offset', endColumn: 'end_offset' },
  { table: 'character_quote_attributions', paragraphColumn: 'evidence_paragraph_id', quoteColumn: 'evidence_text' },
  { table: 'timeline_event_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'timeline_time_expressions', paragraphColumn: 'paragraph_id', quoteColumn: 'surface_text', startColumn: 'start_offset', endColumn: 'end_offset' },
  { table: 'timeline_event_relations', paragraphColumn: 'evidence_paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'character_relationship_candidate_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'character_relationship_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'place_mentions', paragraphColumn: 'paragraph_id', quoteColumn: 'surface_text', startColumn: 'char_start', endColumn: 'char_end' },
  { table: 'place_relation_candidate_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'place_relation_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'place_alias_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
  { table: 'place_identity_link_evidence', paragraphColumn: 'paragraph_id', quoteColumn: 'exact_quote' },
];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function selectorContext(text: string, start: number, end: number): { prefixText: string; suffixText: string } {
  return {
    prefixText: Array.from(text.slice(0, start)).slice(-32).join(''),
    suffixText: Array.from(text.slice(end)).slice(0, 32).join(''),
  };
}

function exactOccurrences(text: string, quote: string): number[] {
  const result: number[] = [];
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    result.push(index);
    if (result.length > 1) break;
    from = index + Math.max(quote.length, 1);
  }
  return result;
}

export function createSourceSpan(
  db: SQLiteDatabase,
  paragraphId: string,
  exactQuote: string,
  requestedStart?: number | null,
  requestedEnd?: number | null,
): SourceSpanRecord {
  const paragraph = db.prepare('SELECT revision_id AS revisionId, text FROM paragraphs WHERE id = ?').get(paragraphId) as {
    revisionId: string;
    text: string;
  } | undefined;
  if (!paragraph) throw new Error('找不到证据段落：' + paragraphId);
  if (!exactQuote) throw new Error('证据原文不能为空');

  let startUtf16: number | null = null;
  let endUtf16: number | null = null;
  let alignmentStatus: SourceSpanAlignment = 'invalid';
  const hasRequestedRange = Number.isInteger(requestedStart) && Number.isInteger(requestedEnd)
    && Number(requestedStart) >= 0 && Number(requestedEnd) > Number(requestedStart);
  if (hasRequestedRange && paragraph.text.slice(Number(requestedStart), Number(requestedEnd)) === exactQuote) {
    startUtf16 = Number(requestedStart);
    endUtf16 = Number(requestedEnd);
    alignmentStatus = 'exact';
  } else {
    const occurrences = exactOccurrences(paragraph.text, exactQuote);
    if (occurrences.length === 1) {
      startUtf16 = occurrences[0]!;
      endUtf16 = startUtf16 + exactQuote.length;
      alignmentStatus = 'exact';
    } else if (occurrences.length > 1) {
      alignmentStatus = 'ambiguous';
    }
  }

  const context = startUtf16 === null || endUtf16 === null
    ? { prefixText: '', suffixText: '' }
    : selectorContext(paragraph.text, startUtf16, endUtf16);
  const quoteSha256 = sha256(exactQuote);
  const id = 'ss_' + sha256([
    paragraph.revisionId,
    paragraphId,
    startUtf16 ?? 'none',
    endUtf16 ?? 'none',
    quoteSha256,
    alignmentStatus,
  ].join(':')).slice(0, 32);
  const timestamp = new Date().toISOString();
  db.prepare('INSERT OR IGNORE INTO source_spans (id, revision_id, paragraph_id, start_utf16, end_utf16, exact_quote, quote_sha256, prefix_text, suffix_text, alignment_status, created_at, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      id,
      paragraph.revisionId,
      paragraphId,
      startUtf16,
      endUtf16,
      exactQuote,
      quoteSha256,
      context.prefixText,
      context.suffixText,
      alignmentStatus,
      timestamp,
      timestamp,
    );
  return {
    id,
    revisionId: paragraph.revisionId,
    paragraphId,
    startUtf16,
    endUtf16,
    exactQuote,
    quoteSha256,
    ...context,
    alignmentStatus,
  };
}

export function backfillSourceSpans(db: SQLiteDatabase): { linked: number; unresolved: number } {
  let linked = 0;
  let unresolved = 0;
  db.transaction(() => {
    for (const config of evidenceTables) {
      const rangeColumns = config.startColumn && config.endColumn
        ? ', e.' + config.startColumn + ' AS startOffset, e.' + config.endColumn + ' AS endOffset'
        : '';
      const rows = db.prepare(
        'SELECT e.id AS evidenceId, e.' + config.paragraphColumn + ' AS paragraphId, e.' + config.quoteColumn
          + ' AS exactQuote' + rangeColumns + ' FROM ' + config.table
          + ' e WHERE e.source_span_id IS NULL AND e.' + config.paragraphColumn
          + ' IS NOT NULL AND length(e.' + config.quoteColumn + ') > 0',
      ).all() as Array<{
        evidenceId: string | number;
        paragraphId: string;
        exactQuote: string;
        startOffset?: number;
        endOffset?: number;
      }>;
      const update = db.prepare('UPDATE ' + config.table + ' SET source_span_id = ? WHERE id = ?');
      for (const row of rows) {
        const span = createSourceSpan(db, row.paragraphId, row.exactQuote, row.startOffset, row.endOffset);
        update.run(span.id, row.evidenceId);
        linked += 1;
        if (span.alignmentStatus !== 'exact') unresolved += 1;
      }
    }
  });
  return { linked, unresolved };
}
