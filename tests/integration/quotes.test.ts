import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../electron/worker/project-store';
import { Importer } from '../../electron/worker/importer';
import { EditorService } from '../../electron/worker/editor-service';
import { CharacterService } from '../../electron/worker/character-service';
import { QuoteService, detectChineseQuotes } from '../../electron/worker/quote-service';
import type { CharacterScanOutput } from '../../src/shared/contracts';

const cleanupPaths: string[] = [];
afterEach(async () => { await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true }))); });

describe('phase 1B quote extraction and attribution', () => {
  it('detects Chinese quote forms, confirms explicit speakers and preserves unresolved dialogue for review', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-quotes-'));
    cleanupPaths.push(tempRoot);
    const projectRoot = path.join(tempRoot, '对白归属.novelworld');
    const sourcePath = path.join(tempRoot, 'novel.txt');
    await fs.writeFile(sourcePath, [
      '第一章 客栈',
      '陆沉说道：“先救人。”',
      '“我随后就来。”周平答道。',
      '“是谁？”',
      '——别过来！',
    ].join('\n'), 'utf8');
    const store = new ProjectStore();
    try {
      await store.create('对白归属', projectRoot);
      await new Importer(store).run(sourcePath, 'utf8');
      const editor = new EditorService(store);
      editor.buildChunks({ coreChars: 1000, softLimit: 1500, hardLimit: 2000, overlapBefore: 0, overlapAfter: 0 });
      const paragraphs = editor.listParagraphs();
      const luParagraph = paragraphs.find((paragraph) => paragraph.text.includes('陆沉说道'))!;
      const zhouParagraph = paragraphs.find((paragraph) => paragraph.text.includes('周平答道'))!;
      const characterService = new CharacterService(store);
      const scan = characterService.createScan('test-model', 'character_scan.v1');
      const work = characterService.nextChunk(scan.jobId)!;
      const output: CharacterScanOutput = {
        characters: [
          {
            local_key: 'lu', display_name: '陆沉', mention_forms: [{ text: '陆沉', kind: 'name' }], entity_kind: 'human',
            role_hints: [], has_dialogue: true, participates_in_event: true, confidence: 0.99, uncertainty: '',
            evidence: [{ paragraph_id: luParagraph.id, exact_quote: luParagraph.text, supports: 'dialogue' }],
          },
          {
            local_key: 'zhou', display_name: '周平', mention_forms: [{ text: '周平', kind: 'name' }], entity_kind: 'human',
            role_hints: [], has_dialogue: true, participates_in_event: true, confidence: 0.99, uncertainty: '',
            evidence: [{ paragraph_id: zhouParagraph.id, exact_quote: zhouParagraph.text, supports: 'dialogue' }],
          },
        ],
        identity_claims: [],
      };
      characterService.ingest(scan.jobId, work.chunkId, output, JSON.stringify(output), 50, 20);
      characterService.nextChunk(scan.jobId);
      const characters = characterService.listCharacters();
      const lu = characters.find((character) => character.canonicalName === '陆沉')!;
      const zhou = characters.find((character) => character.canonicalName === '周平')!;
      characterService.review(lu.id, { status: 'confirmed' });
      characterService.review(zhou.id, { status: 'confirmed' });

      const quotes = new QuoteService(store);
      expect(detectChineseQuotes('「甲」『乙』"丙"')).toHaveLength(3);
      expect(quotes.scan()).toEqual({ quoteCount: 4, confirmedSpeakerCount: 2, suggestedSpeakerCount: 1, unresolvedCount: 1 });
      const records = quotes.listQuotes();
      expect(records).toHaveLength(4);
      for (const quote of records) {
        const paragraph = paragraphs.find((item) => item.id === quote.paragraphId)!;
        expect(paragraph.text.slice(quote.startOffset, quote.endOffset)).toBe(quote.quoteText);
      }
      expect(records.find((quote) => quote.quoteText === '先救人。')?.confirmedSpeakerName).toBe('陆沉');
      expect(records.find((quote) => quote.quoteText === '我随后就来。')?.confirmedSpeakerName).toBe('周平');
      const ambiguous = records.find((quote) => quote.quoteText === '是谁？')!;
      const candidates = quotes.listAttributions(ambiguous.id);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({ identityName: '周平', method: 'nearby_context', reviewStatus: 'pending' });
      quotes.review(candidates[0].id, 'rejected');
      expect(quotes.summary().unresolvedCount).toBe(2);
      quotes.review(candidates[0].id, 'pending');
      const dash = records.find((quote) => quote.quoteType === 'dash')!;
      expect(quotes.assignSpeaker(dash.id, lu.id)[0]).toMatchObject({ identityName: '陆沉', method: 'user', reviewStatus: 'confirmed' });
      expect(quotes.summary()).toEqual({ quoteCount: 4, confirmedSpeakerCount: 3, suggestedSpeakerCount: 1, unresolvedCount: 0 });
      expect(quotes.scan()).toEqual({ quoteCount: 4, confirmedSpeakerCount: 3, suggestedSpeakerCount: 1, unresolvedCount: 0 });
      expect(quotes.analyzeLocalTurns()).toEqual({ createdCandidates: 1, profileCount: 2 });
      expect(quotes.analyzeLocalTurns()).toEqual({ createdCandidates: 0, profileCount: 2 });
      let profiles = quotes.listSpeechProfiles();
      expect(profiles.find((profile) => profile.identityName === '陆沉')).toMatchObject({ quoteCount: 2 });
      expect(profiles.find((profile) => profile.identityName === '周平')).toMatchObject({ quoteCount: 1 });
      const turnCandidate = quotes.listAttributions(ambiguous.id).find((candidate) => candidate.method === 'turn_taking')!;
      expect(turnCandidate).toMatchObject({ identityName: '陆沉', reviewStatus: 'pending' });
      quotes.review(turnCandidate.id, 'confirmed');
      profiles = quotes.listSpeechProfiles();
      expect(profiles.find((profile) => profile.identityName === '陆沉')).toMatchObject({ quoteCount: 3 });
      characterService.merge(zhou.id, lu.id);
      expect(quotes.listQuotes().find((quote) => quote.quoteText === '我随后就来。')?.confirmedSpeakerName).toBe('陆沉');
      expect(quotes.listSpeechProfiles()).toHaveLength(0);
      characterService.undoLatest();
      expect(quotes.listQuotes().find((quote) => quote.quoteText === '我随后就来。')?.confirmedSpeakerName).toBe('周平');
    } finally {
      await store.close();
    }
  });
});
