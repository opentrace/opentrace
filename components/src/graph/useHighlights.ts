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

import { useMemo } from "react";
import type Graph from "graphology";
import type { GraphNode, GraphLink, FilterState } from "./types";

/** Extract a string ID from a link endpoint (handles string, number, and object forms). */
function endpointId(endpoint: string | number | GraphNode | undefined): string {
  if (typeof endpoint === "string") return endpoint;
  if (typeof endpoint === "object" && endpoint !== null)
    return (endpoint as GraphNode).id;
  return String(endpoint);
}

/**
 * Compute highlight sets (nodes, links, labels) and a hop-distance map based on
 * the current search query, selected node, hop depth, and filter state.
 *
 * Adjacency is built from `allLinks` filtered by `filterState.hiddenLinkTypes`
 * and excluding links whose endpoints belong to hidden node types.
 */
export function useHighlights(
  _graph: Graph,
  _layoutReady: boolean,
  allNodes: GraphNode[],
  allLinks: GraphLink[],
  searchQuery: string,
  selectedNodeId: string | null,
  hops: number,
  filterState: FilterState,
): {
  highlightNodes: Set<string>;
  highlightLinks: Set<string>;
  labelNodes: Set<string>;
  hopMap: Map<string, number>;
} {
  // Build a node-type lookup so we can filter out hidden endpoint types.
  const nodeTypeMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of allNodes) {
      map.set(node.id, node.type);
    }
    return map;
  }, [allNodes]);

  // Build adjacency from allLinks, respecting filter state.
  const adjacency = useMemo(() => {
    const map = new Map<string, { neighbor: string; linkKey: string }[]>();
    for (const link of allLinks) {
      // Skip hidden link types.
      if (filterState.hiddenLinkTypes.has(link.label)) continue;

      const sourceId = endpointId(link.source);
      const targetId = endpointId(link.target);

      // Skip links where either endpoint is a hidden node type.
      const sourceType = nodeTypeMap.get(sourceId);
      const targetType = nodeTypeMap.get(targetId);
      if (sourceType && filterState.hiddenNodeTypes.has(sourceType)) continue;
      if (targetType && filterState.hiddenNodeTypes.has(targetType)) continue;

      const linkKey = `${sourceId}-${targetId}`;
      if (!map.has(sourceId)) map.set(sourceId, []);
      if (!map.has(targetId)) map.set(targetId, []);
      map.get(sourceId)!.push({ neighbor: targetId, linkKey });
      map.get(targetId)!.push({ neighbor: sourceId, linkKey });
    }
    return map;
  }, [
    allLinks,
    filterState.hiddenLinkTypes,
    filterState.hiddenNodeTypes,
    nodeTypeMap,
  ]);

  // Compute highlights via search and/or BFS from selected node.
  return useMemo(() => {
    const highlightNodes = new Set<string>();
    const highlightLinks = new Set<string>();
    const labelNodes = new Set<string>();
    const hopMap = new Map<string, number>();

    // Search: find nodes whose name, id, or type contain the query.
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      for (const node of allNodes) {
        if (
          node.name?.toLowerCase().includes(q) ||
          node.id.toLowerCase().includes(q) ||
          node.type.toLowerCase().includes(q)
        ) {
          highlightNodes.add(node.id);
          labelNodes.add(node.id);
        }
      }
    }

    // BFS from selected node up to `hops` depth for highlights,
    // but only up to min(2, hops) for labels.
    if (selectedNodeId) {
      const labelDepth = Math.min(2, hops);
      highlightNodes.add(selectedNodeId);
      labelNodes.add(selectedNodeId);
      hopMap.set(selectedNodeId, 0);
      let frontier = new Set<string>([selectedNodeId]);
      for (let depth = 0; depth < hops && frontier.size > 0; depth++) {
        const nextFrontier = new Set<string>();
        frontier.forEach((nodeId) => {
          const edges = adjacency.get(nodeId);
          if (!edges) return;
          edges.forEach(({ neighbor, linkKey }) => {
            highlightLinks.add(linkKey);
            if (!highlightNodes.has(neighbor)) {
              nextFrontier.add(neighbor);
              hopMap.set(neighbor, depth + 1);
            }
            highlightNodes.add(neighbor);
            if (depth < labelDepth) {
              labelNodes.add(neighbor);
            }
          });
        });
        frontier = nextFrontier;
      }
    }

    return { highlightNodes, highlightLinks, labelNodes, hopMap };
  }, [allNodes, searchQuery, selectedNodeId, hops, adjacency]);
}
