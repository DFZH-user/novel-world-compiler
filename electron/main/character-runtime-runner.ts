import { evaluateEpistemicOutput, type EpistemicOutputGateResult } from '../../src/shared/epistemic-output-gate';
import type { CharacterRuntimeRetrievalMode, CharacterRuntimeTurnRecord, CharacterRuntimeWorkItem } from '../../src/shared/contracts';
import { requestTextCompletion } from './secure-config';
import type { WorkerClient } from './worker-client';

type TextCompletion = typeof requestTextCompletion;

function rewritePrompt(originalPrompt: string, candidate: string, gate: EpistemicOutputGateResult): string {
  const violations = gate.violations.map((violation) => `- ${violation.message}`).join('\n');
  const forbiddenSurfaces = [...new Set(gate.violations
    .filter((violation) => violation.code === 'forbidden_claim' || violation.code === 'forbidden_meta_term')
    .map((violation) => violation.surface.trim())
    .filter(Boolean))];
  const forbiddenInstruction = forbiddenSurfaces.length
    ? `\n下列词语不得在重写回答中出现，包括否定、引用或复述：${forbiddenSurfaces.join('、')}。请改用“其来历”“其目的”“这件事”等中性代称。\n如果无法安全改写，只回答：“我现在无法确认其来历和目的，眼下只能继续观察。”\n`
    : '';
  return `${originalPrompt}\n\n【受限重写】\n上一候选没有通过本地认知边界检查：\n${violations}\n\n`+
    `${forbiddenInstruction}\n上一候选：\n${candidate}\n\n请只修正这些问题，不增加新事实；仍以角色身份直接回答，不解释修改过程。`;
}

export class CharacterRuntimeRunner {
  constructor(private readonly worker: WorkerClient, private readonly completeText: TextCompletion = requestTextCompletion) {}

  async ask(identityId: string, question: string, model: string, retrievalMode: CharacterRuntimeRetrievalMode = 'off'): Promise<CharacterRuntimeTurnRecord> {
    return this.run(this.worker.request('runtime:prepare', { identityId, question, model, retrievalMode }));
  }

  async askSession(sessionId: string, question: string): Promise<CharacterRuntimeTurnRecord> {
    return this.run(this.worker.request('runtime:session-prepare', { sessionId, question }));
  }

  private async run(prepared: Promise<CharacterRuntimeWorkItem>): Promise<CharacterRuntimeTurnRecord> {
    const item = await prepared;
    try {
      const first = await this.completeText({
        model: item.model, system: item.systemPrompt, user: item.userPrompt, maxTokens: 500,
      });
      const firstGate = evaluateEpistemicOutput({
        text: first.content, claims: item.claimRules, forbiddenMetaTerms: item.forbiddenMetaTerms,
      });
      if (firstGate.allowed) {
        return this.worker.request('runtime:complete', {
          runId: item.runId, firstCandidate: first.content, finalCandidate: first.content,
          attempts: 1, inputTokens: first.inputTokens, outputTokens: first.outputTokens,
        });
      }
      let rewritten;
      try {
        rewritten = await this.completeText({
          model: item.model,
          system: item.systemPrompt,
          user: rewritePrompt(item.userPrompt, first.content, firstGate),
          maxTokens: 500,
        });
      } catch {
        return this.worker.request('runtime:complete', {
          runId: item.runId, firstCandidate: first.content, finalCandidate: first.content,
          attempts: 1, inputTokens: first.inputTokens, outputTokens: first.outputTokens,
        });
      }
      return this.worker.request('runtime:complete', {
        runId: item.runId, firstCandidate: first.content, finalCandidate: rewritten.content,
        attempts: 2, inputTokens: first.inputTokens + rewritten.inputTokens,
        outputTokens: first.outputTokens + rewritten.outputTokens,
      });
    } catch (error) {
      await this.worker.request('runtime:fail', {
        runId: item.runId, error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      throw error;
    }
  }
}
