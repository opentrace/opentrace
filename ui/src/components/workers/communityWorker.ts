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

/**
 * Web Worker that runs Louvain community detection off the main thread.
 *
 * Receives: { nodes, links, resolution }
 * Returns:  { assignments: Record<string, number> }
 *
 * Only the Louvain algorithm runs here. Color mapping and naming run on
 * the main thread with the returned assignments (they depend on LayoutConfig
 * functions which aren't serializable).
 */

import { UndirectedGraph } from 'graphology';
import louvain from 'graphology-communities-louvain';

export interface CommunityRequest {
  nodes: { id: string; type: string }[];
  links: { source: string; target: string; label: string }[];
  resolution: number;
}

export interface CommunityResponse {
  assignments: Record<string, number>;
}

self.onmessage = (e: MessageEvent<CommunityRequest>) => {
  const { nodes, links, resolution } = e.data;

  const tempGraph = new UndirectedGraph();
  const nodeIdSet = new Set<string>();

  for (const node of nodes) {
    if (!nodeIdSet.has(node.id)) {
      tempGraph.addNode(node.id);
      nodeIdSet.add(node.id);
    }
  }

  for (const link of links) {
    if (link.source === link.target) continue;
    if (!nodeIdSet.has(link.source) || !nodeIdSet.has(link.target)) continue;

    if (tempGraph.hasEdge(link.source, link.target)) {
      const w =
        (tempGraph.getEdgeAttribute(
          link.source,
          link.target,
          'weight',
        ) as number) ?? 1;
      tempGraph.setEdgeAttribute(link.source, link.target, 'weight', w + 1);
    } else {
      tempGraph.addEdge(link.source, link.target, { weight: 1 });
    }
  }

  const assignments = louvain(tempGraph, {
    resolution,
    getEdgeWeight: 'weight',
  });

  (self as unknown as Worker).postMessage({
    assignments,
  } satisfies CommunityResponse);
};
