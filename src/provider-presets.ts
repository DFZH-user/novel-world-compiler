export type ApiProviderPreset = {
  id: 'deepseek' | 'zhipu' | 'moonshot' | 'siliconflow' | 'bailian' | 'custom';
  label: string;
  provider: string;
  baseUrl: string;
  preferredModel: string;
  note: string;
};

export const apiProviderPresets: ApiProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek · V4.1 Flash', provider: 'DeepSeek', baseUrl: 'https://api.deepseek.com', preferredModel: 'deepseek-flash', note: 'DeepSeek 官方 V4.1 Flash；兼容 OpenAI Chat Completions。' },
  { id: 'zhipu', label: '智谱 AI · GLM', provider: '智谱 AI', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', preferredModel: 'glm-5.3', note: '保留为可切换服务商；兼容 OpenAI Chat Completions。' },
  { id: 'moonshot', label: 'Moonshot · Kimi', provider: 'Moonshot AI', baseUrl: 'https://api.moonshot.cn/v1', preferredModel: 'kimi-k3', note: 'Kimi 官方接口；模型仍可手工覆盖。' },
  { id: 'siliconflow', label: '硅基流动 · SiliconFlow', provider: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', preferredModel: 'Pro/deepseek-ai/DeepSeek-R1', note: '聚合模型平台；建议保存后读取账户可用模型。' },
  { id: 'bailian', label: '阿里云百炼 · 北京按量付费', provider: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', preferredModel: 'qwen-plus', note: '北京公共 DashScope 地址；其他地域请使用自定义服务。' },
  { id: 'custom', label: '自定义 OpenAI 兼容服务', provider: '', baseUrl: '', preferredModel: '', note: '适用于代理、私有部署、其他地域或未来供应商。' },
];

export function findProviderPreset(provider: string | null, baseUrl: string | null): ApiProviderPreset {
  const normalizedBase = (baseUrl ?? '').replace(/\/$/u, '').toLowerCase();
  return apiProviderPresets.find((preset) => preset.id !== 'custom'
    && preset.provider === provider
    && preset.baseUrl.toLowerCase() === normalizedBase) ?? apiProviderPresets.at(-1)!;
}

export function providerConfigChanged(saved: { provider: string | null; baseUrl: string | null }, current: { provider: string; baseUrl: string }): boolean {
  if (!saved.provider || !saved.baseUrl) return false;
  return saved.provider !== current.provider || saved.baseUrl.replace(/\/$/u, '') !== current.baseUrl.replace(/\/$/u, '');
}
