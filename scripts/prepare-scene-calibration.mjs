import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  source: { type: 'string' },
  selection: { type: 'string' },
  output: { type: 'string' },
  encoding: { type: 'string', default: 'utf8' },
  validate: { type: 'string' },
  review: { type: 'string' },
  help: { type: 'boolean' },
} });

if (values.help) {
  console.log('Prepare: node scripts/prepare-scene-calibration.mjs --source <TXT> --selection <JSON> --output <parent> [--encoding utf8]\nValidate: node scripts/prepare-scene-calibration.mjs --validate <dataset-directory> [--review <review.json>]');
} else {
  if (values.review && !values.validate) throw new Error('--review 必须与 --validate 配合使用');
  if (!values.validate && (!values.source || !values.selection || !values.output)) throw new Error('必须指定 --source、--selection 和 --output');
  const buildRoot = await fs.mkdtemp(path.join(scriptRoot, '.scene-calibration-build-'));
  try {
    await build({
      entry: [path.join(scriptRoot, 'lib/prepare-scene-calibration-entry.ts').replaceAll('\\', '/')],
      config: false,
      format: ['cjs'],
      platform: 'node',
      target: 'node22',
      outDir: buildRoot,
      clean: false,
      silent: true,
      outExtension: () => ({ js: '.cjs' }),
    });
    const runner = createRequire(import.meta.url)(path.join(buildRoot, 'prepare-scene-calibration-entry.cjs'));
    const result = values.validate
      ? await runner.checkSceneCalibration(values.validate, values.review)
      : await runner.prepareSceneCalibration({ source: values.source, selection: values.selection, output: values.output, encoding: values.encoding });
    console.log(JSON.stringify(result, null, 2));
    if (values.validate) {
      const checks = 'valid' in result ? [result] : [result.reviewerA, result.reviewerB];
      if (checks.some((check) => !check.valid)) process.exitCode = 1;
    }
  } finally {
    const resolved = path.resolve(buildRoot);
    if (path.dirname(resolved) !== scriptRoot || !path.basename(resolved).startsWith('.scene-calibration-build-')) throw new Error('拒绝清理非本次构建目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
