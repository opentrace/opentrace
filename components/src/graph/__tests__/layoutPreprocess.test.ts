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

import { describe, it, expect } from 'vitest';
import { applySpacing, applyNoverlap } from '../layoutPreprocess';

// ─── Helpers ──────────────────────────────────────────────────────────

/** Generate N nodes spread across `numCommunities` communities with random positions. */
function generateNodes(
  count: number,
  numCommunities: number,
): {
  pos: Map<string, { x: number; y: number }>;
  assignments: Record<string, number>;
  sizes: Map<string, number>;
} {
  const pos = new Map<string, { x: number; y: number }>();
  const assignments: Record<string, number> = {};
  const sizes = new Map<string, number>();

  for (let i = 0; i < count; i++) {
    const id = `n${i}`;
    const cid = i % numCommunities;
    // Cluster nodes near their community centroid with some noise
    const cx = (cid % 10) * 100;
    const cy = Math.floor(cid / 10) * 100;
    pos.set(id, {
      x: cx + (Math.random() - 0.5) * 50,
      y: cy + (Math.random() - 0.5) * 50,
    });
    assignments[id] = cid;
    sizes.set(id, 3 + Math.random() * 5);
  }

  return { pos, assignments, sizes };
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

// ─── Correctness tests ───────────────────────────────────────────────

describe('applySpacing', () => {
  it('pushes overlapping communities apart', () => {
    const pos = new Map<string, { x: number; y: number }>([
      ['a1', { x: 0, y: 0 }],
      ['a2', { x: 1, y: 0 }],
      ['b1', { x: 2, y: 0 }],
      ['b2', { x: 3, y: 0 }],
    ]);
    const assignments: Record<string, number> = {
      a1: 0,
      a2: 0,
      b1: 1,
      b2: 1,
    };

    applySpacing(pos, assignments, 10, 5, 50, 0.5);

    const c0x = (pos.get('a1')!.x + pos.get('a2')!.x) / 2;
    const c1x = (pos.get('b1')!.x + pos.get('b2')!.x) / 2;
    expect(c1x - c0x).toBeGreaterThan(2);
  });

  it('does nothing with a single community', () => {
    const pos = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 1, y: 1 }],
    ]);
    applySpacing(pos, { a: 0, b: 0 }, 10, 5, 50, 0.5);
    expect(pos.get('a')!.x).toBe(0);
    expect(pos.get('b')!.x).toBe(1);
  });
});

describe('applyNoverlap', () => {
  it('pushes overlapping nodes apart within a community', () => {
    // Place nodes at graph-scale positions (hundreds of units apart)
    // so the bounding-box scale factor produces meaningful sizes
    const pos = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 1, y: 0 }],
      ['c', { x: 2, y: 0 }],
      ['d', { x: 500, y: 500 }], // far corner to set bounding box scale
    ]);
    const sizes = new Map([
      ['a', 5],
      ['b', 5],
      ['c', 5],
      ['d', 5],
    ]);
    const assignments: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };

    const origSpan = pos.get('c')!.x - pos.get('a')!.x; // 2

    applyNoverlap(pos, sizes, assignments, 25, 20);

    const newSpan = Math.abs(pos.get('c')!.x - pos.get('a')!.x);
    expect(newSpan).toBeGreaterThan(origSpan);
  });

  it('skips communities smaller than 3 nodes', () => {
    const pos = new Map([
      ['a', { x: 0, y: 0 }],
      ['b', { x: 0.01, y: 0 }],
    ]);
    const sizes = new Map([
      ['a', 5],
      ['b', 5],
    ]);
    applyNoverlap(pos, sizes, { a: 0, b: 0 }, 25, 20);
    // Positions unchanged — community too small
    expect(pos.get('a')!.x).toBe(0);
    expect(pos.get('b')!.x).toBe(0.01);
  });
});

// ─── Performance tests ──────────────────────────────────────────────

describe('applySpacing performance', () => {
  const SIZES = [
    { nodes: 10_000, communities: 50, label: '10k' },
    { nodes: 100_000, communities: 200, label: '100k' },
    { nodes: 300_000, communities: 500, label: '300k' },
  ];

  for (const { nodes, communities, label } of SIZES) {
    it(`${label} nodes / ${communities} communities completes within budget`, () => {
      const { pos, assignments } = generateNodes(nodes, communities);

      const ms = timeMs(() => {
        applySpacing(pos, assignments, 40, 100, 50, 0.5);
      });

      // Log for visibility in test output
      console.log(
        `  applySpacing(${label}): ${ms.toFixed(1)}ms (${communities} communities)`,
      );

      // Budget: spacing is O(communities²·iterations + nodes) per iteration.
      // With 500 communities and 50 iters, the community loop is 500²·50 = 12.5M ops.
      // Node position updates are O(nodes) per iteration.
      // 10k: <100ms, 100k: <500ms, 300k: <2000ms
      const budget =
        nodes <= 10_000 ? 500 : nodes <= 100_000 ? 2000 : 5000;
      expect(ms).toBeLessThan(budget);
    });
  }
});

describe('applyNoverlap performance', () => {
  const SIZES = [
    { nodes: 10_000, communities: 50, label: '10k' },
    { nodes: 100_000, communities: 200, label: '100k' },
    { nodes: 300_000, communities: 500, label: '300k' },
  ];

  for (const { nodes, communities, label } of SIZES) {
    it(`${label} nodes / ${communities} communities completes within budget`, () => {
      const { pos, assignments, sizes } = generateNodes(nodes, communities);

      const ms = timeMs(() => {
        applyNoverlap(pos, sizes, assignments, 25, 20);
      });

      console.log(
        `  applyNoverlap(${label}): ${ms.toFixed(1)}ms (${communities} communities, max 500/community)`,
      );

      // Budget: noverlap is O(sum of communitySize² · iterations) for communities ≤500.
      // With even distribution: each community has nodes/communities members.
      // 10k/50 = 200/community → 200²·20 = 800k ops per community × 50 = 40M total
      // 100k/200 = 500/community → capped at 500, 500²·20 = 5M × 200 = 1B — expensive
      // 300k/500 = 600/community → capped at 500 (skipped), so effectively 0 work for large communities
      const budget =
        nodes <= 10_000 ? 1000 : nodes <= 100_000 ? 5000 : 10000;
      expect(ms).toBeLessThan(budget);
    });
  }
});
