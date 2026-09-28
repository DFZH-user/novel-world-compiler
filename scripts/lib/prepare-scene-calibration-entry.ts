import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import {
  blankSceneReview,
  buildSceneCalibrationDataset,
  renderSceneCalibrationGuide,
  sceneDigest,
  validateOwnerProvisionalApproval,
  validateSceneReview,
  type SceneCalibrationDataset,
  type SceneParagraph,
} from './scene-calibration';

export async function prepareSceneCalibration(options: {
  source: string;
  selection: string;
  output: string;
  encoding?: string;
}) {
  const sourcePath = path.resolve(options.source);
  const selectionPath = path.resolve(options.selection);
  const before = sceneDigest(await fs.readFile(sourcePath));
  const selection: unknown = JSON.parse(await fs.readFile(selectionPath, 'utf8'));
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-scene-calibration-'));
  const store = new ProjectStore();
  try {
    await store.create('隔离场景标注', path.join(temporaryRoot, 'scene-calibration.novelworld'));
    const imported = await new Importer(store).run(sourcePath, options.encoding ?? 'utf8');
    const { db, rootPath } = store.get();
    const paragraphs = db.prepare(`SELECT p.id, p.ordinal, p.text, c.title AS chapterTitle,
      p.utf8_start AS utf8Start, p.utf8_end AS utf8End FROM paragraphs p
      LEFT JOIN chapters c ON c.id = p.chapter_id WHERE p.revision_id = ? ORDER BY p.ordinal`)
      .all(imported.revisionId) as SceneParagraph[];
    const revision = db.prepare('SELECT normalized_path AS normalizedPath FROM source_revisions WHERE id = ?')
      .get(imported.revisionId) as { normalizedPath: string };
    const normalized = await fs.readFile(path.join(rootPath, revision.normalizedPath));
    const dataset = buildSceneCalibrationDataset({
      source: {
        name: path.basename(sourcePath),
        sha256: imported.sha256,
        revisionId: imported.revisionId,
        encoding: imported.encoding,
        bytes: imported.byteSize,
      },
      paragraphs,
      selection,
    });
    for (const item of dataset.cases) {
      for (const paragraph of [...item.paragraphs, ...item.previousContext.flatMap((context) => context.paragraphs)]) {
        if (normalized.subarray(paragraph.utf8Start, paragraph.utf8End).toString('utf8') !== paragraph.text) {
          throw new Error(`原文坐标校验失败：${paragraph.id}`);
        }
      }
    }
    const after = sceneDigest(await fs.readFile(sourcePath));
    if (before !== after || before !== imported.sha256) throw new Error('准备期间原文发生变化，请重新生成');
    const reviewerA = blankSceneReview(dataset, 'a');
    const reviewerB = blankSceneReview(dataset, 'b');
    const result = {
      status: 'prepared-awaiting-independent-human-review',
      modelCalls: 0,
      sourceUnchanged: true,
      sourceSha256: before,
      normalizedSha256: sceneDigest(normalized),
      datasetId: dataset.datasetId,
      caseCount: dataset.cases.length,
      entryCount: dataset.cases.reduce((sum, item) => sum + item.entries.length, 0),
      paragraphCount: dataset.cases.reduce((sum, item) => sum + item.paragraphs.length, 0),
      reviewerA: validateSceneReview(dataset, reviewerA),
      reviewerB: validateSceneReview(dataset, reviewerB),
    };
    const parent = path.resolve(options.output);
    await fs.mkdir(parent, { recursive: true });
    const outputPath = path.join(parent, `scene-calibration-${dataset.datasetId.slice(0, 12)}`);
    await fs.mkdir(outputPath, { recursive: false });
    for (const [name, value] of Object.entries({
      'dataset.json': dataset,
      'reviewer-a.json': reviewerA,
      'reviewer-b.json': reviewerB,
      'preparation-result.json': result,
    })) {
      await fs.writeFile(path.join(outputPath, name), `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    }
    await fs.writeFile(path.join(outputPath, 'README.md'), renderSceneCalibrationGuide(dataset), { encoding: 'utf8', flag: 'wx' });
    return { ...result, outputPath };
  } finally {
    await store.close();
    const resolved = path.resolve(temporaryRoot);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('novel-scene-calibration-')) {
      throw new Error('拒绝清理非本次场景标注临时目录');
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

export async function checkSceneCalibration(directory: string, reviewPath?: string) {
  const root = path.resolve(directory);
  const dataset = JSON.parse(await fs.readFile(path.join(root, 'dataset.json'), 'utf8')) as SceneCalibrationDataset;
  if (reviewPath) return validateSceneReview(dataset, JSON.parse(await fs.readFile(path.resolve(reviewPath), 'utf8')));
  const reviewerA = JSON.parse(await fs.readFile(path.join(root, 'reviewer-a.json'), 'utf8'));
  const reviewerB = JSON.parse(await fs.readFile(path.join(root, 'reviewer-b.json'), 'utf8'));
  let ownerApproval = null;
  try {
    ownerApproval = validateOwnerProvisionalApproval(dataset, JSON.parse(await fs.readFile(path.join(root, 'owner-provisional-approval.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { reviewerA: validateSceneReview(dataset, reviewerA), reviewerB: validateSceneReview(dataset, reviewerB), ownerApproval };
}
