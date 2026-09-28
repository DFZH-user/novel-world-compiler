import type { WorkerClient } from './worker-client';
import { generateLocalRelationshipCandidates } from './relationship-candidate-generator';

export class RelationshipScanRunner {
  private readonly activeJobs = new Set<string>();

  constructor(private readonly worker: WorkerClient) {}

  start(jobId: string): void {
    if (this.activeJobs.has(jobId)) return;
    this.activeJobs.add(jobId);
    setImmediate(() => {
      void this.run(jobId).catch((error) => console.error('[relationship-scan]', error)).finally(() => this.activeJobs.delete(jobId));
    });
  }

  private async run(jobId: string): Promise<void> {
    while (true) {
      const item = await this.worker.request('relationships:scan-next', { jobId });
      if (!item) return;
      try {
        const result = generateLocalRelationshipCandidates(item);
        await this.worker.request('relationships:scan-ingest', {
          jobId,
          chunkId: item.chunkId,
          result,
          rawJson: JSON.stringify(result),
        });
      } catch (error) {
        await this.worker.request('relationships:scan-error', {
          jobId,
          chunkId: item.chunkId,
          error: error instanceof Error ? error.message : String(error),
          terminal: true,
        });
      }
    }
  }
}
