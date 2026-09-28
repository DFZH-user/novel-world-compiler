import chardet from 'chardet';
import iconv from 'iconv-lite';
import type { EncodingCandidate } from '../shared/contracts';

const ENCODING_ALIASES: Record<string, string> = {
  utf8: 'utf8',
  'utf-8': 'utf8',
  ascii: 'utf8',
  gb2312: 'gb18030',
  gbk: 'gb18030',
  gb18030: 'gb18030',
  big5: 'big5',
  'utf-16le': 'utf16le',
  utf16le: 'utf16le',
  'utf-16be': 'utf16be',
  utf16be: 'utf16be',
};

export const SUPPORTED_ENCODINGS = ['utf8', 'gb18030', 'big5', 'utf16le', 'utf16be'] as const;

export function normalizeEncodingName(value: string): string {
  return ENCODING_ALIASES[value.toLowerCase().replace(/[_ ]/g, '-')] ?? value.toLowerCase();
}

export function bomEncoding(buffer: Buffer): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf16be';
  return null;
}

export function scoreDecodedText(text: string, detectorMatch = false): Omit<EncodingCandidate, 'encoding' | 'preview'> {
  const length = Math.max(text.length, 1);
  const replacements = (text.match(/\uFFFD/g) ?? []).length;
  const chinese = (text.match(/[\u3400-\u9FFF]/g) ?? []).length;
  const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  const mojibake = (text.match(/[ÃÂ鈥銆鍙妫]/g) ?? []).length;
  const replacementRate = replacements / length;
  const chineseRate = chinese / length;
  const controlRate = controls / length;
  const detectorConfidence = detectorMatch ? 1 : 0;
  const score =
    100
    - replacementRate * 500
    - controlRate * 350
    - Math.min(mojibake / length, 0.2) * 180
    + Math.min(chineseRate, 0.7) * 35
    + detectorConfidence * 12;
  return { score: Number(score.toFixed(3)), detectorConfidence, replacementRate, chineseRate, controlRate };
}

export function rankEncodingCandidates(sample: Buffer): EncodingCandidate[] {
  const bom = bomEncoding(sample);
  const detectedRaw = chardet.detect(sample) ?? '';
  const detected = normalizeEncodingName(detectedRaw);
  const encodings = new Set<string>(SUPPORTED_ENCODINGS);
  if (iconv.encodingExists(detected)) encodings.add(detected);
  return [...encodings]
    .filter((encoding) => iconv.encodingExists(encoding))
    .map((encoding) => {
      const decoded = iconv.decode(sample, encoding).replace(/^\uFEFF/, '');
      const quality = scoreDecodedText(decoded, encoding === detected);
      const bomBonus = bom === encoding ? 1000 : 0;
      return {
        encoding,
        ...quality,
        score: quality.score + bomBonus,
        preview: decoded.replace(/\s+/g, ' ').trim().slice(0, 240),
      };
    })
    .sort((left, right) => right.score - left.score);
}
