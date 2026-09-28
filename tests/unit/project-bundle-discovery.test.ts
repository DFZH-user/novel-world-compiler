import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectProjectBundle, listProjectPlayableEntries } from '../../electron/main/project-bundle-discovery';
import {
  CHARACTER_GRAPH_SPEC_VERSION, NARRATIVE_MAP_SPEC_VERSION,
  type PlayableBundleFileRecord, type ProjectSummary,
} from '../../src/shared/contracts';

const temporaryRoots: string[] = [];
const zeros = '0'.repeat(64);

async function project(): Promise<ProjectSummary> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'nw-bundle-test-'));
  temporaryRoots.push(rootPath);
  return { id: 'project-1', name: '测试小说', rootPath, createdAt: '', updatedAt: '', activeRevisionId: 'revision-1' };
}

async function writeBundle(projectSummary: ProjectSummary, eventId = 'event-1'): Promise<string> {
  const directory = path.join(projectSummary.rootPath, 'exports', `test-bundle-${eventId}`);
  await fs.mkdir(directory, { recursive: true });
  const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: '人物', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
    creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [],
    tags: [], creator: '', character_version: '', extensions: {},
  } };
  const common = { name: '测试', description: '', scan_depth: 1, token_budget: 100, recursive_scanning: false, entries: {} };
  const relationship = { ...common, extensions: { novel_world_compiler: {
    character_graph_spec_version: CHARACTER_GRAPH_SPEC_VERSION, schema_version: 1, project_id: projectSummary.id,
    revision_id: projectSummary.activeRevisionId, entry_ordinal: 1, graph_source_fingerprint: zeros,
  } } };
  const place = { ...common, extensions: { novel_world_compiler: {
    narrative_map_spec_version: NARRATIVE_MAP_SPEC_VERSION, schema_version: 1, project_id: projectSummary.id,
    revision_id: projectSummary.activeRevisionId, entry_ordinal: 1, map_source_fingerprint: zeros,
    coordinate_semantics: 'topology-only',
  } } };
  const assets: Array<{ file: string; kind: PlayableBundleFileRecord['kind']; value: unknown }> = [
    { file: 'cards/character.json', kind: 'character-card', value: card },
    { file: 'worldbooks/character-book.json', kind: 'character-book', value: { extensions: {}, entries: [] } },
    { file: 'worldbooks/relationships.json', kind: 'relationship-world-info', value: relationship },
    { file: 'worldbooks/places.json', kind: 'place-world-info', value: place },
    { file: 'entry-point.json', kind: 'entry-point', value: { format: 'novel-world-entry-point', spec_version: '2.0' } },
  ];
  const files: PlayableBundleFileRecord[] = [];
  for (const asset of assets) {
    const content = JSON.stringify(asset.value) + '\n';
    const absolute = path.join(directory, ...asset.file.split('/'));
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
    files.push({ path: asset.file, kind: asset.kind, bytes: Buffer.byteLength(content), checksum: createHash('sha256').update(content).digest('hex') });
  }
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    format: 'novel-world-playable-bundle', spec_version: '2.0', schema_version: 1,
    project: { id: projectSummary.id, name: projectSummary.name, revision_id: projectSummary.activeRevisionId },
    entry_point: { event_id: eventId, title: eventId === 'event-1' ? '开场' : '另一时刻', narrative_ordinal: 1 },
    source_fingerprints: { character_cards: zeros, relationship_world_info: zeros,
      place_world_info: zeros, character_book: zeros, bundle: zeros },
    character_count: 1, character_book_entry_count: 0, files,
  }));
  return directory;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const resolved = path.resolve(root);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('nw-bundle-test-')) throw new Error('Unsafe test cleanup target');
    await fs.rm(resolved, { recursive: true, force: true });
  }
});

describe('project bundle discovery', () => {
  it('does not treat a project without source or export as playable', async () => {
    const summary = await project();
    expect((await inspectProjectBundle({ ...summary, activeRevisionId: null })).state).toBe('no-source');
    expect((await inspectProjectBundle(summary)).state).toBe('not-exported');
  });

  it('recognizes matching assets and refuses tampered files', async () => {
    const summary = await project();
    const directory = await writeBundle(summary);
    expect((await inspectProjectBundle(summary)).state).toBe('ready-for-assembly');
    await fs.writeFile(path.join(directory, 'cards', 'character.json'), '{}\n');
    expect((await inspectProjectBundle(summary)).state).toBe('invalid');
  });

  it('lists only verified entry choices and selects the requested event', async () => {
    const summary = await project();
    const first = await writeBundle(summary, 'event-1');
    const second = await writeBundle(summary, 'event-2');
    expect((await listProjectPlayableEntries(summary)).map(item => item.eventId)).toEqual(['event-1', 'event-2']);
    expect((await inspectProjectBundle(summary, 'event-1')).packageDirectory).toBe(await fs.realpath(first));
    await fs.writeFile(path.join(second, 'cards', 'character.json'), '{}\n');
    expect((await listProjectPlayableEntries(summary)).map(item => item.eventId)).toEqual(['event-1']);
  });

  it('does not accept an older revision as the current book', async () => {
    const summary = await project();
    await writeBundle(summary);
    expect((await inspectProjectBundle({ ...summary, activeRevisionId: 'revision-2' })).state).toBe('not-exported');
  });
});
