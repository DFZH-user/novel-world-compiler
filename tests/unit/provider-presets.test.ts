import { describe, expect, it } from 'vitest';
import { apiProviderPresets, findProviderPreset, providerConfigChanged } from '../../src/provider-presets';

describe('API provider presets', () => {
  it('provides verified common providers plus an editable custom option', () => {
    expect(apiProviderPresets.map((preset) => preset.id)).toEqual(['deepseek', 'zhipu', 'moonshot', 'siliconflow', 'bailian', 'custom']);
    expect(findProviderPreset('DeepSeek', 'https://api.deepseek.com/')).toMatchObject({
      preferredModel: 'deepseek-flash',
      label: 'DeepSeek · V4.1 Flash',
    });
    expect(findProviderPreset('智谱 AI', 'https://open.bigmodel.cn/api/paas/v4/').id).toBe('zhipu');
    expect(findProviderPreset('未知服务', 'https://example.com/v1').id).toBe('custom');
  });

  it('requires a new key only when the provider connection changes', () => {
    const saved = { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com' };
    expect(providerConfigChanged(saved, { provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com/' })).toBe(false);
    expect(providerConfigChanged(saved, { provider: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })).toBe(true);
  });
});
