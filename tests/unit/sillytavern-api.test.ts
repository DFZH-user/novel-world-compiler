import { describe, expect, it, vi } from 'vitest';
import { SillyTavernApi } from '../../electron/main/sillytavern-api';
import type { TavernCardV2 } from '../../src/shared/contracts';
import type { SessionWorldBook } from '../../src/shared/play-session-assembly';

describe('bundled SillyTavern HTTP adapter', () => {
  it('refuses remote hosts and URL credentials', () => {
    expect(() => new SillyTavernApi('https://example.com/')).toThrow('只允许连接本机');
    expect(() => new SillyTavernApi('http://user:pass@127.0.0.1:8000/')).toThrow('只允许连接本机');
  });

  it('uses one CSRF session, imports detached resources without overwrite flags, and binds metadata in a new chat', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      calls.push({ url, init });
      const payload = url.endsWith('/csrf-token') ? { token: 'test-token' }
        : url.endsWith('/api/worldinfo/import') ? { name: 'novel-world-book' }
          : url.endsWith('/api/characters/import') ? { file_name: 'Novel Narrator' }
            : url.endsWith('/api/chats/save') ? { ok: true } : [];
      return new Response(JSON.stringify(payload), {
        status: 200, headers: url.endsWith('/csrf-token') ? { 'set-cookie': 'sid=test-session; Path=/' } : {},
      });
    }) as typeof fetch;
    const api = new SillyTavernApi('http://127.0.0.1:8765/', request);
    await api.importWorld('novel-world-book', { name: '独立世界', entries: {} } as SessionWorldBook);
    await api.importCharacter({ spec: 'chara_card_v2', data: { name: '世界旁白' } } as TavernCardV2);
    await api.saveNewChat('Novel Narrator.png', 'novel-world-chat', [
      { chat_metadata: { world_info: 'novel-world-book' }, user_name: 'unused', character_name: 'unused' },
    ]);

    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      '/csrf-token', '/api/worldinfo/import', '/api/characters/import', '/api/chats/save',
    ]);
    for (const call of calls.slice(1)) {
      expect(call.init?.headers).toMatchObject({ 'x-csrf-token': 'test-token', cookie: 'sid=test-session' });
    }
    const worldForm = calls[1].init?.body as FormData;
    expect((worldForm.get('avatar') as File).name).toBe('novel-world-book.json');
    const cardForm = calls[2].init?.body as FormData;
    expect(cardForm.get('file_type')).toBe('json');
    expect(cardForm.has('preserved_name')).toBe(false);
    expect(JSON.parse(String(calls[3].init?.body))).toMatchObject({
      avatar_url: 'Novel Narrator.png', file_name: 'novel-world-chat',
      chat: [{ chat_metadata: { world_info: 'novel-world-book' } }],
    });
  });

  it('does not treat an HTTP failure or an error payload as a successful import', async () => {
    const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    const denied = new SillyTavernApi('http://127.0.0.1:8765/', vi.fn()
      .mockResolvedValueOnce(response({ token: 't' }))
      .mockResolvedValueOnce(response({ error: true }, 200)) as typeof fetch);
    await expect(denied.listWorlds()).rejects.toThrow('返回失败');
    const unavailable = new SillyTavernApi('http://127.0.0.1:8765/', vi.fn()
      .mockResolvedValueOnce(response({ token: 't' }))
      .mockResolvedValueOnce(response({}, 500)) as typeof fetch);
    await expect(unavailable.listCharacters()).rejects.toThrow('HTTP 500');
  });
});
