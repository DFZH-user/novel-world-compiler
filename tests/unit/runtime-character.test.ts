import { describe, expect, it } from 'vitest';
import { compactRuntimeCharacter } from '../../src/shared/runtime-character';
import type { TavernCardV2 } from '../../src/shared/contracts';

describe('offline runtime character', () => {
  it('increases complete-statement detail from low to high without editing source', () => {
    const lines = Array.from({ length: 70 }, (_, index) => `经历${index}：在当时完成了一件有记录的事。`).join('\n');
    const source = { spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: '甲', description: lines, personality: '', scenario: '', mes_example: '',
      system_prompt: '', post_history_instructions: '', first_mes: '', creator_notes: '',
      alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
    } } as TavernCardV2;
    const before = structuredClone(source);
    const low = compactRuntimeCharacter('person-1', source, 'low');
    const medium = compactRuntimeCharacter('person-1', source, 'medium');
    const high = compactRuntimeCharacter('person-1', source, 'high');
    expect(low.runtimeChars).toBeLessThan(medium.runtimeChars);
    expect(medium.runtimeChars).toBeLessThan(high.runtimeChars);
    expect(low.details.length).toBeGreaterThan(medium.details.length);
    expect(source).toEqual(before);
  });
  it('retains complete statements and uncertainty across categories without modifying the archive', () => {
    const source = { spec: 'chara_card_v2', spec_version: '2.0', data: {
      name: '方源', description: '{{char}}是人物。\n【能力】\n' + '能力说明。'.repeat(500) + '\n【身份】\n身份：旅人\n【状态】\n持有物：尚不确定（甲 / 乙）',
      personality: '【性格】\n谨慎。\n谨慎。\n【目标】\n寻找故人。', scenario: '当前进入点', mes_example: '',
      system_prompt: '旧长提示'.repeat(2000), post_history_instructions: '', first_mes: '',
      creator_notes: '', alternate_greetings: [], tags: [], creator: '', character_version: '1', extensions: {},
      character_book: { entries: [{ content: '完整世界书' }] },
    } } as unknown as TavernCardV2;
    const before = structuredClone(source);
    const result = compactRuntimeCharacter('person-1', source);
    expect(result.runtimeChars).toBeLessThan(4000);
    expect(result.card.data.description).toContain('方源是人物。');
    expect(result.card.data.description).not.toContain('{{char}}');
    expect(result.card.data.description).toContain('身份：旅人');
    expect(result.card.data.description).toContain('尚不确定（甲 / 乙）');
    expect(result.card.data.personality.match(/谨慎。/gu)).toHaveLength(1);
    expect(result.card.data.character_book).toBeUndefined();
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(result.details).toEqual(expect.arrayContaining([expect.objectContaining({ topic: '能力', content: '【能力】' + '能力说明。'.repeat(500) })]));
    expect(result.details.some(detail => detail.content.includes('身份：旅人'))).toBe(false);
    expect(source).toEqual(before);
  });
});
