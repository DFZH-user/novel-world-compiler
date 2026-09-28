import { describe, expect, it } from 'vitest';
import { reconcileManagedResource, type ManagedResource } from '../../src/shared/managed-resource-reconciliation';

describe('managed play resources', () => {
  const owned: ManagedResource = { kind: 'session-worldbook', resourceKey: 'book:revision:bundle-a', externalId: 'NW-book-a' };

  it('reuses an already imported resource without overwriting manual edits', () => {
    expect(reconcileManagedResource(owned.kind, owned.resourceKey, owned, [owned], 'NW-book-a'))
      .toEqual({ action: 'reuse', externalId: 'NW-book-a' });
  });

  it('recovers an interrupted import from its ownership marker', () => {
    expect(reconcileManagedResource(owned.kind, owned.resourceKey, null, [owned], 'NW-book-a'))
      .toEqual({ action: 'recover', externalId: 'NW-book-a' });
  });

  it('never reuses an older bundle or overwrites an unrelated name collision', () => {
    const unrelated = { ...owned, resourceKey: 'someone-else' };
    expect(reconcileManagedResource(owned.kind, 'book:revision:bundle-b', owned, [owned], 'NW-book-b'))
      .toEqual({ action: 'create', externalId: 'NW-book-b' });
    expect(reconcileManagedResource(owned.kind, owned.resourceKey, null, [unrelated], 'NW-book-a'))
      .toEqual({ action: 'create', externalId: 'NW-book-a-2' });
  });

  it('lets SillyTavern allocate a unique avatar name for a new character', () => {
    expect(reconcileManagedResource('character-card', 'book:revision:character', null, [], undefined))
      .toEqual({ action: 'create', externalId: null });
  });
});
