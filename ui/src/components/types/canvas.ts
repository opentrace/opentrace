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
import type { LayoutConfig, CommunityData, GetSubTypeFn } from '../graph/types';
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
  /** When false, the edge layer is not drawn (Fix #7). Reapplied on
   *  prop change so the value survives graph refreshes; the imperative
   *  `setEdgesEnabled` handle remains available for one-off toggles. */
  edgesEnabled?: boolean;
  /** Whether community wayfinder labels are shown (Fix #52). */
  communityLabelsVisible?: boolean;
  /** Animation settings (glow, pulse, particles, smooth layout). */
  animationSettings?: AnimationSettings;
  /** Called when a node is clicked. */
  onNodeClick?: (node: GraphNode) => void;
  /** Called when an edge is clicked. */
  onEdgeClick?: (edge: SelectedEdge) => void;
  /** Called when the background (stage) is clicked. */
  onStageClick?: () => void;
  /** Called when the cursor enters a node (canvas-local px) or leaves one
   *  (`null` node). Hosts use it for hover tooltips. */
  onNodeHover?: (node: GraphNode | null, x: number, y: number) => void;
  /** Called when the optimize status changes. */
  onOptimizeStatus?: (status: OptimizeStatus | null) => void;
  /** Initial layout mode: 'spread' (force-directed) or 'compact' (radial/circular). */
  layoutMode?: 'spread' | 'compact' | 'tree' | 'onion';
  /** Sprite size response to zoom — `appliedSize = baseSize * (1/scale)^exp`.
   *  Re-applied on every prop change so the persisted user setting takes
   *  effect immediately on mount (Fix #22). Without this the renderer
   *  sat at its hard-coded default of 0.8 even when the slider showed a
   *  different saved value, and only a manual touch would resync them. */
  zoomSizeExponent?: number;
  /** Label scale multiplier. Persisted setting; re-applied like
   *  `zoomSizeExponent` so the renderer matches the slider on mount. */
  labelScale?: number;
  /** User edge-opacity multiplier (1.0 = default). Scales the renderer's
   *  zoom-driven edge opacity so edges can be made more/less visible. */
  edgeOpacity?: number;
  /** Charge/repulsion strength (negative = repel). Persisted physics setting;
   *  re-applied on prop change so a saved value takes effect on load, not just
   *  on a live slider drag (same pattern as `zoomSizeExponent`/`labelScale`). */
  chargeStrength?: number;
  /** Target distance between linked nodes. Persisted; re-applied like
   *  `chargeStrength`. */
  linkDistance?: number;
  /** Compact-layout tuning (already-scaled values). Persisted; re-applied on
   *  prop change. Pass a stable (memoized) object so the effect only fires when
   *  a value actually changes. */
  compactConfig?: {
    radialStrength: number;
    communityPull: number;
    centeringStrength: number;
    radiusScale: number;
  };
  /** Enable pseudo-3D rotation mode. */
  mode3d?: boolean;
  /** Auto-rotation speed in radians/frame. Persisted setting; re-applied on
   *  prop change so the renderer matches the slider on mount (same pattern as
   *  `zoomSizeExponent`/`labelScale`). Without this a saved rotation speed was
   *  stored but never applied — the renderer kept its hard-coded default. */
  rotationSpeed?: number;
  /** Camera tilt as a fraction (elevation above the equator). Persisted
   *  setting; re-applied on prop change like `rotationSpeed`. */
  cameraTilt?: number;
  /** Called when auto-rotation state changes (e.g. paused on node click). */
  on3DAutoRotateChange?: (autoRotate: boolean) => void;
  /** When true, the canvas is in continuous live-build mode: incremental data
   *  updates animate in (new nodes fly out from their parent + scale up; placed
   *  nodes stay put, pinned in the layout) instead of teleporting/reshuffling.
   *  Used while indexing so the graph visibly builds itself in real time. */
  liveGrow?: boolean;
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
  /**
   * Throttled auto-fit — re-frames the graph unless the user has taken
   * manual control of the camera (via pan/zoom/rotate/zoomToNodes). Safe
   * to call from bursty producers (e.g. the d3-force worker streaming
   * positions during indexing); fires at most ~5×/sec.
   */
  scheduleAutoFit?: (duration?: number) => void;
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
  /** Show/hide the community wayfinder labels independently of
   *  layout mode (Fix #52). */
  setShowCommunityLabels?: (show: boolean) => void;
  setChargeStrength?: (strength: number) => void;
  setLinkDistance?: (distance: number) => void;
  setCenterStrength?: (strength: number) => void;
  setCommunityGravity?: (enabled: boolean, strength?: number) => void;
  reheat?: () => void;
  fitToScreen?: () => void;
  setZoomSizeExponent?: (exponent: number) => void;
  /** Switch layout mode: 'spread' (force-directed) or 'compact' (radial/circular). */
  setLayoutMode?: (mode: 'spread' | 'compact' | 'tree' | 'onion') => void;
  /** Update compact-mode-specific parameters. */
  updateCompactConfig?: (config: {
    radialStrength?: number;
    communityPull?: number;
    centeringStrength?: number;
    radiusScale?: number;
  }) => void;
  /** Enable/disable pseudo-3D rotation mode. */
  set3DMode?: (enabled: boolean) => void;
  /** Set 3D auto-rotation speed (radians/frame, default 0.003). */
  set3DSpeed?: (speed: number) => void;
  /** Set 3D camera tilt (radians, default 0.35). */
  set3DTilt?: (tilt: number) => void;
  /** Enable/disable 3D auto-rotation. */
  set3DAutoRotate?: (enabled: boolean) => void;
  /** Set label scale multiplier (independent of node size, default 1.0). */
  setLabelScale?: (scale: number) => void;
  /** Set the user edge-opacity multiplier (1.0 = default). */
  setEdgeOpacity?: (opacity: number) => void;
  /** Trigger a ping/glow animation on the given node IDs. */
  triggerPing?: (nodeIds: Iterable<string>) => void;
  /** Arm the next data load to collapse immediately and hold hidden until
   *  playBuildAnimation() fires — prevents the finished graph flashing before
   *  the burst. Call as soon as an index completes. */
  armBuildAnimation?: () => void;
  /** Replay the graph "building itself" — reveal nodes/edges outward from the
   *  root in BFS order. Cosmetic; the final state is unchanged. Three.js only;
   *  optional so other renderers may omit it. */
  playBuildAnimation?: (rootIds?: string[]) => void;
  /** Abort an in-flight build replay and snap to the final state. */
  stopBuildAnimation?: () => void;
  /** Whether a build replay is currently running. */
  isBuildAnimating?: () => boolean;
  /** Animate the agent "walking" the graph: a glow pulse glides edge-by-edge
   *  through each leg (an ordered real-edge path from the already-discovered
   *  set to a newly-found node), lighting edges and pinging nodes as reached.
   *  `orphanIds` are finds with no path — they just ping. Reached nodes/edges
   *  stay lit until `clearTraversal()`. Successive calls append to the walk.
   *  Three.js only; optional so other renderers may omit it. */
  animateTraversal?: (
    legs: { edges: { sourceId: string; targetId: string }[]; destId: string }[],
    orphanIds?: string[],
  ) => void;
  /** Clear the traversal walk and its lit trail (new question / highlights off). */
  clearTraversal?: () => void;
  /** Re-lay-out the graph from a fresh seed — used on view-preset switches so
   *  the result depends only on the preset's forces, not the prior layout.
   *  Three.js only; optional so other renderers may omit it. */
  reseedLayout?: () => void;
  /** Toggle the nebula cloud layout (the Nebula preset). `baseMode` is the
   *  layout to fall back to when disabling. Three.js only. */
  setNebulaLayout?: (
    enabled: boolean,
    baseMode?: 'spread' | 'compact' | 'tree' | 'onion',
  ) => void;
  /** Toggle ambient motion — a gentle perpetual wander after the layout settles
   *  so the graph stays alive instead of freezing. Three.js only. */
  setAmbientMotion?: (enabled: boolean) => void;
}
