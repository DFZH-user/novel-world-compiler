import { checkReadingRails, checkReadingSidebar } from './reading-layout-check';
import { checkPlayModeRoundtrip } from './play-mode-check';
import { checkRuntimeTokens } from './runtime-token-check';
import { checkCardWorldImport } from './card-world-import-check';
import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('existing project: setup, managed reading, identity, and repeat entry preserve the chat', async () => {
  test.setTimeout(360_000);
  const sample = process.env.NOVEL_REDESIGN_SAMPLE;
  test.skip(!sample, 'Set NOVEL_REDESIGN_SAMPLE to the protected copy');
  if (!sample!.includes('.codex-redesign-audit')) throw new Error('Use only the backed-up test copy');
  const output = path.join(path.dirname(sample!), `electron-acceptance-${Date.now()}`);
  const userData = path.join(output, 'user-data');
  await fs.mkdir(userData, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(sample!, 'project.json'), 'utf8'));
  await fs.writeFile(path.join(userData, 'project-library.json'), JSON.stringify([{
    id: manifest.projectId, name: manifest.name, rootPath: sample,
    activeRevisionId: 'rev_48ce2ab34678c265e8997545c46b3005', createdAt: manifest.createdAt, updatedAt: manifest.createdAt,
  }]));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')), NOVEL_COMPILER_USER_DATA: userData,
    NOVEL_COMPILER_SILLYTAVERN_ROOT: path.resolve('vendor/sillytavern'), NODE_ENV: 'test' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.NOVEL_PACKAGED_EXECUTABLE;
  if (executablePath) delete env.NOVEL_COMPILER_SILLYTAVERN_ROOT;
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [path.resolve('.')], env });
  const errors: string[] = [];
  try {
    await app.evaluate(({ session }) => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const local = !/^https?:/u.test(details.url) || /^http:\/\/127\.0\.0\.1[:/]/u.test(details.url);
        callback({ cancel: !local });
      });
    });
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.stack || error.message));
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), { timeout: 30000 }).toBe(true);
    await page.getByRole('button', { name: '打开这本书' }).click();
    await page.getByRole('button', { name: '进入沉浸阅读' }).click();
    await expect(page.getByRole('heading', { name: '你是谁，由你决定' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('姓名', { exact: true }).fill('测试旅人');
    await page.getByLabel('身份与一句背景').fill('仅供隔离验收的旅人。');
    await page.screenshot({ path: path.join(output, 'setup.png'), fullPage: true });
    await page.getByRole('button', { name: '开始／继续游玩' }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews().length),
      { timeout: 150_000, intervals: [500, 1000] }).toBe(1);
    const inspect = () => app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].getBrowserViews()[0];
      return view.webContents.executeJavaScript(`(async () => {
        const { getContext } = await import('/scripts/st-context.js');
        const context = getContext();
        return { chat: context.chatId, world: context.chatMetadata.world_info,
          marker: context.chatMetadata.novel_world_compiler,
          categories: [...document.querySelectorAll('#nw-categories button')].map(x => x.textContent),
          body: document.body.innerText.slice(-1000) };
      })()`);
    });
    const first = await inspect();
    expect(first.marker.persona.name).toBe('测试旅人');
    expect(first.marker.starting_scene).toBeDefined();
    expect(first.world).toBe(first.marker.world_id);
    expect(first.categories).toHaveLength(6);
    await checkCardWorldImport(app);
    await checkRuntimeTokens(app, sample!, output);
    await checkReadingRails(app, path.join(output, 'reading-three-rail.png'));
    await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0].getBrowserViews()[0];
      await view.webContents.executeJavaScript(`(async () => {
        const { getContext } = await import('/scripts/st-context.js');
        const context = getContext();
        context.chat.push({name: '测试旅人', is_user: true, is_system: false, send_date: new Date().toISOString(), mes: '隔离验收：保留这条历史。'});
        await context.saveChat();
        document.getElementById('nw-settings').click();
        [...document.querySelectorAll('#nw-categories button')].find(x => x.textContent === '我的身份').click();
        if (document.getElementById('nw-project-persona').hidden) throw new Error('Managed persona panel hidden');
      })()`);
    });
    await expect.poll(() => app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`document.body.classList.contains('nw-settings') && document.getElementById('nw-project-persona').getBoundingClientRect().height > 0`))).toBe(true);
    await checkReadingSidebar(app);
    await page.waitForTimeout(300);
    const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.writeFile(path.join(output, 'reading-settings.png'), Buffer.from(image, 'base64'));
    await page.getByRole('button', { name: '← 小说世界', exact: true }).click();
    await page.getByRole('button', { name: '打开这本书' }).click();
    await page.getByRole('button', { name: '进入沉浸阅读' }).click();
    await expect(page.getByLabel('姓名', { exact: true })).toHaveValue('测试旅人', { timeout: 30_000 });
    await page.getByRole('button', { name: '开始／继续游玩' }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews().length),
      { timeout: 30_000 }).toBe(1);
    const second = await inspect();
    expect(second.chat).toBe(first.chat); expect(second.world).toBe(first.world);
    const history = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(
      `(async () => (await import('/scripts/st-context.js')).getContext().chat.map(x => x.mes))()`));
    expect(history).toContain('隔离验收：保留这条历史。');
    await checkPlayModeRoundtrip(app, page, first.chat, () => checkRuntimeTokens(app, sample!, output, 'character'));
    await page.getByRole('button', { name: '← 小说世界', exact: true }).click();
    await page.getByRole('button', { name: '打开这本书' }).click();
    await page.getByRole('button', { name: '进入编译工作台' }).click();
    await page.getByRole('button', { name: '关系图谱' }).click();
    await expect(page.getByRole('region', { name: '人物关系与变化' })).toBeVisible({ timeout: 30_000 });
    await page.getByLabel('搜索中心人物').fill('方源');
    await page.locator('.focus-person-list button').filter({ hasText: '方源' }).first().click();
    await expect(page.locator('.focus-main h2')).toHaveText('方源');
    await page.locator('.focus-connections button').first().click();
    await expect(page.locator('.focus-evidence h4').first()).toContainText('方源');
    const events = page.getByRole('region', { name: '人物重要事件时间线' });
    await expect(events).toBeVisible();
    await expect(events.locator('article').first()).toBeVisible();
    await events.locator('article details summary').first().click();
    await expect(events.locator('article blockquote').first()).toBeVisible();
    await page.screenshot({ path: path.join(output, 'relationship-events.png'), fullPage: true });
    await events.getByRole('button', { name: '查看此时关系' }).first().click();
    await expect.poll(() => page.locator('.graph-time-copy strong').innerText()).not.toContain('16978');
    await expect(page.locator('.focus-main h2')).toHaveText('方源');
    await page.screenshot({ path: path.join(output, 'relationship-focus.png'), fullPage: true });
    await page.getByRole('button', { name: '完整关系图与核查' }).click();
    await expect(page.locator('.graph-stage')).toBeVisible();
    await page.getByRole('button', { name: '叙事地图' }).click();
    await expect(page.getByRole('region', { name: '世界地点总览' })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.atlas-note')).toContainText('尚无已确认空间关系');
    await page.getByLabel('图册搜索地点').fill('青茅山');
    await expect(page.locator('.atlas-place-name').first()).toBeVisible();
    await page.locator('.atlas-place-name').first().click();
    await expect(page.locator('.atlas-detail h3')).toContainText('青茅山');
    await page.getByRole('button', { name: '放大图册' }).click();
    await expect(page.locator('.atlas-zoom')).toContainText('125%');
    await page.screenshot({ path: path.join(output, 'world-atlas.png'), fullPage: true });
    await page.locator('.atlas-paper').screenshot({ path: path.join(output, 'world-atlas-detail.png') });
    expect(errors).toEqual([]);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ first, second, errors }, null, 2));
    console.log('Acceptance artifacts:', output);
  } finally { await app.close(); }
});
