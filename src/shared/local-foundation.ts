export type LocalGenerationOptions = { names?: string; maxCards?: number };
export type LocalFoundationResult = {
  runId: string;
  candidateCount: number;
  evidenceCount: number;
  characters: Array<{ name: string; mentions: number; firstOrdinal: number }>;
  chapters: Array<{ title: string; endOrdinal: number }>;
  outputPath: string | null;
  integrated: boolean;
};
export type LocalFoundationExportOptions = { runId: string; entryOrdinal?: number };
export type LocalFoundationExportResult = { outputPath: string; characterCount: number; worldEntryCount: number; edgeCount: number };
