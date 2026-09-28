import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCalibrationAbPackage, validateCalibrationAbPackage } from './calibration-ab-pack';
import type { SceneCalibrationDataset } from './scene-calibration';

async function inputs(datasetPath: string, projectionPath: string, dryRunPath: string) {
  const dataset = JSON.parse(await fs.readFile(path.resolve(datasetPath), 'utf8')) as SceneCalibrationDataset;
  const projection: unknown = JSON.parse(await fs.readFile(path.resolve(projectionPath), 'utf8'));
  const dryRun: unknown = JSON.parse(await fs.readFile(path.resolve(dryRunPath), 'utf8'));
  return { dataset, projection, dryRun };
}

export async function generateCalibrationAbPack(datasetPath: string, projectionPath: string, dryRunPath: string, outputDirectory: string) {
  const { dataset, projection, dryRun } = await inputs(datasetPath, projectionPath, dryRunPath);
  const built = buildCalibrationAbPackage(dataset, projection, dryRun);
  const destination = path.resolve(outputDirectory);
  await fs.mkdir(destination, { recursive: false });
  await Promise.all([
    fs.writeFile(path.join(destination, 'manifest.json'), `${JSON.stringify(built.packageData, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
    fs.writeFile(path.join(destination, 'blind-key.json'), `${JSON.stringify(built.blindKey, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
    fs.writeFile(path.join(destination, 'blind-review-sheet.json'), `${JSON.stringify(built.blindSheet, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }),
  ]);
  return {
    status: built.packageData.status,
    outputDirectory: destination,
    packageId: built.packageData.packageId,
    caseCount: built.packageData.execution.caseCount,
    trialCount: built.blindSheet.trials.length,
    plannedModelCalls: built.packageData.execution.plannedModelCalls,
    modelCalls: 0,
  };
}

export async function checkCalibrationAbPack(datasetPath: string, projectionPath: string, dryRunPath: string, manifestPath: string) {
  const { dataset, projection, dryRun } = await inputs(datasetPath, projectionPath, dryRunPath);
  const manifest: unknown = JSON.parse(await fs.readFile(path.resolve(manifestPath), 'utf8'));
  return validateCalibrationAbPackage(dataset, projection, dryRun, manifest);
}
