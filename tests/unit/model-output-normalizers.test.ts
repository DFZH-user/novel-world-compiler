import { describe, expect, it } from 'vitest';
import { characterFactOutputSchema } from '../../src/shared/contracts';
import { normalizeCharacterFactOutput } from '../../electron/main/model-output-normalizers';

function fact(category: string) {
  return {
    category, predicate: '所在地点', value: '青石镇客栈', source_type: 'explicit', confidence: 0.9,
    visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
    evidence: [{ paragraph_id: 'p_1', exact_quote: '沈青走进客栈。', role: 'support' }], reasoning_note: '',
  };
}

describe('model output normalizers', () => {
  it('maps known English and Chinese category aliases without changing fact content', () => {
    const parsed = characterFactOutputSchema.parse(normalizeCharacterFactOutput({ facts: [
      fact('location'), fact('地点'), fact('trait'), fact('dialogue'),
    ] }));
    expect(parsed.facts.map((item) => item.category)).toEqual(['status', 'status', 'personality', 'speech']);
    expect(parsed.facts[0]).toMatchObject({ predicate: '所在地点', value: '青石镇客栈' });
  });

  it('conservatively downgrades unknown non-empty categories to the explicit other bucket', () => {
    const parsed = characterFactOutputSchema.parse(normalizeCharacterFactOutput({ facts: [fact('combat_rank')] }));
    expect(parsed.facts[0]).toMatchObject({ category: 'other', predicate: '所在地点', value: '青石镇客栈' });
  });

  it('still rejects an empty category instead of hiding a malformed response', () => {
    expect(() => characterFactOutputSchema.parse(normalizeCharacterFactOutput({ facts: [fact('  ')] }))).toThrow();
  });
});
