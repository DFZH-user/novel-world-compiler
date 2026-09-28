import type { RelationshipTimelineEvent } from '../../src/shared/contracts';
import type { SQLiteDatabase } from './sqlite-db';

/** Return complete, confirmed events only. A summary can span its entire evidence set. */
export function relationshipEventTimeline(db: SQLiteDatabase, revisionId: string, ordinal: number): RelationshipTimelineEvent[] {
  const rows = db.prepare(`SELECT e.id, e.title, e.summary, e.event_type AS eventType,
    e.narrative_start_ordinal AS startOrdinal, e.narrative_end_ordinal AS endOrdinal
    FROM timeline_events e WHERE e.revision_id = ? AND e.review_status = 'confirmed'
    AND e.narrative_start_ordinal <= ? AND e.narrative_end_ordinal <= ?
    AND EXISTS (SELECT 1 FROM timeline_event_evidence ev JOIN paragraphs p ON p.id = ev.paragraph_id
      WHERE ev.event_id = e.id AND p.revision_id = e.revision_id AND p.ordinal <= ?)
    AND NOT EXISTS (SELECT 1 FROM timeline_event_evidence ev JOIN paragraphs p ON p.id = ev.paragraph_id
      WHERE ev.event_id = e.id AND (p.revision_id != e.revision_id OR p.ordinal > ?))
    ORDER BY e.narrative_end_ordinal, e.id`).all(revisionId, ordinal, ordinal, ordinal, ordinal) as Array<{
      id: string; title: string; summary: string; eventType: string; startOrdinal: number; endOrdinal: number;
    }>;
  if (!rows.length) return [];
  const ids = new Set(rows.map(row => row.id));
  const participants = db.prepare(`SELECT ep.event_id AS eventId, ep.identity_id AS identityId,
    i.canonical_name AS name FROM timeline_event_participants ep
    JOIN timeline_events e ON e.id = ep.event_id JOIN person_identities i ON i.id = ep.identity_id
    WHERE e.revision_id = ? AND i.revision_id = ? AND ep.review_status = 'confirmed'
    AND i.review_status = 'confirmed' ORDER BY ep.event_id, ep.identity_id`).all(revisionId, revisionId) as Array<{
      eventId: string; identityId: string; name: string;
    }>;
  const quotes = db.prepare(`SELECT ev.id, ev.event_id AS eventId, p.ordinal AS paragraphOrdinal, ev.exact_quote AS exactQuote
    FROM timeline_event_evidence ev JOIN timeline_events e ON e.id = ev.event_id JOIN paragraphs p ON p.id = ev.paragraph_id
    WHERE e.revision_id = ? AND p.revision_id = ? AND p.ordinal <= ? ORDER BY p.ordinal, ev.id`)
    .all(revisionId, revisionId, ordinal) as Array<{ id: string; eventId: string; paragraphOrdinal: number; exactQuote: string }>;
  const peopleByEvent = new Map<string, RelationshipTimelineEvent['participants']>();
  const evidenceByEvent = new Map<string, RelationshipTimelineEvent['evidence']>();
  for (const { eventId, identityId, name } of participants) {
    if (!ids.has(eventId)) continue;
    const group = peopleByEvent.get(eventId) ?? [];
    if (!group.some(person => person.identityId === identityId)) group.push({ identityId, name });
    peopleByEvent.set(eventId, group);
  }
  for (const { eventId, ...quote } of quotes) {
    if (!ids.has(eventId)) continue;
    evidenceByEvent.set(eventId, [...(evidenceByEvent.get(eventId) ?? []), quote]);
  }
  return rows.filter(row => peopleByEvent.has(row.id)).map(row => ({ ...row,
    participants: peopleByEvent.get(row.id)!, evidence: evidenceByEvent.get(row.id) ?? [],
  }));
}
