import { checkReadingModelError } from './reading-model-error-check';
import { checkReadingSaveFailure } from './reading-save-failure-check';
import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('library switches books and restores each identity, world and saved chat', async () => {
  test.setTimeout(240_000);
  const sample = process.env.NOVEL_REDESIGN_SAMPLE;
  test.skip(!sample, 'Requires the protected original-project copy and offline second-book fixture');
  if (!sample!.includes('.codex-redesign-audit')) throw new Error('Only use the protected copy');
  const audit = path.dirname(sample!);
  const second = JSON.parse(await fs.readFile(path.join(audit, 'cross-book-fixture.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(path.join(sample!, 'project.json'), 'utf8'));
  const first = { id: manifest.projectId, name: manifest.name, rootPath: sample,
    activeRevisionId: 'rev_48ce2ab34678c265e8997545c46b3005', createdAt: manifest.createdAt, updatedAt: manifest.createdAt };
  const output = path.join(audit, `cross-book-acceptance-${Date.now()}`);
  const userData = path.join(output, 'user-data');
  await fs.mkdir(userData, { recursive: true });
  await fs.writeFile(path.join(userData, 'project-library.json'), JSON.stringify([first, second]));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), NOVEL_COMPILER_USER_DATA: userData,
    NOVEL_COMPILER_SILLYTAVERN_ROOT: path.resolve('vendor/sillytavern'), NODE_ENV: 'test' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.NOVEL_PACKAGED_EXECUTABLE;
  if (executablePath) delete env.NOVEL_COMPILER_SILLYTAVERN_ROOT;
  const startTime = Date.now();
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [path.resolve('.')], env });
  try {
    const page = await app.firstWindow();
    const startupMs = Date.now() - startTime;
    const runtime = await app.evaluate(({app}) => ({packaged:app.isPackaged,version:app.getVersion()}));
    if (executablePath) { expect(runtime.packaged).toBe(true); expect(runtime.version).toBe('0.3.0-integrated.11'); }
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const open = async (name: string, persona: string, returning = false) => {
      await page.getByLabel('搜索书库').fill(name);
      await page.getByRole('button', { name: '打开这本书' }).click();
      await page.getByRole('button', { name: '进入沉浸阅读' }).click();
      await expect(page.getByLabel('姓名', { exact: true })).toBeVisible({ timeout: 30_000 });
      if (returning) await expect(page.getByLabel('姓名', { exact: true })).toHaveValue(persona);
      else await page.getByLabel('姓名', { exact: true }).fill(persona);
      await page.getByRole('button', { name: '开始／继续游玩' }).click();
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews().length), { timeout: 120_000 }).toBe(1);
    };
    const inspect = (save: string | null = null) => app.evaluate(async ({ BrowserWindow }, message) => {
      const view = BrowserWindow.getAllWindows()[0].getBrowserViews()[0];
      view.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({cancel:
        (/^https?:/u.test(details.url) && !/^http:\/\/127\.0\.0\.1[:/]/u.test(details.url)) || /\/api\/.*\/(generate|completions|completion)(?:[/?]|$)/u.test(details.url)}));
      return view.webContents.executeJavaScript(`(async () => {
        const context=(await import('/scripts/st-context.js')).getContext();
        const message=${JSON.stringify(message)};
        if(message) { context.chat.push({name:context.chatMetadata.novel_world_compiler.persona.name,is_user:true,is_system:false,send_date:new Date().toISOString(),mes:message});await context.saveChat(); }
        const book=await (await import('/scripts/world-info.js')).loadWorldInfo(context.chatMetadata.world_info);
        return {chat:context.chatId,world:context.chatMetadata.world_info,marker:context.chatMetadata.novel_world_compiler,
          bookProject:book.extensions.novel_world_compiler.project_id,history:context.chat.map(x=>x.mes)};
      })()`);
    }, save);
    const back = () => page.getByRole('button', { name: '← 小说世界', exact: true }).click();
    await open(first.name, '蛊界旅人'); await checkReadingSaveFailure(app); const a = await inspect('只属于蛊界的历史。');
    await back(); await open(second.name, '青石旅人'); await checkReadingModelError(app); const b = await inspect('只属于青石镇的历史。');
    expect(b.bookProject).toBe(second.id); expect(a.bookProject).toBe(first.id);
    expect(b.world).not.toBe(a.world); expect(b.chat).not.toBe(a.chat);
    expect(b.history).not.toContain('只属于蛊界的历史。');
    await back(); await open(first.name, '蛊界旅人', true); const restoredA = await inspect();
    expect(restoredA).toEqual(a);
    await back(); await open(second.name, '青石旅人', true); const restoredB = await inspect();
    expect(restoredB).toEqual(b); expect(errors).toEqual([]);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({a,b,restoredA,restoredB,errors,runtime,startupMs}, null, 2));
    console.log('Cross-book acceptance:', output);
  } finally { await app.close(); }
});
