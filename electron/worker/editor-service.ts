import { createHash, randomUUID } from 'node:crypto';
import type {
  ChapterRecord,
  ChunkInspection,
  ChunkRecord,
  ChunkSettings,
  JobRecord,
  ParagraphRecord,
  SearchHit,
  EvidenceAnchorRecord,
} from '../../src/shared/contracts';
import { buildChunkSlices, type ChunkBoundaryKind } from '../../src/lib/chunker';
import type { ProjectStore } from './project-store';
import { withTransaction } from './db-utils';
import type { SQLiteDatabase } from './sqlite-db';
import { invalidateCharacterLiteralMetrics } from './character-literal-metrics';
import { literalFtsPhrase } from './full-text-search';

function now(): string {
  return new Date().toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

export class EditorService {
  constructor(private readonly store: ProjectStore) {}

  listChapters(): ChapterRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT id, ordinal, title, paragraph_start AS paragraphStart, paragraph_end AS paragraphEnd,
      character_count AS characterCount, detection_score AS detectionScore, manually_edited AS manuallyEdited
      FROM chapters WHERE revision_id = ? ORDER BY ordinal`).all(revisionId) as unknown as ChapterRecord[];
  }

  renameChapter(chapterId: string, title: string): ChapterRecord[] {
    const cleanTitle = title.trim().slice(0, 100);
    if (!cleanTitle) throw new Error('章节标题不能为空');
    const { db } = this.store.get();
    const result = db.prepare(`UPDATE chapters SET title = ?, manually_edited = 1, updated_at = ? WHERE id = ?`).run(cleanTitle, now(), chapterId);
    if (result.changes !== 1) throw new Error('找不到要重命名的章节');
    return this.listChapters();
  }

  splitChapter(chapterId: string, paragraphOrdinal: number, title: string): ChapterRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const chapter = db.prepare(`SELECT * FROM chapters WHERE id = ? AND revision_id = ?`).get(chapterId, revisionId) as {
      ordinal: number; paragraph_start: number; paragraph_end: number;
    } | undefined;
    if (!chapter) throw new Error('找不到要拆分的章节');
    if (paragraphOrdinal <= chapter.paragraph_start || paragraphOrdinal > chapter.paragraph_end) {
      throw new Error('拆分点必须位于章节内部，且不能是首段');
    }
    const cleanTitle = title.trim().slice(0, 100) || `拆分章节 ${chapter.ordinal + 1}`;
    const newChapterId = randomUUID();
    const timestamp = now();
    withTransaction(db, () => {
      const later = db.prepare(`SELECT id, ordinal FROM chapters WHERE revision_id = ? AND ordinal > ? ORDER BY ordinal DESC`)
        .all(revisionId, chapter.ordinal) as Array<{ id: string; ordinal: number }>;
      const setOrdinal = db.prepare('UPDATE chapters SET ordinal = ? WHERE id = ?');
      later.forEach((item) => setOrdinal.run(item.ordinal + 1, item.id));
      db.prepare(`UPDATE chapters SET paragraph_end = ?, character_count =
        (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM paragraphs WHERE revision_id = ? AND ordinal BETWEEN ? AND ?),
        manually_edited = 1, updated_at = ? WHERE id = ?`)
        .run(paragraphOrdinal - 1, revisionId, chapter.paragraph_start, paragraphOrdinal - 1, timestamp, chapterId);
      const newCount = (db.prepare(`SELECT COALESCE(SUM(LENGTH(text)), 0) AS total FROM paragraphs
        WHERE revision_id = ? AND ordinal BETWEEN ? AND ?`).get(revisionId, paragraphOrdinal, chapter.paragraph_end) as { total: number }).total;
      db.prepare(`INSERT INTO chapters
        (id, revision_id, ordinal, title, paragraph_start, paragraph_end, character_count, detection_score, manually_edited, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`)
        .run(newChapterId, revisionId, chapter.ordinal + 1, cleanTitle, paragraphOrdinal, chapter.paragraph_end, newCount, timestamp, timestamp);
      db.prepare(`UPDATE paragraphs SET chapter_id = ? WHERE revision_id = ? AND ordinal BETWEEN ? AND ?`)
        .run(newChapterId, revisionId, paragraphOrdinal, chapter.paragraph_end);
      db.prepare(`INSERT INTO chapter_lineage (revision_id, parent_chapter_id, child_chapter_id, operation, created_at)
        VALUES (?, ?, ?, 'split', ?)`).run(revisionId, chapterId, newChapterId, timestamp);
      invalidateCharacterLiteralMetrics(db, revisionId);
    });
    return this.listChapters();
  }

  mergeWithNext(chapterId: string): ChapterRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const chapter = db.prepare(`SELECT id, ordinal, paragraph_start AS start, paragraph_end AS end FROM chapters WHERE id = ? AND revision_id = ?`)
      .get(chapterId, revisionId) as { id: string; ordinal: number; start: number; end: number } | undefined;
    if (!chapter) throw new Error('找不到要合并的章节');
    const next = db.prepare(`SELECT id, ordinal, paragraph_end AS end FROM chapters WHERE revision_id = ? AND ordinal = ?`)
      .get(revisionId, chapter.ordinal + 1) as { id: string; ordinal: number; end: number } | undefined;
    if (!next) throw new Error('当前章节已经是最后一章');
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare(`UPDATE paragraphs SET chapter_id = ? WHERE chapter_id = ?`).run(chapter.id, next.id);
      db.prepare(`INSERT INTO chapter_lineage (revision_id, parent_chapter_id, child_chapter_id, operation, created_at)
        VALUES (?, ?, ?, 'merge', ?)`).run(revisionId, next.id, chapter.id, timestamp);
      db.prepare('DELETE FROM chapters WHERE id = ?').run(next.id);
      db.prepare(`UPDATE chapters SET paragraph_end = ?, character_count =
        (SELECT COALESCE(SUM(LENGTH(text)), 0) FROM paragraphs WHERE revision_id = ? AND ordinal BETWEEN ? AND ?),
        manually_edited = 1, updated_at = ? WHERE id = ?`)
        .run(next.end, revisionId, chapter.start, next.end, timestamp, chapter.id);
      const later = db.prepare(`SELECT id, ordinal FROM chapters WHERE revision_id = ? AND ordinal > ? ORDER BY ordinal`)
        .all(revisionId, next.ordinal) as Array<{ id: string; ordinal: number }>;
      const setOrdinal = db.prepare('UPDATE chapters SET ordinal = ? WHERE id = ?');
      later.forEach((item) => setOrdinal.run(item.ordinal - 1, item.id));
      invalidateCharacterLiteralMetrics(db, revisionId);
    });
    return this.listChapters();
  }

  listParagraphs(chapterId?: string, limit = 2000, offset = 0): ParagraphRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const params: Array<string | number> = [revisionId];
    let chapterFilter = '';
    if (chapterId) {
      chapterFilter = 'AND p.chapter_id = ?';
      params.push(chapterId);
    }
    params.push(Math.min(Math.max(limit, 1), 5000), Math.max(offset, 0));
    return db.prepare(`SELECT p.id, p.ordinal, p.chapter_id AS chapterId, p.text, p.utf8_start AS utf8Start,
      p.utf8_end AS utf8End, COALESCE(e.excluded, 0) AS excluded
      FROM paragraphs p LEFT JOIN paragraph_exclusions e ON e.paragraph_id = p.id
      WHERE p.revision_id = ? ${chapterFilter} ORDER BY p.ordinal LIMIT ? OFFSET ?`).all(...params) as unknown as ParagraphRecord[];
  }

  setParagraphExcluded(paragraphId: string, excluded: boolean): { ok: true } {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    if (excluded) {
      const exists = db.prepare('SELECT id FROM paragraphs WHERE id = ?').get(paragraphId);
      if (!exists) throw new Error('找不到该段落');
      db.prepare(`INSERT INTO paragraph_exclusions (paragraph_id, excluded, updated_at) VALUES (?, 1, ?)
        ON CONFLICT(paragraph_id) DO UPDATE SET excluded = 1, updated_at = excluded.updated_at`).run(paragraphId, now());
    } else {
      db.prepare('DELETE FROM paragraph_exclusions WHERE paragraph_id = ?').run(paragraphId);
    }
    invalidateCharacterLiteralMetrics(db, revisionId);
    return { ok: true };
  }

  buildChunks(settings: ChunkSettings): ChunkRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const paragraphs = db.prepare(`SELECT p.id, p.ordinal, p.chapter_id AS chapterId, LENGTH(p.text) AS characterCount,
      p.content_hash AS contentHash, p.boundary_before AS boundaryBefore
      FROM paragraphs p LEFT JOIN paragraph_exclusions e ON e.paragraph_id = p.id
      WHERE p.revision_id = ? AND COALESCE(e.excluded, 0) = 0 ORDER BY p.ordinal`).all(revisionId) as Array<{
        id: string; ordinal: number; chapterId: string | null; characterCount: number;
        contentHash: string; boundaryBefore: ChunkBoundaryKind;
      }>;
    const algorithmVersion = 'boundary-v2';
    const inputHash = hash(JSON.stringify({
      algorithmVersion,
      settings,
      paragraphs: paragraphs.map((paragraph) => [
        paragraph.id, paragraph.contentHash, paragraph.chapterId, paragraph.boundaryBefore,
      ]),
    }));
    const latestPlan = db.prepare(`SELECT id, version, input_hash AS inputHash FROM chunk_plans
      WHERE revision_id = ? ORDER BY version DESC LIMIT 1`).get(revisionId) as {
        id: string; version: number; inputHash: string | null;
      } | undefined;
    if (latestPlan?.inputHash === inputHash) return this.listChunks();
    const slices = buildChunkSlices(paragraphs, settings);
    const version = (latestPlan?.version ?? 0) + 1;
    const planId = randomUUID();
    const insertChunk = db.prepare(`INSERT INTO chunks
      (id, plan_id, ordinal, chapter_id, core_start_ordinal, core_end_ordinal, context_start_ordinal, context_end_ordinal,
       character_count, core_character_count, context_character_count, boundary_reason, oversized, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertMember = db.prepare(`INSERT INTO chunk_members (chunk_id, paragraph_id, role, ordinal_in_chunk) VALUES (?, ?, ?, ?)`);
    withTransaction(db, () => {
      db.prepare(`INSERT INTO chunk_plans
        (id, revision_id, version, settings_json, algorithm_version, input_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(planId, revisionId, version, JSON.stringify(settings), algorithmVersion, inputHash, now());
      slices.forEach((slice, sliceIndex) => {
        const coreStart = paragraphs[slice.coreStartIndex].ordinal;
        const coreEnd = paragraphs[slice.coreEndIndex].ordinal;
        const contextStart = paragraphs[slice.contextStartIndex].ordinal;
        const contextEnd = paragraphs[slice.contextEndIndex].ordinal;
        const chunkId = `c_${hash(`${revisionId}:${version}:${coreStart}:${coreEnd}`).slice(0, 32)}`;
        const members = paragraphs.slice(slice.contextStartIndex, slice.contextEndIndex + 1).map((paragraph, index) => {
          const absoluteIndex = slice.contextStartIndex + index;
          const role = absoluteIndex < slice.coreStartIndex ? 'context_before'
            : absoluteIndex > slice.coreEndIndex ? 'context_after' : 'core';
          return [paragraph.id, paragraph.contentHash, role];
        });
        const contentHash = hash(JSON.stringify(members));
        insertChunk.run(
          chunkId, planId, sliceIndex + 1, slice.chapterId, coreStart, coreEnd, contextStart, contextEnd,
          slice.contextCharacterCount, slice.coreCharacterCount, slice.contextCharacterCount,
          slice.boundaryReason, slice.oversized ? 1 : 0, contentHash,
        );
        for (let index = slice.contextStartIndex; index <= slice.contextEndIndex; index += 1) {
          const role = index < slice.coreStartIndex ? 'context_before' : index > slice.coreEndIndex ? 'context_after' : 'core';
          insertMember.run(chunkId, paragraphs[index].id, role, index - slice.contextStartIndex + 1);
        }
      });
      db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('active_chunk_plan', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(JSON.stringify({ planId, revisionId, version }), now());
    });
    return this.listChunks();
  }

  listChunks(): ChunkRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const plan = db.prepare(`SELECT id FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1`).get(revisionId) as { id: string } | undefined;
    if (!plan) return [];
    const rows = db.prepare(`SELECT id, ordinal, chapter_id AS chapterId, core_start_ordinal AS coreStartOrdinal,
      core_end_ordinal AS coreEndOrdinal, context_start_ordinal AS contextStartOrdinal,
      context_end_ordinal AS contextEndOrdinal, character_count AS characterCount,
      core_character_count AS coreCharacterCount, context_character_count AS contextCharacterCount,
      boundary_reason AS boundaryReason, oversized, content_hash AS contentHash
      FROM chunks WHERE plan_id = ? ORDER BY ordinal`).all(plan.id) as unknown as Array<Omit<ChunkRecord, 'oversized'> & { oversized: number }>;
    return rows.map((row) => ({ ...row, oversized: Boolean(row.oversized) }));
  }

  inspectChunk(chunkId: string): ChunkInspection {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare(`SELECT c.id, c.ordinal, c.chapter_id AS chapterId,
      c.core_start_ordinal AS coreStartOrdinal, c.core_end_ordinal AS coreEndOrdinal,
      c.context_start_ordinal AS contextStartOrdinal, c.context_end_ordinal AS contextEndOrdinal,
      c.character_count AS characterCount, c.core_character_count AS coreCharacterCount,
      c.context_character_count AS contextCharacterCount, c.boundary_reason AS boundaryReason,
      c.oversized, c.content_hash AS contentHash
      FROM chunks c JOIN chunk_plans cp ON cp.id = c.plan_id
      WHERE c.id = ? AND cp.revision_id = ?
        AND cp.version = (SELECT MAX(version) FROM chunk_plans WHERE revision_id = ?)`)
      .get(chunkId, revisionId, revisionId) as unknown as (Omit<ChunkRecord, 'oversized'> & { oversized: number }) | undefined;
    if (!row) throw new Error('找不到当前分块方案中的该分块');
    const paragraphs = db.prepare(`SELECT p.id, p.ordinal, p.chapter_id AS chapterId,
      ch.title AS chapterTitle, p.text, p.utf8_start AS utf8Start, p.utf8_end AS utf8End,
      COALESCE(e.excluded, 0) AS excluded, cm.role, cm.ordinal_in_chunk AS ordinalInChunk
      FROM chunk_members cm
      JOIN paragraphs p ON p.id = cm.paragraph_id
      LEFT JOIN chapters ch ON ch.id = p.chapter_id
      LEFT JOIN paragraph_exclusions e ON e.paragraph_id = p.id
      WHERE cm.chunk_id = ? ORDER BY cm.ordinal_in_chunk`).all(chunkId) as unknown as ChunkInspection['paragraphs'];
    return { chunk: { ...row, oversized: Boolean(row.oversized) }, paragraphs };
  }

  search(query: string, limit = 100): SearchHit[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const clean = Array.from(query.trim()).slice(0, 200).join('');
    if (!clean) return [];
    const cappedLimit = Math.min(Math.max(limit, 1), 200);
    if (Array.from(clean).length < 3) {
      return db.prepare(`SELECT p.id AS paragraphId, c.title AS chapterTitle, p.ordinal,
        substr(p.text, max(instr(p.text, ?) - 18, 1), 72) AS snippet
        FROM paragraphs p LEFT JOIN chapters c ON c.id = p.chapter_id
        WHERE p.revision_id = ? AND instr(p.text, ?) > 0
        ORDER BY p.ordinal LIMIT ?`).all(clean, revisionId, clean, cappedLimit) as unknown as SearchHit[];
    }
    const phrase = literalFtsPhrase(clean);
    return db.prepare(`SELECT p.id AS paragraphId, c.title AS chapterTitle, p.ordinal,
      substr(p.text, max(instr(p.text, ?) - 18, 1), 72) AS snippet
      FROM paragraph_fts f
      JOIN paragraphs p ON p.id = f.paragraph_id
      LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE paragraph_fts MATCH ? AND p.revision_id = ? AND instr(p.text, ?) > 0
      ORDER BY p.ordinal LIMIT ?`).all(clean, phrase, revisionId, clean, cappedLimit) as unknown as SearchHit[];
  }

  getEvidenceAnchor(paragraphId: string): EvidenceAnchorRecord {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const paragraph = db.prepare(`SELECT id, ordinal, text, utf8_start AS utf8Start, utf8_end AS utf8End
      FROM paragraphs WHERE id = ? AND revision_id = ?`).get(paragraphId, revisionId) as {
        id: string; ordinal: number; text: string; utf8Start: number; utf8End: number;
      } | undefined;
    if (!paragraph) throw new Error('找不到证据段落');
    const quote = paragraph.text.slice(0, 240);
    const quoteHash = hash(quote);
    const utf8End = paragraph.utf8Start + Buffer.byteLength(quote, 'utf8');
    const prefix = db.prepare(`SELECT content_hash AS hash FROM paragraphs WHERE revision_id = ? AND ordinal < ? ORDER BY ordinal DESC LIMIT 1`)
      .get(revisionId, paragraph.ordinal) as { hash: string } | undefined;
    const suffix = db.prepare(`SELECT content_hash AS hash FROM paragraphs WHERE revision_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 1`)
      .get(revisionId, paragraph.ordinal) as { hash: string } | undefined;
    const id = `ev_${hash(`${revisionId}:${paragraph.id}:${paragraph.utf8Start}:${utf8End}:${quoteHash}`).slice(0, 32)}`;
    db.prepare(`INSERT OR IGNORE INTO evidence_anchors
      (id, revision_id, paragraph_id, utf8_start, utf8_end, quote, quote_hash, prefix_hash, suffix_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, revisionId, paragraph.id, paragraph.utf8Start, utf8End, quote, quoteHash,
        prefix?.hash ?? null, suffix?.hash ?? null, now(),
      );
    return {
      id,
      revisionId,
      paragraphId: paragraph.id,
      utf8Start: paragraph.utf8Start,
      utf8End,
      quote,
      quoteHash,
      prefixHash: prefix?.hash ?? null,
      suffixHash: suffix?.hash ?? null,
    };
  }

  listJobs(): JobRecord[] {
    const { db, projectId } = this.store.get();
    return db.prepare(`SELECT id, type, state, progress, message, updated_at AS updatedAt
      FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`).all(projectId) as JobRecord[];
  }

  controlJob(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): JobRecord[] {
    const { db, projectId } = this.store.get();
    const job = db.prepare('SELECT state FROM jobs WHERE id = ? AND project_id = ?').get(jobId, projectId) as { state: string } | undefined;
    if (!job) throw new Error('找不到任务');
    const transitions: Record<typeof action, string[]> = {
      pause: ['running'], resume: ['paused', 'queued'], cancel: ['queued', 'running', 'paused'], retry: ['failed'],
    };
    if (!transitions[action].includes(job.state)) throw new Error(`任务状态 ${job.state} 不能执行 ${action}`);
    const target = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : action === 'retry' ? 'queued' : 'running';
    db.prepare(`UPDATE jobs SET state = ?, message = ?, updated_at = ? WHERE id = ?`)
      .run(target, action === 'retry' ? '等待重新执行' : action === 'pause' ? '已暂停' : action === 'resume' ? '继续运行' : '已取消', now(), jobId);
    return this.listJobs();
  }
}
