import { describe, expect, it } from 'vitest';
import { deduplicateAdjacentChapterCandidates, detectChapterCandidate, inferChapterCandidates } from '../../src/lib/chapters';

describe('chapter candidate detection', () => {
  it.each(['第一章 风起', '第１２回 归来', '第二卷 北境', '序章', '番外篇 三', 'Chapter 12 The Door'])(
    'accepts common heading %s',
    (title) => expect(detectChapterCandidate(title, 1)).not.toBeNull(),
  );

  it.each(['第17章 我家故物！', '第38章 微末贱吏，敢凌士族？'])(
    'accepts emphatic real-novel heading %s',
    (title) => expect(detectChapterCandidate(title, 1)).not.toBeNull(),
  );

  it.each(['这是一个普通的长段落。', '第一章里，他离开了家。', '“第十章？”她问。'])(
    'rejects narrative text %s',
    (text) => expect(detectChapterCandidate(text, 1)).toBeNull(),
  );

  it('preserves paragraph ordinals in candidates', () => {
    const candidates = inferChapterCandidates([
      { ordinal: 4, text: '第一章 初见' },
      { ordinal: 5, text: '正文。' },
      { ordinal: 20, text: '第二章 重逢' },
    ]);
    expect(candidates.map((item) => item.paragraphOrdinal)).toEqual([4, 20]);
  });

  it('deduplicates only identical headings on adjacent paragraphs', () => {
    expect(deduplicateAdjacentChapterCandidates([
      { paragraphOrdinal: 10, title: '第364章 争锋', score: 0.98, kind: 'chapter' },
      { paragraphOrdinal: 11, title: '第364章 争锋', score: 0.98, kind: 'chapter' },
      { paragraphOrdinal: 30, title: '第364章 争锋', score: 0.98, kind: 'chapter' },
    ]).map((item) => item.paragraphOrdinal)).toEqual([10, 30]);
  });
});
