import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SQLiteDatabase } from '../../electron/worker/sqlite-db';
import { ProjectStore } from '../../electron/worker/project-store';
import { BASE_SCHEMA_VERSION, SCHEMA_VERSION, schemaMigrations, schemaSql } from '../../electron/worker/schema';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

function firstValue(row: Record<string, unknown> | undefined): unknown {
  return row ? Object.values(row)[0] : undefined;
}

describe('native SQLite persistence', () => {
  it('persists committed writes without exporting or flushing the full database', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-sqlite-'));
    cleanupPaths.push(root);
    const databasePath = path.join(root, 'native.db');

    const database = await SQLiteDatabase.open(databasePath);
    database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    database.prepare('INSERT INTO sample (value) VALUES (?)').run('already-on-disk');
    expect(firstValue(database.prepare('PRAGMA journal_mode').get())).toBe('wal');
    expect(Number(firstValue(database.prepare('PRAGMA synchronous').get()))).toBe(2);
    expect(Number(firstValue(database.prepare('PRAGMA foreign_keys').get()))).toBe(1);
    database.close();

    const reopened = await SQLiteDatabase.open(databasePath);
    expect(reopened.prepare('SELECT value FROM sample WHERE id = 1').get()).toMatchObject({ value: 'already-on-disk' });
    expect(reopened.integrityReport()).toEqual({ integrity: ['ok'], foreignKeyViolations: [] });
    expect(reopened.integrityReport('quick')).toEqual({ integrity: ['ok'], foreignKeyViolations: [] });
    reopened.close();
  });

  it('keeps foreign-key verification enabled in quick mode', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-quick-check-'));
    cleanupPaths.push(root);
    const database = await SQLiteDatabase.open(path.join(root, 'quick-check.db'));
    database.exec('CREATE TABLE parents (id INTEGER PRIMARY KEY)');
    database.exec('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))');
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('INSERT INTO children (id, parent_id) VALUES (?, ?)').run(1, 999);
    const report = database.integrityReport('quick');
    expect(report.integrity).toEqual(['ok']);
    expect(report.foreignKeyViolations).toHaveLength(1);
    expect(() => database.assertIntegrity('quick')).toThrow('外键错误');
    database.close();
  });

  it('uses quick checks for ordinary reopen and full checks before storage migration', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-check-policy-'));
    cleanupPaths.push(root);
    const projectRoot = path.join(root, '检查策略.novelworld');
    const store = new ProjectStore();
    const original = SQLiteDatabase.prototype.assertIntegrity;
    const modes: string[] = [];
    const spy = vi.spyOn(SQLiteDatabase.prototype, 'assertIntegrity').mockImplementation(function (
      this: SQLiteDatabase,
      mode: 'quick' | 'full' = 'full',
    ) {
      modes.push(mode);
      return original.call(this, mode);
    });
    try {
      await store.create('检查策略', projectRoot);
      await store.close();
      modes.length = 0;

      await store.open(projectRoot);
      expect(modes).toEqual(['quick']);
      store.get().db.prepare("DELETE FROM settings WHERE key = 'storage-engine'").run();
      await store.close();
      modes.length = 0;

      await store.open(projectRoot);
      expect(modes).toEqual(['quick', 'full']);
    } finally {
      await store.close();
      spy.mockRestore();
    }
  });

  it('creates a consistent online backup while the source remains open', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-backup-'));
    cleanupPaths.push(root);
    const sourcePath = path.join(root, 'source.db');
    const backupPath = path.join(root, 'backup.db');

    const source = await SQLiteDatabase.open(sourcePath);
    source.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    source.prepare('INSERT INTO sample (value) VALUES (?)').run('included');
    await source.backup(backupPath);
    source.prepare('INSERT INTO sample (value) VALUES (?)').run('after-snapshot');

    const snapshot = await SQLiteDatabase.open(backupPath);
    expect(snapshot.prepare('SELECT value FROM sample ORDER BY id').all()).toEqual([{ value: 'included' }]);
    snapshot.assertIntegrity();
    snapshot.close();
    source.close();
  });

  it('backs up an unmarked legacy project once before marking it as native', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-migration-'));
    cleanupPaths.push(root);
    const projectRoot = path.join(root, '旧工程.novelworld');
    const store = new ProjectStore();
    await store.create('旧工程', projectRoot);
    store.get().db.prepare('DELETE FROM settings WHERE key = ?').run('storage-engine');
    await store.close();

    await store.open(projectRoot);
    const marker = store.get().db.prepare('SELECT value_json AS valueJson FROM settings WHERE key = ?').get('storage-engine');
    expect(marker).toMatchObject({ valueJson: JSON.stringify('node:sqlite-v1') });
    await store.close();

    const backupPath = path.join(projectRoot, 'backups', 'pre-node-sqlite-v' + SCHEMA_VERSION + '.db');
    await expect(fs.stat(backupPath)).resolves.toMatchObject({ size: expect.any(Number) });
    const firstModifiedAt = (await fs.stat(backupPath)).mtimeMs;

    await store.open(projectRoot);
    await store.close();
    expect((await fs.stat(backupPath)).mtimeMs).toBe(firstModifiedAt);
  });

  it('creates a pre-schema backup before upgrading an already-native v19 project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-native-v19-'));
    cleanupPaths.push(root);
    const projectRoot = path.join(root, '原生V19.novelworld');
    await fs.mkdir(projectRoot);
    const projectId = randomUUID();
    const createdAt = new Date().toISOString();
    await fs.writeFile(path.join(projectRoot, 'project.json'), JSON.stringify({
      format: 'novel-world-project',
      schemaVersion: 19,
      projectId,
      name: '原生V19',
      createdAt,
    }, null, 2), 'utf8');

    const database = await SQLiteDatabase.open(path.join(projectRoot, 'novel.db'));
    database.exec(schemaSql);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(BASE_SCHEMA_VERSION, createdAt);
    for (const migration of schemaMigrations.filter((item) => item.version <= 19)) {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, createdAt);
    }
    database.prepare('INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(projectId, '原生V19', projectRoot, createdAt, createdAt);
    database.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('storage-engine', JSON.stringify('node:sqlite-v1'), createdAt);
    database.close();

    const store = new ProjectStore();
    await store.open(projectRoot);
    expect(store.get().db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get())
      .toMatchObject({ version: SCHEMA_VERSION });
    await store.close();
    await expect(fs.stat(path.join(projectRoot, 'backups', 'pre-schema-v19.db')))
      .resolves.toMatchObject({ size: expect.any(Number) });
  });
});
