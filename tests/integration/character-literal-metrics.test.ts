import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { CharacterService } from '../../electron/worker/character-service';
import type { CharacterScanOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

describe('character full-text metrics', () => {
  it('counts full-text names and confirmed proper aliases without counting generic titles', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-character-literal-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '全文计数.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 初见',
      '李绛眉，人称红衣仙子，也被称为殿主，来到山门。',
      '李绛眉拔剑迎敌。',
      '红衣仙子守在门前。',
      '殿主下令封山。',
      '第二章 重逢',
      '李绛眉再次现身。',
      '众人都认出了红衣仙子。',
      '弟子向殿主行礼。',
    ].join('\n'), 'utf8');

    const store = new ProjectStore();
    try {
      await store.create('全文计数', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 2000, softLimit: 2500, hardLimit: 3000, overlapBefore: 0, overlapAfter: 0 });
      const evidence = editor.listParagraphs().find((paragraph) => paragraph.text.includes('人称红衣仙子'))!;
      const service = new CharacterService(store);
      const started = service.createScan('test-model', 'character_scan.v1');
      const work = service.nextChunk(started.jobId)!;
      const output: CharacterScanOutput = {
        characters: [{
          local_key: 'li_jiangmei',
          display_name: '李绛眉',
          mention_forms: [
            { text: '李绛眉', kind: 'name' },
            { text: '红衣仙子', kind: 'alias' },
            { text: '殿主', kind: 'title' },
          ],
          entity_kind: 'human',
          role_hints: ['重要人物候选'],
          has_dialogue: false,
          participates_in_event: true,
          evidence: [{ paragraph_id: evidence.id, exact_quote: evidence.text, supports: 'alias' }],
          confidence: 0.98,
          uncertainty: '',
        }],
        identity_claims: [],
      };

      service.ingest(started.jobId, work.chunkId, output, JSON.stringify(output), 100, 30);
      expect(service.nextChunk(started.jobId)).toBeNull();
      let character = service.listCharacters()[0];
      expect(service.listMentions(character.id)).toHaveLength(1);
      expect(character).toMatchObject({ mentionCount: 3, chapterCount: 2 });

      store.get().db.prepare('UPDATE person_metrics SET mention_count = 1 WHERE identity_id = ?').run(character.id);
      store.get().db.prepare("DELETE FROM settings WHERE key LIKE 'character_literal_metrics_version:%'").run();
      character = service.listCharacters()[0];
      expect(character.mentionCount).toBe(3);

      const repeatedName = editor.listParagraphs().find((paragraph) => paragraph.text.includes('拔剑迎敌'))!;
      editor.setParagraphExcluded(repeatedName.id, true);
      expect(service.listCharacters()[0].mentionCount).toBe(2);
      editor.setParagraphExcluded(repeatedName.id, false);
      expect(service.listCharacters()[0].mentionCount).toBe(3);

      const properAlias = service.listAliases(character.id).find((alias) => alias.alias === '红衣仙子')!;
      service.reviewAlias(properAlias.id, 'confirmed');
      character = service.listCharacters()[0];
      expect(character).toMatchObject({ mentionCount: 6, chapterCount: 2 });

      const genericTitle = service.listAliases(character.id).find((alias) => alias.alias === '殿主')!;
      service.reviewAlias(genericTitle.id, 'confirmed');
      character = service.listCharacters()[0];
      expect(character).toMatchObject({ mentionCount: 6, chapterCount: 2 });
    } finally {
      await store.close();
    }
  });
});
