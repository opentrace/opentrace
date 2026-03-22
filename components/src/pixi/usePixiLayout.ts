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
 * Hook that runs d3-force simulation on the main thread for the Pixi renderer.
 *
 * Unlike the Sigma path (which runs d3-force in a Web Worker, computes all
 * positions upfront, then feeds them to Sigma), this hook runs live: each
 * simulation tick triggers a callback so the PixiRenderer can update sprite
 * positions immediately, giving a smooth "growing graph" animation.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNode, GraphLink, CommunityData, LayoutConfig } from '../graph/types';
import { endpointId, nodeSize } from '../graph/layoutHelpers';

// ─── Types ──────────────────────────────────────────────────────────────

interface SimNode extends SimulationNodeDatum {
  id: string;
  fx?: number | null;
  fy?: number | null;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
}

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
}

// ─── Hook ───────────────────────────────────────────────────────────────

export function usePixiLayout(
  allNodes: GraphNode[],
  allLinks: GraphLink[],
  communityData: CommunityData,
  layoutConfig: LayoutConfig,
  onTick: (positions: Map<string, { x: number; y: number }>) => void,
): UsePixiLayoutResult {
  const [layoutReady, setLayoutReady] = useState(false);
  const [simRunning, setSimRunning] = useState(true);
  const simRunningRef = useRef(true);
  const simulationRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const communityDataRef = useRef(communityData);
  communityDataRef.current = communityData;
  const simNodesRef = useRef<SimNode[]>([]);
  const simNodeMapRef = useRef<Map<string, SimNode>>(new Map());
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const nodeSizesRef = useRef<Map<string, number>>(new Map());
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;

  const flatMode = layoutConfig.flatMode ?? false;
  const structuralTypes = new Set(flatMode ? [] : layoutConfig.structuralTypes);

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

  useEffect(() => {
    // Teardown previous
    simulationRef.current?.stop();
    setLayoutReady(false);

    if (allNodes.length === 0) return;

    // Build simulation nodes
    const nodeIdSet = new Set(allNodes.map((n) => n.id));
    const simNodes: SimNode[] = allNodes.map((n) => ({
      id: n.id,
    }));
    simNodesRef.current = simNodes;
    const simNodeMap = new Map<string, SimNode>();
    for (const n of simNodes) simNodeMap.set(n.id, n);
    simNodeMapRef.current = simNodeMap;

    // Build simulation links — only layout edges (or all in flat mode)
    const simLinks: SimLink[] = [];
    for (const link of allLinks) {
      if (!flatMode && link.label !== layoutConfig.layoutEdgeType) continue;
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (nodeIdSet.has(source) && nodeIdSet.has(target)) {
        simLinks.push({ source, target });
      }
    }

    // Compute community centroids for clustering phase (after initial ticks)
    const { assignments } = communityData;
    const clusterStrength = layoutConfig.clusterStrength;

    // Create simulation
    const sim = forceSimulation<SimNode, SimLink>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(layoutConfig.linkDistance),
      )
      .force('charge', forceManyBody().strength(layoutConfig.chargeStrength))
      .force('center', forceCenter(0, 0));

    // Add community clustering forces if we have assignments
    if (assignments && Object.keys(assignments).length > 0 && clusterStrength > 0 && !flatMode) {
      // We'll add cluster forces after initial layout settles a bit
      // For now, just add center to keep things bounded
    }

    // Tick a few frames synchronously so positions spread out from the
    // phyllotaxis default, then mark ready so sprites appear immediately.
    // The simulation continues running via rAF — nodes animate into position.
    const INITIAL_TICKS = 10;
    sim.stop(); // pause auto-ticking
    for (let i = 0; i < INITIAL_TICKS; i++) sim.tick();
    sim.restart(); // resume auto-ticking from here

    // Seed initial positions
    const pos = positionsRef.current;
    for (const node of simNodes) {
      pos.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
    }
    // Mark ready immediately — sprites appear and animate as simulation runs
    setLayoutReady(true);

    // On each tick, update positions and call callback
    sim.on('tick', () => {
      pos.clear();
      for (const node of simNodes) {
        pos.set(node.id, { x: node.x ?? 0, y: node.y ?? 0 });
      }
      onTickRef.current(pos);
    });

    // No end handler — the live simulation just settles naturally.
    // Community clustering is available on-demand via the control panel's
    // "Community clusters" toggle (setCommunityGravity).

    simulationRef.current = sim;

    return () => {
      sim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes, allLinks, communityData, layoutConfig]);

  const restart = useCallback(() => {
    simulationRef.current?.alpha(0.5).restart();
    simRunningRef.current = true;
    setSimRunning(true);
  }, []);

  const reheat = useCallback(() => {
    simulationRef.current?.alpha(1).restart();
    simRunningRef.current = true;
    setSimRunning(true);
  }, []);

  const toggleSim = useCallback(() => {
    const sim = simulationRef.current;
    if (!sim) return;
    // Use ref to avoid stale closure over simRunning state
    if (simRunningRef.current) {
      sim.stop();
      simRunningRef.current = false;
      setSimRunning(false);
    } else {
      sim.restart();
      simRunningRef.current = true;
      setSimRunning(true);
    }
  }, []);

  const stopSim = useCallback(() => {
    const sim = simulationRef.current;
    if (!sim) return;
    sim.stop();
    simRunningRef.current = false;
    setSimRunning(false);
  }, []);

  const startSim = useCallback(() => {
    const sim = simulationRef.current;
    if (!sim) return;
    sim.alpha(0.5).restart();
    simRunningRef.current = true;
    setSimRunning(true);
  }, []);

  const fixNode = useCallback((nodeId: string, x: number, y: number) => {
    const node = simNodeMapRef.current.get(nodeId);
    if (node) {
      node.fx = x;
      node.fy = y;
      simulationRef.current?.alpha(0.1).restart();
      simRunningRef.current = true;
      setSimRunning(true);
    }
  }, []);

  const unfixNode = useCallback((nodeId: string) => {
    const node = simNodeMapRef.current.get(nodeId);
    if (node) {
      node.fx = null;
      node.fy = null;
    }
  }, []);

  const setChargeStrength = useCallback((strength: number) => {
    const sim = simulationRef.current;
    if (!sim) return;
    sim.force('charge', forceManyBody().strength(strength));
    sim.alpha(0.3).restart();
    simRunningRef.current = true;
    setSimRunning(true);
  }, []);

  const setLinkDistance = useCallback((distance: number) => {
    const sim = simulationRef.current;
    if (!sim) return;
    const link = sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined;
    if (link) link.distance(distance);
    sim.alpha(0.3).restart();
    simRunningRef.current = true;
    setSimRunning(true);
  }, []);

  const setCenterStrength = useCallback((strength: number) => {
    const sim = simulationRef.current;
    if (!sim) return;
    const center = sim.force('center') as ReturnType<typeof forceCenter> | undefined;
    if (center) center.strength(strength);
    sim.alpha(0.3).restart();
    simRunningRef.current = true;
    setSimRunning(true);
  }, []);

  const setCommunityGravity = useCallback((enabled: boolean, strength = 0.1) => {
    const sim = simulationRef.current;
    if (!sim) return;

    if (!enabled) {
      sim.force('clusterX', null);
      sim.force('clusterY', null);
      sim.alpha(0.3).restart();
      simRunningRef.current = true;
      setSimRunning(true);
      return;
    }

    // Compute centroids from current positions
    const { assignments } = communityDataRef.current;
    if (!assignments) return;

    const centroidSums = new Map<number, { x: number; y: number; count: number }>();
    for (const node of simNodesRef.current) {
      const cid = assignments[node.id];
      if (cid === undefined) continue;
      const entry = centroidSums.get(cid) || { x: 0, y: 0, count: 0 };
      entry.x += node.x ?? 0;
      entry.y += node.y ?? 0;
      entry.count += 1;
      centroidSums.set(cid, entry);
    }
    const centroids = new Map<number, { x: number; y: number }>();
    for (const [cid, { x, y, count }] of centroidSums) {
      centroids.set(cid, { x: x / count, y: y / count });
    }
    const nodeCentroid = new Map<string, { x: number; y: number }>();
    for (const node of simNodesRef.current) {
      const cid = assignments[node.id];
      if (cid !== undefined && centroids.has(cid)) {
        nodeCentroid.set(node.id, centroids.get(cid)!);
      }
    }

    sim
      .force('clusterX', forceX<SimNode>((d) => nodeCentroid.get(d.id)?.x ?? 0).strength(strength))
      .force('clusterY', forceY<SimNode>((d) => nodeCentroid.get(d.id)?.y ?? 0).strength(strength))
      .alpha(0.5)
      .restart();
    simRunningRef.current = true;
    setSimRunning(true);
  }, []);

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
  };
}
