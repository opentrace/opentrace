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
 * Web Worker that iteratively pushes community centroids apart so they
 * don't overlap. Each community is treated as a circle with radius
 * proportional to sqrt(memberCount).
 *
 * Posts position updates after each iteration so the graph updates live.
 */

export interface SpacingNode {
  id: string;
  x: number;
  y: number;
  communityId: number;
}

export interface SpacingRequest {
  nodes: SpacingNode[];
  /** Multiplier for community radius (higher = more space between communities) */
  radiusScale: number;
  /** Extra gap between community borders (in graph coordinate units) */
  gap: number;
  /** Max iterations */
  maxIterations: number;
  /** Stop when max overlap between any two communities is below this (0–1) */
  overlapThreshold: number;
}

export interface SpacingProgress {
  type: 'progress';
  iteration: number;
  maxOverlap: number;
  /** Per-node position updates (delta applied to all members of moved communities) */
  updates: { id: string; x: number; y: number }[];
}

export interface SpacingDone {
  type: 'done';
  iterations: number;
  maxOverlap: number;
  totalMs: number;
}

export type SpacingResponse = SpacingProgress | SpacingDone;

// ─── Worker ──────────────────────────────────────────────────────────

interface Community {
  id: number;
  nodeIndices: number[];
  cx: number;
  cy: number;
  radius: number;
}

self.onmessage = (e: MessageEvent<SpacingRequest>) => {
  const { nodes, radiusScale, gap, maxIterations, overlapThreshold } = e.data;
  const t0 = performance.now();

  if (nodes.length === 0) {
    (self as unknown as Worker).postMessage({
      type: 'done', iterations: 0, maxOverlap: 0, totalMs: 0,
    } satisfies SpacingDone);
    return;
  }

  // Group nodes by community
  const communityMap = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const cid = nodes[i].communityId;
    let list = communityMap.get(cid);
    if (!list) { list = []; communityMap.set(cid, list); }
    list.push(i);
  }

  // Build community array with centroids and radii
  const comms: Community[] = [];
  for (const [id, indices] of communityMap) {
    let cx = 0, cy = 0;
    for (const i of indices) { cx += nodes[i].x; cy += nodes[i].y; }
    cx /= indices.length;
    cy /= indices.length;
    comms.push({
      id,
      nodeIndices: indices,
      cx, cy,
      radius: Math.sqrt(indices.length) * radiusScale,
    });
  }

  if (comms.length < 2) {
    (self as unknown as Worker).postMessage({
      type: 'done', iterations: 0, maxOverlap: 0, totalMs: 0,
    } satisfies SpacingDone);
    return;
  }

  let lastMaxOverlap = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    // Compute push vectors for each community centroid
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
          const overlap = (minDist - dist) / minDist; // 0..1
          if (overlap > maxOverlap) maxOverlap = overlap;

          const push = (minDist - dist) * 0.5;
          if (dist > 0.001) {
            const nx = dx / dist;
            const ny = dy / dist;
            // Smaller community moves more
            const totalSize = a.nodeIndices.length + b.nodeIndices.length;
            const aRatio = b.nodeIndices.length / totalSize;
            const bRatio = a.nodeIndices.length / totalSize;
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

    // Apply centroid shifts and move all member nodes
    const updates: { id: string; x: number; y: number }[] = [];
    for (let i = 0; i < comms.length; i++) {
      const ox = pushX[i];
      const oy = pushY[i];
      if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) continue;

      comms[i].cx += ox;
      comms[i].cy += oy;
      for (const ni of comms[i].nodeIndices) {
        nodes[ni].x += ox;
        nodes[ni].y += oy;
        updates.push({ id: nodes[ni].id, x: nodes[ni].x, y: nodes[ni].y });
      }
    }

    // Post progress every iteration
    (self as unknown as Worker).postMessage({
      type: 'progress',
      iteration: iter,
      maxOverlap,
      updates,
    } satisfies SpacingProgress);

    lastMaxOverlap = maxOverlap;

    // Converged
    if (maxOverlap <= overlapThreshold || updates.length === 0) {
      (self as unknown as Worker).postMessage({
        type: 'done',
        iterations: iter + 1,
        maxOverlap,
        totalMs: performance.now() - t0,
      } satisfies SpacingDone);
      return;
    }
  }

  // Max iterations
  (self as unknown as Worker).postMessage({
    type: 'done',
    iterations: maxIterations,
    maxOverlap: lastMaxOverlap,
    totalMs: performance.now() - t0,
  } satisfies SpacingDone);
};
