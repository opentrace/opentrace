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
 * Persistent Web Worker for the Three.js renderer's d3-force-3d layout.
 *
 * Sibling of pixiLayoutWorker, but runs the simulation in 2 OR 3 dimensions
 * (d3-force-3d) and streams stride-3 position snapshots [x,y,z, ...] so the
 * renderer gets genuine z-coordinates in 3D mode. Switching dimensions
 * (`set-dimensions`) rebuilds the simulation in place, preserving x/y and
 * seeding/zeroing z. Otherwise the message protocol matches pixiLayoutWorker.
 */

import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
  forceZ,
  forceRadial,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force-3d';

interface SimNode extends SimulationNodeDatum {
  id: string;
  z?: number | null;
  vz?: number | null;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
  /** Link-force weight: 1 = structural (DEFINES, builds the tree/flower),
   *  <1 = relational (calls/imports — a weak pull that shortens those edges
   *  and forms logical branches without collapsing the structure). */
  w?: number;
}

export type LayoutMode = 'spread' | 'compact' | 'tree';

export type Worker3DInMessage =
  | {
      type: 'init';
      nodeIds: string[];
      links: { source: string; target: string; w?: number }[];
      communities?: Record<string, number>;
      dimensions?: 2 | 3;
      config: {
        chargeStrength: number;
        linkDistance: number;
        centerStrength?: number;
        barnesHutTheta?: number;
        dragTheta?: number;
        layoutMode?: LayoutMode;
      };
    }
  | {
      type: 'add-nodes';
      nodeIds: string[];
      links: { source: string; target: string; w?: number }[];
      communities?: Record<string, number>;
    }
  | {
      type: 'update-config';
      chargeStrength?: number;
      linkDistance?: number;
      centerStrength?: number;
    }
  | {
      type: 'update-compact-config';
      radialStrength?: number;
      communityPull?: number;
      centeringStrength?: number;
      radiusScale?: number;
    }
  | { type: 'set-layout-mode'; mode: LayoutMode }
  | { type: 'set-dimensions'; dimensions: 2 | 3 }
  | { type: 'fix-node'; nodeId: string; x: number; y: number }
  | { type: 'unfix-node'; nodeId: string }
  | { type: 'reheat' }
  | { type: 'stop' }
  | { type: 'start' }
  | { type: 'boost-theta' }
  | { type: 'reset-theta' }
  | { type: 'set-community-gravity'; enabled: boolean; strength?: number }
  | { type: 'set-communities'; communities: Record<string, number> };

export type Worker3DOutMessage =
  | { type: 'positions'; buffer: Float64Array }
  | { type: 'settled' }
  | { type: 'ready'; buffer: Float64Array };

// ─── State ────────────────────────────────────────────────────────────────

let sim: Simulation<SimNode, SimLink> | null = null;
let simNodes: SimNode[] = [];
let nodeIdToIndex: Map<string, number> = new Map();
let communities: Record<string, number> | undefined;
let currentMode: LayoutMode = 'spread';
let nDim: 2 | 3 = 2;
let defaultTheta = 0.9;
let dragTheta = 1.5;
let settled = false;
let cachedLinks: SimLink[] = [];
let cachedConfig: {
  chargeStrength: number;
  linkDistance: number;
  centerStrength?: number;
} | null = null;
const compactConfig = {
  radialStrength: 0.08,
  communityPull: 0.1,
  centeringStrength: 0.05,
  radiusScale: 16,
};
let streaming = false;
let streamInterval: ReturnType<typeof setInterval> | null = null;

// Tree mode: the deterministic radial-tree positions (stride 3), captured by
// computeRadialTree(). The tree sim anchors each node here so the layout stays
// the clean mind-map starburst rather than relaxing into a ball.
let treeSeed = new Float64Array(0);

const STREAM_INTERVAL = 66; // ~15fps
// Declare the layout settled once alpha drops below this. The long tail from
// ~0.02 → 0.005 is ~50 extra ticks of sub-pixel drift that's invisible but
// costs seconds of "still loading" wall-time on a 12k-node 3D sim. Stopping at
// 0.02 cuts that imperceptible tail without changing the visible layout.
const SETTLE_ALPHA = 0.02;
// Barnes-Hut accuracy/speed tradeoff for the charge force. The charge
// (forceManyBody) is ~99% of every tick's CPU on a large 3D sim — at the
// breakpoint default (0.9) it's ~60ms/tick for 12k nodes; at 1.5 it's ~21ms
// (~3× faster) with no visible change to the cluster structure. 1.5 is the
// same accuracy the renderer already uses during node drags (`dragTheta`), so
// the layout was always being computed at this theta interactively. We floor
// the requested theta here rather than mutating the shared breakpoints (those
// also feed the Pixi renderer, which we don't want to perturb).
const FAST_BARNES_HUT_THETA = 1.5;
// Tree mode is a DETERMINISTIC radial mind-map: nodes are anchored to their
// computeRadialTree() positions (root/repo at centre, folders branching out in
// clean spokes, leaves on the rim) so it reads as an organised starburst, not a
// force-relaxed ball. Relational (call/import) edges are drawn over it but do
// NOT pull nodes around (that would distort the tidy tree) — they stay visible,
// and a few are long, which is accepted. Connectivity-aware angular ordering
// (see computeRadialTree) keeps call-related branches near each other so most
// relational chords are still short.
//
// Anchor strength: how firmly each node is held at its radial position. High so
// the structure stays crisp; a little charge still declutters local overlaps.
const TREE_ANCHOR_STRENGTH = 0.35;

// ─── Helpers ────────────────────────────────────────────────────────────

function buildPositionBuffer(): Float64Array {
  // Stride 3 — [x,y,z]. z is 0 in 2D mode.
  const buf = new Float64Array(simNodes.length * 3);
  for (let i = 0; i < simNodes.length; i++) {
    buf[i * 3] = simNodes[i].x ?? 0;
    buf[i * 3 + 1] = simNodes[i].y ?? 0;
    buf[i * 3 + 2] = simNodes[i].z ?? 0;
  }
  return buf;
}

function postPositions(): void {
  const buf = buildPositionBuffer();
  (self as unknown as Worker).postMessage(
    { type: 'positions', buffer: buf } satisfies Worker3DOutMessage,
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
      postPositions();
      stopStreaming();
      settled = true;
      (self as unknown as Worker).postMessage({
        type: 'settled',
      } satisfies Worker3DOutMessage);
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

// ─── Simulation builder ─────────────────────────────────────────────────

/**
 * Build a custom force that pulls each node toward the centroid of its
 * community every tick. This is what gives the graph its "flower" structure —
 * communities condense into petals while charge repulsion keeps the petals
 * apart. Used in BOTH layout modes so communities always shape the layout
 * (the spread default would otherwise be a pure-force hairball). Single-member
 * communities are skipped. `getStrength` is read each tick so the slider
 * applies live.
 */
function makeCommunityForce(
  s: Simulation<SimNode, SimLink>,
  nodes: SimNode[],
  comms: Record<string, number>,
  getStrength: () => number,
): Parameters<typeof s.force>[1] {
  const force = () => {
    const is3D = nDim === 3;
    const cx = new Map<number, number>();
    const cy = new Map<number, number>();
    const cz = new Map<number, number>();
    const count = new Map<number, number>();
    for (const node of nodes) {
      const c = comms[node.id];
      if (c === undefined) continue;
      cx.set(c, (cx.get(c) ?? 0) + (node.x ?? 0));
      cy.set(c, (cy.get(c) ?? 0) + (node.y ?? 0));
      if (is3D) cz.set(c, (cz.get(c) ?? 0) + (node.z ?? 0));
      count.set(c, (count.get(c) ?? 0) + 1);
    }
    const alpha = s.alpha();
    const strength = getStrength();
    for (const node of nodes) {
      const c = comms[node.id];
      if (c === undefined) continue;
      const n = count.get(c)!;
      if (n < 2) continue;
      const targetX = cx.get(c)! / n;
      const targetY = cy.get(c)! / n;
      node.vx = (node.vx ?? 0) + (targetX - (node.x ?? 0)) * strength * alpha;
      node.vy = (node.vy ?? 0) + (targetY - (node.y ?? 0)) * strength * alpha;
      if (is3D) {
        const targetZ = cz.get(c)! / n;
        node.vz = (node.vz ?? 0) + (targetZ - (node.z ?? 0)) * strength * alpha;
      }
    }
  };
  (force as unknown as { initialize: (n: SimNode[]) => void }).initialize =
    () => {};
  return force as unknown as Parameters<typeof s.force>[1];
}

/**
 * Tree mode anchor force. Pulls each node toward its deterministic radial
 * position (treeSeed), so the layout holds the clean mind-map starburst. A
 * light charge force runs alongside to push apart any locally-overlapping
 * siblings without scattering the structure. By index — treeSeed is built in
 * the same simNodes order.
 */
function makeTreeAnchorForce(
  s: Simulation<SimNode, SimLink>,
  nodes: SimNode[],
  getStrength: () => number,
): Parameters<typeof s.force>[1] {
  const force = () => {
    if (treeSeed.length < nodes.length * 3) return;
    const is3D = nDim === 3;
    const alpha = s.alpha();
    const k = getStrength() * alpha;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      node.vx = (node.vx ?? 0) + (treeSeed[i * 3] - (node.x ?? 0)) * k;
      node.vy = (node.vy ?? 0) + (treeSeed[i * 3 + 1] - (node.y ?? 0)) * k;
      if (is3D)
        node.vz = (node.vz ?? 0) + (treeSeed[i * 3 + 2] - (node.z ?? 0)) * k;
    }
  };
  (force as unknown as { initialize: (n: SimNode[]) => void }).initialize =
    () => {};
  return force as unknown as Parameters<typeof s.force>[1];
}

function buildSimulation(
  nodes: SimNode[],
  links: SimLink[],
  config: {
    chargeStrength: number;
    linkDistance: number;
    centerStrength?: number;
  },
  mode: LayoutMode,
): Simulation<SimNode, SimLink> {
  const s = forceSimulation<SimNode, SimLink>(nodes, nDim);

  if (mode === 'tree') {
    // Deterministic radial mind-map. Each node is ANCHORED to its
    // computeRadialTree() position (root/repo centre → folders branch out in
    // clean spokes → leaves on the rim), so the layout stays an organised
    // starburst rather than relaxing into a ball. A light charge declutters
    // locally-overlapping siblings; firm DEFINES links keep parent→child
    // spacing crisp along the spokes. Relational (call/import) links exert NO
    // pull — they're drawn over the tree (some long, accepted) but must not
    // distort it. See TREE_ANCHOR_STRENGTH.
    s.force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d: SimNode) => d.id)
        .distance(config.linkDistance)
        // Only the containment backbone constrains spacing; relational links
        // are inert in the layout (strength 0) so the tree stays tidy.
        .strength((l: SimLink) => ((l.w ?? 1) >= 1 ? 0.6 : 0)),
    ).force(
      'charge',
      // Gentle repulsion — just enough to separate overlapping siblings without
      // fighting the anchor and fanning the tree into a ball.
      forceManyBody()
        .strength(config.chargeStrength * 0.4)
        .theta(defaultTheta),
    );
    s.force(
      'treeAnchor',
      makeTreeAnchorForce(s, nodes, () => TREE_ANCHOR_STRENGTH),
    );
    s.alphaDecay(0.03).velocityDecay(0.5);
    return s;
  }

  // Degree over the link set, so structural links keep d3's default
  // degree-normalized strength (1/min-degree) — high-degree hubs don't get
  // over-pulled. Relational links then scale that by their weight `w`.
  const linkDeg = new Map<string, number>();
  const endId = (v: string | SimNode) => (typeof v === 'string' ? v : v.id);
  for (const l of links) {
    const a = endId(l.source);
    const b = endId(l.target);
    linkDeg.set(a, (linkDeg.get(a) ?? 0) + 1);
    linkDeg.set(b, (linkDeg.get(b) ?? 0) + 1);
  }
  const linkForce = forceLink<SimNode, SimLink>(links)
    .id((d: SimNode) => d.id)
    .distance(mode === 'compact' ? 40 : config.linkDistance);
  // Per-link strength = weight × base. Compact uses a flat base (tight ball);
  // spread uses the degree-normalized base. Either way, relational links
  // (w < 1) pull weakly so they shorten without flattening the structure.
  if (mode === 'compact') {
    linkForce.strength((l: SimLink) => 0.2 * (l.w ?? 1));
  } else {
    linkForce.strength((l: SimLink) => {
      const d = Math.min(
        linkDeg.get(endId(l.source)) ?? 1,
        linkDeg.get(endId(l.target)) ?? 1,
      );
      return (l.w ?? 1) / Math.max(1, d);
    });
  }
  s.force('link', linkForce);

  if (mode === 'compact') {
    const compactRadius = Math.sqrt(nodes.length) * compactConfig.radiusScale;
    s.force(
      'charge',
      forceManyBody().strength(config.chargeStrength).theta(defaultTheta),
    )
      .force('center', forceCenter(0, 0, 0).strength(0.3))
      .force('x', forceX<SimNode>(0).strength(compactConfig.centeringStrength))
      .force('y', forceY<SimNode>(0).strength(compactConfig.centeringStrength))
      .force(
        'radial',
        forceRadial(0, 0, 0).strength(compactConfig.radialStrength),
      )
      // Cool fast so the layout stops churning / streaming sooner — the long
      // settle was a big chunk of perceived load lag on the 3D sim.
      .alphaDecay(0.035)
      .velocityDecay(0.45);

    // Contain force — clamp nodes inside a circle (2D) or sphere (3D) so
    // compact stays a tight ball. In 3D this fills a volume rather than a slab.
    const containForce = () => {
      const is3D = nDim === 3;
      for (const node of nodes) {
        const x = node.x ?? 0;
        const y = node.y ?? 0;
        const z = node.z ?? 0;
        const dist = is3D
          ? Math.sqrt(x * x + y * y + z * z)
          : Math.sqrt(x * x + y * y);
        if (dist > compactRadius) {
          const scale = compactRadius / dist;
          node.x = x * scale;
          node.y = y * scale;
          if (is3D) node.z = z * scale;
        }
      }
    };
    (
      containForce as unknown as { initialize: (n: SimNode[]) => void }
    ).initialize = () => {};
    s.force(
      'contain',
      containForce as unknown as Parameters<typeof s.force>[1],
    );

    if (communities && Object.keys(communities).length > 0) {
      s.force(
        'communityGravity',
        makeCommunityForce(
          s,
          nodes,
          communities,
          () => compactConfig.communityPull,
        ),
      );
    }
  } else {
    // Spread — force-directed, but with community clustering so it reads as a
    // structured "flower" instead of a hairball. Stronger charge separates the
    // petals; the community force condenses each one.
    s.force(
      'charge',
      forceManyBody().strength(config.chargeStrength).theta(defaultTheta),
    )
      // forceCenter only re-centers the centroid (a translation) — it does NOT
      // pull nodes inward. Keep it to anchor the graph, but the user-facing
      // "Center pull" is an actual attraction toward the origin via x/y(/z).
      .force('center', forceCenter(0, 0, 0).strength(1))
      .force(
        'centerX',
        forceX<SimNode>(0).strength(spreadCenterPull(config.centerStrength)),
      )
      .force(
        'centerY',
        forceY<SimNode>(0).strength(spreadCenterPull(config.centerStrength)),
      );
    if (nDim === 3) {
      s.force(
        'centerZ',
        forceZ<SimNode>(0).strength(spreadCenterPull(config.centerStrength)),
      );
    }
    if (communities && Object.keys(communities).length > 0) {
      s.force(
        'communityGravity',
        makeCommunityForce(s, nodes, communities, () => SPREAD_COMMUNITY_PULL),
      );
    }
    // Cool faster than the d3 default (0.0228) so the force-directed layout
    // settles in fewer ticks — the slow convergence was the bulk of perceived
    // load time on a 12k-node 3D sim. velocityDecay matches d3's default.
    s.alphaDecay(0.035).velocityDecay(0.4);
  }

  return s;
}

/** Map the 0–1 "Center pull" setting to an attraction strength toward the
 *  origin. Scaled so the default (~0.3) is a gentle pull and 1.0 is firm
 *  without collapsing the graph. */
function spreadCenterPull(centerStrength: number | undefined): number {
  return (centerStrength ?? 0.3) * 0.25;
}

/** Community-clustering strength in spread mode. Kept gentle so the DEFINES
 *  hierarchy spreads into branches (tree/brainstem look) rather than each
 *  community condensing into a tight petal/ball — communities still tint and
 *  loosely group, but the structural tree dominates the shape. */
const SPREAD_COMMUNITY_PULL = 0.08;

/** Rebuild keeping current positions; seed z when entering 3D, zero it in 2D. */
function rebuild(alpha: number): void {
  if (!cachedConfig) return;
  sim?.stop();
  if (nDim === 3) {
    // Seed z with a spread comparable to the current x/y extent so 3D fills a
    // real volume instead of staying a near-flat plane (the layout we're
    // morphing from is 2D, i.e. all z≈0).
    let ext = 0;
    for (const n of simNodes) {
      ext = Math.max(ext, Math.abs(n.x ?? 0), Math.abs(n.y ?? 0));
    }
    ext = ext || 500;
    for (const n of simNodes) {
      n.z = (Math.random() - 0.5) * ext;
    }
  } else {
    for (const n of simNodes) {
      n.z = 0;
      n.vz = 0;
      n.fz = null;
    }
  }
  sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
  sim.alpha(alpha).restart();
  settled = false;
  startStreaming();
}

// ─── Radial tree layout ─────────────────────────────────────────────────
//
// Deterministic hierarchical layout (NOT a force sim). The structural edges
// (w >= 1, i.e. the DEFINES containment hierarchy: Repository → Directory →
// File → Class → Function) form a tree; we lay it out radially — root at the
// centre, each depth on its own ring, every subtree given an angular wedge
// sized by its leaf count. This is what makes the graph read as an organised
// tree/flower instead of a force-relaxed blob. Relational edges (calls/imports,
// w < 1) don't shape it — they're drawn as chords over the tree.

const TREE_LEAF_ARC = 26; // target world-units between adjacent outer leaves
const TREE_MIN_RADIUS = 220;

function endId(v: string | SimNode): string {
  return typeof v === 'string' ? v : v.id;
}

function computeRadialTree(): void {
  if (simNodes.length === 0) return;
  const ids = new Set(simNodes.map((s) => s.id));

  // parent → children from structural edges; first parent wins ⇒ a forest.
  const children = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const l of cachedLinks) {
    if ((l.w ?? 1) < 1) continue; // structural (containment) only
    const p = endId(l.source);
    const c = endId(l.target);
    if (p === c || !ids.has(p) || !ids.has(c) || parentOf.has(c)) continue;
    parentOf.set(c, p);
    let arr = children.get(p);
    if (!arr) children.set(p, (arr = []));
    arr.push(c);
  }

  // Primary root = the root whose subtree covers the most nodes (the repo,
  // not a stray dependency). Other roots / cycle remnants go to an outer ring.
  const roots = simNodes.map((s) => s.id).filter((id) => !parentOf.has(id));
  const subtreeSize = (root: string): number => {
    let cnt = 0;
    const stack = [root];
    const seenLocal = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seenLocal.has(id)) continue;
      seenLocal.add(id);
      cnt++;
      for (const c of children.get(id) ?? []) stack.push(c);
    }
    return cnt;
  };
  let primary = roots[0] ?? simNodes[0].id;
  let bestSize = -1;
  for (const r of roots) {
    const sz = subtreeSize(r);
    if (sz > bestSize) {
      bestSize = sz;
      primary = r;
    }
  }

  // Iterative post-order over the primary tree: per node compute depth and a
  // leaf-weight (subtree leaf count, used to size each subtree's share of the
  // sphere in 3D). The leaf-order ANGLE is derived separately below, after the
  // children of each node are reordered for connectivity (see buildAngles).
  const depth = new Map<string, number>();
  const leafWeight = new Map<string, number>();
  const seen = new Set<string>([primary]);
  let leafN = 0;
  let maxDepth = 0;
  const stack: { id: string; d: number; i: number }[] = [
    { id: primary, d: 0, i: 0 },
  ];
  while (stack.length) {
    const f = stack[stack.length - 1];
    const kids = children.get(f.id) ?? [];
    if (f.i === 0) {
      depth.set(f.id, f.d);
      if (f.d > maxDepth) maxDepth = f.d;
    }
    if (f.i < kids.length) {
      const k = kids[f.i++];
      if (seen.has(k)) continue;
      seen.add(k);
      stack.push({ id: k, d: f.d + 1, i: 0 });
    } else {
      if (kids.length === 0) {
        leafN++;
        leafWeight.set(f.id, 1);
      } else {
        let w = 0;
        for (const k of kids) w += leafWeight.get(k) ?? 1;
        leafWeight.set(f.id, Math.max(1, w));
      }
      stack.pop();
    }
  }

  // ── Connectivity-aware angular ordering ──────────────────────────────────
  // Order each parent's child subtrees so branches that call/import each other
  // sit angularly ADJACENT, instead of in structural-insertion order. This is
  // what shortens the cross-branch relational edges (the long "slashes" that
  // grow with repo size) — we only permute SIBLINGS, so the containment
  // grouping is untouched. Barycenter heuristic, iterated to convergence: each
  // pass nudges every subtree toward the mean angle of what it connects to,
  // then re-derives angles. Helps BOTH the 2D sunburst (leaf-order → angle) and
  // the 3D sphere (the slice-and-dice walks children in array order).
  const relAdj = new Map<string, string[]>();
  for (const l of cachedLinks) {
    if ((l.w ?? 1) >= 1) continue; // relational (calls/imports) only
    const a = endId(l.source);
    const b = endId(l.target);
    if (a === b || !depth.has(a) || !depth.has(b)) continue;
    (relAdj.get(a) ?? relAdj.set(a, []).get(a)!).push(b);
    (relAdj.get(b) ?? relAdj.set(b, []).get(b)!).push(a);
  }

  // Linear angular coordinate (leaf order) for the CURRENT child ordering:
  // leaves get sequential slots, internal nodes the mean of their children.
  const buildAngles = (): Map<string, number> => {
    const angle = new Map<string, number>();
    let ln = 0;
    const seenA = new Set<string>([primary]);
    const st: { id: string; i: number }[] = [{ id: primary, i: 0 }];
    while (st.length) {
      const f = st[st.length - 1];
      const kids = children.get(f.id) ?? [];
      if (f.i < kids.length) {
        const k = kids[f.i++];
        if (seenA.has(k)) continue;
        seenA.add(k);
        st.push({ id: k, i: 0 });
      } else {
        if (kids.length === 0) {
          angle.set(f.id, ln + 0.5);
          ln++;
        } else {
          let sum = 0;
          let cnt = 0;
          for (const k of kids) {
            const a = angle.get(k);
            if (a !== undefined) {
              sum += a;
              cnt++;
            }
          }
          angle.set(f.id, cnt ? sum / cnt : ln);
        }
        st.pop();
      }
    }
    return angle;
  };

  // Reorder every parent's children by the barycenter of where their subtree's
  // relational edges point. Subtrees with no relations keep their current spot.
  const reorderByBarycenter = (angle: Map<string, number>): void => {
    const sumSelf = new Map<string, number>();
    const cntSelf = new Map<string, number>();
    for (const id of depth.keys()) {
      let s = 0;
      let c = 0;
      for (const v of relAdj.get(id) ?? []) {
        const a = angle.get(v);
        if (a !== undefined) {
          s += a;
          c++;
        }
      }
      sumSelf.set(id, s);
      cntSelf.set(id, c);
    }
    // Aggregate self + descendants (post-order) → per-subtree relational mean.
    const accSum = new Map<string, number>();
    const accCnt = new Map<string, number>();
    const seenP = new Set<string>([primary]);
    const st: { id: string; i: number }[] = [{ id: primary, i: 0 }];
    while (st.length) {
      const f = st[st.length - 1];
      const kids = children.get(f.id) ?? [];
      if (f.i < kids.length) {
        const k = kids[f.i++];
        if (seenP.has(k)) continue;
        seenP.add(k);
        st.push({ id: k, i: 0 });
      } else {
        let s = sumSelf.get(f.id) ?? 0;
        let c = cntSelf.get(f.id) ?? 0;
        for (const k of kids) {
          s += accSum.get(k) ?? 0;
          c += accCnt.get(k) ?? 0;
        }
        accSum.set(f.id, s);
        accCnt.set(f.id, c);
        st.pop();
      }
    }
    const key = (id: string): number => {
      const c = accCnt.get(id) ?? 0;
      return c > 0 ? accSum.get(id)! / c : (angle.get(id) ?? 0);
    };
    for (const kids of children.values()) {
      if (kids.length > 1) kids.sort((a, b) => key(a) - key(b));
    }
  };

  const ORDER_PASSES = 4;
  for (let i = 0; i < ORDER_PASSES; i++) reorderByBarycenter(buildAngles());
  const angleRaw = buildAngles();

  const totalLeaves = Math.max(1, leafN);
  const is3D = nDim === 3;
  // Outer radius the rim leaves sit at. 2D: leaves lie on one circle, so the
  // circumference (leaves × arc) sets it — a proper wide sunburst/mind-map. 3D:
  // leaves spread over a sphere, so the same count fits in far less radius
  // (area 4πR² ≈ leaves × arc²); a separation factor keeps shells legible
  // rather than a tight ball. Using the 2D formula in 3D blows it up ~20×.
  const outerR = is3D
    ? Math.max(
        TREE_MIN_RADIUS,
        TREE_LEAF_ARC * Math.sqrt(totalLeaves / (4 * Math.PI)) * 3,
      )
    : Math.max(TREE_MIN_RADIUS, (totalLeaves * TREE_LEAF_ARC) / (2 * Math.PI));
  const ring = outerR / Math.max(1, maxDepth);

  // Shell radius for a given containment depth. Linear up to the 90th-percentile
  // depth, then compressed — so the rare very-deep chains (nested test fixtures,
  // long call paths) ease toward the rim instead of shooting far past the dense
  // canopy as lone "floating" dots. Still monotonic (no stacking).
  const depthCounts: number[] = [];
  for (const d of depth.values()) depthCounts[d] = (depthCounts[d] ?? 0) + 1;
  let knee = maxDepth;
  let cum = 0;
  const total = Math.max(1, depth.size);
  for (let d = 0; d <= maxDepth; d++) {
    cum += depthCounts[d] ?? 0;
    if (cum >= total * 0.9) {
      knee = d;
      break;
    }
  }
  const SHELL_COMPRESS = 0.35; // each level beyond the knee adds 35% of a ring
  const effDepth = (d: number) =>
    d <= knee ? d : knee + (d - knee) * SHELL_COMPRESS;
  const shellDenom = Math.max(1, effDepth(maxDepth));
  const shellRadius = (d: number) => (effDepth(d) / shellDenom) * outerR;

  const setPos = (s: SimNode, x: number, y: number, z: number) => {
    s.x = x;
    s.y = y;
    s.z = z;
    s.vx = 0;
    s.vy = 0;
    s.vz = 0;
    s.fx = null;
    s.fy = null;
    s.fz = null;
  };
  const nodeAt = (id: string): SimNode | undefined => {
    const i = nodeIdToIndex.get(id);
    return i === undefined ? undefined : simNodes[i];
  };
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));

  if (is3D) {
    // Concentric-shell sphere. Radius = containment depth (repo at the centre →
    // folders → files → functions on successive shells). Angle = containment:
    // each subtree owns an equal-area patch of the sphere and a child stays
    // inside its parent's patch, so a function sits in its file's wedge and
    // parent→child edges are short. The sibling ORDER within each patch is set
    // by connectivity (relational barycenter, computed above), so call-related
    // branches sit adjacent and most call edges stay local too.
    type Region = { p0: number; p1: number; u0: number; u1: number };
    const FULL: Region = { p0: 0, p1: Math.PI * 2, u0: -1, u1: 1 };

    // Split a region among weighted siblings (equal-area: φ spans ~π× the u
    // band, so we cut the longer axis for squarish patches). Order preserved.
    const splitRegion = <T>(
      sibs: T[],
      reg: Region,
      weightOf: (s: T) => number,
    ): { item: T; reg: Region }[] => {
      let tw = 0;
      for (const k of sibs) tw += weightOf(k) || 1;
      tw = tw || 1;
      const res: { item: T; reg: Region }[] = [];
      const pSpan = reg.p1 - reg.p0;
      const uSpan = reg.u1 - reg.u0;
      if (pSpan >= uSpan * Math.PI) {
        let p = reg.p0;
        for (const k of sibs) {
          const p1 = p + ((weightOf(k) || 1) / tw) * pSpan;
          res.push({ item: k, reg: { p0: p, p1, u0: reg.u0, u1: reg.u1 } });
          p = p1;
        }
      } else {
        let uu = reg.u0;
        for (const k of sibs) {
          const u1 = uu + ((weightOf(k) || 1) / tw) * uSpan;
          res.push({ item: k, reg: { p0: reg.p0, p1: reg.p1, u0: uu, u1 } });
          uu = u1;
        }
      }
      return res;
    };

    // Place a containment forest within a region: recursively slice the region
    // by subtree leaf-weight (a child stays inside its parent's patch → folder
    // structure preserved), radius = containment depth → concentric shells.
    const placeForest = (
      roots: string[],
      region: Region,
      childrenOf: (id: string) => string[],
      leafW: (id: string) => number,
    ): void => {
      const stack = splitRegion(roots, region, leafW).map((e) => ({
        id: e.item,
        reg: e.reg,
      }));
      const seenLocal = new Set<string>();
      while (stack.length) {
        const { id, reg } = stack.pop()!;
        if (seenLocal.has(id)) continue;
        seenLocal.add(id);
        const node = nodeAt(id);
        const d = depth.get(id);
        if (node && d !== undefined) {
          const phi = (reg.p0 + reg.p1) / 2;
          const u = (reg.u0 + reg.u1) / 2;
          const lat = Math.sqrt(Math.max(0, 1 - u * u));
          const radius = shellRadius(d);
          setPos(
            node,
            lat * Math.cos(phi) * radius,
            lat * Math.sin(phi) * radius,
            u * radius,
          );
        }
        const kids = childrenOf(id);
        if (kids.length === 0) continue;
        // If every child is a leaf (e.g. a file's functions — all same depth),
        // splitting one axis lines them up. Instead fan them into a 2D sunflower
        // disc filling the patch → a cone-shaped tuft at the branch tip.
        const allLeaves = kids.every((k) => childrenOf(k).length === 0);
        if (allLeaves && kids.length > 1) {
          // Fan the leaves into a round, flat disc in the tangent plane at the
          // patch centre — a true cone-tip pointing outward, round regardless of
          // how thin the patch is. Sized to fit the patch so tufts don't collide.
          const pc = (reg.p0 + reg.p1) / 2;
          const uc = (reg.u0 + reg.u1) / 2;
          const pHalf = (reg.p1 - reg.p0) / 2;
          const uHalf = (reg.u1 - reg.u0) / 2;
          const latc = Math.sqrt(Math.max(1e-6, 1 - uc * uc));
          // Outward unit direction at the patch centre + two tangent unit axes.
          const dx = latc * Math.cos(pc);
          const dy = latc * Math.sin(pc);
          const dz = uc;
          const t1x = -Math.sin(pc); // azimuthal tangent (unit)
          const t1y = Math.cos(pc);
          const t1z = 0;
          const t2x = dy * t1z - dz * t1y; // dir × t1 (unit, perpendicular)
          const t2y = dz * t1x - dx * t1z;
          const t2z = dx * t1y - dy * t1x;
          for (let k = 0; k < kids.length; k++) {
            const kn = nodeAt(kids[k]);
            const kd = depth.get(kids[k]);
            if (!kn || kd === undefined) continue;
            const radius = shellRadius(kd);
            // Disc radius that fits the (physical) patch at this shell.
            const cap = Math.min(latc * pHalf, uHalf) * radius;
            const rr = Math.sqrt((k + 0.5) / kids.length) * cap;
            const ang = k * GOLDEN;
            const ox = rr * Math.cos(ang);
            const oy = rr * Math.sin(ang);
            setPos(
              kn,
              dx * radius + t1x * ox + t2x * oy,
              dy * radius + t1y * ox + t2y * oy,
              dz * radius + t1z * ox + t2z * oy,
            );
          }
        } else {
          for (const c of splitRegion(kids, reg, leafW))
            stack.push({ id: c.item, reg: c.reg });
        }
      }
    };

    // Lay out the whole primary tree by containment from the repo at the
    // centre. `children` is already ordered by connectivity (the relational
    // barycenter pass above), so call-related sibling branches sit angularly
    // adjacent — related nodes near each other without breaking the containment
    // that keeps parent→child (and most call) edges short.
    placeForest(
      [primary],
      FULL,
      (id) => children.get(id) ?? [],
      (id) => leafWeight.get(id) ?? 1,
    );

    // Stragglers (nodes outside the repo's containment tree — mostly Dependency
    // nodes). Park each one right next to the code that uses it: the centroid of
    // its already-placed neighbours, nudged a little further out so it sits just
    // beyond its importer's cluster. This keeps dependencies hugging the sphere
    // near their consumers (short edges) instead of floating on a far shell.
    const strag = simNodes.filter((s) => depth.get(s.id) === undefined);
    const stragSet = new Set(strag.map((s) => s.id));
    const nbr = new Map<string, string[]>();
    for (const l of cachedLinks) {
      const a = endId(l.source);
      const b = endId(l.target);
      const aS = stragSet.has(a);
      const bS = stragSet.has(b);
      if (aS && !bS) (nbr.get(a) ?? nbr.set(a, []).get(a)!).push(b);
      if (bS && !aS) (nbr.get(b) ?? nbr.set(b, []).get(b)!).push(a);
    }
    const orphans: SimNode[] = [];
    for (const s of strag) {
      const ns = nbr.get(s.id);
      let x = 0;
      let y = 0;
      let z = 0;
      let cnt = 0;
      if (ns)
        for (const m of ns) {
          const i = nodeIdToIndex.get(m);
          if (i === undefined || depth.get(m) === undefined) continue;
          x += simNodes[i].x ?? 0;
          y += simNodes[i].y ?? 0;
          z += simNodes[i].z ?? 0;
          cnt++;
        }
      if (cnt === 0) {
        orphans.push(s);
        continue;
      }
      x /= cnt;
      y /= cnt;
      z /= cnt;
      const rr = Math.hypot(x, y, z) || 1;
      const k = (rr + ring * 0.6) / rr; // nudge just outside the importer
      setPos(s, x * k, y * k, z * k);
    }
    // Truly disconnected nodes have no anchor — tuck them on a modest inner
    // shell (not the far rim) so they don't read as floating far out.
    orphans.forEach((s, i) => {
      const y = 1 - (2 * (i + 0.5)) / Math.max(1, orphans.length);
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const ph = i * GOLDEN;
      const R = outerR * 0.5;
      setPos(s, Math.cos(ph) * r * R, y * R, Math.sin(ph) * r * R);
    });
  } else {
    // 2D — flat radial sunburst (depth → ring, leaf-order → angle).
    for (const s of simNodes) {
      const d = depth.get(s.id);
      if (d === undefined) continue;
      const theta = (angleRaw.get(s.id)! / totalLeaves) * Math.PI * 2;
      const rad2d = shellRadius(d);
      setPos(s, Math.cos(theta) * rad2d, Math.sin(theta) * rad2d, 0);
    }
    const out = simNodes.filter((s) => depth.get(s.id) === undefined);
    out.forEach((s, i) => {
      const theta = (i / Math.max(1, out.length)) * Math.PI * 2;
      setPos(
        s,
        Math.cos(theta) * (outerR + ring),
        Math.sin(theta) * (outerR + ring),
        0,
      );
    });
  }

  // Capture the deterministic radial positions as the anchor target. Tree mode
  // pins each node here (see makeTreeAnchorForce) so the layout stays the clean
  // mind-map starburst instead of being scattered into a ball by the sim.
  treeSeed = new Float64Array(simNodes.length * 3);
  for (let i = 0; i < simNodes.length; i++) {
    treeSeed[i * 3] = simNodes[i].x ?? 0;
    treeSeed[i * 3 + 1] = simNodes[i].y ?? 0;
    treeSeed[i * 3 + 2] = simNodes[i].z ?? 0;
  }
}

// ─── Message handler ────────────────────────────────────────────────────

self.onmessage = (e: MessageEvent<Worker3DInMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      stopStreaming();
      sim?.stop();
      communities = msg.communities;
      defaultTheta = Math.max(
        msg.config.barnesHutTheta ?? 0.9,
        FAST_BARNES_HUT_THETA,
      );
      dragTheta = Math.max(msg.config.dragTheta ?? 1.5, FAST_BARNES_HUT_THETA);
      currentMode = msg.config.layoutMode ?? 'spread';
      nDim = msg.dimensions ?? 2;

      simNodes = msg.nodeIds.map((id) => ({ id }));
      nodeIdToIndex = new Map();
      for (let i = 0; i < msg.nodeIds.length; i++) {
        nodeIdToIndex.set(msg.nodeIds[i], i);
      }

      const nodeIdSet = new Set(msg.nodeIds);
      const simLinks: SimLink[] = [];
      for (const link of msg.links) {
        if (nodeIdSet.has(link.source) && nodeIdSet.has(link.target)) {
          simLinks.push({
            source: link.source,
            target: link.target,
            w: link.w,
          });
        }
      }
      cachedLinks = simLinks;
      cachedConfig = {
        chargeStrength: msg.config.chargeStrength,
        linkDistance: msg.config.linkDistance,
        centerStrength: msg.config.centerStrength,
      };

      // Tree mode is a force layout seeded from the radial tree, so the
      // hierarchy relaxes into organic branches instead of converging from a
      // tangle. Seed positions before building the sim.
      if (currentMode === 'tree') computeRadialTree();

      sim = buildSimulation(simNodes, simLinks, cachedConfig, currentMode);
      sim.stop();
      const INITIAL_TICKS = currentMode === 'compact' ? 30 : 10;
      for (let i = 0; i < INITIAL_TICKS; i++) sim.tick();

      const buf = buildPositionBuffer();
      (self as unknown as Worker).postMessage(
        { type: 'ready', buffer: buf } satisfies Worker3DOutMessage,
        [buf.buffer],
      );

      sim.restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'set-dimensions': {
      if (msg.dimensions === nDim) break;
      nDim = msg.dimensions;
      // Tree mode: re-seed from the radial tree for the new dimensionality
      // (flat in 2D, spherical in 3D) and let the force tree relax again.
      if (currentMode === 'tree') {
        sim?.stop();
        computeRadialTree();
        sim = buildSimulation(
          simNodes,
          cachedLinks,
          cachedConfig!,
          currentMode,
        );
        sim.alpha(0.6).restart();
        settled = false;
        startStreaming();
        break;
      }
      if (!sim || !cachedConfig) break;
      rebuild(0.6);
      break;
    }

    case 'add-nodes': {
      if (!sim || !cachedConfig) break;
      if (msg.communities) communities = { ...communities, ...msg.communities };

      const existingIds = new Set(simNodes.map((n) => n.id));
      let cx = 0,
        cy = 0,
        cz = 0;
      for (const n of simNodes) {
        cx += n.x ?? 0;
        cy += n.y ?? 0;
        cz += n.z ?? 0;
      }
      if (simNodes.length > 0) {
        cx /= simNodes.length;
        cy /= simNodes.length;
        cz /= simNodes.length;
      }
      const spread = Math.sqrt(simNodes.length) * 10;

      let added = 0;
      for (const id of msg.nodeIds) {
        if (existingIds.has(id)) continue;
        const angle = Math.random() * Math.PI * 2;
        const r = Math.random() * spread;
        const node: SimNode = {
          id,
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
          z: nDim === 3 ? cz + (Math.random() - 0.5) * spread : 0,
        };
        simNodes.push(node);
        nodeIdToIndex.set(id, simNodes.length - 1);
        added++;
      }
      if (added === 0) break;

      const updatedIds = new Set(simNodes.map((n) => n.id));
      for (const link of msg.links) {
        if (updatedIds.has(link.source) && updatedIds.has(link.target)) {
          cachedLinks.push({
            source: link.source,
            target: link.target,
            w: link.w,
          });
        }
      }

      sim.stop();
      stopStreaming();
      sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
      sim.alpha(0.3).restart();
      settled = false;
      startStreaming();
      postPositions();
      break;
    }

    case 'update-config': {
      if (!sim || !cachedConfig) break;
      // No-op if nothing actually changes (e.g. the on-load re-apply of a
      // setting that already matches the init value) — avoids a needless reheat.
      const cfgUnchanged =
        (msg.chargeStrength === undefined ||
          msg.chargeStrength === cachedConfig.chargeStrength) &&
        (msg.linkDistance === undefined ||
          msg.linkDistance === cachedConfig.linkDistance) &&
        (msg.centerStrength === undefined ||
          msg.centerStrength === cachedConfig.centerStrength);
      if (cfgUnchanged) break;
      if (msg.chargeStrength !== undefined)
        cachedConfig.chargeStrength = msg.chargeStrength;
      if (msg.linkDistance !== undefined)
        cachedConfig.linkDistance = msg.linkDistance;
      if (msg.centerStrength !== undefined)
        cachedConfig.centerStrength = msg.centerStrength;
      if (msg.chargeStrength !== undefined) {
        sim.force(
          'charge',
          forceManyBody().strength(msg.chargeStrength).theta(defaultTheta),
        );
      }
      if (msg.linkDistance !== undefined) {
        const link = sim.force('link') as
          | ReturnType<typeof forceLink<SimNode, SimLink>>
          | undefined;
        if (link) link.distance(msg.linkDistance);
      }
      if (currentMode === 'spread' && msg.centerStrength !== undefined) {
        // Drive the attraction forces (centerX/Y/Z), not forceCenter (which is
        // just a centroid translation and wouldn't visibly tighten anything).
        const pull = spreadCenterPull(msg.centerStrength);
        const fx = sim.force('centerX') as
          | ReturnType<typeof forceX>
          | undefined;
        const fy = sim.force('centerY') as
          | ReturnType<typeof forceY>
          | undefined;
        const fz = sim.force('centerZ') as
          | ReturnType<typeof forceZ>
          | undefined;
        if (fx) fx.strength(pull);
        if (fy) fy.strength(pull);
        if (fz) fz.strength(pull);
      }
      sim.alpha(0.5).restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'update-compact-config': {
      if (!sim || !cachedConfig) break;
      // No-op if every provided value already matches (on-load re-apply of
      // defaults) — avoids a needless reheat/rebuild that would slow the load.
      const compactUnchanged =
        (msg.radialStrength === undefined ||
          msg.radialStrength === compactConfig.radialStrength) &&
        (msg.communityPull === undefined ||
          msg.communityPull === compactConfig.communityPull) &&
        (msg.centeringStrength === undefined ||
          msg.centeringStrength === compactConfig.centeringStrength) &&
        (msg.radiusScale === undefined ||
          msg.radiusScale === compactConfig.radiusScale);
      if (compactUnchanged) break;
      let needsRebuild = false;
      if (msg.radialStrength !== undefined) {
        compactConfig.radialStrength = msg.radialStrength;
        const radial = sim.force('radial') as
          | ReturnType<typeof forceRadial>
          | undefined;
        if (radial) radial.strength(msg.radialStrength);
      }
      if (msg.communityPull !== undefined)
        compactConfig.communityPull = msg.communityPull;
      if (msg.centeringStrength !== undefined) {
        compactConfig.centeringStrength = msg.centeringStrength;
        const fx = sim.force('x') as ReturnType<typeof forceX> | undefined;
        const fy = sim.force('y') as ReturnType<typeof forceY> | undefined;
        if (fx) fx.strength(msg.centeringStrength);
        if (fy) fy.strength(msg.centeringStrength);
      }
      if (msg.radiusScale !== undefined) {
        compactConfig.radiusScale = msg.radiusScale;
        needsRebuild = true;
      }
      if (needsRebuild) {
        sim.stop();
        sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
      }
      sim.alpha(0.8).restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'set-communities': {
      communities = msg.communities;
      // Tree mode's radial layout is driven by containment + connectivity
      // ordering (relational edges, known at init) — it doesn't use Louvain
      // communities, so nothing to recompute. Stay settled (and tell the main
      // thread, which optimistically flips simRunning on this message).
      if (currentMode === 'tree') {
        (self as unknown as Worker).postMessage({
          type: 'settled',
        } satisfies Worker3DOutMessage);
        break;
      }
      if (!sim || !cachedConfig) break;
      sim.stop();
      sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
      // Reheat hard — community gravity was just (re)installed and needs energy
      // to pull the (possibly settled) layout into petals.
      sim.alpha(0.7).restart();
      settled = false;
      startStreaming();
      break;
    }

    case 'set-layout-mode': {
      if (!cachedConfig) break;
      currentMode = msg.mode;
      sim?.stop();
      // Tree: re-seed from the radial tree so it relaxes into clean branches;
      // spread/compact keep current positions and relax.
      if (currentMode === 'tree') computeRadialTree();
      sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
      sim.alpha(currentMode === 'tree' ? 0.6 : 0.5).restart();
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
      if (!sim) break;
      const charge = sim.force('charge') as
        | ReturnType<typeof forceManyBody>
        | undefined;
      if (charge) charge.theta(dragTheta);
      break;
    }

    case 'reset-theta': {
      if (!sim) break;
      const charge = sim.force('charge') as
        | ReturnType<typeof forceManyBody>
        | undefined;
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
      const strength = msg.strength ?? 0.1;
      if (!communities) break;
      const sums = new Map<number, { x: number; y: number; count: number }>();
      for (const node of simNodes) {
        const cid = communities[node.id];
        if (cid === undefined) continue;
        const e2 = sums.get(cid) || { x: 0, y: 0, count: 0 };
        e2.x += node.x ?? 0;
        e2.y += node.y ?? 0;
        e2.count += 1;
        sums.set(cid, e2);
      }
      const centroids = new Map<number, { x: number; y: number }>();
      for (const [cid, { x, y, count }] of sums)
        centroids.set(cid, { x: x / count, y: y / count });
      const nodeCentroid = new Map<string, { x: number; y: number }>();
      for (const node of simNodes) {
        const cid = communities[node.id];
        if (cid !== undefined && centroids.has(cid))
          nodeCentroid.set(node.id, centroids.get(cid)!);
      }
      sim
        .force(
          'clusterX',
          forceX<SimNode>(
            (d: SimNode) => nodeCentroid.get(d.id)?.x ?? 0,
          ).strength(strength),
        )
        .force(
          'clusterY',
          forceY<SimNode>(
            (d: SimNode) => nodeCentroid.get(d.id)?.y ?? 0,
          ).strength(strength),
        )
        .alpha(0.5)
        .restart();
      settled = false;
      startStreaming();
      break;
    }
  }
};
