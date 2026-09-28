import { createHash, randomUUID } from 'node:crypto';
import type {
  AutomationDraftTimeRunRecord,
  TimeExpressionRecord,
  TimeExpressionReviewStatus,
  TimeExpressionScanSummary,
  TimeExpressionType,
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

export type DetectedTimeExpression = {
  startOffset: number;
  endOffset: number;
  surfaceText: string;
  expressionType: TimeExpressionType;
  normalizedValue: string | null;
  calendarSystem: TimeExpressionRecord['calendarSystem'];
  confidence: number;
};

type DetectionRule = {
  expression: RegExp;
  expressionType: TimeExpressionType;
  calendarSystem: TimeExpressionRecord['calendarSystem'];
  confidence: number;
  normalize?: (surface: string) => string | null;
};

const CHINESE_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function parseChineseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  if ([...value].every((character) => character in CHINESE_DIGITS)) {
    return Number([...value].map((character) => CHINESE_DIGITS[character]).join(''));
  }
  const unit = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (unit) return (unit[1] ? CHINESE_DIGITS[unit[1]] : 1) * 10 + (unit[2] ? CHINESE_DIGITS[unit[2]] : 0);
  return null;
}

function normalizeCalendar(surface: string): string | null {
  const separated = surface.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?$/u);
  if (separated) {
    const [, year, month, day] = separated;
    return day ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : `${year}-${month.padStart(2, '0')}`;
  }
  const chinese = surface.match(/^(?:公元)?([〇零一二三四五六七八九\d]{2,4})年(?:([一二两三四五六七八九十\d]{1,3})月)?(?:([一二两三四五六七八九十\d]{1,3})(?:日|号))?$/u);
  if (!chinese) return null;
  const year = parseChineseNumber(chinese[1]);
  const month = chinese[2] ? parseChineseNumber(chinese[2]) : null;
  const day = chinese[3] ? parseChineseNumber(chinese[3]) : null;
  if (year === null || (month !== null && (month < 1 || month > 12)) || (day !== null && (day < 1 || day > 31))) return null;
  const normalizedYear = String(year).padStart(4, '0');
  if (month === null) return normalizedYear;
  if (day === null) return `${normalizedYear}-${String(month).padStart(2, '0')}`;
  return `${normalizedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeRelative(surface: string): string | null {
  const fixed: Record<string, string> = {
    当天: 'RELATIVE:SAME_DAY', 当日: 'RELATIVE:SAME_DAY', 当晚: 'RELATIVE:SAME_NIGHT', 当夜: 'RELATIVE:SAME_NIGHT',
    翌日: 'RELATIVE:NEXT_DAY', 次日: 'RELATIVE:NEXT_DAY', 第二天: 'RELATIVE:NEXT_DAY',
    前一天: 'RELATIVE:PREVIOUS_DAY', 昨日: 'RELATIVE:PREVIOUS_DAY', 昨天: 'RELATIVE:PREVIOUS_DAY',
    今日: 'RELATIVE:CURRENT_DAY', 今天: 'RELATIVE:CURRENT_DAY', 明日: 'RELATIVE:NEXT_DAY', 明天: 'RELATIVE:NEXT_DAY',
    随后: 'RELATIVE:AFTER', 此前: 'RELATIVE:BEFORE', 与此同时: 'RELATIVE:SIMULTANEOUS', 同时: 'RELATIVE:SIMULTANEOUS',
    不久后: 'RELATIVE:AFTER', 稍后: 'RELATIVE:AFTER', 片刻后: 'RELATIVE:AFTER', 片刻前: 'RELATIVE:BEFORE',
  };
  if (fixed[surface]) return fixed[surface];
  const offset = surface.match(/^([一二两三四五六七八九十百千万\d半]+)(年|个月|月|周|星期|天|日|时辰|小时|刻钟|分钟|分|秒)(前|后)$/u);
  if (!offset) return null;
  return `RELATIVE:${offset[3] === '前' ? 'BEFORE' : 'AFTER'}:${offset[1]}${offset[2]}`;
}

const DETECTION_RULES: DetectionRule[] = [
  { expression: /(?:公元)?[〇零一二三四五六七八九\d]{2,4}年(?:[一二两三四五六七八九十\d]{1,3}月)?(?:[一二两三四五六七八九十\d]{1,3}(?:日|号))?/gu, expressionType: 'calendar', calendarSystem: 'gregorian', confidence: 0.98, normalize: normalizeCalendar },
  { expression: /\b\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?\b/gu, expressionType: 'calendar', calendarSystem: 'gregorian', confidence: 0.98, normalize: normalizeCalendar },
  { expression: /(?:凌晨|清晨|早晨|早上|上午|中午|下午|傍晚|晚上|夜里|午夜)?[零一二两三四五六七八九十\d]{1,3}(?:点|时)(?:[零一二两三四五六七八九十\d]{1,3}分|半|一刻|三刻)?|(?:子|丑|寅|卯|辰|巳|午|未|申|酉|戌|亥)时|[一二三四五]更/gu, expressionType: 'clock', calendarSystem: 'unspecified', confidence: 0.9 },
  { expression: /(?:当天|当日|当晚|当夜|翌日|次日|第二天|前一天|昨日|昨天|今日|今天|明日|明天|随后|此前|与此同时|同时|不久后|稍后|片刻后|片刻前)|[一二两三四五六七八九十百千万\d半]+(?:年|个月|月|周|星期|天|日|时辰|小时|刻钟|分钟|分|秒)(?:前|后)/gu, expressionType: 'relative', calendarSystem: 'relative', confidence: 0.9, normalize: normalizeRelative },
  { expression: /(?:历时|持续|经过|过了)[一二两三四五六七八九十百千万\d半]+(?:年|个月|月|周|星期|天|日|时辰|小时|刻钟|分钟|分|秒)/gu, expressionType: 'duration', calendarSystem: 'relative', confidence: 0.88 },
  { expression: /(?:每隔?[一二两三四五六七八九十百千万\d半]*(?:年|个月|月|周|星期|天|日|时辰|小时|分钟)|每逢[^，。！？；]{1,12}|一年一度)/gu, expressionType: 'frequency', calendarSystem: 'relative', confidence: 0.86 },
  { expression: /(?:年方|年仅|时年)?[一二两三四五六七八九十百\d]{1,4}岁/gu, expressionType: 'age', calendarSystem: 'relative', confidence: 0.9 },
  { expression: /(?:春|夏|秋|冬)(?:季|天|日|夜)|(?:初春|仲春|暮春|盛夏|初秋|深秋|初冬|隆冬)/gu, expressionType: 'season', calendarSystem: 'unspecified', confidence: 0.78 },
  { expression: /(?:上古|远古|太古|中古|近古|现代|当代|民国|先秦|秦汉|唐宋|明清)(?:时期|时代|年间)?|[\p{Script=Han}]{2,6}元年|(?:贞观|开元|天宝|洪武|永乐|康熙|雍正|乾隆|嘉庆|道光|咸丰|同治|光绪|宣统|天启|崇祯)[一二两三四五六七八九十]{1,4}年/gu, expressionType: 'era', calendarSystem: 'fictional', confidence: 0.72 },
];

export function detectChineseTimeExpressions(text: string): DetectedTimeExpression[] {
  const candidates: DetectedTimeExpression[] = [];
  for (const rule of DETECTION_RULES) {
    for (const match of text.matchAll(rule.expression)) {
      if (match.index === undefined || !match[0]) continue;
      candidates.push({
        startOffset: match.index,
        endOffset: match.index + match[0].length,
        surfaceText: match[0],
        expressionType: rule.expressionType,
        normalizedValue: rule.normalize?.(match[0]) ?? null,
        calendarSystem: rule.calendarSystem,
        confidence: rule.confidence,
      });
    }
  }
  return candidates
    .sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset || right.confidence - left.confidence)
    .filter((candidate, index, all) => !all.slice(0, index).some((kept) => candidate.startOffset < kept.endOffset && candidate.endOffset > kept.startOffset));
}

export class TimelineService {
  constructor(private readonly store: ProjectStore) {}

  scanTimeExpressions(): TimeExpressionScanSummary {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const paragraphs = this.activeParagraphs(db, revisionId);
    const timestamp = now();
    let counts = { detectedCount: 0, insertedCount: 0 };
    withTransaction(db, () => { counts = this.insertDetectedExpressions(db, revisionId, paragraphs, timestamp); });
    return { ...this.summaryForRevision(db, revisionId), ...counts };
  }

  scanDraftTimeExpressions(selectionRunId: string): AutomationDraftTimeRunRecord {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const selection = db.prepare(`SELECT id, revision_id AS revisionId, input_hash AS inputHash, state
      FROM automation_draft_selection_runs WHERE id = ? AND project_id = ?`).get(selectionRunId, projectId) as
      { id: string; revisionId: string; inputHash: string; state: string } | undefined;
    if (!selection || selection.state !== 'completed') throw new Error('自动草稿选择尚未完成，不能扫描时间表达式草稿');
    if (selection.revisionId !== revisionId) throw new Error('自动草稿选择不属于当前正文修订');
    const algorithmVersion = 'draft-time-rules.v1';
    const paragraphs = this.activeParagraphs(db, revisionId);
    const inputHash = hash(JSON.stringify({
      revisionId,
      selectionRunId,
      selectionInputHash: selection.inputHash,
      algorithmVersion,
      paragraphs: paragraphs.map((paragraph) => [paragraph.id, hash(paragraph.text)]),
    }));
    const existing = db.prepare(`SELECT id, revision_id AS revisionId, selection_run_id AS selectionRunId,
      algorithm_version AS algorithmVersion, input_hash AS inputHash, detected_count AS detectedCount,
      inserted_count AS insertedCount, total_count AS totalCount, pending_count AS pendingCount,
      confirmed_count AS confirmedCount, rejected_count AS rejectedCount, normalized_count AS normalizedCount,
      created_at AS createdAt FROM automation_draft_time_runs
      WHERE project_id = ? AND revision_id = ? AND selection_run_id = ? AND algorithm_version = ? AND input_hash = ?`)
      .get(projectId, revisionId, selectionRunId, algorithmVersion, inputHash) as
      Omit<AutomationDraftTimeRunRecord, 'reused'> | undefined;
    if (existing) return { ...existing, reused: true };

    const id = randomUUID();
    const timestamp = now();
    let detectedCount = 0;
    let insertedCount = 0;
    let summary = this.summaryForRevision(db, revisionId);
    withTransaction(db, () => {
      ({ detectedCount, insertedCount } = this.insertDetectedExpressions(db, revisionId, paragraphs, timestamp));
      summary = this.summaryForRevision(db, revisionId);
      db.prepare(`INSERT INTO automation_draft_time_runs
        (id, project_id, revision_id, selection_run_id, algorithm_version, input_hash, detected_count, inserted_count,
         total_count, pending_count, confirmed_count, rejected_count, normalized_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, projectId, revisionId, selectionRunId, algorithmVersion, inputHash, detectedCount, insertedCount,
          summary.totalCount, summary.pendingCount, summary.confirmedCount, summary.rejectedCount, summary.normalizedCount, timestamp);
    });
    return { id, revisionId, selectionRunId, algorithmVersion, inputHash, detectedCount, insertedCount, ...summary, reused: false, createdAt: timestamp };
  }

  timeExpressionSummary(): Omit<TimeExpressionScanSummary, 'detectedCount' | 'insertedCount'> {
    const { db, projectId } = this.store.get();
    return this.summaryForRevision(db, activeRevision(db, projectId));
  }

  private activeParagraphs(db: SQLiteDatabase, revisionId: string): Array<{ id: string; text: string }> {
    return db.prepare(`SELECT p.id, p.text FROM paragraphs p
      LEFT JOIN paragraph_exclusions x ON x.paragraph_id = p.id
      WHERE p.revision_id = ? AND COALESCE(x.excluded, 0) = 0 ORDER BY p.ordinal`).all(revisionId) as Array<{ id: string; text: string }>;
  }

  private insertDetectedExpressions(
    db: SQLiteDatabase,
    revisionId: string,
    paragraphs: Array<{ id: string; text: string }>,
    timestamp: string,
  ): { detectedCount: number; insertedCount: number } {
    let detectedCount = 0;
    let insertedCount = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO timeline_time_expressions
      (id, revision_id, paragraph_id, start_offset, end_offset, surface_text, expression_type, normalized_value,
       calendar_system, detection_method, confidence, review_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'rule', ?, 'pending', ?, ?)`);
    for (const paragraph of paragraphs) {
      for (const expression of detectChineseTimeExpressions(paragraph.text)) {
        detectedCount += 1;
        const id = `te_${hash(`${revisionId}:${paragraph.id}:${expression.startOffset}:${expression.endOffset}:${expression.surfaceText}`).slice(0, 32)}`;
        insertedCount += insert.run(id, revisionId, paragraph.id, expression.startOffset, expression.endOffset, expression.surfaceText,
          expression.expressionType, expression.normalizedValue, expression.calendarSystem, expression.confidence, timestamp, timestamp).changes;
      }
    }
    return { detectedCount, insertedCount };
  }

  private summaryForRevision(db: SQLiteDatabase, revisionId: string): Omit<TimeExpressionScanSummary, 'detectedCount' | 'insertedCount'> {
    const row = db.prepare(`SELECT COUNT(*) AS totalCount,
      SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
      SUM(CASE WHEN review_status = 'confirmed' THEN 1 ELSE 0 END) AS confirmedCount,
      SUM(CASE WHEN review_status = 'rejected' THEN 1 ELSE 0 END) AS rejectedCount,
      SUM(CASE WHEN normalized_value IS NOT NULL AND normalized_value != '' THEN 1 ELSE 0 END) AS normalizedCount
      FROM timeline_time_expressions WHERE revision_id = ?`).get(revisionId) as Record<string, number | null>;
    return {
      totalCount: Number(row.totalCount ?? 0),
      pendingCount: Number(row.pendingCount ?? 0),
      confirmedCount: Number(row.confirmedCount ?? 0),
      rejectedCount: Number(row.rejectedCount ?? 0),
      normalizedCount: Number(row.normalizedCount ?? 0),
    };
  }
  listTimeExpressions(status?: TimeExpressionReviewStatus): TimeExpressionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const filter = status ? 'AND t.review_status = ?' : '';
    const values = status ? [revisionId, status] : [revisionId];
    return db.prepare(`SELECT t.id, t.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      t.start_offset AS startOffset, t.end_offset AS endOffset, t.surface_text AS surfaceText,
      t.expression_type AS expressionType, t.normalized_value AS normalizedValue, t.calendar_system AS calendarSystem,
      t.detection_method AS detectionMethod, t.confidence, t.review_status AS reviewStatus
      FROM timeline_time_expressions t JOIN paragraphs p ON p.id = t.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE t.revision_id = ? ${filter} ORDER BY p.ordinal, t.start_offset`).all(...values) as unknown as TimeExpressionRecord[];
  }

  reviewTimeExpression(id: string, status: TimeExpressionReviewStatus, normalizedValue?: string | null): TimeExpressionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare('SELECT id FROM timeline_time_expressions WHERE id = ? AND revision_id = ?').get(id, revisionId);
    if (!row) throw new Error('找不到该时间表达');
    if (normalizedValue !== undefined && normalizedValue !== null && normalizedValue.length > 200) throw new Error('规范时间值过长');
    if (normalizedValue === undefined) {
      db.prepare('UPDATE timeline_time_expressions SET review_status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
    } else {
      db.prepare('UPDATE timeline_time_expressions SET review_status = ?, normalized_value = ?, updated_at = ? WHERE id = ?')
        .run(status, normalizedValue?.trim() || null, now(), id);
    }
    return this.listTimeExpressions();
  }
}
