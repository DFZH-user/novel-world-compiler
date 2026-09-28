import type { ChunkSettings } from '../shared/contracts';

export type ChunkBoundaryKind = 'document' | 'chapter' | 'scene' | 'blank_line' | 'paragraph';

export type ChunkParagraph = {
  id: string;
  ordinal: number;
  chapterId: string | null;
  characterCount: number;
  boundaryBefore?: ChunkBoundaryKind;
};

export type ChunkBoundaryReason = 'document_end' | 'chapter' | 'scene' | 'blank_line' | 'soft_limit' | 'target' | 'oversized_paragraph';

export type ChunkSlice = {
  chapterId: string | null;
  coreStartIndex: number;
  coreEndIndex: number;
  contextStartIndex: number;
  contextEndIndex: number;
  coreCharacterCount: number;
  contextCharacterCount: number;
  characterCount: number;
  boundaryReason: ChunkBoundaryReason;
  oversized: boolean;
};

type Candidate = {
  endIndex: number;
  characterCount: number;
  boundaryAfter: ChunkBoundaryKind | 'document_end';
};

function sumChars(items: ChunkParagraph[], start: number, end: number): number {
  let total = 0;
  for (let index = start; index <= end; index += 1) total += items[index]?.characterCount ?? 0;
  return total;
}

function boundaryScore(boundary: Candidate['boundaryAfter']): number {
  if (boundary === 'document_end') return 20;
  if (boundary === 'chapter') return 12;
  if (boundary === 'scene') return 8;
  if (boundary === 'blank_line') return 4;
  return 0;
}

function chooseCoreEnd(paragraphs: ChunkParagraph[], start: number, settings: ChunkSettings): {
  endIndex: number;
  characterCount: number;
  reason: ChunkBoundaryReason;
  oversized: boolean;
} {
  const firstCount = paragraphs[start].characterCount;
  if (firstCount > settings.hardLimit) {
    return { endIndex: start, characterCount: firstCount, reason: 'oversized_paragraph', oversized: true };
  }

  const candidates: Candidate[] = [];
  let total = 0;
  for (let index = start; index < paragraphs.length; index += 1) {
    const projected = total + paragraphs[index].characterCount;
    if (projected > settings.hardLimit) break;
    total = projected;
    candidates.push({
      endIndex: index,
      characterCount: total,
      boundaryAfter: paragraphs[index + 1]?.boundaryBefore ?? 'document_end',
    });
  }

  const atOrPastTarget = candidates.filter((candidate) => candidate.characterCount >= settings.coreChars);
  const pool = atOrPastTarget.length ? atOrPastTarget : candidates;
  const hardRange = Math.max(settings.hardLimit - settings.softLimit, 1);
  const target = Math.max(settings.coreChars, 1);
  const selected = pool.reduce((best, candidate) => {
    const targetPenalty = (Math.abs(candidate.characterCount - settings.coreChars) / target) * 10;
    const softPenalty = candidate.characterCount > settings.softLimit
      ? ((candidate.characterCount - settings.softLimit) / hardRange) * 12
      : 0;
    const score = boundaryScore(candidate.boundaryAfter) - targetPenalty - softPenalty;
    return !best || score > best.score ? { candidate, score } : best;
  }, null as { candidate: Candidate; score: number } | null)!.candidate;

  const reason: ChunkBoundaryReason = selected.boundaryAfter === 'document_end'
    ? 'document_end'
    : selected.boundaryAfter === 'chapter' || selected.boundaryAfter === 'scene' || selected.boundaryAfter === 'blank_line'
      ? selected.boundaryAfter
      : selected.characterCount >= settings.softLimit ? 'soft_limit' : 'target';
  return { endIndex: selected.endIndex, characterCount: selected.characterCount, reason, oversized: false };
}

export function buildChunkSlices(paragraphs: ChunkParagraph[], settings: ChunkSettings): ChunkSlice[] {
  if (paragraphs.length === 0) return [];
  const slices: ChunkSlice[] = [];
  let coreStart = 0;
  while (coreStart < paragraphs.length) {
    const core = chooseCoreEnd(paragraphs, coreStart, settings);
    const coreEnd = core.endIndex;

    let contextStart = coreStart;
    let before = 0;
    while (contextStart > 0 && before < settings.overlapBefore) {
      contextStart -= 1;
      before += paragraphs[contextStart].characterCount;
    }
    let contextEnd = coreEnd;
    let after = 0;
    while (contextEnd + 1 < paragraphs.length && after < settings.overlapAfter) {
      contextEnd += 1;
      after += paragraphs[contextEnd].characterCount;
    }
    const contextCharacterCount = sumChars(paragraphs, contextStart, contextEnd);
    slices.push({
      chapterId: paragraphs[coreStart].chapterId,
      coreStartIndex: coreStart,
      coreEndIndex: coreEnd,
      contextStartIndex: contextStart,
      contextEndIndex: contextEnd,
      coreCharacterCount: core.characterCount,
      contextCharacterCount,
      characterCount: contextCharacterCount,
      boundaryReason: core.reason,
      oversized: core.oversized,
    });
    coreStart = coreEnd + 1;
  }
  return slices;
}
