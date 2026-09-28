export type ManagedResourceKind = 'session-worldbook' | 'narrator-card' | 'character-card' | 'chat';
export type ManagedResource = {
  kind: ManagedResourceKind;
  resourceKey: string;
  externalId: string;
};
export type ResourceDecision =
  | { action: 'reuse' | 'recover'; externalId: string }
  | { action: 'create'; externalId: string | null };

/**
 * A record in our registry is an ownership reference, never a reason to overwrite.
 * If the user edited an owned asset, reuse it as-is. A new bundle key creates a new asset.
 */
export function reconcileManagedResource(
  kind: ManagedResourceKind,
  resourceKey: string,
  registered: ManagedResource | null,
  existing: ManagedResource[],
  proposedId?: string,
): ResourceDecision {
  const sameKind = existing.filter(item => item.kind === kind);
  if (registered?.kind === kind && registered.resourceKey === resourceKey
    && sameKind.some(item => item.externalId === registered.externalId)) {
    return { action: 'reuse', externalId: registered.externalId };
  }
  const recovered = sameKind.find(item => item.resourceKey === resourceKey);
  if (recovered) return { action: 'recover', externalId: recovered.externalId };
  if (!proposedId) return { action: 'create', externalId: null };
  const used = new Set(sameKind.map(item => item.externalId));
  let suffix = 1;
  let name = proposedId;
  while (used.has(name)) { suffix += 1; name = `${proposedId}-${suffix}`; }
  return { action: 'create', externalId: name };
}
