import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import readline from 'node:readline';
import iconv from 'iconv-lite';
import type { ImportPreview, ImportResult } from '../../src/shared/contracts';
import { rankEncodingCandidates, normalizeEncodingName } from '../../src/lib/encoding';
import { deduplicateAdjacentChapterCandidates, detectChapterCandidate, type ChapterCandidate } from '../../src/lib/chapters';
import type { ProjectStore } from './project-store';
import { withTransaction } from './db-utils';
import type { SQLiteDatabase } from './sqlite-db';

function now(): string {
  return new Date().toISOString();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

class NewlineNormalizer extends Transform {
  private trailingCarriageReturn = false;
  private firstChunk = true;

  constructor() {
    super({ decodeStrings: false });
  }

  override _transform(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: string) => void): void {
    let text = String(chunk);
    if (this.firstChunk) {
      text = text.replace(/^\uFEFF/, '');
      this.firstChunk = false;
    }
    if (this.trailingCarriageReturn) text = `\r${text}`;
    this.trailingCarriageReturn = text.endsWith('\r');
    if (this.trailingCarriageReturn) text = text.slice(0, -1);
    callback(null, text.replace(/\r\n?/g, '\n'));
  }

  override _flush(callback: (error?: Error | null, data?: string) => void): void {
    callback(null, this.trailingCarriageReturn ? '\n' : undefined);
  }
}

async function sampleFile(sourcePath: string): Promise<{ sample: Buffer; byteSize: number }> {
  const stat = await fsp.stat(sourcePath);
  if (!stat.isFile() || stat.size === 0) throw new Error('请选择非空的 TXT 文件');
  const handle = await fsp.open(sourcePath, 'r');
  try {
    const sampleSize = Math.min(64 * 1024, stat.size);
    const offsets = [...new Set([0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.max(0, Math.floor((stat.size - sampleSize) * ratio))))];
    const samples: Buffer[] = [];
    for (const offset of offsets) {
      const buffer = Buffer.alloc(sampleSize);
      const { bytesRead } = await handle.read(buffer, 0, sampleSize, offset);
      samples.push(buffer.subarray(0, bytesRead));
    }
    return { sample: Buffer.concat(samples), byteSize: stat.size };
  } finally {
    await handle.close();
  }
}

async function copyAndHash(sourcePath: string, destinationPath: string): Promise<string> {
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await pipeline(fs.createReadStream(sourcePath), meter, fs.createWriteStream(destinationPath, { flags: 'wx' }));
  return hash.digest('hex');
}

async function normalizeFile(sourcePath: string, destinationPath: string, encoding: string): Promise<void> {
  await pipeline(
    fs.createReadStream(sourcePath),
    iconv.decodeStream(encoding),
    new NewlineNormalizer(),
    fs.createWriteStream(destinationPath, { encoding: 'utf8', flags: 'wx' }),
  );
}

type ParsedText = { paragraphCount: number; characterCount: number; candidates: ChapterCandidate[] };

function isSceneSeparator(text: string): boolean {
  return /^(?:[*＊#＃=_~～·•—\-]\s*){3,}$/u.test(text) || /^(?:…\s*){3,}$/u.test(text);
}

async function waitForJob(db: SQLiteDatabase, jobId: string): Promise<void> {
  while (true) {
    const row = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: string } | undefined;
    if (!row || row.state === 'cancelled') throw new Error('IMPORT_CANCELLED');
    if (row.state !== 'paused') return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function parseParagraphs(
  db: SQLiteDatabase,
  normalizedPath: string,
  revisionId: string,
  jobId: string,
  byteSize: number,
): Promise<ParsedText> {
  const input = fs.createReadStream(normalizedPath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const insert = db.prepare(`INSERT INTO paragraphs
    (id, revision_id, ordinal, text, utf8_start, utf8_end, content_hash, blank_lines_before, boundary_before)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const candidates: ChapterCandidate[] = [];
  let ordinal = 0;
  let byteOffset = 0;
  let characterCount = 0;
  let lineNumber = 0;
  let blankLinesBefore = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for await (const rawLine of reader) {
      const line = String(rawLine);
      const lineBytes = Buffer.byteLength(line, 'utf8');
      const trimmed = line.trim();
      lineNumber += 1;
      if (trimmed) {
        ordinal += 1;
        const leadingBytes = Buffer.byteLength(line.slice(0, line.indexOf(trimmed)), 'utf8');
        const start = byteOffset + leadingBytes;
        const end = start + Buffer.byteLength(trimmed, 'utf8');
        const contentHash = sha256(trimmed);
        const id = `p_${sha256(`${revisionId}:${start}:${end}:${contentHash}`).slice(0, 32)}`;
        const candidate = detectChapterCandidate(trimmed, ordinal);
        const boundaryBefore = ordinal === 1 ? 'document'
          : candidate ? 'chapter'
            : isSceneSeparator(trimmed) ? 'scene'
              : blankLinesBefore > 0 ? 'blank_line' : 'paragraph';
        insert.run(id, revisionId, ordinal, trimmed, start, end, contentHash, blankLinesBefore, boundaryBefore);
        characterCount += trimmed.length;
        if (candidate) candidates.push(candidate);
        blankLinesBefore = 0;
      } else {
        blankLinesBefore += 1;
      }
      byteOffset += lineBytes + 1;
      if (lineNumber % 1000 === 0) {
        db.exec('COMMIT');
        db.exec('BEGIN IMMEDIATE');
        await waitForJob(db, jobId);
        const progress = Math.min(0.9, 0.25 + (byteOffset / Math.max(byteSize, 1)) * 0.6);
        db.prepare(`UPDATE jobs SET progress = ?, message = ?, checkpoint_json = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
          .run(progress, `已整理 ${ordinal.toLocaleString()} 个段落`, JSON.stringify({ lineNumber, ordinal, byteOffset }), new Date(Date.now() + 30_000).toISOString(), now(), jobId);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    reader.close();
    throw error;
  }
  return { paragraphCount: ordinal, characterCount, candidates };
}

function buildChapters(db: SQLiteDatabase, revisionId: string, paragraphCount: number, candidates: ChapterCandidate[]): number {
  const boundaries = deduplicateAdjacentChapterCandidates(candidates);
  if (boundaries.length === 0 || boundaries[0].paragraphOrdinal > 1) {
    boundaries.unshift({ paragraphOrdinal: 1, title: boundaries.length ? '正文前内容' : '全文', score: boundaries.length ? 0.5 : 0.3, kind: 'special' });
  }
  const createdAt = now();
  const insert = db.prepare(`INSERT INTO chapters
    (id, revision_id, ordinal, title, paragraph_start, paragraph_end, character_count, detection_score, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateParagraphs = db.prepare(`UPDATE paragraphs SET chapter_id = ? WHERE revision_id = ? AND ordinal BETWEEN ? AND ?`);
  const sumCharacters = db.prepare(`SELECT COALESCE(SUM(LENGTH(text)), 0) AS total FROM paragraphs WHERE revision_id = ? AND ordinal BETWEEN ? AND ?`);
  withTransaction(db, () => {
    boundaries.forEach((boundary, index) => {
      const start = boundary.paragraphOrdinal;
      const end = (boundaries[index + 1]?.paragraphOrdinal ?? (paragraphCount + 1)) - 1;
      if (end < start) return;
      const chapterId = randomUUID();
      const total = (sumCharacters.get(revisionId, start, end) as { total: number }).total;
      insert.run(chapterId, revisionId, index + 1, boundary.title, start, end, total, boundary.score, createdAt, createdAt);
      updateParagraphs.run(chapterId, revisionId, start, end);
    });
  });
  return boundaries.length;
}

async function cleanupIncompleteRevision(db: SQLiteDatabase, rootPath: string, revisionId: string): Promise<void> {
  const row = db.prepare(`SELECT id FROM source_revisions WHERE id = ? AND status != 'ready'`).get(revisionId) as { id: string } | undefined;
  if (!row) return;
  withTransaction(db, () => {
    db.prepare('DELETE FROM source_revisions WHERE id = ?').run(revisionId);
  });
  const sourcesRoot = path.resolve(rootPath, 'sources');
  const revisionPath = path.resolve(sourcesRoot, revisionId);
  if (path.dirname(revisionPath) !== sourcesRoot) throw new Error('不安全的修订目录路径');
  await fsp.rm(revisionPath, { recursive: true, force: true });
}

export class Importer {
  constructor(private readonly store: ProjectStore) {}

  async preview(sourcePath: string): Promise<ImportPreview> {
    const { sample, byteSize } = await sampleFile(sourcePath);
    const candidates = rankEncodingCandidates(sample);
    if (!candidates[0]) throw new Error('无法识别文本编码');
    return { sourcePath, byteSize, candidates, recommendedEncoding: candidates[0].encoding };
  }

  async run(sourcePath: string, requestedEncoding: string): Promise<ImportResult> {
    const { rootPath, db, projectId } = this.store.get();
    const encoding = normalizeEncodingName(requestedEncoding);
    if (!iconv.encodingExists(encoding)) throw new Error(`不支持的编码：${requestedEncoding}`);
    const stat = await fsp.stat(sourcePath);
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const startedAt = now();
    db.prepare(`INSERT INTO jobs (id, project_id, type, state, progress, message, input_json, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, 'import', 'running', 0, '准备导入', ?, ?, ?, ?, ?)`)
      .run(jobId, projectId, JSON.stringify({ sourcePath, encoding }), process.pid.toString(), new Date(Date.now() + 30_000).toISOString(), startedAt, startedAt);
    db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, 1, ?, 'running')`)
      .run(attemptId, jobId, startedAt);
    const tempDir = path.join(rootPath, 'tmp', `import-${jobId}`);
    await fsp.mkdir(tempDir, { recursive: false });
    const rawTemp = path.join(tempDir, 'original.tmp');
    const normalizedTemp = path.join(tempDir, 'normalized.tmp');
    let finalDir: string | null = null;
    try {
      const digest = await copyAndHash(sourcePath, rawTemp);
      const revisionId = `rev_${sha256(`${digest}:${encoding}`).slice(0, 32)}`;
      const existing = db.prepare(`SELECT id, encoding, sha256, byte_size AS byteSize, character_count AS characterCount
        FROM source_revisions WHERE id = ? AND status = 'ready'`).get(revisionId) as Omit<ImportResult, 'chapterCount' | 'paragraphCount' | 'revisionId'> & { id: string } | undefined;
      if (existing) {
        const counts = db.prepare(`SELECT
          (SELECT COUNT(*) FROM chapters WHERE revision_id = ?) AS chapterCount,
          (SELECT COUNT(*) FROM paragraphs WHERE revision_id = ?) AS paragraphCount`).get(revisionId, revisionId) as { chapterCount: number; paragraphCount: number };
        db.prepare(`UPDATE projects SET active_revision_id = ?, updated_at = ? WHERE id = ?`).run(revisionId, now(), projectId);
        db.prepare(`UPDATE jobs SET state = 'completed', progress = 1, message = '相同版本已存在，已直接启用', updated_at = ? WHERE id = ?`).run(now(), jobId);
        db.prepare(`UPDATE job_attempts SET state = 'completed', finished_at = ? WHERE id = ?`).run(now(), attemptId);
        return { revisionId, ...existing, ...counts };
      }
      await cleanupIncompleteRevision(db, rootPath, revisionId);
      db.prepare(`UPDATE jobs SET progress = 0.12, message = '正在转换为规范 UTF-8 文本', input_hash = ?, updated_at = ? WHERE id = ?`)
        .run(digest, now(), jobId);
      await normalizeFile(rawTemp, normalizedTemp, encoding);
      finalDir = path.join(rootPath, 'sources', revisionId);
      try {
        const orphan = await fsp.stat(finalDir);
        if (orphan.isDirectory()) await fsp.rm(finalDir, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await fsp.mkdir(finalDir, { recursive: false });
      const rawFinal = path.join(finalDir, 'original.txt');
      const normalizedFinal = path.join(finalDir, 'normalized.txt');
      await fsp.rename(rawTemp, rawFinal);
      await fsp.rename(normalizedTemp, normalizedFinal);
      db.prepare(`INSERT INTO source_revisions
        (id, project_id, original_name, original_path, normalized_path, encoding, sha256, byte_size, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'importing', ?)`)
        .run(
          revisionId,
          projectId,
          path.basename(sourcePath),
          path.relative(rootPath, rawFinal),
          path.relative(rootPath, normalizedFinal),
          encoding,
          digest,
          stat.size,
          now(),
        );
      const parsed = await parseParagraphs(db, normalizedFinal, revisionId, jobId, stat.size);
      if (parsed.paragraphCount === 0) throw new Error('文本中没有可导入的非空段落');
      const chapterCount = buildChapters(db, revisionId, parsed.paragraphCount, parsed.candidates);
      const finishedAt = now();
      withTransaction(db, () => {
        db.prepare(`UPDATE source_revisions SET character_count = ?, status = 'ready', completed_at = ? WHERE id = ?`)
          .run(parsed.characterCount, finishedAt, revisionId);
        db.prepare(`UPDATE projects SET active_revision_id = ?, updated_at = ? WHERE id = ?`).run(revisionId, finishedAt, projectId);
        db.prepare(`UPDATE jobs SET state = 'completed', progress = 1, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
          .run(`导入完成：${chapterCount} 章，${parsed.paragraphCount} 段`, finishedAt, jobId);
        db.prepare(`UPDATE job_attempts SET state = 'completed', finished_at = ? WHERE id = ?`).run(finishedAt, attemptId);
      });
      return {
        revisionId,
        encoding,
        sha256: digest,
        byteSize: stat.size,
        characterCount: parsed.characterCount,
        chapterCount,
        paragraphCount: parsed.paragraphCount,
      };
    } catch (error) {
      const cancelled = error instanceof Error && error.message === 'IMPORT_CANCELLED';
      const message = cancelled ? '导入已取消' : error instanceof Error ? error.message : '导入失败';
      db.prepare(`UPDATE jobs SET state = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(cancelled ? 'cancelled' : 'failed', message, now(), jobId);
      db.prepare(`UPDATE job_attempts SET state = ?, error = ?, finished_at = ? WHERE id = ?`)
        .run(cancelled ? 'cancelled' : 'failed', message, now(), attemptId);
      if (finalDir) {
        const revisionId = path.basename(finalDir);
        await cleanupIncompleteRevision(db, rootPath, revisionId);
      }
      throw new Error(message);
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }
}
