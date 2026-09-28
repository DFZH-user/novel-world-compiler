import { describe, expect, it } from 'vitest';
import { detectRelationshipCommunities } from '../../src/lib/relationship-communities';

describe('relationship community detection', () => {
  it('deterministically separates dense groups connected by a weak bridge', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id }));
    const edge = (id: string, sourceIdentityId: string, targetIdentityId: string, confidence = 1, strength = 1) =>
      ({ id, sourceIdentityId, targetIdentityId, confidence, strength });
    const edges = [
      edge('ab', 'a', 'b'), edge('ac', 'a', 'c'), edge('bc', 'b', 'c'),
      edge('de', 'd', 'e'), edge('df', 'd', 'f'), edge('ef', 'e', 'f'),
      edge('cd', 'c', 'd', 0.1, 0),
    ];
    const first = detectRelationshipCommunities(nodes, edges);
    const second = detectRelationshipCommunities([...nodes].reverse(), [...edges].reverse());
    expect(first).toEqual(second);
    expect(first.map((community) => community.memberNodeIds)).toEqual([['a', 'b', 'c'], ['d', 'e', 'f']]);
    expect(first[0].relationshipIds).toEqual(['ab', 'ac', 'bc']);
    expect(first[1].relationshipIds).toEqual(['de', 'df', 'ef']);
  });

  it('keeps isolated nodes as rebuildable singleton communities', () => {
    expect(detectRelationshipCommunities([{ id: 'solo' }], [])).toEqual([{ memberNodeIds: ['solo'], relationshipIds: [] }]);
  });
});
