/*
 * Copyright 2026 OpenTrace Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Graph from 'graphology';
import type {
  GraphNode,
  GraphLink,
  CommunityData,
  LayoutConfig,
} from './types';
import type { LayoutRequest, LayoutResponse } from '../hooks/d3LayoutWorker';
import {
  NODE_SIZE_MIN,
  NODE_SIZE_MAX,
  NODE_SIZE_DEGREE_SCALE,
  NODE_SIZE_MULTIPLIERS,
  EDGE_SIZE_DEFAULT,
  EDGE_SIZE_DEFAULT_LINE,
} from '../config/graphLayout';

// ─── Helpers ────────────────────────────────────────────────────────────

function nodeSize(
  degree: number,
  nodeType: string,
  structuralTypes: Set<string>,
): number {
  const base = Math.min(
    NODE_SIZE_MAX,
    Math.max(
      NODE_SIZE_MIN,
      NODE_SIZE_MIN + Math.sqrt(degree) * NODE_SIZE_DEGREE_SCALE,
    ),
  );
  const multiplier =
    NODE_SIZE_MULTIPLIERS[nodeType] ??
    (structuralTypes.has(nodeType) ? NODE_SIZE_MULTIPLIERS._structural : 1);
  return base * multiplier;
}

/** Extract string ID from a link endpoint (handles both string and object forms). */
function endpointId(endpoint: string | number | GraphNode | undefined): string {
  if (typeof endpoint === 'string') return endpoint;
  if (typeof endpoint === 'object' && endpoint !== null)
    return (endpoint as GraphNode).id;
  return String(endpoint);
}

// ─── Hook ───────────────────────────────────────────────────────────────

export interface UseGraphInstanceResult {
  graph: Graph;
  /** True once d3-force layout has been applied and positions seeded into the graph */
  layoutReady: boolean;
}

export interface UseGraphInstanceOptions {
  allNodes: GraphNode[];
  allLinks: GraphLink[];
  communityData: CommunityData;
  layoutConfig: LayoutConfig;
}

export function useGraphInstance({
  allNodes,
  allLinks,
  communityData,
  layoutConfig,
}: UseGraphInstanceOptions): UseGraphInstanceResult {
  // Stable graph instance — created once, never replaced.
  const graph = useMemo(() => new Graph({ multi: true, type: 'directed' }), []);

  // Worker ref — persists across renders, terminated on unmount
  const workerRef = useRef<Worker | null>(null);

  // Guard against unmount — worker.onmessage may fire after cleanup
  const unmountedRef = useRef(false);

  // Track which dataset the worker is computing for (to discard stale results)
  const requestIdRef = useRef(0);

  const [layoutReady, setLayoutReady] = useState(false);

  // Derived from config
  const structuralTypes = useMemo(
    () => new Set(layoutConfig.structuralTypes),
    [layoutConfig.structuralTypes],
  );

  // Single effect: rebuild graph and run d3-force worker when data changes.
  useEffect(() => {
    graph.clear();
    setLayoutReady(false);

    if (allNodes.length === 0) return;

    const { assignments, colorMap, names } = communityData;
    const { getNodeColor, getLinkColor, getCommunityColor } = layoutConfig;

    // ── Build ALL nodes with initial x:0, y:0 ──────────────────────────
    const nodeIdSet = new Set<string>();
    const serializedNodes = allNodes.map((node) => {
      nodeIdSet.add(node.id);
      const typeColor = getNodeColor(node.type);
      const commColor = getCommunityColor(assignments, colorMap, node.id);
      const cid = assignments[node.id];
      const commName = cid !== undefined ? names.get(cid) : undefined;
      return {
        key: node.id,
        attributes: {
          label: node.name || node.id,
          x: 0,
          y: 0,
          size: nodeSize(0, node.type, structuralTypes),
          nodeType: node.type,
          _graphNode: node,
          _typeColor: typeColor,
          _communityColor: commColor,
          _communityName: commName ?? undefined,
        },
      };
    });

    // ── Build ALL edges (deduped by source-label-target key) ────────────
    const seenEdges = new Set<string>();
    const serializedEdges: {
      key: string;
      source: string;
      target: string;
      attributes: Record<string, unknown>;
    }[] = [];

    const edgeSize =
      allLinks.length > layoutConfig.edgeProgramThreshold
        ? EDGE_SIZE_DEFAULT_LINE
        : EDGE_SIZE_DEFAULT;

    for (const link of allLinks) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) continue;
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

    // Bulk import — single set of graphology events
    graph.import({
      nodes: serializedNodes,
      edges: serializedEdges,
    });

    // ── Prepare worker data ─────────────────────────────────────────────
    const nodeIds = allNodes.map((n) => n.id);
    const simLinks: { source: string; target: string }[] = [];
    for (const link of allLinks) {
      if (link.label !== layoutConfig.layoutEdgeType) continue;
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

    const worker = new Worker(
      new URL('../hooks/d3LayoutWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    if (process.env.NODE_ENV === 'development') {
      console.time('[graph] d3-force worker layout');
    }

    worker.onerror = (err) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;
      console.error('[graph] d3-force worker failed:', err);
      setLayoutReady(true);
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;

      // Build position lookup
      const pos = new Map<string, { x: number; y: number }>();
      for (const [id, x, y] of e.data.positions) {
        pos.set(id, { x, y });
      }

      if (process.env.NODE_ENV === 'development') {
        console.timeEnd('[graph] d3-force worker layout');
        console.log(`[graph] layout computed for ${pos.size} nodes`);
      }

      // Seed positions into graph — batched, single event
      graph.updateEachNodeAttributes((_id, attrs) => {
        const p = pos.get(_id);
        if (p) {
          attrs.x = p.x;
          attrs.y = p.y;
        }
        return attrs;
      });

      setLayoutReady(true);

      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };

    worker.postMessage({
      nodeIds,
      links: simLinks,
      communities: assignments,
      config: {
        linkDistance: layoutConfig.linkDistance,
        chargeStrength: layoutConfig.chargeStrength,
        ticks: layoutConfig.simulationTicks,
        clusterStrength: layoutConfig.clusterStrength,
        clusterTicks: layoutConfig.clusterTicks,
        clusterSeparation: layoutConfig.clusterSeparation,
      },
    } satisfies LayoutRequest);

    return () => {
      if (workerRef.current === worker) {
        worker.terminate();
        workerRef.current = null;
      }
    };
    // Dependencies: allNodes/allLinks/layoutConfig changes trigger full rebuild.
    // communityData is derived from allNodes/allLinks, so it's implicitly tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes, allLinks, graph, layoutConfig, structuralTypes]);

  // Track mount state — reset on each mount (strict mode remounts)
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      workerRef.current?.terminate();
    };
  }, []);

  return { graph, layoutReady };
}
