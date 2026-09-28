import fs from 'node:fs/promises';
import path from 'node:path';
import { runDeepSeekAbSmoke } from './deepseek-ab-smoke';

function readEnvValue(source: string, name: string): string | undefined {
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`));
    if (!match) continue;
    const raw = match[1];
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return raw.slice(1, -1);
    return raw;
  }
  return undefined;
}

async function loadApiKey(envFile: string): Promise<string> {
  const fromProcess = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromProcess) return fromProcess;
  const source = await fs.readFile(path.resolve(envFile), 'utf8');
  const fromFile = readEnvValue(source, 'DEEPSEEK_API_KEY')?.trim();
  if (!fromFile) throw new Error('没有找到可用的 DEEPSEEK_API_KEY');
  return fromFile;
}

export async function executeDeepSeekAbSmoke(options: {
  packageDirectory: string;
  outputPath: string;
  envFile: string;
  trialId: string;
  maxBudgetCny: number;
  temperature?: number;
  paidSmokeConfirmed: boolean;
}) {
  if (!options.paidSmokeConfirmed) throw new Error('必须显式传入 --confirm-paid-smoke 才能发起两次付费调用');
  const packageDirectory = path.resolve(options.packageDirectory);
  const outputPath = path.resolve(options.outputPath);
  try {
    await fs.access(outputPath);
    throw new Error(`输出文件已存在，拒绝覆盖: ${outputPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const [manifest, blindKey, apiKey] = await Promise.all([
    fs.readFile(path.join(packageDirectory, 'manifest.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(packageDirectory, 'blind-key.json'), 'utf8').then(JSON.parse),
    loadApiKey(options.envFile),
  ]);
  const result = await runDeepSeekAbSmoke({
    manifest,
    blindKey,
    trialId: options.trialId,
    apiKey,
    maxBudgetCny: options.maxBudgetCny,
    temperature: options.temperature,
  });
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return {
    status: result.status,
    outputPath,
    provider: result.provider,
    model: result.config.model,
    trialId: result.trial.trialId,
    modelCalls: result.totals.modelCalls,
    totalTokens: result.totals.total_tokens,
    conservativePeakUpperBoundCny: result.budget.conservativePeakUpperBoundCny,
  };
}
