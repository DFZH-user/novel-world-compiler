import { describe, expect, it } from 'vitest';
import { placeModelOutputSchema } from '../../src/shared/contracts';

describe('place model output contract', () => {
  it('accepts evidence-bound pending suggestions without depending on a model vendor', () => {
    const result = placeModelOutputSchema.parse({
      aliases: [{
        place_id: 'place-town', alias: '镇上', confidence: 0.8,
        evidence: [{ paragraph_id: 'p-1', exact_quote: '镇上的客栈已经关门。' }],
      }],
      identity_links: [{
        left_place_id: 'place-inn', right_place_id: 'place-east-inn', relation: 'must_link',
        confidence: 0.7, reason: '原文明确为同一家客栈',
        evidence: [{ paragraph_id: 'p-2', exact_quote: '东店就是归雁客栈。', role: 'support' }],
      }],
      relations: [{
        source_place_id: 'place-town', target_place_id: 'place-inn', relation_kind: 'contains',
        direction: 'directed', information_source_type: 'narrator', information_source_identity_id: null,
        truth_status: 'asserted', valid_from_event_id: null, valid_to_event_id: null, confidence: 0.9,
        evidence: [{ paragraph_id: 'p-3', exact_quote: '归雁客栈坐落在青石镇东。', role: 'support' }],
        reasoning_note: '原文明示包含关系', uncertainty: '',
      }],
    });
    expect(result.relations[0].relation_kind).toBe('contains');
  });

  it('rejects self-links, missing support evidence and invalid character sources', () => {
    expect(() => placeModelOutputSchema.parse({ aliases: [], relations: [], identity_links: [{
      left_place_id: 'same', right_place_id: 'same', relation: 'cannot_link', confidence: 1, reason: '冲突',
      evidence: [{ paragraph_id: 'p-1', exact_quote: '原文', role: 'support' }],
    }] })).toThrow(/不能连接同一地点/);
    expect(() => placeModelOutputSchema.parse({ aliases: [], identity_links: [], relations: [{
      source_place_id: 'a', target_place_id: 'b', relation_kind: 'near', direction: 'undirected',
      information_source_type: 'character', information_source_identity_id: null, truth_status: 'rumor',
      valid_from_event_id: null, valid_to_event_id: null, confidence: 0.5,
      evidence: [{ paragraph_id: 'p-1', exact_quote: '似乎很近', role: 'context' }],
    }] })).toThrow(/人物来源必须提供人物 ID|至少需要一条支持证据/);
  });
});
