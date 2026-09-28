import { app, BrowserView, BrowserWindow, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { SillyTavernStatus } from '../../src/shared/contracts';
import type { TavernSessionHandle } from './sillytavern-assembly';

const TAVERN_BAR_HEIGHT = 68;

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function endpointReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 1_500 }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

export class SillyTavernManager {
  private window: BrowserWindow | null = null;
  private view: BrowserView | null = null;
  private child: ChildProcess | null = null;
  private startPromise: Promise<SillyTavernStatus> | null = null;
  private state: SillyTavernStatus['state'] = 'stopped';
  private baseUrl: string | null = null;
  private version: string | null = null;
  private message = '尚未启动';
  private lastLog = '';
  private stopping = false;
  private showRequested = false;

  attachWindow(window: BrowserWindow): void {
    this.window = window;
    window.on('resize', () => this.layout());
    window.on('closed', () => {
      this.window = null;
      this.view = null;
    });
  }

  status(): SillyTavernStatus {
    const runtimeRoot = this.runtimeRoot();
    return {
      state: this.state,
      version: this.version,
      runtimeRoot,
      dataRoot: path.join(app.getPath('userData'), 'sillytavern-data'),
      baseUrl: this.baseUrl,
      pid: this.child?.pid ?? null,
      message: this.message,
      bundled: fs.existsSync(path.join(runtimeRoot, 'server.js')),
    };
  }

  async start(): Promise<SillyTavernStatus> {
    if (this.state === 'ready' && this.child) return this.status();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal().finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async show(): Promise<SillyTavernStatus> {
    this.showRequested = true;
    const status = await this.start();
    if (!this.showRequested || status.state !== 'ready' || !status.baseUrl) return status;
    await this.ensureView(status.baseUrl);
    if (this.window && this.view) {
      this.window.setBrowserView(this.view);
      this.layout();
    }
    return this.status();
  }

  async showSession(handle: TavernSessionHandle, settingsPage?: 'model' | 'tuning' | 'other'): Promise<SillyTavernStatus> {
    // Keep the prior book hidden while switching; a failed switch must not
    // expose an unrelated chat as though the requested book were ready.
    this.hide();
    const status = await this.start();
    if (status.state !== 'ready' || !status.baseUrl) throw new Error(status.message);
    await this.ensureView(status.baseUrl);
    if (!this.view || !this.window) throw new Error('酒馆阅读窗口尚未就绪。');
    const selected = await this.view.webContents.executeJavaScript(`(async () => {
      const deadline = Date.now() + 30000;
      while (!window.novelWorldManagedSession && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!window.novelWorldManagedSession) throw new Error('阅读界面尚未初始化，请稍后重试。');
      return window.novelWorldManagedSession.open(${JSON.stringify(handle)});
    })()`, true) as boolean;
    if (!selected) throw new Error('酒馆没有切换到本书的旁白会话。');
    if (settingsPage) await this.view.webContents.executeJavaScript(
      `window.novelWorldReadingSettings?.open(${JSON.stringify(settingsPage)})`, true);
    this.showRequested = true;
    this.window.setBrowserView(this.view);
    this.layout();
    return this.status();
  }

  hide(): SillyTavernStatus {
    this.showRequested = false;
    if (this.window && this.view) {
      try { this.window.setBrowserView(null); } catch { /* already detached */ }
    }
    return this.status();
  }

  async stop(): Promise<SillyTavernStatus> {
    this.stopping = true;
    this.showRequested = false;
    this.hide();
    if (this.view) {
      this.view.webContents.close();
      this.view = null;
    }
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    this.state = 'stopped';
    this.baseUrl = null;
    this.message = '已停止；聊天数据仍保存在本机独立目录';
    this.stopping = false;
    return this.status();
  }

  private runtimeRoot(): string {
    if (process.env.NOVEL_COMPILER_SILLYTAVERN_ROOT) {
      return path.resolve(process.env.NOVEL_COMPILER_SILLYTAVERN_ROOT);
    }
    return app.isPackaged
      ? path.join(process.resourcesPath, 'sillytavern')
      : path.resolve(process.cwd(), 'vendor', 'sillytavern');
  }

  private async startInternal(): Promise<SillyTavernStatus> {
    this.state = 'starting';
    this.message = '正在准备 SillyTavern 本地运行环境…';
    this.lastLog = '';
    const runtimeRoot = this.runtimeRoot();
    const serverPath = path.join(runtimeRoot, 'server.js');
    const packagePath = path.join(runtimeRoot, 'package.json');
    const modulePath = path.join(runtimeRoot, 'node_modules');
    if (!fs.existsSync(serverPath) || !fs.existsSync(packagePath) || !fs.existsSync(modulePath)) {
      return this.fail(`SillyTavern 运行文件不完整：${runtimeRoot}`);
    }

    try {
      const packageJson = JSON.parse(await fsp.readFile(packagePath, 'utf8')) as { version?: string };
      this.version = packageJson.version ?? null;
      const dataRoot = path.join(app.getPath('userData'), 'sillytavern-data');
      const runtimeDataRoot = path.join(app.getPath('userData'), 'sillytavern-runtime');
      const configPath = path.join(runtimeDataRoot, 'config.yaml');
      const seedRoot = path.join(runtimeRoot, 'initial-data');
      const existingData = await fsp.readdir(dataRoot).catch(() => [] as string[]);
      if (existingData.length === 0 && fs.existsSync(seedRoot)) {
        await fsp.mkdir(path.dirname(dataRoot), { recursive: true });
        await fsp.cp(seedRoot, dataRoot, { recursive: true, force: false });
      }
      await Promise.all([fsp.mkdir(dataRoot, { recursive: true }), fsp.mkdir(runtimeDataRoot, { recursive: true })]);
      if (!fs.existsSync(configPath)) await fsp.copyFile(path.join(runtimeRoot, 'config.yaml'), configPath);
      const port = await findFreePort();
      const baseUrl = `http://127.0.0.1:${port}`;
      const child = spawn(process.execPath, [
        serverPath,
        '--dataRoot', dataRoot,
        '--configPath', configPath,
        '--port', String(port),
        '--browserLaunchEnabled', 'false',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
      ], {
        cwd: runtimeRoot,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.child = child;
      const appendLog = (chunk: Buffer) => {
        this.lastLog = `${this.lastLog}${chunk.toString('utf8')}`.slice(-12_000);
      };
      child.stdout.on('data', appendLog);
      child.stderr.on('data', appendLog);
      child.once('error', (error) => {
        if (this.child !== child) return;
        this.child = null;
        this.fail(`SillyTavern 启动失败：${error.message}`);
      });
      child.once('exit', (code) => {
        if (this.child !== child) return;
        this.child = null;
        if (!this.stopping) this.fail(`SillyTavern 已退出（代码 ${code ?? '未知'}）${this.lastLog ? `\n${this.lastLog.slice(-500)}` : ''}`);
      });

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && this.child === child) {
        if (await endpointReady(baseUrl)) {
          this.baseUrl = baseUrl;
          this.message = 'SillyTavern 服务已启动，正在载入页面…';
          await this.ensureView(baseUrl);
          this.state = 'ready';
          this.message = `本地定制 SillyTavern ${this.version ?? ''} 已在本机运行`;
          return this.status();
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
      if (this.child !== child) return this.status();
      if (!child.killed) child.kill();
      this.child = null;
      return this.fail(`SillyTavern 启动超时${this.lastLog ? `：${this.lastLog.slice(-500)}` : ''}`);
    } catch (error) {
      const child = this.child;
      this.child = null;
      if (child && !child.killed) child.kill();
      return this.fail(error instanceof Error ? error.message : String(error));
    }
  }

  private fail(message: string): SillyTavernStatus {
    this.state = 'error';
    this.message = message;
    this.baseUrl = null;
    return this.status();
  }

  private async ensureView(url: string): Promise<void> {
    if (!this.view) {
      this.view = new BrowserView({
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          partition: 'persist:novel-world-sillytavern',
        },
      });
      this.view.webContents.setWindowOpenHandler(({ url: target }) => {
        if (/^https?:\/\//u.test(target)) void shell.openExternal(target);
        return { action: 'deny' };
      });
      this.view.webContents.on('will-navigate', (event, target) => {
        if (target.startsWith(url) || target === 'about:blank') return;
        event.preventDefault();
        if (/^https?:\/\//u.test(target)) void shell.openExternal(target);
      });
    }
    if (this.view.webContents.getURL().replace(/\/$/u, '') !== url.replace(/\/$/u, '')) await this.view.webContents.loadURL(url);
  }

  private layout(): void {
    if (!this.window || !this.view) return;
    const [width, height] = this.window.getContentSize();
    this.view.setBounds({ x: 0, y: TAVERN_BAR_HEIGHT, width, height: Math.max(0, height - TAVERN_BAR_HEIGHT) });
  }
}
