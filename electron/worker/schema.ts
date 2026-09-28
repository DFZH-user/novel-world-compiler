export const BASE_SCHEMA_VERSION = 13;
export const SCHEMA_VERSION = 28;

export const schemaSql = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  active_revision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  original_path TEXT NOT NULL,
  normalized_path TEXT NOT NULL,
  encoding TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  character_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('importing','ready','failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, sha256, encoding)
);

CREATE TABLE IF NOT EXISTS volumes (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  paragraph_start INTEGER NOT NULL,
  paragraph_end INTEGER NOT NULL,
  UNIQUE(revision_id, ordinal)
);

CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  paragraph_start INTEGER NOT NULL,
  paragraph_end INTEGER NOT NULL,
  character_count INTEGER NOT NULL DEFAULT 0,
  detection_score REAL NOT NULL DEFAULT 0,
  manually_edited INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, ordinal)
);

CREATE TABLE IF NOT EXISTS chapter_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  parent_chapter_id TEXT NOT NULL,
  child_chapter_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('split','merge')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paragraphs (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  utf8_start INTEGER NOT NULL,
  utf8_end INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  UNIQUE(revision_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_paragraphs_revision_ordinal ON paragraphs(revision_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_paragraphs_chapter_ordinal ON paragraphs(chapter_id, ordinal);

CREATE TABLE IF NOT EXISTS paragraph_exclusions (
  paragraph_id TEXT PRIMARY KEY REFERENCES paragraphs(id) ON DELETE CASCADE,
  excluded INTEGER NOT NULL DEFAULT 1,
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunk_plans (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  settings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(revision_id, version)
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES chunk_plans(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
  core_start_ordinal INTEGER NOT NULL,
  core_end_ordinal INTEGER NOT NULL,
  context_start_ordinal INTEGER NOT NULL,
  context_end_ordinal INTEGER NOT NULL,
  character_count INTEGER NOT NULL,
  UNIQUE(plan_id, ordinal)
);

CREATE TABLE IF NOT EXISTS chunk_members (
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('core','context_before','context_after')),
  ordinal_in_chunk INTEGER NOT NULL,
  PRIMARY KEY(chunk_id, paragraph_id)
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','failed','cancelled')),
  progress REAL NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  input_json TEXT,
  input_hash TEXT,
  checkpoint_json TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  state TEXT NOT NULL,
  error TEXT,
  UNIQUE(job_id, attempt)
);

CREATE TABLE IF NOT EXISTS evidence_anchors (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  utf8_start INTEGER NOT NULL,
  utf8_end INTEGER NOT NULL,
  quote TEXT NOT NULL,
  quote_hash TEXT NOT NULL,
  prefix_hash TEXT,
  suffix_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_scan_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  chunk_plan_id TEXT NOT NULL REFERENCES chunk_plans(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed','cancelled')),
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, chunk_plan_id, model, prompt_version, input_hash)
);

CREATE TABLE IF NOT EXISTS character_chunk_results (
  run_id TEXT NOT NULL REFERENCES character_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  input_hash TEXT NOT NULL,
  raw_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_character_chunks_run_status ON character_chunk_results(run_id, status);

CREATE TABLE IF NOT EXISTS person_identities (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'unknown',
  importance_tier TEXT NOT NULL DEFAULT 'pending' CHECK(importance_tier IN ('core','important','minor','incidental','pending')),
  importance_score REAL NOT NULL DEFAULT 0,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  uncertainty TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_person_identities_revision_name ON person_identities(revision_id, normalized_name);

CREATE TABLE IF NOT EXISTS person_aliases (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  alias_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  evidence_paragraph_id TEXT REFERENCES paragraphs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(identity_id, normalized_alias, evidence_paragraph_id)
);

CREATE INDEX IF NOT EXISTS idx_person_aliases_revision_alias ON person_aliases(revision_id, normalized_alias);

CREATE TABLE IF NOT EXISTS person_mentions (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES character_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  surface_text TEXT NOT NULL,
  mention_type TEXT NOT NULL,
  exact_quote TEXT NOT NULL,
  supports TEXT NOT NULL,
  has_dialogue INTEGER NOT NULL DEFAULT 0,
  participates_in_event INTEGER NOT NULL DEFAULT 0,
  confidence REAL NOT NULL,
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_person_mentions_identity ON person_mentions(identity_id);
CREATE INDEX IF NOT EXISTS idx_person_mentions_paragraph ON person_mentions(paragraph_id);

CREATE TABLE IF NOT EXISTS person_identity_links (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  left_identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  right_identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('must_link','cannot_link','uncertain')),
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_metrics (
  identity_id TEXT PRIMARY KEY REFERENCES person_identities(id) ON DELETE CASCADE,
  mention_count INTEGER NOT NULL DEFAULT 0,
  chapter_count INTEGER NOT NULL DEFAULT 0,
  dialogue_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  first_ordinal INTEGER NOT NULL DEFAULT 0,
  last_ordinal INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_manual_tiers (
  identity_id TEXT PRIMARY KEY REFERENCES person_identities(id) ON DELETE CASCADE,
  tier TEXT NOT NULL CHECK(tier IN ('core','important','minor','incidental','pending')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS person_identity_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK(operation IN ('merge','split','cannot_link','must_link','alias_review')),
  description TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'applied' CHECK(state IN ('applied','undone')),
  created_at TEXT NOT NULL,
  undone_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_person_operations_revision_state ON person_identity_operations(revision_id, state, id);

CREATE TABLE IF NOT EXISTS character_fact_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed','cancelled')),
  total_batches INTEGER NOT NULL,
  completed_batches INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, identity_id, model, prompt_version, input_hash)
);

CREATE TABLE IF NOT EXISTS character_fact_batches (
  run_id TEXT NOT NULL REFERENCES character_fact_runs(id) ON DELETE CASCADE,
  batch_ordinal INTEGER NOT NULL,
  paragraph_ids_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  raw_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, batch_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_fact_batches_run_status ON character_fact_batches(run_id, status);

CREATE TABLE IF NOT EXISTS character_fact_run_options (
  run_id TEXT PRIMARY KEY REFERENCES character_fact_runs(id) ON DELETE CASCADE,
  extraction_passes INTEGER NOT NULL DEFAULT 1 CHECK(extraction_passes IN (1, 2)),
  target_characters INTEGER NOT NULL DEFAULT 6000,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_facts (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES character_fact_runs(id) ON DELETE CASCADE,
  batch_ordinal INTEGER NOT NULL,
  category TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK(source_type IN ('explicit','inferred','user','generated')),
  confidence REAL NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('public','private','secret')),
  valid_from_ordinal INTEGER,
  valid_to_ordinal INTEGER,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  reasoning_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_character_facts_identity ON character_facts(identity_id, review_status, category);

CREATE TABLE IF NOT EXISTS character_fact_claim_metadata (
  fact_id TEXT PRIMARY KEY REFERENCES character_facts(id) ON DELETE CASCADE,
  assertion_mode TEXT NOT NULL CHECK(assertion_mode IN ('narrator_assertion','self_report','other_report','rumor','belief','behavior_inference')),
  truth_status TEXT NOT NULL CHECK(truth_status IN ('asserted','suspected','disputed','false','unknown')),
  attributed_source_name TEXT,
  extraction_pass INTEGER NOT NULL DEFAULT 1 CHECK(extraction_pass IN (1, 2)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_fact_evidence (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES character_facts(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('support','context','contradict')),
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(fact_id, paragraph_id, exact_quote, evidence_role)
);

CREATE TABLE IF NOT EXISTS character_quotes (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  quote_text TEXT NOT NULL,
  quote_type TEXT NOT NULL CHECK(quote_type IN ('curly_double','corner','double_corner','ascii_double','dash')),
  detection_method TEXT NOT NULL DEFAULT 'rule' CHECK(detection_method IN ('rule','model','user')),
  created_at TEXT NOT NULL,
  UNIQUE(revision_id, paragraph_id, start_offset, end_offset, quote_type)
);

CREATE INDEX IF NOT EXISTS idx_character_quotes_revision_paragraph ON character_quotes(revision_id, paragraph_id);

CREATE TABLE IF NOT EXISTS character_quote_attributions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES character_quotes(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'speaker' CHECK(role IN ('speaker','addressee')),
  method TEXT NOT NULL CHECK(method IN ('explicit_cue','nearby_context','turn_taking','style','model','user')),
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  evidence_paragraph_id TEXT REFERENCES paragraphs(id) ON DELETE SET NULL,
  evidence_text TEXT NOT NULL DEFAULT '',
  reasoning TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(quote_id, identity_id, role, method)
);

CREATE INDEX IF NOT EXISTS idx_quote_attributions_quote ON character_quote_attributions(quote_id, role, review_status);
CREATE INDEX IF NOT EXISTS idx_quote_attributions_identity ON character_quote_attributions(identity_id, review_status);

CREATE TABLE IF NOT EXISTS character_speech_profiles (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  quote_count INTEGER NOT NULL,
  character_count INTEGER NOT NULL,
  average_length REAL NOT NULL,
  question_rate REAL NOT NULL,
  exclamation_rate REAL NOT NULL,
  ellipsis_rate REAL NOT NULL,
  first_person_rate REAL NOT NULL,
  sentence_particle_rate REAL NOT NULL,
  politeness_rate REAL NOT NULL,
  classical_rate REAL NOT NULL,
  favorite_markers_json TEXT NOT NULL DEFAULT '[]',
  sample_quote_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, identity_id)
);

CREATE INDEX IF NOT EXISTS idx_speech_profiles_revision_count ON character_speech_profiles(revision_id, quote_count DESC);

CREATE TABLE IF NOT EXISTS character_fact_clusters (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  canonical_predicate TEXT NOT NULL,
  canonical_value TEXT NOT NULL,
  normalized_predicate TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  first_observed_ordinal INTEGER,
  last_observed_ordinal INTEGER,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, identity_id, category, normalized_predicate, normalized_value)
);

CREATE INDEX IF NOT EXISTS idx_fact_clusters_identity_predicate ON character_fact_clusters(identity_id, category, normalized_predicate);

CREATE TABLE IF NOT EXISTS character_fact_cluster_members (
  cluster_id TEXT NOT NULL REFERENCES character_fact_clusters(id) ON DELETE CASCADE,
  fact_id TEXT NOT NULL REFERENCES character_facts(id) ON DELETE CASCADE,
  membership_method TEXT NOT NULL CHECK(membership_method IN ('exact_normalized','user')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(cluster_id, fact_id),
  UNIQUE(fact_id)
);

CREATE TABLE IF NOT EXISTS character_fact_relations (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  left_cluster_id TEXT NOT NULL REFERENCES character_fact_clusters(id) ON DELETE CASCADE,
  right_cluster_id TEXT NOT NULL REFERENCES character_fact_clusters(id) ON DELETE CASCADE,
  proposed_relation TEXT NOT NULL CHECK(proposed_relation IN ('uncertain','contradiction','state_change','coexists_by_time','viewpoint_difference','rumor_correction','identity_disguise','unrelated')),
  resolved_relation TEXT CHECK(resolved_relation IN ('contradiction','state_change','coexists_by_time','viewpoint_difference','rumor_correction','identity_disguise','unrelated')),
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(left_cluster_id, right_cluster_id)
);

CREATE INDEX IF NOT EXISTS idx_fact_relations_identity_status ON character_fact_relations(identity_id, review_status);

CREATE TABLE IF NOT EXISTS character_state_transitions (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  relation_id TEXT NOT NULL UNIQUE REFERENCES character_fact_relations(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  predicate TEXT NOT NULL,
  from_cluster_id TEXT NOT NULL REFERENCES character_fact_clusters(id) ON DELETE CASCADE,
  to_cluster_id TEXT NOT NULL REFERENCES character_fact_clusters(id) ON DELETE CASCADE,
  from_value TEXT NOT NULL,
  to_value TEXT NOT NULL,
  observed_from_ordinal INTEGER,
  observed_to_ordinal INTEGER,
  trigger_paragraph_id TEXT REFERENCES paragraphs(id) ON DELETE SET NULL,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_transitions_identity_order ON character_state_transitions(identity_id, observed_to_ordinal);

CREATE TABLE IF NOT EXISTS timeline_events (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL DEFAULT 'other' CHECK(event_type IN ('action','dialogue','movement','meeting','conflict','discovery','state_change','birth','death','other')),
  narrative_start_ordinal INTEGER NOT NULL,
  narrative_end_ordinal INTEGER NOT NULL,
  extraction_method TEXT NOT NULL CHECK(extraction_method IN ('model','rule','user')),
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  uncertainty TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(narrative_end_ordinal >= narrative_start_ordinal)
);

CREATE INDEX IF NOT EXISTS idx_timeline_events_revision_order ON timeline_events(revision_id, narrative_start_ordinal, narrative_end_ordinal);
CREATE INDEX IF NOT EXISTS idx_timeline_events_revision_status ON timeline_events(revision_id, review_status);

CREATE TABLE IF NOT EXISTS timeline_event_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  chunk_plan_id TEXT NOT NULL REFERENCES chunk_plans(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed','cancelled')),
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, chunk_plan_id, model, prompt_version, input_hash)
);

CREATE TABLE IF NOT EXISTS timeline_event_chunk_results (
  run_id TEXT NOT NULL REFERENCES timeline_event_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  input_hash TEXT NOT NULL,
  raw_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_timeline_event_chunks_run_status ON timeline_event_chunk_results(run_id, status);

CREATE TABLE IF NOT EXISTS timeline_event_sources (
  event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES timeline_event_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  local_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(event_id, run_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS timeline_event_participants (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  identity_id TEXT REFERENCES person_identities(id) ON DELETE SET NULL,
  surface_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant' CHECK(role IN ('actor','target','witness','speaker','addressee','participant','other')),
  action_text TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeline_participants_event ON timeline_event_participants(event_id, review_status);
CREATE INDEX IF NOT EXISTS idx_timeline_participants_identity ON timeline_event_participants(identity_id, review_status);

CREATE TABLE IF NOT EXISTS timeline_event_locations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  surface_name TEXT NOT NULL,
  normalized_name TEXT,
  location_role TEXT NOT NULL DEFAULT 'at' CHECK(location_role IN ('at','from','to','through','near','mentioned')),
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_timeline_locations_event ON timeline_event_locations(event_id, review_status);
CREATE INDEX IF NOT EXISTS idx_timeline_locations_name ON timeline_event_locations(normalized_name, review_status);

CREATE TABLE IF NOT EXISTS timeline_event_evidence (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  evidence_role TEXT NOT NULL DEFAULT 'support' CHECK(evidence_role IN ('support','context','contradict')),
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(event_id, paragraph_id, exact_quote, evidence_role)
);

CREATE INDEX IF NOT EXISTS idx_timeline_event_evidence_event ON timeline_event_evidence(event_id);
CREATE INDEX IF NOT EXISTS idx_timeline_event_evidence_paragraph ON timeline_event_evidence(paragraph_id);

CREATE TABLE IF NOT EXISTS timeline_time_expressions (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  surface_text TEXT NOT NULL,
  expression_type TEXT NOT NULL CHECK(expression_type IN ('calendar','clock','relative','duration','frequency','age','era','season','unknown')),
  normalized_value TEXT,
  calendar_system TEXT NOT NULL DEFAULT 'unspecified' CHECK(calendar_system IN ('gregorian','lunar','fictional','relative','unspecified')),
  detection_method TEXT NOT NULL CHECK(detection_method IN ('rule','model','user')),
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(start_offset >= 0 AND end_offset > start_offset),
  UNIQUE(revision_id, paragraph_id, start_offset, end_offset, surface_text)
);

CREATE INDEX IF NOT EXISTS idx_time_expressions_revision_order ON timeline_time_expressions(revision_id, paragraph_id, start_offset);
CREATE INDEX IF NOT EXISTS idx_time_expressions_revision_status ON timeline_time_expressions(revision_id, review_status);

CREATE TABLE IF NOT EXISTS timeline_event_time_links (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  time_expression_id TEXT NOT NULL REFERENCES timeline_time_expressions(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('occurs_at','begins_at','ends_at','during','before','after')),
  confidence REAL NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(event_id, time_expression_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_event_time_links_event ON timeline_event_time_links(event_id, review_status);

CREATE TABLE IF NOT EXISTS timeline_event_relations (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  left_event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  right_event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('before','after','simultaneous','includes','is_included','unknown')),
  source_type TEXT NOT NULL CHECK(source_type IN ('explicit','inferred','model','user')),
  evidence_paragraph_id TEXT REFERENCES paragraphs(id) ON DELETE SET NULL,
  exact_quote TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(left_event_id != right_event_id),
  UNIQUE(left_event_id, right_event_id)
);

CREATE INDEX IF NOT EXISTS idx_event_relations_revision_status ON timeline_event_relations(revision_id, review_status);
CREATE INDEX IF NOT EXISTS idx_event_relations_left ON timeline_event_relations(left_event_id, review_status);
CREATE INDEX IF NOT EXISTS idx_event_relations_right ON timeline_event_relations(right_event_id, review_status);

CREATE TABLE IF NOT EXISTS timeline_event_relation_decisions (
  relation_id TEXT PRIMARY KEY REFERENCES timeline_event_relations(id) ON DELETE CASCADE,
  resolved_relation TEXT NOT NULL CHECK(resolved_relation IN ('before','after','simultaneous','includes','is_included','unknown')),
  reviewed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_card_drafts (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  entry_event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  scenario TEXT NOT NULL DEFAULT '',
  first_mes TEXT NOT NULL DEFAULT '',
  mes_example TEXT NOT NULL DEFAULT '',
  creator_notes TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  post_history_instructions TEXT NOT NULL DEFAULT '',
  alternate_greetings_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  creator TEXT NOT NULL DEFAULT '',
  character_version TEXT NOT NULL DEFAULT '1.0',
  review_status TEXT NOT NULL DEFAULT 'draft' CHECK(review_status IN ('draft','reviewed')),
  source_summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, identity_id)
);

CREATE INDEX IF NOT EXISTS idx_character_card_drafts_revision_status ON character_card_drafts(revision_id, review_status);

CREATE TABLE IF NOT EXISTS character_card_refinements (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  original_fields_json TEXT NOT NULL,
  proposed_fields_json TEXT NOT NULL,
  source_keys_json TEXT NOT NULL,
  change_summary_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  raw_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
  applied_fields_json TEXT NOT NULL DEFAULT '[]',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_card_refinements_identity_created ON character_card_refinements(revision_id, identity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type SchemaMigration = {
  version: number;
  sql: string;
};

export const schemaMigrations: SchemaMigration[] = [
  {
    version: 14,
    sql: `
CREATE TABLE character_relationship_candidates (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  source_identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  target_identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  candidate_method TEXT NOT NULL CHECK(candidate_method IN ('cooccurrence','rule','model','user')),
  proposed_type TEXT,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_identity_id != target_identity_id)
);

CREATE INDEX idx_relationship_candidates_revision_status
  ON character_relationship_candidates(revision_id, review_status, confidence DESC);
CREATE INDEX idx_relationship_candidates_pair
  ON character_relationship_candidates(source_identity_id, target_identity_id, review_status);

CREATE TABLE character_relationship_candidate_evidence (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES character_relationship_candidates(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('clue','support','context','contradict')),
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(candidate_id, paragraph_id, exact_quote, evidence_role)
);

CREATE INDEX idx_relationship_candidate_evidence_candidate
  ON character_relationship_candidate_evidence(candidate_id);

CREATE TABLE character_relationships (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  source_identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  target_identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('directed','undirected','reciprocal')),
  strength REAL CHECK(strength IS NULL OR (strength >= 0 AND strength <= 1)),
  polarity REAL CHECK(polarity IS NULL OR (polarity >= -1 AND polarity <= 1)),
  information_source_type TEXT NOT NULL CHECK(information_source_type IN ('narrator','character','unknown')),
  information_source_identity_id TEXT REFERENCES person_identities(id) ON DELETE SET NULL,
  truth_status TEXT NOT NULL CHECK(truth_status IN ('asserted','suspected','disputed','false','unknown','rumor')),
  valid_from_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  valid_to_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  valid_from_time_expression_id TEXT REFERENCES timeline_time_expressions(id) ON DELETE SET NULL,
  valid_to_time_expression_id TEXT REFERENCES timeline_time_expressions(id) ON DELETE SET NULL,
  valid_from_ordinal INTEGER,
  valid_to_ordinal INTEGER,
  first_revealed_paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE RESTRICT,
  first_revealed_ordinal INTEGER NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  extraction_method TEXT NOT NULL CHECK(extraction_method IN ('rule','model','user')),
  candidate_id TEXT REFERENCES character_relationship_candidates(id) ON DELETE SET NULL,
  supersedes_relationship_id TEXT REFERENCES character_relationships(id) ON DELETE SET NULL,
  reasoning_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_identity_id != target_identity_id),
  CHECK(valid_to_ordinal IS NULL OR valid_from_ordinal IS NULL OR valid_from_ordinal <= valid_to_ordinal),
  CHECK((information_source_type = 'character' AND information_source_identity_id IS NOT NULL)
    OR information_source_type != 'character')
);

CREATE INDEX idx_relationships_revision_review_reveal
  ON character_relationships(revision_id, review_status, first_revealed_ordinal);
CREATE INDEX idx_relationships_source_target
  ON character_relationships(source_identity_id, target_identity_id, relationship_type);
CREATE INDEX idx_relationships_temporal_window
  ON character_relationships(revision_id, valid_from_ordinal, valid_to_ordinal);

CREATE TABLE character_relationship_evidence (
  id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL REFERENCES character_relationships(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('support','context','contradict')),
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(relationship_id, paragraph_id, exact_quote, evidence_role)
);

CREATE INDEX idx_relationship_evidence_relationship
  ON character_relationship_evidence(relationship_id);
CREATE INDEX idx_relationship_evidence_paragraph
  ON character_relationship_evidence(paragraph_id);
`,
  },
  {
    version: 15,
    sql: `
ALTER TABLE character_relationship_candidates ADD COLUMN source_fingerprint TEXT;

CREATE UNIQUE INDEX idx_relationship_candidates_source_fingerprint
  ON character_relationship_candidates(revision_id, source_fingerprint)
  WHERE source_fingerprint IS NOT NULL;

CREATE TABLE relationship_scan_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  chunk_plan_id TEXT NOT NULL REFERENCES chunk_plans(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  scan_mode TEXT NOT NULL DEFAULT 'local' CHECK(scan_mode IN ('local','model')),
  model TEXT,
  prompt_version TEXT NOT NULL DEFAULT 'relationship-local.v1',
  extractor_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed','cancelled')),
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, chunk_plan_id, extractor_version, input_hash)
  ,CHECK(scan_mode = 'local' OR model IS NOT NULL)
);

CREATE TABLE relationship_scan_chunk_results (
  run_id TEXT NOT NULL REFERENCES relationship_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  input_hash TEXT NOT NULL,
  raw_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, chunk_id)
);

CREATE INDEX idx_relationship_scan_chunks_run_status
  ON relationship_scan_chunk_results(run_id, status);

CREATE TABLE relationship_scan_candidate_sources (
  run_id TEXT NOT NULL REFERENCES relationship_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES character_relationship_candidates(id) ON DELETE CASCADE,
  candidate_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, candidate_id),
  UNIQUE(run_id, candidate_fingerprint)
);

CREATE INDEX idx_relationship_scan_candidate_sources_chunk
  ON relationship_scan_candidate_sources(run_id, chunk_id);

CREATE TABLE relationship_model_suggestions (
  candidate_id TEXT PRIMARY KEY REFERENCES character_relationship_candidates(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('directed','undirected','reciprocal')),
  strength REAL CHECK(strength IS NULL OR (strength >= 0 AND strength <= 1)),
  polarity REAL CHECK(polarity IS NULL OR (polarity >= -1 AND polarity <= 1)),
  information_source_type TEXT NOT NULL CHECK(information_source_type IN ('narrator','character','unknown')),
  information_source_identity_id TEXT REFERENCES person_identities(id) ON DELETE SET NULL,
  truth_status TEXT NOT NULL CHECK(truth_status IN ('asserted','suspected','disputed','false','unknown','rumor')),
  valid_from_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  valid_to_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  reasoning_note TEXT NOT NULL DEFAULT '',
  uncertainty TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK((information_source_type = 'character' AND information_source_identity_id IS NOT NULL)
    OR information_source_type != 'character')
);
`,
  },
  {
    version: 16,
    sql: `
CREATE TABLE place_identities (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  place_type TEXT NOT NULL DEFAULT 'other' CHECK(place_type IN (
    'realm','region','country','city','settlement','district','route','natural','building','room','landmark','other'
  )),
  description TEXT NOT NULL DEFAULT '',
  importance_score REAL NOT NULL DEFAULT 0 CHECK(importance_score >= 0 AND importance_score <= 1),
  first_revealed_paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE RESTRICT,
  first_revealed_ordinal INTEGER NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  extraction_method TEXT NOT NULL CHECK(extraction_method IN ('rule','model','user')),
  source_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, source_fingerprint)
);

CREATE INDEX idx_place_identities_revision_review_reveal
  ON place_identities(revision_id, review_status, first_revealed_ordinal);
CREATE INDEX idx_place_identities_revision_name
  ON place_identities(revision_id, normalized_name);

CREATE TABLE place_aliases (
  id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('event','model','user')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(place_id, normalized_alias)
);

CREATE INDEX idx_place_aliases_place_review ON place_aliases(place_id, review_status);

CREATE TABLE place_mentions (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  surface_text TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  source_event_location_id TEXT REFERENCES timeline_event_locations(id) ON DELETE SET NULL,
  extraction_method TEXT NOT NULL CHECK(extraction_method IN ('rule','model','user')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(char_start >= 0 AND char_end > char_start),
  UNIQUE(place_id, paragraph_id, char_start, char_end)
);

CREATE INDEX idx_place_mentions_place_review ON place_mentions(place_id, review_status);
CREATE INDEX idx_place_mentions_revision_paragraph ON place_mentions(revision_id, paragraph_id);

CREATE TABLE place_relation_candidates (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  source_place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  target_place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  candidate_method TEXT NOT NULL CHECK(candidate_method IN ('rule','model','user')),
  proposed_relation_kind TEXT,
  proposed_direction TEXT CHECK(proposed_direction IS NULL OR proposed_direction IN ('directed','undirected')),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  source_fingerprint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_place_id != target_place_id),
  UNIQUE(revision_id, source_fingerprint)
);

CREATE INDEX idx_place_relation_candidates_revision_review
  ON place_relation_candidates(revision_id, review_status);

CREATE TABLE place_relation_candidate_evidence (
  id TEXT PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES place_relation_candidates(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('clue','support','context','contradict')),
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(candidate_id, paragraph_id, exact_quote, evidence_role)
);

CREATE INDEX idx_place_relation_candidate_evidence_candidate
  ON place_relation_candidate_evidence(candidate_id);

CREATE TABLE place_relations (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  source_place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  target_place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  relation_kind TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('directed','undirected')),
  information_source_type TEXT NOT NULL CHECK(information_source_type IN ('narrator','character','unknown')),
  information_source_identity_id TEXT REFERENCES person_identities(id) ON DELETE SET NULL,
  truth_status TEXT NOT NULL CHECK(truth_status IN ('asserted','suspected','disputed','false','unknown','rumor')),
  valid_from_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  valid_to_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  valid_from_ordinal INTEGER,
  valid_to_ordinal INTEGER,
  first_revealed_paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE RESTRICT,
  first_revealed_ordinal INTEGER NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  extraction_method TEXT NOT NULL CHECK(extraction_method IN ('rule','model','user')),
  candidate_id TEXT REFERENCES place_relation_candidates(id) ON DELETE SET NULL,
  supersedes_relation_id TEXT REFERENCES place_relations(id) ON DELETE SET NULL,
  reasoning_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(source_place_id != target_place_id),
  CHECK(valid_to_ordinal IS NULL OR valid_from_ordinal IS NULL OR valid_from_ordinal <= valid_to_ordinal),
  CHECK((information_source_type = 'character' AND information_source_identity_id IS NOT NULL)
    OR information_source_type != 'character')
);

CREATE INDEX idx_place_relations_revision_review_reveal
  ON place_relations(revision_id, review_status, first_revealed_ordinal);
CREATE INDEX idx_place_relations_source_target
  ON place_relations(source_place_id, target_place_id, relation_kind);
CREATE INDEX idx_place_relations_temporal_window
  ON place_relations(revision_id, valid_from_ordinal, valid_to_ordinal);

CREATE TABLE place_relation_evidence (
  id TEXT PRIMARY KEY,
  relation_id TEXT NOT NULL REFERENCES place_relations(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('support','context','contradict')),
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(relation_id, paragraph_id, exact_quote, evidence_role)
);

CREATE INDEX idx_place_relation_evidence_relation ON place_relation_evidence(relation_id);
CREATE INDEX idx_place_relation_evidence_paragraph ON place_relation_evidence(paragraph_id);
`,
  },
  {
    version: 17,
    sql: `
CREATE TABLE place_identity_links (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  left_place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  right_place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK(relation IN ('must_link','cannot_link')),
  reason TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  review_status TEXT NOT NULL DEFAULT 'confirmed' CHECK(review_status IN ('pending','confirmed','rejected')),
  created_at TEXT NOT NULL,
  CHECK(left_place_id != right_place_id),
  UNIQUE(revision_id, left_place_id, right_place_id, relation)
);

CREATE INDEX idx_place_identity_links_revision_pair
  ON place_identity_links(revision_id, left_place_id, right_place_id, review_status);

CREATE TABLE place_identity_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK(operation IN ('merge','split','cannot_link','must_link','alias_review')),
  description TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'applied' CHECK(state IN ('applied','undone')),
  created_at TEXT NOT NULL,
  undone_at TEXT
);

CREATE INDEX idx_place_identity_operations_revision_state
  ON place_identity_operations(revision_id, state, id DESC);
`,
  },
  {
    version: 18,
    sql: `
CREATE TABLE place_model_scan_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  chunk_plan_id TEXT NOT NULL REFERENCES chunk_plans(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed','cancelled')),
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  alias_count INTEGER NOT NULL DEFAULT 0,
  identity_link_count INTEGER NOT NULL DEFAULT 0,
  relation_candidate_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, chunk_plan_id, extractor_version, input_hash)
);

CREATE TABLE place_model_scan_chunk_results (
  run_id TEXT NOT NULL REFERENCES place_model_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
  input_hash TEXT NOT NULL,
  raw_json TEXT,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  alias_count INTEGER NOT NULL DEFAULT 0,
  identity_link_count INTEGER NOT NULL DEFAULT 0,
  relation_candidate_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, chunk_id)
);

CREATE INDEX idx_place_model_scan_chunks_run_status
  ON place_model_scan_chunk_results(run_id, status);

CREATE TABLE place_alias_evidence (
  id TEXT PRIMARY KEY,
  alias_id TEXT NOT NULL REFERENCES place_aliases(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(alias_id, paragraph_id, exact_quote)
);

CREATE TABLE place_identity_link_evidence (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES place_identity_links(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  exact_quote TEXT NOT NULL,
  evidence_role TEXT NOT NULL CHECK(evidence_role IN ('support','context','contradict')),
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized')),
  created_at TEXT NOT NULL,
  UNIQUE(link_id, paragraph_id, exact_quote, evidence_role)
);

CREATE TABLE place_relation_model_suggestions (
  candidate_id TEXT PRIMARY KEY REFERENCES place_relation_candidates(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK(direction IN ('directed','undirected')),
  information_source_type TEXT NOT NULL CHECK(information_source_type IN ('narrator','character','unknown')),
  information_source_identity_id TEXT REFERENCES person_identities(id) ON DELETE SET NULL,
  truth_status TEXT NOT NULL CHECK(truth_status IN ('asserted','suspected','disputed','false','unknown','rumor')),
  valid_from_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  valid_to_event_id TEXT REFERENCES timeline_events(id) ON DELETE SET NULL,
  reasoning_note TEXT NOT NULL DEFAULT '',
  uncertainty TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  CHECK((information_source_type = 'character' AND information_source_identity_id IS NOT NULL)
    OR information_source_type != 'character')
);

CREATE TABLE place_model_alias_sources (
  run_id TEXT NOT NULL REFERENCES place_model_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  alias_id TEXT NOT NULL REFERENCES place_aliases(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, alias_id),
  UNIQUE(run_id, fingerprint)
);

CREATE TABLE place_model_identity_link_sources (
  run_id TEXT NOT NULL REFERENCES place_model_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES place_identity_links(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, link_id),
  UNIQUE(run_id, fingerprint)
);

CREATE TABLE place_model_relation_candidate_sources (
  run_id TEXT NOT NULL REFERENCES place_model_scan_runs(id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES place_relation_candidates(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, candidate_id),
  UNIQUE(run_id, fingerprint)
);
`,
  },
  {
    version: 19,
    sql: `
CREATE TABLE place_geometries (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL REFERENCES place_identities(id) ON DELETE CASCADE,
  coordinate_system TEXT NOT NULL DEFAULT 'WGS84' CHECK(coordinate_system = 'WGS84'),
  geometry_type TEXT NOT NULL DEFAULT 'Point' CHECK(geometry_type = 'Point'),
  longitude REAL NOT NULL CHECK(longitude >= -180 AND longitude <= 180),
  latitude REAL NOT NULL CHECK(latitude >= -90 AND latitude <= 90),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manual','gazetteer')),
  source_label TEXT NOT NULL DEFAULT '',
  source_uri TEXT,
  certainty TEXT NOT NULL DEFAULT 'certain' CHECK(certainty IN ('certain','less_certain','uncertain')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','confirmed','rejected')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(revision_id, place_id),
  CHECK(source_uri IS NULL OR length(trim(source_uri)) > 0)
);

CREATE INDEX idx_place_geometries_revision_review
  ON place_geometries(revision_id, review_status, place_id);
`,
  },
  {
    version: 20,
    sql: `
CREATE TABLE source_spans (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  start_utf16 INTEGER,
  end_utf16 INTEGER,
  offset_unit TEXT NOT NULL DEFAULT 'utf16-code-unit-v1' CHECK(offset_unit = 'utf16-code-unit-v1'),
  exact_quote TEXT NOT NULL,
  quote_sha256 TEXT NOT NULL,
  prefix_text TEXT NOT NULL DEFAULT '',
  suffix_text TEXT NOT NULL DEFAULT '',
  alignment_status TEXT NOT NULL CHECK(alignment_status IN ('exact','normalized','ambiguous','invalid')),
  created_at TEXT NOT NULL,
  validated_at TEXT NOT NULL,
  CHECK((start_utf16 IS NULL AND end_utf16 IS NULL)
    OR (start_utf16 IS NOT NULL AND end_utf16 IS NOT NULL AND start_utf16 >= 0 AND end_utf16 > start_utf16)),
  UNIQUE(revision_id, paragraph_id, start_utf16, end_utf16, quote_sha256)
);

CREATE INDEX idx_source_spans_paragraph
  ON source_spans(revision_id, paragraph_id, start_utf16, end_utf16);
CREATE INDEX idx_source_spans_status
  ON source_spans(revision_id, alignment_status);

ALTER TABLE evidence_anchors ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE person_aliases ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE person_mentions ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE character_fact_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE character_quotes ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE character_quote_attributions ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE timeline_event_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE timeline_time_expressions ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE timeline_event_relations ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE character_relationship_candidate_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE character_relationship_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE place_mentions ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE place_relation_candidate_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE place_relation_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE place_alias_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;
ALTER TABLE place_identity_link_evidence ADD COLUMN source_span_id TEXT REFERENCES source_spans(id) ON DELETE SET NULL;

CREATE INDEX idx_person_mentions_source_span ON person_mentions(source_span_id);
CREATE INDEX idx_character_fact_evidence_source_span ON character_fact_evidence(source_span_id);
CREATE INDEX idx_timeline_event_evidence_source_span ON timeline_event_evidence(source_span_id);
CREATE INDEX idx_character_relationship_candidate_evidence_source_span ON character_relationship_candidate_evidence(source_span_id);
CREATE INDEX idx_character_relationship_evidence_source_span ON character_relationship_evidence(source_span_id);
CREATE INDEX idx_place_mentions_source_span ON place_mentions(source_span_id);
CREATE INDEX idx_place_relation_candidate_evidence_source_span ON place_relation_candidate_evidence(source_span_id);
CREATE INDEX idx_place_relation_evidence_source_span ON place_relation_evidence(source_span_id);
`,
  },
  {
    version: 21,
    sql: `
ALTER TABLE paragraphs ADD COLUMN blank_lines_before INTEGER NOT NULL DEFAULT 0 CHECK(blank_lines_before >= 0);
ALTER TABLE paragraphs ADD COLUMN boundary_before TEXT NOT NULL DEFAULT 'paragraph'
  CHECK(boundary_before IN ('document','chapter','scene','blank_line','paragraph'));

UPDATE paragraphs
SET boundary_before = 'chapter'
WHERE EXISTS (
  SELECT 1 FROM chapters c
  WHERE c.revision_id = paragraphs.revision_id AND c.paragraph_start = paragraphs.ordinal
);
UPDATE paragraphs
SET boundary_before = 'document'
WHERE ordinal = (SELECT MIN(p2.ordinal) FROM paragraphs p2 WHERE p2.revision_id = paragraphs.revision_id)
  AND boundary_before = 'paragraph';

ALTER TABLE chunk_plans ADD COLUMN algorithm_version TEXT NOT NULL DEFAULT 'paragraph-v1';
ALTER TABLE chunk_plans ADD COLUMN input_hash TEXT;
CREATE INDEX idx_chunk_plans_revision_input ON chunk_plans(revision_id, input_hash, version DESC);

ALTER TABLE chunks ADD COLUMN core_character_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN context_character_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN boundary_reason TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE chunks ADD COLUMN oversized INTEGER NOT NULL DEFAULT 0 CHECK(oversized IN (0,1));
ALTER TABLE chunks ADD COLUMN content_hash TEXT;

UPDATE chunks
SET core_character_count = COALESCE((
      SELECT SUM(LENGTH(p.text)) FROM chunk_members cm
      JOIN paragraphs p ON p.id = cm.paragraph_id
      WHERE cm.chunk_id = chunks.id AND cm.role = 'core'
    ), 0),
    context_character_count = character_count;
`,
  },
  {
    version: 22,
    sql: `
CREATE TABLE foundation_workflow_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  profile TEXT NOT NULL DEFAULT 'foundation-v1',
  model TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','failed','cancelled')),
  current_step_key TEXT,
  total_steps INTEGER NOT NULL,
  completed_steps INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_foundation_workflow_runs_project
  ON foundation_workflow_runs(project_id, revision_id, created_at DESC);
CREATE INDEX idx_foundation_workflow_runs_state
  ON foundation_workflow_runs(project_id, state, updated_at DESC);

CREATE TABLE foundation_workflow_steps (
  run_id TEXT NOT NULL REFERENCES foundation_workflow_runs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','paused','completed','failed','skipped','cancelled')),
  progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
  message TEXT NOT NULL DEFAULT '',
  child_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  output_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, step_key),
  UNIQUE(run_id, ordinal)
);
CREATE INDEX idx_foundation_workflow_steps_state
  ON foundation_workflow_steps(run_id, state, ordinal);
`,
  },
  {
    version: 23,
    sql: `
UPDATE foundation_workflow_steps
SET ordinal = ordinal + 10
WHERE step_key = 'summary';

INSERT INTO foundation_workflow_steps
  (run_id, step_key, ordinal, state, progress, message, finished_at, updated_at)
SELECT id, 'draft_selection', 3,
  CASE
    WHEN state = 'completed' THEN 'skipped'
    WHEN state = 'cancelled' THEN 'cancelled'
    ELSE 'pending'
  END,
  CASE WHEN state = 'completed' THEN 1 ELSE 0 END,
  CASE
    WHEN state = 'completed' THEN '第一批历史运行未包含自动草稿选择'
    WHEN state = 'cancelled' THEN '历史运行已经取消'
    ELSE '自动草稿选择等待执行'
  END,
  CASE WHEN state IN ('completed','cancelled') THEN updated_at ELSE NULL END,
  updated_at
FROM foundation_workflow_runs;

UPDATE foundation_workflow_steps
SET ordinal = 4
WHERE step_key = 'summary';

UPDATE foundation_workflow_runs
SET total_steps = 5,
    completed_steps = completed_steps + CASE WHEN state = 'completed' THEN 1 ELSE 0 END;

CREATE TABLE automation_draft_selection_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  profile TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','failed','cancelled')),
  total_candidates INTEGER NOT NULL DEFAULT 0,
  processed_candidates INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, profile, policy_version, input_hash)
);
CREATE INDEX idx_automation_draft_selection_runs_project
  ON automation_draft_selection_runs(project_id, revision_id, created_at DESC);
CREATE INDEX idx_automation_draft_selection_runs_state
  ON automation_draft_selection_runs(project_id, state, updated_at DESC);

CREATE TABLE automation_draft_selection_items (
  run_id TEXT NOT NULL REFERENCES automation_draft_selection_runs(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  identity_name TEXT NOT NULL,
  input_snapshot_json TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
  selected INTEGER CHECK(selected IN (0,1)),
  reason_code TEXT,
  reason TEXT,
  review_status_snapshot TEXT NOT NULL CHECK(review_status_snapshot IN ('pending','confirmed','rejected')),
  importance_tier_snapshot TEXT NOT NULL CHECK(importance_tier_snapshot IN ('core','important','minor','incidental','pending')),
  importance_score_snapshot REAL NOT NULL,
  mention_count_snapshot INTEGER NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, identity_id),
  UNIQUE(run_id, ordinal)
);
CREATE INDEX idx_automation_draft_selection_items_status
  ON automation_draft_selection_items(run_id, status, ordinal);
CREATE INDEX idx_automation_draft_selection_items_selected
  ON automation_draft_selection_items(run_id, selected, ordinal);
`,
  },
  {
    version: 24,
    sql: `
UPDATE foundation_workflow_steps
SET ordinal = ordinal + 10
WHERE step_key = 'summary';

INSERT INTO foundation_workflow_steps
  (run_id, step_key, ordinal, state, progress, message, finished_at, updated_at)
SELECT id, 'character_facts', 4,
  CASE
    WHEN state = 'completed' THEN 'skipped'
    WHEN state = 'cancelled' THEN 'cancelled'
    ELSE 'pending'
  END,
  CASE WHEN state = 'completed' THEN 1 ELSE 0 END,
  CASE
    WHEN state = 'completed' THEN '第二批历史运行未包含人物事实草稿'
    WHEN state = 'cancelled' THEN '历史运行已经取消'
    ELSE '人物事实草稿等待执行'
  END,
  CASE WHEN state IN ('completed','cancelled') THEN updated_at ELSE NULL END,
  updated_at
FROM foundation_workflow_runs;

INSERT INTO foundation_workflow_steps
  (run_id, step_key, ordinal, state, progress, message, finished_at, updated_at)
SELECT id, 'dialogue_scan', 5,
  CASE
    WHEN state = 'completed' THEN 'skipped'
    WHEN state = 'cancelled' THEN 'cancelled'
    ELSE 'pending'
  END,
  CASE WHEN state = 'completed' THEN 1 ELSE 0 END,
  CASE
    WHEN state = 'completed' THEN '第二批历史运行未包含对白草稿'
    WHEN state = 'cancelled' THEN '历史运行已经取消'
    ELSE '对白草稿等待执行'
  END,
  CASE WHEN state IN ('completed','cancelled') THEN updated_at ELSE NULL END,
  updated_at
FROM foundation_workflow_runs;

UPDATE foundation_workflow_steps
SET ordinal = 6
WHERE step_key = 'summary';

UPDATE foundation_workflow_runs
SET total_steps = 7,
    completed_steps = completed_steps + CASE WHEN state = 'completed' THEN 2 ELSE 0 END;

ALTER TABLE character_fact_runs
  ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'human-confirmed'
  CHECK(input_mode IN ('human-confirmed','automation-draft-selection'));
ALTER TABLE character_fact_runs
  ADD COLUMN draft_selection_run_id TEXT REFERENCES automation_draft_selection_runs(id) ON DELETE SET NULL;
ALTER TABLE character_fact_runs
  ADD COLUMN draft_selection_item_hash TEXT;
CREATE INDEX idx_character_fact_runs_draft_selection
  ON character_fact_runs(draft_selection_run_id, identity_id, status);

CREATE TABLE automation_draft_quote_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  selection_run_id TEXT NOT NULL REFERENCES automation_draft_selection_runs(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','paused','completed','failed','cancelled')),
  total_paragraphs INTEGER NOT NULL DEFAULT 0,
  completed_paragraphs INTEGER NOT NULL DEFAULT 0,
  quote_count INTEGER NOT NULL DEFAULT 0,
  attribution_count INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, selection_run_id, algorithm_version, input_hash)
);
CREATE INDEX idx_automation_draft_quote_runs_project
  ON automation_draft_quote_runs(project_id, revision_id, created_at DESC);
CREATE INDEX idx_automation_draft_quote_runs_state
  ON automation_draft_quote_runs(project_id, state, updated_at DESC);

CREATE TABLE automation_draft_quote_items (
  run_id TEXT NOT NULL REFERENCES automation_draft_quote_runs(id) ON DELETE CASCADE,
  paragraph_id TEXT NOT NULL REFERENCES paragraphs(id) ON DELETE CASCADE,
  paragraph_ordinal INTEGER NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed','cancelled')),
  quote_count INTEGER NOT NULL DEFAULT 0,
  attribution_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, paragraph_id),
  UNIQUE(run_id, paragraph_ordinal)
);
CREATE INDEX idx_automation_draft_quote_items_status
  ON automation_draft_quote_items(run_id, status, paragraph_ordinal);
`,
  },
  {
    version: 25,
    sql: `
UPDATE foundation_workflow_steps
SET ordinal = ordinal + 10
WHERE step_key = 'summary';

INSERT INTO foundation_workflow_steps
  (run_id, step_key, ordinal, state, progress, message, finished_at, updated_at)
SELECT id, step_key, ordinal,
  CASE
    WHEN state = 'completed' THEN 'skipped'
    WHEN state = 'cancelled' THEN 'cancelled'
    ELSE 'pending'
  END,
  CASE WHEN state = 'completed' THEN 1 ELSE 0 END,
  CASE
    WHEN state = 'completed' THEN '第三批历史运行未包含世界草稿步骤'
    WHEN state = 'cancelled' THEN '历史运行已经取消'
    ELSE label || '等待执行'
  END,
  CASE WHEN state IN ('completed','cancelled') THEN updated_at ELSE NULL END,
  updated_at
FROM foundation_workflow_runs
CROSS JOIN (
  SELECT 'time_expressions' AS step_key, 6 AS ordinal, '时间表达式草稿' AS label
  UNION ALL SELECT 'event_drafts', 7, '事件草稿'
  UNION ALL SELECT 'place_drafts', 8, '地点草稿'
  UNION ALL SELECT 'relationship_drafts', 9, '关系草稿'
);

UPDATE foundation_workflow_steps
SET ordinal = 10
WHERE step_key = 'summary';

UPDATE foundation_workflow_runs
SET total_steps = 11,
    completed_steps = completed_steps + CASE WHEN state = 'completed' THEN 4 ELSE 0 END;

ALTER TABLE timeline_event_runs
  ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK(input_mode IN ('standard','automation-draft-selection'));
ALTER TABLE timeline_event_runs
  ADD COLUMN draft_selection_run_id TEXT REFERENCES automation_draft_selection_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_timeline_event_runs_draft_selection
  ON timeline_event_runs(draft_selection_run_id, status, created_at DESC);

ALTER TABLE relationship_scan_runs
  ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'standard'
  CHECK(input_mode IN ('standard','automation-draft-selection'));
ALTER TABLE relationship_scan_runs
  ADD COLUMN draft_selection_run_id TEXT REFERENCES automation_draft_selection_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_relationship_scan_runs_draft_selection
  ON relationship_scan_runs(draft_selection_run_id, status, created_at DESC);

CREATE TABLE automation_draft_time_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  selection_run_id TEXT NOT NULL REFERENCES automation_draft_selection_runs(id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  detected_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  total_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  normalized_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, selection_run_id, algorithm_version, input_hash)
);
CREATE INDEX idx_automation_draft_time_runs_project
  ON automation_draft_time_runs(project_id, revision_id, created_at DESC);

CREATE TABLE automation_draft_place_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  selection_run_id TEXT NOT NULL REFERENCES automation_draft_selection_runs(id) ON DELETE CASCADE,
  event_run_id TEXT NOT NULL REFERENCES timeline_event_runs(id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  source_location_count INTEGER NOT NULL DEFAULT 0,
  created_place_count INTEGER NOT NULL DEFAULT 0,
  created_mention_count INTEGER NOT NULL DEFAULT 0,
  skipped_unaligned_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, revision_id, selection_run_id, event_run_id, algorithm_version, input_hash)
);
CREATE INDEX idx_automation_draft_place_runs_project
  ON automation_draft_place_runs(project_id, revision_id, created_at DESC);
`,
  },
  {
    version: 26,
    sql: `
CREATE TABLE character_runtime_turns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  entry_event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  question TEXT NOT NULL,
  context_fingerprint TEXT NOT NULL,
  claim_rules_json TEXT NOT NULL,
  forbidden_meta_terms_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','delivered','blocked','failed')),
  first_candidate TEXT NOT NULL DEFAULT '',
  final_candidate TEXT NOT NULL DEFAULT '',
  delivered_answer TEXT NOT NULL DEFAULT '',
  gate_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 2),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_character_runtime_turns_identity_created
  ON character_runtime_turns(revision_id, identity_id, created_at DESC);
`,
  },
  {
    version: 27,
    sql: `
CREATE TABLE character_runtime_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES source_revisions(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES person_identities(id) ON DELETE CASCADE,
  entry_event_id TEXT NOT NULL REFERENCES timeline_events(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  card_source_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','closed')),
  max_history_turns INTEGER NOT NULL DEFAULT 6 CHECK(max_history_turns BETWEEN 1 AND 12),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_character_runtime_sessions_identity_updated
  ON character_runtime_sessions(revision_id, identity_id, updated_at DESC);

ALTER TABLE character_runtime_turns
  ADD COLUMN session_id TEXT REFERENCES character_runtime_sessions(id) ON DELETE CASCADE;
ALTER TABLE character_runtime_turns
  ADD COLUMN turn_index INTEGER;
CREATE UNIQUE INDEX idx_character_runtime_turns_session_index
  ON character_runtime_turns(session_id, turn_index) WHERE session_id IS NOT NULL;
`,
  },
  {
    version: 28,
    sql: `
ALTER TABLE character_runtime_sessions
  ADD COLUMN retrieval_mode TEXT NOT NULL DEFAULT 'off'
  CHECK(retrieval_mode IN ('off','explainable-v1'));
ALTER TABLE character_runtime_turns
  ADD COLUMN retrieval_json TEXT;
ALTER TABLE character_runtime_turns
  ADD COLUMN retrieval_approx_tokens INTEGER NOT NULL DEFAULT 0;
`,
  },
];
