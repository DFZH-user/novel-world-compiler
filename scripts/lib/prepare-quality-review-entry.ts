import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import { validateReviewProposal } from './quality-review-proposal';
import { blankReview, buildReviewDataset, digest, renderReviewGuide, validateReview, type ReviewDataset, type ReviewParagraph } from './quality-review';

export async function prepareQualityReview(options: {
  source: string; output: string; subject: string; seed: string; encoding?: string; perStratum?: number; radius?: number;
}) {
  const sourcePath = path.resolve(options.source);
  const before = digest(await fs.readFile(sourcePath));
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-quality-review-'));
  const store = new ProjectStore();
  try {
    await store.create('隔离质量抽样', path.join(temporaryRoot, 'sample.novelworld'));
    const imported = await new Importer(store).run(sourcePath, options.encoding ?? 'utf8');
    const { db, rootPath } = store.get();
    const paragraphs = db.prepare(`SELECT p.id, p.ordinal, p.text, c.title AS chapterTitle,
      p.utf8_start AS utf8Start, p.utf8_end AS utf8End FROM paragraphs p
      LEFT JOIN chapters c ON c.id = p.chapter_id WHERE p.revision_id = ? ORDER BY p.ordinal`)
      .all(imported.revisionId) as ReviewParagraph[];
    const revision = db.prepare('SELECT normalized_path AS normalizedPath FROM source_revisions WHERE id = ?')
      .get(imported.revisionId) as { normalizedPath: string };
    const normalized = await fs.readFile(path.join(rootPath, revision.normalizedPath));
    const dataset = buildReviewDataset({
      source: { name: path.basename(sourcePath), sha256: imported.sha256, revisionId: imported.revisionId,
        encoding: imported.encoding, bytes: imported.byteSize },
      paragraphs, subject: options.subject, seed: options.seed, perStratum: options.perStratum, radius: options.radius,
    });
    for (const sample of dataset.samples) for (const p of sample.paragraphs) {
      if (normalized.subarray(p.utf8Start, p.utf8End).toString('utf8') !== p.text) throw new Error(`原文坐标校验失败：${p.id}`);
    }
    const after = digest(await fs.readFile(sourcePath));
    if (before !== after || before !== imported.sha256) throw new Error('抽样期间原文发生变化，请重新准备');
    const review = blankReview(dataset);
    const result = {
      status: 'prepared-awaiting-human-review', modelCalls: 0, sourceUnchanged: true,
      sourceSha256: before, normalizedSha256: digest(normalized), datasetId: dataset.datasetId,
      chapterCount: imported.chapterCount, paragraphCount: imported.paragraphCount,
      sampleCount: dataset.samples.length, verifiedExcerptCount: dataset.samples.reduce((sum, s) => sum + s.paragraphs.length, 0),
      review: validateReview(dataset, review),
    };
    const parent = path.resolve(options.output);
    await fs.mkdir(parent, { recursive: true });
    const outputPath = path.join(parent, `quality-review-${dataset.datasetId.slice(0, 12)}`);
    // Never replace a directory that might already contain human annotations.
    await fs.mkdir(outputPath, { recursive: false });
    for (const [name, value] of Object.entries({ 'dataset.json': dataset, 'review.json': review, 'preparation-result.json': result })) {
      await fs.writeFile(path.join(outputPath, name), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    await fs.writeFile(path.join(outputPath, 'README.md'), renderReviewGuide(dataset), { encoding: 'utf8', flag: 'wx' });
    return { ...result, outputPath };
  } finally {
    await store.close();
    // Only remove this invocation's newly created scratch project, never a user project.
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('novel-quality-review-')) {
      throw new Error('拒绝清理非本次临时目录');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

export async function checkQualityReview(directory: string, proposalPath?: string) {
  const root = path.resolve(directory);
  const dataset = JSON.parse(await fs.readFile(path.join(root, 'dataset.json'), 'utf8')) as ReviewDataset;
  const reviewBytes = await fs.readFile(path.join(root, 'review.json'));
  if (proposalPath) {
    const proposal: unknown = JSON.parse(await fs.readFile(path.resolve(proposalPath), 'utf8'));
    return validateReviewProposal(dataset, proposal, digest(reviewBytes));
  }
  return validateReview(dataset, JSON.parse(reviewBytes.toString('utf8')));
}
