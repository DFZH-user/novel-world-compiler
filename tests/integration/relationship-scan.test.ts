import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { CharacterService } from '../../electron/worker/character-service';
import { RelationshipService } from '../../electron/worker/relationship-service';
import { RelationshipScanService } from '../../electron/worker/relationship-scan-service';
import { backfillSourceSpans } from '../../electron/worker/source-span-service';
import { generateLocalRelationshipCandidates } from '../../electron/main/relationship-candidate-generator';
import type { CharacterScanOutput, RelationshipScanOutput, RelationshipScanWorkItem } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
});

async function setupProject(): Promise<{ store: ProjectStore; projectRoot: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-relationship-scan-'));
  cleanupPaths.push(tempRoot);
  const projectRoot = path.join(tempRoot, '关系扫描.novelworld');
  const sourcePath = path.join(tempRoot, 'novel.txt');
  await fs.writeFile(sourcePath, [
    '第一章 同行',
    '陆沉与林月结伴守城。',
    '后来，林月告诉旁人，陆沉一直是她最信任的朋友。',
  ].join('\n'), 'utf8');
  const store = new ProjectStore();
  await store.create('关系扫描', projectRoot);
  await new Importer(store).run(sourcePath, 'utf8');
  const editor = new EditorService(store);
  editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
  const paragraphs = editor.listParagraphs();
  const first = paragraphs.find((paragraph) => paragraph.text.includes('结伴守城'))!;
  const second = paragraphs.find((paragraph) => paragraph.text.includes('最信任的朋友'))!;
  const characters = new CharacterService(store);
  const started = characters.createScan('test-model', 'relationship-fixture.v1');
  const work = characters.nextChunk(started.jobId)!;
  const output: CharacterScanOutput = {
    characters: [
      {
        local_key: 'lu', display_name: '陆沉', entity_kind: 'human', role_hints: [],
        mention_forms: [{ text: '陆沉', kind: 'name' }], has_dialogue: false, participates_in_event: true,
        confidence: 0.98, uncertainty: '',
        evidence: [
          { paragraph_id: first.id, exact_quote: first.text, supports: 'existence' },
          { paragraph_id: second.id, exact_quote: second.text, supports: 'existence' },
        ],
      },
      {
        local_key: 'lin', display_name: '林月', entity_kind: 'human', role_hints: [],
        mention_forms: [{ text: '林月', kind: 'name' }], has_dialogue: true, participates_in_event: true,
        confidence: 0.98, uncertainty: '',
        evidence: [
          { paragraph_id: first.id, exact_quote: first.text, supports: 'existence' },
          { paragraph_id: second.id, exact_quote: second.text, supports: 'dialogue' },
        ],
      },
    ],
    identity_claims: [],
  };
  characters.ingest(started.jobId, work.chunkId, output, JSON.stringify(output), 0, 0);
  characters.nextChunk(started.jobId);
  for (const character of characters.listCharacters()) characters.review(character.id, { status: 'confirmed' });
  return { store, projectRoot };
}

describe('phase 2 batch 2A recoverable local relationship scan', () => {
  it('creates only pending candidates, resumes interrupted chunks, and reuses completed input without duplicates', async () => {
    let { store, projectRoot } = await setupProject();
    const scans = new RelationshipScanService(store);
    expect(scans.estimate()).toMatchObject({ ready: true, chunkCount: 1, confirmedCharacterCount: 2 });

    const interrupted = scans.createRun('local-v1');
    const interruptedWork = scans.nextChunk(interrupted.jobId)!;
    const invalid = generateLocalRelationshipCandidates(interruptedWork);
    invalid.candidates[0].evidence[0].exactQuote = '原文中不存在的关系证据';
    expect(() => scans.ingest(interrupted.jobId, interruptedWork.chunkId, invalid, JSON.stringify(invalid))).toThrow('无法对齐原文');
    await store.close();

    store = new ProjectStore();
    await store.open(projectRoot);
    const resumedScans = new RelationshipScanService(store);
    const resumed = resumedScans.createRun('local-v1');
    expect(resumed).toMatchObject({ jobId: interrupted.jobId, runId: interrupted.runId, reused: true, state: 'running' });
    const resumedWork = resumedScans.nextChunk(resumed.jobId)!;
    const local = generateLocalRelationshipCandidates(resumedWork);
    expect(local.candidates.some((candidate) => candidate.method === 'cooccurrence')).toBe(true);
    expect(local.candidates.some((candidate) => candidate.method === 'rule' && candidate.proposedType === '朋友')).toBe(true);
    expect(resumedScans.ingest(resumed.jobId, resumedWork.chunkId, local, JSON.stringify(local))).toMatchObject({ state: 'completed', progress: 1 });
    expect(resumedScans.nextChunk(resumed.jobId)).toBeNull();

    const relationships = new RelationshipService(store);
    const candidates = relationships.listCandidates();
    expect(candidates).toHaveLength(local.candidates.length);
    expect(candidates.every((candidate) => candidate.reviewStatus === 'pending')).toBe(true);
    expect(relationships.listRelationships()).toHaveLength(0);

    const reused = resumedScans.createRun('local-v1');
    expect(reused).toMatchObject({ jobId: resumed.jobId, reused: true, state: 'completed' });
    expect(relationships.listCandidates()).toHaveLength(candidates.length);
    const attempts = store.get().db.prepare('SELECT attempt, state FROM job_attempts WHERE job_id = ? ORDER BY attempt')
      .all(resumed.jobId) as Array<{ attempt: number; state: string }>;
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(attempts.at(-1)?.state).toBe('completed');

    const alternateVersion = resumedScans.createRun('local-v2');
    const alternateWork = resumedScans.nextChunk(alternateVersion.jobId)!;
    const alternateOutput = generateLocalRelationshipCandidates(alternateWork);
    expect(resumedScans.ingest(alternateVersion.jobId, alternateWork.chunkId, alternateOutput, JSON.stringify(alternateOutput)))
      .toMatchObject({ state: 'completed', progress: 1 });
    expect(relationships.listCandidates()).toHaveLength(candidates.length);
    const alternateSources = store.get().db.prepare(`SELECT COUNT(*) AS value FROM relationship_scan_candidate_sources
      WHERE run_id = ?`).get(alternateVersion.runId) as { value: number };
    expect(Number(alternateSources.value)).toBe(local.candidates.length);
    expect(store.get().db.prepare('SELECT candidate_count AS candidateCount FROM relationship_scan_runs WHERE id = ?')
      .get(alternateVersion.runId)).toMatchObject({ candidateCount: 0 });

    const identities = store.get().db.prepare(`SELECT id FROM person_identities
      WHERE review_status = 'confirmed' ORDER BY canonical_name`).all() as Array<{ id: string }>;
    const mention = store.get().db.prepare('SELECT id FROM person_mentions WHERE identity_id = ? LIMIT 1')
      .get(identities[0].id) as { id: string };
    store.get().db.prepare('UPDATE person_mentions SET identity_id = ? WHERE id = ?').run(identities[1].id, mention.id);
    const changedMentionRun = resumedScans.createRun('local-v1');
    expect(changedMentionRun).toMatchObject({ reused: false, state: 'running' });
    expect(changedMentionRun.runId).not.toBe(resumed.runId);
    await store.close();
  });

  it('keeps pause, resume, and cancel transitions consistent across jobs, attempts, runs, and chunks', async () => {
    const { store } = await setupProject();
    try {
      const scans = new RelationshipScanService(store);
      const started = scans.createRun('state-machine-v1');
      const work = scans.nextChunk(started.jobId)!;

      scans.controlJob(started.jobId, 'pause');
      expect(store.get().db.prepare('SELECT state, lease_owner AS leaseOwner FROM jobs WHERE id = ?').get(started.jobId))
        .toMatchObject({ state: 'paused', leaseOwner: null });
      expect(store.get().db.prepare('SELECT status FROM relationship_scan_runs WHERE id = ?').get(started.runId))
        .toMatchObject({ status: 'paused' });
      expect(store.get().db.prepare('SELECT status FROM relationship_scan_chunk_results WHERE run_id = ? AND chunk_id = ?')
        .get(started.runId, work.chunkId)).toMatchObject({ status: 'pending' });
      expect(store.get().db.prepare('SELECT state FROM job_attempts WHERE job_id = ? AND attempt = 1').get(started.jobId))
        .toMatchObject({ state: 'paused' });
      const pausedOutput = generateLocalRelationshipCandidates(work);
      expect(scans.ingest(started.jobId, work.chunkId, pausedOutput, JSON.stringify(pausedOutput)))
        .toMatchObject({ state: 'paused' });
      expect(new RelationshipService(store).listCandidates()).toHaveLength(0);

      scans.controlJob(started.jobId, 'resume');
      expect(store.get().db.prepare('SELECT state FROM jobs WHERE id = ?').get(started.jobId)).toMatchObject({ state: 'running' });
      expect(store.get().db.prepare('SELECT status FROM relationship_scan_runs WHERE id = ?').get(started.runId))
        .toMatchObject({ status: 'running' });
      const stateAttempts = store.get().db.prepare('SELECT attempt, state FROM job_attempts WHERE job_id = ? ORDER BY attempt')
        .all(started.jobId) as Array<{ attempt: number; state: string }>;
      expect(stateAttempts).toEqual([
        { attempt: 1, state: 'paused' },
        { attempt: 2, state: 'running' },
      ]);

      const resumedWork = scans.nextChunk(started.jobId)!;
      scans.controlJob(started.jobId, 'cancel');
      const cancelledOutput = generateLocalRelationshipCandidates(resumedWork);
      expect(scans.ingest(started.jobId, resumedWork.chunkId, cancelledOutput, JSON.stringify(cancelledOutput)))
        .toMatchObject({ state: 'cancelled' });
      scans.recordError(started.jobId, resumedWork.chunkId, '取消后的迟到错误', true);
      expect(store.get().db.prepare('SELECT state FROM jobs WHERE id = ?').get(started.jobId)).toMatchObject({ state: 'cancelled' });
      expect(store.get().db.prepare('SELECT status FROM relationship_scan_runs WHERE id = ?').get(started.runId))
        .toMatchObject({ status: 'cancelled' });
      expect(store.get().db.prepare('SELECT state FROM job_attempts WHERE job_id = ? AND attempt = 2').get(started.jobId))
        .toMatchObject({ state: 'cancelled' });
      expect(new RelationshipService(store).listCandidates()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it('retries a failed chunk with a new attempt and completes without partial candidate writes', async () => {
    const { store } = await setupProject();
    try {
      const scans = new RelationshipScanService(store);
      const started = scans.createRun('retry-v1');
      const failedWork = scans.nextChunk(started.jobId)!;
      scans.recordError(started.jobId, failedWork.chunkId, '模拟生成失败', true);
      expect(store.get().db.prepare('SELECT state FROM jobs WHERE id = ?').get(started.jobId)).toMatchObject({ state: 'failed' });
      expect(new RelationshipService(store).listCandidates()).toHaveLength(0);

      scans.controlJob(started.jobId, 'retry');
      expect(store.get().db.prepare('SELECT state FROM jobs WHERE id = ?').get(started.jobId)).toMatchObject({ state: 'queued' });
      expect(store.get().db.prepare('SELECT status FROM relationship_scan_runs WHERE id = ?').get(started.runId))
        .toMatchObject({ status: 'paused' });
      scans.controlJob(started.jobId, 'resume');
      const retriedWork = scans.nextChunk(started.jobId)!;
      const output = generateLocalRelationshipCandidates(retriedWork);
      expect(scans.ingest(started.jobId, retriedWork.chunkId, output, JSON.stringify(output)))
        .toMatchObject({ state: 'completed', progress: 1 });
      const attempts = store.get().db.prepare('SELECT attempt, state FROM job_attempts WHERE job_id = ? ORDER BY attempt')
        .all(started.jobId) as Array<{ attempt: number; state: string }>;
      expect(attempts).toEqual([
        { attempt: 1, state: 'failed' },
        { attempt: 2, state: 'completed' },
      ]);
    } finally {
      await store.close();
    }
  });

  it('stores model output only as a pending candidate plus a gated assertion suggestion', async () => {
    const { store } = await setupProject();
    try {
      const scans = new RelationshipScanService(store);
      const started = scans.createRun('model:fixture:v1', 'model', 'deepseek-v4-flash', 'relationship-model.test.v1');
      const work = scans.nextChunk(started.jobId)!;
      expect(work).toMatchObject({ scanMode: 'model', model: 'deepseek-v4-flash', promptVersion: 'relationship-model.test.v1' });
      const lu = work.characters.find((character) => character.name === '陆沉')!;
      const lin = work.characters.find((character) => character.name === '林月')!;
      const support = work.paragraphs.find((paragraph) => paragraph.role === 'core' && paragraph.text.includes('最信任的朋友'))!;
      const output: RelationshipScanOutput = { candidates: [{
        sourceIdentityId: lin.identityId,
        targetIdentityId: lu.identityId,
        method: 'model',
        proposedType: '信任的朋友',
        confidence: 0.93,
        evidence: [{ paragraphId: support.paragraphId, exactQuote: support.text, role: 'support' }],
        suggestion: {
          direction: 'directed',
          strength: 0.8,
          polarity: 0.9,
          informationSourceType: 'narrator',
          informationSourceIdentityId: null,
          truthStatus: 'asserted',
          validFromEventId: null,
          validToEventId: null,
          reasoningNote: '原文明确说明林月对陆沉的信任。',
          uncertainty: '',
        },
      }] };
      const forged = structuredClone(output);
      forged.candidates[0].suggestion!.validFromEventId = 'forged-event';
      expect(() => scans.ingest(started.jobId, work.chunkId, forged, JSON.stringify(forged), 10, 5))
        .toThrow('关系起点只能引用已确认事件');

      expect(scans.ingest(started.jobId, work.chunkId, output, JSON.stringify(output), 120, 45))
        .toMatchObject({ state: 'completed', progress: 1 });
      const candidate = store.get().db.prepare(`SELECT id, source_identity_id AS sourceIdentityId,
        target_identity_id AS targetIdentityId, candidate_method AS candidateMethod, review_status AS reviewStatus
        FROM character_relationship_candidates WHERE candidate_method = 'model'`).get() as {
          id: string; sourceIdentityId: string; targetIdentityId: string; candidateMethod: string; reviewStatus: string;
        };
      expect(candidate).toMatchObject({
        sourceIdentityId: lin.identityId,
        targetIdentityId: lu.identityId,
        candidateMethod: 'model',
        reviewStatus: 'pending',
      });
      expect(store.get().db.prepare(`SELECT direction, truth_status AS truthStatus, reasoning_note AS reasoningNote
        FROM relationship_model_suggestions WHERE candidate_id = ?`).get(candidate.id)).toMatchObject({
        direction: 'directed',
        truthStatus: 'asserted',
        reasoningNote: '原文明确说明林月对陆沉的信任。',
      });
      expect(store.get().db.prepare(`SELECT evidence_role AS evidenceRole FROM character_relationship_candidate_evidence
        WHERE candidate_id = ?`).get(candidate.id)).toMatchObject({ evidenceRole: 'support' });
      expect(store.get().db.prepare(`SELECT input_tokens AS inputTokens, output_tokens AS outputTokens
        FROM relationship_scan_runs WHERE id = ?`).get(started.runId)).toMatchObject({ inputTokens: 120, outputTokens: 45 });
      const relationships = new RelationshipService(store);
      backfillSourceSpans(store.get().db);
      expect(relationships.listCandidateEvidence(candidate.id)).toEqual([
        expect.objectContaining({ sourceSpanId: expect.any(String), alignmentStatus: 'exact' }),
      ]);
      expect(relationships.getModelSuggestion(candidate.id)).toMatchObject({
        candidateId: candidate.id,
        direction: 'directed',
        truthStatus: 'asserted',
      });
      expect(relationships.listRelationships()).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it('prefers the longest overlapping name and does not invent a substring identity cooccurrence', () => {
    const item: RelationshipScanWorkItem = {
      jobId: 'job', runId: 'run', chunkId: 'chunk', chunkOrdinal: 0, extractorVersion: 'local-v1',
      scanMode: 'local', model: null, promptVersion: 'relationship-local.v1',
      characters: [
        { identityId: 'wang', name: '王小明', aliases: [] },
        { identityId: 'xiao', name: '小明', aliases: [] },
        { identityId: 'lin', name: '林月', aliases: [] },
      ],
      cannotLinks: [],
      quotes: [],
      events: [],
      paragraphs: [{
        paragraphId: 'paragraph', ordinal: 0, chapterTitle: null, role: 'core', text: '王小明与林月是朋友。',
      }],
    };
    const output = generateLocalRelationshipCandidates(item);
    expect(output.candidates).toHaveLength(1);
    expect(new Set([output.candidates[0].sourceIdentityId, output.candidates[0].targetIdentityId])).toEqual(new Set(['wang', 'lin']));
  });
});
