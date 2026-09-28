import { defaultApiRequestSettings } from '../../src/shared/api-request-settings';
import { describe, expect, it, vi } from 'vitest';
import { CharacterScanRunner } from '../../electron/main/character-scan-runner';
import { CompletionJsonError } from '../../electron/main/completion-json';
import { getRequestSettings, requestJsonCompletion } from '../../electron/main/secure-config';
import type { WorkerClient } from '../../electron/main/worker-client';
vi.mock('../../electron/main/secure-config', () => ({ requestJsonCompletion: vi.fn(), getRequestSettings: vi.fn(async () => defaultApiRequestSettings) }));
describe('census retry recovery', () => {
  it('honors a saved large initial budget, ceiling and single-attempt setting', async () => {
    vi.mocked(getRequestSettings).mockResolvedValueOnce({ ...defaultApiRequestSettings, jsonMaxTokens: 64000, censusRetryMaxTokens: 128000, maxAttempts: 1 });
    vi.mocked(requestJsonCompletion).mockReset().mockRejectedValue(new CompletionJsonError('truncated', 'length'));
    const request = vi.fn(async (channel: string) => channel === 'characters:scan-next' ? { jobId: 'j', chunkId: 'c', chunkOrdinal: 1, model: 'deepseek-flash', promptVersion: 'v1', paragraphs: [] } : null);
    await (new CharacterScanRunner({ request } as unknown as WorkerClient) as unknown as { run(id: string): Promise<void> }).run('j');
    expect(requestJsonCompletion).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestJsonCompletion).mock.calls[0][0].maxTokens).toBe(64000);
    expect(request.mock.calls.filter(call => call[0] === 'characters:scan-error')).toHaveLength(1);
  });

  it('retries the failed chunk with a larger budget and ingests only the complete result', async () => {
    vi.mocked(requestJsonCompletion).mockReset();
    vi.mocked(requestJsonCompletion).mockRejectedValueOnce(new CompletionJsonError('truncated', 'length')).mockResolvedValueOnce({ parsed: { characters: [], identity_claims: [] }, rawJson: '{"characters":[],"identity_claims":[]}', inputTokens: 20, outputTokens: 10 });
    let next = 0;
    const request = vi.fn(async (channel: string) => channel === 'characters:scan-next' && next++ === 0 ? { jobId: 'j', chunkId: 'c', chunkOrdinal: 1, model: 'deepseek-flash', promptVersion: 'v1', paragraphs: [] } : null);
    const runner = new CharacterScanRunner({ request } as unknown as WorkerClient);
    await (runner as unknown as { run(id: string): Promise<void> }).run('j');
    expect(vi.mocked(requestJsonCompletion).mock.calls.map(call => call[0].maxTokens)).toEqual([6000, 12000]);
    expect(vi.mocked(requestJsonCompletion).mock.calls[1][0].system).toContain('重新输出完整');
    expect(request.mock.calls.filter(call => call[0] === 'characters:scan-ingest')).toHaveLength(1);
    expect(request.mock.calls.filter(call => call[0] === 'characters:scan-error')).toHaveLength(0);
  });
  it('stops after three invalid replies and never writes partial candidates', async () => {
    vi.mocked(requestJsonCompletion).mockReset().mockRejectedValue(new CompletionJsonError('invalid-json', 'invalid'));
    const request = vi.fn(async (channel: string) => channel === 'characters:scan-next' ? { jobId: 'j', chunkId: 'c', chunkOrdinal: 1, model: 'deepseek-flash', promptVersion: 'v1', paragraphs: [] } : null);
    await (new CharacterScanRunner({ request } as unknown as WorkerClient) as unknown as { run(id: string): Promise<void> }).run('j');
    expect(requestJsonCompletion).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.filter(call => call[0] === 'characters:scan-ingest')).toHaveLength(0);
    expect(request.mock.calls.filter(call => call[0] === 'characters:scan-error')).toHaveLength(1);
  });
});
