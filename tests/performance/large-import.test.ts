import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';

const cleanupPaths: string[] = [];
afterEach(async () => Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))));

async function createSizedNovel(filePath: string, targetBytes: number): Promise<void> {
  const handle = await fs.open(filePath, 'w');
  const paragraph = `${'这是一段用于验证大型小说流式导入、稳定段落定位和中断检查点的中文正文。'.repeat(620)}\n`;
  const bytes = Buffer.from(paragraph, 'utf8');
  let written = 0;
  try {
    await handle.write(Buffer.from('第一章 大文件测试\n', 'utf8'));
    written += Buffer.byteLength('第一章 大文件测试\n', 'utf8');
    while (written < targetBytes) {
      await handle.write(bytes);
      written += bytes.length;
    }
  } finally {
    await handle.close();
  }
}

describe('large TXT streaming import', () => {
  for (const megabytes of [1, 10, 50]) {
    it(`imports and reopens an approximately ${megabytes} MB novel`, async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), `novel-${megabytes}mb-`));
      cleanupPaths.push(tempRoot);
      const sourcePath = path.join(tempRoot, 'large.txt');
      const projectRoot = path.join(tempRoot, 'large.novelworld');
      await createSizedNovel(sourcePath, megabytes * 1024 * 1024);
      const store = new ProjectStore();
      let revisionId = '';
      try {
        await store.create(`${megabytes}MB`, projectRoot);
        const result = await new Importer(store).run(sourcePath, 'utf8');
        revisionId = result.revisionId;
        expect(result.byteSize).toBeGreaterThanOrEqual(megabytes * 1024 * 1024);
        expect(result.paragraphCount).toBeGreaterThan(1);
        expect(result.chapterCount).toBe(1);
      } finally {
        await store.close();
      }
      const reopened = new ProjectStore();
      try {
        const project = await reopened.open(projectRoot);
        expect(project.activeRevisionId).toBe(revisionId);
      } finally {
        await reopened.close();
      }
    }, 120_000);
  }
});
