import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import archiver from 'archiver';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupService } from '../../electron/worker/backup-service';
import { ProjectStore } from '../../electron/worker/project-store';
import { SCHEMA_VERSION } from '../../electron/worker/schema';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fsp.rm(target, { recursive: true, force: true })));
});

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeZip(outputPath: string, entries: Array<{ name: string; content: Buffer | string }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(outputPath, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) archive.append(entry.content, { name: entry.name });
    void archive.finalize();
  });
}

describe('backup restore safety', () => {
  it('restores a verified backup into a new project without overwriting', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'novel-backup-restore-'));
    cleanupPaths.push(tempRoot);
    const originalRoot = path.join(tempRoot, '原工程.novelworld');
    const restoreParent = path.join(tempRoot, 'restored');
    await fsp.mkdir(restoreParent);
    const store = new ProjectStore();
    const restoredStore = new ProjectStore();
    try {
      const original = await store.create('原工程', originalRoot);
      const preservedSource = path.join(originalRoot, 'sources', 'manual-note.txt');
      await fsp.writeFile(preservedSource, '这一行必须完整恢复。', 'utf8');
      // Copied older projects may omit empty temporary directories.
      await fsp.rmdir(path.join(originalRoot, 'tmp'));
      const backupPath = path.join(tempRoot, 'verified.novelproj');
      await new BackupService(store).create(backupPath);

      const restored = await new BackupService(store).restore(backupPath, restoreParent);
      expect(restored.projectId).toBe(original.id);
      expect(restored.fileCount).toBe(3);
      expect(restored.projectPath).toBe(path.join(restoreParent, '原工程.novelworld'));
      expect(await fsp.readFile(path.join(restored.projectPath, 'sources', 'manual-note.txt'), 'utf8')).toBe('这一行必须完整恢复。');
      const opened = await restoredStore.open(restored.projectPath);
      expect(opened.id).toBe(original.id);
      expect(opened.rootPath).toBe(restored.projectPath);

      await expect(new BackupService(store).restore(backupPath, restoreParent)).rejects.toThrow('恢复不会覆盖');
    } finally {
      await restoredStore.close();
      await store.close();
    }
  });

  it('rejects unknown archive entries and traversal paths', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'novel-backup-hostile-'));
    cleanupPaths.push(tempRoot);
    const unknownPath = path.join(tempRoot, 'unknown.novelproj');
    await writeZip(unknownPath, [{ name: 'evil.txt', content: 'unexpected' }]);
    await expect(new BackupService(new ProjectStore()).restore(unknownPath, tempRoot)).rejects.toThrow('未知条目');

    const traversalPath = path.join(tempRoot, 'traversal.novelproj');
    await writeZip(traversalPath, [{ name: 'safefile.tx', content: 'escape attempt' }]);
    const zipBytes = await fsp.readFile(traversalPath);
    const safeName = Buffer.from('safefile.tx');
    const hostileName = Buffer.from('../evil.txt');
    let replacementCount = 0;
    for (let offset = zipBytes.indexOf(safeName); offset >= 0; offset = zipBytes.indexOf(safeName, offset + hostileName.length)) {
      hostileName.copy(zipBytes, offset);
      replacementCount += 1;
    }
    expect(replacementCount).toBe(2);
    await fsp.writeFile(traversalPath, zipBytes);
    await expect(new BackupService(new ProjectStore()).restore(traversalPath, tempRoot)).rejects.toThrow('不安全路径');
    await expect(fsp.access(path.join(tempRoot, 'evil.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a backup whose content does not match its checksum manifest', async () => {
    const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'novel-backup-tampered-'));
    cleanupPaths.push(tempRoot);
    const backupPath = path.join(tempRoot, 'tampered.novelproj');
    const manifest = Buffer.from(JSON.stringify({
      format: 'novel-world-project',
      schemaVersion: SCHEMA_VERSION,
      projectId: randomUUID(),
      name: '被篡改的工程',
      createdAt: new Date().toISOString(),
    }));
    const database = Buffer.from('not a valid database');
    const checksums = Buffer.from(JSON.stringify({
      'manifest.json': sha256(manifest),
      'novel.db': '0'.repeat(64),
    }));
    await writeZip(backupPath, [
      { name: 'manifest.json', content: manifest },
      { name: 'novel.db', content: database },
      { name: 'checksums.sha256.json', content: checksums },
    ]);

    await expect(new BackupService(new ProjectStore()).restore(backupPath, tempRoot)).rejects.toThrow('novel.db 已损坏');
    expect((await fsp.readdir(tempRoot)).some((name) => name.includes('.restore-'))).toBe(false);
  });
});
