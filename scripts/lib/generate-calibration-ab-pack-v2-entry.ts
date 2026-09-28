import fs from 'node:fs/promises';
import path from 'node:path';
import { buildCalibrationAbPackageV2 } from './calibration-ab-pack-v2';
import type { SceneCalibrationDataset } from './scene-calibration';

export async function generateCalibrationAbPackV2(datasetPath: string, projectionPath: string, dryRunPath: string, outputDirectory: string) {
  const [dataset, projection, dryRun] = await Promise.all([
    fs.readFile(path.resolve(datasetPath), 'utf8').then(JSON.parse) as Promise<SceneCalibrationDataset>,
    fs.readFile(path.resolve(projectionPath), 'utf8').then(JSON.parse) as Promise<unknown>,
    fs.readFile(path.resolve(dryRunPath), 'utf8').then(JSON.parse) as Promise<unknown>,
  ]);
  const built = buildCalibrationAbPackageV2(dataset, projection, dryRun);
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
    promptPolicyVersion: built.packageData.promptPolicyVersion,
    plannedModelCalls: built.packageData.execution.plannedModelCalls,
    modelCalls: 0,
  };
}
