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
 * Web Worker that runs d3-force layout off the main thread.
 *
 * Receives: { nodeIds: string[], links: { source, target }[], config }
 * Returns:  { positions: [id, x, y][] }
 */
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
} from "d3-force";

interface SimNode {
  id: string;
  x?: number;
  y?: number;
}

interface SimLink {
  source: string;
  target: string;
}

export interface LayoutRequest {
  nodeIds: string[];
  links: SimLink[];
  communities?: Record<string, number>;
  config: {
    linkDistance: number;
    chargeStrength: number;
    ticks: number;
    clusterStrength?: number;
    clusterTicks?: number;
    clusterSeparation?: number;
  };
}

export interface LayoutResponse {
  positions: [string, number, number][];
}

self.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const { nodeIds, links, communities, config } = e.data;

  const simNodes: SimNode[] = nodeIds.map((id) => ({ id }));

  // Phase 1: Standard force layout
  const simulation = forceSimulation(simNodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(config.linkDistance),
    )
    .force("charge", forceManyBody().strength(config.chargeStrength))
    .force("center", forceCenter(0, 0))
    .stop();

  for (let i = 0; i < config.ticks; i++) {
    simulation.tick();
  }

  // Phase 2: Community clustering
  if (communities && config.clusterStrength) {
    // Compute centroid of each community from Phase 1 positions
    const centroidSums = new Map<
      number,
      { x: number; y: number; count: number }
    >();
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

    // Spread centroids apart by scaling distance from global center.
    // Uses log scale: small graphs barely spread, large graphs spread more.
    const baseSep = config.clusterSeparation ?? 1;
    const separation =
      centroids.size <= 10 ? 1.0 : baseSep * Math.log10(centroids.size);
    if (separation > 1 && centroids.size > 1) {
      let gx = 0,
        gy = 0;
      for (const { x, y } of centroids.values()) {
        gx += x;
        gy += y;
      }
      gx /= centroids.size;
      gy /= centroids.size;
      for (const [cid, c] of centroids) {
        centroids.set(cid, {
          x: gx + (c.x - gx) * separation,
          y: gy + (c.y - gy) * separation,
        });
      }
    }

    // Build lookup: nodeId → centroid
    const nodeCentroid = new Map<string, { x: number; y: number }>();
    for (const node of simNodes) {
      const cid = communities[node.id];
      if (cid !== undefined && centroids.has(cid)) {
        nodeCentroid.set(node.id, centroids.get(cid)!);
      }
    }

    // Phase 2 simulation: keep link forces + add clustering pull with softer repulsion
    const sim2 = forceSimulation(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.id)
          .distance(config.linkDistance),
      )
      .force("charge", forceManyBody().strength(config.chargeStrength * 0.5))
      .force(
        "clusterX",
        forceX<SimNode>((d) => nodeCentroid.get(d.id)?.x ?? 0).strength(
          config.clusterStrength,
        ),
      )
      .force(
        "clusterY",
        forceY<SimNode>((d) => nodeCentroid.get(d.id)?.y ?? 0).strength(
          config.clusterStrength,
        ),
      )
      .stop();

    for (let i = 0; i < (config.clusterTicks ?? 40); i++) {
      sim2.tick();
    }
  }

  const positions: [string, number, number][] = simNodes.map((n) => [
    n.id,
    n.x ?? 0,
    n.y ?? 0,
  ]);

  (self as unknown as Worker).postMessage({
    positions,
  } satisfies LayoutResponse);
};
