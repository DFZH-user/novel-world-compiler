import { useState } from 'react';
import type { NarrativeMapProjection } from './shared/contracts';
import './WorldAtlas.css';
import { AtlasCanvas } from './AtlasCanvas';

/** Layout v1: deterministic index positions, never geographic coordinates. */
export function WorldAtlas({ projection }: { projection: NarrativeMapProjection }) {
  const [eventId, setEventId] = useState('');
  const [scope, setScope] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(0);
  const nodes = [...projection.nodes].sort((a, b) => b.importanceScore - a.importanceScore || a.id.localeCompare(b.id));
  const parent = nodes.find(node => node.id === scope);
  const selected = nodes.find(node => node.id === selectedId);
  const needle = query.trim().toLocaleLowerCase('zh-CN');
  const recentEvents = [...projection.events].sort((a,b) => b.narrativeStartOrdinal - a.narrativeStartOrdinal).slice(0, 30);
  const scene = recentEvents.find(event => event.id === eventId);
  const highlighted = new Set(scene?.places.map(place => place.placeId) ?? []);
  const matches = nodes.filter(node => (!scene || highlighted.has(node.id))).filter(node => needle ? [node.name, ...node.aliases].some(name => name.toLocaleLowerCase('zh-CN').includes(needle)) : scene ? true : parent ? node.parentId === parent.id && !node.hierarchyConflict : !node.parentId || node.hierarchyConflict || !nodes.some(candidate => candidate.id === node.parentId));
  const safePage = Math.min(page, Math.max(0, Math.ceil(matches.length / 24) - 1));
  const shown = matches.slice(safePage * 24, safePage * 24 + 24);
  const events = selected ? projection.events.filter(event => event.places.some(place => place.placeId === selected.id)) : [];
  const relations = selected ? projection.edges.filter(edge => edge.sourcePlaceId === selected.id || edge.targetPlaceId === selected.id) : [];
  const relationIds = new Set(relations.map(edge => edge.id));
  const evidence = projection.evidence.filter(item => relationIds.has(item.relationId));
  const enter = (id: string) => { setScope(id); setQuery(''); setEventId(''); setPage(0); };
  return <section className="world-atlas" aria-label="世界地点总览">
    <div className="atlas-toolbar"><div><small>世界图册 · 布局版本 2</small><h3>{parent?.name ?? '世界概览'}</h3></div><label>搜索全部已知地点<input aria-label="图册搜索地点" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="地点名称或别名" /></label><div className="atlas-zoom"><button aria-label="缩小图册" disabled={zoom <= 0.75} onClick={() => setZoom(value => Math.max(.75, value - .25))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大图册" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + .25))}>＋</button></div></div>
    <p className="atlas-note">示意位置 · 点位与区域外框仅用于浏览，不表示方向、距离或行政边界。{projection.edges.length === 0 ? '本工程尚无已确认空间关系，按示意位置展示，不能推断真实地理。' : '区域层级仅使用当前已确认的包含关系。'}</p>
    <label className="atlas-scene">剧情相关地点<select aria-label="地图剧情事件" value={scene?.id ?? ''} onChange={event => { setEventId(event.target.value); setQuery(''); setPage(0); }}><option value="">不叠加事件</option>{recentEvents.map(event => <option key={event.id} value={event.id}>¶ {event.narrativeStartOrdinal} · {event.title}</option>)}</select>{scene && <span>{scene.places.length} 个关联地点；当前只展示这些地点，不代表人物移动路线。</span>}</label>
    <div className="atlas-breadcrumb"><button onClick={() => enter('')}>世界概览</button>{parent && <><span> / {parent.name}</span><button onClick={() => enter(parent.parentId ?? '')}>返回上层</button></>}{needle && <span>搜索结果 · {matches.length}</span>}</div>
    <div className="atlas-workspace"><main className="atlas-paper"><div className="atlas-scroll"><AtlasCanvas nodes={shown} allNodes={nodes} selectedId={selectedId} highlighted={highlighted} zoom={zoom} onSelect={setSelectedId} onEnter={enter} /></div>{shown.length === 0 && <p className="atlas-empty">当前范围没有已确认地点，请返回概览或更换搜索词。</p>}<footer><span>{matches.length} 个地点 · 第 {safePage + 1} / {Math.max(1, Math.ceil(matches.length / 24))} 页</span><button disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>上一页</button><button disabled={(safePage + 1) * 24 >= matches.length} onClick={() => setPage(safePage + 1)}>下一页</button></footer></main>
    <aside className="atlas-detail panel"><small>地点档案</small><h3>{selected?.name ?? '选择一个地点'}</h3>{selected ? <><p>{selected.aliases.length ? `别名：${selected.aliases.join('、')}` : '暂无别名'}</p><p>首次揭示：¶ {selected.firstRevealedOrdinal}</p><p>所属区域：{selected.hierarchyConflict ? '存在冲突，待核实' : nodes.find(node => node.id === selected.parentId)?.name ?? '尚无足够证据'}</p><h4>当前空间关系 · {relations.length}</h4>{relations.map(edge => <p key={edge.id}>{nodes.find(node => node.id === edge.sourcePlaceId)?.name} → {nodes.find(node => node.id === edge.targetPlaceId)?.name}<br />{edge.relationKind} · {edge.truthStatus}</p>)}<h4>原文依据 · {evidence.length}</h4>{evidence.slice(0, 12).map(item => <blockquote key={item.id}>{item.exactQuote}</blockquote>)}{evidence.length > 12 && <p>更多证据请在“空间关系核查”中查看。</p>}<h4>已知地点事件 · {events.length}</h4>{events.slice(0, 20).map(event => <p key={event.id}><small>¶ {event.narrativeStartOrdinal}</small><br />{event.title}</p>)}{events.length > 20 && <p>其余事件可在工作台事件列表中查看。</p>}</> : <p>可查看区域层级、空间关系证据和当前阅读位置已知的地点事件。</p>}</aside></div>
  </section>;
}
