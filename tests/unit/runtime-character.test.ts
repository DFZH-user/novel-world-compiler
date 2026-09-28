import { describe, expect, it } from 'vitest';
import { compactRuntimeCharacter } from '../../src/shared/runtime-character';
import type { TavernCardV2 } from '../../src/shared/contracts';

describe('offline runtime character', () => {
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
