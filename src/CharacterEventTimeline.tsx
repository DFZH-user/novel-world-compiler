import { useState } from 'react';
import type { RelationshipGraphProjection } from './shared/contracts';

export function CharacterEventTimeline({ projection, identityId, onOrdinal }: {
  projection: RelationshipGraphProjection; identityId: string; onOrdinal: (ordinal: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [keyOnly, setKeyOnly] = useState(true);
  const [limit, setLimit] = useState(20);
  const relevant = (projection.events ?? []).filter(event => event.participants.some(person => person.identityId === identityId));
  const relationEvents = new Set(projection.history.filter(edge => edge.sourceIdentityId === identityId || edge.targetIdentityId === identityId)
    .flatMap(edge => [edge.validFromEventId, edge.validToEventId]).filter(Boolean));
  const matches = relevant.filter(event => (!keyOnly || relationEvents.has(event.id) || event.participants.length > 1)
    && `${event.title}\n${event.summary}`.includes(query.trim()));
  return <section className="focus-story-events" aria-label="人物重要事件时间线"><h3>人物事件时间线</h3><p>重点显示关系起止事件及多人共同参与的事件。仅包含当前阅读位置已完整揭示的资料。</p>
    <div className="focus-event-tools"><input aria-label="搜索人物事件" value={query} onChange={event => { setQuery(event.target.value); setLimit(20); }} placeholder="搜索事件标题或摘要" /><label><input type="checkbox" checked={keyOnly} onChange={event => { setKeyOnly(event.target.checked); setLimit(20); }} />只看重点事件</label></div>
    <small>{matches.length} 个匹配事件 / {relevant.length} 个已知事件</small>
    {matches.slice(0, limit).map(event => <article key={event.id}><small>¶ {event.startOrdinal} — {event.endOrdinal}{relationEvents.has(event.id) ? ' · 关系起止' : ''}</small><h4>{event.title}</h4><p>{event.summary || '暂无事件摘要。'}</p><p>参与人物：{event.participants.map(person => person.name).join('、')}</p><details><summary>原文依据 · {event.evidence.length}</summary>{event.evidence.map(quote => <blockquote key={quote.id}><small>¶ {quote.paragraphOrdinal}</small>{quote.exactQuote}</blockquote>)}</details><button onClick={() => onOrdinal(Math.max(event.endOrdinal, ...event.evidence.map(quote => quote.paragraphOrdinal)))}>查看此时关系</button></article>)}
    {matches.length === 0 && <p>当前筛选下没有已完整揭示的事件。可以取消重点筛选或调整阅读位置。</p>}
    {matches.length > limit && <button onClick={() => setLimit(limit + 20)}>再显示 20 个事件</button>}
  </section>;
}
