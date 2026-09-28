import { describe, expect, it } from 'vitest';
import {
  buildJsonCompletionAttempts,
  buildTextCompletionAttempts,
  modelRequestProfile,
  shouldRetryWithoutOptionalJsonMode,
} from '../../electron/main/model-request-policy';

describe('provider-neutral model request policy', () => {
  it('keeps generic models free of vendor-specific thinking parameters', () => {
    const attempts = buildJsonCompletionAttempts({ model: 'future-model-x', system: 's', user: 'u' });
    expect(modelRequestProfile('future-model-x')).toBe('generic');
    expect(attempts[0]).toMatchObject({ model: 'future-model-x', response_format: { type: 'json_object' }, temperature: 0.1 });
    expect(attempts[0]).not.toHaveProperty('thinking');
    expect(attempts[1]).not.toHaveProperty('response_format');
    expect(attempts[1]).not.toHaveProperty('temperature');
  });

  it('uses only the compatibility parameters required by known model families', () => {
    const deepseek = buildJsonCompletionAttempts({ model: 'deepseek-flash', system: 's', user: 'u' })[0];
    expect(deepseek).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0.1 });
    expect(deepseek).not.toHaveProperty('reasoning_effort');
    expect(modelRequestProfile('deepseek-v4-flash')).toBe('deepseek-v4');

    const glm = buildJsonCompletionAttempts({ model: 'glm-5.3', system: 's', user: 'u' })[0];
    expect(glm).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'low', temperature: 1 });
    expect(modelRequestProfile('GLM-5.3-Flash')).toBe('glm-5.3');
    expect(buildJsonCompletionAttempts({ model: 'glm-5.3', system: 's', user: 'u' })[1]).not.toHaveProperty('temperature');
  });

  it('retries only explicit optional-parameter compatibility failures', () => {
    expect(shouldRetryWithoutOptionalJsonMode(400, 'unknown parameter response_format')).toBe(true);
    expect(shouldRetryWithoutOptionalJsonMode(422, '不支持 thinking 参数')).toBe(true);
    expect(shouldRetryWithoutOptionalJsonMode(400, 'context length exceeded')).toBe(false);
    expect(shouldRetryWithoutOptionalJsonMode(429, 'unsupported response_format')).toBe(false);
    expect(shouldRetryWithoutOptionalJsonMode(500, 'unknown response_format')).toBe(false);
  });

  it('builds short roleplay text requests without JSON mode', () => {
    const deepseek = buildTextCompletionAttempts({ model: 'deepseek-flash', system: 's', user: 'u' });
    expect(deepseek[0]).toMatchObject({
      model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: 0.7, max_tokens: 500, stream: false,
    });
    expect(deepseek[0]).not.toHaveProperty('response_format');
    expect(deepseek[1]).not.toHaveProperty('thinking');

    const generic = buildTextCompletionAttempts({ model: 'future-model-x', system: 's', user: 'u', maxTokens: 320 });
    expect(generic).toHaveLength(1);
    expect(generic[0]).toMatchObject({ temperature: 0.7, max_tokens: 320 });
  });
});
