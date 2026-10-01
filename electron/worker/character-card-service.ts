import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  CharacterCardBatchGenerationSummary,
  CharacterCardBatchItem,
  CharacterCardDraftFields,
  CharacterCardDraftRecord,
  CharacterCardRefineField,
  CharacterCardRefinementOutput,
  CharacterCardRefinementRecord,
  CharacterCardRefinementWorkItem,
  CharacterCardQualityReport,
  StoryStateValueRecord,
  TavernCharacterBook,
  TavernCardV2,
} from '../../src/shared/contracts';
import { characterCardDraftFieldsSchema, characterCardRefinementOutputSchema } from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { SCHEMA_VERSION } from './schema';
import { StoryStateService } from './story-state-service';
import { withTransaction } from './db-utils';
import { CHARACTER_KNOWLEDGE_POLICY, StoryKnowledgeProjection, type ProjectedQuote } from './story-knowledge-projection';
import { activeLocalPipeline, LOCAL_PIPELINE_VERSION } from './local-pipeline-context';

type IdentityRow = { id: string; name: string; importanceTier: string };
type DraftRow = {
  id: string; identityId: string; identityName: string; entryEventId: string; entryEventTitle: string;
  description: string; personality: string; scenario: string; firstMes: string; mesExample: string;
  creatorNotes: string; systemPrompt: string; postHistoryInstructions: string; alternateGreetingsJson: string;
  tagsJson: string; creator: string; characterVersion: string; reviewStatus: 'draft' | 'reviewed';
  sourceSummaryJson: string; createdAt: string; updatedAt: string;
};
type RefinementRow = {
  id: string; identityId: string; model: string; promptVersion: string; originalFieldsJson: string;
  proposedFieldsJson: string; sourceKeysJson: string; changeSummaryJson: string; warningsJson: string;
  status: CharacterCardRefinementRecord['status']; appliedFieldsJson: string; inputTokens: number; outputTokens: number;
  createdAt: string; reviewedAt: string | null;
};
type QuoteRow = ProjectedQuote;

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

function representativeQuotes(rows: QuoteRow[], limit: number): QuoteRow[] {
  const eligible = rows.filter((row) => row.text.trim().length >= 2 && row.text.trim().length <= 160);
  const source = eligible.length >= Math.min(limit, rows.length) ? eligible : rows;
  if (source.length <= limit) return source;
  const selected = new Map<string, QuoteRow>();
  for (let index = 0; index < limit; index += 1) {
    const position = Math.round(index * (source.length - 1) / Math.max(1, limit - 1));
    selected.set(source[position].id, source[position]);
  }
  return [...selected.values()];
}

function projectedSpeechLines(quotes: QuoteRow[]): string[] {
  if (!quotes.length) return [];
  const hasAny = (text: string, markers: string[]) => markers.some((marker) => text.includes(marker));
  const rate = (predicate: (text: string) => boolean) => quotes.filter((quote) => predicate(quote.text)).length / quotes.length;
  const markerCandidates = ['我', '我们', '咱们', '你', '你们', '您', '请', '多谢', '谢谢', '抱歉', '对不起', '在下', '阁下', '本座', '贫道', '奴家', '吾', '汝', '尔'];
  const markers = markerCandidates.map((marker) => ({ marker, count: quotes.reduce((sum, quote) => sum + quote.text.split(marker).length - 1, 0) }))
    .filter((item) => item.count > 0).sort((a, b) => b.count - a.count || a.marker.localeCompare(b.marker, 'zh-CN')).slice(0, 6);
  const average = quotes.reduce((sum, quote) => sum + quote.text.length, 0) / quotes.length;
  const lines = [`已确认对白 ${quotes.length} 条，平均长度 ${average.toFixed(1)} 字。`];
  if (markers.length) lines.push(`常见用语标记：${markers.map((item) => item.marker).join('、')}。`);
  if (rate((text) => hasAny(text, ['在下', '阁下', '本座', '贫道', '奴家', '吾', '汝', '尔'])) >= 0.3) lines.push('措辞带有较明显的古典称谓倾向。');
  if (rate((text) => hasAny(text, ['请', '劳驾', '多谢', '谢谢', '抱歉', '对不起'])) >= 0.3) lines.push('较常使用礼貌措辞。');
  if (rate((text) => /[？?]/u.test(text)) >= 0.3) lines.push('对话中较常使用问句。');
  if (rate((text) => /[！!]/u.test(text)) >= 0.3) lines.push('对话中较常使用感叹句。');
  return lines;
}

const categoryLabels: Record<StoryStateValueRecord['category'], string> = {
  identity: '身份', appearance: '外貌', personality: '性格', ability: '能力', motivation: '动机', background: '经历与背景',
  status: '当前状态', secret: '秘密', speech: '语言习惯', relationship: '人物关系', other: '其他事实',
};

function renderValues(values: StoryStateValueRecord[]): string {
  const groups = new Map<string, StoryStateValueRecord[]>();
  for (const value of values) {
    const items = groups.get(value.category) ?? [];
    items.push(value); groups.set(value.category, items);
  }
  return [...groups.entries()].map(([category, items]) => `【${categoryLabels[category as StoryStateValueRecord['category']]}】\n${items.map((item) =>
    item.value ? `${item.predicate}：${item.value}` : `${item.predicate}：尚不确定（可能为 ${item.alternatives.join(' / ')}）`).join('\n')}`).join('\n\n');
}

export class CharacterCardService {
  private readonly storyState: StoryStateService;

  constructor(private readonly store: ProjectStore) {
    this.storyState = new StoryStateService(store);
  }

  getDraft(identityId: string): CharacterCardDraftRecord | null {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare(`SELECT d.id, d.identity_id AS identityId, i.canonical_name AS identityName,
      d.entry_event_id AS entryEventId, e.title AS entryEventTitle, d.description, d.personality, d.scenario,
      d.first_mes AS firstMes, d.mes_example AS mesExample, d.creator_notes AS creatorNotes,
      d.system_prompt AS systemPrompt, d.post_history_instructions AS postHistoryInstructions,
      d.alternate_greetings_json AS alternateGreetingsJson, d.tags_json AS tagsJson, d.creator,
      d.character_version AS characterVersion, d.review_status AS reviewStatus,
      d.source_summary_json AS sourceSummaryJson, d.created_at AS createdAt, d.updated_at AS updatedAt
      FROM character_card_drafts d JOIN person_identities i ON i.id = d.identity_id
      JOIN timeline_events e ON e.id = d.entry_event_id WHERE d.revision_id = ? AND d.identity_id = ?`)
      .get(revisionId, identityId) as DraftRow | undefined;
    return row ? this.mapDraft(row) : null;
  }

  private projectSources(identityId: string, entryEventId: string) {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const projection = new StoryKnowledgeProjection(db, revisionId, entryEventId);
    const snapshot = this.storyState.snapshot(entryEventId, identityId, 'public-entry');
    const facts = projection.facts(identityId);
    const quotes = projection.quotes(identityId);
    const fingerprint = hash(JSON.stringify({
      policy: CHARACTER_KNOWLEDGE_POLICY, revisionId, identityId, entry: projection.entry,
      facts, quotes, characters: snapshot.characters,
    }));
    return { snapshot, facts, quotes, fingerprint };
  }

  private assertProjectionCurrent(draft: CharacterCardDraftRecord) {
    const message = '角色卡资料投影已过期或来自旧版规则；请先保留人工修改，重新生成并审阅后再导出或润色';
    if (draft.sourceSummary.projectionPolicyVersion !== CHARACTER_KNOWLEDGE_POLICY) throw new Error(message);
    try {
      const projected = this.projectSources(draft.identityId, draft.entryEventId);
      if (projected.fingerprint !== draft.sourceSummary.sourceFingerprint) throw new Error(message);
      return projected;
    } catch {
      throw new Error(message);
    }
  }

  generate(identityId: string, entryEventId: string): CharacterCardDraftRecord {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const identity = db.prepare(`SELECT id, canonical_name AS name, importance_tier AS importanceTier
      FROM person_identities WHERE id = ? AND revision_id = ? AND review_status = 'confirmed'`)
      .get(identityId, revisionId) as IdentityRow | undefined;
    if (!identity) throw new Error('请先确认要制作角色卡的人物');
    const projected = this.projectSources(identityId, entryEventId);
    const { snapshot } = projected;
    const localBasic = activeLocalPipeline(db, revisionId)?.identityIds.includes(identityId) ?? false;
    const character = snapshot.characters[0];
    if (!character || !projected.facts.length) throw new Error('该进入点还没有可用于角色卡的已确认公开事实');
    const descriptive = character.values.filter((item) => !['personality', 'motivation', 'speech'].includes(item.category));
    const behavioral = character.values.filter((item) => ['personality', 'motivation', 'speech'].includes(item.category));
    const quoteRows = representativeQuotes(projected.quotes, 3);
    const speechLines = projectedSpeechLines(projected.quotes);
    const location = character.values.find((item) => item.category === 'status' && /地点|位置|所在/u.test(item.predicate) && item.value);
    const fields: CharacterCardDraftFields = {
      description: [localBasic ? '【极低档本地基础资料】下列原文提及仅是文本线索，不等于角色亲历、内心或已知秘密。未说明的设定保持未知，不把同场人物的经历和对白归给本角色。' : '', `{{char}}是小说工程中的人物，姓名为${identity.name}。`, renderValues(descriptive)].filter(Boolean).join('\n\n'),
      personality: [renderValues(behavioral), speechLines.length ? `【对白统计画像】\n${speechLines.join('\n')}` : ''].filter(Boolean).join('\n\n'),
      scenario: `{{user}}在“${snapshot.entryEventTitle}”对应的故事时间点进入世界。下列人物状态以这个进入点为准；标记为不确定的内容不可擅自选定。`,
      firstMes: `*故事从“${snapshot.entryEventTitle}”这一时刻展开。${location?.value ? `${identity.name}此时位于${location.value}。` : `${identity.name}正处在这个世界中。`}*`,
      mesExample: quoteRows.map((quote) => `<START>\n{{char}}: ${quote.text}`).join('\n'),
      creatorNotes: '自动资料仅使用进入段落（含）之前已有支持证据的已确认公开事实与对白；私密和秘密事实不自动纳入。公开不等于人物本人知情，请人工核对人物知情范围、名称、进入事件标题、开场白和不确定项；人工编辑内容也须检查剧透。本卡没有覆盖 SillyTavern 的全局系统提示词。',
      systemPrompt: '',
      postHistoryInstructions: '',
      alternateGreetings: [],
      tags: ['小说角色', '证据驱动', ...(localBasic ? ['本地基础'] : []), identity.importanceTier === 'core' ? '核心人物' : identity.importanceTier === 'important' ? '重要人物' : '小说人物'],
      creator: '小说世界编译器',
      characterVersion: localBasic ? LOCAL_PIPELINE_VERSION : '1.0-draft',
    };
    const sourceFingerprint = projected.fingerprint;
    const sourceSummary = {
      confirmedFactCount: projected.facts.length,
      resolvedStateCount: character.resolvedCount,
      ambiguousStateCount: character.ambiguousCount,
      quoteSampleCount: quoteRows.length,
      sourceFingerprint,
      projectionPolicyVersion: CHARACTER_KNOWLEDGE_POLICY,
    };
    const timestamp = now();
    const id = `ccd_${hash(`${revisionId}:${identityId}`).slice(0, 32)}`;
    db.prepare(`INSERT INTO character_card_drafts
      (id, revision_id, identity_id, entry_event_id, description, personality, scenario, first_mes, mes_example,
       creator_notes, system_prompt, post_history_instructions, alternate_greetings_json, tags_json, creator,
       character_version, review_status, source_summary_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      ON CONFLICT(revision_id, identity_id) DO UPDATE SET entry_event_id = excluded.entry_event_id,
       description = excluded.description, personality = excluded.personality, scenario = excluded.scenario,
       first_mes = excluded.first_mes, mes_example = excluded.mes_example, creator_notes = excluded.creator_notes,
       system_prompt = excluded.system_prompt, post_history_instructions = excluded.post_history_instructions,
       alternate_greetings_json = excluded.alternate_greetings_json, tags_json = excluded.tags_json,
       creator = excluded.creator, character_version = excluded.character_version, review_status = 'draft',
       source_summary_json = excluded.source_summary_json, updated_at = excluded.updated_at`)
      .run(id, revisionId, identityId, entryEventId, fields.description, fields.personality, fields.scenario, fields.firstMes,
        fields.mesExample, fields.creatorNotes, fields.systemPrompt, fields.postHistoryInstructions,
        JSON.stringify(fields.alternateGreetings), JSON.stringify(fields.tags), fields.creator, fields.characterVersion,
        JSON.stringify(sourceSummary), timestamp, timestamp);
    return this.getDraft(identityId)!;
  }

  save(identityId: string, input: CharacterCardDraftFields, reviewStatus: 'draft' | 'reviewed'): CharacterCardDraftRecord {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const fields = characterCardDraftFieldsSchema.parse(input);
    const result = db.prepare(`UPDATE character_card_drafts SET description = ?, personality = ?, scenario = ?,
      first_mes = ?, mes_example = ?, creator_notes = ?, system_prompt = ?, post_history_instructions = ?,
      alternate_greetings_json = ?, tags_json = ?, creator = ?, character_version = ?, review_status = ?, updated_at = ?
      WHERE revision_id = ? AND identity_id = ?`)
      .run(fields.description, fields.personality, fields.scenario, fields.firstMes, fields.mesExample, fields.creatorNotes,
        fields.systemPrompt, fields.postHistoryInstructions, JSON.stringify(fields.alternateGreetings), JSON.stringify(fields.tags),
        fields.creator, fields.characterVersion, reviewStatus, now(), revisionId, identityId);
    if (!result.changes) throw new Error('请先生成角色卡草稿');
    return this.getDraft(identityId)!;
  }

  async exportJson(identityId: string, outputPath: string): Promise<{ outputPath: string; checksum: string; card: TavernCardV2 }> {
    const card = this.buildCard(identityId);
    const serialized = `${JSON.stringify(card, null, 2)}\n`;
    await fs.writeFile(outputPath, serialized, 'utf8');
    return { outputPath, checksum: hash(serialized), card };
  }

  buildCard(identityId: string, characterBook?: TavernCharacterBook): TavernCardV2 {
    const draft = this.getDraft(identityId);
    if (!draft) throw new Error('请先生成角色卡草稿');
    if (draft.reviewStatus !== 'reviewed') throw new Error('请先保存并标记角色卡为已审阅');
    this.assertProjectionCurrent(draft);
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const card: TavernCardV2 = {
      spec: 'chara_card_v2', spec_version: '2.0',
      data: {
        name: draft.identityName, description: draft.description, personality: draft.personality,
        scenario: draft.scenario, first_mes: draft.firstMes, mes_example: draft.mesExample,
        creator_notes: draft.creatorNotes, system_prompt: draft.systemPrompt,
        post_history_instructions: draft.postHistoryInstructions, alternate_greetings: draft.alternateGreetings,
        ...(characterBook ? { character_book: characterBook } : {}),
        tags: draft.tags, creator: draft.creator, character_version: draft.characterVersion,
        extensions: { novel_world_compiler: {
          schema_version: SCHEMA_VERSION, revision_id: revisionId, identity_id: draft.identityId,
          entry_event_id: draft.entryEventId, source_fingerprint: draft.sourceSummary.sourceFingerprint,
        } },
      },
    };
    return card;
  }

  prepareRefinement(identityId: string, modelInput: string, promptVersionInput: string): CharacterCardRefinementWorkItem {
    const draft = this.getDraft(identityId);
    if (!draft) throw new Error('请先生成角色卡草稿');
    if (draft.reviewStatus !== 'reviewed') throw new Error('请先人工审阅本地草稿，再请求模型润色');
    const model = modelInput.trim();
    const promptVersion = promptVersionInput.trim() || 'character_card_refine.v1';
    if (!model) throw new Error('请填写角色卡润色模型');
    const projected = this.assertProjectionCurrent(draft);
    const sources: CharacterCardRefinementWorkItem['sources'] = [];
    const facts = projected.facts;
    facts.forEach((fact) => sources.push({ key: `fact:${fact.id}`, kind: 'fact', label: `${fact.category}/${fact.predicate}`, content: fact.value }));
    const quotes = representativeQuotes(projected.quotes, 12);
    quotes.forEach((quote) => sources.push({ key: `quote:${quote.id}`, kind: 'quote', label: '已确认原文对白', content: quote.text }));
    sources.push({ key: `entry:${draft.entryEventId}`, kind: 'entry', label: '已确认进入事件', content: draft.entryEventTitle });
    const draftFields: Pick<CharacterCardDraftFields, CharacterCardRefineField> = {
      description: draft.description, personality: draft.personality, scenario: draft.scenario,
      firstMes: draft.firstMes, mesExample: draft.mesExample,
    };
    for (const [field, content] of Object.entries(draftFields)) {
      sources.push({ key: `draft:${field}`, kind: 'draft', label: `已审阅草稿/${field}`, content });
    }
    return {
      identityId, identityName: draft.identityName, entryEventId: draft.entryEventId,
      entryEventTitle: draft.entryEventTitle, model, promptVersion, draft: draftFields, sources,
    };
  }

  ingestRefinement(identityId: string, model: string, promptVersion: string, input: CharacterCardRefinementOutput,
    rawJson: string, inputTokens: number, outputTokens: number): CharacterCardRefinementRecord {
    const work = this.prepareRefinement(identityId, model, promptVersion);
    const result = characterCardRefinementOutputSchema.parse(input);
    const allowed = new Set(work.sources.map((source) => source.key));
    const fieldPairs: Array<[CharacterCardRefineField, keyof typeof result.fields]> = [
      ['description', 'description'], ['personality', 'personality'], ['scenario', 'scenario'], ['firstMes', 'first_mes'], ['mesExample', 'mes_example'],
    ];
    const proposed = {} as Pick<CharacterCardDraftFields, CharacterCardRefineField>;
    const sourceKeys = {} as Record<CharacterCardRefineField, string[]>;
    for (const [target, source] of fieldPairs) {
      const invalid = result.fields[source].source_keys.filter((key) => !allowed.has(key));
      if (invalid.length) throw new Error(`模型为 ${target} 返回了不存在的来源键：${invalid.join('、')}`);
      proposed[target] = result.fields[source].text;
      sourceKeys[target] = [...new Set(result.fields[source].source_keys)];
    }
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const id = `ccr_${randomUUID()}`;
    const timestamp = now();
    db.prepare(`INSERT INTO character_card_refinements
      (id, revision_id, identity_id, model, prompt_version, original_fields_json, proposed_fields_json,
       source_keys_json, change_summary_json, warnings_json, raw_json, status, applied_fields_json,
       input_tokens, output_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '[]', ?, ?, ?)`)
      .run(id, revisionId, identityId, work.model, work.promptVersion, JSON.stringify(work.draft), JSON.stringify(proposed),
        JSON.stringify(sourceKeys), JSON.stringify(result.change_summary), JSON.stringify(result.warnings), rawJson,
        Math.max(0, Math.trunc(inputTokens)), Math.max(0, Math.trunc(outputTokens)), timestamp);
    return this.getRefinement(id)!;
  }

  latestRefinement(identityId: string): CharacterCardRefinementRecord | null {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare(`SELECT id FROM character_card_refinements WHERE revision_id = ? AND identity_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(revisionId, identityId) as { id: string } | undefined;
    return row ? this.getRefinement(row.id) : null;
  }

  reviewRefinement(refinementId: string, action: 'apply' | 'reject', fieldsInput: CharacterCardRefineField[] = []): {
    refinement: CharacterCardRefinementRecord; draft: CharacterCardDraftRecord;
  } {
    const refinement = this.getRefinement(refinementId);
    if (!refinement) throw new Error('找不到该角色卡润色建议');
    if (refinement.status !== 'pending') throw new Error('该润色建议已经处理');
    const allFields: CharacterCardRefineField[] = ['description', 'personality', 'scenario', 'firstMes', 'mesExample'];
    const fields = [...new Set(fieldsInput)].filter((field): field is CharacterCardRefineField => allFields.includes(field));
    if (action === 'apply' && !fields.length) throw new Error('请至少选择一个要采用的字段');
    if (action === 'apply') {
      const current = this.getDraft(refinement.identityId);
      const currentFields = current ? {
        description: current.description, personality: current.personality, scenario: current.scenario,
        firstMes: current.firstMes, mesExample: current.mesExample,
      } : null;
      if (!currentFields || JSON.stringify(currentFields) !== JSON.stringify(refinement.original)) {
        throw new Error('角色卡草稿在润色建议生成后已经改变，请重新请求润色');
      }
      this.assertProjectionCurrent(current!);
    }
    const { db } = this.store.get();
    const timestamp = now();
    withTransaction(db, () => {
      if (action === 'apply') {
        const columns: Record<CharacterCardRefineField, string> = {
          description: 'description', personality: 'personality', scenario: 'scenario', firstMes: 'first_mes', mesExample: 'mes_example',
        };
        for (const field of fields) {
          db.prepare(`UPDATE character_card_drafts SET ${columns[field]} = ?, review_status = 'draft', updated_at = ? WHERE identity_id = ?`)
            .run(refinement.proposed[field], timestamp, refinement.identityId);
        }
      }
      db.prepare(`UPDATE character_card_refinements SET status = ?, applied_fields_json = ?, reviewed_at = ? WHERE id = ?`)
        .run(action === 'apply' ? 'applied' : 'rejected', JSON.stringify(action === 'apply' ? fields : []), timestamp, refinementId);
    });
    return { refinement: this.getRefinement(refinementId)!, draft: this.getDraft(refinement.identityId)! };
  }

  batchStatus(): CharacterCardBatchItem[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const local = activeLocalPipeline(db, revisionId);
    const rows = db.prepare(`SELECT i.id AS identityId, i.canonical_name AS identityName, i.importance_tier AS importanceTier,
      COUNT(CASE WHEN COALESCE(m.truth_status, 'asserted') = 'asserted' THEN f.id END) AS confirmedFactCount FROM person_identities i
      LEFT JOIN character_facts f ON f.identity_id = i.id AND f.review_status = 'confirmed'
      LEFT JOIN character_fact_claim_metadata m ON m.fact_id = f.id
      WHERE i.revision_id = ? AND i.review_status = 'confirmed'
        AND ${local ? 'i.id IN (SELECT value FROM json_each(?))' : "i.importance_tier IN ('core','important')"}
      GROUP BY i.id ORDER BY CASE i.importance_tier WHEN 'core' THEN 0 ELSE 1 END, i.canonical_name`)
      .all(revisionId, ...(local ? [JSON.stringify(local.identityIds)] : [])) as Array<{ identityId: string; identityName: string; importanceTier: 'core' | 'important'; confirmedFactCount: number }>;
    return rows.map((row) => {
      const draft = this.getDraft(row.identityId);
      const quality = draft ? this.qualityReport(draft) : null;
      return {
        identityId: row.identityId, identityName: row.identityName, importanceTier: row.importanceTier,
        confirmedFactCount: Number(row.confirmedFactCount), hasDraft: Boolean(draft),
        reviewStatus: draft?.reviewStatus ?? 'none', entryEventId: draft?.entryEventId ?? null,
        entryEventTitle: draft?.entryEventTitle ?? null, quality,
        exportReady: Boolean(draft?.reviewStatus === 'reviewed' && quality?.contentReady),
      };
    });
  }

  generateMissing(entryEventId: string): CharacterCardBatchGenerationSummary {
    this.storyState.snapshot(entryEventId);
    const targets = this.batchStatus();
    const results: CharacterCardBatchGenerationSummary['results'] = [];
    for (const target of targets) {
      if (target.hasDraft) {
        results.push({ identityId: target.identityId, identityName: target.identityName, status: 'skipped', message: '已有草稿，未覆盖' });
        continue;
      }
      try {
        this.generate(target.identityId, entryEventId);
        results.push({ identityId: target.identityId, identityName: target.identityName, status: 'generated', message: '已生成本地草稿' });
      } catch (error) {
        results.push({ identityId: target.identityId, identityName: target.identityName, status: 'failed', message: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      entryEventId, targetCount: targets.length,
      generatedCount: results.filter((item) => item.status === 'generated').length,
      skippedCount: results.filter((item) => item.status === 'skipped').length,
      failedCount: results.filter((item) => item.status === 'failed').length,
      results,
    };
  }

  async exportReviewed(outputDirectory: string): Promise<{
    outputDirectory: string; exportedCount: number;
    files: Array<{ identityId: string; identityName: string; outputPath: string; checksum: string }>;
  }> {
    const targets = this.batchStatus().filter((item) => item.exportReady);
    if (!targets.length) throw new Error('没有同时满足“已审阅”和质量门槛的角色卡');
    await fs.mkdir(outputDirectory, { recursive: true });
    const files: Array<{ identityId: string; identityName: string; outputPath: string; checksum: string }> = [];
    for (const target of targets) {
      const safeName = target.identityName.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim() || 'character';
      let outputPath = path.join(outputDirectory, `${safeName}-角色卡-v2.json`);
      let suffix = 2;
      while (await fs.access(outputPath).then(() => true).catch(() => false)) {
        outputPath = path.join(outputDirectory, `${safeName}-角色卡-v2-${suffix}.json`);
        suffix += 1;
      }
      const result = await this.exportJson(target.identityId, outputPath);
      files.push({ identityId: target.identityId, identityName: target.identityName, outputPath, checksum: result.checksum });
    }
    return { outputDirectory, exportedCount: files.length, files };
  }

  private qualityReport(draft: CharacterCardDraftRecord): CharacterCardQualityReport {
    const issues: CharacterCardQualityReport['issues'] = [];
    let score = 100;
    const subtract = (points: number, severity: 'error' | 'warning', code: string, message: string) => {
      score -= points; issues.push({ severity, code, message });
    };
    try { this.assertProjectionCurrent(draft); }
    catch (error) { subtract(30, 'error', 'stale_knowledge_projection', error instanceof Error ? error.message : '角色卡资料投影需要重新审核'); }
    if (draft.sourceSummary.confirmedFactCount === 0) subtract(30, 'error', 'no_confirmed_facts', '没有已确认人物事实');
    else if (draft.sourceSummary.confirmedFactCount < 3) subtract(12, 'warning', 'few_confirmed_facts', '已确认人物事实少于 3 条，人物定义可能单薄');
    if (!draft.description.trim()) subtract(30, 'error', 'empty_description', '人物定义为空');
    if (!draft.personality.trim()) subtract(15, 'warning', 'empty_personality', '性格与语言字段为空');
    if (!draft.scenario.trim()) subtract(20, 'error', 'empty_scenario', '进入场景为空');
    if (draft.firstMes.trim().length < 20) subtract(15, 'warning', 'short_first_message', '开场白少于 20 个字符');
    if (!draft.mesExample.trim()) subtract(10, 'warning', 'no_message_examples', '没有已确认对白示例');
    if (draft.sourceSummary.quoteSampleCount === 0) subtract(8, 'warning', 'no_confirmed_quotes', '没有可追溯的已确认说话人对白');
    if (draft.sourceSummary.ambiguousStateCount > 0) subtract(Math.min(15, draft.sourceSummary.ambiguousStateCount * 4), 'warning', 'ambiguous_entry_state', `进入时刻有 ${draft.sourceSummary.ambiguousStateCount} 项人物状态仍不确定`);
    if (draft.systemPrompt.trim() || draft.postHistoryInstructions.trim()) {
      issues.push({ severity: 'info', code: 'prompt_override_present', message: '包含角色专属提示覆盖字段，导入前应再次确认' });
    }
    const approximateCharacters = [draft.description, draft.personality, draft.scenario, draft.firstMes, draft.mesExample].reduce((sum, value) => sum + value.length, 0);
    const approximateTokens = Math.ceil(approximateCharacters / 2.5);
    if (approximateTokens > 5000) subtract(8, 'warning', 'large_context', `主要字段约 ${approximateTokens} Token，可能挤占聊天上下文`);
    score = Math.max(0, Math.min(100, score));
    const grade: CharacterCardQualityReport['grade'] = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
    const localBasic = draft.characterVersion === LOCAL_PIPELINE_VERSION && draft.tags.includes('本地基础');
    if (localBasic) issues.push({ severity: 'info', code: 'local_basic_profile', message: '极低档按基础可玩门槛判断；缺少性格或对白示例会保留质量提示，不要求虚构内容补齐。' });
    return { score, grade, contentReady: (localBasic || score >= 70) && !issues.some((issue) => issue.severity === 'error'), approximateCharacters, approximateTokens, issues };
  }

  private getRefinement(refinementId: string): CharacterCardRefinementRecord | null {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const row = db.prepare(`SELECT id, identity_id AS identityId, model, prompt_version AS promptVersion,
      original_fields_json AS originalFieldsJson, proposed_fields_json AS proposedFieldsJson,
      source_keys_json AS sourceKeysJson, change_summary_json AS changeSummaryJson, warnings_json AS warningsJson,
      status, applied_fields_json AS appliedFieldsJson, input_tokens AS inputTokens, output_tokens AS outputTokens,
      created_at AS createdAt, reviewed_at AS reviewedAt FROM character_card_refinements WHERE id = ? AND revision_id = ?`)
      .get(refinementId, revisionId) as RefinementRow | undefined;
    if (!row) return null;
    return {
      id: row.id, identityId: row.identityId, model: row.model, promptVersion: row.promptVersion,
      original: JSON.parse(row.originalFieldsJson) as CharacterCardRefinementRecord['original'],
      proposed: JSON.parse(row.proposedFieldsJson) as CharacterCardRefinementRecord['proposed'],
      sourceKeys: JSON.parse(row.sourceKeysJson) as CharacterCardRefinementRecord['sourceKeys'],
      changeSummary: JSON.parse(row.changeSummaryJson) as string[], warnings: JSON.parse(row.warningsJson) as string[],
      status: row.status, appliedFields: JSON.parse(row.appliedFieldsJson) as CharacterCardRefineField[],
      inputTokens: Number(row.inputTokens), outputTokens: Number(row.outputTokens), createdAt: row.createdAt, reviewedAt: row.reviewedAt,
    };
  }

  private mapDraft(row: DraftRow): CharacterCardDraftRecord {
    return {
      id: row.id, identityId: row.identityId, identityName: row.identityName,
      entryEventId: row.entryEventId, entryEventTitle: row.entryEventTitle,
      description: row.description, personality: row.personality, scenario: row.scenario,
      firstMes: row.firstMes, mesExample: row.mesExample, creatorNotes: row.creatorNotes,
      systemPrompt: row.systemPrompt, postHistoryInstructions: row.postHistoryInstructions,
      alternateGreetings: JSON.parse(row.alternateGreetingsJson) as string[], tags: JSON.parse(row.tagsJson) as string[],
      creator: row.creator, characterVersion: row.characterVersion, reviewStatus: row.reviewStatus,
      sourceSummary: JSON.parse(row.sourceSummaryJson) as CharacterCardDraftRecord['sourceSummary'],
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }
}
