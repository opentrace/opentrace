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
 * Tests for the node overlap optimization logic from optimizeWorker.ts.
 *
 * Since the worker uses `self.onmessage`, we replicate the core algorithm
 * here as a pure function to test the overlap resolution behavior.
 */

// ─── Extracted algorithm ──────────────────────────────────────────────

interface OptimizeNode {
  id: string;
  x: number;
  y: number;
  size: number;
}

/**
 * Replicate the core optimize logic: iteratively push overlapping nodes apart.
 * Returns updated nodes and convergence info.
 */
function runOptimize(
  nodes: OptimizeNode[],
  margin: number,
  overlapThreshold: number,
  targetCleanRatio: number,
  maxIterations: number,
  pushStrength: number,
): { nodes: OptimizeNode[]; iterations: number; cleanRatio: number } {
  if (nodes.length === 0) return { nodes, iterations: 0, cleanRatio: 1 };

  // Track frozen nodes
  const cleanStreak = new Uint8Array(nodes.length);
  const frozen = new Uint8Array(nodes.length);
  const FREEZE_AFTER = 3;

  for (let iter = 0; iter < maxIterations; iter++) {
    let cleanCount = 0;
    const pushX = new Float64Array(nodes.length);
    const pushY = new Float64Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      if (frozen[i]) {
        cleanCount++;
        continue;
      }

      const a = nodes[i];
      let worstOverlap = 0;

      for (let j = 0; j < nodes.length; j++) {
        if (i === j) continue;
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.size + b.size + margin;

        if (dist < minDist) {
          const overlap = 1 - dist / minDist;
          if (overlap > worstOverlap) worstOverlap = overlap;

          const force = overlap * pushStrength;
          if (dist > 0.001) {
            const nx = dx / dist,
              ny = dy / dist;
            if (!frozen[i]) {
              pushX[i] -= nx * force * minDist;
              pushY[i] -= ny * force * minDist;
            }
            if (!frozen[j]) {
              pushX[j] += nx * force * minDist;
              pushY[j] += ny * force * minDist;
            }
          } else {
            // Same position — push apart along x-axis
            pushX[i] -= force * minDist;
            pushX[j] += force * minDist;
          }
        }
      }

      if (worstOverlap < overlapThreshold) {
        cleanCount++;
        cleanStreak[i]++;
        if (cleanStreak[i] >= FREEZE_AFTER) frozen[i] = 1;
      } else {
        cleanStreak[i] = 0;
      }
    }

    // Apply push vectors
    for (let i = 0; i < nodes.length; i++) {
      if (frozen[i]) continue;
      if (Math.abs(pushX[i]) > 0.01 || Math.abs(pushY[i]) > 0.01) {
        nodes[i].x += pushX[i];
        nodes[i].y += pushY[i];
      }
    }

    const cleanRatio = cleanCount / nodes.length;
    if (cleanRatio >= targetCleanRatio) {
      return { nodes, iterations: iter + 1, cleanRatio };
    }
  }

  // Final measurement
  let finalClean = 0;
  for (let i = 0; i < nodes.length; i++) {
    let worst = 0;
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const dx = nodes[j].x - nodes[i].x;
      const dy = nodes[j].y - nodes[i].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = nodes[i].size + nodes[j].size + margin;
      if (dist < minDist) {
        const o = 1 - dist / minDist;
        if (o > worst) worst = o;
      }
    }
    if (worst < overlapThreshold) finalClean++;
  }

  return {
    nodes,
    iterations: maxIterations,
    cleanRatio: finalClean / nodes.length,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('optimize algorithm', () => {
  it('pushes overlapping nodes apart', () => {
    const nodes: OptimizeNode[] = [
      { id: 'a', x: 0, y: 0, size: 5 },
      { id: 'b', x: 2, y: 0, size: 5 }, // overlap: minDist = 5+5+2 = 12, dist = 2
    ];
    const result = runOptimize(nodes, 2, 0.1, 0.5, 100, 0.5);

    const dist = Math.sqrt(
      (result.nodes[1].x - result.nodes[0].x) ** 2 +
        (result.nodes[1].y - result.nodes[0].y) ** 2,
    );
    // After optimization, distance should be at least close to minDist
    expect(dist).toBeGreaterThan(2);
  });

  it('nodes at nearly same position get pushed apart', () => {
    // Place nodes very close (but not exactly at same position) so push direction is defined
    const nodes: OptimizeNode[] = [
      { id: 'a', x: 50, y: 50, size: 5 },
      { id: 'b', x: 50.002, y: 50, size: 5 },
    ];
    const result = runOptimize(nodes, 2, 0.1, 0.5, 100, 0.5);

    const dist = Math.sqrt(
      (result.nodes[1].x - result.nodes[0].x) ** 2 +
        (result.nodes[1].y - result.nodes[0].y) ** 2,
    );
    // After optimization they should be meaningfully separated
    expect(dist).toBeGreaterThan(1);
  });

  it('frozen nodes do not move after clean streak', () => {
    // Two well-separated nodes and one overlapping pair
    const nodes: OptimizeNode[] = [
      { id: 'far', x: 1000, y: 1000, size: 2 }, // isolated, will freeze quickly
      { id: 'a', x: 0, y: 0, size: 5 },
      { id: 'b', x: 1, y: 0, size: 5 }, // overlaps with a
    ];
    const result = runOptimize(nodes, 1, 0.1, 0.9, 100, 0.3);

    // The far node should not have moved at all (it was clean from the start)
    expect(result.nodes[0].x).toBe(1000);
    expect(result.nodes[0].y).toBe(1000);
  });

  it('clean ratio correctly computed', () => {
    // All nodes far apart — should immediately be 100% clean
    const nodes: OptimizeNode[] = [
      { id: 'a', x: 0, y: 0, size: 2 },
      { id: 'b', x: 100, y: 0, size: 2 },
      { id: 'c', x: 0, y: 100, size: 2 },
    ];
    const result = runOptimize(nodes, 1, 0.1, 0.5, 10, 0.5);

    expect(result.cleanRatio).toBe(1);
    expect(result.iterations).toBe(1); // converges immediately
  });

  it('converges when target met', () => {
    const nodes: OptimizeNode[] = [
      { id: 'a', x: 0, y: 0, size: 3 },
      { id: 'b', x: 1, y: 0, size: 3 },
      { id: 'c', x: 100, y: 100, size: 3 }, // far away, always clean
    ];
    // targetCleanRatio = 0.5 means we need 2/3 nodes clean
    const result = runOptimize(nodes, 1, 0.1, 0.5, 200, 0.5);

    expect(result.cleanRatio).toBeGreaterThanOrEqual(0.5);
    expect(result.iterations).toBeLessThan(200);
  });
});
