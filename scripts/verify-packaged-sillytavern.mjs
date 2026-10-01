import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = path.resolve(projectRoot, process.argv[2] ?? path.join('release', 'integrated15'), 'win-unpacked');
const runtimeRoot = path.join(appRoot, 'resources', 'sillytavern');
const executable = path.join(appRoot, '小说世界.exe');
const smokeRoot = path.join(projectRoot, '.codex-redesign-audit', 'packaged-sillytavern-smoke');
const dataRoot = path.join(smokeRoot, 'data');
const configPath = path.join(smokeRoot, 'config.yaml');
const configSource = await fs.stat(path.join(runtimeRoot, 'config.yaml')).then(() => path.join(runtimeRoot, 'config.yaml'))
  .catch(() => path.join(runtimeRoot, 'default', 'config.yaml'));
await Promise.all([fs.access(executable), fs.access(path.join(runtimeRoot, 'server.js')),
  fs.access(path.join(runtimeRoot, 'node_modules', 'express', 'index.js')), fs.access(configSource)]);
await fs.mkdir(dataRoot, { recursive: true });
await fs.copyFile(configSource, configPath);

const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    server.close(error => error ? reject(error) : resolve(address.port));
  });
});
const child = spawn(executable, [path.join(runtimeRoot, 'server.js'), '--dataRoot', dataRoot,
  '--configPath', configPath, '--port', String(port), '--browserLaunchEnabled', 'false',
  '--enableIPv4', 'true', '--enableIPv6', 'false'], {
  cwd: runtimeRoot, windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', chunk => { log = `${log}${chunk}`.slice(-6000); });
child.stderr.on('data', chunk => { log = `${log}${chunk}`.slice(-6000); });
try {
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2000) });
      if (response.status < 500) { ready = true; break; }
    } catch { /* service is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error(`Bundled SillyTavern did not start. Exit ${child.exitCode}. ${log}`);
  console.log(`Bundled SillyTavern HTTP startup passed on port ${port}.`);
} finally {
  child.kill();
}
