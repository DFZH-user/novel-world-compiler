import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkerChannel, WorkerRequestMap, WorkerResponseMap } from '../../src/shared/contracts';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeout: NodeJS.Timeout;
};

type WorkerReply =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: { message: string; stack?: string } };

export class WorkerClient {
  private process: UtilityProcess | null = null;
  private readonly pending = new Map<string, PendingRequest>();

  start(): void {
    if (this.process) return;
    const workerPath = path.join(__dirname, '..', 'worker', 'index.cjs');
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: '小说工程数据服务',
      stdio: 'pipe',
    });
    child.on('message', (message: WorkerReply) => this.handleReply(message));
    child.on('exit', (code) => {
      this.process = null;
      const error = new Error(`数据服务已退出（代码 ${code ?? 'unknown'}）`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timeout);
        request.reject(error);
      }
      this.pending.clear();
    });
    child.stderr?.on('data', (chunk) => console.error(`[data-service] ${String(chunk).trimEnd()}`));
    this.process = child;
  }

  async request<C extends WorkerChannel>(
    channel: C,
    payload: WorkerRequestMap[C],
    timeoutMs = channel === 'import:run' || channel === 'backup:create' || channel === 'backup:restore' ? 10 * 60_000 : 30_000,
  ): Promise<WorkerResponseMap[C]> {
    this.start();
    const child = this.process;
    if (!child) throw new Error('数据服务无法启动');
    const requestId = randomUUID();
    return new Promise<WorkerResponseMap[C]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`操作超时：${channel}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      child.postMessage({ requestId, channel, payload });
    });
  }

  stop(): void {
    this.process?.kill();
    this.process = null;
  }

  private handleReply(reply: WorkerReply): void {
    if (!reply || typeof reply.requestId !== 'string') return;
    const request = this.pending.get(reply.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    this.pending.delete(reply.requestId);
    if (reply.ok) request.resolve(reply.result);
    else request.reject(Object.assign(new Error(reply.error.message), { stack: reply.error.stack }));
  }
}
