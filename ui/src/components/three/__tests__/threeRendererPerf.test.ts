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
 * Result-identity tests for the ThreeRenderer performance fast paths.
 *
 * These construct the renderer HEADLESSLY (Scene / BufferGeometry /
 * ShaderMaterial are pure JS — only WebGLRenderer needs a GPU, and init() is
 * never called) and verify that every optimized path produces bit-identical
 * outputs to the historical slow path, which is reimplemented verbatim here
 * as an oracle where needed.
 */

import { describe, expect, it } from 'vitest';
import { OrthographicCamera, Scene } from 'three';

import { ThreeRenderer, type ThreeEdge } from '../ThreeRenderer';
import { createNodeMaterial } from '../nodeMaterial';
import { createEdgeMaterial } from '../edgeMaterial';
import type { GraphLink, GraphNode } from '../../graph/types';
import {
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_HIGHLIGHTED,
  EDGE_OPACITY_DIMMED,
} from '../../config/graphLayout';

// ─── Harness ────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rndr = ThreeRenderer & Record<string, any>;

const node = (id: string, type = 'Class'): GraphNode => ({
  id,
  name: id,
  type,
});
const link = (source: string, target: string, label = 'CALLS'): GraphLink => ({
  source,
  target,
  label,
});

function makeCamera(width: number, height: number): OrthographicCamera {
  const cam = new OrthographicCamera(
    -width / 2,
    width / 2,
    height / 2,
    -height / 2,
    -100000,
    100000,
  );
  cam.position.set(0, 0, 1000);
  cam.zoom = 1;
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld();
  return cam;
}

/** Renderer with the GL-independent guts wired up (init() untouched). */
function makeRenderer(opts?: { camera?: boolean }): Rndr {
  const r = new ThreeRenderer() as Rndr;
  r.scene = new Scene();
  r.nodeMaterial = createNodeMaterial(1, {
    hlScale: 1.5,
    dimScale: 0.5,
    dimAlpha: 0.2,
  });
  r.nodeHaloMaterial = createNodeMaterial(1, {
    hlScale: 1.5,
    dimScale: 0.5,
    dimAlpha: 0.2,
    haloPass: true,
  });
  r.edgeMaterial = createEdgeMaterial();
  r.superEdgeMaterial = createEdgeMaterial();
  r.width = 800;
  r.height = 600;
  if (opts?.camera) r.camera = makeCamera(800, 600);
  return r;
}

async function setData(
  r: Rndr,
  nodes: GraphNode[],
  links: GraphLink[],
  positions?: Map<string, { x: number; y: number }>,
): Promise<void> {
  const pos =
    positions ??
    new Map(nodes.map((n, i) => [n.id, { x: i * 10, y: -i * 5 }] as const));
  await r.setData(
    nodes,
    links,
    pos,
    new Map(nodes.map((n) => [n.id, '#3366ff'] as const)),
    new Map(nodes.map((n) => [n.id, 4] as const)),
    new Map([['CALLS', '#888888']]),
    { skipAutoFit: true },
  );
}

// ─── Oracles (verbatim historical slow-path logic) ──────────────────────

/** The original updateEdgeAlpha per-edge computation, pre-refactor. */
function oracleEdgeAlphas(r: Rndr): Float32Array {
  const out = new Float32Array(r.edges.length * 2);
  const enabled = r.edgesEnabled;
  const lod = r.lodEnabled && r.superList.length > 0;
  const traversalActive = r.traversalActive();
  for (let i = 0; i < r.edges.length; i++) {
    const e: ThreeEdge = r.edges[i];
    const key = `${e.sourceId}-${e.targetId}`;
    const hot = r.hasHighlight && r.edgeIsHot(key);
    let alpha: number;
    if (r.traversalPendingEdges.has(key)) {
      alpha = 0;
    } else if ((!enabled || r.hiddenLinkTypes.has(e.label)) && !hot) {
      alpha = 0;
    } else {
      const sVis = r.nodeArray[e.sourceIdx]?.visible ?? true;
      const tVis = r.nodeArray[e.targetIdx]?.visible ?? true;
      const lodHidden =
        lod && (!r.nodeLodVisible(e.sourceId) || !r.nodeLodVisible(e.targetId));
      if (!sVis || !tVis || (lodHidden && !hot)) {
        alpha = 0;
      } else if (r.hasHighlight) {
        alpha = hot
          ? 1 + EDGE_OPACITY_HIGHLIGHTED
          : traversalActive
            ? 0
            : EDGE_OPACITY_DIMMED;
      } else {
        alpha = EDGE_OPACITY_DEFAULT;
        if (r.currentLayoutMode === 'tree' && e.label !== 'DEFINES') {
          alpha *= 0.1;
        }
      }
    }
    out[i * 2] = alpha;
    out[i * 2 + 1] = alpha;
  }
  return out;
}

/** The original rebuildEdgeDrawIndex loop: nodeInView per edge endpoint. */
function oracleEdgeDrawIndex(r: Rndr): number[] {
  const out: number[] = [];
  const a = r.edgeAlphaArray;
  const cull = r.bp.edgeViewportCulling && r.activeCamera != null;
  const mx = r.width * 0.25;
  const my = r.height * 0.25;
  for (let i = 0; i < r.edges.length; i++) {
    if (a[i * 2] <= 0) continue;
    if (cull) {
      const e: ThreeEdge = r.edges[i];
      if (
        !r.nodeInView(e.sourceIdx, mx, my) &&
        !r.nodeInView(e.targetIdx, mx, my)
      ) {
        continue;
      }
    }
    out.push(i * 2, i * 2 + 1);
  }
  return out;
}

function currentEdgeAlphas(r: Rndr): Float32Array {
  return (r.edgeAlphaArray as Float32Array).slice(0, r.edges.length * 2);
}

function currentEdgeDrawIndex(r: Rndr): number[] {
  const idx: Uint32Array = r.edgeDrawIndex;
  return [...idx.slice(0, r.edgeDrawCount)];
}

function currentNodeDrawIndex(r: Rndr): number[] {
  const idx: Uint32Array = r.nodeDrawIndex;
  return [...idx.slice(0, r.nodeDrawCount)];
}

// ─── Item 1: cached edge keys ───────────────────────────────────────────

describe('ThreeEdge.key caching', () => {
  it('stores `${sourceId}-${targetId}` on every edge built by setData', async () => {
    const r = makeRenderer();
    await setData(
      r,
      [node('a'), node('b'), node('c')],
      [link('a', 'b'), link('b', 'c', 'DEFINES')],
    );
    expect(r.edges.map((e: ThreeEdge) => e.key)).toEqual(['a-b', 'b-c']);
    for (const e of r.edges as ThreeEdge[]) {
      expect(e.key).toBe(`${e.sourceId}-${e.targetId}`);
    }
  });

  it('stores the key on edges appended during live-build', async () => {
    const r = makeRenderer();
    r.beginLiveGrow();
    await setData(r, [node('a'), node('b')], [link('a', 'b')]);
    r.appendLiveData(
      [node('a'), node('b'), node('c')],
      [link('a', 'b'), link('b', 'c')],
      new Map([['c', { x: 5, y: 5 }]]),
      new Map([['c', '#ff0000']]),
      new Map([['c', 4]]),
      new Map([['CALLS', '#888888']]),
    );
    expect(r.edges.map((e: ThreeEdge) => e.key)).toEqual(['a-b', 'b-c']);
  });
});

// ─── Items 6+7: per-edge alpha equivalence across render states ─────────

describe('updateEdgeAlpha result identity', () => {
  const NODES = [node('a'), node('b'), node('c'), node('d'), node('e')];
  const LINKS = [
    link('a', 'b'),
    link('b', 'c', 'DEFINES'),
    link('c', 'd'),
    link('d', 'e', 'IMPORTS'),
    link('a', 'e'),
  ];

  /** Apply a named state mutation, run updateEdgeAlpha, compare to oracle. */
  async function checkState(
    name: string,
    mutate: (r: Rndr) => void,
  ): Promise<void> {
    const r = makeRenderer();
    await setData(r, NODES, LINKS);
    mutate(r);
    r.updateEdgeAlpha();
    expect(currentEdgeAlphas(r), name).toEqual(oracleEdgeAlphas(r));
  }

  it('matches the oracle with no highlight (fast pass)', async () => {
    await checkState('base', () => {});
  });

  it('matches with edges disabled', async () => {
    await checkState('edges off', (r) => {
      r.edgesEnabled = false;
    });
  });

  it('matches with hidden link types', async () => {
    await checkState('hidden types', (r) => {
      r.hiddenLinkTypes = new Set(['CALLS']);
    });
  });

  it('matches in tree layout mode (relational-chord fade)', async () => {
    await checkState('tree mode', (r) => {
      r.currentLayoutMode = 'tree';
    });
  });

  it('matches with hidden nodes', async () => {
    await checkState('hidden nodes', (r) => {
      r.nodeArray[2].visible = false; // c → hides b-c and c-d
    });
  });

  it('matches with an active highlight (general path)', async () => {
    await checkState('highlight', (r) => {
      r.highlightNodes = new Set(['a', 'b']);
      r.highlightLinks = new Set(['a-b']);
      r.hasHighlight = true;
    });
  });

  it('matches with traversal pending + lit edges', async () => {
    await checkState('traversal', (r) => {
      r.traversalLitNodes = new Set(['a', 'b']);
      r.traversalLitEdges = new Set(['a-b', 'b-a']);
      r.traversalPendingEdges = new Set(['c-d', 'd-c']);
      r.hasHighlight = true;
    });
  });

  it('matches under active LOD aggregation', async () => {
    await checkState('lod', (r) => {
      r.lodEnabled = true;
      r.communityAssignments = { a: 0, b: 0, c: 1, d: 1 }; // e unassigned
      r.cidToSuper = new Map([
        [0, 0],
        [1, 1],
      ]);
      r.communityExpanded = Uint8Array.from([1, 0]); // 0 expanded, 1 collapsed
      r.superList = [
        { cid: 0, x: 0, y: 0, z: 0, radius: 1, count: 2 },
        { cid: 1, x: 0, y: 0, z: 0, radius: 1, count: 2 },
      ];
    });
  });

  it('matches under LOD + highlight (hot edges override the collapse)', async () => {
    await checkState('lod+highlight', (r) => {
      r.lodEnabled = true;
      r.communityAssignments = { a: 0, b: 0, c: 1, d: 1 };
      r.cidToSuper = new Map([
        [0, 0],
        [1, 1],
      ]);
      r.communityExpanded = Uint8Array.from([1, 0]);
      r.superList = [
        { cid: 0, x: 0, y: 0, z: 0, radius: 1, count: 2 },
        { cid: 1, x: 0, y: 0, z: 0, radius: 1, count: 2 },
      ];
      r.highlightNodes = new Set(['c', 'd']);
      r.highlightLinks = new Set(['c-d']);
      r.hasHighlight = true;
    });
  });
});

// ─── Item 7: LOD visibility flags equal nodeLodVisible per node ─────────

describe('computeLodVisFlags', () => {
  it('matches nodeLodVisible for every node', async () => {
    const r = makeRenderer();
    await setData(r, [node('a'), node('b'), node('c'), node('d')], []);
    r.lodEnabled = true;
    r.communityAssignments = { a: 0, b: 1, c: 7 }; // d unassigned
    r.cidToSuper = new Map([
      [0, 0],
      [1, 1],
    ]); // cid 7 has no super (too small)
    r.communityExpanded = Uint8Array.from([0, 1]);
    r.superList = [
      { cid: 0, x: 0, y: 0, z: 0, radius: 1, count: 4 },
      { cid: 1, x: 0, y: 0, z: 0, radius: 1, count: 4 },
    ];
    const flags = r.computeLodVisFlags();
    for (let i = 0; i < r.nodeArray.length; i++) {
      expect(flags[i] === 1).toBe(r.nodeLodVisible(r.nodeArray[i].id));
    }
  });
});

// ─── Item 2: edge draw index culling identity ───────────────────────────

describe('rebuildEdgeDrawIndex viewport culling', () => {
  it('produces the same index as the per-edge nodeInView oracle', async () => {
    const r = makeRenderer({ camera: true });
    // Viewport is 800×600 at zoom 1 with ±25% margins: nodes beyond ~±500/±375
    // (plus margin) are out. Mix of in-view, off-x, off-y endpoints.
    const positions = new Map<string, { x: number; y: number }>([
      ['a', { x: 0, y: 0 }], // in view
      ['b', { x: 100, y: 50 }], // in view
      ['c', { x: 5000, y: 0 }], // far off-screen (x)
      ['d', { x: 5100, y: 20 }], // far off-screen (x)
      ['e', { x: 0, y: -4000 }], // far off-screen (y)
    ]);
    await setData(
      r,
      [node('a'), node('b'), node('c'), node('d'), node('e')],
      [
        link('a', 'b'), // both in → kept
        link('b', 'c'), // one in → kept
        link('c', 'd'), // both out → culled
        link('d', 'e'), // both out → culled
        link('a', 'e'), // one in → kept
      ],
      positions,
    );
    r.bp = { ...r.bp, edgeViewportCulling: true };
    r.updateEdgeAlpha(); // fills alphas + rebuilds the index with culling
    expect(currentEdgeDrawIndex(r)).toEqual(oracleEdgeDrawIndex(r));
    // Sanity: the cull actually removed the off-screen pairs.
    expect(currentEdgeDrawIndex(r)).toEqual([0, 1, 2, 3, 8, 9]);
    // Geometry submits exactly the culled count.
    expect(r.edgeGeometry.drawRange.count).toBe(r.edgeDrawCount);
    expect(r.edgeGeometry.getIndex()!.array).toBe(r.edgeDrawIndex);
  });

  it('keeps zero-alpha edges out of the index regardless of culling', async () => {
    const r = makeRenderer({ camera: true });
    await setData(
      r,
      [node('a'), node('b'), node('c')],
      [link('a', 'b'), link('b', 'c', 'DEFINES')],
    );
    r.bp = { ...r.bp, edgeViewportCulling: true };
    r.hiddenLinkTypes = new Set(['CALLS']);
    r.updateEdgeAlpha();
    expect(currentEdgeDrawIndex(r)).toEqual(oracleEdgeDrawIndex(r));
    expect(currentEdgeDrawIndex(r)).toEqual([2, 3]); // only the DEFINES edge
  });
});

// ─── Item 4: pre-sorted label order ─────────────────────────────────────

describe('getLabelOrder', () => {
  it('matches the historical filter-then-stable-sort candidate order', async () => {
    const r = makeRenderer();
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => node(id));
    await setData(r, nodes, []);
    // Sizes with duplicates to exercise the tie-break: index-ascending.
    const sizes = [4, 9, 4, 9, 2, 9];
    for (let i = 0; i < sizes.length; i++) r.nodeArray[i].size = sizes[i];
    r.labelOrderDirty = true;

    const order: number[] = r.getLabelOrder();
    // Oracle: the old per-cull sort (stable) over ascending indices.
    const oracle = r.nodeArray.map((_: unknown, i: number) => i);
    oracle.sort((a: number, b: number) => sizes[b] - sizes[a]);
    expect(order).toEqual(oracle);
    expect(order).toEqual([1, 3, 5, 0, 2, 4]);

    // Filtering the pre-sorted order equals sorting the filtered candidates
    // (the equivalence runNodeLabelCull relies on).
    r.nodeArray[3].visible = false;
    const filtered = order.filter((i: number) => r.nodeArray[i].visible);
    const oldWay = r.nodeArray
      .map((_: unknown, i: number) => i)
      .filter((i: number) => r.nodeArray[i].visible)
      .sort((a: number, b: number) => sizes[b] - sizes[a]);
    expect(filtered).toEqual(oldWay);
  });

  it('is rebuilt after appendLiveData adds nodes', async () => {
    const r = makeRenderer();
    r.beginLiveGrow();
    await setData(r, [node('a'), node('b')], [link('a', 'b')]);
    r.getLabelOrder();
    r.appendLiveData(
      [node('a'), node('b'), node('c')],
      [link('b', 'c')],
      new Map([['c', { x: 1, y: 1 }]]),
      new Map([['c', '#ff0000']]),
      new Map([['c', 9]]),
      new Map(),
    );
    expect(r.getLabelOrder()).toHaveLength(3);
    expect(r.getLabelOrder()[0]).toBe(2); // size 9 sorts first
  });
});

// ─── Item 5: community centroid dirty flag ──────────────────────────────

describe('community centroid dirty flag', () => {
  it('is set by position updates and consumed on recompute', async () => {
    const r = makeRenderer();
    await setData(r, [node('a'), node('b')], []);
    r.communityAssignments = { a: 0, b: 0 };
    expect(r.centroidsDirty).toBe(true);
    r.centroidsDirty = false;
    r.updatePositions(new Map([['a', { x: 42, y: 42 }]]));
    expect(r.centroidsDirty).toBe(true);
  });

  it('recomputing with unchanged inputs yields identical centroids (skip-safe)', async () => {
    const r = makeRenderer();
    await setData(r, [node('a'), node('b'), node('c')], []);
    r.communityAssignments = { a: 0, b: 0, c: 1 };
    r.recomputeCommunityCentroids();
    const first = new Map(
      [...r.communityCentroids].map(([k, v]: [number, object]) => [
        k,
        { ...v },
      ]),
    );
    r.recomputeCommunityCentroids();
    expect(r.communityCentroids).toEqual(first);
  });

  it('is set by visibility changes (centroids average visible nodes only)', async () => {
    const r = makeRenderer();
    await setData(r, [node('a'), node('b')], []);
    r.centroidsDirty = false;
    r.setNodeVisibility(new Set(['a']));
    expect(r.centroidsDirty).toBe(true);
    expect(r.hiddenNodeCount).toBe(1);
  });
});

// ─── Item 6: live-append fast path ──────────────────────────────────────

describe('appendLiveData / appendLiveEdges fast path', () => {
  const batch = (
    r: Rndr,
    allNodes: GraphNode[],
    allLinks: GraphLink[],
    fresh: string[],
  ) =>
    r.appendLiveData(
      allNodes,
      allLinks,
      new Map(fresh.map((id, i) => [id, { x: 50 + i, y: 50 - i }] as const)),
      new Map(fresh.map((id) => [id, '#00ff00'] as const)),
      new Map(fresh.map((id) => [id, 4] as const)),
      new Map([['CALLS', '#888888']]),
    );

  /** Snapshot everything the fast path writes, then rerun the FULL passes and
   *  assert nothing changes — i.e. the fast path already produced exactly the
   *  slow path's output. */
  function expectFullPassIdempotent(r: Rndr): void {
    const alphas = currentEdgeAlphas(r);
    const edgeIdx = currentEdgeDrawIndex(r);
    const edgeRange = r.edgeGeometry.drawRange.count;
    const nodeIdx = currentNodeDrawIndex(r);
    const nodeRange = r.nodeGeometry.drawRange.count;
    const states = (r.stateArray as Float32Array).slice(0, r.nodeArray.length);

    r.applyNodeStates();
    r.updateEdgeAlpha();

    expect(currentEdgeAlphas(r)).toEqual(alphas);
    expect(currentEdgeDrawIndex(r)).toEqual(edgeIdx);
    expect(r.edgeGeometry.drawRange.count).toBe(edgeRange);
    expect(currentNodeDrawIndex(r)).toEqual(nodeIdx);
    expect(r.nodeGeometry.drawRange.count).toBe(nodeRange);
    expect((r.stateArray as Float32Array).slice(0, r.nodeArray.length)).toEqual(
      states,
    );
  }

  async function makeLiveRenderer(opts?: { camera?: boolean }): Promise<Rndr> {
    const r = makeRenderer(opts);
    r.beginLiveGrow();
    await setData(r, [node('a'), node('b')], [link('a', 'b')]);
    // Prime the node draw index (a fresh geometry is index-less; the first
    // batch after setData intentionally takes the full path).
    r.applyNodeStates();
    return r;
  }

  it('takes the fast path in the idle streaming state and matches the full pass', async () => {
    const r = await makeLiveRenderer();
    expect(r.canFastAppend()).toBe(true);
    expect(r.nodeDrawIndexValid).toBe(true);

    const all = [node('a'), node('b'), node('c'), node('d')];
    const links = [link('a', 'b'), link('b', 'c'), link('c', 'd', 'DEFINES')];
    batch(r, all, links, ['c', 'd']);

    expect(r.nodeArray).toHaveLength(4);
    expect(r.edges).toHaveLength(3);
    // Appended edges got the exact full-path alpha (no highlight → default).
    expect(currentEdgeAlphas(r)).toEqual(oracleEdgeAlphas(r));
    // Node index extended over the appended rows, range widened.
    expect(currentNodeDrawIndex(r)).toEqual([0, 1, 2, 3]);
    expect(r.nodeGeometry.drawRange.count).toBe(4);
    expectFullPassIdempotent(r);
  });

  it('fast path respects edgesEnabled=false exactly like the full pass', async () => {
    const r = await makeLiveRenderer();
    r.setEdgesEnabled(false); // full repaint; still fast-append eligible
    expect(r.canFastAppend()).toBe(true);

    batch(
      r,
      [node('a'), node('b'), node('c')],
      [link('a', 'b'), link('b', 'c')],
      ['c'],
    );
    // All alphas 0 (edges disabled), including the appended row.
    expect(currentEdgeAlphas(r)).toEqual(new Float32Array(4));
    expect(currentEdgeDrawIndex(r)).toEqual([]); // nothing drawable
    expectFullPassIdempotent(r);
  });

  it('fast path respects tree-mode chord fading exactly like the full pass', async () => {
    const r = await makeLiveRenderer();
    r.currentLayoutMode = 'tree';
    r.updateEdgeAlpha(); // repaint existing rows under the new mode

    batch(
      r,
      [node('a'), node('b'), node('c'), node('d')],
      [link('a', 'b'), link('b', 'c'), link('c', 'd', 'DEFINES')],
      ['c', 'd'],
    );
    const a = currentEdgeAlphas(r);
    // (Math.fround: the buffer stores float32.)
    expect(a[2]).toBe(Math.fround(EDGE_OPACITY_DEFAULT * 0.1)); // CALLS chord
    expect(a[4]).toBe(Math.fround(EDGE_OPACITY_DEFAULT)); // DEFINES skeleton
    expect(currentEdgeAlphas(r)).toEqual(oracleEdgeAlphas(r));
    expectFullPassIdempotent(r);
  });

  it('extends the culled edge index in place while the camera is unchanged', async () => {
    const r = await makeLiveRenderer({ camera: true });
    r.bp = { ...r.bp, edgeViewportCulling: true };
    r.updateEdgeAlpha(); // culled rebuild + camera snapshot
    expect(r.edgeCullCameraUnchanged()).toBe(true);

    // Two new far-off-screen nodes connected only to EACH OTHER (no edge to
    // the on-screen frontier, so scheduleGrowIn keeps them at their own
    // off-screen spot rather than parking them on a visible parent — the
    // culling inputs stay stable for the idempotence check below).
    r.appendLiveData(
      [node('a'), node('b'), node('c'), node('d')],
      [link('a', 'b'), link('c', 'd')],
      new Map([
        ['c', { x: 6000, y: 0 }],
        ['d', { x: 6100, y: 0 }],
      ]),
      new Map([
        ['c', '#00ff00'],
        ['d', '#00ff00'],
      ]),
      new Map([
        ['c', 4],
        ['d', 4],
      ]),
      new Map([['CALLS', '#888888']]),
    );
    expect(currentEdgeDrawIndex(r)).toEqual(oracleEdgeDrawIndex(r));
    // a-b kept (both on screen), c-d culled (both ends off).
    expect(currentEdgeDrawIndex(r)).toEqual([0, 1]);
    expectFullPassIdempotent(r);
  });

  it('falls back to a full culled rebuild when the camera moved since the last cull', async () => {
    const r = await makeLiveRenderer({ camera: true });
    r.bp = { ...r.bp, edgeViewportCulling: true };
    r.updateEdgeAlpha();
    // Move the camera → retained rows' in-view decisions are stale.
    r.camera.position.x += 300;
    r.camera.updateMatrixWorld();
    expect(r.edgeCullCameraUnchanged()).toBe(false);

    batch(
      r,
      [node('a'), node('b'), node('c')],
      [link('a', 'b'), link('b', 'c')],
      ['c'],
    );
    // The fallback rebuilt everything against the CURRENT camera — identical
    // to the slow path's output for the same state.
    expect(currentEdgeDrawIndex(r)).toEqual(oracleEdgeDrawIndex(r));
    expectFullPassIdempotent(r);
  });

  it('uses the full path whenever a disqualifying state is active', async () => {
    const r = await makeLiveRenderer();

    r.setHighlight(new Set(['a']), new Set(['a-b']));
    expect(r.canFastAppend()).toBe(false);
    batch(
      r,
      [node('a'), node('b'), node('c')],
      [link('a', 'b'), link('b', 'c')],
      ['c'],
    );
    // Full path ran: appended edge is dimmed (highlight active), not default.
    expect(currentEdgeAlphas(r)).toEqual(oracleEdgeAlphas(r));
    expect(currentEdgeAlphas(r)[2]).toBe(Math.fround(EDGE_OPACITY_DIMMED));

    r.setHighlight(new Set(), new Set());
    expect(r.canFastAppend()).toBe(true);

    r.setHiddenLinkTypes(new Set(['IMPORTS']));
    expect(r.canFastAppend()).toBe(false);
    r.setHiddenLinkTypes(new Set());

    r.setNodeVisibility(new Set(['a', 'b'])); // hides c
    expect(r.canFastAppend()).toBe(false);
    r.setNodeVisibility(new Set(['a', 'b', 'c']));
    expect(r.canFastAppend()).toBe(true);

    r.traversalPendingEdges.add('a-b');
    expect(r.canFastAppend()).toBe(false);
    r.traversalPendingEdges.clear();

    r.lodEnabled = true;
    r.superList = [{ cid: 0, x: 0, y: 0, z: 0, radius: 1, count: 2 }];
    expect(r.canFastAppend()).toBe(false);
  });

  it('survives edge-buffer capacity growth mid-append', async () => {
    const r = makeRenderer();
    r.beginLiveGrow();
    await setData(r, [node('a'), node('b')], [link('a', 'b')]);
    r.applyNodeStates();
    // Force tiny capacity so the append must grow + recreate geometry.
    r.edgeCapacity = 1;

    const all = [node('a'), node('b'), node('c'), node('d')];
    batch(r, all, [link('a', 'b'), link('b', 'c'), link('c', 'd')], ['c', 'd']);
    expect(r.edges).toHaveLength(3);
    expect(currentEdgeAlphas(r)).toEqual(oracleEdgeAlphas(r));
    // The regrown geometry carries the full draw index (old + appended rows).
    expect(currentEdgeDrawIndex(r)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.edgeGeometry.getIndex()!.array).toBe(r.edgeDrawIndex);
    expect(r.edgeGeometry.drawRange.count).toBe(6);
    expectFullPassIdempotent(r);
  });

  it('falls back to a full node repack after node-buffer growth (fresh index-less geometry)', async () => {
    const r = makeRenderer();
    r.beginLiveGrow();
    await setData(r, [node('a'), node('b')], [link('a', 'b')]);
    r.applyNodeStates();
    r.nodeCapacity = 2; // force growNodeBuffers on the next append
    r.posArray = (r.posArray as Float32Array).slice(0, 6);
    r.layoutPos = (r.layoutPos as Float32Array).slice(0, 6);
    r.colorArray = (r.colorArray as Float32Array).slice(0, 6);
    r.pickColorArray = (r.pickColorArray as Float32Array).slice(0, 6);
    r.sizeArray = (r.sizeArray as Float32Array).slice(0, 2);
    r.stateArray = (r.stateArray as Float32Array).slice(0, 2);

    batch(
      r,
      [node('a'), node('b'), node('c')],
      [link('a', 'b'), link('b', 'c')],
      ['c'],
    );
    expect(r.nodeArray).toHaveLength(3);
    // growNodeBuffers rebuilt the geometry; either path must leave the draw
    // index covering all (visible) nodes.
    expect(currentNodeDrawIndex(r)).toEqual([0, 1, 2]);
    expect(r.nodeGeometry.drawRange.count).toBe(3);
    expectFullPassIdempotent(r);
  });

  it('multiple consecutive fast batches accumulate correctly', async () => {
    const r = await makeLiveRenderer();
    let all = [node('a'), node('b')];
    let links = [link('a', 'b')];
    for (let k = 0; k < 5; k++) {
      const id = `n${k}`;
      all = [...all, node(id)];
      links = [...links, link(k === 0 ? 'b' : `n${k - 1}`, id)];
      batch(r, all, links, [id]);
    }
    expect(r.nodeArray).toHaveLength(7);
    expect(r.edges).toHaveLength(6);
    expect(currentNodeDrawIndex(r)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(currentEdgeAlphas(r)).toEqual(oracleEdgeAlphas(r));
    expect(currentEdgeDrawIndex(r)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expectFullPassIdempotent(r);
  });
});
