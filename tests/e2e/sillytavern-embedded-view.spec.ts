import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('opens the bundled SillyTavern inside the application window', async () => {
  test.setTimeout(150_000);
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'novel-sillytavern-view-'));
  const packagedExecutable = process.env.NOVEL_COMPILER_PACKAGED_EXE;
  const launchOptions = packagedExecutable
    ? {
        executablePath: path.resolve(packagedExecutable),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data'),
        },
      }
    : {
        args: [path.resolve('.')],
        env: {
          ...process.env,
          NODE_ENV: 'test',
          NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data'),
          NOVEL_COMPILER_SILLYTAVERN_ROOT: path.resolve('vendor', 'sillytavern'),
        },
      };

  if (packagedExecutable) {
    test.skip(!fs.existsSync(path.resolve(packagedExecutable)), 'The packaged executable does not exist');
  }

  const app = await electron.launch(launchOptions);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.tavern-door')).toBeVisible();
    await page.locator('.tavern-door').click();

    await expect.poll(
      () => page.evaluate(async () => (await window.novelCompiler.getSillyTavernStatus()).state),
      { timeout: 120_000, intervals: [500, 1_000, 2_000] },
    ).toBe('ready');

    await expect.poll(
      () => app.evaluate(async ({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const view = window?.getBrowserViews()[0];
        if (!view) return { count: 0, url: '', title: '', body: '' };
        const body = await view.webContents.executeJavaScript(
          'document.body?.innerText?.slice(0, 1000) ?? ""',
        ) as string;
        return {
          count: window.getBrowserViews().length,
          url: view.webContents.getURL(),
          title: view.webContents.getTitle(),
          body,
        };
      }),
      { timeout: 30_000, intervals: [250, 500, 1_000] },
    ).toMatchObject({ count: 1 });

    const result = await app.evaluate(async ({ BrowserWindow }) => {
      const view = BrowserWindow.getAllWindows()[0]?.getBrowserViews()[0];
      if (!view) return { url: '', title: '', body: '' };
      return {
        url: view.webContents.getURL(),
        title: view.webContents.getTitle(),
        body: await view.webContents.executeJavaScript(
          'document.body?.innerText?.slice(0, 1000) ?? ""',
        ) as string,
      };
    });
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/?/u);
    expect(`${result.title}\n${result.body}`).toMatch(/SillyTavern|角色|聊天/u);
  } finally {
    await app.close();
    await fsPromises.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
