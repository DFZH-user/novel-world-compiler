import fs from 'node:fs/promises';
import path from 'node:path';
import type { SQLiteDatabase } from './sqlite-db';

const BOUNDARY_VERSION = 'boundary-v2';

function isSceneSeparator(text: string): boolean {
  return /^(?:[*＊#＃=_~～·•—\-]\s*){3,}$/u.test(text) || /^(?:…\s*){3,}$/u.test(text);
}

function safeRevisionPath(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('规范文本路径超出工程目录');
  return resolved;
}

export async function backfillParagraphBoundaries(db: SQLiteDatabase, rootPath: string): Promise<number> {
  const marker = db.prepare("SELECT value_json AS valueJson FROM settings WHERE key = 'paragraph-boundary-version'").get() as {
    valueJson: string;
  } | undefined;
  if (marker?.valueJson === JSON.stringify(BOUNDARY_VERSION)) return 0;

  const revisions = db.prepare(`SELECT id, normalized_path AS normalizedPath FROM source_revisions
    WHERE status = 'ready' ORDER BY created_at`).all() as Array<{ id: string; normalizedPath: string }>;
  const updates: Array<{ id: string; blankLinesBefore: number; boundaryBefore: string }> = [];
  for (const revision of revisions) {
    let normalized: Buffer;
    try {
      normalized = await fs.readFile(safeRevisionPath(rootPath, revision.normalizedPath));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const chapterStarts = new Set((db.prepare('SELECT paragraph_start AS ordinal FROM chapters WHERE revision_id = ?')
      .all(revision.id) as Array<{ ordinal: number }>).map((row) => Number(row.ordinal)));
    const paragraphs = db.prepare(`SELECT id, ordinal, text, utf8_start AS utf8Start, utf8_end AS utf8End
      FROM paragraphs WHERE revision_id = ? ORDER BY ordinal`).all(revision.id) as Array<{
        id: string; ordinal: number; text: string; utf8Start: number; utf8End: number;
      }>;
    let previousEnd = 0;
    for (const paragraph of paragraphs) {
      const gap = normalized.subarray(previousEnd, paragraph.utf8Start).toString('utf8');
      const newlineCount = gap.match(/\n/gu)?.length ?? 0;
      const blankLinesBefore = paragraph.ordinal === 1 ? Math.max(0, newlineCount) : Math.max(0, newlineCount - 1);
      const boundaryBefore = paragraph.ordinal === 1 ? 'document'
        : chapterStarts.has(paragraph.ordinal) ? 'chapter'
          : isSceneSeparator(paragraph.text) ? 'scene'
            : blankLinesBefore > 0 ? 'blank_line' : 'paragraph';
      updates.push({ id: paragraph.id, blankLinesBefore, boundaryBefore });
      previousEnd = paragraph.utf8End;
    }
  }

  db.transaction(() => {
    const update = db.prepare('UPDATE paragraphs SET blank_lines_before = ?, boundary_before = ? WHERE id = ?');
    for (const row of updates) update.run(row.blankLinesBefore, row.boundaryBefore, row.id);
    db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('paragraph-boundary-version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(BOUNDARY_VERSION), new Date().toISOString());
  });
  return updates.length;
}
