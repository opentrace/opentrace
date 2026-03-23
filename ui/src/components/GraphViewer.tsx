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
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  GraphNode,
  GraphLink,
  SelectedNode,
  SelectedEdge,
  FilterState,
} from '@opentrace/components/utils';
import {
  getNodeColor,
  getLinkColor,
  useCommunities,
  useHighlights,
} from '@opentrace/components/utils';
import {
  PixiGraphCanvas,
  GraphLegend,
  GraphToolbar,
  PhysicsPanel,
  type GraphCanvasHandle,
  type FilterItem,
  type FilterPanelProps,
  DEFAULT_LAYOUT_CONFIG,
  type OptimizeStatus,
} from '@opentrace/components';
import type { NodeSourceResponse } from '../store/types';
import { useStore } from '../store';
import { useGraphData } from '../hooks/useGraphData';
import type { JobState } from '../job';
import type { JobMessage } from '../job';
import { JobPhase } from '../job';
import {
  AddRepoModal,
  IndexingProgress,
  detectProvider,
  normalizeRepoUrl,
  type IndexingState,
} from '@opentrace/components';
import { GitHubIcon, GitLabIcon } from './providerIcons';
import JobMinimizedBar from './JobMinimizedBar';
import SidePanel from './SidePanel';
import type { SidePanelTab } from './SidePanel';
import ThemeSelector from './ThemeSelector';
import { OpenTraceLogo } from './OpenTraceLogo';
import ResetConfirmModal from './ResetConfirmModal';

const INDEXING_STAGES = [
  { key: String(JobPhase.JOB_PHASE_INITIALIZING), label: 'Initializing' },
  { key: String(JobPhase.JOB_PHASE_FETCHING), label: 'Fetching files' },
  { key: String(JobPhase.JOB_PHASE_PARSING), label: 'Files & symbols' },
  { key: String(JobPhase.JOB_PHASE_RESOLVING), label: 'Call resolution' },
  { key: String(JobPhase.JOB_PHASE_SUMMARIZING), label: 'Summarizing' },
  { key: String(JobPhase.JOB_PHASE_SUBMITTING), label: 'Persisting graph' },
  { key: String(JobPhase.JOB_PHASE_EMBEDDING), label: 'Generating embeddings' },
];

/** Map app-specific JobState to the generic IndexingState + title/message. */
function toIndexingProps(job: JobState, repoUrl: string) {
  let status: IndexingState['status'];
  let title: string | undefined;
  let message: string | undefined;

  switch (job.status) {
    case 'persisted':
      status = 'done';
      title = 'Indexing Complete';
      message = 'Loading graph...';
      break;
    case 'enriching':
      status = 'running';
      title = 'Enriching Repository';
      break;
    default:
      status = job.status;
  }

  const state: IndexingState = {
    status,
    nodesCreated: job.nodesCreated,
    relationshipsCreated: job.relationshipsCreated,
    error: job.error,
    stages: job.stages as Record<string, IndexingState['stages'][string]>,
  };

  const provider = detectProvider(repoUrl);
  const icon =
    provider === 'gitlab' ? <GitLabIcon /> : provider ? <GitHubIcon /> : null;

  return { state, title, message, icon };
}

/** Node types whose source code can be fetched and displayed. */
const SOURCE_TYPES = new Set(['File', 'Function', 'Class', 'PullRequest']);
// WARNING: Module-level singleton — do NOT mutate (add/delete). Used as a
// stable empty default for highlight props to avoid unnecessary re-renders.
const EMPTY_SET: Set<string> = Object.freeze(new Set<string>()) as Set<string>;

/**
 * Extract a sub-type value from a node based on its type.
 * Returns null if no meaningful sub-type can be derived.
 */
function getSubType(node: GraphNode): string | null {
  if (node.type === 'File') {
    const name = node.name || node.id;
    const lastDot = name.lastIndexOf('.');
    if (lastDot > 0) return name.slice(lastDot); // e.g. ".ts", ".go"
    return null;
  }
  if (node.type === 'Function' || node.type === 'Class') {
    const lang = node.properties?.language as string | undefined;
    return lang || null;
  }
  if (node.type === 'Package') {
    const registry = node.properties?.registry as string | undefined;
    return registry || null;
  }
  return null;
}

/**
 * Extract the string ID from a link endpoint.
 * GraphLink endpoints are always strings in our data model,
 * but we keep this helper for safety.
 */
function linkId(endpoint: string | number | GraphNode | undefined): string {
  if (typeof endpoint === 'object' && endpoint !== null) return endpoint.id;
  return String(endpoint);
}

// GraphLegend is now imported from @opentrace/components

export interface GraphViewerHandle {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  selectNode: (nodeId: string, hops?: number) => void;
  reload: (query?: string, hops?: number) => Promise<void>;
}

export interface GraphViewerProps {
  width: number;
  height: number;
  // Job (App owns state, GraphViewer renders UI)
  jobState: JobState;
  activeRepoUrl: string;
  jobExpanded: boolean;
  onJobClose: () => void;
  onJobCancel: () => void;
  onJobMinimize: () => void;
  onJobExpand: () => void;
  // Add repo modal
  showAddRepo: boolean;
  onAddRepoOpen: () => void;
  onAddRepoClose: () => void;
  onJobSubmit: (message: JobMessage) => void;
  // Toolbar toggles
  showChat: boolean;
  chatWidth: number;
  onToggleChat: () => void;
  showSettings: boolean;
  onToggleSettings: () => void;
  /** Called when graphData changes so parent can pass it reactively to siblings */
  onGraphDataChange?: (data: {
    nodes: GraphNode[];
    links: GraphLink[];
  }) => void;
  /** Animation settings from SettingsDrawer */
  animationSettings?: import('@opentrace/components').AnimationSettings;
}

const GraphViewer = memo(
  forwardRef<GraphViewerHandle, GraphViewerProps>(
    function GraphViewer(props, ref) {
      const {
        width,
        height,
        jobState,
        activeRepoUrl,
        jobExpanded,
        onJobClose,
        onJobCancel,
        onJobMinimize,
        onJobExpand,
        showAddRepo,
        onAddRepoOpen,
        onAddRepoClose,
        onJobSubmit,
        showChat,
        chatWidth,
        onToggleChat,
        showSettings,
        onToggleSettings,
        onGraphDataChange,
        animationSettings,
      } = props;

      const { store } = useStore();
      const canvasRef = useRef<GraphCanvasHandle>(null);

      // Fetch indexed repos when the add-repo modal opens (for duplicate detection)
      interface IndexedRepo {
        name: string;
        url: string;
      }
      const [indexedRepos, setIndexedRepos] = useState<IndexedRepo[]>([]);
      useEffect(() => {
        if (!showAddRepo) return;
        let cancelled = false;
        store
          .listNodes('Repository')
          .then((nodes) => {
            if (cancelled) return;
            setIndexedRepos(
              nodes
                .filter((n) => n.properties?.source_uri || n.properties?.url)
                .map((n) => ({
                  name: n.name,
                  url: (n.properties!.source_uri ??
                    n.properties!.url) as string,
                })),
            );
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [showAddRepo, store]);

      const validateRepo = useCallback(
        (url: string): string | null => {
          if (indexedRepos.length === 0) return null;
          const normalized = normalizeRepoUrl(url).toLowerCase();
          const match = indexedRepos.find(
            (r) => normalizeRepoUrl(r.url).toLowerCase() === normalized,
          );
          return match ? `${match.name} is already indexed` : null;
        },
        [indexedRepos],
      );

      const onGraphLoaded = useCallback(() => {
        setTimeout(() => {
          canvasRef.current?.zoomToFit(400);
        }, 500);
      }, []);

      const {
        graphData,
        loading,
        error,
        stats,
        lastSearchQuery,
        graphVersion,
        loadGraph,
        setError,
      } = useGraphData(onGraphLoaded);

      // Keep a ref to latest graphData so imperative selectNode always reads fresh data
      const graphDataRef = useRef(graphData);
      useEffect(() => {
        graphDataRef.current = graphData;
      }, [graphData]);

      // Notify parent when graphData changes (for reactive sibling props like ChatPanel)
      useEffect(() => {
        onGraphDataChange?.(graphData);
      }, [graphData, onGraphDataChange]);

      const [selectedNode, setSelectedNode] = useState<SelectedNode | null>(
        null,
      );
      const [selectedLink, setSelectedLink] = useState<SelectedEdge | null>(
        null,
      );
      const [searchQuery, setSearchQuery] = useState('');
      const [showResetConfirm, setShowResetConfirm] = useState(false);
      const [mobilePanelTab, setMobilePanelTab] = useState<SidePanelTab | null>(
        null,
      );
      const [hops, setHops] = useState(2);
      const [hiddenNodeTypes, setHiddenNodeTypes] = useState(new Set<string>());
      const [hiddenLinkTypes, setHiddenLinkTypes] = useState(new Set<string>());
      const [hiddenSubTypes, setHiddenSubTypes] = useState(new Set<string>());
      const [hiddenCommunities, setHiddenCommunities] = useState(
        new Set<number>(),
      );
      // Track whether we've applied the default Package hiding
      const defaultsApplied = useRef(false);
      const [nodeSource, setNodeSource] = useState<NodeSourceResponse | null>(
        null,
      );
      const [sourceLoading, setSourceLoading] = useState(false);
      const [sourceError, setSourceError] = useState<string | null>(null);

      const pendingMinimize = useRef(false);
      const minimizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
        null,
      );

      // Edge-click highlight override state
      const [edgeHighlightNodes, setEdgeHighlightNodes] = useState<Set<string>>(
        new Set(),
      );
      const [edgeHighlightLinks, setEdgeHighlightLinks] = useState<Set<string>>(
        new Set(),
      );
      const [edgeLabelNodes, setEdgeLabelNodes] = useState<Set<string>>(
        new Set(),
      );

      // Community-focus highlight override state
      const [focusedCommunityNodes, setFocusedCommunityNodes] =
        useState<Set<string>>(EMPTY_SET);

      // Optimize status (from GraphCanvas callback)
      const [optimizeStatus, setOptimizeStatus] =
        useState<OptimizeStatus | null>(null);

      // Physics panel state
      const [showPhysicsPanel, setShowPhysicsPanel] = useState(false);
      // Persisted graph settings — restored from localStorage on mount
      const stored = useMemo(() => {
        try {
          return JSON.parse(
            localStorage.getItem('graph-settings') ?? '{}',
          ) as Record<string, unknown>;
        } catch {
          return {};
        }
      }, []);
      const ps = <T,>(key: string, def: T): T => (stored[key] as T) ?? def;
      const [zoomOnSelect, setZoomOnSelect] = useState(() =>
        ps('zoomOnSelect', true),
      );
      const [repulsion, setRepulsion] = useState(() => ps('repulsion', 120));
      const [labelsVisible, setLabelsVisible] = useState(() =>
        ps('labelsVisible', true),
      );
      const [physicsRunning, setPhysicsRunning] = useState(false);
      // Pixi-specific control state
      const [pixiLinkDist, setPixiLinkDist] = useState(() =>
        ps('pixiLinkDist', 200),
      );
      const [pixiCenter, setPixiCenter] = useState(() => ps('pixiCenter', 0.3));
      const [pixiZoomExponent, setPixiZoomExponent] = useState(() =>
        ps('pixiZoomExponent', 0.8),
      );
      // Layout mode + compact-specific config
      const [layoutMode, setLayoutMode] = useState<'spread' | 'compact'>(() =>
        ps('layoutMode', 'spread'),
      );
      const [compactRadial, setCompactRadial] = useState(() =>
        ps('compactRadial', 8),
      );
      const [compactCommunity, setCompactCommunity] = useState(() =>
        ps('compactCommunity', 10),
      );
      const [compactCentering, setCompactCentering] = useState(() =>
        ps('compactCentering', 5),
      );
      const [compactRadius, setCompactRadius] = useState(() =>
        ps('compactRadius', 32),
      );

      // Persist settings to localStorage when they change
      useEffect(() => {
        const settings = {
          repulsion,
          labelsVisible,
          zoomOnSelect,
          pixiLinkDist,
          pixiCenter,
          pixiZoomExponent,
          layoutMode,
          compactRadial,
          compactCommunity,
          compactCentering,
          compactRadius,
        };
        localStorage.setItem('graph-settings', JSON.stringify(settings));
      }, [
        repulsion,
        labelsVisible,
        zoomOnSelect,
        pixiLinkDist,
        pixiCenter,
        pixiZoomExponent,
        layoutMode,
        compactRadial,
        compactCommunity,
        compactCentering,
        compactRadius,
      ]);

      // React to persisted: load the graph, then auto-minimize after a brief delay
      useEffect(() => {
        if (jobState.status === 'persisted') {
          loadGraph()
            .then(() => {
              pendingMinimize.current = true;
            })
            .catch(() => {
              // Graph load failed — don't set pendingMinimize
            });
        }
      }, [jobState.status, loadGraph]);

      // React to done: final graph refresh with enriched data
      useEffect(() => {
        if (jobState.status === 'done') {
          loadGraph();
        }
      }, [jobState.status, loadGraph]);

      const handleSearch = () => {
        if (searchQuery.trim()) {
          loadGraph(searchQuery.trim(), hops);
        }
      };

      const handleReset = () => {
        setSearchQuery('');
        setHops(2);
        setSelectedNode(null);
        setSelectedLink(null);
        if (lastSearchQuery) {
          loadGraph();
        }
      };

      const layoutConfig = useMemo(
        () => ({
          ...DEFAULT_LAYOUT_CONFIG,
          fa2ScalingRatio: repulsion,
        }),
        [repulsion],
      );

      // Compute Louvain communities on the full graph (before filtering, so
      // community assignments are available for the community filter).
      const communityData = useCommunities(
        graphData.nodes,
        graphData.links,
        layoutConfig,
      );

      // Derive available types from raw graph data (for filter panel)
      const availableNodeTypes = useMemo(() => {
        const counts: Record<string, number> = {};
        graphData.nodes.forEach((n) => {
          counts[n.type] = (counts[n.type] || 0) + 1;
        });
        return Object.entries(counts)
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count);
      }, [graphData.nodes]);

      const availableLinkTypes = useMemo(() => {
        const counts: Record<string, number> = {};
        graphData.links.forEach((l) => {
          const label = (l as unknown as GraphLink).label || 'unknown';
          counts[label] = (counts[label] || 0) + 1;
        });
        return Object.entries(counts)
          .map(([type, count]) => ({ type, count }))
          .sort((a, b) => b.count - a.count);
      }, [graphData.links]);

      // Derive sub-type counts grouped by node type (for filter panel)
      const availableSubTypes = useMemo(() => {
        const map = new Map<string, Record<string, number>>();
        graphData.nodes.forEach((n) => {
          const sub = getSubType(n);
          if (!sub) return;
          if (!map.has(n.type)) map.set(n.type, {});
          const counts = map.get(n.type)!;
          counts[sub] = (counts[sub] || 0) + 1;
        });
        const result = new Map<string, { subType: string; count: number }[]>();
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

      // On first data load, hide all Package sub-types by default
      useEffect(() => {
        if (defaultsApplied.current) return;
        const pkgSubs = availableSubTypes.get('Package');
        if (pkgSubs && pkgSubs.length > 0) {
          defaultsApplied.current = true;
          // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional one-time default init
          setHiddenSubTypes((prev) => {
            const next = new Set(prev);
            pkgSubs.forEach((s) => next.add(`Package:${s.subType}`));
            return next;
          });
        }
      }, [availableSubTypes]);

      // Apply type + sub-type + community filters to produce the rendered graph.
      const filteredGraphData = useMemo(() => {
        const nodes = graphData.nodes.filter((n) => {
          // Community filter (when any communities are hidden)
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

      // Build filterState for the new hooks
      const filterState: FilterState = useMemo(
        () => ({
          hiddenNodeTypes,
          hiddenLinkTypes,
          hiddenSubTypes,
          hiddenCommunities,
        }),
        [hiddenNodeTypes, hiddenLinkTypes, hiddenSubTypes, hiddenCommunities],
      );

      const onNodeClick = useCallback(
        (node: GraphNode) => {
          setSelectedNode(node);
          setSelectedLink(null);
          // Clear edge-click and community-focus highlights (use stable empty sets)
          setEdgeHighlightNodes(EMPTY_SET);
          setEdgeHighlightLinks(EMPTY_SET);
          setEdgeLabelNodes(EMPTY_SET);
          setFocusedCommunityNodes(EMPTY_SET);
          if (zoomOnSelect) {
            canvasRef.current?.zoomToNodes([node.id], 600);
          }
        },
        [zoomOnSelect],
      );

      const onCommunityFocus = useCallback(
        (key: string) => {
          const cid = Number(key);
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

      // Zoom camera to focused community nodes when they change
      useEffect(() => {
        if (focusedCommunityNodes.size > 0) {
          canvasRef.current?.zoomToNodes(focusedCommunityNodes, 600);
        }
      }, [focusedCommunityNodes]);

      // Expose imperative handle for parent/sibling access
      useImperativeHandle(
        ref,
        () => ({
          graphData,
          selectNode: (nodeId: string, nodeHops?: number) => {
            if (nodeHops !== undefined) setHops(nodeHops);
            const node = graphDataRef.current.nodes.find(
              (n) => n.id === nodeId,
            );
            if (node) onNodeClick(node);
          },
          reload: (query?: string, hops?: number) => loadGraph(query, hops),
        }),
        [graphData, loadGraph, onNodeClick],
      );

      const onLinkClick = useCallback((edge: SelectedEdge) => {
        setSelectedLink(edge);
        setSelectedNode(null);
        // Highlight the two endpoints and the clicked link
        const sourceId = edge.source;
        const targetId = edge.target;
        setEdgeHighlightNodes(new Set([sourceId, targetId]));
        setEdgeHighlightLinks(new Set([`${sourceId}-${targetId}`]));
        setEdgeLabelNodes(new Set([sourceId, targetId]));
        // Zoom to fit the two endpoints
        canvasRef.current?.zoomToNodes([sourceId, targetId], 600);
      }, []);

      // Fetch source code when a source-bearing node is selected.
      /* eslint-disable react-hooks/set-state-in-effect -- async fetch pattern with cleanup */
      useEffect(() => {
        if (!selectedNode || !SOURCE_TYPES.has(selectedNode.type)) {
          setNodeSource(null);
          setSourceError(null);
          return;
        }

        let cancelled = false;
        setSourceLoading(true);
        setSourceError(null);
        setNodeSource(null);

        const startLine = selectedNode.properties?.start_line as
          | number
          | undefined;
        const endLine = selectedNode.properties?.end_line as number | undefined;

        store
          .fetchSource(selectedNode.id, startLine, endLine)
          .then((src) => {
            if (!cancelled) {
              if (src) setNodeSource(src);
              else setSourceError('Source not available');
            }
          })
          .catch((err) => {
            if (!cancelled) setSourceError(err.message);
          })
          .finally(() => {
            if (!cancelled) setSourceLoading(false);
          });

        return () => {
          cancelled = true;
        };
      }, [selectedNode?.id, store]); // eslint-disable-line react-hooks/exhaustive-deps
      /* eslint-enable react-hooks/set-state-in-effect */

      // Compute degree (connection count) per node for size scaling
      const graphNodeIds = useMemo(
        () => graphData.nodes.map((n) => n.id as string),
        [graphData.nodes],
      );

      const [colorMode, setColorMode] = useState<'type' | 'community'>('type');

      // ─── Highlights (computed from arrays) ────────────────────────────

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

      const legendNodeItems = useMemo(() => {
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

      // Derive available communities from raw graph data (for filter panel)
      const availableCommunities = useMemo(() => {
        const counts = new Map<number, number>();
        for (const n of graphData.nodes) {
          const cid = communityData.assignments[n.id];
          if (cid !== undefined) {
            counts.set(cid, (counts.get(cid) || 0) + 1);
          }
        }
        return [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([cid, count]) => ({
            communityId: cid,
            label: communityData.names.get(cid) ?? `Community ${cid}`,
            count,
            color: communityData.colorMap.get(cid) ?? '#64748b',
          }));
      }, [graphData.nodes, communityData]);

      const legendCommunityItems = useMemo(() => {
        if (colorMode !== 'community') return [];
        // Group filtered nodes by community
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

      const legendLinkItems = useMemo(() => {
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

      // Determine whether to show the full indexing progress modal
      const showFullModal =
        jobState.status === 'running' ||
        jobState.status === 'persisted' ||
        jobState.status === 'error' ||
        ((jobState.status === 'enriching' || jobState.status === 'done') &&
          jobExpanded);

      const graphWidth = showChat ? width - chatWidth : width;

      const isEmpty = graphData.nodes.length === 0;
      const isSearchEmpty = isEmpty && !!lastSearchQuery;

      // Auto-minimize once graph data has arrived (bridges "Loading graph..." modal
      // to the "Computing layout" overlay without flashing "no data").
      useEffect(() => {
        if (pendingMinimize.current && !isEmpty) {
          pendingMinimize.current = false;
          minimizeTimeoutRef.current = setTimeout(() => {
            minimizeTimeoutRef.current = null;
            onJobMinimize();
          }, 500);
        }
        return () => {
          if (minimizeTimeoutRef.current) {
            clearTimeout(minimizeTimeoutRef.current);
            minimizeTimeoutRef.current = null;
          }
        };
      }, [isEmpty, onJobMinimize]);

      // Auto-open the Add Repo modal when the graph is empty and idle
      useEffect(() => {
        if (
          isEmpty &&
          !isSearchEmpty &&
          !loading &&
          jobState.status === 'idle'
        ) {
          onAddRepoOpen();
        }
      }, [isEmpty, isSearchEmpty, loading, jobState.status, onAddRepoOpen]);

      const handleStageClick = useCallback(() => {
        setSelectedNode(null);
        setSelectedLink(null);
        // Clear edge-click and community-focus highlights
        setEdgeHighlightNodes(EMPTY_SET);
        setEdgeHighlightLinks(EMPTY_SET);
        setFocusedCommunityNodes(EMPTY_SET);
        setEdgeLabelNodes(EMPTY_SET);
      }, []);

      // --- Early returns for loading/error/empty states ---

      if (loading && !showAddRepo && !showFullModal) {
        return (
          <div className="graph-viewport">
            <div className="loading">
              <OpenTraceLogo size={64} />
              <span>Loading graph...</span>
              <footer className="version-footer">
                v{__APP_VERSION__} &middot;{' '}
                {new Date(__BUILD_TIME__).toLocaleString()}
              </footer>
            </div>
          </div>
        );
      }

      if (error) {
        return (
          <div className="graph-viewport">
            <div className="loading">
              <p>Failed to load graph: {error}</p>
              <button
                onClick={() => {
                  setError(null);
                  loadGraph();
                }}
              >
                Retry
              </button>
              <footer className="version-footer">
                v{__APP_VERSION__} &middot;{' '}
                {new Date(__BUILD_TIME__).toLocaleString()}
              </footer>
            </div>
          </div>
        );
      }

      if (isSearchEmpty && !showFullModal) {
        return (
          <div className="graph-viewport">
            <div className="empty-state-overlay">
              <div className="empty-state-content">
                <img
                  src="/opentrace-logo.svg"
                  alt="OpenTrace"
                  className="empty-state-logo"
                />
                <h1>No results</h1>
                <p>
                  No nodes matched <strong>{lastSearchQuery}</strong>. Try a
                  different search or clear to see the full graph.
                </p>
                <button className="empty-state-add-btn" onClick={handleReset}>
                  Clear Search
                </button>
              </div>
            </div>
            <footer className="copyright-footer">
              &copy; {new Date().getFullYear()} OpenTrace
            </footer>
            <footer className="version-footer">
              v{__APP_VERSION__} &middot;{' '}
              {new Date(__BUILD_TIME__).toLocaleString()}
            </footer>
          </div>
        );
      }

      if (isEmpty && !showFullModal) {
        return (
          <div className="graph-viewport">
            <div className="empty-state-header">
              <img
                src="/opentrace-logo.svg"
                alt="OpenTrace"
                className="empty-state-header-logo"
              />
              <span className="empty-state-header-title">OpenTrace</span>
            </div>

            {showAddRepo && (
              <AddRepoModal
                onClose={onAddRepoClose}
                onSubmit={onJobSubmit}
                dismissable={false}
                onValidate={validateRepo}
              />
            )}

            {!showAddRepo && (
              <div className="empty-state-overlay">
                <div className="empty-state-content">
                  <p>No data in the graph yet.</p>
                  <button
                    className="empty-state-add-btn"
                    onClick={onAddRepoOpen}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    Add Repository
                  </button>
                </div>
              </div>
            )}

            {showFullModal && (
              <IndexingProgress
                {...toIndexingProps(jobState, activeRepoUrl)}
                stages={INDEXING_STAGES}
                onClose={onJobClose}
              />
            )}

            <footer className="copyright-footer">
              &copy; {new Date().getFullYear()} OpenTrace
            </footer>
            <footer className="version-footer">
              v{__APP_VERSION__} &middot;{' '}
              {new Date(__BUILD_TIME__).toLocaleString()}
            </footer>
          </div>
        );
      }

      // --- Main graph viewport ---

      const selectedCommunityId = selectedNode
        ? communityData.assignments[selectedNode.id]
        : undefined;
      const selectedCommunityName =
        selectedCommunityId !== undefined
          ? communityData.names.get(selectedCommunityId)
          : undefined;
      const selectedCommunityColor =
        selectedCommunityId !== undefined
          ? communityData.colorMap.get(selectedCommunityId)
          : undefined;

      // ─── Build filter sections for SidePanel ──────────────────────────

      const nodeFilterItems: FilterItem[] = availableNodeTypes.map(
        ({ type, count }) => {
          const subs = availableSubTypes.get(type);
          const children = subs?.map((s) => ({
            key: `${type}:${s.subType}`,
            label: s.subType,
            count: s.count,
            color: getNodeColor(type),
            hidden: hiddenSubTypes.has(`${type}:${s.subType}`),
          }));
          return {
            key: type,
            label: type,
            count,
            color: getNodeColor(type),
            hidden: hiddenNodeTypes.has(type),
            children,
          };
        },
      );

      const toggleNodeFilter = (key: string) => {
        if (key.includes(':')) {
          // Sub-type key like "Class:Controller"
          setHiddenSubTypes((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        } else {
          // Parent type key — toggle all sub-types if any, else toggle type
          const subs = availableSubTypes.get(key);
          if (subs && subs.length > 0) {
            setHiddenSubTypes((prev) => {
              const keys = subs.map((s) => `${key}:${s.subType}`);
              const allHidden = keys.every((k) => prev.has(k));
              const next = new Set(prev);
              if (allHidden) {
                keys.forEach((k) => next.delete(k));
              } else {
                keys.forEach((k) => next.add(k));
              }
              return next;
            });
          } else {
            setHiddenNodeTypes((prev) => {
              const next = new Set(prev);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              return next;
            });
          }
        }
      };

      const linkFilterItems: FilterItem[] = availableLinkTypes.map(
        ({ type, count }) => ({
          key: type,
          label: type.toLowerCase(),
          count,
          color: getLinkColor(type),
          hidden: hiddenLinkTypes.has(type),
        }),
      );

      const communityFilterItems: FilterItem[] = availableCommunities.map(
        ({ communityId, label, count, color }) => ({
          key: String(communityId),
          label,
          count,
          color,
          hidden: hiddenCommunities.has(communityId),
        }),
      );

      const filterSections: FilterPanelProps[] = [];

      if (colorMode === 'community' && communityFilterItems.length > 0) {
        filterSections.push({
          title: 'Communities',
          items: communityFilterItems,
          onToggle: (key) => {
            const cid = Number(key);
            setHiddenCommunities((prev) => {
              const next = new Set(prev);
              if (next.has(cid)) next.delete(cid);
              else next.add(cid);
              return next;
            });
          },
          onShowAll: () => setHiddenCommunities(new Set()),
          onHideAll: () =>
            setHiddenCommunities(
              new Set(availableCommunities.map((c) => c.communityId)),
            ),
          onFocus: onCommunityFocus,
        });
      }

      filterSections.push({
        title: 'Node Types',
        items: nodeFilterItems,
        onToggle: toggleNodeFilter,
        onShowAll: () => {
          setHiddenNodeTypes(new Set());
          setHiddenSubTypes(new Set());
        },
        onHideAll: () => {
          setHiddenNodeTypes(new Set(availableNodeTypes.map((t) => t.type)));
          const allSubKeys = new Set<string>();
          availableSubTypes.forEach((subs, type) => {
            subs.forEach((s) => allSubKeys.add(`${type}:${s.subType}`));
          });
          setHiddenSubTypes(allSubKeys);
        },
      });

      filterSections.push({
        title: 'Edges',
        items: linkFilterItems,
        indicator: 'line',
        emptyMessage: 'No edges',
        onToggle: (key) =>
          setHiddenLinkTypes((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          }),
        onShowAll: () => setHiddenLinkTypes(new Set()),
        onHideAll: () =>
          setHiddenLinkTypes(new Set(availableLinkTypes.map((t) => t.type))),
      });

      return (
        <div className="graph-viewport">
          <SidePanel
            filterSections={filterSections}
            selectedNode={selectedNode}
            nodeSource={nodeSource}
            sourceLoading={sourceLoading}
            sourceError={sourceError}
            communityName={selectedCommunityName}
            communityColor={selectedCommunityColor}
            selectedLink={selectedLink}
            onSelectNode={(nodeId) => {
              const node = graphDataRef.current.nodes.find(
                (n) => n.id === nodeId,
              );
              if (node) onNodeClick(node);
            }}
            onCloseDetails={() => {
              setSelectedNode(null);
              setSelectedLink(null);
            }}
            graphVersion={graphVersion}
            graphNodeIds={graphNodeIds}
            hopMap={hopMap}
            mobileActiveTab={mobilePanelTab}
            onMobileTabChange={setMobilePanelTab}
            onMobileClose={() => setMobilePanelTab(null)}
          />
          <GraphToolbar
            logo={
              <button
                type="button"
                className="header-logo header-logo--clickable"
                onClick={() => setShowResetConfirm(true)}
              >
                <img src="/opentrace-logo.svg" alt="OpenTrace" />
                <h1>OpenTrace</h1>
              </button>
            }
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            onSearch={handleSearch}
            onReset={handleReset}
            searchDisabled={
              !searchQuery.trim() || searchQuery === lastSearchQuery
            }
            showResetButton={!!lastSearchQuery}
            hops={hops}
            onHopsChange={setHops}
            nodeCount={filteredGraphData.nodes.length}
            edgeCount={filteredGraphData.links.length}
            totalNodes={stats?.total_nodes}
            totalEdges={stats?.total_edges}
            mobilePanelTabs={[
              {
                key: 'filters',
                label: 'Filters',
                icon: (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                  </svg>
                ),
              },
              {
                key: 'discover',
                label: 'Discover',
                icon: (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
                  </svg>
                ),
              },
              {
                key: 'details',
                label: 'Details',
                visible: !!(selectedNode || selectedLink),
                icon: (
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="16" x2="12" y2="12" />
                    <line x1="12" y1="8" x2="12.01" y2="8" />
                  </svg>
                ),
              },
            ]}
            onMobilePanelTab={(key) => setMobilePanelTab(key as SidePanelTab)}
            persistentActions={
              <a
                className="github-star-btn"
                href="https://github.com/opentrace/opentrace"
                target="_blank"
                rel="noopener noreferrer"
                title="Star on GitHub"
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
                </svg>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="currentColor"
                  strokeWidth="1"
                >
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
                <span className="star-label">Star</span>
              </a>
            }
            actions={
              <>
                {(jobState.status === 'enriching' ||
                  jobState.status === 'done') &&
                !jobExpanded ? (
                  <JobMinimizedBar
                    state={jobState}
                    onClick={onJobExpand}
                    onCancel={onJobCancel}
                  />
                ) : (
                  <button
                    className="add-repo-btn"
                    onClick={onAddRepoOpen}
                    disabled
                    title="Add Repository"
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    <span className="ot-menu-label">Add Repository</span>
                  </button>
                )}
                {graphData.nodes.length > 0 && store.exportDatabase && (
                  <button
                    className="export-db-btn"
                    title="Export database"
                    onClick={async () => {
                      if (!store.exportDatabase) return;
                      const data = await store.exportDatabase();
                      // Copy to a standard ArrayBuffer — the WASM FS may
                      // return a Uint8Array backed by SharedArrayBuffer.
                      const buf = new Uint8Array(data).buffer as ArrayBuffer;
                      const blob = new Blob([buf], {
                        type: 'application/octet-stream',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'opentrace.parquet.zip';
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    <span className="ot-menu-label">Export</span>
                  </button>
                )}
                <ThemeSelector />
                <button
                  className={`chat-toggle-btn ${showChat ? 'active' : ''}`}
                  onClick={onToggleChat}
                  title="Toggle AI Chat"
                  data-testid="chat-toggle-btn"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                    <path d="M20 3v4" />
                    <path d="M22 5h-4" />
                    <path d="M4 17v2" />
                    <path d="M5 18H3" />
                  </svg>
                  <span className="ot-menu-label">AI Chat</span>
                </button>
                <button
                  className={`settings-toggle-btn ${showSettings ? 'active' : ''}`}
                  onClick={onToggleSettings}
                  title="Settings"
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span className="ot-menu-label">Settings</span>
                </button>
              </>
            }
          />

          {showResetConfirm && (
            <ResetConfirmModal
              onConfirm={() => window.location.reload()}
              onCancel={() => setShowResetConfirm(false)}
            />
          )}

          {showAddRepo && jobState.status === 'idle' && (
            <AddRepoModal
              onClose={onAddRepoClose}
              onSubmit={onJobSubmit}
              onValidate={validateRepo}
            />
          )}

          {isEmpty && showFullModal && (
            <div className="empty-state-header">
              <img
                src="/opentrace-logo.svg"
                alt="OpenTrace"
                className="empty-state-header-logo"
              />
              <span className="empty-state-header-title">OpenTrace</span>
            </div>
          )}

          {showFullModal && (
            <IndexingProgress
              {...toIndexingProps(jobState, activeRepoUrl)}
              stages={INDEXING_STAGES}
              onClose={onJobClose}
            />
          )}

          <GraphLegend items={legendItems} linkItems={legendLinkItems} />

          <PixiGraphCanvas
            ref={canvasRef}
            nodes={graphData.nodes}
            links={graphData.links}
            width={graphWidth}
            height={height}
            layoutConfig={layoutConfig}
            colorMode={colorMode}
            hiddenNodeTypes={hiddenNodeTypes}
            hiddenLinkTypes={hiddenLinkTypes}
            hiddenSubTypes={hiddenSubTypes}
            hiddenCommunities={hiddenCommunities}
            searchQuery={searchQuery}
            selectedNodeId={selectedNode?.id}
            hops={hops}
            getSubType={getSubType}
            highlightNodes={
              selectedLink
                ? edgeHighlightNodes
                : focusedCommunityNodes.size > 0
                  ? focusedCommunityNodes
                  : highlights.highlightNodes
            }
            highlightLinks={
              selectedLink
                ? edgeHighlightLinks
                : focusedCommunityNodes.size > 0
                  ? EMPTY_SET
                  : highlights.highlightLinks
            }
            labelNodes={
              selectedLink
                ? edgeLabelNodes
                : focusedCommunityNodes.size > 0
                  ? focusedCommunityNodes
                  : highlights.labelNodes
            }
            availableSubTypes={availableSubTypes}
            zIndex
            communityData={communityData}
            onNodeClick={onNodeClick}
            onEdgeClick={onLinkClick}
            onStageClick={handleStageClick}
            onOptimizeStatus={setOptimizeStatus}
            layoutMode={layoutMode}
            animationSettings={animationSettings}
            style={{ isolation: 'isolate' }}
          />

          {showPhysicsPanel && (
            <PhysicsPanel
              repulsion={repulsion}
              onRepulsionChange={(v) => {
                setRepulsion(v);
                canvasRef.current?.setChargeStrength?.(-v);
              }}
              labelsVisible={labelsVisible}
              onLabelsVisibleChange={(v) => {
                setLabelsVisible(v);
                canvasRef.current?.setShowLabels?.(v);
              }}
              colorMode={colorMode}
              onColorModeChange={setColorMode}
              isPhysicsRunning={physicsRunning}
              onStopPhysics={() => {
                canvasRef.current?.stopPhysics();
                setPhysicsRunning(false);
              }}
              onStartPhysics={() => {
                canvasRef.current?.startPhysics();
                setPhysicsRunning(true);
              }}
              // Pixi-specific props
              pixiMode={true}
              linkDistance={pixiLinkDist}
              onLinkDistanceChange={(v) => {
                setPixiLinkDist(v);
                canvasRef.current?.setLinkDistance?.(v);
              }}
              centerStrength={pixiCenter}
              onCenterStrengthChange={(v) => {
                setPixiCenter(v);
                canvasRef.current?.setCenterStrength?.(v);
              }}
              layoutMode={layoutMode}
              onLayoutModeChange={(mode) => {
                setLayoutMode(mode);
                canvasRef.current?.setLayoutMode?.(mode);
              }}
              radialStrength={compactRadial}
              onRadialStrengthChange={(v) => {
                setCompactRadial(v);
                canvasRef.current?.updateCompactConfig?.({
                  radialStrength: v / 100,
                });
              }}
              communityPull={compactCommunity}
              onCommunityPullChange={(v) => {
                setCompactCommunity(v);
                canvasRef.current?.updateCompactConfig?.({
                  communityPull: v / 100,
                });
              }}
              centeringStrength={compactCentering}
              onCenteringStrengthChange={(v) => {
                setCompactCentering(v);
                canvasRef.current?.updateCompactConfig?.({
                  centeringStrength: v / 100,
                });
              }}
              circleRadius={compactRadius}
              onCircleRadiusChange={(v) => {
                setCompactRadius(v);
                canvasRef.current?.updateCompactConfig?.({ radiusScale: v });
              }}
              zoomSizeExponent={pixiZoomExponent}
              onZoomSizeExponentChange={(v) => {
                setPixiZoomExponent(v);
                canvasRef.current?.setZoomSizeExponent?.(v);
              }}
              onReheat={() => canvasRef.current?.reheat?.()}
              onFitToScreen={() => canvasRef.current?.fitToScreen?.()}
            />
          )}

          <div className="graph-controls">
            <button
              className={`graph-control-btn${zoomOnSelect ? ' graph-control-btn--active' : ''}`}
              onClick={() => setZoomOnSelect((z) => !z)}
              title={
                zoomOnSelect
                  ? 'Zoom to node on click (on)'
                  : 'Zoom to node on click (off)'
              }
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
                {zoomOnSelect && (
                  <>
                    <line x1="11" y1="8" x2="11" y2="14" />
                    <line x1="8" y1="11" x2="14" y2="11" />
                  </>
                )}
              </svg>
            </button>
            <button
              className="graph-control-btn"
              onClick={() => canvasRef.current?.zoomIn()}
              title="Zoom in"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              className="graph-control-btn"
              onClick={() => canvasRef.current?.zoomOut()}
              title="Zoom out"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              className="graph-control-btn"
              onClick={() => canvasRef.current?.resetCamera()}
              title="Zoom to fit"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
            <button
              className={`graph-control-btn${showPhysicsPanel ? ' graph-control-btn--active' : ''}`}
              onClick={() => setShowPhysicsPanel((v) => !v)}
              title="Physics tuner"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" />
                <line x1="9" y1="8" x2="15" y2="8" />
                <line x1="17" y1="16" x2="23" y2="16" />
              </svg>
            </button>
            <button
              className={`graph-control-btn${layoutMode === 'compact' ? ' graph-control-btn--active' : ''}`}
              onClick={() => {
                const next = layoutMode === 'spread' ? 'compact' : 'spread';
                setLayoutMode(next);
                canvasRef.current?.setLayoutMode?.(next);
              }}
              title={
                layoutMode === 'compact'
                  ? 'Switch to spread layout'
                  : 'Switch to compact layout'
              }
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {layoutMode === 'compact' ? (
                  /* Expand/spread icon */
                  <>
                    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                  </>
                ) : (
                  /* Compact/circle icon */
                  <circle cx="12" cy="12" r="9" />
                )}
              </svg>
            </button>
            <button
              className={`graph-control-btn${optimizeStatus?.phase === 'fa2' ? ' graph-control-btn--active' : ''}`}
              onClick={() => canvasRef.current?.optimize()}
              title={
                optimizeStatus?.phase === 'fa2'
                  ? 'Running physics...'
                  : 'Optimize layout'
              }
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12 2l0 4M12 18l0 4M2 12l4 0M18 12l4 0" />
                <path d="M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            </button>
          </div>
          {optimizeStatus && optimizeStatus.phase !== 'done' && (
            <div
              className="optimize-status"
              style={{
                position: 'absolute',
                left: '50%',
                bottom: 60,
                transform: 'translateX(-50%)',
                background: 'rgba(0,0,0,0.75)',
                color: '#e2e8f0',
                padding: '6px 16px',
                borderRadius: 8,
                fontSize: 13,
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {optimizeStatus.phase === 'fa2' && 'Running physics...'}
            </div>
          )}
        </div>
      );
    },
  ),
);

export default GraphViewer;
