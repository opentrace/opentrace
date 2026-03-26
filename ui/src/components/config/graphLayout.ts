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
 * ═══════════════════════════════════════════════════════════════════════
 * Graph Layout & Rendering Configuration
 *
 * All tunable parameters for graph appearance in one place.
 * Edit values here and see changes immediately on reload.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ─── Node Sizes (screen pixels) ─────────────────────────────────────────
// Base size is computed as: clamp(NODE_SIZE_MIN, NODE_SIZE_MIN + sqrt(degree) * NODE_SIZE_DEGREE_SCALE, NODE_SIZE_MAX)
// Then multiplied by the type multiplier below.

export const NODE_SIZE_MIN = 4;
export const NODE_SIZE_MAX = 20;
export const NODE_SIZE_DEGREE_SCALE = 1.8; // how much degree (connections) inflates size

// Type-based multipliers applied to the base size
export const NODE_SIZE_MULTIPLIERS: Record<string, number> = {
  Repository: 1.0,
  // All other STRUCTURAL_TYPES default to this:
  _structural: 1.0,
  // Everything else gets 1.0 (no multiplier)
};

// ─── Edge Sizes (screen pixels) ─────────────────────────────────────────

export const EDGE_SIZE_DEFAULT = 1; // normal state (curved arrows)
export const EDGE_SIZE_DEFAULT_LINE = 2; // normal state (straight lines, for large graphs)
export const EDGE_SIZE_HIGHLIGHTED = 1.25; // when part of a selected neighborhood
export const EDGE_SIZE_DIMMED = 0.5; // when another node is selected

// ─── Edge Opacity ───────────────────────────────────────────────────────
// Alpha blend against dark background (0 = invisible, 1 = full color)

export const EDGE_OPACITY_DEFAULT = 0.78; // normal state
export const EDGE_OPACITY_HIGHLIGHTED = 1.0; // when part of a selected neighborhood
export const EDGE_OPACITY_DIMMED = 0.08; // when another node is selected

// ─── Node Opacity ───────────────────────────────────────────────────────

export const NODE_OPACITY_DIMMED = 0.22; // when another node is selected
export const NODE_SIZE_DIMMED_SCALE = 0.35; // shrink non-highlighted nodes so edges show through

// ─── Zoom Scaling ───────────────────────────────────────────────────────
// Controls how node sizes scale when zooming out.
// Higher = nodes shrink faster when zooming out.

export const ZOOM_SIZE_EXPONENT = 0.7;

// ─── d3-Force Layout ────────────────────────────────────────────────────
// Layout uses only DEFINED_IN edges. These control the force simulation.

export const FORCE_LINK_DISTANCE = 200; // target distance between linked nodes
export const FORCE_CHARGE_STRENGTH = -200; // repulsion between all nodes (negative = repel)
export const FORCE_SIMULATION_TICKS = 80; // total simulation iterations (enough to seed FA2)
export const FORCE_CLUSTER_STRENGTH = 0.3; // how strongly nodes pull toward community centroid (0-1)
export const FORCE_CLUSTER_TICKS = 40; // additional ticks for clustering phase

// ─── ForceAtlas2 Live Physics ───────────────────────────────────────────
// Runs after d3-force initial positioning to refine the layout.
// Set FA2_ENABLED = false to skip (static layout only).

export const FA2_ENABLED = true;
export const FA2_GRAVITY = 0.1;
export const FA2_SCALING_RATIO = 120;
export const FA2_SLOW_DOWN = 0.5;
export const FA2_BARNES_HUT_THRESHOLD = 300; // use Barnes-Hut when nodeCount > this
export const FA2_BARNES_HUT_THETA = 0.5;
export const FA2_STRONG_GRAVITY = false;
export const FA2_LIN_LOG_MODE = true;
export const FA2_OUTBOUND_ATTRACTION = true;
export const FA2_ADJUST_SIZES = true;
export const FA2_DURATION = 20000; // ms to run before auto-stop

// ─── Noverlap Post-Processing ───────────────────────────────────────────
// Runs after FA2 stops (or after d3-force if FA2 disabled) to push apart remaining overlaps.

export const NOVERLAP_MAX_ITERATIONS = 50;
export const NOVERLAP_RATIO = 1.5;
export const NOVERLAP_MARGIN = 25;
export const NOVERLAP_EXPANSION = 1.5;
export const NOVERLAP_COMMUNITY_ITERATIONS = 20; // per-community push-apart passes

// ─── Renderer ───────────────────────────────────────────────────────────

// Above this edge count, use simple line edges instead of curved arrows
export const EDGE_PROGRAM_THRESHOLD = 50000;

export const LABEL_RENDERED_SIZE_THRESHOLD = 8;
export const LABEL_MAX_LENGTH = 64;
export const LABEL_SIZE = 12;
export const LABEL_FONT = 'Inter, system-ui, sans-serif';
export const LABEL_COLOR = '#e2e8f0';

// ─── Louvain Community Detection ────────────────────────────────────────
// Resolution >1 produces more communities (finer), <1 produces fewer (coarser).

export const LOUVAIN_RESOLUTION = 1.0;

// ─── Bundled LayoutConfig ──────────────────────────────────────────────
// Same values as above, bundled into a single object for passing to hooks/components.

import type { LayoutConfig } from '../graph/types';
import { getNodeColor } from '../colors/nodeColors';
import { getLinkColor } from '../colors/linkColors';
import {
  buildCommunityColorMap,
  buildCommunityNames,
  getCommunityColor,
} from '../colors/communityColors';

export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  linkDistance: FORCE_LINK_DISTANCE,
  chargeStrength: FORCE_CHARGE_STRENGTH,
  simulationTicks: FORCE_SIMULATION_TICKS,
  clusterStrength: FORCE_CLUSTER_STRENGTH,
  clusterTicks: FORCE_CLUSTER_TICKS,
  clusterSeparation: 2.5,
  fa2Enabled: FA2_ENABLED,
  fa2Gravity: FA2_GRAVITY,
  fa2ScalingRatio: FA2_SCALING_RATIO,
  fa2SlowDown: FA2_SLOW_DOWN,
  fa2BarnesHutThreshold: FA2_BARNES_HUT_THRESHOLD,
  fa2BarnesHutTheta: FA2_BARNES_HUT_THETA,
  fa2StrongGravity: FA2_STRONG_GRAVITY,
  fa2LinLogMode: FA2_LIN_LOG_MODE,
  fa2OutboundAttraction: FA2_OUTBOUND_ATTRACTION,
  fa2AdjustSizes: FA2_ADJUST_SIZES,
  fa2Duration: FA2_DURATION,
  noverlapMaxNodes: 3000,
  noverlapMaxIterations: NOVERLAP_MAX_ITERATIONS,
  noverlapRatio: NOVERLAP_RATIO,
  noverlapMargin: NOVERLAP_MARGIN,
  noverlapExpansion: NOVERLAP_EXPANSION,
  noverlapCommunityIterations: NOVERLAP_COMMUNITY_ITERATIONS,
  louvainResolution: LOUVAIN_RESOLUTION,
  edgeProgramThreshold: 50000,
  // Graph structure
  layoutEdgeType: 'DEFINED_IN',
  structuralTypes: ['Repository', 'Directory', 'Package'],
  // Color functions — OpenTrace palettes
  getNodeColor,
  getLinkColor,
  buildCommunityColorMap,
  buildCommunityNames,
  getCommunityColor,
};
