import { describe, expect, it } from 'vitest';
import { buildChunkSlices } from '../../src/lib/chunker';

describe('dynamic chunking', () => {
  const paragraphs = Array.from({ length: 18 }, (_, index) => ({
    id: `p${index + 1}`,
    ordinal: index + 1,
    chapterId: index < 8 ? 'a' : index < 14 ? 'b' : 'c',
    characterCount: 900,
  }));

  it('covers every core paragraph exactly once and keeps overlap contextual', () => {
    const chunks = buildChunkSlices(paragraphs, {
      coreChars: 4000,
      softLimit: 5000,
      hardLimit: 6000,
      overlapBefore: 900,
      overlapAfter: 900,
    });
    const covered = chunks.flatMap((chunk) => Array.from(
      { length: chunk.coreEndIndex - chunk.coreStartIndex + 1 },
      (_, offset) => chunk.coreStartIndex + offset,
    ));
    expect(covered).toEqual(paragraphs.map((_, index) => index));
    expect(chunks.every((chunk) => chunk.contextStartIndex <= chunk.coreStartIndex)).toBe(true);
    expect(chunks.every((chunk) => chunk.contextEndIndex >= chunk.coreEndIndex)).toBe(true);
  });

  it('returns no chunks for an empty novel', () => {
    expect(buildChunkSlices([], { coreChars: 8000, softLimit: 10_000, hardLimit: 12_000, overlapBefore: 500, overlapAfter: 500 })).toEqual([]);
  });

  it('prefers a nearby chapter, scene, or blank-line boundary without creating tiny chunks', () => {
    const settings = { coreChars: 4000, softLimit: 5000, hardLimit: 6000, overlapBefore: 0, overlapAfter: 0 };
    const withBoundaries = Array.from({ length: 10 }, (_, index) => ({
      id: 'b' + index,
      ordinal: index + 1,
      chapterId: index < 5 ? 'a' : 'b',
      characterCount: 900,
      boundaryBefore: index === 2 ? 'chapter' as const : index === 5 ? 'scene' as const : 'paragraph' as const,
    }));
    const chunks = buildChunkSlices(withBoundaries, settings);
    expect(chunks[0]).toMatchObject({ coreStartIndex: 0, coreEndIndex: 4, boundaryReason: 'scene' });
    expect(chunks[0].coreCharacterCount).toBe(4500);
  });

  it('never crosses the hard limit unless one indivisible paragraph is itself oversized', () => {
    const settings = { coreChars: 4000, softLimit: 5000, hardLimit: 6000, overlapBefore: 0, overlapAfter: 0 };
    const regular = Array.from({ length: 8 }, (_, index) => ({
      id: 'r' + index, ordinal: index + 1, chapterId: null, characterCount: 1700, boundaryBefore: 'paragraph' as const,
    }));
    expect(buildChunkSlices(regular, settings).every((chunk) => chunk.coreCharacterCount <= settings.hardLimit)).toBe(true);
    const oversized = buildChunkSlices([
      { id: 'huge', ordinal: 1, chapterId: null, characterCount: 7000 },
      { id: 'normal', ordinal: 2, chapterId: null, characterCount: 1000 },
    ], settings);
    expect(oversized[0]).toMatchObject({
      coreStartIndex: 0,
      coreEndIndex: 0,
      coreCharacterCount: 7000,
      boundaryReason: 'oversized_paragraph',
      oversized: true,
    });
  });
});
