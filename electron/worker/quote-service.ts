import { createHash } from 'node:crypto';
import type {
  CharacterQuoteRecord,
  QuoteAttributionRecord,
  QuoteLocalAnalysisSummary,
  QuoteScanSummary,
  SpeechProfileRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type DetectedQuote = {
  startOffset: number;
  endOffset: number;
  fullStart: number;
  fullEnd: number;
  quoteText: string;
  quoteType: CharacterQuoteRecord['quoteType'];
};

export type IdentityForm = { identityId: string; identityName: string; form: string; confirmed: boolean };

const SPEECH_VERBS = '(?:说|说道|道|问|问道|答|答道|回答|喊|喊道|叫|叫道|喝道|吼道|骂道|叹道|笑道|开口|回应|嘀咕|低语|耳语)';

function pushDetected(target: DetectedQuote[], text: string, expression: RegExp, quoteType: DetectedQuote['quoteType']): void {
  for (const match of text.matchAll(expression)) {
    if (match.index === undefined || !match[1]) continue;
    const raw = match[1];
    const quoteText = raw.trim();
    if (!quoteText) continue;
    const leading = raw.length - raw.trimStart().length;
    const rawOffset = match[0].indexOf(raw);
    const startOffset = match.index + rawOffset + leading;
    target.push({
      startOffset,
      endOffset: startOffset + quoteText.length,
      fullStart: match.index,
      fullEnd: match.index + match[0].length,
      quoteText,
      quoteType,
    });
  }
}

export function detectChineseQuotes(text: string): DetectedQuote[] {
  const detected: DetectedQuote[] = [];
  pushDetected(detected, text, /“([^”\r\n]{1,4000})”/gu, 'curly_double');
  pushDetected(detected, text, /「([^」\r\n]{1,4000})」/gu, 'corner');
  pushDetected(detected, text, /『([^』\r\n]{1,4000})』/gu, 'double_corner');
  pushDetected(detected, text, /"([^"\r\n]{1,4000})"/gu, 'ascii_double');
  pushDetected(detected, text, /^(?:—{1,2}|－{1,2})\s*(.{1,4000})$/gu, 'dash');
  const seen = new Set<string>();
  return detected.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset)
    .filter((item) => {
      const key = `${item.startOffset}:${item.endOffset}:${item.quoteType}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function explicitCandidates(text: string, quote: DetectedQuote, forms: IdentityForm[]): Array<IdentityForm & { confidence: number; evidenceText: string; reasoning: string }> {
  const before = text.slice(Math.max(0, quote.fullStart - 70), quote.fullStart);
  const after = text.slice(quote.fullEnd, Math.min(text.length, quote.fullEnd + 70));
  const found = new Map<string, IdentityForm & { confidence: number; evidenceText: string; reasoning: string }>();
  for (const form of forms) {
    const escaped = escapeRegExp(form.form);
    const beforeMatch = before.match(new RegExp(`(?:^|[，。！？!?；;\\s])(${escaped})(?:[^，。！？!?；;：“”「」『』]{0,12})${SPEECH_VERBS}[：:，,\\s]*$`, 'u'));
    const afterMatch = after.match(new RegExp(`^[，,。！？!?…\\s]*(${escaped})(?:[^，。！？!?；;：“”「」『』]{0,12})${SPEECH_VERBS}`, 'u'));
    const match = beforeMatch ?? afterMatch;
    if (!match) continue;
    const candidate = {
      ...form,
      confidence: beforeMatch ? 0.98 : 0.97,
      evidenceText: match[0].trim(),
      reasoning: beforeMatch ? '对白前存在明确姓名和言说动词' : '对白后存在明确姓名和言说动词',
    };
    const previous = found.get(form.identityId);
    if (!previous || candidate.confidence > previous.confidence || candidate.form.length > previous.form.length) found.set(form.identityId, candidate);
  }
  return [...found.values()];
}

export class QuoteService {
  constructor(private readonly store: ProjectStore) {}

  scan(): QuoteScanSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const timestamp = now();
    const forms = this.identityForms(db, revisionId);
    const mentionRows = db.prepare(`SELECT p.ordinal, m.identity_id AS identityId, MAX(m.confidence) AS confidence
      FROM person_mentions m JOIN paragraphs p ON p.id = m.paragraph_id
      JOIN person_identities i ON i.id = m.identity_id
      WHERE m.revision_id = ? AND i.review_status != 'rejected' GROUP BY p.ordinal, m.identity_id`)
      .all(revisionId) as Array<{ ordinal: number; identityId: string; confidence: number }>;
    const mentionsByOrdinal = new Map<number, Array<{ identityId: string; confidence: number }>>();
    for (const mention of mentionRows) {
      const ordinal = Number(mention.ordinal);
      const values = mentionsByOrdinal.get(ordinal) ?? [];
      values.push({ identityId: mention.identityId, confidence: Number(mention.confidence) });
      mentionsByOrdinal.set(ordinal, values);
    }
    const identityNames = new Map(forms.map((form) => [form.identityId, form.identityName]));
    const paragraphs = db.prepare(`SELECT p.id, p.ordinal, p.text FROM paragraphs p
      LEFT JOIN paragraph_exclusions x ON x.paragraph_id = p.id
      WHERE p.revision_id = ? AND COALESCE(x.excluded, 0) = 0 ORDER BY p.ordinal`)
      .all(revisionId) as Array<{ id: string; ordinal: number; text: string }>;

    withTransaction(db, () => {
      for (const paragraph of paragraphs) {
        for (const quote of detectChineseQuotes(paragraph.text)) {
          const quoteId = `cq_${hash(`${revisionId}:${paragraph.id}:${quote.startOffset}:${quote.endOffset}:${quote.quoteType}:${quote.quoteText}`).slice(0, 32)}`;
          db.prepare(`INSERT OR IGNORE INTO character_quotes
            (id, revision_id, paragraph_id, start_offset, end_offset, quote_text, quote_type, detection_method, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'rule', ?)`)
            .run(quoteId, revisionId, paragraph.id, quote.startOffset, quote.endOffset, quote.quoteText, quote.quoteType, timestamp);
          const explicit = explicitCandidates(paragraph.text, quote, forms);
          if (explicit.length) {
            for (const candidate of explicit) {
              this.insertCandidate(db, quoteId, candidate.identityId, 'explicit_cue', candidate.confidence,
                explicit.length === 1 && candidate.confirmed ? 'confirmed' : 'pending', paragraph.id, candidate.evidenceText, candidate.reasoning, timestamp);
            }
            continue;
          }
          const nearby = new Map<string, { confidence: number; distance: number }>();
          for (let distance = 0; distance <= 1; distance += 1) {
            const ordinals = distance === 0 ? [Number(paragraph.ordinal)] : [Number(paragraph.ordinal) - 1, Number(paragraph.ordinal) + 1];
            for (const ordinal of ordinals) {
              for (const mention of mentionsByOrdinal.get(ordinal) ?? []) {
                const confidence = Math.min(0.72, 0.5 + Number(mention.confidence) * 0.15 - distance * 0.08);
                const prior = nearby.get(mention.identityId);
                if (!prior || confidence > prior.confidence) nearby.set(mention.identityId, { confidence, distance });
              }
            }
          }
          for (const [identityId, candidate] of [...nearby.entries()].sort((left, right) => right[1].confidence - left[1].confidence).slice(0, 5)) {
            this.insertCandidate(db, quoteId, identityId, 'nearby_context', candidate.confidence, 'pending', paragraph.id, '',
              `${identityNames.get(identityId) ?? '该人物'}出现在对白${candidate.distance ? '相邻段落' : '所在段落'}，仅作为待审核候选`, timestamp);
          }
        }
      }
    });
    this.rebuildSpeechProfiles(db, revisionId, timestamp);
    return this.summary();
  }

  analyzeLocalTurns(): QuoteLocalAnalysisSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const timestamp = now();
    const quotes = db.prepare(`SELECT q.id, q.paragraph_id AS paragraphId, p.ordinal,
      (SELECT a.identity_id FROM character_quote_attributions a WHERE a.quote_id = q.id AND a.role = 'speaker'
        AND a.review_status = 'confirmed' ORDER BY a.updated_at DESC LIMIT 1) AS confirmedSpeakerId
      FROM character_quotes q JOIN paragraphs p ON p.id = q.paragraph_id WHERE q.revision_id = ?
      ORDER BY p.ordinal, q.start_offset`).all(revisionId) as Array<{ id: string; paragraphId: string; ordinal: number; confirmedSpeakerId: string | null }>;
    const mentionRows = db.prepare(`SELECT DISTINCT p.ordinal, m.identity_id AS identityId FROM person_mentions m
      JOIN paragraphs p ON p.id = m.paragraph_id JOIN person_identities i ON i.id = m.identity_id
      WHERE m.revision_id = ? AND i.review_status = 'confirmed'`).all(revisionId) as Array<{ ordinal: number; identityId: string }>;
    const mentionsByOrdinal = new Map<number, string[]>();
    for (const mention of mentionRows) {
      const ordinal = Number(mention.ordinal);
      const values = mentionsByOrdinal.get(ordinal) ?? [];
      if (!values.includes(mention.identityId)) values.push(mention.identityId);
      mentionsByOrdinal.set(ordinal, values);
    }
    let createdCandidates = 0;
    withTransaction(db, () => {
      quotes.forEach((quote, index) => {
        if (quote.confirmedSpeakerId) return;
        const previous = quotes[index - 1];
        const previousTwo = quotes[index - 2];
        const next = quotes[index + 1];
        const closePrevious = previous && Number(quote.ordinal) - Number(previous.ordinal) <= 1 ? previous : null;
        const closePreviousTwo = previousTwo && Number(quote.ordinal) - Number(previousTwo.ordinal) <= 2 ? previousTwo : null;
        const closeNext = next && Number(next.ordinal) - Number(quote.ordinal) <= 1 ? next : null;
        const scene = new Set<string>();
        for (let ordinal = Number(quote.ordinal) - 2; ordinal <= Number(quote.ordinal) + 2; ordinal += 1) {
          for (const identityId of mentionsByOrdinal.get(ordinal) ?? []) scene.add(identityId);
        }
        if (closePrevious?.confirmedSpeakerId) scene.add(closePrevious.confirmedSpeakerId);
        if (closeNext?.confirmedSpeakerId) scene.add(closeNext.confirmedSpeakerId);
        let identityId: string | null = null;
        let confidence = 0;
        let reasoning = '';
        if (closePrevious?.confirmedSpeakerId && closePreviousTwo?.confirmedSpeakerId
          && closePrevious.confirmedSpeakerId !== closePreviousTwo.confirmedSpeakerId) {
          identityId = closePreviousTwo.confirmedSpeakerId;
          confidence = 0.78;
          reasoning = '前两条已确认对白由两人交替发言，本条按相邻轮次生成回切候选';
        } else if (scene.size === 2 && closePrevious?.confirmedSpeakerId) {
          identityId = [...scene].find((value) => value !== closePrevious.confirmedSpeakerId) ?? null;
          confidence = closeNext?.confirmedSpeakerId === closePrevious.confirmedSpeakerId ? 0.75 : 0.7;
          reasoning = closeNext?.confirmedSpeakerId === closePrevious.confirmedSpeakerId
            ? '本条夹在同一已确认说话人的两条对白之间，且局部场景只有两名已确认人物'
            : '局部场景只有两名已确认人物，本条按相邻对话轮次生成另一人的候选';
        } else if (scene.size === 2 && closeNext?.confirmedSpeakerId) {
          identityId = [...scene].find((value) => value !== closeNext.confirmedSpeakerId) ?? null;
          confidence = 0.68;
          reasoning = '局部场景只有两名已确认人物，本条按后一条已确认对白反推另一人的候选';
        }
        if (!identityId) return;
        const valid = db.prepare(`SELECT id FROM person_identities WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`)
          .get(identityId, revisionId);
        if (!valid) return;
        if (this.insertCandidate(db, quote.id, identityId, 'turn_taking', confidence, 'pending', quote.paragraphId, '', reasoning, timestamp)) {
          createdCandidates += 1;
        }
      });
    });
    const profileCount = this.rebuildSpeechProfiles(db, revisionId, timestamp);
    return { createdCandidates, profileCount };
  }

  summary(): QuoteScanSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare(`SELECT COUNT(*) AS quoteCount,
      SUM(CASE WHEN EXISTS (SELECT 1 FROM character_quote_attributions a WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status = 'confirmed') THEN 1 ELSE 0 END) AS confirmedSpeakerCount,
      SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM character_quote_attributions a WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status = 'confirmed')
        AND EXISTS (SELECT 1 FROM character_quote_attributions a WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status = 'pending') THEN 1 ELSE 0 END) AS suggestedSpeakerCount,
      SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM character_quote_attributions a WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status IN ('pending','confirmed')) THEN 1 ELSE 0 END) AS unresolvedCount
      FROM character_quotes q WHERE q.revision_id = ?`).get(revisionId) as Record<string, number | null>;
    return {
      quoteCount: Number(row.quoteCount ?? 0),
      confirmedSpeakerCount: Number(row.confirmedSpeakerCount ?? 0),
      suggestedSpeakerCount: Number(row.suggestedSpeakerCount ?? 0),
      unresolvedCount: Number(row.unresolvedCount ?? 0),
    };
  }

  listQuotes(limitInput = 500, offsetInput = 0, unresolvedOnly = false): CharacterQuoteRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const limit = Math.max(1, Math.min(1000, Number(limitInput) || 500));
    const offset = Math.max(0, Number(offsetInput) || 0);
    const unresolved = unresolvedOnly ? `AND NOT EXISTS (SELECT 1 FROM character_quote_attributions ax
      WHERE ax.quote_id = q.id AND ax.role = 'speaker' AND ax.review_status = 'confirmed')` : '';
    return db.prepare(`SELECT q.id, q.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      q.start_offset AS startOffset, q.end_offset AS endOffset, q.quote_text AS quoteText, q.quote_type AS quoteType,
      (SELECT a.identity_id FROM character_quote_attributions a WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status = 'confirmed' ORDER BY a.updated_at DESC LIMIT 1) AS confirmedSpeakerId,
      (SELECT i.canonical_name FROM character_quote_attributions a JOIN person_identities i ON i.id = a.identity_id WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status = 'confirmed' ORDER BY a.updated_at DESC LIMIT 1) AS confirmedSpeakerName,
      (SELECT i.canonical_name FROM character_quote_attributions a JOIN person_identities i ON i.id = a.identity_id WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status = 'pending' ORDER BY a.confidence DESC LIMIT 1) AS suggestedSpeakerName,
      (SELECT COUNT(*) FROM character_quote_attributions a WHERE a.quote_id = q.id AND a.role = 'speaker' AND a.review_status != 'rejected') AS candidateCount
      FROM character_quotes q JOIN paragraphs p ON p.id = q.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE q.revision_id = ? ${unresolved} ORDER BY p.ordinal, q.start_offset LIMIT ? OFFSET ?`)
      .all(revisionId, limit, offset) as unknown as CharacterQuoteRecord[];
  }

  listAttributions(quoteId: string): QuoteAttributionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT a.id, a.quote_id AS quoteId, a.identity_id AS identityId, i.canonical_name AS identityName,
      a.role, a.method, a.confidence, a.review_status AS reviewStatus, a.evidence_paragraph_id AS evidenceParagraphId,
      a.evidence_text AS evidenceText, a.reasoning FROM character_quote_attributions a
      JOIN character_quotes q ON q.id = a.quote_id JOIN person_identities i ON i.id = a.identity_id
      WHERE a.quote_id = ? AND q.revision_id = ? ORDER BY a.review_status = 'rejected', a.review_status = 'confirmed' DESC, a.confidence DESC`)
      .all(quoteId, revisionId) as unknown as QuoteAttributionRecord[];
  }

  review(attributionId: string, status: QuoteAttributionRecord['reviewStatus']): QuoteAttributionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare(`SELECT a.id, a.quote_id AS quoteId, a.role FROM character_quote_attributions a
      JOIN character_quotes q ON q.id = a.quote_id WHERE a.id = ? AND q.revision_id = ?`)
      .get(attributionId, revisionId) as { id: string; quoteId: string; role: string } | undefined;
    if (!row) throw new Error('找不到该对白归属候选');
    withTransaction(db, () => {
      if (status === 'confirmed') db.prepare(`UPDATE character_quote_attributions SET review_status = 'pending', updated_at = ?
        WHERE quote_id = ? AND role = ? AND review_status = 'confirmed' AND id != ?`).run(now(), row.quoteId, row.role, attributionId);
      db.prepare('UPDATE character_quote_attributions SET review_status = ?, updated_at = ? WHERE id = ?').run(status, now(), attributionId);
    });
    this.rebuildSpeechProfiles(db, revisionId, now());
    return this.listAttributions(row.quoteId);
  }

  assignSpeaker(quoteId: string, identityId: string): QuoteAttributionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const quote = db.prepare('SELECT id, paragraph_id AS paragraphId FROM character_quotes WHERE id = ? AND revision_id = ?')
      .get(quoteId, revisionId) as { id: string; paragraphId: string } | undefined;
    if (!quote) throw new Error('找不到该对白');
    const identity = db.prepare(`SELECT id, canonical_name AS name FROM person_identities
      WHERE id = ? AND revision_id = ? AND review_status != 'rejected'`).get(identityId, revisionId) as { id: string; name: string } | undefined;
    if (!identity) throw new Error('找不到可分配的说话人');
    const timestamp = now();
    const attributionId = `cqa_${hash(`${quoteId}:${identityId}:speaker:user`).slice(0, 32)}`;
    withTransaction(db, () => {
      db.prepare(`UPDATE character_quote_attributions SET review_status = 'pending', updated_at = ?
        WHERE quote_id = ? AND role = 'speaker' AND review_status = 'confirmed'`).run(timestamp, quoteId);
      db.prepare(`INSERT INTO character_quote_attributions
        (id, quote_id, identity_id, role, method, confidence, review_status, evidence_paragraph_id, evidence_text, reasoning, created_at, updated_at)
        VALUES (?, ?, ?, 'speaker', 'user', 1, 'confirmed', ?, '', '用户手工指定说话人', ?, ?)
        ON CONFLICT(quote_id, identity_id, role, method) DO UPDATE SET confidence = 1, review_status = 'confirmed',
          reasoning = '用户手工指定说话人', updated_at = excluded.updated_at`)
        .run(attributionId, quoteId, identityId, quote.paragraphId, timestamp, timestamp);
    });
    this.rebuildSpeechProfiles(db, revisionId, timestamp);
    return this.listAttributions(quoteId);
  }

  listSpeechProfiles(): SpeechProfileRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const rows = db.prepare(`SELECT s.identity_id AS identityId, i.canonical_name AS identityName, s.quote_count AS quoteCount,
      s.character_count AS characterCount, s.average_length AS averageLength, s.question_rate AS questionRate,
      s.exclamation_rate AS exclamationRate, s.ellipsis_rate AS ellipsisRate, s.first_person_rate AS firstPersonRate,
      s.sentence_particle_rate AS sentenceParticleRate, s.politeness_rate AS politenessRate, s.classical_rate AS classicalRate,
      s.favorite_markers_json AS favoriteMarkersJson, s.sample_quote_ids_json AS sampleQuoteIdsJson
      FROM character_speech_profiles s JOIN person_identities i ON i.id = s.identity_id
      WHERE s.revision_id = ? ORDER BY s.quote_count DESC, i.canonical_name`).all(revisionId) as Array<Record<string, string | number>>;
    return rows.map((row) => {
      const sampleIds = JSON.parse(String(row.sampleQuoteIdsJson)) as string[];
      const samples = sampleIds.length ? db.prepare(`SELECT q.id AS quoteId, q.quote_text AS quoteText, p.ordinal AS paragraphOrdinal
        FROM character_quotes q JOIN paragraphs p ON p.id = q.paragraph_id WHERE q.id IN (${sampleIds.map(() => '?').join(',')}) ORDER BY p.ordinal`)
        .all(...sampleIds) as unknown as SpeechProfileRecord['samples'] : [];
      return {
        identityId: String(row.identityId), identityName: String(row.identityName), quoteCount: Number(row.quoteCount),
        characterCount: Number(row.characterCount), averageLength: Number(row.averageLength), questionRate: Number(row.questionRate),
        exclamationRate: Number(row.exclamationRate), ellipsisRate: Number(row.ellipsisRate), firstPersonRate: Number(row.firstPersonRate),
        sentenceParticleRate: Number(row.sentenceParticleRate), politenessRate: Number(row.politenessRate), classicalRate: Number(row.classicalRate),
        favoriteMarkers: JSON.parse(String(row.favoriteMarkersJson)) as string[], samples,
      };
    });
  }

  private identityForms(db: SQLiteDatabase, revisionId: string): IdentityForm[] {
    const rows = db.prepare(`SELECT i.id AS identityId, i.canonical_name AS identityName, i.canonical_name AS form,
      i.review_status AS reviewStatus FROM person_identities i WHERE i.revision_id = ? AND i.review_status != 'rejected'
      UNION ALL
      SELECT i.id, i.canonical_name, a.alias, i.review_status FROM person_aliases a
      JOIN person_identities i ON i.id = a.identity_id WHERE a.revision_id = ? AND a.review_status = 'confirmed' AND i.review_status != 'rejected'`)
      .all(revisionId, revisionId) as Array<{ identityId: string; identityName: string; form: string; reviewStatus: string }>;
    const seen = new Set<string>();
    return rows.filter((row) => row.form.trim().length >= 2).sort((left, right) => right.form.length - left.form.length).flatMap((row) => {
      const key = `${row.identityId}:${row.form}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ identityId: row.identityId, identityName: row.identityName, form: row.form, confirmed: row.reviewStatus === 'confirmed' }];
    });
  }

  private insertCandidate(db: SQLiteDatabase, quoteId: string, identityId: string, method: QuoteAttributionRecord['method'], confidence: number,
    status: QuoteAttributionRecord['reviewStatus'], paragraphId: string, evidenceText: string, reasoning: string, timestamp: string): boolean {
    const attributionId = `cqa_${hash(`${quoteId}:${identityId}:speaker:${method}`).slice(0, 32)}`;
    const result = db.prepare(`INSERT OR IGNORE INTO character_quote_attributions
      (id, quote_id, identity_id, role, method, confidence, review_status, evidence_paragraph_id, evidence_text, reasoning, created_at, updated_at)
      VALUES (?, ?, ?, 'speaker', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(attributionId, quoteId, identityId, method, confidence, status, paragraphId, evidenceText, reasoning, timestamp, timestamp);
    return result.changes > 0;
  }

  private rebuildSpeechProfiles(db: SQLiteDatabase, revisionId: string, timestamp: string): number {
    const rows = db.prepare(`SELECT a.identity_id AS identityId, q.id AS quoteId, q.quote_text AS quoteText, p.ordinal
      FROM character_quote_attributions a JOIN character_quotes q ON q.id = a.quote_id JOIN paragraphs p ON p.id = q.paragraph_id
      WHERE q.revision_id = ? AND a.role = 'speaker' AND a.review_status = 'confirmed' ORDER BY a.identity_id, p.ordinal, q.start_offset`)
      .all(revisionId) as Array<{ identityId: string; quoteId: string; quoteText: string; ordinal: number }>;
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const values = groups.get(row.identityId) ?? [];
      values.push(row);
      groups.set(row.identityId, values);
    }
    const markerCandidates = ['我', '我们', '咱们', '你', '你们', '您', '请', '多谢', '谢谢', '抱歉', '对不起', '在下', '阁下', '本座', '贫道', '奴家', '吾', '汝', '尔'];
    const hasAny = (text: string, markers: string[]) => markers.some((marker) => text.includes(marker));
    withTransaction(db, () => {
      db.prepare('DELETE FROM character_speech_profiles WHERE revision_id = ?').run(revisionId);
      for (const [identityId, quotes] of groups) {
        const quoteCount = quotes.length;
        const characterCount = quotes.reduce((sum, quote) => sum + quote.quoteText.length, 0);
        const rate = (predicate: (text: string) => boolean) => quotes.filter((quote) => predicate(quote.quoteText)).length / quoteCount;
        const markerCounts = markerCandidates.map((marker) => ({ marker, count: quotes.reduce((sum, quote) => sum + quote.quoteText.split(marker).length - 1, 0) }))
          .filter((item) => item.count > 0).sort((left, right) => right.count - left.count || left.marker.localeCompare(right.marker, 'zh-CN')).slice(0, 6);
        const eligible = quotes.filter((quote) => quote.quoteText.length >= 2 && quote.quoteText.length <= 80);
        const source = eligible.length ? eligible : quotes;
        const sampleIds = [...new Set([0, 0.5, 1].map((ratio) => source[Math.floor((source.length - 1) * ratio)]?.quoteId).filter(Boolean))];
        db.prepare(`INSERT INTO character_speech_profiles
          (id, revision_id, identity_id, quote_count, character_count, average_length, question_rate, exclamation_rate,
           ellipsis_rate, first_person_rate, sentence_particle_rate, politeness_rate, classical_rate,
           favorite_markers_json, sample_quote_ids_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`csp_${hash(`${revisionId}:${identityId}`).slice(0, 32)}`, revisionId, identityId, quoteCount, characterCount,
            characterCount / quoteCount, rate((text) => /[？?]/u.test(text)), rate((text) => /[！!]/u.test(text)),
            rate((text) => /…{2,}|\.{3,}/u.test(text)), rate((text) => hasAny(text, ['我', '我们', '咱', '俺', '本座', '在下', '吾'])),
            rate((text) => /[吧呢啊呀吗嘛啦罢哉][。！？!?…]*$/u.test(text)), rate((text) => hasAny(text, ['请', '劳驾', '多谢', '谢谢', '抱歉', '对不起'])),
            rate((text) => hasAny(text, ['在下', '阁下', '本座', '贫道', '奴家', '吾', '汝', '尔'])),
            JSON.stringify(markerCounts.map((item) => item.marker)), JSON.stringify(sampleIds), timestamp);
      }
    });
    return groups.size;
  }
}
