import { ManagedSessionUpdate } from './managed-session-update';
import { createHash, randomUUID } from 'node:crypto';
import { reconcileManagedResource, type ManagedResource } from '../../src/shared/managed-resource-reconciliation';
import type { SessionAssemblyPlan } from '../../src/shared/play-session-assembly';
import { SillyTavernApi, type TavernCharacterSummary, type TavernChatRow } from './sillytavern-api';

export type TavernSessionHandle = {
  resourceKey: string;
  avatar: string;
  worldId: string;
  chatFile: string;
  updateNotice?: string;
};

function ownedKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const marker = (value as { extensions?: { novel_world_compiler?: Record<string, unknown> } })
    .extensions?.novel_world_compiler;
  if (typeof marker?.resource_key === 'string') return marker.resource_key;
  const project = marker?.project_id, revision = marker?.revision_id, bundle = marker?.bundle_fingerprint;
  return typeof project === 'string' && typeof revision === 'string' && typeof bundle === 'string'
    ? `${project}:${revision}:${bundle}` : null;
}

function chatHeader(plan: SessionAssemblyPlan, worldId: string): TavernChatRow {
  return {
    chat_metadata: {
      world_info: worldId,
      novel_world_compiler: { assembly_version: 'session-assembly.v1', resource_key: plan.resourceKey,
        world_id: worldId, world_token_budget: plan.sessionWorldBook.token_budget,
        mode: plan.options?.mode ?? 'narrator', persona: plan.options?.persona,
        starting_scene: plan.preview?.startingScene,
        project_name: plan.preview?.projectName, entry_title: plan.preview?.entryTitle,
        entry_event_id: plan.preview?.entryEventId, entry_ordinal: plan.preview?.entryOrdinal },
    },
    user_name: 'unused',
    character_name: 'unused',
  };
}

function checkOwnedChat(rows: TavernChatRow[] | Record<string, unknown>, plan: SessionAssemblyPlan, worldId: string): boolean {
  if (!Array.isArray(rows) || !rows.length) return false;
  const metadata = rows[0].chat_metadata as Record<string, unknown> | undefined;
  const marker = metadata?.novel_world_compiler as Record<string, unknown> | undefined;
  if (marker?.resource_key !== plan.resourceKey) return false;
  if (metadata?.world_info !== worldId) {
    throw new Error('此游玩会话的世界书曾被手工切换；不会覆盖你的改动。请从酒馆检查该会话。');
  }
  return true;
}

/**
 * Re-runnable assembly saga. Managed sessions retain stable resources and use
 * persisted before-images for safe updates. Legacy plans keep versioned resources.
 * Chat history is never replaced. A partial initial import is safe to retry because
 * each completed resource is rediscovered by its ownership marker.
 */
export class SillyTavernAssembly {
  private readonly pending = new Map<string, Promise<TavernSessionHandle>>();

  private readonly updates?: ManagedSessionUpdate;
  constructor(private readonly api: SillyTavernApi, updateDirectory?: string) {
    if (updateDirectory) this.updates = new ManagedSessionUpdate(api, updateDirectory);
  }

  assemble(plan: SessionAssemblyPlan): Promise<TavernSessionHandle> {
    const generation = plan.resourceKey;
    const effective = structuredClone(plan);
    if (plan.updateKey && this.updates) {
      effective.resourceKey = plan.updateKey;
      effective.sessionWorldBook.extensions.novel_world_compiler.resource_key = plan.updateKey;
      effective.narratorCard.data.extensions.novel_world_compiler = {
        ...(effective.narratorCard.data.extensions.novel_world_compiler as Record<string, unknown>), resource_key: plan.updateKey,
      };
    }
    const current = this.pending.get(effective.resourceKey);
    if (current) return current;
    const run = (async () => {
      const handle = await this.assembleInternal(effective);
      if (plan.updateKey && this.updates) {
        const updateNotice = await this.updates.apply(handle, { generation, world: effective.sessionWorldBook, card: effective.narratorCard });
        if (updateNotice) return { ...handle, updateNotice };
      }
      return handle;
    })();
    this.pending.set(effective.resourceKey, run);
    void run.finally(() => { this.pending.delete(effective.resourceKey); }).catch(() => undefined);
    return run;
  }

  private async assembleInternal(plan: SessionAssemblyPlan): Promise<TavernSessionHandle> {
    const digest = createHash('sha256').update(plan.resourceKey).digest('hex').slice(0, 20);
    const worldBase = `nw-world-${digest}`;
    const worldSummaries = await this.api.listWorlds();
    const worlds: ManagedResource[] = worldSummaries.map(world => ({
      kind: 'session-worldbook', resourceKey: ownedKey(world) ?? '', externalId: world.file_id,
    }));
    const worldDecision = reconcileManagedResource('session-worldbook', plan.resourceKey, null, worlds, worldBase);
    const worldId = worldDecision.externalId;
    if (!worldId) throw new Error('无法选择安全的世界书文件名。');
    if (worldDecision.action === 'create') {
      const imported = await this.api.importWorld(worldId, plan.sessionWorldBook);
      if (imported.name !== worldId) throw new Error('世界书导入后的文件名与预期不符。');
    }
    const actualWorld = await this.api.getWorld(worldId);
    if (ownedKey(actualWorld) !== plan.resourceKey) {
      throw new Error('世界书所有权标记不匹配；不会继续创建游玩会话。');
    }

    const summaries = await this.api.listCharacters();
    const characters: TavernCharacterSummary[] = [];
    for (const summary of summaries) {
      if (!summary.avatar) continue;
      if (ownedKey(summary.data) === plan.resourceKey) characters.push(summary);
      else if (!summary.data || summary.data.extensions === undefined) {
        characters.push(await this.api.getCharacter(summary.avatar));
      }
    }
    const existingCards: ManagedResource[] = characters.map(character => ({
      kind: 'narrator-card', resourceKey: ownedKey(character.data) ?? '', externalId: character.avatar,
    }));
    const cardDecision = reconcileManagedResource('narrator-card', plan.resourceKey, null, existingCards);
    let avatar = cardDecision.externalId;
    if (cardDecision.action === 'create') {
      const imported = await this.api.importCharacter(plan.narratorCard);
      avatar = imported.file_name.endsWith('.png') ? imported.file_name : `${imported.file_name}.png`;
    }
    if (!avatar || ownedKey((await this.api.getCharacter(avatar)).data) !== plan.resourceKey) {
      throw new Error('旁白卡导入后无法验证来源；不会创建游玩会话。');
    }
    const verifiedAvatar = avatar;

    // Recover an existing owned chat first. New chat IDs contain a random UUID
    // so even a malformed file omitted by SillyTavern's search is not overwritten.
    const chatBase = `nw-chat-${digest}`;
    const chatList = await this.api.listChats(verifiedAvatar);
    const occupied = new Set(chatList.map(chat => chat.file_name));
    let chatFile = '';
    for (const candidate of occupied) {
      if (candidate.startsWith(`${chatBase}-`)
        && checkOwnedChat(await this.api.getChat(verifiedAvatar, candidate), plan, worldId)) {
        chatFile = candidate; break;
      }
    }
    if (!chatFile) {
      const candidate = `${chatBase}-${randomUUID()}`;
      if (occupied.has(candidate)) throw new Error('新聊天文件名意外冲突；请重试。');
      const result = await this.api.saveNewChat(verifiedAvatar, candidate, [chatHeader(plan, worldId)]);
      if (!result.ok) throw new Error('酒馆没有确认新聊天已保存。');
      chatFile = candidate;
    }
    if (!chatFile || !checkOwnedChat(await this.api.getChat(verifiedAvatar, chatFile), plan, worldId)) {
      throw new Error('会话世界书绑定未能核验；沉浸阅读不可解锁。');
    }
    return { resourceKey: plan.resourceKey, avatar: verifiedAvatar, worldId, chatFile };
  }
}
