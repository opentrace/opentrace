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

import { useMemo } from 'react';
import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';
import type {
  GraphNode,
  GraphLink,
  CommunityData,
  LayoutConfig,
} from './types';

/**
 * Compute Louvain communities on the full (unfiltered) graph.
 * Color and naming functions are provided via layoutConfig to avoid
 * coupling to a specific color palette.
 */
export function useCommunities(
  allNodes: GraphNode[],
  allLinks: GraphLink[],
  layoutConfig: LayoutConfig,
): CommunityData {
  return useMemo(() => {
    if (allNodes.length === 0) {
      return {
        assignments: {} as Record<string, number>,
        colorMap: new Map<number, string>(),
        names: new Map<number, string>(),
        count: 0,
      };
    }

    const tempGraph = new UndirectedGraph();
    const nodeIdSet = new Set<string>();

    for (const node of allNodes) {
      if (!nodeIdSet.has(node.id)) {
        tempGraph.addNode(node.id);
        nodeIdSet.add(node.id);
      }
    }

    for (const link of allLinks) {
      const source =
        typeof link.source === 'string'
          ? link.source
          : (link.source as GraphNode).id;
      const target =
        typeof link.target === 'string'
          ? link.target
          : (link.target as GraphNode).id;
      if (source === target) continue;
      if (!nodeIdSet.has(source) || !nodeIdSet.has(target)) continue;

      if (tempGraph.hasEdge(source, target)) {
        const w =
          (tempGraph.getEdgeAttribute(source, target, 'weight') as number) ?? 1;
        tempGraph.setEdgeAttribute(source, target, 'weight', w + 1);
      } else {
        tempGraph.addEdge(source, target, { weight: 1 });
      }
    }

    const assignments = louvain(tempGraph, {
      resolution: layoutConfig.louvainResolution,
      getEdgeWeight: 'weight',
    });
    const colorMap = layoutConfig.buildCommunityColorMap(assignments);
    const names = layoutConfig.buildCommunityNames(assignments, allNodes);
    const count = new Set(Object.values(assignments)).size;

    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[graph] Louvain: ${count} communities from ${allNodes.length} nodes`,
      );
    }

    return { assignments, colorMap, names, count };
  }, [allNodes, allLinks, layoutConfig]);
}
