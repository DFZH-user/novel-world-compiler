import { z } from 'zod';
import { dryRunPromptReceiptSchema, type DryRunPromptReceipt } from '../../src/shared/dry-run-context-assembler';
import { tavernCardV2Schema, type TavernCardV2 } from '../../src/shared/contracts';

const triggerSchema = z.string().trim().min(2).max(120);

export type SillyTavernReplayFixture = {
  card: TavernCardV2;
  trigger: string;
  expectedContents: string[];
  expectedItemIds: string[];
  excludedClaimIds: string[];
  receiptId: string;
  projectionRequestId: string;
};

export type SillyTavernReplayDiff = {
  expectedEntryCount: number;
  actualEntryCount: number;
  matchingEntryCount: number;
  missingItemIds: string[];
  extraItemIds: string[];
  textMismatchItemIds: string[];
  orderMatches: boolean;
  forbiddenHits: Array<{ claimId: string; text: string }>;
  passed: boolean;
};

export function replayEntryContent(item: DryRunPromptReceipt['included'][number]) {
  return `[NWC_ITEM:${item.itemId}]\n${item.renderedText}\n[/NWC_ITEM]`;
}

export function extractSillyTavernReplayItems(worldInfoString: string) {
  const pattern = /\[NWC_ITEM:([^\]\r\n]+)\]\r?\n([\s\S]*?)\r?\n\[\/NWC_ITEM\]/gu;
  return [...worldInfoString.matchAll(pattern)].map((match) => ({ itemId: match[1], renderedText: match[2] }));
}

export function compareSillyTavernReplay(
  fixture: SillyTavernReplayFixture,
  worldInfoString: string,
  forbidden: Array<{ claimId: string; text: string }>,
): SillyTavernReplayDiff {
  const actual = extractSillyTavernReplayItems(worldInfoString);
  const actualIds = actual.map((item) => item.itemId);
  const actualById = new Map(actual.map((item) => [item.itemId, item.renderedText]));
  const expectedById = new Map(fixture.expectedContents.map((content, index) => {
    const parsed = extractSillyTavernReplayItems(content)[0];
    if (!parsed) throw new Error(`回放夹具条目无法解析：${fixture.expectedItemIds[index]}`);
    return [fixture.expectedItemIds[index], parsed.renderedText];
  }));
  const missingItemIds = fixture.expectedItemIds.filter((id) => !actualById.has(id));
  const extraItemIds = actualIds.filter((id) => !expectedById.has(id));
  const textMismatchItemIds = fixture.expectedItemIds.filter((id) => actualById.has(id) && actualById.get(id) !== expectedById.get(id));
  const orderMatches = actualIds.length === fixture.expectedItemIds.length
    && actualIds.every((id, index) => id === fixture.expectedItemIds[index]);
  const forbiddenHits = forbidden.filter((item) => worldInfoString.includes(item.text));
  const matchingEntryCount = fixture.expectedItemIds.length - missingItemIds.length - textMismatchItemIds.length;
  return {
    expectedEntryCount: fixture.expectedItemIds.length,
    actualEntryCount: actualIds.length,
    matchingEntryCount,
    missingItemIds,
    extraItemIds,
    textMismatchItemIds,
    orderMatches,
    forbiddenHits,
    passed: missingItemIds.length === 0 && extraItemIds.length === 0 && textMismatchItemIds.length === 0 && orderMatches && forbiddenHits.length === 0,
  };
}

export function buildSillyTavernReplayFixture(rawReceipt: unknown, triggerInput: string): SillyTavernReplayFixture {
  const receipt = dryRunPromptReceiptSchema.parse(rawReceipt);
  if (receipt.status !== 'assembled' || !receipt.finalPromptPreview) throw new Error('只有已成功装配的 Prompt Receipt 可以进入 SillyTavern 回放');
  const trigger = triggerSchema.parse(triggerInput);
  const shortId = receipt.receiptId.slice(0, 12);
  const expectedContents = receipt.included.map(replayEntryContent);
  const expectedItemIds = receipt.included.map((item) => item.itemId);
  const excludedClaimIds = receipt.excluded.flatMap((item) => item.claimId ? [item.claimId] : []);
  const card = tavernCardV2Schema.parse({
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: `NWC上下文回放-${shortId}`,
      description: '仅用于隔离的 SillyTavern World Info 原生回放。',
      personality: '不调用模型。',
      scenario: `输入中文触发词：${trigger}`,
      first_mes: '上下文回放已就绪。',
      mes_example: '',
      creator_notes: '临时验收卡；不得作为正式角色卡发布。',
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: ['nwc-context-replay'],
      creator: '小说世界编译器',
      character_version: 'stage-3-replay-v1',
      extensions: {
        novel_world_compiler: {
          purpose: 'sillytavern-native-context-replay',
          prompt_receipt_id: receipt.receiptId,
          projection_request_id: receipt.projection.requestId,
        },
      },
      character_book: {
        name: `NWC回放知识-${shortId}`,
        description: '由 Stage 2 Prompt Receipt 生成的临时确定性关键词世界书。',
        scan_depth: 4,
        token_budget: 4096,
        recursive_scanning: false,
        extensions: {
          novel_world_compiler: { prompt_receipt_id: receipt.receiptId },
        },
        entries: receipt.included.map((item, index) => ({
          id: index,
          keys: [trigger],
          secondary_keys: [],
          comment: item.itemId,
          content: expectedContents[index],
          constant: false,
          selective: false,
          // SillyTavern prepends before_char entries after sorting; ascending source
          // order preserves the Stage 2 receipt order in the final worldInfoString.
          insertion_order: index,
          enabled: true,
          position: 'before_char' as const,
          extensions: {
            position: 0,
            probability: 100,
            useProbability: false,
            match_whole_words: false,
            exclude_recursion: true,
            prompt_receipt_id: receipt.receiptId,
            context_item_id: item.itemId,
          },
        })),
      },
    },
  });
  return {
    card,
    trigger,
    expectedContents,
    expectedItemIds,
    excludedClaimIds,
    receiptId: receipt.receiptId,
    projectionRequestId: receipt.projection.requestId,
  };
}
