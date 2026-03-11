import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph, {
  type ForceGraphMethods,
  type NodeObject,
  type LinkObject,
} from "react-force-graph-2d";
import type { GraphNode, GraphLink, GraphStats } from "./types/graph";
import type { NodeSourceResponse } from "./store/types";
import { useStore } from "./store";
import { getNodeColor } from "./chat/results/nodeColors";
import { getLinkColor } from "./chat/results/linkColors";
import { useJobService, useJobStream } from "./job";
import type { JobMessage } from "./job";
import AddRepoModal, { detectProvider } from "./components/AddRepoModal";
import IndexingProgress from "./components/IndexingProgress";
import JobMinimizedBar from "./components/JobMinimizedBar";
import ChatPanel from "./components/ChatPanel";
import FilterPanel from "./components/FilterPanel";
import SettingsDrawer from "./components/SettingsDrawer";
import ThemeSelector from "./components/ThemeSelector";
import "./App.css";

type Node = NodeObject<GraphNode>;
type Link = LinkObject<GraphNode, GraphLink>;

/** Node types whose source code can be fetched and displayed. */
const SOURCE_TYPES = new Set(["File", "Function", "Class", "Module"]);

/**
 * Extract the string ID from a link endpoint.
 * react-force-graph-2d mutates links at runtime, replacing string IDs
 * with object references after simulation starts. This helper handles both.
 */
function linkId(endpoint: string | number | Node | undefined): string {
  if (typeof endpoint === "object" && endpoint !== null) return endpoint.id;
  return String(endpoint);
}

function App() {
  const { store } = useStore();
  const jobService = useJobService();
  const { state: jobState, start: startJob, cancel: cancelJob, minimize: minimizeJob, reset: resetJob } = useJobStream(jobService);

  const fgRef = useRef<ForceGraphMethods<Node, Link>>(undefined);
  const [graphData, setGraphData] = useState<{ nodes: Node[]; links: Link[] }>({
    nodes: [],
    links: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [hops, setHops] = useState(2);
  const [lastSearchQuery, setLastApiQuery] = useState("");
  const [highlightNodes, setHighlightNodes] = useState(new Set<string>());
  const [highlightLinks, setHighlightLinks] = useState(new Set<string>());
  const [labelNodes, setLabelNodes] = useState(new Set<string>());
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState(new Set<string>(["Package"]));
  const [hiddenLinkTypes, setHiddenLinkTypes] = useState(new Set<string>(["DEPENDS_ON"]));
  const [stats, setStats] = useState<GraphStats | null>(null);
  const [nodeSource, setNodeSource] = useState<NodeSourceResponse | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  // Track the repo URL for provider detection in IndexingProgress
  const [activeRepoUrl, setActiveRepoUrl] = useState("");

  // Whether the full modal is re-expanded from the minimized bar
  const [jobExpanded, setJobExpanded] = useState(false);

  useEffect(() => {
    const onResize = () =>
      setDimensions({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const loadGraph = useCallback((query?: string, h: number = 0): Promise<void> => {
    setLoading(true);
    return store.fetchGraph(query, h)
      .then((data) => {
        setGraphData(data);
        setLoading(false);
        setLastApiQuery(query ?? "");
        setTimeout(() => fgRef.current?.zoomToFit(400, 60), 500);
        store.fetchStats().then(setStats).catch(() => {});
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [store]);

  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  // React to persisted: load the graph, then auto-minimize after a brief delay
  useEffect(() => {
    if (jobState.status === "persisted") {
      loadGraph().then(() => {
        setTimeout(() => minimizeJob(), 1500);
      });
    }
  }, [jobState.status, loadGraph, minimizeJob]);

  // React to done: final graph refresh with enriched data
  useEffect(() => {
    if (jobState.status === "done") {
      loadGraph();
    }
  }, [jobState.status, loadGraph]);

  const handleJobSubmit = useCallback((message: JobMessage) => {
    if (message.type === "index-repo") {
      setActiveRepoUrl(message.repoUrl);
    } else if (message.type === "index-directory") {
      setActiveRepoUrl(`local/${message.name}`);
    }
    setShowAddRepo(false);
    setJobExpanded(false);
    startJob(message);
  }, [startJob]);

  const handleJobClose = useCallback(() => {
    resetJob();
    setJobExpanded(false);
  }, [resetJob]);

  const handleCancelJob = useCallback(() => {
    cancelJob();
    setJobExpanded(false);
  }, [cancelJob]);

  const handleSearch = () => {
    if (searchQuery.trim()) {
      loadGraph(searchQuery.trim(), hops);
    }
  };

  const handleReset = () => {
    setSearchQuery("");
    setHops(2);
    setSelectedNode(null);
    if (lastSearchQuery) {
      loadGraph();
    }
  };

  // Derive available types from raw graph data (for filter panel)
  const availableNodeTypes = useMemo(() => {
    const counts: Record<string, number> = {};
    graphData.nodes.forEach((n) => { counts[n.type] = (counts[n.type] || 0) + 1; });
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [graphData.nodes]);

  const availableLinkTypes = useMemo(() => {
    const counts: Record<string, number> = {};
    graphData.links.forEach((l) => {
      const label = (l as unknown as GraphLink).label || "unknown";
      counts[label] = (counts[label] || 0) + 1;
    });
    return Object.entries(counts)
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count);
  }, [graphData.links]);

  // Apply type filters to produce the rendered graph
  const filteredGraphData = useMemo(() => {
    const nodes = graphData.nodes.filter((n) => !hiddenNodeTypes.has(n.type));
    const visibleNodeIds = new Set(nodes.map((n) => n.id));
    const links = graphData.links.filter((l) => {
      const sourceId = linkId(l.source);
      const targetId = linkId(l.target);
      const label = (l as unknown as GraphLink).label || "unknown";
      return visibleNodeIds.has(sourceId) && visibleNodeIds.has(targetId) && !hiddenLinkTypes.has(label);
    });
    return { nodes, links };
  }, [graphData, hiddenNodeTypes, hiddenLinkTypes]);

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
      fgRef.current?.zoomToFit(600, 60, (n: Node) => neighborhood.has(n.id));
    },
    [fgRef, hops, adjacency],
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

    const startLine = selectedNode.properties?.start_line as number | undefined;
    const endLine = selectedNode.properties?.end_line as number | undefined;

    store.fetchSource(selectedNode.id, startLine, endLine)
      .then((src) => { if (!cancelled) { if (src) setNodeSource(src); else setSourceError("Source not available"); } })
      .catch((err) => { if (!cancelled) setSourceError(err.message); })
      .finally(() => { if (!cancelled) setSourceLoading(false); });

    return () => { cancelled = true; };
  }, [selectedNode?.id, store]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update highlights when search or selection changes
  useEffect(() => {
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
    if (selectedNode) {
      const labelDepth = Math.min(2, hops);
      nodes.add(selectedNode.id);
      labels.add(selectedNode.id);
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
  }, [searchQuery, selectedNode, hops, adjacency, filteredGraphData]);

  // Compute degree (connection count) per node for size scaling
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
      const label = node.name ?? node.id;
      const size = nodeSize(node);
      const fontSize = Math.max(12 / globalScale, 1.5);
      const isHighlighted =
        highlightNodes.size === 0 || highlightNodes.has(node.id);

      ctx.globalAlpha = isHighlighted ? 1 : 0.15;

      // Glow on highlighted nodes (search, selection)
      if (highlightNodes.size > 0 && highlightNodes.has(node.id)) {
        ctx.shadowColor = nodeColor(node);
        ctx.shadowBlur = 15;
      }

      // Circle
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, size, 0, 2 * Math.PI);
      ctx.fillStyle = nodeColor(node);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Label — shown when zoomed in or within label radius (2 hops of selection)
      if (
        globalScale > 3.5 ||
        (labelNodes.size > 0 && labelNodes.has(node.id))
      ) {
        const isLight = document.documentElement.dataset.mode === "light";
        ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = isLight
          ? `rgba(0, 0, 0, ${isHighlighted ? 0.85 : 0.15})`
          : `rgba(255, 255, 255, ${isHighlighted ? 0.9 : 0.2})`;
        ctx.fillText(String(label), node.x!, node.y! + size + 2);
      }
      ctx.globalAlpha = 1;
    },
    [nodeColor, nodeSize, highlightNodes, labelNodes],
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
      const label = (l as unknown as GraphLink).label || "unknown";
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
    jobState.status === "running" ||
    jobState.status === "persisted" ||
    jobState.status === "error" ||
    ((jobState.status === "enriching" || jobState.status === "done") && jobExpanded);

  if (loading && !showAddRepo && !showFullModal) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>Loading graph...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="loading">
        <p>Failed to load graph: {error}</p>
        <button onClick={() => { setError(null); loadGraph(); }}>
          Retry
        </button>
      </div>
    );
  }

  const isEmpty = graphData.nodes.length === 0;

  if (isEmpty && !showFullModal) {
    return (
      <div className="app">
        <div className="empty-state-overlay">
          <div className="empty-state-content">
            <img src="/opentrace-logo.svg" alt="OpenTrace" className="empty-state-logo" />
            <h1>OpenTrace</h1>
            <p>No data in the graph yet. Add a repository to get started.</p>
            <button
              className="empty-state-add-btn"
              onClick={() => setShowAddRepo(true)}
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
          {showAddRepo && (
            <AddRepoModal
              onClose={() => setShowAddRepo(false)}
              onSubmit={handleJobSubmit}
            />
          )}
        </div>

        {showFullModal && (
          <IndexingProgress
            state={jobState}
            provider={detectProvider(activeRepoUrl)}
            onClose={handleJobClose}
            onCancel={handleCancelJob}
            onMinimize={() => setJobExpanded(false)}
          />
        )}
      </div>
    );
  }

  const chatWidth = 480;
  const graphWidth = showChat ? dimensions.width - chatWidth : dimensions.width;

  return (
    <div className="app">
      <div className="app-body">
        <div className="graph-viewport">
          <FilterPanel
            nodeTypes={availableNodeTypes}
            linkTypes={availableLinkTypes}
            hiddenNodeTypes={hiddenNodeTypes}
            hiddenLinkTypes={hiddenLinkTypes}
            onToggleNodeType={(type) =>
              setHiddenNodeTypes((prev) => {
                const next = new Set(prev);
                next.has(type) ? next.delete(type) : next.add(type);
                return next;
              })
            }
            onToggleLinkType={(type) =>
              setHiddenLinkTypes((prev) => {
                const next = new Set(prev);
                next.has(type) ? next.delete(type) : next.add(type);
                return next;
              })
            }
            onShowAllNodes={() => setHiddenNodeTypes(new Set())}
            onHideAllNodes={() => setHiddenNodeTypes(new Set(availableNodeTypes.map((t) => t.type)))}
            onShowAllLinks={() => setHiddenLinkTypes(new Set())}
            onHideAllLinks={() => setHiddenLinkTypes(new Set(availableLinkTypes.map((t) => t.type)))}
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
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
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
                setHops(Math.min(5, Math.max(0, parseInt(e.target.value) || 0)))
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
              disabled={!searchQuery.trim() || searchQuery === lastSearchQuery}
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
          <span className="badge-rendered">{filteredGraphData.nodes.length}</span>
          {stats && <span className="badge-total">({stats.total_nodes})</span>}
          <span>nodes</span>
          <span className="badge-sep">&middot;</span>
          <span className="badge-rendered">{filteredGraphData.links.length}</span>
          {stats && <span className="badge-total">({stats.total_edges})</span>}
          <span>edges</span>
        </span>
        {(jobState.status === "enriching" || jobState.status === "done") && !jobExpanded ? (
          <JobMinimizedBar
            state={jobState}
            onClick={() => setJobExpanded(true)}
            onCancel={handleCancelJob}
          />
        ) : (
          <button
            className="add-repo-btn"
            onClick={() => setShowAddRepo(true)}
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
                className={`chat-toggle-btn ${showChat ? "active" : ""}`}
                onClick={() => setShowChat(!showChat)}
                title="Toggle AI Chat"
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
          className={`settings-toggle-btn ${showSettings ? "active" : ""}`}
          onClick={() => setShowSettings(!showSettings)}
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

      {showAddRepo && jobState.status === "idle" && (
        <AddRepoModal
          onClose={() => setShowAddRepo(false)}
          onSubmit={handleJobSubmit}
        />
      )}

      {showFullModal && (
        <IndexingProgress
          state={jobState}
          provider={detectProvider(activeRepoUrl)}
          onClose={handleJobClose}
          onCancel={handleCancelJob}
          onMinimize={() => setJobExpanded(false)}
        />
      )}

          <div className="legend">
            {legendItems.map(({ type, count, color }) => (
              <span key={type} className="legend-item">
                <span className="legend-dot" style={{ backgroundColor: color }} />
                <span className="legend-count">{count}</span>
                {type}
              </span>
            ))}
            {legendLinkItems.length > 0 && (
              <>
                <span className="legend-divider" />
                {legendLinkItems.map(({ type, count, color }) => (
                  <span key={type} className="legend-item">
                    <span className="legend-line" style={{ backgroundColor: color }} />
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
            height={dimensions.height}
            backgroundColor="transparent"
            nodeCanvasObject={paintNode}
            nodeCanvasObjectMode={() => "replace"}
            nodePointerAreaPaint={nodePointerArea}
            nodeRelSize={1}
            nodeVal={(node: Node) => nodeSize(node) ** 2}
            linkColor={(link: Link) => {
              const id = `${linkId(link.source)}-${linkId(link.target)}`;
              const label = (link as GraphLink).label ?? "";
              const baseColor = label ? getLinkColor(label) : "#94a3b8";
              if (highlightLinks.has(id)) return baseColor;
              if (highlightLinks.size > 0 || highlightNodes.size > 0)
                return baseColor + "0D"; // ~5% opacity
              return baseColor + "4D"; // ~30% opacity
            }}
            linkWidth={(link: Link) => {
              return highlightLinks.has(`${linkId(link.source)}-${linkId(link.target)}`) ? 4 : 2.5;
            }}
            linkCurvature={0.25}
            linkDirectionalArrowLength={5}
            linkDirectionalArrowRelPos={1}
            linkDirectionalParticles={(link: Link) => {
              return highlightLinks.has(`${linkId(link.source)}-${linkId(link.target)}`) ? 4 : 1;
            }}
            linkDirectionalParticleWidth={(link: Link) => {
              return highlightLinks.has(`${linkId(link.source)}-${linkId(link.target)}`) ? 3 : 2;
            }}
            linkDirectionalParticleSpeed={0.005}
            linkLabel={(link: Link) => (link as GraphLink).label ?? ""}
            onNodeClick={onNodeClick}
            onBackgroundClick={() => setSelectedNode(null)}
            enableZoomInteraction={true}
            enablePanInteraction={true}
            cooldownTicks={100}
            d3AlphaDecay={0.02}
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              className="graph-control-btn"
              onClick={() => fgRef.current?.zoomToFit(400, 60)}
              title="Zoom to fit"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 3 21 3 21 9" />
                <polyline points="9 21 3 21 3 15" />
                <line x1="21" y1="3" x2="14" y2="10" />
                <line x1="3" y1="21" x2="10" y2="14" />
              </svg>
            </button>
          </div>

          {selectedNode && (
            <div className="node-details-panel">
              <div className="panel-header">
                <h3>Node Details</h3>
                <button className="close-btn" onClick={() => setSelectedNode(null)}>
                  &times;
                </button>
              </div>
              <div className="panel-content">
                <div className="detail-row">
                  <span className="label">Name</span>
                  <span className="value">{selectedNode.name || "N/A"}</span>
                </div>
                <div className="detail-row">
                  <span className="label">Type</span>
                  <span
                    className="value type-badge"
                    style={{ backgroundColor: nodeColor(selectedNode) }}
                  >
                    {selectedNode.type}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="label">ID</span>
                  <span className="value id-value">{selectedNode.id}</span>
                </div>

                {!!(selectedNode.properties?.summary || selectedNode.properties?.has_embedding) && (
                  <div className="detail-row">
                    <span className="label">Enrichment</span>
                    <div className="enrichment-pips">
                      {!!selectedNode.properties?.summary && (
                        <span className="enrichment-pip enrichment-pip--summarized">
                          <span className="enrichment-pip-dot" />
                          Summarized
                        </span>
                      )}
                      {!!selectedNode.properties?.has_embedding && (
                        <span className="enrichment-pip enrichment-pip--embedded">
                          <span className="enrichment-pip-dot" />
                          Embedded
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {selectedNode.properties &&
                  Object.keys(selectedNode.properties).length > 0 && (
                    <div className="properties-section">
                      <h4>Properties</h4>
                      {Object.entries(selectedNode.properties)
                        .filter(([k]) => k !== "has_embedding")
                        .map(([k, v]) => (
                        <div key={k} className="detail-row">
                          <span className="label">{k}</span>
                          <span className="value">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}

                {/* Source code viewer */}
                {SOURCE_TYPES.has(selectedNode.type) && (
                  <div className="source-section">
                    <h4>
                      Source
                      {nodeSource && (
                        <span className="source-path">{nodeSource.path}</span>
                      )}
                    </h4>
                    {sourceLoading && (
                      <div className="source-loading">Loading source...</div>
                    )}
                    {sourceError && (
                      <div className="source-error">{sourceError}</div>
                    )}
                    {nodeSource && (
                      <div className="source-viewer">
                        {nodeSource.start_line && nodeSource.end_line ? (
                          <div className="source-line-info">
                            Lines {nodeSource.start_line}&ndash;{nodeSource.end_line} of {nodeSource.line_count}
                          </div>
                        ) : null}
                        <pre className="source-code"><code>{
                          nodeSource.content.split("\n").map((line, i) => {
                            const lineNum = (nodeSource.start_line || 1) + i;
                            return (
                              <span key={i} className="source-line">
                                <span className="line-number">{lineNum}</span>
                                {line}
                                {"\n"}
                              </span>
                            );
                          })
                        }</code></pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {showChat && (
          <ChatPanel
            graphData={graphData}
            onClose={() => setShowChat(false)}
          />
        )}
      </div>

      {showSettings && (
        <SettingsDrawer
          onClose={() => setShowSettings(false)}
          onGraphCleared={() => {
            setShowSettings(false);
            loadGraph();
          }}
        />
      )}
    </div>
  );
}
export default App;
