import { expect, type ElectronApplication, type Page } from '@playwright/test';

export async function checkPlayModeRoundtrip(app: ElectronApplication, page: Page, narratorChat: string, checkCharacterRequest: () => Promise<void>) {
  const inspect = () => app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`(async () => {
    const context=(await import('/scripts/st-context.js')).getContext();
    return {chat:context.chatId,mode:context.chatMetadata.novel_world_compiler.mode,
      name:context.characters[context.characterId].name,history:context.chat.map(item=>item.mes)};
  })()`));
  const prepare = async () => {
    await page.getByRole('button', {name:'← 小说世界',exact:true}).click();
    await page.getByRole('button', {name:'打开这本书'}).click();
    await page.getByRole('button', {name:'进入沉浸阅读'}).click();
    await expect(page.getByLabel('游玩模式')).toBeVisible({timeout:30000});
  };
  const launch = async () => {
    await page.getByRole('button', {name:'开始／继续游玩'}).click();
    await expect.poll(() => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].getBrowserViews().length),{timeout:60000}).toBe(1);
  };
  await prepare();
  await page.getByLabel('游玩模式').selectOption('character');
  await page.getByLabel('AI 扮演的人物').selectOption({label:'方源'});
  await page.getByLabel('姓名',{exact:true}).fill('方源');
  await expect(page.getByRole('button',{name:'开始／继续游玩'})).toBeDisabled();
  await page.getByLabel('姓名',{exact:true}).fill('测试旅人');
  await launch();
  const character = await inspect();
  expect(character.mode).toBe('character'); expect(character.name).toBe('方源');
  expect(character.chat).not.toBe(narratorChat);
  expect(character.history).not.toContain('隔离验收：保留这条历史。');
  await checkCharacterRequest();
  await prepare();
  await page.getByLabel('游玩模式').selectOption('narrator');
  await launch();
  const restored = await inspect();
  expect(restored.mode).toBe('narrator'); expect(restored.chat).toBe(narratorChat);
  expect(restored.history).toContain('隔离验收：保留这条历史。');
}
