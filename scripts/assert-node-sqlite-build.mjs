import fs from 'node:fs';
import path from 'node:path';

const workerPath = path.resolve('dist-electron', 'worker', 'index.cjs');
if (!fs.existsSync(workerPath)) {
  throw new Error('Electron worker 构建产物不存在：' + workerPath);
}

const output = fs.readFileSync(workerPath, 'utf8');
const preservesNodeBuiltin = output.includes('["node", "sqlite"].join(":")')
  || output.includes("['node', 'sqlite'].join(':')")
  || output.includes('node:sqlite');
const importsBareSqlite = /\brequire\(["']sqlite["']\)/u.test(output)
  || /\bimport\(["']sqlite["']\)/u.test(output);

if (!preservesNodeBuiltin || importsBareSqlite) {
  throw new Error('Electron worker 的 node:sqlite 引用在构建时被错误改写');
}

console.log('Electron worker node:sqlite build assertion passed.');
