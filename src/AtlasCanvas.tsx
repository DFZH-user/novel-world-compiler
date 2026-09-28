import type { NarrativeMapNode } from './shared/contracts';

const types: Record<string, string> = { mountain: '山', river: '川', city: '城', village: '村', region: '域', building: '阁', forest: '林', cave: '洞', lake: '湖', country: '国', world: '界' };
export function AtlasCanvas({ nodes, allNodes, selectedId, highlighted, zoom, onSelect, onEnter }: {
  nodes: NarrativeMapNode[]; allNodes: NarrativeMapNode[]; selectedId: string; highlighted: Set<string>;
  zoom: number; onSelect: (id: string) => void; onEnter: (id: string) => void;
}) {
  const rows = Math.max(3, Math.ceil(nodes.length / 4));
  const height = rows * 145 + 100;
  return <svg className="atlas-diagram" role="group" aria-label="地点示意地图，位置不代表真实地理方向" viewBox={`0 0 900 ${height}`} style={{ width: `${900 * zoom}px`, height: `${height * zoom}px` }}>
    <rect x="20" y="22" width="860" height={height - 44} rx="32" className="atlas-frame" />
    <text x="48" y="58" className="atlas-map-caption">地点分布示意 · 非比例地图</text>
    <text x="852" y="58" textAnchor="end" className="atlas-map-caption">布局规则 v2</text>
    {nodes.map((node, index) => {
      const seed = [...node.id].reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 17);
      const x = 125 + (index % 4) * 218 + (seed % 17 - 8);
      const y = 130 + Math.floor(index / 4) * 145 + ((seed >>> 5) % 13 - 6);
      const children = allNodes.filter(child => child.parentId === node.id && !child.hierarchyConflict).length;
      return <g key={node.id} transform={`translate(${x},${y})`} className={`${selectedId === node.id ? 'selected' : ''} ${highlighted.has(node.id) ? 'in-scene' : ''}`}>
        {children > 0 && <ellipse rx="85" ry="55" className="atlas-region-halo" />}
        <g className="atlas-place-name" role="button" tabIndex={0} aria-label={`查看地点 ${node.name}`} onClick={() => onSelect(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node.id); } }}>
          <title>{node.name} · 示意位置{node.hierarchyConflict ? ' · 层级待核实' : ''}</title>
          <circle r="24" className="atlas-pin" /><text y="7" textAnchor="middle" className="atlas-type-mark">{types[node.placeType] ?? '地'}</text>
          <text y="48" textAnchor="middle" className="atlas-pin-label">{node.name.length > 12 ? `${node.name.slice(0, 11)}…` : node.name}</text>
          <text y="68" textAnchor="middle" className="atlas-pin-note">{highlighted.has(node.id) ? '所选事件相关' : node.hierarchyConflict ? '区域归属待核实' : children ? '已知包含层级' : node.parentId ? '所属区域已知' : '示意位置 · 归属待定'}</text>
        </g>
        {children > 0 && <g role="button" tabIndex={0} className="atlas-region-link" aria-label={`展开区域 ${node.name}`} transform="translate(0,92)" onClick={() => onEnter(node.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEnter(node.id); } }}><rect x="-65" y="-14" width="130" height="24" rx="12" /><text textAnchor="middle" y="2">展开 {children} 个下属地点 →</text></g>}
      </g>;
    })}
  </svg>;
}
