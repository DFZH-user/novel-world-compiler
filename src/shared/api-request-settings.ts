import { z } from 'zod';
import { chunkSettingsSchema } from './contracts';

// These are application defaults, not declarations of any provider's model limits.
export const apiRequestSettingsSchema = z.object({
  inputChunks: chunkSettingsSchema.default({ coreChars: 8000, softLimit: 10000, hardLimit: 12000, overlapBefore: 500, overlapAfter: 500 }),
  jsonMaxTokens: z.number().int().positive().max(2147483647).default(6000),
  textMaxTokens: z.number().int().positive().max(2147483647).default(500),
  censusRetryMaxTokens: z.number().int().positive().max(2147483647).default(12000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  retryDelayMs: z.number().int().min(0).max(60000).default(500),
  timeoutSeconds: z.number().int().min(5).max(3600).default(120),
  jsonTemperature: z.number().min(0).max(2).nullable().default(null),
  textTemperature: z.number().min(0).max(2).nullable().default(null),
  topP: z.number().min(0).max(1).nullable().default(null),
  frequencyPenalty: z.number().min(-2).max(2).nullable().default(null),
  presencePenalty: z.number().min(-2).max(2).nullable().default(null),
  seed: z.number().int().min(0).max(2147483647).nullable().default(null),
  thinking: z.enum(['auto', 'omit', 'enabled', 'disabled']).default('auto'),
  reasoningEffort: z.enum(['auto', 'omit', 'low', 'medium', 'high', 'max']).default('auto'),
  jsonMode: z.enum(['auto', 'required', 'off']).default('auto'),
  compatibilityFallback: z.boolean().default(true),
}).refine(value => value.censusRetryMaxTokens >= value.jsonMaxTokens, {
  path: ['censusRetryMaxTokens'], message: '截断重试上限不能小于分析输出上限',
});
export type ApiRequestSettings = z.infer<typeof apiRequestSettingsSchema>;
export const defaultApiRequestSettings: ApiRequestSettings = apiRequestSettingsSchema.parse({});
