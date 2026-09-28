import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { BackupService } from '../../electron/worker/backup-service';
import { EditorService } from '../../electron/worker/editor-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import { SCHEMA_VERSION } from '../../electron/worker/schema';
import { createSourceSpan } from '../../electron/worker/source-span-service';

const sourcePath = process.env.FULL_NOVEL_STAGE0_SOURCE;

async function fileHash(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

test.skipIf(!sourcePath)('validates a full real novel through the complete stage 0 pipeline', async () => {
  const source = path.resolve(sourcePath!);
  const sourceHashBefore = await fileHash(source);
  const startedAt = Date.now();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-full-stage0-'));
  const projectRoot = path.join(tempRoot, '整本阶段0验收.novelworld');
  const backupPath = path.join(tempRoot, '整本阶段0验收.novelproj');
  const store = new ProjectStore();
  let report: Record<string, unknown> = {};
  try {
    const sourceStat = await fs.stat(source);
    const importer = new Importer(store);
    await store.create('整本阶段0验收', projectRoot);
    const preview = await importer.preview(source);
    const importStartedAt = Date.now();
    const imported = await importer.run(source, preview.recommendedEncoding);
    const importElapsedMs = Date.now() - importStartedAt;
    const db = store.get().db;
    const editor = new EditorService(store);
    const chunkStartedAt = Date.now();
    const chunks = editor.buildChunks({
      coreChars: 8_000,
      softLimit: 10_000,
      hardLimit: 12_000,
      overlapBefore: 500,
      overlapAfter: 500,
    });
    const chunkElapsedMs = Date.now() - chunkStartedAt;
    const plan = db.prepare(`SELECT id, algorithm_version AS algorithmVersion, input_hash AS inputHash
      FROM chunk_plans ORDER BY version DESC LIMIT 1`).get() as { id: string; algorithmVersion: string; inputHash: string };
    const coverage = db.prepare(`SELECT
      COUNT(*) AS coreRows,
      COUNT(DISTINCT paragraph_id) AS distinctCoreParagraphs
      FROM chunk_members WHERE role = 'core' AND chunk_id IN (SELECT id FROM chunks WHERE plan_id = ?)`)
      .get(plan.id) as { coreRows: number; distinctCoreParagraphs: number };
    const includedParagraphs = (db.prepare(`SELECT COUNT(*) AS count FROM paragraphs p
      LEFT JOIN paragraph_exclusions e ON e.paragraph_id = p.id
      WHERE p.revision_id = ? AND COALESCE(e.excluded, 0) = 0`).get(imported.revisionId) as { count: number }).count;
    expect(coverage).toMatchObject({ coreRows: includedParagraphs, distinctCoreParagraphs: includedParagraphs });
    expect(chunks.filter((chunk) => !chunk.oversized).every((chunk) => chunk.coreCharacterCount <= 12_000)).toBe(true);

    const paragraph = db.prepare(`SELECT id, text FROM paragraphs
      WHERE revision_id = ? AND LENGTH(text) >= 40 ORDER BY ordinal LIMIT 1`).get(imported.revisionId) as { id: string; text: string };
    let quote = '';
    for (let start = 0; start + 12 <= paragraph.text.length; start += 1) {
      const candidate = paragraph.text.slice(start, start + 12);
      if (paragraph.text.indexOf(candidate) === paragraph.text.lastIndexOf(candidate)) {
        quote = candidate;
        break;
      }
    }
    expect(quote).not.toBe('');
    const span = createSourceSpan(db, paragraph.id, quote);
    expect(span.alignmentStatus).toBe('exact');
    expect(paragraph.text.slice(span.startUtf16!, span.endUtf16!)).toBe(quote);
    const searchQuery = Array.from(quote).slice(0, 4).join('');
    const searchStartedAt = Date.now();
    const searchHits = editor.search(searchQuery, 20);
    const searchElapsedMs = Date.now() - searchStartedAt;
    expect(searchHits.some((hit) => hit.paragraphId === paragraph.id)).toBe(true);

    const boundaryCounts = db.prepare(`SELECT boundary_before AS boundary, COUNT(*) AS count
      FROM paragraphs GROUP BY boundary_before ORDER BY boundary_before`).all();
    const ftsCount = (db.prepare('SELECT COUNT(*) AS count FROM paragraph_fts').get() as { count: number }).count;
    expect(ftsCount).toBe(imported.paragraphCount);
    db.assertIntegrity('quick');

    const backupStartedAt = Date.now();
    const backup = await new BackupService(store).create(backupPath);
    const backupElapsedMs = Date.now() - backupStartedAt;
    const backupBytes = (await fs.stat(backupPath)).size;
    await store.close();
    const reopenStartedAt = Date.now();
    await store.open(projectRoot);
    const reopenElapsedMs = Date.now() - reopenStartedAt;
    store.get().db.assertIntegrity('quick');
    const reopenedChunks = new EditorService(store).listChunks();
    expect(reopenedChunks).toHaveLength(chunks.length);

    report = {
      source,
      sourceBytes: sourceStat.size,
      sourceSha256: sourceHashBefore,
      schemaVersion: SCHEMA_VERSION,
      encoding: imported.encoding,
      encodingCandidates: preview.candidates.map((candidate) => ({
        encoding: candidate.encoding,
        score: candidate.score,
        detectorConfidence: candidate.detectorConfidence,
      })),
      chapterCount: imported.chapterCount,
      paragraphCount: imported.paragraphCount,
      characterCount: imported.characterCount,
      chunkCount: chunks.length,
      oversizedChunkCount: chunks.filter((chunk) => chunk.oversized).length,
      maximumCoreCharacters: Math.max(...chunks.map((chunk) => chunk.coreCharacterCount)),
      coreCoverage: coverage,
      algorithmVersion: plan.algorithmVersion,
      planInputHash: plan.inputHash,
      boundaryCounts,
      ftsRowCount: ftsCount,
      searchHitCount: searchHits.length,
      sourceSpanStatus: span.alignmentStatus,
      sourceSpanOffsetUnit: 'utf16-code-unit-v1',
      backupBytes,
      backupSha256: backup.checksum,
      importElapsedMs,
      chunkElapsedMs,
      searchElapsedMs,
      backupElapsedMs,
      reopenElapsedMs,
      totalElapsedMs: Date.now() - startedAt,
      reopenedSuccessfully: true,
      integrity: 'ok',
    };
  } finally {
    await store.close();
    expect(await fileHash(source)).toBe(sourceHashBefore);
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  await fs.mkdir(path.resolve('verification-results'), { recursive: true });
  await fs.writeFile(
    path.resolve('verification-results', 'full-novel-stage0-probe-result.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );
}, 600_000);
