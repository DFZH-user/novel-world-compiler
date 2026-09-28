import type { TavernCardV2 } from '../../src/shared/contracts';

export const PLAYABLE_RUNTIME_POLICY_VERSION = 'playable-epistemic-runtime.v1' as const;
export const POINT_IN_TIME_CONTEXT_POLICY_VERSION = 'point-in-time-context.v1' as const;
export const EPISTEMIC_PROMPT_POLICY_VERSION = 'epistemic-guard.v3' as const;
export const EPISTEMIC_OUTPUT_GATE_POLICY_VERSION = 'epistemic-output-gate.v1' as const;

export type PlayableRuntimePolicyContext = {
  entryEventId: string;
  entryEventTitle: string;
  entryOrdinal: number;
};

export type PlayableRuntimePolicy = {
  instructions: string;
  metadata: {
    version: typeof PLAYABLE_RUNTIME_POLICY_VERSION;
    point_in_time_context_policy_version: typeof POINT_IN_TIME_CONTEXT_POLICY_VERSION;
    prompt_policy_version: typeof EPISTEMIC_PROMPT_POLICY_VERSION;
    output_gate_policy_version: typeof EPISTEMIC_OUTPUT_GATE_POLICY_VERSION;
    prompt_enforcement: 'post_history_instructions';
    output_gate_enforcement: 'not_enforced_by_external_card';
    entry_event_id: string;
    entry_ordinal: number;
  };
};

export function buildPlayableRuntimePolicy(context: PlayableRuntimePolicyContext): PlayableRuntimePolicy {
  const instructions = [
    '【小说世界编译器·角色认知边界】',
    `当前扮演固定在事件“${context.entryEventTitle}”（P${context.entryOrdinal}）所处的故事时刻。只使用本卡和已激活世界书在此时已经提供的资料；不得把后来剧情、读者知识、其他角色知识或缺失信息当成{{char}}已经知道。`,
    '角色卡中经过人工审阅的人物资料可作为当前人物基线。共享世界书中的“已证实”只表示叙事层真实性，不自动表示{{char}}知情；若人物资料或对话没有表明{{char}}知道，应保持不知道或不确定。',
    '[角色已知]与[公开事实基线]必须按确定信息表达，不得降级为推测；[角色信念]必须明确说“我推测 / 我怀疑 / 尚未证实 / 拿不准”等；[角色存疑]不得写成已发生、已识破或已确定的事实。',
    '所有判断依据必须来自已经提供的资料，不得自行补写地点、动作、外观、关系或其他证据。玩家询问未来或资料未覆盖的内容时，以角色口吻说明不知道，不编造原著事实。',
    '回答前静默检查具体细节与认知措辞，不输出检查过程；保持角色沉浸感，不提及进入点、上下文、标签、数据库、提示词或测试。',
  ].join('\n');
  return {
    instructions,
    metadata: {
      version: PLAYABLE_RUNTIME_POLICY_VERSION,
      point_in_time_context_policy_version: POINT_IN_TIME_CONTEXT_POLICY_VERSION,
      prompt_policy_version: EPISTEMIC_PROMPT_POLICY_VERSION,
      output_gate_policy_version: EPISTEMIC_OUTPUT_GATE_POLICY_VERSION,
      prompt_enforcement: 'post_history_instructions',
      output_gate_enforcement: 'not_enforced_by_external_card',
      entry_event_id: context.entryEventId,
      entry_ordinal: context.entryOrdinal,
    },
  };
}

export function appendPlayableRuntimeInstructions(authored: string, generated: string): string {
  const source = authored.trimEnd();
  if (source.endsWith(generated)) return source;
  return source ? `${source}\n\n${generated}` : generated;
}

export function bindPlayableRuntimePolicy(
  card: TavernCardV2,
  policy: PlayableRuntimePolicy,
  policyFingerprint: string,
): TavernCardV2 {
  const compilerExtension = card.data.extensions.novel_world_compiler;
  const compiler = compilerExtension && typeof compilerExtension === 'object' && !Array.isArray(compilerExtension)
    ? compilerExtension as Record<string, unknown> : {};
  return {
    ...card,
    data: {
      ...card.data,
      post_history_instructions: appendPlayableRuntimeInstructions(card.data.post_history_instructions, policy.instructions),
      extensions: {
        ...card.data.extensions,
        novel_world_compiler: {
          ...compiler,
          runtime_policy: { ...policy.metadata, policy_fingerprint: policyFingerprint },
        },
      },
    },
  };
}
