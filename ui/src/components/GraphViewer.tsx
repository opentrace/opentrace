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
import ForceGraph, {
  type ForceGraphMethods,
  type NodeObject,
  type LinkObject,
} from 'react-force-graph-2d';
import type { GraphNode, GraphLink } from '../types/graph';
import type { NodeSourceResponse } from '../store/types';
import { useStore } from '../store';
import { getNodeColor } from '../chat/results/nodeColors';
import { getLinkColor } from '../chat/results/linkColors';
import { useGraphData } from '../hooks/useGraphData';
import type { JobState } from '../job';
import type { JobMessage } from '../job';
import { detectProvider } from './AddRepoModal';
import AddRepoModal from './AddRepoModal';
import IndexingProgress from './IndexingProgress';
import JobMinimizedBar from './JobMinimizedBar';
import SidePanel from './SidePanel';
import ThemeSelector from './ThemeSelector';
import { OpenTraceLogo } from './OpenTraceLogo';

type Node = NodeObject<GraphNode>;
type Link = LinkObject<GraphNode, GraphLink>;

/** Node types whose source code can be fetched and displayed. */
const SOURCE_TYPES = new Set([
  'File',
  'Function',
  'Class',
  'Module',
  'PullRequest',
]);

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
  if (
    node.type === 'Function' ||
    node.type === 'Class' ||
    node.type === 'Module'
  ) {
    const lang = node.properties?.language as string | undefined;
    return lang || null;
  }
  if (node.type === 'Package') {
    const provider = node.properties?.source_name as string | undefined;
    return provider || null;
  }
  return null;
}

/**
 * Extract the string ID from a link endpoint.
 * react-force-graph-2d mutates links at runtime, replacing string IDs
 * with object references after simulation starts. This helper handles both.
 */
function linkId(endpoint: string | number | Node | undefined): string {
  if (typeof endpoint === 'object' && endpoint !== null) return endpoint.id;
  return String(endpoint);
}

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
  onToggleChat: () => void;
  showSettings: boolean;
  onToggleSettings: () => void;
  /** Called when graphData changes so parent can pass it reactively to siblings */
  onGraphDataChange?: (data: {
    nodes: GraphNode[];
    links: GraphLink[];
  }) => void;
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
        onToggleChat,
        showSettings,
        onToggleSettings,
        onGraphDataChange,
      } = props;

      const { store } = useStore();
      const fgRef = useRef<ForceGraphMethods<Node, Link>>(undefined);

      const onGraphLoaded = useCallback(() => {
        setTimeout(() => fgRef.current?.zoomToFit(400, 60), 500);
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
      graphDataRef.current = graphData;

      // Notify parent when graphData changes (for reactive sibling props like ChatPanel)
      useEffect(() => {
        onGraphDataChange?.(graphData);
      }, [graphData, onGraphDataChange]);

      const [selectedNode, setSelectedNode] = useState<Node | null>(null);
      const [selectedLink, setSelectedLink] = useState<Link | null>(null);
      const [searchQuery, setSearchQuery] = useState('');
      const [hops, setHops] = useState(2);
      const [highlightNodes, setHighlightNodes] = useState(new Set<string>());
      const [highlightLinks, setHighlightLinks] = useState(new Set<string>());
      const [labelNodes, setLabelNodes] = useState(new Set<string>());
      const [hopMap, setHopMap] = useState(new Map<string, number>());
      const [hiddenNodeTypes, setHiddenNodeTypes] = useState(new Set<string>());
      const [hiddenLinkTypes, setHiddenLinkTypes] = useState(
        new Set<string>(['DEPENDS_ON']),
      );
      const [hiddenSubTypes, setHiddenSubTypes] = useState(new Set<string>());
      // Track whether we've applied the default Package hiding
      const defaultsApplied = useRef(false);
      const [nodeSource, setNodeSource] = useState<NodeSourceResponse | null>(
        null,
      );
      const [sourceLoading, setSourceLoading] = useState(false);
      const [sourceError, setSourceError] = useState<string | null>(null);

      // React to persisted: load the graph, then auto-minimize after a brief delay
      useEffect(() => {
        if (jobState.status === 'persisted') {
          loadGraph().then(() => {
            setTimeout(() => onJobMinimize(), 1500);
          });
        }
      }, [jobState.status, loadGraph, onJobMinimize]);

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
          setHiddenSubTypes((prev) => {
            const next = new Set(prev);
            pkgSubs.forEach((s) => next.add(`Package:${s.subType}`));
            return next;
          });
        }
      }, [availableSubTypes]);

      // Apply type + sub-type filters to produce the rendered graph.
      // Node/edge counts are already capped by the worker's MAX_VIS_NODES/EDGES limits
      // (configured via Settings), so no additional truncation is needed here.
      const filteredGraphData = useMemo(() => {
        let nodes = graphData.nodes.filter((n) => {
          const hasSubTypeFilters = availableSubTypes.has(n.type);
          if (hasSubTypeFilters) {
            // For types with sub-types, visibility is driven by sub-type filters
            const sub = getSubType(n);
            if (sub) {
              return !hiddenSubTypes.has(`${n.type}:${sub}`);
            }
            // Nodes with no sub-type: visible unless ALL sub-types are hidden
            const subs = availableSubTypes.get(n.type)!;
            const allHidden = subs.every((s) =>
              hiddenSubTypes.has(`${n.type}:${s.subType}`),
            );
            return !allHidden;
          }
          // For types without sub-types, use the type-level filter
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
        availableSubTypes,
      ]);

      const nodeColor = useCallback(
        (node: Node) => getNodeColor(node.type),
        [],
      );

      // Adjacency list for multi-hop BFS traversal (uses filtered data)
      const adjacency = useMemo(() => {
        const map = new Map<string, { neighbor: string; linkKey: string }[]>();
        filteredGraphData.links.forEach((l) => {
          const sourceId = linkId(l.source);
          const targetId = linkId(l.target);
          const linkKey = `${sourceId}-${targetId}`;
          if (!map.has(sourceId)) map.set(sourceId, []);
          if (!map.has(targetId)) map.set(targetId, []);
          map.get(sourceId)!.push({ neighbor: targetId, linkKey });
          map.get(targetId)!.push({ neighbor: sourceId, linkKey });
        });
        return map;
      }, [filteredGraphData.links]);

      const onNodeClick = useCallback(
        (node: Node) => {
          setSelectedNode(node);
          setSelectedLink(null);
          // BFS to find N-hop neighborhood, then zoom to fit it
          const neighborhood = new Set<string>([node.id]);
          let frontier = new Set<string>([node.id]);
          for (let d = 0; d < hops && frontier.size > 0; d++) {
            const next = new Set<string>();
            frontier.forEach((id) => {
              adjacency.get(id)?.forEach(({ neighbor }) => {
                if (!neighborhood.has(neighbor)) {
                  next.add(neighbor);
                  neighborhood.add(neighbor);
                }
              });
            });
            frontier = next;
          }
          fgRef.current?.zoomToFit(600, 60, (n: Node) =>
            neighborhood.has(n.id),
          );
        },
        [fgRef, hops, adjacency],
      );

      // Expose imperative handle for parent/sibling access
      // (placed after onNodeClick so the reference is initialized)
      useImperativeHandle(
        ref,
        () => ({
          graphData,
          selectNode: (nodeId: string, nodeHops?: number) => {
            if (nodeHops !== undefined) setHops(nodeHops);
            const node = graphDataRef.current.nodes.find(
              (n) => n.id === nodeId,
            );
            if (node) onNodeClick(node as Node);
          },
          reload: (query?: string, hops?: number) => loadGraph(query, hops),
        }),
        [graphData, loadGraph, onNodeClick],
      );

      const onLinkClick = useCallback(
        (link: Link) => {
          setSelectedLink(link);
          setSelectedNode(null);
          // Highlight the two endpoints and the clicked link
          const sourceId = linkId(link.source);
          const targetId = linkId(link.target);
          setHighlightNodes(new Set([sourceId, targetId]));
          setHighlightLinks(new Set([`${sourceId}-${targetId}`]));
          setLabelNodes(new Set([sourceId, targetId]));
          // Zoom to fit the two endpoints
          fgRef.current?.zoomToFit(
            600,
            60,
            (n: Node) => n.id === sourceId || n.id === targetId,
          );
        },
        [fgRef],
      );

      // Fetch source code when a source-bearing node is selected.
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

      // Update highlights when search or selection changes
      useEffect(() => {
        // When an edge is selected, its click handler sets highlights directly — skip this effect.
        if (selectedLink) return;

        const nodes = new Set<string>();
        const links = new Set<string>();
        const labels = new Set<string>();

        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          filteredGraphData.nodes.forEach((n) => {
            if (
              n.name?.toLowerCase().includes(q) ||
              n.id.toLowerCase().includes(q) ||
              n.type.toLowerCase().includes(q)
            ) {
              nodes.add(n.id);
              labels.add(n.id);
            }
          });
        }

        // BFS from selected node up to `hops` depth for highlights,
        // but only up to 2 hops for labels
        const hm = new Map<string, number>();
        if (selectedNode) {
          const labelDepth = Math.min(2, hops);
          nodes.add(selectedNode.id);
          labels.add(selectedNode.id);
          hm.set(selectedNode.id, 0);
          let frontier = new Set<string>([selectedNode.id]);
          for (let depth = 0; depth < hops && frontier.size > 0; depth++) {
            const nextFrontier = new Set<string>();
            frontier.forEach((nodeId) => {
              const edges = adjacency.get(nodeId);
              if (!edges) return;
              edges.forEach(({ neighbor, linkKey }) => {
                links.add(linkKey);
                if (!nodes.has(neighbor)) {
                  nextFrontier.add(neighbor);
                  hm.set(neighbor, depth + 1);
                }
                nodes.add(neighbor);
                if (depth < labelDepth) {
                  labels.add(neighbor);
                }
              });
            });
            frontier = nextFrontier;
          }
        }

        setHighlightNodes(nodes);
        setHighlightLinks(links);
        setLabelNodes(labels);
        setHopMap(hm);
      }, [
        searchQuery,
        selectedNode,
        selectedLink,
        hops,
        adjacency,
        filteredGraphData,
      ]);

      // Compute degree (connection count) per node for size scaling
      const graphNodeIds = useMemo(
        () => graphData.nodes.map((n) => n.id as string),
        [graphData.nodes],
      );

      const degreeMap = useMemo(() => {
        const map = new Map<string, number>();
        filteredGraphData.links.forEach((l) => {
          const sourceId = linkId(l.source);
          const targetId = linkId(l.target);
          map.set(sourceId, (map.get(sourceId) || 0) + 1);
          map.set(targetId, (map.get(targetId) || 0) + 1);
        });
        return map;
      }, [filteredGraphData.links]);

      const nodeSize = useCallback(
        (node: Node) => {
          const degree = degreeMap.get(node.id) || 0;
          // sqrt scaling: area proportional to degree. Range: 4px (isolated) to 20px (hub)
          return Math.min(20, Math.max(4, 4 + Math.sqrt(degree) * 3));
        },
        [degreeMap],
      );

      const paintNode = useCallback(
        (node: Node, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const fullLabel = node.name ?? node.id;
          const size = nodeSize(node);
          // Truncate labels on smaller nodes — large hubs get the full name
          const maxChars =
            size <= 5 ? 12 : size <= 8 ? 20 : size <= 12 ? 30 : Infinity;
          const label =
            fullLabel.length > maxChars
              ? fullLabel.slice(0, maxChars - 1) + '\u2026'
              : fullLabel;
          const fontSize = Math.max(12 / globalScale, 1.5);
          const isHighlighted =
            highlightNodes.size === 0 || highlightNodes.has(node.id);

          ctx.globalAlpha = isHighlighted ? 1 : 0.15;

          // Glow on highlighted nodes (search, selection)
          if (highlightNodes.size > 0 && highlightNodes.has(node.id)) {
            ctx.shadowColor = nodeColor(node);
            ctx.shadowBlur = 15;
          }

          // Selection halo
          if (selectedNode && node.id === selectedNode.id) {
            const haloRadius = size + 4;
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, haloRadius, 0, 2 * Math.PI);
            ctx.strokeStyle = nodeColor(node);
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.6;
            ctx.stroke();
            // Outer glow ring
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, haloRadius + 3, 0, 2 * Math.PI);
            ctx.strokeStyle = nodeColor(node);
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.25;
            ctx.stroke();
            ctx.globalAlpha = isHighlighted ? 1 : 0.15;
          }

          // Circle
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, size, 0, 2 * Math.PI);
          ctx.fillStyle = nodeColor(node);
          ctx.fill();
          ctx.shadowBlur = 0;

          // Label — shown when zoomed in (threshold scales with node size) or within label radius
          const sizeRatio = size / 4; // 1 for smallest nodes, up to 5 for largest
          const zoomThreshold = 3.5 / sizeRatio; // hubs: ~0.7, leaves: 3.5
          if (
            globalScale > zoomThreshold ||
            (labelNodes.size > 0 && labelNodes.has(node.id))
          ) {
            const isLight = document.documentElement.dataset.mode === 'light';
            ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = isLight
              ? `rgba(0, 0, 0, ${isHighlighted ? 0.85 : 0.15})`
              : `rgba(255, 255, 255, ${isHighlighted ? 0.9 : 0.2})`;
            ctx.fillText(String(label), node.x!, node.y! + size + 2);
          }
          ctx.globalAlpha = 1;
        },
        [nodeColor, nodeSize, highlightNodes, labelNodes, selectedNode],
      );

      const nodePointerArea = useCallback(
        (node: Node, color: string, ctx: CanvasRenderingContext2D) => {
          const size = nodeSize(node);
          ctx.beginPath();
          ctx.arc(node.x!, node.y!, Math.max(size, 10), 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        },
        [nodeSize],
      );

      const legendItems = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredGraphData.nodes.forEach((n) => {
          counts[n.type] = (counts[n.type] || 0) + 1;
        });
        return Object.entries(counts)
          .map(([type, count]) => ({
            type,
            count,
            color: getNodeColor(type),
          }))
          .sort((a, b) => b.count - a.count);
      }, [filteredGraphData.nodes]);

      const legendLinkItems = useMemo(() => {
        const counts: Record<string, number> = {};
        filteredGraphData.links.forEach((l) => {
          const label = (l as unknown as GraphLink).label || 'unknown';
          counts[label] = (counts[label] || 0) + 1;
        });
        return Object.entries(counts)
          .map(([type, count]) => ({
            type,
            count,
            color: getLinkColor(type),
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

      const chatWidth = 480;
      const graphWidth = showChat ? width - chatWidth : width;

      const isEmpty = graphData.nodes.length === 0;
      const isSearchEmpty = isEmpty && !!lastSearchQuery;

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
                state={jobState}
                provider={detectProvider(activeRepoUrl)}
                onClose={onJobClose}
                onCancel={onJobCancel}
                onMinimize={onJobMinimize}
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

      return (
        <div className="graph-viewport">
          <SidePanel
            nodeTypes={availableNodeTypes}
            linkTypes={availableLinkTypes}
            hiddenNodeTypes={hiddenNodeTypes}
            hiddenLinkTypes={hiddenLinkTypes}
            subTypesByNodeType={availableSubTypes}
            hiddenSubTypes={hiddenSubTypes}
            onToggleNodeType={(type) => {
              const subs = availableSubTypes.get(type);
              if (subs && subs.length > 0) {
                // For types with sub-types, toggle all sub-types
                setHiddenSubTypes((prev) => {
                  const keys = subs.map((s) => `${type}:${s.subType}`);
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
                  next.has(type) ? next.delete(type) : next.add(type);
                  return next;
                });
              }
            }}
            onToggleLinkType={(type) =>
              setHiddenLinkTypes((prev) => {
                const next = new Set(prev);
                next.has(type) ? next.delete(type) : next.add(type);
                return next;
              })
            }
            onToggleSubType={(key) =>
              setHiddenSubTypes((prev) => {
                const next = new Set(prev);
                next.has(key) ? next.delete(key) : next.add(key);
                return next;
              })
            }
            onShowAllNodes={() => {
              setHiddenNodeTypes(new Set());
              setHiddenSubTypes(new Set());
            }}
            onHideAllNodes={() => {
              setHiddenNodeTypes(
                new Set(availableNodeTypes.map((t) => t.type)),
              );
              // Also hide all sub-types
              const allSubKeys = new Set<string>();
              availableSubTypes.forEach((subs, type) => {
                subs.forEach((s) => allSubKeys.add(`${type}:${s.subType}`));
              });
              setHiddenSubTypes(allSubKeys);
            }}
            onShowAllLinks={() => setHiddenLinkTypes(new Set())}
            onHideAllLinks={() =>
              setHiddenLinkTypes(new Set(availableLinkTypes.map((t) => t.type)))
            }
            selectedNode={selectedNode}
            nodeSource={nodeSource}
            sourceLoading={sourceLoading}
            sourceError={sourceError}
            selectedLink={selectedLink}
            onSelectNode={(nodeId) => {
              const node = graphDataRef.current.nodes.find(
                (n) => n.id === nodeId,
              );
              if (node) onNodeClick(node as Node);
            }}
            onCloseDetails={() => {
              setSelectedNode(null);
              setSelectedLink(null);
            }}
            graphVersion={graphVersion}
            graphNodeIds={graphNodeIds}
            hopMap={hopMap}
          />
          <header>
            <div className="header-logo">
              <img src="/opentrace-logo.svg" alt="OpenTrace" />
              <h1>OpenTrace</h1>
            </div>
            <div className="search-container">
              <input
                type="text"
                placeholder="Search nodes..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="search-input"
              />
              <div className="search-params">
                <label htmlFor="hops-input">Hops:</label>
                <input
                  id="hops-input"
                  type="number"
                  min="0"
                  max="5"
                  value={hops}
                  onChange={(e) =>
                    setHops(
                      Math.min(5, Math.max(0, parseInt(e.target.value) || 0)),
                    )
                  }
                  className="hops-input"
                  title="Number of connection hops to include (max 5)"
                />
              </div>
              <div className="search-actions">
                {searchQuery && (
                  <button
                    className="clear-search"
                    onClick={handleReset}
                    title="Clear search"
                  >
                    &times;
                  </button>
                )}
                <button
                  className="api-search-btn"
                  onClick={handleSearch}
                  title="Query API and rerender"
                  disabled={
                    !searchQuery.trim() || searchQuery === lastSearchQuery
                  }
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="11" cy="11" r="8"></circle>
                    <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                  </svg>
                </button>
              </div>
            </div>
            {lastSearchQuery && (
              <button className="reset-btn" onClick={handleReset}>
                Show All
              </button>
            )}
            <span className="badge">
              <span className="badge-rendered">
                {filteredGraphData.nodes.length}
              </span>
              {stats && (
                <span className="badge-total">({stats.total_nodes})</span>
              )}
              <span>nodes</span>
              <span className="badge-sep">&middot;</span>
              <span className="badge-rendered">
                {filteredGraphData.links.length}
              </span>
              {stats && (
                <span className="badge-total">({stats.total_edges})</span>
              )}
              <span>edges</span>
            </span>
            {(jobState.status === 'enriching' || jobState.status === 'done') &&
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
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
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
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
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
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </header>

          {showAddRepo && jobState.status === 'idle' && (
            <AddRepoModal onClose={onAddRepoClose} onSubmit={onJobSubmit} />
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
              state={jobState}
              provider={detectProvider(activeRepoUrl)}
              onClose={onJobClose}
              onCancel={onJobCancel}
              onMinimize={onJobMinimize}
            />
          )}

          <div className="legend">
            {legendItems.map(({ type, count, color }) => (
              <span key={type} className="legend-item">
                <span
                  className="legend-dot"
                  style={{ backgroundColor: color }}
                />
                <span className="legend-count">{count}</span>
                {type}
              </span>
            ))}
            {legendLinkItems.length > 0 && (
              <>
                <span className="legend-divider" />
                {legendLinkItems.map(({ type, count, color }) => (
                  <span key={type} className="legend-item">
                    <span
                      className="legend-line"
                      style={{ backgroundColor: color }}
                    />
                    <span className="legend-count">{count}</span>
                    {type}
                  </span>
                ))}
              </>
            )}
          </div>

          <ForceGraph
            ref={fgRef}
            graphData={filteredGraphData}
            width={graphWidth}
            height={height}
            backgroundColor="transparent"
            nodeCanvasObject={paintNode}
            nodeCanvasObjectMode={() => 'replace'}
            nodePointerAreaPaint={nodePointerArea}
            nodeRelSize={1}
            nodeVal={(node: Node) => nodeSize(node) ** 2}
            linkColor={(link: Link) => {
              const id = `${linkId(link.source)}-${linkId(link.target)}`;
              const label = (link as GraphLink).label ?? '';
              const baseColor = label ? getLinkColor(label) : '#94a3b8';
              if (highlightLinks.has(id)) return baseColor;
              if (highlightLinks.size > 0 || highlightNodes.size > 0)
                return baseColor + '0D'; // ~5% opacity
              return baseColor + '4D'; // ~30% opacity
            }}
            linkWidth={(link: Link) => {
              return highlightLinks.has(
                `${linkId(link.source)}-${linkId(link.target)}`,
              )
                ? 4
                : 2.5;
            }}
            linkCurvature={0.25}
            linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={(link: Link) => {
              // Disable particles on large graphs for performance
              if (filteredGraphData.links.length > 500) return 0;
              return highlightLinks.has(
                `${linkId(link.source)}-${linkId(link.target)}`,
              )
                ? 4
                : 1;
            }}
            linkDirectionalParticleWidth={(link: Link) => {
              return highlightLinks.has(
                `${linkId(link.source)}-${linkId(link.target)}`,
              )
                ? 3
                : 2;
            }}
            linkDirectionalParticleSpeed={0.005}
            linkLabel={(link: Link) => (link as GraphLink).label ?? ''}
            onNodeClick={onNodeClick}
            onLinkClick={onLinkClick}
            onBackgroundClick={() => {
              setSelectedNode(null);
              setSelectedLink(null);
            }}
            enableZoomInteraction={true}
            enablePanInteraction={true}
            cooldownTicks={filteredGraphData.nodes.length > 500 ? 50 : 100}
            d3AlphaDecay={filteredGraphData.nodes.length > 500 ? 0.04 : 0.02}
            d3VelocityDecay={0.3}
          />

          <div className="graph-controls">
            <button
              className="graph-control-btn"
              onClick={() => {
                const current = fgRef.current?.zoom();
                if (current) fgRef.current?.zoom(current * 1.5, 300);
              }}
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
              onClick={() => {
                const current = fgRef.current?.zoom();
                if (current) fgRef.current?.zoom(current / 1.5, 300);
              }}
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
              onClick={() => fgRef.current?.zoomToFit(400, 60)}
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
          </div>
        </div>
      );
    },
  ),
);

export default GraphViewer;
