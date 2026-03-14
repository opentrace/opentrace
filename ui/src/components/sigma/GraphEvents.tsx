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
      enterNode: () => { container.style.cursor = 'pointer'; },
      leaveNode: () => { container.style.cursor = 'default'; },
      enterEdge: () => { container.style.cursor = 'pointer'; },
      leaveEdge: () => { container.style.cursor = 'default'; },
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
          properties: (attrs._graphLink as { properties?: Record<string, unknown> })?.properties,
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
