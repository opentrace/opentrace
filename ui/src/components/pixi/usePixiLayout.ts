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
 * Hook that runs d3-force simulation in a Web Worker for the Pixi renderer.
 *
 * The worker streams position snapshots at ~15fps via transferable Float64Array.
 * The main thread reads positions and updates sprites, keeping the render loop
 * free from simulation computation. At 20k nodes, this moves ~50-200ms/tick of
 * d3-force work off the main thread entirely.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphNode, GraphLink, CommunityData, LayoutConfig } from '../graph/types';
import { endpointId, nodeSize } from '../graph/layoutHelpers';
import type { WorkerInMessage, WorkerOutMessage, LayoutMode } from '../workers/pixiLayoutWorker';
import { type PixiScaleBreakpoint, selectBreakpoint } from './scaleBreakpoints';

// ─── Types ──────────────────────────────────────────────────────────────

export interface UsePixiLayoutResult {
  /** True once the initial layout pass has completed. */
  layoutReady: boolean;
  /** Map of node positions, updated every tick. */
  positions: Map<string, { x: number; y: number }>;
  /** Map of computed node sizes. */
  nodeSizes: Map<string, number>;
  /** Whether the simulation is currently running. */
  simRunning: boolean;
  /** Restart the simulation with full alpha (reheat). */
  reheat: () => void;
  /** Restart the simulation (e.g. for optimize button). */
  restart: () => void;
  /** Stop or resume the simulation. */
  toggleSim: () => void;
  /** Unconditionally stop the simulation. */
  stopSim: () => void;
  /** Unconditionally start the simulation. */
  startSim: () => void;
  /** Pin a node to a fixed position (for dragging). */
  fixNode: (nodeId: string, x: number, y: number) => void;
  /** Unpin a node (after drag ends). */
  unfixNode: (nodeId: string) => void;
  /** Update charge (repulsion) strength at runtime. */
  setChargeStrength: (strength: number) => void;
  /** Update link distance at runtime. */
  setLinkDistance: (distance: number) => void;
  /** Update center force strength at runtime. */
  setCenterStrength: (strength: number) => void;
  /** Enable/disable community cluster gravity force. */
  setCommunityGravity: (enabled: boolean, strength?: number) => void;
  /** Increase Barnes-Hut theta for faster (less accurate) charge computation during drag. */
  boostTheta: () => void;
  /** Restore default Barnes-Hut theta after drag. */
  resetTheta: () => void;
  /** Switch layout mode ('spread' = standard force-directed, 'compact' = radial/circular). */
  setLayoutMode: (mode: LayoutMode) => void;
  /** Update compact-mode-specific config (radial strength, community pull, centering). */
  updateCompactConfig: (config: { radialStrength?: number; communityPull?: number; centeringStrength?: number; radiusScale?: number }) => void;
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function usePixiLayout(
  allNodes: GraphNode[],
  allLinks: GraphLink[],
  communityData: CommunityData,
  layoutConfig: LayoutConfig,
  onTick: (positions: Map<string, { x: number; y: number }>, buffer?: Float64Array) => void,
  initialLayoutMode: LayoutMode = 'spread',
): UsePixiLayoutResult {
  const [layoutReady, setLayoutReady] = useState(false);
  const [simRunning, setSimRunning] = useState(true);
  const simRunningRef = useRef(true);
  const workerRef = useRef<Worker | null>(null);
  const unmountedRef = useRef(false);
  const requestIdRef = useRef(0);

  // Stable refs for node order (set during init, used to decode Float64Array)
  const nodeOrderRef = useRef<string[]>([]);
  const breakpointRef = useRef<PixiScaleBreakpoint | null>(null);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const nodeSizesRef = useRef<Map<string, number>>(new Map());
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const flatMode = layoutConfig.flatMode ?? false;
  const structuralTypes = new Set(flatMode ? [] : layoutConfig.structuralTypes);

  // Cleanup on unmount
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // Compute node sizes
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
      sizes.set(node.id, nodeSize(degreeMap.get(node.id) ?? 0, node.type, structuralTypes));
    }
    nodeSizesRef.current = sizes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes, allLinks]);

  // Apply Float64Array positions to the position map (in-place update, no allocation)
  const applyPositionBuffer = useCallback((buffer: Float64Array) => {
    const nodeOrder = nodeOrderRef.current;
    const pos = positionsRef.current;
    for (let i = 0; i < nodeOrder.length; i++) {
      const id = nodeOrder[i];
      const existing = pos.get(id);
      if (existing) {
        existing.x = buffer[i * 2];
        existing.y = buffer[i * 2 + 1];
      } else {
        pos.set(id, { x: buffer[i * 2], y: buffer[i * 2 + 1] });
      }
    }
  }, []);

  // Main effect: spawn worker and init simulation
  useEffect(() => {
    // Terminate previous worker
    workerRef.current?.terminate();
    workerRef.current = null;
    setLayoutReady(false);

    if (allNodes.length === 0) return;

    const reqId = ++requestIdRef.current;

    // Build node order
    const nodeIds = allNodes.map((n) => n.id);
    nodeOrderRef.current = nodeIds;

    // Seed position map entries
    const pos = positionsRef.current;
    pos.clear();
    for (const id of nodeIds) {
      pos.set(id, { x: 0, y: 0 });
    }

    // Build layout-only links
    const nodeIdSet = new Set(nodeIds);
    const links: { source: string; target: string }[] = [];
    for (const link of allLinks) {
      if (!flatMode && link.label !== layoutConfig.layoutEdgeType) continue;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (nodeIdSet.has(source) && nodeIdSet.has(target)) {
        links.push({ source, target });
      }
    }

    // Create worker
    const worker = new Worker(
      new URL('../workers/pixiLayoutWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onerror = (err) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;
      console.error(
        '[pixi] layout worker failed — nodes will be placed at (0,0).',
        'The graph will render but without force-directed layout.',
        err,
      );
      setLayoutReady(true);
    };

    worker.onmessage = (e: MessageEvent<WorkerOutMessage>) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;

      switch (e.data.type) {
        case 'ready':
          // Initial positions from sync ticks
          applyPositionBuffer(e.data.buffer);
          setLayoutReady(true);
          break;

        case 'positions':
          // Streaming position update — in-place map update + pass raw buffer
          applyPositionBuffer(e.data.buffer);
          onTickRef.current(positionsRef.current, e.data.buffer);
          break;

        case 'settled':
          simRunningRef.current = false;
          setSimRunning(false);
          break;
      }
    };

    // Select breakpoint for theta config
    const bp = selectBreakpoint(allNodes.length);
    breakpointRef.current = bp;

    // Send init message
    worker.postMessage({
      type: 'init',
      nodeIds,
      links,
      communities: communityData.assignments,
      config: {
        chargeStrength: layoutConfig.chargeStrength,
        linkDistance: layoutConfig.linkDistance,
        barnesHutTheta: bp.barnesHutTheta,
        dragTheta: bp.dragTheta,
        layoutMode: initialLayoutMode,
      },
    } satisfies WorkerInMessage);

    simRunningRef.current = true;
    setSimRunning(true);

    return () => {
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes, allLinks, communityData, layoutConfig, applyPositionBuffer]);

  // ── Control callbacks (all just postMessage to worker) ────────────────

  const postToWorker = useCallback((msg: WorkerInMessage) => {
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

  const fixNode = useCallback((nodeId: string, x: number, y: number) => {
    postToWorker({ type: 'fix-node', nodeId, x, y });
    if (!simRunningRef.current) {
      simRunningRef.current = true;
      setSimRunning(true);
    }
  }, [postToWorker]);

  const unfixNode = useCallback((nodeId: string) => {
    postToWorker({ type: 'unfix-node', nodeId });
  }, [postToWorker]);

  const setChargeStrength = useCallback((strength: number) => {
    postToWorker({ type: 'update-config', chargeStrength: strength });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const setLinkDistance = useCallback((distance: number) => {
    postToWorker({ type: 'update-config', linkDistance: distance });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const setCenterStrength = useCallback((strength: number) => {
    postToWorker({ type: 'update-config', centerStrength: strength });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const setCommunityGravity = useCallback((enabled: boolean, strength = 0.1) => {
    postToWorker({ type: 'set-community-gravity', enabled, strength });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const boostTheta = useCallback(() => {
    postToWorker({ type: 'boost-theta' });
  }, [postToWorker]);

  const resetTheta = useCallback(() => {
    postToWorker({ type: 'reset-theta' });
  }, [postToWorker]);

  const setLayoutMode = useCallback((mode: LayoutMode) => {
    postToWorker({ type: 'set-layout-mode', mode });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const updateCompactConfig = useCallback((config: { radialStrength?: number; communityPull?: number; centeringStrength?: number; radiusScale?: number }) => {
    postToWorker({ type: 'update-compact-config', ...config });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  return {
    layoutReady,
    positions: positionsRef.current,
    nodeSizes: nodeSizesRef.current,
    simRunning,
    reheat,
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
  };
}
