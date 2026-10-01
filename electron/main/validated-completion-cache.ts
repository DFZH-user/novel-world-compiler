import { createHash } from 'node:crypto';
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getApiStatus, requestJsonCompletion } from './secure-config';
import { recordCompletionSchemaFailure, recordLocalCompletionCacheHit } from './token-usage-ledger';

export type ValidatedCompletion = { parsed: unknown; rawJson: string };

export function validatedCompletionKey(input: {
  baseUrl: string; model: string; system: string; user: string; maxTokens: number;
  requestSettings: unknown; validatorVersion: string;
}): string {
  return createHash('sha256').update(JSON.stringify({ cacheVersion: 1, ...input })).digest('hex');
}

function cachePath(key: string): string {
  if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('无效的模型结果缓存键');
  return path.join(app.getPath('userData'), 'validated-completion-cache', `${key}.json`);
}

export async function readValidatedCompletion(key: string): Promise<ValidatedCompletion | null> {
  try {
    const value = JSON.parse(await fs.readFile(cachePath(key), 'utf8')) as ValidatedCompletion;
    if (value && typeof value.rawJson === 'string' && value.parsed !== undefined) return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
  }
  await discardValidatedCompletion(key);
  return null;
}

/** Called only after the caller has validated and ingested the model output. */
export async function writeValidatedCompletion(key: string, completion: ValidatedCompletion): Promise<void> {
  const serialized = JSON.stringify(completion);
  if (Buffer.byteLength(serialized) > 2_000_000) return;
  const filename = cachePath(key);
  try {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') console.warn('[completion-cache] 无法写入已验证结果', error);
  }
}

export async function discardValidatedCompletion(key: string): Promise<void> {
  try { await fs.unlink(cachePath(key)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[completion-cache] 无法移除失效结果', error); }
}

export async function requestValidatedCompletion<T>(input: {
  model: string; system: string; user: string; maxTokens: number;
  requestSettings: unknown; validatorVersion: string;
  usageContext: { jobId: string; runId?: string; stage: string };
  validate: (parsed: unknown) => T;
}): Promise<{ value: T; rawJson: string; inputTokens: number; outputTokens: number;
  cacheKey: string | null; cacheHit: boolean; parsed: unknown }> {
  let key: string | null = null;
  try {
    const status = await getApiStatus();
    if (status.baseUrl) key = validatedCompletionKey({ baseUrl: status.baseUrl, model: input.model,
      system: input.system, user: input.user, maxTokens: input.maxTokens,
      requestSettings: input.requestSettings, validatorVersion: input.validatorVersion });
  } catch { /* The model request will report missing configuration. */ }
  if (key) {
    const cached = await readValidatedCompletion(key);
    if (cached) {
      try {
        const value = input.validate(cached.parsed);
        await recordLocalCompletionCacheHit({ ...input.usageContext, model: input.model });
        return { value, ...cached, inputTokens: 0, outputTokens: 0, cacheKey: key, cacheHit: true };
      } catch { await discardValidatedCompletion(key); }
    }
  }
  const completion = await requestJsonCompletion({ model: input.model, system: input.system,
    user: input.user, maxTokens: input.maxTokens, usageContext: input.usageContext });
  try {
    return { value: input.validate(completion.parsed), ...completion, cacheKey: key, cacheHit: false };
  } catch (error) {
    await recordCompletionSchemaFailure({ ...input.usageContext, model: input.model });
    throw error;
  }
}
