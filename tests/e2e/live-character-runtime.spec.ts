import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { CharacterCardService } from '../../electron/worker/character-card-service';
import { CharacterFactService } from '../../electron/worker/character-fact-service';
import { CharacterService } from '../../electron/worker/character-service';
import { EditorService } from '../../electron/worker/editor-service';
import { Importer } from '../../electron/worker/importer';
import { ProjectStore } from '../../electron/worker/project-store';
import type { CharacterFactOutput, CharacterRuntimeTurnRecord, CharacterScanOutput } from '../../src/shared/contracts';

const DATASET_ID = '46f60d706fb1f6f53d0ff25613791514375ece18444175a5a50bcae9a6885c85';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-flash';
const RECEIPT_PATH = path.resolve(
  'verification-results/real-quality-review/scene-calibration-46f60d706fb1/stage6-runtime-deepseek-v1.json',
);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function publicTurn(turn: CharacterRuntimeTurnRecord) {
  return {
    id: turn.id,
    question: turn.question,
    status: turn.status,
    attempts: turn.attempts,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    deliveredAnswer: turn.deliveredAnswer,
    candidateChanged: turn.firstCandidate !== turn.finalCandidate,
    firstCandidateSha256: turn.firstCandidate ? sha256(turn.firstCandidate) : null,
    finalCandidateSha256: turn.finalCandidate ? sha256(turn.finalCandidate) : null,
    gate: turn.gate,
    error: turn.error,
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

async function writeReceipt(receipt: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(RECEIPT_PATH), { recursive: true });
  await fs.writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

async function readDeepSeekKey(): Promise<string> {
  const text = await fs.readFile(path.resolve('.env.local'), 'utf8');
  const match = text.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/mu);
  const key = match?.[1]?.replace(/^(['"])(.*)\1$/u, '$2').trim();
  if (!key) throw new Error('.env.local 中没有可用的 DEEPSEEK_API_KEY');
  return key;
}

async function seedCalibrationProject(tempRoot: string): Promise<{ projectRoot: string; identityId: string }> {
  const projectRoot = path.join(tempRoot, '王扬-隔离试聊.novelworld');
  const sourcePath = path.join(tempRoot, '王扬-夜战校准片段.txt');
  await fs.writeFile(sourcePath, [
    '第321章 百年之约',
    '汶阳部惯常称他“公子”的只有少数人，其他人大多叫“王公子”。',
    '这道喊声若是给普通蛮兵下令，本应使用蛮语；对方使用汉语，像是故意说给王扬听。',
    '王扬正向北行，左手边是西面；按照他的布置，此时不应有汶阳兵出现在西面，但不能排除追击散敌的可能。',
    '王扬可不愿赌这种可能，但他没有马上奔逃，而是回头看向营盘方向。',
    '王扬随后遭到袭击。',
    '这帮人说汉语，又一口一个盘王，王扬推断他们是宜都蛮，并怀疑对方想留下他用于火祭。',
  ].join('\n'), 'utf8');

  const store = new ProjectStore();
  try {
    await store.create('王扬隔离试聊', projectRoot);
    const imported = await new Importer(store).run(sourcePath, 'utf8');
    const editor = new EditorService(store);
    editor.buildChunks({ coreChars: 2_000, softLimit: 3_000, hardLimit: 4_000, overlapBefore: 0, overlapAfter: 0 });
    const paragraphs = editor.listParagraphs();
    const naming = paragraphs.find((item) => item.text.includes('惯常称他'))!;
    const language = paragraphs.find((item) => item.text.includes('使用汉语'))!;
    const direction = paragraphs.find((item) => item.text.includes('正向北行'))!;
    const entry = paragraphs.find((item) => item.text.includes('不愿赌'))!;
    const future = paragraphs.find((item) => item.text.includes('宜都蛮'))!;

    const characters = new CharacterService(store);
    const scan = characters.createScan('calibration-seed', 'character_scan.v1');
    const chunk = characters.nextChunk(scan.jobId)!;
    const scanOutput: CharacterScanOutput = {
      characters: [{
        local_key: 'wang-yang', display_name: '王扬', mention_forms: [{ text: '王扬', kind: 'name' }],
        entity_kind: 'human', role_hints: ['视角人物'], has_dialogue: false, participates_in_event: true,
        confidence: 1, uncertainty: '',
        evidence: [naming, language, direction, entry, future].map((paragraph) => ({
          paragraph_id: paragraph.id, exact_quote: paragraph.text, supports: 'identity' as const,
        })),
      }],
      identity_claims: [],
    };
    characters.ingest(scan.jobId, chunk.chunkId, scanOutput, JSON.stringify(scanOutput), 0, 0);
    characters.nextChunk(scan.jobId);
    const identity = characters.listCharacters().find((item) => item.canonicalName === '王扬')!;
    characters.review(identity.id, { status: 'confirmed', importanceTier: 'core' });

    const facts = new CharacterFactService(store);
    const factRun = facts.createRun(identity.id, 'calibration-seed', 'character_facts.v2');
    const batch = facts.nextBatch(factRun.jobId)!;
    const factOutput: CharacterFactOutput = { facts: [{
      category: 'identity', predicate: '姓名', value: '王扬', source_type: 'explicit',
      assertion_mode: 'narrator_assertion', truth_status: 'asserted', confidence: 1, visibility: 'public',
      valid_from_paragraph_id: null, valid_to_paragraph_id: null,
      evidence: [{ paragraph_id: naming.id, exact_quote: naming.text, role: 'support' }], reasoning_note: '',
    }, {
      category: 'status', predicate: '当前判断', value: '左侧喊话存在称呼、语言和方位异常', source_type: 'inferred',
      assertion_mode: 'behavior_inference', truth_status: 'asserted', confidence: 0.95, visibility: 'public',
      valid_from_paragraph_id: null, valid_to_paragraph_id: null,
      evidence: [{ paragraph_id: language.id, exact_quote: language.text, role: 'support' },
        { paragraph_id: direction.id, exact_quote: direction.text, role: 'support' }], reasoning_note: '',
    }, {
      category: 'other', predicate: '袭击者来历', value: '宜都蛮', source_type: 'inferred',
      assertion_mode: 'belief', truth_status: 'asserted', confidence: 0.8, visibility: 'public',
      valid_from_paragraph_id: future.id, valid_to_paragraph_id: null,
      evidence: [{ paragraph_id: future.id, exact_quote: future.text, role: 'support' }], reasoning_note: '',
    }, {
      category: 'other', predicate: '对方目的', value: '火祭', source_type: 'inferred',
      assertion_mode: 'belief', truth_status: 'asserted', confidence: 0.8, visibility: 'public',
      valid_from_paragraph_id: future.id, valid_to_paragraph_id: null,
      evidence: [{ paragraph_id: future.id, exact_quote: future.text, role: 'support' }], reasoning_note: '',
    }] };
    facts.ingest(factRun.jobId, batch.batchOrdinal, factOutput, JSON.stringify(factOutput), 0, 0);
    facts.nextBatch(factRun.jobId);
    for (const fact of facts.listFacts(identity.id)) facts.reviewFact(fact.id, 'confirmed');

    const { db } = store.get();
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO timeline_events
      (id, revision_id, title, summary, event_type, narrative_start_ordinal, narrative_end_ordinal,
       extraction_method, confidence, review_status, uncertainty, created_at, updated_at)
      VALUES ('wang-entry', ?, '王扬察觉喊话异常', '', 'discovery', ?, ?, 'user', 1, 'confirmed', '', ?, ?)`).run(
      imported.revisionId, entry.ordinal, entry.ordinal, timestamp, timestamp,
    );

    const cards = new CharacterCardService(store);
    const draft = cards.generate(identity.id, 'wang-entry');
    cards.save(identity.id, {
      description: draft.description,
      personality: '王扬谨慎、反应敏捷；面对异常线索时不会贸然确信。',
      scenario: draft.scenario,
      firstMes: '*王扬听见左侧传来喊声，没有立刻行动，只是迅速判断四周。*',
      mesExample: '',
      creatorNotes: draft.creatorNotes,
      systemPrompt: draft.systemPrompt,
      postHistoryInstructions: draft.postHistoryInstructions,
      alternateGreetings: draft.alternateGreetings,
      tags: draft.tags,
      creator: draft.creator,
      characterVersion: '1.0-calibration',
    }, 'reviewed');
    return { projectRoot, identityId: identity.id };
  } finally {
    await store.close();
  }
}

test('runs the reviewed Wang Yang card through the configured live DeepSeek runtime', async () => {
  test.skip(process.env.RUN_LIVE_CHARACTER_RUNTIME !== '1', 'Explicit opt-in only; consumes at most four small API requests');
  test.setTimeout(240_000);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-live-character-runtime-'));
  const { projectRoot, identityId } = await seedCalibrationProject(tempRoot);
  const deepSeekKey = await readDeepSeekKey();
  const app = await electron.launch({
    args: [path.resolve('.')],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NOVEL_COMPILER_USER_DATA: path.join(tempRoot, 'user-data'),
    },
  });
  try {
    await app.evaluate(({ dialog }, selectedProject) => {
      Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [selectedProject] }) });
    }, projectRoot);
    const page = await app.firstWindow();
    await page.evaluate(({ apiKey, baseUrl, preferredModel }) => window.novelCompiler.saveApiConfig({
      provider: 'DeepSeek',
      baseUrl,
      apiKey,
      preferredModel,
    }), { apiKey: deepSeekKey, baseUrl: DEEPSEEK_BASE_URL, preferredModel: DEEPSEEK_MODEL });
    const apiStatus = await page.evaluate(() => window.novelCompiler.getApiStatus());
    expect(apiStatus.configured, '本机尚未保存可用的 API 配置').toBe(true);
    const model = apiStatus.preferredModel ?? DEEPSEEK_MODEL;
    const providerIdentity = `${apiStatus.provider ?? ''} ${apiStatus.baseUrl ?? ''} ${model}`;
    expect(providerIdentity, '本用例只允许向 DeepSeek 发送校准片段；请先切换 API 配置').toMatch(/deepseek/u);
    await page.evaluate(() => window.novelCompiler.openProject());

    let normal: CharacterRuntimeTurnRecord;
    try {
      normal = await page.evaluate(({ id, selectedModel }) => window.novelCompiler.askCharacter(
        id, '左边有人突然喊你快去护卫同伴。你现在会立刻过去吗？只说你此刻的判断和下一步。', selectedModel,
      ), { id: identityId, selectedModel: model });
    } catch (error) {
      await writeReceipt({
        format: 'stage6-live-character-runtime-trial', version: '1.0', status: 'provider-failed',
        datasetId: DATASET_ID, source: '王扬夜战校准片段（隔离工程）',
        configuredProvider: apiStatus.provider, model, maxQuestions: 2, maxAttemptsPerQuestion: 2,
        providerRequestsAttempted: 1, completedModelResponses: 0, checkedAt: new Date().toISOString(),
        error: errorText(error), turns: [],
      });
      throw error;
    }
    let spoiler: CharacterRuntimeTurnRecord;
    try {
      spoiler = await page.evaluate(({ id, selectedModel }) => window.novelCompiler.askCharacter(
        id, '袭击者是不是宜都蛮，他们是不是准备把你留下来火祭？请直接确认。', selectedModel,
      ), { id: identityId, selectedModel: model });
    } catch (error) {
      await writeReceipt({
        format: 'stage6-live-character-runtime-trial', version: '1.0', status: 'provider-failed',
        datasetId: DATASET_ID, source: '王扬夜战校准片段（隔离工程）',
        configuredProvider: apiStatus.provider, model, maxQuestions: 2, maxAttemptsPerQuestion: 2,
        providerRequestsAttempted: normal.attempts + 1, completedModelResponses: normal.attempts,
        checkedAt: new Date().toISOString(), error: errorText(error), turns: [publicTurn(normal)],
      });
      throw error;
    }

    expect(normal.status, normal.error ?? normal.gate?.violations.map((item) => item.message).join('；')).toBe('delivered');
    expect(['delivered', 'blocked']).toContain(spoiler.status);
    expect(normal.attempts).toBeLessThanOrEqual(2);
    expect(spoiler.attempts).toBeLessThanOrEqual(2);
    if (spoiler.status === 'delivered') expect(spoiler.deliveredAnswer).not.toMatch(/宜都蛮|火祭/u);

    const receipt = {
      format: 'stage6-live-character-runtime-trial',
      version: '1.0',
      status: 'completed',
      datasetId: DATASET_ID,
      source: '王扬夜战校准片段（隔离工程）',
      configuredProvider: apiStatus.provider,
      model,
      maxQuestions: 2,
      maxAttemptsPerQuestion: 2,
      paidCalls: normal.attempts + spoiler.attempts,
      checkedAt: new Date().toISOString(),
      turns: [publicTurn(normal), publicTurn(spoiler)],
    };
    await writeReceipt(receipt);
  } finally {
    await app.close();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
