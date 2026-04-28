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
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type {
  FilterState,
  GraphLink,
  GraphNode,
  SelectedEdge,
  SelectedNode,
} from '@opentrace/components/utils';
import {
  DEFAULT_LAYOUT_CONFIG,
  getNodeColor,
  useCommunities,
  useHighlights,
} from '@opentrace/components';
import type { HistoryEntry } from '../appComponents/historyTypes';
import { useGraph } from './GraphDataProvider';
import { getSubType, linkId } from './graphFilterUtils';

type ColorMode = 'type' | 'community';

const EMPTY_NODE_SET: Set<string> = Object.freeze(
  new Set<string>(),
) as Set<string>;

export interface AvailableType {
  type: string;
  count: number;
}

export interface AvailableSubType {
  subType: string;
  count: number;
}

export interface AvailableCommunity {
  communityId: number;
  label: string;
  count: number;
  color: string;
}

export type CommunityData = ReturnType<typeof useCommunities>;
export type HighlightsResult = ReturnType<typeof useHighlights>;

export interface GraphInteractionState {
  // Selection
  selectedNode: SelectedNode | null;
  selectedLink: SelectedEdge | null;
  setSelectedNode: Dispatch<SetStateAction<SelectedNode | null>>;
  setSelectedLink: Dispatch<SetStateAction<SelectedEdge | null>>;
  /** Select a node and record it in history. Pass `null` to deselect. */
  selectNode: (node: SelectedNode | null) => void;
  /** Select a link (edge). Pass `null` to deselect. */
  selectLink: (edge: SelectedEdge | null) => void;
  /** Clear both selections. */
  clearSelection: () => void;

  // History
  nodeHistory: HistoryEntry[];
  setNodeHistory: Dispatch<SetStateAction<HistoryEntry[]>>;

  // Filter state
  hiddenNodeTypes: Set<string>;
  hiddenLinkTypes: Set<string>;
  hiddenSubTypes: Set<string>;
  hiddenCommunities: Set<number>;
  setHiddenNodeTypes: Dispatch<SetStateAction<Set<string>>>;
  setHiddenLinkTypes: Dispatch<SetStateAction<Set<string>>>;
  setHiddenSubTypes: Dispatch<SetStateAction<Set<string>>>;
  setHiddenCommunities: Dispatch<SetStateAction<Set<number>>>;
  filterState: FilterState;

  // Color mode
  colorMode: ColorMode;
  setColorMode: Dispatch<SetStateAction<ColorMode>>;

  // Search / hops (toolbar-driven, but read by highlights and SidePanel)
  searchQuery: string;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  hops: number;
  setHops: Dispatch<SetStateAction<number>>;

  // Community-focus highlight (set by toolbar suggestions / filter panel)
  focusedCommunityNodes: Set<string>;
  setFocusedCommunityNodes: Dispatch<SetStateAction<Set<string>>>;
  /** Focus all nodes in a community (also clears selection). */
  focusCommunity: (communityId: number) => void;

  // Derived (memoized) — computed once here, read by both GraphViewer and SidePanel
  availableNodeTypes: AvailableType[];
  availableLinkTypes: AvailableType[];
  availableSubTypes: Map<string, AvailableSubType[]>;
  availableCommunities: AvailableCommunity[];
  communityData: CommunityData;
  filteredGraphData: { nodes: GraphNode[]; links: GraphLink[] };
  highlights: HighlightsResult;
  /** Map of node ID → hop distance from selected node. Empty when an edge is selected. */
  hopMap: Map<string, number>;
  /** All node IDs currently in the loaded graph (unfiltered). */
  graphNodeIds: string[];
}

const GraphInteractionContext = createContext<GraphInteractionState | null>(
  null,
);

interface GraphInteractionProviderProps {
  children: ReactNode;
  /**
   * When provided, the provider exposes this value directly instead of
   * deriving everything from `useGraph()`. Use for apps that own their
   * own selection / filter / community / highlight machinery (e.g. a
   * Neo4j-backed viewer with granularity-aware data) and just want
   * downstream consumers like `SidePanel` to read it via the standard
   * context.
   *
   * The presence/absence of `value` must be stable for a given mounted
   * provider — don't toggle between modes after mount.
   */
  value?: GraphInteractionState;
}

export function GraphInteractionProvider({
  children,
  value,
}: GraphInteractionProviderProps) {
  if (value !== undefined) {
    return (
      <GraphInteractionContext.Provider value={value}>
        {children}
      </GraphInteractionContext.Provider>
    );
  }
  return (
    <InternalGraphInteractionProvider>
      {children}
    </InternalGraphInteractionProvider>
  );
}

function InternalGraphInteractionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { graphData, graphVersion } = useGraph();

  // Selection
  const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(null);
  const [selectedLink, setSelectedLink] = useState<SelectedEdge | null>(null);

  // History
  const [nodeHistory, setNodeHistory] = useState<HistoryEntry[]>([]);

  // Filter state
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState(new Set<string>());
  const [hiddenLinkTypes, setHiddenLinkTypes] = useState(new Set<string>());
  const [hiddenSubTypes, setHiddenSubTypes] = useState(new Set<string>());
  const [hiddenCommunities, setHiddenCommunities] = useState(new Set<number>());

  // Color mode
  const [colorMode, setColorMode] = useState<ColorMode>('type');

  // Search / hops
  const [searchQuery, setSearchQuery] = useState('');
  const [hops, setHops] = useState(2);

  // Community focus
  const [focusedCommunityNodes, setFocusedCommunityNodes] =
    useState<Set<string>>(EMPTY_NODE_SET);

  // ─── Derived: available types ────────────────────────────────────────
  const availableNodeTypes = useMemo<AvailableType[]>(() => {
    const counts: Record<string, number> = {};
    graphData.nodes.forEach((n) => {
      counts[n.type] = (counts[n.type] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [graphData.nodes]);

  const availableLinkTypes = useMemo<AvailableType[]>(() => {
    const counts: Record<string, number> = {};
    graphData.links.forEach((l) => {
      const label = (l as unknown as GraphLink).label || 'unknown';
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [graphData.links]);

  const availableSubTypes = useMemo<Map<string, AvailableSubType[]>>(() => {
    const map = new Map<string, Record<string, number>>();
    graphData.nodes.forEach((n) => {
      const sub = getSubType(n);
      if (!sub) return;
      if (!map.has(n.type)) map.set(n.type, {});
      const counts = map.get(n.type)!;
      counts[sub] = (counts[sub] || 0) + 1;
    });
    const result = new Map<string, AvailableSubType[]>();
    map.forEach((counts, type) => {
      result.set(
        type,
        Object.entries(counts)
          .map(([subType, count]) => ({ subType, count }))
          .sort((a, b) => b.count - a.count),
      );
    });
    return result;
  }, [graphData.nodes]);

  // ─── First-load defaults: hide Dependency sub-types ──────────────────
  // Runs once per successful graph load (graphVersion bump). Tracks the
  // last applied version so re-loads (e.g. switching repositories or
  // re-indexing) re-apply the defaults — the original ref-only flag was
  // session-scoped, which broke for the second repo a user opened.
  const lastDefaultsVersion = useRef(0);
  useEffect(() => {
    if (graphVersion === 0) return;
    if (lastDefaultsVersion.current === graphVersion) return;
    const depSubs = availableSubTypes.get('Dependency');
    if (!depSubs || depSubs.length === 0) return;
    lastDefaultsVersion.current = graphVersion;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time-per-load default init
    setHiddenSubTypes((prev) => {
      const next = new Set(prev);
      depSubs.forEach((s) => next.add(`Dependency:${s.subType}`));
      return next;
    });
  }, [graphVersion, availableSubTypes]);

  // ─── Derived: communities (Louvain) ──────────────────────────────────
  const communityData = useCommunities(
    graphData.nodes,
    graphData.links,
    DEFAULT_LAYOUT_CONFIG,
  );

  const availableCommunities = useMemo<AvailableCommunity[]>(() => {
    const counts: Record<number, number> = {};
    for (const n of graphData.nodes) {
      const cid = communityData.assignments[n.id];
      if (cid !== undefined) counts[cid] = (counts[cid] || 0) + 1;
    }
    return Object.entries(counts)
      .map(([cidStr, count]) => {
        const cid = Number(cidStr);
        return {
          communityId: cid,
          label: communityData.names.get(cid) ?? `Community ${cid}`,
          count,
          color: communityData.colorMap.get(cid) ?? getNodeColor('Unknown'),
        };
      })
      .sort((a, b) => b.count - a.count);
  }, [graphData.nodes, communityData]);

  // ─── Derived: filtered graph (canvas-rendered) ───────────────────────
  const filteredGraphData = useMemo(() => {
    const nodes = graphData.nodes.filter((n) => {
      if (hiddenCommunities.size > 0) {
        const cid = communityData.assignments[n.id];
        if (cid !== undefined && hiddenCommunities.has(cid)) return false;
      }
      const hasSubTypeFilters = availableSubTypes.has(n.type);
      if (hasSubTypeFilters) {
        const sub = getSubType(n);
        if (sub) {
          return !hiddenSubTypes.has(`${n.type}:${sub}`);
        }
        const subs = availableSubTypes.get(n.type)!;
        const allHidden = subs.every((s) =>
          hiddenSubTypes.has(`${n.type}:${s.subType}`),
        );
        return !allHidden;
      }
      return !hiddenNodeTypes.has(n.type);
    });
    const visibleNodeIds = new Set(nodes.map((n) => n.id));
    const links = graphData.links.filter((l) => {
      const sourceId = linkId(l.source);
      const targetId = linkId(l.target);
      const label = (l as unknown as GraphLink).label || 'unknown';
      return (
        visibleNodeIds.has(sourceId) &&
        visibleNodeIds.has(targetId) &&
        !hiddenLinkTypes.has(label)
      );
    });
    return { nodes, links };
  }, [
    graphData,
    hiddenNodeTypes,
    hiddenLinkTypes,
    hiddenSubTypes,
    hiddenCommunities,
    communityData.assignments,
    availableSubTypes,
  ]);

  const filterState = useMemo<FilterState>(
    () => ({
      hiddenNodeTypes,
      hiddenLinkTypes,
      hiddenSubTypes,
      hiddenCommunities,
    }),
    [hiddenNodeTypes, hiddenLinkTypes, hiddenSubTypes, hiddenCommunities],
  );

  const graphNodeIds = useMemo(
    () => graphData.nodes.map((n) => n.id as string),
    [graphData.nodes],
  );

  // ─── Highlights (used by canvas + Discover panel hop colouring) ───────
  const highlights = useHighlights(
    null as never, // _graph — unused
    false, // _layoutReady — unused
    graphData.nodes,
    graphData.links,
    searchQuery,
    selectedNode?.id ?? null,
    hops,
    filterState,
  );

  const hopMap = useMemo(() => {
    if (selectedLink) return new Map<string, number>();
    return highlights.hopMap;
  }, [selectedLink, highlights.hopMap]);

  // ─── Selection helpers ───────────────────────────────────────────────
  // selectNode / selectLink also clear any community focus — selection
  // takes precedence over a focused community group.
  const selectNode = useCallback((node: SelectedNode | null) => {
    setSelectedNode(node);
    setSelectedLink(null);
    setFocusedCommunityNodes(EMPTY_NODE_SET);
    if (!node) return;
    // Record in session history (skip consecutive duplicates)
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
  }, []);

  const selectLink = useCallback((edge: SelectedEdge | null) => {
    setSelectedLink(edge);
    setSelectedNode(null);
    setFocusedCommunityNodes(EMPTY_NODE_SET);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedNode(null);
    setSelectedLink(null);
  }, []);

  const focusCommunity = useCallback(
    (cid: number) => {
      const nodeIds = Object.entries(communityData.assignments)
        .filter(([, id]) => id === cid)
        .map(([nodeId]) => nodeId);
      if (nodeIds.length > 0) {
        setFocusedCommunityNodes(new Set(nodeIds));
        setSelectedNode(null);
        setSelectedLink(null);
      }
    },
    [communityData.assignments],
  );

  const value = useMemo<GraphInteractionState>(
    () => ({
      selectedNode,
      selectedLink,
      setSelectedNode,
      setSelectedLink,
      selectNode,
      selectLink,
      clearSelection,
      nodeHistory,
      setNodeHistory,
      hiddenNodeTypes,
      hiddenLinkTypes,
      hiddenSubTypes,
      hiddenCommunities,
      setHiddenNodeTypes,
      setHiddenLinkTypes,
      setHiddenSubTypes,
      setHiddenCommunities,
      filterState,
      colorMode,
      setColorMode,
      searchQuery,
      setSearchQuery,
      hops,
      setHops,
      focusedCommunityNodes,
      setFocusedCommunityNodes,
      focusCommunity,
      availableNodeTypes,
      availableLinkTypes,
      availableSubTypes,
      availableCommunities,
      communityData,
      filteredGraphData,
      highlights,
      hopMap,
      graphNodeIds,
    }),
    [
      selectedNode,
      selectedLink,
      selectNode,
      selectLink,
      clearSelection,
      nodeHistory,
      hiddenNodeTypes,
      hiddenLinkTypes,
      hiddenSubTypes,
      hiddenCommunities,
      filterState,
      colorMode,
      searchQuery,
      hops,
      focusedCommunityNodes,
      focusCommunity,
      availableNodeTypes,
      availableLinkTypes,
      availableSubTypes,
      availableCommunities,
      communityData,
      filteredGraphData,
      highlights,
      hopMap,
      graphNodeIds,
    ],
  );

  return (
    <GraphInteractionContext.Provider value={value}>
      {children}
    </GraphInteractionContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components -- co-located hook + provider
export function useGraphInteraction(): GraphInteractionState {
  const ctx = useContext(GraphInteractionContext);
  if (!ctx) {
    throw new Error(
      'useGraphInteraction must be used within a GraphInteractionProvider',
    );
  }
  return ctx;
}
