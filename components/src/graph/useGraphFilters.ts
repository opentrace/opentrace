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

import { useEffect } from "react";
import type Graph from "graphology";
import type { GraphNode, FilterState, GetSubTypeFn } from "./types";

// ─── Filter Logic ───────────────────────────────────────────────────────

/**
 * Determine whether a node should be hidden based on the current filter state.
 * Exported so it can be reused by other components.
 */
export function shouldHideNode(
  node: GraphNode,
  filterState: FilterState,
  communityAssignments: Record<string, number>,
  availableSubTypes: Map<string, { subType: string; count: number }[]>,
  getSubType: GetSubTypeFn,
): boolean {
  // Community filter
  const communityId = communityAssignments[node.id];
  if (
    communityId !== undefined &&
    filterState.hiddenCommunities.has(communityId)
  ) {
    return true;
  }

  // Sub-type filter: only applies when the node type has sub-types
  const subTypes = availableSubTypes.get(node.type);
  if (subTypes && subTypes.length > 0) {
    const subType = getSubType(node);
    if (subType && filterState.hiddenSubTypes.has(`${node.type}:${subType}`)) {
      return true;
    }
  }

  // Type filter
  if (filterState.hiddenNodeTypes.has(node.type)) {
    return true;
  }

  return false;
}

// ─── Hook ───────────────────────────────────────────────────────────────

/**
 * Sets `hidden` attribute on nodes/edges based on filter state.
 * Never touches x/y positions.
 */
export function useGraphFilters(
  graph: Graph,
  layoutReady: boolean,
  filterState: FilterState,
  communityAssignments: Record<string, number>,
  availableSubTypes: Map<string, { subType: string; count: number }[]>,
  getSubType: GetSubTypeFn,
): void {
  useEffect(() => {
    if (!layoutReady || graph.order === 0) return;

    // Track which nodes are hidden so we can hide their edges too
    const hiddenNodes = new Set<string>();

    // Batched node update — single event
    graph.updateEachNodeAttributes((id, attrs) => {
      const graphNode = attrs._graphNode as GraphNode | undefined;
      if (!graphNode) return attrs;

      const hidden = shouldHideNode(
        graphNode,
        filterState,
        communityAssignments,
        availableSubTypes,
        getSubType,
      );

      if (hidden) hiddenNodes.add(id);
      attrs.hidden = hidden;
      return attrs;
    });

    // Batched edge update — single event
    graph.updateEachEdgeAttributes((_id, attrs, source, target) => {
      // Hide edge if either endpoint is hidden
      if (hiddenNodes.has(source) || hiddenNodes.has(target)) {
        attrs.hidden = true;
        return attrs;
      }

      // Hide edge if its link type is hidden
      const label = attrs.label as string | undefined;
      if (label && filterState.hiddenLinkTypes.has(label)) {
        attrs.hidden = true;
        return attrs;
      }

      attrs.hidden = false;
      return attrs;
    });
  }, [
    graph,
    layoutReady,
    filterState,
    communityAssignments,
    availableSubTypes,
    getSubType,
  ]);
}
