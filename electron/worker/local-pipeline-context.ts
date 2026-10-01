import type { SQLiteDatabase } from './sqlite-db';

export const LOCAL_PIPELINE_VERSION = 'local-pipeline.v2';
export type LocalPipelineContext = { runId: string; identityIds: string[]; entryEventId?: string };

export function activeLocalPipeline(db: SQLiteDatabase, revisionId: string): LocalPipelineContext | null {
  const latest = db.prepare('SELECT id, profile FROM foundation_workflow_runs WHERE revision_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get(revisionId) as { id: string; profile: string } | undefined;
  if (latest?.profile !== 'local') return null;
  const row = db.prepare('SELECT value_json AS value FROM settings WHERE key = ?').get(`local-pipeline:${revisionId}`) as { value: string } | undefined;
  if (!row) return null;
  const context = JSON.parse(row.value) as LocalPipelineContext;
  return context.runId === latest.id ? context : null;
}
