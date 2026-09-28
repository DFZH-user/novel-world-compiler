import type { NarrativeMapEdge, NarrativeMapNode } from './contracts';

const placeTypeWeight: Record<NarrativeMapNode['placeType'], number> = {
  realm: 10, region: 9, country: 9, city: 8, settlement: 7, district: 5,
  route: 4, natural: 6, building: 3, room: 1, landmark: 5, other: 2,
};

/** A readable index, not invented geographic coordinates. The full projection stays untouched. */
export function selectMapOverview(
  nodes: NarrativeMapNode[],
  edges: NarrativeMapEdge[],
  limit = 72,
): { nodes: NarrativeMapNode[]; edges: NarrativeMapEdge[] } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ranked = [...nodes].sort((left, right) => {
    const score = (node: NarrativeMapNode) => (
      node.importanceScore * 8 + Math.log1p(node.mentionCount) * 5
      + Math.log1p(node.degree) * 10 + placeTypeWeight[node.placeType]
    );
    return score(right) - score(left) || left.firstRevealedOrdinal - right.firstRevealedOrdinal
      || left.id.localeCompare(right.id);
  });
  const selected = new Set(ranked.slice(0, Math.max(1, limit)).map((node) => node.id));
  for (const id of [...selected]) {
    let parentId = byId.get(id)?.parentId;
    const visited = new Set<string>();
    while (parentId && byId.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      selected.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
  }
  return {
    nodes: nodes.filter((node) => selected.has(node.id)),
    edges: edges.filter((edge) => selected.has(edge.sourcePlaceId) && selected.has(edge.targetPlaceId)),
  };
}
