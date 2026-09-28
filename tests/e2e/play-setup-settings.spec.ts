import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('the reading setup selects a bounded location and opens all three settings pages', async () => {
  test.setTimeout(240_000);
  const sample = process.env.NOVEL_REDESIGN_SAMPLE;
  test.skip(!sample, 'Requires the protected paid-project copy');
  if (!sample!.includes('.codex-redesign-audit')) throw new Error('Only the protected copy may be used');
  const output = path.join(path.dirname(sample!), `setup-settings-acceptance-${Date.now()}`);
  const userData = path.join(output, 'user-data');
  await fs.mkdir(userData, { recursive: true });
  const project = JSON.parse(await fs.readFile(path.join(sample!, 'project.json'), 'utf8'));
  await fs.writeFile(path.join(userData, 'project-library.json'), JSON.stringify([{
    id: project.projectId, name: project.name, rootPath: sample,
    activeRevisionId: 'rev_48ce2ab34678c265e8997545c46b3005', createdAt: project.createdAt, updatedAt: project.createdAt,
  }]));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string')),
    NOVEL_COMPILER_USER_DATA: userData, NOVEL_COMPILER_SILLYTAVERN_ROOT: path.resolve('vendor/sillytavern'), NODE_ENV: 'test' };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.NOVEL_PACKAGED_EXECUTABLE;
  if (executablePath) delete env.NOVEL_COMPILER_SILLYTAVERN_ROOT;
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [path.resolve('.')], env });
  try {
    const page = await app.firstWindow();
    const read = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0]
      .webContents.executeJavaScript(`(async () => ({ heading: document.getElementById('nw-setting-title')?.textContent,
        settings: document.body.classList.contains('nw-settings'),
        marker: (await import('/scripts/st-context.js')).getContext().chatMetadata.novel_world_compiler }))()`, true));
    for (const [button, heading] of [
      ['进入并打开模型连接', '模型连接'],
      ['进入并打开游玩调节', '游玩调节'],
      ['进入并打开其他设置', '提示词与上下文'],
    ]) {
      await page.getByRole('button', { name: '打开这本书' }).click();
      await page.getByRole('button', { name: '进入沉浸阅读' }).click();
      await expect(page.getByRole('heading', { name: '选择进入故事的时刻' })).toBeVisible({ timeout: 30000 });
      await expect(page.getByLabel('进入时间', { exact: true })).toBeEnabled({ timeout: 60000 });
      expect(await page.getByLabel('进入时间', { exact: true }).locator('option').count()).toBeGreaterThan(0);
      const place = page.getByLabel('玩家选择的开场地点');
      await expect.poll(() => place.locator('option').count(), { timeout: 30000 }).toBeGreaterThan(1);
      if (!(await place.inputValue())) await place.selectOption({ index: 1 });
      const selectedPlace = await place.locator('option:checked').textContent();
      const name = page.getByLabel('姓名', { exact: true });
      if (!(await name.inputValue())) await name.fill('设置验收旅人');
      await page.getByRole('button', { name: button }).click();
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews().length), { timeout: 120000 }).toBe(1);
      await expect.poll(async () => (await read()).heading, { timeout: 30000 }).toBe(heading);
      const state = await read();
      expect(state.settings).toBe(true);
      expect(state.marker.starting_scene.chosenLocation.name).toBe(selectedPlace);
      await page.getByRole('button', { name: '← 小说世界' }).click();
    }
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ settings: ['模型连接', '游玩调节', '提示词与上下文'], locationSelected: true }, null, 2));
  } finally { await app.close(); }
});
