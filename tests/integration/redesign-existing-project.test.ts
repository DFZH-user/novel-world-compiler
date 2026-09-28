import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RelationshipService } from '../../electron/worker/relationship-service';
import { ProjectStore } from '../../electron/worker/project-store';
import { inspectProjectBundle, listProjectPlayableEntries } from '../../electron/main/project-bundle-discovery';
import { PlayableBundleValidationService } from '../../electron/worker/playable-bundle-validation-service';
import { PlaySessionPreparationService } from '../../electron/worker/play-session-preparation-service';

const sample = process.env.NOVEL_REDESIGN_SAMPLE;
describe.runIf(Boolean(sample))('existing paid project in a protected test copy', () => {
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
      expect(plan.narratorCard.data.scenario).toContain(entry!.title);
      expect(plan.preview?.startingScene?.evidenceOrdinals.every(ordinal => ordinal <= entry!.ordinal)).toBe(true);
      expect(plan.sessionWorldBook.extensions.novel_world_compiler.entry_ordinal).toBe(entry!.ordinal);
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
        worldEntries: plan.preview?.worldEntryCount,
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
