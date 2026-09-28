import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { CALIBRATION_CLAIM_DEFINITIONS } from '../../scripts/lib/calibration-dry-run';
import { buildSillyTavernReplayFixture, compareSillyTavernReplay } from '../../scripts/lib/sillytavern-native-replay';
import { withIsolatedSillyTavern } from './helpers/isolated-sillytavern';

test('replays Stage 2 receipts through native SillyTavern Chinese keyword activation', async () => {
  test.skip(process.env.RUN_SILLYTAVERN_CONTEXT_REPLAY !== '1', 'Explicit isolated SillyTavern context replay only');
  test.setTimeout(240_000);
  const calibrationRoot = path.resolve('verification-results/real-quality-review/scene-calibration-46f60d706fb1');
  const run = JSON.parse(await fs.readFile(path.join(calibrationRoot, 'dry-run-context-v1.json'), 'utf8')) as { runId: string; receipts: unknown[] };
  const fixtures = run.receipts.map((receipt, index) => {
    const fixture = buildSillyTavernReplayFixture(receipt, `校准中文入口${String(index + 1).padStart(2, '0')}号`);
    const forbidden = fixture.excludedClaimIds.map((claimId) => {
      const definition = CALIBRATION_CLAIM_DEFINITIONS[claimId];
      if (!definition) throw new Error(`找不到禁入命题文本：${claimId}`);
      return { claimId, text: definition.text };
    });
    return { fixture, forbidden };
  });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sillytavern-context-replay-'));
  let isolatedDataRoot = '';
  try {
    const acceptance = await withIsolatedSillyTavern(tempRoot, async ({ baseUrl, dataRoot, version }) => {
      isolatedDataRoot = dataRoot;
      const browser = await chromium.launch({ channel: 'msedge', headless: true });
      try {
        const page = await browser.newPage();
        let initialDocumentSeen = false;
        await page.route('**/*', async (route) => {
          const request = route.request();
          if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            if (initialDocumentSeen) return route.abort('aborted');
            initialDocumentSeen = true;
          }
          return route.continue();
        });
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(async () => {
          const eventsUrl = '/scripts/events.js';
          const events = await import(eventsUrl) as {
            eventSource: { autoFireLastArgs: Map<string, unknown> };
            event_types: { APP_READY: string };
          };
          return events.eventSource.autoFireLastArgs.has(events.event_types.APP_READY);
        }, undefined, { timeout: 90_000 });
        const firstBook = fixtures[0].fixture.card.data.character_book;
        if (!firstBook) throw new Error('回放夹具缺少 Character Book');
        let nextEntryId = 0;
        const combinedBook = {
          ...firstBook,
          name: 'NWC全部上下文回放',
          entries: fixtures.flatMap((item) => {
            const entries = item.fixture.card.data.character_book?.entries ?? [];
            return entries.map((entry) => ({ ...entry, id: nextEntryId++ }));
          }),
        };
        const outputs = await page.evaluate(async ({ characterBook, bookName, triggers }) => {
            const worldInfoUrl = '/scripts/world-info.js';
            const worldInfo = await import(worldInfoUrl) as {
              world_names: string[];
              convertCharacterBook: (book: unknown) => unknown;
              updateWorldInfoList: () => Promise<void>;
              setWorldInfoSettings: (settings: Record<string, unknown>, data: { world_names: string[] }) => void;
              getWorldInfoPrompt: (chat: string[], maxContext: number, isDryRun: boolean) => Promise<{ worldInfoString: string }>;
            };
            const response = await fetch('/api/worldinfo/edit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: bookName, data: worldInfo.convertCharacterBook(characterBook) }),
            });
            if (!response.ok) throw new Error(`World Info 写入失败：HTTP ${response.status}`);
            await worldInfo.updateWorldInfoList();
            worldInfo.setWorldInfoSettings({
              world_info: [bookName],
              world_info_depth: 4,
              world_info_budget: 100,
              world_info_budget_cap: 4096,
              world_info_recursive: false,
              world_info_case_sensitive: false,
              world_info_match_whole_words: false,
            }, { world_names: worldInfo.world_names });
            const results = [];
            for (const trigger of triggers) results.push(await worldInfo.getWorldInfoPrompt([trigger], 16_384, true));
            return results;
          }, {
            characterBook: combinedBook,
            bookName: `NWC全部回放-${run.runId.slice(0, 8)}`,
            triggers: fixtures.map((item) => item.fixture.trigger),
          });
        const cases = [];
        for (const [index, item] of fixtures.entries()) {
          const actual = outputs[index];
          if (!actual) throw new Error(`SillyTavern 未返回第 ${index + 1} 个入口结果`);
          const diff = compareSillyTavernReplay(item.fixture, actual.worldInfoString, item.forbidden);
          expect(diff, item.fixture.projectionRequestId).toMatchObject({ passed: true });
          cases.push({
            requestId: item.fixture.projectionRequestId,
            receiptId: item.fixture.receiptId,
            trigger: item.fixture.trigger,
            ...diff,
            worldInfoString: actual.worldInfoString,
          });
        }
        const expectedEntryCount = cases.reduce((sum, item) => sum + item.expectedEntryCount, 0);
        const actualEntryCount = cases.reduce((sum, item) => sum + item.actualEntryCount, 0);
        return {
          sillyTavernVersion: version,
          mode: 'native-world-info-dry-run',
          nativeFunctions: ['convertCharacterBook', 'setWorldInfoSettings', 'getWorldInfoPrompt'],
          endpoints: ['/api/worldinfo/edit', '/api/settings/get', '/api/worldinfo/get'],
          modelCalls: 0,
          summary: {
            caseCount: cases.length,
            passedCaseCount: cases.filter((item) => item.passed).length,
            failedCaseCount: cases.filter((item) => !item.passed).length,
            expectedEntryCount,
            actualEntryCount,
            missingEntryCount: cases.reduce((sum, item) => sum + item.missingItemIds.length, 0),
            extraEntryCount: cases.reduce((sum, item) => sum + item.extraItemIds.length, 0),
            textMismatchCount: cases.reduce((sum, item) => sum + item.textMismatchItemIds.length, 0),
            orderMismatchCount: cases.filter((item) => !item.orderMatches).length,
            forbiddenLeakCount: cases.reduce((sum, item) => sum + item.forbiddenHits.length, 0),
          },
          cases,
        };
      } finally {
        await browser.close();
      }
    });
    await expect(fs.access(isolatedDataRoot)).rejects.toThrow();
    const payload = {
      format: 'sillytavern-native-context-replay',
      version: '1.0',
      dryRunRunId: run.runId,
      ...acceptance.result,
    };
    const result = { ...payload, resultId: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    await fs.writeFile(path.join(calibrationRoot, 'sillytavern-native-replay-v1.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    const table = [
      '# SillyTavern 原生上下文回放逐入口差异表',
      '',
      `- SillyTavern：${result.sillyTavernVersion}`,
      `- Stage 2 Dry-run：\`${result.dryRunRunId}\``,
      `- 原生回放结果：\`${result.resultId}\``,
      `- 模型调用：${result.modelCalls}`,
      '',
      '| # | 投影请求 | 预期 | 实际 | 缺失 | 额外 | 文本差异 | 顺序 | 禁入泄漏 | 结果 |',
      '|---:|---|---:|---:|---:|---:|---:|---|---:|---|',
      ...result.cases.map((item, index) => `| ${index + 1} | ${item.requestId.replaceAll('|', '\\|')} | ${item.expectedEntryCount} | ${item.actualEntryCount} | ${item.missingItemIds.length} | ${item.extraItemIds.length} | ${item.textMismatchItemIds.length} | ${item.orderMatches ? '一致' : '不一致'} | ${item.forbiddenHits.length} | ${item.passed ? '通过' : '失败'} |`),
      '',
      `汇总：${result.summary.passedCaseCount}/${result.summary.caseCount} 个入口通过；`+
        `预期/实际条目 ${result.summary.expectedEntryCount}/${result.summary.actualEntryCount}；`+
        `缺失 ${result.summary.missingEntryCount}、额外 ${result.summary.extraEntryCount}、文本差异 ${result.summary.textMismatchCount}、`+
        `顺序差异 ${result.summary.orderMismatchCount}、禁入泄漏 ${result.summary.forbiddenLeakCount}。`,
      '',
    ].join('\n');
    await fs.writeFile(path.join(calibrationRoot, 'sillytavern-native-replay-diff-v1.md'), table, 'utf8');
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
