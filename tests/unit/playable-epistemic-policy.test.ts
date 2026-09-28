import { describe, expect, it } from 'vitest';
import type { TavernCardV2 } from '../../src/shared/contracts';
import {
  appendPlayableRuntimeInstructions,
  bindPlayableRuntimePolicy,
  buildPlayableRuntimePolicy,
} from '../../electron/worker/playable-epistemic-policy';

function card(postHistoryInstructions = ''): TavernCardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: '陆沉', description: '', personality: '', scenario: '', first_mes: '', mes_example: '', creator_notes: '',
      system_prompt: '', post_history_instructions: postHistoryInstructions, alternate_greetings: [], tags: [], creator: '',
      character_version: '1.0', extensions: { novel_world_compiler: { identity_id: 'lu' } },
    },
  };
}

describe('playable epistemic policy', () => {
  const policy = buildPlayableRuntimePolicy({ entryEventId: 'event-1', entryEventTitle: '进入青石镇', entryOrdinal: 42 });

  it('preserves authored instructions and appends the generated guard last', () => {
    const bound = bindPlayableRuntimePolicy(card('始终保持简短。'), policy, 'fingerprint');
    expect(bound.data.post_history_instructions).toBe(`始终保持简短。\n\n${policy.instructions}`);
    expect(bound.data.extensions.novel_world_compiler).toMatchObject({
      identity_id: 'lu',
      runtime_policy: {
        version: 'playable-epistemic-runtime.v1',
        point_in_time_context_policy_version: 'point-in-time-context.v1',
        prompt_policy_version: 'epistemic-guard.v3',
        output_gate_policy_version: 'epistemic-output-gate.v1',
        output_gate_enforcement: 'not_enforced_by_external_card',
        entry_event_id: 'event-1',
        entry_ordinal: 42,
        policy_fingerprint: 'fingerprint',
      },
    });
  });

  it('does not duplicate an identical generated suffix', () => {
    const once = appendPlayableRuntimeInstructions('人工规则', policy.instructions);
    expect(appendPlayableRuntimeInstructions(once, policy.instructions)).toBe(once);
  });

  it('keeps shared narrative truth separate from character knowledge', () => {
    expect(policy.instructions).toContain('“已证实”只表示叙事层真实性，不自动表示{{char}}知情');
    expect(policy.instructions).toContain('[角色信念]必须明确说');
    expect(policy.instructions).toContain('不得把后来剧情、读者知识、其他角色知识或缺失信息当成{{char}}已经知道');
  });
});
