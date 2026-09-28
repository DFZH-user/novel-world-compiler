import { describe, expect, it } from 'vitest';
import { SillyTavernAssembly } from '../../electron/main/sillytavern-assembly';
import type { SillyTavernApi, TavernChatRow, TavernCharacterSummary } from '../../electron/main/sillytavern-api';
import type { SessionAssemblyPlan, SessionWorldBook } from '../../src/shared/play-session-assembly';
import type { TavernCardV2 } from '../../src/shared/contracts';

function plan(bundle: string): SessionAssemblyPlan {
  const marker = { project_id: 'project', revision_id: 'revision', bundle_fingerprint: bundle };
  return {
    resourceKey: `project:revision:${bundle}`,
    sessionWorldBook: { name: '本书世界', extensions: { novel_world_compiler: marker }, entries: {} } as SessionWorldBook,
    narratorCard: { spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: '世界旁白', description: '', personality: '', scenario: '', first_mes: '',
      mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '',
      alternate_greetings: [], tags: [], creator: '', character_version: 'test',
      extensions: { novel_world_compiler: marker },
    } } as TavernCardV2,
  };
}

class MemoryTavern {
  readonly worlds = new Map<string, SessionWorldBook>();
  readonly cards = new Map<string, TavernCardV2>();
  readonly chats = new Map<string, TavernChatRow[]>();
  imports = { world: 0, card: 0, chat: 0 };
  failCardOnce = false;

  listWorlds = async () => [...this.worlds].map(([file_id, book]) => ({
    file_id, name: book.name, extensions: book.extensions,
  }));
  getWorld = async (name: string) => this.worlds.get(name) ?? null;
  importWorld = async (name: string, book: SessionWorldBook) => {
    if (this.worlds.has(name)) throw new Error('world overwritten');
    this.worlds.set(name, structuredClone(book)); this.imports.world += 1;
    return { name };
  };
  listCharacters = async (): Promise<TavernCharacterSummary[]> =>
    [...this.cards].map(([avatar, card]) => ({ avatar, name: card.data.name }));
  getCharacter = async (avatar: string) => {
    const card = this.cards.get(avatar);
    if (!card) throw new Error('missing card');
    return { avatar, name: card.data.name, data: structuredClone(card.data) };
  };
  importCharacter = async (card: TavernCardV2) => {
    if (this.failCardOnce) { this.failCardOnce = false; throw new Error('simulated import failure'); }
    const file_name = `narrator-${this.cards.size + 1}`;
    this.cards.set(`${file_name}.png`, structuredClone(card)); this.imports.card += 1;
    return { file_name };
  };
  listChats = async (avatar: string) => [...this.chats.keys()]
    .filter(key => key.startsWith(`${avatar}/`)).map(key => ({ file_name: key.slice(avatar.length + 1) }));
  getChat = async (avatar: string, name: string) => this.chats.get(`${avatar}/${name}`) ?? {};
  saveNewChat = async (avatar: string, name: string, rows: TavernChatRow[]) => {
    const key = `${avatar}/${name}`;
    if (this.chats.has(key)) throw new Error('chat overwritten');
    this.chats.set(key, structuredClone(rows)); this.imports.chat += 1;
    return { ok: true };
  };
}

describe('one-click SillyTavern assembly', () => {
  it('retries partial imports, reuses edited resources, and isolates a new bundle', async () => {
    const memory = new MemoryTavern();
    const assembly = new SillyTavernAssembly(memory as unknown as SillyTavernApi);
    memory.failCardOnce = true;
    await expect(assembly.assemble(plan('a'.repeat(64)))).rejects.toThrow('simulated');
    expect(memory.imports).toEqual({ world: 1, card: 0, chat: 0 });

    const first = await assembly.assemble(plan('a'.repeat(64)));
    expect(memory.imports).toEqual({ world: 1, card: 1, chat: 1 });
    const firstWorld = memory.worlds.get(first.worldId)!;
    firstWorld.description = '用户手工补充的世界描述';
    const firstCard = memory.cards.get(first.avatar)!;
    firstCard.data.personality = '用户手工改过的旁白语气';
    expect(await assembly.assemble(plan('a'.repeat(64)))).toEqual(first);
    expect(memory.imports).toEqual({ world: 1, card: 1, chat: 1 });
    expect(memory.worlds.get(first.worldId)?.description).toBe('用户手工补充的世界描述');
    expect(memory.cards.get(first.avatar)?.data.personality).toBe('用户手工改过的旁白语气');

    const second = await assembly.assemble(plan('b'.repeat(64)));
    expect(second.worldId).not.toBe(first.worldId);
    expect(second.avatar).not.toBe(first.avatar);
    expect(second.chatFile).not.toBe(first.chatFile);
    expect(memory.imports).toEqual({ world: 2, card: 2, chat: 2 });
    expect((memory.chats.get(`${second.avatar}/${second.chatFile}`)?.[0].chat_metadata as { world_info: string }).world_info)
      .toBe(second.worldId);
  });

  it('never overwrites an existing chat or a manually changed chat worldbook', async () => {
    const memory = new MemoryTavern();
    const assembly = new SillyTavernAssembly(memory as unknown as SillyTavernApi);
    const source = plan('c'.repeat(64));
    const first = await assembly.assemble(source);
    const chatKey = `${first.avatar}/${first.chatFile}`;
    memory.chats.set(chatKey, [{ chat_metadata: { world_info: 'other-world',
      novel_world_compiler: { resource_key: source.resourceKey } } }]);
    await expect(assembly.assemble(source)).rejects.toThrow('不会覆盖你的改动');
    expect(memory.imports.chat).toBe(1);

    memory.chats.set(chatKey, [{ chat_metadata: { world_info: 'unrelated' } }]);
    const recovered = await assembly.assemble(source);
    expect(recovered.chatFile).not.toBe(first.chatFile);
    expect(memory.imports.chat).toBe(2);
    expect(memory.chats.get(chatKey)?.[0].chat_metadata).toEqual({ world_info: 'unrelated' });
  });
});
