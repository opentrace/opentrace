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

export type LayoutMode = 'spread' | 'compact';

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
      if (!sim || !cachedConfig) break;
      if (msg.dimensions === nDim) break;
      nDim = msg.dimensions;
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
      if (!sim || !cachedConfig) break;
      currentMode = msg.mode;
      sim.stop();
      sim = buildSimulation(simNodes, cachedLinks, cachedConfig, currentMode);
      sim.alpha(0.5).restart();
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
