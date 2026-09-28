import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDeepSeekRequest,
  preflightRequestUpperBoundCny,
  requestPeakUpperBoundCny,
  runDeepSeekAbSmoke,
  selectSmokeTrial,
} from '../../scripts/lib/deepseek-ab-smoke';

const packageDirectory = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1/stage4-ab-wang-v1');

async function fixtures() {
  return Promise.all([
    fs.readFile(path.join(packageDirectory, 'manifest.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(packageDirectory, 'blind-key.json'), 'utf8').then(JSON.parse),
  ]);
}

function mockResponse(id: string, content: string, promptTokens: number, completionTokens: number) {
  return new Response(JSON.stringify({
    id,
    model: 'deepseek-v4-flash',
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: promptTokens,
      total_tokens: promptTokens + completionTokens,
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('DeepSeek A/B paid smoke guard', () => {
  it('selects the existing blind mapping without exposing arm names in the response labels', async () => {
    const [manifest, blindKey] = await fixtures();
    const selected = selectSmokeTrial(manifest, blindKey, 'late-identity-purpose:run-1');
    expect(selected.arms).toEqual({ X: 'A', Y: 'B' });
    expect(selected.prompts.X).not.toContain('山地部族');
    expect(selected.prompts.Y).toContain('山地部族');
  });

  it('builds a non-thinking, bounded request and computes a conservative peak-price bound', () => {
    expect(buildDeepSeekRequest('测试')).toMatchObject({
      model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: 0, max_tokens: 220, stream: false,
    });
    expect(buildDeepSeekRequest('测试', 0.7)).toMatchObject({ temperature: 0.7 });
    expect(preflightRequestUpperBoundCny('测试')).toBeLessThan(0.01);
    expect(requestPeakUpperBoundCny({
      prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 1000, total_tokens: 1200,
    })).toBeCloseTo(0.0048, 8);
  });

  it('makes exactly two sequential calls and records raw outputs without the API key', async () => {
    const [manifest, blindKey] = await fixtures();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse('x-id', '资料不足，我不能确定。', 180, 20))
      .mockResolvedValueOnce(mockResponse('y-id', '我推断他们来自山地部族，可能要将我用于火祭，但尚未证实。', 230, 32));
    const result = await runDeepSeekAbSmoke({
      manifest, blindKey, trialId: 'late-identity-purpose:run-1', apiKey: 'test-secret', maxBudgetCny: 1, fetchImpl: fetchMock,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'complete', provider: 'DeepSeek', totals: { modelCalls: 2, total_tokens: 462 } });
    expect(JSON.stringify(result)).not.toContain('test-secret');
    expect(result.responses.Y.content).toContain('山地部族');
  });

  it('rejects an empty key or a budget above the project ceiling before any call', async () => {
    const [manifest, blindKey] = await fixtures();
    const fetchMock = vi.fn();
    await expect(runDeepSeekAbSmoke({ manifest, blindKey, trialId: 'late-identity-purpose:run-1', apiKey: '', maxBudgetCny: 1, fetchImpl: fetchMock }))
      .rejects.toThrow('DEEPSEEK_API_KEY 为空');
    await expect(runDeepSeekAbSmoke({ manifest, blindKey, trialId: 'late-identity-purpose:run-1', apiKey: 'x', maxBudgetCny: 2, fetchImpl: fetchMock }))
      .rejects.toThrow('0–1 元');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
