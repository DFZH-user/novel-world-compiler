import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TavernCardV2 } from '../../src/shared/contracts';
import type { SessionWorldBook } from '../../src/shared/play-session-assembly';
import type { TavernSessionHandle } from './sillytavern-assembly';

type Data = Record<string, unknown>;
type Target = { generation: string; world: SessionWorldBook; card: TavernCardV2 };
type RecordState = { handle: TavernSessionHandle; generation: string; world: Data; card: Data; pending?: Target };
export interface SessionUpdateApi {
  getWorld(id: string): Promise<Data | null>;
  getCharacter(avatar: string): Promise<{ data?: unknown }>;
  updateWorld(id: string, world: SessionWorldBook): Promise<void>;
  updateCharacter(avatar: string, card: TavernCardV2): Promise<void>;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
// Imported cards acquire additional native fields. Check every generated field,
// without considering those native additions a failed import.
function includes(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) return same(actual, expected);
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => includes((actual as Data)[key], value));
}

/** Durable before-images and a pending write record make interrupted updates retryable.
 * Chat files are never written here. Manual edits prevent replacement of either asset.
 */
export class ManagedSessionUpdate {
  constructor(private readonly api: SessionUpdateApi, private readonly directory: string) {}

  private async write(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, file);
    } catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
  }

  private async readAssets(handle: TavernSessionHandle) {
    const world = await this.api.getWorld(handle.worldId);
    const character = await this.api.getCharacter(handle.avatar);
    if (!world || !character.data || typeof character.data !== 'object') throw new Error('游玩资源缺失，不能安全更新。');
    return { world, card: character.data as Data };
  }

  async apply(handle: TavernSessionHandle, target: Target): Promise<string | undefined> {
    const key = createHash('sha256').update(handle.resourceKey).digest('hex');
    const file = path.join(this.directory, `${key}.json`);
    let state: RecordState | undefined;
    try { state = JSON.parse(await fs.readFile(file, 'utf8')) as RecordState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const current = await this.readAssets(handle);
    const manualNotice = '发现手工修改，已保留现有角色卡和世界书；本次没有自动覆盖更新。';
    if (!state) {
      if (!includes(current.world, target.world) || !includes(current.card, target.card.data)) return manualNotice;
      await this.write(file, { handle, generation: target.generation, ...current });
      return;
    }
    if (!same(state.handle, handle)) throw new Error('资源更新记录与当前会话不一致，已停止更新。');

    const finish = async (pending: Target) => {
      const actual = await this.readAssets(handle);
      const worldDone = same(actual.world, pending.world);
      const cardDone = includes(actual.card, pending.card.data);
      if ((!worldDone && !same(actual.world, state!.world)) || (!cardDone && !same(actual.card, state!.card))) {
        throw new Error('上次资料更新未完成，期间发现手工修改；已停止更新并保留聊天，请检查角色卡与世界书。');
      }
      if (!worldDone) await this.api.updateWorld(handle.worldId, pending.world);
      if (!cardDone) await this.api.updateCharacter(handle.avatar, pending.card);
      const saved = await this.readAssets(handle);
      if (!includes(saved.world, pending.world) || !includes(saved.card, pending.card.data)) throw new Error('更新后读回内容不一致，请重试；聊天未被覆盖。');
      state = { handle, generation: pending.generation, ...saved };
      await this.write(file, state);
    };

    if (state.pending) await finish(state.pending);
    if (state.generation === target.generation) return;
    const before = await this.readAssets(handle);
    if (!same(before.world, state.world) || !same(before.card, state.card)) return manualNotice;
    await this.write(path.join(this.directory, 'history', `${key}-${randomUUID()}.json`), state);
    state.pending = target;
    await this.write(file, state);
    await finish(target);
  }
}
