import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCalibrationDryRun, validateCalibrationDryRun } from './calibration-dry-run';
import type { SceneCalibrationDataset } from './scene-calibration';

async function readInputs(datasetPath: string, projectionPath: string) {
  const dataset = JSON.parse(await fs.readFile(path.resolve(datasetPath), 'utf8')) as SceneCalibrationDataset;
  const projection: unknown = JSON.parse(await fs.readFile(path.resolve(projectionPath), 'utf8'));
  return { dataset, projection };
}

export async function generateCalibrationDryRun(datasetPath: string, projectionPath: string, outputPath: string) {
  const { dataset, projection } = await readInputs(datasetPath, projectionPath);
  const run = buildCalibrationDryRun(dataset, projection);
  const destination = path.resolve(outputPath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, `${JSON.stringify(run, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return { status: 'generated-provisional-dry-run-context-receipts', outputPath: destination, runId: run.runId, ...run.summary, modelCalls: 0 };
}

export async function checkCalibrationDryRun(datasetPath: string, projectionPath: string, runPath: string) {
  const { dataset, projection } = await readInputs(datasetPath, projectionPath);
  const run: unknown = JSON.parse(await fs.readFile(path.resolve(runPath), 'utf8'));
  return validateCalibrationDryRun(dataset, projection, run);
}
