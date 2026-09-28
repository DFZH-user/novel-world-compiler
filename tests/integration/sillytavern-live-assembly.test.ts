import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SillyTavernApi } from '../../electron/main/sillytavern-api';
import { SillyTavernAssembly } from '../../electron/main/sillytavern-assembly';
import type { SessionAssemblyPlan, SessionWorldBook } from '../../src/shared/play-session-assembly';
import type { TavernCardV2 } from '../../src/shared/contracts';

const sourceRoot = process.env.NW_REAL_ST_ROOT;
const nodeBinary = process.env.NW_REAL_ST_NODE ?? process.execPath;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No TCP port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}

function makePlan(bundle: string, project = 'isolated-test'): SessionAssemblyPlan {
  const marker = {
    assembly_version: 'session-assembly.v1', project_id: project,
    revision_id: 'test-revision', bundle_fingerprint: bundle,
  };
  const world: SessionWorldBook = {
    name: '隔离测试世界', description: '仅供临时验收', scan_depth: 2,
    token_budget: 512, recursive_scanning: false, entries: {},
    extensions: { novel_world_compiler: marker },
  } as SessionWorldBook;
  const card: TavernCardV2 = {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: '隔离测试旁白', description: '描述当前世界。', personality: '清晰、克制。',
      scenario: '测试场景。', first_mes: '故事开始。', mes_example: '',
      creator_notes: '离线测试卡', system_prompt: '你是旁白。', post_history_instructions: '',
      alternate_greetings: [], tags: ['test'], creator: 'novel-world-test',
      character_version: '1', extensions: { novel_world_compiler: marker },
    },
  };
  return { resourceKey: `${project}:test-revision:${bundle}`, narratorCard: card, sessionWorldBook: world };
}

describe.runIf(Boolean(sourceRoot))('temporary real SillyTavern session assembly', () => {
  it('imports, binds and reuses without touching a normal user profile', async () => {
    const runtime = path.resolve(sourceRoot!);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-st-isolated-'));
    const dataRoot = path.join(tempRoot, 'data');
    const configPath = path.join(tempRoot, 'config.yaml');
    let child: ChildProcess | null = null;
    let logs = '';
    try {
      await fs.cp(path.join(runtime, 'initial-data'), dataRoot, { recursive: true });
      await fs.copyFile(path.join(runtime, 'config.yaml'), configPath);
      const port = await freePort();
      child = spawn(nodeBinary, [
        path.join(runtime, 'server.js'), '--dataRoot', dataRoot, '--configPath', configPath,
        '--port', String(port), '--browserLaunchEnabled', 'false', '--enableIPv4', 'true', '--enableIPv6', 'false',
      ], { cwd: runtime, windowsHide: true, env: { ...process.env, NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', data => { logs = (logs + String(data)).slice(-4000); });
      child.stderr?.on('data', data => { logs = (logs + String(data)).slice(-4000); });
      const baseUrl = `http://127.0.0.1:${port}/`;
      let ready = false;
      for (let attempt = 0; attempt < 480 && child.exitCode === null; attempt += 1) {
        try {
          const response = await fetch(`${baseUrl}csrf-token`, { signal: AbortSignal.timeout(700) });
          if (response.ok) { ready = true; break; }
        } catch { /* server still starting */ }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!ready) throw new Error(`临时酒馆未启动：${logs.slice(-1200)}`);
      const api = new SillyTavernApi(baseUrl);
      const assembly = new SillyTavernAssembly(api);
      const first = await assembly.assemble(makePlan('a'.repeat(64)));
      expect((await api.getChat(first.avatar, first.chatFile) as Array<{ chat_metadata: { world_info: string } }>)[0]
        .chat_metadata.world_info).toBe(first.worldId);
      expect(await assembly.assemble(makePlan('a'.repeat(64)))).toEqual(first);
      const next = await assembly.assemble(makePlan('b'.repeat(64)));
      expect(next.worldId).not.toBe(first.worldId);
      expect(next.avatar).not.toBe(first.avatar);

      // Equal revision and bundle fingerprints must still remain isolated by book.
      const other = await assembly.assemble(makePlan('a'.repeat(64), 'second-book'));
      expect(other.worldId).not.toBe(first.worldId);
      expect(other.avatar).not.toBe(first.avatar);
      expect(other.chatFile).not.toBe(first.chatFile);
      const otherRows = await api.getChat(other.avatar, other.chatFile) as Array<{ chat_metadata: { world_info: string; novel_world_compiler: { resource_key: string } } }>;
      expect(otherRows[0].chat_metadata.world_info).toBe(other.worldId);
      expect(otherRows[0].chat_metadata.novel_world_compiler.resource_key).toBe(makePlan('a'.repeat(64), 'second-book').resourceKey);
      const firstRows = await api.getChat(first.avatar, first.chatFile);
      const firstWorld = await api.getWorld(first.worldId);
      const firstCard = await api.getCharacter(first.avatar);
      expect(await assembly.assemble(makePlan('a'.repeat(64)))).toEqual(first);
      expect(await api.getChat(first.avatar, first.chatFile)).toEqual(firstRows);
      expect(await api.getWorld(first.worldId)).toEqual(firstWorld);
      expect(await api.getCharacter(first.avatar)).toEqual(firstCard);
      expect((await api.listCharacters()).filter(card => card.name === '隔离测试旁白').length).toBe(3);
      const updateDirectory = path.join(tempRoot, 'update-records');
      const managed = makePlan('c'.repeat(64), 'updatable-book'); managed.updateKey = 'stable-test-session';
      const updater = new SillyTavernAssembly(api, updateDirectory);
      const original = await updater.assemble(managed);
      const originalChat = await api.getChat(original.avatar, original.chatFile);
      const updated = makePlan('d'.repeat(64), 'updatable-book'); updated.updateKey = managed.updateKey;
      updated.sessionWorldBook.description = '更新后的世界设定';
      updated.narratorCard.data.personality = '更新后的旁白语气';
      expect(await updater.assemble(updated)).toEqual(original);
      expect((await api.getWorld(original.worldId))?.description).toBe('更新后的世界设定');
      expect((await api.getCharacter(original.avatar)).data).toMatchObject({ personality: '更新后的旁白语气' });
      expect(await api.getChat(original.avatar, original.chatFile)).toEqual(originalChat);
      expect(await new SillyTavernAssembly(api, updateDirectory).assemble(updated)).toEqual(original);
      const edited = await api.getWorld(original.worldId) as SessionWorldBook;
      edited.description = '用户手工补充'; await api.updateWorld(original.worldId, edited);
      const third = makePlan('e'.repeat(64), 'updatable-book'); third.updateKey = managed.updateKey;
      const preserved = await updater.assemble(third);
      expect(preserved.updateNotice).toContain('手工修改');
      expect(preserved.chatFile).toBe(original.chatFile);
      expect((await api.getWorld(original.worldId))?.description).toBe('用户手工补充');
      expect((await api.listCharacters()).filter(card => card.name === '隔离测试旁白').length).toBe(4);


    } finally {
      child?.kill();
      // Only the mkdtemp child under the OS temp directory is ever removed.
      const relative = path.relative(os.tmpdir(), tempRoot);
      if (relative.startsWith('novel-st-isolated-') && !relative.includes(path.sep)) {
        await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      }
    }
  }, 160_000);
});
