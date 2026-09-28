import { _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-graph-review-'));
const sourcePath = path.join(tempRoot, '关系图视觉审查.txt');
const screenshotPath = path.resolve('test-results', 'relationship-graph-review.png');
await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
await fs.writeFile(sourcePath, [
  '第一章 城门',
  '陆沉与林月结伴守城，二人约定彼此照应。',
  '林月却开始怀疑陆沉隐瞒了城中的消息。',
  '直到夜深，二人仍站在同一座城楼上。',
].join('\n'), 'utf8');

const apiServer = createServer((request, response) => {
  if (request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'graph-review-model' }] }));
    return;
  }
  let raw = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const body = JSON.parse(raw);
    const payload = JSON.parse(body.messages.find((message) => message.role === 'user').content);
    const paragraph = payload.paragraphs.find((item) => item.text.includes('结伴守城'));
    const result = {
      characters: [
        { local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }], entity_kind: 'human', role_hints: ['守城者'], has_dialogue: false, participates_in_event: true, confidence: 0.98, uncertainty: '', evidence: [{ paragraph_id: paragraph.paragraph_id, exact_quote: paragraph.text, supports: 'name' }] },
        { local_key: 'lin', display_name: '林月', mention_forms: [{ text: '林月', kind: 'name' }], entity_kind: 'human', role_hints: ['守城者'], has_dialogue: false, participates_in_event: true, confidence: 0.98, uncertainty: '', evidence: [{ paragraph_id: paragraph.paragraph_id, exact_quote: paragraph.text, supports: 'name' }] },
      ],
      identity_claims: [],
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }], usage: { prompt_tokens: 40, completion_tokens: 30 } }));
  });
});
await new Promise((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
const address = apiServer.address();
if (!address || typeof address === 'string') throw new Error('mock API failed');

const app = await electron.launch({
  args: [path.resolve('.')],
  env: { ...process.env, NODE_ENV: 'test', NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data') },
});
try {
  await app.evaluate(({ dialog }, locations) => {
    Object.assign(dialog, {
      showOpenDialog: async (...args) => {
        const options = args.at(-1);
        return { canceled: false, filePaths: [options?.title?.includes('TXT') ? locations.sourcePath : locations.tempRoot] };
      },
    });
  }, { tempRoot, sourcePath });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1500, height: 980 });
  await page.locator('.create-row input').fill('关系图视觉审查');
  await page.getByRole('button', { name: '新建工程' }).click();
  await page.getByRole('button', { name: '导入 TXT' }).click();
  await page.getByRole('button', { name: '按此编码导入' }).click();
  await page.getByRole('button', { name: '分析分块' }).click();
  await page.getByRole('button', { name: '生成新方案' }).click();
  await page.evaluate((baseUrl) => window.novelCompiler.saveApiConfig({ provider: '视觉审查', baseUrl, apiKey: 'test', preferredModel: 'graph-review-model' }), `http://127.0.0.1:${address.port}`);
  const jobId = await page.evaluate(async () => (await window.novelCompiler.startCharacterScan({ model: 'graph-review-model' })).jobId);
  await page.waitForFunction(async (id) => (await window.novelCompiler.listJobs()).find((job) => job.id === id)?.state === 'completed', jobId);
  const characters = await page.evaluate(() => window.novelCompiler.listCharacters());
  for (const character of characters) {
    await page.evaluate((identityId) => window.novelCompiler.reviewCharacter(identityId, { status: 'confirmed', importanceTier: 'core' }), character.id);
    await page.waitForTimeout(120);
  }
  await page.evaluate(async () => {
    const confirmed = await window.novelCompiler.listCharacters();
    const lu = confirmed.find((item) => item.canonicalName === '陆沉');
    const lin = confirmed.find((item) => item.canonicalName === '林月');
    const paragraph = (await window.novelCompiler.listParagraphs()).find((item) => item.text.includes('结伴守城'));
    if (!lu || !lin || !paragraph) throw new Error('visual fixture is incomplete');
    return { luId: lu.id, linId: lin.id, paragraphId: paragraph.id, paragraphText: paragraph.text };
  }).then(async (fixture) => {
    for (const assertion of [
      { relationshipType: '守城同盟', polarity: 0.8, truthStatus: 'asserted' },
      { relationshipType: '互相戒备', polarity: -0.7, truthStatus: 'disputed' },
    ]) {
      const relationship = await page.evaluate(({ fixture, assertion }) => window.novelCompiler.createRelationship({
        sourceIdentityId: fixture.luId, targetIdentityId: fixture.linId, relationshipType: assertion.relationshipType,
        direction: 'reciprocal', strength: 0.82, polarity: assertion.polarity, informationSourceType: 'narrator',
        truthStatus: assertion.truthStatus, confidence: 0.9, extractionMethod: 'user', reasoningNote: '视觉审查用的冲突断言。',
        evidence: [{ paragraphId: fixture.paragraphId, exactQuote: fixture.paragraphText, role: 'support' }],
      }), { fixture, assertion });
      await page.waitForTimeout(120);
      await page.evaluate((relationshipId) => window.novelCompiler.reviewRelationship(relationshipId, 'confirmed'), relationship.id);
      await page.waitForTimeout(120);
    }
  });
  await page.getByRole('button', { name: '关系图谱' }).click();
  await page.locator('.graph-stage-count').waitFor();
  await page.getByText('2 NODES / 2 EDGES').waitFor();
  const canvas = page.locator('.graph-canvas');
  let edgeSelected = false;
  for (let y = 170; y <= 430 && !edgeSelected; y += 40) {
    for (let x = 300; x <= 390 && !edgeSelected; x += 6) {
      await canvas.click({ position: { x, y } });
      edgeSelected = await page.locator('.graph-edge-detail').count() > 0;
    }
  }
  if (!edgeSelected) throw new Error('relationship edge was not selectable in visual review');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log(screenshotPath);
} finally {
  await app.close();
  await new Promise((resolve, reject) => apiServer.close((error) => error ? reject(error) : resolve()));
  await fs.rm(tempRoot, { recursive: true, force: true });
}
