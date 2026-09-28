import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ProjectDiagnosticCheck,
  ProjectDiagnosticReport,
  ProjectDiagnosticStatus,
} from '../../src/shared/contracts';
import { SCHEMA_VERSION } from './schema';
import type { ProjectStore } from './project-store';

type RevisionRow = {
  id: string;
  originalName: string;
  originalPath: string;
  normalizedPath: string;
  encoding: string;
  sha256: string;
  byteSize: number;
};

async function fileState(filePath: string): Promise<{ exists: boolean; size: number }> {
  try {
    const value = await fs.stat(filePath);
    return { exists: value.isFile(), size: value.isFile() ? value.size : 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, size: 0 };
    throw error;
  }
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

function overallStatus(checks: ProjectDiagnosticCheck[]): ProjectDiagnosticStatus {
  if (checks.some((check) => check.status === 'error')) return 'error';
  if (checks.some((check) => check.status === 'warning')) return 'warning';
  return 'ok';
}

export class ProjectDiagnosticService {
  constructor(private readonly store: ProjectStore) {}

  async run(mode: 'quick' | 'full'): Promise<ProjectDiagnosticReport> {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    const { db, projectId, rootPath } = this.store.get();
    const checks: ProjectDiagnosticCheck[] = [];

    const schemaVersion = Number((db.prepare('SELECT COALESCE(MAX(version), 0) AS value FROM schema_migrations').get() as { value: number }).value);
    const storageRow = db.prepare("SELECT value_json AS valueJson FROM settings WHERE key = 'storage-engine'").get() as { valueJson: string } | undefined;
    let storageEngine: string | null = null;
    try { storageEngine = storageRow ? String(JSON.parse(storageRow.valueJson)) : null; } catch { storageEngine = null; }

    try {
      const manifest = JSON.parse(await fs.readFile(path.join(rootPath, 'project.json'), 'utf8')) as {
        format?: string; schemaVersion?: number; projectId?: string;
      };
      const valid = manifest.format === 'novel-world-project' && manifest.projectId === projectId && manifest.schemaVersion === SCHEMA_VERSION;
      checks.push({
        id: 'manifest', label: '工程清单', status: valid ? 'ok' : 'error',
        summary: valid ? 'project.json 与当前工程一致' : 'project.json 与数据库或当前 schema 不一致',
        detail: `project ${String(manifest.projectId ?? 'unknown')} · schema v${String(manifest.schemaVersion ?? 'unknown')}`,
      });
    } catch (error) {
      checks.push({ id: 'manifest', label: '工程清单', status: 'error', summary: 'project.json 无法读取或解析', detail: error instanceof Error ? error.message : String(error) });
    }

    checks.push({
      id: 'schema', label: 'Schema', status: schemaVersion === SCHEMA_VERSION ? 'ok' : 'error',
      summary: schemaVersion === SCHEMA_VERSION ? `当前为 schema v${schemaVersion}` : `当前 v${schemaVersion}，应用要求 v${SCHEMA_VERSION}`,
    });
    checks.push({
      id: 'storage', label: '存储引擎', status: storageEngine === 'node:sqlite-v1' ? 'ok' : 'error',
      summary: storageEngine === 'node:sqlite-v1' ? 'node:sqlite 文件直连存储' : '未识别或尚未完成原生存储迁移',
      detail: storageEngine ?? '未登记',
    });

    const integrity = db.integrityReport(mode);
    const integrityOk = integrity.integrity.length === 1 && integrity.integrity[0]?.toLowerCase() === 'ok';
    checks.push({
      id: 'database', label: mode === 'full' ? 'SQLite 严格检查' : 'SQLite 快速检查',
      status: integrityOk && integrity.foreignKeyViolations.length === 0 ? 'ok' : 'error',
      summary: integrityOk && integrity.foreignKeyViolations.length === 0
        ? `${mode === 'full' ? 'integrity_check' : 'quick_check'} 与外键检查通过`
        : `完整性结果 ${integrity.integrity.join('；') || '未知'}，外键错误 ${integrity.foreignKeyViolations.length} 条`,
    });

    const paragraphCount = Number((db.prepare('SELECT COUNT(*) AS value FROM paragraphs').get() as { value: number }).value);
    const ftsRowCount = Number((db.prepare('SELECT COUNT(*) AS value FROM paragraph_fts').get() as { value: number }).value);
    const ftsTriggers = Number((db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type = 'trigger' AND name IN ('paragraphs_fts_insert','paragraphs_fts_delete','paragraphs_fts_update')").get() as { value: number }).value);
    const ftsOk = paragraphCount === ftsRowCount && ftsTriggers === 3;
    checks.push({
      id: 'fts', label: '全文检索索引', status: ftsOk ? 'ok' : 'error',
      summary: ftsOk ? `FTS5 已覆盖 ${ftsRowCount} 个段落` : `段落 ${paragraphCount}、索引 ${ftsRowCount}、触发器 ${ftsTriggers}/3`,
      detail: 'trigram FTS5 · 增删改触发同步',
    });

    const sourceSpanCount = Number((db.prepare('SELECT COUNT(*) AS value FROM source_spans').get() as { value: number }).value);
    const unresolvedSourceSpanCount = Number((db.prepare("SELECT COUNT(*) AS value FROM source_spans WHERE alignment_status IN ('ambiguous','invalid')").get() as { value: number }).value);
    checks.push({
      id: 'source-spans', label: '原文定位', status: unresolvedSourceSpanCount ? 'warning' : 'ok',
      summary: sourceSpanCount
        ? `${sourceSpanCount} 条定位，${unresolvedSourceSpanCount} 条歧义或失效`
        : '尚无 SourceSpan；导入后会随证据生成',
      detail: '读取时会重新验证 UTF-16 范围',
    });

    const revision = db.prepare(`SELECT r.id, r.original_name AS originalName, r.original_path AS originalPath,
      r.normalized_path AS normalizedPath, r.encoding, r.sha256, r.byte_size AS byteSize
      FROM projects p LEFT JOIN source_revisions r ON r.id = p.active_revision_id WHERE p.id = ?`).get(projectId) as RevisionRow | undefined;
    let source: ProjectDiagnosticReport['source'] = null;
    if (revision?.id) {
      const originalAbsolute = path.resolve(rootPath, revision.originalPath);
      const normalizedAbsolute = path.resolve(rootPath, revision.normalizedPath);
      const [original, normalized] = await Promise.all([fileState(originalAbsolute), fileState(normalizedAbsolute)]);
      const checksumMatches = mode === 'full' && original.exists ? await fileSha256(originalAbsolute).then((value) => value === revision.sha256) : null;
      source = {
        revisionId: revision.id, originalName: revision.originalName, encoding: revision.encoding,
        byteSize: revision.byteSize, sha256: revision.sha256, originalPath: revision.originalPath,
        normalizedPath: revision.normalizedPath, originalExists: original.exists,
        normalizedExists: normalized.exists, checksumMatches,
      };
      const sourceOk = original.exists && normalized.exists && original.size === revision.byteSize && checksumMatches !== false;
      checks.push({
        id: 'source', label: '来源文件', status: sourceOk ? 'ok' : 'error',
        summary: !original.exists || !normalized.exists
          ? '保留的原始文件或规范文本缺失'
          : original.size !== revision.byteSize
            ? `原始文件大小不符：${original.size} / ${revision.byteSize} bytes`
            : checksumMatches === false ? '原始文件 SHA-256 与导入记录不一致'
              : mode === 'full' ? '原始文件与规范文本存在，SHA-256 通过' : '原始文件与规范文本存在，大小一致',
        detail: `${revision.originalName} · ${revision.encoding}`,
      });
    } else {
      checks.push({ id: 'source', label: '来源文件', status: 'warning', summary: '工程尚未导入小说版本' });
    }

    const backupRoot = path.join(rootPath, 'backups');
    const backupEntries = await fs.readdir(backupRoot, { withFileTypes: true }).catch(() => []);
    const backupFiles = await Promise.all(backupEntries.filter((entry) => entry.isFile()).map(async (entry) => ({
      name: entry.name,
      modifiedAt: (await fs.stat(path.join(backupRoot, entry.name))).mtimeMs,
    })));
    backupFiles.sort((left, right) => right.modifiedAt - left.modifiedAt);
    checks.push({
      id: 'backups', label: '内部安全快照', status: 'ok',
      summary: backupFiles.length ? `${backupFiles.length} 个迁移前快照` : '当前没有迁移前快照',
      detail: backupFiles[0]?.name ?? '导出的 .novelproj 由用户选择位置，不在工程内登记',
    });

    return {
      checkedAt, mode, durationMs: Date.now() - startedAt, overallStatus: overallStatus(checks),
      schemaVersion, expectedSchemaVersion: SCHEMA_VERSION, storageEngine,
      paragraphCount, ftsRowCount, sourceSpanCount, unresolvedSourceSpanCount,
      foreignKeyViolationCount: integrity.foreignKeyViolations.length,
      internalBackupCount: backupFiles.length, latestInternalBackup: backupFiles[0]?.name ?? null,
      source, checks,
    };
  }
}
