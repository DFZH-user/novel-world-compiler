import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/isolated-model-test' }, safeStorage: { isEncryptionAvailable: () => true, decryptString: () => 'mock-key' } }));
vi.mock('node:fs/promises', () => ({ default: {
  readFile: async () => JSON.stringify({ provider: 'Mock', baseUrl: 'https://mock.invalid/v1', encryptedKey: 'bW9jaw==' }),
  mkdir: async () => undefined,
  appendFile: async () => undefined,
} }));
import { requestJsonCompletion } from '../../electron/main/secure-config';
const response = (content: string, finish_reason: string) => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 6000 } }), { status: 200 });
afterEach(() => vi.unstubAllGlobals());
describe('JSON transport metadata', () => {
  it('preserves the upstream finish reason and rejects truncated output before ingestion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('{"characters":[]}', 'length')); vi.stubGlobal('fetch', fetchMock);
    await expect(requestJsonCompletion({ model: 'deepseek-flash', system: 's', user: 'u' })).rejects.toMatchObject({ kind: 'truncated' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('passes the bounded retry budget to the provider and accepts a complete document', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response('以下是结果：{ "characters": [] }', 'stop')); vi.stubGlobal('fetch', fetchMock);
    const completion = await requestJsonCompletion({ model: 'deepseek-flash', system: 's', user: 'u', maxTokens: 12000 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ max_tokens: 12000, response_format: { type: 'json_object' } });
    expect(completion.parsed).toEqual({ characters: [] });
    expect(completion.outputTokens).toBe(6000);
  });
});
