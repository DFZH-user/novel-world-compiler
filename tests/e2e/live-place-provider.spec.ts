import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

test('validates a real provider with an evidence-gated place scan', async () => {
  test.skip(process.env.RUN_LIVE_PLACE_PROVIDER !== '1', 'Explicit opt-in only; consumes two small completion requests');
  test.setTimeout(360_000);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-live-place-'));
  const sourcePath = path.join(tempRoot, '地点小样本.txt');
  const projectRoot = path.join(tempRoot, 'GLM地点验收.novelworld');
  await fs.writeFile(sourcePath, [
    '第一章 小镇',
    '二〇二四年三月五日，陆沉抵达青石镇。',
    '青石镇东的归雁客栈又称雁归店。归雁客栈坐落在青石镇。',
    '陆沉从青石镇沿官道前往归雁客栈。',
  ].join('\n'), 'utf8');

  const app = await electron.launch({ args: [path.resolve('.')], env: { ...process.env, NODE_ENV: 'test' } });
  let provider = '';
  let model = '';
  let aliasCount = 0;
  let relationCount = 0;
  let formalRelationCount = 0;
  let projectedEdgeCount = 0;
  let projectedEvidenceCount = 0;
  let placeScanStartedAt = 0;
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
    const status = await page.evaluate(() => window.novelCompiler.getApiStatus());
    expect(status.configured).toBe(true);
    expect(status.preferredModel).toBeTruthy();
    provider = status.provider ?? '';
    model = status.preferredModel!;

    await page.locator('.create-row input').fill('GLM地点验收');
    await page.getByRole('button', { name: '新建工程' }).click();
    await page.getByRole('button', { name: '导入 TXT' }).click();
    await page.getByRole('button', { name: '按此编码导入' }).click();
    await page.getByRole('button', { name: '分析分块' }).click();
    await page.getByRole('button', { name: '生成新方案' }).click();

    const eventStart = await page.evaluate((selectedModel) => window.novelCompiler.startTimelineEventExtraction({ model: selectedModel, promptVersion: 'timeline-events.v1' }), model);
    await expect.poll(async () => page.evaluate(async (jobId) => (await window.novelCompiler.listJobs()).find((job) => job.id === jobId), eventStart.jobId), {
      timeout: 150_000,
      intervals: [1_000, 2_000, 3_000],
    }).toMatchObject({ state: 'completed' });
    const events = await page.evaluate(() => window.novelCompiler.listTimelineEvents());
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) await page.evaluate((eventId) => window.novelCompiler.reviewTimelineEvent(eventId, 'confirmed'), event.id);
    const bootstrap = await page.evaluate(() => window.novelCompiler.bootstrapPlacesFromEvents());
    expect(bootstrap.createdPlaceCount).toBeGreaterThanOrEqual(2);
    const places = await page.evaluate(() => window.novelCompiler.listPlaces());
    expect(places.map((item) => item.canonicalName)).toEqual(expect.arrayContaining(['青石镇', '归雁客栈']));
    for (const place of places) {
      const placeType = place.canonicalName === '青石镇' ? 'settlement' : place.canonicalName === '归雁客栈' ? 'building' : place.placeType;
      await page.evaluate(({ placeId, selectedType }) => window.novelCompiler.reviewPlace(placeId, { status: 'confirmed', placeType: selectedType }), {
        placeId: place.id,
        selectedType: placeType,
      });
    }
    await expect.poll(() => page.evaluate(() => window.novelCompiler.estimatePlaceModelScan())).toMatchObject({ ready: true, confirmedPlaceCount: expect.any(Number), chunkCount: 1 });
    placeScanStartedAt = Date.now();
    const placeStart = await page.evaluate((selectedModel) => window.novelCompiler.startPlaceModelScan({ model: selectedModel, promptVersion: 'place-model.v1' }), model);
    await expect.poll(async () => page.evaluate(async (jobId) => (await window.novelCompiler.listJobs()).find((job) => job.id === jobId), placeStart.jobId), {
      timeout: 150_000,
      intervals: [1_000, 2_000, 3_000],
    }).toMatchObject({ state: 'completed' });
    const refreshedPlaces = await page.evaluate(() => window.novelCompiler.listPlaces());
    const inn = refreshedPlaces.find((item) => item.canonicalName === '归雁客栈')!;
    const aliases = await page.evaluate((placeId) => window.novelCompiler.listPlaceAliases(placeId), inn.id);
    const relations = await page.evaluate(() => window.novelCompiler.listPlaceRelationCandidates('pending'));
    aliasCount = aliases.filter((item) => item.source === 'model').length;
    relationCount = relations.length;
    expect(aliases.some((item) => item.alias === '雁归店' && item.reviewStatus === 'pending')).toBe(true);
    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) {
      const evidence = await page.evaluate((candidateId) => window.novelCompiler.listPlaceRelationCandidateEvidence(candidateId), relation.id);
      expect(evidence.some((item) => item.evidenceRole === 'support')).toBe(true);
      await page.evaluate((candidateId) => window.novelCompiler.reviewPlaceRelationCandidate(candidateId, 'confirmed'), relation.id);
      const assertion = await page.evaluate((candidateId) => window.novelCompiler.createPlaceRelationFromCandidate(candidateId), relation.id);
      expect(assertion.reviewStatus).toBe('pending');
      await page.evaluate((relationId) => window.novelCompiler.reviewPlaceRelation(relationId, 'confirmed'), assertion.id);
    }
    const formalRelations = await page.evaluate(() => window.novelCompiler.listPlaceRelations('confirmed'));
    formalRelationCount = formalRelations.length;
    expect(formalRelationCount).toBeGreaterThan(0);
    const map = await page.evaluate(() => window.novelCompiler.getNarrativeMapProjection(Number.MAX_SAFE_INTEGER));
    projectedEdgeCount = map.edges.length;
    projectedEvidenceCount = map.evidence.length;
    expect(map.coordinateSemantics).toBe('topology-only');
    expect(map.edges.length).toBeGreaterThan(0);
    expect(map.evidence.some((item) => item.evidenceRole === 'support')).toBe(true);
  } finally {
    await app.close();
  }

  const database = new DatabaseSync(path.join(projectRoot, 'novel.db'), { readOnly: true });
  const run = database.prepare(`SELECT status, input_tokens, output_tokens, alias_count, identity_link_count, relation_candidate_count
    FROM place_model_scan_runs ORDER BY created_at DESC LIMIT 1`).get() as Record<string, string | number | bigint | null> | undefined;
  database.close();
  expect(run).toBeDefined();
  const result = {
    provider,
    model,
    status: run?.status,
    inputTokens: Number(run?.input_tokens),
    outputTokens: Number(run?.output_tokens),
    aliasCount,
    identityLinkCount: Number(run?.identity_link_count),
    relationCount,
    formalRelationCount,
    projectedEdgeCount,
    projectedEvidenceCount,
    elapsedMs: Date.now() - placeScanStartedAt,
  };
  await fs.mkdir(path.resolve('test-results'), { recursive: true });
  await fs.writeFile(path.resolve('test-results', 'live-place-provider-result.json'), JSON.stringify(result, null, 2), 'utf8');
  await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
