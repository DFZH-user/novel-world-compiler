import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { backfillSourceSpans, createSourceSpan, inspectSourceSpan } from '../../electron/worker/source-span-service';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function setupProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-source-span-'));
  cleanupPaths.push(root);
  const projectRoot = path.join(root, '证据测试.novelworld');
  const sourcePath = path.join(root, 'source.txt');
  await fs.writeFile(sourcePath, ['第一章 证据', '甲😀乙看见青石镇。后来青石镇很安静。'].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('证据测试', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  const paragraph = store.get().db.prepare('SELECT id, text FROM paragraphs WHERE text LIKE ?').get('%😀%') as { id: string; text: string };
  return { store, paragraph };
}

describe('SourceSpan v2', () => {
  it('stores exact UTF-16 ranges and quote context even with supplementary characters', async () => {
    const { store, paragraph } = await setupProject();
    try {
      const quote = '乙看见青石镇';
      const span = createSourceSpan(store.get().db, paragraph.id, quote);
      expect(span.alignmentStatus).toBe('exact');
      expect(span.startUtf16).toBe(paragraph.text.indexOf(quote));
      expect(span.endUtf16).toBe(paragraph.text.indexOf(quote) + quote.length);
      expect(paragraph.text.slice(span.startUtf16!, span.endUtf16!)).toBe(quote);
      expect(span.prefixText.endsWith('甲😀')).toBe(true);
      expect(span.suffixText.startsWith('。后来')).toBe(true);
      expect(span.quoteSha256).toBe(createHash('sha256').update(quote).digest('hex'));
      expect(inspectSourceSpan(store.get().db, span.id)).toMatchObject({
        paragraphId: paragraph.id,
        paragraphText: paragraph.text,
        exactQuote: quote,
        alignmentStatus: 'exact',
        startUtf16: paragraph.text.indexOf(quote),
        endUtf16: paragraph.text.indexOf(quote) + quote.length,
      });
    } finally {
      await store.close();
    }
  });

  it('does not silently choose the first occurrence when a quote is ambiguous', async () => {
    const { store, paragraph } = await setupProject();
    try {
      const span = createSourceSpan(store.get().db, paragraph.id, '青石镇');
      expect(span).toMatchObject({
        alignmentStatus: 'ambiguous',
        startUtf16: null,
        endUtf16: null,
        prefixText: '',
        suffixText: '',
      });
      expect(inspectSourceSpan(store.get().db, span.id)).toMatchObject({
        alignmentStatus: 'ambiguous',
        startUtf16: null,
        endUtf16: null,
      });
    } finally {
      await store.close();
    }
  });

  it('downgrades an exact span to invalid when its stored coordinates no longer match the paragraph', async () => {
    const { store, paragraph } = await setupProject();
    try {
      const db = store.get().db;
      const span = createSourceSpan(db, paragraph.id, '乙看见青石镇');
      db.prepare('UPDATE paragraphs SET text = ? WHERE id = ?').run('这段原文已发生变化。', paragraph.id);
      expect(inspectSourceSpan(db, span.id)).toMatchObject({
        id: span.id,
        alignmentStatus: 'invalid',
        paragraphText: '这段原文已发生变化。',
      });
      expect(() => inspectSourceSpan(db, 'missing-source-span')).toThrow(/找不到该原文定位记录/u);
    } finally {
      await store.close();
    }
  });

  it('backfills legacy evidence rows with canonical source_span_id links', async () => {
    const { store, paragraph } = await setupProject();
    try {
      const db = store.get().db;
      const quote = '乙看见青石镇';
      db.prepare('INSERT INTO evidence_anchors (id, revision_id, paragraph_id, utf8_start, utf8_end, quote, quote_hash, created_at) SELECT ?, revision_id, id, utf8_start, utf8_end, ?, ?, ? FROM paragraphs WHERE id = ?')
        .run('legacy-anchor', quote, createHash('sha256').update(quote).digest('hex'), new Date().toISOString(), paragraph.id);
      expect(backfillSourceSpans(db)).toMatchObject({ linked: 1, unresolved: 0 });
      const linked = db.prepare('SELECT e.source_span_id AS sourceSpanId, s.alignment_status AS alignmentStatus, s.start_utf16 AS startUtf16, s.end_utf16 AS endUtf16 FROM evidence_anchors e JOIN source_spans s ON s.id = e.source_span_id WHERE e.id = ?')
        .get('legacy-anchor');
      expect(linked).toMatchObject({
        sourceSpanId: expect.stringMatching(/^ss_/u),
        alignmentStatus: 'exact',
        startUtf16: paragraph.text.indexOf(quote),
        endUtf16: paragraph.text.indexOf(quote) + quote.length,
      });
    } finally {
      await store.close();
    }
  });
});
