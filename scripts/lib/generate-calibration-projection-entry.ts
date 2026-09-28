import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCalibrationProjectionRun, validateCalibrationProjectionRun } from './calibration-projection-run';
import type { SceneCalibrationDataset } from './scene-calibration';

export async function generateCalibrationProjection(datasetPath: string, outputPath: string) {
  const dataset = JSON.parse(await fs.readFile(path.resolve(datasetPath), 'utf8')) as SceneCalibrationDataset;
  const run = buildCalibrationProjectionRun(dataset);
  const destination = path.resolve(outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { status: 'generated-provisional-projection-receipts', outputPath: destination, runId: run.runId, ...run.summary, modelCalls: 0 };
}

export async function checkCalibrationProjection(datasetPath: string, runPath: string) {
  const dataset = JSON.parse(await fs.readFile(path.resolve(datasetPath), 'utf8')) as SceneCalibrationDataset;
  const run: unknown = JSON.parse(await fs.readFile(path.resolve(runPath), 'utf8'));
  return validateCalibrationProjectionRun(dataset, run);
}
