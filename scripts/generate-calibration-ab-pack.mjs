import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  dataset: { type: 'string' }, projection: { type: 'string' }, dryRun: { type: 'string' }, output: { type: 'string' }, validate: { type: 'string' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('Generate: node scripts/generate-calibration-ab-pack.mjs --dataset <dataset.json> --projection <projection.json> --dryRun <dry-run.json> --output <directory>\nValidate: node scripts/generate-calibration-ab-pack.mjs --dataset <dataset.json> --projection <projection.json> --dryRun <dry-run.json> --validate <manifest.json>');
} else {
  if (!values.dataset || !values.projection || !values.dryRun || (!values.output && !values.validate) || (values.output && values.validate)) throw new Error('必须指定 --dataset、--projection、--dryRun，并且在 --output 与 --validate 中二选一');
  const buildRoot = await fs.mkdtemp(path.join(scriptRoot, '.calibration-ab-build-'));
  try {
    await build({
      entry: [path.join(scriptRoot, 'lib/generate-calibration-ab-pack-entry.ts').replaceAll('\\', '/')],
      config: false, format: ['cjs'], platform: 'node', target: 'node22', outDir: buildRoot, clean: false, silent: true,
      outExtension: () => ({ js: '.cjs' }),
    });
    const runner = createRequire(import.meta.url)(path.join(buildRoot, 'generate-calibration-ab-pack-entry.cjs'));
    const result = values.validate
      ? await runner.checkCalibrationAbPack(values.dataset, values.projection, values.dryRun, values.validate)
      : await runner.generateCalibrationAbPack(values.dataset, values.projection, values.dryRun, values.output);
    console.log(JSON.stringify(result, null, 2));
    if (values.validate && !result.valid) process.exitCode = 1;
  } finally {
    const resolved = path.resolve(buildRoot);
    if (path.dirname(resolved) !== scriptRoot || !path.basename(resolved).startsWith('.calibration-ab-build-')) throw new Error('拒绝清理非本次 A/B 构建目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
