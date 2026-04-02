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
import type { LayoutRequest, LayoutResponse } from '../workers/d3LayoutWorker';
import {
  EDGE_SIZE_DEFAULT,
  EDGE_SIZE_DEFAULT_LINE,
  LABEL_MAX_LENGTH,
} from '../config/graphLayout';
import {
  nodeSize,
  endpointId,
  applySpacing,
  applyNoverlap,
} from './layoutHelpers';

function cleanLabel(raw: string): string {
  const stripped = raw.replace(/[\n\r\t]+/g, ' ').trim();
  return stripped.length > LABEL_MAX_LENGTH
    ? stripped.slice(0, LABEL_MAX_LENGTH) + '…'
    : stripped;
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
  const flatMode = layoutConfig.flatMode ?? false;
  const structuralTypes = useMemo(
    () =>
      flatMode ? new Set<string>() : new Set(layoutConfig.structuralTypes),
    [layoutConfig.structuralTypes, flatMode],
  );

  // Single effect: rebuild graph and run d3-force worker when data changes.
  useEffect(() => {
    graph.clear();
    setLayoutReady(false);

    if (allNodes.length === 0) return;

    const { assignments, colorMap, names } = communityData;
    const { getNodeColor, getLinkColor, getCommunityColor } = layoutConfig;

    // ── Pre-compute degree (connection count) per node ─────────────────
    const degreeMap = new Map<string, number>();
    for (const link of allLinks) {
      const s = endpointId(link.source);
      const t = endpointId(link.target);
      degreeMap.set(s, (degreeMap.get(s) || 0) + 1);
      degreeMap.set(t, (degreeMap.get(t) || 0) + 1);
    }

    // ── Build ALL nodes with initial x:0, y:0 ──────────────────────────
    const nodeIdSet = new Set<string>();
    const serializedNodes = allNodes.map((node) => {
      nodeIdSet.add(node.id);
      const typeColor = getNodeColor(node.type);
      const commColor = getCommunityColor(assignments, colorMap, node.id);
      const cid = assignments[node.id];
      const commName = cid !== undefined ? names.get(cid) : undefined;
      const degree = degreeMap.get(node.id) || 0;
      const size = nodeSize(degree, node.type, structuralTypes);
      return {
        key: node.id,
        attributes: {
          label: cleanLabel(node.name || node.id),
          _originalLabel: cleanLabel(node.name || node.id),
          x: 0,
          y: 0,
          size,
          _baseSize: size,
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

    // ── Add virtual community edges for FA2 intra-community attraction ──
    // Each node gets 1–2 edges to random same-community neighbors.
    // Hidden from rendering, but FA2 uses them for attraction.
    // Skipped in flat mode — all real edges drive layout directly.
    const { assignments: communityAssignments } = communityData;
    if (communityAssignments && !flatMode) {
      const communityGroups = new Map<number, string[]>();
      for (const node of allNodes) {
        const cid = communityAssignments[node.id];
        if (cid === undefined) continue;
        let list = communityGroups.get(cid);
        if (!list) {
          list = [];
          communityGroups.set(cid, list);
        }
        list.push(node.id);
      }

      let vcIdx = 0;
      for (const [, members] of communityGroups) {
        if (members.length < 2) continue;
        // Scale ties with community size: small=2, medium=3, large=3
        const baseTies = members.length >= 10 ? 3 : 2;
        for (const nodeId of members) {
          const count = Math.min(baseTies, members.length - 1);
          for (let c = 0; c < count; c++) {
            // Pick a random neighbor (simple deterministic shuffle via index)
            const targetIdx =
              (members.indexOf(nodeId) + c + 1) % members.length;
            const targetId = members[targetIdx];
            if (targetId === nodeId) continue;
            const vcKey = `_vc_${vcIdx++}`;
            if (seenEdges.has(`${nodeId}-_COMMUNITY_-${targetId}`)) continue;
            seenEdges.add(`${nodeId}-_COMMUNITY_-${targetId}`);
            serializedEdges.push({
              key: vcKey,
              source: nodeId,
              target: targetId,
              attributes: {
                label: '_COMMUNITY_',
                color: 'transparent',
                size: 0,
                hidden: true,
                _virtual: true,
              },
            });
          }
        }
      }
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
      // In flat mode, all edges drive the force layout.
      // In structured mode, only layoutEdgeType edges (e.g. DEFINES) are used.
      if (!flatMode && link.label !== layoutConfig.layoutEdgeType) continue;
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
      new URL('../workers/d3LayoutWorker.ts', import.meta.url),
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

      // ── Pre-render spacing + noverlap ──────────────────────────────────
      // Run synchronously so the first frame has well-separated, non-overlapping nodes.
      // Skipped in flat mode — all edges drive layout, no structural hierarchy.
      const { assignments } = communityData;
      if (!flatMode && assignments && Object.keys(assignments).length > 0) {
        applySpacing(pos, assignments, 40, 100, 50, 0.5);

        // Build size lookup from serialized nodes
        const sizeMap = new Map<string, number>();
        for (const sn of serializedNodes) {
          sizeMap.set(sn.key, sn.attributes.size);
        }
        applyNoverlap(
          pos,
          sizeMap,
          assignments,
          layoutConfig.noverlapMargin,
          layoutConfig.noverlapCommunityIterations ?? 20,
        );
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
