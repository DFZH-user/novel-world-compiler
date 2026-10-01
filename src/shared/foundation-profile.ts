export const foundationProfiles = ['local', 'low', 'medium', 'high'] as const;
export type FoundationProfile = typeof foundationProfiles[number];

export function normalizeFoundationProfile(value: string): FoundationProfile | 'foundation-v1' {
  if (value === 'foundation-v1' || foundationProfiles.some((profile) => profile === value)) return value as FoundationProfile | 'foundation-v1';
  throw new Error('未知的一键分析档位');
}

export function factPolicyForPromptVersion(promptVersion: string): {
  context: 'full' | 'short' | 'none';
  maxDirectParagraphs: number | null;
} {
  if (promptVersion === 'character_facts.v3.low') return { context: 'none', maxDirectParagraphs: 800 };
  if (promptVersion === 'character_facts.v3.medium') return { context: 'short', maxDirectParagraphs: null };
  return { context: 'full', maxDirectParagraphs: null };
}

export function sampleEvenly<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  if (limit < 2) throw new Error('抽样上限至少为 2');
  return Array.from({ length: limit }, (_, index) => items[Math.round(index * (items.length - 1) / (limit - 1))]);
}
