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

// ─── Pre-render community spacing ────────────────────────────────────────
// Same algorithm as spacingWorker.ts but runs synchronously on the main
// thread before sigma renders. Mutates the position map in-place.

function applySpacing(
  pos: Map<string, { x: number; y: number }>,
  assignments: Record<string, number>,
  radiusScale: number,
  gap: number,
  maxIterations: number,
  pushFactor: number,
) {
  // Group by community
  const groups = new Map<number, string[]>();
  for (const [id] of pos) {
    const cid = assignments[id];
    if (cid === undefined) continue;
    let list = groups.get(cid);
    if (!list) {
      list = [];
      groups.set(cid, list);
    }
    list.push(id);
  }

  if (groups.size < 2) return;

  // Build community centroids and radii
  const comms: {
    nodeIds: string[];
    cx: number;
    cy: number;
    radius: number;
  }[] = [];
  for (const [, ids] of groups) {
    let cx = 0,
      cy = 0;
    for (const id of ids) {
      const p = pos.get(id)!;
      cx += p.x;
      cy += p.y;
    }
    cx /= ids.length;
    cy /= ids.length;
    comms.push({
      nodeIds: ids,
      cx,
      cy,
      radius: Math.sqrt(ids.length) * radiusScale,
    });
  }

  for (let iter = 0; iter < maxIterations; iter++) {
    const pushX = new Float64Array(comms.length);
    const pushY = new Float64Array(comms.length);
    let maxOverlap = 0;

    for (let i = 0; i < comms.length; i++) {
      for (let j = i + 1; j < comms.length; j++) {
        const a = comms[i];
        const b = comms[j];
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.radius + b.radius + gap;

        if (dist < minDist) {
          const overlap = (minDist - dist) / minDist;
          if (overlap > maxOverlap) maxOverlap = overlap;

          const push = (minDist - dist) * pushFactor;
          if (dist > 0.001) {
            const nx = dx / dist;
            const ny = dy / dist;
            const totalSize = a.nodeIds.length + b.nodeIds.length;
            const aRatio = b.nodeIds.length / totalSize;
            const bRatio = a.nodeIds.length / totalSize;
            pushX[i] -= nx * push * aRatio;
            pushY[i] -= ny * push * aRatio;
            pushX[j] += nx * push * bRatio;
            pushY[j] += ny * push * bRatio;
          } else {
            const angle = Math.random() * Math.PI * 2;
            pushX[i] -= Math.cos(angle) * minDist * 0.5;
            pushY[i] -= Math.sin(angle) * minDist * 0.5;
            pushX[j] += Math.cos(angle) * minDist * 0.5;
            pushY[j] += Math.sin(angle) * minDist * 0.5;
          }
        }
      }
    }

    if (maxOverlap <= 0.05) break;

    // Apply pushes to centroids and member positions
    for (let i = 0; i < comms.length; i++) {
      const ox = pushX[i];
      const oy = pushY[i];
      if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) continue;
      comms[i].cx += ox;
      comms[i].cy += oy;
      for (const id of comms[i].nodeIds) {
        const p = pos.get(id)!;
        p.x += ox;
        p.y += oy;
      }
    }
  }
}

// ─── Pre-render per-community noverlap ───────────────────────────────────
// Pushes overlapping nodes apart within each community. Runs after spacing
// so nodes don't start stacked on top of each other.

function applyNoverlap(
  pos: Map<string, { x: number; y: number }>,
  sizes: Map<string, number>,
  assignments: Record<string, number>,
  margin: number,
  iterations: number,
) {
  // Group by community
  const groups = new Map<number, string[]>();
  for (const [id] of pos) {
    const cid = assignments[id];
    if (cid === undefined) continue;
    let list = groups.get(cid);
    if (!list) {
      list = [];
      groups.set(cid, list);
    }
    list.push(id);
  }

  // Compute a scale factor from the position bounding box
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [, p] of pos) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const scale = Math.max(maxX - minX, maxY - minY, 1) / 4000;
  const scaledMargin = margin * scale;

  const MAX_INLINE = 500;

  for (const [, ids] of groups) {
    if (ids.length < 3 || ids.length > MAX_INLINE) continue;

    // Build local position/size array
    const nodes = ids.map((id) => ({
      id,
      x: pos.get(id)!.x,
      y: pos.get(id)!.y,
      size: (sizes.get(id) ?? 3) * scale,
    }));

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = a.size + b.size + scaledMargin;
          if (dist < minDist && dist > 0.001) {
            const push = (minDist - dist) * 0.5;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x -= nx * push;
            a.y -= ny * push;
            b.x += nx * push;
            b.y += ny * push;
          }
        }
      }
    }

    // Write back
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      p.x = n.x;
      p.y = n.y;
    }
  }
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
    () => (flatMode ? new Set<string>() : new Set(layoutConfig.structuralTypes)),
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
          label: node.name || node.id,
          _originalLabel: node.name || node.id,
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
            const targetIdx = (members.indexOf(nodeId) + c + 1) % members.length;
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
      // In structured mode, only layoutEdgeType edges (e.g. DEFINED_IN) are used.
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
        applyNoverlap(pos, sizeMap, assignments, layoutConfig.noverlapMargin, layoutConfig.noverlapCommunityIterations ?? 20);
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
