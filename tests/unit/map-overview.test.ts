import { describe, expect, it } from 'vitest';
import { selectMapOverview } from '../../src/shared/map-overview';
import type { NarrativeMapEdge, NarrativeMapNode } from '../../src/shared/contracts';

function place(index: number, overrides: Partial<NarrativeMapNode> = {}): NarrativeMapNode {
  return {
    id: `place-${index}`, name: `地点${index}`, aliases: [], placeType: 'other',
    importanceScore: 0, mentionCount: 0, degree: 0, firstRevealedOrdinal: index,
    componentId: index, parentId: null, hierarchyConflict: false, ...overrides,
  };
}

describe('map overview', () => {
  it('keeps important places and their confirmed parent without changing source data', () => {
    const nodes = Array.from({ length: 100 }, (_, index) => place(index));
    nodes[99] = place(99, { importanceScore: 100, parentId: 'place-98' });
    const source = [...nodes];
    const overview = selectMapOverview(nodes, [], 10);
    expect(overview.nodes.map((node) => node.id)).toContain('place-99');
    expect(overview.nodes.map((node) => node.id)).toContain('place-98');
    expect(overview.nodes.length).toBeLessThan(100);
    expect(nodes).toEqual(source);
  });

  it('shows only relations with both endpoints in the overview', () => {
    const nodes = [place(0, { importanceScore: 10 }), place(1, { importanceScore: 9 }), place(2)];
    const edges = [
      { id: 'visible', sourcePlaceId: 'place-0', targetPlaceId: 'place-1' },
      { id: 'hidden', sourcePlaceId: 'place-0', targetPlaceId: 'place-2' },
    ] as NarrativeMapEdge[];
    expect(selectMapOverview(nodes, edges, 2).edges.map((edge) => edge.id)).toEqual(['visible']);
  });
});
