import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { withIsolatedSillyTavern } from './helpers/isolated-sillytavern';

type Entry = { uid: number; comment: string; key: string[]; keysecondary: string[]; selective: boolean;
  extensions?: { novel_world_compiler?: { entry_kind?: string } } };
type Book = { token_budget: number; entries: Record<string, Entry> };

test.use({ browserName: 'chromium', launchOptions: {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
} });

test('measures real SillyTavern worldbook activation for three play profiles without model calls', async ({ browser }) => {
  const inputDirectory = process.env.NOVEL_WORLD_ITEMIZATION_DIR;
  test.skip(!inputDirectory, 'Run explicitly against an isolated project copy with exported session worldbooks');
  test.setTimeout(300_000);
  const profiles = ['low', 'medium', 'high'] as const;
  const books = await Promise.all(profiles.map(async profile => JSON.parse(await fs.readFile(
    path.join(inputDirectory!, `session-worldbook-${profile}.json`), 'utf8')) as Book));
  const relation = Object.values(books[0].entries).find(entry => entry.extensions?.novel_world_compiler?.entry_kind === 'relationship'
    && entry.key[0] && entry.keysecondary[0] && entry.key[0] !== entry.keysecondary[0]);
  const place = Object.values(books[0].entries).find(entry => entry.extensions?.novel_world_compiler?.entry_kind === 'place'
    && entry.key[0]);
  expect(relation).toBeDefined();
  expect(place).toBeDefined();
  const primary = relation!.key[0], secondary = relation!.keysecondary[0];
  const stressText = Object.values(books[0].entries).filter(entry => entry.key[0])
    .slice(0, 80).flatMap(entry => [...entry.key, ...entry.keysecondary]).join('，');
  const cases = [
    { id: 'single-person', text: `${primary}站在街口。` },
    { id: 'two-people', text: `${primary}与${secondary}在街口交谈。` },
    { id: 'place', text: `我来到${place!.key[0]}。` },
    { id: 'crowded', text: stressText },
  ];
  const tempRoot = path.join(inputDirectory!, 'sillytavern-itemization');
  await fs.mkdir(tempRoot, { recursive: true });
  const acceptance = await withIsolatedSillyTavern(tempRoot, async ({ baseUrl, version }) => {
    const worldIds = [];
    for (const [index, profile] of profiles.entries()) {
      const worldId = `nw-itemization-${profile}`;
      const form = new FormData();
      form.append('avatar', new Blob([JSON.stringify(books[index])], { type: 'application/json' }), `${worldId}.json`);
      const imported = await fetch(`${baseUrl}/api/worldinfo/import`, { method: 'POST', body: form });
      expect(imported.ok).toBe(true);
      worldIds.push(worldId);
    }
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForSelector('#world_info', { state: 'attached', timeout: 90_000 });
    const results = await page.evaluate(async ({ worldIds, budgets, cases }) => {
          type ScanEntry = { uid: number; comment: string; content: string; key: string[]; keysecondary: string[] };
          type ScanResult = { allActivatedEntries: Set<ScanEntry>; worldInfoBefore: string; worldInfoAfter: string };
          const world = await (Function('return import("/scripts/world-info.js")')() as Promise<{
            setWorldInfoSettings: (settings: unknown, data: unknown) => void;
            getSortedEntries: () => Promise<ScanEntry[]>;
            checkWorldInfo: (chat: string[], maxContext: number, isDryRun: boolean) => Promise<ScanResult>;
          }>);
          const tokenizer = await (Function('return import("/scripts/tokenizers.js")')() as Promise<{
            getTokenCountAsync: (value: string) => Promise<number>;
          }>);
          const results = [];
          for (const [index, worldId] of worldIds.entries()) {
            const budget = budgets[index];
            world.setWorldInfoSettings({ world_info: [worldId], world_info_budget: 25,
              world_info_budget_cap: budget, world_info_recursive: false }, { world_names: worldIds });
            const loaded = await world.getSortedEntries();
            const scans = [];
            for (const item of cases) {
              const result = await world.checkWorldInfo([item.text], 8192, true);
              const injected = result.worldInfoBefore + result.worldInfoAfter;
              scans.push({ id: item.id, activated: [...result.allActivatedEntries].map(entry => ({
                uid: entry.uid, comment: entry.comment, content: entry.content,
                key: entry.key, keysecondary: entry.keysecondary,
              })), injectedTokens: await tokenizer.getTokenCountAsync(injected), injectedChars: injected.length });
            }
            results.push({ budget, loadedEntries: loaded.length, scans });
          }
          const { chat_metadata } = await (Function('return import("/script.js")')() as Promise<{
            chat_metadata: Record<string, unknown>;
          }>);
          const previousMarker = chat_metadata.novel_world_compiler;
          const previousWarning = (window as typeof window & { toastr: { warning: (...args: unknown[]) => unknown } }).toastr.warning;
          let overflowAlerts = 0;
          try {
            chat_metadata.novel_world_compiler = { assembly_version: 'session-assembly.v1' };
            (window as typeof window & { toastr: { warning: (...args: unknown[]) => unknown } }).toastr.warning = (...args) => {
              if (String(args[0]).includes('World info budget reached')) overflowAlerts += 1;
              return undefined;
            };
            world.setWorldInfoSettings({ world_info: [worldIds[0]], world_info_budget: 25,
              world_info_budget_cap: 16, world_info_recursive: false, world_info_overflow_alert: false },
            { world_names: worldIds });
            await world.checkWorldInfo([cases.find(item => item.id === 'crowded')!.text], 8192, true);
          } finally {
            chat_metadata.novel_world_compiler = previousMarker;
            (window as typeof window & { toastr: { warning: (...args: unknown[]) => unknown } }).toastr.warning = previousWarning;
          }
          return { results, overflowAlerts };
        }, { worldIds, budgets: books.map(book => book.token_budget), cases });
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    return { version, relation: { uid: relation!.uid, primary, secondary }, place: place!.key[0],
      overflowAlerts: results.overflowAlerts,
      results: results.results.map((result, index) => ({ profile: profiles[index], ...result })) };
  });
  expect(acceptance.result.overflowAlerts).toBeGreaterThan(0);
  for (const profile of acceptance.result.results) {
    expect(profile.loadedEntries).toBeGreaterThan(0);
    const single = profile.scans.find(item => item.id === 'single-person')!;
    expect(single.activated.some(entry => entry.comment === relation!.comment)).toBe(false);
    const pair = profile.scans.find(item => item.id === 'two-people')!;
    expect(pair.activated.some(entry => entry.comment === relation!.comment)).toBe(true);
    expect(pair.activated.filter(entry => entry.comment === relation!.comment)).toHaveLength(1);
    expect(pair.activated.some(entry => entry.comment.startsWith('关系社区：'))).toBe(false);
    for (const scan of profile.scans) {
      expect(scan.injectedTokens).toBeLessThanOrEqual(profile.budget);
      const signatures = scan.activated.map(entry => JSON.stringify([entry.key, entry.keysecondary, entry.content]));
      expect(new Set(signatures).size).toBe(signatures.length);
    }
  }
  await fs.writeFile(path.join(inputDirectory!, 'sillytavern-worldbook-itemization-result.json'),
    JSON.stringify(acceptance.result, null, 2), 'utf8');
});
