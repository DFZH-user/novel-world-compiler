import { useEffect, useState } from 'react';
import type { SillyTavernWorldInfoEntry } from './shared/contracts';

export function WorldBookPreview({ ordinal, onNavigate }: { ordinal: number; onNavigate: (view: 'relationship-graph' | 'narrative-map') => void }) {
  const [entries, setEntries] = useState<Array<{ source: string; entry: Pick<SillyTavernWorldInfoEntry, 'uid' | 'comment' | 'key' | 'content'> }>>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(30);
  useEffect(() => {
    let active = true; setLoading(true); setEntries([]); setError(''); setLimit(30);
    window.novelCompiler.previewWorldBook(ordinal).then(result => {
      if (active) setEntries([
        ...Object.values(result.relationships.entries).map(entry => ({ source: '人物与关系', entry })),
        ...Object.values(result.places.entries).map(entry => ({ source: '地点与空间', entry })),
      ]);
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [ordinal]);
  const needle = query.trim().toLocaleLowerCase();
  const filtered = entries.filter(({ entry }) => `${entry.comment} ${entry.key.join(' ')} ${entry.content}`.toLocaleLowerCase().includes(needle));
  return <section className="panel" aria-label="世界书内容预览" style={{ padding: 24, marginTop: 20 }}>
    <header><h3>世界书 · 当前进入点</h3><p>仅显示到段落 {ordinal} 已揭示的关系与地点资料。修改请前往对应工作台；游玩时的人物精简资料另行按需装配。</p></header>
    <div className="artifact-proof-actions">
      <button className="button ghost" onClick={() => onNavigate('relationship-graph')}>前往人物关系工作台</button>
      <button className="button ghost" onClick={() => onNavigate('narrative-map')}>前往世界地图工作台</button>
    </div>
    <label style={{ display: 'grid', gap: 8, maxWidth: 520, margin: '20px 0' }}>搜索世界书<input style={{ padding: '10px 12px', border: '1px solid #cfddd6', borderRadius: 8, font: 'inherit' }} aria-label="搜索世界书内容" value={query} onChange={event => { setQuery(event.target.value); setLimit(30); }} placeholder="人物、地点或设定关键词" /></label>
    {loading ? <p role="status">正在读取已有资料…</p> : error ? <p role="alert">{error}</p> : <>
      <p>{filtered.length} 条匹配 / 共 {entries.length} 条</p>
      {filtered.slice(0, limit).map(({ source, entry }, index) => <details key={`${source}-${entry.uid}-${index}`} style={{ borderTop: '1px solid #dce5df', padding: '14px 0' }}>
        <summary>{entry.comment || entry.key.join('、')} · {source}</summary>
        <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{entry.content}</p>
        <small>触发词：{entry.key.join('、') || '无'}</small>
      </details>)}
      {!filtered.length && <p>没有匹配资料，可调整关键词或到对应工作台检查已确认内容。</p>}
      {filtered.length > limit && <button className="button ghost" onClick={() => setLimit(value => value + 30)}>继续查看 30 条</button>}
    </>}
  </section>;
}
