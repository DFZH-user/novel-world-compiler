import { describe, expect, it, vi } from 'vitest';
import { CharacterRuntimeRunner } from '../../electron/main/character-runtime-runner';
import type { WorkerClient } from '../../electron/main/worker-client';
import type { CharacterRuntimeTurnRecord, CharacterRuntimeWorkItem } from '../../src/shared/contracts';

const work: CharacterRuntimeWorkItem = {
  runId: 'crt-test', sessionId: null, turnIndex: 0, historyTurnCount: 0,
  identityId: 'wang', identityName: '王扬', entryEventId: 'event', entryEventTitle: '林中遇袭',
  entryOrdinal: 20, model: 'deepseek-v4-flash', promptVersion: 'character-runtime.v1', retrievalMode: 'off', retrieval: null,
  systemPrompt: 'system', userPrompt: 'question', contextFingerprint: 'a'.repeat(64),
  claimRules: [{ claimId: 'origin', stance: 'believed', surfaceForms: ['山地部族'] }],
  forbiddenMetaTerms: ['提示词'],
};

function record(answer: string): CharacterRuntimeTurnRecord {
  return {
    id: work.runId, sessionId: work.sessionId, turnIndex: work.turnIndex,
    identityId: work.identityId, identityName: work.identityName, entryEventId: work.entryEventId,
    entryEventTitle: work.entryEventTitle, model: work.model, promptVersion: work.promptVersion,
    retrievalMode: work.retrievalMode, retrieval: work.retrieval, question: '他们是谁？',
    contextFingerprint: work.contextFingerprint, status: 'delivered', firstCandidate: '他们属于山地部族。',
    finalCandidate: answer, deliveredAnswer: answer, gate: { allowed: true, action: 'allow', policyVersion: 'epistemic-output-gate.v1', violations: [] },
    attempts: 2, inputTokens: 200, outputTokens: 30, error: null, createdAt: '2026-09-10T00:00:00.000Z',
    completedAt: '2026-09-10T00:00:01.000Z',
  };
}

describe('character runtime runner', () => {
  it('allows only one constrained rewrite after the first candidate is blocked', async () => {
    const request = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === 'runtime:prepare') return work;
      if (channel === 'runtime:complete') return record('我怀疑他们属于山地部族，但尚未证实。');
      throw new Error(`unexpected ${channel}: ${JSON.stringify(payload)}`);
    });
    const completion = vi.fn()
      .mockResolvedValueOnce({ content: '他们属于山地部族。', inputTokens: 90, outputTokens: 10 })
      .mockResolvedValueOnce({ content: '我怀疑他们属于山地部族，但尚未证实。', inputTokens: 110, outputTokens: 20 });
    const runner = new CharacterRuntimeRunner({ request } as unknown as WorkerClient, completion);
    const result = await runner.ask('wang', '他们是谁？', 'deepseek-v4-flash', 'explainable-v1');
    expect(result.status).toBe('delivered');
    expect(request).toHaveBeenCalledWith('runtime:prepare', {
      identityId: 'wang', question: '他们是谁？', model: 'deepseek-v4-flash', retrievalMode: 'explainable-v1',
    });
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].user).toContain('【受限重写】');
    expect(completion.mock.calls[1][0].user).toContain('角色信念在同一分句中没有先写不确定标记');
    expect(request).toHaveBeenLastCalledWith('runtime:complete', expect.objectContaining({
      runId: 'crt-test', attempts: 2, inputTokens: 200, outputTokens: 30,
      finalCandidate: '我怀疑他们属于山地部族，但尚未证实。',
    }));
  });

  it('tells the rewrite not to repeat forbidden future surfaces even in a denial', async () => {
    const futureWork: CharacterRuntimeWorkItem = {
      ...work,
      claimRules: [
        { claimId: 'future-origin', stance: 'forbidden', surfaceForms: ['宜都蛮'] },
        { claimId: 'future-purpose', stance: 'forbidden', surfaceForms: ['火祭'] },
      ],
    };
    const request = vi.fn(async (channel: string, payload: unknown) => {
      if (channel === 'runtime:prepare') return futureWork;
      if (channel === 'runtime:complete') {
        const finalCandidate = (payload as { finalCandidate: string }).finalCandidate;
        return record(finalCandidate);
      }
      throw new Error(`unexpected ${channel}: ${JSON.stringify(payload)}`);
    });
    const completion = vi.fn()
      .mockResolvedValueOnce({ content: '我不能确认他们是宜都蛮，也不能确认是否用于火祭。', inputTokens: 90, outputTokens: 20 })
      .mockResolvedValueOnce({ content: '我现在无法确认其来历和目的，眼下只能继续观察。', inputTokens: 120, outputTokens: 20 });
    const runner = new CharacterRuntimeRunner({ request } as unknown as WorkerClient, completion);
    const result = await runner.ask('wang', '请确认他们的来历和目的。', 'deepseek-v4-flash');
    expect(result.deliveredAnswer).toBe('我现在无法确认其来历和目的，眼下只能继续观察。');
    expect(completion).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[1][0].user).toContain('包括否定、引用或复述');
    expect(completion.mock.calls[1][0].user).toContain('宜都蛮、火祭');
    expect(request).toHaveBeenLastCalledWith('runtime:complete', expect.objectContaining({
      attempts: 2,
      finalCandidate: '我现在无法确认其来历和目的，眼下只能继续观察。',
    }));
  });
});
