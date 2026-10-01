import type { ApiRequestSettings } from './api-request-settings';
import { z } from 'zod';
import type { EpistemicOutputGateResult, OutputClaimRule } from './epistemic-output-gate';

export const chunkSettingsSchema = z.object({
  coreChars: z.number().int().min(1000).max(50_000).default(8000),
  softLimit: z.number().int().min(1000).max(60_000).default(10_000),
  hardLimit: z.number().int().min(1000).max(80_000).default(12_000),
  overlapBefore: z.number().int().min(0).max(5000).default(500),
  overlapAfter: z.number().int().min(0).max(5000).default(500),
}).refine((value) => value.coreChars <= value.softLimit && value.softLimit <= value.hardLimit, {
  message: '分块限制必须满足核心 ≤ 软上限 ≤ 硬上限',
});

export type ChunkSettings = z.infer<typeof chunkSettingsSchema>;

export type EncodingCandidate = {
  encoding: string;
  score: number;
  detectorConfidence: number;
  replacementRate: number;
  chineseRate: number;
  controlRate: number;
  preview: string;
};

export type ProjectSummary = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  activeRevisionId: string | null;
};

export type ProjectBundleAvailability = {
  state: 'no-source' | 'not-exported' | 'invalid' | 'ready-for-assembly';
  message: string;
  packageDirectory: string | null;
  specVersion: '1.0' | '2.0' | null;
  characterCount: number;
};

export type ProjectDiagnosticStatus = 'ok' | 'warning' | 'error';

export type ProjectDiagnosticCheck = {
  id: 'manifest' | 'schema' | 'storage' | 'database' | 'fts' | 'source' | 'source-spans' | 'backups';
  label: string;
  status: ProjectDiagnosticStatus;
  summary: string;
  detail?: string;
};

export type ProjectDiagnosticReport = {
  checkedAt: string;
  mode: 'quick' | 'full';
  durationMs: number;
  overallStatus: ProjectDiagnosticStatus;
  schemaVersion: number;
  expectedSchemaVersion: number;
  storageEngine: string | null;
  paragraphCount: number;
  ftsRowCount: number;
  sourceSpanCount: number;
  unresolvedSourceSpanCount: number;
  foreignKeyViolationCount: number;
  internalBackupCount: number;
  latestInternalBackup: string | null;
  source: {
    revisionId: string;
    originalName: string;
    encoding: string;
    byteSize: number;
    sha256: string;
    originalPath: string;
    normalizedPath: string;
    originalExists: boolean;
    normalizedExists: boolean;
    checksumMatches: boolean | null;
  } | null;
  checks: ProjectDiagnosticCheck[];
};

export type ImportPreview = {
  sourcePath: string;
  byteSize: number;
  candidates: EncodingCandidate[];
  recommendedEncoding: string;
};

export type ImportResult = {
  revisionId: string;
  encoding: string;
  sha256: string;
  byteSize: number;
  characterCount: number;
  chapterCount: number;
  paragraphCount: number;
};

export type ChapterRecord = {
  id: string;
  ordinal: number;
  title: string;
  paragraphStart: number;
  paragraphEnd: number;
  characterCount: number;
  detectionScore: number;
  manuallyEdited: boolean;
};

export type ParagraphRecord = {
  id: string;
  ordinal: number;
  chapterId: string | null;
  text: string;
  utf8Start: number;
  utf8End: number;
  excluded: boolean;
};

export type ChunkRecord = {
  id: string;
  ordinal: number;
  chapterId: string | null;
  coreStartOrdinal: number;
  coreEndOrdinal: number;
  contextStartOrdinal: number;
  contextEndOrdinal: number;
  characterCount: number;
  coreCharacterCount: number;
  contextCharacterCount: number;
  boundaryReason: 'document_end' | 'chapter' | 'scene' | 'blank_line' | 'soft_limit' | 'target' | 'oversized_paragraph' | 'legacy';
  oversized: boolean;
  contentHash: string | null;
};

export type ChunkParagraphRecord = ParagraphRecord & {
  chapterTitle: string | null;
  role: 'context_before' | 'core' | 'context_after';
  ordinalInChunk: number;
};

export type ChunkInspection = {
  chunk: ChunkRecord;
  paragraphs: ChunkParagraphRecord[];
};

export type SearchHit = {
  paragraphId: string;
  chapterTitle: string | null;
  ordinal: number;
  snippet: string;
};

export type EvidenceAnchorRecord = {
  id: string;
  revisionId: string;
  paragraphId: string;
  utf8Start: number;
  utf8End: number;
  quote: string;
  quoteHash: string;
  prefixHash: string | null;
  suffixHash: string | null;
};

export type SourceSpanAlignment = 'exact' | 'normalized' | 'ambiguous' | 'invalid';

export type SourceSpanInspection = {
  id: string;
  revisionId: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  paragraphText: string;
  startUtf16: number | null;
  endUtf16: number | null;
  exactQuote: string;
  quoteSha256: string;
  prefixText: string;
  suffixText: string;
  alignmentStatus: SourceSpanAlignment;
};

export type JobRecord = {
  id: string;
  type: string;
  state: 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  updatedAt: string;
};

export type RefinementSeverity = 'must' | 'recommended' | 'later';
export type RefinementTargetView =
  | 'foundation-workflow'
  | 'characters'
  | 'quotes'
  | 'fact-review'
  | 'timeline'
  | 'places'
  | 'relationships'
  | 'jobs'
  | 'diagnostics';
export type RefinementIssueKind =
  | 'workflow-incomplete'
  | 'source-alignment'
  | 'selected-character-review'
  | 'fact-conflict-review'
  | 'character-fact-review'
  | 'character-alias-review'
  | 'quote-attribution-review'
  | 'event-review'
  | 'place-review'
  | 'relationship-candidate-review'
  | 'formal-relationship-review'
  | 'timeline-relation-review'
  | 'identity-link-review'
  | 'place-identity-link-review'
  | 'place-alias-review'
  | 'place-relation-candidate-review'
  | 'formal-place-relation-review'
  | 'remaining-character-review'
  | 'time-expression-review'
  | 'place-geometry-review'
  | 'cooccurrence-review';

export type RefinementIssue = {
  id: string;
  severity: RefinementSeverity;
  kind: RefinementIssueKind;
  title: string;
  summary: string;
  count: number;
  targetView: RefinementTargetView;
  samples: string[];
  rule: string;
};

export type RefinementDashboard = {
  revisionId: string;
  policyVersion: string;
  generatedAt: string;
  foundationRunId: string | null;
  selectionRunId: string | null;
  readyForArtifactDrafts: boolean;
  counts: Record<RefinementSeverity, number>;
  issues: RefinementIssue[];
};
export type ArtifactFoundationKind = 'character-cards' | 'relationship-graph' | 'narrative-map';
export type ArtifactFoundationStatus = 'blocked' | 'missing' | 'needs-review' | 'ready';
export type ArtifactFoundationTargetView = 'refinement' | 'character-cards' | 'relationship-graph' | 'narrative-map';

export type ArtifactFoundationIssue = {
  severity: 'blocker' | 'warning' | 'info';
  code: string;
  message: string;
  count: number;
};

export type ArtifactFoundationGate = {
  kind: ArtifactFoundationKind;
  title: string;
  status: ArtifactFoundationStatus;
  canGenerate: boolean;
  foundationReady: boolean;
  exportReady: boolean;
  targetView: ArtifactFoundationTargetView;
  metrics: Array<{ label: string; value: number }>;
  issues: ArtifactFoundationIssue[];
  sourceFingerprint: string | null;
};

export type ArtifactFoundationDashboard = {
  revisionId: string;
  policyVersion: string;
  generatedAt: string;
  refinementReady: boolean;
  canGenerate: boolean;
  entryEvent: { id: string; title: string; narrativeOrdinal: number } | null;
  gates: ArtifactFoundationGate[];
};

export type ArtifactFoundationGenerationResult = {
  generatedAt: string;
  entryEvent: { id: string; title: string; narrativeOrdinal: number };
  characterCards: CharacterCardBatchGenerationSummary;
  relationshipGraph: { nodeCount: number; relationshipCount: number; evidenceCount: number; sourceFingerprint: string };
  narrativeMap: { nodeCount: number; relationCount: number; eventCount: number; evidenceCount: number; sourceFingerprint: string };
  dashboard: ArtifactFoundationDashboard;
};

export type AutomaticFinalizationResult = {
  policyVersion: string;
  revisionId: string;
  selectionRunId: string;
  finalizedAt: string;
  counts: Record<string, number>;
  entryEvent: { id: string; title: string; narrativeOrdinal: number } | null;
  artifactGeneration: ArtifactFoundationGenerationResult | null;
  playableBundle: PlayableBundleExportResult | null;
  warnings: string[];
};

export type FoundationWorkflowControlAction = 'pause' | 'resume' | 'cancel' | 'retry';
export type FoundationWorkflowStepKey =
  | 'preflight'
  | 'chunks'
  | 'character_scan'
  | 'draft_selection'
  | 'character_facts'
  | 'dialogue_scan'
  | 'time_expressions'
  | 'event_drafts'
  | 'place_drafts'
  | 'relationship_drafts'
  | 'summary';
export type FoundationWorkflowStepState = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export type FoundationWorkflowStepRecord = {
  stepKey: FoundationWorkflowStepKey;
  ordinal: number;
  state: FoundationWorkflowStepState;
  progress: number;
  message: string;
  childJobId: string | null;
  outputJson: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
};

export type FoundationWorkflowRunRecord = {
  id: string;
  jobId: string;
  revisionId: string;
  profile: string;
  model: string;
  tokenBudget: number | null;
  inputHash: string;
  state: JobRecord['state'];
  currentStepKey: FoundationWorkflowStepKey | null;
  totalSteps: number;
  completedSteps: number;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  steps: FoundationWorkflowStepRecord[];
};

export type FoundationWorkflowStart = {
  runId: string;
  jobId: string;
  state: JobRecord['state'];
  reused: boolean;
};

export type FoundationUsageSummary = {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  attempts: number;
  localCacheHits: number;
  failedAttempts: number;
  unreportedAttempts: number;
  stages: Record<string, {
    inputTokens: number; outputTokens: number; cacheHitTokens: number; cacheMissTokens: number;
    attempts: number; localCacheHits: number; failedAttempts: number; unreportedAttempts: number;
  }>;
};

export type AutomationDraftSelectionReasonCode =
  | 'human-confirmed'
  | 'high-importance'
  | 'fallback-with-evidence'
  | 'human-rejected'
  | 'no-evidence'
  | 'automatic-limit'
  | 'low-importance';

export type AutomationDraftSelectionItemRecord = {
  identityId: string;
  identityName: string;
  ordinal: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  selected: boolean | null;
  reasonCode: AutomationDraftSelectionReasonCode | null;
  reason: string | null;
  reviewStatusSnapshot: 'pending' | 'confirmed' | 'rejected';
  importanceTierSnapshot: CharacterCandidate['importanceTier'];
  importanceScoreSnapshot: number;
  mentionCountSnapshot: number;
  updatedAt: string;
};

export type AutomationDraftTimeRunRecord = TimeExpressionScanSummary & {
  id: string;
  revisionId: string;
  selectionRunId: string;
  algorithmVersion: string;
  inputHash: string;
  reused: boolean;
  createdAt: string;
};

export type AutomationDraftPlaceRunRecord = PlaceBootstrapSummary & {
  id: string;
  revisionId: string;
  selectionRunId: string;
  eventRunId: string;
  algorithmVersion: string;
  inputHash: string;
  reused: boolean;
  createdAt: string;
};

export type AutomationDraftSelectionRunRecord = {
  id: string;
  jobId: string;
  revisionId: string;
  profile: string;
  policyVersion: string;
  inputHash: string;
  state: JobRecord['state'];
  totalCandidates: number;
  processedCandidates: number;
  selectedCount: number;
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  items: AutomationDraftSelectionItemRecord[];
};

export type AutomationDraftSelectionStart = {
  runId: string;
  jobId: string;
  state: JobRecord['state'];
  reused: boolean;
};

export type AutomationDraftQuoteItemRecord = {
  paragraphId: string;
  paragraphOrdinal: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  quoteCount: number;
  attributionCount: number;
  error: string | null;
  updatedAt: string;
};

export type AutomationDraftQuoteRunRecord = {
  id: string;
  jobId: string;
  revisionId: string;
  selectionRunId: string;
  algorithmVersion: string;
  inputHash: string;
  state: JobRecord['state'];
  totalParagraphs: number;
  completedParagraphs: number;
  quoteCount: number;
  attributionCount: number;
  progress: number;
  message: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  items: AutomationDraftQuoteItemRecord[];
};

export type AutomationDraftQuoteStart = {
  runId: string;
  jobId: string;
  state: JobRecord['state'];
  reused: boolean;
};

export type ApiStatus = {
  requestSettings?: ApiRequestSettings;
  configured: boolean;
  provider: string | null;
  baseUrl: string | null;
  preferredModel: string | null;
};

export type ApiModelList = { models: string[] };

export const characterScanOutputSchema = z.object({
  characters: z.array(z.object({
    local_key: z.string().min(1).max(80),
    display_name: z.string().trim().min(1).max(100),
    mention_forms: z.array(z.object({
      text: z.string().trim().min(1).max(100),
      kind: z.enum(['name', 'alias', 'title', 'kinship', 'role', 'pronoun', 'other']),
    })).max(30).default([]),
    entity_kind: z.enum(['human', 'nonhuman', 'deity_spirit', 'artificial', 'persona', 'unknown']).default('unknown'),
    role_hints: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
    has_dialogue: z.boolean().default(false),
    participates_in_event: z.boolean().default(false),
    evidence: z.array(z.object({
      paragraph_id: z.string().min(1),
      exact_quote: z.string().trim().min(1).max(500),
      supports: z.enum(['existence', 'name', 'alias', 'identity', 'dialogue', 'event']),
    })).min(1).max(20),
    confidence: z.number().min(0).max(1),
    uncertainty: z.string().max(500).default(''),
  })).max(100),
  identity_claims: z.array(z.object({
    left_local_key: z.string().min(1).max(80),
    right_local_key: z.string().min(1).max(80),
    relation: z.enum(['same_person', 'different_person', 'uncertain']),
    reason: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
    evidence_paragraph_ids: z.array(z.string().min(1)).max(20).default([]),
  })).max(100).default([]),
});

export type CharacterScanOutput = z.infer<typeof characterScanOutputSchema>;

export type CharacterScanEstimate = {
  chunkPlanId: string | null;
  chunkCount: number;
  characterCount: number;
  approximateInputTokens: number;
  ready: boolean;
};

export type CharacterScanStart = {
  jobId: string;
  runId: string;
  state: JobRecord['state'];
  reused: boolean;
};

export type CharacterScanParagraph = {
  paragraphId: string;
  ordinal: number;
  chapterTitle: string | null;
  role: 'core' | 'context_before' | 'context_after';
  text: string;
};

export type CharacterScanWorkItem = {
  jobId: string;
  runId: string;
  chunkId: string;
  chunkOrdinal: number;
  model: string;
  promptVersion: string;
  paragraphs: CharacterScanParagraph[];
};

export type CharacterCandidate = {
  id: string;
  canonicalName: string;
  aliases: string[];
  entityType: string;
  importanceTier: 'core' | 'important' | 'minor' | 'incidental' | 'pending';
  importanceScore: number;
  reviewStatus: 'pending' | 'confirmed' | 'rejected';
  mentionCount: number;
  chapterCount: number;
  dialogueCount: number;
  eventCount: number;
  firstOrdinal: number;
  lastOrdinal: number;
  uncertainty: string;
};

export type CharacterMentionRecord = {
  id: string;
  sourceSpanId: string | null;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  surfaceText: string;
  mentionType: string;
  exactQuote: string;
  supports: string;
  confidence: number;
  alignmentStatus: 'exact' | 'normalized';
};

export type CharacterAliasRecord = {
  id: string;
  alias: string;
  aliasType: string;
  confidence: number;
  reviewStatus: 'pending' | 'confirmed' | 'rejected';
  paragraphId: string | null;
  paragraphOrdinal: number | null;
  exactQuote: string | null;
};

export type IdentityOperationRecord = {
  id: string;
  operation: 'merge' | 'split' | 'cannot_link' | 'must_link' | 'alias_review';
  description: string;
  state: 'applied' | 'undone';
  createdAt: string;
  undoneAt: string | null;
};

export type CharacterIdentityLinkRecord = {
  id: string;
  otherIdentityId: string;
  otherName: string;
  relation: 'must_link' | 'cannot_link' | 'uncertain';
  reason: string;
  confidence: number;
  reviewStatus: 'pending' | 'confirmed' | 'rejected';
};

export const characterFactOutputSchema = z.object({
  facts: z.array(z.object({
    category: z.enum(['identity', 'appearance', 'personality', 'ability', 'motivation', 'background', 'status', 'secret', 'speech', 'relationship', 'other']),
    predicate: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(1000),
    source_type: z.enum(['explicit', 'inferred']),
    assertion_mode: z.enum(['narrator_assertion', 'self_report', 'other_report', 'rumor', 'belief', 'behavior_inference']).optional(),
    truth_status: z.enum(['asserted', 'suspected', 'disputed', 'false', 'unknown']).optional(),
    attributed_source_name: z.string().trim().min(1).max(100).nullable().optional(),
    extraction_pass: z.number().int().min(1).max(2).optional(),
    confidence: z.number().min(0).max(1),
    visibility: z.enum(['public', 'private', 'secret']).default('public'),
    valid_from_paragraph_id: z.string().nullable().default(null),
    valid_to_paragraph_id: z.string().nullable().default(null),
    evidence: z.array(z.object({
      paragraph_id: z.string().min(1),
      exact_quote: z.string().trim().min(1).max(500),
      role: z.enum(['support', 'context']),
    })).min(1).max(20),
    reasoning_note: z.string().max(500).default(''),
  })).max(200),
});

export type CharacterFactOutput = z.infer<typeof characterFactOutputSchema>;

export type CharacterFactEstimate = {
  identityId: string;
  paragraphCount: number;
  characterCount: number;
  batchCount: number;
  approximateInputTokens: number;
  ready: boolean;
};

export type CharacterFactWorkItem = {
  jobId: string;
  runId: string;
  identityId: string;
  identityName: string;
  batchOrdinal: number;
  model: string;
  promptVersion: string;
  extractionPasses: 1 | 2;
  inputMode: 'human-confirmed' | 'automation-draft-selection';
  draftSelectionRunId: string | null;
  paragraphs: Array<{ paragraphId: string; ordinal: number; chapterTitle: string | null; text: string }>;
};

export type CharacterFactRecord = {
  id: string;
  identityId: string;
  category: CharacterFactOutput['facts'][number]['category'];
  predicate: string;
  value: string;
  sourceType: 'explicit' | 'inferred' | 'user' | 'generated';
  assertionMode: 'narrator_assertion' | 'self_report' | 'other_report' | 'rumor' | 'belief' | 'behavior_inference';
  truthStatus: 'asserted' | 'suspected' | 'disputed' | 'false' | 'unknown';
  attributedSourceName: string | null;
  extractionPass: number;
  confidence: number;
  visibility: 'public' | 'private' | 'secret';
  validFromOrdinal: number | null;
  validToOrdinal: number | null;
  reviewStatus: 'pending' | 'confirmed' | 'rejected';
  reasoningNote: string;
  evidenceCount: number;
};

export type CharacterFactEvidenceRecord = {
  id: string;
  sourceSpanId: string | null;
  factId: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  exactQuote: string;
  evidenceRole: 'support' | 'context' | 'contradict';
  alignmentStatus: 'exact' | 'normalized';
};

export type QuoteScanSummary = {
  quoteCount: number;
  confirmedSpeakerCount: number;
  suggestedSpeakerCount: number;
  unresolvedCount: number;
};

export type CharacterQuoteRecord = {
  id: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  startOffset: number;
  endOffset: number;
  quoteText: string;
  quoteType: 'curly_double' | 'corner' | 'double_corner' | 'ascii_double' | 'dash';
  confirmedSpeakerId: string | null;
  confirmedSpeakerName: string | null;
  suggestedSpeakerName: string | null;
  candidateCount: number;
};

export type QuoteAttributionRecord = {
  id: string;
  quoteId: string;
  identityId: string;
  identityName: string;
  role: 'speaker' | 'addressee';
  method: 'explicit_cue' | 'nearby_context' | 'turn_taking' | 'style' | 'model' | 'user';
  confidence: number;
  reviewStatus: 'pending' | 'confirmed' | 'rejected';
  evidenceParagraphId: string | null;
  evidenceText: string;
  reasoning: string;
};

export type QuoteLocalAnalysisSummary = {
  createdCandidates: number;
  profileCount: number;
};

export type SpeechProfileRecord = {
  identityId: string;
  identityName: string;
  quoteCount: number;
  characterCount: number;
  averageLength: number;
  questionRate: number;
  exclamationRate: number;
  ellipsisRate: number;
  firstPersonRate: number;
  sentenceParticleRate: number;
  politenessRate: number;
  classicalRate: number;
  favoriteMarkers: string[];
  samples: Array<{ quoteId: string; quoteText: string; paragraphOrdinal: number }>;
};

export type FactConsolidationSummary = {
  clusterCount: number;
  memberCount: number;
  pendingRelationCount: number;
  transitionCount: number;
};

export type FactClusterRecord = {
  id: string;
  identityId: string;
  identityName: string;
  category: CharacterFactRecord['category'];
  canonicalPredicate: string;
  canonicalValue: string;
  firstObservedOrdinal: number | null;
  lastObservedOrdinal: number | null;
  reviewStatus: 'pending' | 'confirmed' | 'rejected';
  memberCount: number;
  confirmedMemberCount: number;
};

export type FactRelationKind = 'uncertain' | 'contradiction' | 'state_change' | 'coexists_by_time' | 'viewpoint_difference' | 'rumor_correction' | 'identity_disguise' | 'unrelated';

export type FactRelationRecord = {
  id: string;
  identityId: string;
  identityName: string;
  category: CharacterFactRecord['category'];
  predicate: string;
  leftClusterId: string;
  leftValue: string;
  leftObservedOrdinal: number | null;
  rightClusterId: string;
  rightValue: string;
  rightObservedOrdinal: number | null;
  proposedRelation: FactRelationKind;
  resolvedRelation: Exclude<FactRelationKind, 'uncertain'> | null;
  confidence: number;
  reason: string;
  reviewStatus: 'pending' | 'confirmed' | 'rejected';
};

export type CharacterStateTransitionRecord = {
  id: string;
  identityId: string;
  identityName: string;
  category: CharacterFactRecord['category'];
  predicate: string;
  fromValue: string;
  toValue: string;
  observedFromOrdinal: number | null;
  observedToOrdinal: number | null;
  triggerParagraphId: string | null;
  confidence: number;
};

export type TimelineEventType = 'action' | 'dialogue' | 'movement' | 'meeting' | 'conflict' | 'discovery' | 'state_change' | 'birth' | 'death' | 'other';
export type TimelineRelationKind = 'before' | 'after' | 'simultaneous' | 'includes' | 'is_included' | 'unknown';
export type TimeExpressionType = 'calendar' | 'clock' | 'relative' | 'duration' | 'frequency' | 'age' | 'era' | 'season' | 'unknown';
export type TimeExpressionReviewStatus = 'pending' | 'confirmed' | 'rejected';

export type TimeExpressionRecord = {
  id: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  startOffset: number;
  endOffset: number;
  surfaceText: string;
  expressionType: TimeExpressionType;
  normalizedValue: string | null;
  calendarSystem: 'gregorian' | 'lunar' | 'fictional' | 'relative' | 'unspecified';
  detectionMethod: 'rule' | 'model' | 'user';
  confidence: number;
  reviewStatus: TimeExpressionReviewStatus;
};

export type TimeExpressionScanSummary = {
  detectedCount: number;
  insertedCount: number;
  totalCount: number;
  pendingCount: number;
  confirmedCount: number;
  rejectedCount: number;
  normalizedCount: number;
};

export const timelineEventOutputSchema = z.object({
  events: z.array(z.object({
    local_key: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().max(1000).default(''),
    event_type: z.enum(['action', 'dialogue', 'movement', 'meeting', 'conflict', 'discovery', 'state_change', 'birth', 'death', 'other']),
    participants: z.array(z.object({
      identity_id: z.string().trim().min(1).nullable().default(null),
      surface_name: z.string().trim().min(1).max(100),
      role: z.enum(['actor', 'target', 'witness', 'speaker', 'addressee', 'participant', 'other']).default('participant'),
      action_text: z.string().trim().max(300).default(''),
      confidence: z.number().min(0).max(1),
    })).max(50).default([]),
    locations: z.array(z.object({
      surface_name: z.string().trim().min(1).max(160),
      normalized_name: z.string().trim().min(1).max(160).nullable().default(null),
      role: z.enum(['at', 'from', 'to', 'through', 'near', 'mentioned']).default('at'),
      confidence: z.number().min(0).max(1),
    })).max(30).default([]),
    time_links: z.array(z.object({
      time_expression_id: z.string().trim().min(1),
      relation: z.enum(['occurs_at', 'begins_at', 'ends_at', 'during', 'before', 'after']),
      confidence: z.number().min(0).max(1),
    })).max(20).default([]),
    evidence: z.array(z.object({
      paragraph_id: z.string().min(1),
      exact_quote: z.string().trim().min(1).max(1000),
      role: z.enum(['support', 'context']).default('support'),
    })).min(1).max(30),
    confidence: z.number().min(0).max(1),
    uncertainty: z.string().max(500).default(''),
  })).max(150),
});

export type TimelineEventOutput = z.infer<typeof timelineEventOutputSchema>;

export type TimelineEventEstimate = {
  chunkPlanId: string | null;
  chunkCount: number;
  characterCount: number;
  approximateInputTokens: number;
  ready: boolean;
};

export type TimelineEventWorkItem = {
  jobId: string;
  runId: string;
  inputMode?: 'standard' | 'automation-draft-selection';
  draftSelectionRunId?: string | null;
  chunkId: string;
  chunkOrdinal: number;
  model: string;
  promptVersion: string;
  paragraphs: CharacterScanParagraph[];
  characters: Array<{ identityId: string; name: string; aliases: string[] }>;
  timeExpressions: Array<{ id: string; paragraphId: string; surfaceText: string; expressionType: TimeExpressionType; normalizedValue: string | null; reviewStatus: TimeExpressionReviewStatus }>;
};

export type TimelineEventRecord = {
  id: string;
  title: string;
  summary: string;
  eventType: TimelineEventType;
  narrativeStartOrdinal: number;
  narrativeEndOrdinal: number;
  chapterTitle: string | null;
  extractionMethod: 'model' | 'rule' | 'user';
  confidence: number;
  reviewStatus: TimeExpressionReviewStatus;
  uncertainty: string;
  participantCount: number;
  locationCount: number;
  evidenceCount: number;
  timeLinkCount: number;
};

export type TimelineEventEvidenceRecord = {
  id: string;
  sourceSpanId: string | null;
  eventId: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  exactQuote: string;
  evidenceRole: 'support' | 'context' | 'contradict';
  alignmentStatus: 'exact' | 'normalized';
};

export type TimelineEventParticipantRecord = {
  id: string;
  eventId: string;
  identityId: string | null;
  identityName: string | null;
  surfaceName: string;
  role: 'actor' | 'target' | 'witness' | 'speaker' | 'addressee' | 'participant' | 'other';
  actionText: string;
  confidence: number;
  reviewStatus: TimeExpressionReviewStatus;
};

export type TimelineEventLocationRecord = {
  id: string;
  eventId: string;
  surfaceName: string;
  normalizedName: string | null;
  locationRole: 'at' | 'from' | 'to' | 'through' | 'near' | 'mentioned';
  confidence: number;
  reviewStatus: TimeExpressionReviewStatus;
};

export type PlaceType = 'realm' | 'region' | 'country' | 'city' | 'settlement' | 'district'
  | 'route' | 'natural' | 'building' | 'room' | 'landmark' | 'other';
export type PlaceReviewStatus = 'pending' | 'confirmed' | 'rejected';

export type PlaceRecord = {
  id: string;
  canonicalName: string;
  normalizedName: string;
  placeType: PlaceType;
  description: string;
  importanceScore: number;
  firstRevealedParagraphId: string;
  firstRevealedOrdinal: number;
  chapterTitle: string | null;
  reviewStatus: PlaceReviewStatus;
  extractionMethod: 'rule' | 'model' | 'user';
  mentionCount: number;
  sourceEventCount: number;
};

export type PlaceMentionRecord = {
  id: string;
  sourceSpanId: string | null;
  placeId: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  surfaceText: string;
  charStart: number;
  charEnd: number;
  sourceEventLocationId: string | null;
  extractionMethod: 'rule' | 'model' | 'user';
  confidence: number;
  reviewStatus: PlaceReviewStatus;
  paragraphText: string;
};

export type PlaceBootstrapSummary = {
  sourceLocationCount: number;
  createdPlaceCount: number;
  createdMentionCount: number;
  skippedUnalignedCount: number;
};

export type PlaceAliasRecord = {
  id: string;
  placeId: string;
  alias: string;
  normalizedAlias: string;
  source: 'event' | 'model' | 'user';
  reviewStatus: PlaceReviewStatus;
};

export type PlaceSuggestionEvidenceRecord = {
  id: string;
  sourceSpanId: string | null;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  exactQuote: string;
  evidenceRole: 'support' | 'context' | 'contradict' | null;
  alignmentStatus: 'exact' | 'normalized';
};

export type PlaceIdentityLinkRecord = {
  id: string;
  leftPlaceId: string;
  leftName: string;
  rightPlaceId: string;
  rightName: string;
  relation: 'must_link' | 'cannot_link';
  reason: string;
  confidence: number;
  reviewStatus: PlaceReviewStatus;
  createdAt: string;
};

export type PlaceIdentityOperationRecord = {
  id: string;
  operation: 'merge' | 'split' | 'cannot_link' | 'must_link' | 'alias_review';
  description: string;
  state: 'applied' | 'undone';
  createdAt: string;
  undoneAt: string | null;
};

export type PlaceRelationCandidateRecord = {
  id: string;
  sourcePlaceId: string;
  sourceName: string;
  targetPlaceId: string;
  targetName: string;
  candidateMethod: 'rule' | 'model' | 'user';
  proposedRelationKind: string | null;
  proposedDirection: 'directed' | 'undirected' | null;
  confidence: number;
  reviewStatus: PlaceReviewStatus;
  evidenceCount: number;
};

export type PlaceRelationModelSuggestionRecord = {
  candidateId: string;
  direction: 'directed' | 'undirected';
  informationSourceType: 'narrator' | 'character' | 'unknown';
  informationSourceIdentityId: string | null;
  informationSourceName: string | null;
  truthStatus: 'asserted' | 'suspected' | 'disputed' | 'false' | 'unknown' | 'rumor';
  validFromEventId: string | null;
  validFromEventTitle: string | null;
  validToEventId: string | null;
  validToEventTitle: string | null;
  reasoningNote: string;
  uncertainty: string;
};

export type PlaceRelationRecord = {
  id: string;
  sourcePlaceId: string;
  sourceName: string;
  targetPlaceId: string;
  targetName: string;
  relationKind: string;
  direction: 'directed' | 'undirected';
  informationSourceType: 'narrator' | 'character' | 'unknown';
  informationSourceIdentityId: string | null;
  informationSourceName: string | null;
  truthStatus: 'asserted' | 'suspected' | 'disputed' | 'false' | 'unknown' | 'rumor';
  validFromEventId: string | null;
  validFromEventTitle: string | null;
  validToEventId: string | null;
  validToEventTitle: string | null;
  validFromOrdinal: number | null;
  validToOrdinal: number | null;
  firstRevealedParagraphId: string;
  firstRevealedOrdinal: number;
  confidence: number;
  reviewStatus: PlaceReviewStatus;
  extractionMethod: 'rule' | 'model' | 'user';
  candidateId: string | null;
  supersedesRelationId: string | null;
  reasoningNote: string;
  evidenceCount: number;
};

export type PlaceRelationEvidenceRecord = PlaceSuggestionEvidenceRecord & { relationId: string };

export type PlaceGeometrySourceKind = 'manual' | 'gazetteer';
export type PlaceGeometryCertainty = 'certain' | 'less_certain' | 'uncertain';

export type PlaceGeometryInput = {
  placeId: string;
  longitude: number;
  latitude: number;
  sourceKind: PlaceGeometrySourceKind;
  sourceLabel: string;
  sourceUri: string | null;
  certainty: PlaceGeometryCertainty;
  note: string;
};

export type PlaceGeometryRecord = PlaceGeometryInput & {
  id: string;
  placeName: string;
  coordinateSystem: 'WGS84';
  geometryType: 'Point';
  reviewStatus: PlaceReviewStatus;
  createdAt: string;
  updatedAt: string;
};

export const PLACE_GEOJSON_SPEC_VERSION = '1.0' as const;

export const placeGeoJsonSchema = z.object({
  type: z.literal('FeatureCollection'),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  features: z.array(z.object({
    type: z.literal('Feature'),
    id: z.string().min(1),
    geometry: z.object({
      type: z.literal('Point'),
      coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
    }),
    properties: z.object({
      name: z.string().min(1),
      aliases: z.array(z.string().min(1)),
      place_type: z.enum(['realm', 'region', 'country', 'city', 'settlement', 'district', 'route', 'natural', 'building', 'room', 'landmark', 'other']),
      first_revealed_ordinal: z.number().int().nonnegative(),
      coordinate_system: z.literal('WGS84'),
      certainty: z.enum(['certain', 'less_certain', 'uncertain']),
      provenance: z.object({
        kind: z.enum(['manual', 'gazetteer']),
        label: z.string(),
        uri: z.string().url().nullable(),
        note: z.string(),
      }),
    }),
  })),
  novel_world_compiler: z.object({
    format: z.literal('novel-world-place-geojson'),
    spec_version: z.literal(PLACE_GEOJSON_SPEC_VERSION),
    schema_version: z.number().int().positive(),
    generated_at: z.string().datetime(),
    project_id: z.string().min(1),
    project_name: z.string().min(1),
    revision_id: z.string().min(1),
    entry_ordinal: z.number().int().nonnegative(),
    maximum_ordinal: z.number().int().nonnegative(),
    coordinate_semantics: z.literal('earth-wgs84-confirmed-only'),
    source_fingerprint: z.string().length(64),
  }),
});

export type PlaceGeoJson = z.infer<typeof placeGeoJsonSchema>;
export type PlaceGeoJsonExportResult = { outputPath: string; checksum: string; geoJson: PlaceGeoJson };

export type NarrativeMapTopologyClass = 'hierarchy' | 'connection' | 'direction' | 'proximity' | 'other';

export type NarrativeMapNode = {
  id: string;
  name: string;
  aliases: string[];
  placeType: PlaceType;
  importanceScore: number;
  mentionCount: number;
  degree: number;
  firstRevealedOrdinal: number;
  componentId: number;
  parentId: string | null;
  hierarchyConflict: boolean;
};

export type NarrativeMapEdge = PlaceRelationRecord & {
  pairKey: string;
  topologyClass: NarrativeMapTopologyClass;
  hasConflict: boolean;
};

export type NarrativeMapEventRecord = {
  id: string;
  title: string;
  eventType: TimelineEventType;
  narrativeStartOrdinal: number;
  narrativeEndOrdinal: number;
  places: Array<{ placeId: string; locationRole: TimelineEventLocationRecord['locationRole'] }>;
  participants: Array<{
    identityId: string;
    name: string;
    role: TimelineEventParticipantRecord['role'];
  }>;
};

export type NarrativeMapProjection = {
  entryOrdinal: number;
  maximumOrdinal: number;
  nodes: NarrativeMapNode[];
  edges: NarrativeMapEdge[];
  history: PlaceRelationRecord[];
  evidence: PlaceRelationEvidenceRecord[];
  events: NarrativeMapEventRecord[];
  revealedRelationCount: number;
  temporallyInactiveRelationCount: number;
  hierarchyConflictCount: number;
  coordinateSemantics: 'topology-only';
};

export const NARRATIVE_MAP_SPEC_VERSION = '1.0' as const;

const narrativeMapRelationExportSchema = z.object({
  id: z.string().min(1),
  source_place_id: z.string().min(1),
  source_name: z.string().min(1),
  target_place_id: z.string().min(1),
  target_name: z.string().min(1),
  relation_kind: z.string().min(1),
  topology_class: z.enum(['hierarchy', 'connection', 'direction', 'proximity', 'other']),
  direction: z.enum(['directed', 'undirected']),
  information_source: z.object({
    type: z.enum(['narrator', 'character', 'unknown']),
    identity_id: z.string().min(1).nullable(),
    name: z.string().min(1).nullable(),
  }),
  truth_status: z.enum(['asserted', 'suspected', 'disputed', 'false', 'unknown', 'rumor']),
  validity: z.object({
    from_event_id: z.string().min(1).nullable(),
    from_event_title: z.string().min(1).nullable(),
    to_event_id: z.string().min(1).nullable(),
    to_event_title: z.string().min(1).nullable(),
    from_ordinal: z.number().int().nonnegative().nullable(),
    to_ordinal: z.number().int().nonnegative().nullable(),
  }),
  first_revealed: z.object({ paragraph_id: z.string().min(1), ordinal: z.number().int().nonnegative() }),
  confidence: z.number().min(0).max(1),
  extraction_method: z.enum(['rule', 'model', 'user']),
  candidate_id: z.string().min(1).nullable(),
  supersedes_relation_id: z.string().min(1).nullable(),
  reasoning_note: z.string(),
  evidence_ids: z.array(z.string().min(1)),
  active_at_entry: z.boolean(),
  has_conflict: z.boolean(),
});

export const narrativeMapExportSchema = z.object({
  format: z.literal('novel-world-narrative-map'),
  spec_version: z.literal(NARRATIVE_MAP_SPEC_VERSION),
  schema_version: z.number().int().positive(),
  generated_at: z.string().datetime(),
  project: z.object({ id: z.string().min(1), name: z.string().min(1), revision_id: z.string().min(1) }),
  fence: z.object({
    entry_ordinal: z.number().int().nonnegative(),
    maximum_ordinal: z.number().int().nonnegative(),
  }),
  coordinate_semantics: z.literal('topology-only'),
  nodes: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    aliases: z.array(z.string().min(1)),
    place_type: z.enum(['realm', 'region', 'country', 'city', 'settlement', 'district', 'route', 'natural', 'building', 'room', 'landmark', 'other']),
    importance_score: z.number(),
    mention_count: z.number().int().nonnegative(),
    degree: z.number().int().nonnegative(),
    first_revealed_ordinal: z.number().int().nonnegative(),
    component_id: z.number().int().nonnegative(),
    parent_id: z.string().min(1).nullable(),
    hierarchy_conflict: z.boolean(),
  })),
  relations: z.array(narrativeMapRelationExportSchema),
  evidence: z.array(z.object({
    id: z.string().min(1),
    relation_id: z.string().min(1),
    paragraph_id: z.string().min(1),
    paragraph_ordinal: z.number().int().nonnegative(),
    chapter_title: z.string().nullable(),
    exact_quote: z.string().min(1),
    role: z.enum(['support', 'context', 'contradict']),
    alignment_status: z.enum(['exact', 'normalized']),
  })),
  events: z.array(z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    event_type: z.enum(['action', 'dialogue', 'movement', 'meeting', 'conflict', 'discovery', 'state_change', 'birth', 'death', 'other']),
    narrative_start_ordinal: z.number().int().nonnegative(),
    narrative_end_ordinal: z.number().int().nonnegative(),
    places: z.array(z.object({
      place_id: z.string().min(1),
      location_role: z.enum(['at', 'from', 'to', 'through', 'near', 'mentioned']),
    })).min(1),
    participants: z.array(z.object({
      identity_id: z.string().min(1),
      name: z.string().min(1),
      role: z.enum(['actor', 'target', 'witness', 'speaker', 'addressee', 'participant', 'other']),
    })),
  })),
  extensions: z.object({
    novel_world_compiler: z.object({ source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }),
  }),
});

export type NarrativeMapExport = z.infer<typeof narrativeMapExportSchema>;
export type NarrativeMapExportRelation = z.infer<typeof narrativeMapRelationExportSchema>;
export type NarrativeMapExportResult = {
  outputPath: string;
  checksum: string;
  map: NarrativeMapExport;
};

const placeModelEvidenceSchema = z.object({
  paragraph_id: z.string().trim().min(1),
  exact_quote: z.string().trim().min(1).max(4000),
});

export const placeModelOutputSchema = z.object({
  aliases: z.array(z.object({
    place_id: z.string().trim().min(1),
    alias: z.string().trim().min(1).max(200),
    confidence: z.number().min(0).max(1),
    evidence: z.array(placeModelEvidenceSchema).min(1).max(20),
  })).max(200),
  identity_links: z.array(z.object({
    left_place_id: z.string().trim().min(1),
    right_place_id: z.string().trim().min(1),
    relation: z.enum(['must_link', 'cannot_link']),
    confidence: z.number().min(0).max(1),
    reason: z.string().trim().min(1).max(1000),
    evidence: z.array(placeModelEvidenceSchema.extend({
      role: z.enum(['support', 'context', 'contradict']),
    })).min(1).max(20),
  }).refine((value) => value.left_place_id !== value.right_place_id, {
    message: '地点身份建议不能连接同一地点',
  })).max(200),
  relations: z.array(z.object({
    source_place_id: z.string().trim().min(1),
    target_place_id: z.string().trim().min(1),
    relation_kind: z.string().trim().min(1).max(120),
    direction: z.enum(['directed', 'undirected']),
    information_source_type: z.enum(['narrator', 'character', 'unknown']),
    information_source_identity_id: z.string().trim().min(1).nullable().default(null),
    truth_status: z.enum(['asserted', 'suspected', 'disputed', 'false', 'unknown', 'rumor']),
    valid_from_event_id: z.string().trim().min(1).nullable().default(null),
    valid_to_event_id: z.string().trim().min(1).nullable().default(null),
    confidence: z.number().min(0).max(1),
    evidence: z.array(placeModelEvidenceSchema.extend({
      role: z.enum(['support', 'context', 'contradict']),
    })).min(1).max(20),
    reasoning_note: z.string().trim().max(1000).default(''),
    uncertainty: z.string().trim().max(500).default(''),
  }).superRefine((value, context) => {
    if (value.source_place_id === value.target_place_id) {
      context.addIssue({ code: 'custom', message: '空间关系不能形成自环' });
    }
    if (value.information_source_type === 'character' && !value.information_source_identity_id) {
      context.addIssue({ code: 'custom', message: '人物来源必须提供人物 ID' });
    }
    if (value.information_source_type !== 'character' && value.information_source_identity_id) {
      context.addIssue({ code: 'custom', message: '非人物来源不能提供人物 ID' });
    }
    if (!value.evidence.some((evidence) => evidence.role === 'support')) {
      context.addIssue({ code: 'custom', message: '空间关系至少需要一条支持证据' });
    }
  })).max(200),
});

export type PlaceModelOutput = z.infer<typeof placeModelOutputSchema>;

export type PlaceModelScanEstimate = {
  chunkPlanId: string | null;
  chunkCount: number;
  confirmedPlaceCount: number;
  ready: boolean;
};

export type PlaceModelScanWorkItem = {
  jobId: string;
  runId: string;
  chunkId: string;
  chunkOrdinal: number;
  model: string;
  promptVersion: string;
  places: Array<{ placeId: string; name: string; placeType: PlaceType; aliases: string[] }>;
  identityLinks: Array<{ leftPlaceId: string; rightPlaceId: string; relation: 'must_link' | 'cannot_link' }>;
  characters: Array<{ identityId: string; name: string }>;
  events: Array<{ eventId: string; title: string; narrativeStartOrdinal: number; narrativeEndOrdinal: number }>;
  paragraphs: Array<{
    paragraphId: string;
    ordinal: number;
    chapterTitle: string | null;
    role: 'core' | 'context_before' | 'context_after';
    text: string;
  }>;
};

export type TimelineRelationRecord = {
  id: string;
  leftEventId: string;
  leftTitle: string;
  leftNarrativeOrdinal: number;
  rightEventId: string;
  rightTitle: string;
  rightNarrativeOrdinal: number;
  proposedRelation: TimelineRelationKind;
  resolvedRelation: TimelineRelationKind | null;
  effectiveRelation: TimelineRelationKind;
  sourceType: 'explicit' | 'inferred' | 'model' | 'user';
  evidenceParagraphId: string | null;
  exactQuote: string;
  confidence: number;
  reason: string;
  reviewStatus: TimeExpressionReviewStatus;
};

export type TimelineRelationConsolidationSummary = {
  createdCount: number;
  totalCount: number;
  pendingCount: number;
  confirmedCount: number;
};

export type TimelineOrderRecord = {
  eventId: string;
  title: string;
  narrativeOrdinal: number;
  orderLevel: number;
  simultaneousGroup: number;
  constrained: boolean;
};

export type TimelineGraphSummary = {
  eventCount: number;
  confirmedRelationCount: number;
  pendingRelationCount: number;
  hasCycle: boolean;
  orderedEventCount: number;
  unconstrainedEventCount: number;
};

export type CharacterRelationshipReviewStatus = 'pending' | 'confirmed' | 'rejected';
export type CharacterRelationshipDirection = 'directed' | 'undirected' | 'reciprocal';
export type CharacterRelationshipTruthStatus = 'asserted' | 'suspected' | 'disputed' | 'false' | 'unknown' | 'rumor';
export type CharacterRelationshipInformationSource = 'narrator' | 'character' | 'unknown';
export type CharacterRelationshipEvidenceRole = 'support' | 'context' | 'contradict';

export type CharacterRelationshipEvidenceInput = {
  paragraphId: string;
  exactQuote: string;
  role: CharacterRelationshipEvidenceRole;
};

export type CharacterRelationshipCandidateInput = {
  sourceIdentityId: string;
  targetIdentityId: string;
  method: 'cooccurrence' | 'rule' | 'model' | 'user';
  proposedType?: string | null;
  confidence: number;
  evidence: Array<Omit<CharacterRelationshipEvidenceInput, 'role'> & {
    role: 'clue' | CharacterRelationshipEvidenceRole;
  }>;
};

export type CharacterRelationshipAssertionInput = {
  sourceIdentityId: string;
  targetIdentityId: string;
  relationshipType: string;
  direction: CharacterRelationshipDirection;
  strength?: number | null;
  polarity?: number | null;
  informationSourceType: CharacterRelationshipInformationSource;
  informationSourceIdentityId?: string | null;
  truthStatus: CharacterRelationshipTruthStatus;
  validFromEventId?: string | null;
  validToEventId?: string | null;
  validFromTimeExpressionId?: string | null;
  validToTimeExpressionId?: string | null;
  confidence: number;
  extractionMethod: 'rule' | 'model' | 'user';
  candidateId?: string | null;
  supersedesRelationshipId?: string | null;
  reasoningNote?: string;
  evidence: CharacterRelationshipEvidenceInput[];
};

export type CharacterRelationshipCandidateRecord = {
  id: string;
  sourceIdentityId: string;
  sourceName: string;
  targetIdentityId: string;
  targetName: string;
  candidateMethod: CharacterRelationshipCandidateInput['method'];
  proposedType: string | null;
  confidence: number;
  reviewStatus: CharacterRelationshipReviewStatus;
  evidenceCount: number;
};

export type CharacterRelationshipCandidateEvidenceRecord = {
  id: string;
  sourceSpanId: string | null;
  candidateId: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  exactQuote: string;
  evidenceRole: 'clue' | 'support' | 'context' | 'contradict';
  alignmentStatus: 'exact' | 'normalized';
};

export type RelationshipModelSuggestionRecord = {
  candidateId: string;
  direction: CharacterRelationshipDirection;
  strength: number | null;
  polarity: number | null;
  informationSourceType: CharacterRelationshipInformationSource;
  informationSourceIdentityId: string | null;
  informationSourceName: string | null;
  truthStatus: CharacterRelationshipTruthStatus;
  validFromEventId: string | null;
  validFromEventTitle: string | null;
  validToEventId: string | null;
  validToEventTitle: string | null;
  reasoningNote: string;
  uncertainty: string;
};

export type CharacterRelationshipRecord = {
  id: string;
  sourceIdentityId: string;
  sourceName: string;
  targetIdentityId: string;
  targetName: string;
  relationshipType: string;
  direction: CharacterRelationshipDirection;
  strength: number | null;
  polarity: number | null;
  informationSourceType: CharacterRelationshipInformationSource;
  informationSourceIdentityId: string | null;
  informationSourceName: string | null;
  truthStatus: CharacterRelationshipTruthStatus;
  validFromEventId: string | null;
  validToEventId: string | null;
  validFromTimeExpressionId: string | null;
  validToTimeExpressionId: string | null;
  validFromOrdinal: number | null;
  validToOrdinal: number | null;
  firstRevealedParagraphId: string;
  firstRevealedOrdinal: number;
  confidence: number;
  reviewStatus: CharacterRelationshipReviewStatus;
  extractionMethod: CharacterRelationshipAssertionInput['extractionMethod'];
  candidateId: string | null;
  supersedesRelationshipId: string | null;
  reasoningNote: string;
  evidenceCount: number;
};

export type CharacterRelationshipEvidenceRecord = {
  id: string;
  sourceSpanId: string | null;
  relationshipId: string;
  paragraphId: string;
  paragraphOrdinal: number;
  chapterTitle: string | null;
  exactQuote: string;
  evidenceRole: CharacterRelationshipEvidenceRole;
  alignmentStatus: 'exact' | 'normalized';
};

export type RelationshipGraphNode = {
  id: string;
  name: string;
  importanceTier: CharacterCandidate['importanceTier'];
  importanceScore: number;
  degree: number;
  firstRevealedOrdinal: number;
  componentId: number;
};

export type RelationshipGraphEdge = CharacterRelationshipRecord & {
  pairKey: string;
  hasConflict: boolean;
};

export type RelationshipTimelineEvent = {
  id: string; title: string; summary: string; eventType: string; startOrdinal: number; endOrdinal: number;
  participants: Array<{ identityId: string; name: string }>;
  evidence: Array<{ id: string; paragraphOrdinal: number; exactQuote: string }>;
};

export type RelationshipGraphProjection = {
  events?: RelationshipTimelineEvent[];
  entryOrdinal: number;
  maximumOrdinal: number;
  nodes: RelationshipGraphNode[];
  edges: RelationshipGraphEdge[];
  history: CharacterRelationshipRecord[];
  evidence: CharacterRelationshipEvidenceRecord[];
  revealedRelationshipCount: number;
  temporallyInactiveRelationshipCount: number;
};

export const CHARACTER_GRAPH_SPEC_VERSION = '1.0' as const;

const characterGraphRelationshipSchema = z.object({
  id: z.string().min(1),
  source_identity_id: z.string().min(1),
  source_name: z.string().min(1),
  target_identity_id: z.string().min(1),
  target_name: z.string().min(1),
  relationship_type: z.string().min(1),
  direction: z.enum(['directed', 'undirected', 'reciprocal']),
  strength: z.number().min(0).max(1).nullable(),
  polarity: z.number().min(-1).max(1).nullable(),
  information_source: z.object({
    type: z.enum(['narrator', 'character', 'unknown']),
    identity_id: z.string().min(1).nullable(),
    name: z.string().min(1).nullable(),
  }),
  truth_status: z.enum(['asserted', 'suspected', 'disputed', 'false', 'unknown', 'rumor']),
  validity: z.object({
    from_event_id: z.string().min(1).nullable(),
    to_event_id: z.string().min(1).nullable(),
    from_time_expression_id: z.string().min(1).nullable(),
    to_time_expression_id: z.string().min(1).nullable(),
    from_ordinal: z.number().int().nonnegative().nullable(),
    to_ordinal: z.number().int().nonnegative().nullable(),
  }),
  first_revealed: z.object({ paragraph_id: z.string().min(1), ordinal: z.number().int().nonnegative() }),
  confidence: z.number().min(0).max(1),
  extraction_method: z.enum(['rule', 'model', 'user']),
  supersedes_relationship_id: z.string().min(1).nullable(),
  reasoning_note: z.string(),
  evidence_ids: z.array(z.string().min(1)),
  active_at_entry: z.boolean(),
  has_conflict: z.boolean(),
});

export const characterGraphExportSchema = z.object({
  format: z.literal('novel-world-character-graph'),
  spec_version: z.literal(CHARACTER_GRAPH_SPEC_VERSION),
  schema_version: z.number().int().positive(),
  generated_at: z.string().datetime(),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    revision_id: z.string().min(1),
  }),
  fence: z.object({
    entry_ordinal: z.number().int().nonnegative(),
    maximum_ordinal: z.number().int().nonnegative(),
  }),
  nodes: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    importance_tier: z.enum(['core', 'important', 'minor', 'incidental', 'pending']),
    importance_score: z.number(),
    degree: z.number().int().nonnegative(),
    first_revealed_ordinal: z.number().int().nonnegative(),
    component_id: z.number().int().nonnegative(),
    community_id: z.string().min(1),
  })),
  relationships: z.array(characterGraphRelationshipSchema),
  evidence: z.array(z.object({
    id: z.string().min(1),
    relationship_id: z.string().min(1),
    paragraph_id: z.string().min(1),
    paragraph_ordinal: z.number().int().nonnegative(),
    chapter_title: z.string().nullable(),
    exact_quote: z.string().min(1),
    role: z.enum(['support', 'context', 'contradict']),
    alignment_status: z.enum(['exact', 'normalized']),
  })),
  communities: z.array(z.object({
    id: z.string().min(1),
    member_node_ids: z.array(z.string().min(1)).min(1),
    relationship_ids: z.array(z.string().min(1)),
    source_relationship_ids: z.array(z.string().min(1)),
    source_evidence_ids: z.array(z.string().min(1)),
    summary: z.string().nullable(),
  })),
  extensions: z.object({
    novel_world_compiler: z.object({ source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u) }),
  }),
});

export type CharacterGraphExport = z.infer<typeof characterGraphExportSchema>;
export type CharacterGraphExportRelationship = z.infer<typeof characterGraphRelationshipSchema>;
export type CharacterGraphExportResult = {
  outputPath: string;
  checksum: string;
  graph: CharacterGraphExport;
};

export const sillyTavernWorldInfoEntrySchema = z.object({
  uid: z.number().int().nonnegative(),
  key: z.array(z.string().min(1)).min(1),
  keysecondary: z.array(z.string().min(1)),
  comment: z.string(),
  content: z.string().min(1),
  constant: z.boolean(),
  selective: z.boolean(),
  vectorized: z.boolean(),
  selectiveLogic: z.number().int(),
  order: z.number().int(),
  position: z.number().int(),
  disable: z.boolean(),
  addMemo: z.boolean(),
  excludeRecursion: z.boolean(),
  preventRecursion: z.boolean(),
  delayUntilRecursion: z.boolean(),
  displayIndex: z.number().int().nonnegative(),
  probability: z.number().min(0).max(100),
  useProbability: z.boolean(),
  depth: z.number().int().nonnegative(),
  outletName: z.string(),
  group: z.string(),
  groupOverride: z.boolean(),
  groupWeight: z.number(),
  scanDepth: z.number().int().nonnegative().nullable(),
  caseSensitive: z.boolean().nullable(),
  matchWholeWords: z.boolean().nullable(),
  useGroupScoring: z.boolean().nullable(),
  automationId: z.string(),
  role: z.number().int(),
  sticky: z.number().int().nonnegative().nullable(),
  cooldown: z.number().int().nonnegative().nullable(),
  delay: z.number().int().nonnegative().nullable(),
  triggers: z.array(z.string()),
  ignoreBudget: z.boolean(),
  extensions: z.object({
    novel_world_compiler: z.object({
      entry_kind: z.enum(['community', 'relationship']),
      source_relationship_ids: z.array(z.string().min(1)),
      source_evidence_ids: z.array(z.string().min(1)),
    }),
  }),
});

export const sillyTavernWorldInfoExportSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  scan_depth: z.number().int().nonnegative(),
  token_budget: z.number().int().positive(),
  recursive_scanning: z.boolean(),
  entries: z.record(z.string(), sillyTavernWorldInfoEntrySchema),
  extensions: z.object({
    novel_world_compiler: z.object({
      character_graph_spec_version: z.literal(CHARACTER_GRAPH_SPEC_VERSION),
      schema_version: z.number().int().positive(),
      project_id: z.string().min(1),
      revision_id: z.string().min(1),
      entry_ordinal: z.number().int().nonnegative(),
      graph_source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  }),
});

export type SillyTavernWorldInfoEntry = z.infer<typeof sillyTavernWorldInfoEntrySchema>;
export type SillyTavernWorldInfoExport = z.infer<typeof sillyTavernWorldInfoExportSchema>;
export type SillyTavernWorldInfoExportResult = {
  outputPath: string;
  checksum: string;
  worldInfo: SillyTavernWorldInfoExport;
};

export const sillyTavernPlaceWorldInfoEntrySchema = sillyTavernWorldInfoEntrySchema.extend({
  extensions: z.object({
    novel_world_compiler: z.object({
      entry_kind: z.enum(['place', 'spatial_relation']),
      source_place_ids: z.array(z.string().min(1)),
      source_relation_ids: z.array(z.string().min(1)),
      source_evidence_ids: z.array(z.string().min(1)),
      source_event_ids: z.array(z.string().min(1)),
    }),
  }),
});

export const sillyTavernPlaceWorldInfoExportSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  scan_depth: z.number().int().nonnegative(),
  token_budget: z.number().int().positive(),
  recursive_scanning: z.boolean(),
  entries: z.record(z.string(), sillyTavernPlaceWorldInfoEntrySchema),
  extensions: z.object({
    novel_world_compiler: z.object({
      narrative_map_spec_version: z.literal(NARRATIVE_MAP_SPEC_VERSION),
      schema_version: z.number().int().positive(),
      project_id: z.string().min(1),
      revision_id: z.string().min(1),
      entry_ordinal: z.number().int().nonnegative(),
      map_source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
      coordinate_semantics: z.literal('topology-only'),
    }),
  }),
});

export type SillyTavernPlaceWorldInfoEntry = z.infer<typeof sillyTavernPlaceWorldInfoEntrySchema>;
export type SillyTavernPlaceWorldInfoExport = z.infer<typeof sillyTavernPlaceWorldInfoExportSchema>;
export type SillyTavernPlaceWorldInfoExportResult = {
  outputPath: string;
  checksum: string;
  worldInfo: SillyTavernPlaceWorldInfoExport;
};

export type RelationshipScanEstimate = {
  chunkPlanId: string | null;
  chunkCount: number;
  confirmedCharacterCount: number;
  ready: boolean;
};

export type RelationshipScanCharacter = {
  identityId: string;
  name: string;
  aliases: string[];
};

export type RelationshipScanWorkItem = {
  jobId: string;
  runId: string;
  inputMode?: 'standard' | 'automation-draft-selection';
  draftSelectionRunId?: string | null;
  chunkId: string;
  chunkOrdinal: number;
  extractorVersion: string;
  scanMode: 'local' | 'model';
  model: string | null;
  promptVersion: string;
  characters: RelationshipScanCharacter[];
  cannotLinks: Array<{ leftIdentityId: string; rightIdentityId: string }>;
  quotes: Array<{ paragraphId: string; exactQuote: string; speakerIdentityId: string; speakerName: string }>;
  events: Array<{
    eventId: string;
    title: string;
    summary: string;
    narrativeStartOrdinal: number;
    narrativeEndOrdinal: number;
    participantIdentityIds: string[];
  }>;
  paragraphs: Array<{
    paragraphId: string;
    ordinal: number;
    chapterTitle: string | null;
    role: 'core' | 'context_before' | 'context_after';
    text: string;
  }>;
};

export type RelationshipScanCandidate = {
  sourceIdentityId: string;
  targetIdentityId: string;
  method: 'cooccurrence' | 'rule' | 'model';
  proposedType: string | null;
  confidence: number;
  evidence: Array<{
    paragraphId: string;
    exactQuote: string;
    role: 'clue' | 'support' | 'context' | 'contradict';
  }>;
  suggestion?: {
    direction: CharacterRelationshipDirection;
    strength: number | null;
    polarity: number | null;
    informationSourceType: CharacterRelationshipInformationSource;
    informationSourceIdentityId: string | null;
    truthStatus: CharacterRelationshipTruthStatus;
    validFromEventId: string | null;
    validToEventId: string | null;
    reasoningNote: string;
    uncertainty: string;
  };
};

export type RelationshipScanOutput = {
  candidates: RelationshipScanCandidate[];
};

export const relationshipModelOutputSchema = z.object({
  candidates: z.array(z.object({
    source_identity_id: z.string().trim().min(1),
    target_identity_id: z.string().trim().min(1),
    relationship_type: z.string().trim().min(1).max(120),
    direction: z.enum(['directed', 'undirected', 'reciprocal']),
    strength: z.number().min(0).max(1).nullable().default(null),
    polarity: z.number().min(-1).max(1).nullable().default(null),
    information_source_type: z.enum(['narrator', 'character', 'unknown']),
    information_source_identity_id: z.string().trim().min(1).nullable().default(null),
    truth_status: z.enum(['asserted', 'suspected', 'disputed', 'false', 'unknown', 'rumor']),
    valid_from_event_id: z.string().trim().min(1).nullable().default(null),
    valid_to_event_id: z.string().trim().min(1).nullable().default(null),
    confidence: z.number().min(0).max(1),
    evidence: z.array(z.object({
      paragraph_id: z.string().trim().min(1),
      exact_quote: z.string().trim().min(1).max(4000),
      role: z.enum(['support', 'context', 'contradict']),
    })).min(1).max(20),
    reasoning_note: z.string().trim().max(1000).default(''),
    uncertainty: z.string().trim().max(500).default(''),
  })).max(200),
});

export type RelationshipModelOutput = z.infer<typeof relationshipModelOutputSchema>;

export type StoryStateValueRecord = {
  category: CharacterFactRecord['category'];
  predicate: string;
  value: string | null;
  alternatives: string[];
  resolution: 'timeless' | 'effective_after_transition' | 'effective_before_transition' | 'ambiguous';
  visibility: 'public' | 'private' | 'secret';
  confidence: number;
  evidenceCount: number;
  transitionId: string | null;
  triggerEventId: string | null;
  reason: string;
};

export type StoryCharacterSnapshot = {
  identityId: string;
  identityName: string;
  importanceTier: CharacterCandidate['importanceTier'];
  values: StoryStateValueRecord[];
  resolvedCount: number;
  ambiguousCount: number;
};

export type StoryStateSnapshot = {
  entryEventId: string;
  entryEventTitle: string;
  entryNarrativeOrdinal: number;
  generatedAt: string;
  characters: StoryCharacterSnapshot[];
  resolvedValueCount: number;
  ambiguousValueCount: number;
};

export const characterCardDraftFieldsSchema = z.object({
  description: z.string().max(30_000),
  personality: z.string().max(20_000),
  scenario: z.string().max(20_000),
  firstMes: z.string().max(20_000),
  mesExample: z.string().max(30_000),
  creatorNotes: z.string().max(10_000),
  systemPrompt: z.string().max(20_000),
  postHistoryInstructions: z.string().max(20_000),
  alternateGreetings: z.array(z.string().max(20_000)).max(20),
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  creator: z.string().max(200),
  characterVersion: z.string().max(100),
});

export type CharacterCardDraftFields = z.infer<typeof characterCardDraftFieldsSchema>;

export type CharacterCardDraftRecord = CharacterCardDraftFields & {
  id: string;
  identityId: string;
  identityName: string;
  entryEventId: string;
  entryEventTitle: string;
  reviewStatus: 'draft' | 'reviewed';
  sourceSummary: {
    confirmedFactCount: number;
    resolvedStateCount: number;
    ambiguousStateCount: number;
    quoteSampleCount: number;
    sourceFingerprint: string;
    projectionPolicyVersion?: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type TavernCardV2 = {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    creator_notes: string;
    system_prompt: string;
    post_history_instructions: string;
    alternate_greetings: string[];
    character_book?: TavernCharacterBook;
    tags: string[];
    creator: string;
    character_version: string;
    extensions: Record<string, unknown>;
  };
};

export type TavernCharacterBookEntry = {
  keys: string[];
  content: string;
  extensions: Record<string, unknown>;
  enabled: boolean;
  insertion_order: number;
  case_sensitive?: boolean;
  name?: string;
  priority?: number;
  id?: number;
  comment?: string;
  selective?: boolean;
  secondary_keys?: string[];
  constant?: boolean;
  position?: 'before_char' | 'after_char';
};

export type TavernCharacterBook = {
  name?: string;
  description?: string;
  scan_depth?: number;
  token_budget?: number;
  recursive_scanning?: boolean;
  extensions: Record<string, unknown>;
  entries: TavernCharacterBookEntry[];
};

export const tavernCharacterBookEntrySchema = z.object({
  keys: z.array(z.string().min(1)),
  content: z.string(),
  extensions: z.record(z.string(), z.unknown()),
  enabled: z.boolean(),
  insertion_order: z.number().int(),
  case_sensitive: z.boolean().optional(),
  name: z.string().optional(),
  priority: z.number().optional(),
  id: z.number().int().nonnegative().optional(),
  comment: z.string().optional(),
  selective: z.boolean().optional(),
  secondary_keys: z.array(z.string()).optional(),
  constant: z.boolean().optional(),
  position: z.enum(['before_char', 'after_char']).optional(),
}).passthrough();

export const tavernCharacterBookSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  scan_depth: z.number().int().nonnegative().optional(),
  token_budget: z.number().int().positive().optional(),
  recursive_scanning: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()),
  entries: z.array(tavernCharacterBookEntrySchema),
}).passthrough();

export const tavernCardV2Schema = z.object({
  spec: z.literal('chara_card_v2'),
  spec_version: z.literal('2.0'),
  data: z.object({
    name: z.string(),
    description: z.string(),
    personality: z.string(),
    scenario: z.string(),
    first_mes: z.string(),
    mes_example: z.string(),
    creator_notes: z.string(),
    system_prompt: z.string(),
    post_history_instructions: z.string(),
    alternate_greetings: z.array(z.string()),
    character_book: tavernCharacterBookSchema.optional(),
    tags: z.array(z.string()),
    creator: z.string(),
    character_version: z.string(),
    extensions: z.record(z.string(), z.unknown()),
  }).passthrough(),
}).passthrough();

export const PLAYABLE_BUNDLE_SPEC_VERSION = '2.0' as const;

export const playableBundleFileRecordSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['character-card', 'character-book', 'relationship-world-info', 'place-world-info', 'entry-point']),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative(),
  identityId: z.string().min(1).optional(),
  identityName: z.string().min(1).optional(),
});

export const playableBundleManifestSchema = z.object({
  format: z.literal('novel-world-playable-bundle'),
  // Keep historical 1.0 packages readable; new exports use detached worldbooks.
  spec_version: z.union([z.literal('1.0'), z.literal(PLAYABLE_BUNDLE_SPEC_VERSION)]),
  schema_version: z.number().int().positive(),
  project: z.object({ id: z.string().min(1), name: z.string().min(1), revision_id: z.string().min(1) }),
  entry_point: z.object({ event_id: z.string().min(1), title: z.string().min(1), narrative_ordinal: z.number().int().nonnegative() }),
  source_fingerprints: z.object({
    character_cards: z.string().regex(/^[a-f0-9]{64}$/u),
    relationship_world_info: z.string().regex(/^[a-f0-9]{64}$/u),
    place_world_info: z.string().regex(/^[a-f0-9]{64}$/u),
    character_book: z.string().regex(/^[a-f0-9]{64}$/u),
    bundle: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  character_count: z.number().int().positive(),
  character_book_entry_count: z.number().int().nonnegative(),
  files: z.array(playableBundleFileRecordSchema).min(5),
});

export type PlayableBundleFileRecord = {
  path: string;
  kind: 'character-card' | 'character-book' | 'relationship-world-info' | 'place-world-info' | 'entry-point';
  checksum: string;
  bytes: number;
  identityId?: string;
  identityName?: string;
};

export type PlayableBundleManifest = {
  format: 'novel-world-playable-bundle';
  spec_version: '1.0' | typeof PLAYABLE_BUNDLE_SPEC_VERSION;
  schema_version: number;
  project: { id: string; name: string; revision_id: string };
  entry_point: { event_id: string; title: string; narrative_ordinal: number };
  source_fingerprints: {
    character_cards: string;
    relationship_world_info: string;
    place_world_info: string;
    character_book: string;
    bundle: string;
  };
  character_count: number;
  character_book_entry_count: number;
  files: PlayableBundleFileRecord[];
};

export type PlayableBundleExportResult = {
  outputDirectory: string;
  packageDirectory: string;
  bundleFingerprint: string;
  reused: boolean;
  manifest: PlayableBundleManifest;
};

export type PlayableBundleValidationIssue = {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
};

export type PlayableBundleValidationFile = {
  path: string;
  kind?: PlayableBundleFileRecord['kind'];
  status: 'ok' | 'missing' | 'unsafe-path' | 'checksum-mismatch' | 'size-mismatch' | 'invalid-json' | 'invalid-schema';
  expectedChecksum?: string;
  actualChecksum?: string;
  expectedBytes?: number;
  actualBytes?: number;
};

export type PlayableBundleValidationReport = {
  checkedAt: string;
  packageDirectory: string;
  valid: boolean;
  sillyTavernCompatible: boolean;
  compatibilityProfile: 'SillyTavern 1.18 / Character Card V2';
  currentProjectMatch: boolean;
  manifest: PlayableBundleManifest | null;
  fileCount: number;
  validFileCount: number;
  characterCount: number;
  characterBookEntryCount: number;
  files: PlayableBundleValidationFile[];
  issues: PlayableBundleValidationIssue[];
};

export const characterCardRefinementOutputSchema = z.object({
  fields: z.object({
    description: z.object({ text: z.string().max(30_000), source_keys: z.array(z.string().min(1)).min(1).max(200) }),
    personality: z.object({ text: z.string().max(20_000), source_keys: z.array(z.string().min(1)).min(1).max(200) }),
    scenario: z.object({ text: z.string().max(20_000), source_keys: z.array(z.string().min(1)).min(1).max(200) }),
    first_mes: z.object({ text: z.string().max(20_000), source_keys: z.array(z.string().min(1)).min(1).max(200) }),
    mes_example: z.object({ text: z.string().max(30_000), source_keys: z.array(z.string().min(1)).min(1).max(200) }),
  }),
  change_summary: z.array(z.string().max(500)).max(30),
  warnings: z.array(z.string().max(500)).max(30),
});

export type CharacterCardRefinementOutput = z.infer<typeof characterCardRefinementOutputSchema>;
export type CharacterCardRefineField = 'description' | 'personality' | 'scenario' | 'firstMes' | 'mesExample';

export type CharacterCardRefinementWorkItem = {
  identityId: string;
  identityName: string;
  entryEventId: string;
  entryEventTitle: string;
  model: string;
  promptVersion: string;
  draft: Pick<CharacterCardDraftFields, CharacterCardRefineField>;
  sources: Array<{ key: string; kind: 'fact' | 'quote' | 'entry' | 'draft'; label: string; content: string }>;
};

export type CharacterCardRefinementRecord = {
  id: string;
  identityId: string;
  model: string;
  promptVersion: string;
  original: Pick<CharacterCardDraftFields, CharacterCardRefineField>;
  proposed: Pick<CharacterCardDraftFields, CharacterCardRefineField>;
  sourceKeys: Record<CharacterCardRefineField, string[]>;
  changeSummary: string[];
  warnings: string[];
  status: 'pending' | 'applied' | 'rejected';
  appliedFields: CharacterCardRefineField[];
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  reviewedAt: string | null;
};

export type CharacterCardQualityReport = {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  contentReady: boolean;
  approximateCharacters: number;
  approximateTokens: number;
  issues: Array<{ severity: 'error' | 'warning' | 'info'; code: string; message: string }>;
};

export type CharacterCardBatchItem = {
  identityId: string;
  identityName: string;
  importanceTier: 'core' | 'important';
  confirmedFactCount: number;
  hasDraft: boolean;
  reviewStatus: 'none' | 'draft' | 'reviewed';
  entryEventId: string | null;
  entryEventTitle: string | null;
  quality: CharacterCardQualityReport | null;
  exportReady: boolean;
};

export type CharacterCardBatchGenerationSummary = {
  entryEventId: string;
  targetCount: number;
  generatedCount: number;
  skippedCount: number;
  failedCount: number;
  results: Array<{ identityId: string; identityName: string; status: 'generated' | 'skipped' | 'failed'; message: string }>;
};

export type CharacterRuntimeWorkItem = {
  runId: string;
  sessionId: string | null;
  turnIndex: number;
  historyTurnCount: number;
  identityId: string;
  identityName: string;
  entryEventId: string;
  entryEventTitle: string;
  entryOrdinal: number;
  model: string;
  promptVersion: 'character-runtime.v1' | 'character-runtime.v2' | 'character-runtime.v3';
  retrievalMode: CharacterRuntimeRetrievalMode;
  retrieval: CharacterRuntimeRetrievalTrace | null;
  systemPrompt: string;
  userPrompt: string;
  claimRules: OutputClaimRule[];
  forbiddenMetaTerms: string[];
  contextFingerprint: string;
};

export type CharacterRuntimeTurnRecord = {
  id: string;
  sessionId: string | null;
  turnIndex: number;
  identityId: string;
  identityName: string;
  entryEventId: string;
  entryEventTitle: string;
  model: string;
  promptVersion: 'character-runtime.v1' | 'character-runtime.v2' | 'character-runtime.v3';
  retrievalMode: CharacterRuntimeRetrievalMode;
  retrieval: CharacterRuntimeRetrievalTrace | null;
  question: string;
  contextFingerprint: string;
  status: 'prepared' | 'delivered' | 'blocked' | 'failed';
  firstCandidate: string;
  finalCandidate: string;
  deliveredAnswer: string;
  gate: EpistemicOutputGateResult | null;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type CharacterRuntimeSessionRecord = {
  id: string;
  identityId: string;
  identityName: string;
  entryEventId: string;
  entryEventTitle: string;
  model: string;
  retrievalMode: CharacterRuntimeRetrievalMode;
  cardSourceFingerprint: string;
  status: 'active' | 'closed';
  maxHistoryTurns: number;
  turnCount: number;
  deliveredTurnCount: number;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type CharacterRuntimeRetrievalMode = 'off' | 'explainable-v1';

export type CharacterRuntimeRetrievalItem = {
  rank: number;
  kind: 'fact' | 'relationship' | 'place' | 'paragraph';
  sourceId: string;
  sourceOrdinal: number | null;
  title: string;
  content: string;
  reason: string;
  matchedTerms: string[];
  approxTokens: number;
};

export type CharacterRuntimeRetrievalTrace = {
  version: 'character-runtime-retrieval.v1';
  query: string;
  entryOrdinal: number;
  budgetTokens: number;
  approxTokens: number;
  candidateCount: number;
  omittedCount: number;
  items: CharacterRuntimeRetrievalItem[];
};

export type BackupRestoreResult = {
  projectPath: string;
  projectId: string;
  name: string;
  fileCount: number;
};

export type WorkerRequestMap = {
  'project:create': { name: string; rootPath: string };
  'project:open': { rootPath: string };
  'project:get': undefined;
  'project:diagnostics': { mode: 'quick' | 'full' };
  'refinement:dashboard': undefined;
  'automation:finalize': { selectionRunId: string };
  'artifacts:foundation-status': { entryEventId?: string };
  'artifacts:foundation-generate': { entryEventId: string };
  'artifacts:playable-bundle-export': { entryEventId: string; outputDirectory: string };
  'artifacts:playable-bundle-validate': { packageDirectory: string };
  'artifacts:play-session-prepare': { packageDirectory: string; options?: import('./play-session-options').PlaySessionOptions };
  'artifacts:play-session-prepare-live': { entryEventId: string; options?: import('./play-session-options').PlaySessionOptions };
  'import:preview': { sourcePath: string };
  'import:run': { sourcePath: string; encoding: string };
  'chapters:list': undefined;
  'chapters:rename': { chapterId: string; title: string };
  'chapters:split': { chapterId: string; paragraphOrdinal: number; title: string };
  'chapters:merge-next': { chapterId: string };
  'paragraphs:list': { chapterId?: string; limit?: number; offset?: number };
  'paragraphs:exclude': { paragraphId: string; excluded: boolean };
  'chunks:build': ChunkSettings;
  'chunks:list': undefined;
  'chunks:inspect': { chunkId: string };
  'search': { query: string; limit?: number };
  'evidence:anchor': { paragraphId: string };
  'source-spans:inspect': { sourceSpanId: string };
  'jobs:list': undefined;
  'jobs:control': { jobId: string; action: 'pause' | 'resume' | 'cancel' | 'retry' };
  'workflows:foundation-create': { model: string; profile: string; tokenBudget?: number | null; localOptions?: import('./local-foundation').LocalGenerationOptions };
  'workflows:local-next': { runId: string };
  'workflows:local-upgrade': { runId: string };
  'workflows:local-result': { runId: string };
  'workflows:local-export': import('./local-foundation').LocalFoundationExportOptions;
  'workflows:foundation-list': undefined;
  'workflows:foundation-get': { runId: string };
  'workflows:foundation-budget': { runId: string; tokenBudget: number | null };
  'workflows:foundation-step': {
    runId: string;
    stepKey: FoundationWorkflowStepKey;
    state: FoundationWorkflowStepState;
    message: string;
    progress?: number;
    childJobId?: string | null;
    output?: unknown;
    error?: string | null;
  };
  'workflows:foundation-fail': { runId: string; error: string };
  'workflows:foundation-control': { runId: string; action: FoundationWorkflowControlAction };
  'draft-selections:create': { workflowRunId: string; profile: string };
  'draft-selections:process-next': { jobId: string };
  'draft-selections:get': { runId: string };
  'draft-selections:get-by-job': { jobId: string };
  'backup:create': { outputPath: string };
  'backup:restore': { inputPath: string; targetParent: string };
  'characters:estimate': undefined;
  'characters:scan-create': { model: string; promptVersion: string };
  'characters:scan-next': { jobId: string };
  'characters:scan-ingest': { jobId: string; chunkId: string; result: CharacterScanOutput; rawJson: string; inputTokens: number; outputTokens: number };
  'characters:scan-error': { jobId: string; chunkId: string; error: string; terminal: boolean };
  'characters:list': undefined;
  'characters:mentions': { identityId: string };
  'characters:review': { identityId: string; status?: 'pending' | 'confirmed' | 'rejected'; importanceTier?: CharacterCandidate['importanceTier'] };
  'characters:aliases': { identityId: string };
  'characters:alias-review': { aliasId: string; status: CharacterAliasRecord['reviewStatus'] };
  'characters:links': { identityId: string };
  'characters:link-review': { linkId: string; status: CharacterIdentityLinkRecord['reviewStatus'] };
  'characters:merge': { sourceIdentityId: string; targetIdentityId: string };
  'characters:split': { sourceIdentityId: string; mentionIds: string[]; canonicalName: string };
  'characters:link': { leftIdentityId: string; rightIdentityId: string; relation: 'cannot_link' | 'must_link'; reason: string };
  'characters:operations': undefined;
  'characters:undo': undefined;
  'facts:estimate': { identityId: string };
  'facts:run-create': { identityId: string; model: string; promptVersion: string; extractionPasses: 1 | 2 };
  'facts:draft-run-create': { selectionRunId: string; identityId: string; model: string; promptVersion: string; extractionPasses: 1 | 2 };
  'facts:run-next': { jobId: string };
  'facts:run-ingest': { jobId: string; batchOrdinal: number; result: CharacterFactOutput; rawJson: string; inputTokens: number; outputTokens: number };
  'facts:run-error': { jobId: string; batchOrdinal: number; error: string; terminal: boolean };
  'facts:list': { identityId: string };
  'facts:evidence': { factId: string };
  'facts:review': { factId: string; status: CharacterFactRecord['reviewStatus'] };
  'draft-quotes:create': { selectionRunId: string };
  'draft-quotes:process-next': { jobId: string };
  'draft-quotes:get': { runId: string };
  'draft-quotes:get-by-job': { jobId: string };
  'quotes:scan': undefined;
  'quotes:summary': undefined;
  'quotes:list': { limit?: number; offset?: number; unresolvedOnly?: boolean };
  'quotes:attributions': { quoteId: string };
  'quotes:review': { attributionId: string; status: QuoteAttributionRecord['reviewStatus'] };
  'quotes:assign': { quoteId: string; identityId: string };
  'quotes:analyze-local': undefined;
  'quotes:profiles': undefined;
  'facts:consolidate-local': undefined;
  'facts:clusters': { identityId?: string };
  'facts:cluster-members': { clusterId: string };
  'facts:relations': { identityId?: string };
  'facts:relation-review': { relationId: string; status: 'pending' | 'confirmed' | 'rejected'; resolvedRelation?: Exclude<FactRelationKind, 'uncertain'> };
  'facts:transitions': { identityId?: string };
  'timeline:time-scan': undefined;
  'timeline:draft-time-scan': { selectionRunId: string };
  'timeline:time-summary': undefined;
  'timeline:time-list': { status?: TimeExpressionReviewStatus };
  'timeline:time-review': { id: string; status: TimeExpressionReviewStatus; normalizedValue?: string | null };
  'timeline:events-estimate': undefined;
  'timeline:events-run-create': { model: string; promptVersion: string };
  'timeline:events-draft-run-create': { selectionRunId: string; model: string; promptVersion: string };
  'timeline:events-run-next': { jobId: string };
  'timeline:events-run-ingest': { jobId: string; chunkId: string; result: TimelineEventOutput; rawJson: string; inputTokens: number; outputTokens: number };
  'timeline:events-run-error': { jobId: string; chunkId: string; error: string; terminal: boolean };
  'timeline:events-list': { status?: TimeExpressionReviewStatus };
  'timeline:events-review': { eventId: string; status: TimeExpressionReviewStatus };
  'timeline:events-evidence': { eventId: string };
  'timeline:events-participants': { eventId: string };
  'timeline:events-locations': { eventId: string };
  'places:bootstrap-events': undefined;
  'places:draft-bootstrap': { selectionRunId: string; eventRunId: string };
  'places:list': { status?: PlaceReviewStatus };
  'places:mentions': { placeId: string };
  'places:review': { placeId: string; status: PlaceReviewStatus; placeType?: PlaceType; canonicalName?: string };
  'places:aliases': { placeId: string };
  'places:alias-review': { aliasId: string; status: PlaceReviewStatus };
  'places:alias-evidence': { aliasId: string };
  'places:merge': { sourcePlaceId: string; targetPlaceId: string };
  'places:split': { sourcePlaceId: string; mentionIds: string[]; canonicalName: string };
  'places:link': { leftPlaceId: string; rightPlaceId: string; relation: 'cannot_link' | 'must_link'; reason: string };
  'places:links': { placeId?: string };
  'places:link-review': { linkId: string; status: PlaceReviewStatus };
  'places:link-evidence': { linkId: string };
  'places:relation-candidates': { status?: PlaceReviewStatus };
  'places:relation-evidence': { candidateId: string };
  'places:relation-suggestion': { candidateId: string };
  'places:relation-review': { candidateId: string; status: PlaceReviewStatus };
  'places:assertion-create': { candidateId: string };
  'places:assertions-list': { status?: PlaceReviewStatus };
  'places:assertions-at-entry': { entryOrdinal: number };
  'places:map-projection': { entryOrdinal: number };
  'places:map-export': { entryOrdinal: number; outputPath: string };
  'artifacts:worldbook-preview': { entryOrdinal: number };
  'places:world-info-export': { entryOrdinal: number; outputPath: string };
  'places:geometries-list': { status?: PlaceReviewStatus };
  'places:geometry-upsert': PlaceGeometryInput;
  'places:geometry-review': { geometryId: string; status: PlaceReviewStatus };
  'places:geojson-build': { entryOrdinal: number };
  'places:geojson-export': { entryOrdinal: number; outputPath: string };
  'places:assertion-review': { relationId: string; status: PlaceReviewStatus };
  'places:assertion-evidence': { relationId: string };
  'places:operations': undefined;
  'places:undo': undefined;
  'places:model-scan-estimate': undefined;
  'places:model-scan-create': { model: string; promptVersion: string; extractorVersion: string };
  'places:model-scan-next': { jobId: string };
  'places:model-scan-ingest': { jobId: string; chunkId: string; result: PlaceModelOutput; rawJson: string; inputTokens: number; outputTokens: number };
  'places:model-scan-error': { jobId: string; chunkId: string; error: string; terminal: boolean };
  'timeline:relations-consolidate': undefined;
  'timeline:relations-list': undefined;
  'timeline:relations-review': { relationId: string; status: TimeExpressionReviewStatus; resolvedRelation?: TimelineRelationKind };
  'timeline:graph-summary': undefined;
  'timeline:graph-order': undefined;
  'timeline:state-snapshot': { entryEventId: string; identityId?: string };
  'relationships:scan-estimate': undefined;
  'relationships:scan-create': {
    extractorVersion: string;
    mode?: 'local' | 'model';
    model?: string;
    promptVersion?: string;
  };
  'relationships:draft-scan-create': { selectionRunId: string; extractorVersion: string };
  'relationships:scan-info': { jobId: string };
  'relationships:scan-next': { jobId: string };
  'relationships:scan-ingest': { jobId: string; chunkId: string; result: RelationshipScanOutput; rawJson: string; inputTokens?: number; outputTokens?: number };
  'relationships:scan-error': { jobId: string; chunkId: string; error: string; terminal: boolean };
  'relationships:candidates-list': { status?: CharacterRelationshipReviewStatus };
  'relationships:candidate-evidence': { candidateId: string };
  'relationships:candidate-suggestion': { candidateId: string };
  'relationships:candidate-create': CharacterRelationshipCandidateInput;
  'relationships:candidate-review': { candidateId: string; status: CharacterRelationshipReviewStatus };
  'relationships:list': { status?: CharacterRelationshipReviewStatus };
  'relationships:list-at-entry': { entryOrdinal: number };
  'relationships:graph-projection': { entryOrdinal: number };
  'relationships:graph-export': { entryOrdinal: number; outputPath: string };
  'relationships:world-info-export': { entryOrdinal: number; outputPath: string };
  'relationships:create': CharacterRelationshipAssertionInput;
  'relationships:review': { relationshipId: string; status: CharacterRelationshipReviewStatus };
  'relationships:evidence': { relationshipId: string };
  'cards:draft-get': { identityId: string };
  'cards:draft-generate': { identityId: string; entryEventId: string };
  'cards:draft-save': { identityId: string; fields: CharacterCardDraftFields; reviewStatus: 'draft' | 'reviewed' };
  'cards:export-json': { identityId: string; outputPath: string };
  'cards:refinement-prepare': { identityId: string; model: string; promptVersion: string };
  'cards:refinement-ingest': { identityId: string; model: string; promptVersion: string; result: CharacterCardRefinementOutput; rawJson: string; inputTokens: number; outputTokens: number };
  'cards:refinement-latest': { identityId: string };
  'cards:refinement-review': { refinementId: string; action: 'apply' | 'reject'; fields?: CharacterCardRefineField[] };
  'cards:batch-status': undefined;
  'cards:batch-generate': { entryEventId: string };
  'cards:batch-export': { outputDirectory: string };
  'runtime:prepare': { identityId: string; question: string; model: string; retrievalMode?: CharacterRuntimeRetrievalMode };
  'runtime:session-create': { identityId: string; model: string; retrievalMode?: CharacterRuntimeRetrievalMode };
  'runtime:session-close': { sessionId: string };
  'runtime:session-list': { identityId: string; limit?: number };
  'runtime:session-prepare': { sessionId: string; question: string };
  'runtime:session-turns': { sessionId: string; limit?: number };
  'runtime:complete': {
    runId: string;
    firstCandidate: string;
    finalCandidate: string;
    attempts: 1 | 2;
    inputTokens: number;
    outputTokens: number;
  };
  'runtime:fail': { runId: string; error: string };
  'runtime:list': { identityId: string; limit?: number };
};

export type WorkerResponseMap = {
  'project:create': ProjectSummary;
  'project:open': ProjectSummary;
  'project:get': ProjectSummary | null;
  'project:diagnostics': ProjectDiagnosticReport;
  'refinement:dashboard': RefinementDashboard;
  'automation:finalize': AutomaticFinalizationResult;
  'artifacts:foundation-status': ArtifactFoundationDashboard;
  'artifacts:foundation-generate': ArtifactFoundationGenerationResult;
  'artifacts:playable-bundle-export': PlayableBundleExportResult;
  'artifacts:playable-bundle-validate': PlayableBundleValidationReport;
  'artifacts:play-session-prepare': import('./play-session-assembly').SessionAssemblyPlan;
  'artifacts:play-session-prepare-live': import('./play-session-assembly').SessionAssemblyPlan;
  'import:preview': ImportPreview;
  'import:run': ImportResult;
  'chapters:list': ChapterRecord[];
  'chapters:rename': ChapterRecord[];
  'chapters:split': ChapterRecord[];
  'chapters:merge-next': ChapterRecord[];
  'paragraphs:list': ParagraphRecord[];
  'paragraphs:exclude': { ok: true };
  'chunks:build': ChunkRecord[];
  'chunks:list': ChunkRecord[];
  'chunks:inspect': ChunkInspection;
  'search': SearchHit[];
  'evidence:anchor': EvidenceAnchorRecord;
  'source-spans:inspect': SourceSpanInspection;
  'jobs:list': JobRecord[];
  'jobs:control': JobRecord[];
  'workflows:foundation-create': FoundationWorkflowStart;
  'workflows:local-next': FoundationWorkflowRunRecord;
  'workflows:local-upgrade': FoundationWorkflowStart;
  'workflows:local-result': import('./local-foundation').LocalFoundationResult;
  'workflows:local-export': import('./local-foundation').LocalFoundationExportResult;
  'workflows:foundation-list': FoundationWorkflowRunRecord[];
  'workflows:foundation-get': FoundationWorkflowRunRecord;
  'workflows:foundation-budget': FoundationWorkflowRunRecord;
  'workflows:foundation-step': FoundationWorkflowRunRecord;
  'workflows:foundation-fail': FoundationWorkflowRunRecord;
  'workflows:foundation-control': FoundationWorkflowRunRecord;
  'draft-selections:create': AutomationDraftSelectionStart;
  'draft-selections:process-next': AutomationDraftSelectionRunRecord;
  'draft-selections:get': AutomationDraftSelectionRunRecord;
  'draft-selections:get-by-job': AutomationDraftSelectionRunRecord;
  'backup:create': { outputPath: string; checksum: string };
  'backup:restore': BackupRestoreResult;
  'characters:estimate': CharacterScanEstimate;
  'characters:scan-create': CharacterScanStart;
  'characters:scan-next': CharacterScanWorkItem | null;
  'characters:scan-ingest': { state: JobRecord['state']; progress: number };
  'characters:scan-error': { state: JobRecord['state']; progress: number };
  'characters:list': CharacterCandidate[];
  'characters:mentions': CharacterMentionRecord[];
  'characters:review': CharacterCandidate[];
  'characters:aliases': CharacterAliasRecord[];
  'characters:alias-review': CharacterAliasRecord[];
  'characters:links': CharacterIdentityLinkRecord[];
  'characters:link-review': CharacterIdentityLinkRecord[];
  'characters:merge': CharacterCandidate[];
  'characters:split': CharacterCandidate[];
  'characters:link': CharacterCandidate[];
  'characters:operations': IdentityOperationRecord[];
  'characters:undo': { operation: IdentityOperationRecord; characters: CharacterCandidate[] };
  'facts:estimate': CharacterFactEstimate;
  'facts:run-create': CharacterScanStart;
  'facts:draft-run-create': CharacterScanStart;
  'facts:run-next': CharacterFactWorkItem | null;
  'facts:run-ingest': { state: JobRecord['state']; progress: number };
  'facts:run-error': { state: JobRecord['state']; progress: number };
  'facts:list': CharacterFactRecord[];
  'facts:evidence': CharacterFactEvidenceRecord[];
  'facts:review': CharacterFactRecord[];
  'draft-quotes:create': AutomationDraftQuoteStart;
  'draft-quotes:process-next': AutomationDraftQuoteRunRecord;
  'draft-quotes:get': AutomationDraftQuoteRunRecord;
  'draft-quotes:get-by-job': AutomationDraftQuoteRunRecord;
  'quotes:scan': QuoteScanSummary;
  'quotes:summary': QuoteScanSummary;
  'quotes:list': CharacterQuoteRecord[];
  'quotes:attributions': QuoteAttributionRecord[];
  'quotes:review': QuoteAttributionRecord[];
  'quotes:assign': QuoteAttributionRecord[];
  'quotes:analyze-local': QuoteLocalAnalysisSummary;
  'quotes:profiles': SpeechProfileRecord[];
  'facts:consolidate-local': FactConsolidationSummary;
  'facts:clusters': FactClusterRecord[];
  'facts:cluster-members': CharacterFactRecord[];
  'facts:relations': FactRelationRecord[];
  'facts:relation-review': FactRelationRecord[];
  'facts:transitions': CharacterStateTransitionRecord[];
  'timeline:time-scan': TimeExpressionScanSummary;
  'timeline:draft-time-scan': AutomationDraftTimeRunRecord;
  'timeline:time-summary': Omit<TimeExpressionScanSummary, 'detectedCount' | 'insertedCount'>;
  'timeline:time-list': TimeExpressionRecord[];
  'timeline:time-review': TimeExpressionRecord[];
  'timeline:events-estimate': TimelineEventEstimate;
  'timeline:events-run-create': CharacterScanStart;
  'timeline:events-draft-run-create': CharacterScanStart;
  'timeline:events-run-next': TimelineEventWorkItem | null;
  'timeline:events-run-ingest': { state: JobRecord['state']; progress: number };
  'timeline:events-run-error': { state: JobRecord['state']; progress: number };
  'timeline:events-list': TimelineEventRecord[];
  'timeline:events-review': TimelineEventRecord[];
  'timeline:events-evidence': TimelineEventEvidenceRecord[];
  'timeline:events-participants': TimelineEventParticipantRecord[];
  'timeline:events-locations': TimelineEventLocationRecord[];
  'places:bootstrap-events': PlaceBootstrapSummary;
  'places:draft-bootstrap': AutomationDraftPlaceRunRecord;
  'places:list': PlaceRecord[];
  'places:mentions': PlaceMentionRecord[];
  'places:review': PlaceRecord[];
  'places:aliases': PlaceAliasRecord[];
  'places:alias-review': PlaceAliasRecord[];
  'places:alias-evidence': PlaceSuggestionEvidenceRecord[];
  'places:merge': PlaceRecord[];
  'places:split': PlaceRecord[];
  'places:link': PlaceIdentityLinkRecord[];
  'places:links': PlaceIdentityLinkRecord[];
  'places:link-review': PlaceIdentityLinkRecord[];
  'places:link-evidence': PlaceSuggestionEvidenceRecord[];
  'places:relation-candidates': PlaceRelationCandidateRecord[];
  'places:relation-evidence': PlaceSuggestionEvidenceRecord[];
  'places:relation-suggestion': PlaceRelationModelSuggestionRecord | null;
  'places:relation-review': PlaceRelationCandidateRecord[];
  'places:assertion-create': PlaceRelationRecord;
  'places:assertions-list': PlaceRelationRecord[];
  'places:assertions-at-entry': PlaceRelationRecord[];
  'places:map-projection': NarrativeMapProjection;
  'places:map-export': NarrativeMapExportResult;
  'artifacts:worldbook-preview': { relationships: SillyTavernWorldInfoExport; places: SillyTavernPlaceWorldInfoExport };
  'places:world-info-export': SillyTavernPlaceWorldInfoExportResult;
  'places:geometries-list': PlaceGeometryRecord[];
  'places:geometry-upsert': PlaceGeometryRecord;
  'places:geometry-review': PlaceGeometryRecord[];
  'places:geojson-build': PlaceGeoJson;
  'places:geojson-export': PlaceGeoJsonExportResult;
  'places:assertion-review': PlaceRelationRecord[];
  'places:assertion-evidence': PlaceRelationEvidenceRecord[];
  'places:operations': PlaceIdentityOperationRecord[];
  'places:undo': { operation: PlaceIdentityOperationRecord; places: PlaceRecord[] };
  'places:model-scan-estimate': PlaceModelScanEstimate;
  'places:model-scan-create': CharacterScanStart;
  'places:model-scan-next': PlaceModelScanWorkItem | null;
  'places:model-scan-ingest': { state: JobRecord['state']; progress: number };
  'places:model-scan-error': { state: JobRecord['state']; progress: number };
  'timeline:relations-consolidate': TimelineRelationConsolidationSummary;
  'timeline:relations-list': TimelineRelationRecord[];
  'timeline:relations-review': TimelineRelationRecord[];
  'timeline:graph-summary': TimelineGraphSummary;
  'timeline:graph-order': TimelineOrderRecord[];
  'timeline:state-snapshot': StoryStateSnapshot;
  'relationships:scan-estimate': RelationshipScanEstimate;
  'relationships:scan-create': CharacterScanStart;
  'relationships:draft-scan-create': CharacterScanStart;
  'relationships:scan-info': { mode: 'local' | 'model' };
  'relationships:scan-next': RelationshipScanWorkItem | null;
  'relationships:scan-ingest': { state: JobRecord['state']; progress: number };
  'relationships:scan-error': { state: JobRecord['state']; progress: number };
  'relationships:candidates-list': CharacterRelationshipCandidateRecord[];
  'relationships:candidate-evidence': CharacterRelationshipCandidateEvidenceRecord[];
  'relationships:candidate-suggestion': RelationshipModelSuggestionRecord | null;
  'relationships:candidate-create': CharacterRelationshipCandidateRecord;
  'relationships:candidate-review': CharacterRelationshipCandidateRecord[];
  'relationships:list': CharacterRelationshipRecord[];
  'relationships:list-at-entry': CharacterRelationshipRecord[];
  'relationships:graph-projection': RelationshipGraphProjection;
  'relationships:graph-export': CharacterGraphExportResult;
  'relationships:world-info-export': SillyTavernWorldInfoExportResult;
  'relationships:create': CharacterRelationshipRecord;
  'relationships:review': CharacterRelationshipRecord[];
  'relationships:evidence': CharacterRelationshipEvidenceRecord[];
  'cards:draft-get': CharacterCardDraftRecord | null;
  'cards:draft-generate': CharacterCardDraftRecord;
  'cards:draft-save': CharacterCardDraftRecord;
  'cards:export-json': { outputPath: string; checksum: string; card: TavernCardV2 };
  'cards:refinement-prepare': CharacterCardRefinementWorkItem;
  'cards:refinement-ingest': CharacterCardRefinementRecord;
  'cards:refinement-latest': CharacterCardRefinementRecord | null;
  'cards:refinement-review': { refinement: CharacterCardRefinementRecord; draft: CharacterCardDraftRecord };
  'cards:batch-status': CharacterCardBatchItem[];
  'cards:batch-generate': CharacterCardBatchGenerationSummary;
  'cards:batch-export': { outputDirectory: string; exportedCount: number; files: Array<{ identityId: string; identityName: string; outputPath: string; checksum: string }> };
  'runtime:prepare': CharacterRuntimeWorkItem;
  'runtime:session-create': CharacterRuntimeSessionRecord;
  'runtime:session-close': CharacterRuntimeSessionRecord;
  'runtime:session-list': CharacterRuntimeSessionRecord[];
  'runtime:session-prepare': CharacterRuntimeWorkItem;
  'runtime:session-turns': CharacterRuntimeTurnRecord[];
  'runtime:complete': CharacterRuntimeTurnRecord;
  'runtime:fail': CharacterRuntimeTurnRecord;
  'runtime:list': CharacterRuntimeTurnRecord[];
};

export type WorkerChannel = keyof WorkerRequestMap;

export type SillyTavernStatus = {
  state: 'stopped' | 'starting' | 'ready' | 'error';
  version: string | null;
  runtimeRoot: string;
  dataRoot: string;
  baseUrl: string | null;
  pid: number | null;
  message: string;
  bundled: boolean;
};

export type AppApi = {
  platform: NodeJS.Platform;
  versions: { app: string; electron: string };
  getSillyTavernStatus(): Promise<SillyTavernStatus>;
  startSillyTavern(): Promise<SillyTavernStatus>;
  stopSillyTavern(): Promise<SillyTavernStatus>;
  showSillyTavern(): Promise<SillyTavernStatus>;
  hideSillyTavern(): Promise<SillyTavernStatus>;
  createProject(name: string): Promise<ProjectSummary | null>;
  openProject(): Promise<ProjectSummary | null>;
  listProjectLibrary(): Promise<ProjectSummary[]>;
  inspectProjectBundle(id: string): Promise<ProjectBundleAvailability>;
  listProjectPlayEntries(id: string): Promise<import('./play-session-options').PlayableEntryChoice[]>;
  prepareProjectPlay(id: string, entryEventId?: string, options?: import('./play-session-options').PlaySessionOptions): Promise<import('./play-session-options').PlaySessionPreview>;
  launchProjectPlay(id: string, options: import('./play-session-options').PlaySessionOptions, settingsPage?: 'model' | 'tuning' | 'other'): Promise<SillyTavernStatus>;
  openRecentProject(id: string): Promise<ProjectSummary>;
  getProject(): Promise<ProjectSummary | null>;
  runProjectDiagnostics(mode: 'quick' | 'full'): Promise<ProjectDiagnosticReport>;
  getRefinementDashboard(): Promise<RefinementDashboard>;
  getArtifactFoundationStatus(entryEventId?: string): Promise<ArtifactFoundationDashboard>;
  generateArtifactFoundation(entryEventId: string): Promise<ArtifactFoundationGenerationResult>;
  exportPlayableBundle(entryEventId: string): Promise<PlayableBundleExportResult | null>;
  validatePlayableBundle(): Promise<PlayableBundleValidationReport | null>;
  previewImport(): Promise<ImportPreview | null>;
  runImport(sourcePath: string, encoding: string): Promise<ImportResult>;
  listChapters(): Promise<ChapterRecord[]>;
  renameChapter(chapterId: string, title: string): Promise<ChapterRecord[]>;
  splitChapter(chapterId: string, paragraphOrdinal: number, title: string): Promise<ChapterRecord[]>;
  mergeChapterWithNext(chapterId: string): Promise<ChapterRecord[]>;
  listParagraphs(chapterId?: string): Promise<ParagraphRecord[]>;
  setParagraphExcluded(paragraphId: string, excluded: boolean): Promise<{ ok: true }>;
  buildChunks(settings: ChunkSettings): Promise<ChunkRecord[]>;
  listChunks(): Promise<ChunkRecord[]>;
  inspectChunk(chunkId: string): Promise<ChunkInspection>;
  search(query: string): Promise<SearchHit[]>;
  getEvidenceAnchor(paragraphId: string): Promise<EvidenceAnchorRecord>;
  inspectSourceSpan(sourceSpanId: string): Promise<SourceSpanInspection>;
  listJobs(): Promise<JobRecord[]>;
  controlJob(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<JobRecord[]>;
  startFoundationWorkflow(options: { model: string; profile?: string; tokenBudget?: number | null; localOptions?: import('./local-foundation').LocalGenerationOptions }): Promise<FoundationWorkflowStart>;
  getLocalFoundationResult(runId: string): Promise<import('./local-foundation').LocalFoundationResult>;
  upgradeLocalFoundation(runId: string): Promise<FoundationWorkflowStart>;
  exportLocalFoundation(options: import('./local-foundation').LocalFoundationExportOptions): Promise<import('./local-foundation').LocalFoundationExportResult>;
  listFoundationWorkflows(): Promise<FoundationWorkflowRunRecord[]>;
  getFoundationUsage(runId: string): Promise<FoundationUsageSummary>;
  updateFoundationTokenBudget(runId: string, tokenBudget: number | null): Promise<FoundationWorkflowRunRecord>;
  controlFoundationWorkflow(runId: string, action: FoundationWorkflowControlAction): Promise<FoundationWorkflowRunRecord>;
  createBackup(): Promise<{ outputPath: string; checksum: string } | null>;
  restoreBackup(): Promise<ProjectSummary | null>;
  getApiStatus(): Promise<ApiStatus>;
  saveApiConfig(config: { provider: string; baseUrl: string; apiKey?: string; preferredModel: string; requestSettings?: ApiRequestSettings }): Promise<ApiStatus>;
  testApiConnection(): Promise<{ ok: boolean; message: string }>;
  listApiModels(): Promise<ApiModelList>;
  estimateCharacterScan(): Promise<CharacterScanEstimate>;
  startCharacterScan(options: { model: string; promptVersion?: string }): Promise<CharacterScanStart>;
  listCharacters(): Promise<CharacterCandidate[]>;
  listCharacterMentions(identityId: string): Promise<CharacterMentionRecord[]>;
  reviewCharacter(identityId: string, changes: { status?: 'pending' | 'confirmed' | 'rejected'; importanceTier?: CharacterCandidate['importanceTier'] }): Promise<CharacterCandidate[]>;
  listCharacterAliases(identityId: string): Promise<CharacterAliasRecord[]>;
  reviewCharacterAlias(aliasId: string, status: CharacterAliasRecord['reviewStatus']): Promise<CharacterAliasRecord[]>;
  listCharacterIdentityLinks(identityId: string): Promise<CharacterIdentityLinkRecord[]>;
  reviewCharacterIdentityLink(linkId: string, status: CharacterIdentityLinkRecord['reviewStatus']): Promise<CharacterIdentityLinkRecord[]>;
  mergeCharacters(sourceIdentityId: string, targetIdentityId: string): Promise<CharacterCandidate[]>;
  splitCharacter(sourceIdentityId: string, mentionIds: string[], canonicalName: string): Promise<CharacterCandidate[]>;
  linkCharacters(leftIdentityId: string, rightIdentityId: string, relation: 'cannot_link' | 'must_link', reason: string): Promise<CharacterCandidate[]>;
  listIdentityOperations(): Promise<IdentityOperationRecord[]>;
  undoLastIdentityOperation(): Promise<{ operation: IdentityOperationRecord; characters: CharacterCandidate[] }>;
  estimateCharacterFacts(identityId: string): Promise<CharacterFactEstimate>;
  startCharacterFactExtraction(options: { identityId: string; model: string; promptVersion?: string; extractionPasses?: 1 | 2 }): Promise<CharacterScanStart>;
  listCharacterFacts(identityId: string): Promise<CharacterFactRecord[]>;
  listCharacterFactEvidence(factId: string): Promise<CharacterFactEvidenceRecord[]>;
  reviewCharacterFact(factId: string, status: CharacterFactRecord['reviewStatus']): Promise<CharacterFactRecord[]>;
  scanCharacterQuotes(): Promise<QuoteScanSummary>;
  getCharacterQuoteSummary(): Promise<QuoteScanSummary>;
  listCharacterQuotes(options?: { limit?: number; offset?: number; unresolvedOnly?: boolean }): Promise<CharacterQuoteRecord[]>;
  listQuoteAttributions(quoteId: string): Promise<QuoteAttributionRecord[]>;
  reviewQuoteAttribution(attributionId: string, status: QuoteAttributionRecord['reviewStatus']): Promise<QuoteAttributionRecord[]>;
  assignQuoteSpeaker(quoteId: string, identityId: string): Promise<QuoteAttributionRecord[]>;
  analyzeLocalQuoteTurns(): Promise<QuoteLocalAnalysisSummary>;
  listSpeechProfiles(): Promise<SpeechProfileRecord[]>;
  consolidateCharacterFacts(): Promise<FactConsolidationSummary>;
  listFactClusters(identityId?: string): Promise<FactClusterRecord[]>;
  listFactClusterMembers(clusterId: string): Promise<CharacterFactRecord[]>;
  listFactRelations(identityId?: string): Promise<FactRelationRecord[]>;
  reviewFactRelation(relationId: string, status: 'pending' | 'confirmed' | 'rejected', resolvedRelation?: Exclude<FactRelationKind, 'uncertain'>): Promise<FactRelationRecord[]>;
  listCharacterStateTransitions(identityId?: string): Promise<CharacterStateTransitionRecord[]>;
  scanTimeExpressions(): Promise<TimeExpressionScanSummary>;
  getTimeExpressionSummary(): Promise<Omit<TimeExpressionScanSummary, 'detectedCount' | 'insertedCount'>>;
  listTimeExpressions(status?: TimeExpressionReviewStatus): Promise<TimeExpressionRecord[]>;
  reviewTimeExpression(id: string, status: TimeExpressionReviewStatus, normalizedValue?: string | null): Promise<TimeExpressionRecord[]>;
  estimateTimelineEvents(): Promise<TimelineEventEstimate>;
  startTimelineEventExtraction(options: { model: string; promptVersion?: string }): Promise<CharacterScanStart>;
  listTimelineEvents(status?: TimeExpressionReviewStatus): Promise<TimelineEventRecord[]>;
  reviewTimelineEvent(eventId: string, status: TimeExpressionReviewStatus): Promise<TimelineEventRecord[]>;
  listTimelineEventEvidence(eventId: string): Promise<TimelineEventEvidenceRecord[]>;
  listTimelineEventParticipants(eventId: string): Promise<TimelineEventParticipantRecord[]>;
  listTimelineEventLocations(eventId: string): Promise<TimelineEventLocationRecord[]>;
  bootstrapPlacesFromEvents(): Promise<PlaceBootstrapSummary>;
  listPlaces(status?: PlaceReviewStatus): Promise<PlaceRecord[]>;
  listPlaceMentions(placeId: string): Promise<PlaceMentionRecord[]>;
  reviewPlace(placeId: string, changes: { status: PlaceReviewStatus; placeType?: PlaceType; canonicalName?: string }): Promise<PlaceRecord[]>;
  listPlaceAliases(placeId: string): Promise<PlaceAliasRecord[]>;
  reviewPlaceAlias(aliasId: string, status: PlaceReviewStatus): Promise<PlaceAliasRecord[]>;
  listPlaceAliasEvidence(aliasId: string): Promise<PlaceSuggestionEvidenceRecord[]>;
  mergePlaces(sourcePlaceId: string, targetPlaceId: string): Promise<PlaceRecord[]>;
  splitPlace(sourcePlaceId: string, mentionIds: string[], canonicalName: string): Promise<PlaceRecord[]>;
  linkPlaces(leftPlaceId: string, rightPlaceId: string, relation: 'cannot_link' | 'must_link', reason: string): Promise<PlaceIdentityLinkRecord[]>;
  listPlaceIdentityLinks(placeId?: string): Promise<PlaceIdentityLinkRecord[]>;
  reviewPlaceIdentityLink(linkId: string, status: PlaceReviewStatus): Promise<PlaceIdentityLinkRecord[]>;
  listPlaceIdentityLinkEvidence(linkId: string): Promise<PlaceSuggestionEvidenceRecord[]>;
  listPlaceRelationCandidates(status?: PlaceReviewStatus): Promise<PlaceRelationCandidateRecord[]>;
  listPlaceRelationCandidateEvidence(candidateId: string): Promise<PlaceSuggestionEvidenceRecord[]>;
  getPlaceRelationModelSuggestion(candidateId: string): Promise<PlaceRelationModelSuggestionRecord | null>;
  reviewPlaceRelationCandidate(candidateId: string, status: PlaceReviewStatus): Promise<PlaceRelationCandidateRecord[]>;
  createPlaceRelationFromCandidate(candidateId: string): Promise<PlaceRelationRecord>;
  listPlaceRelations(status?: PlaceReviewStatus): Promise<PlaceRelationRecord[]>;
  listPlaceRelationsAtEntry(entryOrdinal: number): Promise<PlaceRelationRecord[]>;
  getNarrativeMapProjection(entryOrdinal: number): Promise<NarrativeMapProjection>;
  exportNarrativeMap(entryOrdinal: number): Promise<NarrativeMapExportResult | null>;
  exportWorldBook(entryOrdinal: number): Promise<{ outputPath: string; entryCount: number } | null>;
  previewWorldBook(entryOrdinal: number): Promise<{ relationships: SillyTavernWorldInfoExport; places: SillyTavernPlaceWorldInfoExport }>;
  exportPlaceWorldInfo(entryOrdinal: number): Promise<SillyTavernPlaceWorldInfoExportResult | null>;
  listPlaceGeometries(status?: PlaceReviewStatus): Promise<PlaceGeometryRecord[]>;
  upsertPlaceGeometry(input: PlaceGeometryInput): Promise<PlaceGeometryRecord>;
  reviewPlaceGeometry(geometryId: string, status: PlaceReviewStatus): Promise<PlaceGeometryRecord[]>;
  buildPlaceGeoJson(entryOrdinal: number): Promise<PlaceGeoJson>;
  exportPlaceGeoJson(entryOrdinal: number): Promise<PlaceGeoJsonExportResult | null>;
  reviewPlaceRelation(relationId: string, status: PlaceReviewStatus): Promise<PlaceRelationRecord[]>;
  listPlaceRelationEvidence(relationId: string): Promise<PlaceRelationEvidenceRecord[]>;
  listPlaceIdentityOperations(): Promise<PlaceIdentityOperationRecord[]>;
  undoPlaceIdentityOperation(): Promise<{ operation: PlaceIdentityOperationRecord; places: PlaceRecord[] }>;
  estimatePlaceModelScan(): Promise<PlaceModelScanEstimate>;
  startPlaceModelScan(options: { model: string; promptVersion?: string }): Promise<CharacterScanStart>;
  consolidateTimelineRelations(): Promise<TimelineRelationConsolidationSummary>;
  listTimelineRelations(): Promise<TimelineRelationRecord[]>;
  reviewTimelineRelation(relationId: string, status: TimeExpressionReviewStatus, resolvedRelation?: TimelineRelationKind): Promise<TimelineRelationRecord[]>;
  getTimelineGraphSummary(): Promise<TimelineGraphSummary>;
  getTimelineOrder(): Promise<TimelineOrderRecord[]>;
  getStoryStateSnapshot(entryEventId: string, identityId?: string): Promise<StoryStateSnapshot>;
  estimateRelationshipScan(): Promise<RelationshipScanEstimate>;
  startRelationshipScan(options?: {
    extractorVersion?: string;
    mode?: 'local' | 'model';
    model?: string;
    promptVersion?: string;
  }): Promise<CharacterScanStart>;
  listRelationshipCandidates(status?: CharacterRelationshipReviewStatus): Promise<CharacterRelationshipCandidateRecord[]>;
  listRelationshipCandidateEvidence(candidateId: string): Promise<CharacterRelationshipCandidateEvidenceRecord[]>;
  getRelationshipModelSuggestion(candidateId: string): Promise<RelationshipModelSuggestionRecord | null>;
  createRelationshipCandidate(input: CharacterRelationshipCandidateInput): Promise<CharacterRelationshipCandidateRecord>;
  reviewRelationshipCandidate(candidateId: string, status: CharacterRelationshipReviewStatus): Promise<CharacterRelationshipCandidateRecord[]>;
  listRelationships(status?: CharacterRelationshipReviewStatus): Promise<CharacterRelationshipRecord[]>;
  listRelationshipsAtEntry(entryOrdinal: number): Promise<CharacterRelationshipRecord[]>;
  getRelationshipGraphProjection(entryOrdinal: number): Promise<RelationshipGraphProjection>;
  exportRelationshipGraph(entryOrdinal: number): Promise<CharacterGraphExportResult | null>;
  exportRelationshipWorldInfo(entryOrdinal: number): Promise<SillyTavernWorldInfoExportResult | null>;
  createRelationship(input: CharacterRelationshipAssertionInput): Promise<CharacterRelationshipRecord>;
  reviewRelationship(relationshipId: string, status: CharacterRelationshipReviewStatus): Promise<CharacterRelationshipRecord[]>;
  listRelationshipEvidence(relationshipId: string): Promise<CharacterRelationshipEvidenceRecord[]>;
  getCharacterCardDraft(identityId: string): Promise<CharacterCardDraftRecord | null>;
  generateCharacterCardDraft(identityId: string, entryEventId: string): Promise<CharacterCardDraftRecord>;
  saveCharacterCardDraft(identityId: string, fields: CharacterCardDraftFields, reviewStatus: 'draft' | 'reviewed'): Promise<CharacterCardDraftRecord>;
  exportCharacterCardJson(identityId: string): Promise<{ outputPath: string; checksum: string; card: TavernCardV2 } | null>;
  refineCharacterCard(identityId: string, model: string): Promise<CharacterCardRefinementRecord>;
  getLatestCharacterCardRefinement(identityId: string): Promise<CharacterCardRefinementRecord | null>;
  reviewCharacterCardRefinement(refinementId: string, action: 'apply' | 'reject', fields?: CharacterCardRefineField[]): Promise<{ refinement: CharacterCardRefinementRecord; draft: CharacterCardDraftRecord }>;
  getCharacterCardBatchStatus(): Promise<CharacterCardBatchItem[]>;
  generateMissingCharacterCardDrafts(entryEventId: string): Promise<CharacterCardBatchGenerationSummary>;
  exportReviewedCharacterCards(): Promise<{ outputDirectory: string; exportedCount: number; files: Array<{ identityId: string; identityName: string; outputPath: string; checksum: string }> } | null>;
  askCharacter(identityId: string, question: string, model: string, retrievalMode?: CharacterRuntimeRetrievalMode): Promise<CharacterRuntimeTurnRecord>;
  listCharacterRuntimeTurns(identityId: string, limit?: number): Promise<CharacterRuntimeTurnRecord[]>;
  createCharacterRuntimeSession(identityId: string, model: string, retrievalMode?: CharacterRuntimeRetrievalMode): Promise<CharacterRuntimeSessionRecord>;
  closeCharacterRuntimeSession(sessionId: string): Promise<CharacterRuntimeSessionRecord>;
  listCharacterRuntimeSessions(identityId: string, limit?: number): Promise<CharacterRuntimeSessionRecord[]>;
  askCharacterInSession(sessionId: string, question: string): Promise<CharacterRuntimeTurnRecord>;
  listCharacterRuntimeSessionTurns(sessionId: string, limit?: number): Promise<CharacterRuntimeTurnRecord[]>;
};
