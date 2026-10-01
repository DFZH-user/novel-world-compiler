import { describe, expect, it } from 'vitest';
import { buildSessionAssemblyPlan } from '../../src/shared/play-session-assembly';
import { tavernCardV2Schema } from '../../src/shared/contracts';
import type {
  PlayableBundleManifest, SillyTavernPlaceWorldInfoExport, SillyTavernWorldInfoEntry,
  SillyTavernWorldInfoExport,
} from '../../src/shared/contracts';

const fingerprint = 'a'.repeat(64);
const graphFingerprint = 'b'.repeat(64);
const mapFingerprint = 'c'.repeat(64);

function sources() {
  const manifest = {
    project: { id: 'project-1', name: '测试小说', revision_id: 'revision-1' },
    entry_point: { event_id: 'event-1', title: '故事开端', narrative_ordinal: 42 },
    source_fingerprints: { bundle: fingerprint, relationship_world_info: graphFingerprint, place_world_info: mapFingerprint },
  } as PlayableBundleManifest;
  const sample = { uid: 0, displayIndex: 0, key: ['地点'], content: '已确认的资料' } as SillyTavernWorldInfoEntry;
  const relationships = {
    name: '关系', description: '', scan_depth: 3, token_budget: 4096, recursive_scanning: false,
    entries: { '0': sample },
    extensions: { novel_world_compiler: {
      project_id: 'project-1', revision_id: 'revision-1', entry_ordinal: 42,
      graph_source_fingerprint: graphFingerprint,
    } },
  } as unknown as SillyTavernWorldInfoExport;
  const places = {
    name: '地点', description: '', scan_depth: 4, token_budget: 4096, recursive_scanning: false,
    entries: { '0': { ...sample, key: ['另一地点'] } },
    extensions: { novel_world_compiler: {
      project_id: 'project-1', revision_id: 'revision-1', entry_ordinal: 42,
      map_source_fingerprint: mapFingerprint,
    } },
  } as unknown as SillyTavernPlaceWorldInfoExport;
  return { manifest, relationships, places };
}

describe('offline play session assembly', () => {
  it('keeps independent source worldbooks and produces a compact narrator card', () => {
    const { manifest, relationships, places } = sources();
    const originalRelationship = structuredClone(relationships);
    const originalPlace = structuredClone(places);
    const plan = buildSessionAssemblyPlan(manifest, relationships, places);
    expect(Object.keys(plan.sessionWorldBook.entries)).toEqual(['0', '1']);
    expect(plan.sessionWorldBook.entries['1'].uid).toBe(1);
    expect(plan.sessionWorldBook.token_budget).toBe(2048);
    expect(plan.narratorCard.data.character_book).toBeUndefined();
    expect(tavernCardV2Schema.safeParse(plan.narratorCard).success).toBe(true);
    expect(plan.narratorCard.data.description.length + plan.narratorCard.data.system_prompt.length).toBeLessThan(450);
    expect(relationships).toEqual(originalRelationship);
    expect(places).toEqual(originalPlace);
  });

  it('rejects a worldbook from another revision or source', () => {
    const { manifest, relationships, places } = sources();
    places.extensions.novel_world_compiler.revision_id = 'revision-old';
    expect(() => buildSessionAssemblyPlan(manifest, relationships, places)).toThrow('不能装配');
  });

  it('omits redundant community summaries and merges identical relationship evidence only in the session', () => {
    const { manifest, relationships, places } = sources();
    const base = relationships.entries['0'];
    const relation = { ...base, key: ['甲', '乙', '朋友'], content: '甲与乙是朋友。',
      extensions: { novel_world_compiler: { entry_kind: 'relationship' as const,
        source_relationship_ids: ['r1'], source_evidence_ids: ['e1'] } } };
    relationships.entries = {
      '0': { ...base, key: ['甲', '乙'], content: '甲和乙所在的关系社区。',
        extensions: { novel_world_compiler: { entry_kind: 'community',
          source_relationship_ids: ['r1'], source_evidence_ids: ['e1'] } } } as SillyTavernWorldInfoEntry,
      '1': relation,
      '2': { ...relation, extensions: { novel_world_compiler: { entry_kind: 'relationship',
        source_relationship_ids: ['r2'], source_evidence_ids: ['e2'] } } },
      '3': { ...relation, content: '甲与乙也有一段争执。', extensions: { novel_world_compiler: { entry_kind: 'relationship',
        source_relationship_ids: ['r3'], source_evidence_ids: ['e3'] } } },
    } as SillyTavernWorldInfoExport['entries'];
    const original = structuredClone(relationships);
    const plan = buildSessionAssemblyPlan(manifest, relationships, places);
    const entries = Object.values(plan.sessionWorldBook.entries);
    expect(entries).toHaveLength(3); // two distinct relations and one place
    expect(entries[0].key).toEqual(['甲']);
    expect(entries[0].keysecondary).toEqual(['乙']);
    expect(entries[0].selective).toBe(true);
    expect((entries[0] as SillyTavernWorldInfoEntry).extensions.novel_world_compiler.source_relationship_ids).toEqual(['r1', 'r2']);
    expect((entries[0] as SillyTavernWorldInfoEntry).extensions.novel_world_compiler.source_evidence_ids).toEqual(['e1', 'e2']);
    expect(entries[1].content).toContain('争执');
    expect(relationships).toEqual(original);
  });
});
