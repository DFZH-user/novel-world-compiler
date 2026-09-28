import { performance } from 'node:perf_hooks';
import cytoscape from 'cytoscape';

const samples = [
  { nodes: 100, edges: 300 },
  { nodes: 500, edges: 1_500 },
  { nodes: 2_000, edges: 6_000 },
];

function elementsFor(sample) {
  const nodes = Array.from({ length: sample.nodes }, (_, index) => ({
    data: { id: `n${index}`, label: `人物${index}`, degree: 6 },
  }));
  const edges = Array.from({ length: sample.edges }, (_, index) => ({
    data: {
      id: `e${index}`,
      source: `n${index % sample.nodes}`,
      target: `n${(index * 37 + 11) % sample.nodes}`,
      strength: (index % 10) / 10,
    },
  }));
  return [...nodes, ...edges];
}

const results = [];
for (const sample of samples) {
  const beforeHeap = process.memoryUsage().heapUsed;
  const start = performance.now();
  const graph = cytoscape({ headless: true, styleEnabled: true, elements: elementsFor(sample) });
  const initialized = performance.now();
  graph.layout({ name: sample.nodes <= 500 ? 'cose' : 'circle', animate: false }).run();
  const laidOut = performance.now();
  results.push({
    ...sample,
    layout: sample.nodes <= 500 ? 'cose' : 'circle',
    initializeMs: Number((initialized - start).toFixed(1)),
    layoutMs: Number((laidOut - initialized).toFixed(1)),
    heapDeltaMb: Number(((process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024).toFixed(1)),
  });
  graph.destroy();
}

console.log(JSON.stringify({ cytoscape: cytoscape.version, results }, null, 2));
