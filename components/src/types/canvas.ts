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

import type { GraphNode, GraphLink, SelectedEdge } from './graph';
import type {
  LayoutConfig,
  CommunityData,
  GetSubTypeFn,
} from '../graph/types';
import type { OptimizeStatus } from '../graph/LayoutPipelineTypes';

export interface AnimationSettings {
  selectionPulse: boolean;
}

export interface GraphCanvasProps {
  /** Graph nodes to render. */
  nodes: GraphNode[];
  /** Graph links/edges to render. */
  links: GraphLink[];
  /** Width of the canvas in pixels. */
  width: number;
  /** Height of the canvas in pixels. */
  height: number;
  /** Layout and color configuration. Defaults to DEFAULT_LAYOUT_CONFIG. */
  layoutConfig?: LayoutConfig;
  /** Color mode for nodes — 'type' uses node type colors, 'community' uses Louvain community colors. */
  colorMode?: 'type' | 'community';
  /** Set of node type strings to hide. */
  hiddenNodeTypes?: Set<string>;
  /** Set of link label strings to hide. */
  hiddenLinkTypes?: Set<string>;
  /** Set of "Type:SubType" strings to hide. */
  hiddenSubTypes?: Set<string>;
  /** Set of community IDs to hide. */
  hiddenCommunities?: Set<number>;
  /** Search query for highlighting matching nodes. */
  searchQuery?: string;
  /** Currently selected node ID (for BFS highlight). */
  selectedNodeId?: string | null;
  /** Number of hops for BFS neighborhood highlight. Default: 2. */
  hops?: number;
  /** Function to extract sub-type from a node (e.g. file extension). */
  getSubType?: GetSubTypeFn;
  /** Override computed highlight nodes (e.g. for edge-click highlighting). */
  highlightNodes?: Set<string>;
  /** Override computed highlight links. */
  highlightLinks?: Set<string>;
  /** Override computed label nodes. */
  labelNodes?: Set<string>;
  /** Sub-type groupings for filter support. */
  availableSubTypes?: Map<string, { subType: string; count: number }[]>;
  /** Enable z-index layer reordering when highlights are active. */
  zIndex?: boolean;
  /** Pre-computed community data. If omitted, computed internally. */
  communityData?: CommunityData;
  /** When false, all node labels are hidden. */
  labelsVisible?: boolean;
  /** Animation settings (glow, pulse, particles, smooth layout). */
  animationSettings?: AnimationSettings;
  /** Called when a node is clicked. */
  onNodeClick?: (node: GraphNode) => void;
  /** Called when an edge is clicked. */
  onEdgeClick?: (edge: SelectedEdge) => void;
  /** Called when the background (stage) is clicked. */
  onStageClick?: () => void;
  /** Called when the optimize status changes. */
  onOptimizeStatus?: (status: OptimizeStatus | null) => void;
  /** CSS class name for the container div. */
  className?: string;
  /** Inline styles for the container div. */
  style?: React.CSSProperties;
}

export interface GraphCanvasHandle {
  /** Select and zoom to a node by ID. */
  selectNode: (nodeId: string, hops?: number) => void;
  /** Zoom to fit all visible nodes. */
  zoomToFit: (duration?: number) => void;
  /** Zoom to specific node IDs. */
  zoomToNodes: (nodeIds: Iterable<string>, duration?: number) => void;
  /** Trigger a layout re-optimization. */
  optimize: () => void;
  /** Zoom in (reduce camera ratio). */
  zoomIn: (duration?: number) => void;
  /** Zoom out (increase camera ratio). */
  zoomOut: (duration?: number) => void;
  /** Reset camera to default position. */
  resetCamera: (duration?: number) => void;
  /** Stop physics simulation. */
  stopPhysics: () => void;
  /** Start physics simulation. */
  startPhysics: () => void;
  /** Returns whether physics is currently running. */
  isPhysicsRunning: () => boolean;
  setEdgesEnabled?: (enabled: boolean) => void;
  setShowLabels?: (show: boolean) => void;
  setChargeStrength?: (strength: number) => void;
  setLinkDistance?: (distance: number) => void;
  setCenterStrength?: (strength: number) => void;
  setCommunityGravity?: (enabled: boolean, strength?: number) => void;
  reheat?: () => void;
  fitToScreen?: () => void;
  setZoomSizeExponent?: (exponent: number) => void;
}
