import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import iconv from 'iconv-lite';

const DEFAULT_SOURCE = 'D:\\小说\\开局长生苟在下界吃土飞升_1-500章.txt';
const SAMPLE_CHAPTERS = 10;

test('validates the full configured novel through the production desktop without calling a model', async () => {
  test.skip(process.env.RUN_FULL_NOVEL_DESKTOP_CHECK !== '1', 'Explicit local full-novel desktop acceptance only');
  test.setTimeout(180_000);

  const sourcePath = process.env.LIVE_LONG_NOVEL_SOURCE || DEFAULT_SOURCE;
  await fs.access(sourcePath);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-full-desktop-'));
  const projectName = '五百章桌面验收';
  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const app = await electron.launch({ args: [path.resolve('.')], env: { ...process.env, NODE_ENV: 'test' } });
  try {
    await app.evaluate(({ dialog }, locations) => {
      Object.assign(dialog, {
        showOpenDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          return { canceled: false, filePaths: [options?.title?.includes('TXT') ? locations.sourcePath : locations.tempRoot] };
        },
      });
    }, { tempRoot, sourcePath });
    const page = await app.firstWindow();

    await page.locator('.create-row input').fill(projectName);
    await page.getByRole('button', { name: '新建工程' }).click();
    await expect(page.getByRole('heading', { name: '工程总览' })).toBeVisible({ timeout: 20_000 });

    const importStartedAt = Date.now();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await expect(page.getByRole('heading', { name: '确认文本编码' })).toBeVisible();
    await expect(page.locator('.encoding-list button.active')).toContainText(/GB18030|GBK/u);
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await expect(page.getByText('小说导入完成，结构化底稿已经建立')).toBeVisible({ timeout: 60_000 });
    timings.importMs = Date.now() - importStartedAt;

    const chunkStartedAt = Date.now();
    await page.getByRole('button', { name: '分析分块' }).click();
    await page.getByRole('button', { name: '生成新方案' }).click();
    await expect(page.getByText('新的分块方案已经生成')).toBeVisible({ timeout: 30_000 });
    timings.chunkMs = Date.now() - chunkStartedAt;
    await page.getByRole('button', { name: '查看分块 #1 原文' }).click();
    await expect(page.getByRole('heading', { name: /原文范围/u })).toBeVisible();
    const coreParagraphCountInFirstChunk = await page.locator('.chunk-source-paragraph.core').count();
    expect(coreParagraphCountInFirstChunk).toBeGreaterThan(0);

    await page.getByRole('button', { name: '工程诊断' }).click();
    await expect(page.getByRole('heading', { name: '工程诊断' })).toBeVisible();
    await expect(page.getByText('全部正常')).toBeVisible({ timeout: 20_000 });
    const strictStartedAt = Date.now();
    await page.getByRole('button', { name: '运行严格检查' }).click();
    await expect(page.getByText('严格工程检查完成')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('匹配', { exact: true })).toBeVisible();
    timings.strictDiagnosticsMs = Date.now() - strictStartedAt;

    const [chapters, chunks, diagnostics] = await Promise.all([
      page.evaluate(() => window.novelCompiler.listChapters()),
      page.evaluate(() => window.novelCompiler.listChunks()),
      page.evaluate(() => window.novelCompiler.runProjectDiagnostics('full')),
    ]);
    expect(chapters).toHaveLength(500);
    expect(chunks.length).toBeGreaterThan(0);
    expect(diagnostics).toMatchObject({
      overallStatus: 'ok',
      paragraphCount: 23_786,
      ftsRowCount: 23_786,
      foreignKeyViolationCount: 0,
      source: { originalExists: true, normalizedExists: true, checksumMatches: true },
    });

    await fs.mkdir(path.resolve('verification-results'), { recursive: true });
    await fs.writeFile(path.resolve('verification-results', 'full-novel-desktop-acceptance-result.json'), JSON.stringify({
      sourcePath,
      projectRoot: path.join(tempRoot, projectName + '.novelworld'),
      chapterCount: chapters.length,
      chunkCount: chunks.length,
      coreParagraphCountInFirstChunk,
      diagnostics,
      timings,
      totalElapsedMs: Date.now() - startedAt,
      modelApiCalled: false,
    }, null, 2), 'utf8');
  } finally {
    await app.close();
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('probes the first ten chapters of the configured long novel with GLM 5.3', async () => {
  test.skip(process.env.RUN_LIVE_LONG_NOVEL_PROBE !== '1', 'Explicit opt-in only; consumes several completion requests');
  test.setTimeout(900_000);

  const sourcePath = process.env.LIVE_LONG_NOVEL_SOURCE || DEFAULT_SOURCE;
  const sourceBytes = await fs.readFile(sourcePath);
  const decoded = iconv.decode(sourceBytes, 'gb18030');
  const lines = decoded.split(/\r?\n/u);
  const chapterPattern = /^\s*第\s*[〇零一二三四五六七八九十百千万两0-9]+\s*章(?:\s|$)/u;
  const chapterLineIndexes = lines.flatMap((line, index) => chapterPattern.test(line) ? [index] : []);
  expect(chapterLineIndexes.length).toBeGreaterThanOrEqual(SAMPLE_CHAPTERS);
  const sampleEndLine = chapterLineIndexes[SAMPLE_CHAPTERS] ?? lines.length;
  const sampleText = lines.slice(0, sampleEndLine).join('\n').trimEnd();

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-live-long-probe-'));
  const samplePath = path.join(tempRoot, '开局长生前十章-UTF8.txt');
  const projectName = '开局长生前十章-GLM53探针';
  const projectRoot = path.join(tempRoot, `${projectName}.novelworld`);
  await fs.writeFile(samplePath, sampleText, 'utf8');

  const startedAt = Date.now();
  const app = await electron.launch({ args: [path.resolve('.')], env: { ...process.env, NODE_ENV: 'test' } });
  const electronStderr: string[] = [];
  app.process().stderr?.on('data', (chunk) => electronStderr.push(String(chunk)));
  app.process().on('exit', (code, signal) => electronStderr.push(`[probe] Electron exit code=${code} signal=${signal}\n`));
  let result: Record<string, unknown> = {};
  try {
    await app.evaluate(({ dialog }, locations) => {
      Object.assign(dialog, {
        showOpenDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          return { canceled: false, filePaths: [options?.title?.includes('TXT') ? locations.samplePath : locations.tempRoot] };
        },
      });
    }, { tempRoot, samplePath });

    const page = await app.firstWindow();
    page.on('close', () => electronStderr.push('[probe] main page closed\n'));
    const status = await page.evaluate(() => window.novelCompiler.getApiStatus());
    expect(status.configured).toBe(true);
    expect(status.preferredModel?.toLowerCase()).toContain('glm-5.3');

    const created = await page.evaluate((name) => window.novelCompiler.createProject(name), projectName)
      .catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}
Electron stderr:
${electronStderr.join('').slice(-8000)}`);
      });
    expect(created).not.toBeNull();
    expect(created!.rootPath).toBe(projectRoot);
    const imported = await page.evaluate(({ source }) => window.novelCompiler.runImport(source, 'utf8'), { source: samplePath });
    expect(imported.revisionId).toMatch(/^rev_/u);

    const chunks = await page.evaluate(() => window.novelCompiler.buildChunks({
      coreChars: 8_000,
      softLimit: 10_000,
      hardLimit: 12_000,
      overlapBefore: 500,
      overlapAfter: 500,
    }));
    const chapters = await page.evaluate(() => window.novelCompiler.listChapters());
    const estimate = await page.evaluate(() => window.novelCompiler.estimateCharacterScan());
    expect(estimate.ready).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);

    const scanStartedAt = Date.now();
    const scan = await page.evaluate((model) => window.novelCompiler.startCharacterScan({
      model,
      promptVersion: 'character-scan.v1',
    }), status.preferredModel!);
    const completedJob = await expect.poll(async () => page.evaluate(async (jobId) =>
      (await window.novelCompiler.listJobs()).find((job) => job.id === jobId), scan.jobId), {
      timeout: 720_000,
      intervals: [1_000, 2_000, 3_000, 5_000],
    }).toMatchObject({ state: 'completed' });
    void completedJob;

    const characters = await page.evaluate(() => window.novelCompiler.listCharacters());
    expect(characters.length).toBeGreaterThan(0);
    const characterDetails = [];
    for (const character of characters) {
      const [mentions, aliases] = await Promise.all([
        page.evaluate((identityId) => window.novelCompiler.listCharacterMentions(identityId), character.id),
        page.evaluate((identityId) => window.novelCompiler.listCharacterAliases(identityId), character.id),
      ]);
      characterDetails.push({
        name: character.canonicalName,
        importanceScore: character.importanceScore,
        mentionCount: character.mentionCount,
        evidenceCount: mentions.length,
        exactEvidenceCount: mentions.filter((mention) => mention.alignmentStatus === 'exact').length,
        normalizedEvidenceCount: mentions.filter((mention) => mention.alignmentStatus === 'normalized').length,
        aliases: aliases.map((alias) => alias.alias),
        uncertainty: character.uncertainty,
      });
    }

    result = {
      sourcePath,
      sourceBytes: sourceBytes.length,
      detectedFullChapterHeadings: chapterLineIndexes.length,
      sampleChapters: SAMPLE_CHAPTERS,
      sampleCharacters: sampleText.length,
      importedChapters: chapters.length,
      chunkCount: chunks.length,
      estimatedInputTokens: estimate.approximateInputTokens,
      provider: status.provider,
      model: status.preferredModel,
      candidateCount: characters.length,
      totalEvidenceCount: characterDetails.reduce((sum, item) => sum + item.evidenceCount, 0),
      scanElapsedMs: Date.now() - scanStartedAt,
      candidates: characterDetails.sort((left, right) => right.importanceScore - left.importanceScore).slice(0, 30),
    };
  } catch (error) {
    const diagnostics = electronStderr.join('').slice(-16_000);
    await fs.mkdir(path.resolve('test-results'), { recursive: true });
    await fs.writeFile(path.resolve('test-results', 'live-long-novel-probe-stderr.log'), diagnostics, 'utf8');
    throw new Error(`${error instanceof Error ? error.stack ?? error.message : String(error)}
Electron diagnostics:
${diagnostics}`);
  } finally {
    await app.close();
  }

  const database = new DatabaseSync(path.join(projectRoot, 'novel.db'), { readOnly: true });
  const run = database.prepare(`SELECT status, total_chunks, completed_chunks, input_tokens, output_tokens
    FROM character_scan_runs ORDER BY created_at DESC LIMIT 1`).get() as Record<string, string | number | bigint | null> | undefined;
  database.close();
  result = {
    ...result,
    runStatus: run?.status,
    totalChunks: Number(run?.total_chunks ?? 0),
    completedChunks: Number(run?.completed_chunks ?? 0),
    inputTokens: Number(run?.input_tokens ?? 0),
    outputTokens: Number(run?.output_tokens ?? 0),
    totalElapsedMs: Date.now() - startedAt,
  };

  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  await fs.writeFile(path.resolve('test-results', 'live-long-novel-probe-result.json'), JSON.stringify(result, null, 2), 'utf8');
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
