import type { SessionWorldBook } from '../../src/shared/play-session-assembly';
import type { TavernCardV2 } from '../../src/shared/contracts';

export type TavernWorldSummary = { file_id: string; name: string; extensions?: Record<string, unknown> };
export type TavernCharacterSummary = { avatar: string; name: string; data?: { extensions?: Record<string, unknown> } };
export type TavernChatRow = Record<string, unknown>;

/**
 * HTTP adapter for the bundled, loopback-only SillyTavern service.
 * Mutating methods are deliberately low-level: callers must reconcile ownership
 * before import and must never save over an existing chat.
 */
export class SillyTavernApi {
  private csrfToken: string | null = null;
  private cookie = '';
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly request: typeof fetch = fetch) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('只允许连接本机 127.0.0.1 的内置酒馆服务。');
    }
    this.baseUrl = parsed.origin;
  }

  private async authorize(): Promise<void> {
    if (this.csrfToken) return;
    const response = await this.request(`${this.baseUrl}/csrf-token`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`无法获取酒馆会话凭证（HTTP ${response.status}）。`);
    const token = (await response.json() as { token?: unknown }).token;
    if (typeof token !== 'string' || !token) throw new Error('酒馆没有返回有效的会话凭证。');
    this.csrfToken = token;
    this.cookie = response.headers.getSetCookie()
      .map(value => value.split(';', 1)[0]).filter(Boolean).join('; ');
  }

  private async post<T>(path: string, body: Record<string, unknown> | FormData): Promise<T> {
    await this.authorize();
    const multipart = body instanceof FormData;
    const response = await this.request(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'x-csrf-token': this.csrfToken!,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(!multipart ? { 'content-type': 'application/json' } : {}),
      },
      body: multipart ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`酒馆接口 ${path} 返回 HTTP ${response.status}；未确认资源已保存。`);
    const value = await response.json() as T & { error?: unknown };
    if (value && typeof value === 'object' && value.error) {
      throw new Error(`酒馆接口 ${path} 返回失败；未确认资源已保存。`);
    }
    return value;
  }

  listWorlds(): Promise<TavernWorldSummary[]> {
    return this.post('/api/worldinfo/list', {});
  }

  getWorld(name: string): Promise<Record<string, unknown> | null> {
    return this.post('/api/worldinfo/get', { name });
  }

  importWorld(fileId: string, world: SessionWorldBook): Promise<{ name: string }> {
    if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(fileId)) throw new Error('世界书文件名不安全。');
    const form = new FormData();
    form.append('avatar', new Blob([JSON.stringify(world)], { type: 'application/json' }), `${fileId}.json`);
    return this.post('/api/worldinfo/import', form);
  }

  async updateWorld(name: string, world: SessionWorldBook): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(name)) throw new Error('世界书文件名不安全。');
    const result = await this.post<{ ok: boolean }>('/api/worldinfo/edit', { name, data: world });
    if (!result.ok) throw new Error('世界书更新没有确认成功。');
  }

  async updateCharacter(avatar: string, card: TavernCardV2): Promise<void> {
    const result = await this.post<{ updated?: string[]; failed?: string[] }>('/api/characters/merge-attributes', {
      avatars: [avatar], data: { ...card.data, data: card.data },
    });
    if (!result.updated?.includes(avatar) || result.failed?.length) throw new Error('人物卡更新没有确认成功。');
  }

  listCharacters(): Promise<TavernCharacterSummary[]> {
    return this.post('/api/characters/all', {});
  }

  getCharacter(avatar: string): Promise<TavernCharacterSummary> {
    return this.post('/api/characters/get', { avatar_url: avatar });
  }

  importCharacter(card: TavernCardV2): Promise<{ file_name: string }> {
    const form = new FormData();
    form.append('avatar', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'novel-world-character.json');
    form.append('file_type', 'json');
    // Never pass preserved_name: that option overwrites an existing PNG.
    return this.post('/api/characters/import', form);
  }

  getChat(avatar: string, fileName: string): Promise<TavernChatRow[] | Record<string, unknown>> {
    return this.post('/api/chats/get', { avatar_url: avatar, file_name: fileName });
  }

  listChats(avatar: string): Promise<Array<{ file_name: string }>> {
    return this.post('/api/chats/search', { avatar_url: avatar, query: '' });
  }

  saveNewChat(avatar: string, fileName: string, rows: TavernChatRow[]): Promise<{ ok: boolean }> {
    if (!/^[a-zA-Z0-9_-]{1,96}$/u.test(fileName)) throw new Error('聊天文件名不安全。');
    if (!rows[0] || typeof rows[0].chat_metadata !== 'object') throw new Error('新聊天缺少会话元数据。');
    return this.post('/api/chats/save', { avatar_url: avatar, file_name: fileName, chat: rows });
  }
}
