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
      };
    }
  | { type: 'update-config'; chargeStrength?: number; linkDistance?: number; centerStrength?: number }
  | { type: 'fix-node'; nodeId: string; x: number; y: number }
  | { type: 'unfix-node'; nodeId: string }
  | { type: 'reheat' }
  | { type: 'stop' }
  | { type: 'start' }
  | { type: 'boost-theta' } // increase Barnes-Hut theta during drag for speed
  | { type: 'reset-theta' } // restore normal theta after drag
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
let defaultTheta = 0.9; // Barnes-Hut approximation accuracy
let dragTheta = 1.5; // faster theta during drag
let settled = false;
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

      // Create simulation
      sim = forceSimulation<SimNode, SimLink>(simNodes)
        .force(
          'link',
          forceLink<SimNode, SimLink>(simLinks)
            .id((d) => d.id)
            .distance(msg.config.linkDistance),
        )
        .force('charge', forceManyBody().strength(msg.config.chargeStrength).theta(defaultTheta))
        .force('center', forceCenter(0, 0).strength(msg.config.centerStrength ?? 1));

      // Run initial ticks synchronously
      sim.stop();
      const INITIAL_TICKS = 10;
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
      if (!sim) break;
      if (msg.chargeStrength !== undefined) {
        sim.force('charge', forceManyBody().strength(msg.chargeStrength));
      }
      if (msg.linkDistance !== undefined) {
        const link = sim.force('link') as ReturnType<typeof forceLink<SimNode, SimLink>> | undefined;
        if (link) link.distance(msg.linkDistance);
      }
      if (msg.centerStrength !== undefined) {
        const center = sim.force('center') as ReturnType<typeof forceCenter> | undefined;
        if (center) center.strength(msg.centerStrength);
      }
      sim.alpha(0.3).restart();
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

