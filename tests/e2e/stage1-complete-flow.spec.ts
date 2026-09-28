import { expect, test, _electron as electron, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:http';
import { SCHEMA_VERSION } from '../../electron/worker/schema';

async function waitForCompletedJob(page: Page, jobId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async (id) => {
    const job = (await window.novelCompiler.listJobs()).find((item) => item.id === id);
    return job ? `${job.state}:${job.message}` : 'missing';
  }, jobId), { timeout: 30_000, intervals: [100, 250, 500] }).toMatch(/^completed:/u);
}

test('runs stage 1 from TXT import through reviewed V2 card and project backup', async () => {
  test.setTimeout(120_000);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-stage1-complete-'));
  const sourcePath = path.join(tempRoot, '完整流程小说.txt');
  const cardPath = path.join(tempRoot, '陆沉-角色卡-v2.json');
  const backupPath = path.join(tempRoot, '阶段一完整流程.novelproj');
  const restoreParent = path.join(tempRoot, '恢复结果');
  const batchDirectory = path.join(tempRoot, '批量导出');
  const requestedTasks: string[] = [];
  await fs.writeFile(sourcePath, [
    '第一章 雨夜归来',
    '二〇二四年三月五日，陆沉回到青石镇。',
    '陆沉，人称小陆，谨慎地观察街道后走进客栈。',
    '陆沉说道：“今夜先在这里休息。”',
    '掌柜周平替陆沉安排了二楼的房间。',
  ].join('\n'), 'utf8');
  await fs.mkdir(restoreParent);

  const apiServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-stage1-model' }] }));
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
        const userContent = body.messages.find((message) => message.role === 'user')!.content;
        if (userContent.includes('【玩家问题】')) {
          requestedTasks.push('character_runtime');
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({
            choices: [{ message: { content: '我是陆沉，大家也叫我小陆。今夜先在这里休息。' } }],
            usage: { prompt_tokens: 180, completion_tokens: 18 },
          }));
          return;
        }
        const payload = JSON.parse(userContent) as {
          task: string;
          paragraphs: Array<{ paragraph_id: string; text: string; role: string }>;
          supplied_characters?: Array<{ identity_id: string; name: string }>;
          supplied_time_expressions?: Array<{ time_expression_id: string; surface_text: string }>;
        };
        requestedTasks.push(payload.task);
        const arrival = payload.paragraphs.find((item) => item.text.includes('回到青石镇'))!;
        const identity = payload.paragraphs.find((item) => item.text.includes('人称小陆'))!;
        const dialogue = payload.paragraphs.find((item) => item.text.includes('今夜先在这里休息'))!;
        let result: unknown;
        if (payload.task === 'character_census') {
          result = {
            characters: [{
              local_key: 'lu_chen', display_name: '陆沉',
              mention_forms: [{ text: '陆沉', kind: 'name' }, { text: '小陆', kind: 'alias' }],
              entity_kind: 'human', role_hints: ['主角候选'], has_dialogue: true, participates_in_event: true,
              evidence: [
                { paragraph_id: identity.paragraph_id, exact_quote: identity.text, supports: 'alias' },
                { paragraph_id: dialogue.paragraph_id, exact_quote: dialogue.text, supports: 'dialogue' },
              ], confidence: 0.99, uncertainty: '',
            }],
            identity_claims: [],
          };
        } else if (payload.task === 'character_fact_extraction') {
          result = { facts: [
            {
              category: 'identity', predicate: '常用称呼', value: '小陆', source_type: 'explicit', confidence: 0.99,
              assertion_mode: 'narrator_assertion', truth_status: 'asserted', attributed_source_name: null,
              visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
              evidence: [{ paragraph_id: identity.paragraph_id, exact_quote: identity.text, role: 'support' }], reasoning_note: '',
            },
            {
              category: 'personality', predicate: '处事风格', value: '谨慎，会先观察周围环境', source_type: 'explicit', confidence: 0.96,
              assertion_mode: 'narrator_assertion', truth_status: 'asserted', attributed_source_name: null,
              visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
              evidence: [{ paragraph_id: identity.paragraph_id, exact_quote: identity.text, role: 'support' }], reasoning_note: '',
            },
            {
              category: 'status', predicate: '所在地点', value: '青石镇客栈', source_type: 'explicit', confidence: 0.97,
              assertion_mode: 'narrator_assertion', truth_status: 'asserted', attributed_source_name: null,
              visibility: 'public', valid_from_paragraph_id: identity.paragraph_id, valid_to_paragraph_id: null,
              evidence: [{ paragraph_id: identity.paragraph_id, exact_quote: identity.text, role: 'support' }], reasoning_note: '',
            },
          ] };
        } else if (payload.task === 'timeline_event_extraction') {
          const timeExpression = payload.supplied_time_expressions?.find((item) => item.surface_text.includes('二〇二四年'));
          result = { events: [{
            local_key: 'arrival', title: '陆沉返回青石镇', summary: '陆沉在雨夜回到青石镇并进入客栈。', event_type: 'movement',
            participants: [{
              identity_id: payload.supplied_characters?.find((item) => item.name === '陆沉')?.identity_id ?? null,
              surface_name: '陆沉', role: 'actor', action_text: '回到青石镇', confidence: 0.99,
            }],
            locations: [{ surface_name: '青石镇', normalized_name: '青石镇', role: 'to', confidence: 0.99 }],
            time_links: timeExpression ? [{ time_expression_id: timeExpression.time_expression_id, relation: 'occurs_at', confidence: 0.98 }] : [],
            evidence: [{ paragraph_id: arrival.paragraph_id, exact_quote: arrival.text, role: 'support' }],
            confidence: 0.98, uncertainty: '',
          }, {
            local_key: 'rest', title: '陆沉在客栈决定休息', summary: '陆沉说今夜先在这里休息。', event_type: 'dialogue',
            participants: [{
              identity_id: payload.supplied_characters?.find((item) => item.name === '陆沉')?.identity_id ?? null,
              surface_name: '陆沉', role: 'actor', action_text: '决定休息', confidence: 0.99,
            }],
            locations: [], time_links: [],
            evidence: [{ paragraph_id: dialogue.paragraph_id, exact_quote: dialogue.text, role: 'support' }],
            confidence: 0.98, uncertainty: '',
          }] };
        } else {
          throw new Error(`unexpected task: ${payload.task}`);
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 120, completion_tokens: 60 } }));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('本地模拟 API 启动失败');

  const app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data') },
  });
  try {
    await app.evaluate(({ dialog }, locations) => {
      Object.assign(dialog, {
        showOpenDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          if (options?.title?.includes('TXT')) return { canceled: false, filePaths: [locations.sourcePath] };
          if (options?.title?.includes('角色卡')) return { canceled: false, filePaths: [locations.batchDirectory] };
          if (options?.title?.includes('工程备份')) return { canceled: false, filePaths: [locations.backupPath] };
          if (options?.title?.includes('恢复位置')) return { canceled: false, filePaths: [locations.restoreParent] };
          return { canceled: false, filePaths: [locations.tempRoot] };
        },
        showSaveDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          return { canceled: false, filePath: options?.title?.includes('工程备份') ? locations.backupPath : locations.cardPath };
        },
      });
    }, { tempRoot, sourcePath, cardPath, backupPath, restoreParent, batchDirectory });
    const page = await app.firstWindow();
    await page.evaluate(() => window.novelCompiler.createProject('阶段一完整流程'));
    await page.reload();
    await page.getByRole('button', { name: '选择《阶段一完整流程》', exact: true }).click();
    await page.locator('.library-enter').click();
    await expect(page.locator('.app-shell')).toBeVisible();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await expect(page.getByText('小说导入完成，结构化底稿已经建立')).toBeVisible();

    await page.evaluate(async ({ port }) => {
      await window.novelCompiler.saveApiConfig({
        provider: '阶段一模拟服务', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'test-key', preferredModel: 'mock-stage1-model',
      });
      await window.novelCompiler.buildChunks({ coreChars: 2_000, softLimit: 3_000, hardLimit: 4_000, overlapBefore: 100, overlapAfter: 100 });
    }, { port: address.port });
    expect(await page.evaluate(() => window.novelCompiler.testApiConnection())).toMatchObject({ ok: true });

    const scanJob = await page.evaluate(() => window.novelCompiler.startCharacterScan({ model: 'mock-stage1-model' }));
    await waitForCompletedJob(page, scanJob.jobId);
    const character = (await page.evaluate(() => window.novelCompiler.listCharacters())).find((item) => item.canonicalName === '陆沉')!;
    expect(character).toBeDefined();
    await page.evaluate(async (identityId) => { await window.novelCompiler.reviewCharacter(identityId, { status: 'confirmed', importanceTier: 'core' }); }, character.id);
    await page.getByRole('button', { name: '人物普查' }).click();
    await expect(page.getByRole('heading', { name: '人物普查' })).toBeVisible();
    await page.getByRole('button', { name: '查看原文' }).first().click();
    await expect(page.getByRole('dialog', { name: /段落/u })).toBeVisible();
    await expect(page.locator('.source-span-status.exact')).toContainText('逐字坐标有效');
    await expect(page.locator('.source-span-paragraph mark')).toContainText('陆沉');
    await page.getByRole('button', { name: '关闭原文定位' }).click();

    const factJob = await page.evaluate((identityId) => window.novelCompiler.startCharacterFactExtraction({
      identityId, model: 'mock-stage1-model', extractionPasses: 1,
    }), character.id);
    await waitForCompletedJob(page, factJob.jobId);
    const facts = await page.evaluate((identityId) => window.novelCompiler.listCharacterFacts(identityId), character.id);
    expect(facts).toHaveLength(3);
    for (const fact of facts) {
      await page.evaluate(async (factId) => { await window.novelCompiler.reviewCharacterFact(factId, 'confirmed'); }, fact.id);
    }
    await page.getByRole('button', { name: '工程总览' }).click();
    await page.getByRole('button', { name: '人物普查' }).click();
    await page.getByRole('button', { name: '查看人物事实证据原文' }).first().click();
    await expect(page.locator('.source-span-status.exact')).toContainText('逐字坐标有效');
    await expect(page.locator('.source-span-paragraph mark')).toContainText('陆沉');
    await page.getByRole('button', { name: '关闭原文定位' }).click();

    const quoteSummary = await page.evaluate(() => window.novelCompiler.scanCharacterQuotes());
    expect(quoteSummary.confirmedSpeakerCount).toBeGreaterThan(0);
    const speechProfiles = await page.evaluate(() => window.novelCompiler.listSpeechProfiles());
    expect(speechProfiles.find((item) => item.identityId === character.id)?.quoteCount).toBeGreaterThan(0);

    await page.evaluate(() => window.novelCompiler.scanTimeExpressions());
    const timeExpressions = await page.evaluate(() => window.novelCompiler.listTimeExpressions());
    expect(timeExpressions.length).toBeGreaterThan(0);
    for (const expression of timeExpressions) {
      await page.evaluate(async (item) => {
        await window.novelCompiler.reviewTimeExpression(item.id, 'confirmed', item.normalizedValue);
      }, { id: expression.id, normalizedValue: expression.normalizedValue });
    }

    const eventJob = await page.evaluate(() => window.novelCompiler.startTimelineEventExtraction({ model: 'mock-stage1-model' }));
    await waitForCompletedJob(page, eventJob.jobId);
    const event = (await page.evaluate(() => window.novelCompiler.listTimelineEvents())).find((item) => item.title === '陆沉返回青石镇')!;
    expect(event).toBeDefined();
    await page.evaluate(async (eventId) => { await window.novelCompiler.reviewTimelineEvent(eventId, 'confirmed'); }, event.id);
    await page.getByRole('button', { name: '故事时间' }).click();
    await page.getByRole('button', { name: '查看事件证据原文' }).first().click();
    await expect(page.locator('.source-span-status.exact')).toContainText('逐字坐标有效');
    await expect(page.locator('.source-span-paragraph mark')).toContainText('陆沉');
    await page.getByRole('button', { name: '关闭原文定位' }).click();
    const snapshot = await page.evaluate(({ eventId, identityId }) => window.novelCompiler.getStoryStateSnapshot(eventId, identityId), {
      eventId: event.id, identityId: character.id,
    });
    expect(snapshot.characters[0]).toMatchObject({ identityName: '陆沉' });

    // Editorial state may use the whole book; playable cards must not borrow
    // the alias/personality evidence revealed after this early arrival event.
    await expect(page.evaluate(({ identityId, eventId }) => window.novelCompiler.generateCharacterCardDraft(identityId, eventId), {
      identityId: character.id, eventId: event.id,
    })).rejects.toThrow('已确认公开事实');
    const playableEvent = (await page.evaluate(() => window.novelCompiler.listTimelineEvents()))
      .find((item) => item.title === '陆沉在客栈决定休息')!;
    await page.evaluate(async (id) => { await window.novelCompiler.reviewTimelineEvent(id, 'confirmed'); }, playableEvent.id);

    const draft = await page.evaluate(({ identityId, eventId }) => window.novelCompiler.generateCharacterCardDraft(identityId, eventId), {
      identityId: character.id, eventId: playableEvent.id,
    });
    expect(draft).toMatchObject({ identityName: '陆沉', reviewStatus: 'draft' });
    const reviewed = await page.evaluate(({ identityId, current }) => window.novelCompiler.saveCharacterCardDraft(identityId, {
      description: current.description,
      personality: current.personality,
      scenario: current.scenario,
      firstMes: '*陆沉从二楼走下，在柜台旁停步，平静地看向刚刚进入客栈的来客。*',
      mesExample: current.mesExample,
      creatorNotes: current.creatorNotes,
      systemPrompt: current.systemPrompt,
      postHistoryInstructions: current.postHistoryInstructions,
      alternateGreetings: current.alternateGreetings,
      tags: current.tags,
      creator: current.creator,
      characterVersion: '1.0',
    }, 'reviewed'), { identityId: character.id, current: draft });
    expect(reviewed.reviewStatus).toBe('reviewed');

    const runtimeTurn = await page.evaluate((identityId) =>
      window.novelCompiler.askCharacter(identityId, '你是谁，今晚准备做什么？', 'mock-stage1-model'), character.id);
    expect(runtimeTurn).toMatchObject({
      status: 'delivered', attempts: 1, deliveredAnswer: '我是陆沉，大家也叫我小陆。今夜先在这里休息。',
      inputTokens: 180, outputTokens: 18, gate: { allowed: true, action: 'allow' },
    });
    expect(await page.evaluate((identityId) => window.novelCompiler.listCharacterRuntimeTurns(identityId), character.id))
      .toEqual([expect.objectContaining({ id: runtimeTurn.id, status: 'delivered' })]);

    const runtimeSession = await page.evaluate((identityId) =>
      window.novelCompiler.createCharacterRuntimeSession(identityId, 'mock-stage1-model', 'explainable-v1'), character.id);
    expect(runtimeSession).toMatchObject({
      identityId: character.id, model: 'mock-stage1-model', retrievalMode: 'explainable-v1', status: 'active', maxHistoryTurns: 6,
      turnCount: 0, deliveredTurnCount: 0,
    });
    const firstSessionTurn = await page.evaluate((sessionId) =>
      window.novelCompiler.askCharacterInSession(sessionId, '你还记得我刚才问了什么吗？'), runtimeSession.id);
    const secondSessionTurn = await page.evaluate((sessionId) =>
      window.novelCompiler.askCharacterInSession(sessionId, '那我们接着聊今晚的安排。'), runtimeSession.id);
    expect(firstSessionTurn).toMatchObject({ sessionId: runtimeSession.id, turnIndex: 1, retrievalMode: 'explainable-v1', status: 'delivered', retrieval: { version: 'character-runtime-retrieval.v1' } });
    expect(secondSessionTurn).toMatchObject({ sessionId: runtimeSession.id, turnIndex: 2, retrievalMode: 'explainable-v1', status: 'delivered', retrieval: { version: 'character-runtime-retrieval.v1' } });
    expect(await page.evaluate((sessionId) => window.novelCompiler.listCharacterRuntimeSessionTurns(sessionId), runtimeSession.id))
      .toEqual([
        expect.objectContaining({ id: secondSessionTurn.id, turnIndex: 2 }),
        expect.objectContaining({ id: firstSessionTurn.id, turnIndex: 1 }),
      ]);
    expect(await page.evaluate((sessionId) => window.novelCompiler.closeCharacterRuntimeSession(sessionId), runtimeSession.id))
      .toMatchObject({ status: 'closed', turnCount: 2, deliveredTurnCount: 2 });
    await page.getByRole('button', { name: '角色卡制作' }).click();
    await expect(page.getByRole('heading', { name: '单人物安全试聊' })).toBeVisible();
    await expect(page.getByText('按需检索 B 组')).toBeVisible();
    await expect(page.locator('.runtime-retrieval-control input[type="checkbox"]')).toBeChecked();

    const exportResult = await page.evaluate((identityId) => window.novelCompiler.exportCharacterCardJson(identityId), character.id);
    expect(exportResult?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    const exportedCard = JSON.parse(await fs.readFile(cardPath, 'utf8')) as { spec: string; spec_version: string; data: { name: string; extensions: { novel_world_compiler: { schema_version: number } } } };
    expect(exportedCard).toMatchObject({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: '陆沉' } });
    expect(exportedCard.data.extensions.novel_world_compiler.schema_version).toBe(SCHEMA_VERSION);

    const batchStatus = await page.evaluate(() => window.novelCompiler.getCharacterCardBatchStatus());
    expect(batchStatus.find((item) => item.identityId === character.id)).toMatchObject({ exportReady: true, reviewStatus: 'reviewed' });
    const batchExport = await page.evaluate(() => window.novelCompiler.exportReviewedCharacterCards());
    expect(batchExport).toMatchObject({ exportedCount: 1 });
    const backup = await page.evaluate(() => window.novelCompiler.createBackup());
    expect(backup?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    await expect(fs.stat(backupPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(page.getByRole('button', { name: '恢复备份' })).toBeVisible();
    await page.getByRole('button', { name: '恢复备份' }).click();
    await expect(page.getByText('备份已安全恢复为“阶段一完整流程”')).toBeVisible();
    const restoredProject = await page.evaluate(() => window.novelCompiler.getProject());
    expect(restoredProject?.rootPath).toBe(path.join(restoreParent, '阶段一完整流程.novelworld'));
    expect(await page.evaluate(() => window.novelCompiler.search('青石镇'))).not.toHaveLength(0);
    expect(requestedTasks).toEqual(expect.arrayContaining([
      'character_census', 'character_fact_extraction', 'timeline_event_extraction', 'character_runtime',
    ]));
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
