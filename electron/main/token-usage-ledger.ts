import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FoundationUsageSummary } from '../../src/shared/contracts';

export type TokenUsageAttempt = {
  runId?: string | null;
  jobId: string | null;
  stage: string;
  model: string;
  requestKind: 'json' | 'text';
  attempt: number;
  httpStatus: number | null;
  outcome: 'completed' | 'invalid_response' | 'invalid_schema' | 'http_error' | 'network_error' | 'cache_hit';
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
};

export async function readTokenUsageSummary(runId: string): Promise<FoundationUsageSummary> {
  const summary: FoundationUsageSummary = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0,
    cacheMissTokens: 0, attempts: 0, localCacheHits: 0, failedAttempts: 0, unreportedAttempts: 0, stages: {} };
  let content: string;
  try { content = await fs.readFile(path.join(app.getPath('userData'), 'token-usage-attempts.ndjson'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return summary; throw error; }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let attempt: TokenUsageAttempt;
    try { attempt = JSON.parse(line) as TokenUsageAttempt; } catch { continue; }
    if (attempt.runId !== runId) continue;
    const stage = summary.stages[attempt.stage] ?? { inputTokens: 0, outputTokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0, attempts: 0, localCacheHits: 0,
      failedAttempts: 0, unreportedAttempts: 0 };
    summary.stages[attempt.stage] = stage;
    if (attempt.outcome === 'cache_hit') {
      summary.localCacheHits += 1;
      stage.localCacheHits += 1;
      continue;
    }
    if (attempt.outcome === 'invalid_schema') {
      summary.failedAttempts += 1;
      stage.failedAttempts += 1;
      continue;
    }
    summary.attempts += 1;
    stage.attempts += 1;
    if (attempt.outcome !== 'completed') { summary.failedAttempts += 1; stage.failedAttempts += 1; }
    if (attempt.inputTokens === null || attempt.outputTokens === null) {
      summary.unreportedAttempts += 1;
      stage.unreportedAttempts += 1;
    }
    summary.inputTokens += attempt.inputTokens ?? 0;
    summary.outputTokens += attempt.outputTokens ?? 0;
    summary.cacheHitTokens += attempt.cacheHitTokens ?? 0;
    summary.cacheMissTokens += attempt.cacheMissTokens ?? 0;
    stage.inputTokens += attempt.inputTokens ?? 0;
    stage.outputTokens += attempt.outputTokens ?? 0;
    stage.cacheHitTokens += attempt.cacheHitTokens ?? 0;
    stage.cacheMissTokens += attempt.cacheMissTokens ?? 0;
  }
  return summary;
}

export async function recordLocalCompletionCacheHit(input: { jobId: string; runId?: string; stage: string; model: string }): Promise<void> {
  await recordTokenUsageAttempt({ runId: input.runId ?? null, jobId: input.jobId, stage: input.stage, model: input.model,
    requestKind: 'json', attempt: 0, httpStatus: null, outcome: 'cache_hit',
    inputTokens: 0, outputTokens: 0, cacheHitTokens: null, cacheMissTokens: null });
}

/** Schema rejection annotates the preceding HTTP attempt without counting its tokens twice. */
export async function recordCompletionSchemaFailure(input: { jobId: string; runId?: string; stage: string; model: string }): Promise<void> {
  await recordTokenUsageAttempt({ runId: input.runId ?? null, jobId: input.jobId, stage: input.stage, model: input.model,
    requestKind: 'json', attempt: 0, httpStatus: null, outcome: 'invalid_schema',
    inputTokens: 0, outputTokens: 0, cacheHitTokens: null, cacheMissTokens: null });
}

// One line per HTTP attempt. Never store the key, prompt, response body, or novel text.
export async function recordTokenUsageAttempt(attempt: TokenUsageAttempt): Promise<void> {
  try {
    const directory = app.getPath('userData');
    await fs.mkdir(directory, { recursive: true });
    await fs.appendFile(path.join(directory, 'token-usage-attempts.ndjson'),
      JSON.stringify({ recordedAt: new Date().toISOString(), ...attempt }) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.warn('[token-usage] 无法写入请求用量记录', error);
  }
}
