import { describe, expect, it } from 'vitest';
import { generateLocalRelationshipCandidates } from '../../electron/main/relationship-candidate-generator';
import type { RelationshipScanWorkItem } from '../../src/shared/contracts';

function candidates(text: string, people: Array<[string, string]>) {
  const item = {
    jobId: 'job', runId: 'run', chunkId: 'chunk', chunkOrdinal: 0,
    extractorVersion: 'local-v1', scanMode: 'local', model: null,
    promptVersion: 'relationship-local.v1',
    characters: people.map(([identityId, name]) => ({ identityId, name, aliases: [] })),
    cannotLinks: [], quotes: [], events: [],
    paragraphs: [{ paragraphId: 'p', ordinal: 1, chapterTitle: null, role: 'core', text }],
  } as RelationshipScanWorkItem;
  return generateLocalRelationshipCandidates(item).candidates;
}

describe('local relationship rule specificity', () => {
  it('keeps an explicit sibling statement', () => {
    expect(candidates('方源和弟弟方正是住在二楼。', [['yuan', '方源'], ['zheng', '方正']]))
      .toEqual([expect.objectContaining({ proposedType: '兄弟', method: 'rule' })]);
    expect(candidates('方源与方正是兄弟。', [['yuan', '方源'], ['zheng', '方正']]))
      .toEqual([expect.objectContaining({ proposedType: '兄弟', method: 'rule' })]);
    expect(candidates('方源是方正的哥哥。', [['yuan', '方源'], ['zheng', '方正']]))
      .toEqual([expect.objectContaining({ proposedType: '兄弟', method: 'rule' })]);
  });

  it('does not assign a third person’s sibling statement to the nearby pair', () => {
    const output = candidates('他望着学堂家老，笑着说：“晚辈是古月方源，古月方正是我的弟弟。',
      [['elder', '学堂家老'], ['yuan', '古月方源'], ['zheng', '古月方正']]);
    expect(output.find(item => [item.sourceIdentityId, item.targetIdentityId].includes('elder')
      && [item.sourceIdentityId, item.targetIdentityId].includes('zheng'))?.proposedType).not.toBe('兄弟');
  });

  it('does not label two people siblings when an unrelated brother is mentioned earlier', () => {
    const output = candidates('这些年跟着哥哥一起生活，受方源的照顾。不过他讨厌沈翠这样的丫鬟。',
      [['yuan', '方源'], ['shen', '沈翠']]);
    expect(output[0]?.proposedType).not.toBe('兄弟');
  });

  it('retains an explicit friendship statement', () => {
    expect(candidates('王小明与林月是朋友。', [['wang', '王小明'], ['lin', '林月']]))
      .toEqual([expect.objectContaining({ proposedType: '朋友', method: 'rule' })]);
  });
});
