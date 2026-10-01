import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ stored: '', writes: [] as string[], usageLines: [] as string[] }));
vi.mock('electron', () => ({ app: { getPath: () => '/settings-test' }, safeStorage: { isEncryptionAvailable: () => true, encryptString: () => Buffer.from('encrypted-test'), decryptString: () => 'mock-key' } }));
vi.mock('node:fs/promises', () => ({ default: {
  readFile: async () => state.stored,
  mkdir: async () => {},
  writeFile: async (_path: string, content: string) => { state.stored = content; state.writes.push(content); },
  appendFile: async (_path: string, content: string) => { state.usageLines.push(content); },
} }));
import { apiRequestSettingsSchema, defaultApiRequestSettings } from '../../src/shared/api-request-settings';
import { getApiStatus, saveApiConfig, requestJsonCompletion, requestTextCompletion } from '../../electron/main/secure-config';
import { buildJsonCompletionAttempts } from '../../electron/main/model-request-policy';
import { CompletionJsonError, nextCensusJsonBudget } from '../../electron/main/completion-json';
const connection = { provider: 'Mock', baseUrl: 'https://mock.invalid/v1', preferredModel: 'deepseek-flash' };
const successfulResponse = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"characters":[]}' } }] }));
beforeEach(() => { state.stored = JSON.stringify({ ...connection, encryptedKey: 'existing-encrypted-key' }); state.writes = []; state.usageLines = []; });
afterEach(() => vi.unstubAllGlobals());
describe('editable API preferences', () => {
  it('loads legacy defaults, round-trips settings and retains the existing encrypted key', async () => {
    expect((await getApiStatus()).requestSettings).toEqual(defaultApiRequestSettings);
    const requestSettings = { ...defaultApiRequestSettings, jsonMaxTokens: 65536, censusRetryMaxTokens: 131072, textMaxTokens: 4096, timeoutSeconds: 600 };
    const status = await saveApiConfig({ ...connection, requestSettings });
    expect(status.requestSettings).toEqual(requestSettings);
    expect(JSON.parse(state.stored).encryptedKey).toBe('existing-encrypted-key');
    expect(status).not.toHaveProperty('encryptedKey');
    // Saving an older client's connection form must not discard advanced preferences.
    await saveApiConfig(connection);
    expect((await getApiStatus()).requestSettings).toEqual(requestSettings);
  });
  it('sends saved large budgets, timeout and manual sampling on actual transport calls', async () => {
    await saveApiConfig({ ...connection, requestSettings: { ...defaultApiRequestSettings, jsonMaxTokens: 65536, censusRetryMaxTokens: 131072, textMaxTokens: 8192, timeoutSeconds: 600, jsonTemperature: 0, textTemperature: 0.9, topP: 0.8, frequencyPenalty: 0.2, presencePenalty: -0.1, seed: 42, thinking: 'disabled' } });
    const fetchMock = vi.fn().mockImplementation(async () => successfulResponse()); vi.stubGlobal('fetch', fetchMock);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await requestJsonCompletion({ model: 'deepseek-flash', system: 's', user: 'u' });
      await requestTextCompletion({ model: 'deepseek-flash', system: 's', user: 'u', maxTokens: 500 });
      await requestTextCompletion({ model: 'deepseek-flash', system: 's', user: 'u' });
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ max_tokens: 65536, temperature: 0, top_p: 0.8, frequency_penalty: 0.2, presence_penalty: -0.1, seed: 42 });
      expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ max_tokens: 500, temperature: 0.9 });
      expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ max_tokens: 8192, temperature: 0.9 });
      expect(timeout).toHaveBeenCalledWith(600000);
    } finally { timeout.mockRestore(); }
  });
  it('records reported tokens even when a model reply cannot be decoded', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: '{"facts":[' } }],
      usage: { prompt_tokens: 123, completion_tokens: 45, prompt_cache_hit_tokens: 67 },
    }))));
    await expect(requestJsonCompletion({ model: 'deepseek-flash', system: 's', user: 'u',
      usageContext: { jobId: 'job-1', stage: 'character_facts' } })).rejects.toThrow();
    expect(state.usageLines).toHaveLength(1);
    expect(JSON.parse(state.usageLines[0])).toMatchObject({ jobId: 'job-1', stage: 'character_facts',
      outcome: 'invalid_response', inputTokens: 123, outputTokens: 45, cacheHitTokens: 67 });
  });
  it('sends the campus API ID even when a failed workflow saved the catalog label', async () => {
    state.stored = JSON.stringify({ provider: 'BUPT', baseUrl: 'https://myai.bupt.edu.cn/llm-gw/v1',
      preferredModel: 'DeepSeek V4 Flash', encryptedKey: 'existing-encrypted-key' });
    expect((await getApiStatus()).preferredModel).toBe('deepseek-v4-flash');
    const fetchMock = vi.fn().mockImplementation(async () => successfulResponse());
    vi.stubGlobal('fetch', fetchMock);
    await requestJsonCompletion({ model: 'DeepSeek V4 Flash', system: 's', user: 'u' });
    await requestTextCompletion({ model: 'DeepSeek V4 Flash', system: 's', user: 'u' });
    for (const call of fetchMock.mock.calls) expect(JSON.parse(call[1].body).model).toBe('deepseek-v4-flash');
    await saveApiConfig({ provider: 'BUPT', baseUrl: 'https://myai.bupt.edu.cn/llm-gw/v1',
      preferredModel: 'DeepSeek V4 Flash' });
    expect(JSON.parse(state.stored).preferredModel).toBe('deepseek-v4-flash');
  });
  it('does not silently drop manual parameters during compatibility fallback', () => {
    const settings = { ...defaultApiRequestSettings, jsonTemperature: 0.3, thinking: 'enabled' as const, reasoningEffort: 'high' as const };
    const attempts = buildJsonCompletionAttempts({ model: 'generic', system: 's', user: 'u', settings });
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) expect(attempt).toMatchObject({ temperature: 0.3, thinking: { type: 'enabled' }, reasoning_effort: 'high' });
    expect(buildJsonCompletionAttempts({ model: 'generic', system: 's', user: 'u', settings: { ...settings, compatibilityFallback: false } })).toHaveLength(1);
    for (const attempt of buildJsonCompletionAttempts({ model: 'generic', system: 's', user: 'u', settings: { ...settings, jsonMode: 'required' } })) expect(attempt.response_format).toEqual({ type: 'json_object' });
  });
  it('rejects invalid settings without overwriting the saved configuration', async () => {
    const previous = state.stored;
    for (const patch of [{ jsonMaxTokens: 0 }, { jsonMaxTokens: 64000, censusRetryMaxTokens: 12000 }, { maxAttempts: 0 }, { jsonTemperature: 3 }, { timeoutSeconds: NaN }, { inputChunks: { ...defaultApiRequestSettings.inputChunks, coreChars: 20000 } }]) {
      await expect(saveApiConfig({ ...connection, requestSettings: { ...defaultApiRequestSettings, ...patch } })).rejects.toThrow();
    }
    expect(state.stored).toBe(previous);
    expect(state.writes).toEqual([]);
    expect(apiRequestSettingsSchema.parse({ jsonMaxTokens: 100000, censusRetryMaxTokens: 200000 }).jsonMaxTokens).toBe(100000);
  });
  it('grows only truncated output up to the user ceiling', () => {
    const error = new CompletionJsonError('truncated', 'length');
    expect(nextCensusJsonBudget(64000, error, 100000)).toBe(100000);
    expect(nextCensusJsonBudget(100000, error, 100000)).toBe(100000);
    expect(nextCensusJsonBudget(64000, new Error('invalid'), 100000)).toBe(64000);
  });
});
