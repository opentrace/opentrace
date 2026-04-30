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
  AddRepoModal,
  DEFAULT_LAYOUT_CONFIG,
  GraphLegend,
  GraphToolbar,
  IndexingProgress,
  PixiGraphCanvas,
  detectProvider,
  normalizeRepoUrl,
  type GraphCanvasHandle,
  type IndexingState,
  type SearchSuggestion,
} from '@opentrace/components';
import type {
  GraphLink,
  GraphNode,
  SelectedEdge,
} from '@opentrace/components/utils';
import { getLinkColor, getNodeColor } from '@opentrace/components/utils';
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
import { useGraph } from '../providers/GraphDataProvider';
import { useGraphInteraction } from '../providers/GraphInteractionProvider';
import { getSubType } from '../providers/graphFilterUtils';
import type { JobMessage, JobState } from '../job';
import { JobPhase } from '../job';
import { useStore } from '../store';
import ExportModal from './ExportModal';
import {
  EmptyStateHeader,
  GraphErrorState,
  GraphInitialEmpty,
  GraphLoadingState,
  GraphSearchEmpty,
} from './GraphEmptyStates';
import { GraphControlsBar } from './GraphControlsBar';
import {
  GitHubStarButton,
  GraphToolbarActionButtons,
  buildMobilePanelTabs,
} from './GraphToolbarActions';
import type { HistoryEntry } from './historyTypes';
import { PhysicsPanelContainer } from './PhysicsPanelContainer';
import { GitHubIcon, GitLabIcon } from './providerIcons';
import ResetConfirmModal from './ResetConfirmModal';
import type { SidePanelTab } from './SidePanel';

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

// WARNING: Module-level singleton — do NOT mutate (add/delete). Used as a
// stable empty default for highlight props to avoid unnecessary re-renders.
const EMPTY_SET: Set<string> = Object.freeze(new Set<string>()) as Set<string>;

export interface GraphViewerHandle {
  selectNode: (nodeId: string, hops?: number) => void;
  triggerPing: (nodeIds: Iterable<string>) => void;
  resetCamera: () => void;
  zoomToFit: (duration?: number) => void;
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
  showHelp: boolean;
  onToggleHelp: () => void;
  /** Node IDs found by chat tool results — highlighted when no other selection is active */
  chatHighlightNodes?: Set<string>;
  /** Animation settings from SettingsDrawer */
  animationSettings?: import('@opentrace/components').AnimationSettings;
  /** Additional React elements rendered in the toolbar's actions area (right side).
   *  Appended after the built-in buttons (chat toggle, settings, theme). */
  toolbarActions?: React.ReactNode;
  /** Mobile: whether the graph is in fullscreen mode (hides chat) */
  graphFullscreen?: boolean;
  /** Mobile: toggle graph fullscreen */
  onToggleGraphFullscreen?: () => void;
  /** Mobile: open SidePanel on a given tab (state lives in App). */
  onMobilePanelTabChange?: (tab: SidePanelTab) => void;
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
        showHelp,
        onToggleHelp,
        chatHighlightNodes,
        animationSettings,
        toolbarActions,
        graphFullscreen,
        onToggleGraphFullscreen,
        onMobilePanelTabChange,
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
                .filter((n) => n.properties?.sourceUri || n.properties?.url)
                .map((n) => ({
                  name: n.name,
                  url: (n.properties!.sourceUri ?? n.properties!.url) as string,
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

      // Set by the post-embedding reload effect to suppress the redundant
      // auto-fit it would otherwise trigger (embeddings only add vector
      // properties to existing nodes — the structural graph is unchanged).
      //
      // Known limitation: if the `persisted` loadGraph is still in-flight
      // when `done` fires (tiny repos with near-instant embedding + slow
      // fetchGraph), the wrong increment may consume the flag. The window
      // is small in practice — embedding typically dominates `fetchGraph`
      // by orders of magnitude — so we accept the race rather than thread
      // per-promise suppression tokens through useGraph.
      const suppressNextFitRef = useRef(false);

      const {
        graphData,
        loading,
        error,
        stats,
        lastSearchQuery,
        graphVersion,
        loadGraph,
        setError,
      } = useGraph();

      // Pointer to the same graphData object the provider holds — not a copy.
      // useRef stores the reference (`ref.current === graphData`); the nodes
      // and links arrays exist on the heap exactly once.
      //
      // Why we don't just read `graphData` from useGraph() at each call site:
      // useImperativeHandle, the narrow-dep chat-highlight effect, and
      // handleSelectEdgeFromNode all need *stable identity* but must see the
      // *latest* data. Reading `graphData` directly inside those closures
      // would force it into their dependency arrays, re-creating the
      // handle/callback on every load and re-firing effects (which would
      // duplicate history entries, churn the imperative handle, etc.).
      // The ref lets stale closures dereference the current pointer without
      // subscribing.
      const graphDataRef = useRef(graphData);
      useEffect(() => {
        graphDataRef.current = graphData;
      }, [graphData]);

      // Auto-fit after each successful graph load (graphVersion bumps on success).
      // The post-embedding reload (which only attaches vector properties without
      // changing graph structure) sets `suppressNextFitRef` to skip the next
      // auto-fit so the user's existing camera position isn't disturbed.
      useEffect(() => {
        if (graphVersion === 0) return;
        if (suppressNextFitRef.current) {
          suppressNextFitRef.current = false;
          return;
        }
        // scheduleAutoFit is throttled and gated by the user's pan/zoom state,
        // so this is a no-op if the user has already moved the camera.
        canvasRef.current?.scheduleAutoFit?.(400);
      }, [graphVersion]);

      // Compute edges between chat-highlighted nodes
      const chatHighlightLinks = useMemo(() => {
        if (!chatHighlightNodes || chatHighlightNodes.size < 2)
          return EMPTY_SET;
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

      // Selection, filter state, history, search/hops, and derived data all
      // live in GraphInteractionProvider so SidePanel can sit as a sibling.
      const {
        selectedNode,
        setSelectedNode,
        selectedLink,
        setSelectedLink,
        setNodeHistory,
        hiddenNodeTypes,
        setHiddenNodeTypes,
        hiddenLinkTypes,
        hiddenSubTypes,
        hiddenCommunities,
        setHiddenCommunities,
        colorMode,
        setColorMode,
        searchQuery,
        setSearchQuery,
        hops,
        setHops,
        focusedCommunityNodes,
        setFocusedCommunityNodes,
        availableSubTypes,
        communityData,
        filteredGraphData,
        highlights,
      } = useGraphInteraction();

      const [showResetConfirm, setShowResetConfirm] = useState(false);
      const [showExportModal, setShowExportModal] = useState(false);
      const [exporting, setExporting] = useState(false);

      // Append chat-highlighted nodes to session history
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

      // Active search filter — stored as data so we can re-apply it
      const [activeFilter, setActiveFilter] = useState<{
        type: 'community';
        communityId: number;
      } | null>(null);

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
      // 3D mode state
      const [mode3d, setMode3d] = useState(() => ps('mode3d', true));
      const [mode3dSpeed, setMode3dSpeed] = useState(() =>
        ps('mode3dSpeed', 30),
      );
      const [mode3dTilt, setMode3dTilt] = useState(() => ps('mode3dTilt', 35));
      const [labelScale, setLabelScale] = useState(() => ps('labelScale', 100));
      const [rendererAutoRotate, setRendererAutoRotate] = useState<
        boolean | null
      >(null);

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
          mode3d,
          mode3dSpeed,
          mode3dTilt,
          labelScale,
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
        mode3d,
        mode3dSpeed,
        mode3dTilt,
        labelScale,
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

      // React to done: final graph refresh with enriched data. Suppress the
      // auto-fit this reload would otherwise trigger — embeddings only add
      // vector properties to existing nodes, so the view should not re-animate.
      useEffect(() => {
        if (jobState.status === 'done') {
          suppressNextFitRef.current = true;
          loadGraph().finally(() => {
            // Defensive reset: if loadGraph failed or was aborted, onGraphLoaded
            // never fired and the flag would leak onto the next unrelated call.
            suppressNextFitRef.current = false;
          });
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
        setActiveFilter(null);
        setFocusedCommunityNodes(EMPTY_SET);
        setHiddenNodeTypes(new Set());
        setHiddenCommunities(new Set());
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

      const onNodeClick = useCallback(
        (node: GraphNode) => {
          setSelectedNode(node);
          setSelectedLink(null);
          // Clear edge-click and community-focus highlights (use stable empty sets)
          setEdgeHighlightNodes(EMPTY_SET);
          setEdgeHighlightLinks(EMPTY_SET);
          setEdgeLabelNodes(EMPTY_SET);
          setFocusedCommunityNodes(EMPTY_SET);
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
          // Zoom is handled by the effect below after highlights are computed
        },
        [
          setSelectedNode,
          setSelectedLink,
          setFocusedCommunityNodes,
          setNodeHistory,
        ],
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
          selectNode: (nodeId: string, nodeHops?: number) => {
            if (nodeHops !== undefined) setHops(nodeHops);
            const node = graphDataRef.current.nodes.find(
              (n) => n.id === nodeId,
            );
            if (node) onNodeClick(node);
          },
          triggerPing: (nodeIds: Iterable<string>) => {
            canvasRef.current?.triggerPing?.(nodeIds);
          },
          resetCamera: () => {
            canvasRef.current?.resetCamera();
          },
          zoomToFit: (duration?: number) => {
            canvasRef.current?.zoomToFit(duration);
          },
        }),
        [onNodeClick, setHops],
      );

      const onLinkClick = useCallback(
        (edge: SelectedEdge) => {
          setSelectedLink(edge);
          setSelectedNode(null);
        },
        [setSelectedLink, setSelectedNode],
      );

      // Sync canvas-side edge highlights + zoom to whichever edge is selected
      // — works for both the canvas-click path (onLinkClick) and the
      // SidePanel "select edge from node details" path (which writes to
      // context's selectedLink directly via the provider's selectLink helper).
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

      // Zoom to highlighted neighborhood when a node is selected,
      // or zoom to fit all nodes when deselected.
      // Only trigger on selectedNode identity change, not on highlight recalculation
      // (which fires on filter/search/hops changes and would cause unwanted re-zoom).
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
      }, [
        zoomOnSelect,
        selectedNode?.id,
        !!selectedLink,
        focusedCommunityNodes.size,
      ]);

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

      // Build autocomplete suggestions for the toolbar search
      const searchSuggestions = useMemo<SearchSuggestion[]>(() => {
        // Deduplicate names; pick first node's type/community/id for each name
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

      // Apply the active filter — computes focused nodes from the stored filter
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
                // After graph reloads, find and select the target node
                if (targetId) {
                  const node = graphDataRef.current.nodes.find(
                    (n) => n.id === targetId,
                  );
                  if (node) {
                    onNodeClick(node);
                    // Zoom to the selected node after a short delay for layout settle
                    setTimeout(() => {
                      canvasRef.current?.zoomToNodes(new Set([targetId]), 600);
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

      const isEmpty = graphData.nodes.length === 0;
      const isSearchEmpty = isEmpty && !!lastSearchQuery;

      // Determine whether to show the full indexing progress modal
      const showFullModal =
        jobState.status === 'running' ||
        jobState.status === 'persisted' ||
        jobState.status === 'error' ||
        ((jobState.status === 'enriching' || jobState.status === 'done') &&
          (jobExpanded || (loading && isEmpty)));

      const graphWidth = showChat || showHelp ? width - chatWidth : width;

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

      const activeFilterRef = useRef(activeFilter);
      activeFilterRef.current = activeFilter;

      const handleStageClick = useCallback(() => {
        setSelectedNode(null);
        setSelectedLink(null);
        setEdgeHighlightNodes(EMPTY_SET);
        setEdgeHighlightLinks(EMPTY_SET);
        setEdgeLabelNodes(EMPTY_SET);
        // Re-apply the active search filter (e.g. community focus)
        applyFilter(activeFilterRef.current);
      }, [applyFilter, setSelectedLink, setSelectedNode]);

      // --- Early returns for loading/error/empty states ---

      if (loading && isEmpty && !showAddRepo && !showFullModal) {
        return <GraphLoadingState />;
      }

      if (error) {
        return (
          <GraphErrorState
            error={error}
            onRetry={() => {
              setError(null);
              loadGraph();
            }}
          />
        );
      }

      if (isSearchEmpty && !showFullModal) {
        return (
          <GraphSearchEmpty
            searchQuery={lastSearchQuery}
            onClearSearch={handleReset}
          />
        );
      }

      if (isEmpty && !showFullModal) {
        return (
          <GraphInitialEmpty
            showAddRepo={showAddRepo}
            showFullModal={showFullModal}
            onAddRepoOpen={onAddRepoOpen}
            onAddRepoClose={onAddRepoClose}
            onJobSubmit={onJobSubmit}
            onValidateRepo={validateRepo}
            indexingProgress={
              <IndexingProgress
                {...toIndexingProps(jobState, activeRepoUrl)}
                stages={INDEXING_STAGES}
                onClose={onJobClose}
              />
            }
          />
        );
      }

      // --- Main graph viewport ---

      return (
        <div className="graph-viewport">
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
            searchSuggestions={searchSuggestions}
            onSuggestionSelect={handleSuggestionSelect}
            hops={hops}
            onHopsChange={setHops}
            nodeCount={filteredGraphData.nodes.length}
            edgeCount={filteredGraphData.links.length}
            totalNodes={stats?.total_nodes}
            totalEdges={stats?.total_edges}
            mobilePanelTabs={buildMobilePanelTabs({
              showDetails: !!(selectedNode || selectedLink),
            })}
            onMobilePanelTab={(key) =>
              onMobilePanelTabChange?.(key as SidePanelTab)
            }
            persistentActions={<GitHubStarButton />}
            actions={
              <GraphToolbarActionButtons
                toolbarActions={toolbarActions}
                jobState={jobState}
                jobExpanded={jobExpanded}
                onJobExpand={onJobExpand}
                onJobCancel={onJobCancel}
                onAddRepoOpen={onAddRepoOpen}
                hasGraphData={graphData.nodes.length > 0}
                canExport={!!store.exportDatabase}
                exporting={exporting}
                onExportOpen={() => {
                  if (!store.exportDatabase || exporting) return;
                  setShowExportModal(true);
                }}
                showChat={showChat}
                onToggleChat={onToggleChat}
                showHelp={showHelp}
                onToggleHelp={onToggleHelp}
                showSettings={showSettings}
                onToggleSettings={onToggleSettings}
              />
            }
          />

          {showResetConfirm && (
            <ResetConfirmModal
              onConfirm={() => window.location.reload()}
              onCancel={() => setShowResetConfirm(false)}
            />
          )}

          {showExportModal && store.exportDatabase && (
            <ExportModal
              onCancel={() => setShowExportModal(false)}
              onExport={async ({ includeSource, repoId }) => {
                setShowExportModal(false);
                setExporting(true);
                try {
                  const data = await store.exportDatabase!({
                    includeSource,
                    repoId,
                  });
                  const buf = new Uint8Array(data).buffer as ArrayBuffer;
                  const blob = new Blob([buf], {
                    type: 'application/octet-stream',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  const safeName = repoId
                    ? repoId.replace(/\//g, '-')
                    : 'opentrace';
                  a.download = `${safeName}.parquet.zip`;
                  a.click();
                  URL.revokeObjectURL(url);
                } finally {
                  setExporting(false);
                }
              }}
            />
          )}

          {showAddRepo && jobState.status === 'idle' && (
            <AddRepoModal
              onClose={onAddRepoClose}
              onSubmit={onJobSubmit}
              onValidate={validateRepo}
            />
          )}

          {isEmpty && showFullModal && <EmptyStateHeader />}

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
                  : highlights.highlightNodes.size > 0
                    ? highlights.highlightNodes
                    : chatHighlightNodes && chatHighlightNodes.size > 0
                      ? chatHighlightNodes
                      : highlights.highlightNodes
            }
            highlightLinks={
              selectedLink
                ? edgeHighlightLinks
                : focusedCommunityNodes.size > 0
                  ? EMPTY_SET
                  : highlights.highlightLinks.size > 0
                    ? highlights.highlightLinks
                    : chatHighlightLinks.size > 0
                      ? chatHighlightLinks
                      : highlights.highlightLinks
            }
            labelNodes={
              selectedLink
                ? edgeLabelNodes
                : focusedCommunityNodes.size > 0
                  ? focusedCommunityNodes
                  : highlights.labelNodes.size > 0
                    ? highlights.labelNodes
                    : chatHighlightNodes && chatHighlightNodes.size > 0
                      ? chatHighlightNodes
                      : highlights.labelNodes
            }
            availableSubTypes={availableSubTypes}
            zIndex
            communityData={communityData}
            onNodeClick={onNodeClick}
            onEdgeClick={onLinkClick}
            onStageClick={handleStageClick}
            labelsVisible={labelsVisible}
            layoutMode={layoutMode}
            mode3d={mode3d}
            on3DAutoRotateChange={setRendererAutoRotate}
            animationSettings={animationSettings}
            style={{ isolation: 'isolate' }}
          />

          {showPhysicsPanel && (
            <PhysicsPanelContainer
              canvasRef={canvasRef}
              repulsion={repulsion}
              setRepulsion={setRepulsion}
              labelsVisible={labelsVisible}
              setLabelsVisible={setLabelsVisible}
              colorMode={colorMode}
              setColorMode={setColorMode}
              physicsRunning={physicsRunning}
              setPhysicsRunning={setPhysicsRunning}
              pixiLinkDist={pixiLinkDist}
              setPixiLinkDist={setPixiLinkDist}
              pixiCenter={pixiCenter}
              setPixiCenter={setPixiCenter}
              pixiZoomExponent={pixiZoomExponent}
              setPixiZoomExponent={setPixiZoomExponent}
              layoutMode={layoutMode}
              setLayoutMode={setLayoutMode}
              compactRadial={compactRadial}
              setCompactRadial={setCompactRadial}
              compactCommunity={compactCommunity}
              setCompactCommunity={setCompactCommunity}
              compactCentering={compactCentering}
              setCompactCentering={setCompactCentering}
              compactRadius={compactRadius}
              setCompactRadius={setCompactRadius}
              mode3d={mode3d}
              setMode3d={setMode3d}
              mode3dSpeed={mode3dSpeed}
              setMode3dSpeed={setMode3dSpeed}
              mode3dTilt={mode3dTilt}
              setMode3dTilt={setMode3dTilt}
              rendererAutoRotate={rendererAutoRotate}
              setRendererAutoRotate={setRendererAutoRotate}
              labelScale={labelScale}
              setLabelScale={setLabelScale}
            />
          )}

          <GraphControlsBar
            canvasRef={canvasRef}
            graphFullscreen={graphFullscreen}
            onToggleGraphFullscreen={onToggleGraphFullscreen}
            zoomOnSelect={zoomOnSelect}
            setZoomOnSelect={setZoomOnSelect}
            showPhysicsPanel={showPhysicsPanel}
            setShowPhysicsPanel={setShowPhysicsPanel}
            layoutMode={layoutMode}
            setLayoutMode={setLayoutMode}
            mode3d={mode3d}
            setMode3d={setMode3d}
          />
        </div>
      );
    },
  ),
);

export default GraphViewer;
