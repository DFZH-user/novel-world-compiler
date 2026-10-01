import { Segment, useDefault, cnPOSTag } from 'segmentit';

let tokenizer: Segment | null = null;
export function localTokens(text: string) {
  tokenizer ??= useDefault(new Segment());
  // Keep the tokenizer's intermediate arrays bounded, including unusually long lines.
  return tokenizer.doSegment(text.slice(0, 1500));
}
export function tokenPeople(text: string): string[] {
  return localTokens(text).filter(t => cnPOSTag(t.p).includes('人名')).map(t => t.w);
}

/** Bounded TextRank-style extractive ranking. Original sentences remain unchanged. */
export function rankLocalPassages<T extends { text: string }>(items: T[], limit: number): T[] {
  const candidates = items.slice(0, 64);
  if (candidates.length <= limit) return candidates;
  const terms = candidates.map(item => new Set(localTokens(item.text).filter(t => t.w.length > 1 && !/标点|代词|助词|连词|介词/u.test(cnPOSTag(t.p))).map(t => t.w)));
  const weights = terms.map((left, i) => terms.map((right, j) => {
    if (i === j || !left.size || !right.size) return 0;
    let shared = 0; for (const term of left) if (right.has(term)) shared++;
    return shared / (Math.log(left.size + 1) + Math.log(right.size + 1));
  }));
  const totals = weights.map(row => row.reduce((sum, value) => sum + value, 0));
  let scores = candidates.map(() => 1);
  for (let iteration = 0; iteration < 20; iteration++) scores = candidates.map((_, i) =>
    0.15 + weights.reduce((sum, row, j) => sum + (totals[j] ? 0.85 * row[i] * scores[j] / totals[j] : 0), 0));
  const ranked = candidates.map((item, i) => ({ item, score: scores[i], i })).sort((a, b) => b.score - a.score || a.i - b.i);
  const picked: T[] = [], texts = new Set<string>();
  for (const row of ranked) { if (texts.has(row.item.text)) continue; texts.add(row.item.text); picked.push(row.item); if (picked.length === limit) break; }
  return picked;
}
