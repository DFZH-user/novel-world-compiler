import { useState } from 'react';
import type { RelationshipGraphProjection } from './shared/contracts';
import './RelationshipFocus.css';
import { CharacterEventTimeline } from './CharacterEventTimeline';

const truth: Record<string, string> = { asserted: '已证实', suspected: '疑似', disputed: '有争议', false: '已否定', unknown: '未知', rumor: '传闻' };

export function RelationshipFocus({ projection, onOrdinal }: {
  projection: RelationshipGraphProjection; onOrdinal: (ordinal: number) => void;
}) {
  const [centerId, setCenterId] = useState('');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [showAll, setShowAll] = useState(false);
  const people = [...projection.nodes].sort((a, b) => b.importanceScore - a.importanceScore || a.id.localeCompare(b.id));
  const center = people.find(person => person.id === centerId) ?? people[0];
  const involves = (edge: { sourceIdentityId: string; targetIdentityId: string }) => !!center && (edge.sourceIdentityId === center.id || edge.targetIdentityId === center.id);
  const edges = projection.edges.filter(involves).sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
  const history = projection.history.filter(involves).sort((a, b) => a.firstRevealedOrdinal - b.firstRevealedOrdinal || a.id.localeCompare(b.id));
  const selected = [...edges, ...history].find(edge => edge.id === selectedId);
  const evidence = selected ? projection.evidence.filter(item => item.relationshipId === selected.id) : [];
  const changeCenter = (id: string) => { setCenterId(id); setSelectedId(''); setShowAll(false); };
  return <section className="relationship-focus" aria-label="人物关系与变化">
    <aside className="focus-people panel"><h3>以谁为中心</h3><input aria-label="搜索中心人物" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索已知人物" /><div className="focus-person-list">{people.filter(person => person.name.includes(query.trim())).map(person => <button aria-pressed={person.id === center?.id} key={person.id} onClick={() => changeCenter(person.id)}>{person.name}<small>{person.degree} 条关系</small></button>)}</div></aside>
    <main className="focus-main panel"><header><small>当前阅读位置 · ¶ {projection.entryOrdinal}</small><h2>{center?.name ?? '尚无已知人物'}</h2><p>{edges.length} 条当前关系 · {history.length} 条已揭示记录</p></header><div className="focus-connections">{(showAll ? edges : edges.slice(0, 12)).map(edge => <button key={edge.id} aria-pressed={edge.id === selectedId} onClick={() => setSelectedId(edge.id)}><small>{truth[edge.truthStatus]}{edge.hasConflict ? ' · 存在冲突' : ''}</small><strong>{edge.sourceIdentityId === center?.id ? edge.targetName : edge.sourceName}</strong><span>{edge.sourceName} → {edge.targetName}</span><b>{edge.relationshipType}</b></button>)}</div>{edges.length === 0 && <p>这个阅读位置没有该人物的有效关系。</p>}{edges.length > 12 && <button onClick={() => setShowAll(!showAll)}>{showAll ? '收起次要关系' : `查看其余 ${edges.length - 12} 条关系`}</button>}
    {center && <CharacterEventTimeline key={center.id} projection={projection} identityId={center.id} onOrdinal={onOrdinal} />}
    <section className="focus-timeline"><h3>关系揭示时间线</h3><p>按原文揭示顺序排列；记录只包含当前阅读位置已经知道的内容。</p>{history.map(edge => <article key={edge.id}><button onClick={() => { setSelectedId(edge.id); }}><small>¶ {edge.firstRevealedOrdinal} · {truth[edge.truthStatus]}</small><strong>{edge.sourceName} → {edge.targetName}</strong><span>{edge.relationshipType}</span></button><button aria-label={`回到关系揭示位置 ${edge.firstRevealedOrdinal}`} onClick={() => onOrdinal(edge.firstRevealedOrdinal)}>回到此处</button></article>)}</section></main>
    <aside className="focus-evidence panel"><h3>关系与依据</h3>{selected ? <><h4>{selected.sourceName} → {selected.targetName}</h4><p>{selected.relationshipType} · {truth[selected.truthStatus]}</p><p>{selected.reasoningNote || '没有附加说明。'}</p><p>有效起点：¶ {selected.validFromOrdinal ?? '未标注'}<br />终点：{selected.validToOrdinal === null ? '未揭示 / 持续' : `¶ ${selected.validToOrdinal}`}</p><h4>原文依据 · {evidence.length}</h4>{evidence.map(item => <blockquote key={item.id}><small>¶ {item.paragraphOrdinal}</small>{item.exactQuote}</blockquote>)}</> : <p>选择关系，查看状态、有效区间与原文依据。</p>}</aside>
  </section>;
}
