import type { SQLiteDatabase } from './sqlite-db';

const PARAGRAPH_FTS_VERSION = 'trigram-v1';

function isFts5Table(db: SQLiteDatabase): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'paragraph_fts'").get() as { sql: string | null } | undefined;
  return Boolean(row?.sql && /CREATE\s+VIRTUAL\s+TABLE[\s\S]+USING\s+fts5/iu.test(row.sql));
}

export function ensureParagraphFts(db: SQLiteDatabase): void {
  const existing = db.prepare("SELECT name FROM sqlite_master WHERE name = 'paragraph_fts'").get();
  const existingIsFts5 = existing ? isFts5Table(db) : false;
  if (existing && !existingIsFts5) {
    db.exec('DROP TRIGGER IF EXISTS paragraphs_fts_insert');
    db.exec('DROP TRIGGER IF EXISTS paragraphs_fts_delete');
    db.exec('DROP TRIGGER IF EXISTS paragraphs_fts_update');
    db.exec('DROP TABLE paragraph_fts');
  }
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS paragraph_fts USING fts5(paragraph_id UNINDEXED, text, tokenize='trigram')");
  db.exec('CREATE TRIGGER IF NOT EXISTS paragraphs_fts_insert AFTER INSERT ON paragraphs BEGIN INSERT INTO paragraph_fts(rowid, paragraph_id, text) VALUES (new.rowid, new.id, new.text); END');
  db.exec('CREATE TRIGGER IF NOT EXISTS paragraphs_fts_delete AFTER DELETE ON paragraphs BEGIN DELETE FROM paragraph_fts WHERE rowid = old.rowid; END');
  db.exec('CREATE TRIGGER IF NOT EXISTS paragraphs_fts_update AFTER UPDATE OF id, text ON paragraphs BEGIN DELETE FROM paragraph_fts WHERE rowid = old.rowid; INSERT INTO paragraph_fts(rowid, paragraph_id, text) VALUES (new.rowid, new.id, new.text); END');

  const paragraphCount = Number((db.prepare('SELECT COUNT(*) AS count FROM paragraphs').get() as { count: number }).count);
  const indexCount = Number((db.prepare('SELECT COUNT(*) AS count FROM paragraph_fts').get() as { count: number }).count);
  const versionRow = db.prepare("SELECT value_json AS valueJson FROM settings WHERE key = 'paragraph-fts-version'").get() as {
    valueJson: string;
  } | undefined;
  const currentVersion = versionRow?.valueJson === JSON.stringify(PARAGRAPH_FTS_VERSION);
  if (!existingIsFts5 || !currentVersion || paragraphCount !== indexCount) {
    db.transaction(() => {
      db.exec('DELETE FROM paragraph_fts');
      db.exec('INSERT INTO paragraph_fts(rowid, paragraph_id, text) SELECT rowid, id, text FROM paragraphs');
      db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('paragraph-fts-version', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(JSON.stringify(PARAGRAPH_FTS_VERSION), new Date().toISOString());
    });
  }
}

export function literalFtsPhrase(query: string): string {
  return '"' + query.replace(/"/gu, '""') + '"';
}
