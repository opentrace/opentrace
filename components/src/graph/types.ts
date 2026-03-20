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
 * Graph node — the minimal interface required by the graph layout system.
 * Consumers can extend this with additional properties.
 */
export interface GraphNode {
  id: string;
  name: string;
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * Graph link — the minimal interface required by the graph layout system.
 */
export interface GraphLink {
  source: string;
  target: string;
  label: string;
  properties?: Record<string, unknown>;
}

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
  /** Iterations for per-community noverlap push-apart */
  noverlapCommunityIterations: number;
  // Louvain
  louvainResolution: number;
  // Rendering
  edgeProgramThreshold: number;
  // Graph structure — which edge type to use for force layout
  layoutEdgeType: string;
  // Node types considered structural (affect sizing)
  structuralTypes: string[];
  // Color functions — consumers provide their own palettes
  getNodeColor: (type: string) => string;
  getLinkColor: (label: string) => string;
  /** Build a community→color mapping from assignments (largest community gets first palette slot) */
  buildCommunityColorMap: (
    assignments: Record<string, number>,
  ) => Map<number, string>;
  /** Derive human-readable community names from assignments and nodes */
  buildCommunityNames: (
    assignments: Record<string, number>,
    nodes: GraphNode[],
  ) => Map<number, string>;
  /** Look up the community color for a given node */
  getCommunityColor: (
    assignments: Record<string, number>,
    colorMap: Map<number, string>,
    nodeId: string,
  ) => string;
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
