export type ChapterCandidate = {
  paragraphOrdinal: number;
  title: string;
  score: number;
  kind: 'chapter' | 'volume' | 'special';
};

const chineseNumber = '[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟0-9０-９]+';
const chapterPattern = new RegExp(`^\\s*第\\s*${chineseNumber}\\s*[章节回折幕话集]([\\s:：·、.-]+.{0,50})?\\s*$`, 'i');
const volumePattern = new RegExp(`^\\s*第?\\s*${chineseNumber}\\s*[卷部篇]([\\s:：·、.-]+.{0,50})?\\s*$`, 'i');
const specialPattern = /^\s*(序章|序言|前言|楔子|引子|终章|尾声|后记|番外(?:篇)?(?:\s*[一二三四五六七八九十0-9]+)?)(?:[\s:：·、.-]+.{0,40})?\s*$/i;
const englishPattern = /^\s*(?:chapter|book|part)\s+[0-9ivxlcdm]+(?:[\s:：·、.-]+.{0,60})?\s*$/i;

export function detectChapterCandidate(text: string, paragraphOrdinal: number): ChapterCandidate | null {
  const title = text.trim();
  if (!title || title.length > 80 || /。$/u.test(title)) return null;
  if (chapterPattern.test(title) || englishPattern.test(title)) {
    return { paragraphOrdinal, title, score: title.length <= 35 ? 0.98 : 0.88, kind: 'chapter' };
  }
  if (volumePattern.test(title)) return { paragraphOrdinal, title, score: 0.96, kind: 'volume' };
  if (specialPattern.test(title)) return { paragraphOrdinal, title, score: 0.94, kind: 'special' };
  return null;
}

export function deduplicateAdjacentChapterCandidates(candidates: ChapterCandidate[]): ChapterCandidate[] {
  return candidates.filter((candidate, index) => {
    const previous = candidates[index - 1];
    if (!previous) return true;
    if (candidate.paragraphOrdinal === previous.paragraphOrdinal) return false;
    const sameAdjacentTitle = candidate.paragraphOrdinal === previous.paragraphOrdinal + 1
      && candidate.title.normalize('NFKC').replace(/\s+/gu, ' ').trim()
        === previous.title.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    return !sameAdjacentTitle;
  });
}
export function inferChapterCandidates(paragraphs: Array<{ ordinal: number; text: string }>): ChapterCandidate[] {
  return paragraphs.flatMap((paragraph) => {
    const candidate = detectChapterCandidate(paragraph.text, paragraph.ordinal);
    return candidate ? [candidate] : [];
  });
}
