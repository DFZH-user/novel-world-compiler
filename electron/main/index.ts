import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { WorkerClient } from './worker-client';
import { getApiStatus, listApiModels, saveApiConfig, testApiConnection } from './secure-config';
import { chunkSettingsSchema } from '../../src/shared/contracts';
import type {
  CharacterRelationshipAssertionInput,
  CharacterRelationshipCandidateInput,
  CharacterRelationshipReviewStatus,
  FoundationWorkflowControlAction,
  WorkerRequestMap,
} from '../../src/shared/contracts';
import { CharacterScanRunner } from './character-scan-runner';
import { FoundationWorkflowRunner } from './foundation-workflow-runner';
import { CharacterFactRunner } from './character-fact-runner';
import { TimelineEventRunner } from './timeline-event-runner';
import { CharacterCardRefinementRunner } from './character-card-refinement-runner';
import { RelationshipScanRunner } from './relationship-scan-runner';
import { RelationshipModelRunner } from './relationship-model-runner';
import { PlaceModelScanRunner } from './place-model-scan-runner';
import { CharacterRuntimeRunner } from './character-runtime-runner';
import { ProjectLibrary } from './project-library';
import { inspectProjectBundle, listProjectPlayableEntries } from './project-bundle-discovery';
import type { ProjectSummary } from '../../src/shared/contracts';
import { SillyTavernManager } from './sillytavern-manager';
import { SillyTavernApi } from './sillytavern-api';
import { SillyTavernAssembly } from './sillytavern-assembly';
import { playSessionOptionsSchema, type PlaySessionOptions } from '../../src/shared/play-session-options';
import { readTokenUsageSummary } from './token-usage-ledger';

const worker = new WorkerClient();
const characterRunner = new CharacterScanRunner(worker);
const factRunner = new CharacterFactRunner(worker);
const timelineEventRunner = new TimelineEventRunner(worker);
const characterCardRefinementRunner = new CharacterCardRefinementRunner(worker);
const relationshipScanRunner = new RelationshipScanRunner(worker);
const foundationWorkflowRunner = new FoundationWorkflowRunner(worker, characterRunner, factRunner, timelineEventRunner, relationshipScanRunner);
const relationshipModelRunner = new RelationshipModelRunner(worker);
const placeModelScanRunner = new PlaceModelScanRunner(worker);
const characterRuntimeRunner = new CharacterRuntimeRunner(worker);
const sillyTavern = new SillyTavernManager();
let mainWindow: BrowserWindow | null = null;

if (process.env.NOVEL_COMPILER_USER_DATA) app.setPath('userData', path.resolve(process.env.NOVEL_COMPILER_USER_DATA));

const projectLibrary = new ProjectLibrary(path.join(app.getPath('userData'), 'project-library.json'));
async function rememberProject(project: ProjectSummary) {
  await projectLibrary.remember(project).catch(error => console.warn('Cannot update project library:', error));
  return project;
}

function safeFolderName(name: string): string {
  const result = name.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '-').replace(/[. ]+$/g, '');
  if (!result) throw new Error('工程名称不能为空');
  return result.slice(0, 80);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    backgroundColor: '#f6f8fa',
    title: '小说世界',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  sillyTavern.attachWindow(mainWindow);
  const window = mainWindow;
  // Register before loadFile: packaged startup can paint before its promise resolves.
  window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show(); });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.startsWith('file:')) return;
    event.preventDefault();
  });
  const openSettings = process.env.NOVEL_COMPILER_OPEN_SETTINGS === '1'
    || app.commandLine.hasSwitch('open-settings')
    || process.argv.includes('--open-settings');
  const requestedPreset = process.env.NOVEL_COMPILER_PROVIDER_PRESET
    || app.commandLine.getSwitchValue('provider-preset')
    || process.argv.find((argument) => argument.startsWith('--provider-preset='))?.slice('--provider-preset='.length);
  if (process.env.VITE_DEV_SERVER_URL) {
    const devUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    if (openSettings) devUrl.searchParams.set('view', 'settings');
    if (requestedPreset) devUrl.searchParams.set('preset', requestedPreset);
    await mainWindow.loadURL(devUrl.toString());
  } else {
    const query: Record<string, string> = {};
    if (openSettings) query.view = 'settings';
    if (requestedPreset) query.preset = requestedPreset;
    await mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'), Object.keys(query).length ? { query } : undefined);
  }
  // A completed load must never leave the only window hidden if ready-to-show raced ahead.
  if (!window.isDestroyed() && !window.isVisible()) window.show();
}

let launchInProgress = false;
let assemblyConnection: { url: string; assembly: SillyTavernAssembly } | null = null;

async function prepareBook(id: string, options?: PlaySessionOptions, entryEventId?: string) {
  let project = await worker.request('project:get', undefined);
  if (project?.id !== id) {
    if (project) {
      const jobs = await worker.request('jobs:list', undefined);
      if (jobs.some(job => job.state === 'running')) throw new Error('请先暂停当前编译任务，再切换书籍。');
    }
    project = await worker.request('project:open', { rootPath: await projectLibrary.resolve(id) });
    await rememberProject(project);
  }
  const selectedEntryId = options?.entryEventId ?? entryEventId;
  const availability = await inspectProjectBundle(project, selectedEntryId);
  if (availability.state === 'invalid') throw new Error(availability.message);
  const plan = availability.packageDirectory
    ? await worker.request('artifacts:play-session-prepare', { packageDirectory: availability.packageDirectory, options })
    : selectedEntryId
      ? await worker.request('artifacts:play-session-prepare-live', { entryEventId: selectedEntryId, options })
      : (() => { throw new Error(availability.message); })();
  const current = await worker.request('project:get', undefined);
  if (current?.id !== id || current.activeRevisionId !== project.activeRevisionId) throw new Error('准备期间工程已切换，请重试。');
  return plan;
}

function registerIpc(): void {
  ipcMain.handle('project:play-entries', async (_event, id: string) => {
    await prepareBook(String(id));
    const project = await worker.request('project:get', undefined);
    if (!project || project.id !== String(id)) throw new Error('工程已切换，请重试。');
    const [events, prepared] = await Promise.all([
      worker.request('timeline:events-list', { status: 'confirmed' }),
      listProjectPlayableEntries(project),
    ]);
    const ready = new Set(prepared.map(item => item.eventId));
    return events.map(event => ({ eventId: event.id, title: event.title,
      ordinal: event.narrativeStartOrdinal, prepared: ready.has(event.id) }));
  });
  ipcMain.handle('project:play-prepare', async (_event, id: string, entryEventId?: string, rawOptions?: unknown) => {
    const options = rawOptions ? playSessionOptionsSchema.parse(rawOptions) : undefined;
    const plan = await prepareBook(String(id), options, entryEventId ? String(entryEventId) : undefined);
    if (!plan.preview) throw new Error('无法生成游玩摘要。');
    return plan.preview;
  });
  ipcMain.handle('project:play-launch', async (_event, id: string, rawOptions: unknown, rawSettingsPage?: unknown) => {
    if (launchInProgress) throw new Error('正在打开游玩会话，请稍候。');
    launchInProgress = true;
    try {
      const options = playSessionOptionsSchema.parse(rawOptions);
      const plan = await prepareBook(String(id), options);
      const status = await sillyTavern.start();
      if (status.state !== 'ready' || !status.baseUrl) throw new Error(status.message);
      if (assemblyConnection?.url !== status.baseUrl) assemblyConnection = {
        url: status.baseUrl, assembly: new SillyTavernAssembly(new SillyTavernApi(status.baseUrl), path.join(app.getPath('userData'), 'managed-session-updates')),
      };
      const handle = await assemblyConnection.assembly.assemble(plan);
      const settingsPage = ['model', 'tuning', 'other'].includes(String(rawSettingsPage))
        ? String(rawSettingsPage) as 'model' | 'tuning' | 'other' : undefined;
      return await sillyTavern.showSession(handle, settingsPage);
    } finally { launchInProgress = false; }
  });
  ipcMain.handle('sillytavern:status', () => sillyTavern.status());
  ipcMain.handle('sillytavern:start', () => sillyTavern.start());
  ipcMain.handle('sillytavern:stop', () => sillyTavern.stop());
  ipcMain.handle('sillytavern:show', () => sillyTavern.show());
  ipcMain.handle('sillytavern:hide', () => sillyTavern.hide());
  ipcMain.handle('project:create', async (_event, rawName: unknown) => {
    const name = safeFolderName(String(rawName ?? ''));
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择新工程的保存位置',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '在这里创建',
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const rootPath = path.join(selection.filePaths[0], `${name}.novelworld`);
    try {
      await fs.access(rootPath);
      throw new Error(`目标目录已存在：${rootPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return rememberProject(await worker.request('project:create', { name, rootPath }));
  });
  ipcMain.handle('project:open', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '打开小说工程',
      properties: ['openDirectory'],
      buttonLabel: '打开工程',
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return rememberProject(await worker.request('project:open', { rootPath: selection.filePaths[0] }));
  });
  ipcMain.handle('project:library', async () => {
    const current = await worker.request('project:get', undefined);
    if (current) await rememberProject(current);
    return projectLibrary.list();
  });
  ipcMain.handle('project:bundle-availability', async (_event, id: unknown) => {
    const project = (await projectLibrary.list()).find(item => item.id === String(id));
    if (!project) throw new Error('书库中没有这本书，请重新打开工程。');
    return inspectProjectBundle(project);
  });
  ipcMain.handle('project:open-recent', async (_event, id: unknown) => {
    const current = await worker.request('project:get', undefined);
    if (current?.id === String(id)) return rememberProject(current);
    if (current) {
      const jobs = await worker.request('jobs:list', undefined);
      if (jobs.some(job => job.state === 'running')) throw new Error('当前工程有任务正在运行，请先在任务中心暂停或等待完成，再切换书籍。');
    }
    const rootPath = await projectLibrary.resolve(String(id));
    return rememberProject(await worker.request('project:open', { rootPath }));
  });
  ipcMain.handle('project:get', () => worker.request('project:get', undefined));
  ipcMain.handle('project:diagnostics', (_event, mode: 'quick' | 'full') =>
    worker.request('project:diagnostics', { mode: mode === 'full' ? 'full' : 'quick' }));
  ipcMain.handle('refinement:dashboard', () => worker.request('refinement:dashboard', undefined));
  ipcMain.handle('artifacts:foundation-status', (_event, entryEventId?: string) =>
    worker.request('artifacts:foundation-status', { entryEventId: entryEventId ? String(entryEventId) : undefined }));
  ipcMain.handle('artifacts:foundation-generate', (_event, entryEventId: string) =>
    worker.request('artifacts:foundation-generate', { entryEventId: String(entryEventId) }));
  ipcMain.handle('artifacts:playable-bundle-export', async (_event, entryEventId: string) => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择可游玩整合包的输出文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const project = await worker.request('project:get', undefined);
    if (!project) throw new Error('请先打开工程。');
    const internalDirectory = path.join(project.rootPath, 'exports');
    const internal = await worker.request('artifacts:playable-bundle-export', {
      entryEventId: String(entryEventId), outputDirectory: internalDirectory,
    });
    if (path.resolve(selection.filePaths[0]).toLowerCase() === path.resolve(internalDirectory).toLowerCase()) return internal;
    return worker.request('artifacts:playable-bundle-export', {
      entryEventId: String(entryEventId), outputDirectory: selection.filePaths[0],
    });
  });
  ipcMain.handle('artifacts:playable-bundle-validate', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择要校验的可游玩整合包',
      properties: ['openDirectory'],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return worker.request('artifacts:playable-bundle-validate', { packageDirectory: selection.filePaths[0] });
  });
  ipcMain.handle('import:preview', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择 TXT 小说',
      properties: ['openFile'],
      filters: [{ name: '文本小说', extensions: ['txt'] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return worker.request('import:preview', { sourcePath: selection.filePaths[0] });
  });
  ipcMain.handle('import:run', async (_event, sourcePath: string, encoding: string) => {
    const result = await worker.request('import:run', { sourcePath, encoding });
    const project = await worker.request('project:get', undefined);
    if (project) await rememberProject(project);
    return result;
  });
  ipcMain.handle('chapters:list', () => worker.request('chapters:list', undefined));
  ipcMain.handle('chapters:rename', (_event, chapterId: string, title: string) =>
    worker.request('chapters:rename', { chapterId, title }),
  );
  ipcMain.handle('chapters:split', (_event, chapterId: string, paragraphOrdinal: number, title: string) =>
    worker.request('chapters:split', { chapterId, paragraphOrdinal, title }),
  );
  ipcMain.handle('chapters:merge-next', (_event, chapterId: string) =>
    worker.request('chapters:merge-next', { chapterId }),
  );
  ipcMain.handle('paragraphs:list', (_event, chapterId?: string) =>
    worker.request('paragraphs:list', { chapterId, limit: 2000 }),
  );
  ipcMain.handle('paragraphs:exclude', (_event, paragraphId: string, excluded: boolean) =>
    worker.request('paragraphs:exclude', { paragraphId, excluded }),
  );
  ipcMain.handle('chunks:build', (_event, settings: unknown) => worker.request('chunks:build', chunkSettingsSchema.parse(settings)));
  ipcMain.handle('chunks:list', () => worker.request('chunks:list', undefined));
  ipcMain.handle('chunks:inspect', (_event, chunkId: string) => worker.request('chunks:inspect', { chunkId: String(chunkId) }));
  ipcMain.handle('search', (_event, query: string) => worker.request('search', { query: String(query), limit: 100 }));
  ipcMain.handle('evidence:anchor', (_event, paragraphId: string) => worker.request('evidence:anchor', { paragraphId }));
  ipcMain.handle('source-spans:inspect', (_event, sourceSpanId: string) =>
    worker.request('source-spans:inspect', { sourceSpanId: String(sourceSpanId) }));
  ipcMain.handle('jobs:list', () => worker.request('jobs:list', undefined));
  ipcMain.handle('jobs:control', async (_event, jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    let jobs = await worker.request('jobs:control', { jobId, action });
    const target = jobs.find((job) => job.id === jobId);
    if (target?.type === 'character-scan' && action === 'retry') {
      jobs = await worker.request('jobs:control', { jobId, action: 'resume' });
      characterRunner.start(jobId);
    } else if (target?.type === 'character-scan' && action === 'resume') {
      characterRunner.start(jobId);
    }
    if (target?.type === 'character-facts' && action === 'retry') {
      jobs = await worker.request('jobs:control', { jobId, action: 'resume' });
      factRunner.start(jobId);
    } else if (target?.type === 'character-facts' && action === 'resume') {
      factRunner.start(jobId);
    }
    if (target?.type === 'timeline-events' && action === 'retry') {
      jobs = await worker.request('jobs:control', { jobId, action: 'resume' });
      timelineEventRunner.start(jobId);
    } else if (target?.type === 'timeline-events' && action === 'resume') {
      timelineEventRunner.start(jobId);
    }
    if (target?.type === 'relationship-scan' && action === 'retry') {
      jobs = await worker.request('jobs:control', { jobId, action: 'resume' });
      const info = await worker.request('relationships:scan-info', { jobId });
      (info.mode === 'model' ? relationshipModelRunner : relationshipScanRunner).start(jobId);
    } else if (target?.type === 'relationship-scan' && action === 'resume') {
      const info = await worker.request('relationships:scan-info', { jobId });
      (info.mode === 'model' ? relationshipModelRunner : relationshipScanRunner).start(jobId);
    }
    if (target?.type === 'place-model-scan' && action === 'retry') {
      jobs = await worker.request('jobs:control', { jobId, action: 'resume' });
      placeModelScanRunner.start(jobId);
    } else if (target?.type === 'place-model-scan' && action === 'resume') {
      placeModelScanRunner.start(jobId);
    }
    return jobs;
  });
  ipcMain.handle('workflows:foundation-list', () => worker.request('workflows:foundation-list', undefined));
  ipcMain.handle('workflows:foundation-usage', (_event, runId: string) => readTokenUsageSummary(String(runId)));
  ipcMain.handle('workflows:foundation-budget', (_event, runId: string, tokenBudget: number | null) =>
    worker.request('workflows:foundation-budget', { runId: String(runId), tokenBudget }));
  ipcMain.handle('workflows:local-result', (_event, runId: string) => worker.request('workflows:local-result', { runId: String(runId) }));
  ipcMain.handle('workflows:local-upgrade', async (_event, runId: string) => {
    const result = await worker.request('workflows:local-upgrade', { runId: String(runId) });
    if (result.state === 'running') foundationWorkflowRunner.start(result.runId);
    return result;
  });
  ipcMain.handle('workflows:local-export', async (_event, options: import('../../src/shared/local-foundation').LocalFoundationExportOptions) => {
    const result = await worker.request('workflows:local-export', { runId: String(options.runId), entryOrdinal: options.entryOrdinal });
    await shell.openPath(result.outputPath);
    return result;
  });
  ipcMain.handle('workflows:foundation-start', async (_event, options: { model?: unknown; profile?: unknown; tokenBudget?: unknown; localOptions?: import('../../src/shared/local-foundation').LocalGenerationOptions }) => {
    const start = await worker.request('workflows:foundation-create', {
      model: String(options?.model ?? '').trim(),
      profile: String(options?.profile ?? 'medium').trim() || 'medium',
      tokenBudget: options?.tokenBudget == null ? null : Number(options.tokenBudget),
      localOptions: options?.localOptions,
    });
    if (start.state === 'running') foundationWorkflowRunner.start(start.runId);
    return start;
  });
  ipcMain.handle('workflows:foundation-control', async (
    _event,
    rawRunId: unknown,
    action: FoundationWorkflowControlAction,
  ) => {
    const runId = String(rawRunId ?? '');
    const current = await worker.request('workflows:foundation-get', { runId });
    const childJobId = current.steps.find((step) => step.stepKey === current.currentStepKey)?.childJobId;
    if (childJobId && (action === 'pause' || action === 'cancel')) {
      const child = (await worker.request('jobs:list', undefined)).find((job) => job.id === childJobId);
      const canPause = action === 'pause' && child?.state === 'running';
      const canCancel = action === 'cancel' && child && ['queued', 'running', 'paused'].includes(child.state);
      if (canPause || canCancel) await worker.request('jobs:control', { jobId: childJobId, action });
    }
    const result = await worker.request('workflows:foundation-control', { runId, action });
    if (action === 'resume' || action === 'retry') foundationWorkflowRunner.start(result.id);
    return result;
  });
  ipcMain.handle('backup:create', async () => {
    const project = await worker.request('project:get', undefined);
    if (!project) throw new Error('请先打开工程');
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出工程备份',
      defaultPath: `${project.name}-${new Date().toISOString().slice(0, 10)}.novelproj`,
      filters: [{ name: '小说工程备份', extensions: ['novelproj'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return worker.request('backup:create', { outputPath: selection.filePath });
  });
  ipcMain.handle('backup:restore', async () => {
    const backupSelection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择工程备份',
      properties: ['openFile'],
      filters: [{ name: '小说工程备份', extensions: ['novelproj'] }],
    });
    if (backupSelection.canceled || !backupSelection.filePaths[0]) return null;
    const destinationSelection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择恢复位置',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '恢复到这里',
    });
    if (destinationSelection.canceled || !destinationSelection.filePaths[0]) return null;
    const restored = await worker.request('backup:restore', {
      inputPath: backupSelection.filePaths[0],
      targetParent: destinationSelection.filePaths[0],
    });
    return rememberProject(await worker.request('project:open', { rootPath: restored.projectPath }));
  });
  ipcMain.handle('api:status', () => getApiStatus());
  ipcMain.handle('api:save', (_event, config: unknown) => saveApiConfig(config));
  ipcMain.handle('api:test', () => testApiConnection());
  ipcMain.handle('api:models', () => listApiModels());
  ipcMain.handle('characters:estimate', () => worker.request('characters:estimate', undefined));
  ipcMain.handle('characters:start', async (_event, options: { model?: unknown; promptVersion?: unknown }) => {
    const start = await worker.request('characters:scan-create', {
      model: String(options?.model ?? '').trim(),
      promptVersion: String(options?.promptVersion ?? 'character_scan.v1').trim(),
    });
    if (start.state === 'running') characterRunner.start(start.jobId);
    return start;
  });
  ipcMain.handle('characters:list', () => worker.request('characters:list', undefined));
  ipcMain.handle('characters:mentions', (_event, identityId: string) =>
    worker.request('characters:mentions', { identityId: String(identityId) }),
  );
  ipcMain.handle('characters:review', (_event, identityId: string, changes: { status?: 'pending' | 'confirmed' | 'rejected'; importanceTier?: 'core' | 'important' | 'minor' | 'incidental' | 'pending' }) =>
    worker.request('characters:review', { identityId: String(identityId), ...changes }),
  );
  ipcMain.handle('characters:aliases', (_event, identityId: string) => worker.request('characters:aliases', { identityId: String(identityId) }));
  ipcMain.handle('characters:alias-review', (_event, aliasId: string, status: 'pending' | 'confirmed' | 'rejected') =>
    worker.request('characters:alias-review', { aliasId: String(aliasId), status }),
  );
  ipcMain.handle('characters:links', (_event, identityId: string) => worker.request('characters:links', { identityId: String(identityId) }));
  ipcMain.handle('characters:link-review', (_event, linkId: string, status: 'pending' | 'confirmed' | 'rejected') =>
    worker.request('characters:link-review', { linkId: String(linkId), status }),
  );
  ipcMain.handle('characters:merge', (_event, sourceIdentityId: string, targetIdentityId: string) =>
    worker.request('characters:merge', { sourceIdentityId: String(sourceIdentityId), targetIdentityId: String(targetIdentityId) }),
  );
  ipcMain.handle('characters:split', (_event, sourceIdentityId: string, mentionIds: string[], canonicalName: string) =>
    worker.request('characters:split', { sourceIdentityId: String(sourceIdentityId), mentionIds: mentionIds.map(String), canonicalName: String(canonicalName) }),
  );
  ipcMain.handle('characters:link', (_event, leftIdentityId: string, rightIdentityId: string, relation: 'cannot_link' | 'must_link', reason: string) =>
    worker.request('characters:link', { leftIdentityId: String(leftIdentityId), rightIdentityId: String(rightIdentityId), relation, reason: String(reason) }),
  );
  ipcMain.handle('characters:operations', () => worker.request('characters:operations', undefined));
  ipcMain.handle('characters:undo', () => worker.request('characters:undo', undefined));
  ipcMain.handle('facts:estimate', (_event, identityId: string) => worker.request('facts:estimate', { identityId: String(identityId) }));
  ipcMain.handle('facts:start', async (_event, options: { identityId?: unknown; model?: unknown; promptVersion?: unknown; extractionPasses?: unknown }) => {
    const start = await worker.request('facts:run-create', {
      identityId: String(options?.identityId ?? ''), model: String(options?.model ?? '').trim(),
      promptVersion: String(options?.promptVersion ?? 'character_facts.v2').trim(),
      extractionPasses: options?.extractionPasses === 2 ? 2 : 1,
    });
    if (start.state === 'running') factRunner.start(start.jobId);
    return start;
  });
  ipcMain.handle('facts:list', (_event, identityId: string) => worker.request('facts:list', { identityId: String(identityId) }));
  ipcMain.handle('facts:evidence', (_event, factId: string) => worker.request('facts:evidence', { factId: String(factId) }));
  ipcMain.handle('facts:review', (_event, factId: string, status: 'pending' | 'confirmed' | 'rejected') =>
    worker.request('facts:review', { factId: String(factId), status }),
  );
  ipcMain.handle('quotes:scan', () => worker.request('quotes:scan', undefined));
  ipcMain.handle('quotes:summary', () => worker.request('quotes:summary', undefined));
  ipcMain.handle('quotes:list', (_event, options?: { limit?: unknown; offset?: unknown; unresolvedOnly?: unknown }) => worker.request('quotes:list', {
    limit: Math.max(1, Math.min(1000, Number(options?.limit) || 500)), offset: Math.max(0, Number(options?.offset) || 0),
    unresolvedOnly: options?.unresolvedOnly === true,
  }));
  ipcMain.handle('quotes:attributions', (_event, quoteId: string) => worker.request('quotes:attributions', { quoteId: String(quoteId) }));
  ipcMain.handle('quotes:review', (_event, attributionId: string, status: 'pending' | 'confirmed' | 'rejected') =>
    worker.request('quotes:review', { attributionId: String(attributionId), status }));
  ipcMain.handle('quotes:assign', (_event, quoteId: string, identityId: string) =>
    worker.request('quotes:assign', { quoteId: String(quoteId), identityId: String(identityId) }));
  ipcMain.handle('quotes:analyze-local', () => worker.request('quotes:analyze-local', undefined));
  ipcMain.handle('quotes:profiles', () => worker.request('quotes:profiles', undefined));
  ipcMain.handle('facts:consolidate-local', () => worker.request('facts:consolidate-local', undefined));
  ipcMain.handle('facts:clusters', (_event, identityId?: string) => worker.request('facts:clusters', { identityId: identityId ? String(identityId) : undefined }));
  ipcMain.handle('facts:cluster-members', (_event, clusterId: string) => worker.request('facts:cluster-members', { clusterId: String(clusterId) }));
  ipcMain.handle('facts:relations', (_event, identityId?: string) => worker.request('facts:relations', { identityId: identityId ? String(identityId) : undefined }));
  ipcMain.handle('facts:relation-review', (_event, relationId: string, status: 'pending' | 'confirmed' | 'rejected',
    resolvedRelation?: 'contradiction' | 'state_change' | 'coexists_by_time' | 'viewpoint_difference' | 'rumor_correction' | 'identity_disguise' | 'unrelated') =>
    worker.request('facts:relation-review', { relationId: String(relationId), status, resolvedRelation }));
  ipcMain.handle('facts:transitions', (_event, identityId?: string) => worker.request('facts:transitions', { identityId: identityId ? String(identityId) : undefined }));
  ipcMain.handle('timeline:time-scan', () => worker.request('timeline:time-scan', undefined));
  ipcMain.handle('timeline:time-summary', () => worker.request('timeline:time-summary', undefined));
  ipcMain.handle('timeline:time-list', (_event, status?: 'pending' | 'confirmed' | 'rejected') =>
    worker.request('timeline:time-list', { status }));
  ipcMain.handle('timeline:time-review', (_event, id: string, status: 'pending' | 'confirmed' | 'rejected', normalizedValue?: string | null) =>
    worker.request('timeline:time-review', { id: String(id), status, normalizedValue }));
  ipcMain.handle('timeline:events-estimate', () => worker.request('timeline:events-estimate', undefined));
  ipcMain.handle('timeline:events-start', async (_event, options: { model?: unknown; promptVersion?: unknown }) => {
    const start = await worker.request('timeline:events-run-create', {
      model: String(options?.model ?? '').trim(),
      promptVersion: String(options?.promptVersion ?? 'timeline_events.v1').trim(),
    });
    if (start.state === 'running') timelineEventRunner.start(start.jobId);
    return start;
  });
  ipcMain.handle('timeline:events-list', (_event, status?: 'pending' | 'confirmed' | 'rejected') => worker.request('timeline:events-list', { status }));
  ipcMain.handle('timeline:events-review', (_event, eventId: string, status: 'pending' | 'confirmed' | 'rejected') =>
    worker.request('timeline:events-review', { eventId: String(eventId), status }));
  ipcMain.handle('timeline:events-evidence', (_event, eventId: string) => worker.request('timeline:events-evidence', { eventId: String(eventId) }));
  ipcMain.handle('timeline:events-participants', (_event, eventId: string) => worker.request('timeline:events-participants', { eventId: String(eventId) }));
  ipcMain.handle('timeline:events-locations', (_event, eventId: string) => worker.request('timeline:events-locations', { eventId: String(eventId) }));
  ipcMain.handle('places:bootstrap-events', () => worker.request('places:bootstrap-events', undefined));
  ipcMain.handle('places:list', (_event, status?: 'pending' | 'confirmed' | 'rejected') => worker.request('places:list', { status }));
  ipcMain.handle('places:mentions', (_event, placeId: string) => worker.request('places:mentions', { placeId: String(placeId) }));
  ipcMain.handle('places:review', (_event, placeId: string, changes: WorkerRequestMap['places:review']) => worker.request('places:review', {
    placeId: String(placeId), status: changes.status, placeType: changes.placeType, canonicalName: changes.canonicalName,
  }));
  ipcMain.handle('places:aliases', (_event, placeId: string) => worker.request('places:aliases', { placeId: String(placeId) }));
  ipcMain.handle('places:alias-review', (_event, aliasId: string, status: 'pending' | 'confirmed' | 'rejected') =>
    worker.request('places:alias-review', { aliasId: String(aliasId), status }));
  ipcMain.handle('places:alias-evidence', (_event, aliasId: string) => worker.request('places:alias-evidence', { aliasId: String(aliasId) }));
  ipcMain.handle('places:merge', (_event, sourcePlaceId: string, targetPlaceId: string) =>
    worker.request('places:merge', { sourcePlaceId: String(sourcePlaceId), targetPlaceId: String(targetPlaceId) }));
  ipcMain.handle('places:split', (_event, sourcePlaceId: string, mentionIds: string[], canonicalName: string) =>
    worker.request('places:split', { sourcePlaceId: String(sourcePlaceId), mentionIds: mentionIds.map(String), canonicalName: String(canonicalName) }));
  ipcMain.handle('places:link', (_event, leftPlaceId: string, rightPlaceId: string, relation: 'cannot_link' | 'must_link', reason: string) =>
    worker.request('places:link', { leftPlaceId: String(leftPlaceId), rightPlaceId: String(rightPlaceId), relation, reason: String(reason) }));
  ipcMain.handle('places:links', (_event, placeId?: string) => worker.request('places:links', { placeId: placeId ? String(placeId) : undefined }));
  ipcMain.handle('places:link-review', (_event, linkId: string, status: 'pending' | 'confirmed' | 'rejected') => worker.request('places:link-review', { linkId: String(linkId), status }));
  ipcMain.handle('places:link-evidence', (_event, linkId: string) => worker.request('places:link-evidence', { linkId: String(linkId) }));
  ipcMain.handle('places:relation-candidates', (_event, status?: 'pending' | 'confirmed' | 'rejected') => worker.request('places:relation-candidates', { status }));
  ipcMain.handle('places:relation-evidence', (_event, candidateId: string) => worker.request('places:relation-evidence', { candidateId: String(candidateId) }));
  ipcMain.handle('places:relation-suggestion', (_event, candidateId: string) => worker.request('places:relation-suggestion', { candidateId: String(candidateId) }));
  ipcMain.handle('places:relation-review', (_event, candidateId: string, status: 'pending' | 'confirmed' | 'rejected') => worker.request('places:relation-review', { candidateId: String(candidateId), status }));
  ipcMain.handle('places:assertion-create', (_event, candidateId: string) => worker.request('places:assertion-create', { candidateId: String(candidateId) }));
  ipcMain.handle('places:assertions-list', (_event, status?: 'pending' | 'confirmed' | 'rejected') => worker.request('places:assertions-list', { status }));
  ipcMain.handle('places:assertions-at-entry', (_event, entryOrdinal: number) => worker.request('places:assertions-at-entry', { entryOrdinal: Number(entryOrdinal) }));
  ipcMain.handle('places:map-projection', (_event, entryOrdinal: number) => worker.request('places:map-projection', { entryOrdinal: Number(entryOrdinal) }));
  ipcMain.handle('places:map-export', async (_event, entryOrdinal: number) => {
    const project = await worker.request('project:get', undefined);
    if (!project?.activeRevisionId) throw new Error('请先导入小说');
    const safeName = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim() || 'world-map';
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出防剧透叙事地图',
      defaultPath: `${safeName}-world_map-p${Number(entryOrdinal)}.json`,
      filters: [{ name: '叙事地图 JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return worker.request('places:map-export', { entryOrdinal: Number(entryOrdinal), outputPath: selection.filePath });
  });
  ipcMain.handle('artifacts:worldbook-export', async (_event, entryOrdinal: number) => {
    if (!Number.isSafeInteger(entryOrdinal) || entryOrdinal < 0) throw new Error('请选择有效的阅读位置。');
    const project = await worker.request('project:get', undefined);
    if (!project?.activeRevisionId) throw new Error('请先导入小说');
    const data = await worker.request('artifacts:worldbook-preview', { entryOrdinal });
    const entries = Object.fromEntries([...Object.values(data.relationships.entries), ...Object.values(data.places.entries)]
      .map((entry, uid) => [String(uid), { ...entry, uid, displayIndex: uid, excludeRecursion: true, preventRecursion: true, ignoreBudget: false }]));
    const book = { name: `${project.name} · 世界书 P${entryOrdinal}`, description: `仅包含段落 ${entryOrdinal} 已揭示的关系与地点资料。`,
      scan_depth: 2, token_budget: 2048, recursive_scanning: false, entries,
      extensions: { novel_world_compiler: { project_id: project.id, revision_id: project.activeRevisionId, entry_ordinal: entryOrdinal } } };
    const selection = await dialog.showSaveDialog(mainWindow!, { title: '导出独立世界书', defaultPath: '世界书.json', filters: [{ name: '世界书 JSON', extensions: ['json'] }] });
    if (selection.canceled || !selection.filePath) return null;
    const temporary = selection.filePath + '.' + randomUUID() + '.tmp';
    try { await fs.writeFile(temporary, JSON.stringify(book, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); await fs.rename(temporary, selection.filePath); }
    catch (error) { await fs.unlink(temporary).catch(() => undefined); throw error; }
    return { outputPath: selection.filePath, entryCount: Object.keys(entries).length };
  });
  ipcMain.handle('artifacts:worldbook-preview', async (_event, entryOrdinal: number) => {
    if (!Number.isSafeInteger(entryOrdinal) || entryOrdinal < 0) throw new Error('请选择有效的阅读位置。');
    return worker.request('artifacts:worldbook-preview', { entryOrdinal });
  });
  ipcMain.handle('places:world-info-export', async (_event, entryOrdinal: number) => {
    const project = await worker.request('project:get', undefined);
    if (!project?.activeRevisionId) throw new Error('请先导入小说');
    const safeName = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim() || 'place-world-info';
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出 SillyTavern 地点世界书',
      defaultPath: `${safeName}-places-world_info-p${Number(entryOrdinal)}.json`,
      filters: [{ name: 'SillyTavern 地点世界书 JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return worker.request('places:world-info-export', { entryOrdinal: Number(entryOrdinal), outputPath: selection.filePath });
  });
  ipcMain.handle('places:geometries-list', (_event, status?: 'pending' | 'confirmed' | 'rejected') => worker.request('places:geometries-list', { status }));
  ipcMain.handle('places:geometry-upsert', (_event, input: WorkerRequestMap['places:geometry-upsert']) => worker.request('places:geometry-upsert', input));
  ipcMain.handle('places:geometry-review', (_event, geometryId: string, status: 'pending' | 'confirmed' | 'rejected') => worker.request('places:geometry-review', { geometryId: String(geometryId), status }));
  ipcMain.handle('places:geojson-build', (_event, entryOrdinal: number) => worker.request('places:geojson-build', { entryOrdinal: Number(entryOrdinal) }));
  ipcMain.handle('places:geojson-export', async (_event, entryOrdinal: number) => {
    const project = await worker.request('project:get', undefined);
    if (!project?.activeRevisionId) throw new Error('请先导入小说');
    const safeName = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim() || 'places';
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出已确认真实地点 GeoJSON',
      defaultPath: `${safeName}-places-p${Number(entryOrdinal)}.geojson`,
      filters: [{ name: 'GeoJSON', extensions: ['geojson', 'json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return worker.request('places:geojson-export', { entryOrdinal: Number(entryOrdinal), outputPath: selection.filePath });
  });
  ipcMain.handle('places:assertion-review', (_event, relationId: string, status: 'pending' | 'confirmed' | 'rejected') => worker.request('places:assertion-review', { relationId: String(relationId), status }));
  ipcMain.handle('places:assertion-evidence', (_event, relationId: string) => worker.request('places:assertion-evidence', { relationId: String(relationId) }));
  ipcMain.handle('places:operations', () => worker.request('places:operations', undefined));
  ipcMain.handle('places:undo', () => worker.request('places:undo', undefined));
  ipcMain.handle('places:model-scan-estimate', () => worker.request('places:model-scan-estimate', undefined));
  ipcMain.handle('places:model-scan-start', async (_event, options?: { model?: unknown; promptVersion?: unknown }) => {
    const model = String(options?.model ?? '').trim();
    const promptVersion = String(options?.promptVersion ?? 'place-model.v1').trim();
    const extractorVersion = `model:${model}:${promptVersion}`;
    const start = await worker.request('places:model-scan-create', { model, promptVersion, extractorVersion });
    if (start.state === 'running') placeModelScanRunner.start(start.jobId);
    return start;
  });
  ipcMain.handle('timeline:relations-consolidate', () => worker.request('timeline:relations-consolidate', undefined));
  ipcMain.handle('timeline:relations-list', () => worker.request('timeline:relations-list', undefined));
  ipcMain.handle('timeline:relations-review', (_event, relationId: string, status: 'pending' | 'confirmed' | 'rejected', resolvedRelation?: 'before' | 'after' | 'simultaneous' | 'includes' | 'is_included' | 'unknown') =>
    worker.request('timeline:relations-review', { relationId: String(relationId), status, resolvedRelation }));
  ipcMain.handle('timeline:graph-summary', () => worker.request('timeline:graph-summary', undefined));
  ipcMain.handle('timeline:graph-order', () => worker.request('timeline:graph-order', undefined));
  ipcMain.handle('timeline:state-snapshot', (_event, entryEventId: string, identityId?: string) =>
    worker.request('timeline:state-snapshot', { entryEventId: String(entryEventId), identityId: identityId ? String(identityId) : undefined }));
  ipcMain.handle('relationships:candidates-list', (_event, status?: CharacterRelationshipReviewStatus) =>
    worker.request('relationships:candidates-list', { status }));
  ipcMain.handle('relationships:candidate-evidence', (_event, candidateId: string) =>
    worker.request('relationships:candidate-evidence', { candidateId: String(candidateId) }));
  ipcMain.handle('relationships:candidate-suggestion', (_event, candidateId: string) =>
    worker.request('relationships:candidate-suggestion', { candidateId: String(candidateId) }));
  ipcMain.handle('relationships:scan-estimate', () => worker.request('relationships:scan-estimate', undefined));
  ipcMain.handle('relationships:scan-start', async (_event, options?: { extractorVersion?: unknown }) => {
    const requested = options as { extractorVersion?: unknown; mode?: unknown; model?: unknown; promptVersion?: unknown } | undefined;
    const mode = requested?.mode === 'model' ? 'model' as const : 'local' as const;
    const model = mode === 'model' ? String(requested?.model ?? '').trim() : undefined;
    const promptVersion = String(requested?.promptVersion ?? (mode === 'model' ? 'relationship-model.v1' : 'relationship-local.v2')).trim();
    const extractorVersion = String(requested?.extractorVersion ?? (mode === 'model' ? `model:${model}:${promptVersion}` : 'local-v2')).trim()
      || (mode === 'model' ? `model:${model}:${promptVersion}` : 'local-v2');
    const start = await worker.request('relationships:scan-create', { extractorVersion, mode, model, promptVersion });
    if (start.state === 'running') (mode === 'model' ? relationshipModelRunner : relationshipScanRunner).start(start.jobId);
    return start;
  });
  ipcMain.handle('relationships:candidate-create', (_event, input: CharacterRelationshipCandidateInput) =>
    worker.request('relationships:candidate-create', input));
  ipcMain.handle('relationships:candidate-review', (_event, candidateId: string, status: CharacterRelationshipReviewStatus) =>
    worker.request('relationships:candidate-review', { candidateId: String(candidateId), status }));
  ipcMain.handle('relationships:list', (_event, status?: CharacterRelationshipReviewStatus) =>
    worker.request('relationships:list', { status }));
  ipcMain.handle('relationships:list-at-entry', (_event, entryOrdinal: number) =>
    worker.request('relationships:list-at-entry', { entryOrdinal: Number(entryOrdinal) }));
  ipcMain.handle('relationships:graph-projection', (_event, entryOrdinal: number) =>
    worker.request('relationships:graph-projection', { entryOrdinal: Number(entryOrdinal) }));
  ipcMain.handle('relationships:graph-export', async (_event, entryOrdinal: number) => {
    const project = await worker.request('project:get', undefined);
    if (!project?.activeRevisionId) throw new Error('请先导入小说');
    const safeName = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim() || 'character-graph';
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出防剧透人物关系图',
      defaultPath: `${safeName}-character_graph-p${Number(entryOrdinal)}.json`,
      filters: [{ name: '人物关系图 JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return worker.request('relationships:graph-export', { entryOrdinal: Number(entryOrdinal), outputPath: selection.filePath });
  });
  ipcMain.handle('relationships:world-info-export', async (_event, entryOrdinal: number) => {
    const project = await worker.request('project:get', undefined);
    if (!project?.activeRevisionId) throw new Error('请先导入小说');
    const safeName = project.name.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim() || 'world-info';
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出 SillyTavern 世界书',
      defaultPath: `${safeName}-relationships-world_info-p${Number(entryOrdinal)}.json`,
      filters: [{ name: 'SillyTavern 世界书 JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return worker.request('relationships:world-info-export', { entryOrdinal: Number(entryOrdinal), outputPath: selection.filePath });
  });
  ipcMain.handle('relationships:create', (_event, input: CharacterRelationshipAssertionInput) =>
    worker.request('relationships:create', input));
  ipcMain.handle('relationships:review', (_event, relationshipId: string, status: CharacterRelationshipReviewStatus) =>
    worker.request('relationships:review', { relationshipId: String(relationshipId), status }));
  ipcMain.handle('relationships:evidence', (_event, relationshipId: string) =>
    worker.request('relationships:evidence', { relationshipId: String(relationshipId) }));
  ipcMain.handle('cards:draft-get', (_event, identityId: string) => worker.request('cards:draft-get', { identityId: String(identityId) }));
  ipcMain.handle('cards:draft-generate', (_event, identityId: string, entryEventId: string) =>
    worker.request('cards:draft-generate', { identityId: String(identityId), entryEventId: String(entryEventId) }));
  ipcMain.handle('cards:draft-save', (_event, identityId: string, fields: unknown, reviewStatus: 'draft' | 'reviewed') =>
    worker.request('cards:draft-save', { identityId: String(identityId), fields: fields as never, reviewStatus }));
  ipcMain.handle('cards:export-json', async (_event, identityId: string) => {
    const draft = await worker.request('cards:draft-get', { identityId: String(identityId) });
    if (!draft) throw new Error('请先生成角色卡草稿');
    const safeName = draft.identityName.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').trim() || 'character';
    const selection = await dialog.showSaveDialog(mainWindow!, {
      title: '导出 SillyTavern V2 角色卡',
      defaultPath: `${safeName}-角色卡-v2.json`,
      filters: [{ name: 'SillyTavern 角色卡 JSON', extensions: ['json'] }],
    });
    if (selection.canceled || !selection.filePath) return null;
    return worker.request('cards:export-json', { identityId: String(identityId), outputPath: selection.filePath });
  });
  ipcMain.handle('cards:refine', (_event, identityId: string, model: string) =>
    characterCardRefinementRunner.refine(String(identityId), String(model)));
  ipcMain.handle('cards:refinement-latest', (_event, identityId: string) =>
    worker.request('cards:refinement-latest', { identityId: String(identityId) }));
  ipcMain.handle('cards:refinement-review', (_event, refinementId: string, action: 'apply' | 'reject', fields?: Array<'description' | 'personality' | 'scenario' | 'firstMes' | 'mesExample'>) =>
    worker.request('cards:refinement-review', { refinementId: String(refinementId), action, fields }));
  ipcMain.handle('cards:batch-status', () => worker.request('cards:batch-status', undefined));
  ipcMain.handle('cards:batch-generate', (_event, entryEventId: string) =>
    worker.request('cards:batch-generate', { entryEventId: String(entryEventId) }));
  ipcMain.handle('cards:batch-export', async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, { title: '选择已审阅角色卡的导出文件夹', properties: ['openDirectory', 'createDirectory'] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return worker.request('cards:batch-export', { outputDirectory: selection.filePaths[0] });
  });
  ipcMain.handle('runtime:ask', (_event, identityId: string, question: string, model: string, retrievalMode?: 'off' | 'explainable-v1') =>
    characterRuntimeRunner.ask(String(identityId), String(question), String(model), retrievalMode));
  ipcMain.handle('runtime:list', (_event, identityId: string, limit?: number) =>
    worker.request('runtime:list', { identityId: String(identityId), limit: limit === undefined ? undefined : Number(limit) }));
  ipcMain.handle('runtime:session-create', (_event, identityId: string, model: string, retrievalMode?: 'off' | 'explainable-v1') =>
    worker.request('runtime:session-create', { identityId: String(identityId), model: String(model), retrievalMode }));
  ipcMain.handle('runtime:session-close', (_event, sessionId: string) =>
    worker.request('runtime:session-close', { sessionId: String(sessionId) }));
  ipcMain.handle('runtime:session-list', (_event, identityId: string, limit?: number) =>
    worker.request('runtime:session-list', { identityId: String(identityId), limit: limit === undefined ? undefined : Number(limit) }));
  ipcMain.handle('runtime:session-ask', (_event, sessionId: string, question: string) =>
    characterRuntimeRunner.askSession(String(sessionId), String(question)));
  ipcMain.handle('runtime:session-turns', (_event, sessionId: string, limit?: number) =>
    worker.request('runtime:session-turns', { sessionId: String(sessionId), limit: limit === undefined ? undefined : Number(limit) }));
}

app.whenReady().then(async () => {
  app.setAppUserModelId('cn.dfzh.novelworldcompiler');
  registerIpc();
  worker.start();
  await createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void sillyTavern.stop();
  worker.stop();
});
