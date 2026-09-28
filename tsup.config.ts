import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { 'main/index': 'electron/main/index.ts' },
    outDir: 'dist-electron',
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: true,
    external: ['electron', 'node:sqlite'],
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    entry: { 'preload/index': 'electron/preload/index.ts' },
    outDir: 'dist-electron',
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    external: ['electron'],
    outExtension: () => ({ js: '.cjs' }),
  },
  {
    entry: { 'worker/index': 'electron/worker/index.ts' },
    outDir: 'dist-electron',
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    external: ['electron', 'node:sqlite'],
    outExtension: () => ({ js: '.cjs' }),
  },
]);
