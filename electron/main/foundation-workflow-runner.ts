import { getRequestSettings } from './secure-config';
import type {
  AutomationDraftQuoteRunRecord,
  AutomationDraftSelectionRunRecord,
  FoundationWorkflowRunRecord,
  FoundationWorkflowStepKey,
  JobRecord,
} from '../../src/shared/contracts';
import type { CharacterFactRunner } from './character-fact-runner';
import type { CharacterScanRunner } from './character-scan-runner';
import type { RelationshipScanRunner } from './relationship-scan-runner';
import type { TimelineEventRunner } from './timeline-event-runner';
import type { WorkerClient } from './worker-client';
import { normalizeFoundationProfile } from '../../src/shared/foundation-profile';
import { readTokenUsageSummary } from './token-usage-ledger';


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FoundationWorkflowRunner {
  private readonly activeRuns = new Set<string>();

  constructor(
    private readonly worker: WorkerClient,
    private readonly characterRunner: CharacterScanRunner,
    private readonly factRunner: CharacterFactRunner,
    private readonly timelineEventRunner: TimelineEventRunner,
    private readonly relationshipScanRunner: RelationshipScanRunner,
  ) {}

  private async pauseNearBudget(workflow: FoundationWorkflowRunRecord, childJobId?: string): Promise<boolean> {
    if (!workflow.tokenBudget || workflow.state !== 'running') return false;
    const usage = await readTokenUsageSummary(workflow.id);
    if (usage.inputTokens + usage.outputTokens < Math.ceil(workflow.tokenBudget * 0.95)) return false;
    if (childJobId) {
      const child = (await this.worker.request('jobs:list', undefined)).find(job => job.id === childJobId);
      if (child?.state === 'running') await this.worker.request('jobs:control', { jobId: childJobId, action: 'pause' });
    }
    const current = await this.worker.request('workflows:foundation-get', { runId: workflow.id });
    if (current.state === 'running') await this.worker.request('workflows:foundation-control', { runId: workflow.id, action: 'pause' });
    return true;
  }

  start(runId: string): void {
    if (this.activeRuns.has(runId)) return;
    this.activeRuns.add(runId);
    setImmediate(() => {
      void this.run(runId)
        .catch((error) => console.error('[foundation-workflow]', error))
        .finally(() => this.activeRuns.delete(runId));
    });
  }

  private async run(runId: string): Promise<void> {
    try {
      let workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;

      if (!this.completed(workflow, 'preflight')) {
        await this.worker.request('workflows:foundation-step', {
          runId,
          stepKey: 'preflight',
          state: 'running',
          message: '正在检查数据库、全文索引与原文来源',
          progress: 0.2,
        });
        const report = await this.worker.request('project:diagnostics', { mode: 'quick' });
        if (report.overallStatus === 'error') {
          const failures = report.checks.filter((check) => check.status === 'error').map((check) => check.summary);
          throw new Error(`工程预检未通过：${failures.join('；') || '请先运行工程诊断'}`);
        }
        workflow = await this.worker.request('workflows:foundation-step', {
          runId,
          stepKey: 'preflight',
          state: 'completed',
          message: report.overallStatus === 'warning' ? '工程预检通过，但有警告需要后续复核' : '工程预检通过',
          progress: 1,
          output: {
            overallStatus: report.overallStatus,
            schemaVersion: report.schemaVersion,
            paragraphCount: report.paragraphCount,
            unresolvedSourceSpanCount: report.unresolvedSourceSpanCount,
          },
        });
        if (workflow.state !== 'running') return;
      }

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (!this.completed(workflow, 'chunks')) {
        await this.worker.request('workflows:foundation-step', {
          runId,
          stepKey: 'chunks',
          state: 'running',
          message: '正在检查当前分析分块',
          progress: 0.2,
        });
        const defaultChunks = (await getRequestSettings()).inputChunks;
        let chunks = await this.worker.request('chunks:list', undefined);
        let generated = false;
        if (!chunks.length) {
          chunks = await this.worker.request('chunks:build', defaultChunks);
          generated = true;
        }
        workflow = await this.worker.request('workflows:foundation-step', {
          runId,
          stepKey: 'chunks',
          state: 'completed',
          message: generated ? `已按现有默认参数生成 ${chunks.length} 个分析分块` : `复用现有 ${chunks.length} 个分析分块`,
          progress: 1,
          output: { chunkCount: chunks.length, generated, settings: generated ? defaultChunks : null },
        });
        if (workflow.state !== 'running') return;
      }

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (await this.pauseNearBudget(workflow)) return;
      if (!this.completed(workflow, 'character_scan')) {
        await this.runCharacterScan(workflow);
      }

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (!this.completed(workflow, 'draft_selection')) {
        await this.runDraftSelection(workflow);
      }

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (await this.pauseNearBudget(workflow)) return;
      if (!this.completed(workflow, 'character_facts')) {
        await this.runCharacterFacts(workflow);
      }

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (!this.completed(workflow, 'dialogue_scan')) {
        await this.runDialogueDraft(workflow);
      }

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (!this.completed(workflow, 'time_expressions')) await this.runTimeDraft(workflow);

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (await this.pauseNearBudget(workflow)) return;
      if (!this.completed(workflow, 'event_drafts')) await this.runEventDraft(workflow);

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (!this.completed(workflow, 'place_drafts')) await this.runPlaceDraft(workflow);

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running') return;
      if (!this.completed(workflow, 'relationship_drafts')) await this.runRelationshipDraft(workflow);

      workflow = await this.worker.request('workflows:foundation-get', { runId });
      if (workflow.state !== 'running' || this.completed(workflow, 'summary')) return;
      await this.worker.request('workflows:foundation-step', {
        runId,
        stepKey: 'summary',
        state: 'running',
        message: '正在自动定稿并生成地图、图谱与角色卡',
        progress: 0.35,
      });
      const characters = await this.worker.request('characters:list', undefined);
      const selectionStep = workflow.steps.find((step) => step.stepKey === 'draft_selection');
      const selection = selectionStep?.childJobId
        ? await this.worker.request('draft-selections:get-by-job', { jobId: selectionStep.childJobId })
        : null;
      const factStep = workflow.steps.find((step) => step.stepKey === 'character_facts');
      const factOutput = factStep?.outputJson ? JSON.parse(factStep.outputJson) as { completedJobCount?: number } : null;
      const dialogueStep = workflow.steps.find((step) => step.stepKey === 'dialogue_scan');
      const dialogue = dialogueStep?.childJobId
        ? await this.worker.request('draft-quotes:get-by-job', { jobId: dialogueStep.childJobId })
        : null;
      const timeOutput = this.stepOutput<{ detectedCount?: number; insertedCount?: number }>(workflow, 'time_expressions');
      const eventOutput = this.stepOutput<{ eventRunId?: string }>(workflow, 'event_drafts');
      const placeOutput = this.stepOutput<{ sourceLocationCount?: number; createdPlaceCount?: number }>(workflow, 'place_drafts');
      const relationshipOutput = this.stepOutput<{ skipped?: boolean; childJobId?: string }>(workflow, 'relationship_drafts');
      if (!selection) throw new Error('自动定稿缺少已完成的草稿选择结果');
      const finalization = await this.worker.request('automation:finalize', { selectionRunId: selection.id });
      await this.worker.request('workflows:foundation-step', {
        runId,
        stepKey: 'summary',
        state: 'completed',
        message: `一键生成完成：${selection.selectedCount} 人进入重点分析，人物、事件、地点与关系已自动定稿${finalization.playableBundle ? '，可游玩包已导出' : ''}`,
        progress: 1,
        output: {
          characterCandidateCount: characters.length,
          draftSelectionCount: selection?.selectedCount ?? 0,
          characterFactDraftCount: factOutput?.completedJobCount ?? 0,
          dialogueQuoteCount: dialogue?.quoteCount ?? 0,
          dialogueAttributionCount: dialogue?.attributionCount ?? 0,
          detectedTimeExpressionCount: timeOutput?.detectedCount ?? 0,
          insertedTimeExpressionCount: timeOutput?.insertedCount ?? 0,
          eventRunId: eventOutput?.eventRunId ?? null,
          sourceLocationCount: placeOutput?.sourceLocationCount ?? 0,
          createdPlaceCount: placeOutput?.createdPlaceCount ?? 0,
          relationshipSkipped: relationshipOutput?.skipped ?? false,
          relationshipJobId: relationshipOutput?.childJobId ?? null,
          automaticFinalization: finalization,
          reviewBoundary: 'pending-records-auto-finalized-manual-decisions-preserved',
          nextBatch: 'optional-quality-editing',
        },
      });
    } catch (error) {
      const workflow = await this.worker.request('workflows:foundation-get', { runId }).catch(() => null);
      if (workflow?.state === 'running') {
        await this.worker.request('workflows:foundation-fail', {
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async runCharacterScan(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const runId = workflow.id;
    const step = workflow.steps.find((item) => item.stepKey === 'character_scan');
    let childJobId = step?.childJobId ?? null;
    let childJob: JobRecord | undefined;

    if (childJobId) {
      childJob = (await this.worker.request('jobs:list', undefined)).find((job) => job.id === childJobId);
      if (childJob?.state === 'failed') {
        await this.worker.request('jobs:control', { jobId: childJobId, action: 'retry' });
        await this.worker.request('jobs:control', { jobId: childJobId, action: 'resume' });
        childJob = (await this.worker.request('jobs:list', undefined)).find((job) => job.id === childJobId);
      } else if (childJob?.state === 'paused' || childJob?.state === 'queued') {
        await this.worker.request('jobs:control', { jobId: childJobId, action: 'resume' });
        childJob = (await this.worker.request('jobs:list', undefined)).find((job) => job.id === childJobId);
      }
    }

    if (!childJobId || !childJob) {
      const started = await this.worker.request('characters:scan-create', {
        model: workflow.model,
        promptVersion: 'character_scan.v1',
      });
      childJobId = started.jobId;
      childJob = (await this.worker.request('jobs:list', undefined)).find((job) => job.id === childJobId);
    }

    await this.worker.request('workflows:foundation-step', {
      runId,
      stepKey: 'character_scan',
      state: 'running',
      message: childJob?.state === 'completed' ? '复用已完成的人物普查' : '正在执行人物普查',
      progress: childJob?.progress ?? 0,
      childJobId,
    });
    if (childJob?.state === 'running') this.characterRunner.start(childJobId, runId);

    while (true) {
      const current = await this.worker.request('workflows:foundation-get', { runId });
      if (current.state !== 'running') return;
      if (await this.pauseNearBudget(current, childJobId)) return;
      const job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
      if (!job) throw new Error('人物普查子任务已经丢失');
      if (job.state === 'completed') {
        await this.worker.request('workflows:foundation-step', {
          runId,
          stepKey: 'character_scan',
          state: 'completed',
          message: '人物普查完成；人物候选仍等待审核',
          progress: 1,
          childJobId,
          output: { childJobId, childState: job.state },
        });
        return;
      }
      if (job.state === 'failed') throw new Error(job.message || '人物普查失败');
      if (job.state === 'cancelled') throw new Error('人物普查子任务已取消');
      if (job.state === 'paused' || job.state === 'queued') return;
      await this.worker.request('workflows:foundation-step', {
        runId,
        stepKey: 'character_scan',
        state: 'running',
        message: job.message,
        progress: job.progress,
        childJobId,
      });
      await delay(750);
    }
  }

  private async runDraftSelection(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const runId = workflow.id;
    const step = workflow.steps.find((item) => item.stepKey === 'draft_selection');
    let childJobId = step?.childJobId ?? null;
    let selection = childJobId
      ? await this.worker.request('draft-selections:get-by-job', { jobId: childJobId })
      : null;

    if (!selection) {
      const started = await this.worker.request('draft-selections:create', {
        workflowRunId: runId,
        profile: workflow.profile,
      });
      childJobId = started.jobId;
      selection = await this.worker.request('draft-selections:get', { runId: started.runId });
    }

    if (selection.state === 'failed') {
      await this.worker.request('jobs:control', { jobId: selection.jobId, action: 'retry' });
      await this.worker.request('jobs:control', { jobId: selection.jobId, action: 'resume' });
      selection = await this.worker.request('draft-selections:get-by-job', { jobId: selection.jobId });
    } else if (selection.state === 'paused' || selection.state === 'queued') {
      await this.worker.request('jobs:control', { jobId: selection.jobId, action: 'resume' });
      selection = await this.worker.request('draft-selections:get-by-job', { jobId: selection.jobId });
    }

    await this.worker.request('workflows:foundation-step', {
      runId,
      stepKey: 'draft_selection',
      state: selection.state === 'completed' ? 'completed' : 'running',
      message: selection.message,
      progress: selection.progress,
      childJobId: selection.jobId,
      output: selection.state === 'completed' ? this.selectionOutput(selection) : {
        selectionRunId: selection.id,
        inputHash: selection.inputHash,
        policyVersion: selection.policyVersion,
      },
    });
    if (selection.state === 'completed') return;

    while (true) {
      const current = await this.worker.request('workflows:foundation-get', { runId });
      if (current.state !== 'running') return;
      selection = await this.worker.request('draft-selections:process-next', { jobId: selection.jobId });
      if (selection.state === 'failed') throw new Error(selection.error || selection.message || '自动草稿选择失败');
      if (selection.state === 'cancelled') throw new Error('自动草稿选择任务已取消');
      if (selection.state === 'paused' || selection.state === 'queued') return;
      if (selection.state === 'completed') {
        await this.worker.request('workflows:foundation-step', {
          runId,
          stepKey: 'draft_selection',
          state: 'completed',
          message: selection.message,
          progress: 1,
          childJobId: selection.jobId,
          output: this.selectionOutput(selection),
        });
        return;
      }
      await this.worker.request('workflows:foundation-step', {
        runId,
        stepKey: 'draft_selection',
        state: 'running',
        message: selection.message,
        progress: selection.progress,
        childJobId: selection.jobId,
      });
    }
  }

  private async runCharacterFacts(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const runId = workflow.id;
    const profile = normalizeFoundationProfile(workflow.profile);
    const selection = await this.completedSelection(workflow);
    const selectedItems = selection.items.filter((item) => item.status === 'completed' && item.selected);
    const characters = new Map((await this.worker.request('characters:list', undefined)).map((item) => [item.id, item]));
    const completedJobs: Array<{ identityId: string; identityName: string; jobId: string; reused: boolean }> = [];
    const skippedCharacters: Array<{ identityId: string; identityName: string; reason: string }> = [];
    const total = selectedItems.length;

    await this.worker.request('workflows:foundation-step', {
      runId,
      stepKey: 'character_facts',
      state: total ? 'running' : 'completed',
      message: total ? `正在为自动草稿集合中的 ${total} 个人物提取待审事实` : '自动草稿集合为空，无需提取人物事实',
      progress: total ? 0 : 1,
      output: total ? { selectionRunId: selection.id, targetCount: total } : {
        selectionRunId: selection.id,
        targetCount: 0,
        completedJobCount: 0,
        skippedCharacters: [],
        reviewBoundary: 'facts-remain-pending',
      },
    });
    if (!total) return;

    for (let index = 0; index < selectedItems.length; index += 1) {
      const selected = selectedItems[index];
      const current = await this.worker.request('workflows:foundation-get', { runId });
      if (current.state !== 'running') return;
      const character = characters.get(selected.identityId);
      if (!character || character.reviewStatus === 'rejected') {
        skippedCharacters.push({
          identityId: selected.identityId,
          identityName: selected.identityName,
          reason: !character ? '人物已不在当前修订中' : '人物已被人工拒绝',
        });
        continue;
      }
      const estimate = await this.worker.request('facts:estimate', { identityId: character.id });
      if (!estimate.ready) {
        skippedCharacters.push({ identityId: character.id, identityName: character.canonicalName, reason: '没有可用于事实提取的正文材料' });
        continue;
      }
      const started = await this.worker.request('facts:draft-run-create', {
        selectionRunId: selection.id,
        identityId: character.id,
        model: workflow.model,
        promptVersion: profile === 'foundation-v1' ? 'character_facts.v2' : `character_facts.v3.${profile}`,
        extractionPasses: profile === 'high' ? 2 : 1,
      });
      let job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === started.jobId);
      if (!job) throw new Error(`“${character.canonicalName}”的人物事实子任务已经丢失`);
      await this.worker.request('workflows:foundation-step', {
        runId,
        stepKey: 'character_facts',
        state: 'running',
        message: job.state === 'completed' ? `复用“${character.canonicalName}”的已完成人物事实草稿` : `正在提取“${character.canonicalName}”的待审人物事实`,
        progress: (index + job.progress) / total,
        childJobId: job.id,
      });
       if (job.state === 'running') this.factRunner.start(job.id, runId);

      while (job.state !== 'completed') {
        const parent = await this.worker.request('workflows:foundation-get', { runId });
        if (parent.state !== 'running') return;
        if (await this.pauseNearBudget(parent, job.id)) return;
        if (job.state === 'failed') throw new Error(job.message || `“${character.canonicalName}”的人物事实提取失败`);
        if (job.state === 'cancelled') throw new Error(`“${character.canonicalName}”的人物事实子任务已取消`);
        if (job.state === 'paused' || job.state === 'queued') return;
        await delay(750);
        job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === started.jobId);
        if (!job) throw new Error(`“${character.canonicalName}”的人物事实子任务已经丢失`);
        await this.worker.request('workflows:foundation-step', {
          runId,
          stepKey: 'character_facts',
          state: 'running',
          message: job.message,
          progress: (index + job.progress) / total,
          childJobId: job.id,
        });
      }
      completedJobs.push({ identityId: character.id, identityName: character.canonicalName, jobId: job.id, reused: started.reused });
    }

    await this.worker.request('workflows:foundation-step', {
      runId,
      stepKey: 'character_facts',
      state: 'completed',
      message: `人物事实草稿完成：${completedJobs.length} 个人物已生成候选，${skippedCharacters.length} 人跳过；全部仍待人工审核`,
      progress: 1,
      output: {
        selectionRunId: selection.id,
        targetCount: total,
        completedJobCount: completedJobs.length,
        completedJobs,
        skippedCharacters,
        reviewBoundary: 'facts-remain-pending',
      },
    });
  }

  private async runDialogueDraft(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const runId = workflow.id;
    const selection = await this.completedSelection(workflow);
    const step = workflow.steps.find((item) => item.stepKey === 'dialogue_scan');
    let draft = step?.childJobId
      ? await this.worker.request('draft-quotes:get-by-job', { jobId: step.childJobId })
      : null;
    if (!draft) {
      const started = await this.worker.request('draft-quotes:create', { selectionRunId: selection.id });
      draft = await this.worker.request('draft-quotes:get', { runId: started.runId });
    }
    if (draft.state === 'failed') {
      await this.worker.request('jobs:control', { jobId: draft.jobId, action: 'retry' });
      await this.worker.request('jobs:control', { jobId: draft.jobId, action: 'resume' });
      draft = await this.worker.request('draft-quotes:get-by-job', { jobId: draft.jobId });
    } else if (draft.state === 'paused' || draft.state === 'queued') {
      await this.worker.request('jobs:control', { jobId: draft.jobId, action: 'resume' });
      draft = await this.worker.request('draft-quotes:get-by-job', { jobId: draft.jobId });
    }

    await this.worker.request('workflows:foundation-step', {
      runId,
      stepKey: 'dialogue_scan',
      state: draft.state === 'completed' ? 'completed' : 'running',
      message: draft.message,
      progress: draft.progress,
      childJobId: draft.jobId,
      output: draft.state === 'completed' ? this.dialogueOutput(draft) : {
        selectionRunId: selection.id,
        dialogueRunId: draft.id,
        inputHash: draft.inputHash,
        algorithmVersion: draft.algorithmVersion,
      },
    });
    if (draft.state === 'completed') return;

    while (true) {
      const current = await this.worker.request('workflows:foundation-get', { runId });
      if (current.state !== 'running') return;
      if (await this.pauseNearBudget(current, draft.jobId)) return;
      draft = await this.worker.request('draft-quotes:process-next', { jobId: draft.jobId });
      if (draft.state === 'failed') throw new Error(draft.error || draft.message || '自动对白草稿扫描失败');
      if (draft.state === 'cancelled') throw new Error('自动对白草稿子任务已取消');
      if (draft.state === 'paused' || draft.state === 'queued') return;
      await this.worker.request('workflows:foundation-step', {
        runId,
        stepKey: 'dialogue_scan',
        state: draft.state === 'completed' ? 'completed' : 'running',
        message: draft.message,
        progress: draft.progress,
        childJobId: draft.jobId,
        output: draft.state === 'completed' ? this.dialogueOutput(draft) : undefined,
      });
      if (draft.state === 'completed') return;
    }
  }

  private async runTimeDraft(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const selection = await this.completedSelection(workflow);
    await this.worker.request('workflows:foundation-step', {
      runId: workflow.id, stepKey: 'time_expressions', state: 'running',
      message: '正在按本地规则识别待审时间表达式', progress: 0.5,
      output: { selectionRunId: selection.id },
    });
    const result = await this.worker.request('timeline:draft-time-scan', { selectionRunId: selection.id });
    await this.worker.request('workflows:foundation-step', {
      runId: workflow.id, stepKey: 'time_expressions', state: 'completed',
      message: `时间表达式草稿完成：识别 ${result.detectedCount} 条，本次新增 ${result.insertedCount} 条；全部保留审核状态`,
      progress: 1,
      output: { ...result, reviewBoundary: 'new-time-expressions-remain-pending' },
    });
  }

  private async runEventDraft(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const selection = await this.completedSelection(workflow);
    const step = workflow.steps.find((item) => item.stepKey === 'event_drafts');
    const prior = this.stepOutput<{ eventRunId?: string }>(workflow, 'event_drafts');
    let eventRunId = prior?.eventRunId ?? null;
    let childJobId = step?.childJobId ?? null;
    let job = childJobId ? (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId) : undefined;
    if (job?.state === 'failed') {
      await this.worker.request('jobs:control', { jobId: job.id, action: 'retry' });
      await this.worker.request('jobs:control', { jobId: job.id, action: 'resume' });
      job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
    } else if (job?.state === 'paused' || job?.state === 'queued') {
      await this.worker.request('jobs:control', { jobId: job.id, action: 'resume' });
      job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
    }
    if (!childJobId || !job) {
      const started = await this.worker.request('timeline:events-draft-run-create', {
        selectionRunId: selection.id, model: workflow.model, promptVersion: 'timeline_events.draft.v1',
      });
      childJobId = started.jobId;
      eventRunId = started.runId;
      job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
    }
    if (!job || !childJobId || !eventRunId) throw new Error('事件草稿子任务缺少可恢复的运行信息');
    await this.worker.request('workflows:foundation-step', {
      runId: workflow.id, stepKey: 'event_drafts', state: job.state === 'completed' ? 'completed' : 'running',
      message: job.state === 'completed' ? '复用已完成的事件草稿；事件仍待人工审核' : '正在提取选择范围内的待审事件',
      progress: job.progress, childJobId,
      output: { selectionRunId: selection.id, eventRunId, childJobId, reviewBoundary: 'events-and-details-remain-pending' },
    });
    if (job.state === 'completed') return;
    this.timelineEventRunner.start(childJobId, workflow.id);
    await this.waitForChildJob(workflow.id, 'event_drafts', childJobId, '事件草稿', {
      selectionRunId: selection.id, eventRunId, childJobId, reviewBoundary: 'events-and-details-remain-pending',
    });
  }

  private async runPlaceDraft(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const selection = await this.completedSelection(workflow);
    const event = this.stepOutput<{ eventRunId?: string }>(workflow, 'event_drafts');
    if (!event?.eventRunId) throw new Error('一键流程缺少事件草稿运行，不能生成地点草稿');
    await this.worker.request('workflows:foundation-step', {
      runId: workflow.id, stepKey: 'place_drafts', state: 'running',
      message: '正在从本次事件草稿的地点证据生成待审地点', progress: 0.5,
      output: { selectionRunId: selection.id, eventRunId: event.eventRunId },
    });
    const result = await this.worker.request('places:draft-bootstrap', {
      selectionRunId: selection.id, eventRunId: event.eventRunId,
    });
    await this.worker.request('workflows:foundation-step', {
      runId: workflow.id, stepKey: 'place_drafts', state: 'completed',
      message: `地点草稿完成：读取 ${result.sourceLocationCount} 条地点线索，新增 ${result.createdPlaceCount} 个地点、${result.createdMentionCount} 条提及；全部待审`,
      progress: 1, output: { ...result, reviewBoundary: 'places-aliases-and-mentions-remain-pending' },
    });
  }

  private async runRelationshipDraft(workflow: FoundationWorkflowRunRecord): Promise<void> {
    const selection = await this.completedSelection(workflow);
    const selectedIds = new Set(selection.items.filter((item) => item.status === 'completed' && item.selected).map((item) => item.identityId));
    const currentCount = (await this.worker.request('characters:list', undefined))
      .filter((item) => selectedIds.has(item.id) && item.reviewStatus !== 'rejected').length;
    if (currentCount < 2) {
      await this.worker.request('workflows:foundation-step', {
        runId: workflow.id, stepKey: 'relationship_drafts', state: 'skipped',
        message: '当前自动草稿集合不足两名可用人物，已跳过关系草稿', progress: 1,
        output: { selectionRunId: selection.id, selectedCharacterCount: currentCount, skipped: true, reviewBoundary: 'no-review-status-changed' },
      });
      return;
    }
    const step = workflow.steps.find((item) => item.stepKey === 'relationship_drafts');
    let childJobId = step?.childJobId ?? null;
    let job = childJobId ? (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId) : undefined;
    if (job?.state === 'failed') {
      await this.worker.request('jobs:control', { jobId: job.id, action: 'retry' });
      await this.worker.request('jobs:control', { jobId: job.id, action: 'resume' });
      job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
    } else if (job?.state === 'paused' || job?.state === 'queued') {
      await this.worker.request('jobs:control', { jobId: job.id, action: 'resume' });
      job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
    }
    if (!childJobId || !job) {
      const started = await this.worker.request('relationships:draft-scan-create', {
        selectionRunId: selection.id, extractorVersion: 'relationship-draft-local.v2',
      });
      childJobId = started.jobId;
      job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
    }
    if (!job || !childJobId) throw new Error('关系草稿子任务已经丢失');
    const output = { selectionRunId: selection.id, childJobId, selectedCharacterCount: currentCount,
      skipped: false, reviewBoundary: 'relationship-candidates-remain-pending' };
    await this.worker.request('workflows:foundation-step', {
      runId: workflow.id, stepKey: 'relationship_drafts', state: job.state === 'completed' ? 'completed' : 'running',
      message: job.state === 'completed' ? '复用已完成的关系草稿；候选仍待人工审核' : '正在本地扫描选择范围内的人物关系候选',
      progress: job.progress, childJobId, output,
    });
    if (job.state === 'completed') return;
    this.relationshipScanRunner.start(childJobId);
    await this.waitForChildJob(workflow.id, 'relationship_drafts', childJobId, '关系草稿', output);
  }

  private async waitForChildJob(
    runId: string,
    stepKey: 'event_drafts' | 'relationship_drafts',
    childJobId: string,
    label: string,
    output: Record<string, unknown>,
  ): Promise<void> {
    while (true) {
      const current = await this.worker.request('workflows:foundation-get', { runId });
      if (current.state !== 'running') return;
      if (await this.pauseNearBudget(current, childJobId)) return;
      const job = (await this.worker.request('jobs:list', undefined)).find((item) => item.id === childJobId);
      if (!job) throw new Error(`${label}子任务已经丢失`);
      if (job.state === 'completed') {
        await this.worker.request('workflows:foundation-step', {
          runId, stepKey, state: 'completed', message: `${label}完成；全部候选仍待人工审核`,
          progress: 1, childJobId, output,
        });
        return;
      }
      if (job.state === 'failed') throw new Error(job.message || `${label}失败`);
      if (job.state === 'cancelled') throw new Error(`${label}子任务已取消`);
      if (job.state === 'paused' || job.state === 'queued') return;
      await this.worker.request('workflows:foundation-step', {
        runId, stepKey, state: 'running', message: job.message, progress: job.progress, childJobId,
      });
      await delay(750);
    }
  }

  private stepOutput<T>(workflow: FoundationWorkflowRunRecord, stepKey: FoundationWorkflowStepKey): T | null {
    const raw = workflow.steps.find((item) => item.stepKey === stepKey)?.outputJson;
    if (!raw) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  }
  private async completedSelection(workflow: FoundationWorkflowRunRecord): Promise<AutomationDraftSelectionRunRecord> {
    const step = workflow.steps.find((item) => item.stepKey === 'draft_selection');
    if (!step?.childJobId) throw new Error('一键流程缺少自动草稿选择结果');
    const selection = await this.worker.request('draft-selections:get-by-job', { jobId: step.childJobId });
    if (selection.state !== 'completed') throw new Error('自动草稿选择尚未完成，不能启动下游草稿任务');
    return selection;
  }

  private dialogueOutput(draft: AutomationDraftQuoteRunRecord): Record<string, unknown> {
    return {
      selectionRunId: draft.selectionRunId,
      dialogueRunId: draft.id,
      inputHash: draft.inputHash,
      algorithmVersion: draft.algorithmVersion,
      paragraphCount: draft.totalParagraphs,
      quoteCount: draft.quoteCount,
      attributionCount: draft.attributionCount,
      reviewBoundary: 'all-attributions-remain-pending',
    };
  }
  private selectionOutput(selection: AutomationDraftSelectionRunRecord): Record<string, unknown> {
    return {
      selectionRunId: selection.id,
      inputHash: selection.inputHash,
      policyVersion: selection.policyVersion,
      candidateCount: selection.totalCandidates,
      selectedCount: selection.selectedCount,
      reviewBoundary: 'selection-only-no-confirmation',
      selectedCharacters: selection.items.filter((item) => item.selected).map((item) => ({
        identityId: item.identityId,
        identityName: item.identityName,
        reasonCode: item.reasonCode,
        reason: item.reason,
        reviewStatusSnapshot: item.reviewStatusSnapshot,
      })),
    };
  }

  private completed(workflow: FoundationWorkflowRunRecord, stepKey: FoundationWorkflowStepKey): boolean {
    return workflow.steps.some((step) => step.stepKey === stepKey && ['completed', 'skipped'].includes(step.state));
  }
}
