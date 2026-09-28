import { describe, expect, it } from 'vitest';
import { resolveModelId } from '../../src/shared/model-id';

describe('campus model ID', () => {
  it('uses the exact gateway ID for the catalog label, including saved failed jobs', () => {
    expect(resolveModelId('https://myai.bupt.edu.cn/llm-gw/v1', 'DeepSeek V4 Flash')).toBe('deepseek-v4-flash');
    expect(resolveModelId('https://myai.bupt.edu.cn/llm-gw/v1', 'deepseek-v4-flash')).toBe('deepseek-v4-flash');
  });
  it('preserves provider-specific IDs outside the known campus alias', () => {
    expect(resolveModelId('https://api.siliconflow.cn/v1', 'Pro/deepseek-ai/DeepSeek-R1')).toBe('Pro/deepseek-ai/DeepSeek-R1');
    expect(resolveModelId('https://another.example/v1', 'DeepSeek V4 Flash')).toBe('DeepSeek V4 Flash');
    expect(resolveModelId('https://myai.bupt.edu.cn/llm-gw/v1', 'bge-m3')).toBe('bge-m3');
  });
});
