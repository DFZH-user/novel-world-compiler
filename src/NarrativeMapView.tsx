import cytoscape from 'cytoscape';
import { WorldAtlas } from './WorldAtlas';
import { useEffect, useMemo, useRef, useState } from 'react';
import { selectMapOverview } from './shared/map-overview';
import type {
  NarrativeMapEdge,
  NarrativeMapProjection,
  NarrativeMapTopologyClass,
  PlaceGeometryCertainty,
  PlaceGeometryRecord,
  PlaceGeometrySourceKind,
  PlaceRelationRecord,
  PlaceType,
} from './shared/contracts';

type LayoutName = 'cose' | 'breadthfirst' | 'circle';
type SelectedItem = { kind: 'node'; id: string } | { kind: 'edge'; id: string } | null;
type TruthFilter = 'all' | NarrativeMapEdge['truthStatus'];
type GeometryForm = {
  longitude: string;
  latitude: string;
  sourceKind: PlaceGeometrySourceKind;
  sourceLabel: string;
  sourceUri: string;
  certainty: PlaceGeometryCertainty;
  note: string;
};

const emptyGeometryForm: GeometryForm = {
  longitude: '', latitude: '', sourceKind: 'manual', sourceLabel: '', sourceUri: '', certainty: 'certain', note: '',
};

const topologyLabels: Record<NarrativeMapTopologyClass, string> = {
  hierarchy: '包含层级', connection: '通路连接', direction: '相对方位', proximity: '远近邻接', other: '其他拓扑',
};
const truthLabels: Record<NarrativeMapEdge['truthStatus'], string> = {
  asserted: '已证实', suspected: '疑似', disputed: '有争议', false: '已否定', unknown: '未知', rumor: '传闻',
};
const sourceLabels: Record<NarrativeMapEdge['informationSourceType'], string> = {
  narrator: '叙述者', character: '人物视角', unknown: '来源未知',
};
const placeTypeLabels: Record<PlaceType, string> = {
  realm: '世界 / 界域', region: '区域', country: '国家', city: '城市', settlement: '聚落', district: '片区',
  route: '路线', natural: '自然地貌', building: '建筑', room: '房间', landmark: '地标', other: '其他',
};

function unorderedPair(relation: Pick<PlaceRelationRecord, 'sourcePlaceId' | 'targetPlaceId'>): string {
  return [relation.sourcePlaceId, relation.targetPlaceId].sort().join('~');
}

function findPath(nodes: Array<{ id: string }>, edges: NarrativeMapEdge[], start: string, end: string): { nodes: string[]; edges: string[] } | null {
  if (!start || !end || start === end) return start ? { nodes: [start], edges: [] } : null;
  const allowed = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, Array<{ nodeId: string; edgeId: string }>>();
  for (const edge of edges) {
    if (!allowed.has(edge.sourcePlaceId) || !allowed.has(edge.targetPlaceId)) continue;
    adjacency.set(edge.sourcePlaceId, [...(adjacency.get(edge.sourcePlaceId) ?? []), { nodeId: edge.targetPlaceId, edgeId: edge.id }]);
    adjacency.set(edge.targetPlaceId, [...(adjacency.get(edge.targetPlaceId) ?? []), { nodeId: edge.sourcePlaceId, edgeId: edge.id }]);
  }
  const queue = [start]; const visited = new Set([start]);
  const previous = new Map<string, { nodeId: string; edgeId: string }>();
  while (queue.length) {
    const current = queue.shift()!;
    if (current === end) break;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next.nodeId)) continue;
      visited.add(next.nodeId); previous.set(next.nodeId, { nodeId: current, edgeId: next.edgeId }); queue.push(next.nodeId);
    }
  }
  if (!visited.has(end)) return null;
  const pathNodes = [end]; const pathEdges: string[] = []; let cursor = end;
  while (cursor !== start) {
    const step = previous.get(cursor)!;
    pathNodes.unshift(step.nodeId); pathEdges.unshift(step.edgeId); cursor = step.nodeId;
  }
  return { nodes: pathNodes, edges: pathEdges };
}

export function NarrativeMapView() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<cytoscape.Core | null>(null);
  const pendingFocus = useRef<string | null>(null);
  const [viewMode, setViewMode] = useState<'atlas' | 'review'>('atlas');
  const [projection, setProjection] = useState<NarrativeMapProjection | null>(null);
  const [entryOrdinal, setEntryOrdinal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [topologyFilter, setTopologyFilter] = useState<'all' | NarrativeMapTopologyClass>('all');
  const [truthFilter, setTruthFilter] = useState<TruthFilter>('all');
  const [minimumConfidence, setMinimumConfidence] = useState(0);
  const [showIsolated, setShowIsolated] = useState(true);
  const [mapScope, setMapScope] = useState<'overview' | 'all'>('overview');
  const [layoutName, setLayoutName] = useState<LayoutName>('cose');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SelectedItem>(null);
  const [pathStart, setPathStart] = useState('');
  const [pathEnd, setPathEnd] = useState('');
  const [path, setPath] = useState<{ nodes: string[]; edges: string[] } | null>(null);
  const [pathMessage, setPathMessage] = useState('');
  const [selectedCharacterId, setSelectedCharacterId] = useState('');
  const [exportMessage, setExportMessage] = useState('');
  const [geometries, setGeometries] = useState<PlaceGeometryRecord[]>([]);
  const [geometryForm, setGeometryForm] = useState<GeometryForm>(emptyGeometryForm);
  const [geometryBusy, setGeometryBusy] = useState(false);

  const projectionRequest = useRef(0);
  async function loadProjection(ordinal: number) {
    const request = ++projectionRequest.current;
    setLoading(true); setError('');
    try {
      const [next, nextGeometries] = await Promise.all([
        window.novelCompiler.getNarrativeMapProjection(ordinal),
        window.novelCompiler.listPlaceGeometries(),
      ]);
      if (request !== projectionRequest.current) return;
      setGeometries(nextGeometries);
      setProjection(next); setEntryOrdinal(next.entryOrdinal); setSelected(null); setPath(null); setPathMessage('');
    } catch (loadError) {
      if (request !== projectionRequest.current) return;
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally { if (request === projectionRequest.current) setLoading(false); }
  }

  useEffect(() => { void loadProjection(Number.MAX_SAFE_INTEGER); }, []);
  useEffect(() => {
    if (!projection || entryOrdinal === projection.entryOrdinal) return;
    const timer = window.setTimeout(() => { void loadProjection(entryOrdinal); }, 140);
    return () => window.clearTimeout(timer);
  }, [entryOrdinal, projection?.entryOrdinal]);

  const visible = useMemo(() => {
    if (!projection) return { nodes: [], edges: [] as NarrativeMapEdge[] };
    const edges = projection.edges.filter((edge) => edge.confidence >= minimumConfidence
      && (topologyFilter === 'all' || edge.topologyClass === topologyFilter)
      && (truthFilter === 'all' || edge.truthStatus === truthFilter));
    const candidates = showIsolated ? projection.nodes : (() => {
      const included = new Set(edges.flatMap((edge) => [edge.sourcePlaceId, edge.targetPlaceId]));
      const parentByNode = new Map(projection.nodes.map((node) => [node.id, node.parentId]));
      for (const id of [...included]) {
        let parentId = parentByNode.get(id);
        const visited = new Set<string>();
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId); included.add(parentId); parentId = parentByNode.get(parentId);
        }
      }
      return projection.nodes.filter((node) => included.has(node.id));
    })();
    if (mapScope === 'all') return { nodes: candidates, edges };
    return selectMapOverview(candidates, edges);
  }, [projection, minimumConfidence, topologyFilter, truthFilter, showIsolated, mapScope]);

  const searchMatches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('zh-CN');
    if (!needle) return [];
    return (projection?.nodes ?? []).filter((node) => node.name.toLocaleLowerCase('zh-CN').includes(needle)).slice(0, 8);
  }, [query, projection?.nodes]);

  const characterOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const event of projection?.events ?? []) for (const participant of event.participants) {
      byId.set(participant.identityId, participant.name);
    }
    return [...byId].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [projection?.events]);

  useEffect(() => {
    if (selectedCharacterId && !characterOptions.some((character) => character.id === selectedCharacterId)) setSelectedCharacterId('');
  }, [characterOptions, selectedCharacterId]);

  const narrativeTrail = useMemo(() => {
    if (!selectedCharacterId || !projection) return [];
    return projection.events
      .filter((event) => event.participants.some((participant) => participant.identityId === selectedCharacterId))
      .flatMap((event) => event.places.map((place) => ({ event, ...place })))
      .filter((visit, index, all) => all.findIndex((candidate) => candidate.event.id === visit.event.id && candidate.placeId === visit.placeId) === index)
      .sort((left, right) => left.event.narrativeStartOrdinal - right.event.narrativeStartOrdinal);
  }, [projection, selectedCharacterId]);
  const trailStops = useMemo(() => {
    const byPlace = new Map<string, number[]>();
    narrativeTrail.forEach((visit, index) => byPlace.set(visit.placeId, [...(byPlace.get(visit.placeId) ?? []), index + 1]));
    return byPlace;
  }, [narrativeTrail]);

  useEffect(() => {
    if (!mapContainer.current || viewMode !== 'review') return;
    map.current?.destroy();
    const visibleIds = new Set(visible.nodes.map((node) => node.id));
    const parentIds = new Set(visible.nodes.map((node) => node.parentId).filter((id): id is string => Boolean(id)));
    const instance = cytoscape({
      container: mapContainer.current,
      minZoom: 0.16,
      maxZoom: 3.2,
      wheelSensitivity: 0.2,
      elements: [
        ...visible.nodes.map((node) => ({
          group: 'nodes' as const,
          data: {
            id: node.id,
            label: trailStops.has(node.id) ? `[${trailStops.get(node.id)!.join('·')}] ${node.name}` : node.name,
            degree: node.degree,
            importance: node.importanceScore,
            parent: node.parentId && visibleIds.has(node.parentId) ? node.parentId : undefined,
          },
          classes: `place-${node.placeType} ${parentIds.has(node.id) ? 'parent-shell' : ''} ${node.hierarchyConflict ? 'hierarchy-conflict' : ''} ${trailStops.has(node.id) ? 'trail-stop' : ''}`,
        })),
        ...visible.edges.map((edge) => ({
          group: 'edges' as const,
          data: { id: edge.id, source: edge.sourcePlaceId, target: edge.targetPlaceId, label: edge.relationKind, confidence: edge.confidence },
          classes: `topology-${edge.topologyClass} ${edge.direction} truth-${edge.truthStatus} ${edge.hasConflict ? 'conflict' : ''}`,
        })),
      ],
      style: [
        { selector: 'node', style: {
          label: 'data(label)', color: '#38515c', 'font-family': 'Georgia, FangSong, serif', 'font-size': 12,
          'text-valign': 'bottom', 'text-margin-y': 7, 'text-outline-color': '#f6f9fa', 'text-outline-width': 2,
          width: 'mapData(importance, 0, 1, 27, 52)', height: 'mapData(importance, 0, 1, 27, 52)',
          'background-color': '#6d756c', 'border-color': '#c4a568', 'border-width': 1.4,
        } },
        { selector: 'node.place-realm, node.place-region, node.place-country', style: { shape: 'hexagon', 'background-color': '#705b3d', 'border-color': '#e0b76c' } },
        { selector: 'node.place-city, node.place-settlement, node.place-district', style: { shape: 'round-rectangle', 'background-color': '#536f68', 'border-color': '#8fc0aa' } },
        { selector: 'node.place-building, node.place-room', style: { shape: 'rectangle', 'background-color': '#755e4a', 'border-color': '#d3a46d' } },
        { selector: 'node.place-route', style: { shape: 'diamond', 'background-color': '#637985', 'border-color': '#9bc4cf' } },
        { selector: 'node.place-natural, node.place-landmark', style: { shape: 'triangle', 'background-color': '#65744f', 'border-color': '#aabd7a' } },
        { selector: 'node.parent-shell', style: {
          shape: 'round-rectangle', 'background-opacity': 0.08, 'border-style': 'dashed', 'border-width': 1,
          padding: '18px', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -6,
        } },
        { selector: 'node.hierarchy-conflict', style: { 'border-color': '#d06f67', 'border-width': 3 } },
        { selector: 'node.trail-stop', style: { 'border-color': '#e4c067', 'border-width': 4, 'overlay-color': '#d2a653', 'overlay-opacity': 0.08, 'overlay-padding': 7 } },
        { selector: 'edge', style: {
          label: 'data(label)', color: '#5c747e', 'font-family': 'Microsoft YaHei UI, sans-serif', 'font-size': 9,
          'text-background-color': '#f6f9fa', 'text-background-opacity': 0.88, 'text-background-padding': '2px',
          width: 'mapData(confidence, 0, 1, 1, 3.5)', 'curve-style': 'bezier', 'line-color': '#77766e',
          'target-arrow-color': '#77766e', 'arrow-scale': 0.7,
        } },
        { selector: 'edge.directed', style: { 'target-arrow-shape': 'triangle' } },
        { selector: 'edge.topology-hierarchy', style: { 'line-color': '#b58a48', 'target-arrow-color': '#b58a48' } },
        { selector: 'edge.topology-connection', style: { 'line-color': '#62a08a', 'target-arrow-color': '#62a08a', width: 3 } },
        { selector: 'edge.topology-direction', style: { 'line-color': '#6f9eb1', 'target-arrow-color': '#6f9eb1', 'target-arrow-shape': 'triangle' } },
        { selector: 'edge.topology-proximity', style: { 'line-color': '#a58d69', 'target-arrow-color': '#a58d69', 'line-style': 'dashed' } },
        { selector: 'edge.truth-rumor, edge.truth-suspected, edge.truth-unknown', style: { 'line-style': 'dashed', opacity: 0.66 } },
        { selector: 'edge.truth-false, edge.truth-disputed, edge.conflict', style: { 'line-color': '#bd645f', 'target-arrow-color': '#bd645f', 'line-style': 'dotted', 'z-index': 12 } },
        { selector: ':selected', style: { 'overlay-color': '#66988f', 'overlay-opacity': 0.18, 'overlay-padding': 7 } },
        { selector: '.path', style: { 'line-color': '#357e77', 'target-arrow-color': '#357e77', 'background-color': '#4d9287', 'z-index': 20 } },
      ],
    });
    instance.on('tap', 'node', (event) => setSelected({ kind: 'node', id: event.target.id() }));
    instance.on('tap', 'edge', (event) => setSelected({ kind: 'edge', id: event.target.id() }));
    instance.on('tap', (event) => { if (event.target === instance) setSelected(null); });
    const effectiveLayout = visible.edges.length === 0 || visible.nodes.length > 350 ? 'grid' : layoutName;
    const layout = instance.layout({
      name: effectiveLayout,
      animate: false,
      animationDuration: 430,
      fit: true,
      padding: 48,
      ...(effectiveLayout === 'breadthfirst' ? { directed: true, spacingFactor: 1.25 } : {}),
    });
    layout.one('layoutstop', () => {
      window.requestAnimationFrame(() => {
        if (instance.destroyed()) return;
        instance.resize();
        instance.fit(instance.elements(), 48);
        const placeId = pendingFocus.current;
        if (placeId) {
          const item = instance.getElementById(placeId);
          if (item.length) {
            instance.elements().unselect(); item.select(); instance.center(item);
            instance.zoom({ level: 1.3, renderedPosition: { x: instance.width() / 2, y: instance.height() / 2 } });
            pendingFocus.current = null;
          }
        }
      });
    });
    layout.run();
    const resizeObserver = new ResizeObserver(() => {
      if (instance.destroyed()) return;
      instance.resize();
    });
    resizeObserver.observe(mapContainer.current);
    map.current = instance;
    return () => { resizeObserver.disconnect(); layout.stop(); instance.stop(true, false); instance.elements().stop(true, false); instance.destroy(); if (map.current === instance) map.current = null; };
  }, [viewMode, visible.nodes, visible.edges, layoutName, trailStops]);

  useEffect(() => {
    const instance = map.current; if (!instance) return;
    instance.elements().removeClass('path');
    if (!path) return;
    for (const id of [...path.nodes, ...path.edges]) instance.getElementById(id).addClass('path');
  }, [path]);

  function focusNode(placeId: string) {
    setSelected({ kind: 'node', id: placeId });
    if (!visible.nodes.some((node) => node.id === placeId)) {
      pendingFocus.current = placeId;
      setMapScope('all');
      return;
    }
    const instance = map.current;
    const item = instance?.getElementById(placeId);
    if (instance && item?.length) {
      instance.stop(); instance.elements().unselect(); item.select();
      instance.center(item);
      instance.zoom({ level: 1.3, renderedPosition: { x: instance.width() / 2, y: instance.height() / 2 } });
    }
  }

  function calculatePath() {
    const result = findPath(visible.nodes, visible.edges, pathStart, pathEnd);
    setPath(result);
    setPathMessage(result ? `可见拓扑最短链路 · ${Math.max(0, result.nodes.length - 1)} 跳` : '当前筛选与阅读位置下没有可见链路');
  }

  async function exportWorldMap() {
    setError(''); setExportMessage('');
    try {
      const result = await window.novelCompiler.exportNarrativeMap(entryOrdinal);
      if (result) setExportMessage(`已导出 world_map.json · ${result.map.nodes.length} 个地点、${result.map.relations.length} 条已揭示关系 · SHA256 ${result.checksum.slice(0, 12)}…`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function exportPlaceWorldInfo() {
    setError(''); setExportMessage('');
    try {
      const result = await window.novelCompiler.exportPlaceWorldInfo(entryOrdinal);
      if (result) setExportMessage(`已导出 SillyTavern 地点世界书 · ${Object.keys(result.worldInfo.entries).length} 个条目 · SHA256 ${result.checksum.slice(0, 12)}…`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function exportGeoJson() {
    setError(''); setExportMessage('');
    try {
      const result = await window.novelCompiler.exportPlaceGeoJson(entryOrdinal);
      if (result) setExportMessage(`已导出真实地点 GeoJSON · ${result.geoJson.features.length} 个已确认坐标 · SHA256 ${result.checksum.slice(0, 12)}…`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  const selectedNode = selected?.kind === 'node' ? projection?.nodes.find((node) => node.id === selected.id) ?? null : null;
  const selectedEdge = selected?.kind === 'edge' ? projection?.edges.find((edge) => edge.id === selected.id) ?? null : null;
  const selectedEvidence = selectedEdge ? projection?.evidence.filter((item) => item.relationId === selectedEdge.id) ?? [] : [];
  const pairHistory = selectedEdge ? projection?.history.filter((item) => unorderedPair(item) === unorderedPair(selectedEdge)) ?? [] : [];
  const selectedParent = selectedNode?.parentId ? projection?.nodes.find((node) => node.id === selectedNode.parentId) ?? null : null;
  const selectedNodeEvents = selectedNode ? projection?.events.filter((event) => event.places.some((place) => place.placeId === selectedNode.id)) ?? [] : [];
  const selectedGeometry = selectedNode ? geometries.find((geometry) => geometry.placeId === selectedNode.id) ?? null : null;

  useEffect(() => {
    if (!selectedNode) { setGeometryForm(emptyGeometryForm); return; }
    const geometry = geometries.find((item) => item.placeId === selectedNode.id);
    setGeometryForm(geometry ? {
      longitude: String(geometry.longitude), latitude: String(geometry.latitude), sourceKind: geometry.sourceKind,
      sourceLabel: geometry.sourceLabel, sourceUri: geometry.sourceUri ?? '', certainty: geometry.certainty, note: geometry.note,
    } : emptyGeometryForm);
  }, [selectedNode?.id, geometries]);

  async function saveGeometry() {
    if (!selectedNode) return;
    setGeometryBusy(true); setError(''); setExportMessage('');
    try {
      const record = await window.novelCompiler.upsertPlaceGeometry({
        placeId: selectedNode.id,
        longitude: Number(geometryForm.longitude),
        latitude: Number(geometryForm.latitude),
        sourceKind: geometryForm.sourceKind,
        sourceLabel: geometryForm.sourceLabel,
        sourceUri: geometryForm.sourceUri.trim() || null,
        certainty: geometryForm.certainty,
        note: geometryForm.note,
      });
      setGeometries((current) => [...current.filter((item) => item.id !== record.id), record]);
      setExportMessage(`已保存“${selectedNode.name}”的 WGS84 坐标候选；确认后才会进入 GeoJSON。`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally { setGeometryBusy(false); }
  }

  async function reviewGeometry(status: 'confirmed' | 'rejected') {
    if (!selectedGeometry) return;
    setGeometryBusy(true); setError(''); setExportMessage('');
    try {
      setGeometries(await window.novelCompiler.reviewPlaceGeometry(selectedGeometry.id, status));
      setExportMessage(status === 'confirmed'
        ? `已确认“${selectedNode?.name}”的真实坐标，可按当前阅读位置导出。`
        : `已驳回“${selectedNode?.name}”的坐标记录，不会进入 GeoJSON。`);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : String(reviewError));
    } finally { setGeometryBusy(false); }
  }

  return <section className="narrative-map-view">
    <div className="page-title"><p>NARRATIVE CARTOGRAPHY</p><h2>防剧透叙事地图</h2><span>这是一张由原文关系组成的拓扑图：距离、方向和画布位置只有在正式断言中出现时才成立，自动布局不代表真实坐标。</span></div>
    <div className="map-reading-console panel">
      <div className="map-compass" aria-hidden="true"><i>N</i><b>◇</b><span>S</span></div>
      <div className="map-reading-copy"><span>READING FENCE</span><strong>¶ {entryOrdinal}</strong><small>{loading ? '正在重建安全地图…' : `${projection?.nodes.length ?? 0} 个已知地点 · ${projection?.edges.length ?? 0} 条当前关系 · ${projection?.events.length ?? 0} 个地点事件`}</small></div>
      <label><span>阅读位置 / 剧透边界</span><input aria-label="叙事地图阅读位置" type="range" min={0} max={projection?.maximumOrdinal ?? 0} value={entryOrdinal} onChange={(event) => setEntryOrdinal(Number(event.target.value))} /></label>
      <div className="map-topology-seal"><b>DUAL CARTOGRAPHY</b><span>TOPOLOGY + REVIEWED WGS84</span><small>小说拓扑与真实坐标分层；只有人工确认点进入 GeoJSON</small><div><button disabled={loading} onClick={() => void exportWorldMap()}>导出 world_map.json</button><button disabled={loading} onClick={() => void exportPlaceWorldInfo()}>导出地点世界书</button><button disabled={loading} onClick={() => void exportGeoJson()}>导出真实地点 GeoJSON</button></div></div>
    </div>
    {error && <div className="map-error">{error}</div>}
    {exportMessage && <div className="map-export-result">{exportMessage}</div>}
    <div className="relationship-mode" role="group" aria-label="地图视图"><button aria-pressed={viewMode === 'atlas'} onClick={() => setViewMode('atlas')}>世界地点总览</button><button aria-pressed={viewMode === 'review'} onClick={() => setViewMode('review')}>空间关系核查</button></div>
    {viewMode === 'atlas' && projection && <WorldAtlas projection={projection} />}
    <div style={{ display: viewMode === 'review' ? 'block' : 'none' }}>
    <div className="map-filter-strip panel">
      <label><span>关系层</span><select value={topologyFilter} onChange={(event) => setTopologyFilter(event.target.value as typeof topologyFilter)}><option value="all">全部拓扑</option>{Object.entries(topologyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>真实性</span><select value={truthFilter} onChange={(event) => setTruthFilter(event.target.value as TruthFilter)}><option value="all">全部状态</option>{Object.entries(truthLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="map-confidence"><span>最低置信度 · {Math.round(minimumConfidence * 100)}%</span><input type="range" min={0} max={1} step={0.05} value={minimumConfidence} onChange={(event) => setMinimumConfidence(Number(event.target.value))} /></label>
      <div className="map-scope-switch" role="group" aria-label="地图显示范围"><button className={mapScope === 'overview' ? 'active' : ''} onClick={() => setMapScope('overview')}>重点地点</button><button className={mapScope === 'all' ? 'active' : ''} onClick={() => setMapScope('all')}>全部地点</button></div>
      <label className="map-isolated"><input type="checkbox" checked={showIsolated} onChange={(event) => setShowIsolated(event.target.checked)} /><span>包含尚未连线地点</span></label>
    </div>
    <div className="map-workspace">
      <aside className="map-tools panel">
        <section className="map-search"><span>地点定位</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入地点名…" />{searchMatches.map((node) => <button key={node.id} onClick={() => focusNode(node.id)}><strong>{node.name}</strong><small>{placeTypeLabels[node.placeType]} · {node.degree} 条关系</small></button>)}</section>
        <section className="map-trail"><span>人物叙述轨迹</span><select aria-label="地图人物叙述轨迹" value={selectedCharacterId} onChange={(event) => setSelectedCharacterId(event.target.value)}><option value="">不叠加人物</option>{characterOptions.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select>{selectedCharacterId && narrativeTrail.length === 0 && <small>当前阅读位置尚无已确认地点事件。</small>}{narrativeTrail.map((visit, index) => <button key={`${visit.event.id}:${visit.placeId}`} onClick={() => focusNode(visit.placeId)}><i>{index + 1}</i><span>¶ {visit.event.narrativeStartOrdinal}</span><strong>{projection?.nodes.find((node) => node.id === visit.placeId)?.name ?? '地点'}</strong><small>{visit.event.title}</small></button>)}{selectedCharacterId && narrativeTrail.length > 1 && <p>编号只表示已确认事件在原文中的揭示顺序，不代表人物沿直线移动。</p>}</section>
        <section className="map-route"><span>拓扑寻径</span><select value={pathStart} onChange={(event) => setPathStart(event.target.value)}><option value="">起点地点</option>{visible.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select><select value={pathEnd} onChange={(event) => setPathEnd(event.target.value)}><option value="">终点地点</option>{visible.nodes.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select><button disabled={!pathStart || !pathEnd} onClick={calculatePath}>标出可见链路</button>{pathMessage && <small>{pathMessage}</small>}</section>
        <section className="map-layout"><span>图面编排</span>{(['cose', 'breadthfirst', 'circle'] as LayoutName[]).map((name) => <button key={name} className={layoutName === name ? 'active' : ''} onClick={() => setLayoutName(name)}>{name === 'cose' ? '拓扑力导向' : name === 'breadthfirst' ? '层级展开' : '环形索引'}</button>)}</section>
        <section className="map-legend"><span>图例</span>{Object.entries(topologyLabels).map(([kind, label]) => <div key={kind}><i className={kind} />{label}</div>)}<small>虚线 / 点线表示不确定、否定或冲突关系。</small></section>
      </aside>
      <div className="map-stage panel"><div ref={mapContainer} className="map-canvas" />{!loading && visible.nodes.length === 0 && <div className="map-empty"><b>此处尚无已确认地点</b><span>移动阅读位置，或回到地点审核确认身份与空间关系。</span></div>}<div className="map-stage-stamp"><b>{visible.edges.length === 0 ? '地点索引 · 非地理方位' : '空间关系示意'}</b><span>{visible.nodes.length} / {projection?.nodes.length ?? 0} PLACES · {visible.edges.length} LINKS</span>{mapScope === 'overview' && <small>按重要度精选；全部资料仍可搜索和查看</small>}</div>{(projection?.hierarchyConflictCount ?? 0) > 0 && <div className="map-conflict-note">{projection?.hierarchyConflictCount} 个地点存在多重或循环包含关系，已停止自动嵌套</div>}</div>
      <aside className="map-inspector panel">
        {!selectedNode && !selectedEdge && <div className="map-inspector-empty"><span>FIELD NOTES</span><b>选择地点或关系</b><p>右侧只展示当前阅读位置已经揭示的原文证据。画布上的远近与方向不能当作故事事实。</p></div>}
        {selectedNode && <div className="map-node-detail"><span>PLACE RECORD</span><h3>{selectedNode.name}</h3><em>{placeTypeLabels[selectedNode.placeType]}</em><dl><div><dt>可见关系</dt><dd>{selectedNode.degree}</dd></div><div><dt>原文提及</dt><dd>{selectedNode.mentionCount}</dd></div><div><dt>首次揭示</dt><dd>¶ {selectedNode.firstRevealedOrdinal}</dd></div><div><dt>所属层级</dt><dd>{selectedParent?.name ?? '未确认'}</dd></div><div><dt>连通分量</dt><dd>#{selectedNode.componentId}</dd></div></dl>{selectedNode.hierarchyConflict && <p className="map-warning">该地点存在冲突的包含层级；系统保留关系线，但不擅自选择父级。</p>}<section className="map-geometry-editor"><header><div><span>EARTH ANCHOR</span><strong>真实坐标审核</strong></div><em className={selectedGeometry?.reviewStatus ?? 'none'}>{selectedGeometry?.reviewStatus === 'confirmed' ? '已确认' : selectedGeometry?.reviewStatus === 'pending' ? '待审核' : selectedGeometry?.reviewStatus === 'rejected' ? '已驳回' : '未登记'}</em></header><p>仅登记地球 WGS84 点；虚构地点与自动布局不要填写。坐标顺序导出为［经度, 纬度］。</p><div className="map-coordinate-pair"><label><span>经度</span><input aria-label="真实地点经度" inputMode="decimal" value={geometryForm.longitude} onChange={(event) => setGeometryForm({ ...geometryForm, longitude: event.target.value })} placeholder="-180 … 180" /></label><label><span>纬度</span><input aria-label="真实地点纬度" inputMode="decimal" value={geometryForm.latitude} onChange={(event) => setGeometryForm({ ...geometryForm, latitude: event.target.value })} placeholder="-90 … 90" /></label></div><div className="map-geometry-options"><label><span>来源</span><select aria-label="真实坐标来源" value={geometryForm.sourceKind} onChange={(event) => setGeometryForm({ ...geometryForm, sourceKind: event.target.value as PlaceGeometrySourceKind })}><option value="manual">人工核对</option><option value="gazetteer">外部地名库</option></select></label><label><span>确定性</span><select aria-label="真实坐标确定性" value={geometryForm.certainty} onChange={(event) => setGeometryForm({ ...geometryForm, certainty: event.target.value as PlaceGeometryCertainty })}><option value="certain">确定</option><option value="less_certain">较不确定 / 近似</option><option value="uncertain">不确定</option></select></label></div><label><span>来源名称</span><input aria-label="真实坐标来源名称" value={geometryForm.sourceLabel} onChange={(event) => setGeometryForm({ ...geometryForm, sourceLabel: event.target.value })} placeholder={geometryForm.sourceKind === 'gazetteer' ? '如 CHGIS、GeoNames' : '如 人工查证'} /></label><label><span>来源链接</span><input aria-label="真实坐标来源链接" value={geometryForm.sourceUri} onChange={(event) => setGeometryForm({ ...geometryForm, sourceUri: event.target.value })} placeholder="https://…（地名库记录确认时必填）" /></label><label><span>核对备注</span><textarea aria-label="真实坐标核对备注" value={geometryForm.note} onChange={(event) => setGeometryForm({ ...geometryForm, note: event.target.value })} placeholder="记录为什么选择此点、精度限制或历史名称…" /></label><div className="map-geometry-actions"><button disabled={geometryBusy || !geometryForm.longitude || !geometryForm.latitude} onClick={() => void saveGeometry()}>{selectedGeometry ? '保存修改并重新待审' : '保存为待审候选'}</button>{selectedGeometry && <button className="confirm" disabled={geometryBusy || selectedGeometry.reviewStatus === 'confirmed'} onClick={() => void reviewGeometry('confirmed')}>确认坐标</button>}{selectedGeometry && <button className="reject" disabled={geometryBusy || selectedGeometry.reviewStatus === 'rejected'} onClick={() => void reviewGeometry('rejected')}>驳回</button>}</div></section><section className="map-place-events"><strong>已揭示地点事件 · {selectedNodeEvents.length}</strong>{selectedNodeEvents.map((event) => <article key={event.id}><span>¶ {event.narrativeStartOrdinal} · {event.eventType}</span><b>{event.title}</b><small>{event.participants.map((participant) => participant.name).join('、') || '无已揭示人物'}</small></article>)}</section></div>}
        {selectedEdge && <div className="map-edge-detail"><span>{selectedEdge.hasConflict ? 'CONFLICTED ASSERTION' : 'SPATIAL ASSERTION'}</span><h3>{selectedEdge.sourceName}<b>{selectedEdge.direction === 'directed' ? '→' : '—'}</b>{selectedEdge.targetName}</h3><h4>{selectedEdge.relationKind}</h4><div className="map-edge-status"><em>{topologyLabels[selectedEdge.topologyClass]}</em><em>{truthLabels[selectedEdge.truthStatus]}</em><em>{Math.round(selectedEdge.confidence * 100)}%</em></div><p>{selectedEdge.reasoningNote || '当前阅读位置没有可公开的附加推理说明。'}</p><dl><div><dt>信息来源</dt><dd>{sourceLabels[selectedEdge.informationSourceType]}{selectedEdge.informationSourceName ? ` · ${selectedEdge.informationSourceName}` : ''}</dd></div><div><dt>有效区间</dt><dd>¶ {selectedEdge.validFromOrdinal ?? '—'} — {selectedEdge.validToOrdinal ?? '未揭示 / 持续'}</dd></div><div><dt>首次揭示</dt><dd>¶ {selectedEdge.firstRevealedOrdinal}</dd></div></dl><section className="map-evidence"><strong>可见原文证据 · {selectedEvidence.length}</strong>{selectedEvidence.map((item) => <blockquote key={item.id}><span>¶ {item.paragraphOrdinal} · {item.evidenceRole}</span>{item.exactQuote}</blockquote>)}</section><section className="map-history"><strong>双方空间断言 · {pairHistory.length}</strong>{pairHistory.map((item) => <div key={item.id} className={item.id === selectedEdge.id ? 'current' : ''}><i /><span>¶ {item.firstRevealedOrdinal}</span><b>{item.relationKind}</b><small>{truthLabels[item.truthStatus]}</small></div>)}</section></div>}
      </aside>
    </div>
    </div>
  </section>;
}
