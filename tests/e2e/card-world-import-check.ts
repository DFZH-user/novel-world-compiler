import { expect, type ElectronApplication } from '@playwright/test';

export async function checkCardWorldImport(app: ElectronApplication) {
  const run = (code: string) => app.evaluate(async ({ BrowserWindow }, source) =>
    BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(source), code);
  await run(`(async () => {
    const native = await import('/script.js');
    const world = await import('/scripts/world-info.js');
    const context = (await import('/scripts/st-context.js')).getContext();
    const card = { spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: '拆分验收人物', description: '仅供离线验收', personality: '', scenario: '', first_mes: '测试', mes_example: '',
      creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: { world: '拆分验收同名世界' },
      character_book: { name: '拆分验收同名世界', entries: [{ id: 0, keys: ['验收'], content: '卡内独立资料', enabled: true, insertion_order: 1, position: 'before_char' }] }
    }};
    const body = new FormData(); body.append('avatar', new File([JSON.stringify(card)], 'split-test.json', {type:'application/json'}));
    body.append('file_type', 'json'); body.append('user_name', '测试旅人');
    const imported = await fetch('/api/characters/import', {method:'POST',headers:native.getRequestHeaders({omitContentType:true}),body});
    if (!imported.ok) throw new Error('Test card import failed');
    const result = await imported.json();
    window.__splitAvatar = result.file_name + '.png';
    await native.getCharacters();
    const old = {entries:{0:{uid:0,key:['原有'],content:'保留旧世界内容',constant:false}}};
    const saved = await fetch('/api/worldinfo/edit', {method:'POST',headers:native.getRequestHeaders(),body:JSON.stringify({name:'拆分验收同名世界',data:old})});
    if (!saved.ok) throw new Error('Test world setup failed');
    await world.updateWorldInfoList();
    window.__splitBefore = {count:world.world_names.length, chat:context.chatId, binding:context.chatMetadata.world_info};
    window.__splitDone = false;
    world.checkEmbeddedWorld(context.characters.findIndex(card => card.avatar === window.__splitAvatar));
  })()`);
  await expect.poll(() => run(`document.querySelector('dialog[open] .popup-button-ok')?.textContent`)).toBe('拆分导入');
  await run(`document.querySelector('dialog[open] .popup-button-cancel').click()`);
  await expect.poll(() => run(`Boolean(document.querySelector('dialog[open] .popup-button-ok'))`)).toBe(false);
  expect(await run(`(async () => (await import('/scripts/world-info.js')).world_names.length === window.__splitBefore.count)()`)).toBe(true);
  await run(`(async () => {window.__splitDone=false;(await import('/scripts/world-info.js')).importNovelCardWorld(window.__splitAvatar).then(name => {window.__splitResult=name;window.__splitDone=true;});})()`);
  await expect.poll(() => run(`document.querySelector('dialog[open] .popup-button-ok')?.textContent`)).toBe('拆分导入');
  await run(`document.querySelector('dialog[open] .popup-button-ok').click()`);
  await expect.poll(() => run(`window.__splitDone`)).toBe(true);
  const result = await run(`(async () => {
    const native = await import('/script.js');const world = await import('/scripts/world-info.js');
    const context = (await import('/scripts/st-context.js')).getContext();
    const read = async name => {const response=await fetch('/api/worldinfo/get',{method:'POST',headers:native.getRequestHeaders(),body:JSON.stringify({name})});if(!response.ok)throw new Error('Read failed');return response.json();};
    return {name:window.__splitResult,old:await read('拆分验收同名世界'),imported:await read(window.__splitResult),
      extra:world.world_names.length-window.__splitBefore.count,bindingUnchanged:context.chatMetadata.world_info===window.__splitBefore.binding,
      chatUnchanged:context.chatId===window.__splitBefore.chat,
      embedded:context.characters.find(card=>card.avatar===window.__splitAvatar).data.character_book.entries[0].content};
  })()`);
  expect(result.name).toContain('拆分验收同名世界 · 导入');
  expect(result.old.entries[0].content).toBe('保留旧世界内容');
  expect(result.imported.entries[0].content).toBe('卡内独立资料');
  expect(result.embedded).toBe('卡内独立资料');
  expect(result.extra).toBe(1);
  expect(result.bindingUnchanged).toBe(true);
  expect(result.chatUnchanged).toBe(true);
  await run(`document.getElementById('nw-settings').click();[...document.querySelectorAll('#nw-categories button')].find(button => button.textContent === '世界设定／世界书').click();`);
  await expect.poll(() => run(`document.querySelector('#nw-world-library select')?.options.length || 0`)).toBeGreaterThan(0);
  await run(`const select = document.querySelector('#nw-world-library select');select.value = window.__splitResult;select.dispatchEvent(new Event('change'));`);
  await expect.poll(() => run(`[...document.querySelectorAll('#nw-world-library button')].some(button => button.textContent === '用于本会话')`)).toBe(true);
  await run(`[...document.querySelectorAll('#nw-world-library button')].find(button => button.textContent === '用于本会话').click();`);
  await expect.poll(() => run(`document.querySelector('dialog[open] .popup-button-ok')?.textContent`)).toBe('确认采用');
  await run(`document.querySelector('dialog[open] .popup-button-ok').click();`);
  await expect.poll(() => run(`[...document.querySelectorAll('#nw-world-library button')].some(button => button.textContent === '停止用于本会话')`)).toBe(true);
  const adopted = await run(`(async () => {
    const {eventSource,event_types}=await import('/scripts/events.js');
    const context=(await import('/scripts/st-context.js')).getContext();
    const groups={globalLore:[{world:'未采用的其他书',uid:1,content:'不应加载'}],characterLore:[],personaLore:[],chatLore:[{world:context.chatMetadata.world_info,uid:0,content:'本书基础'}]};
    await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED,groups);
    return {entries:groups.chatLore,global:groups.globalLore,base:context.chatMetadata.world_info===window.__splitBefore.binding};
  })()`);
  expect(adopted.global).toEqual([]);
  expect(adopted.base).toBe(true);
  expect(adopted.entries.some((entry: {content: string}) => entry.content === '卡内独立资料')).toBe(true);
  await run(`[...document.querySelectorAll('#nw-world-library button')].find(button => button.textContent === '停止用于本会话').click();`);
  await expect.poll(() => run(`document.querySelector('dialog[open] .popup-button-ok')?.textContent`)).toBe('停止采用');
  await run(`document.querySelector('dialog[open] .popup-button-ok').click();`);
  await expect.poll(() => run(`(async () => (await import('/scripts/st-context.js')).getContext().chatMetadata.novel_world_compiler.extra_worlds.length)()`)).toBe(0);

}
