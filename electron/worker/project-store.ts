import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProjectSummary } from '../../src/shared/contracts';
import { BASE_SCHEMA_VERSION, SCHEMA_VERSION, schemaMigrations, schemaSql } from './schema';
import { SQLiteDatabase } from './sqlite-db';
import { backfillSourceSpans } from './source-span-service';
import { ensureParagraphFts } from './full-text-search';
import { backfillParagraphBoundaries } from './paragraph-boundary-service';

const manifestSchema = z.object({
  format: z.literal('novel-world-project'),
  schemaVersion: z.number().int().positive(),
  projectId: z.string().uuid(),
  name: z.string().min(1),
  createdAt: z.string(),
});

type ProjectContext = { rootPath: string; db: SQLiteDatabase; projectId: string };
const STORAGE_ENGINE_KEY = 'storage-engine';
const STORAGE_ENGINE_VALUE = 'node:sqlite-v1';

function now(): string {
  return new Date().toISOString();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function recordedSchemaVersion(db: SQLiteDatabase): number {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!table) return 0;
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null } | undefined;
  return Number(row?.version ?? 0);
}

function usesNativeStorage(db: SQLiteDatabase): boolean {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get();
  if (!table) return false;
  const row = db.prepare('SELECT value_json AS valueJson FROM settings WHERE key = ?').get(STORAGE_ENGINE_KEY) as { valueJson: string } | undefined;
  return row?.valueJson === JSON.stringify(STORAGE_ENGINE_VALUE);
}

function markNativeStorage(db: SQLiteDatabase): void {
  db.prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at')
    .run(STORAGE_ENGINE_KEY, JSON.stringify(STORAGE_ENGINE_VALUE), now());
}

export class ProjectStore {
  private context: ProjectContext | null = null;

  async create(name: string, rootPath: string): Promise<ProjectSummary> {
    await this.close();
    await fs.mkdir(rootPath, { recursive: false });
    await Promise.all([
      fs.mkdir(path.join(rootPath, 'sources'), { recursive: true }),
      fs.mkdir(path.join(rootPath, 'tmp'), { recursive: true }),
      fs.mkdir(path.join(rootPath, 'backups'), { recursive: true }),
    ]);
    const projectId = randomUUID();
    const createdAt = now();
    const manifest = { format: 'novel-world-project' as const, schemaVersion: SCHEMA_VERSION, projectId, name, createdAt };
    await fs.writeFile(path.join(rootPath, 'project.json'), JSON.stringify(manifest, null, 2), 'utf8');
    const db = await this.openDatabase(path.join(rootPath, 'novel.db'));
    db.prepare(`INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .run(projectId, name, rootPath, createdAt, createdAt);
    this.context = { rootPath, db, projectId };
    return this.getSummary()!;
  }

  async open(rootPath: string): Promise<ProjectSummary> {
    await this.close();
    const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(rootPath, 'project.json'), 'utf8')));
    if (manifest.schemaVersion > SCHEMA_VERSION) throw new Error('这个工程由更高版本的软件创建，请升级应用后再打开');
    await fs.mkdir(path.join(rootPath, 'backups'), { recursive: true });
    const db = await this.openDatabase(path.join(rootPath, 'novel.db'), true);
    const row = db.prepare('SELECT id FROM projects WHERE id = ?').get(manifest.projectId) as { id: string } | undefined;
    if (!row) {
      db.close();
      throw new Error('工程清单与数据库不匹配');
    }
    const interruptedAt = now();
    db.prepare(`UPDATE job_attempts SET state = 'interrupted', finished_at = ?
      WHERE state = 'running' AND job_id IN (SELECT id FROM jobs WHERE state = 'running')`).run(interruptedAt);
    db.prepare(`UPDATE jobs SET state = 'queued', message = '上次运行中断，等待恢复', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE state = 'running'`)
      .run(interruptedAt);
    db.prepare(`UPDATE foundation_workflow_runs
      SET state = 'paused', message = '上次运行中断，可继续执行', updated_at = ?
      WHERE state = 'running'`).run(interruptedAt);
    db.prepare(`UPDATE foundation_workflow_steps
      SET state = 'paused', message = '上次运行中断，可继续执行', updated_at = ?
      WHERE state = 'running'`).run(interruptedAt);
    db.prepare(`UPDATE automation_draft_selection_items SET status = 'pending', error = NULL, updated_at = ?
      WHERE status = 'running' AND run_id IN (
        SELECT id FROM automation_draft_selection_runs WHERE project_id = ?
      )`).run(interruptedAt, manifest.projectId);
    db.prepare(`UPDATE automation_draft_selection_runs
      SET state = 'paused', message = '上次运行中断，可继续执行', updated_at = ?
      WHERE project_id = ? AND state = 'running'`).run(interruptedAt, manifest.projectId);
    db.prepare(`UPDATE automation_draft_quote_items SET status = 'pending', error = NULL, updated_at = ?
      WHERE status = 'running' AND run_id IN (
        SELECT id FROM automation_draft_quote_runs WHERE project_id = ?
      )`).run(interruptedAt, manifest.projectId);
    db.prepare(`UPDATE automation_draft_quote_runs
      SET state = 'paused', message = '上次运行中断，可继续执行', updated_at = ?
      WHERE project_id = ? AND state = 'running'`).run(interruptedAt, manifest.projectId);
    db.prepare(`UPDATE character_chunk_results SET status = 'pending', error = NULL, updated_at = ?
      WHERE status = 'running' AND run_id IN (SELECT id FROM character_scan_runs WHERE project_id = ?)`)
      .run(now(), manifest.projectId);
    db.prepare(`UPDATE character_scan_runs SET status = 'paused', updated_at = ?
      WHERE project_id = ? AND status = 'running'`).run(now(), manifest.projectId);
    db.prepare(`UPDATE character_fact_batches SET status = 'pending', error = NULL, updated_at = ?
      WHERE status = 'running' AND run_id IN (SELECT id FROM character_fact_runs WHERE project_id = ?)`)
      .run(now(), manifest.projectId);
    db.prepare(`UPDATE character_fact_runs SET status = 'paused', updated_at = ?
      WHERE project_id = ? AND status = 'running'`).run(now(), manifest.projectId);
    db.prepare(`UPDATE timeline_event_chunk_results SET status = 'pending', error = NULL, updated_at = ?
      WHERE status = 'running' AND run_id IN (SELECT id FROM timeline_event_runs WHERE project_id = ?)`)
      .run(now(), manifest.projectId);
    db.prepare(`UPDATE timeline_event_runs SET status = 'paused', updated_at = ?
      WHERE project_id = ? AND status = 'running'`).run(now(), manifest.projectId);
    db.prepare(`UPDATE relationship_scan_chunk_results SET status = 'pending', error = NULL, updated_at = ?
      WHERE status = 'running' AND run_id IN (SELECT id FROM relationship_scan_runs WHERE project_id = ?)`)
      .run(now(), manifest.projectId);
    db.prepare(`UPDATE relationship_scan_runs SET status = 'paused', updated_at = ?
      WHERE project_id = ? AND status = 'running'`).run(now(), manifest.projectId);
    db.prepare(`UPDATE place_model_scan_chunk_results SET status = 'pending', error = NULL, updated_at = ?
      WHERE status = 'running' AND run_id IN (SELECT id FROM place_model_scan_runs WHERE project_id = ?)`)
      .run(now(), manifest.projectId);
    db.prepare(`UPDATE place_model_scan_runs SET status = 'paused', updated_at = ?
      WHERE project_id = ? AND status = 'running'`).run(now(), manifest.projectId);
    this.context = { rootPath, db, projectId: manifest.projectId };
    if (manifest.schemaVersion < SCHEMA_VERSION) {
      await fs.writeFile(path.join(rootPath, 'project.json'), JSON.stringify({ ...manifest, schemaVersion: SCHEMA_VERSION }, null, 2), 'utf8');
    }
    return this.getSummary()!;
  }

  get(): ProjectContext {
    if (!this.context) throw new Error('请先新建或打开工程');
    return this.context;
  }

  getSummary(): ProjectSummary | null {
    if (!this.context) return null;
    const row = this.context.db.prepare(`
      SELECT id, name, root_path AS rootPath, active_revision_id AS activeRevisionId,
             created_at AS createdAt, updated_at AS updatedAt
      FROM projects WHERE id = ?
    `).get(this.context.projectId) as ProjectSummary | undefined;
    return row ? { ...row, rootPath: this.context.rootPath } : null;
  }

  async close(): Promise<void> {
    if (!this.context) return;
    this.context.db.close();
    this.context = null;
  }

  private async openDatabase(dbPath: string, protectExisting = false): Promise<SQLiteDatabase> {
    const existingDatabase = protectExisting && await fileExists(dbPath);
    const db = await SQLiteDatabase.open(dbPath);
    let migrated = false;
    try {
      if (existingDatabase) {
        db.assertIntegrity('quick');
        const versionBeforeMigration = recordedSchemaVersion(db);
        const nativeStorage = usesNativeStorage(db);
        const backupName = !nativeStorage
          ? 'pre-node-sqlite-v' + versionBeforeMigration + '.db'
          : versionBeforeMigration < SCHEMA_VERSION
            ? 'pre-schema-v' + versionBeforeMigration + '.db'
            : null;
        if (backupName) {
          db.assertIntegrity('full');
          const backupPath = path.join(path.dirname(dbPath), 'backups', backupName);
          if (!await fileExists(backupPath)) await db.backup(backupPath);
        }
      }
      db.exec(schemaSql);
      const recorded = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null } | undefined;
      let currentVersion = Number(recorded?.version ?? 0);
      if (currentVersion === 0) {
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(BASE_SCHEMA_VERSION, now());
        currentVersion = BASE_SCHEMA_VERSION;
      }
      if (currentVersion > SCHEMA_VERSION) throw new Error('数据库由更高版本的软件创建，请升级应用后再打开');
      for (const migration of schemaMigrations) {
        if (migration.version <= currentVersion) continue;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(migration.sql);
          db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, now());
          db.exec('COMMIT');
          currentVersion = migration.version;
          migrated = true;
        } catch (error) {
          db.exec('ROLLBACK');
          throw new Error(`工程数据库迁移到 schema v${migration.version} 失败`, { cause: error });
        }
      }
      if (currentVersion !== SCHEMA_VERSION) throw new Error(`缺少从 schema v${currentVersion} 到 v${SCHEMA_VERSION} 的迁移`);
      await backfillParagraphBoundaries(db, path.dirname(dbPath));
      backfillSourceSpans(db);
      markNativeStorage(db);
      if (!existingDatabase || migrated) db.assertIntegrity('full');
    } catch (error) {
      db.close();
      throw error;
    }
    ensureParagraphFts(db);
    return db;
  }
}
