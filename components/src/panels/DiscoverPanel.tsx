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

import { useEffect, useMemo, useState } from 'react';
import { List, useListRef } from 'react-window';
import type { RowComponentProps } from 'react-window';
import { getNodeColor } from '../colors/nodeColors';
import type { DiscoverPanelProps, TreeNodeData } from './types';
import './DiscoverPanel.css';

const ROW_HEIGHT = 28;

const DEFAULT_EXPANDABLE_TYPES = new Set([
  'Repository',
  'Directory',
  'File',
  'Class',
  'PullRequest',
]);

function defaultIsExpandable(node: TreeNodeData): boolean {
  return DEFAULT_EXPANDABLE_TYPES.has(node.type);
}

/** Sort priority: directories → files → PRs → symbols, then alphabetical */
function sortRank(type: string): number {
  if (type === 'Repository' || type === 'Directory') return 0;
  if (type === 'File') return 1;
  if (type === 'PullRequest') return 2;
  return 3;
}

function displayName(name: string): string {
  const segments = name.split('/');
  return segments[segments.length - 1] || name;
}

function sortChildren(nodes: TreeNodeData[]): TreeNodeData[] {
  return [...nodes].sort((a, b) => {
    const ra = sortRank(a.type);
    const rb = sortRank(b.type);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

/** Check if a node or any of its cached descendants are in the graph */
function isInGraph(
  node: TreeNodeData,
  graphIds: Set<string>,
  childrenMap: Map<string, TreeNodeData[]>,
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
  node: TreeNodeData,
  filter: string,
  childrenMap: Map<string, TreeNodeData[]>,
): boolean {
  if (displayName(node.name).toLowerCase().includes(filter)) return true;
  const children = childrenMap.get(node.id);
  if (children) {
    return children.some((c) => matchesFilter(c, filter, childrenMap));
  }
  return false;
}

interface FlatRow {
  node: TreeNodeData;
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
  roots: TreeNodeData[],
  expanded: Set<string>,
  childrenMap: Map<string, TreeNodeData[]>,
  filter: string,
  hideOffGraph: boolean,
  graphNodeIdSet: Set<string> | undefined,
  isExpandable: (node: TreeNodeData) => boolean,
): FlatRow[] {
  const rows: FlatRow[] = [];

  function walk(nodes: TreeNodeData[], depth: number) {
    for (const node of nodes) {
      // Filter check
      if (filter && !matchesFilter(node, filter, childrenMap)) continue;

      // Graph visibility check
      if (hideOffGraph && graphNodeIdSet) {
        if (!isInGraph(node, graphNodeIdSet, childrenMap)) continue;
      }

      const children = childrenMap.get(node.id);
      const couldExpand = isExpandable(node);
      const knownEmpty = children !== undefined && children.length === 0;
      const expandable = couldExpand && !knownEmpty;
      const isExpanded = expanded.has(node.id);

      rows.push({ node, depth, expandable, isExpanded, isLoading: false });

      // Recurse into expanded children
      if (isExpanded && children && children.length > 0) {
        const sorted = sortChildren(children);
        const visibleChildren = filter
          ? sorted.filter((c) => matchesFilter(c, filter, childrenMap))
          : sorted;
        walk(visibleChildren, depth + 1);
      } else if (isExpanded && !children) {
        // Expanded but children not yet in map — show loading placeholder
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

/** Props passed to each virtualized row via rowProps. */
interface TreeRowProps {
  flatRows: FlatRow[];
  selectedNodeId?: string;
  graphNodeIdSet?: Set<string>;
  childrenMap: Map<string, TreeNodeData[]>;
  hopMap?: Map<string, number>;
  maxHops: number;
  onToggle: (nodeId: string) => void;
  onSelect: (nodeId: string) => void;
}

/** Virtualized row component for react-window v2. */
function TreeRow({
  index,
  style,
  flatRows,
  selectedNodeId,
  graphNodeIdSet,
  childrenMap,
  hopMap,
  maxHops,
  onToggle,
  onSelect,
}: RowComponentProps<TreeRowProps>) {
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
    !isSelected && hopHighlight !== undefined ? 'discover-tree-row--hop' : '',
    offGraph && hopHighlight === undefined ? 'discover-tree-row--faded' : '',
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
  );
}

export default function DiscoverPanel({
  roots,
  childrenMap,
  expanded,
  onToggleExpand,
  onSelectNode,
  selectedNodeId,
  graphNodeIds,
  hopMap,
  isExpandable = defaultIsExpandable,
  loading,
}: DiscoverPanelProps) {
  const [filter, setFilter] = useState('');
  const [hideOffGraph, setHideOffGraph] = useState(false);

  const listRef = useListRef(null);

  // Build a Set for O(1) lookups; undefined means "no filtering" (all nodes in graph)
  const graphNodeIdSet = useMemo(
    () => (graphNodeIds ? new Set(graphNodeIds) : undefined),
    [graphNodeIds],
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

  const normalizedFilter = filter.toLowerCase().trim();

  // Flatten tree into virtual rows
  const flatRows = useMemo(
    () =>
      flattenTree(
        roots,
        expanded,
        childrenMap,
        normalizedFilter,
        hideOffGraph,
        graphNodeIdSet,
        isExpandable,
      ),
    [
      roots,
      expanded,
      childrenMap,
      normalizedFilter,
      hideOffGraph,
      graphNodeIdSet,
      isExpandable,
    ],
  );

  // Scroll to selected node when selection changes
  useEffect(() => {
    if (!selectedNodeId || !listRef.current) return;
    const idx = flatRows.findIndex((r) => r.node.id === selectedNodeId);
    if (idx >= 0) {
      listRef.current.scrollToRow({ index: idx, align: 'center' });
    }
  }, [selectedNodeId, flatRows, listRef]);

  // Stable rowProps object for react-window
  const rowProps: TreeRowProps = useMemo(
    () => ({
      flatRows,
      selectedNodeId,
      graphNodeIdSet,
      childrenMap,
      hopMap,
      maxHops,
      onToggle: onToggleExpand,
      onSelect: onSelectNode,
    }),
    [
      flatRows,
      selectedNodeId,
      graphNodeIdSet,
      childrenMap,
      hopMap,
      maxHops,
      onToggleExpand,
      onSelectNode,
    ],
  );

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
      {flatRows.length === 0 ? (
        <div className="discover-panel-empty">No matches</div>
      ) : (
        <List
          listRef={listRef}
          rowCount={flatRows.length}
          rowHeight={ROW_HEIGHT}
          rowComponent={TreeRow}
          rowProps={rowProps}
          overscanCount={20}
          className="discover-virtual-list"
        />
      )}
    </div>
  );
}
