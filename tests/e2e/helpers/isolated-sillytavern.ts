import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_SILLYTAVERN_SOURCE_ROOT = 'E:\\SillyTavern\\SillyTavern-SillyTavern-51ad27f';

export type IsolatedSillyTavernContext = {
  baseUrl: string;
  dataRoot: string;
  sourceRoot: string;
  version: string;
};

export type IsolatedSillyTavernResult<T> = {
  dataRoot: string;
  result: T;
  sourceRoot: string;
  version: string;
};

export async function withIsolatedSillyTavern<T>(
  tempRoot: string,
  run: (context: IsolatedSillyTavernContext) => Promise<T>,
): Promise<IsolatedSillyTavernResult<T>> {
  const sourceRoot = process.env.SILLYTAVERN_SOURCE_ROOT || DEFAULT_SILLYTAVERN_SOURCE_ROOT;
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8')) as { version: string };
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const address = portProbe.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 SillyTavern 隔离验收端口');
  const port = address.port;
  await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));

  const dataRoot = path.join(tempRoot, 'sillytavern-isolated-data');
  await fs.mkdir(dataRoot, { recursive: true });
  try {
    await fs.cp(path.join(sourceRoot, 'data', '_webpack'), path.join(dataRoot, '_webpack'), { recursive: true });
  } catch {
    // A cold start is slower but remains valid when no reusable webpack cache exists.
  }
  const configPath = path.join(dataRoot, 'isolated-config.yaml');
  const configSource = path.join(sourceRoot, 'config.yaml');
  const isolatedConfig = (await fs.readFile(await fs.access(configSource).then(() => configSource)
    .catch(() => path.join(sourceRoot, 'default', 'config.yaml')), 'utf8'))
    .replace('skipContentCheck: false', 'skipContentCheck: true');
  await fs.writeFile(configPath, isolatedConfig, 'utf8');

  const server = spawn(process.execPath, [
    'server.js', '--dataRoot', dataRoot, '--configPath', configPath, '--port', String(port), '--browserLaunchEnabled', 'false',
    '--disableCsrf', '--enableIPv6', 'false', '--enableIPv4', 'true',
  ], { cwd: sourceRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk.toString(); });
  server.stderr.on('data', (chunk) => { log += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) break;
      try { ready = (await fetch(baseUrl)).ok; } catch { /* startup in progress */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`SillyTavern 隔离实例未就绪：${log.slice(-2_000)}`);

    return {
      dataRoot,
      result: await run({ baseUrl, dataRoot, sourceRoot, version: packageJson.version }),
      sourceRoot,
      version: packageJson.version,
    };
  } finally {
    server.kill();
    await new Promise<void>((resolve) => {
      if (server.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 5_000);
      server.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
