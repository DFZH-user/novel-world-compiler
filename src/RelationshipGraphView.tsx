import cytoscape from 'cytoscape';
import { RelationshipFocus } from './RelationshipFocus';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CharacterRelationshipInformationSource,
  CharacterRelationshipRecord,
  CharacterRelationshipTruthStatus,
  RelationshipGraphEdge,
  RelationshipGraphProjection,
} from './shared/contracts';

type LayoutName = 'cose' | 'circle' | 'concentric';
type SelectedItem = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;

const truthLabels: Record<CharacterRelationshipTruthStatus, string> = {
  asserted: '已证实', suspected: '疑似', disputed: '有争议', false: '已否定', unknown: '未知', rumor: '传闻',
};

const sourceLabels: Record<CharacterRelationshipInformationSource, string> = {
  narrator: '叙述者', character: '人物视角', unknown: '来源未知',
};

function unorderedPair(relationship: Pick<CharacterRelationshipRecord, 'sourceIdentityId' | 'targetIdentityId'>): string {
  return [relationship.sourceIdentityId, relationship.targetIdentityId].sort().join('~');
}

function findPath(nodes: Array<{ id: string }>, edges: RelationshipGraphEdge[], start: string, end: string): { nodes: string[]; edges: string[] } | null {
  if (!start || !end || start === end) return start ? { nodes: [start], edges: [] } : null;
  const allowed = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>();
  for (const edge of edges) {
    if (!allowed.has(edge.sourceIdentityId) || !allowed.has(edge.targetIdentityId)) continue;
    adjacency.set(edge.sourceIdentityId, [...(adjacency.get(edge.sourceIdentityId) ?? []), { nodeId: edge.targetIdentityId, edgeId: edge.id }]);
    adjacency.set(edge.targetIdentityId, [...(adjacency.get(edge.targetIdentityId) ?? []), { nodeId: edge.sourceIdentityId, edgeId: edge.id }]);
  }
  const queue = [start];
  const visited = new Set([start]);
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === end) break;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next.nodeId)) continue;
      visited.add(next.nodeId);
      previous.set(next.nodeId, { nodeId: current, edgeId: next.edgeId });
      queue.push(next.nodeId);
    }
  }
  if (!visited.has(end)) return null;
  const pathNodes = [end];
  const pathEdges: string[] = [];
  let cursor = end;
  while (cursor !== start) {
    const step = previous.get(cursor)!;
    pathEdges.unshift(step.edgeId);
    pathNodes.unshift(step.nodeId);
    cursor = step.nodeId;
  }
  return { nodes: pathNodes, edges: pathEdges };
}

export function RelationshipGraphView() {
  const graphContainer = useRef<HTMLDivElement>(null);
  const graph = useRef<cytoscape.Core | null>(null);
  const [viewMode, setViewMode] = useState<'focus' | 'review'>('focus');
  const [projection, setProjection] = useState<RelationshipGraphProjection | null>(null);
  const [entryOrdinal, setEntryOrdinal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [minimumConfidence, setMinimumConfidence] = useState(0);
  const [minimumDegree, setMinimumDegree] = useState(0);
  const [sourceFilter, setSourceFilter] = useState<'all' | CharacterRelationshipInformationSource>('all');
  const [truthFilter, setTruthFilter] = useState<'all' | CharacterRelationshipTruthStatus>('all');
  const [largestComponentOnly, setLargestComponentOnly] = useState(false);
  const [layoutName, setLayoutName] = useState<LayoutName>('cose');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SelectedItem>(null);
  const [pathStart, setPathStart] = useState('');
  const [pathEnd, setPathEnd] = useState('');
  const [path, setPath] = useState<{ nodes: string[]; edges: string[] } | null>(null);
  const [pathMessage, setPathMessage] = useState('');
  const [exportMessage, setExportMessage] = useState('');

  const projectionRequest = useRef(0);
  async function loadProjection(ordinal: number) {
    const request = ++projectionRequest.current;
    setLoading(true);
    setError('');
    try {
      const next = await window.novelCompiler.getRelationshipGraphProjection(ordinal);
      if (request !== projectionRequest.current) return;
      setProjection(next);
      setEntryOrdinal(next.entryOrdinal);
      setSelected(null);
      setPath(null);
      setPathMessage('');
    } catch (loadError) {
      if (request !== projectionRequest.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (request === projectionRequest.current) setLoading(false);
    }
  }

  useEffect(() => { void loadProjection(Number.MAX_SAFE_INTEGER); }, []);
  useEffect(() => {
    if (!projection || entryOrdinal === projection.entryOrdinal) return;
    const timer = window.setTimeout(() => { void loadProjection(entryOrdinal); }, 140);
    return () => window.clearTimeout(timer);
  }, [entryOrdinal, projection?.entryOrdinal]);

  const largestComponentId = useMemo(() => {
    if (!projection) return null;
    const counts = new Map<number, number>();
    for (const node of projection.nodes) counts.set(node.componentId, (counts.get(node.componentId) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  }, [projection]);

  const visible = useMemo(() => {
    if (!projection) return { nodes: [], edges: [] as RelationshipGraphEdge[] };
    const nodes = projection.nodes.filter((node) => node.degree >= minimumDegree
      && (!largestComponentOnly || node.componentId === largestComponentId));
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges = projection.edges.filter((edge) => edge.confidence >= minimumConfidence
      && (sourceFilter === 'all' || edge.informationSourceType === sourceFilter)
      && (truthFilter === 'all' || edge.truthStatus === truthFilter)
      && nodeIds.has(edge.sourceIdentityId) && nodeIds.has(edge.targetIdentityId));
    return { nodes, edges };
  }, [projection, minimumConfidence, minimumDegree, sourceFilter, truthFilter, largestComponentOnly, largestComponentId]);

  const searchMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    if (!needle) return [];
    return visible.nodes.filter((node) => node.name.toLocaleLowerCase('zh-CN').includes(needle)).slice(0, 8);
  }, [query, visible.nodes]);

  useEffect(() => {
    if (!graphContainer.current || viewMode !== 'review') return;
    graph.current?.destroy();
    const parallelGroups = new Map<string, RelationshipGraphEdge[]>();
    for (const edge of visible.edges) {
      const key = unorderedPair(edge);
      parallelGroups.set(key, [...(parallelGroups.get(key) ?? []), edge]);
    }
    const controlDistance = new Map<string, number>();
    for (const group of parallelGroups.values()) {
      group.sort((left, right) => left.id.localeCompare(right.id)).forEach((edge, index) => {
        controlDistance.set(edge.id, (index - (group.length - 1) / 2) * 72);
      });
    }
    const instance = cytoscape({
      container: graphContainer.current,
      minZoom: 0.18,
      maxZoom: 3,
      wheelSensitivity: 0.22,
      elements: [
        ...visible.nodes.map((node) => ({
          group: 'nodes' as const,
          data: { id: node.id, label: node.name, degree: node.degree, tier: node.importanceTier },
          classes: `tier-${node.importanceTier}`,
        })),
        ...visible.edges.map((edge) => ({
          group: 'edges' as const,
          data: {
            id: edge.id, source: edge.sourceIdentityId, target: edge.targetIdentityId, label: edge.relationshipType,
            polarity: edge.polarity ?? 0, strength: edge.strength ?? 0.45, truth: edge.truthStatus,
            controlDistance: controlDistance.get(edge.id) ?? 0,
          },
          classes: `${edge.direction} ${edge.hasConflict ? 'conflict' : ''} truth-${edge.truthStatus}`,
        })),
      ],
      style: [
        { selector: 'node', style: {
          label: 'data(label)', color: '#38515c', 'font-family': 'Georgia, FangSong, serif', 'font-size': 12,
          'text-valign': 'bottom', 'text-margin-y': 7, 'text-outline-color': '#f6f9fa', 'text-outline-width': 2,
          width: 'mapData(degree, 0, 12, 27, 58)', height: 'mapData(degree, 0, 12, 27, 58)',
          'background-color': '#647080', 'border-color': '#b6a476', 'border-width': 1.3,
        } },
        { selector: 'node.tier-core', style: { 'background-color': '#b18642', 'border-color': '#f0cd83', 'border-width': 2.2 } },
        { selector: 'node.tier-important', style: { 'background-color': '#617e8d', 'border-color': '#a9ccd3' } },
        { selector: 'node.tier-minor', style: { 'background-color': '#545e6a' } },
        { selector: 'edge', style: {
          label: 'data(label)', color: '#5c747e', 'font-size': 9, 'font-family': 'Microsoft YaHei UI, sans-serif',
          'text-background-color': '#f6f9fa', 'text-background-opacity': 0.86, 'text-background-padding': '2px',
          width: 'mapData(strength, 0, 1, 1, 4)', 'line-color': '#81785f', 'curve-style': 'unbundled-bezier',
          'control-point-distances': 'data(controlDistance)', 'control-point-weights': 0.5,
          'target-arrow-color': '#81785f', 'source-arrow-color': '#81785f', 'arrow-scale': 0.7,
        } },
        { selector: 'edge.directed', style: { 'target-arrow-shape': 'triangle' } },
        { selector: 'edge.reciprocal', style: { 'target-arrow-shape': 'triangle', 'source-arrow-shape': 'triangle' } },
        { selector: 'edge[polarity < 0]', style: { 'line-color': '#a4555d', 'target-arrow-color': '#a4555d', 'source-arrow-color': '#a4555d' } },
        { selector: 'edge[polarity > 0]', style: { 'line-color': '#5f9674', 'target-arrow-color': '#5f9674', 'source-arrow-color': '#5f9674' } },
        { selector: 'edge.truth-rumor, edge.truth-suspected, edge.truth-unknown', style: { 'line-style': 'dashed', opacity: 0.72 } },
        { selector: 'edge.conflict', style: { 'line-color': '#e68b52', 'target-arrow-color': '#e68b52', 'source-arrow-color': '#e68b52', 'line-style': 'dotted', 'z-index': 10 } },
        { selector: ':selected', style: { 'overlay-color': '#66988f', 'overlay-opacity': 0.16, 'overlay-padding': 7 } },
        { selector: '.path', style: { 'line-color': '#357e77', 'target-arrow-color': '#357e77', 'source-arrow-color': '#357e77', 'background-color': '#4d9287', 'z-index': 20 } },
      ],
    });
    instance.on('tap', 'node', (event) => setSelected({ kind: 'node', id: event.target.id() }));
    instance.on('tap', 'edge', (event) => setSelected({ kind: 'edge', id: event.target.id() }));
    instance.on('tap', (event) => { if (event.target === instance) setSelected(null); });
    const effectiveLayout = layoutName === 'cose' && visible.nodes.length > 300 ? 'concentric' : layoutName;
    const layout = instance.layout({ name: effectiveLayout, animate: false, animationDuration: 420, fit: true, padding: 45 });
    layout.run();
    graph.current = instance;
    return () => { layout.stop(); instance.stop(true, false); instance.elements().stop(true, false); instance.destroy(); if (graph.current === instance) graph.current = null; };
  }, [viewMode, visible.nodes, visible.edges, layoutName]);

  useEffect(() => {
    const instance = graph.current;
    if (!instance) return;
    instance.elements().removeClass('path');
    if (!path) return;
    for (const id of [...path.nodes, ...path.edges]) instance.getElementById(id).addClass('path');
  }, [path]);

  function focusNode(identityId: string) {
    setSelected({ kind: 'node', id: identityId });
    const item = graph.current?.getElementById(identityId);
    if (item?.length) {
      graph.current?.elements().unselect();
      item.select();
      graph.current?.animate({ center: { eles: item }, zoom: 1.35 }, { duration: 260 });
    }
  }

  function calculatePath() {
    const result = findPath(visible.nodes, visible.edges, pathStart, pathEnd);
    setPath(result);
    setPathMessage(result ? `最短链路 ${Math.max(0, result.nodes.length - 1)} 跳` : '当前筛选和阅读位置下不存在可见路径');
  }

  async function exportCurrentGraph() {
    setError('');
    try {
      const result = await window.novelCompiler.exportRelationshipGraph(entryOrdinal);
      if (result) setExportMessage(`已导出 ${result.graph.nodes.length} 个节点、${result.graph.relationships.length} 条已揭示关系 · SHA256 ${result.checksum.slice(0, 12)}…`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function exportWorldInfo() {
    setError('');
    try {
      const result = await window.novelCompiler.exportRelationshipWorldInfo(entryOrdinal);
      if (result) setExportMessage(`已导出 SillyTavern 世界书 ${Object.keys(result.worldInfo.entries).length} 个条目 · SHA256 ${result.checksum.slice(0, 12)}…`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  const selectedNode = selected?.kind === 'node' ? projection?.nodes.find((node) => node.id === selected.id) ?? null : null;
  const selectedEdge = selected?.kind === 'edge' ? projection?.edges.find((edge) => edge.id === selected.id) ?? null : null;
  const selectedEvidence = selectedEdge ? projection?.evidence.filter((item) => item.relationshipId === selectedEdge.id) ?? [] : [];
  const pairHistory = selectedEdge ? projection?.history.filter((item) => unorderedPair(item) === unorderedPair(selectedEdge)) ?? [] : [];

  return <section className="relationship-graph-view">
    <div className="page-title"><p>RELATIONSHIP ATLAS</p><h2>防剧透关系图谱</h2><span>图、搜索、详情与路径共用同一阅读位置快照；未来关系、证据与有效期终点不会进入前端。</span></div>
    <div className="graph-time-console panel">
      <div className="graph-time-copy"><span>阅读坐标</span><strong>¶ {entryOrdinal}</strong><small>{loading ? '正在重建安全视图…' : `已揭示 ${projection?.revealedRelationshipCount ?? 0} 条 · 当前有效 ${projection?.edges.length ?? 0} 条`}</small></div>
      <label><span>时间 / 剧透边界</span><input aria-label="关系图阅读位置" type="range" min={0} max={projection?.maximumOrdinal ?? 0} value={entryOrdinal} onChange={(event) => setEntryOrdinal(Number(event.target.value))} /></label>
      <div className="graph-fence-seal"><b>FENCE</b><span>统一边界已启用</span><div className="graph-export-buttons"><button disabled={loading} onClick={() => void exportCurrentGraph()}>导出图 JSON</button><button disabled={loading} onClick={() => void exportWorldInfo()}>导出世界书</button></div></div>
    </div>
    {error && <div className="graph-error">{error}</div>}
    {exportMessage && <div className="graph-export-result">{exportMessage}</div>}
    <div className="relationship-mode" role="group" aria-label="关系图视图"><button aria-pressed={viewMode === 'focus'} onClick={() => setViewMode('focus')}>人物与时间线</button><button aria-pressed={viewMode === 'review'} onClick={() => setViewMode('review')}>完整关系图与核查</button></div>
    {viewMode === 'focus' && projection && <RelationshipFocus projection={projection} onOrdinal={setEntryOrdinal} />}
    <div style={{ display: viewMode === 'review' ? 'block' : 'none' }}>
    <div className="graph-filter-bar panel">
      <label><span>最低置信度 · {Math.round(minimumConfidence * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))} /></label>
      <label><span>最低度数 · {minimumDegree}</span><input type="range" min={0} max={Math.max(1, ...((projection?.nodes ?? []).map((node) => node.degree)))} value={minimumDegree} onChange={(event) => setMinimumDegree(Number(event.target.value))} /></label>
      <label><span>信息来源</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}><option value="all">全部来源</option>{Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>真实性</span><select value={truthFilter} onChange={(event) => setTruthFilter(event.target.value as typeof truthFilter)}><option value="all">全部状态</option>{Object.entries(truthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="component-switch"><input type="checkbox" checked={largestComponentOnly} onChange={(event) => setLargestComponentOnly(event.target.checked)} /><span>仅主连通分量</span></label>
    </div>
    <div className="graph-workspace">
      <aside className="graph-tools panel">
        <div className="graph-search"><span>人物定位</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入姓名…" />{searchMatches.map((node) => <button key={node.id} onClick={() => focusNode(node.id)}><strong>{node.name}</strong><small>{node.degree} 条可见关系</small></button>)}</div>
        <div className="graph-path"><span>关系路径</span><select value={pathStart} onChange={(event) => setPathStart(event.target.value)}><option value="">起点人物</option>{visible.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select><select value={pathEnd} onChange={(event) => setPathEnd(event.target.value)}><option value="">终点人物</option>{visible.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select><button disabled={!pathStart || !pathEnd} onClick={calculatePath}>查找最短链路</button>{pathMessage && <small>{pathMessage}</small>}</div>
        <div className="graph-layout"><span>布局</span>{(['cose', 'concentric', 'circle'] as LayoutName[]).map((name) => <button className={layoutName === name ? 'active' : ''} key={name} onClick={() => setLayoutName(name)}>{name === 'cose' ? '关系力导向' : name === 'concentric' ? '核心同心层' : '环形总览'}</button>)}{layoutName === 'cose' && visible.nodes.length > 300 && <small>超过 300 节点，已自动使用同心布局避免阻塞。</small>}</div>
        <div className="graph-legend"><span>图例</span><i className="positive" />正向 <i className="negative" />负向 <i className="uncertain" />未定 <i className="conflict" />冲突</div>
      </aside>
      <div className="graph-stage panel"><div ref={graphContainer} className="graph-canvas" />{!loading && visible.nodes.length === 0 && <div className="graph-empty"><b>此处尚无可见关系</b><span>移动阅读位置，或放宽左侧筛选条件。</span></div>}<div className="graph-stage-count">{visible.nodes.length} NODES / {visible.edges.length} EDGES</div></div>
      <aside className="graph-inspector panel">
        {!selectedNode && !selectedEdge && <div className="graph-inspector-empty"><span>INSPECTOR</span><b>选择人物或关系</b><p>详情只显示当前阅读坐标已经揭示的内容。</p></div>}
        {selectedNode && <div className="graph-node-detail"><span>CHARACTER NODE</span><h3>{selectedNode.name}</h3><dl><div><dt>可见关系度数</dt><dd>{selectedNode.degree}</dd></div><div><dt>重要度</dt><dd>{selectedNode.importanceTier}</dd></div><div><dt>首次入图</dt><dd>¶ {selectedNode.firstRevealedOrdinal}</dd></div><div><dt>连通分量</dt><dd>#{selectedNode.componentId}</dd></div></dl></div>}
        {selectedEdge && <div className="graph-edge-detail"><span>{selectedEdge.hasConflict ? 'CONFLICT FLAG' : 'RELATION ASSERTION'}</span><h3>{selectedEdge.sourceName}<b>→</b>{selectedEdge.targetName}</h3><h4>{selectedEdge.relationshipType}</h4><div className="edge-status"><em>{truthLabels[selectedEdge.truthStatus]}</em><em>{sourceLabels[selectedEdge.informationSourceType]}</em><em>{Math.round(selectedEdge.confidence * 100)}%</em></div><p>{selectedEdge.reasoningNote || '没有附加推理说明。'}</p><dl><div><dt>方向</dt><dd>{selectedEdge.direction}</dd></div><div><dt>强度</dt><dd>{selectedEdge.strength === null ? '未标注' : `${Math.round(selectedEdge.strength * 100)}%`}</dd></div><div><dt>有效区间</dt><dd>¶ {selectedEdge.validFromOrdinal ?? '—'} — {selectedEdge.validToOrdinal ?? '未揭示 / 持续'}</dd></div><div><dt>首次揭示</dt><dd>¶ {selectedEdge.firstRevealedOrdinal}</dd></div></dl><section className="graph-evidence"><strong>可见证据 · {selectedEvidence.length}</strong>{selectedEvidence.map((item) => <blockquote key={item.id}><span>¶ {item.paragraphOrdinal} · {item.evidenceRole}</span>{item.exactQuote}</blockquote>)}</section><section className="graph-evolution"><strong>双方关系演化 · {pairHistory.length}</strong>{pairHistory.map((item) => <div className={item.id === selectedEdge.id ? 'current' : ''} key={item.id}><i /><span>¶ {item.firstRevealedOrdinal}</span><b>{item.relationshipType}</b><small>{truthLabels[item.truthStatus]}</small></div>)}</section></div>}
      </aside>
    </div>
    </div>
  </section>;
}
