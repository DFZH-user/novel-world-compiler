import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoundationWorkflowRunRecord } from '../../src/shared/contracts';

const state = vi.hoisted(() => ({ usage: vi.fn() }));
vi.mock('../../electron/main/secure-config', () => ({ getRequestSettings: vi.fn() }));
vi.mock('../../electron/main/token-usage-ledger', () => ({ readTokenUsageSummary: state.usage }));

import { FoundationWorkflowRunner } from '../../electron/main/foundation-workflow-runner';

describe('foundation Token budget gate', () => {
  beforeEach(() => state.usage.mockReset());

  it('pauses the active child and workflow at 95 percent, then allows a raised budget', async () => {
    const workflow = { id: 'run', state: 'running', tokenBudget: 1000 } as FoundationWorkflowRunRecord;
    const requests = vi.fn(async (method: string) => {
      if (method === 'jobs:list') return [{ id: 'child', state: 'running' }];
      if (method === 'workflows:foundation-get') return workflow;
      return undefined;
    });
    const runner = new FoundationWorkflowRunner({ request: requests } as never,
      {} as never, {} as never, {} as never, {} as never);
    const check = (runner as unknown as { pauseNearBudget: (
      workflow: FoundationWorkflowRunRecord, childJobId?: string,
    ) => Promise<boolean> }).pauseNearBudget.bind(runner);
    state.usage.mockResolvedValue({ inputTokens: 800, outputTokens: 149 });
    expect(await check(workflow, 'child')).toBe(false);
    expect(requests).not.toHaveBeenCalled();

    state.usage.mockResolvedValue({ inputTokens: 800, outputTokens: 150 });
    expect(await check(workflow, 'child')).toBe(true);
    expect(requests.mock.calls.map(call => call[0])).toEqual([
      'jobs:list', 'jobs:control', 'workflows:foundation-get', 'workflows:foundation-control',
    ]);
    expect(requests).toHaveBeenCalledWith('jobs:control', { jobId: 'child', action: 'pause' });
    expect(requests).toHaveBeenCalledWith('workflows:foundation-control', { runId: 'run', action: 'pause' });

    requests.mockClear();
    expect(await check({ ...workflow, tokenBudget: 2000 }, 'child')).toBe(false);
    expect(requests).not.toHaveBeenCalled();
  });
});
