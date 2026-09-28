import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  source: { type: 'string' }, output: { type: 'string' }, subject: { type: 'string' },
  seed: { type: 'string', default: 'quality-review-v1' }, encoding: { type: 'string', default: 'utf8' },
  'per-stratum': { type: 'string', default: '6' }, radius: { type: 'string', default: '1' },
  validate: { type: 'string' }, proposal: { type: 'string' }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('Prepare: node scripts/prepare-quality-review.mjs --source <TXT> --output <parent> --subject <name> [--seed <seed>] [--encoding utf8] [--per-stratum 6] [--radius 1]\nValidate (read-only): node scripts/prepare-quality-review.mjs --validate <dataset-directory> [--proposal <assistant-proposal.json>]');
} else {
  if (values.proposal && !values.validate) throw new Error('--proposal 必须与 --validate 配合使用，不会导入或覆盖人工标注');
  if (!values.validate && (!values.source || !values.output || !values.subject)) throw new Error('必须指定 --source、--output 和 --subject');
  const buildRoot = await fs.mkdtemp(path.join(scriptRoot, '.quality-review-build-'));
  try {
    await build({ entry: [path.join(scriptRoot, 'lib/prepare-quality-review-entry.ts').replaceAll('\\', '/')], config: false,
      format: ['cjs'], platform: 'node', target: 'node22', outDir: buildRoot, clean: false, silent: true,
      outExtension: () => ({ js: '.cjs' }),
    });
    const runner = createRequire(import.meta.url)(path.join(buildRoot, 'prepare-quality-review-entry.cjs'));
    const result = values.validate ? await runner.checkQualityReview(values.validate, values.proposal) : await runner.prepareQualityReview({
      source: values.source, output: values.output, subject: values.subject, seed: values.seed,
      encoding: values.encoding, perStratum: Number(values['per-stratum']), radius: Number(values.radius),
    });
    console.log(JSON.stringify(result, null, 2));
    if (values.validate && !result.valid) process.exitCode = 1;
  } finally {
    const resolved = path.resolve(buildRoot);
    if (path.dirname(resolved) !== scriptRoot || !path.basename(resolved).startsWith('.quality-review-build-')) throw new Error('拒绝清理非本次构建目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
