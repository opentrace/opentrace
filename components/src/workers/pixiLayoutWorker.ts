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
 * Persistent Web Worker for Pixi.js d3-force layout.
 *
 * Unlike d3LayoutWorker (single-shot), this worker keeps the simulation alive
 * and streams position snapshots at ~15fps via transferable Float64Array.
 *
 * Protocol:
 *   init           → build simulation, return initial positions after sync ticks
 *   positions      ← streamed every ~66ms as Float64Array [x0,y0,x1,y1,...]
 *   settled        ← sent when alpha < 0.005
 *   update-config  → change force parameters, reheat
 *   fix-node       → pin node for dragging
 *   unfix-node     → unpin node
 *   reheat / stop / start → physics controls
 *   set-community-gravity → toggle cluster forces
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
  forceRadial,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

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

/** Layout mode: 'spread' = standard force-directed, 'compact' = radial/circular with contain force. */
export type LayoutMode = 'spread' | 'compact';

export type WorkerInMessage =
  | {
      type: 'init';
      nodeIds: string[];
      links: { source: string; target: string }[];
      communities?: Record<string, number>;
      config: {
        chargeStrength: number;
        linkDistance: number;
        centerStrength?: number;
        barnesHutTheta?: number;
        dragTheta?: number;
        layoutMode?: LayoutMode;
      };
    }
  | { type: 'update-config'; chargeStrength?: number; linkDistance?: number; centerStrength?: number }
  | { type: 'update-compact-config'; radialStrength?: number; communityPull?: number; centeringStrength?: number; radiusScale?: number }
  | { type: 'set-layout-mode'; mode: LayoutMode }
  | { type: 'fix-node'; nodeId: string; x: number; y: number }
  | { type: 'unfix-node'; nodeId: string }
  | { type: 'reheat' }
  | { type: 'stop' }
  | { type: 'start' }
  | { type: 'boost-theta' }
  | { type: 'reset-theta' }
  | { type: 'set-community-gravity'; enabled: boolean; strength?: number };

export type WorkerOutMessage =
  | { type: 'positions'; buffer: Float64Array }
  | { type: 'settled' }
  | { type: 'ready'; buffer: Float64Array };

// ─── Worker State ────────────────────────────────────────────────────────

let sim: Simulation<SimNode, SimLink> | null = null;
let simNodes: SimNode[] = [];
let nodeIdToIndex: Map<string, number> = new Map();
let communities: Record<string, number> | undefined;
let currentMode: LayoutMode = 'spread';
let defaultTheta = 0.9;
let dragTheta = 1.5;
let settled = false;
// Cached init config for re-building simulation on layout mode switch
let cachedLinks: SimLink[] = [];
let cachedConfig: { chargeStrength: number; linkDistance: number; centerStrength?: number } | null = null;
// Compact mode tuning (updated at runtime via update-compact-config)
let compactConfig = { radialStrength: 0.08, communityPull: 0.1, centeringStrength: 0.05, radiusScale: 32 };
let streaming = false;
let streamInterval: ReturnType<typeof setInterval> | null = null;

const STREAM_INTERVAL = 66; // ~15fps
const SETTLE_ALPHA = 0.005;

// ─── Helpers ─────────────────────────────────────────────────────────────

function buildPositionBuffer(): Float64Array {
  const buf = new Float64Array(simNodes.length * 2);
  for (let i = 0; i < simNodes.length; i++) {
    buf[i * 2] = simNodes[i].x ?? 0;
    buf[i * 2 + 1] = simNodes[i].y ?? 0;
  }
  return buf;
}

function postPositions(): void {
  const buf = buildPositionBuffer();
  (self as unknown as Worker).postMessage(
    { type: 'positions', buffer: buf } satisfies WorkerOutMessage,
    [buf.buffer],
  );
}

function startStreaming(): void {
  if (streaming) return;
  streaming = true;
  settled = false;
  streamInterval = setInterval(() => {
    if (!sim) return;
    if (sim.alpha() < SETTLE_ALPHA) {
      // Send one final position snapshot so the last ~66ms of movement isn't dropped
      postPositions();
      stopStreaming();
      settled = true;
      (self as unknown as Worker).postMessage({ type: 'settled' } satisfies WorkerOutMessage);
      return;
    }
    postPositions();
  }, STREAM_INTERVAL);
}

function stopStreaming(): void {
  if (streamInterval !== null) {
    clearInterval(streamInterval);
    streamInterval = null;
  }
  streaming = false;
}

// ─── Simulation Builder ──────────────────────────────────────────────────

/**
 * Build a d3-force simulation with the appropriate forces for the layout mode.
 *
 * 'spread': Standard force-directed — nodes repel, links attract, gentle center.
 * 'compact': Radial/circular — weak charge, radial pull, contain force, community
 *            gravity. Produces the dense circular layout like Grafana/Obsidian.
 */
function buildSimulation(
  nodes: SimNode[],
  links: SimLink[],
  config: { chargeStrength: number; linkDistance: number; centerStrength?: number },
  mode: LayoutMode,
): Simulation<SimNode, SimLink> {
  const s = forceSimulation<SimNode, SimLink>(nodes);

  // Link force — compact mode uses shorter, weaker links for dense packing
  const linkForce = forceLink<SimNode, SimLink>(links)
    .id((d) => d.id)
    .distance(mode === 'compact' ? 40 : config.linkDistance);
  if (mode === 'compact') linkForce.strength(0.2);
  s.force('link', linkForce);

  if (mode === 'compact') {
    const compactRadius = Math.sqrt(nodes.length) * compactConfig.radiusScale;

    s.force('charge', forceManyBody().strength(config.chargeStrength).theta(defaultTheta))
      .force('center', forceCenter(0, 0).strength(0.3))
      .force('x', forceX<SimNode>(0).strength(compactConfig.centeringStrength))
      .force('y', forceY<SimNode>(0).strength(compactConfig.centeringStrength))
      .force('radial', forceRadial(0, 0, 0).strength(compactConfig.radialStrength))
      .alphaDecay(0.008)
      .velocityDecay(0.4);

    // Custom contain force — clamps nodes inside a circle
    const containForce = () => {
      for (const node of nodes) {
        const dist = Math.sqrt((node.x ?? 0) ** 2 + (node.y ?? 0) ** 2);
        if (dist > compactRadius) {
          const scale = compactRadius / dist;
          node.x = (node.x ?? 0) * scale;
          node.y = (node.y ?? 0) * scale;
        }
      }
    };
    // d3-force accepts any function with .initialize as a force
    (containForce as unknown as { initialize: (n: SimNode[]) => void }).initialize = () => {};
    s.force('contain', containForce as unknown as Parameters<typeof s.force>[1]);

    // Community gravity — pulls nodes toward their community centroid each tick
    if (communities && Object.keys(communities).length > 0) {
      const comms = communities;
      const communityForce = () => {
        const cx = new Map<number, number>();
        const cy = new Map<number, number>();
        const count = new Map<number, number>();
        for (const node of nodes) {
          const c = comms[node.id];
          if (c === undefined) continue;
          cx.set(c, (cx.get(c) ?? 0) + (node.x ?? 0));
          cy.set(c, (cy.get(c) ?? 0) + (node.y ?? 0));
          count.set(c, (count.get(c) ?? 0) + 1);
        }
        const alpha = s.alpha();
        for (const node of nodes) {
          const c = comms[node.id];
          if (c === undefined) continue;
          const n = count.get(c)!;
          if (n < 2) continue;
          const targetX = cx.get(c)! / n;
          const targetY = cy.get(c)! / n;
          node.vx = (node.vx ?? 0) + (targetX - (node.x ?? 0)) * compactConfig.communityPull * alpha;
          node.vy = (node.vy ?? 0) + (targetY - (node.y ?? 0)) * compactConfig.communityPull * alpha;
        }
      };
      (communityForce as unknown as { initialize: (n: SimNode[]) => void }).initialize = () => {};
      s.force('communityGravity', communityForce as unknown as Parameters<typeof s.force>[1]);
    }
  } else {
    // Spread mode — standard force-directed
    s.force('charge', forceManyBody().strength(config.chargeStrength).theta(defaultTheta))
      .force('center', forceCenter(0, 0).strength(config.centerStrength ?? 1));
  }

  return s;
}

// ─── Message Handler ─────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<WorkerInMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      // Tear down previous
      stopStreaming();
      sim?.stop();
      communities = msg.communities;
      defaultTheta = msg.config.barnesHutTheta ?? 0.9;
      dragTheta = msg.config.dragTheta ?? 1.5;
      currentMode = msg.config.layoutMode ?? 'spread';

      // Build sim nodes
      simNodes = msg.nodeIds.map((id) => ({ id }));
      nodeIdToIndex = new Map();
      for (let i = 0; i < msg.nodeIds.length; i++) {
        nodeIdToIndex.set(msg.nodeIds[i], i);
      }

      // Build sim links — filter to valid endpoints
      const nodeIdSet = new Set(msg.nodeIds);
      const simLinks: SimLink[] = [];
      for (const link of msg.links) {
        if (nodeIdSet.has(link.source) && nodeIdSet.has(link.target)) {
          simLinks.push({ source: link.source, target: link.target });
        }
      }
      cachedLinks = simLinks;
      cachedConfig = {
        chargeStrength: msg.config.chargeStrength,
        linkDistance: msg.config.linkDistance,
        centerStrength: msg.config.centerStrength,
      };

      // Create simulation
      sim = buildSimulation(simNodes, simLinks, cachedConfig, currentMode);

      // Run initial ticks synchronously
      sim.stop();
      const INITIAL_TICKS = currentMode === 'compact' ? 30 : 10;
      for (let i = 0; i < INITIAL_TICKS; i++) sim.tick();

      // Send initial positions
      const buf = buildPositionBuffer();
      (self as unknown as Worker).postMessage(
        { type: 'ready', buffer: buf } satisfies WorkerOutMessage,
        [buf.buffer],
      );

      // Resume simulation and start streaming
      sim.restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'update-config': {
      if (!sim || !cachedConfig) break;
      if (msg.chargeStrength !== undefined) cachedConfig.chargeStrength = msg.chargeStrength;
      if (msg.linkDistance !== undefined) cachedConfig.linkDistance = msg.linkDistance;
      if (msg.centerStrength !== undefined) cachedConfig.centerStrength = msg.centerStrength;

      // Charge and link distance apply in both modes
      if (msg.chargeStrength !== undefined) {
        sim.force('charge', forceManyBody().strength(msg.chargeStrength).theta(defaultTheta));
      }
      if (msg.linkDistance !== undefined) {
        const link = sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined;
        if (link) link.distance(msg.linkDistance);
      }
      // Center strength only applies in spread mode
      if (currentMode === 'spread' && msg.centerStrength !== undefined) {
        const center = sim.force('center') as ReturnType<typeof forceCenter> | undefined;
        if (center) center.strength(msg.centerStrength);
      }
      sim.alpha(0.3).restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'update-compact-config': {
      if (!sim || !cachedConfig) break;
      let needsRebuild = false;
      if (msg.radialStrength !== undefined) {
        compactConfig.radialStrength = msg.radialStrength;
        const radial = sim.force('radial') as ReturnType<typeof forceRadial> | undefined;
        if (radial) radial.strength(msg.radialStrength);
      }
      if (msg.communityPull !== undefined) {
        compactConfig.communityPull = msg.communityPull;
        // communityGravity is a custom force — reads compactConfig.communityPull directly
      }
      if (msg.centeringStrength !== undefined) {
        compactConfig.centeringStrength = msg.centeringStrength;
        const fx = sim.force('x') as ReturnType<typeof forceX> | undefined;
        const fy = sim.force('y') as ReturnType<typeof forceY> | undefined;
        if (fx) fx.strength(msg.centeringStrength);
        if (fy) fy.strength(msg.centeringStrength);
      }
      if (msg.radiusScale !== undefined) {
        compactConfig.radiusScale = msg.radiusScale;
        // Contain force captures radius at build time — must rebuild
        needsRebuild = true;
      }
      if (needsRebuild) {
        sim.stop();
        sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
        sim.alpha(0.5).restart();
      } else {
        sim.alpha(0.3).restart();
      }
      settled = false;
      startStreaming();
      break;
    }

    case 'set-layout-mode': {
      if (!sim || !cachedConfig) break;
      currentMode = msg.mode;
      // Rebuild simulation with new force composition, keeping current positions
      sim.stop();
      sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
      sim.alpha(1).restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'fix-node': {
      if (!sim) break;
      const idx = nodeIdToIndex.get(msg.nodeId);
      if (idx !== undefined) {
        simNodes[idx].fx = msg.x;
        simNodes[idx].fy = msg.y;
        sim.alpha(Math.max(sim.alpha(), 0.1)).restart();
        if (settled) {
          settled = false;
          startStreaming();
        }
      }
      break;
    }

    case 'unfix-node': {
      if (!sim) break;
      const idx = nodeIdToIndex.get(msg.nodeId);
      if (idx !== undefined) {
        simNodes[idx].fx = null;
        simNodes[idx].fy = null;
      }
      break;
    }

    case 'reheat': {
      if (!sim) break;
      sim.alpha(1).restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'stop': {
      if (!sim) break;
      sim.stop();
      stopStreaming();
      break;
    }

    case 'start': {
      if (!sim) break;
      sim.alpha(0.5).restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'boost-theta': {
      // Increase Barnes-Hut theta during drag for faster computation.
      // Less accurate but ~2x faster at 20k nodes — acceptable since only
      // local nodes matter during drag.
      if (!sim) break;
      const charge = sim.force('charge') as ReturnType<typeof forceManyBody> | undefined;
      if (charge) charge.theta(dragTheta);
      break;
    }

    case 'reset-theta': {
      if (!sim) break;
      const charge = sim.force('charge') as ReturnType<typeof forceManyBody> | undefined;
      if (charge) charge.theta(defaultTheta);
      break;
    }

    case 'set-community-gravity': {
      if (!sim) break;

      if (!msg.enabled) {
        sim.force('clusterX', null);
        sim.force('clusterY', null);
        sim.alpha(0.3).restart();
        settled = false;
        startStreaming();
        break;
      }

      // Compute centroids from current positions
      const strength = msg.strength ?? 0.1;
      const centroidSums = new Map<number, { x: number; y: number; count: number }>();

      if (!communities) break;

      for (const node of simNodes) {
        const cid = communities[node.id];
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
      for (const node of simNodes) {
        const cid = communities[node.id];
        if (cid !== undefined && centroids.has(cid)) {
          nodeCentroid.set(node.id, centroids.get(cid)!);
        }
      }

      sim
        .force('clusterX', forceX<SimNode>((d) => nodeCentroid.get(d.id)?.x ?? 0).strength(strength))
        .force('clusterY', forceY<SimNode>((d) => nodeCentroid.get(d.id)?.y ?? 0).strength(strength))
        .alpha(0.5)
        .restart();
      settled = false;
      startStreaming();
      break;
    }
  }
};

