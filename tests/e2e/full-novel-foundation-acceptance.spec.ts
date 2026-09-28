import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test, _electron as electron, type Page } from '@playwright/test';
import { SCHEMA_VERSION } from '../../electron/worker/schema';

const DEFAULT_SOURCE = 'D:\\小说\\冒姓琅琊(1-375章).txt';
const MOCK_MODEL = 'local-deterministic-foundation-model';

type PromptParagraph = { paragraph_id: string; text: string; role?: string };
type ModelPrompt = {
  task: string;
  paragraphs: PromptParagraph[];
  target_character?: { identity_id: string; name: string };
  supplied_characters?: Array<{ identity_id: string; name: string }>;
};

async function fileHash(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function validateIsolatedSillyTavernImport(cardPath: string, tempRoot: string): Promise<Record<string, unknown>> {
  const sourceRoot = process.env.SILLYTAVERN_SOURCE_ROOT || 'E:\\SillyTavern\\SillyTavern-SillyTavern-51ad27f';
  const packagePath = path.join(sourceRoot, 'package.json');
  try { await fs.access(packagePath); } catch { return { executed: false, reason: 'SillyTavern source not found' }; }
  const packageJson = JSON.parse(await fs.readFile(packagePath, 'utf8')) as { version: string };
  const portProbe = createServer();
  await new Promise<void>((resolve) => portProbe.listen(0, '127.0.0.1', resolve));
  const address = portProbe.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 SillyTavern 隔离验收端口');
  const port = address.port;
  await new Promise<void>((resolve, reject) => portProbe.close((error) => error ? reject(error) : resolve()));
  const dataRoot = path.join(tempRoot, 'sillytavern-isolated-data');
  await fs.mkdir(dataRoot, { recursive: true });
  const sourceWebpackCache = path.join(sourceRoot, 'data', '_webpack');
  try { await fs.cp(sourceWebpackCache, path.join(dataRoot, '_webpack'), { recursive: true }); } catch { /* cold cache fallback */ }
  const configPath = path.join(dataRoot, 'isolated-config.yaml');
  const isolatedConfig = (await fs.readFile(path.join(sourceRoot, 'config.yaml'), 'utf8'))
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

    const sourceCard = JSON.parse(await fs.readFile(cardPath, 'utf8')) as {
      data: { name: string; character_book?: { entries: unknown[] } };
    };
    const form = new FormData();
    form.append('file_type', 'json');
    form.append('avatar', new Blob([await fs.readFile(cardPath, 'utf8')], { type: 'application/json' }), path.basename(cardPath));
    const importedResponse = await fetch(`${baseUrl}/api/characters/import`, { method: 'POST', body: form });
    const importedBody = await importedResponse.json() as { file_name?: string; error?: boolean };
    if (!importedResponse.ok || importedBody.error || !importedBody.file_name) {
      throw new Error(`SillyTavern 角色导入失败：${JSON.stringify(importedBody)}`);
    }
    const listResponse = await fetch(`${baseUrl}/api/characters/all`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const characters = await listResponse.json() as Array<{
      name: string; data?: { character_book?: { entries?: unknown[] } };
    }>;
    const imported = characters.find((character) => character.name === sourceCard.data.name);
    if (!imported) throw new Error('SillyTavern 导入成功但角色列表未返回目标角色');
    const importedEntryCount = imported.data?.character_book?.entries?.length ?? -1;
    const sourceEntryCount = sourceCard.data.character_book?.entries.length ?? -1;
    if (importedEntryCount !== sourceEntryCount) throw new Error('SillyTavern 导入后未完整保留内嵌 character_book');
    return {
      executed: true, version: packageJson.version, endpoint: '/api/characters/import',
      importedFileName: importedBody.file_name, characterName: imported.name,
      sourceEntryCount, importedEntryCount, isolatedDataRoot: dataRoot,
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

async function waitForJob(page: Page, jobId: string, timeout = 120_000): Promise<void> {
  await expect.poll(async () => page.evaluate(async (id) => {
    const job = (await window.novelCompiler.listJobs()).find((item) => item.id === id);
    return job ? `${job.state}:${job.message}` : 'missing';
  }, jobId), { timeout, intervals: [250, 500, 1_000] }).toMatch(/^completed:/u);
}

test('accepts another full novel from import through refinement and three foundation artifacts', async () => {
  test.skip(process.env.RUN_FULL_NOVEL_FOUNDATION_CHECK !== '1', 'Explicit local full-novel foundation acceptance only');
  test.setTimeout(1_500_000);

  const sourcePath = process.env.FULL_NOVEL_FOUNDATION_SOURCE || DEFAULT_SOURCE;
  await fs.access(sourcePath);
  const sourceStat = await fs.stat(sourcePath);
  const sourceHashBefore = await fileHash(sourcePath);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-full-foundation-'));
  const projectName = '冒姓琅琊全链路验收';
  const requestCounts: Record<string, number> = {};
  const factsProduced = new Set<string>();
  let eventProduced = false;

  const apiServer = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: MOCK_MODEL }] }));
      return;
    }
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      try {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
        const prompt = JSON.parse(body.messages.find((message) => message.role === 'user')!.content) as ModelPrompt;
        requestCounts[prompt.task] = (requestCounts[prompt.task] ?? 0) + 1;
        const core = prompt.paragraphs.filter((paragraph) => paragraph.role === undefined || paragraph.role === 'core');
        let result: unknown;

        if (prompt.task === 'character_census') {
          const characters = [
            { localKey: 'wang_yang', name: '王扬' },
            { localKey: 'xie_xinghan', name: '谢星涵' },
          ].flatMap((target) => {
            const evidence = core.find((paragraph) => paragraph.text.includes(target.name));
            if (!evidence) return [];
            return [{
              local_key: target.localKey,
              display_name: target.name,
              mention_forms: [{ text: target.name, kind: 'name' }],
              entity_kind: 'human',
              role_hints: ['核心人物候选'],
              has_dialogue: /[“”]/u.test(evidence.text),
              participates_in_event: true,
              evidence: [{ paragraph_id: evidence.paragraph_id, exact_quote: evidence.text, supports: 'event' }],
              confidence: 0.99,
              uncertainty: '',
            }];
          });
          result = { characters, identity_claims: [] };
        } else if (prompt.task === 'character_fact_extraction') {
          const target = prompt.target_character!;
          const evidence = prompt.paragraphs.find((paragraph) => paragraph.text.includes(target.name));
          if (!evidence || factsProduced.has(target.name)) {
            result = { facts: [] };
          } else {
            factsProduced.add(target.name);
            result = { facts: [{
              category: 'identity', predicate: '人物称呼', value: target.name,
              source_type: 'explicit', assertion_mode: 'narrator_assertion', truth_status: 'asserted',
              attributed_source_name: null, confidence: 0.99, visibility: 'public',
              valid_from_paragraph_id: null, valid_to_paragraph_id: null,
              evidence: [{ paragraph_id: evidence.paragraph_id, exact_quote: evidence.text, role: 'support' }],
              reasoning_note: '长篇验收的最小可追溯身份事实。',
            }] };
          }
        } else if (prompt.task === 'timeline_event_extraction') {
          const meeting = core.find((paragraph) => paragraph.text.includes('谢星涵首先开口了') && paragraph.text.includes('公子通诗否'));
          const location = core.find((paragraph) => paragraph.text.includes('郡学'));
          if (!meeting || !location || eventProduced) {
            result = { events: [] };
          } else {
            eventProduced = true;
            const supplied = new Map((prompt.supplied_characters ?? []).map((item) => [item.name, item.identity_id]));
            result = { events: [{
              local_key: 'wang_xie_first_dialogue', title: '王扬与谢星涵在郡学交锋',
              summary: '王扬与谢星涵在郡学首次正面对话。', event_type: 'meeting',
              participants: [
                { identity_id: supplied.get('王扬') ?? null, surface_name: '王扬', role: 'participant', action_text: '参与对话', confidence: 0.99 },
                { identity_id: supplied.get('谢星涵') ?? null, surface_name: '谢星涵', role: 'speaker', action_text: '主动发问', confidence: 0.99 },
              ],
              locations: [{ surface_name: '郡学', normalized_name: '郡学', role: 'at', confidence: 0.99 }],
              time_links: [],
              evidence: [
                { paragraph_id: meeting.paragraph_id, exact_quote: meeting.text, role: 'support' },
                { paragraph_id: location.paragraph_id, exact_quote: location.text, role: 'support' },
              ],
              confidence: 0.99, uncertainty: '',
            }] };
          }
        } else {
          throw new Error(`unexpected task: ${prompt.task}`);
        }

        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 100, completion_tokens: 30 },
        }));
      } catch (error) {
        response.writeHead(500, { 'Content-Type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
  });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('本地确定性模型服务启动失败');

  const startedAt = Date.now();
  const timings: Record<string, number> = {};
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data') },
  });
  let report: Record<string, unknown> = {};
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
    const importStartedAt = Date.now();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await expect(page.getByRole('heading', { name: '确认文本编码' })).toBeVisible();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await expect(page.getByText('小说导入完成，结构化底稿已经建立')).toBeVisible({ timeout: 90_000 });
    timings.importMs = Date.now() - importStartedAt;

    await page.evaluate(async ({ port }) => {
      await window.novelCompiler.saveApiConfig({
        provider: '本地确定性验收服务', baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'local-test-key', preferredModel: 'local-deterministic-foundation-model',
      });
    }, { port: address.port });
    await expect(page.evaluate(() => window.novelCompiler.testApiConnection())).resolves.toMatchObject({ ok: true });

    await page.locator('aside').getByRole('button', { name: /一键生成/u }).click();
    await expect(page.getByRole('heading', { name: '一键生成基础版本' })).toBeVisible();
    const workflowStartedAt = Date.now();
    await page.getByRole('button', { name: '一键开始' }).click();
    await expect.poll(async () => page.evaluate(async () => {
      const run = (await window.novelCompiler.listFoundationWorkflows())[0];
      return run ? `${run.state}:${run.completedSteps}/${run.totalSteps}:${run.currentStepKey ?? 'none'}:${run.message}` : 'missing';
    }), { timeout: 1_200_000, intervals: [1_000, 2_000, 3_000] }).toMatch(/^completed:/u);
    timings.workflowMs = Date.now() - workflowStartedAt;

    const workflow = (await page.evaluate(() => window.novelCompiler.listFoundationWorkflows()))[0];
    expect(workflow.steps).toHaveLength(11);
    expect(workflow.steps.every((step) => ['completed', 'skipped'].includes(step.state))).toBe(true);
    const selectionStep = workflow.steps.find((step) => step.stepKey === 'draft_selection')!;
    const selectionOutput = JSON.parse(selectionStep.outputJson ?? '{}') as {
      selectedCharacters?: Array<{ identityId: string; identityName: string }>;
    };

    let characters = await page.evaluate(() => window.novelCompiler.listCharacters());
    const targetCharacters = characters.filter((item) => ['王扬', '谢星涵'].includes(item.canonicalName));
    expect(targetCharacters).toHaveLength(2);
    for (const character of targetCharacters) {
      await page.evaluate((identityId) => window.novelCompiler.reviewCharacter(identityId, { status: 'confirmed', importanceTier: 'core' }), character.id);
    }
    characters = await page.evaluate(() => window.novelCompiler.listCharacters());

    for (const character of characters.filter((item) => ['王扬', '谢星涵'].includes(item.canonicalName))) {
      let facts = await page.evaluate((identityId) => window.novelCompiler.listCharacterFacts(identityId), character.id);
      if (!facts.length) {
        const started = await page.evaluate(({ identityId }) => window.novelCompiler.startCharacterFactExtraction({
          identityId, model: 'local-deterministic-foundation-model', extractionPasses: 1,
        }), { identityId: character.id });
        await waitForJob(page, started.jobId);
        facts = await page.evaluate((identityId) => window.novelCompiler.listCharacterFacts(identityId), character.id);
      }
      expect(facts.length).toBeGreaterThan(0);
      for (const fact of facts) await page.evaluate((factId) => window.novelCompiler.reviewCharacterFact(factId, 'confirmed'), fact.id);
    }

    const events = await page.evaluate(() => window.novelCompiler.listTimelineEvents());
    const entryEvent = events.find((event) => event.title === '王扬与谢星涵在郡学交锋');
    expect(entryEvent).toBeDefined();
    await page.evaluate((eventId) => window.novelCompiler.reviewTimelineEvent(eventId, 'confirmed'), entryEvent!.id);

    const places = await page.evaluate(() => window.novelCompiler.listPlaces());
    const school = places.find((place) => place.canonicalName === '郡学');
    expect(school).toBeDefined();
    await page.evaluate((place) => window.novelCompiler.reviewPlace(place.id, {
      status: 'confirmed', placeType: place.placeType, canonicalName: place.canonicalName,
    }), school!);

    const confirmedTargets = (await page.evaluate(() => window.novelCompiler.listCharacters()))
      .filter((item) => ['王扬', '谢星涵'].includes(item.canonicalName));
    const wang = confirmedTargets.find((item) => item.canonicalName === '王扬')!;
    const xie = confirmedTargets.find((item) => item.canonicalName === '谢星涵')!;
    let candidates = await page.evaluate(() => window.novelCompiler.listRelationshipCandidates());
    let candidate = candidates.find((item) => new Set([item.sourceIdentityId, item.targetIdentityId]).has(wang.id)
      && new Set([item.sourceIdentityId, item.targetIdentityId]).has(xie.id));
    if (!candidate) {
      const hit = (await page.evaluate(() => window.novelCompiler.search('公子通诗否')))[0];
      expect(hit).toBeDefined();
      const anchor = await page.evaluate((paragraphId) => window.novelCompiler.getEvidenceAnchor(paragraphId), hit.paragraphId);
      candidate = await page.evaluate(({ sourceIdentityId, targetIdentityId, paragraphId, exactQuote }) =>
        window.novelCompiler.createRelationshipCandidate({
          sourceIdentityId, targetIdentityId, method: 'user', proposedType: '初识与交锋', confidence: 0.95,
          evidence: [{ paragraphId, exactQuote, role: 'clue' }],
        }), { sourceIdentityId: wang.id, targetIdentityId: xie.id, paragraphId: hit.paragraphId, exactQuote: anchor.quote });
      candidates = [...candidates, candidate];
    }
    await page.evaluate((candidateId) => window.novelCompiler.reviewRelationshipCandidate(candidateId, 'confirmed'), candidate.id);
    const candidateEvidence = await page.evaluate((candidateId) => window.novelCompiler.listRelationshipCandidateEvidence(candidateId), candidate.id);
    const revealedEvidence = candidateEvidence.find((item) => item.paragraphOrdinal <= entryEvent!.narrativeStartOrdinal) ?? candidateEvidence[0];
    expect(revealedEvidence).toBeDefined();
    const relationship = await page.evaluate(({ candidate, evidence }) => window.novelCompiler.createRelationship({
      sourceIdentityId: candidate.sourceIdentityId, targetIdentityId: candidate.targetIdentityId,
      relationshipType: '初识与交锋', direction: 'reciprocal', strength: 0.55, polarity: -0.1,
      informationSourceType: 'narrator', truthStatus: 'asserted', confidence: 0.95,
      extractionMethod: 'user', candidateId: candidate.id, reasoningNote: '长篇桌面验收的人工二次审核断言。',
      evidence: [{ paragraphId: evidence.paragraphId, exactQuote: evidence.exactQuote, role: 'support' }],
    }), { candidate, evidence: revealedEvidence });
    await page.evaluate((relationshipId) => window.novelCompiler.reviewRelationship(relationshipId, 'confirmed'), relationship.id);

    const refinement = await page.evaluate(() => window.novelCompiler.getRefinementDashboard());
    expect(refinement).toMatchObject({ readyForArtifactDrafts: true, policyVersion: 'refinement-triage.v1', counts: { must: 0 } });
    await page.locator('aside').getByRole('button', { name: /统一精修/u }).click();
    await expect(page.getByRole('heading', { name: '统一精修台' })).toBeVisible();
    await expect(page.getByText('可以生成角色卡、图谱与地图基础稿')).toBeVisible();

    const before = await page.evaluate((eventId) => window.novelCompiler.getArtifactFoundationStatus(eventId), entryEvent!.id);
    expect(before).toMatchObject({ refinementReady: true, canGenerate: true, policyVersion: 'artifact-foundation.v1' });
    const generation = await page.evaluate((eventId) => window.novelCompiler.generateArtifactFoundation(eventId), entryEvent!.id);
    expect(generation.characterCards).toMatchObject({ generatedCount: 2, failedCount: 0 });
    expect(generation.relationshipGraph.nodeCount).toBeGreaterThanOrEqual(2);
    expect(generation.relationshipGraph.relationshipCount).toBeGreaterThanOrEqual(1);
    expect(generation.narrativeMap.nodeCount).toBeGreaterThanOrEqual(1);

    const draftTimestamps = Object.fromEntries(await Promise.all(confirmedTargets.map(async (character) => {
      const draft = await page.evaluate((identityId) => window.novelCompiler.getCharacterCardDraft(identityId), character.id);
      return [character.id, draft?.updatedAt ?? null] as const;
    })));
    const repeated = await page.evaluate((eventId) => window.novelCompiler.generateArtifactFoundation(eventId), entryEvent!.id);
    expect(repeated.characterCards).toMatchObject({ generatedCount: 0, skippedCount: 2, failedCount: 0 });
    expect(repeated.relationshipGraph.sourceFingerprint).toBe(generation.relationshipGraph.sourceFingerprint);
    expect(repeated.narrativeMap.sourceFingerprint).toBe(generation.narrativeMap.sourceFingerprint);
    for (const character of confirmedTargets) {
      const draft = await page.evaluate((identityId) => window.novelCompiler.getCharacterCardDraft(identityId), character.id);
      expect(draft?.updatedAt).toBe(draftTimestamps[character.id]);
    }

    for (const character of confirmedTargets) {
      const draft = await page.evaluate((identityId) => window.novelCompiler.getCharacterCardDraft(identityId), character.id);
      expect(draft).not.toBeNull();
      await page.evaluate(({ identityId, draft, identityName }) => window.novelCompiler.saveCharacterCardDraft(identityId, {
        description: draft.description,
        personality: draft.personality.trim() || `${identityName}会依据当前已确认事实和状态行动。`,
        scenario: draft.scenario,
        firstMes: draft.firstMes,
        mesExample: draft.mesExample.trim() || `<START>\n{{char}}: 我们从当前进入时刻继续。`,
        creatorNotes: draft.creatorNotes,
        systemPrompt: draft.systemPrompt,
        postHistoryInstructions: draft.postHistoryInstructions,
        alternateGreetings: draft.alternateGreetings,
        tags: draft.tags,
        creator: draft.creator,
        characterVersion: '1.0-acceptance',
      }, 'reviewed'), { identityId: character.id, draft: draft!, identityName: character.canonicalName });
    }

    await page.locator('aside').getByRole('button', { name: /基础稿生成/u }).click();
    await expect(page.getByRole('heading', { name: '三类基础稿生成台' })).toBeVisible();
    await expect(page.getByText('REFINEMENT GATE PASSED')).toBeVisible();
    await expect(page.getByRole('heading', { name: '角色卡基础稿' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '人物关系图基础稿' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '世界地图基础稿' })).toBeVisible();
    const exportDashboard = await page.evaluate((eventId) => window.novelCompiler.getArtifactFoundationStatus(eventId), entryEvent!.id);
    expect(exportDashboard.gates).toHaveLength(3);
    expect(exportDashboard.gates.every((gate) => gate.exportReady)).toBe(true);
    await expect(page.getByRole('button', { name: '导出可游玩整合包' })).toBeEnabled();
    await page.getByRole('button', { name: '导出可游玩整合包' }).click();
    await expect(page.getByRole('heading', { name: '可游玩整合包已生成' })).toBeVisible();
    const bundleDirectories = (await fs.readdir(tempRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.includes('-可游玩包-P'));
    expect(bundleDirectories).toHaveLength(1);
    const packageDirectory = path.join(tempRoot, bundleDirectories[0].name);
    const bundleManifest = JSON.parse(await fs.readFile(path.join(packageDirectory, 'manifest.json'), 'utf8')) as {
      spec_version: string;
      source_fingerprints: { bundle: string };
      character_count: number;
      character_book_entry_count: number;
      files: Array<{ path: string; kind: string; checksum: string }>;
    };
    expect(bundleManifest).toMatchObject({ spec_version: '1.0', character_count: 2 });
    expect(bundleManifest.character_book_entry_count).toBeGreaterThanOrEqual(2);
    for (const file of bundleManifest.files) {
      expect(await fileHash(path.join(packageDirectory, ...file.path.split('/')))).toBe(file.checksum);
    }
    const bundledCards = bundleManifest.files.filter((file) => file.kind === 'character-card');
    expect(bundledCards).toHaveLength(2);
    for (const file of bundledCards) {
      const card = JSON.parse(await fs.readFile(path.join(packageDirectory, ...file.path.split('/')), 'utf8')) as {
        data: { character_book?: { entries: unknown[] } };
      };
      expect(card.data.character_book?.entries.length).toBe(bundleManifest.character_book_entry_count);
    }
    const sillyTavernImport = await validateIsolatedSillyTavernImport(
      path.join(packageDirectory, ...bundledCards[0].path.split('/')), tempRoot,
    );
    expect(sillyTavernImport).toMatchObject({
      executed: true, version: '1.18.0',
      sourceEntryCount: bundleManifest.character_book_entry_count,
      importedEntryCount: bundleManifest.character_book_entry_count,
    });
    await page.getByRole('button', { name: '导出可游玩整合包' }).click();
    await expect(page.getByRole('heading', { name: '已复用相同整合包' })).toBeVisible();

    await app.evaluate(({ dialog }, directory) => {
      Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [directory] }) });
    }, packageDirectory);
    const bundleValidation = await page.evaluate(() => window.novelCompiler.validatePlayableBundle());
    expect(bundleValidation).toMatchObject({
      valid: true, sillyTavernCompatible: true, currentProjectMatch: true,
      fileCount: bundleManifest.files.length, validFileCount: bundleManifest.files.length,
      characterCount: bundleManifest.character_count,
      characterBookEntryCount: bundleManifest.character_book_entry_count,
      issues: [],
    });
    await page.getByRole('button', { name: '校验已有整合包' }).click();
    await expect(page.getByRole('heading', { name: '整合包完整且可导入' })).toBeVisible();

    const [chapters, chunks, diagnostics, factsByCharacter, confirmedPlaces, confirmedRelationships] = await Promise.all([
      page.evaluate(() => window.novelCompiler.listChapters()),
      page.evaluate(() => window.novelCompiler.listChunks()),
      page.evaluate(() => window.novelCompiler.runProjectDiagnostics('full')),
      Promise.all(confirmedTargets.map(async (character) => ({
        name: character.canonicalName,
        count: (await page.evaluate((identityId) => window.novelCompiler.listCharacterFacts(identityId), character.id))
          .filter((fact) => fact.reviewStatus === 'confirmed').length,
      }))),
      page.evaluate(() => window.novelCompiler.listPlaces('confirmed')),
      page.evaluate(() => window.novelCompiler.listRelationships('confirmed')),
    ]);
    expect(chapters).toHaveLength(376);
    expect(chapters.filter((chapter) => /^第\s*\d+\s*章/u.test(chapter.title))).toHaveLength(375);
    expect(chunks.length).toBeGreaterThan(100);
    expect(diagnostics).toMatchObject({ overallStatus: 'ok', schemaVersion: SCHEMA_VERSION, expectedSchemaVersion: SCHEMA_VERSION });

    report = {
      sourcePath, sourceBytes: sourceStat.size, sourceSha256: sourceHashBefore,
      sourceUnchanged: true, projectName, schemaVersion: SCHEMA_VERSION,
      chapterCount: chapters.length, paragraphCount: diagnostics.paragraphCount, chunkCount: chunks.length,
      workflow: {
        runId: workflow.id, state: workflow.state, stepCount: workflow.steps.length,
        steps: workflow.steps.map((step) => ({ key: step.stepKey, state: step.state })),
        selectedCharacters: selectionOutput.selectedCharacters?.map((item) => item.identityName) ?? [],
      },
      model: { mode: 'local-deterministic', externalApiCalled: false, requestCounts },
      characters: confirmedTargets.map((item) => ({
        name: item.canonicalName, reviewStatus: item.reviewStatus, importanceTier: item.importanceTier,
        importanceScore: item.importanceScore, mentionCount: item.mentionCount, chapterCount: item.chapterCount,
      })),
      confirmedFacts: factsByCharacter,
      confirmedEventCount: 1, confirmedPlaceCount: confirmedPlaces.length,
      confirmedRelationshipCount: confirmedRelationships.length,
      refinement: { policyVersion: refinement.policyVersion, counts: refinement.counts, ready: refinement.readyForArtifactDrafts },
      artifacts: {
        policyVersion: exportDashboard.policyVersion,
        cards: generation.characterCards,
        relationshipGraph: generation.relationshipGraph,
        narrativeMap: generation.narrativeMap,
        gates: exportDashboard.gates.map((gate) => ({
          kind: gate.kind, status: gate.status, foundationReady: gate.foundationReady,
          exportReady: gate.exportReady, metrics: gate.metrics, sourceFingerprint: gate.sourceFingerprint,
        })),
        repeatedGeneration: { generatedCards: repeated.characterCards.generatedCount, skippedCards: repeated.characterCards.skippedCount,
          graphFingerprintStable: repeated.relationshipGraph.sourceFingerprint === generation.relationshipGraph.sourceFingerprint,
          mapFingerprintStable: repeated.narrativeMap.sourceFingerprint === generation.narrativeMap.sourceFingerprint,
          cardTimestampsStable: true },
      },
      playableBundle: {
        specVersion: bundleManifest.spec_version,
        bundleFingerprint: bundleManifest.source_fingerprints.bundle,
        characterCount: bundleManifest.character_count,
        characterBookEntryCount: bundleManifest.character_book_entry_count,
        managedFileCount: bundleManifest.files.length,
        repeatedExportReused: true,
        validation: bundleValidation,
        sillyTavernImport,
      },
      diagnostics: { overallStatus: diagnostics.overallStatus, foreignKeyViolationCount: diagnostics.foreignKeyViolationCount,
        ftsRowCount: diagnostics.ftsRowCount, source: diagnostics.source },
      timings: { ...timings, totalElapsedMs: Date.now() - startedAt },
    };
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
    expect(await fileHash(sourcePath)).toBe(sourceHashBefore);
    await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  await fs.mkdir(path.resolve('verification-results'), { recursive: true });
  await fs.writeFile(path.resolve('verification-results', 'full-novel-foundation-acceptance-result.json'), JSON.stringify(report, null, 2), 'utf8');
});
