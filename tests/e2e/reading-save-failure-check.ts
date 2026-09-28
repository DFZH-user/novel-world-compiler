import { expect, type ElectronApplication } from '@playwright/test';

export async function checkReadingSaveFailure(app: ElectronApplication) {
  const result = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`(async () => {
    const context=(await import('/scripts/st-context.js')).getContext();
    const original=structuredClone(context.chatMetadata.novel_world_compiler.persona);
    document.getElementById('nw-settings').click();
    [...document.querySelectorAll('#nw-categories button')].find(x=>x.textContent==='我的身份').click();
    const panel=document.getElementById('nw-project-persona');
    const input=panel.querySelector('input'); const save=[...panel.querySelectorAll('button')].find(x=>x.textContent==='保存本会话身份');
    const nativeFetch=window.fetch;
    let failures=0;
    input.value='失败后重试身份';
    window.fetch=async function(resource,options) {
      if(String(resource).includes('/api/chats/save')) { failures++;return new Response(JSON.stringify({error:'simulated-save-failure'}),{status:503,statusText:'Offline test failure',headers:{'content-type':'application/json'}}); }
      return nativeFetch.call(this,resource,options);
    };
    let failureMessage,rolledBack;
    try { await save.onclick(); failureMessage=panel.querySelector('[role=status]').textContent;rolledBack=context.chatMetadata.novel_world_compiler.persona.name===original.name; }
    finally { window.fetch=nativeFetch; }
    await save.onclick();
    const retryMessage=panel.querySelector('[role=status]').textContent;
    const native=await import('/script.js');
    const response=await fetch('/api/chats/get',{method:'POST',headers:native.getRequestHeaders(),body:JSON.stringify({avatar_url:context.characters[context.characterId].avatar,file_name:context.chatId})});
    const rows=await response.json();
    const persistedName=rows[0].chat_metadata.novel_world_compiler.persona.name;
    input.value=original.name;await save.onclick();
    return {failures,failureMessage,rolledBack,retryMessage,persistedName};
  })()`));
  expect(result.failures).toBe(1);
  expect(result.failureMessage).toContain('保存失败');
  expect(result.rolledBack).toBe(true);
  expect(result.retryMessage).toBe('本会话身份已保存。');
  expect(result.persistedName).toBe('失败后重试身份');
}
