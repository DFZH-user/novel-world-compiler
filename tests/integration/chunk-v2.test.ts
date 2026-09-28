import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EditorService } from '../../electron/worker/editor-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe('chunk plan v2', () => {
  it('preserves structural boundaries, covers core paragraphs once, and reuses an unchanged plan', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-chunk-v2-'));
    cleanupPaths.push(root);
    const projectRoot = path.join(root, '分块测试.novelworld');
    const sourcePath = path.join(root, 'source.txt');
    await fs.writeFile(sourcePath, [
      '第一章 起点',
      '甲'.repeat(900),
      '乙'.repeat(900),
      '',
      '丙'.repeat(900),
      '第二章 转折',
      '丁'.repeat(900),
      '***',
      '戊'.repeat(900),
      '超'.repeat(4500),
      '终章收束。',
    ].join('\n'), 'utf8');

    const store = new ProjectStore();
    await store.create('分块测试', projectRoot);
    await new Importer(store).run(sourcePath, 'utf8');
    try {
      const db = store.get().db;
      const boundaries = db.prepare(`SELECT text, blank_lines_before AS blankLinesBefore, boundary_before AS boundaryBefore
        FROM paragraphs ORDER BY ordinal`).all() as Array<{ text: string; blankLinesBefore: number; boundaryBefore: string }>;
      expect(boundaries[0]).toMatchObject({ boundaryBefore: 'document' });
      expect(boundaries.find((row) => row.text.startsWith('丙'))).toMatchObject({
        blankLinesBefore: 1,
        boundaryBefore: 'blank_line',
      });
      expect(boundaries.find((row) => row.text === '第二章 转折')).toMatchObject({ boundaryBefore: 'chapter' });
      expect(boundaries.find((row) => row.text === '***')).toMatchObject({ boundaryBefore: 'scene' });

      const editor = new EditorService(store);
      const settings = { coreChars: 1800, softLimit: 2700, hardLimit: 3600, overlapBefore: 300, overlapAfter: 300 };
      const first = editor.buildChunks(settings);
      const firstPlanCount = (db.prepare('SELECT COUNT(*) AS count FROM chunk_plans').get() as { count: number }).count;
      const second = editor.buildChunks(settings);
      expect(second).toEqual(first);
      expect((db.prepare('SELECT COUNT(*) AS count FROM chunk_plans').get() as { count: number }).count).toBe(firstPlanCount);

      const plan = db.prepare(`SELECT algorithm_version AS algorithmVersion, input_hash AS inputHash
        FROM chunk_plans ORDER BY version DESC LIMIT 1`).get();
      expect(plan).toMatchObject({ algorithmVersion: 'boundary-v2', inputHash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(first.every((chunk) => chunk.contentHash && /^[a-f0-9]{64}$/u.test(chunk.contentHash))).toBe(true);
      expect(first.some((chunk) => chunk.oversized && chunk.boundaryReason === 'oversized_paragraph')).toBe(true);
      expect(first.filter((chunk) => !chunk.oversized).every((chunk) => chunk.coreCharacterCount <= settings.hardLimit)).toBe(true);

      const inspections = first.map((chunk) => editor.inspectChunk(chunk.id));
      expect(inspections.every((inspection) => inspection.paragraphs.length > 0)).toBe(true);
      expect(inspections.flatMap((inspection) => inspection.paragraphs).some((paragraph) => paragraph.role !== 'core')).toBe(true);
      for (const inspection of inspections) {
        expect(inspection.chunk.id).toBe(first.find((chunk) => chunk.id === inspection.chunk.id)?.id);
        expect(inspection.paragraphs.map((paragraph) => paragraph.ordinalInChunk))
          .toEqual(inspection.paragraphs.map((_paragraph, index) => index + 1));
        for (const paragraph of inspection.paragraphs) {
          expect(paragraph.ordinal).toBeGreaterThanOrEqual(inspection.chunk.contextStartOrdinal);
          expect(paragraph.ordinal).toBeLessThanOrEqual(inspection.chunk.contextEndOrdinal);
          const expectedRole = paragraph.ordinal < inspection.chunk.coreStartOrdinal ? 'context_before'
            : paragraph.ordinal > inspection.chunk.coreEndOrdinal ? 'context_after' : 'core';
          expect(paragraph.role).toBe(expectedRole);
        }
      }
      expect(() => editor.inspectChunk('missing-chunk')).toThrow(/找不到当前分块方案/u);

      const coreCoverage = db.prepare(`SELECT cm.paragraph_id AS paragraphId, COUNT(*) AS count
        FROM chunk_members cm JOIN chunks c ON c.id = cm.chunk_id
        WHERE c.plan_id = (SELECT id FROM chunk_plans ORDER BY version DESC LIMIT 1) AND cm.role = 'core'
        GROUP BY cm.paragraph_id ORDER BY cm.paragraph_id`).all() as Array<{ paragraphId: string; count: number }>;
      const paragraphCount = (db.prepare('SELECT COUNT(*) AS count FROM paragraphs').get() as { count: number }).count;
      expect(coreCoverage).toHaveLength(paragraphCount);
      expect(coreCoverage.every((row) => row.count === 1)).toBe(true);

      db.prepare("UPDATE paragraphs SET blank_lines_before = 0, boundary_before = 'paragraph'").run();
      db.prepare("DELETE FROM settings WHERE key = 'paragraph-boundary-version'").run();
      await store.close();
      await store.open(projectRoot);
      const recovered = store.get().db.prepare(`SELECT text, blank_lines_before AS blankLinesBefore, boundary_before AS boundaryBefore
        FROM paragraphs ORDER BY ordinal`).all() as Array<{ text: string; blankLinesBefore: number; boundaryBefore: string }>;
      expect(recovered[0]).toMatchObject({ boundaryBefore: 'document' });
      expect(recovered.find((row) => row.text.startsWith('丙'))).toMatchObject({
        blankLinesBefore: 1,
        boundaryBefore: 'blank_line',
      });
      expect(recovered.find((row) => row.text === '第二章 转折')).toMatchObject({ boundaryBefore: 'chapter' });
      expect(recovered.find((row) => row.text === '***')).toMatchObject({ boundaryBefore: 'scene' });
    } finally {
      await store.close();
    }
  });
});
