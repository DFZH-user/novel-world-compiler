export class CompletionJsonError extends Error {
  constructor(public readonly kind: 'truncated' | 'invalid-json' | 'empty' | 'filtered', message: string) {
    super(message); this.name = 'CompletionJsonError';
  }
}

/** Accept only a complete JSON document. Never repair missing characters or ingest partial results. */
export function decodeCompletionJson(input: { content: string | null | undefined; finishReason?: string | null; outputTokens?: number; maxTokens: number }): { parsed: unknown; rawJson: string } {
  const reason = input.finishReason ?? '未提供';
  const details = '结束原因：' + reason + '，输出 ' + (input.outputTokens ?? '未知') + ' token，上限 ' + input.maxTokens;
  if (reason === 'length' || reason === 'max_tokens') throw new CompletionJsonError('truncated', '模型回复达到输出长度上限，JSON 可能被截断（' + details + '）；未保存不完整结果');
  if (reason === 'content_filter') throw new CompletionJsonError('filtered', '模型服务拦截了回复（' + details + '），请检查服务端提示或更换模型');
  const content = input.content?.trim().replace(/^\uFEFF/, '') ?? '';
  if (!content) throw new CompletionJsonError('empty', '模型返回了空内容（' + details + '）');
  const rawJson = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const parse = (text: string) => { const parsed: unknown = JSON.parse(text); if (!parsed || typeof parsed !== 'object') throw new Error('not an object'); return { parsed, rawJson: text }; };
  try { return parse(rawJson); } catch { /* Try a single complete document wrapped in explanatory text. */ }
  const documents: string[] = []; let start = -1; let quoted = false; let escaped = false; const stack: string[] = [];
  for (let index = 0; index < rawJson.length; index++) {
    const ch = rawJson[index];
    if (start < 0) { if (ch !== '{' && ch !== '[') continue; start = index; stack.push(ch); continue; }
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop(); if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) break;
      if (!stack.length) { documents.push(rawJson.slice(start, index + 1)); start = -1; }
    }
  }
  // A document beginning with JSON but followed by garbage is not a prose wrapper.
  if (!/^[{[]/.test(rawJson) && start < 0 && documents.length === 1) {
    try { return parse(documents[0]); } catch { /* Invalid syntax must be retried, not fabricated. */ }
  }
  throw new CompletionJsonError('invalid-json', '模型回复不是完整有效的 JSON（' + details + '，文本 ' + content.length + ' 字符）；未写入人物结果，请从失败处重试');
}

export function nextCensusJsonBudget(current: number, error: unknown, limit = 12000): number {
  return error instanceof CompletionJsonError && error.kind === 'truncated' ? Math.max(current, Math.min(limit, current * 2)) : current;
}
