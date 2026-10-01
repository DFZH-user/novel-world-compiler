import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  sillyTavernPlaceWorldInfoExportSchema, sillyTavernWorldInfoExportSchema, tavernCardV2Schema,
  type PlayableBundleFileRecord, type PlayableBundleManifest, type SillyTavernPlaceWorldInfoExport,
  type SillyTavernWorldInfoExport, type TavernCardV2,
} from '../../src/shared/contracts';
import { buildSessionAssemblyPlan, type SessionAssemblyPlan } from '../../src/shared/play-session-assembly';
import { compactRuntimeCharacter, type RuntimeCharacter } from '../../src/shared/runtime-character';
import { playSessionOptionsSchema, type PlaySessionOptions } from '../../src/shared/play-session-options';
import { playProfileSettings } from '../../src/shared/play-profile';
import { estimateDryRunTokens } from '../../src/shared/dry-run-context-assembler';
import type { ProjectStore } from './project-store';
import { readStartingScene } from './play-starting-scene';
import { PlaceService } from './place-service';
import { PlaceMapExportService } from './place-map-export-service';
import { RelationshipGraphExportService } from './relationship-graph-export-service';
import { StoryStateService } from './story-state-service';
import { SCHEMA_VERSION } from './schema';
import { PlayableBundleValidationService } from './playable-bundle-validation-service';

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Read-only preparation. A plan becomes playable only after import and verified chat binding. */
export class PlaySessionPreparationService {
  constructor(private readonly validation: PlayableBundleValidationService, private readonly store?: ProjectStore) {}

  async prepare(packageDirectory: string, requested?: PlaySessionOptions): Promise<SessionAssemblyPlan> {
    const profile = playSessionOptionsSchema.parse(requested ?? { mode: 'narrator', persona: { name: '旅人', description: '' } }).playProfile ?? 'medium';
    const report = await this.validation.validate(packageDirectory);
    if (!report.valid || !report.currentProjectMatch || !report.manifest) {
      const reason = report.issues.find(issue => issue.severity === 'error')?.message
        ?? report.issues.find(issue => issue.code === 'current-project-mismatch')?.message
        ?? '整合包未通过当前工程的严格校验。';
      throw new Error(`不能准备游玩会话：${reason}`);
    }
    const root = await fs.realpath(report.packageDirectory);
    const readAsset = async (kind: PlayableBundleFileRecord['kind'], identityId?: string): Promise<unknown> => {
      const record = report.manifest!.files.find(file => file.kind === kind && (!identityId || file.identityId === identityId));
      if (!record) throw new Error(`整合包缺少 ${kind}。`);
      const target = path.resolve(root, ...record.path.split('/'));
      if (!contained(root, target)) throw new Error(`整合包文件越界：${kind}。`);
      const realTarget = await fs.realpath(target);
      if (!contained(root, realTarget) || !(await fs.stat(realTarget)).isFile()) {
        throw new Error(`整合包文件位置不安全：${kind}。`);
      }
      const content = await fs.readFile(realTarget);
      if (content.byteLength !== record.bytes
        || createHash('sha256').update(content).digest('hex') !== record.checksum) {
        throw new Error(`整合包文件在校验后发生变化：${kind}。`);
      }
      return JSON.parse(content.toString('utf8')) as unknown;
    };
    const relationships = sillyTavernWorldInfoExportSchema.parse(await readAsset('relationship-world-info'));
    const places = sillyTavernPlaceWorldInfoExportSchema.parse(await readAsset('place-world-info'));
    const characters: RuntimeCharacter[] = [];
    for (const file of report.manifest.files.filter(file => file.kind === 'character-card')) {
      if (!file.identityId) throw new Error('人物卡缺少身份标识。');
      characters.push(compactRuntimeCharacter(file.identityId, tavernCardV2Schema.parse(await readAsset('character-card', file.identityId)), profile));
    }
    return this.finalize(report.manifest, relationships, places, characters, requested);
  }

  /** Assemble another confirmed event from reviewed source data without changing saved drafts or exports. */
  prepareLive(entryEventId: string, requested?: PlaySessionOptions): SessionAssemblyPlan {
    const profile = playSessionOptionsSchema.parse(requested ?? { mode: 'narrator', persona: { name: '旅人', description: '' } }).playProfile ?? 'medium';
    if (!this.store) throw new Error('当前工程不可用，无法选择其他进入时间。');
    const project = this.store.getSummary();
    if (!project?.activeRevisionId) throw new Error('请先导入并确认小说工程。');
    const state = new StoryStateService(this.store).snapshot(entryEventId, undefined, 'public-entry');
    const ordinal = state.entryNarrativeOrdinal;
    const relationships = new RelationshipGraphExportService(this.store).buildWorldInfo(ordinal);
    const places = new PlaceMapExportService(this.store).buildWorldInfo(ordinal);
    // A later canonical name must not identify someone before that name appears in the story.
    const namedBeforeEntry = new Set((this.store.get().db.prepare(`
      SELECT DISTINCT i.id
      FROM person_identities i
      JOIN person_mentions m ON m.identity_id = i.id AND m.revision_id = i.revision_id
      JOIN paragraphs p ON p.id = m.paragraph_id AND p.revision_id = i.revision_id
      WHERE i.revision_id = ? AND m.surface_text = i.canonical_name
        AND m.alignment_status IN ('exact', 'normalized') AND p.ordinal <= ?
    `).all(project.activeRevisionId, ordinal) as Array<{ id: string }>).map(row => row.id));
    const eligible = state.characters.filter(character =>
      (character.importanceTier === 'core' || character.importanceTier === 'important')
      && character.values.length > 0 && namedBeforeEntry.has(character.identityId));
    const characters = eligible.map(character => {
      const lines = character.values.slice(0, profile === 'high' ? 90 : 45).map(value =>
        `${value.predicate}：${value.value ?? `尚未确认${value.alternatives.length ? `（可能为 ${value.alternatives.join(' / ')}）` : ''}`}`);
      const source: TavernCardV2 = {
        spec: 'chara_card_v2', spec_version: '2.0',
        data: {
          name: character.identityName,
          description: `【当时已揭示资料】\n${lines.join('\n')}`,
          personality: '',
          scenario: `故事从“${state.entryEventTitle}”（原文段落 ${ordinal}）进入。`,
          first_mes: `*故事从“${state.entryEventTitle}”这一时刻展开。*`,
          mes_example: '', creator_notes: '从当前进入段落之前有依据的已确认公开事实离线生成；缺失或不确定内容保持未知。',
          system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: ['小说世界', '当时状态'],
          creator: '小说世界编译器', character_version: 'live-entry.v1',
          extensions: { novel_world_compiler: { schema_version: SCHEMA_VERSION, revision_id: project.activeRevisionId,
            identity_id: character.identityId, entry_event_id: entryEventId } },
        },
      };
      return compactRuntimeCharacter(character.identityId, source, profile);
    });
    const relationFingerprint = relationships.extensions.novel_world_compiler.graph_source_fingerprint;
    const placeFingerprint = places.extensions.novel_world_compiler.map_source_fingerprint;
    const characterFingerprint = createHash('sha256').update(JSON.stringify(eligible)).digest('hex');
    const bundleFingerprint = createHash('sha256').update(JSON.stringify({ policy: 'live-entry.v1',
      project: project.id, revision: project.activeRevisionId, event: entryEventId, ordinal,
      relationFingerprint, placeFingerprint, characterFingerprint })).digest('hex');
    const manifest: PlayableBundleManifest = {
      format: 'novel-world-playable-bundle', spec_version: '2.0', schema_version: SCHEMA_VERSION,
      project: { id: project.id, name: project.name, revision_id: project.activeRevisionId },
      entry_point: { event_id: entryEventId, title: state.entryEventTitle, narrative_ordinal: ordinal },
      source_fingerprints: { character_cards: characterFingerprint, relationship_world_info: relationFingerprint,
        place_world_info: placeFingerprint, character_book: '', bundle: bundleFingerprint },
      character_count: characters.length, character_book_entry_count: 0, files: [],
    };
    return this.finalize(manifest, relationships, places, characters, requested);
  }

  private finalize(manifest: PlayableBundleManifest, relationships: SillyTavernWorldInfoExport,
    places: SillyTavernPlaceWorldInfoExport, characters: RuntimeCharacter[], requested?: PlaySessionOptions): SessionAssemblyPlan {
    const plan = buildSessionAssemblyPlan(manifest, relationships, places);
    const options = playSessionOptionsSchema.parse(requested ?? { mode: 'narrator', persona: { name: '旅人', description: '' } });
    const profile = options.playProfile ?? 'medium';
    options.playProfile = profile;
    plan.sessionWorldBook.token_budget = playProfileSettings(profile).worldTokenBudget;
    if (options.entryEventId && options.entryEventId !== manifest.entry_point.event_id) throw new Error('所选进入时间与游玩资料不一致，请重新选择。');
    if (options.mode === 'narrator') delete options.characterId;
    const selected = options.mode === 'character' ? characters.find(item => item.identityId === options.characterId) : undefined;
    if (options.mode === 'character' && !selected) throw new Error('请从本书选择 AI 扮演的人物。');
    const player = options.persona.identityId ? characters.find(item => item.identityId === options.persona.identityId) : undefined;
    if (options.persona.identityId && !player) throw new Error('所选玩家人物不属于本书。');
    if (selected && (selected.identityId === player?.identityId || selected.name === options.persona.name)) {
      throw new Error('同一人物不能同时由你和 AI 扮演，请更换身份或切回旁白模式。');
    }
    if (player) options.persona = { ...options.persona, name: player.name,
      description: [player.card.data.description, player.card.data.personality].join('\n') };
    if (selected) plan.narratorCard = selected.card;
    const availablePlaces = this.store ? new PlaceService(this.store)
      .getNarrativeMapProjection(manifest.entry_point.narrative_ordinal).nodes
      .map(place => ({ id: place.id, name: place.name })) : [];
    const chosenLocation = options.startingPlaceId
      ? availablePlaces.find(place => place.id === options.startingPlaceId) : undefined;
    if (options.startingPlaceId && !chosenLocation) throw new Error('所选地点不属于当前已揭示的本书地点。');
    const startingScene = this.store ? readStartingScene(this.store, manifest.entry_point.event_id,
      manifest.entry_point.narrative_ordinal) : undefined;
    if (startingScene && chosenLocation) startingScene.chosenLocation = chosenLocation;
    if (chosenLocation) {
      const cue = `玩家选择从“${chosenLocation.name}”开始当前游玩分支。此处只是玩家的入场选择，不证明原著事件发生在这里；未确认的地理关系保持未知。`;
      plan.narratorCard.data.scenario = `${plan.narratorCard.data.scenario}\n${cue}`;
      plan.narratorCard.data.first_mes = `*你选择从“${chosenLocation.name}”开始。请说明你的身份与第一个行动。*`;
    }
    const narratorText = [plan.narratorCard.data.description, plan.narratorCard.data.personality,
      plan.narratorCard.data.scenario, plan.narratorCard.data.mes_example, plan.narratorCard.data.system_prompt].join('\n');
    const narratorChars = narratorText.length;
    const variant = createHash('sha256').update(JSON.stringify({ policy: 'runtime-character.v3-bound-names', options, startingScene })).digest('hex').slice(0, 20);
    plan.resourceKey += `:runtime-v1:${variant}`;
    const identityOptions = { ...options };
    delete identityOptions.entryEventId; // The event is already part of the stable key.
    const identity = createHash('sha256').update(JSON.stringify({ project: manifest.project.id,
      revision: manifest.project.revision_id, entry: manifest.entry_point.event_id,
      options: { ...identityOptions, persona: options.persona.identityId ? { identityId: options.persona.identityId } : options.persona },
    })).digest('hex');
    plan.updateKey = `managed-session.v2:${identity}`;
    plan.options = options;
    const marker = { ...plan.sessionWorldBook.extensions.novel_world_compiler, resource_key: plan.resourceKey };
    plan.sessionWorldBook.extensions.novel_world_compiler = marker;
    plan.narratorCard.data.extensions.novel_world_compiler = marker;
    let uid = Object.keys(plan.sessionWorldBook.entries).length;
    for (const character of characters) {
      if (character.identityId === player?.identityId || character.identityId === selected?.identityId) continue;
      plan.sessionWorldBook.entries[String(uid)] = {
        uid, displayIndex: uid, key: [character.name], keysecondary: [],
        content: `在场人物资料：${character.name}\n${character.card.data.description}\n${character.card.data.personality}`,
        comment: `${character.name} · 精简运行档案`, constant: false, selective: false, selectiveLogic: 0,
        order: 120, position: 0, disable: false, excludeRecursion: true, preventRecursion: true,
        ignoreBudget: false, probability: 100, useProbability: false, scanDepth: 2, matchWholeWords: false, caseSensitive: false,
      };
      uid += 1;
    }
    for (const character of characters) {
      for (const detail of character.details) {
        plan.sessionWorldBook.entries[String(uid)] = {
          uid, displayIndex: uid, key: [character.name], keysecondary: [detail.topic],
          content: `人物明细：${character.name}\n${detail.content}`,
          comment: `${character.name} · ${detail.topic} · 按需明细`,
          constant: false, selective: true, selectiveLogic: 0, order: 160, position: 0,
          disable: false, excludeRecursion: true, preventRecursion: true, ignoreBudget: false,
          probability: 100, useProbability: false, scanDepth: 2, matchWholeWords: false, caseSensitive: false,
        };
        uid += 1;
      }
    }
    for (const entry of Object.values(plan.sessionWorldBook.entries)) {
      Object.assign(entry, { excludeRecursion: true, preventRecursion: true, ignoreBudget: false, scanDepth: 2, matchWholeWords: false });
    }
    const ruleKinshipPairCount = this.store ? Number((this.store.get().db.prepare(`SELECT COUNT(DISTINCT source_identity_id || ':' || target_identity_id || ':' || relationship_type) AS value
      FROM character_relationships WHERE revision_id = ? AND review_status = 'confirmed'
        AND extraction_method = 'rule' AND relationship_type IN ('父子/父女', '母子/母女', '兄弟', '姐妹', '夫妻')
        AND first_revealed_ordinal <= ?`).get(manifest.project.revision_id, manifest.entry_point.narrative_ordinal) as { value: number }).value) : 0;
    plan.preview = {
      startingScene,
      projectId: manifest.project.id, projectName: manifest.project.name,
      entryEventId: manifest.entry_point.event_id,
      entryTitle: manifest.entry_point.title, entryOrdinal: manifest.entry_point.narrative_ordinal,
      worldEntryCount: uid, worldTokenBudget: plan.sessionWorldBook.token_budget, narratorChars, ruleKinshipPairCount,
      narratorEstimatedTokens: estimateDryRunTokens(narratorText), playProfile: profile,
      availablePlaces,
      characters: characters.map(item => ({ identityId: item.identityId, name: item.name, sourceChars: item.sourceChars,
        runtimeChars: item.runtimeChars,
        runtimeEstimatedTokens: estimateDryRunTokens([item.card.data.description, item.card.data.personality,
          item.card.data.scenario, item.card.data.mes_example, item.card.data.system_prompt].join('\n')),
        personaDescription: [item.card.data.description, item.card.data.personality].join('\n') })),
    };
    return plan;
  }
}
