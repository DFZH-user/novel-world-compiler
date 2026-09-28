import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { TimelineService } from '../../electron/worker/timeline-service';
import { SCHEMA_VERSION } from '../../electron/worker/schema';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

describe('phase 1C timeline foundation', () => {
  it('scans reviewable time expressions idempotently and preserves review edits', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-timeline-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '时间线.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 重逢',
      '二〇二四年三月五日，陆沉回到青石镇。',
      '三日后，他在下午三点见到林月。',
      '这句将在扫描前被排除：翌日他离开。',
    ].join('\n'), 'utf8');

    const store = new ProjectStore();
    try {
      await store.create('时间线', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      const excluded = editor.listParagraphs().find((paragraph) => paragraph.text.includes('扫描前被排除'))!;
      editor.setParagraphExcluded(excluded.id, true);

      const timeline = new TimelineService(store);
      const first = timeline.scanTimeExpressions();
      expect(first).toMatchObject({ detectedCount: 3, insertedCount: 3, totalCount: 3, pendingCount: 3, normalizedCount: 2 });
      expect(timeline.scanTimeExpressions()).toMatchObject({ detectedCount: 3, insertedCount: 0, totalCount: 3 });

      let expressions = timeline.listTimeExpressions();
      expect(expressions.map((item) => item.surfaceText)).toEqual(['二〇二四年三月五日', '三日后', '下午三点']);
      const relative = expressions.find((item) => item.surfaceText === '三日后')!;
      expressions = timeline.reviewTimeExpression(relative.id, 'confirmed', 'RELATIVE:AFTER:P3D');
      expect(expressions.find((item) => item.id === relative.id)).toMatchObject({ reviewStatus: 'confirmed', normalizedValue: 'RELATIVE:AFTER:P3D' });
      timeline.scanTimeExpressions();
      expect(timeline.listTimeExpressions('confirmed')[0]).toMatchObject({ id: relative.id, normalizedValue: 'RELATIVE:AFTER:P3D' });
    } finally {
      await store.close();
    }
  });

  it('opens a v8 manifest, adds current timeline tables and upgrades the manifest without losing existing data', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-v13-migration-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '旧工程.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, '第一章\n旧工程内容。', 'utf8');
    const initialStore = new ProjectStore();
    await initialStore.create('旧工程', projectRoot);
    const imported = await new Importer(initialStore).run(sourcePath, 'utf8');
    await initialStore.close();

    const manifestPath = path.join(projectRoot, 'project.json');
    const oldManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await fs.writeFile(manifestPath, JSON.stringify({ ...oldManifest, schemaVersion: 8 }, null, 2), 'utf8');

    const reopened = new ProjectStore();
    try {
      const summary = await reopened.open(projectRoot);
      expect(summary.activeRevisionId).toBe(imported.revisionId);
      const { db } = reopened.get();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timeline_events'`).get()).toBeTruthy();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'timeline_time_expressions'`).get()).toBeTruthy();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_card_drafts'`).get()).toBeTruthy();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_card_refinements'`).get()).toBeTruthy();
      expect(Number((db.prepare('SELECT COUNT(*) AS count FROM paragraphs').get() as { count: number }).count)).toBe(2);
      const upgradedManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { schemaVersion: number };
      expect(upgradedManifest.schemaVersion).toBe(SCHEMA_VERSION);
    } finally {
      await reopened.close();
    }
  });
});
