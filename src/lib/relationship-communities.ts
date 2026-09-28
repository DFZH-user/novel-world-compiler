export type RelationshipCommunityNode = { id: string };
export type RelationshipCommunityEdge = {
  id: string;
  sourceIdentityId: string;
  targetIdentityId: string;
  confidence: number;
  strength: number | null;
};

export type DetectedRelationshipCommunity = {
  memberNodeIds: string[];
  relationshipIds: string[];
};

function weight(edge: RelationshipCommunityEdge): number {
  return Math.max(0.0001, edge.confidence * (0.5 + 0.5 * (edge.strength ?? 0.5)));
}

export function detectRelationshipCommunities(nodes: RelationshipCommunityNode[], edges: RelationshipCommunityEdge[]): DetectedRelationshipCommunity[] {
  const nodeIds = [...new Set(nodes.map((node) => node.id))].sort();
  if (nodeIds.length === 0) return [];
  const allowed = new Set(nodeIds);
  const eligibleEdges = edges.filter((edge) => edge.sourceIdentityId !== edge.targetIdentityId
    && allowed.has(edge.sourceIdentityId) && allowed.has(edge.targetIdentityId));
  const totalWeight = eligibleEdges.reduce((total, edge) => total + weight(edge), 0);
  if (totalWeight === 0) return nodeIds.map((id) => ({ memberNodeIds: [id], relationshipIds: [] }));

  const nodeDegree = new Map(nodeIds.map((id) => [id, 0]));
  for (const edge of eligibleEdges) {
    const edgeWeight = weight(edge);
    nodeDegree.set(edge.sourceIdentityId, (nodeDegree.get(edge.sourceIdentityId) ?? 0) + edgeWeight);
    nodeDegree.set(edge.targetIdentityId, (nodeDegree.get(edge.targetIdentityId) ?? 0) + edgeWeight);
  }
  const communities = new Map(nodeIds.map((id) => [id, new Set([id])]));

  for (let mergeCount = 0; mergeCount < nodeIds.length - 1; mergeCount += 1) {
    const owner = new Map<string, string>();
    for (const [communityId, members] of communities) members.forEach((member) => owner.set(member, communityId));
    const communityDegree = new Map<string, number>();
    for (const [communityId, members] of communities) {
      communityDegree.set(communityId, [...members].reduce((total, member) => total + (nodeDegree.get(member) ?? 0), 0));
    }
    const between = new Map<string, { left: string; right: string; value: number }>();
    for (const edge of eligibleEdges) {
      const sourceCommunity = owner.get(edge.sourceIdentityId)!;
      const targetCommunity = owner.get(edge.targetIdentityId)!;
      if (sourceCommunity === targetCommunity) continue;
      const [left, right] = [sourceCommunity, targetCommunity].sort();
      const key = `${left}\u0000${right}`;
      const current = between.get(key) ?? { left, right, value: 0 };
      current.value += weight(edge);
      between.set(key, current);
    }
    const candidates = [...between.values()].map((candidate) => ({
      ...candidate,
      gain: candidate.value / totalWeight
        - ((communityDegree.get(candidate.left) ?? 0) * (communityDegree.get(candidate.right) ?? 0)) / (2 * totalWeight * totalWeight),
    })).sort((left, right) => right.gain - left.gain || left.left.localeCompare(right.left) || left.right.localeCompare(right.right));
    const best = candidates[0];
    if (!best || best.gain <= 1e-12) break;
    const keep = best.left < best.right ? best.left : best.right;
    const remove = keep === best.left ? best.right : best.left;
    const merged = communities.get(keep)!;
    communities.get(remove)!.forEach((member) => merged.add(member));
    communities.delete(remove);
  }

  return [...communities.values()].map((members) => {
    const memberNodeIds = [...members].sort();
    const memberSet = new Set(memberNodeIds);
    return {
      memberNodeIds,
      relationshipIds: eligibleEdges.filter((edge) => memberSet.has(edge.sourceIdentityId) && memberSet.has(edge.targetIdentityId))
        .map((edge) => edge.id).sort(),
    };
  }).sort((left, right) => left.memberNodeIds[0].localeCompare(right.memberNodeIds[0]));
}
