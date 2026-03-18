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
 * Web Worker that iteratively pushes overlapping nodes apart until a target
 * overlap metric is met: ≥50% of nodes have <10% overlap with any neighbor.
 *
 * "Overlap" between two nodes = max(0, 1 - distance / (sizeA + sizeB + margin)).
 * 0% = no overlap, 100% = perfectly stacked.
 *
 * Uses a spatial grid for O(n) neighbor lookups per iteration instead of O(n²).
 */

export interface OptimizeNode {
  id: string;
  x: number;
  y: number;
  size: number;
}

export interface OptimizeRequest {
  nodes: OptimizeNode[];
  /** Minimum gap (px) between node borders */
  margin: number;
  /** Max overlap ratio for a node to be considered "clean" (0.1 = 10%) */
  overlapThreshold: number;
  /** Fraction of nodes that must be "clean" to stop (0.5 = 50%) */
  targetCleanRatio: number;
  /** Max iterations before giving up */
  maxIterations: number;
  /** How aggressively to push apart per step (0.1–1.0) */
  pushStrength: number;
}

export interface OptimizeProgress {
  type: 'progress';
  iteration: number;
  cleanRatio: number;
  totalOverlaps: number;
  updates: { id: string; x: number; y: number }[];
}

export interface OptimizeDone {
  type: 'done';
  iterations: number;
  cleanRatio: number;
  totalMs: number;
}

export type OptimizeResponse = OptimizeProgress | OptimizeDone;

// ─── Spatial grid for fast neighbor queries ──────────────────────────

class SpatialGrid {
  private cells = new Map<string, number[]>();
  private cellSize: number;

  constructor(
    private nodes: OptimizeNode[],
    cellSize: number,
  ) {
    this.cellSize = cellSize;
    this.rebuild();
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  rebuild() {
    this.cells.clear();
    for (let i = 0; i < this.nodes.length; i++) {
      const cx = Math.floor(this.nodes[i].x / this.cellSize);
      const cy = Math.floor(this.nodes[i].y / this.cellSize);
      const k = this.key(cx, cy);
      let list = this.cells.get(k);
      if (!list) {
        list = [];
        this.cells.set(k, list);
      }
      list.push(i);
    }
  }

  /** Get indices of nodes in the same cell or adjacent cells */
  getNeighborIndices(idx: number): number[] {
    const n = this.nodes[idx];
    const cx = Math.floor(n.x / this.cellSize);
    const cy = Math.floor(n.y / this.cellSize);
    const result: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(this.key(cx + dx, cy + dy));
        if (list) {
          for (const j of list) {
            if (j !== idx) result.push(j);
          }
        }
      }
    }
    return result;
  }
}

// ─── Worker ──────────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<OptimizeRequest>) => {
  const {
    nodes,
    margin,
    overlapThreshold,
    targetCleanRatio,
    maxIterations,
    pushStrength,
  } = e.data;
  const t0 = performance.now();

  if (nodes.length === 0) {
    (self as unknown as Worker).postMessage({
      type: 'done',
      iterations: 0,
      cleanRatio: 1,
      totalMs: 0,
    } satisfies OptimizeDone);
    return;
  }

  // Max node size determines grid cell size
  let maxSize = 0;
  for (const n of nodes) {
    if (n.size > maxSize) maxSize = n.size;
  }
  const cellSize = (maxSize * 2 + margin) * 3; // cells large enough to catch all overlapping pairs
  const grid = new SpatialGrid(nodes, cellSize);

  // Track frozen nodes — once clean for 3 consecutive iterations, freeze them.
  // Frozen nodes don't receive push forces, preventing clean areas from drifting.
  const cleanStreak = new Uint8Array(nodes.length); // consecutive clean iterations
  const frozen = new Uint8Array(nodes.length); // 1 = frozen
  const FREEZE_AFTER = 3; // freeze after this many consecutive clean iterations

  for (let iter = 0; iter < maxIterations; iter++) {
    // Measure overlap and compute push vectors
    let cleanCount = 0;
    // frozenCount tracked for potential future reporting
    let totalOverlaps = 0;
    const pushX = new Float64Array(nodes.length);
    const pushY = new Float64Array(nodes.length);

    for (let i = 0; i < nodes.length; i++) {
      if (frozen[i]) {
        cleanCount++;
        // frozen node counted as clean
        continue;
      }

      const a = nodes[i];
      let worstOverlap = 0;
      const neighbors = grid.getNeighborIndices(i);

      for (const j of neighbors) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.size + b.size + margin;

        if (dist < minDist) {
          const overlap = 1 - dist / minDist; // 0..1
          if (overlap > worstOverlap) worstOverlap = overlap;
          totalOverlaps++;

          // Only push unfrozen nodes
          const force = overlap * pushStrength;
          if (dist > 0.001) {
            const nx = dx / dist;
            const ny = dy / dist;
            if (!frozen[i]) {
              pushX[i] -= nx * force * minDist;
              pushY[i] -= ny * force * minDist;
            }
            if (!frozen[j]) {
              pushX[j] += nx * force * minDist;
              pushY[j] += ny * force * minDist;
            }
          } else {
            // Nodes at same position — push in random direction
            const angle = Math.random() * Math.PI * 2;
            pushX[i] -= Math.cos(angle) * force * minDist;
            pushY[i] -= Math.sin(angle) * force * minDist;
          }
        }
      }

      if (worstOverlap < overlapThreshold) {
        cleanCount++;
        cleanStreak[i]++;
        if (cleanStreak[i] >= FREEZE_AFTER) {
          frozen[i] = 1;
        }
      } else {
        cleanStreak[i] = 0;
      }
    }

    // Apply push vectors — only to unfrozen nodes
    for (let i = 0; i < nodes.length; i++) {
      if (frozen[i]) continue;
      if (Math.abs(pushX[i]) > 0.01 || Math.abs(pushY[i]) > 0.01) {
        nodes[i].x += pushX[i];
        nodes[i].y += pushY[i];
      }
    }

    // Rebuild grid with new positions
    grid.rebuild();

    const cleanRatio = cleanCount / nodes.length;

    // Send all current positions every 5 iterations so the graph stays in sync.
    // We send all nodes (not just moved ones) because intermediate iterations
    // accumulate movement that was never reported.
    if (iter % 5 === 0 || cleanRatio >= targetCleanRatio || iter === maxIterations - 1) {
      const updates: { id: string; x: number; y: number }[] = [];
      for (const n of nodes) {
        updates.push({ id: n.id, x: n.x, y: n.y });
      }
      (self as unknown as Worker).postMessage({
        type: 'progress',
        iteration: iter,
        cleanRatio,
        totalOverlaps: totalOverlaps / 2, // each pair counted twice
        updates,
      } satisfies OptimizeProgress);
    }

    // Target met
    if (cleanRatio >= targetCleanRatio) {
      (self as unknown as Worker).postMessage({
        type: 'done',
        iterations: iter + 1,
        cleanRatio,
        totalMs: performance.now() - t0,
      } satisfies OptimizeDone);
      return;
    }
  }

  // Max iterations reached
  const finalClean =
    nodes.reduce((c, _, i) => {
      let worst = 0;
      for (const j of grid.getNeighborIndices(i)) {
        const dx = nodes[j].x - nodes[i].x;
        const dy = nodes[j].y - nodes[i].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = nodes[i].size + nodes[j].size + margin;
        if (dist < minDist) {
          const o = 1 - dist / minDist;
          if (o > worst) worst = o;
        }
      }
      return worst < overlapThreshold ? c + 1 : c;
    }, 0) / nodes.length;

  (self as unknown as Worker).postMessage({
    type: 'done',
    iterations: maxIterations,
    cleanRatio: finalClean,
    totalMs: performance.now() - t0,
  } satisfies OptimizeDone);
};
