import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  dataset: { type: 'string' }, projection: { type: 'string' }, dryRun: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('node scripts/generate-calibration-ab-pack-v2.mjs --dataset <dataset.json> --projection <projection.json> --dryRun <dry-run.json> --output <directory>');
} else {
  if (!values.dataset || !values.projection || !values.dryRun || !values.output) throw new Error('必须指定 --dataset、--projection、--dryRun 与 --output');
  const buildRoot = await fs.mkdtemp(path.join(scriptRoot, '.calibration-v2-build-'));
  try {
    await build({
      entry: [path.join(scriptRoot, 'lib/generate-calibration-ab-pack-v2-entry.ts').replaceAll('\\', '/')],
      config: false, format: ['cjs'], platform: 'node', target: 'node22', outDir: buildRoot, clean: false, silent: true,
      outExtension: () => ({ js: '.cjs' }),
    });
    const runner = createRequire(import.meta.url)(path.join(buildRoot, 'generate-calibration-ab-pack-v2-entry.cjs'));
    console.log(JSON.stringify(await runner.generateCalibrationAbPackV2(values.dataset, values.projection, values.dryRun, values.output), null, 2));
  } finally {
    const resolved = path.resolve(buildRoot);
    if (path.dirname(resolved) !== scriptRoot || !path.basename(resolved).startsWith('.calibration-v2-build-')) throw new Error('拒绝清理非本次 Stage 4 v2 构建目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
