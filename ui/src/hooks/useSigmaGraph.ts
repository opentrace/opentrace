import { useEffect, useMemo } from 'react';
import Graph from 'graphology';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from 'd3-force';
import type { GraphNode, GraphLink } from '../types/graph';
import { getNodeColor } from '../chat/results/nodeColors';
import { getLinkColor } from '../chat/results/linkColors';
import {
  NODE_SIZE_MIN,
  NODE_SIZE_MAX,
  NODE_SIZE_DEGREE_SCALE,
  NODE_SIZE_MULTIPLIERS,
  EDGE_SIZE_DEFAULT,
  EDGE_SIZE_HIGHLIGHTED,
  EDGE_SIZE_DIMMED,
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_DIMMED,
  NODE_OPACITY_DIMMED,
  FORCE_LINK_DISTANCE,
  FORCE_CHARGE_STRENGTH,
  FORCE_COLLIDE_PADDING,
  FORCE_COLLIDE_ITERATIONS,
  FORCE_SIMULATION_TICKS,
} from '../config/graphLayout';

interface UseSigmaGraphOptions {
  /** Full unfiltered graph data — used for layout computation (cached) */
  allNodes: GraphNode[];
  allLinks: GraphLink[];
  /** Filtered subset — actually rendered in the graph */
  nodes: GraphNode[];
  links: GraphLink[];
  degreeMap: Map<string, number>;
  highlightNodes: Set<string>;
  highlightLinks: Set<string>;
  labelNodes: Set<string>;
  selectedNodeId: string | null;
}

const STRUCTURAL_TYPES = new Set([
  'Repository', 'Repo', 'Service', 'InstrumentedService',
  'Cluster', 'Namespace', 'Deployment', 'Directory', 'Module', 'Package',
]);

function nodeSize(degree: number, nodeType: string): number {
  const base = Math.min(NODE_SIZE_MAX, Math.max(NODE_SIZE_MIN, NODE_SIZE_MIN + Math.sqrt(degree) * NODE_SIZE_DEGREE_SCALE));
  const multiplier = NODE_SIZE_MULTIPLIERS[nodeType]
    ?? (STRUCTURAL_TYPES.has(nodeType) ? NODE_SIZE_MULTIPLIERS._structural : 1);
  return base * multiplier;
}

// ─── d3-force layout using only DEFINED_IN edges ────────────────────────

interface SimNode {
  id: string;
  x?: number;
  y?: number;
  radius: number;
}

interface SimLink {
  source: string;
  target: string;
}

function computeD3Layout(
  nodes: GraphNode[],
  links: GraphLink[],
): Map<string, { x: number; y: number }> {
  // Compute degree locally so layout doesn't depend on external degreeMap
  const localDegree = new Map<string, number>();
  for (const link of links) {
    const s = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id;
    const t = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id;
    localDegree.set(s, (localDegree.get(s) || 0) + 1);
    localDegree.set(t, (localDegree.get(t) || 0) + 1);
  }

  const simNodes: SimNode[] = nodes.map((n) => {
    const degree = localDegree.get(n.id) || 0;
    return { id: n.id, radius: nodeSize(degree, n.type) };
  });

  const simLinks: SimLink[] = [];
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  for (const link of links) {
    if (link.label !== 'DEFINED_IN') continue;
    const source = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id;
    const target = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id;
    if (nodeIdSet.has(source) && nodeIdSet.has(target)) {
      simLinks.push({ source, target });
    }
  }

  const simulation = forceSimulation(simNodes)
    .force('link', forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(FORCE_LINK_DISTANCE))
    .force('charge', forceManyBody().strength(FORCE_CHARGE_STRENGTH))
    .force('center', forceCenter(0, 0))
    .force('collide', forceCollide<SimNode>().radius((d) => d.radius + FORCE_COLLIDE_PADDING).iterations(FORCE_COLLIDE_ITERATIONS))
    .stop();

  for (let i = 0; i < FORCE_SIMULATION_TICKS; i++) {
    simulation.tick();
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of simNodes) {
    positions.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
  }

  return positions;
}

// ─── Pre-computed color cache ───────────────────────────────────────────

const dimColorCache = new Map<string, string>();

function dimColor(hex: string, alpha: number): string {
  const key = `${hex}:${alpha}`;
  const cached = dimColorCache.get(key);
  if (cached) return cached;

  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const bgR = 0x1a, bgG = 0x1b, bgB = 0x2e;
  const nr = Math.round(r * alpha + bgR * (1 - alpha));
  const ng = Math.round(g * alpha + bgG * (1 - alpha));
  const nb = Math.round(b * alpha + bgB * (1 - alpha));
  const result = `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
  dimColorCache.set(key, result);
  return result;
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function useSigmaGraph({
  allNodes,
  allLinks,
  nodes,
  links,
  degreeMap,
  highlightNodes,
  highlightLinks,
  labelNodes,
  selectedNodeId,
}: UseSigmaGraphOptions): Graph {
  const graph = useMemo(() => new Graph({ multi: true, type: 'directed' }), []);

  // Compute layout from full dataset (not filtered) so filter toggles are instant.
  // useMemo ensures this only reruns when allNodes/allLinks change (new data fetch).
  const positions = useMemo(() => {
    if (allNodes.length === 0) return new Map<string, { x: number; y: number }>();
    console.time('[graph] d3-force layout');
    const pos = computeD3Layout(allNodes, allLinks);
    console.timeEnd('[graph] d3-force layout');
    console.log(`[graph] layout computed for ${allNodes.length} nodes`);
    return pos;
  }, [allNodes, allLinks]);

  useEffect(() => {
    console.time('[graph] total rebuild');

    console.time('[graph] clear');
    graph.clear();
    console.timeEnd('[graph] clear');

    if (nodes.length === 0) { console.timeEnd('[graph] total rebuild'); return; }

    console.time('[graph] add nodes');
    for (const node of nodes) {
      const degree = degreeMap.get(node.id) || 0;
      const size = nodeSize(degree, node.type);
      const pos = positions.get(node.id) || { x: 0, y: 0 };
      graph.addNode(node.id, {
        label: node.name || node.id,
        x: pos.x,
        y: pos.y,
        size,
        color: getNodeColor(node.type),
        nodeType: node.type,
        _graphNode: node,
      });
    }
    console.timeEnd('[graph] add nodes');

    console.time('[graph] add edges');
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const source = typeof link.source === 'string' ? link.source : (link.source as unknown as GraphNode).id;
      const target = typeof link.target === 'string' ? link.target : (link.target as unknown as GraphNode).id;
      if (!graph.hasNode(source) || !graph.hasNode(target)) continue;
      graph.addEdgeWithKey(`e-${i}`, source, target, {
        label: link.label,
        color: getLinkColor(link.label),
        size: EDGE_SIZE_DEFAULT,
        _graphLink: link,
      });
    }
    console.timeEnd('[graph] add edges');

    console.timeEnd('[graph] total rebuild');
    console.log(`[graph] ${nodes.length} nodes, ${links.length} links`);
  }, [graph, nodes, links, degreeMap, positions]);

  // Batch highlight updates to minimize Sigma re-renders
  useEffect(() => {
    console.time('[graph] highlight update');
    const hasHighlight = highlightNodes.size > 0;

    graph.updateEachNodeAttributes((_id, attrs) => {
      const isHighlighted = !hasHighlight || highlightNodes.has(_id);
      const isSelected = _id === selectedNodeId;
      const showLabel = !hasHighlight || labelNodes.has(_id);
      const baseColor = getNodeColor(attrs.nodeType as string);

      attrs.color = isHighlighted ? baseColor : dimColor(baseColor, NODE_OPACITY_DIMMED);
      attrs.borderColor = isSelected ? baseColor : undefined;
      attrs.borderSize = isSelected ? 3 : 0;
      attrs.forceLabel = showLabel && hasHighlight;
      return attrs;
    });

    graph.forEachEdge((id, attrs, source, target) => {
      const linkKey = `${source}-${target}`;
      const isHighlighted = highlightLinks.has(linkKey);
      const baseColor = getLinkColor(attrs.label as string);

      if (hasHighlight) {
        graph.mergeEdgeAttributes(id, {
          color: isHighlighted ? baseColor : dimColor(baseColor, EDGE_OPACITY_DIMMED),
          size: isHighlighted ? EDGE_SIZE_HIGHLIGHTED : EDGE_SIZE_DIMMED,
        });
      } else {
        graph.mergeEdgeAttributes(id, {
          color: dimColor(baseColor, EDGE_OPACITY_DEFAULT),
          size: EDGE_SIZE_DEFAULT,
        });
      }
    });
    console.timeEnd('[graph] highlight update');
  }, [graph, highlightNodes, highlightLinks, labelNodes, selectedNodeId]);

  return graph;
}
