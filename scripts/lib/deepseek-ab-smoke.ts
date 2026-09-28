import { createHash } from 'node:crypto';

export const DEEPSEEK_SMOKE_CONFIG = Object.freeze({
  endpoint: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-flash',
  thinking: 'disabled' as const,
  temperature: 0,
  maxTokens: 220,
  timeoutMs: 45_000,
  maxCalls: 2,
});

export interface DeepSeekSmokeConfig {
  endpoint: string;
  model: string;
  thinking: 'disabled';
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  maxCalls: 2;
}

export const DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION = Object.freeze({
  cacheHitInput: 0.1,
  cacheMissInput: 3,
  output: 9,
});

type Arm = 'A' | 'B';
type BlindLabel = 'X' | 'Y';

interface CalibrationCase {
  id: string;
  question: string;
  expectedBehavior: string;
  requiredPoints: string[];
  forbiddenPoints: string[];
  prompts: Record<Arm, string>;
}

interface CalibrationManifest {
  packageId: string;
  cases: CalibrationCase[];
}

interface BlindMapping {
  trialId: string;
  X: Arm;
  Y: Arm;
}

interface BlindKey {
  packageId: string;
  mappings: BlindMapping[];
}

export interface DeepSeekUsage {
  completion_tokens: number;
  prompt_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_tokens: number;
}

interface DeepSeekPayload {
  id?: string;
  model?: string;
  created?: number;
  system_fingerprint?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; role?: string };
  }>;
  usage?: DeepSeekUsage;
}

export interface SelectedSmokeTrial {
  trialId: string;
  caseId: string;
  question: string;
  expectedBehavior: string;
  requiredPoints: string[];
  forbiddenPoints: string[];
  arms: Record<BlindLabel, Arm>;
  prompts: Record<BlindLabel, string>;
}

export interface DeepSeekSmokeResult {
  format: 'calibration-ab-deepseek-smoke';
  version: '1.0';
  packageId: string;
  runId: string;
  status: 'complete';
  explicitPaidSmokeApproval: true;
  provider: 'DeepSeek';
  config: DeepSeekSmokeConfig;
  budget: {
    maxCny: number;
    conservativePeakUpperBoundCny: number;
    pricingCnyPerMillionTokens: typeof DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION;
    pricingBasis: string;
  };
  trial: SelectedSmokeTrial;
  responses: Record<BlindLabel, {
    content: string;
    finishReason: string;
    usage: DeepSeekUsage;
    conservativePeakUpperBoundCny: number;
    rawResponse: DeepSeekPayload;
  }>;
  totals: DeepSeekUsage & { modelCalls: 2 };
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
}

function assertManifest(value: unknown): asserts value is CalibrationManifest {
  assertObject(value, 'manifest');
  if (typeof value.packageId !== 'string' || !Array.isArray(value.cases)) throw new Error('manifest 格式无效');
}

function assertBlindKey(value: unknown): asserts value is BlindKey {
  assertObject(value, 'blind-key');
  if (typeof value.packageId !== 'string' || !Array.isArray(value.mappings)) throw new Error('blind-key 格式无效');
}

export function selectSmokeTrial(manifestValue: unknown, blindKeyValue: unknown, trialId: string): SelectedSmokeTrial {
  assertManifest(manifestValue);
  assertBlindKey(blindKeyValue);
  if (manifestValue.packageId !== blindKeyValue.packageId) throw new Error('manifest 与 blind-key 的 packageId 不一致');
  const separator = trialId.lastIndexOf(':run-');
  if (separator <= 0) throw new Error(`无效 trialId: ${trialId}`);
  const caseId = trialId.slice(0, separator);
  const item = manifestValue.cases.find((candidate) => candidate.id === caseId);
  const mapping = blindKeyValue.mappings.find((candidate) => candidate.trialId === trialId);
  if (!item || !mapping) throw new Error(`找不到盲测用例: ${trialId}`);
  if (!item.prompts?.[mapping.X] || !item.prompts?.[mapping.Y]) throw new Error(`用例缺少 A/B 提示词: ${trialId}`);
  return {
    trialId,
    caseId,
    question: item.question,
    expectedBehavior: item.expectedBehavior,
    requiredPoints: [...item.requiredPoints],
    forbiddenPoints: [...item.forbiddenPoints],
    arms: { X: mapping.X, Y: mapping.Y },
    prompts: { X: item.prompts[mapping.X], Y: item.prompts[mapping.Y] },
  };
}

export function requestPeakUpperBoundCny(usage: DeepSeekUsage): number {
  const hit = usage.prompt_cache_hit_tokens ?? 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, usage.prompt_tokens - hit);
  return (
    hit * DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION.cacheHitInput
    + miss * DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION.cacheMissInput
    + usage.completion_tokens * DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION.output
  ) / 1_000_000;
}

export function preflightRequestUpperBoundCny(prompt: string): number {
  const conservativeInputTokens = prompt.length * 4;
  return (
    conservativeInputTokens * DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION.cacheMissInput
    + DEEPSEEK_SMOKE_CONFIG.maxTokens * DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION.output
  ) / 1_000_000;
}

export function buildDeepSeekRequest(prompt: string, temperature: number = DEEPSEEK_SMOKE_CONFIG.temperature) {
  return {
    model: DEEPSEEK_SMOKE_CONFIG.model,
    messages: [{ role: 'user', content: prompt }],
    thinking: { type: DEEPSEEK_SMOKE_CONFIG.thinking },
    temperature,
    max_tokens: DEEPSEEK_SMOKE_CONFIG.maxTokens,
    stream: false,
  };
}

function parseDeepSeekResponse(value: unknown) {
  assertObject(value, 'DeepSeek response');
  const payload = value as DeepSeekPayload;
  const choice = payload.choices?.[0];
  const content = choice?.message?.content?.trim();
  const usage = payload.usage;
  if (!content || !usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) {
    throw new Error('DeepSeek 返回缺少回答或 token 用量');
  }
  return { content, finishReason: choice?.finish_reason ?? 'unknown', usage, rawResponse: payload };
}

function addUsage(left: DeepSeekUsage, right: DeepSeekUsage): DeepSeekUsage {
  return {
    prompt_tokens: left.prompt_tokens + right.prompt_tokens,
    completion_tokens: left.completion_tokens + right.completion_tokens,
    prompt_cache_hit_tokens: (left.prompt_cache_hit_tokens ?? 0) + (right.prompt_cache_hit_tokens ?? 0),
    prompt_cache_miss_tokens: (left.prompt_cache_miss_tokens ?? 0) + (right.prompt_cache_miss_tokens ?? 0),
    total_tokens: left.total_tokens + right.total_tokens,
  };
}

async function callDeepSeek(prompt: string, apiKey: string, fetchImpl: typeof fetch, config: DeepSeekSmokeConfig) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEPSEEK_SMOKE_CONFIG.timeoutMs);
  try {
    const response = await fetchImpl(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildDeepSeekRequest(prompt, config.temperature)),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`DeepSeek API 请求失败（HTTP ${response.status}）`);
    return parseDeepSeekResponse(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function runDeepSeekAbSmoke(options: {
  manifest: unknown;
  blindKey: unknown;
  trialId: string;
  apiKey: string;
  maxBudgetCny: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}): Promise<DeepSeekSmokeResult> {
  if (!options.apiKey.trim()) throw new Error('DEEPSEEK_API_KEY 为空');
  if (!(options.maxBudgetCny > 0 && options.maxBudgetCny <= 1)) throw new Error('本运行器只允许 0–1 元的预算上限');
  const temperature = options.temperature ?? DEEPSEEK_SMOKE_CONFIG.temperature;
  if (!(temperature >= 0 && temperature <= 2)) throw new Error('temperature 必须在 0–2 之间');
  const config: DeepSeekSmokeConfig = { ...DEEPSEEK_SMOKE_CONFIG, temperature };
  const trial = selectSmokeTrial(options.manifest, options.blindKey, options.trialId);
  const preflight = preflightRequestUpperBoundCny(trial.prompts.X) + preflightRequestUpperBoundCny(trial.prompts.Y);
  if (preflight > options.maxBudgetCny) throw new Error('两次调用的保守预估超过预算，未发起请求');

  const fetchImpl = options.fetchImpl ?? fetch;
  const x = await callDeepSeek(trial.prompts.X, options.apiKey, fetchImpl, config);
  const xCost = requestPeakUpperBoundCny(x.usage);
  if (xCost + preflightRequestUpperBoundCny(trial.prompts.Y) > options.maxBudgetCny) {
    throw new Error('第一次调用后预算保护触发，第二次请求未发起');
  }
  const y = await callDeepSeek(trial.prompts.Y, options.apiKey, fetchImpl, config);
  const totalUsage = addUsage(x.usage, y.usage);
  const peakCost = requestPeakUpperBoundCny(totalUsage);
  if (peakCost > options.maxBudgetCny) throw new Error('实际 token 用量超过预算上限');

  const hashInput = JSON.stringify({ packageId: manifestPackageId(options.manifest), trialId: trial.trialId, config, x: x.rawResponse.id, y: y.rawResponse.id });
  return {
    format: 'calibration-ab-deepseek-smoke',
    version: '1.0',
    packageId: manifestPackageId(options.manifest),
    runId: createHash('sha256').update(hashInput).digest('hex'),
    status: 'complete',
    explicitPaidSmokeApproval: true,
    provider: 'DeepSeek',
    config,
    budget: {
      maxCny: options.maxBudgetCny,
      conservativePeakUpperBoundCny: peakCost,
      pricingCnyPerMillionTokens: DEEPSEEK_FLASH_PEAK_CNY_PER_MILLION,
      pricingBasis: 'DeepSeek V4 Flash 高峰价；用于保守上界，实际扣费以平台账单为准',
    },
    trial,
    responses: {
      X: { ...x, conservativePeakUpperBoundCny: requestPeakUpperBoundCny(x.usage) },
      Y: { ...y, conservativePeakUpperBoundCny: requestPeakUpperBoundCny(y.usage) },
    },
    totals: { ...totalUsage, modelCalls: 2 },
  };
}

function manifestPackageId(value: unknown): string {
  assertManifest(value);
  return value.packageId;
}
