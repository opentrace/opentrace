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
 * React bridge to forceLayout3dWorker — the Three.js renderer's d3-force-3d
 * layout. Mirrors usePixiLayout, but decodes stride-3 position buffers
 * [x,y,z,...] and exposes `setDimensions` so the renderer can switch the
 * simulation between 2D and 3D when the user toggles 3D mode.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphNode,
  GraphLink,
  CommunityData,
  LayoutConfig,
} from '../graph/types';
import { endpointId, nodeSize } from '../graph/layoutHelpers';
import { AppendTracker } from './appendPrefix';
import { selectBreakpoint } from './scaleBreakpoints';
import type {
  Worker3DInMessage,
  Worker3DOutMessage,
  LayoutMode,
} from '../workers/forceLayout3dWorker';

/** Layout pull of relational edges (calls/imports/…) relative to the structural
 *  DEFINES tree (1.0). Kept low so the tree/branch structure stays clean: just
 *  enough to gently shorten call/import edges into logical branches, not so much
 *  that the hierarchy collapses into a ball. Higher = tighter/more interconnected,
 *  lower = more tree-like. */
const RELATIONAL_LINK_WEIGHT = 0.05;

/** Which endpoint is the CHILD of a tree-forming edge. Everything points
 *  parent → child except MIRRORS, which is stored doc → file while the File
 *  (already rooted in the code tree) is the anchor the doc hangs off. */
function childEnd(label: string, source: string, target: string): string {
  return label === 'MIRRORS' ? source : target;
}

/** Orient a tree-forming edge parent → child for the worker's forest builder,
 *  which reads `source` as the parent. Only MIRRORS is stored child-first. */
function orientParentFirst(
  link: GraphLink,
  source: string,
  target: string,
): readonly [string, string] {
  return link.label === 'MIRRORS' ? [target, source] : [source, target];
}

/** A layout-worker link: endpoint ids + link-force weight. */
export interface LayoutLink {
  source: string;
  target: string;
  w: number;
}

/** Multiset diff of layout links against what the worker was already sent,
 *  keyed source|target (weight excluded — a flat-mode / layout-edge-type
 *  change reclassifies weights without adding edges and must not re-send the
 *  whole graph). Returns the not-yet-sent links and records them in `sent`.
 *  "Touches a new node" is NOT a reliable new-link test: the pipeline's
 *  resolve stage emits CALLS/IMPORTS edges between nodes that both streamed
 *  in earlier batches. */
function takeUnsentLinks(
  links: LayoutLink[],
  sent: Map<string, number>,
): LayoutLink[] {
  const counts = new Map<string, number>();
  const out: LayoutLink[] = [];
  for (const l of links) {
    const key = `${l.source}|${l.target}`;
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);
    if (c > (sent.get(key) ?? 0)) {
      out.push(l);
      sent.set(key, c);
    }
  }
  return out;
}

/**
 * Incremental "classify raw graph links → diff against what the worker holds".
 *
 * Combines the old buildLayoutLinks (filter self-loops / missing endpoints,
 * assign structural-vs-relational weights) + takeUnsentLinks pair, but skips
 * re-scanning the whole link list per streamed batch when it grew append-only
 * (concat preserves prefix element identity).
 *
 * Fast-path correctness: the fast path emits every candidate that passes the
 * endpoint filter WITHOUT consulting the multiset diff, so it's only taken
 * when `sent` provably equals the per-key counts of the current included
 * list. That invariant is tracked as `sentTotal === included-count` after
 * every full scan (Σ equal + `sent` pointwise ≥ counts ⇒ pointwise equal) and
 * is preserved by each fast-path emission. Anything else — replaced/shrunk
 * arrays, a `sent` superset left over from a shrink — falls back to the full
 * scan, which behaves exactly like the old code path.
 *
 * Links excluded because an endpoint hasn't arrived yet (progressive loading
 * pushes edges before their nodes) are kept in `pendingExcluded` and
 * re-examined on every collect, so a prefix link becoming resolvable is still
 * caught — mirroring what the old full rescan did. Self-loops are dropped
 * permanently (content-based, can never become includable).
 *
 * Assumes the node set only GROWS between `reset()` calls (the owning effect
 * resets on every full worker rebuild, which is the only non-growing path).
 */
export class LayoutLinkCollector {
  private tracker = new AppendTracker<GraphLink>();
  private pendingExcluded: GraphLink[] = [];
  private sent = new Map<string, number>();
  private sentTotal = 0;
  private eligible = false;

  /** Fresh worker → fresh sent-state. Pairs with the worker init/rebuild. */
  reset(): void {
    this.tracker.reset();
    this.pendingExcluded = [];
    this.sent = new Map();
    this.sentTotal = 0;
    this.eligible = false;
  }

  /**
   * Returns the layout links not yet sent to the worker, recording them as
   * sent. Called with the FULL current link list; after a `reset()` the
   * result is the full filtered list (the worker-init payload).
   */
  collect(
    allLinks: GraphLink[],
    nodeIdSet: Set<string>,
    isStructural: (link: GraphLink) => boolean,
    orient: (
      link: GraphLink,
      source: string,
      target: string,
    ) => readonly [string, string] = (_l, s, t) => [s, t],
  ): LayoutLink[] {
    const suffix = this.tracker.suffixStart(allLinks);

    if (suffix >= 0 && this.eligible) {
      // Append fast path: the prefix is already classified + counted into
      // `sent`; only previously endpoint-deferred links and the suffix can
      // produce new layout links. Pending first so output order matches the
      // old full scan (prefix positions precede suffix positions).
      const out: LayoutLink[] = [];
      const pending = this.pendingExcluded;
      this.pendingExcluded = [];
      for (const link of pending) {
        this.consider(link, nodeIdSet, isStructural, orient, out);
      }
      for (let i = suffix; i < allLinks.length; i++) {
        this.consider(allLinks[i], nodeIdSet, isStructural, orient, out);
      }
      return out;
    }

    // Full scan — identical to the old buildLayoutLinks + takeUnsentLinks.
    this.pendingExcluded = [];
    const layoutLinks: LayoutLink[] = [];
    for (const link of allLinks) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (source === target) continue; // self-loops don't shape layout
      if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) {
        this.pendingExcluded.push(link);
        continue;
      }
      // Structural edges (the DEFINES containment tree) drive the layout at
      // full strength → the tree/flower shape. Relational edges (calls,
      // imports, …) are included at a weak weight so call/import neighbours
      // drift closer — shortening those long cross-graph edges into logical
      // branches — without collapsing the structure into a hairball.
      const [from, to] = orient(link, source, target);
      layoutLinks.push({
        source: from,
        target: to,
        w: isStructural(link) ? 1 : RELATIONAL_LINK_WEIGHT,
      });
    }
    const out = takeUnsentLinks(layoutLinks, this.sent);
    this.sentTotal += out.length;
    this.eligible = this.sentTotal === layoutLinks.length;
    return out;
  }

  private consider(
    link: GraphLink,
    nodeIdSet: Set<string>,
    isStructural: (link: GraphLink) => boolean,
    orient: (
      link: GraphLink,
      source: string,
      target: string,
    ) => readonly [string, string],
    out: LayoutLink[],
  ): void {
    const source = endpointId(link.source);
    const target = endpointId(link.target);
    if (source === target) return; // self-loops don't shape layout
    if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) {
      this.pendingExcluded.push(link);
      return;
    }
    // Key on the ORIENTED pair so the multiset diff matches what the full
    // scan records — keying raw endpoints would make a MIRRORS edge look
    // unsent on every collect and re-post it forever.
    const [from, to] = orient(link, source, target);
    const key = `${from}|${to}`;
    this.sent.set(key, (this.sent.get(key) ?? 0) + 1);
    this.sentTotal++;
    out.push({
      source: from,
      target: to,
      w: isStructural(link) ? 1 : RELATIONAL_LINK_WEIGHT,
    });
  }
}

/** Subset of `assignments` for the given ids (the per-batch communities
 *  delta: only NEW nodes' assignments ride along on add-nodes messages —
 *  structured-cloning the full 100k-key record per batch was a large,
 *  pure-overhead cost; the worker already holds everything else). */
export function pickAssignments(
  assignments: Record<string, number>,
  ids: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const v = assignments[id];
    if (v !== undefined) out[id] = v;
  }
  return out;
}

export interface UseForceLayout3dResult {
  layoutReady: boolean;
  positions: Map<string, { x: number; y: number }>;
  nodeSizes: Map<string, number>;
  simRunning: boolean;
  reheat: () => void;
  reseed: () => void;
  setNebula: (enabled: boolean, baseMode: LayoutMode) => void;
  restart: () => void;
  toggleSim: () => void;
  stopSim: () => void;
  startSim: () => void;
  fixNode: (nodeId: string, x: number, y: number) => void;
  unfixNode: (nodeId: string) => void;
  setChargeStrength: (strength: number) => void;
  setLinkDistance: (distance: number) => void;
  setCenterStrength: (strength: number) => void;
  setCommunityGravity: (enabled: boolean, strength?: number) => void;
  boostTheta: () => void;
  resetTheta: () => void;
  setLayoutMode: (mode: LayoutMode) => void;
  updateCompactConfig: (config: {
    radialStrength?: number;
    communityPull?: number;
    centeringStrength?: number;
    radiusScale?: number;
  }) => void;
  /** Switch the running simulation between 2D and 3D. */
  setDimensions: (dimensions: 2 | 3) => void;
  /** Live-build: release all pinned nodes (gentle relax) when the build ends. */
  releasePins: () => void;
}

export function useForceLayout3d(
  allNodes: GraphNode[],
  allLinks: GraphLink[],
  communityData: CommunityData,
  layoutConfig: LayoutConfig,
  onTick: (
    positions: Map<string, { x: number; y: number }>,
    buffer?: Float64Array,
  ) => void,
  initialLayoutMode: LayoutMode = 'spread',
  initialDimensions: 2 | 3 = 2,
  growBuild = false,
): UseForceLayout3dResult {
  const [layoutReady, setLayoutReady] = useState(false);
  // Live-build: when true, incremental adds pin existing nodes so only the new
  // ones settle (no choppy whole-graph reshuffle). Read via ref so the add
  // effect sees the current value without re-subscribing.
  const growBuildRef = useRef(growBuild);
  growBuildRef.current = growBuild;
  // Latched true once a live-build has added nodes; suppresses the end-of-build
  // community-cluster reheat (which would reshuffle the graph). Reset on a full
  // rebuild (fresh graph).
  const liveBuiltRef = useRef(false);
  const [simRunning, setSimRunning] = useState(true);
  const simRunningRef = useRef(true);
  const workerRef = useRef<Worker | null>(null);
  const unmountedRef = useRef(false);
  const requestIdRef = useRef(0);

  const nodeOrderRef = useRef<string[]>([]);
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  // Dimensions are applied at init; later changes go via setDimensions.
  const dimensionsRef = useRef<2 | 3>(initialDimensions);

  const flatMode = layoutConfig.flatMode ?? false;
  const structuralTypes = new Set(flatMode ? [] : layoutConfig.structuralTypes);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  // useMemo (mirroring nodeColors in ThreeGraphCanvas), NOT an effect into a
  // ref: the canvas's data effect consumes this map in the SAME commit that
  // nodes/links change. A ref written by an effect is always one commit stale,
  // so every incrementally-appended node would miss the map and be rendered at
  // the fallback minimum size forever.
  //
  // Append fast path: when nodes AND links both grew append-only (live
  // indexing), the map is extended instead of rebuilt. Sizes depend on
  // DEGREE, which changes for EXISTING nodes as new links arrive — so the
  // extension refreshes not just the new nodes but every endpoint of the
  // appended links. That keeps the map CONTENTS identical to a full
  // recompute in every state (no consumption-equivalence caveats needed:
  // even full setData/addData rebuilds, which size ALL nodes from this map,
  // read exactly the values a fresh recompute would produce). The cached
  // degree/type lookups are guarded on the structural-types inputs; any
  // change there falls back to a full recompute, mirroring what today's
  // recompute would use.
  const nodeSizesCacheRef = useRef<{
    map: Map<string, number>;
    degree: Map<string, number>;
    typeById: Map<string, string>;
    flatMode: boolean;
    structuralTypesInput: LayoutConfig['structuralTypes'];
  } | null>(null);
  const sizeNodesTrackerRef = useRef<AppendTracker<GraphNode> | null>(null);
  sizeNodesTrackerRef.current ??= new AppendTracker<GraphNode>();
  const sizeLinksTrackerRef = useRef<AppendTracker<GraphLink> | null>(null);
  sizeLinksTrackerRef.current ??= new AppendTracker<GraphLink>();
  const nodeSizes = useMemo(() => {
    const cache = nodeSizesCacheRef.current;
    const nodeSuffix = sizeNodesTrackerRef.current!.suffixStart(allNodes);
    const linkSuffix = sizeLinksTrackerRef.current!.suffixStart(allLinks);
    const appendOnly =
      nodeSuffix >= 0 &&
      linkSuffix >= 0 &&
      cache !== null &&
      cache.flatMode === flatMode &&
      cache.structuralTypesInput === layoutConfig.structuralTypes;

    if (appendOnly) {
      const { map, degree, typeById } = cache;
      // Types first: an appended link may touch a node from the same flush.
      for (let i = nodeSuffix; i < allNodes.length; i++) {
        const n = allNodes[i];
        typeById.set(n.id, n.type);
      }
      // Fold the new links into the degree counts. Endpoints without a node
      // (progressive loading pushes edges before their nodes) still count —
      // exactly like the full recompute's unconditional degreeMap fold — but
      // get no size entry until the node arrives.
      const touched = new Set<string>();
      for (let i = linkSuffix; i < allLinks.length; i++) {
        const link = allLinks[i];
        const s = endpointId(link.source);
        const t = endpointId(link.target);
        degree.set(s, (degree.get(s) || 0) + 1);
        degree.set(t, (degree.get(t) || 0) + 1);
        touched.add(s);
        touched.add(t);
      }
      // Refresh every node whose degree changed…
      for (const id of touched) {
        const type = typeById.get(id);
        if (type === undefined) continue; // endpoint not a node (yet)
        map.set(id, nodeSize(degree.get(id)!, type, structuralTypes));
      }
      // …and add the new nodes (their full degree is already folded in).
      for (let i = nodeSuffix; i < allNodes.length; i++) {
        const n = allNodes[i];
        map.set(n.id, nodeSize(degree.get(n.id) ?? 0, n.type, structuralTypes));
      }
      return map;
    }

    const degree = new Map<string, number>();
    for (const link of allLinks) {
      const s = endpointId(link.source);
      const t = endpointId(link.target);
      degree.set(s, (degree.get(s) || 0) + 1);
      degree.set(t, (degree.get(t) || 0) + 1);
    }
    const typeById = new Map<string, string>();
    const sizes = new Map<string, number>();
    for (const node of allNodes) {
      typeById.set(node.id, node.type);
      sizes.set(
        node.id,
        nodeSize(degree.get(node.id) ?? 0, node.type, structuralTypes),
      );
    }
    nodeSizesCacheRef.current = {
      map: sizes,
      degree,
      typeById,
      flatMode,
      structuralTypesInput: layoutConfig.structuralTypes,
    };
    return sizes;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNodes, allLinks]);

  // Stride-3 buffer → positions map (x,y only; z lives in the buffer the
  // renderer reads directly).
  const applyPositionBuffer = useCallback((buffer: Float64Array) => {
    const nodeOrder = nodeOrderRef.current;
    const pos = positionsRef.current;
    const count = Math.min(nodeOrder.length, Math.floor(buffer.length / 3));
    for (let i = 0; i < count; i++) {
      const id = nodeOrder[i];
      const existing = pos.get(id);
      if (existing) {
        existing.x = buffer[i * 3];
        existing.y = buffer[i * 3 + 1];
      } else {
        pos.set(id, { x: buffer[i * 3], y: buffer[i * 3 + 1] });
      }
    }
  }, []);

  const prevNodeIdsRef = useRef<Set<string>>(new Set());
  // layoutEdgeType is a priority-ORDERED list of tree-forming edge types
  // (index 0 = strongest claim on a node). Each node gets exactly ONE
  // full-strength "parent" spring — its highest-priority tree edge — and
  // every other tree-type edge touching it is demoted to the weak
  // relational weight. Without the one-parent rule, multi-parent nodes turn
  // the backbone into a mesh and mega-hubs into dense stars: a Vault
  // CONTAINS 100+ docs, but the docs' MIRRORS twins would scatter them
  // across the code tree where their files actually live.
  const parentPriority = useMemo(() => {
    const list = Array.isArray(layoutConfig.layoutEdgeType)
      ? layoutConfig.layoutEdgeType
      : [layoutConfig.layoutEdgeType];
    return new Map(list.map((t, i) => [t, i] as const));
  }, [layoutConfig.layoutEdgeType]);

  // Pick each node's ONE parent edge: the highest-priority tree-type edge
  // where the node is the child end (first seen wins a tie, matching the
  // worker's first-parent-wins forest). Returned as the set of winning link
  // objects so it can back a per-link `isStructural` predicate — the shape
  // LayoutLinkCollector consumes.
  const chooseParentLinks = useCallback(
    (nodeIdSet: Set<string>, linkArray: GraphLink[]) => {
      const chosen = new Map<string, GraphLink>();
      const chosenPrio = new Map<string, number>();
      for (const link of linkArray) {
        const prio = parentPriority.get(link.label);
        if (prio === undefined) continue;
        const source = endpointId(link.source);
        const target = endpointId(link.target);
        if (source === target) continue;
        if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) continue;
        const child = childEnd(link.label, source, target);
        const cur = chosenPrio.get(child);
        if (cur === undefined || prio < cur) {
          chosenPrio.set(child, prio);
          chosen.set(child, link);
        }
      }
      return new Set(chosen.values());
    },
    [parentPriority],
  );

  // Classifier + multiset diff of links already sent to the live worker
  // (init + add-nodes). Diffing against this is what catches resolve-stage
  // edges that arrive after both endpoints. Reset on full rebuild.
  const linkCollectorRef = useRef<LayoutLinkCollector | null>(null);
  linkCollectorRef.current ??= new LayoutLinkCollector();
  // Append fast path over allNodes (live indexing: batches concat, so the
  // prefix keeps element identity and only the suffix can hold new nodes).
  const nodesTrackerRef = useRef<AppendTracker<GraphNode> | null>(null);
  nodesTrackerRef.current ??= new AppendTracker<GraphNode>();
  // Identity of the assignments object last sent to the worker (init /
  // add-nodes / set-communities). Louvain produces a NEW object each time it
  // (re)computes, so identity is a cheap "actually changed" signal — without
  // it, ANY same-node effect re-run (e.g. a link-only resolve flush) would
  // re-post set-communities and the worker would full-rebuild + reheat
  // (alpha 0.7), reshuffling an already-settled graph.
  const lastPostedCommunitiesRef = useRef<Record<string, number> | null>(null);

  useEffect(() => {
    const prevIds = prevNodeIdsRef.current;
    const prevSize = prevIds.size;
    const suffixStart = nodesTrackerRef.current!.suffixStart(allNodes);

    let nodeIdSet: Set<string>;
    let newNodeIds: string[];
    let newTypes: Record<string, string>;
    let allPrevPresent: boolean;
    if (suffixStart >= 0) {
      // Append fast path: [0, suffixStart) is the previous array, whose ids
      // are exactly `prevIds` — extend it in place (contents end up identical
      // to a from-scratch rebuild) and derive new ids/types from the suffix.
      nodeIdSet = prevIds;
      newNodeIds = [];
      newTypes = {};
      for (let i = suffixStart; i < allNodes.length; i++) {
        const n = allNodes[i];
        if (!nodeIdSet.has(n.id)) {
          nodeIdSet.add(n.id);
          newNodeIds.push(n.id);
          newTypes[n.id] = n.type;
        }
      }
      allPrevPresent = prevSize > 0;
    } else {
      nodeIdSet = new Set<string>();
      for (const n of allNodes) nodeIdSet.add(n.id);
      allPrevPresent =
        prevSize > 0 && [...prevIds].every((id) => nodeIdSet.has(id));
      newNodeIds = [];
      newTypes = {};
      if (allPrevPresent && nodeIdSet.size > prevSize) {
        for (const n of allNodes) {
          if (!prevIds.has(n.id)) {
            newNodeIds.push(n.id);
            newTypes[n.id] = n.type;
          }
        }
      }
    }
    // Structural edges drive the layout at full strength; relational edges
    // pull weakly (see LayoutLinkCollector). "Structural" is the one-parent
    // rule, not a label test: a node's highest-priority tree edge wins, every
    // other tree edge touching it is demoted. That is a GLOBAL decision, so
    // unlike a per-label predicate it needs a pass over all links — skipped
    // entirely in flat mode, where every edge is structural by definition.
    const chosenParents = flatMode
      ? null
      : chooseParentLinks(nodeIdSet, allLinks);
    const isStructural = (link: GraphLink) =>
      flatMode || chosenParents!.has(link);

    const isIncremental =
      allPrevPresent && nodeIdSet.size > prevSize && workerRef.current !== null;
    const isSameNodes = allPrevPresent && nodeIdSet.size === prevSize;

    if (isSameNodes && workerRef.current) {
      // Links can still be new with an unchanged node set: during a live
      // build the resolve stage emits relational edges between
      // already-streamed nodes, and a flush can carry ONLY those. They must
      // reach the worker, or the layout — and the end-of-build reseed, which
      // replays the worker's cached links — permanently lacks their pull.
      const lateLinks = linkCollectorRef.current!.collect(
        allLinks,
        nodeIdSet,
        isStructural,
        orientParentFirst,
      );
      if (lateLinks.length > 0) {
        const assignmentsChanged =
          communityData.assignments !== lastPostedCommunitiesRef.current;
        workerRef.current.postMessage({
          type: 'add-nodes',
          nodeIds: [],
          links: lateLinks,
          // The full (large) assignments record only rides along when
          // Louvain actually recomputed — the worker already holds every
          // key otherwise (identity ⇒ contents), and structured-cloning
          // 100k assignments per resolve flush was pure overhead.
          ...(assignmentsChanged
            ? { communities: communityData.assignments }
            : {}),
          nodeTypes: {},
          pinExisting: growBuildRef.current,
        } satisfies Worker3DInMessage);
        // add-nodes already delivered (and applied) these assignments — no
        // need for the set-communities rebuild below on top of it.
        lastPostedCommunitiesRef.current = communityData.assignments;
        simRunningRef.current = true;
        setSimRunning(true);
      }
      // When Louvain (re)computes — including at the end of a live build — let
      // the layout cluster into communities so the result matches the finished
      // graph's shape. Only when the assignments ACTUALLY changed (identity
      // check — see lastPostedCommunitiesRef).
      if (communityData.assignments !== lastPostedCommunitiesRef.current) {
        lastPostedCommunitiesRef.current = communityData.assignments;
        workerRef.current.postMessage({
          type: 'set-communities',
          communities: communityData.assignments,
        } satisfies Worker3DInMessage);
        // set-communities reheats the worker (alpha 0.7) and reshuffles nodes
        // into their community clusters — a real layout move. Flag the sim as
        // running so the renderer drops `layoutSettled` and keeps edge endpoints
        // following the nodes; otherwise edges freeze at the pre-cluster
        // positions and look detached until the next reheat.
        simRunningRef.current = true;
        setSimRunning(true);
      }
      return;
    }

    if (isIncremental) {
      if (growBuildRef.current) liveBuiltRef.current = true;
      const newLinks = linkCollectorRef.current!.collect(
        allLinks,
        nodeIdSet,
        isStructural,
        orientParentFirst,
      );
      for (const id of newNodeIds) nodeOrderRef.current.push(id);

      const pos = positionsRef.current;
      let cx = 0,
        cy = 0,
        count = 0;
      // On the fast path `prevIds` was already extended with the new ids —
      // harmless here: new ids can't have a position yet, so the `p` guard
      // skips them and the centroid matches the old previous-ids-only loop.
      for (const id of prevIds) {
        const p = pos.get(id);
        if (p) {
          cx += p.x;
          cy += p.y;
          count++;
        }
      }
      if (count > 0) {
        cx /= count;
        cy /= count;
      }
      const spread = Math.sqrt(prevSize) * 10;
      for (const id of newNodeIds) {
        if (!pos.has(id)) {
          const angle = Math.random() * Math.PI * 2;
          const r = Math.random() * spread;
          pos.set(id, {
            x: cx + Math.cos(angle) * r,
            y: cy + Math.sin(angle) * r,
          });
        }
      }

      prevNodeIdsRef.current = nodeIdSet;
      const assignmentsChanged =
        communityData.assignments !== lastPostedCommunitiesRef.current;
      workerRef.current!.postMessage({
        type: 'add-nodes',
        nodeIds: newNodeIds,
        links: newLinks,
        // Per-batch payload: only the NEW nodes' assignments (the worker
        // merges them in). The full record still goes when Louvain actually
        // recomputed, exactly as before.
        ...(assignmentsChanged
          ? { communities: communityData.assignments }
          : {
              communitiesDelta: pickAssignments(
                communityData.assignments,
                newNodeIds,
              ),
            }),
        nodeTypes: newTypes,
        pinExisting: growBuildRef.current,
      } satisfies Worker3DInMessage);
      lastPostedCommunitiesRef.current = communityData.assignments;

      simRunningRef.current = true;
      setSimRunning(true);
      return;
    }

    workerRef.current?.terminate();
    workerRef.current = null;
    setLayoutReady(false);
    liveBuiltRef.current = false; // fresh graph — community reheat allowed again

    if (allNodes.length === 0) {
      prevNodeIdsRef.current = new Set();
      linkCollectorRef.current!.reset();
      lastPostedCommunitiesRef.current = null;
      return;
    }

    const reqId = ++requestIdRef.current;
    const nodeIds = allNodes.map((n) => n.id);
    // id → node type, for the worker's onion layout (shells by type).
    const typeById: Record<string, string> = {};
    for (const n of allNodes) typeById[n.id] = n.type;
    nodeOrderRef.current = nodeIds;

    const pos = positionsRef.current;
    pos.clear();
    for (const id of nodeIds) pos.set(id, { x: 0, y: 0 });

    // Fresh worker → fresh sent-state; collect() after reset() returns the
    // full filtered link list (the init payload) while seeding the diff.
    linkCollectorRef.current!.reset();
    const links = linkCollectorRef.current!.collect(
      allLinks,
      nodeIdSet,
      isStructural,
      orientParentFirst,
    );

    const worker = new Worker(
      new URL('../workers/forceLayout3dWorker.ts', import.meta.url),
      { type: 'module' },
    );
    workerRef.current = worker;

    worker.onerror = (err) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;
      console.error(
        '[three] layout worker failed — nodes will be placed at (0,0).',
        err,
      );
      setLayoutReady(true);
    };

    worker.onmessage = (e: MessageEvent<Worker3DOutMessage>) => {
      if (reqId !== requestIdRef.current || unmountedRef.current) return;
      switch (e.data.type) {
        case 'ready':
          applyPositionBuffer(e.data.buffer);
          setLayoutReady(true);
          break;
        case 'positions':
          applyPositionBuffer(e.data.buffer);
          onTickRef.current(positionsRef.current, e.data.buffer);
          break;
        case 'settled':
          simRunningRef.current = false;
          setSimRunning(false);
          break;
      }
    };

    const bp = selectBreakpoint(allNodes.length);
    worker.postMessage({
      type: 'init',
      nodeIds,
      links,
      communities: communityData.assignments,
      nodeTypes: typeById,
      dimensions: dimensionsRef.current,
      config: {
        chargeStrength: layoutConfig.chargeStrength,
        linkDistance: layoutConfig.linkDistance,
        barnesHutTheta: bp.barnesHutTheta,
        dragTheta: bp.dragTheta,
        layoutMode: initialLayoutMode,
      },
    } satisfies Worker3DInMessage);
    lastPostedCommunitiesRef.current = communityData.assignments;

    prevNodeIdsRef.current = nodeIdSet;
    simRunningRef.current = true;
    setSimRunning(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    allNodes,
    allLinks,
    communityData,
    layoutConfig,
    applyPositionBuffer,
    // flatMode derives from layoutConfig (already a dep), so listing it adds no
    // re-run trigger. Same reasoning covers the omitted `chooseParentLinks`:
    // it is a useCallback over `parentPriority`, which derives from
    // layoutConfig.layoutEdgeType — so any change that would give it new
    // behaviour already re-runs this effect through `layoutConfig`.
    flatMode,
  ]);

  const postToWorker = useCallback((msg: Worker3DInMessage) => {
    workerRef.current?.postMessage(msg);
  }, []);

  const restart = useCallback(() => {
    postToWorker({ type: 'start' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const reheat = useCallback(() => {
    postToWorker({ type: 'reheat' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const releasePins = useCallback(() => {
    postToWorker({ type: 'release-pins' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  /** Re-lay-out the graph from scratch (fresh seed) — used on preset switches
   *  so the result is independent of the layout currently on screen. */
  const reseed = useCallback(() => {
    postToWorker({ type: 'reseed' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  /** Toggle the nebula cloud layout. `baseMode` is the layout to fall back to
   *  when disabling (the app's current layout mode). */
  const setNebula = useCallback(
    (enabled: boolean, baseMode: LayoutMode) => {
      postToWorker({ type: 'set-nebula', enabled, baseMode });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const toggleSim = useCallback(() => {
    if (simRunningRef.current) {
      postToWorker({ type: 'stop' });
      simRunningRef.current = false;
      setSimRunning(false);
    } else {
      postToWorker({ type: 'start' });
      simRunningRef.current = true;
      setSimRunning(true);
    }
  }, [postToWorker]);

  const stopSim = useCallback(() => {
    postToWorker({ type: 'stop' });
    simRunningRef.current = false;
    setSimRunning(false);
  }, [postToWorker]);

  const startSim = useCallback(() => {
    postToWorker({ type: 'start' });
    simRunningRef.current = true;
    setSimRunning(true);
  }, [postToWorker]);

  const fixNode = useCallback(
    (nodeId: string, x: number, y: number) => {
      postToWorker({ type: 'fix-node', nodeId, x, y });
      if (!simRunningRef.current) {
        simRunningRef.current = true;
        setSimRunning(true);
      }
    },
    [postToWorker],
  );

  const unfixNode = useCallback(
    (nodeId: string) => {
      postToWorker({ type: 'unfix-node', nodeId });
    },
    [postToWorker],
  );

  const setChargeStrength = useCallback(
    (strength: number) => {
      postToWorker({ type: 'update-config', chargeStrength: strength });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setLinkDistance = useCallback(
    (distance: number) => {
      postToWorker({ type: 'update-config', linkDistance: distance });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setCenterStrength = useCallback(
    (strength: number) => {
      postToWorker({ type: 'update-config', centerStrength: strength });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setCommunityGravity = useCallback(
    (enabled: boolean, strength = 0.1) => {
      postToWorker({ type: 'set-community-gravity', enabled, strength });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const boostTheta = useCallback(() => {
    postToWorker({ type: 'boost-theta' });
  }, [postToWorker]);

  const resetTheta = useCallback(() => {
    postToWorker({ type: 'reset-theta' });
  }, [postToWorker]);

  const setLayoutMode = useCallback(
    (mode: LayoutMode) => {
      postToWorker({ type: 'set-layout-mode', mode });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const updateCompactConfig = useCallback(
    (config: {
      radialStrength?: number;
      communityPull?: number;
      centeringStrength?: number;
      radiusScale?: number;
    }) => {
      postToWorker({ type: 'update-compact-config', ...config });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  const setDimensions = useCallback(
    (dimensions: 2 | 3) => {
      if (dimensionsRef.current === dimensions) return;
      dimensionsRef.current = dimensions;
      postToWorker({ type: 'set-dimensions', dimensions });
      simRunningRef.current = true;
      setSimRunning(true);
    },
    [postToWorker],
  );

  return {
    layoutReady,
    positions: positionsRef.current,
    nodeSizes,
    simRunning,
    reheat,
    reseed,
    setNebula,
    restart,
    toggleSim,
    stopSim,
    startSim,
    fixNode,
    unfixNode,
    setChargeStrength,
    setLinkDistance,
    setCenterStrength,
    setCommunityGravity,
    boostTheta,
    resetTheta,
    setLayoutMode,
    updateCompactConfig,
    setDimensions,
    releasePins,
  };
}
