import { useEffect, useMemo, useRef, useState } from 'react';
import Graph, { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { GraphNode, GraphLink } from '../types/graph';
import { getNodeColor } from '../chat/results/nodeColors';
import { getLinkColor } from '../chat/results/linkColors';
import {
  buildCommunityColorMap,
  getCommunityColor,
} from '../chat/results/communityColors';
import type { LayoutRequest, LayoutResponse } from './d3LayoutWorker';
import {
  NODE_SIZE_MIN,
  NODE_SIZE_MAX,
  NODE_SIZE_DEGREE_SCALE,
  NODE_SIZE_MULTIPLIERS,
  EDGE_SIZE_DEFAULT,
  EDGE_SIZE_DEFAULT_LINE,
  EDGE_SIZE_HIGHLIGHTED,
  EDGE_SIZE_DIMMED,
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_DIMMED,
  NODE_OPACITY_DIMMED,
  FORCE_LINK_DISTANCE,
  FORCE_CHARGE_STRENGTH,
  FORCE_SIMULATION_TICKS,
  LOUVAIN_RESOLUTION,
} from '../config/graphLayout';

export interface UseSigmaGraphResult {
  graph: Graph;
  /** True once d3-force layout has been applied and graph is built */
  layoutReady: boolean;
  /** Number of detected Louvain communities */
  communityCount: number;
  /** Node ID → community ID assignments */
  communityAssignments: Record<string, number>;
  /** Community ID → color */
  communityColorMap: Map<number, string>;
}

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
  /** When true, use thicker line-edge sizes (matches EdgeLineProgram in GraphViewer) */
  isLargeGraph: boolean;
  /** Color nodes by type or community */
  colorMode: 'type' | 'community';
}

const STRUCTURAL_TYPES = new Set([
  'Repository',
  'Repo',
  'Service',
  'InstrumentedService',
  'Cluster',
  'Namespace',
  'Deployment',
  'Directory',
  'Module',
  'Package',
]);

function nodeSize(degree: number, nodeType: string): number {
  const base = Math.min(
    NODE_SIZE_MAX,
    Math.max(
      NODE_SIZE_MIN,
      NODE_SIZE_MIN + Math.sqrt(degree) * NODE_SIZE_DEGREE_SCALE,
    ),
  );
  const multiplier =
    NODE_SIZE_MULTIPLIERS[nodeType] ??
    (STRUCTURAL_TYPES.has(nodeType) ? NODE_SIZE_MULTIPLIERS._structural : 1);
  return base * multiplier;
}

/** Extract string ID from a link endpoint (handles both string and object forms). */
function endpointId(endpoint: string | number | GraphNode | undefined): string {
  if (typeof endpoint === 'string') return endpoint;
  if (typeof endpoint === 'object' && endpoint !== null)
    return (endpoint as GraphNode).id;
  return String(endpoint);
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
  // TODO: read from CSS variable for theme support
  const bgR = 0x1a,
    bgG = 0x1b,
    bgB = 0x2e;
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
  isLargeGraph,
  colorMode,
}: UseSigmaGraphOptions): UseSigmaGraphResult {
  // Stable graph instance — created once, never replaced.
  const graph = useMemo(() => new Graph({ multi: true, type: 'directed' }), []);

  // Worker ref — persists across renders, terminated on unmount
  const workerRef = useRef<Worker | null>(null);

  // Latest positions — set once when worker completes
  const [positions, setPositions] = useState<Map<
    string,
    { x: number; y: number }
  > | null>(null);

  // Track which dataset the worker is computing for (to discard stale results)
  const requestIdRef = useRef(0);

  // True once d3-force positions are available
  const layoutReady = positions !== null && positions.size > 0;

  // Compute Louvain communities on the full (unfiltered) graph.
  // Built on an undirected copy — Louvain expects undirected edges.
  // Includes ALL edge types for full coupling signal.
  const { communityAssignments, communityColorMap, communityCount } =
    useMemo(() => {
      if (allNodes.length === 0) {
        return {
          communityAssignments: {} as Record<string, number>,
          communityColorMap: new Map<number, string>(),
          communityCount: 0,
        };
      }

      const tempGraph = new UndirectedGraph();
      const nodeIdSet = new Set<string>();

      for (const node of allNodes) {
        if (!nodeIdSet.has(node.id)) {
          tempGraph.addNode(node.id);
          nodeIdSet.add(node.id);
        }
      }

      for (const link of allLinks) {
        const source =
          typeof link.source === 'string'
            ? link.source
            : (link.source as GraphNode).id;
        const target =
          typeof link.target === 'string'
            ? link.target
            : (link.target as GraphNode).id;
        // Skip self-loops and missing nodes
        if (source === target) continue;
        if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) continue;

        // Merge parallel edges as weight
        if (tempGraph.hasEdge(source, target)) {
          const w =
            (tempGraph.getEdgeAttribute(source, target, 'weight') as number) ||
            1;
          tempGraph.setEdgeAttribute(source, target, 'weight', w + 1);
        } else {
          tempGraph.addEdge(source, target, { weight: 1 });
        }
      }

      const assignments = louvain(tempGraph, {
        resolution: LOUVAIN_RESOLUTION,
        getEdgeWeight: 'weight',
      });
      const colorMap = buildCommunityColorMap(assignments);
      const count = new Set(Object.values(assignments)).size;

      if (process.env.NODE_ENV === 'development') {
        console.log(
          `[graph] Louvain: ${count} communities from ${allNodes.length} nodes`,
        );
      }

      return {
        communityAssignments: assignments,
        communityColorMap: colorMap,
        communityCount: count,
      };
    }, [allNodes, allLinks]);

  // Launch worker computation when allNodes/allLinks change.
  useEffect(() => {
    if (allNodes.length === 0) {
      setPositions(null); // eslint-disable-line react-hooks/set-state-in-effect -- reset when data clears
      return;
    }

    // Reset — new data arriving, layout not ready yet
    setPositions(null); // eslint-disable-line react-hooks/set-state-in-effect -- reset so layoutReady gates graph build

    // Prepare DEFINED_IN links for the worker
    const nodeIds = allNodes.map((n) => n.id);
    const nodeIdSet = new Set(nodeIds);
    const simLinks: { source: string; target: string }[] = [];
    for (const link of allLinks) {
      if (link.label !== 'DEFINED_IN') continue;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (nodeIdSet.has(source) && nodeIdSet.has(target)) {
        simLinks.push({ source, target });
      }
    }

    // Terminate any previous worker
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }

    const reqId = ++requestIdRef.current;

    const worker = new Worker(new URL('./d3LayoutWorker.ts', import.meta.url), {
      type: 'module',
    });
    workerRef.current = worker;

    if (process.env.NODE_ENV === 'development') {
      console.time('[graph] d3-force worker layout');
    }

    worker.onerror = (err) => {
      if (reqId !== requestIdRef.current) return;
      console.error('[graph] d3-force worker failed:', err);
      // Fall back to zero positions so the graph still renders
      const fallback = new Map<string, { x: number; y: number }>();
      for (const id of nodeIds) fallback.set(id, { x: 0, y: 0 });
      setPositions(fallback);
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
      // Discard if a newer request was issued
      if (reqId !== requestIdRef.current) return;

      const pos = new Map<string, { x: number; y: number }>();
      for (const [id, x, y] of e.data.positions) {
        pos.set(id, { x, y });
      }

      if (process.env.NODE_ENV === 'development') {
        console.timeEnd('[graph] d3-force worker layout');
        console.log(`[graph] layout computed for ${pos.size} nodes`);
      }

      setPositions(pos);

      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.postMessage({
      nodeIds,
      links: simLinks,
      config: {
        linkDistance: FORCE_LINK_DISTANCE,
        chargeStrength: FORCE_CHARGE_STRENGTH,
        ticks: FORCE_SIMULATION_TICKS,
      },
    } satisfies LayoutRequest);

    return () => {
      if (workerRef.current === worker) {
        worker.terminate();
        workerRef.current = null;
      }
    };
  }, [allNodes, allLinks]);

  // Build graph only once positions are ready, and when filtered data changes.
  // Uses graph.import() for bulk construction.
  useEffect(() => {
    graph.clear();
    if (!positions || nodes.length === 0) return;

    // Build serialized arrays in plain JS (no graphology events fired)
    const nodeSet = new Set<string>();
    const serializedNodes = nodes.map((node) => {
      const degree = degreeMap.get(node.id) || 0;
      const size = nodeSize(degree, node.type);
      const pos = positions.get(node.id) || { x: 0, y: 0 };
      nodeSet.add(node.id);
      const typeColor = getNodeColor(node.type);
      const commColor = getCommunityColor(
        communityAssignments,
        communityColorMap,
        node.id,
      );
      return {
        key: node.id,
        attributes: {
          label: node.name || node.id,
          x: pos.x,
          y: pos.y,
          size,
          color: colorMode === 'community' ? commColor : typeColor,
          nodeType: node.type,
          _typeColor: typeColor,
          _communityColor: commColor,
          _graphNode: node,
        },
      };
    });

    const seenEdges = new Set<string>();
    const serializedEdges: {
      key: string;
      source: string;
      target: string;
      attributes: Record<string, unknown>;
    }[] = [];

    const edgeSize = isLargeGraph ? EDGE_SIZE_DEFAULT_LINE : EDGE_SIZE_DEFAULT;

    for (const link of links) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (!nodeSet.has(source) || !nodeSet.has(target)) continue;
      const edgeKey = `${source}-${link.label}-${target}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      serializedEdges.push({
        key: edgeKey,
        source,
        target,
        attributes: {
          label: link.label,
          color: getLinkColor(link.label),
          size: edgeSize,
          _graphLink: link,
        },
      });
    }

    // Single bulk import — graphology processes all nodes/edges internally
    // then fires a single set of events for sigma to pick up.
    graph.import({
      nodes: serializedNodes,
      edges: serializedEdges,
    });
  }, [
    graph,
    nodes,
    links,
    degreeMap,
    positions,
    isLargeGraph,
    colorMode,
    communityAssignments,
    communityColorMap,
  ]);

  // Update visual attributes when highlight state changes.
  useEffect(() => {
    if (graph.order === 0) return;
    const hasHighlight = highlightNodes.size > 0;

    graph.updateEachNodeAttributes((_id, attrs) => {
      const isHighlighted = !hasHighlight || highlightNodes.has(_id);
      const isSelected = _id === selectedNodeId;
      const showLabel = !hasHighlight || labelNodes.has(_id);
      const baseColor =
        ((colorMode === 'community'
          ? attrs._communityColor
          : attrs._typeColor) as string) ??
        getNodeColor(attrs.nodeType as string);

      attrs.color = isHighlighted
        ? baseColor
        : dimColor(baseColor, NODE_OPACITY_DIMMED);
      attrs.borderColor = isSelected ? baseColor : undefined;
      attrs.borderSize = isSelected ? 3 : 0;
      attrs.forceLabel = showLabel && hasHighlight;
      return attrs;
    });

    const defaultEdgeSize = isLargeGraph
      ? EDGE_SIZE_DEFAULT_LINE
      : EDGE_SIZE_DEFAULT;

    graph.forEachEdge((id, attrs, source, target) => {
      const linkKey = `${source}-${target}`;
      const isHighlighted = highlightLinks.has(linkKey);
      const baseColor = getLinkColor(attrs.label as string);

      if (hasHighlight) {
        graph.mergeEdgeAttributes(id, {
          color: isHighlighted
            ? baseColor
            : dimColor(baseColor, EDGE_OPACITY_DIMMED),
          size: isHighlighted ? EDGE_SIZE_HIGHLIGHTED : EDGE_SIZE_DIMMED,
        });
      } else {
        graph.mergeEdgeAttributes(id, {
          color: dimColor(baseColor, EDGE_OPACITY_DEFAULT),
          size: defaultEdgeSize,
        });
      }
    });
  }, [
    graph,
    highlightNodes,
    highlightLinks,
    labelNodes,
    selectedNodeId,
    isLargeGraph,
    colorMode,
  ]);

  // Cleanup worker on unmount
  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
    };
  }, []);

  return {
    graph,
    layoutReady,
    communityCount,
    communityAssignments,
    communityColorMap,
  };
}
