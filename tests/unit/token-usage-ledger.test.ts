import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ log: '' }));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/usage-test' } }));
vi.mock('node:fs/promises', () => ({ default: {
  readFile: async () => state.log,
} }));

import { readTokenUsageSummary } from '../../electron/main/token-usage-ledger';

describe('foundation request attempt ledger', () => {
  it('counts paid attempts once and separates schema failures, unknown usage and cache hits by stage', async () => {
    const base = { runId: 'run-a', jobId: 'job-a', model: 'model-a', requestKind: 'json',
      httpStatus: 200, attempt: 1, cacheHitTokens: null, cacheMissTokens: null };
    state.log = [
      { ...base, stage: 'character_facts', outcome: 'completed', inputTokens: 100, outputTokens: 20,
        cacheHitTokens: 30, cacheMissTokens: 70 },
      { ...base, stage: 'character_facts', outcome: 'invalid_response', inputTokens: 50, outputTokens: 10 },
      { ...base, stage: 'character_facts', outcome: 'invalid_schema', attempt: 0, inputTokens: 0, outputTokens: 0 },
      { ...base, stage: 'character_facts', outcome: 'cache_hit', attempt: 0, inputTokens: 0, outputTokens: 0 },
      { ...base, stage: 'event_drafts', outcome: 'network_error', httpStatus: null,
        inputTokens: null, outputTokens: null },
      { ...base, runId: 'another-run', stage: 'character_facts', outcome: 'completed',
        inputTokens: 999, outputTokens: 999 },
    ].map(item => JSON.stringify(item)).join('\n');
    const summary = await readTokenUsageSummary('run-a');
    expect(summary).toMatchObject({ inputTokens: 150, outputTokens: 30, attempts: 3,
      failedAttempts: 3, unreportedAttempts: 1, localCacheHits: 1,
      cacheHitTokens: 30, cacheMissTokens: 70 });
    expect(summary.stages.character_facts).toMatchObject({ inputTokens: 150, outputTokens: 30,
      attempts: 2, failedAttempts: 2, unreportedAttempts: 0, localCacheHits: 1,
      cacheHitTokens: 30, cacheMissTokens: 70 });
    expect(summary.stages.event_drafts).toMatchObject({ attempts: 1, failedAttempts: 1,
      unreportedAttempts: 1, localCacheHits: 0 });
  });
});
