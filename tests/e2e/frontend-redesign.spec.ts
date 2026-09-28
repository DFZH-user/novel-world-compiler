import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const output = path.resolve('verification-results/frontend-integrated6');
test('real library projects open through the cover transition and preserve compiler navigation', async () => {
  test.setTimeout(120_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-library-ui-'));
  const app = await electron.launch({ ...(process.env.NOVEL_COMPILER_PACKAGED_EXE ? { executablePath: path.resolve(process.env.NOVEL_COMPILER_PACKAGED_EXE) } : { args: [path.resolve('.')] }), env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(temp, 'data') } });
  try {
    const page = await app.firstWindow();
    const errors: string[] = []; page.on('pageerror', e => errors.push(e.stack || e.message));
    await expect(page.getByRole('heading', { name: /每一本书，.*都是一个世界。/ })).toBeVisible();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, temp);
    const books = await page.evaluate(async () => {
      const names = ['远山来信', '海边的慢时光', '青溪长歌', '长夜有灯', '风经过的地方', '月落旧庭', '云端档案'];
      const projects = [];
      for (const name of names) projects.push(await window.novelCompiler.createProject(name));
      return projects;
    });
    await page.reload();
    await expect(page.locator('.library-book')).toHaveCount(5);
    await page.getByRole('textbox', { name: '搜索书库' }).fill('青溪');
    await expect(page.locator('.library-book')).toHaveCount(1);
    await page.getByRole('textbox', { name: '搜索书库' }).fill('');
    await page.getByRole('button', { name: '选择《青溪长歌》', exact: true }).click();
    await fs.mkdir(output, { recursive: true });
    await page.screenshot({ animations: 'disabled', path: path.join(output, '01-library.png') });
    await page.locator('.library-enter').click();
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await page.evaluate(async () => (await window.novelCompiler.getProject())?.name)).toBe('青溪长歌');
    await expect(page.getByRole('navigation', { name: '编译器导航' })).toBeVisible();
    const sourcePath = path.join(temp, '青溪长歌.txt');
    await fs.writeFile(sourcePath, '第一章 雨停之后\n\n雨是午后停的。檐角最后一滴水落进石阶的凹处，晕开一个很小的圆。\n\n林舟推开窗。对岸的白墙被雨洗得干净，远处有人撑着一把尚未收起的伞，慢慢走过石桥。\n\n“雨停了。要一起去桥边走走吗？”\n\n第二章 沿河而行\n\n于是他们沿着河岸出发。水面很平，偶尔有风经过，才泛起细细的涟漪。\n', 'utf8');
    await app.evaluate(({ dialog }, source) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] }); }, sourcePath);
    await page.getByRole('button', { name: '导入 TXT', exact: true }).click();
    await expect(page.getByRole('heading', { name: '确认文本编码' })).toBeVisible();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await expect(page.getByRole('button', { name: '章节与段落' })).toBeEnabled();
    await expect.poll(() => page.evaluate(async () => (await window.novelCompiler.getProject())?.activeRevisionId)).toBeTruthy();
    await page.screenshot({ animations: 'disabled', path: path.join(output, '02-compiler.png') });
    await page.getByRole('button', { name: '章节与段落' }).click();
    await expect(page.locator('.paragraphs p').first()).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: path.join(output, '06-source-reading.png') });
    await page.getByRole('button', { name: 'API 设置' }).click();
    await page.getByRole('button', { name: '← 书库', exact: true }).click();
    await expect(page.locator('.library-book.selected')).toHaveAttribute('aria-label', '选择《青溪长歌》');
    await page.locator('.library-enter').click();
    await expect(page.getByRole('button', { name: 'API 设置' })).toHaveClass(/active/);
    const library = await page.evaluate(() => window.novelCompiler.listProjectLibrary());
    expect(library).toHaveLength(7);
    expect(library.map(b => b.id)).toEqual(expect.arrayContaining(books.map(b => b!.id)));
    expect(errors).toEqual([]);
  } finally { await app.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('SillyTavern separates settings and reading while preserving the draft and native controls', async () => {
  test.setTimeout(180_000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-reading-ui-'));
  const app = await electron.launch({ ...(process.env.NOVEL_COMPILER_PACKAGED_EXE ? { executablePath: path.resolve(process.env.NOVEL_COMPILER_PACKAGED_EXE) } : { args: [path.resolve('.')] }), env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(temp, 'data'), ...(process.env.NOVEL_COMPILER_PACKAGED_EXE ? {} : { NOVEL_COMPILER_SILLYTAVERN_ROOT: path.resolve('vendor/sillytavern') }) } });
  async function view<T>(code: string): Promise<T> {
    return app.evaluate(async ({ BrowserWindow }, script) => {
      const target = BrowserWindow.getAllWindows()[0].getBrowserViews()[0];
      return target ? target.webContents.executeJavaScript(script) : null;
    }, code) as Promise<T>;
  }
  async function capture(name: string) {
    await view('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.capturePage()).toPNG().toString('base64'));
    await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, name), Buffer.from(png, 'base64'));
  }
  try {
    const page = await app.firstWindow();
    await page.locator('.tavern-door').click();
    await expect.poll(() => view<boolean>('Boolean(document.querySelector("#nw-bar"))'), { timeout: 120_000 }).toBe(true);
    expect(await view<boolean>('document.body.classList.contains("nw-reading")')).toBe(true);
    await capture('03-reading.png');
    expect(await view<string>('getComputedStyle(document.querySelector("#top-bar")).display')).toBe('none');
    await view('document.querySelector("#send_textarea").value = "测试草稿，切换页面后应保留"; document.querySelector("#nw-settings").click()');
    expect(await view<boolean>('document.body.classList.contains("nw-settings")')).toBe(true);
    expect(await view<string>('document.querySelector(".nw-selected-panel").id')).toBe('rm_api_block');
    expect(await view<string>('getComputedStyle(document.querySelector(".nw-selected-panel")).display')).toBe('block');
    await capture('04-settings.png');
    expect(await view<string>('getComputedStyle(document.querySelector("#chat .mes_text")).visibility')).toBe('hidden');
    await view('document.querySelector("[data-category=nw-effects]").click()');
    expect(await view<boolean>('!document.querySelector("#nw-effect-panel").hidden')).toBe(true);
    expect(await view<string>('getComputedStyle(document.querySelector("#rm_api_block")).display')).toBe('none');
    await capture('05-effects.png');
    await view('document.querySelector("#nw-read").click()');
    expect(await view<string>('document.querySelector("#send_textarea").value')).toBe('测试草稿，切换页面后应保留');
    expect(await view<number>('document.querySelector(".nw-whale").getBoundingClientRect().width')).toBe(38);
    await view('document.querySelector("#ai-config-button .drawer-toggle").click()');
    await expect.poll(() => view<string>('document.querySelector(".nw-selected-panel")?.id')).toBe('left-nav-panel');
    await view('document.querySelector("#nw-read").click(); const text = document.querySelector(".mes_text"); const bounds = text.getBoundingClientRect(); text.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: bounds.x + 100, clientY: bounds.y + 30, pointerType: "mouse" }))');
    await expect.poll(() => view<string>('document.querySelector(".mes_text").style.filter')).toMatch(/url/);
    await view('document.querySelector(".mes_text").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))');
    expect(await view<string>('document.querySelector(".mes_text").style.filter')).toBe('');
    await view('document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))');
    await view('document.querySelector("#nw-settings").click(); document.querySelector("#nw-native").click()');
    expect(await view<boolean>('!document.body.classList.contains("nw-theme")')).toBe(true);
    await view('document.querySelector("#nw-native-return").click()');
    expect(await view<boolean>('document.body.classList.contains("nw-reading")')).toBe(true);
  } finally { await app.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
