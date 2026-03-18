import type { GraphNode } from '../types/graph';

/** All layout tuning parameters bundled into one object. */
export interface LayoutConfig {
  // d3-force Phase 1
  linkDistance: number;
  chargeStrength: number;
  simulationTicks: number;
  // d3-force Phase 2 (community clustering)
  clusterStrength: number;
  clusterTicks: number;
  clusterSeparation: number;
  // ForceAtlas2
  fa2Enabled: boolean;
  fa2Gravity: number;
  fa2ScalingRatio: number;
  fa2SlowDown: number;
  fa2BarnesHutThreshold: number;
  fa2BarnesHutTheta: number;
  fa2StrongGravity: boolean;
  fa2LinLogMode: boolean;
  fa2OutboundAttraction: boolean;
  fa2AdjustSizes: boolean;
  fa2Duration: number;
  // Noverlap
  noverlapMaxNodes: number;
  noverlapMaxIterations: number;
  noverlapRatio: number;
  noverlapMargin: number;
  noverlapExpansion: number;
  // Louvain
  louvainResolution: number;
  // Rendering
  edgeProgramThreshold: number;
}

export interface FilterState {
  hiddenNodeTypes: Set<string>;
  hiddenLinkTypes: Set<string>;
  hiddenSubTypes: Set<string>;
  hiddenCommunities: Set<number>;
}

export interface VisualState {
  colorMode: 'type' | 'community';
  highlightNodes: Set<string>;
  highlightLinks: Set<string>;
  labelNodes: Set<string>;
  selectedNodeId: string | null;
}

export interface CommunityData {
  assignments: Record<string, number>;
  colorMap: Map<number, string>;
  names: Map<number, string>;
  count: number;
}

/** Function to extract a sub-type from a node (e.g. file extension, language). */
export type GetSubTypeFn = (node: GraphNode) => string | null;
