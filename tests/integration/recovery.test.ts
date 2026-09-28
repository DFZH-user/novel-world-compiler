import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';

const cleanupPaths: string[] = [];
afterEach(async () => Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))));

describe('failure and restart recovery', () => {
  it('records an I/O failure without activating a broken revision', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-failure-'));
    cleanupPaths.push(tempRoot);
    const store = new ProjectStore();
    try {
      await store.create('失败测试', path.join(tempRoot, 'project.novelworld'));
      await expect(new Importer(store).run(tempRoot, 'utf8')).rejects.toThrow();
      expect(store.getSummary()?.activeRevisionId).toBeNull();
      const jobs = new EditorService(store).listJobs();
      expect(jobs[0].state).toBe('failed');
      expect(jobs[0].progress).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('turns a stale running job into an explicit recoverable queue item on reopen', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-recovery-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, 'project.novelworld');
    const first = new ProjectStore();
    const project = await first.create('恢复测试', projectRoot);
    const timestamp = new Date().toISOString();
    first.get().db.prepare(`INSERT INTO jobs
      (id, project_id, type, state, progress, message, input_json, lease_owner, lease_expires_at, created_at, updated_at)
      VALUES (?, ?, 'import', 'running', 0.42, '处理中', ?, 'old-process', ?, ?, ?)`)
      .run(randomUUID(), project.id, JSON.stringify({ sourcePath: 'missing.txt', encoding: 'utf8' }), timestamp, timestamp, timestamp);
    await first.close();

    const reopened = new ProjectStore();
    try {
      await reopened.open(projectRoot);
      const jobs = new EditorService(reopened).listJobs();
      expect(jobs[0].state).toBe('queued');
      expect(jobs[0].message).toContain('等待恢复');
      expect(jobs[0].progress).toBeCloseTo(0.42);
    } finally {
      await reopened.close();
    }
  });
});
