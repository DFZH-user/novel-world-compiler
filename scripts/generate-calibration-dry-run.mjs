import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  dataset: { type: 'string' }, projection: { type: 'string' }, output: { type: 'string' }, validate: { type: 'string' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('Generate: node scripts/generate-calibration-dry-run.mjs --dataset <dataset.json> --projection <projection-run.json> --output <dry-run.json>\nValidate: node scripts/generate-calibration-dry-run.mjs --dataset <dataset.json> --projection <projection-run.json> --validate <dry-run.json>');
} else {
  if (!values.dataset || !values.projection || (!values.output && !values.validate) || (values.output && values.validate)) throw new Error('必须指定 --dataset、--projection，并且在 --output 与 --validate 中二选一');
  const buildRoot = await fs.mkdtemp(path.join(scriptRoot, '.calibration-dry-run-build-'));
  try {
    await build({
      entry: [path.join(scriptRoot, 'lib/generate-calibration-dry-run-entry.ts').replaceAll('\\', '/')],
      config: false, format: ['cjs'], platform: 'node', target: 'node22', outDir: buildRoot, clean: false, silent: true,
      outExtension: () => ({ js: '.cjs' }),
    });
    const runner = createRequire(import.meta.url)(path.join(buildRoot, 'generate-calibration-dry-run-entry.cjs'));
    const result = values.validate
      ? await runner.checkCalibrationDryRun(values.dataset, values.projection, values.validate)
      : await runner.generateCalibrationDryRun(values.dataset, values.projection, values.output);
    console.log(JSON.stringify(result, null, 2));
    if (values.validate && !result.valid) process.exitCode = 1;
  } finally {
    const resolved = path.resolve(buildRoot);
    if (path.dirname(resolved) !== scriptRoot || !path.basename(resolved).startsWith('.calibration-dry-run-build-')) throw new Error('拒绝清理非本次 Dry-run 构建目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
