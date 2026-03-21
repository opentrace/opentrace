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
 * Pre-render layout algorithms that run synchronously before sigma renders.
 * Extracted from useGraphInstance for testability.
 */

// ─── Community spacing ──────────────────────────────────────────────────
// Pushes community centroids apart so they don't overlap.
// Same algorithm as spacingWorker.ts but runs synchronously on the main thread.

export function applySpacing(
  pos: Map<string, { x: number; y: number }>,
  assignments: Record<string, number>,
  radiusScale: number,
  gap: number,
  maxIterations: number,
  pushFactor: number,
): void {
  // Group by community
  const groups = new Map<number, string[]>();
  for (const [id] of pos) {
    const cid = assignments[id];
    if (cid === undefined) continue;
    let list = groups.get(cid);
    if (!list) {
      list = [];
      groups.set(cid, list);
    }
    list.push(id);
  }

  if (groups.size < 2) return;

  // Build community centroids and radii
  const comms: {
    nodeIds: string[];
    cx: number;
    cy: number;
    radius: number;
  }[] = [];
  for (const [, ids] of groups) {
    let cx = 0,
      cy = 0;
    for (const id of ids) {
      const p = pos.get(id)!;
      cx += p.x;
      cy += p.y;
    }
    cx /= ids.length;
    cy /= ids.length;
    comms.push({
      nodeIds: ids,
      cx,
      cy,
      radius: Math.sqrt(ids.length) * radiusScale,
    });
  }

  for (let iter = 0; iter < maxIterations; iter++) {
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
          const overlap = (minDist - dist) / minDist;
          if (overlap > maxOverlap) maxOverlap = overlap;

          const push = (minDist - dist) * pushFactor;
          if (dist > 0.001) {
            const nx = dx / dist;
            const ny = dy / dist;
            const totalSize = a.nodeIds.length + b.nodeIds.length;
            const aRatio = b.nodeIds.length / totalSize;
            const bRatio = a.nodeIds.length / totalSize;
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

    if (maxOverlap <= 0.05) break;

    // Apply pushes to centroids and member positions
    for (let i = 0; i < comms.length; i++) {
      const ox = pushX[i];
      const oy = pushY[i];
      if (Math.abs(ox) < 0.01 && Math.abs(oy) < 0.01) continue;
      comms[i].cx += ox;
      comms[i].cy += oy;
      for (const id of comms[i].nodeIds) {
        const p = pos.get(id)!;
        p.x += ox;
        p.y += oy;
      }
    }
  }
}

// ─── Per-community noverlap ─────────────────────────────────────────────
// Pushes overlapping nodes apart within each community.

export function applyNoverlap(
  pos: Map<string, { x: number; y: number }>,
  sizes: Map<string, number>,
  assignments: Record<string, number>,
  margin: number,
  iterations: number,
): void {
  // Group by community
  const groups = new Map<number, string[]>();
  for (const [id] of pos) {
    const cid = assignments[id];
    if (cid === undefined) continue;
    let list = groups.get(cid);
    if (!list) {
      list = [];
      groups.set(cid, list);
    }
    list.push(id);
  }

  // Compute a scale factor from the position bounding box
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const [, p] of pos) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const scale = Math.max(maxX - minX, maxY - minY, 1) / 4000;
  const scaledMargin = margin * scale;

  const MAX_INLINE = 500;

  for (const [, ids] of groups) {
    if (ids.length < 3 || ids.length > MAX_INLINE) continue;

    // Build local position/size array
    const nodes = ids.map((id) => ({
      id,
      x: pos.get(id)!.x,
      y: pos.get(id)!.y,
      size: (sizes.get(id) ?? 3) * scale,
    }));

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDist = a.size + b.size + scaledMargin;
          if (dist < minDist && dist > 0.001) {
            const push = (minDist - dist) * 0.5;
            const nx = dx / dist;
            const ny = dy / dist;
            a.x -= nx * push;
            a.y -= ny * push;
            b.x += nx * push;
            b.y += ny * push;
          }
        }
      }
    }

    // Write back
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      p.x = n.x;
      p.y = n.y;
    }
  }
}
