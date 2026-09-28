import { expect, test, _electron as electron } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import { createServer } from 'node:http';

test('starts the production Electron app with a sandboxed renderer and live data service', async () => {
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const pageErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await expect(page).toHaveTitle('小说世界编译器');
    await expect(page.getByRole('heading', { name: /把一本小说/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建工程' })).toBeVisible();
    const security = await page.evaluate(async () => ({
      hasRequire: 'require' in window,
      hasProcess: 'process' in window,
      project: await window.novelCompiler.getProject(),
      electronVersion: window.novelCompiler.versions.electron,
      relationshipApi: [
        window.novelCompiler.estimateRelationshipScan,
        window.novelCompiler.startRelationshipScan,
        window.novelCompiler.listRelationshipCandidateEvidence,
        window.novelCompiler.getRelationshipModelSuggestion,
        window.novelCompiler.createRelationshipCandidate,
        window.novelCompiler.createRelationship,
        window.novelCompiler.listRelationshipsAtEntry,
        window.novelCompiler.getRelationshipGraphProjection,
        window.novelCompiler.exportRelationshipGraph,
        window.novelCompiler.exportRelationshipWorldInfo,
        window.novelCompiler.listRelationshipEvidence,
        window.novelCompiler.restoreBackup,
        window.novelCompiler.inspectChunk,
        window.novelCompiler.getRefinementDashboard,
        window.novelCompiler.getArtifactFoundationStatus,
        window.novelCompiler.generateArtifactFoundation,
        window.novelCompiler.exportPlayableBundle,
        window.novelCompiler.validatePlayableBundle,
        window.novelCompiler.askCharacter,
        window.novelCompiler.listCharacterRuntimeTurns,
        window.novelCompiler.createCharacterRuntimeSession,
        window.novelCompiler.closeCharacterRuntimeSession,
        window.novelCompiler.listCharacterRuntimeSessions,
        window.novelCompiler.askCharacterInSession,
        window.novelCompiler.listCharacterRuntimeSessionTurns,
        window.novelCompiler.bootstrapPlacesFromEvents,
        window.novelCompiler.listPlaces,
        window.novelCompiler.listPlaceMentions,
        window.novelCompiler.reviewPlace,
        window.novelCompiler.listPlaceAliases,
        window.novelCompiler.reviewPlaceAlias,
        window.novelCompiler.mergePlaces,
        window.novelCompiler.splitPlace,
        window.novelCompiler.linkPlaces,
        window.novelCompiler.listPlaceIdentityLinks,
        window.novelCompiler.listPlaceIdentityOperations,
        window.novelCompiler.undoPlaceIdentityOperation,
      ].every((value) => typeof value === 'function'),
    }));
    expect(security.hasRequire).toBe(false);
    expect(security.hasProcess).toBe(false);
    expect(security.project).toBeNull();
    expect(security.electronVersion).toMatch(/^43\./);
    expect(security.relationshipApi).toBe(true);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('opens API settings with a requested provider preset ready for a fresh key', async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'novel-ui-provider-'));
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NOVEL_COMPILER_USER_DATA: tempRoot,
      NOVEL_COMPILER_OPEN_SETTINGS: '1',
      NOVEL_COMPILER_PROVIDER_PRESET: 'zhipu',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'API 与模型设置' })).toBeVisible();
    await expect(page.getByLabel('API 服务商')).toHaveValue('zhipu');
    await expect(page.getByLabel('API 基础地址')).toHaveValue('https://open.bigmodel.cn/api/paas/v4');
    await expect(page.getByLabel('全局默认模型')).toHaveValue('glm-5.3');
    await expect(page.getByRole('button', { name: '安全保存' })).toBeDisabled();
    await page.screenshot({ path: path.resolve('test-results', 'provider-presets.png') });
  } finally {
    await app.close();
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('starts the packaged Windows executable with its bundled database runtime', async () => {
  const packageVersion = (JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }).version;
  const expectedVersion = process.env.NOVEL_COMPILER_EXPECTED_PACKAGED_VERSION ?? packageVersion;
  const executablePath = process.env.NOVEL_COMPILER_PACKAGED_EXE
    ? path.resolve(process.env.NOVEL_COMPILER_PACKAGED_EXE)
    : path.resolve('release', 'win-unpacked', '小说世界编译器.exe');
  const packagedAppPath = process.env.NOVEL_COMPILER_PACKAGED_APP
    ? path.resolve(process.env.NOVEL_COMPILER_PACKAGED_APP)
    : null;
  test.skip(!fs.existsSync(executablePath), 'Run npm run dist:win before the packaged smoke test');
  const app = await electron.launch({ executablePath, args: packagedAppPath ? [packagedAppPath] : [] });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('小说世界编译器');
    await expect(page.getByRole('button', { name: '新建工程' })).toBeVisible();
    const result = await page.evaluate(async () => ({
      project: await window.novelCompiler.getProject(), appVersion: window.novelCompiler.versions.app,
    }));
    expect(result).toMatchObject({ project: null, appVersion: expectedVersion });
  } finally {
    await app.close();
  }
});

test('builds chunks and opens the phase 1A character census workspace', async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'novel-ui-phase1-'));
  const sourcePath = path.join(tempRoot, '人物小说.txt');
  const graphPath = path.join(tempRoot, 'character_graph.json');
  const worldInfoPath = path.join(tempRoot, 'relationships_world_info.json');
  await fsPromises.writeFile(sourcePath, [
    '第一章 初见',
    '叶凡第一次看见林月。',
    '“跟我来。”林月说道。',
  ].join('\n'), 'utf8');
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data') },
  });
  try {
    await app.evaluate(({ dialog }, locations) => {
      Object.assign(dialog, {
        showOpenDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          return { canceled: false, filePaths: [options?.title?.includes('TXT') ? locations.sourcePath : locations.tempRoot] };
        },
        showSaveDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          return { canceled: false, filePath: options?.title?.includes('世界书') ? locations.worldInfoPath : locations.graphPath };
        },
      });
    }, { tempRoot, sourcePath, graphPath, worldInfoPath });
    const page = await app.firstWindow();
    await page.locator('.create-row input').fill('阶段一界面测试');
    await page.getByRole('button', { name: '新建工程' }).click();
    await expect(page.getByRole('heading', { name: '工程总览' })).toBeVisible();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await expect(page.getByRole('heading', { name: '确认文本编码' })).toBeVisible();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await expect(page.getByText('小说导入完成，结构化底稿已经建立')).toBeVisible();
    await page.getByRole('button', { name: '分析分块' }).click();
    await page.getByRole('button', { name: '生成新方案' }).click();
    await expect(page.getByText('新的分块方案已经生成')).toBeVisible();
    await page.getByRole('button', { name: '查看分块 #1 原文' }).click();
    await expect(page.getByRole('heading', { name: /原文范围/u })).toBeVisible();
    await expect(page.locator('.chunk-source-paragraph.core').filter({ hasText: '叶凡第一次看见林月' })).toHaveCount(1);
    await expect(page.locator('.chunk-role-legend')).toContainText('核心');
    await page.getByRole('button', { name: '工程诊断' }).click();
    await expect(page.getByRole('heading', { name: '工程诊断' })).toBeVisible();
    await expect(page.getByText('全部正常')).toBeVisible();
    await expect(page.getByText('FTS5 已覆盖 3 个段落')).toBeVisible();
    await page.getByRole('button', { name: '运行严格检查' }).click();
    await expect(page.getByText('严格工程检查完成')).toBeVisible();
    await expect(page.getByText('匹配', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '统一精修' }).click();
    await expect(page.getByRole('heading', { name: '统一精修台' })).toBeVisible();
    await expect(page.getByText('还有 1 项阻断待办')).toBeVisible();
    await expect(page.getByRole('heading', { name: '先完成一键基础流程' })).toBeVisible();
    await expect(page.getByText('refinement-triage.v1')).toBeVisible();
    await page.getByRole('button', { name: '基础稿生成' }).click();
    await expect(page.getByRole('heading', { name: '三类基础稿生成台' })).toBeVisible();
    await expect(page.getByText('还没有已确认进入事件')).toBeVisible();
    await expect(page.getByText('artifact-foundation.v1')).toBeVisible();
    await expect(page.getByRole('button', { name: '导出可游玩整合包' })).toBeDisabled();
    await page.getByRole('button', { name: '人物普查' }).click();
    await expect(page.getByRole('heading', { name: '人物普查' })).toBeVisible();
    await expect(page.getByText('约', { exact: false })).toBeVisible();
    // This navigation smoke test must not depend on a real user's model settings.
    // Filling the model only enables the control; no scan or API call is started.
    await page.locator('.scan-model input').fill('local-ui-test-model');
    await expect(page.getByRole('button', { name: '开始人物普查' })).toBeEnabled();
    await page.getByRole('button', { name: '角色卡制作' }).click();
    await expect(page.getByRole('heading', { name: '角色卡制作' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '核心/重要人物成品盘点' })).toBeVisible();
    await expect(page.getByText('请先在“人物普查”中确认至少一个人物。')).toBeVisible();
    await page.getByRole('button', { name: '人物关系' }).click();
    await expect(page.getByRole('heading', { name: '人物关系审核' })).toBeVisible();
    await expect(page.getByText('候选确认 ≠ 图谱确认')).toBeVisible();
    await page.getByRole('button', { name: '关系图谱' }).click();
    await expect(page.getByRole('heading', { name: '防剧透关系图谱' })).toBeVisible();
    await expect(page.getByLabel('关系图阅读位置')).toHaveValue('3');
    await expect(page.getByText('统一边界已启用')).toBeVisible();
    await expect(page.locator('.graph-stage-count')).toHaveText('0 NODES / 0 EDGES');
    await page.getByRole('button', { name: '导出图 JSON' }).click();
    await expect(page.getByText(/已导出 0 个节点、0 条已揭示关系/)).toBeVisible();
    expect(JSON.parse(await fsPromises.readFile(graphPath, 'utf8'))).toMatchObject({
      format: 'novel-world-character-graph', spec_version: '1.0', fence: { entry_ordinal: 3 },
    });
    await page.getByRole('button', { name: '导出世界书' }).click();
    await expect(page.getByText(/已导出 SillyTavern 世界书 0 个条目/)).toBeVisible();
    expect(JSON.parse(await fsPromises.readFile(worldInfoPath, 'utf8'))).toMatchObject({
      entries: {}, extensions: { novel_world_compiler: { entry_ordinal: 3 } },
    });
  } finally {
    await app.close();
    await fsPromises.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('scans and reviews story-time expressions in the desktop UI', async () => {
  test.setTimeout(60_000);
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'novel-ui-timeline-'));
  const sourcePath = path.join(tempRoot, '时间小说.txt');
  const mapPath = path.join(tempRoot, 'world_map.json');
  const placeWorldInfoPath = path.join(tempRoot, 'places_world_info.json');
  const placeGeoJsonPath = path.join(tempRoot, 'places.geojson');
  await fsPromises.writeFile(sourcePath, [
    '第一章 归来',
    '二〇二四年三月五日，陆沉回到青石镇。',
    '三日后，他从青石镇在下午三点再次出发，前往北城门。',
  ].join('\n'), 'utf8');
  let observedThinking: unknown;
  const apiServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-event-model' }] }));
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }>; thinking?: unknown };
      observedThinking = body.thinking;
      const payload = JSON.parse(body.messages.find((message) => message.role === 'user')!.content) as {
        task: string;
        supplied_time_expressions?: Array<{ time_expression_id: string; surface_text: string }>;
        supplied_places?: Array<{ place_id: string; name: string }>;
        paragraphs: Array<{ paragraph_id: string; text: string; role: string }>;
      };
      if (payload.task === 'place_identity_and_spatial_relation_suggestions') {
        const town = payload.supplied_places!.find((place) => place.name === '青石镇')!;
        const gate = payload.supplied_places!.find((place) => place.name === '北城门')!;
        const evidence = payload.paragraphs.find((paragraph) => paragraph.text.includes('前往北城门'))!;
        const result = { aliases: [], identity_links: [], relations: [{
          source_place_id: town.place_id, target_place_id: gate.place_id, relation_kind: 'route_to', direction: 'directed',
          information_source_type: 'narrator', information_source_identity_id: null, truth_status: 'asserted',
          valid_from_event_id: null, valid_to_event_id: null, confidence: 0.91,
          evidence: [{ paragraph_id: evidence.paragraph_id, exact_quote: '从青石镇在下午三点再次出发，前往北城门', role: 'support' }],
          reasoning_note: '原文明示移动方向', uncertainty: '',
        }] };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 40, completion_tokens: 20 } }));
        return;
      }
      const arrival = payload.paragraphs.find((paragraph) => paragraph.text.includes('回到青石镇'))!;
      const departure = payload.paragraphs.find((paragraph) => paragraph.text.includes('再次出发'))!;
      const date = payload.supplied_time_expressions!.find((expression) => expression.surface_text.includes('二〇二四年'))!;
      const relativeTime = payload.supplied_time_expressions!.find((expression) => expression.surface_text === '三日后')!;
      const result = { events: [{
        local_key: 'arrival', title: '陆沉返回青石镇', summary: '陆沉回到青石镇。', event_type: 'movement',
        participants: [{ identity_id: null, surface_name: '陆沉', role: 'actor', action_text: '回到青石镇', confidence: 0.98 }],
        locations: [{ surface_name: '青石镇', normalized_name: '青石镇', role: 'to', confidence: 0.98 }],
        time_links: [{ time_expression_id: date.time_expression_id, relation: 'occurs_at', confidence: 0.95 }],
        evidence: [{ paragraph_id: arrival.paragraph_id, exact_quote: arrival.text, role: 'support' }], confidence: 0.97, uncertainty: '',
      }, {
        local_key: 'departure', title: '陆沉再次出发', summary: '三日后陆沉再次出发。', event_type: 'movement',
        participants: [{ identity_id: null, surface_name: '陆沉', role: 'actor', action_text: '再次出发', confidence: 0.96 }],
        locations: [{ surface_name: '青石镇', normalized_name: '青石镇', role: 'from', confidence: 0.96 }, { surface_name: '北城门', normalized_name: '北城门', role: 'to', confidence: 0.94 }],
        time_links: [{ time_expression_id: relativeTime.time_expression_id, relation: 'occurs_at', confidence: 0.94 }],
        evidence: [{ paragraph_id: departure.paragraph_id, exact_quote: departure.text, role: 'support' }], confidence: 0.95, uncertainty: '',
      }] };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 80, completion_tokens: 40 } }));
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('本地模拟API启动失败');
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data') },
  });
  try {
    await app.evaluate(({ dialog }, locations) => {
      Object.assign(dialog, {
        showOpenDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          return { canceled: false, filePaths: [options?.title?.includes('TXT') ? locations.sourcePath : locations.tempRoot] };
        },
        showSaveDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          const filePath = options?.title?.includes('地点世界书') ? locations.placeWorldInfoPath
            : options?.title?.includes('GeoJSON') ? locations.placeGeoJsonPath : locations.mapPath;
          return { canceled: false, filePath };
        },
      });
    }, { tempRoot, sourcePath, mapPath, placeWorldInfoPath, placeGeoJsonPath });
    const page = await app.firstWindow();
    await page.locator('.create-row input').fill('时间线界面测试');
    await page.getByRole('button', { name: '新建工程' }).click();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await page.getByRole('button', { name: '分析分块' }).click();
    await page.getByRole('button', { name: '生成新方案' }).click();
    await page.getByRole('button', { name: '故事时间' }).click();
    await expect(page.getByRole('heading', { name: '故事时间' })).toBeVisible();
    await page.getByRole('button', { name: '本地扫描时间' }).click();
    await expect(page.getByText('时间表达扫描完成；所有结果均保留原文位置并等待审核')).toBeVisible();
    const relative = page.locator('.time-expression-list article').filter({ hasText: '三日后' });
    await expect(relative).toContainText('相对时间');
    await relative.locator('input').fill('RELATIVE:AFTER:P3D');
    await relative.getByRole('button', { name: '确认' }).click();
    await expect(page.getByText('时间表达已经确认')).toBeVisible();
    await page.locator('.timeline-toolbar select').selectOption('confirmed');
    await expect(page.locator('.time-expression-list article').filter({ hasText: '三日后' }).locator('input')).toHaveValue('RELATIVE:AFTER:P3D');
    await page.getByRole('button', { name: 'API 设置' }).click();
    await page.getByLabel('API 服务商').selectOption('zhipu');
    await expect(page.getByLabel('API 基础地址')).toHaveValue('https://open.bigmodel.cn/api/paas/v4');
    await expect(page.getByLabel('全局默认模型')).toHaveValue('glm-5.3');
    await page.getByLabel('API 服务商').selectOption('custom');
    await page.getByLabel('自定义服务商名称').fill('本地模拟服务');
    await page.getByLabel('API 基础地址').fill(`http://127.0.0.1:${address.port}`);
    await page.getByLabel('API 密钥').fill('test-key');
    await page.getByLabel('全局默认模型').fill('mock-event-model');
    await page.getByRole('button', { name: '安全保存' }).click();
    await expect(page.getByText('API 与默认模型已安全保存')).toBeVisible();
    await page.getByRole('button', { name: '读取模型列表' }).click();
    await expect(page.locator('.model-choice-list')).toContainText('mock-event-model');
    await page.locator('.model-choice-list button').filter({ hasText: 'mock-event-model' }).click();
    await expect(page.getByLabel('全局默认模型')).toHaveValue('mock-event-model');
    await page.getByLabel('全局默认模型').fill('custom-user-model');
    await page.getByRole('button', { name: '安全保存' }).click();
    await page.getByRole('button', { name: '故事时间' }).click();
    await expect(page.locator('.timeline-event-run input')).toHaveValue('custom-user-model');
    await page.locator('.timeline-event-run input').fill('deepseek-v4-flash');
    await page.evaluate(() => { window.confirm = () => true; });
    await page.getByRole('button', { name: '提取候选事件' }).click();
    await expect(page.getByText('事件抽取已启动，可在任务中心暂停、恢复或重试')).toBeVisible();
    await expect(page.locator('.timeline-event-list')).toContainText('陆沉返回青石镇');
    expect(observedThinking).toEqual({ type: 'disabled' });
    await expect(page.locator('.timeline-event-detail')).toContainText('青石镇');
    await expect(page.locator('.event-evidence')).toContainText('二〇二四年三月五日，陆沉回到青石镇。');
    await page.locator('.timeline-event-detail').getByRole('button', { name: '确认' }).click();
    await page.locator('.timeline-event-list > button').filter({ hasText: '陆沉再次出发' }).click();
    await page.locator('.timeline-event-detail').getByRole('button', { name: '确认' }).click();
    await page.getByRole('button', { name: '生成关系候选' }).click();
    await expect(page.getByText('时间关系候选已经生成；叙述顺序不会自动当成故事时间')).toBeVisible();
    const relation = page.locator('.timeline-relations article').filter({ hasText: '陆沉返回青石镇' });
    await expect(relation).toContainText('左侧早于右侧');
    await relation.getByRole('button', { name: '确认' }).click();
    await expect(page.locator('.timeline-order')).toContainText('陆沉再次出发');
    await expect(page.getByRole('heading', { name: '进入时间人物状态' })).toBeVisible();
    await expect(page.getByTestId('snapshot-entry-event')).not.toHaveValue('');
    await page.getByRole('button', { name: '计算人物状态' }).click();
    await expect(page.getByText('进入时间的人物状态已经按已确认事实重新计算')).toBeVisible();
    await expect(page.locator('.state-snapshot-metrics')).toContainText('确定 0 项');
    await page.getByRole('button', { name: '地点审核' }).click();
    await expect(page.getByRole('heading', { name: '地点证据台' })).toBeVisible();
    await page.getByRole('button', { name: '整理事件地点' }).click();
    await expect(page.getByText(/读取 3 个事件地点/)).toBeVisible();
    await expect(page.locator('.place-index')).toContainText('青石镇');
    await expect(page.locator('.place-evidence-sheet mark')).toHaveText('青石镇');
    await page.locator('.place-edit-grid select').selectOption('settlement');
    await page.getByRole('button', { name: '确认地点' }).click();
    await page.locator('.place-index > button').filter({ hasText: '北城门' }).click();
    await page.locator('.place-edit-grid select').selectOption('landmark');
    await page.getByRole('button', { name: '确认地点' }).click();
    await expect(page.getByLabel('地点扫描模型')).toHaveValue('custom-user-model');
    await page.getByRole('button', { name: '开始模型勘测' }).click();
    await expect(page.getByText('地点模型扫描已启动；结果不会自动确认')).toBeVisible();
    await expect(page.locator('.place-relation-stack')).toContainText('青石镇', { timeout: 15_000 });
    const spatial = page.locator('.place-relation-stack article').filter({ hasText: 'route_to' });
    await spatial.locator('.place-relation-main').click();
    await expect(page.locator('.place-suggestion-evidence')).toContainText('逐字对齐');
    await spatial.getByRole('button', { name: '确认候选' }).click();
    await expect(page.getByText('空间关系候选审核状态已更新')).toBeVisible();
    await spatial.getByRole('button', { name: '生成正式关系草案' }).click();
    await expect(page.getByText('已生成待审正式空间关系；还需第二次确认才会进入地图')).toBeVisible();
    const formalSpatial = page.locator('.place-assertion-register article').filter({ hasText: 'route_to' });
    await expect(formalSpatial).toContainText('待二审');
    await formalSpatial.getByRole('button', { name: '确认入图' }).click();
    await expect(page.getByText('正式空间关系已确认，可进入防剧透地图投影')).toBeVisible();
    await page.getByRole('button', { name: '叙事地图' }).click();
    await expect(page.getByRole('heading', { name: '防剧透叙事地图' })).toBeVisible();
    await expect(page.getByText('TOPOLOGY + REVIEWED WGS84')).toBeVisible();
    await expect(page.locator('.map-stage-stamp')).toContainText('2 PLACES / 1 LINKS');
    await expect(page.locator('.map-reading-copy')).toContainText('2 个地点事件');
    await expect(page.getByLabel('叙事地图阅读位置')).not.toHaveValue('0');
    await page.getByRole('button', { name: '导出 world_map.json' }).click();
    await expect(page.getByText(/已导出 world_map\.json · 2 个地点、1 条已揭示关系/)).toBeVisible();
    expect(JSON.parse(await fsPromises.readFile(mapPath, 'utf8'))).toMatchObject({
      format: 'novel-world-narrative-map',
      spec_version: '1.0',
      coordinate_semantics: 'topology-only',
      nodes: expect.arrayContaining([expect.objectContaining({ name: '青石镇' }), expect.objectContaining({ name: '北城门' })]),
      relations: [expect.objectContaining({ relation_kind: 'route_to', topology_class: 'connection', active_at_entry: true })],
      events: expect.arrayContaining([expect.objectContaining({ title: '陆沉返回青石镇' })]),
    });
    await page.getByRole('button', { name: '导出地点世界书' }).click();
    await expect(page.getByText(/已导出 SillyTavern 地点世界书 · 3 个条目/)).toBeVisible();
    const placeWorldInfo = JSON.parse(await fsPromises.readFile(placeWorldInfoPath, 'utf8')) as {
      entries: Record<string, { extensions: { novel_world_compiler: { entry_kind: string } } }>;
      extensions: { novel_world_compiler: { coordinate_semantics: string; entry_ordinal: number } };
    };
    expect(placeWorldInfo.extensions.novel_world_compiler).toMatchObject({ coordinate_semantics: 'topology-only' });
    expect(Object.values(placeWorldInfo.entries).filter((entry) => entry.extensions.novel_world_compiler.entry_kind === 'place')).toHaveLength(2);
    expect(Object.values(placeWorldInfo.entries).filter((entry) => entry.extensions.novel_world_compiler.entry_kind === 'spatial_relation')).toHaveLength(1);
    await page.getByPlaceholder('输入地点名…').fill('青石镇');
    await page.locator('.map-search > button').filter({ hasText: '青石镇' }).click();
    await expect(page.getByText('真实坐标审核')).toBeVisible();
    await page.getByLabel('真实地点经度').fill('120.1551');
    await page.getByLabel('真实地点纬度').fill('30.2741');
    await page.getByLabel('真实坐标来源名称').fill('人工核对');
    await page.getByLabel('真实坐标核对备注').fill('端到端测试');
    await page.getByRole('button', { name: '保存为待审候选' }).click();
    await expect(page.getByText(/确认后才会进入 GeoJSON/)).toBeVisible();
    await page.getByRole('button', { name: '确认坐标' }).click();
    await expect(page.getByText(/已确认“青石镇”的真实坐标/)).toBeVisible();
    await page.getByRole('button', { name: '导出真实地点 GeoJSON' }).click();
    await expect(page.getByText(/已导出真实地点 GeoJSON · 1 个已确认坐标/)).toBeVisible();
    expect(JSON.parse(await fsPromises.readFile(placeGeoJsonPath, 'utf8'))).toMatchObject({
      type: 'FeatureCollection',
      features: [expect.objectContaining({ geometry: { type: 'Point', coordinates: [120.1551, 30.2741] } })],
      novel_world_compiler: { coordinate_semantics: 'earth-wgs84-confirmed-only' },
    });
    const cytoscapeState = await page.locator('.map-canvas').evaluate((container) => {
      const cy = (container as HTMLElement & { _cyreg?: { cy?: { width(): number; height(): number; nodes(): { map(callback: (node: { id(): string; renderedPosition(): { x: number; y: number }; visible(): boolean }) => unknown): unknown[] } } } })._cyreg?.cy;
      return cy ? { width: cy.width(), height: cy.height(), nodes: cy.nodes().map((node) => ({ id: node.id(), position: node.renderedPosition(), visible: node.visible() })) } : null;
    }) as { width: number; height: number; nodes: Array<{ id: string; position: { x: number; y: number }; visible: boolean }> } | null;
    expect(cytoscapeState?.nodes).toHaveLength(2);
    expect(cytoscapeState?.nodes.every((node) => node.visible
      && node.position.x >= 0 && node.position.x <= cytoscapeState.width
      && node.position.y >= 0 && node.position.y <= cytoscapeState.height)).toBe(true);
    await page.locator('.map-workspace').screenshot({ path: path.resolve('test-results/narrative-map.png') });
    await page.getByRole('button', { name: '地点审核' }).click();
    await page.getByRole('tab', { name: '全部' }).click();
    await page.locator('.place-index > button').filter({ hasText: '青石镇' }).first().click();
    await page.getByRole('button', { name: '恢复待审' }).click();
    await page.locator('.place-edit-grid select').selectOption('settlement');
    await page.getByRole('button', { name: '确认地点' }).click();
    await expect(page.getByText('地点与原文提及已经确认')).toBeVisible();
    await page.getByRole('tab', { name: '已确认' }).click();
    await expect(page.locator('.place-index')).toContainText('青石镇');
    await expect(page.locator('.place-evidence-sheet mark')).toHaveText('青石镇');
    await page.screenshot({ path: path.resolve('test-results/place-review.png'), fullPage: true });
    const reopenedApp = await electron.launch({
      args: [path.resolve('.')],
      env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data-reopen') },
    });
    try {
      await reopenedApp.evaluate(({ dialog }, projectRoot) => {
        Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [projectRoot] }) });
      }, path.join(tempRoot, '时间线界面测试.novelworld'));
      const reopenedPage = await reopenedApp.firstWindow();
      await reopenedPage.getByRole('button', { name: '打开已有工程' }).click();
      await expect(reopenedPage.getByRole('heading', { name: '工程总览' })).toBeVisible();
      const persistedRelations = await reopenedPage.evaluate(() => window.novelCompiler.listPlaceRelationCandidates('confirmed'));
      expect(persistedRelations.some((item) => item.proposedRelationKind === 'route_to')).toBe(true);
      const persistedAssertions = await reopenedPage.evaluate(() => window.novelCompiler.listPlaceRelations('confirmed'));
      expect(persistedAssertions.some((item) => item.relationKind === 'route_to')).toBe(true);
    } finally {
      await reopenedApp.close();
    }
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
    await fsPromises.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('reviews aliases, identity constraints, merge, split and undo in the desktop UI', async () => {
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'novel-ui-identity-'));
  const sourcePath = path.join(tempRoot, 'identity.txt');
  await fsPromises.writeFile(sourcePath, [
    '第一章 客栈',
    '陆沉，人称小陆，推门走进客栈。',
    '陆沉把伞放在墙边。',
    '掌柜周平抬头看了他一眼。',
    '陆沉说道：“雨停了再走。”',
    '陆沉问道：“你还走吗？”',
  ].join('\n'), 'utf8');
  const apiServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'mock-character-model' }] }));
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
        const payload = JSON.parse(body.messages.find((message) => message.role === 'user')!.content) as {
          task: string;
          extraction_pass?: number;
          paragraphs: Array<{ paragraph_id: string; text: string; role: string }>;
        };
        const firstLu = payload.paragraphs.find((paragraph) => paragraph.text.includes('小陆'))!;
        const secondLu = payload.paragraphs.find((paragraph) => paragraph.text.includes('墙边'))!;
        const zhou = payload.paragraphs.find((paragraph) => paragraph.text.includes('周平'))!;
        const explicitFacts = [
            {
              category: 'identity', predicate: '常用称呼', value: '小陆', source_type: 'explicit', confidence: 0.98,
              assertion_mode: 'narrator_assertion', truth_status: 'asserted', attributed_source_name: null,
              visibility: 'public', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
              evidence: [{ paragraph_id: firstLu.paragraph_id, exact_quote: firstLu.text, role: 'support' }], reasoning_note: '',
            },
            {
              category: 'status', predicate: '所在地点', value: '客栈门口', source_type: 'explicit', confidence: 0.95,
              assertion_mode: 'narrator_assertion', truth_status: 'asserted', attributed_source_name: null,
              visibility: 'public', valid_from_paragraph_id: firstLu.paragraph_id, valid_to_paragraph_id: firstLu.paragraph_id,
              evidence: [{ paragraph_id: firstLu.paragraph_id, exact_quote: firstLu.text, role: 'support' }], reasoning_note: '',
            },
        ];
        const inferredFacts = [
            {
              category: 'personality', predicate: '行为习惯', value: '进入室内后会整理随身物品', source_type: 'inferred', confidence: 0.8,
              assertion_mode: 'behavior_inference', truth_status: 'suspected', attributed_source_name: null,
              visibility: 'private', valid_from_paragraph_id: null, valid_to_paragraph_id: null,
              evidence: [{ paragraph_id: secondLu.paragraph_id, exact_quote: secondLu.text, role: 'support' }], reasoning_note: '根据放伞行为推断',
            },
            {
              category: 'status', predicate: '所在地点', value: '客栈内', source_type: 'inferred', confidence: 0.85,
              assertion_mode: 'behavior_inference', truth_status: 'asserted', attributed_source_name: null,
              visibility: 'public', valid_from_paragraph_id: secondLu.paragraph_id, valid_to_paragraph_id: null,
              evidence: [{ paragraph_id: secondLu.paragraph_id, exact_quote: secondLu.text, role: 'support' }], reasoning_note: '根据进入客栈后的行为推断',
            },
        ];
        const result = payload.task === 'character_fact_extraction' ? {
          facts: payload.extraction_pass === 1 ? explicitFacts : payload.extraction_pass === 2 ? inferredFacts : [...explicitFacts, ...inferredFacts],
        } : {
          characters: [
            {
              local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }, { text: '小陆', kind: 'alias' }],
              entity_kind: 'human', role_hints: [], has_dialogue: false, participates_in_event: true, confidence: 0.98, uncertainty: '',
              evidence: [
                { paragraph_id: firstLu.paragraph_id, exact_quote: firstLu.text, supports: 'alias' },
                { paragraph_id: secondLu.paragraph_id, exact_quote: secondLu.text, supports: 'event' },
              ],
            },
            {
              local_key: 'zhou', display_name: '周平', mention_forms: [{ text: '周平', kind: 'name' }], entity_kind: 'human',
              role_hints: [], has_dialogue: false, participates_in_event: true, confidence: 0.95, uncertainty: '',
              evidence: [{ paragraph_id: zhou.paragraph_id, exact_quote: zhou.text, supports: 'name' }],
            },
          ], identity_claims: [],
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('本地模拟API启动失败');
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data') },
  });
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
    await page.locator('.create-row input').fill('身份界面测试');
    await page.getByRole('button', { name: '新建工程' }).click();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await expect(page.getByText('小说导入完成，结构化底稿已经建立')).toBeVisible();
    await page.getByRole('button', { name: '分析分块' }).click();
    await page.getByRole('button', { name: '生成新方案' }).click();
    await page.getByRole('button', { name: 'API 设置' }).click();
    await page.getByLabel('API 服务商').selectOption('custom');
    await page.getByLabel('自定义服务商名称').fill('本地模拟服务');
    await page.getByLabel('API 基础地址').fill(`http://127.0.0.1:${address.port}`);
    await page.getByLabel('API 密钥').fill('test-key');
    await page.getByLabel('全局默认模型').fill('mock-character-model');
    await page.getByRole('button', { name: '安全保存' }).click();
    await expect(page.getByText('API 与默认模型已安全保存')).toBeVisible();
    await page.getByRole('button', { name: '人物普查' }).click();
    await expect(page.getByRole('heading', { name: '人物普查' })).toBeVisible();
    await page.getByRole('button', { name: '开始人物普查' }).click();
    await expect(page.locator('.character-list')).toContainText('陆沉');
    const aliasCard = page.locator('.alias-list article').filter({ hasText: '小陆' });
    await aliasCard.getByRole('button', { name: '确认' }).click();
    await expect(page.getByText('别名已确认')).toBeVisible();

    await page.evaluate(() => { window.prompt = () => '二人在同一场景分别行动'; });
    await page.getByRole('button', { name: '明确是不同人物' }).click();
    await expect(page.getByText(/已禁止.*自动合并/)).toBeVisible();
    await page.getByRole('button', { name: '撤销最近操作' }).click();
    await expect(page.getByText('最近一次身份操作已撤销')).toBeVisible();

    await page.evaluate(() => { window.confirm = () => true; });
    await page.getByRole('button', { name: '合并到所选人物' }).click();
    await expect(page.getByText('人物已经合并，原身份和证据仍可撤销恢复')).toBeVisible();
    await page.getByRole('button', { name: '撤销最近操作' }).click();
    await page.locator('.character-list > button').filter({ hasText: '陆沉' }).click();
    await page.locator('.character-evidence input[type="checkbox"]').first().check();
    await page.getByPlaceholder('新人物名称').fill('另一个陆沉');
    await page.getByRole('button', { name: /拆出 1 条证据/ }).click();
    await expect(page.locator('.character-list')).toContainText('另一个陆沉');
    await page.getByRole('button', { name: '撤销最近操作' }).click();
    await expect(page.locator('.character-list')).not.toContainText('另一个陆沉');
    await page.getByRole('button', { name: '确认人物' }).click();
    await page.getByLabel('抽取强度').selectOption('2');
    await page.getByRole('button', { name: '提取人物档案' }).click();
    await expect(page.locator('.fact-list')).toContainText('常用称呼');
    await expect(page.locator('.fact-list')).toContainText('旁白断言');
    await expect(page.locator('.fact-list')).toContainText('行为推断');
    await page.locator('.fact-list article').first().getByRole('button', { name: '确认' }).click();
    await expect(page.getByText('人物事实已确认')).toBeVisible();
    await page.getByRole('button', { name: '对白归属' }).click();
    await expect(page.getByRole('heading', { name: '对白归属' })).toBeVisible();
    await page.getByRole('button', { name: '扫描全书对白' }).click();
    await expect(page.getByText('对白扫描完成；规则扫描未调用模型 API')).toBeVisible();
    await expect(page.locator('.quote-list')).toContainText('雨停了再走');
    await expect(page.locator('.quote-list')).toContainText('已确认：陆沉');
    await expect(page.locator('.attribution-list')).toContainText('明确言说线索');
    await expect(page.locator('.speech-profiles')).toContainText('2 条已确认对白');
    await page.getByRole('button', { name: '分析隐式轮次' }).click();
    await expect(page.getByText('本地轮次分析完成；新候选均保持待审核')).toBeVisible();
    await page.getByRole('button', { name: '事实整理' }).click();
    await expect(page.getByRole('heading', { name: '事实整理' })).toBeVisible();
    await page.getByRole('button', { name: '本地整理事实' }).click();
    await expect(page.getByText('事实整理完成；不同值只生成待审核关系，不会覆盖原始事实')).toBeVisible();
    await expect(page.locator('.fact-clusters')).toContainText('所在地点');
    const locationRelation = page.locator('.fact-relations article').filter({ hasText: '所在地点' });
    await expect(locationRelation).toContainText('客栈门口');
    await expect(locationRelation).toContainText('客栈内');
    await locationRelation.locator('select').selectOption('state_change');
    await locationRelation.getByRole('button', { name: '确认' }).click();
    await expect(page.getByText('事实关系已经确认')).toBeVisible();
    await expect(page.locator('.transition-section')).toContainText('客栈门口 → 客栈内');
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('validates the complete stage 1 flow against the configured live DeepSeek API', async () => {
  test.skip(process.env.RUN_LIVE_DEEPSEEK !== '1', 'Explicit opt-in only; consumes three small API requests');
  test.setTimeout(480_000);
  const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'novel-live-deepseek-'));
  const sourcePath = path.join(tempRoot, '小样本小说.txt');
  const cardPath = path.join(tempRoot, '沈青-真实验证-v2.json');
  await fsPromises.writeFile(sourcePath, [
    '第一章 雨夜客栈',
    '二〇二四年三月五日，沈青抵达青石镇。',
    '沈青披着湿透的青衫走进客栈。他行事谨慎，进门前先观察了四周。',
    '“给我一间安静的房。”沈青把银子放在柜台上。',
    '周平收起银子，领着沈青上了二楼。',
  ].join('\n'), 'utf8');
  const app = await electron.launch({ args: [path.resolve('.')], env: { ...process.env, NODE_ENV: 'test' } });
  try {
    await app.evaluate(({ dialog }, locations) => {
      Object.assign(dialog, {
        showOpenDialog: async (...args: unknown[]) => {
          const options = args.at(-1) as { title?: string };
          return { canceled: false, filePaths: [options?.title?.includes('TXT') ? locations.sourcePath : locations.tempRoot] };
        },
        showSaveDialog: async () => ({ canceled: false, filePath: locations.cardPath }),
      });
    }, { tempRoot, sourcePath, cardPath });
    const page = await app.firstWindow();
    expect(await page.evaluate(() => window.novelCompiler.getApiStatus())).toMatchObject({ configured: true });
    await page.locator('.create-row input').fill('DeepSeek V4 实际验证');
    await page.getByRole('button', { name: '新建工程' }).click();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await page.getByRole('button', { name: '分析分块' }).click();
    await page.getByRole('button', { name: '生成新方案' }).click();
    const jobId = await page.evaluate(async () => (await window.novelCompiler.startCharacterScan({
      model: 'deepseek-v4-flash',
      promptVersion: 'character_scan.v1',
    })).jobId);
    await expect.poll(async () => page.evaluate(async (id) => (await window.novelCompiler.listJobs()).find((job) => job.id === id)?.state, jobId), {
      timeout: 150_000,
      intervals: [1_000, 2_000, 3_000],
    }).toMatch(/^(completed|failed)$/);
    const finalJob = await page.evaluate(async (id) => (await window.novelCompiler.listJobs()).find((job) => job.id === id), jobId);
    expect(finalJob?.state, finalJob?.message).toBe('completed');
    const character = (await page.evaluate(() => window.novelCompiler.listCharacters())).find((item) => item.canonicalName === '沈青')!;
    expect(character).toBeDefined();
    await page.evaluate(async (identityId) => { await window.novelCompiler.reviewCharacter(identityId, { status: 'confirmed', importanceTier: 'core' }); }, character.id);

    const factJobId = await page.evaluate(async (identityId) => (await window.novelCompiler.startCharacterFactExtraction({
      identityId, model: 'deepseek-v4-flash', extractionPasses: 1,
    })).jobId, character.id);
    await expect.poll(async () => page.evaluate(async (id) => (await window.novelCompiler.listJobs()).find((job) => job.id === id)?.state, factJobId), {
      timeout: 150_000, intervals: [1_000, 2_000, 3_000],
    }).toMatch(/^(completed|failed)$/);
    const factJob = await page.evaluate(async (id) => (await window.novelCompiler.listJobs()).find((job) => job.id === id), factJobId);
    expect(factJob?.state, factJob?.message).toBe('completed');
    const facts = await page.evaluate((identityId) => window.novelCompiler.listCharacterFacts(identityId), character.id);
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      await page.evaluate(async (factId) => { await window.novelCompiler.reviewCharacterFact(factId, 'confirmed'); }, fact.id);
    }
    await page.evaluate(() => window.novelCompiler.scanCharacterQuotes());
    await page.evaluate(() => window.novelCompiler.scanTimeExpressions());
    const timeExpressions = await page.evaluate(() => window.novelCompiler.listTimeExpressions());
    for (const expression of timeExpressions) {
      await page.evaluate(async (item) => { await window.novelCompiler.reviewTimeExpression(item.id, 'confirmed', item.normalizedValue); }, {
        id: expression.id, normalizedValue: expression.normalizedValue,
      });
    }

    const eventJobId = await page.evaluate(async () => (await window.novelCompiler.startTimelineEventExtraction({ model: 'deepseek-v4-flash' })).jobId);
    await expect.poll(async () => page.evaluate(async (id) => (await window.novelCompiler.listJobs()).find((job) => job.id === id)?.state, eventJobId), {
      timeout: 150_000, intervals: [1_000, 2_000, 3_000],
    }).toMatch(/^(completed|failed)$/);
    const eventJob = await page.evaluate(async (id) => (await window.novelCompiler.listJobs()).find((job) => job.id === id), eventJobId);
    expect(eventJob?.state, eventJob?.message).toBe('completed');
    const event = (await page.evaluate(() => window.novelCompiler.listTimelineEvents()))[0];
    expect(event).toBeDefined();
    await page.evaluate(async (eventId) => { await window.novelCompiler.reviewTimelineEvent(eventId, 'confirmed'); }, event.id);

    const draft = await page.evaluate(({ identityId, eventId }) => window.novelCompiler.generateCharacterCardDraft(identityId, eventId), {
      identityId: character.id, eventId: event.id,
    });
    const reviewed = await page.evaluate(({ identityId, current }) => window.novelCompiler.saveCharacterCardDraft(identityId, {
      description: current.description, personality: current.personality, scenario: current.scenario,
      firstMes: '*沈青停在二楼木梯旁，安静地看向刚刚走进客栈的来客。*', mesExample: current.mesExample,
      creatorNotes: current.creatorNotes, systemPrompt: current.systemPrompt,
      postHistoryInstructions: current.postHistoryInstructions, alternateGreetings: current.alternateGreetings,
      tags: current.tags, creator: current.creator, characterVersion: '1.0',
    }, 'reviewed'), { identityId: character.id, current: draft });
    expect(reviewed.reviewStatus).toBe('reviewed');
    const exported = await page.evaluate((identityId) => window.novelCompiler.exportCharacterCardJson(identityId), character.id);
    expect(exported?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    const card = JSON.parse(await fsPromises.readFile(cardPath, 'utf8')) as { spec: string; data: { name: string } };
    expect(card).toMatchObject({ spec: 'chara_card_v2', data: { name: '沈青' } });
  } finally {
    await app.close();
    await fsPromises.rm(tempRoot, { recursive: true, force: true });
  }
});

test('checks the configured live provider without exposing its credential', async () => {
  test.skip(process.env.RUN_LIVE_PROVIDER_CHECK !== '1', 'Explicit opt-in only; reads the provider model list once');
  const app = await electron.launch({ args: [path.resolve('.')], env: { ...process.env, NODE_ENV: 'test' } });
  try {
    const page = await app.firstWindow();
    const status = await page.evaluate(() => window.novelCompiler.getApiStatus());
    expect(status).toMatchObject({ configured: true });
    const result = await page.evaluate(() => window.novelCompiler.testApiConnection());
    expect(result.ok, result.message).toBe(true);
  } finally {
    await app.close();
  }
});
