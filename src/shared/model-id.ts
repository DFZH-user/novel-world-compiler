/** Resolve a known catalog label to its exact API ID for the campus gateway. */
export function resolveModelId(baseUrl: string, model: string): string {
  const requested = model.trim();
  let host: string;
  try { host = new URL(baseUrl).hostname.toLowerCase(); }
  catch { return requested; }
  if (host === 'myai.bupt.edu.cn' && requested.toLowerCase() === 'deepseek v4 flash') {
    return 'deepseek-v4-flash';
  }
  return requested;
}
