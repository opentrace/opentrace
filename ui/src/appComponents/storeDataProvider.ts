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

import type { DiscoverDataProvider, TreeNodeData } from '@opentrace/components';
import type { NodeResult, GraphStore } from '../store/types';

const REPO_TYPES = new Set(['Repository']);

function sortRank(type: string): number {
  if (type === 'Repository' || type === 'Directory') return 0;
  if (type === 'File') return 1;
  if (type === 'PullRequest') return 2;
  return 3;
}

function sortChildren(nodes: NodeResult[]): NodeResult[] {
  return [...nodes].sort((a, b) => {
    const ra = sortRank(a.type);
    const rb = sortRank(b.type);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Create a {@link DiscoverDataProvider} backed by a {@link GraphStore}.
 *
 * This is the default provider used by the OSS app. Cloud or other
 * consumers can supply their own provider implementation.
 */
export function createStoreDataProvider(
  store: GraphStore,
): DiscoverDataProvider {
  return {
    async fetchRoots(): Promise<TreeNodeData[]> {
      const repositories = await store.listNodes('Repository', 100);
      return sortChildren(repositories);
    },

    async fetchChildren(
      nodeId: string,
      nodeType: string,
    ): Promise<TreeNodeData[]> {
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
            .traverse(nodeId, 'outgoing', 1, 'DEFINES')
            .then((r) =>
              r.filter((x) => x.node.id !== nodeId).map((x) => x.node),
            ),
        );
        if (REPO_TYPES.has(nodeType)) {
          queries.push(
            store
              .traverse(nodeId, 'incoming', 1, 'REFERENCES')
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

    async fetchAncestorPath(nodeId: string): Promise<string[]> {
      const ancestors: string[] = [];
      let currentId = nodeId;
      // Walk up the tree (max 20 levels to avoid infinite loops)
      for (let i = 0; i < 20; i++) {
        const results = await store.traverse(
          currentId,
          'outgoing',
          1,
          'DEFINES',
        );
        const parent = results.find((r) => r.node.id !== currentId);
        if (!parent) break;
        ancestors.push(parent.node.id);
        currentId = parent.node.id;
      }
      ancestors.reverse(); // root → ... → parent
      return ancestors;
    },
  };
}
