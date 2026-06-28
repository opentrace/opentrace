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

/**
 * React bridge to forceLayout3dWorker — the Three.js renderer's d3-force-3d
 * layout. Mirrors usePixiLayout, but decodes stride-3 position buffers
 * [x,y,z,...] and exposes `setDimensions` so the renderer can switch the
 * simulation between 2D and 3D when the user toggles 3D mode.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GraphNode,
  GraphLink,
  CommunityData,
  LayoutConfig,
} from '../graph/types';
import { endpointId, nodeSize } from '../graph/layoutHelpers';
import { selectBreakpoint } from '../pixi/scaleBreakpoints';
import type {
  Worker3DInMessage,
  Worker3DOutMessage,
  LayoutMode,
} from '../workers/forceLayout3dWorker';

/** Layout pull of relational edges (calls/imports/…) relative to the structural
 *  DEFINES tree (1.0). Kept low so the tree/branch structure stays clean: just
 *  enough to gently shorten call/import edges into logical branches, not so much
 *  that the hierarchy collapses into a ball. Higher = tighter/more interconnected,
 *  lower = more tree-like. */
const RELATIONAL_LINK_WEIGHT = 0.05;

export interface UseForceLayout3dResult {
  layoutReady: boolean;
  positions: Map<string, { x: number; y: number }>;
  nodeSizes: Map<string, number>;
  simRunning: boolean;
  reheat: () => void;
  reseed: () => void;
  setNebula: (enabled: boolean, baseMode: LayoutMode) => void;
  restart: () => void;
  toggleSim: () => void;
  stopSim: () => void;
  startSim: () => void;
  fixNode: (nodeId: string, x: number, y: number) => void;
  unfixNode: (nodeId: string) => void;
  setChargeStrength: (strength: number) => void;
  setLinkDistance: (distance: number) => void;
  setCenterStrength: (strength: number) => void;
  setCommunityGravity: (enabled: boolean, strength?: number) => void;
  boostTheta: () => void;
  resetTheta: () => void;
  setLayoutMode: (mode: LayoutMode) => void;
  updateCompactConfig: (config: {
    radialStrength?: number;
    communityPull?: number;
    centeringStrength?: number;
    radiusScale?: number;
  }) => void;
  /** Switch the running simulation between 2D and 3D. */
  setDimensions: (dimensions: 2 | 3) => void;
}

export function useForceLayout3d(
  allNodes: GraphNode[],
  allLinks: GraphLink[],
  communityData: CommunityData,
  layoutConfig: LayoutConfig,
  onTick: (
    positions: Map<string, { x: number; y: number }>,
    buffer?: Float64Array,
  ) => void,
  initialLayoutMode: LayoutMode = 'spread',
  initialDimensions: 2 | 3 = 2,
): UseForceLayout3dResult {
  const [layoutReady, setLayoutReady] = useState(false);
  const [simRunning, setSimRunning] = useState(true);
  const simRunningRef = useRef(true);
  const workerRef = useRef<Worker | null>(null);
  const unmountedRef = useRef(false);
  const requestIdRef = useRef(0);

  const nodeOrderRef = useRef<string[]>([]);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const nodeSizesRef = useRef<Map<string, number>>(new Map());
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  // Dimensions are applied at init; later changes go via setDimensions.
  const dimensionsRef = useRef<2 | 3>(initialDimensions);

  const flatMode = layoutConfig.flatMode ?? false;
  const structuralTypes = new Set(flatMode ? [] : layoutConfig.structuralTypes);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const degreeMap = new Map<string, number>();
    for (const link of allLinks) {
      const s = endpointId(link.source);
      const t = endpointId(link.target);
      degreeMap.set(s, (degreeMap.get(s) || 0) + 1);
      degreeMap.set(t, (degreeMap.get(t) || 0) + 1);
    }
    const sizes = new Map<string, number>();
    for (const node of allNodes) {
      sizes.set(
        node.id,
        nodeSize(degreeMap.get(node.id) ?? 0, node.type, structuralTypes),
      );
    }
    nodeSizesRef.current = sizes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes, allLinks]);

  // Stride-3 buffer → positions map (x,y only; z lives in the buffer the
  // renderer reads directly).
  const applyPositionBuffer = useCallback((buffer: Float64Array) => {
    const nodeOrder = nodeOrderRef.current;
    const pos = positionsRef.current;
    const count = Math.min(nodeOrder.length, Math.floor(buffer.length / 3));
    for (let i = 0; i < count; i++) {
      const id = nodeOrder[i];
      const existing = pos.get(id);
      if (existing) {
        existing.x = buffer[i * 3];
        existing.y = buffer[i * 3 + 1];
      } else {
        pos.set(id, { x: buffer[i * 3], y: buffer[i * 3 + 1] });
      }
    }
  }, []);

  const prevNodeIdsRef = useRef<Set<string>>(new Set());

  const buildLayoutLinks = useCallback(
    (nodeIdSet: Set<string>, linkArray: GraphLink[]) => {
      const out: { source: string; target: string; w: number }[] = [];
      for (const link of linkArray) {
        const source = endpointId(link.source);
        const target = endpointId(link.target);
        if (source === target) continue; // self-loops don't shape layout
        if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) continue;
        // Structural edges (the DEFINES containment tree) drive the layout at
        // full strength → the tree/flower shape. Relational edges (calls,
        // imports, …) are included at a weak weight so call/import neighbours
        // drift closer — shortening those long cross-graph edges into logical
        // branches — without collapsing the structure into a hairball.
        const structural =
          flatMode || link.label === layoutConfig.layoutEdgeType;
        out.push({
          source,
          target,
          w: structural ? 1 : RELATIONAL_LINK_WEIGHT,
        });
      }
      return out;
    },
    [flatMode, layoutConfig.layoutEdgeType],
  );

  useEffect(() => {
    const nodeIds = allNodes.map((n) => n.id);
    const nodeIdSet = new Set(nodeIds);
    const prevIds = prevNodeIdsRef.current;

    const allPrevPresent =
      prevIds.size > 0 && [...prevIds].every((id) => nodeIdSet.has(id));
    const isIncremental =
      allPrevPresent &&
      nodeIdSet.size > prevIds.size &&
      workerRef.current !== null;
    const isSameNodes = allPrevPresent && nodeIdSet.size === prevIds.size;

    if (isSameNodes && workerRef.current) {
      if (communityData.assignments) {
        workerRef.current.postMessage({
          type: 'set-communities',
          communities: communityData.assignments,
        } satisfies Worker3DInMessage);
        // set-communities reheats the worker (alpha 0.7) and reshuffles nodes
        // into their community clusters — a real layout move. Flag the sim as
        // running so the renderer drops `layoutSettled` and keeps edge endpoints
        // following the nodes; otherwise edges freeze at the pre-cluster
        // positions and look detached until the next reheat.
        simRunningRef.current = true;
        setSimRunning(true);
      }
      return;
    }

    if (isIncremental) {
      const newNodeIds = nodeIds.filter((id) => !prevIds.has(id));
      const links = buildLayoutLinks(nodeIdSet, allLinks);
      const newLinks = links.filter(
        (l) => !prevIds.has(l.source) || !prevIds.has(l.target),
      );
      nodeOrderRef.current = [...nodeOrderRef.current, ...newNodeIds];

      const pos = positionsRef.current;
      let cx = 0,
        cy = 0,
        count = 0;
      for (const id of prevIds) {
        const p = pos.get(id);
        if (p) {
          cx += p.x;
          cy += p.y;
          count++;
        }
      }
      if (count > 0) {
        cx /= count;
        cy /= count;
      }
      const spread = Math.sqrt(prevIds.size) * 10;
      for (const id of newNodeIds) {
        if (!pos.has(id)) {
          const angle = Math.random() * Math.PI * 2;
          const r = Math.random() * spread;
          pos.set(id, {
            x: cx + Math.cos(angle) * r,
            y: cy + Math.sin(angle) * r,
          });
        }
      }

      prevNodeIdsRef.current = nodeIdSet;
      workerRef.current!.postMessage({
        type: 'add-nodes',
        nodeIds: newNodeIds,
        links: newLinks,
        communities: communityData.assignments,
      } satisfies Worker3DInMessage);

      simRunningRef.current = true;
      setSimRunning(true);
      return;
    }

    workerRef.current?.terminate();
    workerRef.current = null;
    setLayoutReady(false);

    if (allNodes.length === 0) {
      prevNodeIdsRef.current = new Set();
      return;
    }

    const reqId = ++requestIdRef.current;
    nodeOrderRef.current = nodeIds;

    const pos = positionsRef.current;
    pos.clear();
    for (const id of nodeIds) pos.set(id, { x: 0, y: 0 });

    const links = buildLayoutLinks(nodeIdSet, allLinks);

    const worker = new Worker(
      new URL('../workers/forceLayout3dWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onerror = (err) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;
      console.error(
        '[three] layout worker failed — nodes will be placed at (0,0).',
        err,
      );
      setLayoutReady(true);
    };

    worker.onmessage = (e: MessageEvent<Worker3DOutMessage>) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;
      switch (e.data.type) {
        case 'ready':
          applyPositionBuffer(e.data.buffer);
          setLayoutReady(true);
          break;
        case 'positions':
          applyPositionBuffer(e.data.buffer);
          onTickRef.current(positionsRef.current, e.data.buffer);
          break;
        case 'settled':
          simRunningRef.current = false;
          setSimRunning(false);
          break;
      }
    };

    const bp = selectBreakpoint(allNodes.length);
    worker.postMessage({
      type: 'init',
      nodeIds,
      links,
      communities: communityData.assignments,
      dimensions: dimensionsRef.current,
      config: {
        chargeStrength: layoutConfig.chargeStrength,
        linkDistance: layoutConfig.linkDistance,
        barnesHutTheta: bp.barnesHutTheta,
        dragTheta: bp.dragTheta,
        layoutMode: initialLayoutMode,
      },
    } satisfies Worker3DInMessage);

    prevNodeIdsRef.current = nodeIdSet;
    simRunningRef.current = true;
    setSimRunning(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allNodes,
    allLinks,
    communityData,
    layoutConfig,
    applyPositionBuffer,
    buildLayoutLinks,
  ]);

  const postToWorker = useCallback((msg: Worker3DInMessage) => {
    workerRef.current?.postMessage(msg);
  }, []);

  const restart = useCallback(() => {
    postToWorker({ type: 'start' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const reheat = useCallback(() => {
    postToWorker({ type: 'reheat' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  /** Re-lay-out the graph from scratch (fresh seed) — used on preset switches
   *  so the result is independent of the layout currently on screen. */
  const reseed = useCallback(() => {
    postToWorker({ type: 'reseed' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  /** Toggle the nebula cloud layout. `baseMode` is the layout to fall back to
   *  when disabling (the app's current layout mode). */
  const setNebula = useCallback(
    (enabled: boolean, baseMode: LayoutMode) => {
      postToWorker({ type: 'set-nebula', enabled, baseMode });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const toggleSim = useCallback(() => {
    if (simRunningRef.current) {
      postToWorker({ type: 'stop' });
      simRunningRef.current = false;
      setSimRunning(false);
    } else {
      postToWorker({ type: 'start' });
      simRunningRef.current = true;
      setSimRunning(true);
    }
  }, [postToWorker]);

  const stopSim = useCallback(() => {
    postToWorker({ type: 'stop' });
    simRunningRef.current = false;
    setSimRunning(false);
  }, [postToWorker]);

  const startSim = useCallback(() => {
    postToWorker({ type: 'start' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const fixNode = useCallback(
    (nodeId: string, x: number, y: number) => {
      postToWorker({ type: 'fix-node', nodeId, x, y });
      if (!simRunningRef.current) {
        simRunningRef.current = true;
        setSimRunning(true);
      }
    },
    [postToWorker],
  );

  const unfixNode = useCallback(
    (nodeId: string) => {
      postToWorker({ type: 'unfix-node', nodeId });
    },
    [postToWorker],
  );

  const setChargeStrength = useCallback(
    (strength: number) => {
      postToWorker({ type: 'update-config', chargeStrength: strength });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setLinkDistance = useCallback(
    (distance: number) => {
      postToWorker({ type: 'update-config', linkDistance: distance });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setCenterStrength = useCallback(
    (strength: number) => {
      postToWorker({ type: 'update-config', centerStrength: strength });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setCommunityGravity = useCallback(
    (enabled: boolean, strength = 0.1) => {
      postToWorker({ type: 'set-community-gravity', enabled, strength });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const boostTheta = useCallback(() => {
    postToWorker({ type: 'boost-theta' });
  }, [postToWorker]);

  const resetTheta = useCallback(() => {
    postToWorker({ type: 'reset-theta' });
  }, [postToWorker]);

  const setLayoutMode = useCallback(
    (mode: LayoutMode) => {
      postToWorker({ type: 'set-layout-mode', mode });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const updateCompactConfig = useCallback(
    (config: {
      radialStrength?: number;
      communityPull?: number;
      centeringStrength?: number;
      radiusScale?: number;
    }) => {
      postToWorker({ type: 'update-compact-config', ...config });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setDimensions = useCallback(
    (dimensions: 2 | 3) => {
      if (dimensionsRef.current === dimensions) return;
      dimensionsRef.current = dimensions;
      postToWorker({ type: 'set-dimensions', dimensions });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  return {
    layoutReady,
    positions: positionsRef.current,
    nodeSizes: nodeSizesRef.current,
    simRunning,
    reheat,
    reseed,
    setNebula,
    restart,
    toggleSim,
    stopSim,
    startSim,
    fixNode,
    unfixNode,
    setChargeStrength,
    setLinkDistance,
    setCenterStrength,
    setCommunityGravity,
    boostTheta,
    resetTheta,
    setLayoutMode,
    updateCompactConfig,
    setDimensions,
  };
}
