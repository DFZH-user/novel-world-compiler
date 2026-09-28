import { describe, expect, it } from 'vitest';
import { decodeCompletionJson, CompletionJsonError, nextCensusJsonBudget } from '../../electron/main/completion-json';
import { buildJsonCompletionAttempts } from '../../electron/main/model-request-policy';
const decode = (content: string, finishReason = 'stop') => decodeCompletionJson({ content, finishReason, maxTokens: 6000, outputTokens: 300 });
describe('complete model JSON', () => {
  it('accepts complete JSON and standard code fences without altering quoted evidence', () => {
    const value = { characters: [{ name: '方源', evidence: '原文含有 } 和 [，以及双引号“你好”' }] };
    expect(decode(JSON.stringify(value)).parsed).toEqual(value);
    expect(decode('\x60\x60\x60json\n' + JSON.stringify(value) + '\n\x60\x60\x60').parsed).toEqual(value);
    expect(decode('结果如下：\n' + JSON.stringify(value) + '\n以上为结果。').parsed).toEqual(value);
  });
  it('never accepts truncated, ambiguous or syntactically damaged results', () => {
    expect(() => decode('{"characters":[]}','length')).toThrow('长度上限');
    expect(() => decode('{"characters":[{"name":"方源"')).toThrow('不是完整有效');
    expect(() => decode('{"characters":[],}')).toThrow('不是完整有效');
    expect(() => decode('结果：{}\n{}')).toThrow('不是完整有效');
    expect(() => decode('false')).toThrow('不是完整有效');
    expect(() => decode('')).toThrow('空内容');
    expect(() => decode('{}', 'content_filter')).toThrow('拦截');
  });
  it('increases a truncated census retry once while bounding the budget', () => {
    const error = new CompletionJsonError('truncated', 'length');
    expect(nextCensusJsonBudget(6000, error)).toBe(12000);
    expect(nextCensusJsonBudget(12000, error)).toBe(12000);
    expect(nextCensusJsonBudget(6000, new Error('bad JSON'))).toBe(6000);
    const attempts = buildJsonCompletionAttempts({ model: 'deepseek-flash', system: 's', user: 'u', maxTokens: 12000 });
    expect(attempts.map(x => x.max_tokens)).toEqual([12000, 12000]);
    expect(buildJsonCompletionAttempts({ model: 'generic', system: 's', user: 'u' })[0].max_tokens).toBe(6000);
  });
});
