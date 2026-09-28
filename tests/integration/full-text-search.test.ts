import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorService } from '../../electron/worker/editor-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import { SQLiteDatabase } from '../../electron/worker/sqlite-db';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function setupProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-fts-'));
  cleanupPaths.push(root);
  const projectRoot = path.join(root, '检索测试.novelworld');
  const sourcePath = path.join(root, 'source.txt');
  await fs.writeFile(sourcePath, [
    '第一章 搜索',
    '青石镇外落着一场很安静的雨。',
    '这里有字面量100%和编号A_B，也有一条反斜线A\\B。',
    '这一行只有100X和编号ACB，用来防止通配符误命中。',
  ].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('检索测试', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  return { store, projectRoot };
}

describe('paragraph FTS5 search', () => {
  it('uses the trigram index for long queries while keeping literal and short-query behavior', async () => {
    const { store } = await setupProject();
    try {
      const editor = new EditorService(store);
      expect(editor.search('青石镇')).toHaveLength(1);
      expect(editor.search('青石')).toHaveLength(1);
      expect(editor.search('100%')).toHaveLength(1);
      expect(editor.search('A_B')).toHaveLength(1);
      expect(editor.search('A\\B')).toHaveLength(1);

      const table = store.get().db.prepare("SELECT sql FROM sqlite_master WHERE name = 'paragraph_fts'").get() as { sql: string };
      expect(table.sql).toMatch(/VIRTUAL\s+TABLE[\s\S]+fts5/iu);
      const plan = store.get().db.prepare(`EXPLAIN QUERY PLAN
        SELECT paragraph_id FROM paragraph_fts WHERE paragraph_fts MATCH ?`).all('"青石镇"') as Array<{ detail: string }>;
      expect(plan.some((row) => /VIRTUAL TABLE INDEX/iu.test(row.detail))).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('keeps the index synchronized and replaces an old plain fallback table on reopen', async () => {
    const { store, projectRoot } = await setupProject();
    const editor = new EditorService(store);
    const paragraph = store.get().db.prepare('SELECT id FROM paragraphs WHERE text LIKE ?').get('%青石镇%') as { id: string };
    store.get().db.prepare('UPDATE paragraphs SET text = ? WHERE id = ?').run('三字新词出现在更新后的段落。', paragraph.id);
    expect(editor.search('青石镇')).toEqual([]);
    expect(editor.search('三字新词')).toHaveLength(1);
    store.get().db.prepare('DELETE FROM paragraphs WHERE id = ?').run(paragraph.id);
    expect(editor.search('三字新词')).toEqual([]);
    await store.close();

    const databasePath = path.join(projectRoot, 'novel.db');
    const database = await SQLiteDatabase.open(databasePath);
    database.exec('DROP TRIGGER IF EXISTS paragraphs_fts_insert');
    database.exec('DROP TRIGGER IF EXISTS paragraphs_fts_delete');
    database.exec('DROP TRIGGER IF EXISTS paragraphs_fts_update');
    database.exec('DROP TABLE paragraph_fts');
    database.exec('CREATE TABLE paragraph_fts (paragraph_id TEXT, text TEXT)');
    database.prepare('INSERT INTO paragraph_fts (paragraph_id, text) VALUES (?, ?)').run('stale', '伪索引内容');
    database.prepare("DELETE FROM settings WHERE key = 'paragraph-fts-version'").run();
    database.close();

    await store.open(projectRoot);
    try {
      const reopened = new EditorService(store);
      expect(reopened.search('100%')).toHaveLength(1);
      expect(reopened.search('伪索引内容')).toEqual([]);
      const counts = store.get().db.prepare(`SELECT
        (SELECT COUNT(*) FROM paragraphs) AS paragraphCount,
        (SELECT COUNT(*) FROM paragraph_fts) AS indexCount`).get();
      expect(counts).toMatchObject({
        paragraphCount: expect.any(Number),
        indexCount: expect.any(Number),
      });
      expect((counts as { paragraphCount: number; indexCount: number }).indexCount)
        .toBe((counts as { paragraphCount: number; indexCount: number }).paragraphCount);
    } finally {
      await store.close();
    }
  });
});
