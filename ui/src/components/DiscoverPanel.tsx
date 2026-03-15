import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FixedSizeList } from 'react-window';
import { useStore } from '../store/context';
import { getNodeColor } from '../chat/results/nodeColors';
import { PARSEABLE_EXTENSIONS } from '../runner/browser/loader/constants';
import type { NodeResult } from '../store/types';
import './DiscoverPanel.css';

const ROW_HEIGHT = 28;

const EXPANDABLE_TYPES = new Set([
  'Repo',
  'Repository',
  'Directory',
  'File',
  'Class',
  'Module',
  'PullRequest',
]);

const REPO_TYPES = new Set(['Repo', 'Repository']);

/** Sort priority: directories → files → PRs → symbols, then alphabetical */
function sortRank(type: string): number {
  if (type === 'Repo' || type === 'Repository' || type === 'Directory')
    return 0;
  if (type === 'File') return 1;
  if (type === 'PullRequest') return 2;
  return 3;
}

function hasParsableExtension(name: string): boolean {
  const dotIdx = name.lastIndexOf('.');
  return (
    dotIdx >= 0 && PARSEABLE_EXTENSIONS.has(name.slice(dotIdx).toLowerCase())
  );
}

function displayName(name: string): string {
  const segments = name.split('/');
  return segments[segments.length - 1] || name;
}

function sortChildren(nodes: NodeResult[]): NodeResult[] {
  return [...nodes].sort((a, b) => {
    const ra = sortRank(a.type);
    const rb = sortRank(b.type);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

/** Check if a node or any of its cached descendants are in the graph */
function isInGraph(
  node: NodeResult,
  graphIds: Set<string>,
  childrenMap: Map<string, NodeResult[]>,
): boolean {
  if (graphIds.has(node.id)) return true;
  const children = childrenMap.get(node.id);
  if (children) {
    return children.some((c) => isInGraph(c, graphIds, childrenMap));
  }
  return false;
}

/** Check if a node or any of its cached descendants match the filter */
function matchesFilter(
  node: NodeResult,
  filter: string,
  childrenMap: Map<string, NodeResult[]>,
): boolean {
  if (displayName(node.name).toLowerCase().includes(filter)) return true;
  const children = childrenMap.get(node.id);
  if (children) {
    return children.some((c) => matchesFilter(c, filter, childrenMap));
  }
  return false;
}

interface FlatRow {
  node: NodeResult;
  depth: number;
  expandable: boolean;
  isExpanded: boolean;
  isLoading: boolean;
}

/**
 * Flatten the tree into a list of visible rows for virtual scrolling.
 * Walks roots → expanded children recursively, applying filter and hideOffGraph.
 */
function flattenTree(
  roots: NodeResult[],
  expanded: Set<string>,
  childrenMap: Map<string, NodeResult[]>,
  loadingSet: Set<string>,
  filter: string,
  hideOffGraph: boolean,
  graphNodeIdSet?: Set<string>,
): FlatRow[] {
  const rows: FlatRow[] = [];

  function walk(nodes: NodeResult[], depth: number) {
    for (const node of nodes) {
      // Filter check
      if (filter && !matchesFilter(node, filter, childrenMap)) continue;

      // Graph visibility check
      if (hideOffGraph && graphNodeIdSet) {
        if (!isInGraph(node, graphNodeIdSet, childrenMap)) continue;
      }

      const children = childrenMap.get(node.id);
      const couldExpand =
        EXPANDABLE_TYPES.has(node.type) &&
        (node.type !== 'File' || hasParsableExtension(node.name));
      const knownEmpty = children !== undefined && children.length === 0;
      const expandable = couldExpand && !knownEmpty;
      const isExpanded = expanded.has(node.id);
      const isLoading = loadingSet.has(node.id);

      rows.push({ node, depth, expandable, isExpanded, isLoading });

      // Recurse into expanded children
      if (isExpanded && children && children.length > 0) {
        const visibleChildren = filter
          ? children.filter((c) => matchesFilter(c, filter, childrenMap))
          : children;
        walk(visibleChildren, depth + 1);
      } else if (isExpanded && isLoading) {
        // Placeholder row for loading state
        rows.push({
          node: {
            id: `__loading_${node.id}`,
            name: 'Loading...',
            type: '__loading',
            properties: {},
          },
          depth: depth + 1,
          expandable: false,
          isExpanded: false,
          isLoading: true,
        });
      }
    }
  }

  walk(roots, 0);
  return rows;
}

interface DiscoverPanelProps {
  onSelectNode: (nodeId: string) => void;
  graphVersion?: number;
  selectedNodeId?: string;
  /** Node IDs currently visible in the graph view */
  graphNodeIds?: string[];
  /** Map of node ID → hop distance from selected node */
  hopMap?: Map<string, number>;
  /** Whether this tab is currently visible */
  isActive?: boolean;
}

export default function DiscoverPanel({
  onSelectNode,
  graphVersion,
  selectedNodeId,
  graphNodeIds,
  hopMap,
  isActive,
}: DiscoverPanelProps) {
  const { store } = useStore();
  const [roots, setRoots] = useState<NodeResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, NodeResult[]>>(
    new Map(),
  );
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [hideOffGraph, setHideOffGraph] = useState(false);
  const [listHeight, setListHeight] = useState(400);

  const listRef = useRef<FixedSizeList>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Refs for latest values — used by async effects to avoid stale closures
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;

  // Measure container height for the virtual list
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListHeight(entry.contentRect.height);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Build a Set for O(1) lookups; undefined means "no filtering" (all nodes in graph)
  const graphNodeIdSet = useMemo(
    () => (graphNodeIds ? new Set(graphNodeIds) : undefined),
    [graphNodeIds],
  );

  /** Fetch children for a node without writing to state — pure data fetch. */
  const fetchChildren = useCallback(
    async (nodeId: string, nodeType: string): Promise<NodeResult[]> => {
      const queries: Promise<NodeResult[]>[] = [];

      if (nodeType === 'PullRequest') {
        queries.push(
          store
            .traverse(nodeId, 'outgoing', 1, 'CHANGES')
            .then((r) =>
              r.filter((x) => x.node.id !== nodeId).map((x) => x.node),
            ),
        );
      } else {
        queries.push(
          store
            .traverse(nodeId, 'incoming', 1, 'DEFINED_IN')
            .then((r) =>
              r.filter((x) => x.node.id !== nodeId).map((x) => x.node),
            ),
        );
        if (REPO_TYPES.has(nodeType)) {
          queries.push(
            store
              .traverse(nodeId, 'incoming', 1, 'TARGETS_REPO')
              .then((r) =>
                r.filter((x) => x.node.id !== nodeId).map((x) => x.node),
              ),
          );
        }
      }

      const results = await Promise.all(queries);
      const seen = new Set<string>();
      const merged: NodeResult[] = [];
      for (const nodes of results) {
        for (const node of nodes) {
          if (!seen.has(node.id)) {
            seen.add(node.id);
            merged.push(node);
          }
        }
      }
      return sortChildren(merged);
    },
    [store],
  );

  /** Fetch children and write them to state (used for interactive expand). */
  const loadChildren = useCallback(
    async (nodeId: string, nodeType: string): Promise<NodeResult[]> => {
      const children = await fetchChildren(nodeId, nodeType);
      setChildrenMap((prev) => {
        const next = new Map(prev);
        next.set(nodeId, children);
        return next;
      });
      return children;
    },
    [fetchChildren],
  );

  // Load repo roots on mount (and re-load when graphVersion changes), then auto-expand 3 levels
  useEffect(() => {
    let cancelled = false;
    async function init() {
      // Clear stale cache so re-expanding fetches fresh data
      setChildrenMap(new Map());
      try {
        const [repos, repositories] = await Promise.all([
          store.listNodes('Repo', 100),
          store.listNodes('Repository', 100),
        ]);
        if (cancelled) return;
        const seen = new Set<string>();
        const merged: NodeResult[] = [];
        for (const node of [...repos, ...repositories]) {
          if (!seen.has(node.id)) {
            seen.add(node.id);
            merged.push(node);
          }
        }
        const sorted = sortChildren(merged);
        setRoots(sorted);

        // Auto-expand 3 levels (root → children → grandchildren)
        const newExpandedIds = new Set<string>();
        const newChildrenMap = new Map<string, NodeResult[]>();

        async function expandLevel(
          nodes: NodeResult[],
          depth: number,
        ): Promise<void> {
          if (depth >= 3 || cancelled) return;
          const expandable = nodes.filter((n) => EXPANDABLE_TYPES.has(n.type));
          const childResults = await Promise.all(
            expandable.map(async (n) => {
              const children = await fetchChildren(n.id, n.type);
              return { parentId: n.id, children };
            }),
          );
          if (cancelled) return;
          for (const { parentId, children } of childResults) {
            newChildrenMap.set(parentId, children);
            if (children.length > 0) newExpandedIds.add(parentId);
          }
          const allChildren = childResults.flatMap((r) => r.children);
          await expandLevel(allChildren, depth + 1);
        }

        await expandLevel(sorted, 0);
        if (!cancelled) {
          setChildrenMap((prev) => {
            const next = new Map(prev);
            for (const [k, v] of newChildrenMap) next.set(k, v);
            return next;
          });
          setExpanded((prev) => {
            const next = new Set(prev);
            for (const id of newExpandedIds) next.add(id);
            return next;
          });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [store, graphVersion, fetchChildren]);

  /** Find a node's type from roots or childrenMap */
  const findNodeType = useCallback(
    (nodeId: string): string => {
      for (const r of roots) {
        if (r.id === nodeId) return r.type;
      }
      for (const children of childrenMap.values()) {
        for (const c of children) {
          if (c.id === nodeId) return c.type;
        }
      }
      return '';
    },
    [roots, childrenMap],
  );

  const handleToggle = useCallback(
    async (nodeId: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(nodeId)) {
          next.delete(nodeId);
          return next;
        }
        next.add(nodeId);
        return next;
      });

      // Lazy-load children if not cached or already loading
      if (childrenMap.has(nodeId) || loadingSet.has(nodeId)) return;

      setLoadingSet((prev) => new Set(prev).add(nodeId));
      try {
        await loadChildren(nodeId, findNodeType(nodeId));
      } finally {
        setLoadingSet((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    },
    [loadChildren, childrenMap, findNodeType, loadingSet],
  );

  // Compute max hops for gradient scaling
  const maxHops = useMemo(() => {
    if (!hopMap || hopMap.size === 0) return 1;
    let max = 0;
    for (const d of hopMap.values()) {
      if (d > max) max = d;
    }
    return max || 1;
  }, [hopMap]);

  // Auto-expand tree path to the selected node
  useEffect(() => {
    if (!selectedNodeId) return;

    // Use refs for latest values to avoid stale closures
    const currentRoots = rootsRef.current;
    const currentChildrenMap = childrenMapRef.current;

    // Check if the node is already visible in the tree
    const isVisible = (nodeId: string): boolean => {
      for (const r of currentRoots) {
        if (r.id === nodeId) return true;
      }
      for (const [parentId, children] of currentChildrenMap.entries()) {
        if (children.some((c) => c.id === nodeId) && expanded.has(parentId)) {
          return true;
        }
      }
      return false;
    };

    if (isVisible(selectedNodeId)) return;

    // Walk up DEFINED_IN to find ancestor path, then expand it
    let cancelled = false;
    (async () => {
      const ancestors: string[] = [];
      let currentId = selectedNodeId;
      // Walk up the tree (max 20 levels to avoid infinite loops)
      for (let i = 0; i < 20; i++) {
        const results = await store.traverse(
          currentId,
          'outgoing',
          1,
          'DEFINED_IN',
        );
        if (cancelled) return;
        const parent = results.find((r) => r.node.id !== currentId);
        if (!parent) break;
        ancestors.push(parent.node.id);
        // If we've reached a root, stop
        if (rootsRef.current.some((r) => r.id === parent.node.id)) break;
        currentId = parent.node.id;
      }
      if (cancelled || ancestors.length === 0) return;

      // Load children for each ancestor (top-down) and expand
      ancestors.reverse(); // root → ... → parent
      for (const ancestorId of ancestors) {
        if (cancelled) return;
        if (!childrenMapRef.current.has(ancestorId)) {
          await loadChildren(
            ancestorId,
            findNodeType(ancestorId) || 'Directory',
          );
        }
      }
      if (cancelled) return;
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const id of ancestors) next.add(id);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedNodeId, store, loadChildren, findNodeType, expanded]);

  const normalizedFilter = filter.toLowerCase().trim();

  // Flatten tree into virtual rows
  const flatRows = useMemo(
    () =>
      flattenTree(
        roots,
        expanded,
        childrenMap,
        loadingSet,
        normalizedFilter,
        hideOffGraph,
        graphNodeIdSet,
      ),
    [
      roots,
      expanded,
      childrenMap,
      loadingSet,
      normalizedFilter,
      hideOffGraph,
      graphNodeIdSet,
    ],
  );

  // Scroll to selected node when selection changes or tab becomes active
  useEffect(() => {
    if (!selectedNodeId || !isActive || !listRef.current) return;
    const idx = flatRows.findIndex((r) => r.node.id === selectedNodeId);
    if (idx >= 0) {
      listRef.current.scrollToItem(idx, 'center');
    }
  }, [selectedNodeId, isActive, flatRows]);

  if (loading) {
    return (
      <div className="discover-panel">
        <div className="discover-panel-empty">Loading repositories...</div>
      </div>
    );
  }

  if (roots.length === 0) {
    return (
      <div className="discover-panel">
        <div className="discover-panel-empty">No repositories indexed yet.</div>
      </div>
    );
  }

  return (
    <div className="discover-panel" ref={containerRef}>
      <div className="discover-filter-bar">
        <input
          className="discover-filter-input"
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button
            className="discover-filter-clear"
            onClick={() => setFilter('')}
            title="Clear filter"
          >
            &times;
          </button>
        )}
      </div>
      {graphNodeIdSet && (
        <div className="discover-graph-toggle">
          <label className="discover-graph-toggle-label">
            <input
              type="checkbox"
              checked={hideOffGraph}
              onChange={(e) => setHideOffGraph(e.target.checked)}
            />
            <span className="discover-toggle-track" />
            <span>In graph only</span>
          </label>
        </div>
      )}
      {flatRows.length === 0 ? (
        <div className="discover-panel-empty">No matches</div>
      ) : (
        <FixedSizeList
          ref={listRef}
          height={listHeight}
          itemCount={flatRows.length}
          itemSize={ROW_HEIGHT}
          width="100%"
          overscanCount={20}
          itemKey={(index) => flatRows[index].node.id}
        >
          {({ index, style }) => {
            const row = flatRows[index];
            const { node, depth, expandable, isExpanded } = row;

            // Loading placeholder row
            if (node.type === '__loading') {
              return (
                <div
                  className="discover-tree-placeholder"
                  style={{
                    ...style,
                    paddingLeft: `${12 + depth * 16}px`,
                  }}
                >
                  Loading...
                </div>
              );
            }

            const isSelected = node.id === selectedNodeId;
            const offGraph = graphNodeIdSet
              ? !isInGraph(node, graphNodeIdSet, childrenMap)
              : false;
            const hopDist = hopMap?.get(node.id);
            const hopHighlight =
              hopDist !== undefined && maxHops > 0
                ? Math.max(0.15, 1 - (hopDist / maxHops) * 0.85)
                : undefined;

            const rowClasses = [
              'discover-tree-row',
              isSelected ? 'discover-tree-row--selected' : '',
              !isSelected && hopHighlight !== undefined
                ? 'discover-tree-row--hop'
                : '',
              offGraph && hopHighlight === undefined
                ? 'discover-tree-row--faded'
                : '',
            ]
              .filter(Boolean)
              .join(' ');

            const rowStyle: React.CSSProperties = {
              ...style,
              paddingLeft: `${12 + depth * 16}px`,
              ...(!isSelected && hopHighlight !== undefined
                ? ({ '--hop-intensity': hopHighlight } as React.CSSProperties)
                : {}),
            };

            return (
              <div className={rowClasses} style={rowStyle}>
                {expandable ? (
                  <button
                    className="filter-expand-btn"
                    onClick={() => handleToggle(node.id)}
                    title={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      className={`filter-expand-icon ${isExpanded ? 'filter-expand-icon--open' : ''}`}
                    >
                      <path
                        d="M3 2 L7 5 L3 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                    </svg>
                  </button>
                ) : (
                  <span className="filter-expand-spacer" />
                )}
                <span
                  className="filter-dot"
                  style={{ backgroundColor: getNodeColor(node.type) }}
                />
                <button
                  className="discover-tree-name"
                  onClick={() => onSelectNode(node.id)}
                  title={node.name}
                >
                  {displayName(node.name)}
                </button>
                <span className="discover-tree-type">{node.type}</span>
              </div>
            );
          }}
        </FixedSizeList>
      )}
    </div>
  );
}
