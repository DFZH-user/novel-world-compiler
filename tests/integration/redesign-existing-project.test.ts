import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RelationshipService } from '../../electron/worker/relationship-service';
import { ProjectStore } from '../../electron/worker/project-store';
import { inspectProjectBundle, listProjectPlayableEntries } from '../../electron/main/project-bundle-discovery';
import { PlayableBundleValidationService } from '../../electron/worker/playable-bundle-validation-service';
import { PlaySessionPreparationService } from '../../electron/worker/play-session-preparation-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';

const sample = process.env.NOVEL_REDESIGN_SAMPLE;
describe.runIf(Boolean(sample))('existing paid project in a protected test copy', () => {
  it('compares three fact extraction material sizes for frequent characters without model calls', async () => {
    if (!sample || !path.resolve(sample).includes('.codex-redesign-audit')) throw new Error('Only use the designated test-copy directory');
    const store = new ProjectStore();
    try {
      await store.open(sample);
      const { db } = store.get();
      const revisionId = store.getSummary()!.activeRevisionId!;
      const identities = db.prepare(`SELECT i.id, i.canonical_name AS name, COUNT(m.paragraph_id) AS mentions
        FROM person_identities i JOIN person_mentions m ON m.identity_id = i.id
        WHERE i.revision_id = ? AND i.review_status = 'confirmed'
        GROUP BY i.id ORDER BY mentions DESC LIMIT 8`).all(revisionId) as Array<{ id: string; name: string; mentions: number }>;
      expect(identities.length).toBeGreaterThan(0);
      const service = new CharacterFactService(store) as unknown as { collectMaterial: (
        database: typeof db, revision: string, identity: string, version: string,
      ) => Array<{ paragraphId: string; text: string }> };
      const rows = identities.map(identity => {
        const tiers = (['low', 'medium', 'high'] as const).map(profile => {
          const material = service.collectMaterial(db, revisionId, identity.id, `character_facts.v3.${profile}`);
          return { profile, paragraphs: material.length, characters: material.reduce((sum, item) => sum + item.text.length, 0) };
        });
        expect(tiers[0].characters).toBeLessThanOrEqual(tiers[1].characters);
        expect(tiers[1].characters).toBeLessThanOrEqual(tiers[2].characters);
        return { name: identity.name, mentions: identity.mentions, tiers };
      });
      await fs.writeFile(path.join(path.dirname(sample), 'foundation-material-ab-result.json'),
        JSON.stringify({ scope: 'eight most mentioned confirmed characters', modelCalls: 0, rows }, null, 2), 'utf8');
    } finally { await store.close(); }
  }, 180_000);

  it('prepares other confirmed entry events offline without changing reviewed cards', async () => {
    if (!sample || !path.resolve(sample).includes('.codex-redesign-audit')) throw new Error('Only use the designated test-copy directory');
    const store = new ProjectStore();
    try {
      await store.open(sample);
      const db = store.get().db;
      const before = JSON.stringify(db.prepare('SELECT id, entry_event_id, review_status, source_summary_json FROM character_card_drafts ORDER BY id').all());
      const entry = db.prepare(`SELECT id, title, narrative_start_ordinal AS ordinal FROM timeline_events
        WHERE review_status = 'confirmed' AND narrative_start_ordinal BETWEEN 4000 AND 5000
        ORDER BY narrative_start_ordinal LIMIT 1`).get() as { id: string; title: string; ordinal: number } | undefined;
      expect(entry).toBeDefined();
      const service = new PlaySessionPreparationService(new PlayableBundleValidationService(store), store);
      const plan = service.prepareLive(entry!.id, { mode: 'narrator', entryEventId: entry!.id,
        persona: { name: '离线测试旅人', description: '' } });
      expect(plan.preview?.entryEventId).toBe(entry!.id);
      expect(plan.preview?.entryOrdinal).toBe(entry!.ordinal);
      expect(plan.preview?.entryTitle).toBe(entry!.title);
      expect(plan.preview?.ruleKinshipPairCount).toBeGreaterThan(0);
      expect(plan.narratorCard.data.scenario).toContain(entry!.title);
      expect(plan.preview?.startingScene?.evidenceOrdinals.every(ordinal => ordinal <= entry!.ordinal)).toBe(true);
      expect(plan.sessionWorldBook.extensions.novel_world_compiler.entry_ordinal).toBe(entry!.ordinal);
      const profilePlans = (['low', 'medium', 'high'] as const).map(playProfile => service.prepareLive(entry!.id, {
        mode: 'narrator', entryEventId: entry!.id, playProfile,
        persona: { name: '离线测试旅人', description: '' },
      }));
      expect(profilePlans.map(item => item.preview?.worldTokenBudget)).toEqual([512, 1024, 2048]);
      expect(new Set(profilePlans.map(item => item.resourceKey)).size).toBe(3);
      for (const item of profilePlans) {
        expect(item.preview?.startingScene?.evidenceOrdinals.every(ordinal => ordinal <= entry!.ordinal)).toBe(true);
      }
      const runtimeChars = profilePlans.map(item => item.preview?.characters.reduce((sum, character) => sum + character.runtimeChars, 0) ?? 0);
      expect(runtimeChars[0]).toBeLessThanOrEqual(runtimeChars[1]);
      expect(runtimeChars[1]).toBeLessThanOrEqual(runtimeChars[2]);
      for (const [index, profile] of (['low', 'medium', 'high'] as const).entries()) {
        await fs.writeFile(path.join(path.dirname(sample), `session-worldbook-${profile}.json`),
          JSON.stringify(profilePlans[index].sessionWorldBook), 'utf8');
      }
      const place = plan.preview?.availablePlaces[0];
      if (place) {
        const chosen = service.prepareLive(entry!.id, { mode: 'narrator', entryEventId: entry!.id,
          startingPlaceId: place.id, persona: { name: '离线测试旅人', description: '' } });
        expect(chosen.preview?.startingScene?.chosenLocation?.id).toBe(place.id);
      }
      for (const direction of ['ASC', 'DESC']) {
        const edge = db.prepare(`SELECT id, narrative_start_ordinal AS ordinal FROM timeline_events
          WHERE review_status = 'confirmed' ORDER BY narrative_start_ordinal ${direction} LIMIT 1`)
          .get() as { id: string; ordinal: number };
        const edgePlan = service.prepareLive(edge.id, { mode: 'narrator', entryEventId: edge.id,
          persona: { name: '离线测试旅人', description: '' } });
        expect(edgePlan.preview?.entryOrdinal).toBe(edge.ordinal);
      }
      expect(JSON.stringify(db.prepare('SELECT id, entry_event_id, review_status, source_summary_json FROM character_card_drafts ORDER BY id').all())).toBe(before);
      expect(() => service.prepareLive('not-an-event')).toThrow('进入事件');
      await fs.writeFile(path.join(path.dirname(sample), 'alternate-entry-result.json'), JSON.stringify({
        entry, characters: plan.preview?.characters.length, places: plan.preview?.availablePlaces.length,
        worldEntries: plan.preview?.worldEntryCount, profileRuntimeChars: runtimeChars,
      }, null, 2));
    } finally { await store.close(); }
  }, 180_000);

  it('opens the copied project and prepares both modes from existing exports without analysis', async () => {
    if (!sample || !path.resolve(sample).includes('.codex-redesign-audit')) throw new Error('Only use the designated test-copy directory');
    const store = new ProjectStore();
    try {
      const project = await store.open(sample);
      expect(project.rootPath).toBe(sample);
      const availability = await inspectProjectBundle(project);
      expect(availability.state).toBe('ready-for-assembly');
      const service = new PlaySessionPreparationService(new PlayableBundleValidationService(store), store);
      const plan = await service.prepare(availability.packageDirectory!);
      expect(plan.preview?.characters).toHaveLength(57);
      expect(plan.preview?.startingScene).toBeDefined();
      expect(plan.preview!.startingScene!.evidenceOrdinals.every(ordinal => ordinal <= plan.preview!.entryOrdinal)).toBe(true);
      const entries = await listProjectPlayableEntries(project);
      expect(entries.some(entry => entry.title === plan.preview!.entryTitle && entry.ordinal === plan.preview!.entryOrdinal)).toBe(true);
      const place = plan.preview!.availablePlaces[0];
      expect(place?.name).toBeTruthy();
      const chosen = await service.prepare(availability.packageDirectory!, {
        mode: 'narrator', entryEventId: entries.find(entry => entry.title === plan.preview!.entryTitle && entry.ordinal === plan.preview!.entryOrdinal)!.eventId, startingPlaceId: place.id,
        persona: { name: '测试旅人', description: '' },
      });
      expect(chosen.preview?.startingScene?.chosenLocation).toEqual({ id: place.id, name: place.name });
      expect(chosen.narratorCard.data.scenario).toContain(place.name);
      expect(chosen.resourceKey).not.toBe(plan.resourceKey);
      await expect(service.prepare(availability.packageDirectory!, {
        mode: 'narrator', startingPlaceId: 'not-a-place', persona: { name: '测试旅人', description: '' },
      })).rejects.toThrow('所选地点');
      await expect(service.prepare(availability.packageDirectory!, {
        mode: 'narrator', entryEventId: 'not-an-entry', persona: { name: '测试旅人', description: '' },
      })).rejects.toThrow('所选进入时间');
      const projection = new RelationshipService(store).getGraphProjection(plan.preview!.entryOrdinal);
      expect(projection.events!.length).toBeGreaterThan(0);
      expect(projection.events!.every(event => event.endOrdinal <= projection.entryOrdinal && event.evidence.every(quote => quote.paragraphOrdinal <= projection.entryOrdinal))).toBe(true);
      const character = plan.preview!.characters.find(item => item.name === '方源')!;
      expect(character).toBeDefined();
      expect(character.runtimeChars).toBeLessThan(4500);
      expect(character.sourceChars).toBeGreaterThan(40000);
      const direct = await service.prepare(availability.packageDirectory!, {
        mode: 'character', characterId: character.identityId, persona: { name: '旅人', description: '来自远方。' },
      });
      expect(direct.narratorCard.data.name).toBe('方源');
      expect(direct.narratorCard.data.character_book).toBeUndefined();
      expect(direct.resourceKey).not.toBe(plan.resourceKey);
      await expect(service.prepare(availability.packageDirectory!, {
        mode: 'character', characterId: character.identityId,
        persona: { name: '方源', description: '', identityId: character.identityId },
      })).rejects.toThrow('同一人物');
      await fs.writeFile(path.join(path.dirname(sample), 'runtime-preparation-result.json'), JSON.stringify({
        project: project.name, preview: plan.preview, characterRuntime: character,
        originalCardRows: store.get().db.prepare('SELECT COUNT(*) count FROM character_card_drafts').get(),
      }, null, 2));
    } finally { await store.close(); }
  }, 120_000);
});
