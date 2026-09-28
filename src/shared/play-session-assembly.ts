import type {
  PlayableBundleManifest, SillyTavernPlaceWorldInfoEntry, SillyTavernPlaceWorldInfoExport,
  SillyTavernWorldInfoEntry, SillyTavernWorldInfoExport, TavernCardV2,
} from './contracts';
import type { PlaySessionOptions, PlaySessionPreview } from './play-session-options';

export type RuntimeWorldEntry = {
  uid: number; displayIndex: number; key: string[]; keysecondary: string[]; content: string;
  comment: string; constant: false; selective: boolean; selectiveLogic: number; order: number;
  position: number; disable: false; excludeRecursion: true; preventRecursion: true;
  ignoreBudget: false; probability: number; useProbability: false; scanDepth: number;
  matchWholeWords: false; caseSensitive: false;
};

export type SessionWorldBook = {
  name: string;
  description: string;
  scan_depth: number;
  token_budget: number;
  recursive_scanning: false;
  entries: Record<string, SillyTavernWorldInfoEntry | SillyTavernPlaceWorldInfoEntry | RuntimeWorldEntry>;
  extensions: { novel_world_compiler: {
    assembly_version: 'session-assembly.v1';
    project_id: string;
    revision_id: string;
    entry_event_id: string;
    entry_ordinal: number;
    bundle_fingerprint: string;
    relationship_source_fingerprint: string;
    place_source_fingerprint: string;
    resource_key?: string;
  } };
};

export type SessionAssemblyPlan = {
  narratorCard: TavernCardV2;
  sessionWorldBook: SessionWorldBook;
  resourceKey: string;
  updateKey?: string;
  options?: PlaySessionOptions;
  preview?: PlaySessionPreview;
};

/**
 * Pure and free of model calls. No source card or source worldbook is edited.
 * This plan is not an import transaction; it becomes playable only after import and chat binding succeed.
 */
export function buildSessionAssemblyPlan(
  manifest: PlayableBundleManifest,
  relationships: SillyTavernWorldInfoExport,
  places: SillyTavernPlaceWorldInfoExport,
): SessionAssemblyPlan {
  const projectId = manifest.project.id;
  const revisionId = manifest.project.revision_id;
  const ordinal = manifest.entry_point.narrative_ordinal;
  const relationMeta = relationships.extensions.novel_world_compiler;
  const placeMeta = places.extensions.novel_world_compiler;
  if (relationMeta.project_id !== projectId || placeMeta.project_id !== projectId
    || relationMeta.revision_id !== revisionId || placeMeta.revision_id !== revisionId
    || relationMeta.entry_ordinal !== ordinal || placeMeta.entry_ordinal !== ordinal
    || relationMeta.graph_source_fingerprint !== manifest.source_fingerprints.relationship_world_info
    || placeMeta.map_source_fingerprint !== manifest.source_fingerprints.place_world_info) {
    throw new Error('世界书与整合包的工程、修订、进入点或来源不一致，不能装配。');
  }
  const fingerprint = manifest.source_fingerprints.bundle;
  const resourceKey = `${projectId}:${revisionId}:${fingerprint}`;
  const entries: SessionWorldBook['entries'] = {};
  let uid = 0;
  for (const source of [relationships.entries, places.entries]) {
    for (const entry of Object.values(source)) {
      entries[String(uid)] = { ...entry, uid, displayIndex: uid };
      uid += 1;
    }
  }
  const sessionWorldBook: SessionWorldBook = {
    name: `${manifest.project.name} · 当前游玩世界 P${ordinal}`,
    description: '只在本书当前游玩会话使用。人物关系、地点与空间事实按关键词触发；位置排版不代表真实地理。',
    scan_depth: Math.max(relationships.scan_depth, places.scan_depth),
    token_budget: Math.max(512, Math.min(2048, relationships.token_budget + places.token_budget)),
    recursive_scanning: false,
    entries,
    extensions: { novel_world_compiler: {
      assembly_version: 'session-assembly.v1',
      project_id: projectId, revision_id: revisionId,
      entry_event_id: manifest.entry_point.event_id, entry_ordinal: ordinal,
      bundle_fingerprint: fingerprint,
      relationship_source_fingerprint: relationMeta.graph_source_fingerprint,
      place_source_fingerprint: placeMeta.map_source_fingerprint,
    } },
  };
  const narratorCard: TavernCardV2 = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: `${manifest.project.name} · 世界旁白`,
      description: '你是这本小说世界的旁白与主持者，叙述环境、在场人物的言行，以及玩家行动的合理结果。你不是玩家本人。',
      personality: '叙事清晰、生动、克制；人物言行符合其已揭示的性格、处境与知识范围。',
      scenario: `故事从“${manifest.entry_point.title}”（原文段落 ${ordinal}）进入。{{user}}以自选身份参与故事。`,
      first_mes: `*故事从“${manifest.entry_point.title}”这一时刻展开。你可以说明自己的身份与第一个行动。*`,
      mes_example: '',
      creator_notes: '程序离线派生的精简旁白运行卡；完整人物资料和原文证据仍留在小说工程中。',
      system_prompt: '作为世界旁白，描述场景、在场人物和玩家行动的后果。不要替 {{user}} 决定想法、言语或行动。只使用当前故事时间点已揭示且有依据的设定；未确认事实保持不确定，不提前透露后续情节。需要扮演人物时遵守该人物当时的目标、能力和知情边界。',
      post_history_instructions: '',
      alternate_greetings: [], tags: ['小说世界', '旁白模式'], creator: '小说世界编译器',
      character_version: 'session-assembly.v1',
      extensions: { novel_world_compiler: {
        assembly_version: 'session-assembly.v1', project_id: projectId, revision_id: revisionId,
        entry_event_id: manifest.entry_point.event_id, bundle_fingerprint: fingerprint,
      } },
    },
  };
  return { narratorCard, sessionWorldBook, resourceKey };
}
