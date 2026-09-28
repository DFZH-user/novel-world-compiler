import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('selects another confirmed event and a revealed place, then enters the matching story', async () => {
  test.setTimeout(300_000);
  const sample = process.env.NOVEL_REDESIGN_SAMPLE;
  test.skip(!sample, 'Requires the protected project copy');
  if (!sample!.includes('.codex-redesign-audit')) throw new Error('Only the protected project copy may be used');
  const output = path.join(path.dirname(sample!), `alternate-entry-acceptance-${Date.now()}`);
  const userData = path.join(output, 'user-data');
  await fs.mkdir(userData, { recursive: true });
  const project = JSON.parse(await fs.readFile(path.join(sample!, 'project.json'), 'utf8'));
  await fs.writeFile(path.join(userData, 'project-library.json'), JSON.stringify([{
    id: project.projectId, name: project.name, rootPath: sample,
    activeRevisionId: 'rev_48ce2ab34678c265e8997545c46b3005', createdAt: project.createdAt, updatedAt: project.createdAt,
  }]));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((item): item is [string, string] => typeof item[1] === 'string')),
    NOVEL_COMPILER_USER_DATA: userData, NODE_ENV: 'test' };
  if (!process.env.NOVEL_PACKAGED_EXECUTABLE) env.NOVEL_COMPILER_SILLYTAVERN_ROOT = path.resolve('vendor/sillytavern');
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.NOVEL_PACKAGED_EXECUTABLE;
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [path.resolve('.')], env });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '打开这本书' }).click();
    await page.getByRole('button', { name: '进入沉浸阅读' }).click();
    await expect(page.getByLabel('进入时间', { exact: true })).toBeEnabled({ timeout: 90_000 });
    await expect(page.getByText('已确认事件 3358 个', { exact: false })).toBeVisible();
    await page.getByLabel('搜索进入时间').fill('4001');
    const option = page.getByLabel('进入时间', { exact: true }).locator('option').filter({ hasText: '段落 4001 · 方源堵在学堂门口勒索元石' });
    const eventId = await option.getAttribute('value');
    expect(eventId).toBeTruthy();
    await page.getByLabel('进入时间', { exact: true }).selectOption(eventId!);
    await expect(page.getByText('从「方源堵在学堂门口勒索元石」进入', { exact: false })).toBeVisible({ timeout: 90_000 });
    const place = page.getByLabel('玩家选择的开场地点');
    await expect.poll(() => place.locator('option').count(), { timeout: 30_000 }).toBeGreaterThan(1);
    await place.selectOption({ index: 1 });
    const chosenPlace = await place.locator('option:checked').textContent();
    await page.getByLabel('姓名', { exact: true }).fill('另一个时间的旅人');
    await page.getByRole('button', { name: '开始／继续游玩' }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews().length),
      { timeout: 120_000 }).toBe(1);
    const marker = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0]
      .webContents.executeJavaScript(`(async () => (await import('/scripts/st-context.js')).getContext().chatMetadata.novel_world_compiler)()`));
    expect(marker.entry_event_id).toBe(eventId);
    expect(marker.entry_ordinal).toBe(4001);
    expect(marker.starting_scene.chosenLocation.name).toBe(chosenPlace);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ eventId, ordinal: 4001, chosenPlace, marker }, null, 2));
  } finally { await app.close(); }
});
