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

import { useEffect } from 'react';
import { useRegisterEvents, useSigma } from '@react-sigma/core';
import type { GraphNode, SelectedEdge } from '../../types/graph';

interface GraphEventsProps {
  onNodeClick: (node: GraphNode) => void;
  onEdgeClick: (edge: SelectedEdge) => void;
  onStageClick: () => void;
}

export default function GraphEvents({
  onNodeClick,
  onEdgeClick,
  onStageClick,
}: GraphEventsProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();

  useEffect(() => {
    const container = sigma.getContainer();

    registerEvents({
      enterNode: () => {
        container.style.cursor = 'pointer';
      },
      leaveNode: () => {
        container.style.cursor = 'default';
      },
      enterEdge: () => {
        container.style.cursor = 'pointer';
      },
      leaveEdge: () => {
        container.style.cursor = 'default';
      },
      clickNode: ({ node }) => {
        const graph = sigma.getGraph();
        const attrs = graph.getNodeAttributes(node);
        const graphNode = attrs._graphNode as GraphNode | undefined;
        if (graphNode) {
          onNodeClick(graphNode);
        }
      },
      clickEdge: ({ edge }) => {
        const graph = sigma.getGraph();
        const attrs = graph.getEdgeAttributes(edge);
        const source = graph.source(edge);
        const target = graph.target(edge);
        const sourceAttrs = graph.getNodeAttributes(source);
        const targetAttrs = graph.getNodeAttributes(target);
        const selectedEdge: SelectedEdge = {
          source,
          target,
          label: (attrs.label as string) || 'unknown',
          properties: (
            attrs._graphLink as { properties?: Record<string, unknown> }
          )?.properties,
          sourceNode: sourceAttrs._graphNode as GraphNode | undefined,
          targetNode: targetAttrs._graphNode as GraphNode | undefined,
        };
        onEdgeClick(selectedEdge);
      },
      clickStage: () => {
        onStageClick();
      },
    });
  }, [registerEvents, sigma, onNodeClick, onEdgeClick, onStageClick]);

  return null;
}
