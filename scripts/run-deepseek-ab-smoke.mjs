import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  packageDir: { type: 'string' },
  output: { type: 'string' },
  envFile: { type: 'string', default: '.env.local' },
  trial: { type: 'string', default: 'late-identity-purpose:run-1' },
  maxBudgetCny: { type: 'string', default: '1' },
  temperature: { type: 'string', default: '0' },
  'confirm-paid-smoke': { type: 'boolean', default: false },
  help: { type: 'boolean' },
} });

if (values.help) {
  console.log('node scripts/run-deepseek-ab-smoke.mjs --packageDir <dir> --output <result.json> --temperature 0 --maxBudgetCny 1 --confirm-paid-smoke');
} else {
  if (!values.packageDir || !values.output) throw new Error('必须指定 --packageDir 与 --output');
  const maxBudgetCny = Number(values.maxBudgetCny);
  const temperature = Number(values.temperature);
  if (!Number.isFinite(maxBudgetCny)) throw new Error('--maxBudgetCny 必须是数字');
  if (!Number.isFinite(temperature)) throw new Error('--temperature 必须是数字');
  const buildRoot = await fs.mkdtemp(path.join(scriptRoot, '.deepseek-smoke-build-'));
  try {
    await build({
      entry: [path.join(scriptRoot, 'lib/run-deepseek-ab-smoke-entry.ts').replaceAll('\\', '/')],
      config: false, format: ['cjs'], platform: 'node', target: 'node22', outDir: buildRoot, clean: false, silent: true,
      outExtension: () => ({ js: '.cjs' }),
    });
    const runner = createRequire(import.meta.url)(path.join(buildRoot, 'run-deepseek-ab-smoke-entry.cjs'));
    const result = await runner.executeDeepSeekAbSmoke({
      packageDirectory: values.packageDir,
      outputPath: values.output,
      envFile: values.envFile,
      trialId: values.trial,
      maxBudgetCny,
      temperature,
      paidSmokeConfirmed: values['confirm-paid-smoke'],
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    const resolved = path.resolve(buildRoot);
    if (path.dirname(resolved) !== scriptRoot || !path.basename(resolved).startsWith('.deepseek-smoke-build-')) throw new Error('拒绝清理非本次 DeepSeek 构建目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
