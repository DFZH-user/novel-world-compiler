import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FoundationWorkflowRunRecord, FoundationWorkflowStart, TavernCardV2, TavernCharacterBook } from '../../src/shared/contracts';
import { chunkSettingsSchema, tavernCardV2Schema, tavernCharacterBookSchema } from '../../src/shared/contracts';
import type { LocalFoundationResult, LocalFoundationExportResult } from '../../src/shared/local-foundation';
import type { ProjectStore } from './project-store';
import { FoundationWorkflowService } from './foundation-workflow-service';
import { discoverNames, discoverWorldTerms, evidenceRange, excerptScore, LocalNameMatcher, validName } from './local-foundation-rules';
import { LocalProjectPipeline } from './local-project-pipeline';
import { EditorService } from './editor-service';

type Entity = { name: string; kind: 'person' | 'place' | 'term'; sightings: number; firstOrdinal: number; seeded: number; selected: number };
type Paragraph = { id: string; ordinal: number; text: string };
const VERSION = 'local-rule.v1';
const BATCH = 120;

export class LocalFoundationService {
  private readonly workflows: FoundationWorkflowService;
  private matcher: { runId: string; value: LocalNameMatcher } | null = null;
  constructor(private readonly store: ProjectStore) { this.workflows = new FoundationWorkflowService(store); }

  private check(runId: string): FoundationWorkflowRunRecord {
    const run = this.workflows.get(runId);
    if (run.profile !== 'local') throw new Error('此操作仅用于极低档本地生成');
    return run;
  }

  upgrade(runId: string): FoundationWorkflowStart {
    const previous = this.check(runId);
    const { db, projectId } = this.store.get();
    const project = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string };
    if (project.id !== previous.revisionId) throw new Error('原文修订已改变，请重新一键生成');
    const state = db.prepare('SELECT phase, total, max_cards AS maxCards FROM local_foundation_runs WHERE run_id = ?').get(runId) as { phase: string; total: number; maxCards: number } | undefined;
    if (!state || state.phase !== 'done' || previous.state !== 'completed') throw new Error('请先完成或继续原来的本地扫描');
    const input = db.prepare('SELECT input_json AS input FROM jobs WHERE id = ?').get(previous.jobId) as { input: string };
    const created = this.workflows.create('', 'local', null, JSON.parse(input.input).localOptions);
    if (created.reused) return created;
    db.transaction(() => {
      db.prepare("INSERT INTO local_foundation_runs(run_id, phase, cursor, total, max_cards) VALUES (?, 'integrate', -1, ?, ?)").run(created.runId, state.total, state.maxCards);
      db.prepare(`INSERT INTO local_foundation_entities(run_id, name, kind, sightings, first_ordinal, seeded, selected)
        SELECT ?, name, kind, sightings, first_ordinal, seeded, selected FROM local_foundation_entities WHERE run_id = ?`).run(created.runId, runId);
      db.prepare(`INSERT INTO local_foundation_evidence(run_id, name, paragraph_id, ordinal, start_offset, end_offset, score)
        SELECT ?, name, paragraph_id, ordinal, start_offset, end_offset, score FROM local_foundation_evidence WHERE run_id = ?`).run(created.runId, runId);
    });
    for (const key of ['preflight', 'chunks', 'character_scan', 'draft_selection'] as const) this.workflows.updateStep(created.runId, key, 'completed', '复用已有本地扫描，补齐工程与游玩流程');
    this.workflows.updateStep(created.runId, 'character_facts', 'running', '正在将已有原文索引接入完整工程');
    return created;
  }

  async next(runId: string): Promise<FoundationWorkflowRunRecord> {
    const run = this.check(runId);
    if (run.state !== 'running') return run;
    const { db } = this.store.get();
    let state = db.prepare('SELECT phase, cursor, total, max_cards AS maxCards FROM local_foundation_runs WHERE run_id = ?').get(runId) as
      { phase: string; cursor: number; total: number; maxCards: number } | undefined;
    if (!state) {
      const input = db.prepare('SELECT input_json AS input FROM jobs WHERE id = ?').get(run.jobId) as { input: string };
      const options = JSON.parse(input.input).localOptions ?? {};
      const names = [...new Set(String(options.names ?? '').split(/[,，;；\s]+/u).map(x => x.trim()).filter(Boolean))];
      if (names.length > 200 || names.some(name => !validName(name))) throw new Error('补充人名最多 200 个，使用 2～6 个汉字或含中点的译名，并用逗号分隔');
      const maxCards = Number(options.maxCards ?? 20);
      if (!Number.isSafeInteger(maxCards) || maxCards < 1 || maxCards > 100) throw new Error('角色卡数量须为 1～100');
      const count = db.prepare(`SELECT COUNT(*) AS total FROM paragraphs p WHERE p.revision_id = ?
        AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1)`).get(run.revisionId) as { total: number };
      if (!count.total) throw new Error('没有可分析的原文段落，请先导入小说');
      db.transaction(() => {
        db.prepare('INSERT INTO local_foundation_runs(run_id, total, max_cards) VALUES (?, ?, ?)').run(runId, count.total, maxCards);
        for (const name of names) db.prepare(`INSERT INTO local_foundation_entities(run_id, name, kind, first_ordinal, seeded)
          VALUES (?, ?, 'person', 2147483647, 1)`).run(runId, name);
      });
      this.workflows.updateStep(runId, 'preflight', 'completed', '原文就绪；纯本地规则，不读取 API 密钥');
      const editor = new EditorService(this.store);
      const chunks = editor.listChunks().length ? editor.listChunks() : editor.buildChunks(chunkSettingsSchema.parse({}));
      this.workflows.updateStep(runId, 'chunks', 'completed', `已准备 ${chunks.length} 个工程分块；本地脚本按段落批次处理`);
      state = { phase: 'discover', cursor: -1, total: count.total, maxCards };
    }
    const paragraphs = db.prepare(`SELECT p.id, p.ordinal, p.text FROM paragraphs p WHERE p.revision_id = ? AND p.ordinal > ?
      AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1)
      ORDER BY p.ordinal LIMIT ?`).all(run.revisionId, state.cursor, BATCH) as Paragraph[];
    if (state.phase === 'discover') {
      if (paragraphs.length) {
        db.transaction(() => {
          const insert = db.prepare(`INSERT INTO local_foundation_entities(run_id, name, kind, sightings, first_ordinal)
            VALUES (?, ?, ?, 1, ?) ON CONFLICT(run_id, name) DO UPDATE SET sightings = sightings + 1,
            first_ordinal = MIN(first_ordinal, excluded.first_ordinal)`);
          // Limit candidate storage; long books must not create an unbounded in-memory dictionary.
          const count = db.prepare('SELECT COUNT(*) AS n FROM local_foundation_entities WHERE run_id = ?').get(runId) as { n: number };
          const known = db.prepare('SELECT 1 FROM local_foundation_entities WHERE run_id = ? AND name = ?');
          let n = count.n;
          for (const p of paragraphs) {
            const candidates = [...discoverNames(p.text).map(name => ({ name, kind: 'person' })), ...discoverWorldTerms(p.text)];
            for (const candidate of candidates) {
              if (!known.get(runId, candidate.name)) { if (n >= 10000) continue; n++; }
              insert.run(runId, candidate.name, candidate.kind, p.ordinal);
            }
          }
          db.prepare('UPDATE local_foundation_runs SET cursor = ? WHERE run_id = ?').run(paragraphs.at(-1)!.ordinal, runId);
        });
        this.workflows.updateStep(runId, 'character_scan', 'running', `正在本地识别人名和术语，已扫描到第 ${paragraphs.at(-1)!.ordinal} 段`, { progress: this.progress(run.revisionId, paragraphs.at(-1)!.ordinal) });
      } else {
        // Explicit seeds take priority. Single incidental matches remain candidates, not facts.
        const people = db.prepare(`SELECT name FROM local_foundation_entities WHERE run_id = ? AND kind = 'person'
          AND (sightings >= 2 OR seeded = 1) ORDER BY seeded DESC, sightings DESC, first_ordinal, name LIMIT ?`).all(runId, state.maxCards) as { name: string }[];
        if (!people.length) throw new Error('规则未找到稳定的人名。请填写补充人名，再点“按当前设置重新生成”');
        db.transaction(() => {
          for (const p of people) db.prepare('UPDATE local_foundation_entities SET selected = 1 WHERE run_id = ? AND name = ?').run(runId, p.name);
          const terms = db.prepare(`SELECT name FROM local_foundation_entities WHERE run_id = ? AND kind != 'person'
            AND (sightings >= 2 OR kind = 'place') ORDER BY sightings DESC, first_ordinal LIMIT 80`).all(runId) as { name: string }[];
          for (const t of terms) db.prepare('UPDATE local_foundation_entities SET selected = 1 WHERE run_id = ? AND name = ?').run(runId, t.name);
          db.prepare("UPDATE local_foundation_runs SET phase = 'evidence', cursor = -1 WHERE run_id = ?").run(runId);
        });
        this.workflows.updateStep(runId, 'character_scan', 'completed', '全书本地候选识别完成；未自动合并别名');
        this.workflows.updateStep(runId, 'draft_selection', 'completed', `选择 ${people.length} 个候选人物生成草稿，其他候选保留在候选清单中`);
      }
    } else if (state.phase === 'evidence') {
      if (paragraphs.length) {
        if (this.matcher?.runId !== runId) this.matcher = { runId, value: new LocalNameMatcher(this.entities(runId).filter(e => e.selected).map(e => e.name)) };
        db.transaction(() => {
          const insert = db.prepare(`INSERT OR IGNORE INTO local_foundation_evidence
            (run_id, name, paragraph_id, ordinal, start_offset, end_offset, score) VALUES (?, ?, ?, ?, ?, ?, ?)`);
          for (const p of paragraphs) {
            const seen = new Set<string>();
            for (const match of this.matcher!.value.find(p.text)) {
              if (seen.has(match.name)) continue;
              seen.add(match.name);
              const range = evidenceRange(p.text, match.start, match.end);
              insert.run(runId, match.name, p.id, p.ordinal, range.start, range.end, excerptScore(p.text.slice(range.start, range.end)));
              db.prepare('UPDATE local_foundation_entities SET first_ordinal = MIN(first_ordinal, ?) WHERE run_id = ? AND name = ?').run(p.ordinal, runId, match.name);
            }
          }
          db.prepare('UPDATE local_foundation_runs SET cursor = ? WHERE run_id = ?').run(paragraphs.at(-1)!.ordinal, runId);
        });
        this.workflows.updateStep(runId, 'character_facts', 'running', `正在收集原文片段，已扫描到第 ${paragraphs.at(-1)!.ordinal} 段`, { progress: this.progress(run.revisionId, paragraphs.at(-1)!.ordinal) });
      } else {
        db.prepare("UPDATE local_foundation_runs SET phase = 'integrate' WHERE run_id = ?").run(runId);
        this.matcher = null;
        this.workflows.updateStep(runId, 'character_facts', 'running', '原文证据索引完成，正在接入工程人物与事实整理');
      }
    } else if (state.phase === 'integrate') {
      const result = new LocalProjectPipeline(this.store).peopleAndFacts(run);
      this.workflows.updateStep(runId, 'character_facts', 'completed', `已接入 ${result.people} 人的基础事实，并完成本地事实整理`, { output: result });
      db.prepare("UPDATE local_foundation_runs SET phase = 'dialogue' WHERE run_id = ?").run(runId);
    } else if (state.phase === 'dialogue') {
      this.workflows.updateStep(runId, 'dialogue_scan', 'running', '正在检测对白、按明确说话提示归属，并整理语言统计');
      const result = new LocalProjectPipeline(this.store).dialogue();
      this.workflows.updateStep(runId, 'dialogue_scan', 'completed', '对白检测与归属处理完成；没有明确说话人的对白保留待审核', { output: result });
      db.prepare("UPDATE local_foundation_runs SET phase = 'time' WHERE run_id = ?").run(runId);
    } else if (state.phase === 'time') {
      this.workflows.updateStep(runId, 'time_expressions', 'running', '正在本地检测日期、相对时间、年龄与时间表达');
      const result = new LocalProjectPipeline(this.store).time();
      this.workflows.updateStep(runId, 'time_expressions', 'completed', '时间表达式已检测并写入故事时间页面', { output: result });
      db.prepare("UPDATE local_foundation_runs SET phase = 'events' WHERE run_id = ?").run(runId);
    } else if (state.phase === 'events') {
      this.workflows.updateStep(runId, 'event_drafts', 'running', '正在提取章节场景与文本入口，关联人物、地点和时间线索');
      const result = new LocalProjectPipeline(this.store).eventsAndPlaces(run);
      this.workflows.updateStep(runId, 'event_drafts', 'completed', `章节场景与故事时间整理完成，处理 ${result.eventCount} 个场景入口`, { output: result });
      this.workflows.updateStep(runId, 'place_drafts', 'completed', '地点审核与叙事地点已接入；无可靠地点时使用“未定位场景”占位', { output: result });
      db.prepare("UPDATE local_foundation_runs SET phase = 'relationships' WHERE run_id = ?").run(runId);
    } else if (state.phase === 'relationships') {
      this.workflows.updateStep(runId, 'relationship_drafts', 'running', '正在生成工程人物关系与关系网图');
      const result = new LocalProjectPipeline(this.store).relationships(run);
      this.workflows.updateStep(runId, 'relationship_drafts', 'completed', '人物关系与图谱已接入，共现关系明确标为原文线索', { output: result });
      db.prepare("UPDATE local_foundation_runs SET phase = 'export' WHERE run_id = ?").run(runId);
    } else if (state.phase === 'export') {
      this.workflows.updateStep(runId, 'summary', 'running', '正在制作工程角色卡、世界书和可游玩整合包');
      const artifacts = await new LocalProjectPipeline(this.store).artifacts(run);
      const output = await this.export(runId);
      if (this.workflows.get(runId).state !== 'running') return this.workflows.get(runId);
      db.prepare("UPDATE local_foundation_runs SET phase = 'done', output_path = ? WHERE run_id = ?").run(output.outputPath, runId);
      this.workflows.updateStep(runId, 'summary', 'completed', '本地完整流程已完成，角色卡、世界书和可游玩包已就绪；API 请求 0 次', { output: { ...output, ...artifacts } });
    }
    return this.workflows.get(runId);
  }

  private progress(revisionId: string, ordinal: number): number {
    const { db } = this.store.get();
    const max = db.prepare('SELECT MAX(ordinal) AS n FROM paragraphs WHERE revision_id = ?').get(revisionId) as { n: number };
    return Math.min(0.99, (ordinal + 1) / Math.max(1, max.n + 1));
  }
  private entities(runId: string): Entity[] {
    return this.store.get().db.prepare(`SELECT name, kind, sightings, first_ordinal AS firstOrdinal, seeded, selected
      FROM local_foundation_entities WHERE run_id = ? ORDER BY seeded DESC, sightings DESC, first_ordinal, name`).all(runId) as Entity[];
  }
  result(runId: string): LocalFoundationResult {
    const run = this.check(runId);
    const { db } = this.store.get();
    const state = db.prepare('SELECT output_path AS outputPath FROM local_foundation_runs WHERE run_id = ?').get(runId) as { outputPath: string | null } | undefined;
    const counts = db.prepare('SELECT COUNT(*) AS n FROM local_foundation_evidence WHERE run_id = ?').get(runId) as { n: number };
    const characters = db.prepare(`SELECT e.name, COUNT(v.paragraph_id) AS mentions, e.first_ordinal AS firstOrdinal
      FROM local_foundation_entities e JOIN local_foundation_evidence v ON v.run_id = e.run_id AND v.name = e.name
      WHERE e.run_id = ? AND e.kind = 'person' AND e.selected = 1
      AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = v.paragraph_id AND x.excluded = 1)
      GROUP BY e.name ORDER BY mentions DESC, e.name`).all(runId) as LocalFoundationResult['characters'];
    const chapters = db.prepare('SELECT title, paragraph_end AS endOrdinal FROM chapters WHERE revision_id = ? ORDER BY ordinal').all(run.revisionId) as LocalFoundationResult['chapters'];
    const summary = run.steps.find(step => step.stepKey === 'summary')?.outputJson;
    const integrated = Boolean(summary && JSON.parse(summary).pipelineVersion === 'local-pipeline.v2');
    return { runId, candidateCount: this.entities(runId).length, evidenceCount: counts.n, characters, chapters, outputPath: state?.outputPath ?? null, integrated };
  }

  async export(runId: string, entryOrdinal?: number): Promise<LocalFoundationExportResult> {
    const run = this.check(runId);
    const { db, rootPath } = this.store.get();
    const state = db.prepare('SELECT phase FROM local_foundation_runs WHERE run_id = ?').get(runId) as { phase: string } | undefined;
    if (!state || !['export', 'done'].includes(state.phase)) throw new Error('请等待本地索引完成后再导出');
    const max = db.prepare('SELECT MAX(ordinal) AS n FROM paragraphs WHERE revision_id = ?').get(run.revisionId) as { n: number };
    const cutoff = entryOrdinal ?? max.n;
    if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > max.n) throw new Error('入口段落不在本书范围内');
    const filtered = entryOrdinal !== undefined;
    const outputPath = path.join(rootPath, 'exports', `local-${runId}`, `${filtered ? `入口-${cutoff}` : '全书资料草稿'}-${randomUUID().slice(0, 8)}`);
    const staging = outputPath + '.writing';
    const exportRoot = path.resolve(rootPath, 'exports');
    for (const target of [outputPath, staging]) {
      const relative = path.relative(exportRoot, path.resolve(target));
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('导出目录必须位于当前工程 exports 内');
    }
    await mkdir(path.join(staging, '角色卡'), { recursive: true });
    const entities = this.entities(runId).filter(e => e.selected && e.firstOrdinal <= cutoff
      && db.prepare(`SELECT 1 FROM local_foundation_evidence v WHERE v.run_id = ? AND v.name = ? AND v.ordinal <= ?
        AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = v.paragraph_id AND x.excluded = 1) LIMIT 1`).get(runId, e.name, cutoff));
    const people = entities.filter(e => e.kind === 'person');
    if (!filtered && !people.length) throw new Error('未在原文中找到选中的人物。请检查补充姓名，并点“按当前设置重新生成”');
    const snippets = (name: string, limit: number) => {
      // Filter source positions BEFORE ranking or summarizing.
      const rows = db.prepare(`SELECT v.paragraph_id AS paragraphId, v.ordinal, v.start_offset AS start, v.end_offset AS end, p.text
        FROM local_foundation_evidence v JOIN paragraphs p ON p.id = v.paragraph_id
        WHERE v.run_id = ? AND v.name = ? AND v.ordinal <= ?
        AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = p.id AND x.excluded = 1)
        ORDER BY v.score DESC, v.ordinal LIMIT ?`).all(runId, name, cutoff, limit) as Array<{ paragraphId: string; ordinal: number; start: number; end: number; text: string }>;
      const seen = new Set<string>();
      return rows.sort((a, b) => a.ordinal - b.ordinal).flatMap(r => {
        const text = r.text.slice(r.start, r.end);
        if (seen.has(text)) return []; seen.add(text);
        return [{ paragraphId: r.paragraphId, ordinal: r.ordinal, start: r.start, end: r.end, text }];
      });
    };
    const entries: TavernCharacterBook['entries'] = [];
    const guard = '本地脚本草稿，仅依据原文提及生成。片段中的引语、猜测、否定与同场人物不可直接当成该角色的事实或记忆。未说明的性格、关系和能力保持未知。';
    const scope = filtered ? `入口为原文第 ${cutoff} 段；只包含此前文本。段落顺序不是绝对故事时间，倒叙、预言和角色知情范围仍需人工复核。` : '全书资料草稿，可能包含后续剧情；游玩前请按章节入口另行导出并复核。';
    for (let i = 0; i < people.length; i++) {
      const person = people[i], evidence = snippets(person.name, 8);
      if (!evidence.length) continue;
      const description = `姓名候选：${person.name}\n${guard}\n${scope}\n原文提及：\n` + evidence.map(e => `【第 ${e.ordinal} 段】${e.text}`).join('\n');
      const card: TavernCardV2 = { spec: 'chara_card_v2', spec_version: '2.0', data: {
        name: person.name, description, personality: '', scenario: scope, first_mes: '', mes_example: '',
        creator_notes: `${guard}\n${scope}`, system_prompt: '', post_history_instructions: '', alternate_greetings: [],
        tags: ['本地脚本', '待复核草稿'], creator: '小说世界', character_version: VERSION,
        extensions: { novel_world_local: { runId, revisionId: run.revisionId, entryOrdinal: cutoff, reviewStatus: 'pending', evidence } },
      } };
      tavernCardV2Schema.parse(card);
      await writeFile(path.join(staging, '角色卡', `${String(i + 1).padStart(3, '0')}-${person.name}.json`), JSON.stringify(card, null, 2), 'utf8');
    }
    for (const entity of entities) {
      const evidence = snippets(entity.name, entity.kind === 'person' ? 2 : 3);
      if (!evidence.length) continue;
      entries.push({ id: entries.length + 1, name: entity.name, keys: [entity.name], enabled: true, insertion_order: entries.length,
        constant: false, case_sensitive: false, selective: false, position: 'before_char',
        content: `【原文片段／待复核：${entity.name}】\n` + evidence.map(e => `第 ${e.ordinal} 段：${e.text}`).join('\n'),
        extensions: { novel_world_local: { kind: entity.kind, reviewStatus: 'pending', evidence, entryOrdinal: cutoff } } });
    }
    const worldbook: TavernCharacterBook = { name: `本地世界书-${filtered ? `入口${cutoff}` : '全书'}`, description: `${guard}\n${scope}`,
      scan_depth: 2, token_budget: 1600, recursive_scanning: false, extensions: { novel_world_local: { version: VERSION, runId, entryOrdinal: cutoff } }, entries };
    tavernCharacterBookSchema.parse(worldbook);
    const rows = db.prepare(`SELECT a.name AS source, b.name AS target, COUNT(*) AS count, MIN(a.ordinal) AS firstOrdinal
      FROM local_foundation_evidence a JOIN local_foundation_evidence b
      ON a.run_id = b.run_id AND a.paragraph_id = b.paragraph_id AND a.name < b.name
      JOIN local_foundation_entities ea ON ea.run_id = a.run_id AND ea.name = a.name
      JOIN local_foundation_entities eb ON eb.run_id = b.run_id AND eb.name = b.name
      WHERE a.run_id = ? AND a.ordinal <= ? AND ea.kind = 'person' AND eb.kind = 'person'
      AND NOT EXISTS (SELECT 1 FROM paragraph_exclusions x WHERE x.paragraph_id = a.paragraph_id AND x.excluded = 1)
      GROUP BY a.name, b.name ORDER BY count DESC, source, target`).all(runId, cutoff) as Array<{ source: string; target: string; count: number; firstOrdinal: number }>;
    const graph = { kind: 'co-occurrence-only', warning: '同段提及，仅表示原文共现，不代表确定的人物关系', nodes: people.map(p => ({ id: p.name })), edges: rows };
    const escapeHtml = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const graphData = JSON.stringify(graph).replace(/</g, '\\u003c');
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>本地生成草稿</title>
<style>body{font:16px/1.7 system-ui;margin:30px auto;padding:0 20px;max-width:1100px;background:#f4f2ed;color:#252a31}section{background:white;border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}a{color:#235e90}select{font:inherit;padding:6px}svg{width:100%;max-height:520px}pre{white-space:pre-wrap}small{color:#667}details{border-top:1px solid #ddd;padding:12px 0}svg text{font:14px system-ui}svg line{stroke:#aab3be;stroke-dasharray:5 5}svg circle{fill:#edf1f5;stroke:#73859a}</style>
<h1>极低档 · 本地生成草稿</h1><p>${escapeHtml(scope)}</p><p>${escapeHtml(guard)}</p>
<section><h2>角色卡</h2><p>角色卡在“角色卡”文件夹中。卡与世界书分开导出。</p>${people.map((person, i) => `<details><summary>${escapeHtml(person.name)}</summary><a href="角色卡/${String(i + 1).padStart(3, '0')}-${encodeURIComponent(person.name)}.json">打开角色卡 JSON</a><pre>${escapeHtml(snippets(person.name, 8).map(e => `【第 ${e.ordinal} 段】${e.text}`).join('\n'))}</pre></details>`).join('')}</section>
<section><h2>人物共现图</h2><p>虚线仅表示同段提及，数字为共现段落数。选择人物后显示其最常共现的最多 20 人。</p><select id="person"></select><svg id="graph" viewBox="0 0 1000 520" role="img" aria-label="人物共现图"></svg></section>
<section><h2>世界书</h2><a href="世界书.json">打开独立世界书 JSON</a>${entries.map(e => `<details><summary>${escapeHtml(e.name ?? '')}</summary><pre>${escapeHtml(e.content)}</pre></details>`).join('')}</section>
<script>const data=${graphData};const select=document.getElementById('person');const svg=document.getElementById('graph');const ns='http://www.w3.org/2000/svg';
for(const node of data.nodes){const option=document.createElement('option');option.textContent=node.id;option.value=node.id;select.append(option)}
function element(tag,attrs,text){const el=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attrs))el.setAttribute(key,String(value));if(text!==undefined)el.textContent=text;svg.append(el);return el}
function draw(){svg.replaceChildren();const center=select.value;if(!center)return;const edges=data.edges.filter(e=>e.source===center||e.target===center).slice(0,20);edges.forEach((edge,i)=>{const angle=2*Math.PI*i/Math.max(1,edges.length);const x=500+390*Math.cos(angle),y=260+200*Math.sin(angle);element('line',{x1:500,y1:260,x2:x,y2:y});element('text',{x:(500+x)/2,y:(260+y)/2},edge.count);element('circle',{cx:x,cy:y,r:24});element('text',{x,y:y+5,'text-anchor':'middle'},edge.source===center?edge.target:edge.source)});element('circle',{cx:500,cy:260,r:40});element('text',{x:500,y:265,'text-anchor':'middle'},center)}select.onchange=draw;draw();</script></html>`;
    await writeFile(path.join(staging, '查看草稿.html'), html, 'utf8');
    await writeFile(path.join(staging, '世界书.json'), JSON.stringify(worldbook, null, 2), 'utf8');
    await writeFile(path.join(staging, '人物共现图.json'), JSON.stringify(graph, null, 2), 'utf8');
    // All-book candidate lists must never accompany a time-filtered runtime export.
    if (!filtered) await writeFile(path.join(staging, '候选清单.json'), JSON.stringify(this.entities(runId), null, 2), 'utf8');
    const manifest = { version: VERSION, runId, revisionId: run.revisionId, entryOrdinal: cutoff, scope: filtered ? 'paragraph-prefix' : 'whole-book',
      apiRequests: 0, apiTokens: 0, reviewStatus: 'pending', characterCount: entries.filter(e => (e.extensions.novel_world_local as { kind: string }).kind === 'person').length,
      worldEntryCount: entries.length, edgeCount: rows.length, createdAt: new Date().toISOString() };
    await writeFile(path.join(staging, '生成记录.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await writeFile(path.join(staging, '使用说明.txt'), `${guard}\n${scope}\n\n角色卡与世界书分开导出，可导入兼容 Character Card V2 的工具。世界书按姓名或术语关键词触发。\n极低档不生成经确认的时间事件、地理地图或语义关系；共现图仅用于查看人物同场线索。\n生成过程 API 请求与 Token 均为 0；之后使用 AI 对话仍会产生模型费用。\n`, 'utf8');
    // Target is derived solely from a validated run UUID and numeric cutoff within this project.
    await rename(staging, outputPath);
    return { outputPath, characterCount: manifest.characterCount, worldEntryCount: entries.length, edgeCount: rows.length };
  }
}
