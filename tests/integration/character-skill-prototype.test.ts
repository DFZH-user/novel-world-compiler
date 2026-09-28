import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CharacterSkillPrototypeService } from '../../electron/worker/character-skill-prototype-service';
import type { PlayableBundleFileRecord, PlayableBundleManifest, TavernCardV2 } from '../../src/shared/contracts';
import { createHash } from 'node:crypto';

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((item) => fs.rm(item, { recursive: true, force: true }))); });

function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

async function fixture(root: string, version: '1.0' | '2.0' = '1.0') {
  const bundle = path.join(root, 'bundle');
  const output = process.env.CHARACTER_SKILL_PROTOTYPE_OUTPUT || path.join(root, 'exports');
  await fs.mkdir(path.join(bundle, 'characters'), { recursive: true });
  const bundleFingerprint = 'a'.repeat(64);
  const bookFingerprint = 'b'.repeat(64);
  const card: TavernCardV2 = {
    spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: '陆沉', description: '陆沉是青石镇的巡夜人。', personality: '沉着谨慎，先查证再判断。',
      scenario: '故事位于陆沉刚进入青石镇的时刻。', first_mes: '今夜城中由我巡查。',
      mes_example: '<START>\n{{char}}: 入夜后，不要独自离开灯火。', creator_notes: '合成验收卡。',
      system_prompt: '保持人物视角，不得提前剧透。', post_history_instructions: '', alternate_greetings: [],
      tags: ['核心人物'], creator: '小说世界编译器', character_version: '1.0',
      extensions: { novel_world_compiler: {
        identity_id: 'identity-lu', entry_event_id: 'entry-event',
        playable_bundle_source_fingerprint: bundleFingerprint,
        character_book_source_fingerprint: bookFingerprint,
      } },
      character_book: {
        name: '陆沉知识', extensions: { novel_world_compiler: {
          entry_event_id: 'entry-event', source_fingerprint: bookFingerprint,
        } }, entries: [{
          id: 0, keys: ['林月'], content: '林月在城门等候陆沉。', enabled: true, insertion_order: 100,
          extensions: { novel_world_compiler: { source_book: 'relationship', source_relation_id: 'relation-lin' } },
        }, {
          id: 1, keys: ['青石镇'], content: '青石镇是陆沉负责巡夜的城镇。', enabled: true, insertion_order: 101,
          extensions: { novel_world_compiler: { source_book: 'place', source_place_id: 'place-town' } },
        }],
      },
    },
  };
  const separateBook = card.data.character_book;
  if (version === '2.0') {
    delete card.data.character_book;
    delete (card.data.extensions.novel_world_compiler as Record<string, unknown>).character_book_source_fingerprint;
  }
  const cardContent = json(card);
  const cardPath = 'characters/01-陆沉.json';
  await fs.writeFile(path.join(bundle, ...cardPath.split('/')), cardContent, 'utf8');
  const bookContent = json(separateBook);
  await fs.writeFile(path.join(bundle, 'character-book.json'), bookContent, 'utf8');
  const placeholder = '{}\n';
  for (const file of ['entry-point.json', 'worldbooks/relationships-world-info.json', 'worldbooks/places-world-info.json']) {
    const target = path.join(bundle, ...file.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, placeholder, 'utf8');
  }
  const records: PlayableBundleFileRecord[] = [{
    path: cardPath, kind: 'character-card', checksum: hash(cardContent), bytes: Buffer.byteLength(cardContent),
    identityId: 'identity-lu', identityName: '陆沉',
  }, {
    path: 'character-book.json', kind: 'character-book', checksum: hash(bookContent), bytes: Buffer.byteLength(bookContent),
  }, ...([
    { path: 'worldbooks/relationships-world-info.json', kind: 'relationship-world-info' },
    { path: 'worldbooks/places-world-info.json', kind: 'place-world-info' },
    { path: 'entry-point.json', kind: 'entry-point' },
  ] satisfies Array<Pick<PlayableBundleFileRecord, 'path' | 'kind'>>).map((record): PlayableBundleFileRecord => ({
    ...record, checksum: hash(placeholder), bytes: Buffer.byteLength(placeholder),
  }))];
  const manifest: PlayableBundleManifest = {
    format: 'novel-world-playable-bundle', spec_version: version, schema_version: 25,
    project: { id: 'project', name: '合成原型工程', revision_id: 'revision' },
    entry_point: { event_id: 'entry-event', title: '陆沉进入青石镇', narrative_ordinal: 3 },
    source_fingerprints: {
      character_cards: 'c'.repeat(64), relationship_world_info: 'd'.repeat(64), place_world_info: 'e'.repeat(64),
      character_book: bookFingerprint, bundle: bundleFingerprint,
    },
    character_count: 1, character_book_entry_count: 2, files: records,
  };
  await fs.writeFile(path.join(bundle, 'manifest.json'), json(manifest), 'utf8');
  return { bundle, output, cardPath };
}

describe('single-character skill A/B prototype', () => {
  it('uses the detached worldbook from a 2.0 bundle without rebinding the card', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-skill-detached-'));
    cleanup.push(root);
    const source = await fixture(root, '2.0');
    const result = await new CharacterSkillPrototypeService().exportFromPlayableBundle(
      source.bundle, 'identity-lu', source.output,
    );
    const baseline = JSON.parse(await fs.readFile(path.join(result.packageDirectory, 'evaluation', 'baseline-character-card.json'), 'utf8')) as TavernCardV2;
    expect(baseline.data.character_book).toBeUndefined();
    expect(result.caseCount).toBe(5);
  });

  it('exports a content-addressed valid skill package and leaves evaluation not run', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-skill-prototype-'));
    cleanup.push(root);
    const source = await fixture(root);
    const service = new CharacterSkillPrototypeService();
    const first = await service.exportFromPlayableBundle(source.bundle, 'identity-lu', source.output);
    expect(first).toMatchObject({ reused: false, caseCount: 5, skillName: expect.stringMatching(/^novel-character-[a-f0-9]{12}$/u) });
    const skill = await fs.readFile(path.join(first.skillDirectory, 'SKILL.md'), 'utf8');
    expect(skill).toMatch(/^---\nname: novel-character-[a-f0-9]{12}\ndescription: .+\n---\n/u);
    // Validate the reference layout, not an incidental word in the prose.
    // This is a packaging check, not proof of runtime retrieval or A/B quality.
    const references = [...skill.matchAll(/\]\((references\/[^)]+)\)/gu)].map((match) => match[1]);
    expect(references.sort()).toEqual(['references/entry-point.md', 'references/knowledge-index.md', 'references/profile.md']);
    for (const reference of references) {
      expect((await fs.readFile(path.join(first.skillDirectory, reference), 'utf8')).trim().length).toBeGreaterThan(0);
    }
    const baseline = JSON.parse(await fs.readFile(path.join(first.packageDirectory, 'evaluation', 'baseline-character-card.json'), 'utf8')) as TavernCardV2;
    const skillBase = JSON.parse(await fs.readFile(path.join(first.packageDirectory, 'evaluation', 'skill-base-character-card.json'), 'utf8')) as TavernCardV2;
    expect(baseline.data.character_book?.entries).toHaveLength(2);
    expect(skillBase.data.character_book).toBeUndefined();
    const plan = JSON.parse(await fs.readFile(path.join(first.packageDirectory, 'evaluation', 'ab-plan.json'), 'utf8')) as {
      evaluation_status: string; cases: Array<{ id: string; retrieval_files: string[] }>;
      thresholds: { hard_gates: { spoiler_leak_count_max: number }; promotion: { human_review_required: boolean } };
    };
    expect(plan).toMatchObject({
      evaluation_status: 'not-run',
      thresholds: { hard_gates: { spoiler_leak_count_max: 0 }, promotion: { human_review_required: true } },
    });
    expect(plan.cases.map((item) => item.id)).toEqual([
      'identity-grounding', 'voice-consistency', 'relationship-grounding', 'place-grounding', 'spoiler-boundary',
    ]);
    expect(plan.cases.find((item) => item.id === 'identity-grounding')?.retrieval_files).toEqual([]);
    expect(plan.cases.find((item) => item.id === 'relationship-grounding')?.retrieval_files).toEqual([
      `${first.skillName}/references/knowledge-index.md`,
      expect.stringMatching(/\/references\/knowledge\/relationship-[a-f0-9]{10}\.md$/u),
    ]);
    for (const reference of new Set(plan.cases.flatMap((item) => item.retrieval_files))) {
      expect((await fs.readFile(path.join(first.packageDirectory, reference), 'utf8')).trim().length).toBeGreaterThan(0);
    }
    if (!process.env.CHARACTER_SKILL_PROTOTYPE_OUTPUT) {
      await fs.writeFile(path.join(first.packageDirectory, 'user-note.txt'), 'preserve', 'utf8');
    }
    const repeated = await service.exportFromPlayableBundle(source.bundle, 'identity-lu', source.output);
    expect(repeated).toMatchObject({ reused: true, prototypeFingerprint: first.prototypeFingerprint });
    if (!process.env.CHARACTER_SKILL_PROTOTYPE_OUTPUT) {
      expect(await fs.readFile(path.join(first.packageDirectory, 'user-note.txt'), 'utf8')).toBe('preserve');
    }
    if (process.env.CHARACTER_SKILL_PROTOTYPE_OUTPUT) {
      await fs.writeFile(path.resolve(process.env.CHARACTER_SKILL_PROTOTYPE_OUTPUT, 'acceptance-result.json'), json({
        checkedAt: new Date().toISOString(), packageDirectory: first.packageDirectory, skillDirectory: first.skillDirectory,
        skillName: first.skillName, prototypeFingerprint: first.prototypeFingerprint, caseCount: first.caseCount,
        evaluationStatus: first.manifest.evaluation_status, sourceKind: 'synthetic-reviewed-v2-card',
      }), 'utf8');
    }
  });

  it('rejects a selected card whose bytes no longer match the bundle manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'character-skill-corrupt-'));
    cleanup.push(root);
    const source = await fixture(root);
    await fs.appendFile(path.join(source.bundle, ...source.cardPath.split('/')), ' ');
    await expect(new CharacterSkillPrototypeService().exportFromPlayableBundle(source.bundle, 'identity-lu', source.output))
      .rejects.toThrow('角色卡与整合包清单不一致');
  });
});
