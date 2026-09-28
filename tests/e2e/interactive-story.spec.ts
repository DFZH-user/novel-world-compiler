import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('interactive story guards actions, settles separately and invalidates changed history',async()=>{
 test.setTimeout(300000);
 const sample=process.env.NOVEL_REDESIGN_SAMPLE;
 test.skip(!sample,'Set NOVEL_REDESIGN_SAMPLE to the protected project copy');
 if (!sample!.includes('.codex-redesign-audit')) throw new Error('Use only the protected sample project copy');
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'novel-story-ui-'));
 const data=path.join(temp,'data');await fs.mkdir(data,{recursive:true});
 const manifest=JSON.parse(await fs.readFile(path.join(sample!,'project.json'),'utf8'));
 await fs.writeFile(path.join(data,'project-library.json'),JSON.stringify([{id:manifest.projectId,name:manifest.name,rootPath:sample,activeRevisionId:'rev_48ce2ab34678c265e8997545c46b3005',createdAt:manifest.createdAt,updatedAt:manifest.createdAt}]));
 const app=await electron.launch({...(process.env.NOVEL_COMPILER_PACKAGED_EXE?{executablePath:path.resolve(process.env.NOVEL_COMPILER_PACKAGED_EXE)}:{args:[path.resolve('.')]}),env:{...process.env,NODE_ENV:'test',NOVEL_COMPILER_USER_DATA:path.join(temp,'data'),...(process.env.NOVEL_COMPILER_PACKAGED_EXE?{}:{NOVEL_COMPILER_SILLYTAVERN_ROOT:path.resolve('vendor/sillytavern')})}});
 async function view<T=any>(script:string):Promise<T>{const wrapped='(async()=>{try{return await eval('+JSON.stringify(script)+')}catch(e){return {__testError:String(e.stack)}}})()';const result=await app.evaluate(async({BrowserWindow},code)=>{const v=BrowserWindow.getAllWindows()[0].getBrowserViews()[0];return v?v.webContents.executeJavaScript(code):null;},wrapped);if(result?.__testError)throw new Error(result.__testError);return result as T;}
 async function capture(name:string){const png=await app.evaluate(async({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];const contents=win.getBrowserViews()[0].webContents;contents.setBackgroundThrottling(false);for(let i=0;i<3;i++){const image=await contents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(!image.isEmpty())return image.toPNG().toString('base64');await new Promise(resolve=>setTimeout(resolve,200));}throw new Error('Empty reading screenshot');});await fs.mkdir('verification-results/interactive-story',{recursive:true});await fs.writeFile('verification-results/interactive-story/'+name,Buffer.from(png,'base64'));}
 try{
  const page=await app.firstWindow();await page.getByRole('button',{name:'打开这本书'}).click();await page.getByRole('button',{name:'进入沉浸阅读'}).click();await page.getByLabel('姓名',{exact:true}).fill('剧情测试旅人');await page.getByRole('button',{name:'开始／继续游玩'}).click();await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getBrowserViews().length),{timeout:150000}).toBe(1);
  await expect.poll(()=>view('Boolean(document.querySelector("#nw-story-dock"))'),{timeout:120000}).toBe(true);
  await view(`(async()=>{
    window.storyErrors=[];addEventListener('error',e=>window.storyErrors.push(e.message));
    window.storySelect=(id)=>{const names={'nw-story-settlement':['游玩调节','剧情结算'],'nw-story-assistance':['游玩调节','剧情辅助'],'nw-story-reading':['其他设置','阅读排版'],'nw-story-avatars':['其他设置','人物外观']};const pair=names[id];[...document.querySelectorAll('#nw-categories button')].find(x=>x.textContent===pair[0]).click();[...document.querySelectorAll('#nw-subcategories button')].find(x=>x.textContent===pair[1]).click();};
    const script=await import('/script.js');const c=(await import('/scripts/st-context.js')).getContext();
    const card={spec:'chara_card_v2',spec_version:'2.0',data:{name:'林月',description:'客栈中的旅人',personality:'谨慎',scenario:'北门客栈',first_mes:'雨停了。林月：“别出声。”掌柜：“城卫正在搜查客栈。”',mes_example:'',creator_notes:'',system_prompt:'',post_history_instructions:'',alternate_greetings:[],tags:[],creator:'test',character_version:'1',extensions:{}}};
    const f=new FormData();f.append('file_type','json');f.append('avatar',new Blob([JSON.stringify(card)],{type:'application/json'}),'story-test.json');
    const imported=await (await fetch('/api/characters/import',{method:'POST',headers:c.getRequestHeaders({omitContentType:true}),body:f})).json();
    if(!imported.file_name)throw new Error('test import failed '+JSON.stringify(imported));
    await script.getCharacters();const id=c.characters.findIndex(ch=>ch.avatar===imported.file_name+'.png');await script.selectCharacterById(id);
    window.storyCtx=(await import('/scripts/st-context.js')).getContext;
    window.storyMock={mode:'allow',checks:0,settles:0,narratives:0,payloads:[]};
    window.storyRequests=[]; const originalFetch=window.fetch;
    window.fetch=async(url,options)=>{
      if(String(url).includes('/api/backends/chat-completions/generate')){
        const request=JSON.parse(options.body);window.storyMock.payloads.push(request);
        const prompt=request.messages[0]?.content||'';
        if(prompt.includes('行动合理性检查器')){
          window.storyMock.checks++;
          if(window.storyMock.mode==='block')return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({verdict:'block',evidence:[{source:'rules',quote:'没有瞬移能力'}],suggestion:'我寻找进入皇宫的路线。'})}}]});
          return Response.json({choices:[{finish_reason:'stop',message:{content:'{"verdict":"allow","evidence":[]}'}}]});
        }
        if(prompt.includes('互动小说的结算器')){
          window.storyMock.settles++;
          if(window.storyMock.mode==='fail')return new Response('failed',{status:503});
          if(window.storyMock.mode==='delay')await new Promise(resolve=>window.storyResolve=resolve);
          const result={updates:[{field:'place',value:'北门客栈',evidence:[{source:'body',quote:'客栈'}]}],actions:[{tendency:'kind',label:'保护',text:'帮助林月躲避搜查',evidence:[{source:'body',quote:'林月'}]},{tendency:'neutral',label:'核实',text:'向掌柜询问搜查原因',evidence:[{source:'body',quote:'掌柜'}]}],dialogues:[]};
          return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
        }
        window.storyMock.narratives++;
        return Response.json({choices:[{finish_reason:'stop',message:{content:'林月：“先别出去。”掌柜守在客栈门口。'}}]});
      }
      window.storyRequests.push(String(url)); const response=await originalFetch(url,options);window.storyRequests.push("done "+String(url));return response;
    };
    window.jQuery('#main_api').val('openai').trigger('change');
    const oai=await import('/scripts/openai.js');oai.oai_settings.stream_openai=false;script.setOnlineStatus('mock');
    window.storyCtx().chatMetadata.novel_story.rules='玩家是普通人，没有瞬移能力。';
    await window.storyCtx().saveChat();
    document.querySelector('#nw-settings').click();
    window.storySelect("nw-story-settlement");
  })()`);
  await view('const attempts=document.getElementById("nw-story-settlement").querySelectorAll("input")[3];attempts.value=1;attempts.dispatchEvent(new Event("change"));document.querySelector("#nw-read").click();document.querySelector("#nw-state-toggle").click();document.querySelector("#nw-settle-retry").click();');
  await expect.poll(()=>view('document.querySelectorAll("#nw-action-list button").length')).toBe(2);
  expect(await view('window.storyMock.payloads[0].max_tokens')).toBe(8192);
  const raw=await view('window.storyCtx().chat.map(m=>m.mes)');
  await capture('01-story-actions.png');
  await view('document.querySelector("#send_textarea").value="原有草稿";document.querySelector("#nw-action-list button").click();');
  expect(await view('document.querySelector("#send_textarea").value')).toBe('原有草稿');
  expect(await view('document.querySelector("#nw-action-notice").hidden')).toBe(false);
  await view(`(async()=>{window.storyMock.mode='block';document.querySelector('#send_textarea').value='我瞬移进皇宫。';await (await import('/script.js')).Generate('normal');})()`);
  expect(await view('document.querySelector("#send_textarea").value')).toBe('我瞬移进皇宫。');
  expect(await view('window.storyCtx().chat.map(m=>m.mes)')).toEqual(raw);
  expect(await view('document.querySelector("#nw-action-notice").textContent')).toContain('没有瞬移能力');
  expect(await view('window.storyMock.narratives')).toBe(0);
  await capture('02-action-guard.png');
  const checks=await view('window.storyMock.checks');
  await view(`(async()=>{document.querySelector('#nw-strict-toggle').click();window.storyMock.mode='allow';await (await import('/script.js')).Generate('normal');})()`);
  expect(await view('window.storyMock.checks')).toBe(checks);
  await expect.poll(()=>view('window.storyMock.narratives')).toBe(1);
  await expect.poll(()=>view('document.querySelectorAll("#nw-action-list button").length')).toBe(2);
  await view('document.querySelector("#nw-settings").click();window.storySelect("nw-story-reading");document.querySelector("input[aria-label=突出人物对白]").click();document.querySelector("#nw-read").click();');
  expect(await view('document.querySelectorAll(".nw-dialogue").length')).toBeGreaterThan(0);
  await capture('03-dialogue-reading.png');
  const beforeFailure=await view('window.storyCtx().chat.map(m=>m.mes)');
  await view('window.storyMock.mode="fail";document.querySelector("#nw-settle-retry").click();');
  await expect.poll(()=>view('document.querySelector(".nw-story-status").textContent')).toContain('HTTP 503');
  expect(await view('window.storyCtx().chat.map(m=>m.mes)')).toEqual(beforeFailure);
  expect(await view('document.querySelectorAll("#nw-action-list button").length')).toBe(0);
  await view('window.storyMock.mode="allow";document.querySelector("#nw-settle-retry").click();');
  await expect.poll(()=>view('document.querySelectorAll("#nw-action-list button").length')).toBe(2);


  await view('(async()=>{document.querySelector("#nw-settings").click();window.storySelect("nw-story-avatars");const canvas=document.createElement("canvas");canvas.width=canvas.height=64;canvas.getContext("2d").fillRect(0,0,64,64);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));const data=new DataTransfer();data.items.add(new File([blob],"avatar.png",{type:"image/png"}));const input=[...document.querySelectorAll("#nw-story-avatars input[type=file]")].find(e=>e.getAttribute("aria-label").startsWith("林月"));input.files=data.files;input.dispatchEvent(new Event("change"));})()');
  await expect.poll(()=>view('Boolean(window.storyCtx().chatMetadata.novel_story.avatars["林月"]?.image)')).toBe(true);
  expect(await view('(async()=>{const a=await import("/scripts/novel-story-assets.js");try{await a.importFont(new File(["invalid font"],"broken.ttf"));return false;}catch{return true;}})()')).toBe(true);
  const fontBase64=(await fs.readFile('C:/Windows/Fonts/arial.ttf')).toString('base64');
  await view('(async()=>{window.storySelect("nw-story-reading");const bytes=Uint8Array.from(atob('+JSON.stringify(fontBase64)+'),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],"reading-test.ttf"));const input=document.querySelector("#nw-story-reading input[type=file]");input.files=data.files;input.dispatchEvent(new Event("change"));})()');
  await expect.poll(()=>view('document.querySelector("#nw-story-reading select").value')).toBe('custom');
  expect(await view('(async()=>{const saved=await (await import("/scripts/novel-story-assets.js")).readFont();return saved.name;})()')).toBe('reading-test.ttf');
  await view('document.querySelector("#nw-story-reading button").click();');
  await expect.poll(()=>view('document.querySelector("#nw-story-reading select").value')).toBe('default');
  await capture('04-reading-preferences.png');
  await view('document.querySelector("#nw-read").click();');
  await view('(async()=>{window.originalChatId=window.storyCtx().chatId;await window.storyCtx().saveChat();await window.storyCtx().openCharacterChat(window.originalChatId);})()');
  await expect.poll(()=>view('document.querySelectorAll("#nw-action-list button").length')).toBe(2);
  expect(await view('window.storyCtx().chatMetadata.novel_story.strict')).toBe(false);
  await view('window.storyMock.mode="delay";document.querySelector("#nw-settle-retry").click();');
  await expect.poll(()=>view('typeof window.storyResolve')).toBe('function');
  await view('(async()=>{await window.storyCtx().openCharacterChat("isolated-second-scene");window.storyResolve();})()');
  await new Promise(resolve=>setTimeout(resolve,200));
  expect(await view('Object.keys(window.storyCtx().chatMetadata.novel_story.records).length')).toBe(0);
  expect(await view('document.querySelectorAll("#nw-action-list button").length')).toBe(0);
  await view('(async()=>{window.storyMock.mode="allow";await window.storyCtx().openCharacterChat(window.originalChatId);})()');
  await expect.poll(()=>view('document.querySelectorAll("#nw-action-list button").length')).toBe(2);
  await view(`(async()=>{const c=window.storyCtx();c.chat[0].mes+='前文发生了改变。';await c.eventSource.emit(c.eventTypes.MESSAGE_EDITED,0);})()`);
  await expect.poll(()=>view('document.querySelectorAll("#nw-action-list button").length')).toBe(0);
  await view('document.querySelector("#nw-settings").click();window.storySelect("nw-story-assistance");document.querySelector("input[aria-label=自动更新剧情]").click();');
  const settlements=await view('window.storyMock.settles');
  await view('(async()=>{const c=window.storyCtx();await c.eventSource.emit(c.eventTypes.GENERATION_ENDED,c.chat.length);})()');
  await new Promise(resolve=>setTimeout(resolve,500));
  expect(await view('window.storyMock.settles')).toBe(settlements);
  expect(await view('window.storyErrors')).toEqual([]);
 }catch(e){await capture('failure.png').catch(()=>{});throw e;}finally{await app.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
