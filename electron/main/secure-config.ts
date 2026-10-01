import { apiRequestSettingsSchema } from '../../src/shared/api-request-settings';
import { resolveModelId } from '../../src/shared/model-id';
import { app, safeStorage } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { buildJsonCompletionAttempts, buildTextCompletionAttempts, shouldRetryWithoutOptionalJsonMode } from './model-request-policy';
import { decodeCompletionJson } from './completion-json';
import type { ApiStatus } from '../../src/shared/contracts';
import { isSafeApiBaseUrl } from '../../src/shared/api-base-url';
import { recordTokenUsageAttempt, type TokenUsageAttempt } from './token-usage-ledger';

const apiInputSchema = z.object({
  requestSettings: apiRequestSettingsSchema.optional(),
  provider: z.string().trim().min(1).max(50),
  baseUrl: z.string().url().refine(isSafeApiBaseUrl, {
    message: '远程 API 必须使用 HTTPS',
  }),
  apiKey: z.string().trim().max(500).optional(),
  preferredModel: z.string().trim().min(1).max(200),
});

const storedSchema = z.object({
  requestSettings: apiRequestSettingsSchema.optional(),
  provider: z.string(),
  baseUrl: z.string(),
  encryptedKey: z.string(),
  preferredModel: z.string().optional(),
});

type StoredApiConfig = z.infer<typeof storedSchema>;

const completionResponseSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string().nullable().optional(),
    message: z.object({ content: z.union([z.string(), z.null()]) }),
  })).min(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_hit_tokens: z.number().int().nonnegative().optional(),
    prompt_cache_miss_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().optional() }).optional(),
  }).optional(),
});

function reportedUsage(body: string): Pick<TokenUsageAttempt, 'inputTokens' | 'outputTokens' | 'cacheHitTokens' | 'cacheMissTokens'> {
  try {
    const parsed = z.object({ usage: completionResponseSchema.shape.usage }).parse(JSON.parse(body));
    return {
      inputTokens: parsed.usage?.prompt_tokens ?? null,
      outputTokens: parsed.usage?.completion_tokens ?? null,
      cacheHitTokens: parsed.usage?.prompt_cache_hit_tokens ?? parsed.usage?.prompt_tokens_details?.cached_tokens ?? null,
      cacheMissTokens: parsed.usage?.prompt_cache_miss_tokens ?? null,
    };
  } catch {
    return { inputTokens: null, outputTokens: null, cacheHitTokens: null, cacheMissTokens: null };
  }
}

async function recordCompletionAttempt(
  input: { model: string; usageContext?: { jobId: string; stage: string; runId?: string } },
  requestKind: TokenUsageAttempt['requestKind'], attempt: number, httpStatus: number | null,
  outcome: TokenUsageAttempt['outcome'], body: string,
): Promise<void> {
  await recordTokenUsageAttempt({
    runId: input.usageContext?.runId ?? null,
    jobId: input.usageContext?.jobId ?? null,
    stage: input.usageContext?.stage ?? 'unattributed',
    model: input.model,
    requestKind, attempt, httpStatus, outcome,
    ...reportedUsage(body),
  });
}

const modelListResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().trim().min(1) })),
});

function configPath(): string {
  return path.join(app.getPath('userData'), 'api-config.json');
}

async function readStored(): Promise<StoredApiConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(), 'utf8'));
    return storedSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function getRequestSettings() {
  return apiRequestSettingsSchema.parse((await readStored())?.requestSettings ?? {});
}

export async function getApiStatus(): Promise<ApiStatus> {
  const stored = await readStored();
  return {
    configured: Boolean(stored),
    requestSettings: apiRequestSettingsSchema.parse(stored?.requestSettings ?? {}),
    provider: stored?.provider ?? null,
    baseUrl: stored?.baseUrl ?? null,
    preferredModel: stored?.preferredModel ? resolveModelId(stored.baseUrl, stored.preferredModel) : null,
  };
}

export async function saveApiConfig(input: unknown): Promise<ApiStatus> {
  const config = apiInputSchema.parse(input);
  const previous = await readStored();
  const apiKey = config.apiKey?.trim() ?? '';
  if (!apiKey && !previous) throw new Error('首次保存 API 配置时必须填写密钥');
  const previousBaseUrl = previous?.baseUrl.replace(/\/$/u, '');
  const nextBaseUrl = config.baseUrl.replace(/\/$/u, '');
  const connectionChanged = Boolean(previous
    && (previous.provider !== config.provider || previousBaseUrl !== nextBaseUrl));
  if (!apiKey && connectionChanged) throw new Error('切换 API 服务商或基础地址时必须填写对应的新密钥');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法提供安全密钥存储，请先启用 Windows 登录保护');
  const encryptedKey = apiKey ? safeStorage.encryptString(apiKey).toString('base64') : previous!.encryptedKey;
  await fs.mkdir(path.dirname(configPath()), { recursive: true });
  await fs.writeFile(
    configPath(),
    JSON.stringify({
      provider: config.provider,
      baseUrl: nextBaseUrl,
      encryptedKey,
      preferredModel: resolveModelId(nextBaseUrl, config.preferredModel),
      requestSettings: config.requestSettings ?? previous?.requestSettings ?? apiRequestSettingsSchema.parse({}),
    }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  return getApiStatus();
}

async function authorizedConfig(): Promise<{ stored: StoredApiConfig; key: string }> {
  const stored = await readStored();
  if (!stored) throw new Error('尚未保存 API 配置');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用');
  return { stored, key: safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')) };
}

export async function listApiModels(): Promise<{ models: string[] }> {
  const { stored, key } = await authorizedConfig();
  const response = await fetch(`${stored.baseUrl.replace(/\/$/, '')}/models`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`模型列表请求失败：${response.status} ${response.statusText}`);
  const parsed = modelListResponseSchema.parse(JSON.parse(body));
  return { models: [...new Set(parsed.data.map((item) => item.id))].sort((left, right) => left.localeCompare(right)) };
}

export async function testApiConnection(): Promise<{ ok: boolean; message: string }> {
  try {
    const { models } = await listApiModels();
    return { ok: true, message: `连接成功，读取到 ${models.length} 个可用模型` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '连接失败' };
  }
}

export async function requestJsonCompletion(input: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  usageContext?: { jobId: string; stage: string; runId?: string };
}): Promise<{ parsed: unknown; rawJson: string; inputTokens: number; outputTokens: number }> {
  const stored = await readStored();
  if (!stored) throw new Error('尚未保存 API 配置，请先到“API 设置”完成配置');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用');
  const key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'));
  const settings = apiRequestSettingsSchema.parse(stored.requestSettings ?? {});
  const attempts = buildJsonCompletionAttempts({ ...input, model: resolveModelId(stored.baseUrl, input.model), settings });
  let body = '';
  let response: Response | null = null;
  let successfulAttempt = 0;
  for (let index = 0; index < attempts.length; index += 1) {
    try { response = await fetch(`${stored.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(attempts[index]),
      signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
    }); body = await response.text(); } catch (error) {
      await recordCompletionAttempt(input, 'json', index + 1, null, 'network_error', '');
      throw error;
    }
    if (response.ok) { successfulAttempt = index + 1; break; }
    await recordCompletionAttempt(input, 'json', index + 1, response.status, 'http_error', body);
    const hasFallback = index + 1 < attempts.length;
    if (!hasFallback || !shouldRetryWithoutOptionalJsonMode(response.status, body)) {
      throw new Error(`模型服务器返回 ${response.status}：${body.slice(0, 500)}`);
    }
  }
  if (!response?.ok) throw new Error('模型服务器没有返回可用响应');
  try {
    const completion = completionResponseSchema.parse(JSON.parse(body));
    const { parsed, rawJson } = decodeCompletionJson({
      content: completion.choices[0].message.content,
      finishReason: completion.choices[0].finish_reason,
      outputTokens: completion.usage?.completion_tokens,
      maxTokens: attempts[successfulAttempt - 1].max_tokens,
    });
    await recordCompletionAttempt(input, 'json', successfulAttempt, response.status, 'completed', body);
    return { parsed, rawJson, inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0 };
  } catch (error) {
    await recordCompletionAttempt(input, 'json', successfulAttempt, response.status, 'invalid_response', body);
    throw error;
  }
}

export async function requestTextCompletion(input: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  usageContext?: { jobId: string; stage: string; runId?: string };
}): Promise<{ content: string; inputTokens: number; outputTokens: number }> {
  const stored = await readStored();
  if (!stored) throw new Error('尚未保存 API 配置，请先到“API 设置”完成配置');
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储当前不可用');
  const key = safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64'));
  const settings = apiRequestSettingsSchema.parse(stored.requestSettings ?? {});
  const attempts = buildTextCompletionAttempts({ ...input, model: resolveModelId(stored.baseUrl, input.model), maxTokens: input.maxTokens ?? settings.textMaxTokens, settings });
  let body = '';
  let response: Response | null = null;
  let successfulAttempt = 0;
  for (let index = 0; index < attempts.length; index += 1) {
    try { response = await fetch(`${stored.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(attempts[index]),
      signal: AbortSignal.timeout(settings.timeoutSeconds * 1000),
    }); body = await response.text(); } catch (error) {
      await recordCompletionAttempt(input, 'text', index + 1, null, 'network_error', '');
      throw error;
    }
    if (response.ok) { successfulAttempt = index + 1; break; }
    await recordCompletionAttempt(input, 'text', index + 1, response.status, 'http_error', body);
    if (index + 1 >= attempts.length || !shouldRetryWithoutOptionalJsonMode(response.status, body)) {
      throw new Error(`模型服务器返回 ${response.status}：${body.slice(0, 500)}`);
    }
  }
  if (!response?.ok) throw new Error('模型服务器没有返回可用响应');
  try {
    const completion = completionResponseSchema.parse(JSON.parse(body));
    const content = completion.choices[0].message.content?.trim();
    if (!content) throw new Error('模型返回了空内容');
    await recordCompletionAttempt(input, 'text', successfulAttempt, response.status, 'completed', body);
    return { content, inputTokens: completion.usage?.prompt_tokens ?? 0, outputTokens: completion.usage?.completion_tokens ?? 0 };
  } catch (error) {
    await recordCompletionAttempt(input, 'text', successfulAttempt, response.status, 'invalid_response', body);
    throw error;
  }
}
