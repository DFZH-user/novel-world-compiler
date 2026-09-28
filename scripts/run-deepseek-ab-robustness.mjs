import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { build } from 'tsup';

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: {
  packageDir: { type: 'string' }, outputJsonl: { type: 'string' }, summary: { type: 'string' }, envFile: { type: 'string', default: '.env.local' },
  repeatsPerCase: { type: 'string', default: '10' }, temperature: { type: 'string', default: '0.7' }, maxBudgetCny: { type: 'string', default: '0.8' },
  'confirm-paid-robustness': { type: 'boolean', default: false }, help: { type: 'boolean' },
} });

if (values.help) {
  console.log('node scripts/run-deepseek-ab-robustness.mjs --packageDir <dir> --outputJsonl <raw.jsonl> --summary <summary.json> --repeatsPerCase 10 --temperature 0.7 --maxBudgetCny 0.8 --confirm-paid-robustness');
} else {
  if (!values.packageDir || !values.outputJsonl || !values.summary) throw new Error('必须指定 --packageDir、--outputJsonl 与 --summary');
  const buildRoot = await fs.mkdtemp(path.join(scriptRoot, '.deepseek-robustness-build-'));
  try {
    await build({
      entry: [path.join(scriptRoot, 'lib/run-deepseek-ab-robustness-entry.ts').replaceAll('\\', '/')], config: false, format: ['cjs'], platform: 'node', target: 'node22', outDir: buildRoot, clean: false, silent: true,
      outExtension: () => ({ js: '.cjs' }),
    });
    const runner = createRequire(import.meta.url)(path.join(buildRoot, 'run-deepseek-ab-robustness-entry.cjs'));
    const result = await runner.executeDeepSeekRobustness({
      packageDirectory: values.packageDir, outputJsonl: values.outputJsonl, summaryPath: values.summary, envFile: values.envFile,
      repeatsPerCase: Number(values.repeatsPerCase), temperature: Number(values.temperature), maxBudgetCny: Number(values.maxBudgetCny),
      paidRobustnessConfirmed: values['confirm-paid-robustness'],
      onProgress: (completed, total, spent) => { if (completed % 5 === 0 || completed === total) console.error(`progress ${completed}/${total}, peak-upper-cny=${spent.toFixed(6)}`); },
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    const resolved = path.resolve(buildRoot);
    if (path.dirname(resolved) !== scriptRoot || !path.basename(resolved).startsWith('.deepseek-robustness-build-')) throw new Error('拒绝清理非本次稳健性构建目录');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
