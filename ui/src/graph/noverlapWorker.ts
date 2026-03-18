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
 * Web Worker that runs incremental noverlap — posts position updates after
 * each iteration so the graph updates live.
 *
 * Uses a spatial grid for O(n) neighbor lookups per iteration.
 */

export interface NoverlapNode {
  id: string;
  x: number;
  y: number;
  size: number;
}

export interface NoverlapRequest {
  nodes: NoverlapNode[];
  settings: {
    maxIterations: number;
    ratio: number;
    margin: number;
    expansion: number;
  };
  grid: {
    cellTarget: number;
    overlapRatio: number;
  };
}

export interface NoverlapCellResult {
  type: 'iteration';
  iteration: number;
  totalIterations: number;
  moved: number;
  updates: { id: string; x: number; y: number }[];
  ms: number;
}

export interface NoverlapDone {
  type: 'done';
  totalNodes: number;
  totalCells: number;
  totalMs: number;
}

export type NoverlapResponse = NoverlapCellResult | NoverlapDone;

// ─── Spatial grid for fast neighbor queries ──────────────────────────

class SpatialGrid {
  #cells = new Map<string, number[]>();
  #cellSize: number;
  #nodes: NoverlapNode[];

  constructor(nodes: NoverlapNode[], cellSize: number) {
    this.#nodes = nodes;
    this.#cellSize = cellSize;
    this.rebuild();
  }

  #key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  rebuild() {
    this.#cells.clear();
    for (let i = 0; i < this.#nodes.length; i++) {
      const cx = Math.floor(this.#nodes[i].x / this.#cellSize);
      const cy = Math.floor(this.#nodes[i].y / this.#cellSize);
      const k = this.#key(cx, cy);
      let list = this.#cells.get(k);
      if (!list) {
        list = [];
        this.#cells.set(k, list);
      }
      list.push(i);
    }
  }

  getNeighborIndices(idx: number): number[] {
    const n = this.#nodes[idx];
    const cx = Math.floor(n.x / this.#cellSize);
    const cy = Math.floor(n.y / this.#cellSize);
    const result: number[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.#cells.get(this.#key(cx + dx, cy + dy));
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

self.onmessage = (e: MessageEvent<NoverlapRequest>) => {
  const { nodes, settings } = e.data;
  const t0 = performance.now();

  if (nodes.length === 0) {
    (self as unknown as Worker).postMessage({
      type: 'done',
      totalNodes: 0,
      totalCells: 0,
      totalMs: 0,
    } satisfies NoverlapDone);
    return;
  }

  // Expand node sizes for overlap detection
  const expandedNodes = nodes.map((n) => ({
    ...n,
    size: n.size * settings.expansion,
  }));

  // Compute grid cell size from max expanded node size
  let maxSize = 0;
  for (const n of expandedNodes) {
    if (n.size > maxSize) maxSize = n.size;
  }
  const cellSize = (maxSize * 2 + settings.margin) * 2;
  const grid = new SpatialGrid(expandedNodes, cellSize);

  for (let iter = 0; iter < settings.maxIterations; iter++) {
    const iterStart = performance.now();
    let moved = 0;

    // Compute push vectors
    const pushX = new Float64Array(expandedNodes.length);
    const pushY = new Float64Array(expandedNodes.length);

    for (let i = 0; i < expandedNodes.length; i++) {
      const a = expandedNodes[i];
      const neighbors = grid.getNeighborIndices(i);

      for (const j of neighbors) {
        if (j <= i) continue; // process each pair once
        const b = expandedNodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = (a.size + b.size) * settings.ratio + settings.margin;

        if (dist < minDist && dist > 0.001) {
          const overlap = minDist - dist;
          const nx = dx / dist;
          const ny = dy / dist;
          const push = overlap * 0.5; // split evenly between both nodes
          pushX[i] -= nx * push;
          pushY[i] -= ny * push;
          pushX[j] += nx * push;
          pushY[j] += ny * push;
        } else if (dist <= 0.001) {
          // Same position — random push
          const angle = Math.random() * Math.PI * 2;
          const push = (a.size + b.size) * 0.5;
          pushX[i] -= Math.cos(angle) * push;
          pushY[i] -= Math.sin(angle) * push;
          pushX[j] += Math.cos(angle) * push;
          pushY[j] += Math.sin(angle) * push;
        }
      }
    }

    // Apply and collect updates
    const updates: { id: string; x: number; y: number }[] = [];
    for (let i = 0; i < expandedNodes.length; i++) {
      if (Math.abs(pushX[i]) > 0.01 || Math.abs(pushY[i]) > 0.01) {
        expandedNodes[i].x += pushX[i];
        expandedNodes[i].y += pushY[i];
        // Also update original nodes array for final positions
        nodes[i].x = expandedNodes[i].x;
        nodes[i].y = expandedNodes[i].y;
        updates.push({ id: nodes[i].id, x: nodes[i].x, y: nodes[i].y });
        moved++;
      }
    }

    grid.rebuild();

    // Post update after every iteration
    (self as unknown as Worker).postMessage({
      type: 'iteration',
      iteration: iter,
      totalIterations: settings.maxIterations,
      moved,
      updates,
      ms: performance.now() - iterStart,
    } satisfies NoverlapCellResult);

    // Early exit if nothing moved
    if (moved === 0) break;
  }

  (self as unknown as Worker).postMessage({
    type: 'done',
    totalNodes: nodes.length,
    totalCells: 0,
    totalMs: performance.now() - t0,
  } satisfies NoverlapDone);
};
