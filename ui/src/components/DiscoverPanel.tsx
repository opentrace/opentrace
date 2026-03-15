import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/context';
import { getNodeColor } from '../chat/results/nodeColors';
import { PARSEABLE_EXTENSIONS } from '../runner/browser/loader/constants';
import type { NodeResult } from '../store/types';
import './DiscoverPanel.css';

const EXPANDABLE_TYPES = new Set([
  'Repository',
  'Directory',
  'File',
  'Class',
  'PullRequest',
]);

const REPO_TYPES = new Set(['Repository']);

/** Sort priority: directories → files → PRs → symbols, then alphabetical */
function sortRank(type: string): number {
  if (type === 'Repository' || type === 'Directory') return 0;
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

interface TreeItemProps {
  node: NodeResult;
  depth: number;
  expanded: Set<string>;
  childrenMap: Map<string, NodeResult[]>;
  loadingSet: Set<string>;
  filter: string;
  selectedNodeId?: string;
  graphNodeIdSet?: Set<string>;
  hideOffGraph: boolean;
  hopMap?: Map<string, number>;
  maxHops: number;
  scrollTrigger: number;
  onToggle: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
}

function TreeItem({
  node,
  depth,
  expanded,
  childrenMap,
  loadingSet,
  filter,
  selectedNodeId,
  graphNodeIdSet,
  hideOffGraph,
  hopMap,
  maxHops,
  scrollTrigger,
  onToggle,
  onSelect,
}: TreeItemProps) {
  const isExpanded = expanded.has(node.id);
  const isLoading = loadingSet.has(node.id);
  const children = childrenMap.get(node.id);

  // A node is expandable if it could have children and we either
  // haven't loaded yet, or it actually has children
  const couldExpand =
    EXPANDABLE_TYPES.has(node.type) &&
    (node.type !== 'File' || hasParsableExtension(node.name));
  const knownEmpty = children !== undefined && children.length === 0;
  const expandable = couldExpand && !knownEmpty;

  // Is this node (or a descendant) present in the current graph view?
  const offGraph = graphNodeIdSet
    ? !isInGraph(node, graphNodeIdSet, childrenMap)
    : false;

  // Hop distance from selected node (undefined = not in neighborhood)
  const hopDist = hopMap?.get(node.id);
  const isSelected = node.id === selectedNodeId;

  // Compute highlight intensity: 1.0 at hop 0, fading to ~0.15 at maxHops
  const hopHighlight =
    hopDist !== undefined && maxHops > 0
      ? Math.max(0.15, 1 - (hopDist / maxHops) * 0.85)
      : undefined;

  // Filter children if a filter is active
  const visibleChildren = useMemo(() => {
    if (!children || !filter) return children;
    return children.filter((c) => matchesFilter(c, filter, childrenMap));
  }, [children, filter, childrenMap]);

  // Scroll selected node to upper-third of the panel when selection changes or tab activates
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isSelected && rowRef.current) {
      const scrollParent = rowRef.current.closest(
        '.side-panel-content',
      ) as HTMLElement | null;
      // Skip if panel is hidden (display:none) — offsetParent is null in that case
      if (scrollParent && scrollParent.offsetParent !== null) {
        const rowRect = rowRef.current.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();
        const offset = rowRect.top - parentRect.top + scrollParent.scrollTop;
        scrollParent.scrollTo({
          top: offset - parentRect.height * 0.33,
          behavior: 'smooth',
        });
      }
    }
  }, [isSelected, scrollTrigger]);

  if (hideOffGraph && offGraph) return null;

  const rowClasses = [
    'discover-tree-row',
    isSelected ? 'discover-tree-row--selected' : '',
    !isSelected && hopHighlight !== undefined ? 'discover-tree-row--hop' : '',
    offGraph && hopHighlight === undefined ? 'discover-tree-row--faded' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const rowStyle: React.CSSProperties = {
    paddingLeft: `${12 + depth * 16}px`,
    ...(!isSelected && hopHighlight !== undefined
      ? ({ '--hop-intensity': hopHighlight } as React.CSSProperties)
      : {}),
  };

  return (
    <div className="discover-tree-group">
      <div
        className={rowClasses}
        style={rowStyle}
        ref={isSelected ? rowRef : undefined}
      >
        {expandable ? (
          <button
            className="filter-expand-btn"
            onClick={() => onToggle(node.id)}
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
          onClick={() => onSelect(node.id)}
          title={node.name}
        >
          {displayName(node.name)}
        </button>
        <span className="discover-tree-type">{node.type}</span>
      </div>

      {isExpanded && (
        <div className="discover-tree-children">
          {isLoading ? (
            <div
              className="discover-tree-placeholder"
              style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}
            >
              Loading...
            </div>
          ) : (
            visibleChildren?.map((child) => (
              <TreeItem
                key={child.id}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                childrenMap={childrenMap}
                loadingSet={loadingSet}
                filter={filter}
                selectedNodeId={selectedNodeId}
                graphNodeIdSet={graphNodeIdSet}
                hideOffGraph={hideOffGraph}
                hopMap={hopMap}
                maxHops={maxHops}
                scrollTrigger={scrollTrigger}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
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
  const [scrollTrigger, setScrollTrigger] = useState(0);

  // Refs for latest values — used by async effects to avoid stale closures
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;

  // Trigger scroll-into-view when the tab becomes active
  useEffect(() => {
    if (isActive && selectedNodeId) {
      setScrollTrigger((v) => v + 1);
    }
  }, [isActive, selectedNodeId]);

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
        const repositories = await store.listNodes('Repository', 100);
        if (cancelled) return;
        const sorted = sortChildren(repositories);
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

  const visibleRoots = useMemo(() => {
    if (!normalizedFilter) return roots;
    return roots.filter((r) => matchesFilter(r, normalizedFilter, childrenMap));
  }, [roots, normalizedFilter, childrenMap]);

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
    <div className="discover-panel">
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
      {visibleRoots.length === 0 ? (
        <div className="discover-panel-empty">No matches</div>
      ) : (
        visibleRoots.map((root) => (
          <TreeItem
            key={root.id}
            node={root}
            depth={0}
            expanded={expanded}
            childrenMap={childrenMap}
            loadingSet={loadingSet}
            filter={normalizedFilter}
            selectedNodeId={selectedNodeId}
            graphNodeIdSet={graphNodeIdSet}
            hideOffGraph={hideOffGraph}
            hopMap={hopMap}
            maxHops={maxHops}
            scrollTrigger={scrollTrigger}
            onToggle={handleToggle}
            onSelect={onSelectNode}
          />
        ))
      )}
    </div>
  );
}
