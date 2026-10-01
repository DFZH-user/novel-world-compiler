import { useEffect, useState } from 'react';
import type { SillyTavernStatus } from './shared/contracts';
import type { PlaySessionOptions, PlaySessionPreview, PlayableEntryChoice } from './shared/play-session-options';
import './styles/play-session.css';

export function PlaySessionSetup({ projectId, onBack, onStarted }: {
  projectId: string; onBack: () => void; onStarted: (status: SillyTavernStatus) => void;
}) {
  const [preview, setPreview] = useState<PlaySessionPreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState<PlayableEntryChoice[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [placeFilter, setPlaceFilter] = useState('');
  const [entryFilter, setEntryFilter] = useState('');
  const [options, setOptions] = useState<PlaySessionOptions>(() => {
    try { const value = JSON.parse(localStorage.getItem(`nw-play-${projectId}`) || 'null');
      if (value?.persona && ['narrator', 'character'].includes(value.mode)) return { ...value, playProfile: ['low', 'medium', 'high'].includes(value.playProfile) ? value.playProfile : 'medium' };
    } catch { /* use empty identity */ }
    return { mode: 'narrator', playProfile: 'medium', persona: { name: '', description: '' } };
  });
  useEffect(() => {
    let active = true;
    window.novelCompiler.listProjectPlayEntries(projectId).then(value => {
      if (!active) return;
      setEntries(value);
      if (options.entryEventId && !value.some(item => item.eventId === options.entryEventId)) {
        setOptions(current => ({ ...current, entryEventId: undefined, startingPlaceId: undefined }));
      }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setEntriesLoading(false); });
    return () => { active = false; };
  }, [projectId]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    const previewOptions: PlaySessionOptions = {
      mode: 'narrator', entryEventId: options.entryEventId, startingPlaceId: options.startingPlaceId,
      playProfile: options.playProfile ?? 'medium', persona: { name: '旅人', description: '' },
    };
    window.novelCompiler.prepareProjectPlay(projectId, options.entryEventId, previewOptions).then(value => {
      if (!active) return;
      setPreview(value); setError('');
      setOptions(current => ({
        ...current,
        startingPlaceId: current.startingPlaceId && !value.availablePlaces.some(place => place.id === current.startingPlaceId)
          ? undefined : current.startingPlaceId,
        characterId: current.characterId && !value.characters.some(character => character.identityId === current.characterId)
          ? undefined : current.characterId,
        persona: current.persona.identityId && !value.characters.some(character => character.identityId === current.persona.identityId)
          ? { name: '', description: '' } : current.persona,
      }));
    }).catch(reason => { if (!active) return;
      if (options.startingPlaceId) setOptions(current => ({ ...current, startingPlaceId: undefined }));
      else setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [projectId, options.entryEventId, options.startingPlaceId, options.playProfile]);
  const ai = preview?.characters.find(character => character.identityId === options.characterId);
  const player = preview?.characters.find(character => character.identityId === options.persona.identityId);
  const conflict = options.mode === 'character' && ai && (ai.identityId === player?.identityId || ai.name === options.persona.name.trim());
  const canStart = Boolean(preview && !busy && options.persona.name.trim() && !conflict && (options.mode !== 'character' || ai));
  const selectedEntryId = options.entryEventId ?? preview?.entryEventId;
  const timeQuery = entryFilter.trim().toLocaleLowerCase('zh-CN');
  const shownEntries = entries.filter(entry => !timeQuery
    || entry.title.toLocaleLowerCase('zh-CN').includes(timeQuery) || String(entry.ordinal).includes(timeQuery)).slice(0, timeQuery ? 200 : 100);
  const selectedEntry = entries.find(entry => entry.eventId === selectedEntryId);
  if (selectedEntry && !shownEntries.some(entry => entry.eventId === selectedEntry.eventId)) shownEntries.unshift(selectedEntry);
  const shownPlaces = (preview?.availablePlaces ?? []).filter(place => place.name.includes(placeFilter.trim()));
  async function start(settingsPage?: 'model' | 'tuning' | 'other') {
    setBusy(true); setError('');
    try {
      const status = await window.novelCompiler.launchProjectPlay(projectId, options, settingsPage);
      localStorage.setItem(`nw-play-${projectId}`, JSON.stringify(options));
      onStarted(status);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function importIdentity(file?: File) {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text());
      if (typeof value.name !== 'string' || !value.name.trim() || typeof value.description !== 'string'
        || value.name.length > 80 || value.description.length > 1500) throw new Error('身份 JSON 需要 name（最多 80 字）和 description（最多 1500 字）。');
      setOptions(current => ({ ...current, persona: { name: value.name, description: value.description } }));
      setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '无法导入身份'); }
  }
  return <main className="play-setup" aria-busy={busy}>
    <header><button className="button ghost" disabled={busy} onClick={onBack}>← 返回书库</button><span>小说世界 · 进入故事</span></header>
    <div className="play-setup-heading"><p>这一页之后，是你的故事。</p><h1>{preview?.projectName ?? '正在准备这本书…'}</h1>
      <p>{preview ? `从「${preview.entryTitle}」进入 · 原文段落 ${preview.entryOrdinal}` : '核对已有成果，并离线准备游玩资料。'}</p></div>
    {error && <p className="play-error" role="alert">{error}</p>}
    {preview && <>
      <div className="play-setup-grid">
        <section><small>01 · AI 扮演／角色卡</small><h2>由谁陪你进入故事</h2>
          <label>游玩模式<select disabled={busy} value={options.mode} onChange={event => setOptions({ ...options, mode: event.target.value as PlaySessionOptions['mode'] })}><option value="narrator">世界冒险 · 旁白主持</option><option value="character">指定人物互动</option></select></label>
          <label>游玩资料档位<select disabled={busy} value={options.playProfile ?? 'medium'} onChange={event => setOptions({ ...options, playProfile: event.target.value as 'low' | 'medium' | 'high' })}><option value="low">低 · 精简省空间</option><option value="medium">中 · 均衡（默认）</option><option value="high">高 · 更多已知细节</option></select></label>
          {options.mode === 'character' ? <label>AI 扮演的人物<select disabled={busy} value={options.characterId ?? ''} onChange={event => setOptions({ ...options, characterId: event.target.value })}><option value="">选择本书人物</option>{preview.characters.map(character => <option key={character.identityId} value={character.identityId}>{character.name}</option>)}</select></label> : <p>旁白描写世界与在场人物，你决定自己的行动、台词和心理。</p>}
           <small>常驻资料：{options.mode === 'character' ? ai?.runtimeChars ?? '—' : preview.narratorChars} 字符，约 {options.mode === 'character' ? ai?.runtimeEstimatedTokens ?? '—' : preview.narratorEstimatedTokens} Token（粗估，具体以模型为准）。当前为{preview.playProfile === 'low' ? '低' : preview.playProfile === 'high' ? '高' : '中'}档。</small>
          <small>游玩档位只调整工程里已有资料的装配量；如果整书分析尚未提取某段事实，选择高档也不会补出该事实。人物自由文本的知情边界仍需核对。</small>
        </section>
        <section><small>02 · 世界设定／世界书</small><h2>选择进入故事的时刻</h2><p>{preview.projectName}</p>
          <label>搜索进入时间<input type="search" value={entryFilter} onChange={event => setEntryFilter(event.target.value)} placeholder="输入事件名称或原文段落号" /></label>
          <label>进入时间<select aria-label="进入时间" disabled={busy || entriesLoading} value={selectedEntryId ?? ''} onChange={event => {
            const entry = entries.find(item => item.eventId === event.target.value);
             if (entry) { setEntryFilter(''); setPlaceFilter(''); setOptions(current => ({ ...current, entryEventId: entry.eventId, startingPlaceId: undefined, characterId: undefined,
               persona: current.persona.identityId ? { name: '', description: '' } : current.persona })); }
          }}>{entriesLoading && <option value={preview.entryEventId}>正在核对进入时间…</option>}{shownEntries.map(entry => <option key={entry.eventId} value={entry.eventId}>段落 {entry.ordinal} · {entry.title}{entry.prepared ? ' · 已备好' : ''}</option>)}</select></label>
          <small>{entriesLoading ? '正在核对当前工程的事件。' : `已确认事件 ${entries.length} 个；当前显示 ${shownEntries.length} 个。可按名称或段落搜索，选择后用已有资料离线准备。原文段落顺序不一定等于故事世界的时间顺序。`}</small>
          <label>筛选已揭示地点<input type="search" value={placeFilter} onChange={event => setPlaceFilter(event.target.value)} placeholder={`输入地点名称 · 当前可选 ${preview.availablePlaces.length} 处`} /></label>
          <label>玩家选择的开场地点<select disabled={busy} value={options.startingPlaceId ?? ''} onChange={event => setOptions(current => ({ ...current, startingPlaceId: event.target.value || undefined }))}><option value="">不指定 · 由当前剧情决定</option>{shownPlaces.map(place => <option key={place.id} value={place.id}>{place.name}</option>)}{options.startingPlaceId && !shownPlaces.some(place => place.id === options.startingPlaceId) && preview.availablePlaces.filter(place => place.id === options.startingPlaceId).map(place => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label>
          <small>这是玩家游玩分支的入场选择，不会把该地点写成原著事件的确认地点。仅列出当前时间已揭示、已确认的地点。</small>
          {preview.startingScene && <details><summary>查看原著开场资料 · {preview.startingScene.state === 'complete' ? '事件已揭示' : preview.startingScene.state === 'partial' ? '部分已揭示' : '资料待确认'}</summary><p style={{ whiteSpace: 'pre-wrap' }}>{preview.startingScene.context || '没有可安全带入的事件片段。'}</p><p>原著确认地点：{preview.startingScene.locations.join('、') || '尚未确认'}</p><small>后续剧情以你的行动和当前会话为准。</small></details>}
          <p>{preview.worldEntryCount} 条独立运行资料，按当前对话触发。</p><small>当轮世界资料上限 {preview.worldTokenBudget} Token。</small>
          {preview.ruleKinshipPairCount > 0 && <small role="note">当前时间前有 {preview.ruleKinshipPairCount} 组由本地规则提出并已确认的亲属关系。旧规则曾出现词语靠近人名就误判的情况，建议在关系图中核对后再游玩；此处不会改动审核结果。</small>}</section>
        <section className="play-persona"><small>03 · 我的身份</small><h2>你是谁，由你决定</h2>
          <label>进入方式<select disabled={busy} value={options.persona.identityId ?? ''} onChange={event => {
            const character = preview.characters.find(item => item.identityId === event.target.value);
            setOptions({ ...options, persona: character ? { name: character.name, description: '', identityId: character.identityId } : { name: '', description: '' } });
          }}><option value="">自己创建／导入身份</option>{preview.characters.map(character => <option key={character.identityId} value={character.identityId}>扮演 {character.name}</option>)}</select></label>
          {player ? <p>使用本书已揭示的精简人物资料。AI 不会替你决定行动。</p> : <><label>姓名<input disabled={busy} value={options.persona.name} maxLength={80} onChange={event => setOptions({ ...options, persona: { ...options.persona, name: event.target.value } })} placeholder="你在这个世界的名字" /></label><label>身份与一句背景<textarea disabled={busy} rows={3} maxLength={1500} value={options.persona.description} onChange={event => setOptions({ ...options, persona: { ...options.persona, description: event.target.value } })} placeholder="例如：一名初到此地的旅人。" /></label><label className="play-import">导入身份 JSON<input disabled={busy} type="file" accept=".json,application/json" onChange={event => void importIdentity(event.target.files?.[0])} /></label></>}
          {conflict && <p className="play-error" role="alert">你和 AI 选择了同一人物，请换一个人物或使用旁白模式。</p>}
        </section>
        <section><small>04 · 模型连接</small><h2>检查你的模型</h2><p>进入会话后直接打开模型连接，可选择服务、模型并查看真实连接状态。</p><button className="button ghost play-setup-action" disabled={!canStart} onClick={() => void start('model')}>进入并打开模型连接 ↗</button><small>装配只在本地进行；发送行动后才请求模型。</small></section>
        <section><small>05 · 游玩调节</small><h2>按自己的节奏阅读</h2><p>回复长度、创造性、流式显示与故事规则可在此调整。</p><button className="button ghost play-setup-action" disabled={!canStart} onClick={() => void start('tuning')}>进入并打开游玩调节 ↗</button><small>更改身份或模式会开启独立会话，原有聊天保留。</small></section>
        <section><small>06 · 其他设置</small><h2>需要时，再多走一步</h2><p>高级提示词、上下文、群聊、排版和扩展工具仍保留。</p><button className="button ghost play-setup-action" disabled={!canStart} onClick={() => void start('other')}>进入并打开其他设置 ↗</button><small>进入后可在设置侧栏选择其他高级项目。</small></section>
      </div>
      <footer className="play-setup-footer"><div><strong>{preview.projectName} · {options.mode === 'narrator' ? '世界旁白' : ai?.name ?? '请选择人物'}</strong><p>我的身份：{options.persona.name || '尚未填写'} · 已有会话会自动继续</p></div><button className="button primary" disabled={!canStart} onClick={() => void start()}>{busy ? '正在装配并打开会话…' : '开始／继续游玩 →'}</button></footer>
    </>}
  </main>;
}
