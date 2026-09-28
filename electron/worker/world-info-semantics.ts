import type { SillyTavernPlaceWorldInfoEntry, SillyTavernWorldInfoEntry, TavernCharacterBookEntry } from '../../src/shared/contracts';

export const WORLD_INFO_TRUTH_LABELS = {
  asserted: '已证实', suspected: '疑似', disputed: '有争议', false: '已否定', unknown: '未知', rumor: '传闻',
} as const;

export type WorldInfoSourceEntry = SillyTavernWorldInfoEntry | SillyTavernPlaceWorldInfoEntry;

export function worldInfoMatchesContext(extension: Record<string, unknown>, expected: {
  projectId: string; revisionId: string; entryOrdinal: number; schemaVersion: number;
}): boolean {
  return extension.project_id === expected.projectId && extension.revision_id === expected.revisionId
    && extension.entry_ordinal === expected.entryOrdinal && extension.schema_version === expected.schemaVersion;
}

/** Keep the generated embedded entry identical to the source worldbook on read-back. */
export function embeddedWorldInfoEntry(source: WorldInfoSourceEntry, sourceBook: 'relationship' | 'place', id: number): TavernCharacterBookEntry {
  return {
    keys: [...source.key],
    content: source.content,
    extensions: { novel_world_compiler: { ...source.extensions.novel_world_compiler, source_book: sourceBook } },
    enabled: !source.disable,
    insertion_order: source.order,
    case_sensitive: source.caseSensitive ?? false,
    name: source.comment,
    id,
    comment: source.comment,
    selective: source.selective,
    secondary_keys: [...source.keysecondary],
    constant: source.constant,
    position: source.position === 0 ? 'before_char' : 'after_char',
  };
}
