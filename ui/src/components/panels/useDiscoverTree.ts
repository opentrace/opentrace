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
import type {
  TreeNodeData,
  UseDiscoverTreeOptions,
  UseDiscoverTreeResult,
} from './types';

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

/**
 * Manages the DiscoverPanel tree state (roots, children, expanded)
 * using a pluggable {@link DiscoverDataProvider} for data fetching.
 *
 * This hook owns all the async loading, auto-expand, and expand-to-node
 * logic so that consumers only need to supply a data provider and wire
 * the returned state into `<DiscoverPanel>`.
 */
export function useDiscoverTree({
  dataProvider,
  refreshKey,
  isExpandable = defaultIsExpandable,
  autoExpandDepth = 3,
}: UseDiscoverTreeOptions): UseDiscoverTreeResult {
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
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // O(1) node-type lookup map, rebuilt when roots/childrenMap change
  const nodeTypeMapRef = useRef(new Map<string, string>());
  nodeTypeMapRef.current = (() => {
    const m = new Map<string, string>();
    for (const r of roots) m.set(r.id, r.type);
    for (const children of childrenMap.values()) {
      for (const c of children) m.set(c.id, c.type);
    }
    return m;
  })();

  /** Fetch children and write them into state. */
  const loadChildren = useCallback(
    async (nodeId: string, nodeType: string): Promise<TreeNodeData[]> => {
      const children = await dataProvider.fetchChildren(nodeId, nodeType);
      setChildrenMap((prev) => {
        const next = new Map(prev);
        next.set(nodeId, children);
        return next;
      });
      return children;
    },
    [dataProvider],
  );

  // Load roots on mount (and re-load when refreshKey changes), then auto-expand
  useEffect(() => {
    let cancelled = false;
    async function init() {
      setChildrenMap(new Map());
      try {
        const fetchedRoots = await dataProvider.fetchRoots();
        if (cancelled) return;
        setRoots(fetchedRoots);

        // Auto-expand N levels (root → children → grandchildren → ...)
        const newExpandedIds = new Set<string>();
        const newChildrenMap = new Map<string, TreeNodeData[]>();

        async function expandLevel(
          nodes: TreeNodeData[],
          depth: number,
        ): Promise<void> {
          if (depth >= autoExpandDepth || cancelled) return;
          const expandable = nodes.filter((n) => isExpandable(n));
          const childResults = await Promise.all(
            expandable.map(async (n) => {
              const children = await dataProvider.fetchChildren(n.id, n.type);
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

        await expandLevel(fetchedRoots, 0);
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
    init().catch((err: unknown) => {
      // AbortError fires when clearGraph races with in-flight expansions
      // (e.g. project switch). Expected — swallow silently. Preserve
      // existing unhandled-rejection behavior for anything else.
      if ((err as { name?: string })?.name === 'AbortError') return;
      throw err;
    });
    return () => {
      cancelled = true;
    };
  }, [dataProvider, refreshKey, isExpandable, autoExpandDepth]);

  const toggleExpand = useCallback(
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
        await loadChildren(nodeId, nodeTypeMapRef.current.get(nodeId) ?? '');
      } finally {
        setLoadingSet((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    },
    [loadChildren, childrenMap, loadingSet],
  );

  const expandToNode = useCallback(
    (nodeId: string): (() => void) => {
      // Check if the node is already visible in the tree
      const isVisible = (id: string): boolean => {
        for (const r of rootsRef.current) {
          if (r.id === id) return true;
        }
        const currentExpanded = expandedRef.current;
        for (const [parentId, children] of childrenMapRef.current.entries()) {
          if (
            children.some((c) => c.id === id) &&
            currentExpanded.has(parentId)
          ) {
            return true;
          }
        }
        return false;
      };

      if (isVisible(nodeId)) {
        return () => {};
      }

      let cancelled = false;
      (async () => {
        const ancestors = await dataProvider.fetchAncestorPath(nodeId);
        if (cancelled || ancestors.length === 0) return;

        // Load children for each ancestor (top-down) and expand
        for (const ancestorId of ancestors) {
          if (cancelled) return;
          if (!childrenMapRef.current.has(ancestorId)) {
            await loadChildren(
              ancestorId,
              nodeTypeMapRef.current.get(ancestorId) || 'Directory',
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

      // Return cleanup for the caller (useEffect will call this)
      return () => {
        cancelled = true;
      };
    },
    [dataProvider, loadChildren],
  );

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const expandAll = useCallback(() => {
    const allExpandable = new Set<string>();
    for (const [parentId, children] of childrenMap.entries()) {
      if (children.length > 0) {
        allExpandable.add(parentId);
      }
    }
    setExpanded(allExpandable);
  }, [childrenMap]);

  return {
    roots,
    childrenMap,
    expanded,
    loading,
    toggleExpand,
    collapseAll,
    expandAll,
    expandToNode,
  };
}
