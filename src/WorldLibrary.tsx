import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ProjectBundleAvailability, ProjectSummary, SillyTavernStatus } from './shared/contracts';

type Props = { status: SillyTavernStatus; onEnterCompiler: (id?: string) => void; onEnterTavern: () => void; onEnterPlay: (id: string) => void; onStopTavern: () => void };
const tones = ['#879f97', '#8faaba', '#c2af92', '#a2a6bc', '#b6a3a5', '#83a9a7'];
export function WorldLibrary({ status, onEnterCompiler, onEnterTavern, onEnterPlay, onStopTavern }: Props) {
  const [books, setBooks] = useState<ProjectSummary[]>([]);
  const [selected, setSelected] = useState(() => localStorage.getItem('nw-selected-book') || '');
  const [query, setQuery] = useState('');
  const [list, setList] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [choiceBookId, setChoiceBookId] = useState<string | null>(null);
  const [bundleReport, setBundleReport] = useState<ProjectBundleAvailability | null>(null);
  const [bundleLoading, setBundleLoading] = useState(false);
  const [name, setName] = useState('');
  const lock = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gallery = useRef<HTMLDivElement>(null);
  const filtered = books.filter(book => book.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const index = Math.max(0, filtered.findIndex(b => b.id === selected));
  const book = filtered[index];
  const choiceBook = books.find(item => item.id === choiceBookId);
  useEffect(() => {
    if (!choiceBookId) { setBundleReport(null); return; }
    let active = true;
    setBundleLoading(true); setBundleReport(null);
    window.novelCompiler.inspectProjectBundle(choiceBookId)
      .then(report => { if (active) setBundleReport(report); })
      .catch(error => { if (active) setBundleReport({ state: 'invalid', message: error instanceof Error ? error.message : String(error), packageDirectory: null, specVersion: null, characterCount: 0 }); })
      .finally(() => { if (active) setBundleLoading(false); });
    return () => { active = false; };
  }, [choiceBookId]);
  useEffect(() => {
    let mounted = true;
    window.novelCompiler.listProjectLibrary().then(items => { if (mounted) setBooks(items); }).catch(e => { if (mounted) setError(String(e.message || e)); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; clearTimeout(timer.current); };
  }, []);
  function choose(id: string) { if (lock.current) return; setSelected(id); localStorage.setItem('nw-selected-book', id); }
  function openChoice(id: string) { choose(id); setChoiceBookId(id); }
  function step(direction: number) { if (filtered.length) choose(filtered[(index + direction + filtered.length) % filtered.length].id); }
  const stepRef = useRef(step); stepRef.current = step;
  useEffect(() => {
    const node = gallery.current; if (!node) return;
    let last = 0;
    const wheel = (event: WheelEvent) => { event.preventDefault(); if (Date.now() - last > 300 && Math.abs(event.deltaY + event.deltaX) > 8) { last = Date.now(); stepRef.current(Math.sign(event.deltaY + event.deltaX)); } };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, [loading, list, filtered.length]);
  async function act(operation: () => Promise<ProjectSummary | null>, destination: 'compiler' | 'choice' = 'compiler') {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await operation();
      if (!result) { lock.current = false; setBusy(false); return; }
      setSelected(result.id); localStorage.setItem('nw-selected-book', result.id);
      setBooks(current => current.some(b => b.id === result.id) ? current.map(b => b.id === result.id ? result : b) : [...current, result]);
      if (destination === 'choice') {
        setCreating(false); setList(false); setQuery(''); setChoiceBookId(result.id);
        lock.current = false; setBusy(false);
        return;
      }
      setCreating(false); setList(false); setQuery(''); setPhase('gather');
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
      timer.current = setTimeout(() => { setPhase('unfold'); timer.current = setTimeout(() => onEnterCompiler(result.id), reduced ? 0 : 320); }, reduced ? 0 : 650);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setPhase(''); lock.current = false; setBusy(false); }
  }
  if (choiceBook) return <main className="world-library library-choice" aria-busy={busy}>
    <header className="library-header"><div className="library-brand"><span className="library-mark">世</span><span>小说世界<small>NOVEL WORLD</small></span></div><button className="library-choice-back" onClick={() => setChoiceBookId(null)} disabled={busy}>← 返回书库</button></header>
    <section className="library-choice-content" aria-labelledby="library-choice-title">
      <p className="library-kicker">ONE BOOK · TWO PATHS</p>
      <h1 id="library-choice-title">{choiceBook.name}</h1>
      <p className="library-choice-intro">一本书就是一个工程。先整理故事，等游玩资料真正就绪，再从这里进入故事。</p>
      <div className="library-choice-routes">
        <button className="library-choice-route compiler" disabled={busy} onClick={() => void act(() => window.novelCompiler.openRecentProject(choiceBook.id))}>
          <span className="route-index">01 / COMPILE</span><strong>进入编译工作台</strong>
          <span>{choiceBook.activeRevisionId ? '继续检查、整理和生成这本书的成果' : '导入原文，开始构建这个世界'}</span><i aria-hidden="true">↗</i>
        </button>
        <button className={'library-choice-route reading ' + (bundleReport?.state === 'ready-for-assembly' ? '' : 'locked')}
          disabled={busy || bundleLoading || bundleReport?.state !== 'ready-for-assembly'} onClick={() => onEnterPlay(choiceBook.id)}>
          <span className="route-index">02 / PLAY · {bundleReport?.state === 'ready-for-assembly' ? '准备游玩' : '资料待就绪'}</span><strong>进入沉浸阅读</strong>
          <span role="status">{bundleLoading ? '正在核对这本书的可游玩资源…' : bundleReport?.message ?? '尚未核对可游玩资源。'}</span>
          <i aria-hidden="true">{bundleReport?.state === 'ready-for-assembly' ? '↗' : '锁'}</i>
        </button>
      </div>
      <details className="library-choice-legacy"><summary>旧版手动酒馆入口</summary><p>仅打开原有 SillyTavern，不会自动导入当前工程的角色卡或世界书。已有手动配置与会话保持原样。</p><button disabled={busy || !status.bundled || status.state === 'starting'} onClick={onEnterTavern}>打开旧版酒馆 ↗</button></details>
      {error && <div className="library-error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
    </section>
  </main>;
  return <main className={'world-library ' + phase} aria-busy={busy}>
    <header className="library-header"><div className="library-brand"><span className="library-mark">世</span><span>小说世界<small>NOVEL WORLD</small></span></div><span className="library-header-label">我的书库</span><button className="library-add" onClick={() => setCreating(true)} disabled={busy}>＋ 新建工程</button></header>
    <section className="library-heading"><p className="library-kicker">YOUR STORIES, UNFOLDED</p><h1>每一本书，<br/>都是一个世界。</h1><p>在字里行间，重新遇见故事。</p></section>
    <div className="library-tools"><label><span>⌕</span><input aria-label="搜索书库" placeholder="寻找一本书…" value={query} disabled={busy} onChange={e => setQuery(e.target.value)} /></label><button aria-pressed={list} onClick={() => setList(!list)} disabled={busy}>{list ? '◈ 立体书架' : '☷ 书籍列表'}</button><button onClick={() => void act(() => window.novelCompiler.openProject(), 'choice')} disabled={busy}>打开已有工程 ↗</button></div>
    {error && <div className="library-error" role="alert">{error}<button onClick={() => setError('')} aria-label="关闭提示">×</button></div>}
    {loading ? <div className="library-empty" role="status">正在打开书库…</div> : !filtered.length ? <section className="library-empty"><span>◫</span><h2>{query ? '还没有找到这本书' : '故事，从第一本书开始'}</h2><p>{query ? '试试其他书名，或清空搜索。' : '打开已有工程加入书库，或新建工程导入 TXT。'}</p><button className="button primary" onClick={() => query ? setQuery('') : void act(() => window.novelCompiler.openProject(), 'choice')}>{query ? '查看全部' : '打开已有工程'}</button></section> : list ? <section className="library-list" aria-label="书籍列表">{filtered.map((b, i) => <button key={b.id} disabled={busy} className={book?.id === b.id ? 'selected' : ''} onClick={() => openChoice(b.id)}><span>{String(i + 1).padStart(2, '0')}</span><strong>{b.name}</strong><small>{b.activeRevisionId ? '已导入原文' : '等待导入'}</small><span>↗</span></button>)}</section> : <div ref={gallery} className="library-gallery" role="group" aria-label="选择书籍，使用左右方向键或滚轮" onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); } }}>
      {filtered.map((b, i) => { const distance = i - index; if (Math.abs(distance) > 4) return null; const active = book?.id === b.id; const hash = Array.from(b.name).reduce((a, c) => a + c.charCodeAt(0), 0); return <button key={b.id} className={'library-book ' + (active ? 'selected' : '')} disabled={busy} aria-label={'选择《' + b.name + '》'} aria-pressed={active} style={{ '--offset': distance, '--depth': Math.abs(distance), '--tone': tones[hash % tones.length], '--order': active ? 20 : 10 - Math.abs(distance) } as CSSProperties} onClick={() => openChoice(b.id)}><span className="book-glass"><span className="cover-orbit"/><span className="cover-landscape"/><span className="cover-line"/><small>NOVEL / WORLD</small><strong>{b.name}</strong><span className="cover-footer">一卷文字 · 万千可能</span></span></button>; })}
    </div>}
    {book && <footer className="library-selection"><div className="library-pager"><button aria-label="上一本" disabled={busy || filtered.length < 2} onClick={() => step(-1)}>←</button><span>{String(index + 1).padStart(2, '0')} <small>/ {String(filtered.length).padStart(2, '0')}</small></span><button aria-label="下一本" disabled={busy || filtered.length < 2} onClick={() => step(1)}>→</button></div><div className="selected-copy"><small>{book.activeRevisionId ? '已导入原文 · 可以继续编译' : '新工程 · 等待导入原文'}</small><h2>{book.name}</h2></div><button className="library-enter" disabled={busy} onClick={() => openChoice(book.id)}>打开这本书 <span>↗</span></button></footer>}
    <div className="library-footnote"><span>{books.length ? books.length + ' 本工程 · 本地书库' : 'LOCAL LIBRARY'}</span><span>酒馆保留上次会话；角色卡可从编译器导出后载入。</span>{status.state === 'ready' && <button onClick={onStopTavern}>结束酒馆后台运行</button>}</div>
    {creating && <div className="library-modal" onKeyDown={e => { if (e.key === 'Escape' && !busy) setCreating(false); }}><form role="dialog" aria-modal="true" aria-labelledby="new-book-title" onSubmit={e => { e.preventDefault(); if (name.trim()) void act(() => window.novelCompiler.createProject(name.trim())); }}><p className="library-kicker">A NEW BEGINNING</p><h2 id="new-book-title">给世界一个名字</h2><label>工程名称<input autoFocus required maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder="输入书名" disabled={busy}/></label><p>选择保存位置后，在工作台导入小说原文。</p>{error && <p role="alert">{error}</p>}<div><button type="button" className="button ghost" onClick={() => setCreating(false)} disabled={busy}>取消</button><button className="button primary" disabled={busy || !name.trim()}>选择保存位置 →</button></div></form></div>}
  </main>;
}
