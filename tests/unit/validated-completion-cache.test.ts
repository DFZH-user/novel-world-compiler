import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ files: new Map<string, string>(), requests: vi.fn(), hits: vi.fn(), failures: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/cache-test' } }));
vi.mock('node:fs/promises', () => ({ default: {
  readFile: async (name: string) => {
    if (!state.files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return state.files.get(name);
  },
  mkdir: async () => {},
  writeFile: async (name: string, content: string, options: { flag?: string }) => {
    if (options.flag === 'wx' && state.files.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    state.files.set(name, content);
  },
  unlink: async (name: string) => { state.files.delete(name); },
} }));
vi.mock('../../electron/main/secure-config', () => ({
  getApiStatus: async () => ({ baseUrl: 'https://gateway.example/v1' }),
  requestJsonCompletion: state.requests,
}));
vi.mock('../../electron/main/token-usage-ledger', () => ({ recordLocalCompletionCacheHit: state.hits,
  recordCompletionSchemaFailure: state.failures }));

import { requestValidatedCompletion, writeValidatedCompletion } from '../../electron/main/validated-completion-cache';

beforeEach(() => {
  state.files.clear(); state.requests.mockReset(); state.hits.mockReset(); state.failures.mockReset();
  state.requests.mockResolvedValue({ parsed: { facts: ['甲'] }, rawJson: '{"facts":["甲"]}', inputTokens: 80, outputTokens: 20 });
});

describe('validated completion cache', () => {
  it('reuses only a validated and committed identical request', async () => {
    const input = { model: 'model-a', system: 'rules', user: 'paragraph A', maxTokens: 1000,
      requestSettings: { jsonTemperature: 0 }, validatorVersion: 'facts.v1',
      usageContext: { jobId: 'job', runId: 'run', stage: 'character_facts' },
      validate: (value: unknown) => {
        if (!value || !Array.isArray((value as { facts?: unknown }).facts)) throw new Error('invalid');
        return value as { facts: string[] };
      } };
    const first = await requestValidatedCompletion(input);
    expect(first.cacheHit).toBe(false);
    expect(state.requests).toHaveBeenCalledTimes(1);
    const beforeCommit = await requestValidatedCompletion(input);
    expect(beforeCommit.cacheHit).toBe(false);
    expect(state.requests).toHaveBeenCalledTimes(2);
    await writeValidatedCompletion(first.cacheKey!, { parsed: first.parsed, rawJson: first.rawJson });
    const reused = await requestValidatedCompletion(input);
    expect(reused.cacheHit).toBe(true);
    expect(reused.inputTokens).toBe(0);
    expect(state.requests).toHaveBeenCalledTimes(2);
    expect(state.hits).toHaveBeenCalledWith({ jobId: 'job', runId: 'run', stage: 'character_facts', model: 'model-a' });
    await requestValidatedCompletion({ ...input, user: 'paragraph B' });
    expect(state.requests).toHaveBeenCalledTimes(3);
  });
  it('records a schema rejection without caching the paid response', async () => {
    const input = { model: 'model-a', system: 'rules', user: 'paragraph A', maxTokens: 1000,
      requestSettings: {}, validatorVersion: 'facts.v1',
      usageContext: { jobId: 'job', runId: 'run', stage: 'character_facts' },
      validate: () => { throw new Error('invalid schema'); } };
    await expect(requestValidatedCompletion(input)).rejects.toThrow('invalid schema');
    expect(state.failures).toHaveBeenCalledWith({ jobId: 'job', runId: 'run', stage: 'character_facts', model: 'model-a' });
    expect(state.files.size).toBe(0);
  });
});
