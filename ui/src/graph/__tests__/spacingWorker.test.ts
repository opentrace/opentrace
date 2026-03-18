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

// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

/**
 * Tests for the community spacing algorithm logic from spacingWorker.ts.
 *
 * Since the worker uses `self.onmessage`, we replicate the core algorithm
 * here as a pure function to test the spacing behavior.
 */

// ─── Extracted algorithm ──────────────────────────────────────────────

interface SpacingNode {
  id: string;
  x: number;
  y: number;
  communityId: number;
}

interface Community {
  id: number;
  nodeIndices: number[];
  cx: number;
  cy: number;
  radius: number;
}

/**
 * Replicate the core spacing logic: compute push vectors for overlapping
 * community centroids and apply them to member nodes.
 * Returns the nodes with updated positions.
 */
function runSpacing(
  nodes: SpacingNode[],
  radiusScale: number,
  gap: number,
  maxIterations: number,
): { nodes: SpacingNode[]; iterations: number; maxOverlap: number } {
  if (nodes.length === 0) return { nodes, iterations: 0, maxOverlap: 0 };

  // Group by community
  const communityMap = new Map<number, number[]>();
  for (let i = 0; i < nodes.length; i++) {
    const cid = nodes[i].communityId;
    let list = communityMap.get(cid);
    if (!list) {
      list = [];
      communityMap.set(cid, list);
    }
    list.push(i);
  }

  // Build communities
  const comms: Community[] = [];
  for (const [id, indices] of communityMap) {
    let cx = 0,
      cy = 0;
    for (const i of indices) {
      cx += nodes[i].x;
      cy += nodes[i].y;
    }
    cx /= indices.length;
    cy /= indices.length;
    comms.push({
      id,
      nodeIndices: indices,
      cx,
      cy,
      radius: Math.sqrt(indices.length) * radiusScale,
    });
  }

  if (comms.length < 2) return { nodes, iterations: 0, maxOverlap: 0 };

  let lastMaxOverlap = 0;
  for (let iter = 0; iter < maxIterations; iter++) {
    const pushX = new Float64Array(comms.length);
    const pushY = new Float64Array(comms.length);
    let maxOverlap = 0;

    for (let i = 0; i < comms.length; i++) {
      for (let j = i + 1; j < comms.length; j++) {
        const a = comms[i],
          b = comms[j];
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.radius + b.radius + gap;

        if (dist < minDist) {
          const overlap = (minDist - dist) / minDist;
          if (overlap > maxOverlap) maxOverlap = overlap;
          const push = (minDist - dist) * 0.5;
          if (dist > 0.001) {
            const nx = dx / dist,
              ny = dy / dist;
            const totalSize = a.nodeIndices.length + b.nodeIndices.length;
            const aRatio = b.nodeIndices.length / totalSize;
            const bRatio = a.nodeIndices.length / totalSize;
            pushX[i] -= nx * push * aRatio;
            pushY[i] -= ny * push * aRatio;
            pushX[j] += nx * push * bRatio;
            pushY[j] += ny * push * bRatio;
          }
        }
      }
    }

    let anyMoved = false;
    for (let i = 0; i < comms.length; i++) {
      const ox = pushX[i],
        oy = pushY[i];
      if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) continue;
      anyMoved = true;
      comms[i].cx += ox;
      comms[i].cy += oy;
      for (const ni of comms[i].nodeIndices) {
        nodes[ni].x += ox;
        nodes[ni].y += oy;
      }
    }

    lastMaxOverlap = maxOverlap;
    if (maxOverlap <= 0.01 || !anyMoved) {
      return { nodes, iterations: iter + 1, maxOverlap };
    }
  }

  return { nodes, iterations: maxIterations, maxOverlap: lastMaxOverlap };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('spacing algorithm', () => {
  it('pushes two overlapping communities apart', () => {
    // Two communities at same position
    const nodes: SpacingNode[] = [
      { id: 'a1', x: 0, y: 0, communityId: 0 },
      { id: 'a2', x: 1, y: 0, communityId: 0 },
      { id: 'b1', x: 2, y: 0, communityId: 1 },
      { id: 'b2', x: 3, y: 0, communityId: 1 },
    ];
    // radiusScale=10, gap=5 — communities are close (centroids at 0.5 and 2.5, dist=2)
    // minDist = sqrt(2)*10 + sqrt(2)*10 + 5 = ~33.3 >> 2, so they overlap
    const result = runSpacing(nodes, 10, 5, 50);

    // Community 0 centroid should have moved left, community 1 right
    const c0x = (result.nodes[0].x + result.nodes[1].x) / 2;
    const c1x = (result.nodes[2].x + result.nodes[3].x) / 2;
    expect(c1x - c0x).toBeGreaterThan(2); // farther apart than original 2
  });

  it('non-overlapping communities stay put', () => {
    // Two communities far apart
    const nodes: SpacingNode[] = [
      { id: 'a1', x: 0, y: 0, communityId: 0 },
      { id: 'b1', x: 1000, y: 0, communityId: 1 },
    ];
    // radiusScale=1, gap=1 — minDist = 1+1+1 = 3, dist = 1000 >> 3
    const result = runSpacing(nodes, 1, 1, 50);

    expect(result.nodes[0].x).toBe(0);
    expect(result.nodes[0].y).toBe(0);
    expect(result.nodes[1].x).toBe(1000);
    expect(result.nodes[1].y).toBe(0);
    // Converges in 1 iteration (enters loop, finds no overlap, exits)
    expect(result.iterations).toBe(1);
  });

  it('larger communities move proportionally less', () => {
    // Community 0 has 4 nodes, community 1 has 1 node — overlapping
    // Place them with slightly offset centroids so the push direction is clear
    const nodes: SpacingNode[] = [
      { id: 'a1', x: 0, y: 0, communityId: 0 },
      { id: 'a2', x: 2, y: 0, communityId: 0 },
      { id: 'a3', x: 0, y: 2, communityId: 0 },
      { id: 'a4', x: 2, y: 2, communityId: 0 },
      { id: 'b1', x: 3, y: 1, communityId: 1 }, // centroid offset from comm 0
    ];
    const origC0x = (0 + 2 + 0 + 2) / 4; // 1.0
    const origC1x = 3.0;

    const result = runSpacing(nodes, 5, 2, 50);

    const c0x = result.nodes.slice(0, 4).reduce((s, n) => s + n.x, 0) / 4;
    const c1x = result.nodes[4].x;

    // The small community (1 node) should have moved farther from original position
    const c0Displacement = Math.abs(c0x - origC0x);
    const c1Displacement = Math.abs(c1x - origC1x);
    expect(c1Displacement).toBeGreaterThan(c0Displacement);
  });

  it('gap parameter creates minimum distance between communities', () => {
    const nodes: SpacingNode[] = [
      { id: 'a1', x: 0, y: 0, communityId: 0 },
      { id: 'b1', x: 5, y: 0, communityId: 1 },
    ];
    // With a large gap, communities should be pushed apart
    const smallGap = runSpacing(
      nodes.map((n) => ({ ...n })),
      1,
      1,
      100,
    );
    const largeGap = runSpacing(
      nodes.map((n) => ({ ...n })),
      1,
      50,
      100,
    );

    const smallDist = Math.abs(smallGap.nodes[1].x - smallGap.nodes[0].x);
    const largeDist = Math.abs(largeGap.nodes[1].x - largeGap.nodes[0].x);

    expect(largeDist).toBeGreaterThan(smallDist);
  });
});
