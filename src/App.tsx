import { WorldBookPreview } from './WorldBookPreview';
import { ApiRequestFields } from './ApiRequestFields';
import { apiRequestSettingsSchema, defaultApiRequestSettings } from './shared/api-request-settings';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  ApiStatus,
  ChapterRecord,
  CharacterCandidate,
  CharacterAliasRecord,
  CharacterIdentityLinkRecord,
  CharacterFactEstimate,
  CharacterFactEvidenceRecord,
  CharacterFactRecord,
  CharacterMentionRecord,
  CharacterScanEstimate,
  ChunkInspection,
  ChunkRecord,
  ChunkSettings,
  ImportPreview,
  IdentityOperationRecord,
  JobRecord,
  FoundationWorkflowControlAction,
  FoundationWorkflowRunRecord,
  FoundationUsageSummary,
  FoundationWorkflowStepKey,
  ParagraphRecord,
  ProjectSummary,
  ProjectDiagnosticReport,
  CharacterQuoteRecord,
  QuoteAttributionRecord,
  QuoteScanSummary,
  SpeechProfileRecord,
  CharacterStateTransitionRecord,
  FactClusterRecord,
  FactConsolidationSummary,
  FactRelationKind,
  FactRelationRecord,
  SearchHit,
  SourceSpanInspection,
  TimeExpressionRecord,
  TimeExpressionReviewStatus,
  TimeExpressionScanSummary,
  TimelineEventEstimate,
  TimelineEventEvidenceRecord,
  TimelineEventLocationRecord,
  TimelineEventParticipantRecord,
  TimelineEventRecord,
  TimelineGraphSummary,
  TimelineOrderRecord,
  TimelineRelationKind,
  TimelineRelationRecord,
  StoryStateSnapshot,
  CharacterCardDraftFields,
  CharacterCardDraftRecord,
  CharacterCardRefineField,
  CharacterCardRefinementRecord,
  CharacterCardBatchItem,
  CharacterCardBatchGenerationSummary,
  CharacterRuntimeSessionRecord,
  CharacterRuntimeTurnRecord,
  CharacterRelationshipCandidateEvidenceRecord,
  CharacterRelationshipCandidateRecord,
  CharacterRelationshipRecord,
  CharacterRelationshipReviewStatus,
  RelationshipModelSuggestionRecord,
  RelationshipScanEstimate,
  PlaceAliasRecord,
  PlaceBootstrapSummary,
  PlaceIdentityLinkRecord,
  PlaceIdentityOperationRecord,
  PlaceMentionRecord,
  PlaceModelScanEstimate,
  PlaceRecord,
  PlaceRelationCandidateRecord,
  PlaceRelationEvidenceRecord,
  PlaceRelationModelSuggestionRecord,
  PlaceRelationRecord,
  PlaceReviewStatus,
  PlaceSuggestionEvidenceRecord,
  PlaceType,
  RefinementDashboard,
  RefinementIssue,
  RefinementSeverity,
  ArtifactFoundationDashboard,
  ArtifactFoundationGate,
  ArtifactFoundationGenerationResult,
  PlayableBundleExportResult,
  PlayableBundleValidationReport,
  SillyTavernStatus,
} from './shared/contracts';
import { WorldLibrary } from './WorldLibrary';
import { PlaySessionSetup } from './PlaySessionSetup';
import { apiProviderPresets, findProviderPreset, providerConfigChanged } from './provider-presets';

type View = 'overview' | 'chapters' | 'chunks' | 'foundation-workflow' | 'refinement' | 'artifact-foundation' | 'characters' | 'quotes' | 'fact-review' | 'timeline' | 'places' | 'narrative-map' | 'relationships' | 'relationship-graph' | 'character-cards' | 'search' | 'jobs' | 'diagnostics' | 'settings';

const RelationshipGraphView = lazy(async () => {
  const module = await import('./RelationshipGraphView');
  return { default: module.RelationshipGraphView };
});

const NarrativeMapView = lazy(async () => {
  const module = await import('./NarrativeMapView');
  return { default: module.NarrativeMapView };
});

const defaultChunkSettings: ChunkSettings = {
  coreChars: 8000,
  softLimit: 10_000,
  hardLimit: 12_000,
  overlapBefore: 500,
  overlapAfter: 500,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PlatformMode = 'hub' | 'compiler' | 'tavern' | 'play-setup';

const initialTavernStatus: SillyTavernStatus = {
  state: 'stopped',
  version: null,
  runtimeRoot: '',
  dataRoot: '',
  baseUrl: null,
  pid: null,
  message: '正在检查本地运行文件…',
  bundled: false,
};

export function App() {
  const [mode, setMode] = useState<PlatformMode>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('view') || params.get('mode') === 'compiler' ? 'compiler' : 'hub';
  });
  const [compilerKey, setCompilerKey] = useState('initial');
  const [playProjectId, setPlayProjectId] = useState('');
  const [compilerMounted, setCompilerMounted] = useState(() => new URLSearchParams(window.location.search).has('view') || new URLSearchParams(window.location.search).get('mode') === 'compiler');
  const [tavernStatus, setTavernStatus] = useState<SillyTavernStatus>(initialTavernStatus);

  const refreshTavernStatus = useCallback(() => {
    void window.novelCompiler.getSillyTavernStatus().then(setTavernStatus).catch((error) => {
      setTavernStatus({ ...initialTavernStatus, state: 'error', message: errorMessage(error) });
    });
  }, []);

  useEffect(() => {
    refreshTavernStatus();
    const timer = window.setInterval(refreshTavernStatus, 1_500);
    return () => window.clearInterval(timer);
  }, [refreshTavernStatus]);

  async function enterTavern() {
    setMode('tavern');
    setTavernStatus((current) => ({ ...current, state: 'starting', message: '正在启动本地 SillyTavern…' }));
    try {
      setTavernStatus(await window.novelCompiler.showSillyTavern());
    } catch (error) {
      setTavernStatus((current) => ({ ...current, state: 'error', message: errorMessage(error) }));
    }
  }

  async function prepareReading(id: string) {
    await window.novelCompiler.hideSillyTavern();
    setPlayProjectId(id); setMode('play-setup');
  }

  async function enterCompiler(id?: string) {
    if (id) setCompilerKey(id);
    setCompilerMounted(true);
    await window.novelCompiler.hideSillyTavern().catch(() => undefined);
    setMode('compiler');
  }

  async function returnHome() {
    await window.novelCompiler.hideSillyTavern().catch(() => undefined);
    setMode('hub');
    refreshTavernStatus();
  }

  async function stopTavern() {
    setTavernStatus(await window.novelCompiler.stopSillyTavern());
    setMode('hub');
  }

  return <>
    {compilerMounted && <div hidden={mode !== 'compiler'}><CompilerApp key={compilerKey} onBack={() => void returnHome()} onRead={id => void prepareReading(id)} /></div>}
    {mode === 'tavern' && <TavernSurface status={tavernStatus} onBack={() => void returnHome()} onRetry={() => void enterTavern()} onStop={() => void stopTavern()} />}
    {mode === 'play-setup' && <PlaySessionSetup key={playProjectId} projectId={playProjectId} onBack={() => void returnHome()} onStarted={status => { setTavernStatus(status); setMode('tavern'); }} />}
    {mode === 'hub' && <WorldLibrary status={tavernStatus} onEnterCompiler={id => void enterCompiler(id)} onEnterPlay={id => void prepareReading(id)} onEnterTavern={() => void enterTavern()} onStopTavern={() => void stopTavern()} />}
  </>;
}

function TavernSurface({ status, onBack, onRetry, onStop }: { status: SillyTavernStatus; onBack: () => void; onRetry: () => void; onStop: () => void }) {
  return <main className="tavern-surface">
    <header className="platform-bar">
      <button className="platform-back" onClick={onBack}>← 小说世界</button>
      <div className="platform-module"><i>馆</i><div><strong>小说世界 · 阅读空间</strong><span>{status.state === 'ready' ? `本地运行中 · ${status.version ?? ''}` : status.message}</span></div></div>
      <div className="platform-bar-actions">
        {status.state === 'error' && <button className="button primary" onClick={onRetry}>重新启动</button>}
        {status.state === 'ready' && <button className="button ghost" onClick={onStop}>结束运行</button>}
      </div>
    </header>
    <section className={`tavern-stage ${status.state}`}>
      <div className="tavern-loader"><span>ST</span><h2>{status.state === 'error' ? 'SillyTavern 没有成功启动' : '正在打开 SillyTavern'}</h2><p>{status.message}</p>{status.state === 'error' && <button className="button primary" onClick={onRetry}>重试</button>}</div>
    </section>
  </main>;
}

function CompilerApp({ onBack, onRead }: { onBack: () => void; onRead: (id: string) => void }) {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [foundationProfile, setFoundationProfile] = useState<'low' | 'medium' | 'high'>('medium');
  const [view, setView] = useState<View>(() => new URLSearchParams(window.location.search).get('view') === 'settings' ? 'settings' : 'overview');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [chapters, setChapters] = useState<ChapterRecord[]>([]);
  const [chunks, setChunks] = useState<ChunkRecord[]>([]);
  const [jobs, setJobs] = useState<JobRecord[]>([]);

  const run = useCallback(async <T,>(operation: () => Promise<T>, success?: string): Promise<T | null> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await operation();
      if (success) setNotice({ tone: 'ok', text: success });
      return result;
    } catch (error) {
      setNotice({ tone: 'error', text: errorMessage(error) });
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    const current = await window.novelCompiler.getProject();
    setProject(current);
    if (!current?.activeRevisionId) {
      setChapters([]);
      setChunks([]);
      setJobs(current ? await window.novelCompiler.listJobs() : []);
      return;
    }
    const [nextChapters, nextChunks, nextJobs] = await Promise.all([
      window.novelCompiler.listChapters(),
      window.novelCompiler.listChunks(),
      window.novelCompiler.listJobs(),
    ]);
    setChapters(nextChapters);
    setChunks(nextChunks);
    setJobs(nextJobs);
  }, []);

  useEffect(() => { void refresh().catch(() => undefined); }, [refresh]);
  useEffect(() => { setFoundationProfile('medium'); }, [project?.id]);
  useEffect(() => {
    if (!project) return;
    const timer = window.setInterval(() => {
      void window.novelCompiler.listJobs().then(setJobs).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [project?.id]);

  async function createProject(name: string) {
    const created = await run(() => window.novelCompiler.createProject(name));
    if (created) {
      setProject(created);
      setView('overview');
      setNotice({ tone: 'ok', text: `工程“${created.name}”已创建` });
    }
  }

  async function openProject() {
    const opened = await run(() => window.novelCompiler.openProject());
    if (opened) {
      setProject(opened);
      setView('overview');
      await refresh();
      setNotice({ tone: 'ok', text: `已打开“${opened.name}”` });
    }
  }

  async function restoreBackup() {
    const restored = await run(() => window.novelCompiler.restoreBackup());
    if (restored) {
      setProject(restored);
      setView('overview');
      await refresh();
      setNotice({ tone: 'ok', text: `备份已安全恢复为“${restored.name}”` });
    }
  }

  async function chooseImport() {
    const preview = await run(() => window.novelCompiler.previewImport());
    if (preview) setImportPreview(preview);
  }

  async function confirmImport(encoding: string) {
    if (!importPreview) return;
    const sourcePath = importPreview.sourcePath;
    setImportPreview(null);
    const result = await run(
      () => window.novelCompiler.runImport(sourcePath, encoding),
      '小说导入完成，结构化底稿已经建立',
    );
    if (result) {
      await refresh();
      setView('overview');
    }
  }

  if (!project) {
    if (view === 'settings') {
      return <div className="compiler-entry"><button className="platform-back compiler-floating-back" onClick={onBack}>← 小说世界</button><main className="standalone-settings"><SettingsView run={run} /></main></div>;
    }
    return <div className="compiler-entry"><button className="platform-back compiler-floating-back" onClick={onBack}>← 小说世界</button><Welcome busy={busy} notice={notice} onCreate={createProject} onOpen={openProject} onRestore={restoreBackup} /></div>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="platform-back compiler-topbar-back" onClick={onBack}>← 书库</button><button className="button ghost" disabled={!project.activeRevisionId || busy} onClick={() => onRead(project.id)}>进入沉浸阅读</button>
        <div className="brand-mark">世</div>
        <div className="brand-copy">
          <strong>小说世界编译器</strong>
          <span>{project.name}</span>
        </div>
        <div className="topbar-actions">
          <button className="button ghost" onClick={openProject} disabled={busy}>打开其他工程</button>
          <button className="button ghost" onClick={() => void restoreBackup()} disabled={busy}>恢复备份</button>
          <button className="button ghost" onClick={() => void run(() => window.novelCompiler.createBackup(), '工程备份已生成')} disabled={busy}>导出备份</button>
          <button className="button primary" onClick={chooseImport} disabled={busy}>导入 TXT</button>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <nav aria-label="编译器导航">
            <p className="nav-section">开始</p>
            <NavButton active={view === 'overview'} label="工程总览" icon="◫" onClick={() => setView('overview')} />
            <NavButton active={view === 'foundation-workflow'} label="一键生成" icon="启" onClick={() => setView('foundation-workflow')} disabled={!project.activeRevisionId} />
            <p className="nav-section">原文</p>
            <NavButton active={view === 'chapters'} label="章节与段落" icon="章" onClick={() => setView('chapters')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'chunks'} label="分析分块" icon="▦" onClick={() => setView('chunks')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'search'} label="原文检索" icon="⌕" onClick={() => setView('search')} disabled={!project.activeRevisionId} />
            <p className="nav-section">人物与故事</p>
            <NavButton active={view === 'characters'} label="人物普查" icon="人" onClick={() => setView('characters')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'quotes'} label="对白归属" icon="曰" onClick={() => setView('quotes')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'fact-review'} label="事实整理" icon="理" onClick={() => setView('fact-review')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'timeline'} label="故事时间" icon="时" onClick={() => setView('timeline')} disabled={!project.activeRevisionId} />
            <p className="nav-section">世界与关系</p>
            <NavButton active={view === 'places'} label="地点审核" icon="地" onClick={() => setView('places')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'narrative-map'} label="叙事地图" icon="图" onClick={() => setView('narrative-map')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'relationships'} label="人物关系" icon="系" onClick={() => setView('relationships')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'relationship-graph'} label="关系图谱" icon="网" onClick={() => setView('relationship-graph')} disabled={!project.activeRevisionId} />
            <p className="nav-section">整理与输出</p>
            <NavButton active={view === 'refinement'} label="统一精修" icon="修" onClick={() => setView('refinement')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'artifact-foundation'} label="基础稿生成" icon="稿" onClick={() => setView('artifact-foundation')} disabled={!project.activeRevisionId} />
            <NavButton active={view === 'character-cards'} label="角色卡制作" icon="卡" onClick={() => setView('character-cards')} disabled={!project.activeRevisionId} />
            <p className="nav-section">管理</p>
            <NavButton active={view === 'jobs'} label="任务中心" icon="↻" onClick={() => setView('jobs')} />
            <NavButton active={view === 'diagnostics'} label="工程诊断" icon="检" onClick={() => setView('diagnostics')} />
            <NavButton active={view === 'settings'} label="API 设置" icon="⚙" onClick={() => setView('settings')} />
          </nav>
          <div className="phase-card">
            <span>你的世界底稿</span>
            <strong>{project.name}</strong>
            <p>每一条事实，都能回到故事发生的地方。</p>
          </div>
        </aside>
        <main className="content">
          {notice && <div className={`notice ${notice.tone}`}>{notice.text}<button onClick={() => setNotice(null)}>×</button></div>}
           {view === 'overview' && <Overview project={project} chapters={chapters} chunks={chunks} jobs={jobs} onImport={chooseImport} onOpenWorkflow={() => setView('foundation-workflow')} onOpenRefinement={() => setView('refinement')} profile={foundationProfile} onProfileChange={setFoundationProfile} />}
          {view === 'chapters' && <ChaptersView chapters={chapters} onChanged={(value) => setChapters(value)} run={run} />}
          {view === 'chunks' && <ChunksView chunks={chunks} onChanged={setChunks} run={run} />}
           {view === 'foundation-workflow' && <FoundationWorkflowView run={run} profile={foundationProfile} onProfileChange={setFoundationProfile} />}
          {view === 'refinement' && <RefinementWorkbench run={run} onNavigate={setView} />}
          {view === 'artifact-foundation' && <ArtifactFoundationWorkbench run={run} onNavigate={setView} onRead={() => onRead(project.id)} />}
          {view === 'characters' && <CharactersView chunks={chunks} jobs={jobs} run={run} />}
          {view === 'quotes' && <QuotesView run={run} />}
          {view === 'fact-review' && <FactReviewView run={run} />}
          {view === 'timeline' && <TimelineView run={run} jobs={jobs} />}
          {view === 'places' && <PlacesWorkbench run={run} jobs={jobs} />}
          {view === 'narrative-map' && <Suspense fallback={<section className="graph-loading panel">正在装载叙事地图引擎…</section>}><NarrativeMapView /></Suspense>}
          {view === 'relationships' && <RelationshipWorkbench run={run} jobs={jobs} />}
          {view === 'relationship-graph' && <Suspense fallback={<section className="graph-loading panel">正在装载关系图谱引擎…</section>}><RelationshipGraphView /></Suspense>}
          {view === 'character-cards' && <CharacterCardsView run={run} />}
          {view === 'search' && <SearchView run={run} />}
           {view === 'jobs' && <JobsView jobs={jobs} onChanged={setJobs} run={run} />}
           {view === 'diagnostics' && <DiagnosticsView run={run} />}
           {view === 'settings' && <SettingsView run={run} />}
        </main>
      </div>
      {busy && <div className="busy-indicator"><span />正在处理，请稍候…</div>}
      {importPreview && <ImportDialog preview={importPreview} onCancel={() => setImportPreview(null)} onConfirm={confirmImport} busy={busy} />}
    </div>
  );
}

function Welcome({ busy, notice, onCreate, onOpen, onRestore }: {
  busy: boolean;
  notice: { tone: 'ok' | 'error'; text: string } | null;
  onCreate: (name: string) => Promise<void>;
  onOpen: () => Promise<void>;
  onRestore: () => Promise<void>;
}) {
  const [name, setName] = useState('我的小说世界');
  return (
    <main className="welcome">
      <div className="welcome-emblem">世</div>
      <p className="eyebrow">NOVEL WORLD COMPILER</p>
      <h1>把一本小说，整理成<br /><em>可以进入的世界</em></h1>
      <p className="welcome-intro">阶段 0 会先保留原文、识别编码、整理章节，并建立后续人物、时间线和地图共同使用的证据底座。</p>
      <div className="welcome-card">
        <label>新工程名称</label>
        <div className="create-row">
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} />
          <button className="button primary" disabled={busy || !name.trim()} onClick={() => void onCreate(name)}>新建工程</button>
        </div>
        <div className="divider"><span>或者</span></div>
        <button className="button ghost wide" disabled={busy} onClick={() => void onOpen()}>打开已有工程</button>
        <button className="button ghost wide" disabled={busy} onClick={() => void onRestore()}>从 .novelproj 恢复</button>
      </div>
      {notice && <div className={`notice floating ${notice.tone}`}>{notice.text}</div>}
      <p className="privacy-note">本地优先 · 原文不会自行上传 · API 密钥由 Windows 安全存储保护</p>
    </main>
  );
}

function NavButton({ active, label, icon, onClick, disabled }: { active: boolean; label: string; icon: string; onClick: () => void; disabled?: boolean }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled}><span>{icon}</span>{label}</button>;
}

function PageTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <div className="page-title"><p>{eyebrow}</p><h2>{title}</h2><span>{description}</span></div>;
}

function Overview({ project, chapters, chunks, jobs, onImport, onOpenWorkflow, onOpenRefinement, profile, onProfileChange }: {
  project: ProjectSummary; chapters: ChapterRecord[]; chunks: ChunkRecord[]; jobs: JobRecord[]; onImport: () => void; onOpenWorkflow: () => void; onOpenRefinement: () => void;
  profile: 'low' | 'medium' | 'high'; onProfileChange: (profile: 'low' | 'medium' | 'high') => void;
}) {
  const characters = chapters.reduce((sum, chapter) => sum + chapter.characterCount, 0);
  const latest = jobs[0];
  return (
    <section>
      <PageTitle eyebrow="PROJECT OVERVIEW" title="工程总览" description="原文只负责忠实保存；所有整理结果都可以重做，不会改写小说本体。" />
      {!project.activeRevisionId ? (
        <div className="empty-hero">
          <div className="book-figure"><i /><i /><i /></div>
          <h3>工程已经准备好了</h3>
          <p>选择一本 TXT 小说。导入前会展示编码判断和正文预览，由你确认后才会建立工程底稿。</p>
          <button className="button primary" onClick={onImport}>选择 TXT 小说</button>
        </div>
      ) : (
        <>
          <div className="metric-grid">
            <Metric label="结构章节" value={chapters.length.toLocaleString()} note="可人工拆分、合并、改名" />
            <Metric label="正文字符" value={characters.toLocaleString()} note="不含已排除段落" />
            <Metric label="当前分块" value={chunks.length.toLocaleString()} note={chunks.length ? '已可供后续分析使用' : '尚未生成分析分块'} />
            <Metric label="最近任务" value={latest?.state === 'completed' ? '已完成' : latest?.state ?? '—'} note={latest?.message ?? '暂无任务'} />
          </div>
          <div className="panel source-panel">
            <div><span className="status-dot" /><div><strong>当前原文修订已锁定</strong><p>{project.activeRevisionId}</p></div></div>
            <p>章节编辑和段落排除只改变结构层，不会修改规范化原文和原始 TXT。</p>
          </div>
          <div className="panel foundation-launch">
            <div><span>AUTO FOUNDATION / BATCH 4</span><h3>让程序先跑出一个可审核的基础版本</h3><p>十一阶段已贯通人物、事实、对白、时间、事件、地点与关系草稿；所有结论仍保留人工闸门。</p></div>
             <div className="foundation-launch-actions"><button className="button ghost" onClick={onOpenRefinement}>打开统一精修</button><label>整书分析档位<select aria-label="整书分析档位" value={profile} onChange={event => onProfileChange(event.target.value as 'low' | 'medium' | 'high')}><option value="low">低 · 快速草稿</option><option value="medium">中 · 均衡生成</option><option value="high">高 · 深度生成</option></select></label><button className="button primary" onClick={onOpenWorkflow}>打开一键生成</button></div>
          </div>
          <div className="next-grid">
            <article><span>01</span><h3>检查章节边界</h3><p>快速浏览自动识别结果，必要时拆分或合并。</p></article>
            <article><span>02</span><h3>生成分析分块</h3><p>为后续人物、关系、时间与地点抽取准备上下文。</p></article>
            <article><span>03</span><h3>验证原文证据</h3><p>用全文检索确认段落定位和中文内容是否正确。</p></article>
          </div>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="metric"><span>{label}</span><strong>{value}</strong><p>{note}</p></article>;
}

type RunHelper = <T>(operation: () => Promise<T>, success?: string) => Promise<T | null>;

function usePreferredModel(fallback = '') {
  const [model, setModel] = useState(fallback);
  useEffect(() => {
    void window.novelCompiler.getApiStatus()
      .then((status) => { if (status.preferredModel) setModel(status.preferredModel); })
      .catch(() => undefined);
  }, []);
  return [model, setModel] as const;
}

function ChaptersView({ chapters, onChanged, run }: { chapters: ChapterRecord[]; onChanged: (value: ChapterRecord[]) => void; run: RunHelper }) {
  const [selected, setSelected] = useState(chapters[0]?.id ?? '');
  const [paragraphs, setParagraphs] = useState<ParagraphRecord[]>([]);
  const active = chapters.find((chapter) => chapter.id === selected) ?? chapters[0];
  useEffect(() => {
    if (!active) return;
    setSelected(active.id);
    void run(() => window.novelCompiler.listParagraphs(active.id)).then((value) => value && setParagraphs(value));
  }, [active?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function rename(chapter: ChapterRecord) {
    const title = window.prompt('新的章节标题', chapter.title);
    if (!title || title === chapter.title) return;
    const value = await run(() => window.novelCompiler.renameChapter(chapter.id, title), '章节标题已更新');
    if (value) onChanged(value);
  }
  async function split(chapter: ChapterRecord) {
    const raw = window.prompt(`输入拆分起点的段落序号（${chapter.paragraphStart + 1}–${chapter.paragraphEnd}）`);
    if (!raw) return;
    const ordinal = Number(raw);
    const title = window.prompt('新章节标题', `拆分章节 ${chapter.ordinal + 1}`) ?? '';
    const value = await run(() => window.novelCompiler.splitChapter(chapter.id, ordinal, title), '章节已拆分');
    if (value) onChanged(value);
  }
  async function merge(chapter: ChapterRecord) {
    if (!window.confirm(`把“${chapter.title}”与下一章合并？原文不会改变。`)) return;
    const value = await run(() => window.novelCompiler.mergeChapterWithNext(chapter.id), '章节已合并');
    if (value) onChanged(value);
  }
  return (
    <section>
      <PageTitle eyebrow="STRUCTURE REVIEW" title="章节与段落" description="自动识别只是初稿。人工修订会记录谱系，但不会触碰规范化原文。" />
      <div className="split-layout">
        <div className="chapter-list panel">
          <div className="panel-heading"><strong>{chapters.length} 个章节</strong><span>按原文顺序</span></div>
          {chapters.map((chapter) => <button key={chapter.id} className={active?.id === chapter.id ? 'selected' : ''} onClick={() => setSelected(chapter.id)}>
            <span>{String(chapter.ordinal).padStart(3, '0')}</span><div><strong>{chapter.title}</strong><small>{chapter.characterCount.toLocaleString()} 字 · 段 {chapter.paragraphStart}–{chapter.paragraphEnd}</small></div>
          </button>)}
        </div>
        <div className="reader panel">
          {active && <>
            <div className="reader-heading"><div><span>第 {active.ordinal} 节</span><h3>{active.title}</h3></div><div>
              <button onClick={() => void rename(active)}>改名</button><button onClick={() => void split(active)}>拆分</button><button onClick={() => void merge(active)}>与下一章合并</button>
            </div></div>
            <div className="paragraphs">
              {paragraphs.map((paragraph) => <article key={paragraph.id} className={paragraph.excluded ? 'excluded' : ''}>
                <span>{paragraph.ordinal}</span><p>{paragraph.text}</p><button title={paragraph.excluded ? '恢复此段' : '不参与后续分析'} onClick={() => void run(async () => {
                  await window.novelCompiler.setParagraphExcluded(paragraph.id, !paragraph.excluded);
                  const next = await window.novelCompiler.listParagraphs(active.id);
                  setParagraphs(next);
                  return next;
                }, paragraph.excluded ? '段落已恢复' : '段落已从后续分析中排除')}>{paragraph.excluded ? '恢复' : '排除'}</button>
              </article>)}
            </div>
          </>}
        </div>
      </div>
    </section>
  );
}

const chunkBoundaryLabels: Record<ChunkRecord['boundaryReason'], string> = {
  document_end: '文末',
  chapter: '章节边界',
  scene: '场景分隔',
  blank_line: '空行边界',
  soft_limit: '软上限',
  target: '目标长度',
  oversized_paragraph: '单段超限',
  legacy: '旧版分块',
};

function ChunksView({ chunks, onChanged, run }: { chunks: ChunkRecord[]; onChanged: (value: ChunkRecord[]) => void; run: RunHelper }) {
  const [settings, setSettings] = useState(defaultChunkSettings);
  useEffect(() => { void run(() => window.novelCompiler.getApiStatus()).then(status => { if (status?.requestSettings) setSettings(status.requestSettings.inputChunks); }); }, []);
  const [inspection, setInspection] = useState<ChunkInspection | null>(null);
  function update(key: keyof ChunkSettings, value: string) { setSettings((current) => ({ ...current, [key]: Number(value) })); }
  async function build() {
    const value = await run(() => window.novelCompiler.buildChunks(settings), '新的分块方案已经生成');
    if (value) {
      setInspection(null);
      onChanged(value);
    }
  }
  async function inspect(chunk: ChunkRecord) {
    const value = await run(() => window.novelCompiler.inspectChunk(chunk.id));
    if (!value) return;
    setInspection(value);
    window.requestAnimationFrame(() => document.getElementById('chunk-source-reader')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
  return <section>
    <PageTitle eyebrow="ANALYSIS CHUNKS" title="分析分块" description="分块只引用段落，不复制或改写原文；每次调整都会生成一个新版本。" />
    <div className="chunk-controls panel">
      <NumberField label="核心目标" value={settings.coreChars} onChange={(value) => update('coreChars', value)} />
      <NumberField label="软上限" value={settings.softLimit} onChange={(value) => update('softLimit', value)} />
      <NumberField label="硬上限" value={settings.hardLimit} onChange={(value) => update('hardLimit', value)} />
      <NumberField label="前文重叠" value={settings.overlapBefore} onChange={(value) => update('overlapBefore', value)} />
      <NumberField label="后文重叠" value={settings.overlapAfter} onChange={(value) => update('overlapAfter', value)} />
      <button className="button primary" onClick={() => void build()}>生成新方案</button>
    </div>
    {chunks.length === 0 ? <div className="simple-empty">尚未生成分块。默认参数适合第一轮人物与事件识别。</div> : <div className="chunk-review-layout">
      <div className="chunk-table panel">
        <div className="table-row header"><span>分块</span><span>核心段落</span><span>上下文段落</span><span>核心 / 含上下文</span></div>
        <div className="chunk-table-body">{chunks.map((chunk) => <button
          type="button"
          aria-label={`查看分块 #${chunk.ordinal} 原文`}
          className={`table-row ${inspection?.chunk.id === chunk.id ? 'selected' : ''}`}
          key={chunk.id}
          onClick={() => void inspect(chunk)}
        ><span>#{String(chunk.ordinal).padStart(3, '0')}</span><span>{chunk.coreStartOrdinal}–{chunk.coreEndOrdinal}</span><span>{chunk.contextStartOrdinal}–{chunk.contextEndOrdinal}</span><span>{chunk.coreCharacterCount.toLocaleString()} / {chunk.contextCharacterCount.toLocaleString()}<small>{chunk.oversized ? '⚠ 单个自然段超过硬上限' : chunkBoundaryLabels[chunk.boundaryReason]}</small></span></button>)}</div>
      </div>
      <div className="chunk-source-reader panel" id="chunk-source-reader">
        {!inspection ? <div className="chunk-reader-empty"><span>CHUNK SOURCE</span><strong>选择左侧分块查看原文</strong><p>前文、核心与后文会按实际 `chunk_members` 角色显示，不重新推算范围。</p></div> : <>
          <header>
            <div><span>CHUNK #{String(inspection.chunk.ordinal).padStart(3, '0')}</span><h3>原文范围 {inspection.chunk.contextStartOrdinal}–{inspection.chunk.contextEndOrdinal}</h3><p>核心 {inspection.chunk.coreStartOrdinal}–{inspection.chunk.coreEndOrdinal} · {chunkBoundaryLabels[inspection.chunk.boundaryReason]}</p></div>
            <div className="chunk-role-legend"><span className="context-before">前文</span><span className="core">核心</span><span className="context-after">后文</span></div>
          </header>
          <div className="chunk-source-paragraphs">
            {inspection.paragraphs.map((paragraph) => <article
              key={paragraph.id}
              className={`chunk-source-paragraph ${paragraph.role}`}
              data-paragraph-ordinal={paragraph.ordinal}
            >
              <aside><span>{paragraph.ordinal}</span><small>{paragraph.role === 'core' ? '核心' : paragraph.role === 'context_before' ? '前文' : '后文'}</small></aside>
              <div><small>{paragraph.chapterTitle ?? '未分章'}</small><p>{paragraph.text}</p></div>
            </article>)}
          </div>
        </>}
      </div>
    </div>}
  </section>;
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return <label className="number-field"><span>{label}</span><input type="number" min="0" step="100" value={value} onChange={(event) => onChange(event.target.value)} /><small>字符</small></label>;
}

const foundationStepLabels: Record<FoundationWorkflowStepKey, { index: string; title: string; note: string }> = {
  preflight: { index: '01', title: '工程预检', note: '数据库、全文索引与原文来源' },
  chunks: { index: '02', title: '准备分块', note: '优先复用当前方案，没有才自动生成' },
  character_scan: { index: '03', title: '人物普查', note: '调用当前 API 生成待审核人物候选' },
  draft_selection: { index: '04', title: '自动草稿选择', note: '选择后续分析对象，但不冒充人工确认' },
  character_facts: { index: '05', title: '人物事实草稿', note: '仅对草稿集合提取，事实全部保持待审核' },
  dialogue_scan: { index: '06', title: '对白草稿', note: '仅关联草稿集合，明确说话线索也不自动确认' },
  time_expressions: { index: '07', title: '时间表达式草稿', note: '本地规则识别，新增表达式保持待审核' },
  event_drafts: { index: '08', title: '事件草稿', note: '只把草稿集合人物交给事件抽取器' },
  place_drafts: { index: '09', title: '地点草稿', note: '只消费本次事件草稿中的地点证据' },
  relationship_drafts: { index: '10', title: '关系草稿', note: '仅在草稿集合内生成待审核关系候选' },
  summary: { index: '11', title: '整理结果', note: '汇总人物、事实、对白与世界草稿结果' },
};

type FoundationSelectionOutput = {
  selectedCount?: number;
  selectedCharacters?: Array<{ identityId: string; identityName: string; reason: string | null }>;
};

function parseFoundationSelectionOutput(value: string | null): FoundationSelectionOutput | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as FoundationSelectionOutput;
    return Array.isArray(parsed.selectedCharacters) ? parsed : null;
  } catch {
    return null;
  }
}

const foundationStateLabels: Record<FoundationWorkflowRunRecord['state'], string> = {
  queued: '等待恢复',
  running: '正在运行',
  paused: '已暂停',
  completed: '已完成',
  failed: '出现错误',
  cancelled: '已取消',
};

function FoundationWorkflowView({ run, profile, onProfileChange }: { run: RunHelper; profile: 'low' | 'medium' | 'high'; onProfileChange: (profile: 'low' | 'medium' | 'high') => void }) {
  const [workflows, setWorkflows] = useState<FoundationWorkflowRunRecord[]>([]);
  const [usage, setUsage] = useState<FoundationUsageSummary | null>(null);
  const [model, setModel] = useState('');
  const [tokenBudgetInput, setTokenBudgetInput] = useState('');
  const [apiConfigured, setApiConfigured] = useState(false);

  const load = useCallback(async () => {
    const [status, records] = await Promise.all([
      window.novelCompiler.getApiStatus(),
      window.novelCompiler.listFoundationWorkflows(),
    ]);
    setApiConfigured(status.configured);
    setModel((current) => current || status.preferredModel || '');
    setWorkflows(records);
    setUsage(records[0] ? await window.novelCompiler.getFoundationUsage(records[0].id) : null);
  }, []);

  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const latest = workflows[0] ?? null;
  useEffect(() => { setTokenBudgetInput(latest?.tokenBudget?.toString() ?? ''); }, [latest?.id]);
  const budgetReached = Boolean(latest?.tokenBudget && usage
    && usage.inputTokens + usage.outputTokens >= Math.ceil(latest.tokenBudget * 0.95));
  useEffect(() => {
    if (!latest || !['running', 'queued'].includes(latest.state)) return;
    const timer = window.setInterval(() => void load().catch(() => undefined), 1000);
    return () => window.clearInterval(timer);
  }, [latest?.id, latest?.state, load]);

  async function start() {
    const value = await run(
      () => window.novelCompiler.startFoundationWorkflow({ model: model.trim(), profile,
        tokenBudget: tokenBudgetInput.trim() ? Number(tokenBudgetInput) : null }),
      '一键基础流程已经启动',
    );
    if (value) await load();
  }

  async function control(action: FoundationWorkflowControlAction) {
    if (!latest) return;
    const value = await run(
      () => window.novelCompiler.controlFoundationWorkflow(latest.id, action),
      action === 'pause' ? '流程已暂停' : action === 'cancel' ? '流程已取消' : '流程已经继续',
    );
    if (value) await load();
  }

  async function updateBudgetAndResume() {
    if (!latest) return;
    const updated = await run(() => window.novelCompiler.updateFoundationTokenBudget(latest.id,
      tokenBudgetInput.trim() ? Number(tokenBudgetInput) : null));
    if (updated) await control('resume');
  }

  return <section className="foundation-workflow-view">
    <PageTitle eyebrow="ONE-CLICK WORLD BUILD" title="一键生成完整世界" description="从原文自动完成人物、事实、对白、时间、事件、地点与关系定稿，并立即生成地图、关系图和角色卡；之后仍可逐项修改。" />
    <div className="foundation-workflow-console panel">
      <header>
        <div><span>BATCH 4 / WORLD DRAFTS</span><h3>{latest ? foundationStateLabels[latest.state] : '尚未运行'}</h3><p>{latest?.message ?? '选择模型后，点一次即可完成预检、分块、人物普查、草稿选择，以及人物事实、对白、时间、事件、地点、关系草稿与汇总。'}</p></div>
        <strong>{latest ? `${Math.round(latest.progress * 100)}%` : '0%'}</strong>
      </header>
      <div className="foundation-progress"><i style={{ width: `${Math.round((latest?.progress ?? 0) * 100)}%` }} /></div>
      <div className="foundation-controls">
        <label><span>人物普查模型 ID（区分大小写）</span><input value={model} onChange={(event) => setModel(event.target.value)} placeholder="读取 API 设置中的首选模型" /></label>
         <label><span>整书分析档位</span><select value={profile} onChange={(event) => onProfileChange(event.target.value as 'low' | 'medium' | 'high')}>
          <option value="low">低 · 快速草稿</option><option value="medium">中 · 均衡生成</option><option value="high">高 · 深度生成</option>
        </select></label>
         <label><span>本次 Token 上限（可选）</span><input type="number" min={1000} max={1000000000} step={1000} value={tokenBudgetInput} onChange={event => setTokenBudgetInput(event.target.value)} placeholder="留空表示不限" /></label>
        {!latest || ['completed', 'cancelled'].includes(latest.state)
          ? <button className="button primary" disabled={!apiConfigured || !model.trim()} onClick={() => void start()}>一键开始</button>
          : <>
            {latest.state === 'running' && <button className="button ghost" onClick={() => void control('pause')}>暂停</button>}
             {['paused', 'queued'].includes(latest.state) && (budgetReached
               ? <button className="button primary" onClick={() => void updateBudgetAndResume()}>更新上限并继续</button>
               : <button className="button primary" onClick={() => void control('resume')}>继续</button>)}
            {latest.state === 'failed' && <button className="button primary" onClick={() => void control('retry')}>从失败处重试</button>}
            {['running', 'paused', 'queued'].includes(latest.state) && <button className="button ghost danger" onClick={() => void control('cancel')}>取消本次</button>}
          </>}
      </div>
      <p>低档：全书人物和事件扫描，人物事实按全书均匀抽取最多 800 个直接提及段落，不带邻段；可能漏掉细节。中档：全书扫描，人物事实仅为短段补邻段。高档：保留完整邻段，并增加第二轮事实补漏。三档结果都需检查证据，Token 实际用量以模型响应为准。</p>
      {latest && <small>本次已报告用量：输入 {usage?.inputTokens.toLocaleString() ?? '—'}、输出 {usage?.outputTokens.toLocaleString() ?? '—'} Token；HTTP 请求 {usage?.attempts ?? '—'} 次，本地结果复用 {usage?.localCacheHits ?? '—'} 次，其中异常／重试 {usage?.failedAttempts ?? '—'} 次、未报告用量 {usage?.unreportedAttempts ?? '—'} 次。{usage && usage.cacheHitTokens + usage.cacheMissTokens > 0 ? `网关报告的前缀缓存命中 ${usage.cacheHitTokens.toLocaleString()}、未命中 ${usage.cacheMissTokens.toLocaleString()} Token；具体折扣以网关账单为准。` : '网关前缀缓存用量未确认。'}{latest.tokenBudget ? `本次上限 ${latest.tokenBudget.toLocaleString()} Token，接近时自动暂停；在途请求可能略超。` : '本次未设置 Token 上限。'}</small>}
      {usage && Object.keys(usage.stages).length > 0 && <details className="foundation-usage-stages">
        <summary>按阶段查看 Token 用量</summary>
        {Object.entries(usage.stages).map(([stage, item]) => <p key={stage}>
          <strong>{foundationStepLabels[stage as FoundationWorkflowStepKey]?.title ?? stage}</strong>：输入 {item.inputTokens.toLocaleString()}、输出 {item.outputTokens.toLocaleString()} Token；请求 {item.attempts} 次，结果复用 {item.localCacheHits} 次，异常／重试 {item.failedAttempts} 次，未报告用量 {item.unreportedAttempts} 次{item.cacheHitTokens + item.cacheMissTokens > 0 ? `；网关前缀缓存命中 ${item.cacheHitTokens.toLocaleString()}／未命中 ${item.cacheMissTokens.toLocaleString()} Token` : ''}
        </p>)}
      </details>}
      {latest && <small>当前流程档位：{(latest.profile === 'low' ? '低' : latest.profile === 'medium' ? '中' : latest.profile === 'high' ? '高' : latest.profile === 'foundation-v1' ? '旧版' : latest.profile)}</small>}
      {!apiConfigured && <div className="foundation-warning">还没有可用的 API 设置。请先到左侧“API 设置”保存并测试连接。</div>}
    </div>
    <div className="foundation-boundary">
      <b>自动定稿</b><span>证据与置信度裁决</span><i>→</i><span>成品可用，后续可改</span>
      <p>系统只自动处理尚未裁决的记录：高置信结论确认，低置信或冲突结论排除，来源和置信度全部保留。你之后的确认、排除、编辑和角色卡修改不会在重跑时被覆盖。</p>
    </div>
    <div className="foundation-step-list">
      {(latest?.steps ?? (Object.keys(foundationStepLabels) as FoundationWorkflowStepKey[]).map((stepKey, ordinal) => ({
        stepKey, ordinal, state: 'pending' as const, progress: 0, message: '等待开始', childJobId: null, outputJson: null,
        error: null, startedAt: null, finishedAt: null, updatedAt: '',
      }))).map((step) => {
        const copy = foundationStepLabels[step.stepKey];
        const selectionOutput = step.stepKey === 'draft_selection' ? parseFoundationSelectionOutput(step.outputJson) : null;
        return <article className={`panel foundation-step ${step.state}`} key={step.stepKey}>
          <span>{copy.index}</span>
          <div><h3>{copy.title}</h3><small>{copy.note}</small><p>{step.message}</p>{step.error && <em>{step.error}</em>}
            {selectionOutput && <details><summary>查看 {selectionOutput.selectedCount ?? selectionOutput.selectedCharacters?.length ?? 0} 人的选择理由</summary>
              {selectionOutput.selectedCharacters?.map((item) => <p key={item.identityId}><strong>{item.identityName}</strong>：{item.reason}</p>)}
            </details>}
          </div>
          <strong>{step.state === 'completed' || step.state === 'skipped' ? '完成' : step.state === 'running' ? `${Math.round(step.progress * 100)}%` : step.state === 'failed' ? '失败' : step.state === 'paused' ? '暂停' : '等待'}</strong>
        </article>;
      })}
    </div>
    {workflows.length > 1 && <details className="foundation-history panel">
      <summary>查看最近运行记录（{workflows.length}）</summary>
      {workflows.slice(1, 6).map((item) => <div key={item.id}><span>{new Date(item.updatedAt).toLocaleString()}</span><strong>{foundationStateLabels[item.state]}</strong><small>{item.message}</small></div>)}
    </details>}
  </section>;
}

const artifactGateStatusLabels: Record<ArtifactFoundationGate['status'], string> = {
  blocked: '存在阻断', missing: '等待生成', 'needs-review': '等待精修', ready: '基础稿就绪',
};

function ArtifactFoundationGateCard({ gate, index, onNavigate }: {
  gate: ArtifactFoundationGate; index: number; onNavigate: (view: View) => void;
}) {
  const descriptions: Record<ArtifactFoundationGate['kind'], string> = {
    'character-cards': '每个人物单独成卡，进入游玩时再按需取用。',
    'relationship-graph': '按人物和故事时间查看关系，不把所有连线挤在一起。',
    'narrative-map': '查看地点与空间关系；证据不足的位置保持示意。',
  };
  const leadingIssue = gate.issues.find(issue => issue.severity === 'blocker') ?? gate.issues[0];
  return <article className={`artifact-gate-card ${gate.kind} ${gate.status}`}>
    <header><span>0{index + 1}</span><div><small>{gate.kind.replaceAll('-', ' / ')}</small><h3>{gate.title}</h3></div><strong>{artifactGateStatusLabels[gate.status]}</strong></header>
    <p className="artifact-outcome-description">{descriptions[gate.kind]}</p>
    <div className="artifact-outcome-metrics">{gate.metrics.slice(0, 2).map(metric => <span key={metric.label}>{metric.label}<b>{metric.value.toLocaleString()}</b></span>)}</div>
    <p className="artifact-outcome-note">{leadingIssue ? leadingIssue.message : '基础资料已就绪，可随时查看和调整。'}</p>
    <footer><span>{gate.exportReady ? '可导出' : gate.foundationReady ? '基础稿完成' : '等待处理'}</span><button className="button ghost" onClick={() => onNavigate(gate.targetView)}>查看与导出 ↗</button></footer>
  </article>;
}

function ArtifactFoundationWorkbench({ run, onNavigate, onRead }: { run: RunHelper; onNavigate: (view: View) => void; onRead: () => void }) {
  const [events, setEvents] = useState<TimelineEventRecord[]>([]);
  const [entryEventId, setEntryEventId] = useState('');
  const [dashboard, setDashboard] = useState<ArtifactFoundationDashboard | null>(null);
  const [generation, setGeneration] = useState<ArtifactFoundationGenerationResult | null>(null);
  const [bundleExport, setBundleExport] = useState<PlayableBundleExportResult | null>(null);
  const [bundleValidation, setBundleValidation] = useState<PlayableBundleValidationReport | null>(null);
  const [showWorldBook, setShowWorldBook] = useState(false);
  const [worldBookExport, setWorldBookExport] = useState('');
  const [loadError, setLoadError] = useState('');

  const refresh = useCallback(async (eventId?: string) => {
    setLoadError('');
    try {
      setDashboard(await window.novelCompiler.getArtifactFoundationStatus(eventId || undefined));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void window.novelCompiler.listTimelineEvents().then(async (records) => {
      const confirmed = records.filter((event) => event.reviewStatus === 'confirmed');
      setEvents(confirmed);
      const cards = await window.novelCompiler.getCharacterCardBatchStatus();
      const preserved = [...new Set(cards.filter(card => card.hasDraft && card.entryEventId).map(card => card.entryEventId))];
      const defaultEvent = preserved.length === 1 && confirmed.some(event => event.id === preserved[0])
        ? preserved[0]! : preserved.length > 1 ? '' : confirmed[0]?.id ?? '';
      setEntryEventId(defaultEvent);
      await refresh(defaultEvent);
    }).catch((error) => setLoadError(errorMessage(error)));
  }, [refresh]);

  async function selectEntry(eventId: string) {
    setEntryEventId(eventId); setGeneration(null); setBundleExport(null); setBundleValidation(null); setWorldBookExport('');
    await refresh(eventId);
  }

  async function generate() {
    if (!entryEventId) return;
    const value = await run(() => window.novelCompiler.generateArtifactFoundation(entryEventId),
      '三类基础稿已经按当前进入点生成；已有角色卡未被覆盖');
    if (value) { setGeneration(value); setDashboard(value.dashboard); }
  }

  async function exportPlayableBundle() {
    if (!entryEventId) return;
    const value = await run(() => window.novelCompiler.exportPlayableBundle(entryEventId),
      '可游玩整合包已经按当前进入点导出');
    if (value) setBundleExport(value);
  }

  async function validatePlayableBundle() {
    const value = await run(() => window.novelCompiler.validatePlayableBundle(), '整合包只读校验已经完成');
    if (value) setBundleValidation(value);
  }

  const bundleReady = Boolean(entryEventId && dashboard?.refinementReady
    && dashboard.gates.length === 3 && dashboard.gates.every((gate) => gate.exportReady));

  return <section className="artifact-foundation-workbench">
    <PageTitle eyebrow="FOUR WORLD ARTIFACTS" title="四类游玩成果" description="人物角色卡、人物关系图、世界地图和独立世界书各自保存；按需查看或导出，不必重新分析原文。" />
    <div className="artifact-proof-console panel">
      <div className="artifact-proof-mark"><span>WORLD ASSETS</span><strong>四类成果</strong><small>{dashboard?.policyVersion ?? 'artifact-foundation.v1'}</small></div>
      <label><span>统一防剧透进入事件</span><select value={entryEventId} onChange={(event) => void selectEntry(event.target.value)}><option value="">请选择已确认事件</option>{events.map((event) => <option value={event.id} key={event.id}>段落 {event.narrativeStartOrdinal} · {event.title}</option>)}</select><small>角色卡状态、关系揭示和地点揭示都以此事件的段落序号为界。</small></label>
      <div className="artifact-proof-actions">{dashboard && !dashboard.refinementReady && <button className="button ghost" onClick={() => onNavigate('refinement')}>返回统一精修</button>}<button className="button ghost" onClick={() => void validatePlayableBundle()}>校验已有整合包</button><button className="button ghost" disabled={!bundleReady} onClick={() => void exportPlayableBundle()}>导出可游玩整合包</button><button className="button primary" disabled={!dashboard?.canGenerate || !entryEventId} onClick={() => void generate()}>生成可安全生成部分</button></div>
    </div>
    {loadError && <div className="artifact-load-error panel"><span>{loadError}</span><button className="button ghost" onClick={() => void refresh(entryEventId)}>重新加载</button></div>}
    {!events.length && !loadError && <div className="artifact-entry-empty panel"><strong>还没有已确认进入事件</strong><p>先到“故事时间”确认至少一个事件；系统不会自行选择可能造成剧透的时间点。</p><button className="button ghost" onClick={() => onNavigate('timeline')}>前往故事时间</button></div>}
    {dashboard && <>
      <div className={`artifact-readiness-line ${dashboard.refinementReady ? 'ready' : 'blocked'}`}><span>{dashboard.refinementReady ? 'REFINEMENT GATE PASSED' : 'REFINEMENT GATE BLOCKED'}</span><strong>{dashboard.entryEvent ? `${dashboard.entryEvent.title} · 段落 ${dashboard.entryEvent.narrativeOrdinal}` : '等待选择进入事件'}</strong><small>{dashboard.refinementReady ? '允许生成基础稿，但正式导出仍看下方各自产物门槛。' : '统一精修的“必须处理”清零后才允许生成。'}</small></div>
      <div className="artifact-gate-grid">{dashboard.gates.map((gate, index) => <ArtifactFoundationGateCard gate={gate} index={index} onNavigate={onNavigate} key={gate.kind} />)}
        <article className={`artifact-gate-card worldbook ${worldBookExport ? 'ready' : dashboard.entryEvent ? 'needs-review' : 'missing'}`}>
          <header><span>04</span><div><small>world / lorebook</small><h3>世界书</h3></div><strong>{worldBookExport ? '已导出' : dashboard.entryEvent ? '可导出' : '待准备'}</strong></header>
          <p className="artifact-outcome-description">世界设定独立于人物卡；进入游玩时按当前工程启用。</p>
          <div className="artifact-outcome-metrics"><span>关系与地点资料<b>{dashboard.gates.filter(gate => gate.kind !== 'character-cards' && gate.foundationReady).length} / 2</b></span></div>
          <p className="artifact-outcome-note">{worldBookExport ? `已导出：${worldBookExport}` : '可单独导出当前已揭示的关系与地点资料；完整游玩仍需通过整合包门槛。'}</p>
          <footer><span>{worldBookExport ? '独立文件已生成' : '另存为独立世界书'}</span><button className="button ghost" disabled={!dashboard.entryEvent} onClick={() => setShowWorldBook(value => !value)}>{showWorldBook ? '收起世界书' : '查看世界书'}</button><button className="button ghost" disabled={!dashboard.entryEvent} onClick={() => void run(() => window.novelCompiler.exportWorldBook(dashboard.entryEvent!.narrativeOrdinal), '独立世界书已导出').then(value => { if (value) setWorldBookExport(value.outputPath); })}>导出世界书 ↗</button></footer>
        </article>
      </div>
    </>}
    {showWorldBook && dashboard?.entryEvent && <WorldBookPreview ordinal={dashboard.entryEvent.narrativeOrdinal} onNavigate={onNavigate} />}
    {generation && <div className="artifact-generation-receipt panel"><header><div><span>GENERATION RECEIPT</span><h3>本次基础稿回执</h3></div><small>{new Date(generation.generatedAt).toLocaleString()}</small></header><div><p><strong>角色卡</strong>新生成 {generation.characterCards.generatedCount} · 保留已有 {generation.characterCards.skippedCount} · 失败 {generation.characterCards.failedCount}</p><p><strong>人物关系图</strong>{generation.relationshipGraph.nodeCount} 节点 · {generation.relationshipGraph.relationshipCount} 关系 · SHA {generation.relationshipGraph.sourceFingerprint.slice(0, 12)}…</p><p><strong>世界地图</strong>{generation.narrativeMap.nodeCount} 节点 · {generation.narrativeMap.relationCount} 空间关系 · SHA {generation.narrativeMap.sourceFingerprint.slice(0, 12)}…</p></div><footer>图谱与地图是由当前已确认数据即时重建的防剧透快照；角色卡草稿保存在工程数据库中。再次运行只补缺失卡片，不覆盖已有人工内容。</footer></div>}
    {bundleExport && <div className="artifact-generation-receipt panel"><header><div><span>PLAYABLE BUNDLE</span><h3>{bundleExport.reused ? '已复用相同整合包' : '可游玩整合包已生成'}</h3></div><small>SHA {bundleExport.bundleFingerprint.slice(0, 12)}…</small></header><div><p><strong>角色卡</strong>{bundleExport.manifest.character_count} 张，均不内嵌共享世界书</p><p><strong>独立世界书</strong>{bundleExport.manifest.character_book_entry_count} 条人物关系与地点知识</p><p><strong>文件</strong>{bundleExport.manifest.files.length + 1} 个，含清单与进入点元数据</p></div><footer><span>{bundleExport.packageDirectory}</span><button className="button primary" onClick={onRead}>进入沉浸阅读</button></footer></div>}
    {bundleValidation && <div className={`artifact-bundle-validation panel ${bundleValidation.valid ? 'valid' : 'invalid'}`}><header><div><span>BUNDLE READBACK</span><h3>{bundleValidation.valid ? '整合包完整且可导入' : '整合包存在阻断问题'}</h3></div><strong>{bundleValidation.validFileCount} / {bundleValidation.fileCount} 文件通过</strong></header><div className="artifact-validation-metrics"><p><strong>{bundleValidation.characterCount}</strong>角色卡</p><p><strong>{bundleValidation.characterBookEntryCount}</strong>世界书条目</p><p><strong>{bundleValidation.sillyTavernCompatible ? '兼容' : '不兼容'}</strong>{bundleValidation.compatibilityProfile}</p><p><strong>{bundleValidation.currentProjectMatch ? '一致' : '不同'}</strong>当前工程修订</p></div>{bundleValidation.issues.length > 0 ? <div className="artifact-validation-issues">{bundleValidation.issues.map((issue, index) => <p className={issue.severity} key={`${issue.code}:${issue.path ?? ''}:${index}`}><b>{issue.severity === 'error' ? '阻断' : '提醒'}</b><span>{issue.message}{issue.path ? ` · ${issue.path}` : ''}</span></p>)}</div> : <div className="artifact-validation-clean">清单、逐文件 SHA-256、角色卡、独立世界书与进入点交叉引用全部通过。</div>}<footer>{bundleValidation.packageDirectory}</footer></div>}
  </section>;
}
const refinementSeverityMeta: Record<RefinementSeverity, { eyebrow: string; title: string; note: string }> = {
  must: { eyebrow: 'TECHNICAL BLOCKER', title: '技术阻断', note: '只保留流程失败或工程异常等真正阻断。' },
  recommended: { eyebrow: 'RECOMMENDED', title: '建议处理', note: '不阻断基础稿，但会明显影响成品质量。' },
  later: { eyebrow: 'BACKLOG', title: '可稍后处理', note: '低信号或非核心范围，可按需要逐步整理。' },
};

function RefinementIssueCard({ issue, onNavigate }: { issue: RefinementIssue; onNavigate: (view: View) => void }) {
  return <article className={`refinement-issue ${issue.severity}`}>
    <header><div><span>{issue.kind.replaceAll('-', ' / ')}</span><h3>{issue.title}</h3></div><strong>{issue.count.toLocaleString()}</strong></header>
    <p>{issue.summary}</p>
    {issue.samples.length > 0 && <div className="refinement-samples">{issue.samples.map((sample, index) => <span key={`${issue.id}:${index}`}>{sample}</span>)}</div>}
    <footer><small>{issue.rule}</small><button className="button ghost" onClick={() => onNavigate(issue.targetView)}>{issue.targetView === 'diagnostics' ? '查看诊断' : '前往处理'}</button></footer>
  </article>;
}

function RefinementWorkbench({ run, onNavigate }: { run: RunHelper; onNavigate: (view: View) => void }) {
  const [dashboard, setDashboard] = useState<RefinementDashboard | null>(null);
  const [loadError, setLoadError] = useState('');
  const load = useCallback(async (notify = false) => {
    setLoadError('');
    if (notify) {
      const value = await run(() => window.novelCompiler.getRefinementDashboard(), '精修待办已重新计算');
      if (value) setDashboard(value);
      return;
    }
    try {
      setDashboard(await window.novelCompiler.getRefinementDashboard());
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [run]);

  useEffect(() => { void load(); }, [load]);

  if (!dashboard) return <section className="refinement-workbench"><PageTitle eyebrow="REFINEMENT DESK / TRIAGE" title="统一精修台" description={loadError || '正在按当前修订计算审核待办…'} />{loadError && <button className="button primary" onClick={() => void load()}>重新加载</button>}</section>;

  return <section className="refinement-workbench">
    <PageTitle eyebrow="QUALITY & EDITING CENTER" title="质量与修改中心" description="一键生成已经自动完成裁决。这里保留来源、置信度和质量提示，供你按需修改，不再作为成品生成的人工闸门。" />
    <div className={`refinement-readiness panel ${dashboard.readyForArtifactDrafts ? 'ready' : 'blocked'}`}>
      <div><span>{dashboard.readyForArtifactDrafts ? 'WORLD READY · OPTIONAL EDITING' : 'TECHNICAL ATTENTION REQUIRED'}</span><h3>{dashboard.readyForArtifactDrafts ? '世界数据与三类成品可以直接使用' : `还有 ${dashboard.counts.must.toLocaleString()} 项技术阻断`}</h3><p>{dashboard.readyForArtifactDrafts ? '建议项和稍后项是质量提示，你可以随时回来修改。' : '请先恢复失败或中断的一键任务。'}</p></div>
      <div className="refinement-readiness-actions">{dashboard.readyForArtifactDrafts && <button className="button ghost" onClick={() => onNavigate('artifact-foundation')}>生成三类基础稿</button>}<button className="button primary" onClick={() => void load(true)}>重新计算</button></div>
    </div>
    <div className="refinement-metrics">
      {(Object.keys(refinementSeverityMeta) as RefinementSeverity[]).map((severity) => <article key={severity} className={severity}><span>{refinementSeverityMeta[severity].title}</span><strong>{dashboard.counts[severity].toLocaleString()}</strong><small>{refinementSeverityMeta[severity].note}</small></article>)}
      <article className="policy"><span>规则版本</span><strong>{dashboard.policyVersion}</strong><small>生成于 {new Date(dashboard.generatedAt).toLocaleString()}</small></article>
    </div>
    {(Object.keys(refinementSeverityMeta) as RefinementSeverity[]).map((severity) => {
      const items = dashboard.issues.filter((issue) => issue.severity === severity);
      const meta = refinementSeverityMeta[severity];
      return <section className={`refinement-group ${severity}`} key={severity}>
        <header><div><span>{meta.eyebrow}</span><h2>{meta.title}</h2></div><p>{meta.note}</p></header>
        {items.length > 0 ? <div className="refinement-issue-grid">{items.map((issue) => <RefinementIssueCard key={issue.id} issue={issue} onNavigate={onNavigate} />)}</div>
          : <div className="refinement-empty panel">这一层当前没有待办。</div>}
      </section>;
    })}
    <div className="refinement-boundary"><strong>修改规则</strong><span>仅统计当前修订</span><span>来源与置信度保留</span><span>人工修改优先</span><span>重跑不覆盖既有裁决</span></div>
  </section>;
}
const tierLabels: Record<CharacterCandidate['importanceTier'], string> = {
  core: '核心人物', important: '重要人物', minor: '次要人物', incidental: '一次性人物', pending: '待判断',
};

const factCategoryLabels: Record<CharacterFactRecord['category'], string> = {
  identity: '身份', appearance: '外貌', personality: '性格', ability: '能力', motivation: '动机',
  background: '经历', status: '状态', secret: '秘密', speech: '语言', relationship: '关系', other: '其他',
};

const assertionModeLabels: Record<CharacterFactRecord['assertionMode'], string> = {
  narrator_assertion: '旁白断言', self_report: '人物自述', other_report: '他人陈述', rumor: '传闻',
  belief: '主观看法', behavior_inference: '行为推断',
};

const truthStatusLabels: Record<CharacterFactRecord['truthStatus'], string> = {
  asserted: '文本断言', suspected: '存疑', disputed: '存在争议', false: '已被否定', unknown: '真假未知',
};

const sourceSpanStatusLabels: Record<SourceSpanInspection['alignmentStatus'], string> = {
  exact: '逐字坐标有效',
  normalized: '仅规范化匹配',
  ambiguous: '原文中存在多个相同片段',
  invalid: '定位已经失效',
};

function SourceSpanDialog({ inspection, onClose }: { inspection: SourceSpanInspection; onClose: () => void }) {
  const canHighlight = inspection.alignmentStatus === 'exact'
    && inspection.startUtf16 !== null && inspection.endUtf16 !== null;
  return <div className="source-span-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="source-span-dialog panel" role="dialog" aria-modal="true" aria-labelledby="source-span-title">
      <header>
        <div><span>SOURCE SPAN / UTF-16</span><h3 id="source-span-title">{inspection.chapterTitle ?? '未分章'} · 段落 {inspection.paragraphOrdinal}</h3></div>
        <button type="button" onClick={onClose} aria-label="关闭原文定位">×</button>
      </header>
      <div className={`source-span-status ${inspection.alignmentStatus}`}>
        <strong>{sourceSpanStatusLabels[inspection.alignmentStatus]}</strong>
        <span>{canHighlight ? `${inspection.startUtf16}–${inspection.endUtf16} UTF-16 code units` : '不提供伪造高亮；请人工核对引文与段落'}</span>
      </div>
      <article className="source-span-paragraph">
        {canHighlight ? <p>{inspection.paragraphText.slice(0, inspection.startUtf16!)}<mark>{inspection.paragraphText.slice(inspection.startUtf16!, inspection.endUtf16!)}</mark>{inspection.paragraphText.slice(inspection.endUtf16!)}</p>
          : <><p>{inspection.paragraphText}</p><blockquote><span>待核对引文</span>{inspection.exactQuote}</blockquote></>}
      </article>
      <footer><span>ID</span><code>{inspection.id}</code><span>SHA-256</span><code>{inspection.quoteSha256}</code></footer>
    </section>
  </div>;
}

function useSourceSpanInspector(run: RunHelper) {
  const [inspection, setInspection] = useState<SourceSpanInspection | null>(null);
  const openSourceSpan = useCallback(async (sourceSpanId: string) => {
    const value = await run(() => window.novelCompiler.inspectSourceSpan(sourceSpanId));
    if (value) setInspection(value);
  }, [run]);
  return {
    openSourceSpan,
    sourceSpanDialog: inspection ? <SourceSpanDialog inspection={inspection} onClose={() => setInspection(null)} /> : null,
  };
}

function CharactersView({ chunks, jobs, run }: { chunks: ChunkRecord[]; jobs: JobRecord[]; run: RunHelper }) {
  const [estimate, setEstimate] = useState<CharacterScanEstimate | null>(null);
  const [characters, setCharacters] = useState<CharacterCandidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [mentions, setMentions] = useState<CharacterMentionRecord[]>([]);
  const [aliases, setAliases] = useState<CharacterAliasRecord[]>([]);
  const [identityLinks, setIdentityLinks] = useState<CharacterIdentityLinkRecord[]>([]);
  const [factEstimate, setFactEstimate] = useState<CharacterFactEstimate | null>(null);
  const [facts, setFacts] = useState<CharacterFactRecord[]>([]);
  const [selectedFactId, setSelectedFactId] = useState('');
  const [factEvidence, setFactEvidence] = useState<CharacterFactEvidenceRecord[]>([]);
  const [operations, setOperations] = useState<IdentityOperationRecord[]>([]);
  const [checkedMentions, setCheckedMentions] = useState<string[]>([]);
  const [otherIdentityId, setOtherIdentityId] = useState('');
  const [splitName, setSplitName] = useState('');
  const { openSourceSpan, sourceSpanDialog } = useSourceSpanInspector(run);
  const [model, setModel] = usePreferredModel();
  const [factPasses, setFactPasses] = useState<1 | 2>(1);
  const scanJob = jobs.find((job) => job.type === 'character-scan');
  const factJob = jobs.find((job) => job.type === 'character-facts');
  const selected = characters.find((character) => character.id === selectedId) ?? characters[0];
  const selectedFact = facts.find((fact) => fact.id === selectedFactId) ?? facts[0];
  const latestAppliedOperation = operations.find((operation) => operation.state === 'applied');
  const scanSignature = `${scanJob?.state ?? ''}:${scanJob?.progress ?? 0}:${scanJob?.updatedAt ?? ''}`;
  const factSignature = `${factJob?.state ?? ''}:${factJob?.progress ?? 0}:${factJob?.updatedAt ?? ''}`;

  useEffect(() => {
    void Promise.all([window.novelCompiler.estimateCharacterScan(), window.novelCompiler.listCharacters()])
      .then(([nextEstimate, nextCharacters]) => {
        setEstimate(nextEstimate);
        setCharacters(nextCharacters);
        setSelectedId((current) => current || nextCharacters[0]?.id || '');
      }).catch(() => undefined);
  }, [chunks.length, scanSignature]);

  useEffect(() => {
    if (!selected) { setMentions([]); return; }
    setSelectedId(selected.id);
    setCheckedMentions([]);
    void Promise.all([
      window.novelCompiler.listCharacterMentions(selected.id),
      window.novelCompiler.listCharacterAliases(selected.id),
      window.novelCompiler.listCharacterIdentityLinks(selected.id),
      window.novelCompiler.listIdentityOperations(),
      window.novelCompiler.estimateCharacterFacts(selected.id),
      window.novelCompiler.listCharacterFacts(selected.id),
    ]).then(([nextMentions, nextAliases, nextLinks, nextOperations, nextFactEstimate, nextFacts]) => {
      setMentions(nextMentions);
      setAliases(nextAliases);
      setIdentityLinks(nextLinks);
      setOperations(nextOperations);
      setFactEstimate(nextFactEstimate);
      setFacts(nextFacts);
      setSelectedFactId((current) => nextFacts.some((fact) => fact.id === current) ? current : nextFacts[0]?.id ?? '');
    }).catch(() => { setMentions([]); setAliases([]); setIdentityLinks([]); setFacts([]); });
  }, [selected?.id, scanSignature, factSignature]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedFactId) { setFactEvidence([]); return; }
    void window.novelCompiler.listCharacterFactEvidence(selectedFactId).then(setFactEvidence).catch(() => setFactEvidence([]));
  }, [selectedFactId, factSignature]);

  useEffect(() => {
    const alternatives = characters.filter((character) => character.id !== selected?.id && character.reviewStatus !== 'rejected');
    if (!alternatives.some((character) => character.id === otherIdentityId)) setOtherIdentityId(alternatives[0]?.id ?? '');
  }, [characters, selected?.id, otherIdentityId]);

  async function startScan() {
    const status = await window.novelCompiler.getApiStatus();
    if (!status.configured) {
      await run(async () => { throw new Error('请先在“API 设置”中保存并测试模型连接'); });
      return;
    }
    await run(() => window.novelCompiler.startCharacterScan({ model }), '人物普查已启动，可在任务中心暂停或恢复');
  }

  async function startFactExtraction() {
    if (!selected) return;
    if (selected.reviewStatus !== 'confirmed') {
      await run(async () => { throw new Error('请先点击“确认人物”，再提取人物档案'); });
      return;
    }
    const status = await window.novelCompiler.getApiStatus();
    if (!status.configured) {
      await run(async () => { throw new Error('请先在“API 设置”中保存模型连接'); });
      return;
    }
    await run(() => window.novelCompiler.startCharacterFactExtraction({ identityId: selected.id, model, extractionPasses: factPasses }), `“${selected.canonicalName}”的人物档案提取已启动`);
  }

  async function reviewFact(fact: CharacterFactRecord, status: CharacterFactRecord['reviewStatus']) {
    const value = await run(() => window.novelCompiler.reviewCharacterFact(fact.id, status), status === 'confirmed' ? '人物事实已确认' : status === 'rejected' ? '人物事实已排除' : '人物事实已恢复为待审核');
    if (value) setFacts(value);
  }

  async function review(changes: { status?: CharacterCandidate['reviewStatus']; importanceTier?: CharacterCandidate['importanceTier'] }, success: string) {
    if (!selected) return;
    const value = await run(() => window.novelCompiler.reviewCharacter(selected.id, changes), success);
    if (value) setCharacters(value);
  }

  async function refreshIdentityPanels(nextCharacters: CharacterCandidate[], nextSelectedId?: string) {
    setCharacters(nextCharacters);
    if (nextSelectedId) setSelectedId(nextSelectedId);
    setOperations(await window.novelCompiler.listIdentityOperations());
  }

  async function reviewAlias(alias: CharacterAliasRecord, status: CharacterAliasRecord['reviewStatus']) {
    const value = await run(() => window.novelCompiler.reviewCharacterAlias(alias.id, status), status === 'confirmed' ? '别名已确认' : status === 'rejected' ? '别名已排除' : '别名已恢复为待审核');
    if (value) {
      setAliases(value);
      setOperations(await window.novelCompiler.listIdentityOperations());
    }
  }

  async function reviewIdentityLink(link: CharacterIdentityLinkRecord, status: CharacterIdentityLinkRecord['reviewStatus']) {
    if (!selected) return;
    const value = await run(() => window.novelCompiler.reviewCharacterIdentityLink(link.id, status), status === 'confirmed' ? '身份关系建议已确认' : status === 'rejected' ? '身份关系建议已排除' : '身份关系建议已恢复');
    if (value) {
      setIdentityLinks(await window.novelCompiler.listCharacterIdentityLinks(selected.id));
      setOperations(await window.novelCompiler.listIdentityOperations());
    }
  }

  async function mergeIdentity() {
    if (!selected || !otherIdentityId) return;
    const target = characters.find((character) => character.id === otherIdentityId);
    if (!target || !window.confirm(`把“${selected.canonicalName}”合并到“${target.canonicalName}”？原文证据不会删除，并且可以撤销。`)) return;
    const value = await run(() => window.novelCompiler.mergeCharacters(selected.id, target.id), '人物已经合并，原身份和证据仍可撤销恢复');
    if (value) await refreshIdentityPanels(value, target.id);
  }

  async function markDifferent() {
    if (!selected || !otherIdentityId) return;
    const target = characters.find((character) => character.id === otherIdentityId);
    if (!target) return;
    const reason = window.prompt('为什么确定这是两个不同人物？', '用户根据原文确认二者并非同一人物') ?? '';
    if (!reason.trim()) return;
    const value = await run(() => window.novelCompiler.linkCharacters(selected.id, target.id, 'cannot_link', reason), `已禁止“${selected.canonicalName}”与“${target.canonicalName}”自动合并`);
    if (value) {
      await refreshIdentityPanels(value);
      setIdentityLinks(await window.novelCompiler.listCharacterIdentityLinks(selected.id));
    }
  }

  async function splitIdentity() {
    if (!selected || !checkedMentions.length || !splitName.trim()) return;
    const value = await run(() => window.novelCompiler.splitCharacter(selected.id, checkedMentions, splitName), `已经从“${selected.canonicalName}”拆出新人物“${splitName.trim()}”`);
    if (value) {
      setSplitName('');
      setCheckedMentions([]);
      await refreshIdentityPanels(value);
    }
  }

  async function undoLatest() {
    const value = await run(() => window.novelCompiler.undoLastIdentityOperation(), '最近一次身份操作已撤销');
    if (value) {
      await refreshIdentityPanels(value.characters);
      if (selected) {
        const [nextMentions, nextAliases, nextLinks] = await Promise.all([
          window.novelCompiler.listCharacterMentions(selected.id), window.novelCompiler.listCharacterAliases(selected.id), window.novelCompiler.listCharacterIdentityLinks(selected.id),
        ]);
        setMentions(nextMentions); setAliases(nextAliases); setIdentityLinks(nextLinks);
      }
    }
  }

  function toggleMention(id: string) {
    setCheckedMentions((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
  }

  return <section>
    <PageTitle eyebrow="CHARACTER CENSUS" title="人物普查" description="模型只提交候选；正式身份由原文证据和你的审核共同决定。上下文重叠区不会重复产生人物。" />
    <div className="scan-toolbar panel">
      <div><span>分析分块</span><strong>{estimate?.chunkCount ?? chunks.length}</strong><small>{estimate?.ready ? `正文粗算 ${(estimate.approximateInputTokens / 1000).toFixed(1)}K Token；不含提示词、输出与重试` : '请先生成分析分块'}</small></div>
      <div><span>候选人物</span><strong>{characters.filter((item) => item.reviewStatus !== 'rejected').length}</strong><small>{characters.filter((item) => item.reviewStatus === 'confirmed').length} 个已确认</small></div>
      <div className="scan-model"><label>扫描模型</label><input value={model} onChange={(event) => setModel(event.target.value)} /></div>
      <button className="button primary" disabled={!estimate?.ready || scanJob?.state === 'running' || !model.trim()} onClick={() => void startScan()}>
        {scanJob?.state === 'running' ? `扫描中 ${Math.round(scanJob.progress * 100)}%` : scanJob?.state === 'completed' ? '按当前方案重新检查' : '开始人物普查'}
      </button>
    </div>
    {latestAppliedOperation && <div className="operation-bar panel"><div><span>最近可撤销的身份操作</span><strong>{latestAppliedOperation.description}</strong><small>按应用顺序逐步撤销，不会删除原文证据</small></div><button className="button ghost" onClick={() => void undoLatest()}>撤销最近操作</button></div>}
    {!estimate?.ready ? <div className="simple-empty">先到“分析分块”生成方案。人物普查会锁定当前分块版本，不会读取已排除段落。</div> : characters.length === 0 ?
      <div className="simple-empty">还没有人物候选。开始扫描后，已完成分块的结果会逐步出现在这里。</div> :
      <div className="character-layout">
        <div className="character-list panel">
          <div className="panel-heading"><strong>{characters.length} 个候选</strong><span>按重要度排序</span></div>
          {characters.map((character) => <button key={character.id} className={`${selected?.id === character.id ? 'selected' : ''} ${character.reviewStatus === 'rejected' ? 'rejected' : ''}`} onClick={() => setSelectedId(character.id)}>
            <div><strong>{character.canonicalName}</strong><small>{tierLabels[character.importanceTier]} · 全文出现 {character.mentionCount} 次</small></div><span>{character.importanceScore.toFixed(1)}</span>
          </button>)}
        </div>
        {selected && <div className="character-dossier panel">
          <div className="dossier-heading">
            <div><span>{selected.entityType}</span><h3>{selected.canonicalName}</h3><p>{selected.aliases.length ? `候选别名：${selected.aliases.join('、')}` : '尚无别名候选'}</p></div>
            <div className="review-actions">
              <select value={selected.importanceTier} onChange={(event) => void review({ importanceTier: event.target.value as CharacterCandidate['importanceTier'] }, '人物分级已更新')}>
                {Object.entries(tierLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <button className="button primary" disabled={selected.reviewStatus === 'confirmed'} onClick={() => void review({ status: 'confirmed' }, '人物候选已确认')}>确认人物</button>
              <button className="button ghost" disabled={selected.reviewStatus === 'rejected'} onClick={() => void review({ status: 'rejected' }, '候选已排除，原始证据仍然保留')}>排除</button>
            </div>
          </div>
          <div className="dossier-metrics">
            <span>覆盖章节 <strong>{selected.chapterCount}</strong></span><span>对白证据 <strong>{selected.dialogueCount}</strong></span><span>事件证据 <strong>{selected.eventCount}</strong></span><span>出现范围 <strong>{selected.firstOrdinal}–{selected.lastOrdinal}</strong></span>
          </div>
          <div className="identity-tools">
            <div><label>与另一个候选比较</label><select value={otherIdentityId} onChange={(event) => setOtherIdentityId(event.target.value)}><option value="">没有其他候选</option>{characters.filter((character) => character.id !== selected.id && character.reviewStatus !== 'rejected').map((character) => <option key={character.id} value={character.id}>{character.canonicalName}</option>)}</select></div>
            <button className="button ghost" disabled={!otherIdentityId} onClick={() => void markDifferent()}>明确是不同人物</button>
            <button className="button primary" disabled={!otherIdentityId || selected.reviewStatus === 'rejected'} onClick={() => void mergeIdentity()}>合并到所选人物</button>
          </div>
          {identityLinks.length > 0 && <div className="identity-suggestions"><div className="evidence-heading"><strong>身份关系建议</strong><span>确认“不同人物”后会成为硬约束</span></div>{identityLinks.map((link) => <article key={link.id} className={link.reviewStatus}><div><strong>{link.otherName}</strong><span>{link.relation === 'must_link' ? '可能是同一人物' : link.relation === 'cannot_link' ? '明确是不同人物' : '身份暂不确定'} · {(link.confidence * 100).toFixed(0)}%</span><p>{link.reason}</p></div><div><button disabled={link.reviewStatus === 'confirmed'} onClick={() => void reviewIdentityLink(link, 'confirmed')}>确认</button><button disabled={link.reviewStatus === 'rejected'} onClick={() => void reviewIdentityLink(link, 'rejected')}>排除</button>{link.reviewStatus !== 'pending' && <button onClick={() => void reviewIdentityLink(link, 'pending')}>恢复</button>}</div></article>)}</div>}
          {selected.uncertainty && <div className="uncertainty">待核实：{selected.uncertainty}</div>}
          <div className="fact-section">
            <div className="fact-toolbar"><div><strong>人物事实档案</strong><span>{factEstimate?.ready ? `${factEstimate.paragraphCount} 段材料 · ${factEstimate.batchCount} 批 · 正文粗算 ${((factEstimate.approximateInputTokens * factPasses) / 1000).toFixed(1)}K Token（不含提示词、输出与重试）` : '确认人物后收集相关原文'}</span></div><div className="fact-run-controls"><label><span>抽取强度</span><select value={factPasses} onChange={(event) => setFactPasses(Number(event.target.value) === 2 ? 2 : 1)}><option value={1}>单轮精确</option><option value={2}>双轮补漏</option></select></label><button className="button primary" disabled={selected.reviewStatus !== 'confirmed' || !factEstimate?.ready || factJob?.state === 'running'} onClick={() => void startFactExtraction()}>{factJob?.state === 'running' ? `提取中 ${Math.round(factJob.progress * 100)}%` : facts.length ? '按当前材料重新检查' : '提取人物档案'}</button></div></div>
            {facts.length > 0 ? <div className="fact-workspace"><div className="fact-list">{facts.map((fact) => <article key={fact.id} className={`${fact.id === selectedFact?.id ? 'selected' : ''} ${fact.reviewStatus}`} onClick={() => setSelectedFactId(fact.id)}>
              <div><span>{factCategoryLabels[fact.category]} · {assertionModeLabels[fact.assertionMode]}</span><small>{(fact.confidence * 100).toFixed(0)}% · {fact.evidenceCount} 条证据</small></div><strong>{fact.predicate}：{fact.value}</strong><footer><button disabled={fact.reviewStatus === 'confirmed'} onClick={(event) => { event.stopPropagation(); void reviewFact(fact, 'confirmed'); }}>确认</button><button disabled={fact.reviewStatus === 'rejected'} onClick={(event) => { event.stopPropagation(); void reviewFact(fact, 'rejected'); }}>排除</button>{fact.reviewStatus !== 'pending' && <button onClick={(event) => { event.stopPropagation(); void reviewFact(fact, 'pending'); }}>恢复</button>}</footer>
            </article>)}</div>{selectedFact && <div className="fact-detail"><strong>{selectedFact.predicate}</strong><p>{selectedFact.value}</p><small>{truthStatusLabels[selectedFact.truthStatus]} · 第 {selectedFact.extractionPass} 轮{selectedFact.attributedSourceName ? ` · 来源：${selectedFact.attributedSourceName}` : ''}</small>{selectedFact.reasoningNote && <small>{selectedFact.reasoningNote}</small>}<div>{factEvidence.map((evidence) => <blockquote key={evidence.id}><span>{evidence.chapterTitle ?? '未分章'} · 段落 {evidence.paragraphOrdinal}</span>{evidence.exactQuote}<button className="source-span-link" type="button" aria-label="查看人物事实证据原文" disabled={!evidence.sourceSpanId} onClick={() => evidence.sourceSpanId && void openSourceSpan(evidence.sourceSpanId)}>查看原文</button></blockquote>)}</div></div>}</div> : <p className="no-facts">{selected.reviewStatus === 'confirmed' ? '尚未提取人物事实。提取前会显示材料量，不会上传整本无关正文。' : '先确认这个人物，才能开始提取档案。'}</p>}
          </div>
          <div className="alias-review"><div className="evidence-heading"><strong>别名候选</strong><span>别名确认后可帮助后续分块稳定归并</span></div>{aliases.length ? <div className="alias-list">{aliases.map((alias) => <article key={alias.id} className={alias.reviewStatus}><div><strong>{alias.alias}</strong><small>{alias.aliasType} · {(alias.confidence * 100).toFixed(0)}%</small></div><div><button disabled={alias.reviewStatus === 'confirmed'} onClick={() => void reviewAlias(alias, 'confirmed')}>确认</button><button disabled={alias.reviewStatus === 'rejected'} onClick={() => void reviewAlias(alias, 'rejected')}>排除</button>{alias.reviewStatus !== 'pending' && <button onClick={() => void reviewAlias(alias, 'pending')}>恢复</button>}</div></article>)}</div> : <p className="no-alias">没有待审核别名。</p>}</div>
          <div className="split-tools"><div><label>按证据拆出新人物</label><span>先勾选下方被错误归入当前人物的证据</span></div><input value={splitName} onChange={(event) => setSplitName(event.target.value)} placeholder="新人物名称" /><button className="button ghost" disabled={!checkedMentions.length || !splitName.trim() || checkedMentions.length >= mentions.length} onClick={() => void splitIdentity()}>拆出 {checkedMentions.length || ''} 条证据</button></div>
          <div className="evidence-heading"><strong>原文证据</strong><span>只展示已经重新对齐的引用</span></div>
          <div className="character-evidence">{mentions.map((mention) => <article key={mention.id}>
            <div><span><input type="checkbox" checked={checkedMentions.includes(mention.id)} onChange={() => toggleMention(mention.id)} /> {mention.chapterTitle ?? '未分章'} · 段落 {mention.paragraphOrdinal}</span><small>{mention.alignmentStatus === 'exact' ? '逐字匹配' : '规范化匹配'} · {(mention.confidence * 100).toFixed(0)}%</small></div>
            <p>{mention.exactQuote}</p><footer><span>{mention.surfaceText} · {mention.mentionType} · {mention.supports}</span><button type="button" disabled={!mention.sourceSpanId} onClick={() => mention.sourceSpanId && void openSourceSpan(mention.sourceSpanId)}>查看原文</button></footer>
          </article>)}</div>
          {mentions.length === 0 && <div className="simple-empty">这个候选尚无通过校验的证据。</div>}
        </div>}
      </div>}
    {sourceSpanDialog}
  </section>;
}

const quoteMethodLabels: Record<QuoteAttributionRecord['method'], string> = {
  explicit_cue: '明确言说线索', nearby_context: '邻近人物候选', turn_taking: '对话轮次', style: '语言风格', model: '模型判断', user: '人工指定',
};

function QuotesView({ run }: { run: RunHelper }) {
  const [summary, setSummary] = useState<QuoteScanSummary>({ quoteCount: 0, confirmedSpeakerCount: 0, suggestedSpeakerCount: 0, unresolvedCount: 0 });
  const [quotes, setQuotes] = useState<CharacterQuoteRecord[]>([]);
  const [characters, setCharacters] = useState<CharacterCandidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [attributions, setAttributions] = useState<QuoteAttributionRecord[]>([]);
  const [profiles, setProfiles] = useState<SpeechProfileRecord[]>([]);
  const [unresolvedOnly, setUnresolvedOnly] = useState(false);
  const [manualIdentityId, setManualIdentityId] = useState('');
  const selected = quotes.find((quote) => quote.id === selectedId) ?? quotes[0];

  const reload = useCallback(async () => {
    const [nextSummary, nextQuotes, nextCharacters, nextProfiles] = await Promise.all([
      window.novelCompiler.getCharacterQuoteSummary(),
      window.novelCompiler.listCharacterQuotes({ unresolvedOnly, limit: 500 }),
      window.novelCompiler.listCharacters(),
      window.novelCompiler.listSpeechProfiles(),
    ]);
    setSummary(nextSummary);
    setQuotes(nextQuotes);
    setCharacters(nextCharacters);
    setProfiles(nextProfiles);
    setSelectedId((current) => nextQuotes.some((quote) => quote.id === current) ? current : nextQuotes[0]?.id ?? '');
    setManualIdentityId((current) => nextCharacters.some((character) => character.id === current && character.reviewStatus !== 'rejected')
      ? current : nextCharacters.find((character) => character.reviewStatus === 'confirmed')?.id ?? nextCharacters.find((character) => character.reviewStatus !== 'rejected')?.id ?? '');
  }, [unresolvedOnly]);

  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  useEffect(() => {
    if (!selected?.id) { setAttributions([]); return; }
    setSelectedId(selected.id);
    void window.novelCompiler.listQuoteAttributions(selected.id).then(setAttributions).catch(() => setAttributions([]));
  }, [selected?.id]);

  async function scan() {
    const value = await run(() => window.novelCompiler.scanCharacterQuotes(), '对白扫描完成；规则扫描未调用模型 API');
    if (!value) return;
    setSummary(value);
    await reload();
  }

  async function review(attribution: QuoteAttributionRecord, status: QuoteAttributionRecord['reviewStatus']) {
    const value = await run(() => window.novelCompiler.reviewQuoteAttribution(attribution.id, status),
      status === 'confirmed' ? '说话人已经确认' : status === 'rejected' ? '候选已经排除' : '候选已恢复为待审核');
    if (!value) return;
    setAttributions(value);
    await reload();
  }

  async function analyzeLocalTurns() {
    const value = await run(() => window.novelCompiler.analyzeLocalQuoteTurns(), '本地轮次分析完成；新候选均保持待审核');
    if (!value) return;
    await reload();
  }

  async function assign() {
    if (!selected || !manualIdentityId) return;
    const value = await run(() => window.novelCompiler.assignQuoteSpeaker(selected.id, manualIdentityId), '已人工指定说话人');
    if (!value) return;
    setAttributions(value);
    await reload();
  }

  return <section>
    <PageTitle eyebrow="QUOTE ATTRIBUTION" title="对白归属" description="先用本地规则识别对白和明确说话线索；无法确定的对白保留候选并等待审核，不会仅凭邻近人物自动确认。" />
    <div className="quote-toolbar panel">
      <div><span>识别对白</span><strong>{summary.quoteCount}</strong></div>
      <div><span>已确认说话人</span><strong>{summary.confirmedSpeakerCount}</strong></div>
      <div><span>待审核候选</span><strong>{summary.suggestedSpeakerCount}</strong></div>
      <div><span>尚无候选</span><strong>{summary.unresolvedCount}</strong></div>
      <label><input type="checkbox" checked={unresolvedOnly} onChange={(event) => setUnresolvedOnly(event.target.checked)} /> 只看未确认</label>
      <div className="quote-actions"><button className="button ghost" disabled={!summary.quoteCount} onClick={() => void analyzeLocalTurns()}>分析隐式轮次</button><button className="button primary" onClick={() => void scan()}>扫描全书对白</button></div>
    </div>
    {profiles.length > 0 && <div className="speech-profiles">{profiles.map((profile) => <article className="panel" key={profile.identityId}><div><strong>{profile.identityName}</strong><span>{profile.quoteCount} 条已确认对白 · 平均 {profile.averageLength.toFixed(1)} 字</span></div><p>疑问 {(profile.questionRate * 100).toFixed(0)}% · 感叹 {(profile.exclamationRate * 100).toFixed(0)}% · 省略 {(profile.ellipsisRate * 100).toFixed(0)}% · 语气词 {(profile.sentenceParticleRate * 100).toFixed(0)}%</p><small>{profile.favoriteMarkers.length ? `高频标记：${profile.favoriteMarkers.join('、')}` : '确认对白尚少，暂无稳定高频标记'}</small>{profile.samples.length > 0 && <blockquote>{profile.samples.map((sample) => `“${sample.quoteText}”`).join('　')}</blockquote>}</article>)}</div>}
    {quotes.length ? <div className="quote-layout">
      <div className="quote-list panel"><div className="panel-heading"><strong>{quotes.length} 条对白</strong><span>本页最多 500 条</span></div>{quotes.map((quote) => <button key={quote.id} className={selected?.id === quote.id ? 'selected' : ''} onClick={() => setSelectedId(quote.id)}>
        <div><span>{quote.chapterTitle ?? '未分章'} · 段落 {quote.paragraphOrdinal}</span><p>“{quote.quoteText}”</p></div><small>{quote.confirmedSpeakerName ? `已确认：${quote.confirmedSpeakerName}` : quote.suggestedSpeakerName ? `候选：${quote.suggestedSpeakerName}` : '待归属'}</small>
      </button>)}</div>
      {selected && <div className="quote-detail panel">
        <div className="quote-source"><span>{selected.chapterTitle ?? '未分章'} · 段落 {selected.paragraphOrdinal} · 字符 {selected.startOffset}–{selected.endOffset}</span><blockquote>“{selected.quoteText}”</blockquote></div>
        <div className="manual-speaker"><label>人工指定说话人</label><select value={manualIdentityId} onChange={(event) => setManualIdentityId(event.target.value)}><option value="">选择人物</option>{characters.filter((character) => character.reviewStatus !== 'rejected').map((character) => <option value={character.id} key={character.id}>{character.canonicalName}{character.reviewStatus === 'confirmed' ? '' : '（未确认人物）'}</option>)}</select><button className="button primary" disabled={!manualIdentityId} onClick={() => void assign()}>确认指定</button></div>
        <div className="attribution-heading"><strong>说话人候选</strong><span>确认一个候选会把此前已确认项恢复为待审核</span></div>
        <div className="attribution-list">{attributions.map((attribution) => <article key={attribution.id} className={attribution.reviewStatus}>
          <div><strong>{attribution.identityName}</strong><span>{quoteMethodLabels[attribution.method]} · {(attribution.confidence * 100).toFixed(0)}%</span></div><p>{attribution.reasoning}</p>{attribution.evidenceText && <blockquote>{attribution.evidenceText}</blockquote>}<footer><button disabled={attribution.reviewStatus === 'confirmed'} onClick={() => void review(attribution, 'confirmed')}>确认</button><button disabled={attribution.reviewStatus === 'rejected'} onClick={() => void review(attribution, 'rejected')}>排除</button>{attribution.reviewStatus !== 'pending' && <button onClick={() => void review(attribution, 'pending')}>恢复</button>}</footer>
        </article>)}</div>
        {!attributions.length && <div className="simple-empty">没有可靠候选。请人工指定，或留待后续隐式说话人分析。</div>}
      </div>}
    </div> : <div className="simple-empty">尚未扫描对白。扫描完全在本机完成，不会调用 API，也不会修改原文。</div>}
  </section>;
}

const factRelationLabels: Record<FactRelationKind, string> = {
  uncertain: '需要判断', contradiction: '真正矛盾', state_change: '状态变化', coexists_by_time: '不同阶段并存',
  viewpoint_difference: '人物观点不同', rumor_correction: '传闻被纠正', identity_disguise: '身份伪装', unrelated: '彼此无关',
};

const resolvedFactRelations: Array<Exclude<FactRelationKind, 'uncertain'>> = [
  'state_change', 'coexists_by_time', 'contradiction', 'viewpoint_difference', 'rumor_correction', 'identity_disguise', 'unrelated',
];

function FactReviewView({ run }: { run: RunHelper }) {
  const [characters, setCharacters] = useState<CharacterCandidate[]>([]);
  const [identityId, setIdentityId] = useState('');
  const [clusters, setClusters] = useState<FactClusterRecord[]>([]);
  const [relations, setRelations] = useState<FactRelationRecord[]>([]);
  const [transitions, setTransitions] = useState<CharacterStateTransitionRecord[]>([]);
  const [selectedClusterId, setSelectedClusterId] = useState('');
  const [members, setMembers] = useState<CharacterFactRecord[]>([]);
  const [relationChoices, setRelationChoices] = useState<Record<string, Exclude<FactRelationKind, 'uncertain'> | ''>>({});
  const [summary, setSummary] = useState<FactConsolidationSummary>({ clusterCount: 0, memberCount: 0, pendingRelationCount: 0, transitionCount: 0 });
  const selectedCluster = clusters.find((cluster) => cluster.id === selectedClusterId) ?? clusters[0];

  const reload = useCallback(async () => {
    const filter = identityId || undefined;
    const [nextCharacters, nextClusters, nextRelations, nextTransitions] = await Promise.all([
      window.novelCompiler.listCharacters(), window.novelCompiler.listFactClusters(filter),
      window.novelCompiler.listFactRelations(filter), window.novelCompiler.listCharacterStateTransitions(filter),
    ]);
    setCharacters(nextCharacters);
    setClusters(nextClusters);
    setRelations(nextRelations);
    setTransitions(nextTransitions);
    setSelectedClusterId((current) => nextClusters.some((cluster) => cluster.id === current) ? current : nextClusters[0]?.id ?? '');
    setRelationChoices((current) => {
      const next = { ...current };
      for (const relation of nextRelations) {
        if (next[relation.id] === undefined) next[relation.id] = relation.resolvedRelation
          ?? (relation.proposedRelation === 'uncertain' ? '' : relation.proposedRelation);
      }
      return next;
    });
    setSummary({
      clusterCount: nextClusters.length,
      memberCount: nextClusters.reduce((sum, cluster) => sum + Number(cluster.memberCount), 0),
      pendingRelationCount: nextRelations.filter((relation) => relation.reviewStatus === 'pending').length,
      transitionCount: nextTransitions.length,
    });
  }, [identityId]);

  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  useEffect(() => {
    if (!selectedCluster?.id) { setMembers([]); return; }
    setSelectedClusterId(selectedCluster.id);
    void window.novelCompiler.listFactClusterMembers(selectedCluster.id).then(setMembers).catch(() => setMembers([]));
  }, [selectedCluster?.id]);

  async function consolidate() {
    const value = await run(() => window.novelCompiler.consolidateCharacterFacts(), '事实整理完成；不同值只生成待审核关系，不会覆盖原始事实');
    if (!value) return;
    setSummary(value);
    await reload();
  }

  async function reviewRelation(relation: FactRelationRecord, status: FactRelationRecord['reviewStatus']) {
    const choice = relationChoices[relation.id] || relation.resolvedRelation
      || (relation.proposedRelation === 'uncertain' ? undefined : relation.proposedRelation);
    const value = await run(() => window.novelCompiler.reviewFactRelation(relation.id, status, status === 'confirmed' ? choice || undefined : undefined),
      status === 'confirmed' ? '事实关系已经确认' : status === 'rejected' ? '关系候选已经排除' : '关系已恢复为待审核');
    if (!value) return;
    setRelations(value);
    await reload();
  }

  return <section>
    <PageTitle eyebrow="FACT CONSOLIDATION" title="事实整理" description="相同事实只做规范化归组；不同值必须判断是状态变化、不同阶段、观点差异、传闻纠正还是真正矛盾。" />
    <div className="fact-review-toolbar panel">
      <div><span>事实簇</span><strong>{summary.clusterCount}</strong></div><div><span>原始事实成员</span><strong>{summary.memberCount}</strong></div><div><span>待审核关系</span><strong>{summary.pendingRelationCount}</strong></div><div><span>已确认变化</span><strong>{summary.transitionCount}</strong></div>
      <label><span>人物筛选</span><select value={identityId} onChange={(event) => setIdentityId(event.target.value)}><option value="">全部人物</option>{characters.filter((character) => character.reviewStatus !== 'rejected').map((character) => <option key={character.id} value={character.id}>{character.canonicalName}</option>)}</select></label>
      <button className="button primary" onClick={() => void consolidate()}>本地整理事实</button>
    </div>
    {clusters.length ? <div className="fact-review-layout">
      <div className="fact-clusters panel"><div className="panel-heading"><strong>规范事实簇</strong><span>仅合并规范化后完全相同的值</span></div>{clusters.map((cluster) => <button key={cluster.id} className={selectedCluster?.id === cluster.id ? 'selected' : ''} onClick={() => setSelectedClusterId(cluster.id)}><span>{cluster.identityName} · {factCategoryLabels[cluster.category]}</span><strong>{cluster.canonicalPredicate}：{cluster.canonicalValue}</strong><small>{cluster.memberCount} 条原始事实 · {cluster.firstObservedOrdinal ?? '?'}–{cluster.lastObservedOrdinal ?? '?'}</small></button>)}</div>
      <div className="fact-cluster-detail panel"><div className="panel-heading"><strong>{selectedCluster ? `${selectedCluster.canonicalPredicate}：${selectedCluster.canonicalValue}` : '事实成员'}</strong><span>原始事实不会被删除</span></div><div>{members.map((fact) => <article key={fact.id}><div><span>{assertionModeLabels[fact.assertionMode]} · {truthStatusLabels[fact.truthStatus]}</span><small>{(fact.confidence * 100).toFixed(0)}% · {fact.evidenceCount} 条证据</small></div><p>{fact.value}</p>{fact.reasoningNote && <small>{fact.reasoningNote}</small>}</article>)}</div></div>
    </div> : <div className="simple-empty">尚未建立事实簇。先完成人物事实提取，再点击“本地整理事实”。</div>}
    <div className="relation-section panel"><div className="panel-heading"><strong>同属性不同值</strong><span>必须确认分类后才会影响时间状态</span></div>{relations.length ? <div className="fact-relations">{relations.map((relation) => <article key={relation.id} className={relation.reviewStatus}><div className="relation-values"><span>{relation.leftValue}<small>段落 {relation.leftObservedOrdinal ?? '?'}</small></span><b>→</b><span>{relation.rightValue}<small>段落 {relation.rightObservedOrdinal ?? '?'}</small></span></div><p>{relation.identityName} · {relation.predicate} · 建议：{factRelationLabels[relation.proposedRelation]}（{(relation.confidence * 100).toFixed(0)}%）</p><small>{relation.reason}</small><footer><select value={relationChoices[relation.id] ?? ''} onChange={(event) => setRelationChoices((current) => ({ ...current, [relation.id]: event.target.value as Exclude<FactRelationKind, 'uncertain'> }))}><option value="">选择实际关系</option>{resolvedFactRelations.map((kind) => <option value={kind} key={kind}>{factRelationLabels[kind]}</option>)}</select><button disabled={relation.reviewStatus === 'confirmed' || !relationChoices[relation.id]} onClick={() => void reviewRelation(relation, 'confirmed')}>确认</button><button disabled={relation.reviewStatus === 'rejected'} onClick={() => void reviewRelation(relation, 'rejected')}>排除</button>{relation.reviewStatus !== 'pending' && <button onClick={() => void reviewRelation(relation, 'pending')}>恢复</button>}</footer></article>)}</div> : <p className="no-facts">当前没有需要判断的同属性不同值。</p>}</div>
    {transitions.length > 0 && <div className="transition-section panel"><div className="panel-heading"><strong>已确认人物状态变化</strong><span>将供进入时间选择和角色卡生成使用</span></div>{transitions.map((transition) => <article key={transition.id}><span>{transition.identityName} · {transition.predicate}</span><strong>{transition.fromValue} → {transition.toValue}</strong><small>原文观察顺序：{transition.observedFromOrdinal ?? '?'} → {transition.observedToOrdinal ?? '?'}</small></article>)}</div>}
  </section>;
}

const timeExpressionLabels: Record<TimeExpressionRecord['expressionType'], string> = {
  calendar: '明确日期', clock: '时刻', relative: '相对时间', duration: '持续时间', frequency: '频率',
  age: '年龄时间', era: '时代/纪年', season: '季节', unknown: '待判断',
};

const timelineEventTypeLabels: Record<TimelineEventRecord['eventType'], string> = {
  action: '行动', dialogue: '关键对话', movement: '移动', meeting: '相遇', conflict: '冲突', discovery: '发现',
  state_change: '状态变化', birth: '出生', death: '死亡', other: '其他',
};

const timelineRelationLabels: Record<TimelineRelationKind, string> = {
  before: '左侧早于右侧', after: '左侧晚于右侧', simultaneous: '同时发生', includes: '左侧包含右侧',
  is_included: '左侧被右侧包含', unknown: '无法确定',
};

const timelineRelationKinds: TimelineRelationKind[] = ['before', 'after', 'simultaneous', 'includes', 'is_included', 'unknown'];

function TimelineView({ run, jobs }: { run: RunHelper; jobs: JobRecord[] }) {
  type Summary = Omit<TimeExpressionScanSummary, 'detectedCount' | 'insertedCount'>;
  const [summary, setSummary] = useState<Summary>({ totalCount: 0, pendingCount: 0, confirmedCount: 0, rejectedCount: 0, normalizedCount: 0 });
  const [expressions, setExpressions] = useState<TimeExpressionRecord[]>([]);
  const [filter, setFilter] = useState<'all' | TimeExpressionReviewStatus>('pending');
  const [normalizedDrafts, setNormalizedDrafts] = useState<Record<string, string>>({});
  const [eventEstimate, setEventEstimate] = useState<TimelineEventEstimate | null>(null);
  const [events, setEvents] = useState<TimelineEventRecord[]>([]);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [eventEvidence, setEventEvidence] = useState<TimelineEventEvidenceRecord[]>([]);
  const [eventParticipants, setEventParticipants] = useState<TimelineEventParticipantRecord[]>([]);
  const [eventLocations, setEventLocations] = useState<TimelineEventLocationRecord[]>([]);
  const [eventModel, setEventModel] = usePreferredModel();
  const [relations, setRelations] = useState<TimelineRelationRecord[]>([]);
  const [relationChoices, setRelationChoices] = useState<Record<string, TimelineRelationKind>>({});
  const [graphSummary, setGraphSummary] = useState<TimelineGraphSummary>({ eventCount: 0, confirmedRelationCount: 0, pendingRelationCount: 0, hasCycle: false, orderedEventCount: 0, unconstrainedEventCount: 0 });
  const [timelineOrder, setTimelineOrder] = useState<TimelineOrderRecord[]>([]);
  const [entryEventId, setEntryEventId] = useState('');
  const [stateSnapshot, setStateSnapshot] = useState<StoryStateSnapshot | null>(null);
  const { openSourceSpan, sourceSpanDialog } = useSourceSpanInspector(run);
  const eventJob = jobs.find((job) => job.type === 'timeline-events');
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? events[0];
  const confirmedEvents = useMemo(() => events.filter((event) => event.reviewStatus === 'confirmed'), [events]);

  const reload = useCallback(async () => {
    const [nextSummary, nextExpressions] = await Promise.all([
      window.novelCompiler.getTimeExpressionSummary(),
      window.novelCompiler.listTimeExpressions(filter === 'all' ? undefined : filter),
    ]);
    setSummary(nextSummary);
    setExpressions(nextExpressions);
    setNormalizedDrafts((current) => {
      const next = { ...current };
      for (const expression of nextExpressions) if (next[expression.id] === undefined) next[expression.id] = expression.normalizedValue ?? '';
      return next;
    });
  }, [filter]);

  useEffect(() => { void reload().catch(() => undefined); }, [reload]);
  const reloadEvents = useCallback(async () => {
    const [estimate, nextEvents] = await Promise.all([window.novelCompiler.estimateTimelineEvents(), window.novelCompiler.listTimelineEvents()]);
    setEventEstimate(estimate);
    setEvents(nextEvents);
    setSelectedEventId((current) => nextEvents.some((event) => event.id === current) ? current : nextEvents[0]?.id ?? '');
  }, []);
  useEffect(() => { void reloadEvents().catch(() => undefined); }, [reloadEvents, eventJob?.state, eventJob?.progress]);
  const reloadRelations = useCallback(async () => {
    const [nextRelations, nextSummary, nextOrder] = await Promise.all([
      window.novelCompiler.listTimelineRelations(),
      window.novelCompiler.getTimelineGraphSummary(),
      window.novelCompiler.getTimelineOrder().catch(() => [] as TimelineOrderRecord[]),
    ]);
    setRelations(nextRelations); setGraphSummary(nextSummary); setTimelineOrder(nextOrder);
    setRelationChoices((current) => {
      const next = { ...current };
      for (const relation of nextRelations) if (!next[relation.id]) next[relation.id] = relation.resolvedRelation ?? relation.proposedRelation;
      return next;
    });
  }, []);
  useEffect(() => { void reloadRelations().catch(() => undefined); }, [reloadRelations, events.length]);
  useEffect(() => {
    setEntryEventId((current) => confirmedEvents.some((event) => event.id === current) ? current : confirmedEvents[0]?.id ?? '');
  }, [confirmedEvents]);
  useEffect(() => {
    if (!selectedEvent?.id) { setEventEvidence([]); setEventParticipants([]); setEventLocations([]); return; }
    setSelectedEventId(selectedEvent.id);
    void Promise.all([
      window.novelCompiler.listTimelineEventEvidence(selectedEvent.id),
      window.novelCompiler.listTimelineEventParticipants(selectedEvent.id),
      window.novelCompiler.listTimelineEventLocations(selectedEvent.id),
    ]).then(([evidence, participants, locations]) => {
      setEventEvidence(evidence); setEventParticipants(participants); setEventLocations(locations);
    }).catch(() => undefined);
  }, [selectedEvent?.id]);

  async function scan() {
    const value = await run(() => window.novelCompiler.scanTimeExpressions(), '时间表达扫描完成；所有结果均保留原文位置并等待审核');
    if (!value) return;
    setSummary(value);
    await reload();
  }

  async function review(expression: TimeExpressionRecord, status: TimeExpressionReviewStatus) {
    const normalizedValue = status === 'confirmed' ? normalizedDrafts[expression.id] ?? expression.normalizedValue : undefined;
    const value = await run(() => window.novelCompiler.reviewTimeExpression(expression.id, status, normalizedValue),
      status === 'confirmed' ? '时间表达已经确认' : status === 'rejected' ? '时间表达已经排除' : '时间表达已恢复为待审核');
    if (!value) return;
    await reload();
  }

  async function reviewEvent(event: TimelineEventRecord, status: TimeExpressionReviewStatus) {
    const value = await run(() => window.novelCompiler.reviewTimelineEvent(event.id, status),
      status === 'confirmed' ? '事件已经确认' : status === 'rejected' ? '事件已经排除' : '事件已恢复为待审核');
    if (!value) return;
    setEvents(value);
  }

  async function startEventExtraction() {
    if (!window.confirm('事件抽取会把小说按分析分块发送到已配置的模型 API。是否继续？')) return;
    const value = await run(() => window.novelCompiler.startTimelineEventExtraction({ model: eventModel }), '事件抽取已启动，可在任务中心暂停、恢复或重试');
    if (value?.state === 'completed') await reloadEvents();
  }

  async function consolidateRelations() {
    const value = await run(() => window.novelCompiler.consolidateTimelineRelations(), '时间关系候选已经生成；叙述顺序不会自动当成故事时间');
    if (!value) return;
    await reloadRelations();
  }

  async function reviewTimelineRelation(relation: TimelineRelationRecord, status: TimeExpressionReviewStatus) {
    const resolved = relationChoices[relation.id] ?? relation.effectiveRelation;
    const value = await run(() => window.novelCompiler.reviewTimelineRelation(relation.id, status, status === 'confirmed' ? resolved : undefined),
      status === 'confirmed' ? '事件时间关系已经确认' : status === 'rejected' ? '事件时间关系已经排除' : '事件时间关系已恢复为待审核');
    if (!value) return;
    setRelations(value);
    await reloadRelations();
  }

  async function calculateStateSnapshot() {
    if (!entryEventId) return;
    const value = await run(() => window.novelCompiler.getStoryStateSnapshot(entryEventId), '进入时间的人物状态已经按已确认事实重新计算');
    if (value) setStateSnapshot(value);
  }

  return <section>
    <PageTitle eyebrow="STORY TIME" title="故事时间" description="先识别原文明示的日期、相对时间、时刻和持续时间；模糊表达只记录关系，不会被改写成虚构日期。" />
    <div className="timeline-toolbar panel">
      <div><span>全部表达</span><strong>{summary.totalCount}</strong></div>
      <div><span>待审核</span><strong>{summary.pendingCount}</strong></div>
      <div><span>已确认</span><strong>{summary.confirmedCount}</strong></div>
      <div><span>已规范化</span><strong>{summary.normalizedCount}</strong></div>
      <label><span>审核状态</span><select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="pending">待审核</option><option value="confirmed">已确认</option><option value="rejected">已排除</option><option value="all">全部</option></select></label>
      <button className="button primary" onClick={() => void scan()}>本地扫描时间</button>
    </div>
    <div className="timeline-note panel"><strong>当前边界</strong><p>原文时间证据、候选事件和已审核关系共同形成故事时间偏序；无法由确认关系证明的先后仍保持不确定。</p></div>
    {expressions.length ? <div className="time-expression-list">{expressions.map((expression) => <article className={`panel ${expression.reviewStatus}`} key={expression.id}>
      <header><div><span>{expression.chapterTitle ?? '未分章'} · 段落 {expression.paragraphOrdinal} · 字符 {expression.startOffset}–{expression.endOffset}</span><strong>{expression.surfaceText}</strong></div><small>{timeExpressionLabels[expression.expressionType]} · 置信度 {(expression.confidence * 100).toFixed(0)}%</small></header>
      <label><span>规范时间值</span><input value={normalizedDrafts[expression.id] ?? ''} onChange={(event) => setNormalizedDrafts((current) => ({ ...current, [expression.id]: event.target.value }))} placeholder={expression.expressionType === 'relative' ? '保留相对关系，待事件连接后锚定' : '无法可靠规范化时可以留空'} /></label>
      <footer><span>{expression.detectionMethod === 'rule' ? '本地规则识别' : expression.detectionMethod === 'model' ? '模型识别' : '人工添加'} · {expression.calendarSystem}</span><div><button disabled={expression.reviewStatus === 'confirmed'} onClick={() => void review(expression, 'confirmed')}>确认</button><button disabled={expression.reviewStatus === 'rejected'} onClick={() => void review(expression, 'rejected')}>排除</button>{expression.reviewStatus !== 'pending' && <button onClick={() => void review(expression, 'pending')}>恢复</button>}</div></footer>
    </article>)}</div> : <div className="simple-empty">{summary.totalCount ? '当前筛选条件下没有时间表达。' : '尚未扫描。扫描在本机完成，不调用 API，也不会修改小说原文。'}</div>}
    <div className="timeline-event-heading"><div><p>EVENT EVIDENCE</p><h3>候选事件</h3><span>{eventEstimate?.ready ? `${eventEstimate.chunkCount} 个分块 · 正文粗算 ${(eventEstimate.approximateInputTokens / 1000).toFixed(1)}K Token（不含提示词、输出与重试）` : '请先生成分析分块'}</span></div><div className="timeline-event-run"><label><span>事件模型</span><input value={eventModel} onChange={(event) => setEventModel(event.target.value)} /></label><button className="button primary" disabled={!eventEstimate?.ready || !eventModel.trim() || eventJob?.state === 'running'} onClick={() => void startEventExtraction()}>{eventJob?.state === 'running' ? `抽取中 ${Math.round(eventJob.progress * 100)}%` : events.length ? '按当前方案重新检查' : '提取候选事件'}</button></div></div>
    {events.length ? <div className="timeline-event-layout">
      <div className="timeline-event-list panel">{events.map((event) => <button className={`${event.id === selectedEvent?.id ? 'selected' : ''} ${event.reviewStatus}`} key={event.id} onClick={() => setSelectedEventId(event.id)}><span>{event.chapterTitle ?? '未分章'} · 段落 {event.narrativeStartOrdinal}{event.narrativeEndOrdinal !== event.narrativeStartOrdinal ? `–${event.narrativeEndOrdinal}` : ''}</span><strong>{event.title}</strong><small>{timelineEventTypeLabels[event.eventType]} · {event.evidenceCount} 条证据</small></button>)}</div>
      {selectedEvent && <div className="timeline-event-detail panel"><header><div><span>{timelineEventTypeLabels[selectedEvent.eventType]} · {(selectedEvent.confidence * 100).toFixed(0)}%</span><h3>{selectedEvent.title}</h3></div><div><button disabled={selectedEvent.reviewStatus === 'confirmed'} onClick={() => void reviewEvent(selectedEvent, 'confirmed')}>确认</button><button disabled={selectedEvent.reviewStatus === 'rejected'} onClick={() => void reviewEvent(selectedEvent, 'rejected')}>排除</button>{selectedEvent.reviewStatus !== 'pending' && <button onClick={() => void reviewEvent(selectedEvent, 'pending')}>恢复</button>}</div></header><p>{selectedEvent.summary}</p>{selectedEvent.uncertainty && <small>待核实：{selectedEvent.uncertainty}</small>}<div className="event-entities"><div><strong>参与人物</strong><p>{eventParticipants.length ? eventParticipants.map((item) => `${item.identityName ?? item.surfaceName}${item.actionText ? `（${item.actionText}）` : ''}`).join('、') : '未识别'}</p></div><div><strong>地点</strong><p>{eventLocations.length ? eventLocations.map((item) => item.normalizedName ?? item.surfaceName).join('、') : '未识别'}</p></div></div><div className="event-evidence"><strong>原文证据</strong>{eventEvidence.map((item) => <blockquote key={item.id}><span>{item.chapterTitle ?? '未分章'} · 段落 {item.paragraphOrdinal}</span>{item.exactQuote}<button className="source-span-link" type="button" aria-label="查看事件证据原文" disabled={!item.sourceSpanId} onClick={() => item.sourceSpanId && void openSourceSpan(item.sourceSpanId)}>查看原文</button></blockquote>)}</div></div>}
    </div> : <div className="simple-empty">尚未提取候选事件。点击上方按钮并确认后，程序才会把小说按分块发送到已配置的模型 API。</div>}
    <div className="timeline-relation-heading"><div><p>TEMPORAL GRAPH</p><h3>事件时间关系</h3><span>只有已确认关系进入故事时间排序</span></div><button className="button primary" disabled={events.length < 2} onClick={() => void consolidateRelations()}>生成关系候选</button></div>
    <div className="timeline-graph-metrics panel"><div><span>已确认事件</span><strong>{graphSummary.eventCount}</strong></div><div><span>已确认关系</span><strong>{graphSummary.confirmedRelationCount}</strong></div><div><span>待审核关系</span><strong>{graphSummary.pendingRelationCount}</strong></div><div><span>尚无约束事件</span><strong>{graphSummary.unconstrainedEventCount}</strong></div><div className={graphSummary.hasCycle ? 'danger' : ''}><span>循环状态</span><strong>{graphSummary.hasCycle ? '存在冲突' : '正常'}</strong></div></div>
    {relations.length ? <div className="timeline-relations">{relations.map((relation) => <article className={`panel ${relation.reviewStatus}`} key={relation.id}><div className="timeline-relation-pair"><span><small>段落 {relation.leftNarrativeOrdinal}</small>{relation.leftTitle}</span><b>↔</b><span><small>段落 {relation.rightNarrativeOrdinal}</small>{relation.rightTitle}</span></div><p>建议：{timelineRelationLabels[relation.proposedRelation]} · {(relation.confidence * 100).toFixed(0)}%</p><small>{relation.reason}{relation.exactQuote ? ` · 线索：“${relation.exactQuote}”` : ''}</small><footer><select value={relationChoices[relation.id] ?? relation.effectiveRelation} onChange={(event) => setRelationChoices((current) => ({ ...current, [relation.id]: event.target.value as TimelineRelationKind }))}>{timelineRelationKinds.map((kind) => <option value={kind} key={kind}>{timelineRelationLabels[kind]}</option>)}</select><button disabled={relation.reviewStatus === 'confirmed'} onClick={() => void reviewTimelineRelation(relation, 'confirmed')}>确认</button><button disabled={relation.reviewStatus === 'rejected'} onClick={() => void reviewTimelineRelation(relation, 'rejected')}>排除</button>{relation.reviewStatus !== 'pending' && <button onClick={() => void reviewTimelineRelation(relation, 'pending')}>恢复</button>}</footer></article>)}</div> : <div className="simple-empty">确认至少两个候选事件后，可以生成相邻事件的时间关系候选。</div>}
    {timelineOrder.length > 0 && <div className="timeline-order panel"><div className="panel-heading"><strong>当前故事时间排序</strong><span>同一层级不代表同时；只有同组事件才表示同时</span></div>{timelineOrder.map((item) => <article key={item.eventId} className={item.constrained ? '' : 'unconstrained'}><span>层级 {item.orderLevel} · 组 {item.simultaneousGroup}</span><strong>{item.title}</strong><small>{item.constrained ? '已有确认关系约束' : `仅保留原文观察位置 ${item.narrativeOrdinal}`}</small></article>)}</div>}
    <div className="state-snapshot-heading"><div><p>ENTRY STATE</p><h3>进入时间人物状态</h3><span>选择一个已确认事件，计算进入这个世界时各人物已经处于什么状态</span></div></div>
    <div className="state-snapshot-controls panel">
      <label><span>进入事件</span><select data-testid="snapshot-entry-event" value={entryEventId} onChange={(event) => { setEntryEventId(event.target.value); setStateSnapshot(null); }}><option value="">请选择已确认事件</option>{confirmedEvents.map((event) => <option value={event.id} key={event.id}>段落 {event.narrativeStartOrdinal} · {event.title}</option>)}</select></label>
      <button className="button primary" disabled={!entryEventId} onClick={() => void calculateStateSnapshot()}>计算人物状态</button>
      {stateSnapshot && <div className="state-snapshot-metrics"><span>确定 <strong>{stateSnapshot.resolvedValueCount}</strong> 项</span><span>时间不确定 <strong>{stateSnapshot.ambiguousValueCount}</strong> 项</span></div>}
    </div>
    <div className="timeline-note panel"><strong>解释边界</strong><p>这里只计算故事事实在进入时刻是否已经生效；“公开、私密、秘密”是原有的故事内可见性，不代表某个具体人物一定知道这件事。</p></div>
    {stateSnapshot ? <div className="state-snapshot-list">{stateSnapshot.characters.map((character) => <article className="state-character panel" key={character.identityId}>
      <header><div><span>{tierLabels[character.importanceTier]}</span><h4>{character.identityName}</h4></div><small>{character.resolvedCount} 项确定 · {character.ambiguousCount} 项不确定</small></header>
      {character.values.length ? <div className="state-value-list">{character.values.map((value) => <div className={value.resolution === 'ambiguous' ? 'ambiguous' : ''} key={`${value.category}:${value.predicate}`}><div><span>{value.predicate}</span><strong>{value.value ?? '时间不确定'}</strong></div><small>{value.resolution === 'timeless' ? '当前唯一确认值' : value.resolution === 'effective_after_transition' ? '进入前已经发生变化' : value.resolution === 'effective_before_transition' ? '进入后才会发生变化' : `可能值：${value.alternatives.join(' / ')}`} · {value.visibility === 'public' ? '公开' : value.visibility === 'private' ? '私密' : '秘密'} · {(value.confidence * 100).toFixed(0)}%</small><p>{value.reason}</p></div>)}</div> : <div className="simple-empty">这个人物还没有可用于状态计算的已确认事实。</div>}
    </article>)}</div> : <div className="simple-empty">{confirmedEvents.length ? '选择进入事件后计算；整个过程只读取本地已确认数据，不调用 API。' : '请先确认至少一个候选事件，才能选择进入时间。'}</div>}
    {sourceSpanDialog}
  </section>;
}

function CharacterCardsView({ run }: { run: RunHelper }) {
  const [characters, setCharacters] = useState<CharacterCandidate[]>([]);
  const [events, setEvents] = useState<TimelineEventRecord[]>([]);
  const [selectedIdentityId, setSelectedIdentityId] = useState('');
  const [entryEventId, setEntryEventId] = useState('');
  const [draft, setDraft] = useState<CharacterCardDraftRecord | null>(null);
  const [dirty, setDirty] = useState(false);
  const [lastExport, setLastExport] = useState('');
  const [refineModel, setRefineModel] = usePreferredModel();
  const [refinement, setRefinement] = useState<CharacterCardRefinementRecord | null>(null);
  const [refineFields, setRefineFields] = useState<CharacterCardRefineField[]>(['description', 'personality', 'scenario', 'firstMes', 'mesExample']);
  const [batchItems, setBatchItems] = useState<CharacterCardBatchItem[]>([]);
  const [batchSummary, setBatchSummary] = useState<CharacterCardBatchGenerationSummary | null>(null);
  const [runtimeQuestion, setRuntimeQuestion] = useState('');
  const [runtimeSessions, setRuntimeSessions] = useState<CharacterRuntimeSessionRecord[]>([]);
  const [activeRuntimeSessionId, setActiveRuntimeSessionId] = useState('');
  const [runtimeTurns, setRuntimeTurns] = useState<CharacterRuntimeTurnRecord[]>([]);
  const [runtimeNotice, setRuntimeNotice] = useState('');
  const [runtimeRetrievalEnabled, setRuntimeRetrievalEnabled] = useState(true);
  const activeRuntimeSession = useMemo(
    () => runtimeSessions.find((session) => session.id === activeRuntimeSessionId && session.status === 'active') ?? null,
    [runtimeSessions, activeRuntimeSessionId],
  );
  const effectiveRuntimeRetrieval = activeRuntimeSession
    ? activeRuntimeSession.retrievalMode === 'explainable-v1'
    : runtimeRetrievalEnabled;
  const confirmedCharacters = useMemo(() => characters.filter((character) => character.reviewStatus === 'confirmed'), [characters]);
  const confirmedEvents = useMemo(() => events.filter((event) => event.reviewStatus === 'confirmed'), [events]);

  useEffect(() => {
    void Promise.all([window.novelCompiler.listCharacters(), window.novelCompiler.listTimelineEvents(), window.novelCompiler.getCharacterCardBatchStatus()]).then(([nextCharacters, nextEvents, nextBatchItems]) => {
      setCharacters(nextCharacters); setEvents(nextEvents);
      setBatchItems(nextBatchItems);
      const usableCharacters = nextCharacters.filter((character) => character.reviewStatus === 'confirmed');
      const usableEvents = nextEvents.filter((event) => event.reviewStatus === 'confirmed');
      setSelectedIdentityId((current) => usableCharacters.some((character) => character.id === current) ? current : usableCharacters[0]?.id ?? '');
      setEntryEventId((current) => usableEvents.some((event) => event.id === current) ? current : usableEvents[0]?.id ?? '');
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let current = true;
    setLastExport('');
    if (!selectedIdentityId) {
      setDraft(null); setRuntimeSessions([]); setActiveRuntimeSessionId(''); setRuntimeTurns([]);
      return () => { current = false; };
    }
    void Promise.all([
      window.novelCompiler.getCharacterCardDraft(selectedIdentityId),
      window.novelCompiler.getLatestCharacterCardRefinement(selectedIdentityId),
      window.novelCompiler.listCharacterRuntimeTurns(selectedIdentityId, 10),
      window.novelCompiler.listCharacterRuntimeSessions(selectedIdentityId, 10),
    ]).then(async ([value, latestRefinement, recentTurns, sessions]) => {
      const activeSession = sessions.find((session) => session.status === 'active') ?? null;
      const turns = activeSession
        ? await window.novelCompiler.listCharacterRuntimeSessionTurns(activeSession.id, 20).catch(() => recentTurns)
        : recentTurns;
      if (!current) return;
      setDraft(value); setDirty(false);
      setRefinement(latestRefinement?.status === 'pending' ? latestRefinement : null);
      setRuntimeSessions(sessions); setActiveRuntimeSessionId(activeSession?.id ?? '');
      setRuntimeTurns(turns); setRuntimeNotice('');
      if (value) setEntryEventId(value.entryEventId);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [selectedIdentityId]);

  function updateField<K extends keyof CharacterCardDraftFields>(key: K, value: CharacterCardDraftFields[K]) {
    if (!draft) return;
    setDraft({ ...draft, [key]: value, reviewStatus: 'draft' });
    setDirty(true); setLastExport('');
  }

  async function generate() {
    if (!selectedIdentityId || !entryEventId) return;
    if (draft && !window.confirm('重新生成会覆盖当前人物已保存和未保存的角色卡内容。是否继续？')) return;
    const value = await run(() => window.novelCompiler.generateCharacterCardDraft(selectedIdentityId, entryEventId),
      '角色卡草稿已由本地确认数据生成，请人工检查后再导出');
    if (value) {
      setDraft(value); setDirty(false); setLastExport(''); setRefinement(null);
      setBatchItems(await window.novelCompiler.getCharacterCardBatchStatus());
    }
  }

  async function save(reviewStatus: 'draft' | 'reviewed') {
    if (!draft) return;
    const fields: CharacterCardDraftFields = {
      description: draft.description, personality: draft.personality, scenario: draft.scenario,
      firstMes: draft.firstMes, mesExample: draft.mesExample, creatorNotes: draft.creatorNotes,
      systemPrompt: draft.systemPrompt, postHistoryInstructions: draft.postHistoryInstructions,
      alternateGreetings: draft.alternateGreetings, tags: draft.tags, creator: draft.creator,
      characterVersion: draft.characterVersion,
    };
    const value = await run(() => window.novelCompiler.saveCharacterCardDraft(draft.identityId, fields, reviewStatus),
      reviewStatus === 'reviewed' ? '角色卡已保存并标记为已审阅，可以导出' : '角色卡草稿已经保存');
    if (value) { setDraft(value); setDirty(false); setBatchItems(await window.novelCompiler.getCharacterCardBatchStatus()); }
  }

  async function exportJson() {
    if (!draft) return;
    const value = await run(() => window.novelCompiler.exportCharacterCardJson(draft.identityId));
    if (value) setLastExport(`已导出：${value.outputPath} · SHA256 ${value.checksum.slice(0, 12)}…`);
  }

  async function requestRefinement() {
    if (!draft || dirty || draft.reviewStatus !== 'reviewed' || !refineModel.trim()) return;
    if (!window.confirm('模型润色会发送当前人物的已确认事实摘要、最多 12 条已确认对白、进入事件和已审阅草稿。不会发送整本小说。是否继续？')) return;
    const value = await run(() => window.novelCompiler.refineCharacterCard(draft.identityId, refineModel.trim()),
      '模型润色建议已返回；不会自动覆盖草稿，请逐字段比较后选择');
    if (value) {
      setRefinement(value);
      setRefineFields(['description', 'personality', 'scenario', 'firstMes', 'mesExample']);
    }
  }

  async function reviewRefinement(action: 'apply' | 'reject') {
    if (!refinement) return;
    const value = await run(() => window.novelCompiler.reviewCharacterCardRefinement(refinement.id, action, action === 'apply' ? refineFields : undefined),
      action === 'apply' ? '选中的模型建议已应用；角色卡已恢复为待审阅' : '本次模型润色建议已排除');
    if (value) {
      setDraft(value.draft); setDirty(false); setRefinement(null);
      setBatchItems(await window.novelCompiler.getCharacterCardBatchStatus());
    }
  }

  async function generateMissingDrafts() {
    if (!entryEventId) return;
    if (!window.confirm('将为所有已确认的核心人物和重要人物补齐缺失草稿。已有草稿不会被覆盖，且不会调用模型。是否继续？')) return;
    const value = await run(() => window.novelCompiler.generateMissingCharacterCardDrafts(entryEventId), '核心/重要人物批量草稿检查完成');
    if (!value) return;
    setBatchSummary(value);
    setBatchItems(await window.novelCompiler.getCharacterCardBatchStatus());
    if (selectedIdentityId) {
      const nextDraft = await window.novelCompiler.getCharacterCardDraft(selectedIdentityId);
      if (nextDraft) { setDraft(nextDraft); setDirty(false); }
    }
  }

  async function exportReviewedBatch() {
    const value = await run(() => window.novelCompiler.exportReviewedCharacterCards());
    if (value) setLastExport(`已批量导出 ${value.exportedCount} 张角色卡到 ${value.outputDirectory}`);
  }

  async function askCharacter() {
    if (!draft || dirty || draft.reviewStatus !== 'reviewed' || !runtimeQuestion.trim() || !(activeRuntimeSession?.model || refineModel.trim())) return;
    const session = activeRuntimeSession;
    const historyNotice = session
      ? `还会带上本会话最近最多 ${session.maxHistoryTurns} 个已放行问答；阻断和失败候选不会发送。`
      : '这是独立单轮，不携带其他试聊记录。';
    const retrievalNotice = effectiveRuntimeRetrieval
      ? '本轮会先在本地按进入点过滤，再附加不超过约 600 Token 的可解释检索资料。'
      : '本轮关闭按需检索，只使用固定角色资料。';
    if (!window.confirm(`本次安全试聊会向当前模型发送已审阅角色卡、当前进入点资料和你的问题。${historyNotice}${retrievalNotice}通常调用 1 次；首个候选被本地输出门拦截时最多再调用 1 次，因此可能产生 1–2 次 API 费用。是否继续？`)) return;
    const value = await run(
      () => session
        ? window.novelCompiler.askCharacterInSession(session.id, runtimeQuestion.trim())
        : window.novelCompiler.askCharacter(draft.identityId, runtimeQuestion.trim(), refineModel.trim(), effectiveRuntimeRetrieval ? 'explainable-v1' : 'off'),
      '安全试聊已经完成并写入本地审计记录',
    );
    const nextTurns = session
      ? await window.novelCompiler.listCharacterRuntimeSessionTurns(session.id, 20).catch(() => runtimeTurns)
      : await window.novelCompiler.listCharacterRuntimeTurns(draft.identityId, 10).catch(() => runtimeTurns);
    setRuntimeTurns(nextTurns);
    setRuntimeSessions(await window.novelCompiler.listCharacterRuntimeSessions(draft.identityId, 10).catch(() => runtimeSessions));
    if (!value) return;
    setRuntimeQuestion('');
    setRuntimeNotice(value.status === 'delivered'
      ? value.attempts === 2 ? '首个候选被拦截，受限重写通过后才显示。' : '首个候选通过本地输出门。'
      : value.status === 'blocked' ? '两次候选均未通过；回答没有展示，详情已保存在本地审计记录中。'
        : value.error ?? '本次调用失败。');
  }

  async function createRuntimeSession() {
    if (!draft || dirty || draft.reviewStatus !== 'reviewed' || !refineModel.trim() || activeRuntimeSession) return;
    const value = await run(
      () => window.novelCompiler.createCharacterRuntimeSession(
        draft.identityId, refineModel.trim(), runtimeRetrievalEnabled ? 'explainable-v1' : 'off',
      ),
      '短会话已建立；模型、角色卡和进入点已经锁定',
    );
    if (!value) return;
    setRuntimeSessions([value, ...runtimeSessions.filter((session) => session.id !== value.id)]);
    setActiveRuntimeSessionId(value.id);
    setRuntimeTurns([]);
    setRuntimeNotice('这是短会话第一轮；最多回放最近 6 个已放行问答，聊天不会写回原作事实。');
  }

  async function closeRuntimeSession() {
    if (!draft || !activeRuntimeSession) return;
    const value = await run(
      () => window.novelCompiler.closeCharacterRuntimeSession(activeRuntimeSession.id),
      '短会话已经结束并保留本地审计记录',
    );
    if (!value) return;
    setRuntimeSessions(runtimeSessions.map((session) => session.id === value.id ? value : session));
    setActiveRuntimeSessionId('');
    setRuntimeTurns(await window.novelCompiler.listCharacterRuntimeTurns(draft.identityId, 10).catch(() => runtimeTurns));
    setRuntimeNotice('短会话已结束。可以开始新会话，旧内容不会自动带入。');
  }

  return <section>
    <PageTitle eyebrow="CHARACTER CARD V2" title="角色卡制作" description="把已确认的人物事实、对白风格和进入时间状态整理成可直接导入 SillyTavern 的 V2 JSON；自动稿必须人工审阅。" />
    <div className="card-workbench-toolbar panel">
      <label><span>确认人物</span><select value={selectedIdentityId} onChange={(event) => setSelectedIdentityId(event.target.value)}><option value="">请选择人物</option>{confirmedCharacters.map((character) => <option value={character.id} key={character.id}>{character.canonicalName} · {tierLabels[character.importanceTier]}</option>)}</select></label>
      <label><span>进入事件</span><select value={entryEventId} onChange={(event) => setEntryEventId(event.target.value)}><option value="">请选择已确认事件</option>{confirmedEvents.map((event) => <option value={event.id} key={event.id}>段落 {event.narrativeStartOrdinal} · {event.title}</option>)}</select></label>
      <button className="button primary" disabled={!selectedIdentityId || !entryEventId} onClick={() => void generate()}>{draft ? '重新生成草稿' : '生成角色卡草稿'}</button>
    </div>
    <div className="timeline-note panel"><strong>格式与安全</strong><p>导出采用 Character Card V2 JSON。system prompt 默认留空，不覆盖你的酒馆全局设置；自动稿只使用已确认的本地数据，不会调用 API。</p></div>
    <div className="card-batch-dashboard panel"><header><div><span>PHASE 1 COMPLETION</span><h3>核心/重要人物成品盘点</h3></div><div><button className="button ghost" disabled={!entryEventId || !batchItems.length} onClick={() => void generateMissingDrafts()}>批量补齐缺失草稿</button><button className="button primary" disabled={!batchItems.some((item) => item.exportReady)} onClick={() => void exportReviewedBatch()}>批量导出已就绪卡片</button></div></header><div className="card-batch-metrics"><div><span>目标人物</span><strong>{batchItems.length}</strong></div><div><span>已有草稿</span><strong>{batchItems.filter((item) => item.hasDraft).length}</strong></div><div><span>已经审阅</span><strong>{batchItems.filter((item) => item.reviewStatus === 'reviewed').length}</strong></div><div><span>达到质量门槛</span><strong>{batchItems.filter((item) => item.quality?.contentReady).length}</strong></div><div><span>可批量导出</span><strong>{batchItems.filter((item) => item.exportReady).length}</strong></div></div>{batchItems.length > 0 && <div className="card-batch-list">{batchItems.map((item) => <button className={item.identityId === selectedIdentityId ? 'selected' : ''} key={item.identityId} onClick={() => setSelectedIdentityId(item.identityId)}><div><strong>{item.identityName}</strong><span>{tierLabels[item.importanceTier]} · {item.confirmedFactCount} 条确认事实</span></div><div className={`quality-grade grade-${item.quality?.grade ?? 'none'}`}>{item.quality ? `${item.quality.grade} · ${item.quality.score}` : '未生成'}</div><small>{item.exportReady ? '已就绪' : item.reviewStatus === 'reviewed' ? '质量项待处理' : item.reviewStatus === 'draft' ? '等待审阅' : '缺少草稿'}</small></button>)}</div>}{batchSummary && <div className="batch-summary">本次目标 {batchSummary.targetCount} 人：新生成 {batchSummary.generatedCount}，保留已有 {batchSummary.skippedCount}，失败 {batchSummary.failedCount}{batchSummary.failedCount ? `。${batchSummary.results.filter((item) => item.status === 'failed').map((item) => `${item.identityName}：${item.message}`).join('；')}` : ''}</div>}</div>
    {!confirmedCharacters.length ? <div className="simple-empty">请先在“人物普查”中确认至少一个人物。</div>
      : !confirmedEvents.length ? <div className="simple-empty">请先在“故事时间”中确认至少一个进入事件。</div>
        : !draft ? <div className="simple-empty">选择人物和进入事件后生成草稿。尚未生成的内容不会写入工程。</div>
          : <div className="card-editor">
            <div className="card-source-strip panel"><div><span>人物</span><strong>{draft.identityName}</strong></div><div><span>进入点</span><strong>{draft.entryEventTitle}</strong></div><div><span>确认事实</span><strong>{draft.sourceSummary.confirmedFactCount}</strong></div><div><span>状态</span><strong>{draft.sourceSummary.resolvedStateCount} 确定 / {draft.sourceSummary.ambiguousStateCount} 不确定</strong></div><div><span>对白样本</span><strong>{draft.sourceSummary.quoteSampleCount}</strong></div><div><span>质量 / 审核</span><strong className={draft.reviewStatus === 'reviewed' && !dirty ? 'ready' : ''}>{batchItems.find((item) => item.identityId === draft.identityId)?.quality ? `${batchItems.find((item) => item.identityId === draft.identityId)!.quality!.grade} · ${batchItems.find((item) => item.identityId === draft.identityId)!.quality!.score} / ` : ''}{draft.reviewStatus === 'reviewed' && !dirty ? '已审阅' : '待审阅'}</strong></div></div>
            {batchItems.find((item) => item.identityId === draft.identityId)?.quality?.issues.length ? <div className="card-quality-issues panel"><strong>质量检查</strong>{batchItems.find((item) => item.identityId === draft.identityId)!.quality!.issues.map((issue) => <span className={issue.severity} key={issue.code}>{issue.message}</span>)}</div> : null}
            <div className="card-refine-toolbar panel"><div><span>证据约束润色</span><p>只上传这个人物的确认摘要和已审阅草稿；模型建议不会直接覆盖。</p></div><label><span>润色模型</span><input value={refineModel} onChange={(event) => setRefineModel(event.target.value)} /></label><button className="button primary" disabled={dirty || draft.reviewStatus !== 'reviewed' || !refineModel.trim()} onClick={() => void requestRefinement()}>请求模型润色建议</button></div>
            <div className="character-runtime panel">
              <header><div><span>SAFE CHARACTER RUNTIME · V3</span><h3>单人物安全试聊</h3><p>固定在“{draft.entryEventTitle}”，可独立单轮，也可开启只回放已放行内容的短会话。</p></div><div className="runtime-policy-badges"><b>时间点锁定</b><b>边界前置检索</b><b>仅 6 轮短历史</b><b>不写回原作</b></div></header>
              <div className={'runtime-session-bar ' + (activeRuntimeSession ? 'active' : 'idle')}><div><span>{activeRuntimeSession ? 'ACTIVE SHORT SESSION' : 'SINGLE TURN MODE'}</span><strong>{activeRuntimeSession ? `连续会话 · ${activeRuntimeSession.model}` : '当前为独立单轮'}</strong><small>{activeRuntimeSession ? `已放行 ${activeRuntimeSession.deliveredTurnCount} / 共 ${activeRuntimeSession.turnCount} 轮 · 最近 ${activeRuntimeSession.maxHistoryTurns} 个已放行问答 · 检索${activeRuntimeSession.retrievalMode === 'explainable-v1' ? '已锁定开启' : '已锁定关闭'}` : `已有 ${runtimeSessions.filter((session) => session.status === 'closed').length} 个已结束会话；单轮之间互不引用`}</small></div><div>{activeRuntimeSession ? <button className="button ghost" onClick={() => void closeRuntimeSession()}>结束短会话</button> : <button className="button ghost" disabled={dirty || draft.reviewStatus !== 'reviewed' || !refineModel.trim()} onClick={() => void createRuntimeSession()}>开始短会话</button>}</div></div>
              <div className={'runtime-retrieval-control ' + (effectiveRuntimeRetrieval ? 'enabled' : 'disabled')}><label><input type="checkbox" checked={effectiveRuntimeRetrieval} disabled={Boolean(activeRuntimeSession)} onChange={(event) => setRuntimeRetrievalEnabled(event.target.checked)} /><span>按需检索 B 组</span></label><small>{activeRuntimeSession ? '会话建立后模式锁定，避免中途改变实验条件。' : '先排除进入点之后的资料，再从确认事实、人物关系、地点和原文中召回；每轮约 600 Token。'}</small><b>{effectiveRuntimeRetrieval ? 'BOUNDARY → RETRIEVE' : 'STATIC BASELINE'}</b></div>
              <div className="runtime-compose"><textarea value={runtimeQuestion} onChange={(event) => setRuntimeQuestion(event.target.value)} maxLength={2000} placeholder={draft.reviewStatus === 'reviewed' && !dirty ? '对' + draft.identityName + '说点什么……' : '请先保存并标记角色卡为已审阅'} /><div><small>{runtimeQuestion.length} / 2000 字 · 使用模型 {activeRuntimeSession?.model || refineModel || '未填写'}{activeRuntimeSession ? ' · 会话模型已锁定' : ''}</small><button className="button primary" disabled={dirty || draft.reviewStatus !== 'reviewed' || !runtimeQuestion.trim() || !(activeRuntimeSession?.model || refineModel.trim())} onClick={() => void askCharacter()}>发送并执行安全检查</button></div></div>
              {runtimeNotice && <div className="runtime-notice">{runtimeNotice}</div>}
              {runtimeTurns.length ? <div className="runtime-turns">{runtimeTurns.map((turn) => <article className={'runtime-turn ' + turn.status} key={turn.id}><div className="runtime-question"><span>你</span><p>{turn.question}</p></div><div className="runtime-answer"><span>{turn.identityName}</span>{turn.status === 'delivered' ? <p>{turn.deliveredAnswer}</p> : turn.status === 'blocked' ? <p className="blocked-copy">回答已由本地输出门扣留：{turn.gate?.violations.map((item) => item.message).join('；') || '候选未通过认知边界'}</p> : turn.status === 'failed' ? <p className="blocked-copy">调用失败：{turn.error}</p> : <p>正在准备……</p>}</div>{turn.retrieval && <details className="runtime-retrieval-trace"><summary><span>RETRIEVAL TRACE</span><strong>{turn.retrieval.items.length} 条进入上下文 · 约 {turn.retrieval.approxTokens} / {turn.retrieval.budgetTokens} Token</strong><small>候选 {turn.retrieval.candidateCount} · 预算省略 {turn.retrieval.omittedCount}</small></summary><div>{turn.retrieval.items.length ? turn.retrieval.items.map((item) => <article key={`${item.kind}:${item.sourceId}`}><header><b>{String(item.rank).padStart(2, '0')}</b><div><strong>{item.title}</strong><small>{item.kind.toUpperCase()} · {item.sourceOrdinal === null ? '结构化资料' : `段落 ${item.sourceOrdinal}`} · ≈{item.approxTokens} Token</small></div></header><p>{item.content}</p><footer>{item.reason}{item.matchedTerms.length ? ` · 命中：${item.matchedTerms.join(' / ')}` : ''}</footer></article>) : <p className="runtime-retrieval-empty">本轮没有符合边界和预算的补充资料。</p>}</div></details>}<footer>{turn.sessionId && <span>会话第 {turn.turnIndex} 轮</span>}<span>{turn.model}</span><span>{turn.retrievalMode === 'explainable-v1' ? '按需检索 B' : '固定资料 A'}</span><span>{turn.attempts} 次调用</span><span>输入 {turn.inputTokens} / 输出 {turn.outputTokens} Token</span><span>{'SHA ' + turn.contextFingerprint.slice(0, 10) + '…'}</span></footer></article>)}</div> : <div className="runtime-empty">{activeRuntimeSession ? '短会话已建立，尚未发送第一句话。' : '尚无试聊记录。试聊不会修改角色卡、事实或审核状态。'}</div>}
            </div>
            <div className="card-field-grid">
              <label className="panel"><span>DESCRIPTION · 人物定义</span><textarea value={draft.description} onChange={(event) => updateField('description', event.target.value)} /></label>
              <label className="panel"><span>PERSONALITY · 性格与语言</span><textarea value={draft.personality} onChange={(event) => updateField('personality', event.target.value)} /></label>
              <label className="panel"><span>SCENARIO · 进入场景</span><textarea value={draft.scenario} onChange={(event) => updateField('scenario', event.target.value)} /></label>
              <label className="panel"><span>FIRST MESSAGE · 开场白</span><textarea value={draft.firstMes} onChange={(event) => updateField('firstMes', event.target.value)} /></label>
              <label className="panel wide"><span>EXAMPLE MESSAGES · 已确认对白样本</span><textarea value={draft.mesExample} onChange={(event) => updateField('mesExample', event.target.value)} /></label>
              <label className="panel"><span>CREATOR NOTES · 使用说明</span><textarea value={draft.creatorNotes} onChange={(event) => updateField('creatorNotes', event.target.value)} /></label>
              <label className="panel"><span>ALTERNATE GREETINGS · 用 --- 分隔</span><textarea value={draft.alternateGreetings.join('\n---\n')} onChange={(event) => updateField('alternateGreetings', event.target.value ? event.target.value.split(/\n---\n/gu) : [])} /></label>
              <label className="panel"><span>TAGS · 用中文逗号或英文逗号分隔</span><input value={draft.tags.join('，')} onChange={(event) => updateField('tags', [...new Set(event.target.value.split(/[，,]/gu).map((item) => item.trim()).filter(Boolean))])} /></label>
              <label className="panel"><span>版本</span><input value={draft.characterVersion} onChange={(event) => updateField('characterVersion', event.target.value)} /></label>
              <details className="panel card-advanced"><summary>高级提示字段（默认留空）</summary><label><span>SYSTEM PROMPT</span><textarea value={draft.systemPrompt} onChange={(event) => updateField('systemPrompt', event.target.value)} /></label><label><span>POST-HISTORY INSTRUCTIONS</span><textarea value={draft.postHistoryInstructions} onChange={(event) => updateField('postHistoryInstructions', event.target.value)} /></label></details>
            </div>
            {refinement && <div className="card-refinement panel"><header><div><span>MODEL SUGGESTION</span><h3>逐字段润色对照</h3></div><small>{refinement.model} · 输入 {refinement.inputTokens} / 输出 {refinement.outputTokens} Token</small></header>{refinement.changeSummary.length > 0 && <p>{refinement.changeSummary.join('；')}</p>}{refinement.warnings.length > 0 && <div className="refinement-warning">模型自报提醒：{refinement.warnings.join('；')}</div>}<div className="refinement-fields">{([
              ['description', '人物定义'], ['personality', '性格与语言'], ['scenario', '进入场景'], ['firstMes', '开场白'], ['mesExample', '对白示例'],
            ] as Array<[CharacterCardRefineField, string]>).map(([field, label]) => <article key={field}><label><input type="checkbox" checked={refineFields.includes(field)} onChange={(event) => setRefineFields((current) => event.target.checked ? [...new Set([...current, field])] : current.filter((item) => item !== field))} />采用“{label}”建议</label><div><section><span>当前已审阅稿</span><pre>{refinement.original[field]}</pre></section><section><span>模型建议稿</span><pre>{refinement.proposed[field]}</pre><small>来源：{refinement.sourceKeys[field].join('、')}</small></section></div></article>)}</div><footer><button className="button ghost" onClick={() => void reviewRefinement('reject')}>排除整次建议</button><button className="button primary" disabled={!refineFields.length} onClick={() => void reviewRefinement('apply')}>应用所选字段</button></footer></div>}
            <div className="card-editor-actions panel"><span>{dirty ? '有未保存修改' : draft.reviewStatus === 'reviewed' ? '当前版本已经人工审阅' : '当前版本仍是草稿'}</span><div><button className="button ghost" onClick={() => void save('draft')}>保存草稿</button><button className="button ghost" onClick={() => void save('reviewed')}>保存并标记已审阅</button><button className="button primary" disabled={dirty || draft.reviewStatus !== 'reviewed'} onClick={() => void exportJson()}>导出 V2 JSON</button></div></div>
            {lastExport && <div className="card-export-result panel">{lastExport}</div>}
          </div>}
  </section>;
}

function SearchView({ run }: { run: RunHelper }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = await run(() => window.novelCompiler.search(query));
    if (value) setHits(value);
  }
  return <section>
    <PageTitle eyebrow="SOURCE EVIDENCE" title="原文检索" description="搜索结果直接定位稳定段落，是后续每条人物、事件和地点结论的证据入口。" />
    <form className="search-bar" onSubmit={(event) => void submit(event)}><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入人物、地点、物品或原文片段…" /><button className="button primary">检索原文</button></form>
    <div className="search-results">{hits.map((hit) => <article className="panel" key={hit.paragraphId}><div><span>段落 {hit.ordinal}</span><strong>{hit.chapterTitle ?? '未分章'}</strong></div><p>{hit.snippet}</p><small>{hit.paragraphId}</small></article>)}</div>
    {query && hits.length === 0 && <div className="simple-empty">输入关键词后检索；尚无结果。</div>}
  </section>;
}

const placeTypeLabels: Record<PlaceType, string> = {
  realm: '世界 / 位面', region: '地域', country: '国家 / 政权', city: '城市', settlement: '聚落', district: '城区 / 分区',
  route: '道路 / 航线', natural: '自然地貌', building: '建筑', room: '房间', landmark: '地标', other: '待分类',
};

function PlacesWorkbench({ run, jobs }: { run: RunHelper; jobs: JobRecord[] }) {
  const [filter, setFilter] = useState<PlaceReviewStatus | 'all'>('pending');
  const [places, setPlaces] = useState<PlaceRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [mentions, setMentions] = useState<PlaceMentionRecord[]>([]);
  const [aliases, setAliases] = useState<PlaceAliasRecord[]>([]);
  const [allPlaces, setAllPlaces] = useState<PlaceRecord[]>([]);
  const [links, setLinks] = useState<PlaceIdentityLinkRecord[]>([]);
  const [operations, setOperations] = useState<PlaceIdentityOperationRecord[]>([]);
  const [selectedMentionIds, setSelectedMentionIds] = useState<string[]>([]);
  const [mergeTargetId, setMergeTargetId] = useState('');
  const [splitName, setSplitName] = useState('');
  const [draftName, setDraftName] = useState('');
  const [draftType, setDraftType] = useState<PlaceType>('other');
  const [lastBootstrap, setLastBootstrap] = useState<PlaceBootstrapSummary | null>(null);
  const [scanEstimate, setScanEstimate] = useState<PlaceModelScanEstimate | null>(null);
  const [model, setModel] = usePreferredModel('');
  const [relationCandidates, setRelationCandidates] = useState<PlaceRelationCandidateRecord[]>([]);
  const [formalRelations, setFormalRelations] = useState<PlaceRelationRecord[]>([]);
  const [selectedRelationId, setSelectedRelationId] = useState('');
  const [suggestionEvidence, setSuggestionEvidence] = useState<PlaceSuggestionEvidenceRecord[]>([]);
  const [suggestionTitle, setSuggestionTitle] = useState('');
  const [relationSuggestion, setRelationSuggestion] = useState<PlaceRelationModelSuggestionRecord | null>(null);
  const { openSourceSpan, sourceSpanDialog } = useSourceSpanInspector(run);
  const selected = places.find((place) => place.id === selectedId) ?? places[0] ?? null;
  const placeScanJob = jobs.find((job) => job.type === 'place-model-scan');

  const refresh = useCallback(async (showBusy = true) => {
    const load = () => Promise.all([
      window.novelCompiler.listPlaces(filter === 'all' ? undefined : filter),
      window.novelCompiler.listPlaces(),
      window.novelCompiler.listPlaceIdentityOperations(),
      window.novelCompiler.estimatePlaceModelScan(),
      window.novelCompiler.listPlaceRelationCandidates(),
      window.novelCompiler.listPlaceRelations(),
    ]);
    const result = showBusy ? await run(load) : await load();
    if (result) {
      const [next, everyPlace, nextOperations, nextEstimate, nextRelations, nextFormalRelations] = result;
      setPlaces(next);
      setAllPlaces(everyPlace);
      setOperations(nextOperations);
      setScanEstimate(nextEstimate);
      setRelationCandidates(nextRelations);
      setFormalRelations(nextFormalRelations);
      setSelectedRelationId((current) => nextRelations.some((candidate) => candidate.id === current) ? current : nextRelations[0]?.id ?? '');
      setSelectedId((current) => next.some((place) => place.id === current) ? current : next[0]?.id ?? '');
    }
  }, [filter, run]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (placeScanJob?.state === 'completed') void refresh(false); }, [placeScanJob?.state, placeScanJob?.updatedAt, refresh]);
  useEffect(() => {
    if (!selected) {
      setMentions([]);
      setAliases([]);
      setLinks([]);
      setSelectedMentionIds([]);
      return;
    }
    setDraftName(selected.canonicalName);
    setDraftType(selected.placeType);
    setSplitName('');
    setSelectedMentionIds([]);
    void run(() => Promise.all([
      window.novelCompiler.listPlaceMentions(selected.id),
      window.novelCompiler.listPlaceAliases(selected.id),
      window.novelCompiler.listPlaceIdentityLinks(selected.id),
    ])).then((value) => {
      if (!value) return;
      setMentions(value[0]);
      setAliases(value[1]);
      setLinks(value[2]);
    });
  }, [selected?.id, run]);

  useEffect(() => {
    const available = allPlaces.filter((place) => place.id !== selected?.id && place.reviewStatus !== 'rejected');
    setMergeTargetId((current) => available.some((place) => place.id === current) ? current : available[0]?.id ?? '');
  }, [allPlaces, selected?.id]);

  async function bootstrap() {
    const summary = await run(() => window.novelCompiler.bootstrapPlacesFromEvents());
    if (!summary) return;
    setLastBootstrap(summary);
    await refresh();
  }

  async function review(status: PlaceReviewStatus) {
    if (!selected) return;
    const updated = await run(() => window.novelCompiler.reviewPlace(selected.id, {
      status, placeType: draftType, canonicalName: draftName,
    }), status === 'confirmed' ? '地点与原文提及已经确认' : status === 'rejected' ? '地点候选已经排除' : '地点候选已恢复待审核');
    if (!updated) return;
    const visible = filter === 'all' ? updated : updated.filter((place) => place.reviewStatus === filter);
    setPlaces(visible);
    setSelectedId(visible.some((place) => place.id === selected.id) ? selected.id : visible[0]?.id ?? '');
    setAllPlaces(updated);
    setScanEstimate(await window.novelCompiler.estimatePlaceModelScan());
  }

  async function reviewAlias(aliasId: string, status: PlaceReviewStatus) {
    const next = await run(() => window.novelCompiler.reviewPlaceAlias(aliasId, status), '地点别名审核状态已更新');
    if (next) {
      setAliases(next);
      const nextOperations = await window.novelCompiler.listPlaceIdentityOperations();
      setOperations(nextOperations);
    }
  }

  async function mergeSelected() {
    if (!selected || !mergeTargetId) return;
    const target = allPlaces.find((place) => place.id === mergeTargetId);
    if (!target || !window.confirm(`确认把“${selected.canonicalName}”合并到“${target.canonicalName}”？原地点会被排除，但可以撤销。`)) return;
    const result = await run(() => window.novelCompiler.mergePlaces(selected.id, target.id), '地点已经合并；原地点保留为可撤销记录');
    if (result) await refresh(false);
  }

  async function markDifferent() {
    if (!selected || !mergeTargetId) return;
    const result = await run(() => window.novelCompiler.linkPlaces(selected.id, mergeTargetId, 'cannot_link', '用户在地点审核台确认这是两个不同地点'), '已建立“不同地点”约束，后续不能误合并');
    if (result) {
      setLinks(result.filter((link) => link.leftPlaceId === selected.id || link.rightPlaceId === selected.id));
      setOperations(await window.novelCompiler.listPlaceIdentityOperations());
    }
  }

  async function splitSelected() {
    if (!selected) return;
    const result = await run(() => window.novelCompiler.splitPlace(selected.id, selectedMentionIds, splitName), '已按所选原文证据拆出新地点，并建立“不同地点”约束');
    if (result) await refresh(false);
  }

  async function undoIdentityOperation() {
    const result = await run(() => window.novelCompiler.undoPlaceIdentityOperation(), '最近一次地点身份操作已经撤销');
    if (result) await refresh(false);
  }

  async function startModelScan() {
    if (!model.trim() || !scanEstimate?.ready) return;
    if (!window.confirm(`模型将读取 ${scanEstimate.chunkCount} 个分析分块并生成待审核建议，确认使用“${model.trim()}”开始？`)) return;
    const result = await run(() => window.novelCompiler.startPlaceModelScan({ model: model.trim(), promptVersion: 'place-model.v1' }), '地点模型扫描已启动；结果不会自动确认');
    if (result?.state === 'completed') await refresh(false);
  }

  async function inspectAlias(alias: PlaceAliasRecord) {
    const evidence = await run(() => window.novelCompiler.listPlaceAliasEvidence(alias.id));
    if (evidence) { setSuggestionTitle(`别名建议 · ${alias.alias}`); setSuggestionEvidence(evidence); setRelationSuggestion(null); }
  }

  async function inspectLink(link: PlaceIdentityLinkRecord) {
    const evidence = await run(() => window.novelCompiler.listPlaceIdentityLinkEvidence(link.id));
    if (evidence) { setSuggestionTitle(`身份建议 · ${link.leftName} / ${link.rightName}`); setSuggestionEvidence(evidence); setRelationSuggestion(null); }
  }

  async function reviewLink(linkId: string, status: PlaceReviewStatus) {
    const next = await run(() => window.novelCompiler.reviewPlaceIdentityLink(linkId, status), '地点身份建议审核状态已更新');
    if (next && selected) setLinks(next.filter((link) => link.leftPlaceId === selected.id || link.rightPlaceId === selected.id));
  }

  async function inspectRelation(candidate: PlaceRelationCandidateRecord) {
    setSelectedRelationId(candidate.id);
    const result = await run(() => Promise.all([
      window.novelCompiler.listPlaceRelationCandidateEvidence(candidate.id),
      window.novelCompiler.getPlaceRelationModelSuggestion(candidate.id),
    ]));
    if (result) { setSuggestionTitle(`空间建议 · ${candidate.sourceName} → ${candidate.targetName}`); setSuggestionEvidence(result[0]); setRelationSuggestion(result[1]); }
  }

  async function reviewRelation(candidateId: string, status: PlaceReviewStatus) {
    const next = await run(() => window.novelCompiler.reviewPlaceRelationCandidate(candidateId, status), '空间关系候选审核状态已更新');
    if (next) setRelationCandidates(next);
  }

  async function promoteRelation(candidateId: string) {
    const created = await run(() => window.novelCompiler.createPlaceRelationFromCandidate(candidateId), '已生成待审正式空间关系；还需第二次确认才会进入地图');
    if (created) setFormalRelations(await window.novelCompiler.listPlaceRelations());
  }

  async function inspectFormalRelation(relation: PlaceRelationRecord) {
    const evidence = await run(() => window.novelCompiler.listPlaceRelationEvidence(relation.id));
    if (evidence) {
      setSuggestionTitle(`正式关系 · ${relation.sourceName} → ${relation.targetName}`);
      setSuggestionEvidence(evidence as PlaceRelationEvidenceRecord[]);
      setRelationSuggestion(null);
    }
  }

  async function reviewFormalRelation(relationId: string, status: PlaceReviewStatus) {
    const next = await run(() => window.novelCompiler.reviewPlaceRelation(relationId, status), status === 'confirmed'
      ? '正式空间关系已确认，可进入防剧透地图投影'
      : '正式空间关系审核状态已更新');
    if (next) setFormalRelations(next);
  }

  const counts = {
    pending: places.filter((place) => place.reviewStatus === 'pending').length,
    confirmed: places.filter((place) => place.reviewStatus === 'confirmed').length,
    evidence: places.reduce((sum, place) => sum + Number(place.mentionCount), 0),
  };

  return <section className="place-workbench">
    <PageTitle eyebrow="NARRATIVE CARTOGRAPHY · PHASE 3" title="地点证据台" description="先确认小说里哪些名字确实是地点，再建立层级和通路。布局不等于经纬度，模型归一化也不等于事实。" />
    <div className="place-survey panel">
      <div className="place-compass" aria-hidden="true"><i>N</i><b>地</b><span /></div>
      <div className="place-survey-copy"><span>LOCAL EVENT INDEX</span><strong>从已确认事件整理地点</strong><p>只扫描本地数据库，并在事件证据段落中重新逐字定位；未对齐项不会进入候选。</p></div>
      <div className="place-survey-metrics"><span><b>{counts.pending}</b> 当前待审</span><span><b>{counts.confirmed}</b> 当前确认</span><span><b>{counts.evidence}</b> 原文提及</span></div>
      <button className="button primary" onClick={() => void bootstrap()}>整理事件地点</button>
    </div>
    {lastBootstrap && <div className="place-run-slip">读取 {lastBootstrap.sourceLocationCount} 个事件地点 · 新增 {lastBootstrap.createdPlaceCount} 个候选 / {lastBootstrap.createdMentionCount} 条提及 · 跳过 {lastBootstrap.skippedUnalignedCount} 个未对齐项</div>}
    <section className="place-model-console panel" aria-label="地点模型扫描">
      <div className="place-model-heading"><span>MODEL SURVEY / 可替换模型</span><strong>地点关系勘测</strong><p>只向模型提供已确认地点与当前分块；输出先经过本地逐字门禁，再进入下方人工审核。</p></div>
      <label><span>本次模型</span><input aria-label="地点扫描模型" value={model} onChange={(event) => setModel(event.target.value)} placeholder="输入模型 ID" /></label>
      <div className="place-model-readiness"><b>{scanEstimate?.confirmedPlaceCount ?? 0}</b><span>已确认地点</span><b>{scanEstimate?.chunkCount ?? 0}</b><span>待扫描分块</span></div>
      <button className="button primary" disabled={!model.trim() || !scanEstimate?.ready || placeScanJob?.state === 'running'} onClick={() => void startModelScan()}>{placeScanJob?.state === 'running' ? `扫描中 ${Math.round(placeScanJob.progress * 100)}%` : '开始模型勘测'}</button>
      {placeScanJob && <div className={`place-model-progress ${placeScanJob.state}`}><i style={{ width: `${Math.max(2, placeScanJob.progress * 100)}%` }} /><span>{placeScanJob.message}</span></div>}
    </section>
    <div className="place-filter" role="tablist">{(['pending', 'confirmed', 'rejected', 'all'] as const).map((status) => <button role="tab" aria-selected={filter === status} className={filter === status ? 'active' : ''} key={status} onClick={() => setFilter(status)}>{status === 'pending' ? '待审核' : status === 'confirmed' ? '已确认' : status === 'rejected' ? '已排除' : '全部'}</button>)}</div>
    {places.length ? <div className="place-ledger-layout">
      <div className="place-index panel">
        <header><span>GAZETTEER</span><strong>{places.length} 个地点案卷</strong></header>
        {places.map((place, index) => <button key={place.id} className={`${selected?.id === place.id ? 'selected' : ''} ${place.reviewStatus}`} onClick={() => setSelectedId(place.id)}>
          <em>{String(index + 1).padStart(2, '0')}</em><div><strong>{place.canonicalName}</strong><small>{placeTypeLabels[place.placeType]} · 段落 {place.firstRevealedOrdinal}</small></div><b>{place.mentionCount}</b>
        </button>)}
      </div>
      {selected && <article className="place-dossier panel">
        <header><div><span>PLACE DOSSIER / {selected.reviewStatus.toUpperCase()}</span><h3>{selected.canonicalName}</h3><p>{selected.chapterTitle ?? '未分章'} · 首次揭示于段落 {selected.firstRevealedOrdinal} · 来自 {selected.sourceEventCount} 个事件</p></div><div className={`place-status-seal ${selected.reviewStatus}`}>{selected.reviewStatus === 'confirmed' ? '已核' : selected.reviewStatus === 'rejected' ? '排除' : '待考'}</div></header>
        <div className="place-edit-grid"><label><span>规范地点名</span><input value={draftName} maxLength={200} onChange={(event) => setDraftName(event.target.value)} /></label><label><span>地点类型</span><select value={draftType} onChange={(event) => setDraftType(event.target.value as PlaceType)}>{Object.entries(placeTypeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><div><span>置信度</span><strong>{Math.round(selected.importanceScore * 100)}%</strong></div></div>
        <div className="place-alias-review"><div><strong>地点别名</strong><span>模型别名也必须查看证据并独立审核</span></div>{aliases.length ? <section>{aliases.map((alias) => <article className={alias.reviewStatus} key={alias.id}><div><b>{alias.alias}</b><small>{alias.source} · {alias.reviewStatus}</small></div><div><button onClick={() => void inspectAlias(alias)}>证据</button><button disabled={alias.reviewStatus === 'confirmed'} onClick={() => void reviewAlias(alias.id, 'confirmed')}>确认</button><button disabled={alias.reviewStatus === 'rejected'} onClick={() => void reviewAlias(alias.id, 'rejected')}>排除</button></div></article>)}</section> : <p>当前没有独立别名；规范名仍由下方逐字提及支撑。</p>}</div>
        <details className="place-identity-tools">
          <summary><span>IDENTITY DESK</span><strong>同地异名 / 同名异地治理</strong><small>所有操作可撤销</small></summary>
          <div className="place-identity-grid">
            <label><span>对照地点</span><select aria-label="地点合并对照" value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}><option value="">没有可选地点</option>{allPlaces.filter((place) => place.id !== selected.id && place.reviewStatus !== 'rejected').map((place) => <option key={place.id} value={place.id}>{place.canonicalName} · {placeTypeLabels[place.placeType]}</option>)}</select></label>
            <button disabled={!mergeTargetId} onClick={() => void markDifferent()}>标记不同地点</button><button disabled={!mergeTargetId} onClick={() => void mergeSelected()}>合并到所选地点</button>
            <label><span>拆出后的规范名</span><input aria-label="拆出地点名称" value={splitName} onChange={(event) => setSplitName(event.target.value)} placeholder="例如：东城的同名客栈" /></label>
            <button disabled={!splitName.trim() || selectedMentionIds.length === 0 || selectedMentionIds.length >= mentions.length} onClick={() => void splitSelected()}>按所选证据拆分</button>
            <button disabled={!operations.some((operation) => operation.state === 'applied')} onClick={() => void undoIdentityOperation()}>撤销最近操作</button>
          </div>
          {links.length > 0 && <div className="place-link-notes">{links.map((link) => <article className={link.reviewStatus} key={link.id}><span>{link.leftName} {link.relation === 'cannot_link' ? '≠' : '≈'} {link.rightName} · {link.reason}</span><div><button onClick={() => void inspectLink(link)}>证据</button>{link.reviewStatus === 'pending' && <><button onClick={() => void reviewLink(link.id, 'confirmed')}>确认</button><button onClick={() => void reviewLink(link.id, 'rejected')}>排除</button></>}</div></article>)}</div>}
          {operations.length > 0 && <div className="place-operation-log">{operations.slice(0, 3).map((operation) => <span className={operation.state} key={operation.id}>{operation.state === 'applied' ? '已应用' : '已撤销'} · {operation.description}</span>)}</div>}
        </details>
        <div className="place-evidence-sheet"><div><strong>原文提及</strong><span>{mentions.length} 条逐字位置 · 勾选后可拆分身份</span></div>{mentions.map((mention) => <blockquote className={selectedMentionIds.includes(mention.id) ? 'selected' : ''} key={mention.id}><label><input aria-label={`选择地点证据 ${mention.paragraphOrdinal}`} type="checkbox" checked={selectedMentionIds.includes(mention.id)} onChange={(event) => setSelectedMentionIds((current) => event.target.checked ? [...current, mention.id] : current.filter((id) => id !== mention.id))} /><span>{mention.chapterTitle ?? '未分章'} · 段落 {mention.paragraphOrdinal} · 字符 {mention.charStart}–{mention.charEnd}</span></label><p>{mention.paragraphText.slice(0, mention.charStart)}<mark>{mention.paragraphText.slice(mention.charStart, mention.charEnd)}</mark>{mention.paragraphText.slice(mention.charEnd)}</p><footer><small>{mention.extractionMethod === 'rule' ? '事件地点本地回收' : mention.extractionMethod} · {Math.round(mention.confidence * 100)}%</small><button className="source-span-link" type="button" aria-label="查看地点提及原文" disabled={!mention.sourceSpanId} onClick={() => mention.sourceSpanId && void openSourceSpan(mention.sourceSpanId)}>查看原文</button></footer></blockquote>)}</div>
        <footer className="place-dossier-footer"><p>确认只表示“这是当前小说版本中的一个地点身份”；不会自动创建包含、方位或通路关系。</p><div className="place-dossier-actions"><button disabled={selected.reviewStatus === 'rejected'} onClick={() => void review('rejected')}>排除</button>{selected.reviewStatus !== 'pending' && <button onClick={() => void review('pending')}>恢复待审</button>}<button className="confirm" disabled={!draftName.trim() || selected.reviewStatus === 'confirmed'} onClick={() => void review('confirmed')}>确认地点</button></div></footer>
      </article>}
    </div> : <div className="place-empty panel"><b>地图从空白开始</b><span>{filter === 'pending' ? '先确认时间线事件，再点击“整理事件地点”。没有逐字证据的地名不会出现。' : '当前筛选下没有地点案卷。'}</span></div>}
    <section className="place-suggestion-desk panel">
      <header><div><span>HUMAN CHECKPOINT</span><h3>模型建议裁决台</h3><p>确认候选只表示建议成立；不会自动写入最终地图关系。</p></div><b>{relationCandidates.filter((candidate) => candidate.reviewStatus === 'pending').length} 待审空间关系</b></header>
      <div className="place-suggestion-layout">
        <div className="place-relation-stack">{relationCandidates.length ? relationCandidates.map((candidate) => <article className={`${candidate.reviewStatus} ${selectedRelationId === candidate.id ? 'selected' : ''}`} key={candidate.id}>
          <button className="place-relation-main" onClick={() => void inspectRelation(candidate)}><span>{candidate.proposedDirection === 'undirected' ? '双向 / 无向' : '方向关系'}</span><strong>{candidate.sourceName} <i>→</i> {candidate.targetName}</strong><small>{candidate.proposedRelationKind ?? '待定关系'} · {Math.round(candidate.confidence * 100)}% · {candidate.evidenceCount} 条证据</small></button>
          <div><button disabled={candidate.reviewStatus === 'confirmed'} onClick={() => void reviewRelation(candidate.id, 'confirmed')}>确认候选</button>{candidate.reviewStatus === 'confirmed' && <button disabled={formalRelations.some((relation) => relation.candidateId === candidate.id && relation.reviewStatus !== 'rejected')} onClick={() => void promoteRelation(candidate.id)}>生成正式关系草案</button>}<button disabled={candidate.reviewStatus === 'rejected'} onClick={() => void reviewRelation(candidate.id, 'rejected')}>排除</button></div>
        </article>) : <div className="place-suggestion-empty">模型扫描完成后，空间关系候选会在这里等待裁决。</div>}</div>
        <aside className="place-suggestion-evidence"><span>EVIDENCE WINDOW</span><h4>{suggestionTitle || '选择一项建议查看原文'}</h4>
          {relationSuggestion && <div className="place-suggestion-meta"><b>{relationSuggestion.truthStatus}</b><span>{relationSuggestion.informationSourceName ? `来源：${relationSuggestion.informationSourceName}` : `来源：${relationSuggestion.informationSourceType}`}</span><p>{relationSuggestion.reasoningNote || '模型未提供额外推理说明'}</p>{relationSuggestion.uncertainty && <em>疑点：{relationSuggestion.uncertainty}</em>}</div>}
          {suggestionEvidence.length ? suggestionEvidence.map((evidence) => <blockquote key={evidence.id}><small>{evidence.chapterTitle ?? '未分章'} · 段落 {evidence.paragraphOrdinal} · {evidence.evidenceRole ?? 'alias'}</small><p>“{evidence.exactQuote}”</p><footer><em>{evidence.alignmentStatus === 'exact' ? '逐字对齐' : '规范化对齐'}</em><button className="source-span-link" type="button" aria-label="查看地点建议证据原文" disabled={!evidence.sourceSpanId} onClick={() => evidence.sourceSpanId && void openSourceSpan(evidence.sourceSpanId)}>查看原文</button></footer></blockquote>) : <p className="place-suggestion-hint">别名和身份建议可从上方地点案卷点击“证据”；空间关系从左侧选择。</p>}
        </aside>
      </div>
      <div className="place-assertion-register">
        <header><div><span>SECOND GATE / MAP FACTS</span><strong>正式空间关系断言</strong><small>只有再次确认的断言才会进入地图；候选确认本身不入图。</small></div><b>{formalRelations.filter((relation) => relation.reviewStatus === 'pending').length} 待二审</b></header>
        {formalRelations.length ? <div>{formalRelations.map((relation) => <article className={relation.reviewStatus} key={relation.id}><button onClick={() => void inspectFormalRelation(relation)}><span>{relation.truthStatus} · {relation.direction === 'undirected' ? '无向' : '有向'}</span><strong>{relation.sourceName} <i>→</i> {relation.targetName}</strong><small>{relation.relationKind} · 首次揭示段落 {relation.firstRevealedOrdinal} · {relation.evidenceCount} 条证据</small></button><div><em>{relation.reviewStatus === 'confirmed' ? '已入图' : relation.reviewStatus === 'rejected' ? '已排除' : '待二审'}</em><button disabled={relation.reviewStatus === 'confirmed'} onClick={() => void reviewFormalRelation(relation.id, 'confirmed')}>确认入图</button><button disabled={relation.reviewStatus === 'rejected'} onClick={() => void reviewFormalRelation(relation.id, 'rejected')}>排除</button></div></article>)}</div> : <p>确认一个空间关系候选后，可生成待二审的正式关系草案。</p>}
      </div>
    </section>
    {sourceSpanDialog}
  </section>;
}

function RelationshipWorkbench({ run, jobs }: { run: RunHelper; jobs: JobRecord[] }) {
  const [estimate, setEstimate] = useState<RelationshipScanEstimate | null>(null);
  const [filter, setFilter] = useState<CharacterRelationshipReviewStatus | 'all'>('pending');
  const [candidates, setCandidates] = useState<CharacterRelationshipCandidateRecord[]>([]);
  const [relationships, setRelationships] = useState<CharacterRelationshipRecord[]>([]);
  const [confirmedCharacters, setConfirmedCharacters] = useState<CharacterCandidate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [evidence, setEvidence] = useState<CharacterRelationshipCandidateEvidenceRecord[]>([]);
  const [suggestion, setSuggestion] = useState<RelationshipModelSuggestionRecord | null>(null);
  const [model, setModel] = useState('');
  const [draftType, setDraftType] = useState('');
  const [draftDirection, setDraftDirection] = useState<'directed' | 'undirected' | 'reciprocal'>('undirected');
  const [draftStrength, setDraftStrength] = useState('');
  const [draftPolarity, setDraftPolarity] = useState('');
  const [draftTruth, setDraftTruth] = useState<'asserted' | 'suspected' | 'disputed' | 'false' | 'unknown' | 'rumor'>('unknown');
  const [draftReason, setDraftReason] = useState('');
  const [manualSourceId, setManualSourceId] = useState('');
  const [manualTargetId, setManualTargetId] = useState('');
  const [manualType, setManualType] = useState('');
  const [manualQuery, setManualQuery] = useState('');
  const [manualHits, setManualHits] = useState<SearchHit[]>([]);
  const [manualEvidence, setManualEvidence] = useState<SearchHit | null>(null);
  const { openSourceSpan, sourceSpanDialog } = useSourceSpanInspector(run);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? candidates[0] ?? null;
  const relationshipJob = jobs.find((job) => job.type === 'relationship-scan');
  const jobsKey = jobs.filter((job) => job.type === 'relationship-scan').map((job) => `${job.id}:${job.state}:${job.updatedAt}`).join('|');

  const reload = useCallback(async () => {
    const [nextEstimate, nextCandidates, nextRelationships, characters, api] = await Promise.all([
      window.novelCompiler.estimateRelationshipScan(),
      window.novelCompiler.listRelationshipCandidates(filter === 'all' ? undefined : filter),
      window.novelCompiler.listRelationships(),
      window.novelCompiler.listCharacters(),
      window.novelCompiler.getApiStatus(),
    ]);
    setEstimate(nextEstimate);
    setCandidates(nextCandidates);
    setRelationships(nextRelationships);
    const confirmed = characters.filter((character) => character.reviewStatus === 'confirmed');
    setConfirmedCharacters(confirmed);
    setManualSourceId((current) => confirmed.some((character) => character.id === current) ? current : confirmed[0]?.id ?? '');
    setManualTargetId((current) => confirmed.some((character) => character.id === current) ? current : confirmed[1]?.id ?? '');
    if (api.preferredModel) setModel((current) => current || api.preferredModel!);
    setSelectedId((current) => nextCandidates.some((candidate) => candidate.id === current) ? current : nextCandidates[0]?.id ?? '');
  }, [filter]);

  useEffect(() => { void reload().catch(() => undefined); }, [reload, jobsKey]);
  useEffect(() => {
    if (!selected) { setEvidence([]); setSuggestion(null); return; }
    void Promise.all([
      window.novelCompiler.listRelationshipCandidateEvidence(selected.id),
      window.novelCompiler.getRelationshipModelSuggestion(selected.id),
    ]).then(([nextEvidence, nextSuggestion]) => {
      setEvidence(nextEvidence);
      setSuggestion(nextSuggestion);
      setDraftType(selected.proposedType ?? '');
      setDraftDirection(nextSuggestion?.direction ?? 'undirected');
      setDraftStrength(nextSuggestion?.strength === null || nextSuggestion?.strength === undefined ? '' : String(nextSuggestion.strength));
      setDraftPolarity(nextSuggestion?.polarity === null || nextSuggestion?.polarity === undefined ? '' : String(nextSuggestion.polarity));
      setDraftTruth(nextSuggestion?.truthStatus ?? 'unknown');
      setDraftReason(nextSuggestion?.reasoningNote ?? '');
    }).catch(() => undefined);
  }, [selected?.id]);

  async function startScan(mode: 'local' | 'model') {
    const result = await run(() => window.novelCompiler.startRelationshipScan(mode === 'model' ? {
      mode: 'model', model, promptVersion: 'relationship-model.v1',
    } : { mode: 'local', extractorVersion: 'local-v2' }), mode === 'model'
      ? '模型关系抽取已启动；结果只会进入待审核候选层'
      : '本地关系候选扫描已启动');
    if (result) await reload();
  }

  async function reviewCandidate(status: CharacterRelationshipReviewStatus) {
    if (!selected) return;
    const result = await run(() => window.novelCompiler.reviewRelationshipCandidate(selected.id, status),
      status === 'confirmed' ? '关系候选已确认，尚未成为正式关系' : status === 'rejected' ? '关系候选已排除' : '关系候选已恢复');
    if (result) await reload();
  }

  async function createAssertion() {
    if (!selected || !suggestion || !draftType.trim()) return;
    const supportingEvidence = evidence.filter((item) => item.evidenceRole !== 'clue').map((item) => ({
      paragraphId: item.paragraphId,
      exactQuote: item.exactQuote,
      role: item.evidenceRole as 'support' | 'context' | 'contradict',
    }));
    if (!supportingEvidence.some((item) => item.role === 'support')) {
      await run(async () => { throw new Error('断言建议缺少支持证据，不能升级'); });
      return;
    }
    if (selected.reviewStatus !== 'confirmed') {
      const reviewed = await run(() => window.novelCompiler.reviewRelationshipCandidate(selected.id, 'confirmed'));
      if (!reviewed) return;
    }
    const result = await run(() => window.novelCompiler.createRelationship({
      sourceIdentityId: selected.sourceIdentityId,
      targetIdentityId: selected.targetIdentityId,
      relationshipType: draftType.trim(),
      direction: draftDirection,
      strength: draftStrength === '' ? null : Number(draftStrength),
      polarity: draftPolarity === '' ? null : Number(draftPolarity),
      informationSourceType: suggestion.informationSourceType,
      informationSourceIdentityId: suggestion.informationSourceIdentityId,
      truthStatus: draftTruth,
      validFromEventId: suggestion.validFromEventId,
      validToEventId: suggestion.validToEventId,
      validFromTimeExpressionId: null,
      validToTimeExpressionId: null,
      confidence: selected.confidence,
      extractionMethod: 'model',
      candidateId: selected.id,
      reasoningNote: draftReason,
      evidence: supportingEvidence,
    }), '已生成待审核关系断言；仍需在下方确认后才进入图谱');
    if (result) await reload();
  }

  async function reviewAssertion(relationshipId: string, status: CharacterRelationshipReviewStatus) {
    const result = await run(() => window.novelCompiler.reviewRelationship(relationshipId, status),
      status === 'confirmed' ? '关系断言已确认' : status === 'rejected' ? '关系断言已排除' : '关系断言已恢复');
    if (result) await reload();
  }

  async function searchManualEvidence() {
    const hits = await run(() => window.novelCompiler.search(manualQuery));
    if (hits) { setManualHits(hits.slice(0, 8)); setManualEvidence(hits[0] ?? null); }
  }

  async function createManualCandidate() {
    if (!manualSourceId || !manualTargetId || !manualType.trim() || !manualEvidence) return;
    const result = await run(() => window.novelCompiler.createRelationshipCandidate({
      sourceIdentityId: manualSourceId,
      targetIdentityId: manualTargetId,
      method: 'user',
      proposedType: manualType.trim(),
      confidence: 1,
      evidence: [{ paragraphId: manualEvidence.paragraphId, exactQuote: manualEvidence.snippet, role: 'clue' }],
    }), '人工关系候选已建立，仍需审核');
    if (result) {
      setManualType(''); setManualQuery(''); setManualHits([]); setManualEvidence(null);
      setFilter('pending'); await reload();
    }
  }

  return <section className="relationship-workbench">
    <PageTitle eyebrow="RELATIONSHIP EVIDENCE DESK" title="人物关系审核" description="像整理案卷一样核对人物对、原文证据、信息来源与有效时间；候选和断言分两次确认。" />
    <div className="relationship-command panel">
      <div><span>分析分块</span><strong>{estimate?.chunkCount ?? 0}</strong><small>{estimate?.ready ? `${estimate.confirmedCharacterCount} 名已确认人物` : '请先完成人物确认与分析分块'}</small></div>
      <div><span>待审核候选</span><strong>{filter === 'pending' ? candidates.length : '—'}</strong><small>共现永不自动升级</small></div>
      <button className="button ghost" disabled={!estimate?.ready || relationshipJob?.state === 'running'} onClick={() => void startScan('local')}>本地线索扫描</button>
      <label><span>关系模型</span><input value={model} onChange={(event) => setModel(event.target.value)} /></label>
      <button className="button primary" disabled={!estimate?.ready || !model.trim() || relationshipJob?.state === 'running'} onClick={() => void startScan('model')}>
        {relationshipJob?.state === 'running' ? `抽取中 ${Math.round(relationshipJob.progress * 100)}%` : '提取结构化候选'}
      </button>
    </div>
    <div className="relationship-safety"><b>双闸门</b><span>候选确认 ≠ 图谱确认</span><i />模型只能提出建议；正式关系还要再次审核。</div>
    <div className="relationship-filter">
      {(['pending', 'confirmed', 'rejected', 'all'] as const).map((status) => <button className={filter === status ? 'active' : ''} key={status} onClick={() => setFilter(status)}>{status === 'pending' ? '待审核' : status === 'confirmed' ? '已采纳候选' : status === 'rejected' ? '已排除' : '全部'}</button>)}
    </div>
    <details className="relationship-manual panel">
      <summary><span>＋</span><strong>人工新建关系候选</strong><small>从原文检索结果中选证据，不允许无证据建边</small></summary>
      <div className="manual-candidate-form">
        <label><span>人物 A</span><select value={manualSourceId} onChange={(event) => setManualSourceId(event.target.value)}>{confirmedCharacters.map((character) => <option value={character.id} key={character.id}>{character.canonicalName}</option>)}</select></label>
        <label><span>人物 B</span><select value={manualTargetId} onChange={(event) => setManualTargetId(event.target.value)}>{confirmedCharacters.map((character) => <option value={character.id} key={character.id}>{character.canonicalName}</option>)}</select></label>
        <label><span>候选类型</span><input value={manualType} onChange={(event) => setManualType(event.target.value)} placeholder="例如：师徒、盟友、敌对" /></label>
        <label className="manual-search"><span>原文检索词</span><div><input value={manualQuery} onChange={(event) => setManualQuery(event.target.value)} /><button type="button" onClick={() => void searchManualEvidence()}>检索证据</button></div></label>
        {manualHits.length > 0 && <div className="manual-hit-list">{manualHits.map((hit) => <button type="button" className={manualEvidence?.paragraphId === hit.paragraphId ? 'selected' : ''} key={hit.paragraphId} onClick={() => setManualEvidence(hit)}><span>{hit.chapterTitle ?? '未分章'} · 段落 {hit.ordinal}</span>{hit.snippet}</button>)}</div>}
        <button className="button primary manual-submit" type="button" disabled={!manualSourceId || manualSourceId === manualTargetId || !manualType.trim() || !manualEvidence} onClick={() => void createManualCandidate()}>建立待审核候选</button>
      </div>
    </details>
    {candidates.length ? <div className="relationship-desk">
      <div className="relationship-candidate-stack panel">
        <header><strong>{candidates.length} 份关系案卷</strong><span>按置信度排序</span></header>
        {candidates.map((candidate, index) => <button className={`${candidate.id === selected?.id ? 'selected' : ''} ${candidate.reviewStatus}`} key={candidate.id} onClick={() => setSelectedId(candidate.id)}>
          <span className="case-number">R-{String(index + 1).padStart(3, '0')}</span>
          <div><strong>{candidate.sourceName}<b>↔</b>{candidate.targetName}</strong><small>{candidate.proposedType ?? '仅共现线索'} · {candidate.evidenceCount} 条证据</small></div>
          <em>{Math.round(candidate.confidence * 100)}</em>
        </button>)}
      </div>
      {selected && <article className="relationship-casefile panel">
        <header><div><span>{selected.candidateMethod === 'model' ? 'MODEL ASSERTION PROPOSAL' : 'LOCAL CLUE'}</span><h3>{selected.sourceName}<b> / </b>{selected.targetName}</h3><p>{selected.proposedType ?? '尚无语义类型，只记录人物共现'}</p></div><div className="case-actions"><button disabled={selected.reviewStatus === 'confirmed'} onClick={() => void reviewCandidate('confirmed')}>采纳候选</button><button disabled={selected.reviewStatus === 'rejected'} onClick={() => void reviewCandidate('rejected')}>排除</button>{selected.reviewStatus !== 'pending' && <button onClick={() => void reviewCandidate('pending')}>恢复</button>}</div></header>
        <div className="relationship-evidence-ledger">
          <div className="ledger-title"><strong>证据账页</strong><span>{evidence.length} 条 · 每条均可回到原文</span></div>
          {evidence.map((item) => <blockquote className={item.evidenceRole} key={item.id}><span>{item.evidenceRole.toUpperCase()} · {item.chapterTitle ?? '未分章'} · 段落 {item.paragraphOrdinal}</span>{item.exactQuote}<footer><small>{item.alignmentStatus === 'exact' ? '逐字对齐' : '归一化对齐'}</small><button className="source-span-link" type="button" aria-label="查看人物关系证据原文" disabled={!item.sourceSpanId} onClick={() => item.sourceSpanId && void openSourceSpan(item.sourceSpanId)}>查看原文</button></footer></blockquote>)}
        </div>
        {suggestion ? <div className="relationship-assertion-form">
          <div className="assertion-stamp">待核<br />断言</div>
          <label className="wide"><span>关系类型</span><input value={draftType} onChange={(event) => setDraftType(event.target.value)} /></label>
          <label><span>方向</span><select value={draftDirection} onChange={(event) => setDraftDirection(event.target.value as typeof draftDirection)}><option value="directed">单向</option><option value="undirected">无向</option><option value="reciprocal">双向</option></select></label>
          <label><span>真假状态</span><select value={draftTruth} onChange={(event) => setDraftTruth(event.target.value as typeof draftTruth)}><option value="asserted">文本断言</option><option value="suspected">存疑</option><option value="disputed">有争议</option><option value="false">已否定</option><option value="rumor">传闻</option><option value="unknown">未知</option></select></label>
          <label><span>强度 0–1</span><input type="number" min="0" max="1" step="0.1" value={draftStrength} onChange={(event) => setDraftStrength(event.target.value)} /></label>
          <label><span>极性 -1–1</span><input type="number" min="-1" max="1" step="0.1" value={draftPolarity} onChange={(event) => setDraftPolarity(event.target.value)} /></label>
          <label className="wide"><span>审核说明</span><textarea value={draftReason} onChange={(event) => setDraftReason(event.target.value)} /></label>
          <div className="assertion-provenance"><span>来源：{suggestion.informationSourceName ?? (suggestion.informationSourceType === 'narrator' ? '旁白' : '未知')}</span><span>有效期：{suggestion.validFromEventTitle ?? '未指定'} → {suggestion.validToEventTitle ?? '未指定'}</span>{suggestion.uncertainty && <span>疑点：{suggestion.uncertainty}</span>}</div>
          <button className="button primary wide" onClick={() => void createAssertion()}>生成待审核关系断言</button>
        </div> : <div className="no-assertion">本地线索没有断言字段。可以先确认或排除候选；语义、方向和来源需要模型建议或后续人工新建。</div>}
      </article>}
    </div> : <div className="simple-empty">当前筛选下没有关系候选。先确认至少两名人物，再运行本地线索或结构化模型抽取。</div>}
    <div className="relationship-history-heading"><div><p>ASSERTION REGISTER</p><h3>关系断言册</h3><span>只有“已确认”的断言会进入后续防剧透图谱</span></div><strong>{relationships.filter((item) => item.reviewStatus === 'confirmed').length} / {relationships.length}</strong></div>
    {relationships.length ? <div className="relationship-register">{relationships.map((relationship) => <article className={`panel ${relationship.reviewStatus}`} key={relationship.id}><span>{relationship.truthStatus} · {relationship.direction}</span><h4>{relationship.sourceName}<b>→</b>{relationship.targetName}</h4><p>{relationship.relationshipType}</p><small>首次揭示于段落 {relationship.firstRevealedOrdinal} · 置信度 {Math.round(relationship.confidence * 100)}%</small><footer><button disabled={relationship.reviewStatus === 'confirmed'} onClick={() => void reviewAssertion(relationship.id, 'confirmed')}>确认入图</button><button disabled={relationship.reviewStatus === 'rejected'} onClick={() => void reviewAssertion(relationship.id, 'rejected')}>排除</button>{relationship.reviewStatus !== 'pending' && <button onClick={() => void reviewAssertion(relationship.id, 'pending')}>恢复</button>}</footer></article>)}</div> : <div className="simple-empty">尚无关系断言。模型建议必须先经过上方人工核对。</div>}
    {sourceSpanDialog}
  </section>;
}

function JobsView({ jobs, onChanged, run }: { jobs: JobRecord[]; onChanged: (jobs: JobRecord[]) => void; run: RunHelper }) {
  async function control(job: JobRecord, action: 'pause' | 'resume' | 'cancel' | 'retry') {
    const value = await run(() => window.novelCompiler.controlJob(job.id, action));
    if (value) onChanged(value);
  }
  return <section>
    <PageTitle eyebrow="RECOVERABLE JOBS" title="任务中心" description="长任务保留进度和状态；异常退出后会进入等待恢复，而不是假装已经完成。" />
    <div className="job-list">{jobs.map((job) => <article className="panel job" key={job.id}>
      <div className={`job-state ${job.state}`}>{job.state}</div><div className="job-main"><div><strong>{job.type === 'import' ? '小说导入' : job.type === 'foundation-workflow' ? '一键基础流程' : job.type === 'character-scan' ? '人物普查' : job.type === 'character-facts' ? '人物档案提取' : job.type === 'timeline-events' ? '候选事件提取' : job.type}</strong><span>{new Date(job.updatedAt).toLocaleString()}</span></div><p>{job.message}</p><div className="progress"><i style={{ width: `${Math.round(job.progress * 100)}%` }} /></div></div>
      <div className="job-actions">{job.type === 'foundation-workflow' ? <span>请在“一键生成”页控制</span> : <>{job.state === 'running' && <><button onClick={() => void control(job, 'pause')}>暂停</button><button onClick={() => void control(job, 'cancel')}>取消</button></>}{job.state === 'paused' && <button onClick={() => void control(job, 'resume')}>继续</button>}{job.state === 'queued' && <button onClick={() => void control(job, 'resume')}>恢复</button>}{job.state === 'failed' && <button onClick={() => void control(job, 'retry')}>重试</button>}</>}</div>
    </article>)}</div>
    {jobs.length === 0 && <div className="simple-empty">还没有任务记录。</div>}
  </section>;
}

function DiagnosticsView({ run }: { run: RunHelper }) {
  const [report, setReport] = useState<ProjectDiagnosticReport | null>(null);

  const inspect = useCallback(async (mode: 'quick' | 'full', announce = true) => {
    const value = await run(
      () => window.novelCompiler.runProjectDiagnostics(mode),
      announce ? (mode === 'full' ? '严格工程检查完成' : '快速工程检查完成') : undefined,
    );
    if (value) setReport(value);
  }, [run]);

  useEffect(() => { void inspect('quick', false); }, [inspect]);

  const statusLabel = report?.overallStatus === 'ok' ? '全部正常' : report?.overallStatus === 'warning' ? '需要留意' : report ? '发现错误' : '正在检查';
  return <section>
    <PageTitle eyebrow="PROJECT HEALTH" title="工程诊断" description="快速检查适合日常查看；严格检查会完整扫描 SQLite，并重新计算保留原始文件的 SHA-256。" />
    <div className="diagnostic-command panel">
      <div><span>当前结论</span><strong className={report?.overallStatus ?? 'loading'}>{statusLabel}</strong><small>{report ? (report.mode === 'full' ? '严格' : '快速') + '检查 · ' + report.durationMs + ' ms · ' + new Date(report.checkedAt).toLocaleString() : '正在读取工程状态'}</small></div>
      <div className="diagnostic-actions"><button className="button ghost" onClick={() => void inspect('quick')}>重新快速检查</button><button className="button primary" onClick={() => void inspect('full')}>运行严格检查</button></div>
    </div>
    {report && <>
      <div className="diagnostic-metrics">
        <article className="panel"><span>Schema</span><strong>v{report.schemaVersion}</strong><small>应用要求 v{report.expectedSchemaVersion}</small></article>
        <article className="panel"><span>FTS 覆盖</span><strong>{report.ftsRowCount.toLocaleString()}</strong><small>{report.paragraphCount.toLocaleString()} 个段落</small></article>
        <article className="panel"><span>SourceSpan</span><strong>{report.sourceSpanCount.toLocaleString()}</strong><small>{report.unresolvedSourceSpanCount} 条歧义或失效</small></article>
        <article className="panel"><span>外键错误</span><strong>{report.foreignKeyViolationCount}</strong><small>{report.storageEngine ?? '存储引擎未登记'}</small></article>
        <article className="panel"><span>内部快照</span><strong>{report.internalBackupCount}</strong><small>{report.latestInternalBackup ?? '当前无需迁移快照'}</small></article>
      </div>
      <div className="diagnostic-grid">
        <div className="diagnostic-checks panel">{report.checks.map((check) => <article className={check.status} key={check.id}><i>{check.status === 'ok' ? '✓' : check.status === 'warning' ? '!' : '×'}</i><div><span>{check.label}</span><strong>{check.summary}</strong>{check.detail && <small>{check.detail}</small>}</div></article>)}</div>
        <aside className="diagnostic-source panel">
          <span>SOURCE PRESERVATION</span><h3>来源文件</h3>
          {report.source ? <>
            <dl><div><dt>文件</dt><dd>{report.source.originalName}</dd></div><div><dt>编码</dt><dd>{report.source.encoding}</dd></div><div><dt>大小</dt><dd>{formatBytes(report.source.byteSize)}</dd></div><div><dt>原件</dt><dd>{report.source.originalExists ? '存在' : '缺失'}</dd></div><div><dt>规范文本</dt><dd>{report.source.normalizedExists ? '存在' : '缺失'}</dd></div><div><dt>SHA-256</dt><dd>{report.source.checksumMatches === null ? '严格检查时验证' : report.source.checksumMatches ? '匹配' : '不匹配'}</dd></div></dl>
            <code>{report.source.sha256}</code><small>{report.source.originalPath}<br />{report.source.normalizedPath}</small>
          </> : <p>尚未导入小说，因此没有需要核验的来源文件。</p>}
        </aside>
      </div>
      <div className="diagnostic-note panel"><strong>检查边界</strong><p>内部快照只统计 schema/存储迁移前自动保留的数据库文件；手动导出的 <code>.novelproj</code> 可以保存在任意位置，因此不会假装知道其最新状态。</p></div>
    </>}
  </section>;
}

function SettingsView({ run }: { run: RunHelper }) {
  const requestedPresetId = new URLSearchParams(window.location.search).get('preset');
  const [requestSettings, setRequestSettings] = useState(defaultApiRequestSettings);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const validation = apiRequestSettingsSchema.safeParse(requestSettings);
  const [status, setStatus] = useState<ApiStatus>({ configured: false, provider: null, baseUrl: null, preferredModel: null });
  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [preferredModel, setPreferredModel] = useState('');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testResult, setTestResult] = useState('');
  const [providerPresetId, setProviderPresetId] = useState('custom');
  useEffect(() => { void window.novelCompiler.getApiStatus().then((value) => {
    setStatus(value);
    setRequestSettings(value.requestSettings ?? defaultApiRequestSettings);
    setSettingsLoaded(true);
    const requestedPreset = apiProviderPresets.find((preset) => preset.id === requestedPresetId && preset.id !== 'custom');
    if (requestedPreset) {
      setProviderPresetId(requestedPreset.id);
      setProvider(requestedPreset.provider);
      setBaseUrl(requestedPreset.baseUrl);
      setPreferredModel(requestedPreset.preferredModel);
      setTestResult(`已为本次设置预选 ${requestedPreset.label}；填写该服务商的新密钥后再保存。`);
    } else {
      setProviderPresetId(findProviderPreset(value.provider, value.baseUrl).id);
      if (value.provider) setProvider(value.provider);
      if (value.baseUrl) setBaseUrl(value.baseUrl);
      if (value.preferredModel) setPreferredModel(value.preferredModel);
    }
  }); }, []);
  const selectedPreset = apiProviderPresets.find((preset) => preset.id === providerPresetId) ?? apiProviderPresets.at(-1)!;
  const connectionChanged = providerConfigChanged(status, { provider, baseUrl });
  const needsApiKey = !status.configured || connectionChanged;
  const canSave = settingsLoaded && validation.success && Boolean(provider.trim() && baseUrl.trim() && preferredModel.trim() && (!needsApiKey || apiKey.trim()));
  function selectProvider(presetId: string) {
    const preset = apiProviderPresets.find((item) => item.id === presetId) ?? apiProviderPresets.at(-1)!;
    setProviderPresetId(preset.id);
    setProvider(preset.provider);
    setBaseUrl(preset.baseUrl);
    setPreferredModel(preset.preferredModel);
    setApiKey('');
    setAvailableModels([]);
    setTestResult(preset.id === 'custom' ? '请填写兼容服务的名称、基础地址和模型 ID。' : `已套用 ${preset.label} 预设；请填写对应服务的 API 密钥后保存。`);
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    const value = await run(() => window.novelCompiler.saveApiConfig({
      provider, baseUrl, apiKey: apiKey || undefined, preferredModel, requestSettings,
    }), 'API、默认模型与请求参数已安全保存');
    if (value) { setStatus(value); setApiKey(''); setPreferredModel(value.preferredModel ?? preferredModel); setProviderPresetId(findProviderPreset(value.provider, value.baseUrl).id); }
  }
  async function test() {
    const value = await run(() => window.novelCompiler.testApiConnection());
    if (value) setTestResult(value.message);
  }
  async function loadModels() {
    setLoadingModels(true);
    try {
      const value = await run(() => window.novelCompiler.listApiModels(), '已从服务商读取可用模型');
      if (value) {
        setAvailableModels(value.models);
        setTestResult(value.models.length
          ? `读取到 ${value.models.length} 个模型；可从下方选择，也可继续手工输入。`
          : '服务商返回了空模型列表，仍可手工填写模型 ID。');
      }
    } finally {
      setLoadingModels(false);
    }
  }
  return <section>
    <PageTitle eyebrow="MODEL CONNECTION" title="API 与模型设置" description="从服务商读取模型，也可以输入任意兼容模型 ID；密钥只在主进程解密，不会进入小说工程。" />
    <form className="settings-form panel" onSubmit={(event) => void save(event)}>
      <div className="secure-banner"><span>♢</span><div><strong>{status.configured ? '密钥已受保护' : '尚未保存密钥'}</strong><p>密钥不会写入小说工程、备份文件或界面日志。</p></div></div>
      <label className="provider-picker"><span>API 服务商</span><select aria-label="API 服务商" value={providerPresetId} onChange={(event) => selectProvider(event.target.value)}>{apiProviderPresets.map((preset) => <option value={preset.id} key={preset.id}>{preset.label}</option>)}</select><small>{selectedPreset.note}</small></label>
      {providerPresetId === 'custom' ? <label><span>自定义服务商名称</span><input required value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="输入服务商名称" /></label> : <div className="provider-stamp"><span>SELECTED PROVIDER</span><strong>{selectedPreset.provider}</strong><small>地址与推荐模型已自动填入，保存前仍可修改模型。</small></div>}
      <label><span>API 基础地址 {providerPresetId !== 'custom' && <em>预设自动填写</em>}</span><input required readOnly={providerPresetId !== 'custom'} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…/v1" /></label>
      <label><span>API 密钥</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={needsApiKey ? '请输入当前服务商的新密钥' : '留空则继续使用已安全保存的密钥'} />{connectionChanged && <small className="provider-key-warning">已切换服务商或地址，不能沿用之前保存的密钥。</small>}</label>
      <div className="model-selector-block">
        <div className="model-selector-heading"><div><span>全局默认模型</span><small>请填写接口要求的模型 ID（如 deepseek-v4-flash），目录展示名称可能不同；保存后可读取账户可用列表。</small></div><button className="button ghost" type="button" disabled={!status.configured || connectionChanged || loadingModels} onClick={() => void loadModels()}>{loadingModels ? '正在读取…' : '读取模型列表'}</button></div>
        <input required aria-label="全局默认模型" list="api-model-options" value={preferredModel} onChange={(event) => setPreferredModel(event.target.value)} placeholder="输入任意模型 ID" autoComplete="off" />
        <datalist id="api-model-options">{availableModels.map((model) => <option value={model} key={model} />)}</datalist>
        {availableModels.length > 0 && <div className="model-choice-list">{availableModels.map((model) => <button type="button" className={model === preferredModel ? 'selected' : ''} onClick={() => setPreferredModel(model)} key={model}>{model}</button>)}</div>}
      </div>
      <ApiRequestFields value={requestSettings} onChange={setRequestSettings} />
      {!validation.success && <p className="request-validation" role="alert">{validation.error.issues.map(issue => issue.message).join('；')}</p>}
      <p className="request-settings-note">恢复默认值只修改表单，点击“安全保存”才生效。“测试连接”只检查连接与模型列表，不验证生成参数是否受模型支持。</p>
      <div className="form-actions"><button className="button primary" disabled={!canSave}>安全保存</button><button className="button ghost" type="button" disabled={!status.configured || connectionChanged} onClick={() => void test()}>测试连接</button><span>{testResult}</span></div>
    </form>
  </section>;
}

function ImportDialog({ preview, onCancel, onConfirm, busy }: { preview: ImportPreview; onCancel: () => void; onConfirm: (encoding: string) => Promise<void>; busy: boolean }) {
  const [encoding, setEncoding] = useState(preview.recommendedEncoding);
  const candidate = useMemo(() => preview.candidates.find((item) => item.encoding === encoding) ?? preview.candidates[0], [preview, encoding]);
  return <div className="modal-backdrop"><div className="modal">
    <p className="eyebrow">IMPORT REVIEW</p><h2>确认文本编码</h2><p className="modal-intro">文件大小 {formatBytes(preview.byteSize)}。请看预览是否为正常中文；确认前不会写入工程。</p>
    <div className="encoding-list">{preview.candidates.slice(0, 5).map((item, index) => <button key={item.encoding} className={encoding === item.encoding ? 'active' : ''} onClick={() => setEncoding(item.encoding)}><span>{item.encoding.toUpperCase()}</span><small>{index === 0 ? '推荐' : `评分 ${item.score.toFixed(1)}`}</small></button>)}</div>
    <div className="preview-box"><span>正文预览</span><p>{candidate?.preview || '（没有可预览文本）'}</p></div>
    <div className="quality-row"><span>中文比例 <strong>{((candidate?.chineseRate ?? 0) * 100).toFixed(1)}%</strong></span><span>替换字符 <strong>{((candidate?.replacementRate ?? 0) * 100).toFixed(2)}%</strong></span><span>控制字符 <strong>{((candidate?.controlRate ?? 0) * 100).toFixed(2)}%</strong></span></div>
    <div className="modal-actions"><button className="button ghost" onClick={onCancel} disabled={busy}>取消</button><button className="button primary" onClick={() => void onConfirm(encoding)} disabled={busy}>按此编码导入</button></div>
  </div></div>;
}
