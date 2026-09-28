import { createHash, randomUUID } from 'node:crypto';
import type {
  CharacterCandidate,
  CharacterAliasRecord,
  CharacterIdentityLinkRecord,
  CharacterMentionRecord,
  CharacterScanEstimate,
  CharacterScanOutput,
  CharacterScanStart,
  CharacterScanWorkItem,
  JobRecord,
  IdentityOperationRecord,
} from '../../src/shared/contracts';
import type { ProjectStore } from './project-store';
import type { SQLiteDatabase } from './sqlite-db';
import { withTransaction } from './db-utils';
import {
  calculateCharacterLiteralMetrics,
  CHARACTER_LITERAL_METRICS_VERSION,
  characterLiteralMetricsVersionKey,
} from './character-literal-metrics';

function now(): string {
  return new Date().toISOString();
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().replace(/[\s·•・.。，“”‘’'"《》〈〉【】\[\]()（）]/g, '').toLocaleLowerCase('zh-CN');
}

function normalizedQuote(value: string): string {
  return value.normalize('NFKC').replace(/[\s\u3000]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function activeRevision(db: SQLiteDatabase, projectId: string): string {
  const row = db.prepare('SELECT active_revision_id AS id FROM projects WHERE id = ?').get(projectId) as { id: string | null } | undefined;
  if (!row?.id) throw new Error('请先导入小说');
  return row.id;
}

type RunRow = {
  id: string;
  jobId: string;
  revisionId: string;
  chunkPlanId: string;
  model: string;
  promptVersion: string;
  totalChunks: number;
  completedChunks: number;
  status: string;
};

export class CharacterService {
  constructor(private readonly store: ProjectStore) {}

  estimate(): CharacterScanEstimate {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const plan = db.prepare(`SELECT id FROM chunk_plans WHERE revision_id = ? ORDER BY version DESC LIMIT 1`)
      .get(revisionId) as { id: string } | undefined;
    if (!plan) return { chunkPlanId: null, chunkCount: 0, characterCount: 0, approximateInputTokens: 0, ready: false };
    const totals = db.prepare(`SELECT COUNT(*) AS chunkCount, COALESCE(SUM(character_count), 0) AS characterCount
      FROM chunks WHERE plan_id = ?`).get(plan.id) as { chunkCount: number; characterCount: number };
    return {
      chunkPlanId: plan.id,
      chunkCount: Number(totals.chunkCount),
      characterCount: Number(totals.characterCount),
      approximateInputTokens: Math.ceil(Number(totals.characterCount) / 1.7),
      ready: Number(totals.chunkCount) > 0,
    };
  }

  createScan(modelInput: string, promptVersionInput: string): CharacterScanStart {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const model = modelInput.trim().slice(0, 100);
    const promptVersion = promptVersionInput.trim().slice(0, 100);
    if (!model) throw new Error('模型名称不能为空');
    if (!promptVersion) throw new Error('提示词版本不能为空');
    const plan = db.prepare(`SELECT id, version, settings_json AS settingsJson FROM chunk_plans
      WHERE revision_id = ? ORDER BY version DESC LIMIT 1`).get(revisionId) as { id: string; version: number; settingsJson: string } | undefined;
    if (!plan) throw new Error('请先生成分析分块');
    const chunks = db.prepare(`SELECT id, ordinal, core_start_ordinal AS coreStart, core_end_ordinal AS coreEnd
      FROM chunks WHERE plan_id = ? ORDER BY ordinal`).all(plan.id) as Array<{ id: string; ordinal: number; coreStart: number; coreEnd: number }>;
    if (!chunks.length) throw new Error('当前分块方案没有可分析内容');
    const inputHash = hash(JSON.stringify({ revisionId, planId: plan.id, version: plan.version, settings: plan.settingsJson, model, promptVersion, chunks }));
    const existing = db.prepare(`SELECT r.id, r.job_id AS jobId, r.status, j.state
      FROM character_scan_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.project_id = ? AND r.revision_id = ? AND r.chunk_plan_id = ? AND r.model = ? AND r.prompt_version = ? AND r.input_hash = ?`)
      .get(projectId, revisionId, plan.id, model, promptVersion, inputHash) as { id: string; jobId: string; status: string; state: JobRecord['state'] } | undefined;
    if (existing) {
      if (existing.state !== 'completed' && existing.state !== 'running') {
        withTransaction(db, () => {
          db.prepare(`UPDATE character_chunk_results SET status = 'pending', error = NULL, updated_at = ?
            WHERE run_id = ? AND status IN ('running','failed')`).run(now(), existing.id);
          db.prepare(`UPDATE jobs SET state = 'running', message = '正在恢复人物普查', updated_at = ? WHERE id = ?`).run(now(), existing.jobId);
          db.prepare(`UPDATE character_scan_runs SET status = 'running', updated_at = ? WHERE id = ?`).run(now(), existing.id);
          if (existing.state !== 'paused') {
            const attempt = db.prepare('SELECT COALESCE(MAX(attempt), 0) + 1 AS value FROM job_attempts WHERE job_id = ?')
              .get(existing.jobId) as { value: number };
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
        VALUES (?, ?, 'character-scan', 'running', 0, '正在准备人物普查', ?, ?, ?, ?, ?, ?)`)
        .run(jobId, projectId, JSON.stringify({ runId, model, promptVersion }), inputHash, process.pid.toString(), new Date(Date.now() + 60_000).toISOString(), timestamp, timestamp);
      db.prepare(`INSERT INTO job_attempts (id, job_id, attempt, started_at, state) VALUES (?, ?, 1, ?, 'running')`)
        .run(randomUUID(), jobId, timestamp);
      db.prepare(`INSERT INTO character_scan_runs
        (id, project_id, revision_id, chunk_plan_id, job_id, model, prompt_version, input_hash, status, total_chunks, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`)
        .run(runId, projectId, revisionId, plan.id, jobId, model, promptVersion, inputHash, chunks.length, timestamp, timestamp);
      const insert = db.prepare(`INSERT INTO character_chunk_results (run_id, chunk_id, status, input_hash, updated_at)
        VALUES (?, ?, 'pending', ?, ?)`);
      for (const chunk of chunks) insert.run(runId, chunk.id, hash(`${inputHash}:${chunk.id}`), timestamp);
    });
    return { jobId, runId, state: 'running', reused: false };
  }

  nextChunk(jobId: string): CharacterScanWorkItem | null {
    const { db, projectId } = this.store.get();
    const run = this.getRunByJob(db, projectId, jobId);
    const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (!job || job.state !== 'running') return null;
    const chunk = db.prepare(`SELECT c.id, c.ordinal FROM character_chunk_results r
      JOIN chunks c ON c.id = r.chunk_id WHERE r.run_id = ? AND r.status = 'pending' ORDER BY c.ordinal LIMIT 1`)
      .get(run.id) as { id: string; ordinal: number } | undefined;
    if (!chunk) {
      this.finishIfDone(db, run);
      return null;
    }
    db.prepare(`UPDATE character_chunk_results SET status = 'running', attempts = attempts + 1, updated_at = ?
      WHERE run_id = ? AND chunk_id = ?`).run(now(), run.id, chunk.id);
    const paragraphs = db.prepare(`SELECT p.id AS paragraphId, p.ordinal, ch.title AS chapterTitle, cm.role, p.text
      FROM chunk_members cm JOIN paragraphs p ON p.id = cm.paragraph_id
      LEFT JOIN chapters ch ON ch.id = p.chapter_id
      WHERE cm.chunk_id = ? ORDER BY cm.ordinal_in_chunk`).all(chunk.id) as CharacterScanWorkItem['paragraphs'];
    return {
      jobId,
      runId: run.id,
      chunkId: chunk.id,
      chunkOrdinal: Number(chunk.ordinal),
      model: run.model,
      promptVersion: run.promptVersion,
      paragraphs,
    };
  }

  ingest(jobId: string, chunkId: string, output: CharacterScanOutput, rawJson: string, inputTokens: number, outputTokens: number): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRunByJob(db, projectId, jobId);
    const jobState = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (jobState?.state === 'cancelled') return this.jobProgress(db, jobId);
    const resultRow = db.prepare(`SELECT status FROM character_chunk_results WHERE run_id = ? AND chunk_id = ?`)
      .get(run.id, chunkId) as { status: string } | undefined;
    if (!resultRow) throw new Error('该分块不属于当前人物普查');
    if (resultRow.status === 'completed') return this.jobProgress(db, jobId);

    const paragraphRows = db.prepare(`SELECT p.id, p.text, p.ordinal, p.chapter_id AS chapterId, cm.role
      FROM chunk_members cm JOIN paragraphs p ON p.id = cm.paragraph_id WHERE cm.chunk_id = ?`)
      .all(chunkId) as Array<{ id: string; text: string; ordinal: number; chapterId: string | null; role: string }>;
    const paragraphs = new Map(paragraphRows.map((row) => [row.id, row]));
    const localIdentities = new Map<string, string>();
    const timestamp = now();

    withTransaction(db, () => {
      for (const candidate of output.characters) {
        const aligned = candidate.evidence.flatMap((evidence) => {
          const paragraph = paragraphs.get(evidence.paragraph_id);
          if (!paragraph) return [];
          const status = paragraph.text.includes(evidence.exact_quote)
            ? 'exact' as const
            : normalizedQuote(paragraph.text).includes(normalizedQuote(evidence.exact_quote))
              ? 'normalized' as const
              : null;
          return status ? [{ evidence, paragraph, status }] : [];
        });
        if (!aligned.some((item) => item.paragraph.role === 'core')) continue;
        const normalized = normalizedName(candidate.display_name);
        if (!normalized) continue;
        const forbiddenIdentities = new Set(output.identity_claims
          .filter((claim) => claim.relation === 'different_person' && (claim.left_local_key === candidate.local_key || claim.right_local_key === candidate.local_key))
          .map((claim) => localIdentities.get(claim.left_local_key === candidate.local_key ? claim.right_local_key : claim.left_local_key))
          .filter((id): id is string => Boolean(id)));
        const exactMatches = db.prepare(`SELECT id FROM person_identities WHERE revision_id = ? AND normalized_name = ?
          AND review_status != 'rejected' ORDER BY created_at`).all(run.revisionId, normalized) as Array<{ id: string }>;
        let identity = exactMatches.length === 1 && !forbiddenIdentities.has(exactMatches[0].id) ? exactMatches[0] : undefined;
        if (!identity) {
          const aliasMatches = db.prepare(`SELECT DISTINCT a.identity_id AS id FROM person_aliases a JOIN person_identities i ON i.id = a.identity_id
            WHERE a.revision_id = ? AND a.normalized_alias = ? AND a.review_status = 'confirmed' AND i.review_status != 'rejected'`)
            .all(run.revisionId, normalized) as Array<{ id: string }>;
          if (aliasMatches.length === 1 && !forbiddenIdentities.has(aliasMatches[0].id)) identity = aliasMatches[0];
        }
        if (!identity) {
          identity = { id: randomUUID() };
          db.prepare(`INSERT INTO person_identities
            (id, revision_id, canonical_name, normalized_name, entity_type, uncertainty, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(identity.id, run.revisionId, candidate.display_name, normalized, candidate.entity_kind, candidate.uncertainty, timestamp, timestamp);
        } else {
          db.prepare(`UPDATE person_identities SET entity_type = CASE WHEN entity_type = 'unknown' THEN ? ELSE entity_type END,
            uncertainty = CASE WHEN uncertainty = '' THEN ? ELSE uncertainty END, updated_at = ? WHERE id = ?`)
            .run(candidate.entity_kind, candidate.uncertainty, timestamp, identity.id);
        }
        localIdentities.set(candidate.local_key, identity.id);

        for (const item of aligned) {
          const mentionForm = candidate.mention_forms.find((form) => item.evidence.exact_quote.includes(form.text))
            ?? { text: candidate.display_name, kind: 'name' as const };
          const mentionId = `pm_${hash(`${run.id}:${chunkId}:${identity.id}:${item.evidence.paragraph_id}:${mentionForm.text}:${item.evidence.exact_quote}`).slice(0, 32)}`;
          db.prepare(`INSERT OR IGNORE INTO person_mentions
            (id, revision_id, run_id, chunk_id, identity_id, paragraph_id, surface_text, mention_type, exact_quote, supports,
             has_dialogue, participates_in_event, confidence, alignment_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(mentionId, run.revisionId, run.id, chunkId, identity.id, item.evidence.paragraph_id, mentionForm.text, mentionForm.kind,
              item.evidence.exact_quote, item.evidence.supports, candidate.has_dialogue, candidate.participates_in_event,
              candidate.confidence, item.status, timestamp);

          for (const form of candidate.mention_forms.filter((entry) => entry.kind !== 'pronoun')) {
            if (normalizedName(form.text) === normalized) continue;
            if (!item.paragraph.text.includes(form.text)) continue;
            const aliasId = `pa_${hash(`${identity.id}:${normalizedName(form.text)}:${item.evidence.paragraph_id}`).slice(0, 32)}`;
            db.prepare(`INSERT OR IGNORE INTO person_aliases
              (id, identity_id, revision_id, alias, normalized_alias, alias_type, confidence, review_status, evidence_paragraph_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
              .run(aliasId, identity.id, run.revisionId, form.text, normalizedName(form.text), form.kind, candidate.confidence, item.evidence.paragraph_id, timestamp);
          }
        }
      }

      for (const claim of output.identity_claims) {
        const left = localIdentities.get(claim.left_local_key);
        const right = localIdentities.get(claim.right_local_key);
        if (!left || !right || left === right) continue;
        const relation = claim.relation === 'same_person' ? 'must_link' : claim.relation === 'different_person' ? 'cannot_link' : 'uncertain';
        const [first, second] = [left, right].sort();
        const linkId = `pil_${hash(`${run.revisionId}:${first}:${second}:${relation}:${claim.reason}`).slice(0, 32)}`;
        db.prepare(`INSERT OR IGNORE INTO person_identity_links
          (id, revision_id, left_identity_id, right_identity_id, relation, reason, confidence, evidence_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(linkId, run.revisionId, first, second, relation, claim.reason, claim.confidence, JSON.stringify(claim.evidence_paragraph_ids), timestamp);
      }

      db.prepare(`UPDATE character_chunk_results SET status = 'completed', raw_json = ?, error = NULL,
        input_tokens = ?, output_tokens = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`)
        .run(rawJson, Math.max(0, inputTokens), Math.max(0, outputTokens), timestamp, run.id, chunkId);
      this.recalculateMetrics(db, run.revisionId, timestamp, false);
      this.updateRunProgress(db, run.id, jobId, timestamp);
    });
    return this.jobProgress(db, jobId);
  }

  recordError(jobId: string, chunkId: string, message: string, terminal: boolean): { state: JobRecord['state']; progress: number } {
    const { db, projectId } = this.store.get();
    const run = this.getRunByJob(db, projectId, jobId);
    const jobState = db.prepare('SELECT state FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state'] } | undefined;
    if (jobState?.state === 'cancelled') return this.jobProgress(db, jobId);
    const clean = message.slice(0, 2000);
    const timestamp = now();
    db.prepare(`UPDATE character_chunk_results SET status = ?, error = ?, updated_at = ? WHERE run_id = ? AND chunk_id = ?`)
      .run(terminal ? 'failed' : 'pending', clean, timestamp, run.id, chunkId);
    if (terminal) {
      const completed = db.prepare(`SELECT COUNT(*) AS value FROM character_chunk_results WHERE run_id = ? AND status = 'completed'`)
        .get(run.id) as { value: number };
      db.prepare(`UPDATE character_scan_runs SET status = 'failed', completed_chunks = ?, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value), timestamp, run.id);
      db.prepare(`UPDATE jobs SET state = 'failed', progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
        .run(Number(completed.value) / Math.max(run.totalChunks, 1), `人物普查已停止：${clean}。可在任务中心重试`, timestamp, run.jobId);
      db.prepare(`UPDATE job_attempts SET state = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND state = 'running'`)
        .run(timestamp, clean, run.jobId);
    }
    return this.jobProgress(db, jobId);
  }

  listCharacters(): CharacterCandidate[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const metricVersion = db.prepare('SELECT value_json AS valueJson FROM settings WHERE key = ?')
      .get(characterLiteralMetricsVersionKey(revisionId)) as { valueJson: string } | undefined;
    const hasIdentities = db.prepare('SELECT 1 AS value FROM person_identities WHERE revision_id = ? LIMIT 1')
      .get(revisionId) as { value: number } | undefined;
    if (hasIdentities && metricVersion?.valueJson !== JSON.stringify(CHARACTER_LITERAL_METRICS_VERSION)) {
      this.recalculateMetrics(db, revisionId, now());
    }
    const rows = db.prepare(`SELECT i.id, i.canonical_name AS canonicalName, i.entity_type AS entityType,
      i.importance_tier AS importanceTier, i.importance_score AS importanceScore, i.review_status AS reviewStatus,
      i.uncertainty, COALESCE(m.mention_count, 0) AS mentionCount, COALESCE(m.chapter_count, 0) AS chapterCount,
      COALESCE(m.dialogue_count, 0) AS dialogueCount, COALESCE(m.event_count, 0) AS eventCount,
      COALESCE(m.first_ordinal, 0) AS firstOrdinal, COALESCE(m.last_ordinal, 0) AS lastOrdinal,
      GROUP_CONCAT(DISTINCT a.alias) AS aliases
      FROM person_identities i LEFT JOIN person_metrics m ON m.identity_id = i.id
      LEFT JOIN person_aliases a ON a.identity_id = i.id AND a.review_status != 'rejected'
      WHERE i.revision_id = ? GROUP BY i.id ORDER BY i.review_status = 'rejected', i.importance_score DESC, i.canonical_name`)
      .all(revisionId) as Array<Omit<CharacterCandidate, 'aliases'> & { aliases: string | null }>;
    return rows.map((row) => ({
      ...row,
      importanceScore: Number(row.importanceScore),
      mentionCount: Number(row.mentionCount),
      chapterCount: Number(row.chapterCount),
      dialogueCount: Number(row.dialogueCount),
      eventCount: Number(row.eventCount),
      firstOrdinal: Number(row.firstOrdinal),
      lastOrdinal: Number(row.lastOrdinal),
      aliases: row.aliases ? [...new Set(row.aliases.split(',').filter(Boolean))] : [],
    }));
  }

  listMentions(identityId: string): CharacterMentionRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT m.id, m.source_span_id AS sourceSpanId,
      m.paragraph_id AS paragraphId, p.ordinal AS paragraphOrdinal, c.title AS chapterTitle,
      m.surface_text AS surfaceText, m.mention_type AS mentionType, m.exact_quote AS exactQuote,
      m.supports, m.confidence, m.alignment_status AS alignmentStatus
      FROM person_mentions m JOIN paragraphs p ON p.id = m.paragraph_id LEFT JOIN chapters c ON c.id = p.chapter_id
      WHERE m.identity_id = ? AND m.revision_id = ? ORDER BY p.ordinal, m.created_at`).all(identityId, revisionId) as unknown as CharacterMentionRecord[];
  }

  review(identityId: string, changes: { status?: CharacterCandidate['reviewStatus']; importanceTier?: CharacterCandidate['importanceTier'] }): CharacterCandidate[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const identity = db.prepare('SELECT id FROM person_identities WHERE id = ? AND revision_id = ?').get(identityId, revisionId);
    if (!identity) throw new Error('找不到该人物候选');
    if (!changes.status && !changes.importanceTier) throw new Error('没有需要保存的审核修改');
    const timestamp = now();
    withTransaction(db, () => {
      if (changes.status) db.prepare('UPDATE person_identities SET review_status = ?, updated_at = ? WHERE id = ?').run(changes.status, timestamp, identityId);
      if (changes.importanceTier) {
        db.prepare('UPDATE person_identities SET importance_tier = ?, updated_at = ? WHERE id = ?').run(changes.importanceTier, timestamp, identityId);
        db.prepare(`INSERT INTO person_manual_tiers (identity_id, tier, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(identity_id) DO UPDATE SET tier = excluded.tier, updated_at = excluded.updated_at`)
          .run(identityId, changes.importanceTier, timestamp);
      }
      this.recalculateMetrics(db, revisionId, timestamp);
    });
    return this.listCharacters();
  }

  listAliases(identityId: string): CharacterAliasRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const rows = db.prepare(`SELECT a.id, a.alias, a.normalized_alias AS normalizedAlias,
      a.alias_type AS aliasType, a.confidence,
      a.review_status AS reviewStatus, a.evidence_paragraph_id AS paragraphId,
      p.ordinal AS paragraphOrdinal, p.text AS exactQuote
      FROM person_aliases a JOIN person_identities i ON i.id = a.identity_id
      LEFT JOIN paragraphs p ON p.id = a.evidence_paragraph_id
      WHERE a.identity_id = ? AND i.revision_id = ?
      ORDER BY CASE a.review_status WHEN 'confirmed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        a.confidence DESC, a.alias, p.ordinal, a.id`)
      .all(identityId, revisionId) as unknown as Array<CharacterAliasRecord & { normalizedAlias: string }>;
    const unique = new Map<string, CharacterAliasRecord>();
    for (const { normalizedAlias, ...row } of rows) {
      if (!unique.has(normalizedAlias)) unique.set(normalizedAlias, row);
    }
    return [...unique.values()];
  }

  reviewAlias(aliasId: string, status: CharacterAliasRecord['reviewStatus']): CharacterAliasRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const alias = db.prepare(`SELECT a.id, a.identity_id AS identityId, a.alias,
      a.normalized_alias AS normalizedAlias, a.review_status AS reviewStatus
      FROM person_aliases a JOIN person_identities i ON i.id = a.identity_id
      WHERE a.id = ? AND i.revision_id = ?`).get(aliasId, revisionId) as {
        id: string; identityId: string; alias: string; normalizedAlias: string; reviewStatus: CharacterAliasRecord['reviewStatus'];
      } | undefined;
    if (!alias) throw new Error('找不到该别名候选');
    const aliases = db.prepare(`SELECT id, review_status AS reviewStatus FROM person_aliases
      WHERE identity_id = ? AND normalized_alias = ? ORDER BY id`)
      .all(alias.identityId, alias.normalizedAlias) as Array<{ id: string; reviewStatus: CharacterAliasRecord['reviewStatus'] }>;
    if (aliases.every((item) => item.reviewStatus === status)) return this.listAliases(alias.identityId);
    const timestamp = now();
    withTransaction(db, () => {
      db.prepare('UPDATE person_aliases SET review_status = ? WHERE identity_id = ? AND normalized_alias = ?')
        .run(status, alias.identityId, alias.normalizedAlias);
      this.recalculateMetrics(db, revisionId, timestamp);
      this.insertOperation(db, revisionId, 'alias_review', `将别名“${alias.alias}”标记为${status === 'confirmed' ? '已确认' : status === 'rejected' ? '已排除' : '待审核'}`, {
        aliasId, identityId: alias.identityId, previousStatus: alias.reviewStatus, nextStatus: status,
        aliases: aliases.map((item) => ({ id: item.id, previousStatus: item.reviewStatus })),
      });
    });
    return this.listAliases(alias.identityId);
  }

  listIdentityLinks(identityId: string): CharacterIdentityLinkRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    return db.prepare(`SELECT l.id,
      CASE WHEN l.left_identity_id = ? THEN l.right_identity_id ELSE l.left_identity_id END AS otherIdentityId,
      CASE WHEN l.left_identity_id = ? THEN right_i.canonical_name ELSE left_i.canonical_name END AS otherName,
      l.relation, l.reason, l.confidence, l.review_status AS reviewStatus
      FROM person_identity_links l
      JOIN person_identities left_i ON left_i.id = l.left_identity_id
      JOIN person_identities right_i ON right_i.id = l.right_identity_id
      WHERE l.revision_id = ? AND (l.left_identity_id = ? OR l.right_identity_id = ?)
      ORDER BY l.review_status = 'rejected', l.confidence DESC, l.created_at DESC`)
      .all(identityId, identityId, revisionId, identityId, identityId) as unknown as CharacterIdentityLinkRecord[];
  }

  reviewIdentityLink(linkId: string, status: CharacterIdentityLinkRecord['reviewStatus']): CharacterIdentityLinkRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const link = db.prepare(`SELECT id, left_identity_id AS leftIdentityId, right_identity_id AS rightIdentityId,
      relation, review_status AS reviewStatus FROM person_identity_links WHERE id = ? AND revision_id = ?`)
      .get(linkId, revisionId) as { id: string; leftIdentityId: string; rightIdentityId: string; relation: string; reviewStatus: CharacterIdentityLinkRecord['reviewStatus'] } | undefined;
    if (!link) throw new Error('找不到该身份关系建议');
    if (link.reviewStatus === status) return this.listIdentityLinks(link.leftIdentityId);
    withTransaction(db, () => {
      db.prepare('UPDATE person_identity_links SET review_status = ? WHERE id = ?').run(status, linkId);
      this.insertOperation(db, revisionId, link.relation === 'cannot_link' ? 'cannot_link' : 'must_link', `将身份关系建议标记为${status === 'confirmed' ? '已确认' : status === 'rejected' ? '已排除' : '待审核'}`, {
        linkId, identityId: link.leftIdentityId, previousStatus: link.reviewStatus, nextStatus: status,
      });
    });
    return this.listIdentityLinks(link.leftIdentityId);
  }

  merge(sourceIdentityId: string, targetIdentityId: string): CharacterCandidate[] {
    if (sourceIdentityId === targetIdentityId) throw new Error('不能把人物合并到自己');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const source = this.identityForEdit(db, revisionId, sourceIdentityId);
    const target = this.identityForEdit(db, revisionId, targetIdentityId);
    if (source.reviewStatus === 'rejected' || target.reviewStatus === 'rejected') throw new Error('已排除的人物不能参与合并，请先恢复为待审核');
    const blocked = db.prepare(`SELECT id, reason FROM person_identity_links WHERE revision_id = ? AND relation = 'cannot_link'
      AND review_status = 'confirmed' AND ((left_identity_id = ? AND right_identity_id = ?) OR (left_identity_id = ? AND right_identity_id = ?)) LIMIT 1`)
      .get(revisionId, sourceIdentityId, targetIdentityId, targetIdentityId, sourceIdentityId) as { id: string; reason: string } | undefined;
    if (blocked) throw new Error(`这两个人物已被明确标记为不同人物：${blocked.reason}`);

    const mentionIds = (db.prepare('SELECT id FROM person_mentions WHERE identity_id = ? ORDER BY id').all(sourceIdentityId) as Array<{ id: string }>).map((row) => row.id);
    const factIds = (db.prepare('SELECT id FROM character_facts WHERE identity_id = ? ORDER BY id').all(sourceIdentityId) as Array<{ id: string }>).map((row) => row.id);
    const aliasRows = db.prepare(`SELECT id, identity_id, revision_id, alias, normalized_alias, alias_type, confidence,
      review_status, evidence_paragraph_id, created_at FROM person_aliases WHERE identity_id = ? ORDER BY id`)
      .all(sourceIdentityId) as Array<Record<string, string | number | null>>;
    const movedAliasIds: string[] = [];
    const deletedAliases: Array<Record<string, string | number | null>> = [];
    const quoteAttributionRows = db.prepare(`SELECT id, quote_id, identity_id, role, method, confidence, review_status,
      evidence_paragraph_id, evidence_text, reasoning, created_at, updated_at FROM character_quote_attributions
      WHERE identity_id = ? ORDER BY id`).all(sourceIdentityId) as Array<Record<string, string | number | null>>;
    const movedQuoteAttributionIds: string[] = [];
    const deletedQuoteAttributions: Array<Record<string, string | number | null>> = [];
    let addedCanonicalAliasId: string | null = null;
    const timestamp = now();

    withTransaction(db, () => {
      const moveMention = db.prepare('UPDATE person_mentions SET identity_id = ? WHERE id = ?');
      for (const id of mentionIds) moveMention.run(targetIdentityId, id);
      const moveFact = db.prepare('UPDATE character_facts SET identity_id = ?, updated_at = ? WHERE id = ?');
      for (const id of factIds) moveFact.run(targetIdentityId, timestamp, id);
      for (const alias of aliasRows) {
        const duplicate = db.prepare(`SELECT id FROM person_aliases WHERE identity_id = ? AND normalized_alias = ?
          AND ((evidence_paragraph_id = ?) OR (evidence_paragraph_id IS NULL AND ? IS NULL)) LIMIT 1`)
          .get(targetIdentityId, alias.normalized_alias, alias.evidence_paragraph_id, alias.evidence_paragraph_id) as { id: string } | undefined;
        if (duplicate) {
          deletedAliases.push(alias);
          db.prepare('DELETE FROM person_aliases WHERE id = ?').run(alias.id);
        } else {
          db.prepare('UPDATE person_aliases SET identity_id = ? WHERE id = ?').run(targetIdentityId, alias.id);
          movedAliasIds.push(String(alias.id));
        }
      }
      for (const attribution of quoteAttributionRows) {
        const duplicate = db.prepare(`SELECT id FROM character_quote_attributions
          WHERE quote_id = ? AND identity_id = ? AND role = ? AND method = ? LIMIT 1`)
          .get(attribution.quote_id, targetIdentityId, attribution.role, attribution.method) as { id: string } | undefined;
        if (duplicate) {
          deletedQuoteAttributions.push(attribution);
          db.prepare('DELETE FROM character_quote_attributions WHERE id = ?').run(attribution.id);
        } else {
          db.prepare('UPDATE character_quote_attributions SET identity_id = ?, updated_at = ? WHERE id = ?')
            .run(targetIdentityId, timestamp, attribution.id);
          movedQuoteAttributionIds.push(String(attribution.id));
        }
      }
      if (source.normalizedName !== target.normalizedName) {
        const existingCanonical = db.prepare(`SELECT id FROM person_aliases WHERE identity_id = ? AND normalized_alias = ? LIMIT 1`)
          .get(targetIdentityId, source.normalizedName) as { id: string } | undefined;
        if (!existingCanonical) {
          addedCanonicalAliasId = `pa_${randomUUID()}`;
          db.prepare(`INSERT INTO person_aliases
            (id, identity_id, revision_id, alias, normalized_alias, alias_type, confidence, review_status, evidence_paragraph_id, created_at)
            VALUES (?, ?, ?, ?, ?, 'name', 1, 'confirmed', NULL, ?)`)
            .run(addedCanonicalAliasId, targetIdentityId, revisionId, source.canonicalName, source.normalizedName, timestamp);
        }
      }
      db.prepare(`UPDATE person_identities SET review_status = 'rejected', updated_at = ? WHERE id = ?`).run(timestamp, sourceIdentityId);
      db.prepare('DELETE FROM character_speech_profiles WHERE revision_id = ?').run(revisionId);
      db.prepare('DELETE FROM character_fact_clusters WHERE revision_id = ?').run(revisionId);
      this.recalculateMetrics(db, revisionId, timestamp);
      this.insertOperation(db, revisionId, 'merge', `将“${source.canonicalName}”合并到“${target.canonicalName}”`, {
        sourceIdentityId, targetIdentityId, mentionIds, factIds, movedAliasIds, deletedAliases, addedCanonicalAliasId,
        movedQuoteAttributionIds, deletedQuoteAttributions,
        sourceReviewStatus: source.reviewStatus, sourceImportanceTier: source.importanceTier,
      });
    });
    return this.listCharacters();
  }

  split(sourceIdentityId: string, mentionIdsInput: string[], canonicalNameInput: string): CharacterCandidate[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const source = this.identityForEdit(db, revisionId, sourceIdentityId);
    if (source.reviewStatus === 'rejected') throw new Error('已排除的人物不能拆分');
    const canonicalName = canonicalNameInput.trim().slice(0, 100);
    if (!canonicalName) throw new Error('新人物名称不能为空');
    if (!normalizedName(canonicalName)) throw new Error('新人物名称必须包含可识别字符');
    const requested = [...new Set(mentionIdsInput)].slice(0, 500);
    if (!requested.length) throw new Error('请至少选择一条需要拆出的原文证据');
    const placeholders = requested.map(() => '?').join(',');
    const mentions = db.prepare(`SELECT id, paragraph_id AS paragraphId, surface_text AS surfaceText,
      mention_type AS mentionType, confidence FROM person_mentions WHERE identity_id = ? AND id IN (${placeholders}) ORDER BY id`)
      .all(sourceIdentityId, ...requested) as Array<{ id: string; paragraphId: string; surfaceText: string; mentionType: string; confidence: number }>;
    if (mentions.length !== requested.length) throw new Error('部分证据已经不属于当前人物，请刷新后重试');
    const total = (db.prepare('SELECT COUNT(*) AS value FROM person_mentions WHERE identity_id = ?').get(sourceIdentityId) as { value: number }).value;
    if (mentions.length >= Number(total)) throw new Error('不能把全部证据拆走；如需改名，请保留身份并编辑名称');
    const newIdentityId = randomUUID();
    const linkId = randomUUID();
    const timestamp = now();
    const movedParagraphIds = [...new Set(mentions.map((mention) => mention.paragraphId))];
    const factPlaceholders = movedParagraphIds.map(() => '?').join(',');
    const affectedFacts = movedParagraphIds.length ? db.prepare(`SELECT DISTINCT f.id, f.review_status AS reviewStatus
      FROM character_facts f JOIN character_fact_evidence e ON e.fact_id = f.id
      WHERE f.identity_id = ? AND e.paragraph_id IN (${factPlaceholders})`).all(sourceIdentityId, ...movedParagraphIds) as Array<{ id: string; reviewStatus: string }> : [];
    const affectedQuoteAttributions = movedParagraphIds.length ? db.prepare(`SELECT id, review_status AS reviewStatus
      FROM character_quote_attributions WHERE identity_id = ? AND evidence_paragraph_id IN (${factPlaceholders})`)
      .all(sourceIdentityId, ...movedParagraphIds) as Array<{ id: string; reviewStatus: string }> : [];
    withTransaction(db, () => {
      db.prepare(`INSERT INTO person_identities
        (id, revision_id, canonical_name, normalized_name, entity_type, importance_tier, importance_score, review_status, uncertainty, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 0, 'pending', '', ?, ?)`)
        .run(newIdentityId, revisionId, canonicalName, normalizedName(canonicalName), source.entityType, timestamp, timestamp);
      const move = db.prepare('UPDATE person_mentions SET identity_id = ? WHERE id = ?');
      for (const mention of mentions) move.run(newIdentityId, mention.id);
      for (const fact of affectedFacts) db.prepare(`UPDATE character_facts SET review_status = 'pending', updated_at = ? WHERE id = ?`).run(timestamp, fact.id);
      for (const attribution of affectedQuoteAttributions) db.prepare(`UPDATE character_quote_attributions
        SET review_status = 'pending', updated_at = ? WHERE id = ?`).run(timestamp, attribution.id);
      const seenAliases = new Set<string>();
      for (const mention of mentions) {
        const normalized = normalizedName(mention.surfaceText);
        if (!normalized || normalized === normalizedName(canonicalName) || seenAliases.has(normalized)) continue;
        seenAliases.add(normalized);
        db.prepare(`INSERT INTO person_aliases
          (id, identity_id, revision_id, alias, normalized_alias, alias_type, confidence, review_status, evidence_paragraph_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
          .run(`pa_${randomUUID()}`, newIdentityId, revisionId, mention.surfaceText, normalized, mention.mentionType, Number(mention.confidence), mention.paragraphId, timestamp);
      }
      db.prepare(`INSERT INTO person_identity_links
        (id, revision_id, left_identity_id, right_identity_id, relation, reason, confidence, review_status, evidence_json, created_at)
        VALUES (?, ?, ?, ?, 'cannot_link', '用户从同一候选中拆分为不同人物', 1, 'confirmed', ?, ?)`)
        .run(linkId, revisionId, sourceIdentityId, newIdentityId, JSON.stringify(mentions.map((mention) => mention.paragraphId)), timestamp);
      db.prepare('DELETE FROM character_speech_profiles WHERE revision_id = ?').run(revisionId);
      db.prepare('DELETE FROM character_fact_clusters WHERE revision_id = ?').run(revisionId);
      this.recalculateMetrics(db, revisionId, timestamp);
      this.insertOperation(db, revisionId, 'split', `从“${source.canonicalName}”拆出“${canonicalName}”`, {
        sourceIdentityId, newIdentityId, mentionIds: mentions.map((mention) => mention.id), affectedFacts, affectedQuoteAttributions, linkId,
      });
    });
    return this.listCharacters();
  }

  link(leftIdentityId: string, rightIdentityId: string, relation: 'cannot_link' | 'must_link', reasonInput: string): CharacterCandidate[] {
    if (leftIdentityId === rightIdentityId) throw new Error('不能给同一个人物建立身份约束');
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const left = this.identityForEdit(db, revisionId, leftIdentityId);
    const right = this.identityForEdit(db, revisionId, rightIdentityId);
    const reason = reasonInput.trim().slice(0, 500) || (relation === 'cannot_link' ? '用户确认这是两个不同人物' : '用户确认这是同一人物');
    const linkId = randomUUID();
    withTransaction(db, () => {
      db.prepare(`INSERT INTO person_identity_links
        (id, revision_id, left_identity_id, right_identity_id, relation, reason, confidence, review_status, evidence_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 'confirmed', '[]', ?)`)
        .run(linkId, revisionId, leftIdentityId, rightIdentityId, relation, reason, now());
      this.insertOperation(db, revisionId, relation, `将“${left.canonicalName}”与“${right.canonicalName}”标记为${relation === 'cannot_link' ? '不同人物' : '同一人物候选'}`, { linkId });
    });
    return this.listCharacters();
  }

  listOperations(): IdentityOperationRecord[] {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const rows = db.prepare(`SELECT id, operation, description, state, created_at AS createdAt, undone_at AS undoneAt
      FROM person_identity_operations WHERE revision_id = ? ORDER BY id DESC LIMIT 100`).all(revisionId) as unknown as Array<Omit<IdentityOperationRecord, 'id'> & { id: number }>;
    return rows.map((row) => ({ ...row, id: String(row.id) }));
  }

  undoLatest(): { operation: IdentityOperationRecord; characters: CharacterCandidate[] } {
    const { db, projectId } = this.store.get();
    const revisionId = activeRevision(db, projectId);
    const operation = db.prepare(`SELECT id, operation, description, payload_json AS payloadJson, created_at AS createdAt
      FROM person_identity_operations WHERE revision_id = ? AND state = 'applied' ORDER BY id DESC LIMIT 1`)
      .get(revisionId) as { id: number; operation: IdentityOperationRecord['operation']; description: string; payloadJson: string; createdAt: string } | undefined;
    if (!operation) throw new Error('没有可以撤销的身份操作');
    const payload = JSON.parse(operation.payloadJson) as Record<string, unknown>;
    const timestamp = now();
    withTransaction(db, () => {
      if (operation.operation === 'merge') {
        const sourceIdentityId = String(payload.sourceIdentityId);
        const mentionIds = payload.mentionIds as string[];
        const moveMention = db.prepare('UPDATE person_mentions SET identity_id = ? WHERE id = ?');
        for (const id of mentionIds) moveMention.run(sourceIdentityId, id);
        for (const id of (payload.factIds as string[] | undefined) ?? []) db.prepare('UPDATE character_facts SET identity_id = ?, updated_at = ? WHERE id = ?').run(sourceIdentityId, timestamp, id);
        for (const id of payload.movedAliasIds as string[]) db.prepare('UPDATE person_aliases SET identity_id = ? WHERE id = ?').run(sourceIdentityId, id);
        for (const id of (payload.movedQuoteAttributionIds as string[] | undefined) ?? []) {
          db.prepare('UPDATE character_quote_attributions SET identity_id = ?, updated_at = ? WHERE id = ?').run(sourceIdentityId, timestamp, id);
        }
        for (const raw of payload.deletedAliases as Array<Record<string, string | number | null>>) {
          db.prepare(`INSERT OR IGNORE INTO person_aliases
            (id, identity_id, revision_id, alias, normalized_alias, alias_type, confidence, review_status, evidence_paragraph_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(raw.id, raw.identity_id, raw.revision_id, raw.alias, raw.normalized_alias, raw.alias_type, raw.confidence, raw.review_status, raw.evidence_paragraph_id, raw.created_at);
        }
        for (const raw of (payload.deletedQuoteAttributions as Array<Record<string, string | number | null>> | undefined) ?? []) {
          db.prepare(`INSERT OR IGNORE INTO character_quote_attributions
            (id, quote_id, identity_id, role, method, confidence, review_status, evidence_paragraph_id, evidence_text, reasoning, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(raw.id, raw.quote_id, raw.identity_id, raw.role, raw.method, raw.confidence, raw.review_status,
              raw.evidence_paragraph_id, raw.evidence_text, raw.reasoning, raw.created_at, raw.updated_at);
        }
        if (payload.addedCanonicalAliasId) db.prepare('DELETE FROM person_aliases WHERE id = ?').run(String(payload.addedCanonicalAliasId));
        db.prepare('UPDATE person_identities SET review_status = ?, importance_tier = ?, updated_at = ? WHERE id = ?')
          .run(payload.sourceReviewStatus, payload.sourceImportanceTier, timestamp, sourceIdentityId);
      } else if (operation.operation === 'split') {
        const sourceIdentityId = String(payload.sourceIdentityId);
        for (const id of payload.mentionIds as string[]) db.prepare('UPDATE person_mentions SET identity_id = ? WHERE id = ?').run(sourceIdentityId, id);
        for (const fact of (payload.affectedFacts as Array<{ id: string; reviewStatus: string }> | undefined) ?? []) {
          db.prepare('UPDATE character_facts SET review_status = ?, updated_at = ? WHERE id = ?').run(fact.reviewStatus, timestamp, fact.id);
        }
        for (const attribution of (payload.affectedQuoteAttributions as Array<{ id: string; reviewStatus: string }> | undefined) ?? []) {
          db.prepare('UPDATE character_quote_attributions SET review_status = ?, updated_at = ? WHERE id = ?')
            .run(attribution.reviewStatus, timestamp, attribution.id);
        }
        db.prepare('DELETE FROM person_identities WHERE id = ?').run(String(payload.newIdentityId));
      } else if (operation.operation === 'alias_review') {
        const aliases = payload.aliases as Array<{ id: string; previousStatus: string }> | undefined;
        if (aliases?.length) {
          for (const alias of aliases) {
            db.prepare('UPDATE person_aliases SET review_status = ? WHERE id = ?').run(alias.previousStatus, alias.id);
          }
        } else {
          db.prepare('UPDATE person_aliases SET review_status = ? WHERE id = ?').run(payload.previousStatus, payload.aliasId);
        }
      } else {
        if (payload.previousStatus) db.prepare('UPDATE person_identity_links SET review_status = ? WHERE id = ?').run(payload.previousStatus, payload.linkId);
        else db.prepare('DELETE FROM person_identity_links WHERE id = ?').run(payload.linkId);
      }
      this.recalculateMetrics(db, revisionId, timestamp);
      db.prepare('DELETE FROM character_speech_profiles WHERE revision_id = ?').run(revisionId);
      db.prepare('DELETE FROM character_fact_clusters WHERE revision_id = ?').run(revisionId);
      db.prepare(`UPDATE person_identity_operations SET state = 'undone', undone_at = ? WHERE id = ?`).run(timestamp, operation.id);
    });
    const record: IdentityOperationRecord = {
      id: String(operation.id), operation: operation.operation, description: operation.description,
      state: 'undone', createdAt: operation.createdAt, undoneAt: timestamp,
    };
    return { operation: record, characters: this.listCharacters() };
  }

  private getRunByJob(db: SQLiteDatabase, projectId: string, jobId: string): RunRow {
    const run = db.prepare(`SELECT id, job_id AS jobId, revision_id AS revisionId, chunk_plan_id AS chunkPlanId,
      model, prompt_version AS promptVersion, total_chunks AS totalChunks, completed_chunks AS completedChunks, status
      FROM character_scan_runs WHERE job_id = ? AND project_id = ?`).get(jobId, projectId) as RunRow | undefined;
    if (!run) throw new Error('找不到人物普查任务');
    return run;
  }

  private identityForEdit(db: SQLiteDatabase, revisionId: string, identityId: string): {
    id: string; canonicalName: string; normalizedName: string; entityType: string;
    importanceTier: CharacterCandidate['importanceTier']; reviewStatus: CharacterCandidate['reviewStatus'];
  } {
    const row = db.prepare(`SELECT id, canonical_name AS canonicalName, normalized_name AS normalizedName,
      entity_type AS entityType, importance_tier AS importanceTier, review_status AS reviewStatus
      FROM person_identities WHERE id = ? AND revision_id = ?`).get(identityId, revisionId) as {
        id: string; canonicalName: string; normalizedName: string; entityType: string;
        importanceTier: CharacterCandidate['importanceTier']; reviewStatus: CharacterCandidate['reviewStatus'];
      } | undefined;
    if (!row) throw new Error('找不到要编辑的人物');
    return row;
  }

  private insertOperation(
    db: SQLiteDatabase,
    revisionId: string,
    operation: IdentityOperationRecord['operation'],
    description: string,
    payload: unknown,
  ): void {
    db.prepare(`INSERT INTO person_identity_operations
      (revision_id, operation, description, payload_json, state, created_at) VALUES (?, ?, ?, ?, 'applied', ?)`)
      .run(revisionId, operation, description, JSON.stringify(payload), now());
  }

  private updateRunProgress(db: SQLiteDatabase, runId: string, jobId: string, timestamp: string): void {
    const counts = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
      FROM character_chunk_results WHERE run_id = ?`).get(runId) as { total: number; completed: number; failed: number; inputTokens: number; outputTokens: number };
    const progress = Number(counts.total) ? Number(counts.completed) / Number(counts.total) : 0;
    db.prepare(`UPDATE character_scan_runs SET completed_chunks = ?, input_tokens = ?, output_tokens = ?, updated_at = ? WHERE id = ?`)
      .run(Number(counts.completed), Number(counts.inputTokens), Number(counts.outputTokens), timestamp, runId);
    db.prepare(`UPDATE jobs SET progress = ?, message = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?`)
      .run(progress, `人物普查：已完成 ${Number(counts.completed)}/${Number(counts.total)} 个分块`, new Date(Date.now() + 60_000).toISOString(), timestamp, jobId);
  }

  private finishIfDone(db: SQLiteDatabase, run: RunRow): void {
    const counts = db.prepare(`SELECT
      SUM(CASE WHEN status = 'pending' OR status = 'running' THEN 1 ELSE 0 END) AS remaining,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM character_chunk_results WHERE run_id = ?`).get(run.id) as { remaining: number; failed: number; completed: number };
    if (Number(counts.remaining) > 0) return;
    const timestamp = now();
    const failed = Number(counts.failed);
    const state = failed ? 'failed' : 'completed';
    this.recalculateMetrics(db, run.revisionId, timestamp);
    db.prepare(`UPDATE character_scan_runs SET status = ?, completed_chunks = ?, updated_at = ? WHERE id = ?`)
      .run(state, Number(counts.completed), timestamp, run.id);
    db.prepare(`UPDATE jobs SET state = ?, progress = ?, message = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`)
      .run(state, failed ? Number(counts.completed) / Math.max(run.totalChunks, 1) : 1,
        failed ? `人物普查有 ${failed} 个分块失败，可在任务中心重试` : '人物普查完成，候选人物等待审核', timestamp, run.jobId);
    db.prepare(`UPDATE job_attempts SET state = ?, finished_at = ? WHERE job_id = ? AND state = 'running'`)
      .run(state, timestamp, run.jobId);
  }

  private jobProgress(db: SQLiteDatabase, jobId: string): { state: JobRecord['state']; progress: number } {
    const row = db.prepare('SELECT state, progress FROM jobs WHERE id = ?').get(jobId) as { state: JobRecord['state']; progress: number } | undefined;
    if (!row) throw new Error('找不到人物普查任务');
    return { state: row.state, progress: Number(row.progress) };
  }

  private recalculateMetrics(db: SQLiteDatabase, revisionId: string, timestamp: string, useLiteralCounts = true): void {
    const identities = db.prepare(`SELECT id FROM person_identities WHERE revision_id = ?`).all(revisionId) as Array<{ id: string }>;
    const totals = db.prepare(`SELECT COUNT(*) AS paragraphCount, COUNT(DISTINCT p.chapter_id) AS chapterCount,
      MIN(p.ordinal) AS firstOrdinal, MAX(p.ordinal) AS lastOrdinal
      FROM paragraphs p LEFT JOIN paragraph_exclusions e ON e.paragraph_id = p.id
      WHERE p.revision_id = ? AND COALESCE(e.excluded, 0) = 0`)
      .get(revisionId) as { paragraphCount: number; chapterCount: number; firstOrdinal: number | null; lastOrdinal: number | null };
    const literalMetrics = useLiteralCounts ? calculateCharacterLiteralMetrics(db, revisionId) : null;
    for (const identity of identities) {
      const metrics = db.prepare(`SELECT COUNT(*) AS mentionCount, COUNT(DISTINCT p.chapter_id) AS chapterCount,
        SUM(m.has_dialogue) AS dialogueCount, SUM(m.participates_in_event) AS eventCount,
        MIN(p.ordinal) AS firstOrdinal, MAX(p.ordinal) AS lastOrdinal
        FROM person_mentions m JOIN paragraphs p ON p.id = m.paragraph_id
        LEFT JOIN paragraph_exclusions e ON e.paragraph_id = p.id
        WHERE m.identity_id = ? AND COALESCE(e.excluded, 0) = 0`)
        .get(identity.id) as { mentionCount: number; chapterCount: number; dialogueCount: number; eventCount: number; firstOrdinal: number | null; lastOrdinal: number | null };
      const literal = literalMetrics?.get(identity.id);
      const mentions = literal?.mentionCount ?? Number(metrics.mentionCount ?? 0);
      const chapters = literal?.chapterCount ?? Number(metrics.chapterCount ?? 0);
      const dialogue = Number(metrics.dialogueCount ?? 0);
      const events = Number(metrics.eventCount ?? 0);
      const first = literal?.firstOrdinal ?? Number(metrics.firstOrdinal ?? 0);
      const last = literal?.lastOrdinal ?? Number(metrics.lastOrdinal ?? 0);
      const coverage = chapters / Math.max(Number(totals.chapterCount), 1);
      const sourceSpan = Number(totals.lastOrdinal ?? 0) - Number(totals.firstOrdinal ?? 0);
      const span = last > first ? (last - first) / Math.max(sourceSpan, 1) : 0;
      const score = Math.min(100, coverage * 25 + Math.min(1, Math.log1p(mentions) / Math.log(101)) * 20
        + Math.min(1, dialogue / 30) * 15 + Math.min(1, events / 20) * 15 + span * 10);
      const tier = score >= 55 ? 'core' : score >= 30 ? 'important' : score >= 12 ? 'minor' : 'incidental';
      db.prepare(`INSERT INTO person_metrics
        (identity_id, mention_count, chapter_count, dialogue_count, event_count, first_ordinal, last_ordinal, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity_id) DO UPDATE SET mention_count = excluded.mention_count, chapter_count = excluded.chapter_count,
        dialogue_count = excluded.dialogue_count, event_count = excluded.event_count, first_ordinal = excluded.first_ordinal,
        last_ordinal = excluded.last_ordinal, updated_at = excluded.updated_at`)
        .run(identity.id, mentions, chapters, dialogue, events, first, last, timestamp);
      const manualTier = db.prepare('SELECT tier FROM person_manual_tiers WHERE identity_id = ?').get(identity.id) as { tier: string } | undefined;
      db.prepare(`UPDATE person_identities SET importance_score = ?, importance_tier = ?, updated_at = ? WHERE id = ?`)
        .run(Number(score.toFixed(2)), manualTier?.tier ?? tier, timestamp, identity.id);
    }
    if (useLiteralCounts) {
      db.prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
        .run(characterLiteralMetricsVersionKey(revisionId), JSON.stringify(CHARACTER_LITERAL_METRICS_VERSION), timestamp);
    }
  }
}
