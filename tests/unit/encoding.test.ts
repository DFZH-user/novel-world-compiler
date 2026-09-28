import { describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { rankEncodingCandidates } from '../../src/lib/encoding';

const sampleText = `第一章 初见\n叶凡站在北京旧城的雨里。\n“你终于来了。”她说。\n第二章 夜行\n故事从这里继续。`;

describe('encoding detection', () => {
  it('ranks UTF-8 Chinese text first', () => {
    const ranked = rankEncodingCandidates(Buffer.from(sampleText, 'utf8'));
    expect(ranked[0].encoding).toBe('utf8');
    expect(ranked[0].preview).toContain('叶凡');
    expect(ranked[0].replacementRate).toBe(0);
  });

  it('recognizes GB18030 Chinese text', () => {
    const ranked = rankEncodingCandidates(iconv.encode(sampleText, 'gb18030'));
    expect(ranked[0].encoding).toBe('gb18030');
    expect(ranked[0].preview).toContain('北京');
  });

  it('gives a BOM-backed encoding decisive priority', () => {
    const sample = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(sampleText, 'utf16le')]);
    expect(rankEncodingCandidates(sample)[0].encoding).toBe('utf16le');
  });
});
