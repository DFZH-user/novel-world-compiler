import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { BackupService } from '../../electron/worker/backup-service';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe('project phase-zero flow', () => {
  it('creates, imports, edits, searches, chunks and backs up a project', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-compiler-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '测试世界.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '序章',
      '叶凡第一次来到北京。',
      '他站在旧城门外，雨水沿着伞骨落下。',
      '第一章 初见',
      '叶凡看见林月从街角走来。',
      '“你终于来了。”林月说。',
      '第二章 夜行',
      '两人沿着城墙向北走去。',
      '地图上标着一座已经消失的车站。',
    ].join('\r\n'), 'utf8');

    const store = new ProjectStore();
    try {
      const summary = await store.create('测试世界', projectRoot);
      expect(summary.activeRevisionId).toBeNull();
      const importer = new Importer(store);
      const preview = await importer.preview(sourcePath);
      expect(preview.recommendedEncoding).toBe('utf8');
      const imported = await importer.run(sourcePath, preview.recommendedEncoding);
      expect(imported.chapterCount).toBe(3);
      expect(imported.paragraphCount).toBe(9);
      expect((await fs.readFile(path.join(projectRoot, 'sources', imported.revisionId, 'original.txt'))).equals(await fs.readFile(sourcePath))).toBe(true);
      expect(await fs.readFile(path.join(projectRoot, 'sources', imported.revisionId, 'normalized.txt'), 'utf8')).not.toContain('\r');

      const editor = new EditorService(store);
      let chapters = editor.listChapters();
      expect(chapters.map((chapter) => chapter.title)).toEqual(['序章', '第一章 初见', '第二章 夜行']);
      chapters = editor.renameChapter(chapters[1].id, '第一章 · 雨中初见');
      expect(chapters[1].manuallyEdited).toBe(1);
      expect(editor.search('叶凡')).toHaveLength(2);
      expect(editor.search('消失的车站')[0].chapterTitle).toBe('第二章 夜行');
      const evidenceParagraph = editor.listParagraphs(chapters[1].id)[1];
      const evidence = editor.getEvidenceAnchor(evidenceParagraph.id);
      expect(evidence.quote).toContain('叶凡');
      expect(evidence.utf8End).toBeGreaterThan(evidence.utf8Start);
      expect(editor.getEvidenceAnchor(evidenceParagraph.id).id).toBe(evidence.id);

      const splitSource = chapters[1];
      chapters = editor.splitChapter(splitSource.id, splitSource.paragraphStart + 2, '第一章下 · 对话');
      expect(chapters).toHaveLength(4);
      chapters = editor.mergeWithNext(splitSource.id);
      expect(chapters).toHaveLength(3);

      const firstParagraph = editor.listParagraphs(chapters[0].id)[0];
      editor.setParagraphExcluded(firstParagraph.id, true);
      expect(editor.listParagraphs(chapters[0].id)[0].excluded).toBe(1);
      const chunks = editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 100, overlapAfter: 100 });
      expect(chunks.length).toBeGreaterThan(0);

      const backupPath = path.join(tempRoot, 'backup.novelproj');
      const backup = await new BackupService(store).create(backupPath);
      expect(backup.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect((await fs.readFile(backupPath)).subarray(0, 2).toString()).toBe('PK');
      expect(editor.listJobs()[0].state).toBe('completed');
    } finally {
      await store.close();
    }
  });
});
