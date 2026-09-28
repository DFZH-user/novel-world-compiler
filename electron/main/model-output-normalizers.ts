import type { CharacterFactOutput } from '../../src/shared/contracts';

type FactCategory = CharacterFactOutput['facts'][number]['category'];

const FACT_CATEGORY_ALIASES: Readonly<Record<string, FactCategory>> = {
  identity: 'identity', profile: 'identity', role: 'identity', occupation: 'identity', name: 'identity', title: 'identity',
  身份: 'identity', 姓名: 'identity', 称呼: 'identity', 职业: 'identity',
  appearance: 'appearance', looks: 'appearance', physical: 'appearance', 外貌: 'appearance', 外观: 'appearance', 体貌: 'appearance',
  personality: 'personality', trait: 'personality', temperament: 'personality', 性格: 'personality', 人格: 'personality', 气质: 'personality',
  ability: 'ability', skill: 'ability', power: 'ability', 能力: 'ability', 技能: 'ability', 实力: 'ability',
  motivation: 'motivation', goal: 'motivation', desire: 'motivation', 动机: 'motivation', 目标: 'motivation', 愿望: 'motivation',
  background: 'background', history: 'background', experience: 'background', backstory: 'background', 背景: 'background', 经历: 'background', 过往: 'background',
  status: 'status', state: 'status', location: 'status', whereabouts: 'status', place: 'status', 状态: 'status', 地点: 'status', 位置: 'status', 所在地: 'status',
  secret: 'secret', secrets: 'secret', 秘密: 'secret', 隐秘: 'secret',
  speech: 'speech', language: 'speech', dialogue: 'speech', voice: 'speech', 语言: 'speech', 说话: 'speech', 对白: 'speech', 口癖: 'speech',
  relationship: 'relationship', relation: 'relationship', relations: 'relationship', 关系: 'relationship', 人际关系: 'relationship',
  other: 'other', 其他: 'other', 杂项: 'other',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeCharacterFactOutput(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.facts)) return input;
  return {
    ...input,
    facts: input.facts.map((fact) => {
      if (!isRecord(fact) || typeof fact.category !== 'string') return fact;
      const key = fact.category.normalize('NFKC').trim().toLocaleLowerCase('en-US');
      if (!key) return fact;
      return { ...fact, category: FACT_CATEGORY_ALIASES[key] ?? 'other' };
    }),
  };
}
