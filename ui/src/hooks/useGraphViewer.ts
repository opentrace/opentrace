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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  DEFAULT_LAYOUT_CONFIG,
  getLinkColor,
  getNodeColor,
  type GraphCanvasHandle,
  type LayoutConfig,
  type SearchSuggestion,
} from '../components';
import type { GraphLink, GraphNode, SelectedEdge } from '../components/utils';
import type { HistoryEntry } from '../appComponents/historyTypes';
import { useGraph } from '../providers/GraphDataProvider';
import { useGraphInteraction } from '../providers/GraphInteractionProvider';
import {
  GRAPH_SETTING_DEFAULTS,
  type GraphSettingDefaults,
} from '../config/graphSettingDefaults';

// Module-level frozen empty Set — shared across renders to avoid re-creating
// the empty default for highlight props. Never mutate.
const EMPTY_SET: Set<string> = Object.freeze(new Set<string>()) as Set<string>;

/** Max edges the BFS will walk from a found node before giving up (orphan). */
const TRAVERSAL_MAX_HOPS = 8;

/** Normalize a link endpoint (string | number | {id}) to a string id. */
function endpointKey(ep: unknown): string {
  if (typeof ep === 'string') return ep;
  if (typeof ep === 'number') return String(ep);
  if (ep && typeof ep === 'object' && 'id' in ep) {
    return String((ep as { id: unknown }).id);
  }
  return String(ep);
}

interface TraversalLeg {
  edges: { sourceId: string; targetId: string }[];
  destId: string;
}

/**
 * Plan an agent "walk": for each newly-found node, BFS over the visible-graph
 * adjacency to the nearest already-discovered node, returning the path as
 * travel-ordered edges (anchor → … → found). Nodes with no path within
 * `TRAVERSAL_MAX_HOPS` become orphans (a plain ping). The discovered set grows
 * as nodes are reached, so successive finds anchor to earlier ones — producing
 * one continuous walk rather than disjoint hops.
 */
function computeTraversalLegs(
  adjacency: Map<string, { neighbor: string }[]>,
  newIds: string[],
  priorIds: Set<string>,
): { legs: TraversalLeg[]; orphans: string[] } {
  const legs: TraversalLeg[] = [];
  const orphans: string[] = [];
  // Discovered anchors the walk can start from. Seed with the prior set; if the
  // turn is fresh (nothing discovered yet) the first found node becomes the seed.
  const discovered = new Set(priorIds);
  for (const id of newIds) {
    if (discovered.has(id)) continue;
    if (!adjacency.has(id)) {
      // Not a visible node (filtered out / unknown) — nothing to walk to.
      orphans.push(id);
      continue;
    }
    if (discovered.size === 0) {
      // First node of a fresh walk: it IS the starting anchor, no edge to draw.
      discovered.add(id);
      continue;
    }
    // BFS from the found node outward to the nearest discovered anchor.
    const parent = new Map<string, string>();
    const visited = new Set<string>([id]);
    let frontier = [id];
    let anchor: string | null = null;
    for (let hop = 0; hop < TRAVERSAL_MAX_HOPS && !anchor; hop++) {
      const next: string[] = [];
      for (const u of frontier) {
        for (const { neighbor } of adjacency.get(u) ?? []) {
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          parent.set(neighbor, u);
          if (discovered.has(neighbor)) {
            anchor = neighbor;
            break;
          }
          next.push(neighbor);
        }
        if (anchor) break;
      }
      frontier = next;
    }
    if (!anchor) {
      orphans.push(id);
      discovered.add(id);
      continue;
    }
    // Reconstruct anchor → … → found (parent chain runs found → anchor).
    const chain: string[] = [];
    for (
      let cur: string | undefined = anchor;
      cur !== undefined;
      cur = parent.get(cur)
    ) {
      chain.push(cur);
      if (cur === id) break;
    }
    // chain is anchor … found already (parent walk from anchor toward id).
    const edges: { sourceId: string; targetId: string }[] = [];
    for (let k = 0; k < chain.length - 1; k++) {
      edges.push({ sourceId: chain[k], targetId: chain[k + 1] });
      discovered.add(chain[k + 1]);
    }
    discovered.add(id);
    if (edges.length > 0) legs.push({ edges, destId: id });
  }
  return { legs, orphans };
}

/**
 * Additional highlight contribution from the consumer (e.g. Playground's
 * repo-id scoping). Composed at lower precedence than selection, community
 * focus, search highlights, and chat highlights — see the ladder in
 * {@link UseGraphViewerResult.highlightProps} for placement.
 */
export interface ExtraHighlightSource {
  nodes: Set<string>;
  links: Set<string>;
  labels: Set<string>;
}

export interface UseGraphViewerOptions {
  /**
   * Chat-tool highlight set. Lives above the hook because chat state belongs
   * to the App. Hook treats `undefined` and an empty set the same way.
   */
  chatHighlightNodes?: Set<string>;
  /**
   * Optional additional highlight source (Playground uses this for repo
   * scoping). Pass `null` / omit when not in use.
   */
  extraHighlightSource?: ExtraHighlightSource | null;
  /**
   * When set to true by the consumer, the next `graphVersion`-driven auto-fit
   * is skipped and the flag is reset. OSS sets this on its post-embedding
   * reload (vector-only update — structural graph unchanged) so the camera
   * doesn't re-animate. Playground leaves it untouched.
   */
  suppressNextAutoFitRef?: RefObject<boolean>;
  /**
   * Auto-fit behavior on each `graphVersion` bump.
   *
   * - `'schedule'` (default) — calls `canvasRef.current.scheduleAutoFit(400)`,
   *   which is throttled and gated by user pan/zoom state. If the user has
   *   already moved the camera, the fit is skipped (preserves user intent).
   * - `'unconditional'` — schedules an unconditional `zoomToFit(400)` after
   *   a 500ms layout-settle delay. Re-fits even if the user has panned. Used
   *   by consumers that want every graph load to re-center regardless of
   *   camera state (matches the original UI-repo fork behavior).
   */
  autoFitMode?: 'schedule' | 'unconditional';
}

export interface GraphViewerImperativeHandle {
  selectNode: (nodeId: string, hops?: number) => void;
  triggerPing: (nodeIds: Iterable<string>) => void;
  /**
   * Animate the agent "walking" the graph to newly-found nodes: for each new
   * id, walk real edges from the nearest already-discovered node and light the
   * path edge-by-edge (pulse + node pings), leaving the trail lit. `allIds` is
   * the full accumulated chat highlight set (discovered = allIds − newIds).
   * Falls back to a plain ping when the renderer can't animate (e.g. Pixi).
   */
  animateChatTraversal: (newIds: string[], allIds: Set<string>) => void;
  /** Clear any chat-traversal walk + lit trail (new question / highlights off). */
  clearChatTraversal: () => void;
  resetCamera: () => void;
  zoomToFit: (duration?: number) => void;
  /** Re-fetch the graph from the store. Thin wrapper around `loadGraph`. */
  reload: (query?: string, hops?: number) => Promise<void>;
}

export interface ToolbarState {
  searchQuery: string;
  onSearchQueryChange: (q: string) => void;
  onSearch: () => void;
  onReset: () => void;
  searchDisabled: boolean;
  showResetButton: boolean;
  searchSuggestions: SearchSuggestion[];
  onSuggestionSelect: (s: SearchSuggestion) => void;
  hops: number;
  onHopsChange: (h: number) => void;
  nodeCount: number;
  edgeCount: number;
  totalNodes?: number;
  totalEdges?: number;
  /** True when a node or edge is selected — drives the mobile "Details" tab. */
  showDetailsTab: boolean;
}

export interface PersistedSettings {
  repulsion: number;
  setRepulsion: Dispatch<SetStateAction<number>>;
  labelsVisible: boolean;
  setLabelsVisible: Dispatch<SetStateAction<boolean>>;
  /** Whether edges are drawn on the canvas. Persisted. Fix #7 —
   *  hides the edge layer at the renderer level without removing
   *  edges from the graph data, so node positions are preserved and
   *  edges reappear on re-enable without a relayout. */
  edgesVisible: boolean;
  setEdgesVisible: Dispatch<SetStateAction<boolean>>;
  /** Whether community wayfinder labels are shown. Decoupled from
   *  layout mode in Fix #52 — toggling no longer reflows the graph. */
  communityLabelsVisible: boolean;
  setCommunityLabelsVisible: Dispatch<SetStateAction<boolean>>;
  /** Master switch — when false, Louvain is not run and community
   *  colors/labels/gravity are all dormant. The sub-toggles are
   *  visually disabled in the panel when this is off. */
  communitiesEnabled: boolean;
  setCommunitiesEnabled: Dispatch<SetStateAction<boolean>>;
  zoomOnSelect: boolean;
  setZoomOnSelect: Dispatch<SetStateAction<boolean>>;
  pixiLinkDist: number;
  setPixiLinkDist: Dispatch<SetStateAction<number>>;
  pixiCenter: number;
  setPixiCenter: Dispatch<SetStateAction<number>>;
  pixiZoomExponent: number;
  setPixiZoomExponent: Dispatch<SetStateAction<number>>;
  layoutMode: 'spread' | 'compact' | 'tree' | 'onion';
  setLayoutMode: Dispatch<
    SetStateAction<'spread' | 'compact' | 'tree' | 'onion'>
  >;
  compactRadial: number;
  setCompactRadial: Dispatch<SetStateAction<number>>;
  compactCommunity: number;
  setCompactCommunity: Dispatch<SetStateAction<number>>;
  compactCentering: number;
  setCompactCentering: Dispatch<SetStateAction<number>>;
  compactRadius: number;
  setCompactRadius: Dispatch<SetStateAction<number>>;
  mode3d: boolean;
  setMode3d: Dispatch<SetStateAction<boolean>>;
  mode3dSpeed: number;
  setMode3dSpeed: Dispatch<SetStateAction<number>>;
  mode3dTilt: number;
  setMode3dTilt: Dispatch<SetStateAction<number>>;
  labelScale: number;
  setLabelScale: Dispatch<SetStateAction<number>>;
  edgeOpacity: number;
  setEdgeOpacity: Dispatch<SetStateAction<number>>;
  ambientMotion: boolean;
  setAmbientMotion: Dispatch<SetStateAction<boolean>>;
  rendererAutoRotate: boolean | null;
  setRendererAutoRotate: Dispatch<SetStateAction<boolean | null>>;
  physicsRunning: boolean;
  setPhysicsRunning: Dispatch<SetStateAction<boolean>>;
  /** Reset every persisted panel setting back to its default and
   *  clear localStorage. Used by the "Reset graph" toolbar button. */
  resetSettings: () => void;
}

export interface LegendItem {
  label: string;
  count: number;
  color: string;
}

export interface UseGraphViewerResult {
  /** Wire to `<GraphCanvas ref={canvasRef} />`. */
  canvasRef: RefObject<GraphCanvasHandle | null>;
  /** Stable pointer to the latest graphData. Read inside callbacks/effects
   *  to avoid re-firing on data change. */
  graphDataRef: RefObject<{ nodes: GraphNode[]; links: GraphLink[] }>;

  settings: PersistedSettings;
  toolbar: ToolbarState;

  legendNodeItems: LegendItem[];
  legendCommunityItems: LegendItem[];
  /** Whichever of the two above matches the active `colorMode`. */
  legendItems: LegendItem[];
  legendLinkItems: LegendItem[];

  onNodeClick: (n: GraphNode) => void;
  onLinkClick: (e: SelectedEdge) => void;
  onStageClick: () => void;

  /**
   * Pre-computed highlight props ready to spread into `<GraphCanvas>`.
   *
   * Precedence (highest first):
   *   1. selectedLink → edge endpoints + the edge itself
   *   2. focusedCommunityNodes → the focused community
   *   3. selection-derived highlights from `useGraphInteraction()`
   *   4. chatHighlightNodes (if non-empty)
   *   5. extraHighlightSource (if non-empty)
   *   6. fall back to selection-derived highlights (often empty)
   */
  highlightProps: {
    highlightNodes: Set<string>;
    highlightLinks: Set<string>;
    labelNodes: Set<string>;
  };

  layoutConfig: LayoutConfig;

  isEmpty: boolean;
  isSearchEmpty: boolean;

  /**
   * Build the standard imperative handle. Wrap with `useImperativeHandle` in
   * the consumer's component, e.g.
   *   useImperativeHandle(ref, () => v.buildImperativeHandle(), [v.buildImperativeHandle]);
   * or extend the returned object with consumer-specific methods.
   */
  buildImperativeHandle: () => GraphViewerImperativeHandle;
}

function readPersistedSettings(): Record<string, unknown> {
  try {
    return JSON.parse(localStorage.getItem('graph-settings') ?? '{}') as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

/** Single source of truth for the default values of every persisted
 *  panel setting. Re-exported here for backward compatibility; the
 *  canonical declaration lives in the store-free
 *  `../config/graphSettingDefaults` module so it can also be exposed via
 *  the public `./components/utils` entry point. */
export { GRAPH_SETTING_DEFAULTS };
export type { GraphSettingDefaults };

/**
 * Orchestration hook for a graph viewer shell. Owns the state, effects,
 * and memoized computations that every consumer of `<GraphCanvas>` ends
 * up writing — search/filter/highlight wiring, persisted physics & layout
 * settings, edge-click highlight overlay, community focus zoom, search
 * suggestions, and the standard imperative handle.
 *
 * Must be called inside a `<GraphDataProvider>` and `<GraphInteractionProvider>`.
 *
 * The chrome (toolbar, legend layout, empty/error/loading states, indexing
 * overlays, repo-add modal) is NOT owned here — consumers render whatever
 * shell they want around the values returned. See `appComponents/GraphViewer.tsx`
 * for the OSS reference shell.
 */
export function useGraphViewer(
  options: UseGraphViewerOptions = {},
): UseGraphViewerResult {
  const {
    chatHighlightNodes,
    extraHighlightSource,
    suppressNextAutoFitRef,
    autoFitMode = 'schedule',
  } = options;

  const canvasRef = useRef<GraphCanvasHandle>(null);

  const { graphData, stats, lastSearchQuery, graphVersion, loadGraph } =
    useGraph();

  const {
    selectedNode,
    setSelectedNode,
    selectedLink,
    setSelectedLink,
    setNodeHistory,
    setHiddenNodeTypes,
    setHiddenCommunities,
    colorMode,
    searchQuery,
    setSearchQuery,
    hops,
    setHops,
    focusedCommunityNodes,
    setFocusedCommunityNodes,
    communitiesEnabled,
    setCommunitiesEnabled,
    communityData,
    filteredGraphData,
    highlights,
  } = useGraphInteraction();

  // Stable pointer to the latest graphData. Lets stale closures (imperative
  // handle, narrow-dep effects) read fresh data without forcing graphData
  // into their dependency arrays.
  const graphDataRef = useRef(graphData);
  useEffect(() => {
    graphDataRef.current = graphData;
  }, [graphData]);

  // Stable pointer to the latest *visible* graph (filtered). The chat-traversal
  // pathfinder walks only visible edges so the pulse never routes through nodes
  // the user has filtered out.
  const filteredGraphDataRef = useRef(filteredGraphData);
  useEffect(() => {
    filteredGraphDataRef.current = filteredGraphData;
  }, [filteredGraphData]);

  // ─── Auto-fit on graphVersion bump ──────────────────────────────────────
  // Mode is consumer-selected via `options.autoFitMode`:
  //   - 'schedule' (default): `scheduleAutoFit` is throttled and gated by
  //     the user's pan/zoom state, so it's a no-op if the user has already
  //     moved the camera (preserves user intent — OSS default).
  //   - 'unconditional': always re-fits after a 500ms layout-settle delay,
  //     ignoring user camera state (matches the legacy UI-repo fork behavior).
  // Either mode honors `suppressNextAutoFitRef` for one-shot suppression.
  useEffect(() => {
    if (graphVersion === 0) return;
    if (suppressNextAutoFitRef?.current) {
      suppressNextAutoFitRef.current = false;
      return;
    }
    if (autoFitMode === 'unconditional') {
      const t = setTimeout(() => canvasRef.current?.zoomToFit(400), 500);
      return () => clearTimeout(t);
    }
    canvasRef.current?.scheduleAutoFit?.(400);
  }, [graphVersion, suppressNextAutoFitRef, autoFitMode]);

  // ─── Chat highlight links (edges between chat-highlighted nodes) ────────
  const chatHighlightLinks = useMemo(() => {
    if (!chatHighlightNodes || chatHighlightNodes.size < 2) return EMPTY_SET;
    const links = new Set<string>();
    for (const link of graphData.links) {
      if (
        chatHighlightNodes.has(link.source) &&
        chatHighlightNodes.has(link.target)
      ) {
        links.add(`${link.source}-${link.target}`);
      }
    }
    return links;
  }, [graphData.links, chatHighlightNodes]);

  // ─── Append chat-highlighted nodes to session history ──────────────────
  useEffect(() => {
    if (!chatHighlightNodes || chatHighlightNodes.size === 0) return;
    const now = Date.now();
    setNodeHistory((prev) => {
      const existing = new Set(prev.map((e) => e.id));
      const newEntries: HistoryEntry[] = [];
      for (const id of chatHighlightNodes) {
        if (existing.has(id)) continue;
        const node = graphDataRef.current.nodes.find((n) => n.id === id);
        if (!node) continue;
        newEntries.push({
          id: node.id,
          name: node.name,
          type: node.type,
          timestamp: now,
          source: 'chat',
        });
      }
      if (newEntries.length === 0) return prev;
      return [...newEntries, ...prev].slice(0, 500);
    });
  }, [chatHighlightNodes, setNodeHistory]);

  // ─── Edge-click overlay state ──────────────────────────────────────────
  const [edgeHighlightNodes, setEdgeHighlightNodes] =
    useState<Set<string>>(EMPTY_SET);
  const [edgeHighlightLinks, setEdgeHighlightLinks] =
    useState<Set<string>>(EMPTY_SET);
  const [edgeLabelNodes, setEdgeLabelNodes] = useState<Set<string>>(EMPTY_SET);

  // ─── Active search filter (data, so we can re-apply it) ────────────────
  const [activeFilter, setActiveFilter] = useState<{
    type: 'community';
    communityId: number;
  } | null>(null);

  // ─── Persisted physics / layout / 3D settings ──────────────────────────
  const stored = useMemo(readPersistedSettings, []);
  const ps = <T>(key: string, def: T): T => (stored[key] as T) ?? def;

  const D = GRAPH_SETTING_DEFAULTS;

  const [zoomOnSelect, setZoomOnSelect] = useState(() =>
    ps('zoomOnSelect', D.zoomOnSelect),
  );
  const [repulsion, setRepulsion] = useState(() =>
    ps('repulsion', D.repulsion),
  );
  const [labelsVisible, setLabelsVisible] = useState(() =>
    ps('labelsVisible', D.labelsVisible),
  );
  const [edgesVisible, setEdgesVisible] = useState(() =>
    ps('edgesVisible', D.edgesVisible),
  );
  const [communityLabelsVisible, setCommunityLabelsVisible] = useState(() =>
    ps('communityLabelsVisible', D.communityLabelsVisible),
  );
  const [physicsRunning, setPhysicsRunning] = useState(false);

  const [pixiLinkDist, setPixiLinkDist] = useState(() =>
    ps('pixiLinkDist', D.pixiLinkDist),
  );
  const [pixiCenter, setPixiCenter] = useState(() =>
    ps('pixiCenter', D.pixiCenter),
  );
  const [pixiZoomExponent, setPixiZoomExponent] = useState(() =>
    ps('pixiZoomExponent', D.pixiZoomExponent),
  );

  const [layoutMode, setLayoutMode] = useState<
    'spread' | 'compact' | 'tree' | 'onion'
  >(() => ps('layoutMode', D.layoutMode));
  const [compactRadial, setCompactRadial] = useState(() =>
    ps('compactRadial', D.compactRadial),
  );
  const [compactCommunity, setCompactCommunity] = useState(() =>
    ps('compactCommunity', D.compactCommunity),
  );
  const [compactCentering, setCompactCentering] = useState(() =>
    ps('compactCentering', D.compactCentering),
  );
  const [compactRadius, setCompactRadius] = useState(() =>
    ps('compactRadius', D.compactRadius),
  );

  const [mode3d, setMode3d] = useState(() => ps('mode3d', D.mode3d));
  const [mode3dSpeed, setMode3dSpeed] = useState(() =>
    ps('mode3dSpeed', D.mode3dSpeed),
  );
  const [mode3dTilt, setMode3dTilt] = useState(() =>
    ps('mode3dTilt', D.mode3dTilt),
  );
  const [labelScale, setLabelScale] = useState(() =>
    ps('labelScale', D.labelScale),
  );
  const [edgeOpacity, setEdgeOpacity] = useState(() =>
    ps('edgeOpacity', D.edgeOpacity),
  );
  const [ambientMotion, setAmbientMotion] = useState(() =>
    ps('ambientMotion', D.ambientMotion),
  );

  const [rendererAutoRotate, setRendererAutoRotate] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    const settings = {
      repulsion,
      labelsVisible,
      edgesVisible,
      communityLabelsVisible,
      zoomOnSelect,
      pixiLinkDist,
      pixiCenter,
      pixiZoomExponent,
      layoutMode,
      compactRadial,
      compactCommunity,
      compactCentering,
      compactRadius,
      mode3d,
      mode3dSpeed,
      mode3dTilt,
      labelScale,
      edgeOpacity,
      ambientMotion,
    };
    // Merge into the existing entry rather than overwriting it — fields
    // owned by other writers of this shared key (e.g. `communitiesEnabled`
    // from GraphInteractionProvider) must survive our persist.
    try {
      const prev = JSON.parse(
        localStorage.getItem('graph-settings') ?? '{}',
      ) as Record<string, unknown>;
      localStorage.setItem(
        'graph-settings',
        JSON.stringify({ ...prev, ...settings }),
      );
    } catch {
      localStorage.setItem('graph-settings', JSON.stringify(settings));
    }
  }, [
    repulsion,
    labelsVisible,
    edgesVisible,
    communityLabelsVisible,
    zoomOnSelect,
    pixiLinkDist,
    pixiCenter,
    pixiZoomExponent,
    layoutMode,
    compactRadial,
    compactCommunity,
    compactCentering,
    compactRadius,
    mode3d,
    mode3dSpeed,
    mode3dTilt,
    labelScale,
    edgeOpacity,
    ambientMotion,
  ]);

  // ─── Search / reset / suggestions / filter ─────────────────────────────
  const handleSearch = useCallback(() => {
    if (searchQuery.trim()) {
      loadGraph(searchQuery.trim(), hops);
    }
  }, [searchQuery, hops, loadGraph]);

  // Re-run the active search when the hop depth changes so the neighborhood
  // visibly grows/shrinks instead of waiting for the next manual search.
  // Guarded on a ref so it fires only on a real hops change (not when
  // `lastSearchQuery` updates after a search, which already loaded). When no
  // search is active, hops only drives the selection highlight, which
  // `useHighlights` recomputes reactively — nothing to reload here.
  const prevHopsRef = useRef(hops);
  useEffect(() => {
    if (prevHopsRef.current === hops) return;
    prevHopsRef.current = hops;
    if (lastSearchQuery) {
      loadGraph(lastSearchQuery, hops);
    }
  }, [hops, lastSearchQuery, loadGraph]);

  const handleReset = useCallback(() => {
    setSearchQuery('');
    setHops(2);
    setSelectedNode(null);
    setSelectedLink(null);
    setActiveFilter(null);
    setFocusedCommunityNodes(EMPTY_SET);
    setHiddenNodeTypes(new Set());
    setHiddenCommunities(new Set());
    if (lastSearchQuery) {
      loadGraph();
    }
  }, [
    setSearchQuery,
    setHops,
    setSelectedNode,
    setSelectedLink,
    setFocusedCommunityNodes,
    setHiddenNodeTypes,
    setHiddenCommunities,
    lastSearchQuery,
    loadGraph,
  ]);

  /** Reset every persisted panel setting back to its default value and
   *  clear the localStorage entry. Used by the "Reset graph" button.
   *  Caller is responsible for pushing values into the renderer for
   *  imperative settings (repulsion, link distance, compact forces,
   *  etc.) — those don't flow as React props. */
  const resetSettings = useCallback(() => {
    const D = GRAPH_SETTING_DEFAULTS;
    setZoomOnSelect(D.zoomOnSelect);
    setRepulsion(D.repulsion);
    setLabelsVisible(D.labelsVisible);
    setEdgesVisible(D.edgesVisible);
    setCommunityLabelsVisible(D.communityLabelsVisible);
    setPixiLinkDist(D.pixiLinkDist);
    setPixiCenter(D.pixiCenter);
    setPixiZoomExponent(D.pixiZoomExponent);
    setLayoutMode(D.layoutMode);
    setCompactRadial(D.compactRadial);
    setCompactCommunity(D.compactCommunity);
    setCompactCentering(D.compactCentering);
    setCompactRadius(D.compactRadius);
    setMode3d(D.mode3d);
    setMode3dSpeed(D.mode3dSpeed);
    setMode3dTilt(D.mode3dTilt);
    setLabelScale(D.labelScale);
    setEdgeOpacity(D.edgeOpacity);
    setAmbientMotion(D.ambientMotion);
    setCommunitiesEnabled(D.communitiesEnabled);
    setRendererAutoRotate(null);
    try {
      localStorage.removeItem('graph-settings');
    } catch {
      // ignore
    }
  }, [setCommunitiesEnabled]);

  const applyFilter = useCallback(
    (filter: typeof activeFilter) => {
      if (!filter) {
        setFocusedCommunityNodes(EMPTY_SET);
        return;
      }
      if (filter.type === 'community') {
        const nodeIds = Object.entries(communityData.assignments)
          .filter(([, id]) => id === filter.communityId)
          .map(([nodeId]) => nodeId);
        if (nodeIds.length > 0) {
          const nodeSet = new Set(nodeIds);
          setFocusedCommunityNodes(nodeSet);
          canvasRef.current?.zoomToNodes(nodeSet, 600);
        }
      }
    },
    [communityData.assignments, setFocusedCommunityNodes],
  );

  // ─── Click handlers ────────────────────────────────────────────────────
  const onNodeClick = useCallback(
    (node: GraphNode) => {
      setSelectedNode(node);
      setSelectedLink(null);
      setEdgeHighlightNodes(EMPTY_SET);
      setEdgeHighlightLinks(EMPTY_SET);
      setEdgeLabelNodes(EMPTY_SET);
      setFocusedCommunityNodes(EMPTY_SET);
      setNodeHistory((prev) => {
        if (prev.length > 0 && prev[0].id === node.id) return prev;
        const entry: HistoryEntry = {
          id: node.id,
          name: node.name,
          type: node.type,
          timestamp: Date.now(),
          source: 'user',
        };
        return [entry, ...prev].slice(0, 500);
      });
      // Zoom is handled by the selectedNode-zoom effect after highlights settle.
    },
    [
      setSelectedNode,
      setSelectedLink,
      setFocusedCommunityNodes,
      setNodeHistory,
    ],
  );

  const onLinkClick = useCallback(
    (edge: SelectedEdge) => {
      setSelectedLink(edge);
      setSelectedNode(null);
      // Edge highlight overlay + zoom are wired up by the selectedLink-sync
      // effect below — works for both the canvas-click path and the SidePanel
      // "select edge from node details" path that writes selectedLink directly.
    },
    [setSelectedLink, setSelectedNode],
  );

  const activeFilterRef = useRef(activeFilter);
  activeFilterRef.current = activeFilter;

  const onStageClick = useCallback(() => {
    setSelectedNode(null);
    setSelectedLink(null);
    setEdgeHighlightNodes(EMPTY_SET);
    setEdgeHighlightLinks(EMPTY_SET);
    setEdgeLabelNodes(EMPTY_SET);
    applyFilter(activeFilterRef.current);
  }, [applyFilter, setSelectedLink, setSelectedNode]);

  const handleSuggestionSelect = useCallback(
    (suggestion: SearchSuggestion) => {
      switch (suggestion.category) {
        case 'community': {
          const cid = suggestion.communityId;
          if (cid !== undefined) {
            setActiveFilter({ type: 'community', communityId: cid });
            applyFilter({ type: 'community', communityId: cid });
            setSelectedNode(null);
            setSelectedLink(null);
          }
          break;
        }
        default: {
          // name — load graph centered on the search, then auto-select the node
          setActiveFilter(null);
          const targetId = suggestion.nodeId;
          loadGraph(suggestion.label, hops).then(() => {
            if (targetId) {
              const node = graphDataRef.current.nodes.find(
                (n) => n.id === targetId,
              );
              if (node) {
                onNodeClick(node);
                // Zoom to the node AND its immediate neighbors. Fitting a
                // single node maxes out the zoom (it fills the screen);
                // including neighbors gives the bounding box room so the
                // camera lands at a sane, context-preserving zoom.
                const focusIds = new Set<string>([targetId]);
                for (const link of graphDataRef.current.links) {
                  if (link.source === targetId) focusIds.add(link.target);
                  else if (link.target === targetId) focusIds.add(link.source);
                }
                // Layout-settle delay before zooming to the freshly selected node
                setTimeout(() => {
                  canvasRef.current?.zoomToNodes(focusIds, 600);
                }, 100);
              }
            }
          });
          break;
        }
      }
    },
    [
      applyFilter,
      hops,
      loadGraph,
      onNodeClick,
      setSelectedLink,
      setSelectedNode,
    ],
  );

  // ─── Selection-derived effects (zoom, edge highlight sync) ─────────────
  useEffect(() => {
    if (focusedCommunityNodes.size > 0) {
      canvasRef.current?.zoomToNodes(focusedCommunityNodes, 600);
    }
  }, [focusedCommunityNodes]);

  useEffect(() => {
    if (!selectedLink) {
      setEdgeHighlightNodes(EMPTY_SET);
      setEdgeHighlightLinks(EMPTY_SET);
      setEdgeLabelNodes(EMPTY_SET);
      return;
    }
    const { source: sourceId, target: targetId } = selectedLink;
    setEdgeHighlightNodes(new Set([sourceId, targetId]));
    setEdgeHighlightLinks(new Set([`${sourceId}-${targetId}`]));
    setEdgeLabelNodes(new Set([sourceId, targetId]));
    canvasRef.current?.zoomToNodes([sourceId, targetId], 600);
  }, [selectedLink]);

  // Trigger only on selectedNode identity change — not on highlight
  // recalculation (which would fire on filter/search/hops changes and cause
  // unwanted re-zoom).
  const selectedNodeId = selectedNode?.id;
  const hasSelectedLink = !!selectedLink;
  const focusedCommunitySize = focusedCommunityNodes.size;
  useEffect(() => {
    if (!zoomOnSelect) return;
    if (selectedNode) {
      if (highlights.highlightNodes.size > 0) {
        canvasRef.current?.zoomToNodes(highlights.highlightNodes, 600);
      }
    } else if (!selectedLink && focusedCommunityNodes.size === 0) {
      canvasRef.current?.zoomToFit(600);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomOnSelect, selectedNodeId, hasSelectedLink, focusedCommunitySize]);

  // ─── Legend items ───────────────────────────────────────────────────────
  const legendNodeItems = useMemo<LegendItem[]>(() => {
    const counts: Record<string, number> = {};
    filteredGraphData.nodes.forEach((n) => {
      counts[n.type] = (counts[n.type] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, count]) => ({
        label,
        count,
        color: getNodeColor(label),
      }))
      .sort((a, b) => b.count - a.count);
  }, [filteredGraphData.nodes]);

  const legendCommunityItems = useMemo<LegendItem[]>(() => {
    if (colorMode !== 'community') return [];
    const counts = new Map<number, number>();
    for (const n of filteredGraphData.nodes) {
      const cid = communityData.assignments[n.id];
      if (cid !== undefined) {
        counts.set(cid, (counts.get(cid) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cid, count]) => ({
        label: communityData.names.get(cid) ?? `Community ${cid}`,
        count,
        color: communityData.colorMap.get(cid) ?? '#64748b',
      }));
  }, [colorMode, filteredGraphData.nodes, communityData]);

  const legendItems =
    colorMode === 'community' ? legendCommunityItems : legendNodeItems;

  const legendLinkItems = useMemo<LegendItem[]>(() => {
    const counts: Record<string, number> = {};
    filteredGraphData.links.forEach((l) => {
      const label = (l as unknown as GraphLink).label || 'unknown';
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([label, count]) => ({
        label,
        count,
        color: getLinkColor(label),
      }))
      .sort((a, b) => b.count - a.count);
  }, [filteredGraphData.links]);

  // ─── Search suggestions ─────────────────────────────────────────────────
  const searchSuggestions = useMemo<SearchSuggestion[]>(() => {
    const nameMap = new Map<
      string,
      { type: string; communityId?: number; nodeId: string }
    >();
    for (const n of graphData.nodes) {
      if (!nameMap.has(n.name)) {
        const cid = communityData.assignments[n.id];
        nameMap.set(n.name, {
          type: n.type,
          communityId: cid,
          nodeId: n.id,
        });
      }
    }
    const suggestions: SearchSuggestion[] = [];
    for (const [name, info] of nameMap) {
      const cLabel =
        info.communityId !== undefined
          ? communityData.names.get(info.communityId)
          : undefined;
      const cColor =
        info.communityId !== undefined
          ? communityData.colorMap.get(info.communityId)
          : undefined;
      suggestions.push({
        label: name,
        category: 'name',
        color: getNodeColor(info.type),
        communityLabel: cLabel,
        communityColor: cColor,
        nodeId: info.nodeId,
      });
    }
    for (const [cid, name] of communityData.names) {
      suggestions.push({
        label: name,
        category: 'community',
        color: communityData.colorMap.get(cid),
        communityId: cid,
      });
    }
    return suggestions;
  }, [graphData.nodes, communityData]);

  // ─── Layout config ──────────────────────────────────────────────────────
  const layoutConfig = useMemo<LayoutConfig>(
    () => ({
      ...DEFAULT_LAYOUT_CONFIG,
      fa2ScalingRatio: repulsion,
    }),
    [repulsion],
  );

  // ─── Highlight props (the chained-ternary precedence ladder) ───────────
  // Order of precedence is documented on `UseGraphViewerResult.highlightProps`.
  // Keep this exactly aligned with that doc — both consumers (and any future
  // consumers) rely on this precedence for visual correctness.
  const highlightProps = useMemo(() => {
    const hasChat = !!chatHighlightNodes && chatHighlightNodes.size > 0;
    const hasExtraNodes =
      !!extraHighlightSource && extraHighlightSource.nodes.size > 0;
    const hasExtraLinks =
      !!extraHighlightSource && extraHighlightSource.links.size > 0;
    const hasExtraLabels =
      !!extraHighlightSource && extraHighlightSource.labels.size > 0;

    const highlightNodes = selectedLink
      ? edgeHighlightNodes
      : focusedCommunityNodes.size > 0
        ? focusedCommunityNodes
        : highlights.highlightNodes.size > 0
          ? highlights.highlightNodes
          : hasChat
            ? chatHighlightNodes!
            : hasExtraNodes
              ? extraHighlightSource!.nodes
              : highlights.highlightNodes;

    const highlightLinks = selectedLink
      ? edgeHighlightLinks
      : focusedCommunityNodes.size > 0
        ? EMPTY_SET
        : highlights.highlightLinks.size > 0
          ? highlights.highlightLinks
          : chatHighlightLinks.size > 0
            ? chatHighlightLinks
            : hasExtraLinks
              ? extraHighlightSource!.links
              : highlights.highlightLinks;

    const labelNodes = selectedLink
      ? edgeLabelNodes
      : focusedCommunityNodes.size > 0
        ? focusedCommunityNodes
        : highlights.labelNodes.size > 0
          ? highlights.labelNodes
          : hasChat
            ? chatHighlightNodes!
            : hasExtraLabels
              ? extraHighlightSource!.labels
              : highlights.labelNodes;

    return { highlightNodes, highlightLinks, labelNodes };
  }, [
    selectedLink,
    edgeHighlightNodes,
    edgeHighlightLinks,
    edgeLabelNodes,
    focusedCommunityNodes,
    highlights.highlightNodes,
    highlights.highlightLinks,
    highlights.labelNodes,
    chatHighlightNodes,
    chatHighlightLinks,
    extraHighlightSource,
  ]);

  // ─── Toolbar state (assembled values for a search/header bar) ──────────
  const toolbar = useMemo<ToolbarState>(
    () => ({
      searchQuery,
      onSearchQueryChange: setSearchQuery,
      onSearch: handleSearch,
      onReset: handleReset,
      searchDisabled: !searchQuery.trim() || searchQuery === lastSearchQuery,
      showResetButton: !!lastSearchQuery,
      searchSuggestions,
      onSuggestionSelect: handleSuggestionSelect,
      hops,
      onHopsChange: setHops,
      nodeCount: filteredGraphData.nodes.length,
      edgeCount: filteredGraphData.links.length,
      totalNodes: stats?.total_nodes,
      totalEdges: stats?.total_edges,
      showDetailsTab: !!(selectedNode || selectedLink),
    }),
    [
      searchQuery,
      setSearchQuery,
      handleSearch,
      handleReset,
      lastSearchQuery,
      searchSuggestions,
      handleSuggestionSelect,
      hops,
      setHops,
      filteredGraphData.nodes.length,
      filteredGraphData.links.length,
      stats?.total_nodes,
      stats?.total_edges,
      selectedNode,
      selectedLink,
    ],
  );

  // ─── Persisted-settings bundle ─────────────────────────────────────────
  const settings = useMemo<PersistedSettings>(
    () => ({
      repulsion,
      setRepulsion,
      labelsVisible,
      setLabelsVisible,
      edgesVisible,
      setEdgesVisible,
      communityLabelsVisible,
      setCommunityLabelsVisible,
      communitiesEnabled,
      setCommunitiesEnabled,
      zoomOnSelect,
      setZoomOnSelect,
      pixiLinkDist,
      setPixiLinkDist,
      pixiCenter,
      setPixiCenter,
      pixiZoomExponent,
      setPixiZoomExponent,
      layoutMode,
      setLayoutMode,
      compactRadial,
      setCompactRadial,
      compactCommunity,
      setCompactCommunity,
      compactCentering,
      setCompactCentering,
      compactRadius,
      setCompactRadius,
      mode3d,
      setMode3d,
      mode3dSpeed,
      setMode3dSpeed,
      mode3dTilt,
      setMode3dTilt,
      labelScale,
      setLabelScale,
      edgeOpacity,
      setEdgeOpacity,
      ambientMotion,
      setAmbientMotion,
      rendererAutoRotate,
      setRendererAutoRotate,
      physicsRunning,
      setPhysicsRunning,
      resetSettings,
    }),
    [
      repulsion,
      labelsVisible,
      edgesVisible,
      communityLabelsVisible,
      communitiesEnabled,
      setCommunitiesEnabled,
      zoomOnSelect,
      pixiLinkDist,
      pixiCenter,
      pixiZoomExponent,
      layoutMode,
      compactRadial,
      compactCommunity,
      compactCentering,
      compactRadius,
      mode3d,
      mode3dSpeed,
      mode3dTilt,
      labelScale,
      edgeOpacity,
      ambientMotion,
      rendererAutoRotate,
      physicsRunning,
      resetSettings,
    ],
  );

  const isEmpty = graphData.nodes.length === 0;
  const isSearchEmpty = isEmpty && !!lastSearchQuery;

  // ─── Imperative handle factory ─────────────────────────────────────────
  const buildImperativeHandle = useCallback(
    (): GraphViewerImperativeHandle => ({
      selectNode: (nodeId: string, nodeHops?: number) => {
        if (nodeHops !== undefined) setHops(nodeHops);
        const node = graphDataRef.current.nodes.find((n) => n.id === nodeId);
        if (node) onNodeClick(node);
      },
      triggerPing: (nodeIds: Iterable<string>) => {
        canvasRef.current?.triggerPing?.(nodeIds);
      },
      animateChatTraversal: (newIds: string[], allIds: Set<string>) => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        // Renderer can't animate (e.g. Pixi) — fall back to the plain ping.
        if (!canvas.animateTraversal) {
          canvas.triggerPing?.(newIds);
          return;
        }
        // Adjacency over the *visible* graph, both directions.
        const adjacency = new Map<string, { neighbor: string }[]>();
        for (const link of filteredGraphDataRef.current.links) {
          const s = endpointKey(link.source);
          const t = endpointKey(link.target);
          if (!adjacency.has(s)) adjacency.set(s, []);
          if (!adjacency.has(t)) adjacency.set(t, []);
          adjacency.get(s)!.push({ neighbor: t });
          adjacency.get(t)!.push({ neighbor: s });
        }
        const priorIds = new Set(allIds);
        for (const id of newIds) priorIds.delete(id);
        const { legs, orphans } = computeTraversalLegs(
          adjacency,
          newIds,
          priorIds,
        );
        canvas.animateTraversal(legs, orphans);
      },
      clearChatTraversal: () => {
        canvasRef.current?.clearTraversal?.();
      },
      resetCamera: () => {
        canvasRef.current?.resetCamera();
      },
      zoomToFit: (duration?: number) => {
        canvasRef.current?.zoomToFit(duration);
      },
      reload: (query?: string, hopsArg?: number) => loadGraph(query, hopsArg),
    }),
    [onNodeClick, setHops, loadGraph],
  );

  return {
    canvasRef,
    graphDataRef,
    settings,
    toolbar,
    legendNodeItems,
    legendCommunityItems,
    legendItems,
    legendLinkItems,
    onNodeClick,
    onLinkClick,
    onStageClick,
    highlightProps,
    layoutConfig,
    isEmpty,
    isSearchEmpty,
    buildImperativeHandle,
  };
}
