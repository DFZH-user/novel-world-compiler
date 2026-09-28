import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { ProjectDiagnosticService } from '../../electron/worker/project-diagnostic-service';

const cleanupPaths: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-diagnostics-'));
  cleanupPaths.push(root);
  const projectRoot = path.join(root, '诊断测试.novelworld');
  const sourcePath = path.join(root, 'source.txt');
  await fs.writeFile(sourcePath, ['第一章 归来', '陆沉回到青石镇。', '客栈仍在长街尽头。'].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('诊断测试', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  return { store, projectRoot };
}

describe('project diagnostics', () => {
  it('reports a healthy project in quick and full modes', async () => {
    const { store } = await setup();
    try {
      const diagnostics = new ProjectDiagnosticService(store);
      const quick = await diagnostics.run('quick');
      expect(quick).toMatchObject({
        mode: 'quick',
        overallStatus: 'ok',
        storageEngine: 'node:sqlite-v1',
        paragraphCount: 3,
        ftsRowCount: 3,
        foreignKeyViolationCount: 0,
      });
      expect(quick.checks).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'database', status: 'ok' }),
        expect.objectContaining({ id: 'fts', status: 'ok' }),
        expect.objectContaining({ id: 'source', status: 'ok' }),
      ]));
      expect(quick.source?.checksumMatches).toBeNull();

      const full = await diagnostics.run('full');
      expect(full).toMatchObject({ mode: 'full', overallStatus: 'ok' });
      expect(full.source?.checksumMatches).toBe(true);
      expect(full.checks.find((check) => check.id === 'database')?.summary).toContain('integrity_check');
    } finally {
      await store.close();
    }
  });

  it('surfaces FTS drift and a changed preserved original as errors', async () => {
    const { store, projectRoot } = await setup();
    try {
      const diagnostics = new ProjectDiagnosticService(store);
      store.get().db.prepare('DELETE FROM paragraph_fts WHERE rowid = (SELECT MIN(rowid) FROM paragraph_fts)').run();
      const drifted = await diagnostics.run('quick');
      expect(drifted.overallStatus).toBe('error');
      expect(drifted.checks.find((check) => check.id === 'fts')).toMatchObject({ status: 'error' });

      const revision = store.get().db.prepare('SELECT original_path AS originalPath FROM source_revisions WHERE id = (SELECT active_revision_id FROM projects LIMIT 1)')
        .get() as { originalPath: string };
      await fs.writeFile(path.join(projectRoot, revision.originalPath), '内容已被修改', 'utf8');
      const tampered = await diagnostics.run('full');
      expect(tampered.source?.checksumMatches).toBe(false);
      expect(tampered.checks.find((check) => check.id === 'source')).toMatchObject({ status: 'error' });
    } finally {
      await store.close();
    }
  });
});
