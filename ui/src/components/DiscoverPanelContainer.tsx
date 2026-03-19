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

import { useCallback, useEffect, useRef, useState } from 'react';
import { DiscoverPanel, type TreeNodeData } from '@opentrace/components';
import { useStore } from '../store/context';
import { PARSEABLE_EXTENSIONS } from '../runner/browser/loader/constants';
import type { NodeResult } from '../store/types';

const EXPANDABLE_TYPES = new Set([
  'Repository',
  'Directory',
  'File',
  'Class',
  'PullRequest',
]);

const REPO_TYPES = new Set(['Repository']);

function isExpandable(node: TreeNodeData): boolean {
  if (!EXPANDABLE_TYPES.has(node.type)) return false;
  if (node.type === 'File') {
    const dotIdx = node.name.lastIndexOf('.');
    return (
      dotIdx >= 0 &&
      PARSEABLE_EXTENSIONS.has(node.name.slice(dotIdx).toLowerCase())
    );
  }
  return true;
}

function sortChildren(nodes: NodeResult[]): NodeResult[] {
  return [...nodes].sort((a, b) => {
    const ra = sortRank(a.type);
    const rb = sortRank(b.type);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

function sortRank(type: string): number {
  if (type === 'Repository' || type === 'Directory') return 0;
  if (type === 'File') return 1;
  if (type === 'PullRequest') return 2;
  return 3;
}

interface DiscoverPanelContainerProps {
  onSelectNode: (nodeId: string) => void;
  graphVersion?: number;
  selectedNodeId?: string;
  graphNodeIds?: string[];
  hopMap?: Map<string, number>;
  isActive?: boolean;
}

export default function DiscoverPanelContainer({
  onSelectNode,
  graphVersion,
  selectedNodeId,
  graphNodeIds,
  hopMap,
  isActive,
}: DiscoverPanelContainerProps) {
  const { store } = useStore();
  const [roots, setRoots] = useState<TreeNodeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenMap, setChildrenMap] = useState<Map<string, TreeNodeData[]>>(
    new Map(),
  );
  const [loadingSet, setLoadingSet] = useState<Set<string>>(new Set());

  // Refs for latest values — used by async effects to avoid stale closures
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const childrenMapRef = useRef(childrenMap);
  childrenMapRef.current = childrenMap;

  /** Fetch children for a node without writing to state — pure data fetch. */
  const fetchChildren = useCallback(
    async (nodeId: string, nodeType: string): Promise<TreeNodeData[]> => {
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
    async (nodeId: string, nodeType: string): Promise<TreeNodeData[]> => {
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
        const newChildrenMap = new Map<string, TreeNodeData[]>();

        async function expandLevel(
          nodes: TreeNodeData[],
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

  if (loading) {
    return (
      <div className="discover-panel">
        <div className="discover-panel-empty">Loading repositories...</div>
      </div>
    );
  }

  return (
    <DiscoverPanel
      roots={roots}
      childrenMap={childrenMap}
      expanded={expanded}
      onToggleExpand={handleToggle}
      onSelectNode={onSelectNode}
      selectedNodeId={isActive ? selectedNodeId : undefined}
      graphNodeIds={graphNodeIds}
      hopMap={hopMap}
      isActive={isActive}
      isExpandable={isExpandable}
      loading={loading}
    />
  );
}
