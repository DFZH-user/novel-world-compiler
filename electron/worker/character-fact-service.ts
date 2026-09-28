import { createHash, randomUUID } from 'node:crypto';
import type {
  CharacterFactEstimate,
  CharacterFactEvidenceRecord,
  CharacterFactOutput,
  CharacterFactRecord,
  CharacterFactWorkItem,
  CharacterScanStart,
  JobRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';

function now(): string { return new Date().toISOString(); }
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function normalizedQuote(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type MaterialParagraph = { paragraphId: string; ordinal: number; chapterTitle: string | null; text: string };
type FactRun = {
  id: string; jobId: string; revisionId: string; identityId: string; identityName: string;
  model: string; promptVersion: string; totalBatches: number; extractionPasses: 1 | 2;
  inputMode: CharacterFactWorkItem['inputMode']; draftSelectionRunId: string | null;
};

const TARGET_BATCH_CHARACTERS = 6_000;
const MAX_BATCH_CHARACTERS = 10_000;

function buildBatches(paragraphs: MaterialParagraph[], targetChars = TARGET_BATCH_CHARACTERS, maxParagraphs = 240): MaterialParagraph[][] {
  const batches: MaterialParagraph[][] = [];
  let current: MaterialParagraph[] = [];
  let characters = 0;
  for (const paragraph of paragraphs) {
    if (current.length && (characters + paragraph.text.length > targetChars || current.length >= maxParagraphs)) {
      batches.push(current); current = []; characters = 0;
    }
    if (paragraph.text.length > MAX_BATCH_CHARACTERS && !current.length) {
      batches.push([paragraph]);
      continue;
    }
    current.push(paragraph); characters += paragraph.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export class CharacterFactService {
  constructor(private readonly store: ProjectStore) {}

  estimate(identityId: string): CharacterFactEstimate {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const material = this.collectMaterial(db, revisionId, identityId);
    const characterCount = material.reduce((sum, paragraph) => sum + paragraph.text.length, 0);
    return {
      identityId,
      paragraphCount: material.length,
      characterCount,
      batchCount: buildBatches(material).length,
      approximateInputTokens: Math.ceil(characterCount / 1.7),
      ready: material.length > 0,
    };
  }

  createRun(identityId: string, modelInput: string, promptVersionInput: string, extractionPassesInput: 1 | 2 = 1): CharacterScanStart {
    return this.createRunWithAccess(identityId, modelInput, promptVersionInput, extractionPassesInput, null);
  }

  createDraftRun(
    selectionRunId: string,
    identityId: string,
    modelInput: string,
    promptVersionInput: string,
    extractionPassesInput: 1 | 2 = 1,
  ): CharacterScanStart {
    return this.createRunWithAccess(identityId, modelInput, promptVersionInput, extractionPassesInput, { selectionRunId });
  }

  private createRunWithAccess(
    identityId: string,
    modelInput: string,
    promptVersionInput: string,
    extractionPassesInput: 1 | 2,
    draftAccess: { selectionRunId: string } | null,
  ): CharacterScanStart {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const identity = db.prepare(`SELECT id, canonical_name AS name, review_status AS reviewStatus FROM person_identities
      WHERE id = ? AND revision_id = ?`).get(identityId, revisionId) as { id: string; name: string; reviewStatus: string } | undefined;
    if (!identity) throw new Error('找不到要提取档案的人物');

    let inputMode: CharacterFactWorkItem['inputMode'] = 'human-confirmed';
    let draftSelectionRunId: string | null = null;
    let draftSelectionInputHash: string | null = null;
    let draftSelectionItemHash: string | null = null;
    if (!draftAccess) {
      if (identity.reviewStatus !== 'confirmed') throw new Error('请先确认人物身份，再提取人物档案');
    } else {
      const access = db.prepare(`SELECT s.id, s.input_hash AS selectionInputHash, si.input_hash AS itemInputHash
        FROM automation_draft_selection_runs s
        JOIN automation_draft_selection_items si ON si.run_id = s.id
        WHERE s.id = ? AND s.project_id = ? AND s.revision_id = ? AND s.state = 'completed'
          AND si.identity_id = ? AND si.status = 'completed' AND si.selected = 1`)
        .get(draftAccess.selectionRunId, projectId, revisionId, identityId) as
        { id: string; selectionInputHash: string; itemInputHash: string } | undefined;
      if (!access) throw new Error('该人物不在已完成的自动草稿选择集合中');
      if (identity.reviewStatus === 'rejected') throw new Error('该人物已被用户排除，自动流程不能继续提取');
      inputMode = 'automation-draft-selection';
      draftSelectionRunId = access.id;
      draftSelectionInputHash = access.selectionInputHash;
      draftSelectionItemHash = access.itemInputHash;
    }

    const model = modelInput.trim().slice(0, 100);
    const promptVersion = promptVersionInput.trim().slice(0, 100);
    const extractionPasses: 1 | 2 = extractionPassesInput === 2 ? 2 : 1;
    if (!model || !promptVersion) throw new Error('模型和提示词版本不能为空');
    const material = this.collectMaterial(db, revisionId, identityId);
    const batches = buildBatches(material);
    if (!batches.length) throw new Error('这个人物没有可用于档案提取的原文材料');
    const inputHash = hash(JSON.stringify({
      revisionId,
      identityId,
      model,
      promptVersion,
      extractionPasses,
      targetCharacters: TARGET_BATCH_CHARACTERS,
      inputMode,
      draftSelectionRunId,
      draftSelectionInputHash,
      draftSelectionItemHash,
      material: material.map((item) => [item.paragraphId, hash(item.text)]),
    }));
    const existing = db.prepare(`SELECT r.id, r.job_id AS jobId, j.state FROM character_fact_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.project_id = ? AND r.revision_id = ? AND r.identity_id = ? AND r.model = ? AND r.prompt_version = ? AND r.input_hash = ?`)
      .get(projectId, revisionId, identityId, model, promptVersion, inputHash) as { id: string; jobId: string; state: JobRecord['state'] } | undefined;
    if (existing) {
      if (existing.state !== 'completed' && existing.state !== 'running') {
        withTransaction(db, () => {
          db.prepare(`UPDATE character_fact_batches SET status = 'pending', error = NULL, updated_at = ?
            WHERE run_id = ? AND status IN ('running','failed')`).run(now(), existing.id);
          db.prepare(`UPDATE jobs SET state = 'running', message = '正在恢复人物档案提取', updated_at = ? WHERE id = ?`).run(now(), existing.jobId);
          db.prepare(`UPDATE character_fact_runs SET status = 'running', updated_at = ? WHERE id = ?`).run(now(), existing.id);
          if (existing.state !== 'paused') {
            const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?').get(existing.jobId) as { value: number };
            db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, ?, ?, 'running')`)
              .run(randomUUID(), existing.jobId, Number(attempt.value), now());
          }
        });
      }
      return { jobId: existing.jobId, runId: existing.id, state: existing.state === 'completed' ? 'completed' : 'running', reused: true };
    }

    const jobId = randomUUID();
    const runId = randomUUID();
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO jobs
        (id, project_id, type, state, progress, message, input_json, input_hash, lease_owner, lease_expires_at, created_at, updated_at)
        VALUES (?, ?, 'character-facts', 'running', 0, ?, ?, ?, ?, ?, ?, ?)`)
        .run(jobId, projectId, '正在准备“' + identity.name + '”的人物档案',
          JSON.stringify({ runId, identityId, model, promptVersion, inputMode, draftSelectionRunId }), inputHash,
          process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp);
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, 1, ?, 'running')`)
        .run(randomUUID(), jobId, timestamp);
      db.prepare(`INSERT INTO character_fact_runs
        (id, project_id, revision_id, identity_id, job_id, model, prompt_version, input_hash, status, total_batches,
         input_mode, draft_selection_run_id, draft_selection_item_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`)
        .run(runId, projectId, revisionId, identityId, jobId, model, promptVersion, inputHash, batches.length,
          inputMode, draftSelectionRunId, draftSelectionItemHash, timestamp, timestamp);
      db.prepare(`INSERT INTO character_fact_run_options (run_id, extraction_passes, target_characters, created_at) VALUES (?, ?, ?, ?)`)
        .run(runId, extractionPasses, TARGET_BATCH_CHARACTERS, timestamp);
      const insert = db.prepare(`INSERT INTO character_fact_batches
        (run_id, batch_ordinal, paragraph_ids_json, input_hash, status, updated_at) VALUES (?, ?, ?, ?, 'pending', ?)`);
      batches.forEach((batch, index) => insert.run(runId, index + 1,
        JSON.stringify(batch.map((item) => item.paragraphId)), hash(inputHash + ':' + (index + 1)), timestamp));
    });
    return { jobId, runId, state: 'running', reused: false };
  }
  nextBatch(jobId: string): CharacterFactWorkItem | null {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return null;
    const batch = db.prepare(`SELECT batch_ordinal AS ordinal, paragraph_ids_json AS paragraphIds FROM character_fact_batches
      WHERE run_id = ? AND status = 'pending' ORDER BY batch_ordinal LIMIT 1`).get(run.id) as { ordinal: number; paragraphIds: string } | undefined;
    if (!batch) { this.finishIfDone(db, run); return null; }
    db.prepare(`UPDATE character_fact_batches SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE run_id = ? AND batch_ordinal = ?`)
      .run(now(), run.id, batch.ordinal);
    const ids = JSON.parse(batch.paragraphIds) as string[];
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT p.id AS paragraphId, p.ordinal, c.title AS chapterTitle, p.text
      FROM paragraphs p LEFT JOIN chapters c ON c.id = p.chapter_id WHERE p.id IN (${placeholders}) ORDER BY p.ordinal`)
      .all(...ids) as MaterialParagraph[];
    return {
      jobId, runId: run.id, identityId: run.identityId, identityName: run.identityName,
      batchOrdinal: Number(batch.ordinal), model: run.model, promptVersion: run.promptVersion,
      extractionPasses: run.extractionPasses, inputMode: run.inputMode,
      draftSelectionRunId: run.draftSelectionRunId, paragraphs: rows,
    };
  }

  ingest(jobId: string, batchOrdinal: number, output: CharacterFactOutput, rawJson: string, inputTokens: number, outputTokens: number): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (job?.state === 'cancelled') return this.jobProgress(db, jobId);
    const batch = db.prepare(`SELECT status, paragraph_ids_json AS paragraphIds FROM character_fact_batches
      WHERE run_id = ? AND batch_ordinal = ?`).get(run.id, batchOrdinal) as { status: string; paragraphIds: string } | undefined;
    if (!batch) throw new Error('找不到人物档案材料批次');
    if (batch.status === 'completed') return this.jobProgress(db, jobId);
    const ids = JSON.parse(batch.paragraphIds) as string[];
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, ordinal, text FROM paragraphs WHERE id IN (${placeholders})`).all(...ids) as Array<{ id: string; ordinal: number; text: string }>;
    const paragraphs = new Map(rows.map((row) => [row.id, row]));
    const timestamp = now();
    withTransaction(db, () => {
      for (const fact of output.facts) {
        const aligned = fact.evidence.flatMap((evidence) => {
          const paragraph = paragraphs.get(evidence.paragraph_id);
          if (!paragraph) return [];
          const status = paragraph.text.includes(evidence.exact_quote) ? 'exact' as const
            : normalizedQuote(paragraph.text).includes(normalizedQuote(evidence.exact_quote)) ? 'normalized' as const : null;
          return status ? [{ evidence, paragraph, status }] : [];
        });
        if (!aligned.some((item) => item.evidence.role === 'support')) continue;
        const from = fact.valid_from_paragraph_id ? paragraphs.get(fact.valid_from_paragraph_id)?.ordinal ?? null : null;
        const to = fact.valid_to_paragraph_id ? paragraphs.get(fact.valid_to_paragraph_id)?.ordinal ?? null : null;
        const validFrom = from !== null && to !== null && from > to ? to : from;
        const validTo = from !== null && to !== null && from > to ? from : to;
        const existing = db.prepare(`SELECT id FROM character_facts WHERE identity_id = ? AND category = ? AND predicate = ? AND value = ?
          AND source_type = ? AND COALESCE(valid_from_ordinal, -1) = COALESCE(?, -1) AND COALESCE(valid_to_ordinal, -1) = COALESCE(?, -1) LIMIT 1`)
          .get(run.identityId, fact.category, fact.predicate, fact.value, fact.source_type, validFrom, validTo) as { id: string } | undefined;
        const factId = existing?.id ?? `cf_${hash(`${run.identityId}:${fact.category}:${fact.predicate}:${fact.value}:${fact.source_type}:${validFrom}:${validTo}`).slice(0, 32)}`;
        if (!existing) {
          db.prepare(`INSERT INTO character_facts
            (id, revision_id, identity_id, run_id, batch_ordinal, category, predicate, value, source_type, confidence,
             visibility, valid_from_ordinal, valid_to_ordinal, reasoning_note, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(factId, run.revisionId, run.identityId, run.id, batchOrdinal, fact.category, fact.predicate, fact.value,
              fact.source_type, fact.confidence, fact.visibility, validFrom, validTo, fact.reasoning_note, timestamp, timestamp);
        }
        const assertionMode = fact.assertion_mode ?? (fact.source_type === 'inferred' ? 'behavior_inference' : 'narrator_assertion');
        const truthStatus = fact.truth_status ?? 'asserted';
        db.prepare(`INSERT OR IGNORE INTO character_fact_claim_metadata
          (fact_id, assertion_mode, truth_status, attributed_source_name, extraction_pass, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(factId, assertionMode, truthStatus, fact.attributed_source_name ?? null,
            fact.extraction_pass === 2 ? 2 : 1, timestamp, timestamp);
        for (const item of aligned) {
          const evidenceId = `cfe_${hash(`${factId}:${item.evidence.paragraph_id}:${item.evidence.exact_quote}:${item.evidence.role}`).slice(0, 32)}`;
          db.prepare(`INSERT OR IGNORE INTO character_fact_evidence
            (id, fact_id, paragraph_id, exact_quote, evidence_role, alignment_status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(evidenceId, factId, item.evidence.paragraph_id, item.evidence.exact_quote, item.evidence.role, item.status, timestamp);
        }
      }
      db.prepare(`UPDATE character_fact_batches SET status = 'completed', raw_json = ?, error = NULL, input_tokens = ?, output_tokens = ?, updated_at = ?
        WHERE run_id = ? AND batch_ordinal = ?`).run(rawJson, Math.max(0, inputTokens), Math.max(0, outputTokens), timestamp, run.id, batchOrdinal);
      this.updateProgress(db, run, timestamp);
    });
    return this.jobProgress(db, jobId);
  }

  recordError(jobId: string, batchOrdinal: number, message: string, terminal: boolean): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRun(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (job?.state === 'cancelled') return this.jobProgress(db, jobId);
    db.prepare(`UPDATE character_fact_batches SET status = ?, error = ?, updated_at = ? WHERE run_id = ? AND batch_ordinal = ?`)
      .run(terminal ? 'failed' : 'pending', message.slice(0, 2000), now(), run.id, batchOrdinal);
    if (terminal) {
      const clean = message.slice(0, 2000);
      const timestamp = now();
      const completed = db.prepare(`SELECT COUNT(*) AS value FROM character_fact_batches WHERE run_id = ? AND status = 'completed'`)
        .get(run.id) as { value: number };
      db.prepare(`UPDATE character_fact_runs SET status = 'failed', completed_batches = ?, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value), timestamp, run.id);
      db.prepare(`UPDATE jobs SET state = 'failed', progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value) / Math.max(run.totalBatches, 1), `人物档案已停止：${clean}。可在任务中心重试`, timestamp, run.jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'running'`)
        .run(timestamp, clean, run.jobId);
    }
    return this.jobProgress(db, jobId);
  }

  listFacts(identityId: string): CharacterFactRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT f.id, f.identity_id AS identityId, f.category, f.predicate, f.value,
      f.source_type AS sourceType, f.confidence, f.visibility, f.valid_from_ordinal AS validFromOrdinal,
      f.valid_to_ordinal AS validToOrdinal, f.review_status AS reviewStatus, f.reasoning_note AS reasoningNote,
      COALESCE(m.assertion_mode, CASE WHEN f.source_type = 'inferred' THEN 'behavior_inference' ELSE 'narrator_assertion' END) AS assertionMode,
      COALESCE(m.truth_status, 'asserted') AS truthStatus, m.attributed_source_name AS attributedSourceName,
      COALESCE(m.extraction_pass, 1) AS extractionPass,
      COUNT(e.id) AS evidenceCount FROM character_facts f LEFT JOIN character_fact_evidence e ON e.fact_id = f.id
      LEFT JOIN character_fact_claim_metadata m ON m.fact_id = f.id
      WHERE f.identity_id = ? AND f.revision_id = ? GROUP BY f.id
      ORDER BY f.review_status = 'rejected', f.category, f.valid_from_ordinal, f.confidence DESC`)
      .all(identityId, revisionId) as unknown as CharacterFactRecord[];
  }

  listEvidence(factId: string): CharacterFactEvidenceRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT e.id, e.source_span_id AS sourceSpanId,
      e.fact_id AS factId, e.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal,
      c.title AS chapterTitle, e.exact_quote AS exactQuote, e.evidence_role AS evidenceRole, e.alignment_status AS alignmentStatus
      FROM character_fact_evidence e JOIN character_facts f ON f.id = e.fact_id JOIN paragraphs p ON p.id = e.paragraph_id
      LEFT JOIN chapters c ON c.id = p.chapter_id WHERE e.fact_id = ? AND f.revision_id = ? ORDER BY p.ordinal`)
      .all(factId, revisionId) as unknown as CharacterFactEvidenceRecord[];
  }

  reviewFact(factId: string, status: CharacterFactRecord['reviewStatus']): CharacterFactRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const fact = db.prepare(`SELECT id, identity_id AS identityId FROM character_facts WHERE id = ? AND revision_id = ?`)
      .get(factId, revisionId) as { id: string; identityId: string } | undefined;
    if (!fact) throw new Error('找不到人物事实');
    db.prepare('UPDATE character_facts SET review_status = ?, updated_at = ? WHERE id = ?').run(status, now(), factId);
    return this.listFacts(fact.identityId);
  }

  private collectMaterial(db: SQLiteDatabase, revisionId: string, identityId: string): MaterialParagraph[] {
    const identity = db.prepare(`SELECT canonical_name AS name, review_status AS reviewStatus FROM person_identities WHERE id = ? AND revision_id = ?`)
      .get(identityId, revisionId) as { name: string; reviewStatus: string } | undefined;
    if (!identity) throw new Error('找不到人物');
    const ordinals = new Set<number>();
    const mentions = db.prepare(`SELECT DISTINCT p.ordinal FROM person_mentions m JOIN paragraphs p ON p.id = m.paragraph_id
      WHERE m.identity_id = ? ORDER BY p.ordinal`).all(identityId) as Array<{ ordinal: number }>;
    for (const mention of mentions) { ordinals.add(Number(mention.ordinal) - 1); ordinals.add(Number(mention.ordinal)); ordinals.add(Number(mention.ordinal) + 1); }
    const names = [identity.name, ...(db.prepare(`SELECT DISTINCT alias FROM person_aliases WHERE identity_id = ? AND review_status = 'confirmed'`)
      .all(identityId) as Array<{ alias: string }>).map((row) => row.alias)];
    for (const name of [...new Set(names)].filter(Boolean)) {
      const hits = db.prepare(`SELECT p.ordinal FROM paragraphs p LEFT JOIN paragraph_exclusions x ON x.paragraph_id = p.id
        WHERE p.revision_id = ? AND COALESCE(x.excluded, 0) = 0 AND instr(p.text, ?) > 0 ORDER BY p.ordinal`)
        .all(revisionId, name) as Array<{ ordinal: number }>;
      for (const hit of hits) { ordinals.add(Number(hit.ordinal) - 1); ordinals.add(Number(hit.ordinal)); ordinals.add(Number(hit.ordinal) + 1); }
    }
    const values = [...ordinals].filter((ordinal) => ordinal > 0).sort((a, b) => a - b);
    if (!values.length) return [];
    const rows: MaterialParagraph[] = [];
    for (let start = 0; start < values.length; start += 500) {
      const slice = values.slice(start, start + 500);
      const placeholders = slice.map(() => '?').join(',');
      rows.push(...db.prepare(`SELECT p.id AS paragraphId, p.ordinal, c.title AS chapterTitle, p.text
        FROM paragraphs p LEFT JOIN chapters c ON c.id = p.chapter_id LEFT JOIN paragraph_exclusions x ON x.paragraph_id = p.id
        WHERE p.revision_id = ? AND COALESCE(x.excluded, 0) = 0 AND p.ordinal IN (${placeholders}) ORDER BY p.ordinal`)
        .all(revisionId, ...slice) as MaterialParagraph[]);
    }
    return rows.sort((a, b) => Number(a.ordinal) - Number(b.ordinal));
  }

  private getRun(db: SQLiteDatabase, projectId: string, jobId: string): FactRun {
    const row = db.prepare(`SELECT r.id, r.job_id AS jobId, r.revision_id AS revisionId, r.identity_id AS identityId,
      i.canonical_name AS identityName, r.model, r.prompt_version AS promptVersion, r.total_batches AS totalBatches,
      COALESCE(o.extraction_passes, 1) AS extractionPasses, r.input_mode AS inputMode,
      r.draft_selection_run_id AS draftSelectionRunId
      FROM character_fact_runs r JOIN person_identities i ON i.id = r.identity_id
      LEFT JOIN character_fact_run_options o ON o.run_id = r.id WHERE r.job_id = ? AND r.project_id = ?`)
      .get(jobId, projectId) as FactRun | undefined;
    if (!row) throw new Error('找不到人物档案任务');
    return row;
  }

  private updateProgress(db: SQLiteDatabase, run: FactRun, timestamp: string): void {
    const counts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM character_fact_batches WHERE run_id = ?`).get(run.id) as { total: number; completed: number; inputTokens: number; outputTokens: number };
    const progress = Number(counts.completed) / Math.max(Number(counts.total), 1);
    db.prepare(`UPDATE character_fact_runs SET completed_batches = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?`)
      .run(Number(counts.completed), Number(counts.inputTokens), Number(counts.outputTokens), timestamp, run.id);
    db.prepare(`UPDATE jobs SET progress = ?, message = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(progress, `人物档案：已完成 ${Number(counts.completed)}/${Number(counts.total)} 批材料`, new Date(Date.now() + 60_000).toISOString(), timestamp, run.jobId);
  }

  private finishIfDone(db: SQLiteDatabase, run: FactRun): void {
    const counts = db.prepare(`SELECT SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END) AS remaining,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM character_fact_batches WHERE run_id = ?`).get(run.id) as { remaining: number; failed: number; completed: number };
    if (Number(counts.remaining) > 0) return;
    const timestamp = now(); const failed = Number(counts.failed); const state = failed ? 'failed' : 'completed';
    db.prepare(`UPDATE character_fact_runs SET status = ?, completed_batches = ?, updated_at = ? WHERE id = ?`).run(state, Number(counts.completed), timestamp, run.id);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(state, failed ? Number(counts.completed) / Math.max(run.totalBatches, 1) : 1,
        failed ? `人物档案有 ${failed} 批材料失败，可重试` : `“${run.identityName}”的人物事实已提取，等待审核`, timestamp, run.jobId);
    db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`).run(state, timestamp, run.jobId);
  }

  private jobProgress(db: SQLiteDatabase, jobId: string): { state: JobRecord['state']; progress: number } {
    const row = db.prepare('SELECT state, progress FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state']; progress: number } | undefined;
    if (!row) throw new Error('找不到人物档案任务');
    return { state: row.state, progress: Number(row.progress) };
  }
}
