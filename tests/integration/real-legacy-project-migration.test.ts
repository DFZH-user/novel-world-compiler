import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ProjectStore } from '../../electron/worker/project-store';
import { SCHEMA_VERSION } from '../../electron/worker/schema';

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

const sourceProject = process.env.REAL_LEGACY_PROJECT;

test.skipIf(!sourceProject)('migrates a real legacy project copy without touching the source', async () => {
  const sourceRoot = path.resolve(sourceProject!);
  const sourceDatabase = path.join(sourceRoot, 'novel.db');
  const sourceHashBefore = await sha256(sourceDatabase);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-real-legacy-'));
  const copiedRoot = path.join(tempRoot, path.basename(sourceRoot));
  await fs.cp(sourceRoot, copiedRoot, { recursive: true });

  const store = new ProjectStore();
  try {
    await store.open(copiedRoot);
    const { db } = store.get();
    expect(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()).toMatchObject({ version: SCHEMA_VERSION });
    expect(db.prepare('SELECT COUNT(*) AS count FROM paragraphs').get()).toMatchObject({ count: expect.any(Number) });
    expect(db.prepare('SELECT value_json AS valueJson FROM settings WHERE key = ?').get('storage-engine'))
      .toMatchObject({ valueJson: JSON.stringify('node:sqlite-v1') });
    db.assertIntegrity();
  } finally {
    await store.close();
  }

  const backupPath = path.join(copiedRoot, 'backups', 'pre-node-sqlite-v13.db');
  await expect(fs.stat(backupPath)).resolves.toMatchObject({ size: expect.any(Number) });
  expect(JSON.parse(await fs.readFile(path.join(copiedRoot, 'project.json'), 'utf8'))).toMatchObject({ schemaVersion: SCHEMA_VERSION });
  expect(await sha256(sourceDatabase)).toBe(sourceHashBefore);
  await fs.rm(tempRoot, { recursive: true, force: true });
}, 120_000);
