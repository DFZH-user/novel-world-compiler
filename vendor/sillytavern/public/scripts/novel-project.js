import { eventSource, event_types } from './events.js';
import { getContext } from './st-context.js';
import { getCharacters, selectCharacterById, openCharacterChat, isGenerating } from '../script.js';

const managed = () => getContext().chatMetadata?.novel_world_compiler;
const active = () => managed()?.assembly_version === 'session-assembly.v1' && typeof managed()?.world_id === 'string';

function applyRules() {
  const context = getContext();
  const marker = managed();
  const rules = active() ? [
    marker.mode === 'character' ? '只扮演所选人物；不要成为全知旁白。' : '担任世界旁白，描写环境、在场 NPC 与行动后果。',
    '玩家控制自己的行动、言语和心理。不要代替玩家作决定。只使用当前已揭示设定；未确认事实保持未知。',
    marker.starting_scene?.context ? `开场时已揭示背景（仅作起始参考；后续状态以当前聊天为准，勿将剧情重置到开场）：\n${marker.starting_scene.context}\n开场确认地点：${marker.starting_scene.locations?.join('、') || '未知，不擅自指定。'}` : '',
    marker.starting_scene?.chosenLocation ? `玩家选择的开场地点：${marker.starting_scene.chosenLocation.name}。这是玩家游玩分支的选择，并非原著事件地点的断言；未确认的空间关系保持未知。` : '',
    marker.persona ? `当前玩家姓名：${marker.persona.name}。玩家身份：${marker.persona.description || '尚未说明背景。'}` : '',
  ].join('\n') : '';
  context.setExtensionPrompt('novel-world-project-rules', rules, 1, 0, false, 0);
  renderStatus();
}

function renderStatus() {
  const status = document.getElementById('nw-project-status');
  if (!status) return;
  status.hidden = !active();
  if (!active()) return;
  const context = getContext(), marker = managed();
  const connection = context.onlineStatus && context.onlineStatus !== 'no_connection' ? '模型已连接' : '模型尚未连接，请打开模型连接';
  status.textContent = `${marker.project_name || '当前世界'} · ${marker.persona?.name || '玩家'} · ${connection}`;
  status.title = `独立会话世界书 · ${marker.entry_title || '当前进入点'}。点击上方阅读设置可修改连接。`;
}

// Restrict runtime lore, without changing the user's global selections or other chats.
eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, async groups => {
  if (!active()) return;
  const world = managed().world_id;
  for (const list of Object.values(groups)) {
    if (Array.isArray(list)) list.splice(0, list.length, ...list.filter(entry => entry.world === world));
  }
  const marker = managed();
  const { loadWorldInfo } = await import('./world-info.js');
  for (const name of [...new Set(marker.extra_worlds ?? [])]) {
    if (name === world) continue;
    const data = await loadWorldInfo(name);
    if (!data?.entries || marker !== managed()) throw new Error('所采用的外来世界书无法读取，或会话已切换。');
    groups.chatLore.push(...Object.values(data.entries).map(entry => ({ ...entry, world: name,
      ignoreBudget: false, excludeRecursion: true, preventRecursion: true })));
  }
});
eventSource.on(event_types.GENERATION_AFTER_COMMANDS, async () => {
  if (active() && getContext().chatMetadata.world_info !== managed().world_id) {
    toastr.error('此会话的世界书被更换。请恢复本书世界书或从书库重新准备，避免串入其他世界。');
    throw new Error('本书会话的世界书绑定已改变。');
  }
  if (active()) {
    const marker = managed();
    const { loadWorldInfo } = await import('./world-info.js');
    for (const name of marker.extra_worlds ?? []) {
      if (!(await loadWorldInfo(name))?.entries || marker !== managed()) {
        toastr.error('本会话采用的世界书无法读取，请在世界书工作台检查或停止采用。');
        throw new Error('采用的世界书缺失或会话已切换。');
      }
    }
  }
  applyRules();
});
eventSource.on(event_types.CHAT_CHANGED, applyRules);
eventSource.on(event_types.ONLINE_STATUS_CHANGED, renderStatus);
eventSource.once(event_types.APP_READY, () => {
  const label = document.createElement('p'); label.id = 'nw-project-status'; label.setAttribute('role', 'status');
  document.getElementById('form_sheld')?.prepend(label);
  window.novelWorldManagedSession = {
    async open(handle) {
      if (isGenerating()) throw new Error('当前故事仍在生成，请等待完成后再切书。');
      (await import('./world-info.js')).worldInfoCache.delete(handle.worldId);
      await getCharacters();
      const context = getContext();
      const index = context.characters.findIndex(character => character.avatar === handle.avatar);
      if (index < 0) throw new Error('已导入的人物卡不在酒馆列表中。');
      await selectCharacterById(index, { switchMenu: false });
      await openCharacterChat(handle.chatFile);
      const current = getContext();
      if (current.chatId !== handle.chatFile || current.characters[current.characterId]?.avatar !== handle.avatar
        || current.chatMetadata.world_info !== handle.worldId || managed()?.resource_key !== handle.resourceKey) {
        throw new Error('未能核验本书会话，阅读未解锁。');
      }
      applyRules();
      document.getElementById('nw-read')?.click();
      if (handle.updateNotice) toastr.info(handle.updateNotice, '保留手工资料', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
      return true;
    },
  };
  applyRules();
});
