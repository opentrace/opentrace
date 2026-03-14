/**
 * Web Worker that runs d3-force layout off the main thread.
 *
 * Receives: { nodeIds: string[], links: { source, target }[], config }
 * Returns:  { positions: [id, x, y][] }
 */
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
} from 'd3-force';

interface SimNode {
  id: string;
  x?: number;
  y?: number;
}

interface SimLink {
  source: string;
  target: string;
}

export interface LayoutRequest {
  nodeIds: string[];
  links: SimLink[];
  config: {
    linkDistance: number;
    chargeStrength: number;
    ticks: number;
  };
}

export interface LayoutResponse {
  positions: [string, number, number][];
}

self.onmessage = (e: MessageEvent<LayoutRequest>) => {
  const { nodeIds, links, config } = e.data;

  const simNodes: SimNode[] = nodeIds.map((id) => ({ id }));

  const simulation = forceSimulation(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(links)
        .id((d) => d.id)
        .distance(config.linkDistance),
    )
    .force('charge', forceManyBody().strength(config.chargeStrength))
    .force('center', forceCenter(0, 0))
    .stop();

  for (let i = 0; i < config.ticks; i++) {
    simulation.tick();
  }

  const positions: [string, number, number][] = simNodes.map((n) => [
    n.id,
    n.x ?? 0,
    n.y ?? 0,
  ]);

  (self as unknown as Worker).postMessage({
    positions,
  } satisfies LayoutResponse);
};
