import { expect, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compactRuntimeCharacter } from '../../src/shared/runtime-character';
import { tavernCardV2Schema } from '../../src/shared/contracts';

export async function checkRuntimeTokens(app: ElectronApplication, sample: string, output: string, mode: 'narrator' | 'character' = 'narrator') {
  // Hard block inference and nonlocal traffic even if a future dry-run implementation regresses.
  await app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].getBrowserViews()[0];
    view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const external = /^https?:/u.test(details.url) && !/^http:\/\/127\.0\.0\.1[:/]/u.test(details.url);
      const inference = /\/api\/.*\/(generate|completions|completion)(?:[/?]|$)/u.test(details.url);
      callback({ cancel: external || inference });
    });
  });
  let source;
  for (const relative of await fs.readdir(sample, { recursive: true })) {
    if (!relative.endsWith('.json')) continue;
    const parsed = tavernCardV2Schema.safeParse(JSON.parse(await fs.readFile(path.join(sample, relative), 'utf8')));
    if (parsed.success && parsed.data.data.name === '方源') { source = parsed.data; break; }
  }
  if (!source) throw new Error('Existing Fang Yuan source card missing');
  const compact = compactRuntimeCharacter('audit-character', source);
  const fields = (data: typeof source.data) => [data.description, data.personality, data.scenario, data.mes_example, data.system_prompt, data.post_history_instructions].join('\n');
  const report = await app.evaluate(async ({ BrowserWindow }, texts) => {
    const view = BrowserWindow.getAllWindows()[0].getBrowserViews()[0];
    return view.webContents.executeJavaScript(`(async () => {
      const native = await import('/script.js');
      const {eventSource,event_types} = await import('/scripts/events.js');
      const context = (await import('/scripts/st-context.js')).getContext();
      const inputs = ${JSON.stringify(texts)};
      const encode = async text => {
        const response = await fetch('/api/tokenizers/openai/encode?model=gpt-3.5-turbo', {
          method:'POST',headers:native.getRequestHeaders(),body:JSON.stringify({text})});
        if(!response.ok) throw new Error('Local tokenizer failed');
        const data = await response.json();
        if(text && (!Array.isArray(data.ids) || data.count <= 0)) throw new Error('Tokenizer returned no tokens');
        return data.count;
      };
      const world = await import('/scripts/world-info.js');
      const book = await world.loadWorldInfo(context.chatMetadata.world_info);
      const details = Object.values(book.entries).filter(entry => entry.key?.includes('方源') && entry.comment?.includes('按需明细') && entry.content.length < 250);
      const unique = details.find(entry => Object.values(book.entries).filter(other => other.key?.includes('方源') && other.keysecondary?.includes(entry.keysecondary[0])).length === 1);
      if(!unique) throw new Error('No bounded unique character detail fixture');
      const detailProbe = await world.getWorldInfoPrompt(['方源的' + unique.keysecondary[0] + '是什么？'], 32000, true);
      const irrelevantProbe = await world.getWorldInfoPrompt(['我观察天空。'], 32000, true);
      const detailLoaded = detailProbe.worldInfoString.includes(unique.content);
      const detailAbsentWithoutTopic = !irrelevantProbe.worldInfoString.includes(unique.content);
      let payload;
      const capture = (data,dryRun) => { if(dryRun) payload=structuredClone(data); };
      eventSource.on(event_types.GENERATE_AFTER_DATA,capture);
      const beforeCount=context.chat.length;
      try { await native.Generate('normal', {}, true); }
      finally { eventSource.removeListener(event_types.GENERATE_AFTER_DATA,capture); }
      if(!payload) throw new Error('Dry run did not produce request data');
      const prompt = typeof payload.prompt==='string' ? payload.prompt : JSON.stringify(payload.messages ?? payload.prompt ?? payload);
      return { referenceTokenizer:'local gpt-3.5-turbo / cl100k encoding; not provider billing',
        sourceCardTokens:await encode(inputs.source),compactCardTokens:await encode(inputs.compact),
        constructedPromptTokens:await encode(prompt),constructedPromptChars:prompt.length,
        detailLoaded,detailAbsentWithoutTopic,detailTopic:unique.keysecondary[0],
        mode:context.chatMetadata.novel_world_compiler.mode,actorName:context.characters[context.characterId].name,
        mainApi:context.mainApi,chatUnchanged:context.chat.length===beforeCount,
        promptHasPlayer:prompt.includes('测试旅人'),promptHasProject:prompt.includes('蛊真人'),badNpcBinding:prompt.includes('世界旁白是小说工程中的人物'),globalNameLeaked:prompt.includes('DFZH'),
        requestKeys:Object.keys(payload),prompt };
    })()`);
  }, { source: fields(source.data), compact: fields(compact.card.data) });
  expect(report.mode).toBe(mode);
  if (mode === 'character') {
    expect(report.actorName).toBe('方源');
    expect(report.prompt).toContain('方源');
    expect(report.constructedPromptTokens).toBeLessThan(report.sourceCardTokens / 3);
  }
  expect(report.chatUnchanged).toBe(true);
  expect(report.detailLoaded).toBe(true);
  expect(report.detailAbsentWithoutTopic).toBe(true);
  expect(report.promptHasPlayer).toBe(true);
  expect(report.badNpcBinding).toBe(false);
  expect(report.globalNameLeaked).toBe(false);
  expect(report.compactCardTokens).toBeLessThan(report.sourceCardTokens / 3);
  expect(report.constructedPromptTokens).toBeGreaterThan(0);
  await fs.writeFile(path.join(output, mode === 'narrator' ? 'runtime-token-audit.json' : 'character-runtime-token-audit.json'), JSON.stringify(report, null, 2));
}
