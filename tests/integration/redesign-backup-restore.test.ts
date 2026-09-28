import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ProjectStore } from '../../electron/worker/project-store';
import { BackupService } from '../../electron/worker/backup-service';

const sample = process.env.NOVEL_REDESIGN_SAMPLE;
test.skipIf(!sample)('restores the paid-project copy with all reviewed cards, events and places intact', async () => {
  if (!sample!.includes('.codex-redesign-audit')) throw new Error('Only audit copies may be opened');
  const output=await fs.mkdtemp(path.join(path.dirname(sample!), 'rollback-acceptance-'));
  const store=new ProjectStore(),restoredStore=new ProjectStore();
  try {
    const original=await store.open(sample!);
    const snapshot=(value:ProjectStore)=>({
      cards:value.get().db.prepare('SELECT * FROM character_card_drafts ORDER BY identity_id').all(),
      events:value.get().db.prepare('SELECT COUNT(*) count FROM timeline_events').get(),
      places:value.get().db.prepare('SELECT COUNT(*) count FROM place_identities').get(),
    });
    const before=snapshot(store);
    const backup=path.join(output,'paid-project-copy.novelproj');
    await new BackupService(store).create(backup);
    const parent=path.join(output,'restored');await fs.mkdir(parent);
    const restored=await new BackupService(store).restore(backup,parent);
    const opened=await restoredStore.open(restored.projectPath);
    expect(opened.id).toBe(original.id);expect(opened.rootPath).not.toBe(sample);
    expect(snapshot(restoredStore)).toEqual(before);
    expect(before.cards).toHaveLength(57);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({projectId:opened.id,restoredPath:opened.rootPath,
      cards:before.cards.length,events:before.events,places:before.places,fileCount:restored.fileCount},null,2));
    console.log('Old-project backup restore:',output);
  } finally {await restoredStore.close();await store.close();}
},120000);
