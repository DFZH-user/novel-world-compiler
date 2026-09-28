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

describe('phase 1A character census', () => {
  it('accepts only source-aligned candidates and keeps review reversible', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-character-scan-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '人物测试.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 雨夜',
      '叶凡站在城门下，别人仍叫他叶天帝。',
      '“跟我来。”林月压低声音说道。',
      '叶凡没有回答，只是握紧了剑。',
    ].join('\n'), 'utf8');

    const store = new ProjectStore();
    try {
      await store.create('人物测试', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 100, overlapAfter: 100 });
      const paragraphs = editor.listParagraphs();
      const service = new CharacterService(store);
      const estimate = service.estimate();
      expect(estimate.ready).toBe(true);
      expect(estimate.chunkCount).toBe(1);

      const started = service.createScan('test-model', 'character_scan.v1');
      const work = service.nextChunk(started.jobId);
      expect(work?.paragraphs.every((paragraph) => paragraph.role === 'core')).toBe(true);
      const yeFanParagraph = paragraphs.find((paragraph) => paragraph.text.includes('叶天帝'))!;
      const linYueParagraph = paragraphs.find((paragraph) => paragraph.text.includes('林月'))!;
      const output: CharacterScanOutput = {
        characters: [
          {
            local_key: 'ye_fan', display_name: '叶凡', entity_kind: 'human', role_hints: ['主角候选'],
            mention_forms: [{ text: '叶凡', kind: 'name' }, { text: '叶天帝', kind: 'alias' }],
            has_dialogue: false, participates_in_event: true, confidence: 0.98, uncertainty: '',
            evidence: [{ paragraph_id: yeFanParagraph.id, exact_quote: yeFanParagraph.text, supports: 'alias' }],
          },
          {
            local_key: 'lin_yue', display_name: '林月', entity_kind: 'human', role_hints: [],
            mention_forms: [{ text: '林月', kind: 'name' }], has_dialogue: true, participates_in_event: true,
            confidence: 0.96, uncertainty: '',
            evidence: [{ paragraph_id: linYueParagraph.id, exact_quote: '“跟我来。”林月压低声音说道。', supports: 'dialogue' }],
          },
          {
            local_key: 'invented', display_name: '不存在的人', entity_kind: 'human', role_hints: [],
            mention_forms: [{ text: '不存在的人', kind: 'name' }], has_dialogue: false, participates_in_event: false,
            confidence: 0.99, uncertainty: '',
            evidence: [{ paragraph_id: yeFanParagraph.id, exact_quote: '这句话并不在小说里', supports: 'existence' }],
          },
        ],
        identity_claims: [],
      };
      service.ingest(started.jobId, work!.chunkId, output, JSON.stringify(output), 100, 50);
      expect(service.nextChunk(started.jobId)).toBeNull();
      const candidates = service.listCharacters();
      expect(candidates.map((candidate) => candidate.canonicalName).sort()).toEqual(['叶凡', '林月']);
      expect(candidates.find((candidate) => candidate.canonicalName === '叶凡')?.aliases).toContain('叶天帝');
      const yeFan = candidates.find((candidate) => candidate.canonicalName === '叶凡')!;
      expect(service.listMentions(yeFan.id)[0].alignmentStatus).toBe('exact');

      expect(service.review(yeFan.id, { status: 'confirmed', importanceTier: 'core' }).find((item) => item.id === yeFan.id))
        .toMatchObject({ reviewStatus: 'confirmed', importanceTier: 'core' });
      expect(service.review(yeFan.id, { status: 'pending' }).find((item) => item.id === yeFan.id)?.reviewStatus).toBe('pending');
      expect(service.createScan('test-model', 'character_scan.v1')).toMatchObject({ reused: true, state: 'completed' });
    } finally {
      await store.close();
    }
  });

  it('recovers an interrupted chunk without creating a duplicate scan run', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-character-recovery-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '恢复测试.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, '第一章\n沈青走进客栈。\n', 'utf8');

    const firstStore = new ProjectStore();
    await firstStore.create('恢复测试', projectRoot);
    await new Importer(firstStore).run(sourcePath, 'utf8');
    const firstEditor = new EditorService(firstStore);
    firstEditor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
    const firstService = new CharacterService(firstStore);
    const started = firstService.createScan('test-model', 'character_scan.v1');
    const interruptedWork = firstService.nextChunk(started.jobId)!;
    expect(interruptedWork).not.toBeNull();
    await firstStore.close();

    const recoveredStore = new ProjectStore();
    try {
      await recoveredStore.open(projectRoot);
      expect(new EditorService(recoveredStore).listJobs().find((job) => job.id === started.jobId)?.state).toBe('queued');
      const recoveredService = new CharacterService(recoveredStore);
      const recovered = recoveredService.createScan('test-model', 'character_scan.v1');
      expect(recovered).toMatchObject({ jobId: started.jobId, runId: started.runId, reused: true, state: 'running' });
      expect(recoveredService.nextChunk(started.jobId)?.chunkId).toBe(interruptedWork.chunkId);
    } finally {
      await recoveredStore.close();
    }
  });

  it('stops immediately after a terminal chunk failure and can retry the same chunk', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-character-failure-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '失败重试.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, '第一章\n沈青走进客栈。\n', 'utf8');

    const store = new ProjectStore();
    try {
      await store.create('失败重试', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const service = new CharacterService(store);
      const started = service.createScan('deepseek-v4-flash', 'character_scan.v1');
      const firstWork = service.nextChunk(started.jobId)!;

      expect(service.recordError(started.jobId, firstWork.chunkId, '模型返回了空内容', true)).toMatchObject({ state: 'failed', progress: 0 });
      expect(service.nextChunk(started.jobId)).toBeNull();
      expect(editor.listJobs().find((job) => job.id === started.jobId)).toMatchObject({
        state: 'failed',
        message: expect.stringContaining('模型返回了空内容'),
      });

      expect(service.createScan('deepseek-v4-flash', 'character_scan.v1')).toMatchObject({
        jobId: started.jobId,
        reused: true,
        state: 'running',
      });
      expect(service.nextChunk(started.jobId)?.chunkId).toBe(firstWork.chunkId);
    } finally {
      await store.close();
    }
  });

  it('reviews aliases and reverses cannot-link, merge and evidence split operations', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-identity-review-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '身份审核.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
      await fs.writeFile(sourcePath, [
        '第一章 客栈',
        '陆沉，人称小陆，推门走进客栈。',
        '小陆把伞放在墙边。',
        '掌柜周平抬头看了他一眼。',
    ].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('身份审核', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const paragraphs = editor.listParagraphs();
      const service = new CharacterService(store);
      const started = service.createScan('test-model', 'character_scan.v1');
      const work = service.nextChunk(started.jobId)!;
      const firstLu = paragraphs.find((paragraph) => paragraph.text.includes('小陆'))!;
      const secondLu = paragraphs.find((paragraph) => paragraph.text.includes('墙边'))!;
      const zhou = paragraphs.find((paragraph) => paragraph.text.includes('周平'))!;
      const output: CharacterScanOutput = {
        characters: [
          {
            local_key: 'lu', display_name: '陆沉', entity_kind: 'human', role_hints: [],
            mention_forms: [{ text: '陆沉', kind: 'name' }, { text: '小陆', kind: 'alias' }],
            has_dialogue: false, participates_in_event: true, confidence: 0.98, uncertainty: '',
            evidence: [
              { paragraph_id: firstLu.id, exact_quote: firstLu.text, supports: 'alias' },
              { paragraph_id: secondLu.id, exact_quote: secondLu.text, supports: 'event' },
            ],
          },
          {
            local_key: 'zhou', display_name: '周平', entity_kind: 'human', role_hints: [],
            mention_forms: [{ text: '周平', kind: 'name' }], has_dialogue: false, participates_in_event: true,
            confidence: 0.95, uncertainty: '', evidence: [{ paragraph_id: zhou.id, exact_quote: zhou.text, supports: 'name' }],
          },
        ], identity_claims: [],
      };
      service.ingest(started.jobId, work.chunkId, output, JSON.stringify(output), 100, 50);
      service.nextChunk(started.jobId);
      let people = service.listCharacters();
      const lu = people.find((person) => person.canonicalName === '陆沉')!;
      const zhouPing = people.find((person) => person.canonicalName === '周平')!;
      const matchingAliases = service.listAliases(lu.id).filter((item) => item.alias === '小陆');
      expect(matchingAliases).toHaveLength(1);
      expect(store.get().db.prepare(`SELECT COUNT(*) AS count FROM person_aliases
        WHERE identity_id = ? AND normalized_alias = '小陆'`).get(lu.id)).toMatchObject({ count: 2 });
      const alias = matchingAliases[0];
      expect(service.reviewAlias(alias.id, 'confirmed').find((item) => item.id === alias.id)?.reviewStatus).toBe('confirmed');
      expect(store.get().db.prepare(`SELECT COUNT(*) AS count FROM person_aliases
        WHERE identity_id = ? AND normalized_alias = '小陆' AND review_status = 'confirmed'`).get(lu.id)).toMatchObject({ count: 2 });
      expect(service.undoLatest().operation.operation).toBe('alias_review');
      expect(store.get().db.prepare(`SELECT COUNT(*) AS count FROM person_aliases
        WHERE identity_id = ? AND normalized_alias = '小陆' AND review_status = 'pending'`).get(lu.id)).toMatchObject({ count: 2 });

      service.link(lu.id, zhouPing.id, 'cannot_link', '二人在同一场景分别行动');
      expect(() => service.merge(zhouPing.id, lu.id)).toThrow(/不同人物/);
      expect(service.undoLatest().operation.operation).toBe('cannot_link');

      people = service.merge(zhouPing.id, lu.id);
      expect(people.find((person) => person.id === zhouPing.id)?.reviewStatus).toBe('rejected');
      expect(service.listMentions(lu.id)).toHaveLength(3);
      expect(service.undoLatest().operation.operation).toBe('merge');
      expect(service.listMentions(lu.id)).toHaveLength(2);
      expect(service.listCharacters().find((person) => person.id === zhouPing.id)?.reviewStatus).toBe('pending');

      const splitMention = service.listMentions(lu.id)[1];
      people = service.split(lu.id, [splitMention.id], '另一个陆沉');
      const separated = people.find((person) => person.canonicalName === '另一个陆沉');
      expect(separated).toBeDefined();
      expect(service.listMentions(separated!.id)).toHaveLength(1);
      expect(service.undoLatest().operation.operation).toBe('split');
      expect(service.listCharacters().some((person) => person.canonicalName === '另一个陆沉')).toBe(false);
      expect(service.listMentions(lu.id)).toHaveLength(2);
      expect(service.listOperations().some((item) => item.operation === 'alias_review')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('does not collapse two same-name characters when the chunk says they are different people', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-same-name-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '同名人物.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, '第一章\n东村的陈明先到了。\n西村的陈明随后进门。\n', 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('同名人物', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const paragraphs = editor.listParagraphs().filter((paragraph) => paragraph.text.includes('陈明'));
      const service = new CharacterService(store);
      const started = service.createScan('test-model', 'character_scan.v1');
      const work = service.nextChunk(started.jobId)!;
      const output: CharacterScanOutput = {
        characters: paragraphs.map((paragraph, index) => ({
          local_key: `chen_${index}`, display_name: '陈明', mention_forms: [{ text: '陈明', kind: 'name' as const }],
          entity_kind: 'human' as const, role_hints: [], has_dialogue: false, participates_in_event: true,
          evidence: [{ paragraph_id: paragraph.id, exact_quote: paragraph.text, supports: 'identity' as const }], confidence: 0.99, uncertainty: '同名异人',
        })),
        identity_claims: [{
          left_local_key: 'chen_0', right_local_key: 'chen_1', relation: 'different_person', reason: '分别来自东村和西村',
          confidence: 0.99, evidence_paragraph_ids: paragraphs.map((paragraph) => paragraph.id),
        }],
      };
      service.ingest(started.jobId, work.chunkId, output, JSON.stringify(output), 100, 40);
      const sameNamePeople = service.listCharacters().filter((person) => person.canonicalName === '陈明');
      expect(sameNamePeople).toHaveLength(2);
      const link = service.listIdentityLinks(sameNamePeople[0].id)[0];
      expect(link).toMatchObject({ relation: 'cannot_link', reviewStatus: 'pending' });
      service.reviewIdentityLink(link.id, 'confirmed');
      expect(() => service.merge(sameNamePeople[1].id, sameNamePeople[0].id)).toThrow(/不同人物/);
      expect(service.undoLatest().operation.operation).toBe('cannot_link');
      expect(service.listIdentityLinks(sameNamePeople[0].id)[0].reviewStatus).toBe('pending');
    } finally {
      await store.close();
    }
  });
});
