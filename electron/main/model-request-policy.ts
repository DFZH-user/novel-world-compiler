import type { ApiRequestSettings } from '../../src/shared/api-request-settings';
export type JsonCompletionRequest = {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  response_format?: { type: 'json_object' };
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'medium' | 'high' | 'max';
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  temperature?: number;
  max_tokens: number;
  stream: false;
};

export type ModelRequestProfile = 'deepseek-v4' | 'glm-5.3' | 'generic';

export function modelRequestProfile(modelInput: string): ModelRequestProfile {
  const model = modelInput.trim().toLowerCase();
  if (/^deepseek-(?:flash(?:-|$)|v4(?:-|$))/u.test(model)) return 'deepseek-v4';
  if (/^glm-5\.3(?:-|$)/u.test(model)) return 'glm-5.3';
  return 'generic';
}

export function buildJsonCompletionAttempts(input: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  settings?: ApiRequestSettings;
}): JsonCompletionRequest[] {
  const json = true;
  const base: JsonCompletionRequest = {
    model: input.model,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    max_tokens: input.maxTokens ?? input.settings?.jsonMaxTokens ?? 6000,
    stream: false,
  };
  const profile = modelRequestProfile(input.model);
  if (profile === 'deepseek-v4') {
    return configureAttempts([
      { ...base, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0.1 },
      { ...base, thinking: { type: 'disabled' } },
    ], input.settings, json);
  }
  if (profile === 'glm-5.3') {
    return configureAttempts([
      { ...base, response_format: { type: 'json_object' }, thinking: { type: 'enabled' }, reasoning_effort: 'low', temperature: 1 },
      { ...base, thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    ], input.settings, json);
  }
  return configureAttempts([
    { ...base, response_format: { type: 'json_object' }, temperature: 0.1 },
    { ...base },
  ], input.settings, json);
}

export function buildTextCompletionAttempts(input: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  settings?: ApiRequestSettings;
}): JsonCompletionRequest[] {
  const json = false;
  const base: JsonCompletionRequest = {
    model: input.model,
    messages: [
      { role: 'system', content: input.system },
      { role: 'user', content: input.user },
    ],
    max_tokens: input.maxTokens ?? input.settings?.textMaxTokens ?? 500,
    stream: false,
  };
  const profile = modelRequestProfile(input.model);
  if (profile === 'deepseek-v4') {
    return configureAttempts([
      { ...base, thinking: { type: 'disabled' }, temperature: 0.7 },
      { ...base, temperature: 0.7 },
    ], input.settings, json);
  }
  if (profile === 'glm-5.3') {
    return configureAttempts([
      { ...base, thinking: { type: 'enabled' }, reasoning_effort: 'low', temperature: 1 },
      { ...base, temperature: 1 },
    ], input.settings, json);
  }
  return configureAttempts([{ ...base, temperature: 0.7 }], input.settings, json);
}

export function shouldRetryWithoutOptionalJsonMode(status: number, responseBody: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const text = responseBody.toLowerCase();
  const mentionsOptionalParameter = /response[_ -]?format|json[_ -]?object|thinking|reasoning[_ -]?effort|temperature/u.test(text);
  const reportsParameterProblem = /unsupported|not supported|unknown|unrecognized|invalid|unexpected|不支持|未知|无效|非法/u.test(text);
  return mentionsOptionalParameter && reportsParameterProblem;
}

function configureAttempts(attempts: JsonCompletionRequest[], settings: ApiRequestSettings | undefined, json: boolean): JsonCompletionRequest[] {
  if (!settings) return attempts;
  const result = attempts.map(attempt => {
    const value = { ...attempt };
    const temperature = json ? settings.jsonTemperature : settings.textTemperature;
    if (temperature !== null) value.temperature = temperature;
    if (settings.topP !== null) value.top_p = settings.topP;
    if (settings.frequencyPenalty !== null) value.frequency_penalty = settings.frequencyPenalty;
    if (settings.presencePenalty !== null) value.presence_penalty = settings.presencePenalty;
    if (settings.seed !== null) value.seed = settings.seed;
    if (settings.thinking === 'omit') delete value.thinking;
    else if (settings.thinking !== 'auto') value.thinking = { type: settings.thinking };
    if (settings.reasoningEffort === 'omit') delete value.reasoning_effort;
    else if (settings.reasoningEffort !== 'auto') value.reasoning_effort = settings.reasoningEffort;
    if (json && settings.jsonMode === 'off') delete value.response_format;
    else if (json && settings.jsonMode === 'required') value.response_format = { type: 'json_object' };
    return value;
  });
  // Manual values must never silently disappear during a compatibility retry.
  return (settings.compatibilityFallback ? result : result.slice(0, 1))
    .filter((value, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(value)) === index);
}
