import fs from 'node:fs/promises';
import path from 'node:path';
import { runDeepSeekAbSmoke, type DeepSeekSmokeResult, type DeepSeekUsage } from './deepseek-ab-smoke';
import { buildRobustnessPlan } from './deepseek-ab-robustness';

function envValue(source: string, name: string): string | undefined {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
    if (!match) continue;
    const raw = match[1];
    return ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) ? raw.slice(1, -1) : raw;
  }
  return undefined;
}

async function loadKey(envFile: string) {
  const processKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (processKey) return processKey;
  const fileKey = envValue(await fs.readFile(path.resolve(envFile), 'utf8'), 'DEEPSEEK_API_KEY')?.trim();
  if (!fileKey) throw new Error('没有找到可用的 DEEPSEEK_API_KEY');
  return fileKey;
}

function addUsage(total: DeepSeekUsage, item: DeepSeekUsage): DeepSeekUsage {
  return {
    prompt_tokens: total.prompt_tokens + item.prompt_tokens,
    completion_tokens: total.completion_tokens + item.completion_tokens,
    prompt_cache_hit_tokens: (total.prompt_cache_hit_tokens ?? 0) + (item.prompt_cache_hit_tokens ?? 0),
    prompt_cache_miss_tokens: (total.prompt_cache_miss_tokens ?? 0) + (item.prompt_cache_miss_tokens ?? 0),
    total_tokens: total.total_tokens + item.total_tokens,
  };
}

export async function executeDeepSeekRobustness(options: {
  packageDirectory: string;
  outputJsonl: string;
  summaryPath: string;
  envFile: string;
  repeatsPerCase: number;
  temperature: number;
  maxBudgetCny: number;
  paidRobustnessConfirmed: boolean;
  onProgress?: (completedPairs: number, totalPairs: number, spentUpperCny: number) => void;
}) {
  if (!options.paidRobustnessConfirmed) throw new Error('必须显式传入 --confirm-paid-robustness');
  if (!(options.maxBudgetCny > 0 && options.maxBudgetCny <= 0.8)) throw new Error('稳健性测试预算必须在 0–0.8 元之间');
  if (!(options.temperature >= 0 && options.temperature <= 2)) throw new Error('temperature 必须在 0–2 之间');
  const outputJsonl = path.resolve(options.outputJsonl);
  const summaryPath = path.resolve(options.summaryPath);
  for (const target of [outputJsonl, summaryPath]) {
    try {
      await fs.access(target);
      throw new Error(`输出文件已存在，拒绝覆盖: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const packageDirectory = path.resolve(options.packageDirectory);
  const [manifest, blindKey, apiKey] = await Promise.all([
    fs.readFile(path.join(packageDirectory, 'manifest.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(packageDirectory, 'blind-key.json'), 'utf8').then(JSON.parse),
    loadKey(options.envFile),
  ]);
  const plan = buildRobustnessPlan(manifest, blindKey, options.repeatsPerCase);
  let spentUpperCny = 0;
  let totals: DeepSeekUsage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0, total_tokens: 0 };
  const uniqueByCase = new Map<string, { A: Set<string>; B: Set<string> }>();
  for (let index = 0; index < plan.length; index += 1) {
    const task = plan[index];
    const remainingBudget = options.maxBudgetCny - spentUpperCny;
    if (remainingBudget <= 0) throw new Error('稳健性测试预算已经耗尽');
    const result: DeepSeekSmokeResult = await runDeepSeekAbSmoke({
      manifest,
      blindKey,
      trialId: task.sourceTrialId,
      apiKey,
      maxBudgetCny: Math.min(1, remainingBudget),
      temperature: options.temperature,
    });
    spentUpperCny += result.budget.conservativePeakUpperBoundCny;
    totals = addUsage(totals, result.totals);
    const unique = uniqueByCase.get(task.caseId) ?? { A: new Set<string>(), B: new Set<string>() };
    unique.A.add(result.trial.arms.X === 'A' ? result.responses.X.content : result.responses.Y.content);
    unique.B.add(result.trial.arms.X === 'B' ? result.responses.X.content : result.responses.Y.content);
    uniqueByCase.set(task.caseId, unique);
    await fs.appendFile(outputJsonl, `${JSON.stringify({ ...task, result })}\n`, 'utf8');
    options.onProgress?.(index + 1, plan.length, spentUpperCny);
  }
  const summary = {
    format: 'calibration-ab-deepseek-robustness-summary',
    version: '1.0',
    packageId: (manifest as { packageId: string }).packageId,
    status: 'complete',
    provider: 'DeepSeek',
    model: 'deepseek-flash',
    temperature: options.temperature,
    repeatsPerCase: options.repeatsPerCase,
    pairRuns: plan.length,
    modelCalls: plan.length * 2,
    totals,
    budget: { maxCny: options.maxBudgetCny, conservativePeakUpperBoundCny: spentUpperCny },
    uniqueResponsesByCase: [...uniqueByCase].map(([caseId, value]) => ({ caseId, A: value.A.size, B: value.B.size })),
    rawResults: outputJsonl,
  };
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return summary;
}
