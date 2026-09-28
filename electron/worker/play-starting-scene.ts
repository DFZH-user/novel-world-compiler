import type { StartingScene } from '../../src/shared/play-session-options';
import type { ProjectStore } from './project-store';

/** Uses only confirmed material inside the package's reading boundary. Never writes the project. */
export function readStartingScene(store: ProjectStore, eventId: string, ordinal: number): StartingScene {
  const { db } = store.get();
  const revisionId = store.getSummary()?.activeRevisionId ?? null;
  const event = db.prepare(`SELECT summary, narrative_end_ordinal AS endOrdinal FROM timeline_events
    WHERE id = ? AND revision_id = ? AND review_status = 'confirmed' AND narrative_start_ordinal <= ?`)
    .get(eventId, revisionId, ordinal) as { summary: string; endOrdinal: number } | undefined;
  if (!event) return { state: 'unavailable', context: '', locations: [], evidenceOrdinals: [] };
  const quotes = db.prepare(`SELECT p.ordinal, e.exact_quote AS quote FROM timeline_event_evidence e
    JOIN paragraphs p ON p.id = e.paragraph_id WHERE e.event_id = ? AND p.revision_id = ? ORDER BY p.ordinal, e.id`)
    .all(eventId, revisionId) as Array<{ ordinal: number; quote: string }>;
  const complete = quotes.length > 0 && event.endOrdinal <= ordinal && quotes.every(quote => quote.ordinal <= ordinal);
  const visible = quotes.filter(quote => quote.ordinal <= ordinal);
  let context = complete && event.summary.length <= 1400 ? event.summary : '';
  const evidenceOrdinals: number[] = [];
  if (!context) for (const quote of visible) {
    const line = `¶ ${quote.ordinal}：${quote.quote}`;
    if (context.includes(line) || context.length + line.length > 1400) continue;
    context += `${context ? '\n' : ''}${line}`;
    evidenceOrdinals.push(quote.ordinal);
  }
  else evidenceOrdinals.push(...visible.map(quote => quote.ordinal));
  const locations = complete ? db.prepare(`SELECT COALESCE(NULLIF(normalized_name,''), surface_name) AS name
    FROM timeline_event_locations WHERE event_id = ? AND review_status = 'confirmed' AND location_role = 'at'
    ORDER BY id`).all(eventId) as Array<{ name: string }> : [];
  return { state: context ? complete ? 'complete' : 'partial' : 'unavailable', context,
    locations: [...new Set(locations.map(place => place.name))], evidenceOrdinals: [...new Set(evidenceOrdinals)] };
}
