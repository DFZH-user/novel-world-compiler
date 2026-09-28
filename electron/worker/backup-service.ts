import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import archiver from 'archiver';
import unzipper, { type OpenEntry } from 'unzipper';
import { z } from 'zod';
import type { ProjectStore } from './project-store';
import { ProjectStore as RestoreProjectStore } from './project-store';
import { SCHEMA_VERSION } from './schema';
import type { BackupRestoreResult } from '../../src/shared/contracts';

const MAX_ARCHIVE_ENTRIES = 100_000;
const MAX_UNCOMPRESSED_BYTES = 4 * 1024 ** 3;
const MAX_MANIFEST_BYTES = 1024 ** 2;
const MAX_CHECKSUM_BYTES = 16 * 1024 ** 2;

const backupManifestSchema = z.object({
  format: z.literal('novel-world-project'),
  schemaVersion: z.number().int().positive().max(SCHEMA_VERSION),
  projectId: z.string().uuid(),
  name: z.string().trim().min(1),
  createdAt: z.string().min(1),
});

const checksumManifestSchema = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/i));

function safeFolderName(name: string): string {
  const result = name.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/[. ]+$/g, '');
  if (!result) throw new Error('备份中的工程名称无效');
  return result.slice(0, 80);
}

function validateArchivePath(rawPath: string): string {
  if (!rawPath || rawPath.includes('\0') || rawPath.includes('\\') || path.posix.isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath)) {
    throw new Error(`备份包含不安全路径：${rawPath || '(空路径)'}`);
  }
  const withoutTrailingSlash = rawPath.replace(/\/+$/g, '');
  const normalized = path.posix.normalize(withoutTrailingSlash);
  if (!normalized || normalized === '.' || normalized !== withoutTrailingSlash || normalized.split('/').includes('..')) {
    throw new Error(`备份包含不安全路径：${rawPath}`);
  }
  return normalized;
}

function validateEntryType(entry: OpenEntry): void {
  if (entry.type !== 'File' && entry.type !== 'Directory') throw new Error(`备份包含不支持的条目类型：${entry.path}`);
  const unixMode = (Number(entry.externalFileAttributes ?? 0) >>> 16) & 0xffff;
  const unixType = unixMode & 0o170000;
  if (unixType === 0o120000) throw new Error(`备份不允许符号链接：${entry.path}`);
}

function allowedArchivePath(archivePath: string, type: OpenEntry['type']): boolean {
  if (type === 'Directory') return archivePath === 'sources' || archivePath.startsWith('sources/');
  return archivePath === 'manifest.json'
    || archivePath === 'novel.db'
    || archivePath === 'checksums.sha256.json'
    || archivePath.startsWith('sources/');
}

function bufferHash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fsp.access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function fileHash(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', resolve);
  });
  return hash.digest('hex');
}

async function listFiles(rootPath: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) result.push(fullPath);
    }
  }
  await visit(rootPath);
  return result;
}

export class BackupService {
  constructor(private readonly store: ProjectStore) {}

  async create(outputPath: string): Promise<{ outputPath: string; checksum: string }> {
    const { rootPath, db } = this.store.get();
    const tempDir = path.join(rootPath, 'tmp', `backup-${randomUUID()}`);
    await fsp.mkdir(path.dirname(tempDir), { recursive: true });
    await fsp.mkdir(tempDir, { recursive: false });
    const snapshotPath = path.join(tempDir, 'novel.db');
    try {
      await db.backup(snapshotPath);
      const projectManifestPath = path.join(rootPath, 'project.json');
      const sourceRoot = path.join(rootPath, 'sources');
      const checksums: Record<string, string> = {
        'manifest.json': await fileHash(projectManifestPath),
        'novel.db': await fileHash(snapshotPath),
      };
      for (const filePath of await listFiles(sourceRoot)) {
        const archivePath = path.posix.join('sources', path.relative(sourceRoot, filePath).split(path.sep).join('/'));
        checksums[archivePath] = await fileHash(filePath);
      }
      const checksumPath = path.join(tempDir, 'checksums.sha256.json');
      await fsp.writeFile(checksumPath, JSON.stringify(checksums, null, 2), 'utf8');
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(outputPath, { flags: 'w' });
        const archive = archiver('zip', { zlib: { level: 6 } });
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);
        archive.file(projectManifestPath, { name: 'manifest.json' });
        archive.file(snapshotPath, { name: 'novel.db' });
        archive.directory(sourceRoot, 'sources');
        archive.file(checksumPath, { name: 'checksums.sha256.json' });
        void archive.finalize();
      });
      return { outputPath, checksum: await fileHash(outputPath) };
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  }

  async restore(inputPath: string, targetParent: string): Promise<BackupRestoreResult> {
    const parentPath = path.resolve(targetParent);
    const parentStat = await fsp.stat(parentPath);
    if (!parentStat.isDirectory()) throw new Error('备份恢复位置必须是文件夹');

    const directory = await unzipper.Open.file(inputPath);
    if (directory.files.length > MAX_ARCHIVE_ENTRIES) throw new Error('备份文件条目过多，已拒绝恢复');

    const entries = new Map<string, OpenEntry>();
    let totalUncompressedBytes = 0;
    for (const entry of directory.files) {
      validateEntryType(entry);
      const archivePath = validateArchivePath(entry.path);
      if (!allowedArchivePath(archivePath, entry.type)) throw new Error(`备份包含未知条目：${archivePath}`);
      if (entries.has(archivePath)) throw new Error(`备份包含重复条目：${archivePath}`);
      entries.set(archivePath, entry);
      const size = Number(entry.uncompressedSize);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error(`备份条目大小无效：${archivePath}`);
      totalUncompressedBytes += size;
      if (!Number.isSafeInteger(totalUncompressedBytes) || totalUncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('备份解压后超过 4 GB 安全上限');
      }
    }

    const manifestEntry = entries.get('manifest.json');
    const databaseEntry = entries.get('novel.db');
    const checksumEntry = entries.get('checksums.sha256.json');
    if (!manifestEntry || manifestEntry.type !== 'File' || !databaseEntry || databaseEntry.type !== 'File' || !checksumEntry || checksumEntry.type !== 'File') {
      throw new Error('备份缺少 manifest.json、novel.db 或 checksums.sha256.json');
    }
    if (manifestEntry.uncompressedSize > MAX_MANIFEST_BYTES || checksumEntry.uncompressedSize > MAX_CHECKSUM_BYTES) {
      throw new Error('备份清单异常大，已拒绝恢复');
    }

    const manifestBuffer = await manifestEntry.buffer();
    const checksumBuffer = await checksumEntry.buffer();
    const manifest = backupManifestSchema.parse(JSON.parse(manifestBuffer.toString('utf8')));
    const checksums = checksumManifestSchema.parse(JSON.parse(checksumBuffer.toString('utf8')));
    const contentPaths = [...entries.entries()]
      .filter(([archivePath, entry]) => entry.type === 'File' && archivePath !== 'checksums.sha256.json')
      .map(([archivePath]) => archivePath)
      .sort();
    const checksumPaths = Object.keys(checksums).map(validateArchivePath).sort();
    if (new Set(checksumPaths).size !== checksumPaths.length || checksumPaths.some((archivePath) => archivePath === 'checksums.sha256.json')) {
      throw new Error('备份校验清单包含重复或无效条目');
    }
    if (contentPaths.length !== checksumPaths.length || contentPaths.some((archivePath, index) => archivePath !== checksumPaths[index])) {
      throw new Error('备份内容与校验清单不一致');
    }
    if (bufferHash(manifestBuffer) !== checksums['manifest.json']) throw new Error('备份校验失败：manifest.json 已损坏');

    const finalPath = path.join(parentPath, `${safeFolderName(manifest.name)}.novelworld`);
    if (await exists(finalPath)) throw new Error(`目标工程目录已存在，恢复不会覆盖：${finalPath}`);
    const tempPath = path.join(parentPath, `.${safeFolderName(manifest.name)}.restore-${randomUUID()}.tmp`);
    await fsp.mkdir(tempPath, { recursive: false });
    let renamed = false;
    try {
      await fsp.mkdir(path.join(tempPath, 'sources'), { recursive: true });
      await fsp.mkdir(path.join(tempPath, 'tmp'), { recursive: true });
      for (const archivePath of contentPaths) {
        const entry = entries.get(archivePath)!;
        const destinationRelativePath = archivePath === 'manifest.json' ? 'project.json' : archivePath;
        const destinationPath = path.resolve(tempPath, ...destinationRelativePath.split('/'));
        if (path.dirname(destinationPath) !== tempPath && !path.dirname(destinationPath).startsWith(`${tempPath}${path.sep}`)) {
          throw new Error(`备份包含越界路径：${archivePath}`);
        }
        await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
        const hash = createHash('sha256');
        let writtenBytes = 0;
        const verifier = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            writtenBytes += chunk.length;
            if (writtenBytes > entry.uncompressedSize) return callback(new Error(`备份条目大小不一致：${archivePath}`));
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        await pipeline(entry.stream(), verifier, fs.createWriteStream(destinationPath, { flags: 'wx' }));
        if (writtenBytes !== entry.uncompressedSize || hash.digest('hex') !== checksums[archivePath].toLowerCase()) {
          throw new Error(`备份校验失败：${archivePath} 已损坏`);
        }
      }

      const verificationStore = new RestoreProjectStore();
      try {
        const summary = await verificationStore.open(tempPath);
        if (summary.id !== manifest.projectId) throw new Error('备份工程清单与数据库不匹配');
        const { db } = verificationStore.get();
        db.prepare('UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?')
          .run(finalPath, new Date().toISOString(), manifest.projectId);
        db.assertIntegrity();
      } finally {
        await verificationStore.close();
      }

      await fsp.rename(tempPath, finalPath);
      renamed = true;
      return {
        projectPath: finalPath,
        projectId: manifest.projectId,
        name: manifest.name,
        fileCount: contentPaths.length,
      };
    } finally {
      if (!renamed) await fsp.rm(tempPath, { recursive: true, force: true });
    }
  }
}
