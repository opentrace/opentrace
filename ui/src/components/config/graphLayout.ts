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
// Hot edges (chat traversal / highlight neighborhood) render at this ABSOLUTE
// alpha (see edgeMaterial's `1 + value` encoding), bypassing the preset's edge
// opacity. Kept airy so the lit path reads as a soft glow, not a heavy web.
export const EDGE_OPACITY_HIGHLIGHTED = 0.5; // when part of a selected neighborhood
export const EDGE_OPACITY_DIMMED = 0.08; // when another node is selected
// While a selection/highlight is active, floor the hot-edge multiplier
// (uHotOpacity) to this so the lit neighborhood is clearly visible even on
// presets that keep the ambient edge layer faint (Planet 15%, Onion 0%) —
// otherwise `EDGE_OPACITY_HIGHLIGHTED × preset-opacity` is nearly invisible.
// Rendered hot alpha ≈ EDGE_OPACITY_HIGHLIGHTED × this (≈0.4). Only raises the
// multiplier (max with the user's slider), never lowers it.
export const HIGHLIGHT_EDGE_OPACITY_FLOOR = 0.8;

// ─── Hot-edge glow ribbon ───────────────────────────────────────────────
// Highlighted / chat-traversal edges render as soft, curved, additively-blended
// strands of light (see hotEdgeMaterial.ts) instead of straight 1px GL lines,
// so a highlight reads as organic filaments rather than a vector-graphic star.

// Samples per curve — how finely the bezier is tessellated. Higher = smoother.
export const HOT_EDGE_CURVE_SEGMENTS = 20;
// Sideways bow of the curve as a fraction of the edge's straight length. 0 =
// straight; larger = more pronounced arc.
export const HOT_EDGE_SAG_FACTOR = 0.16;
// Ribbon half-width in WORLD units (not pixels) so strands shrink with the
// graph as you zoom out — a fixed pixel width made the additive glow pile into
// one saturated blob at low zoom. Kept fairly thin so a hub's strands read as
// distinct, traceable rays instead of merging into a washed-out fan; thinner
// ribbons also overlap less, so they can stay bright without piling to white.
export const HOT_EDGE_HALF_WIDTH = 5;
// Opacity of a highlighted (selected-node) edge line. Rendered as a plain crisp
// line under normal blending — overlapping strands at a hub just show the edge
// colour, never summing to a white blob, so no per-strand/taper capping needed.
export const HOT_EDGE_GLOW_ALPHA = 0.85;
// Above this many hot edges the ribbon is skipped and they fall back to the
// bulk line set — which, under DOF, is the BLURRED background, so this must be
// high enough that a normal selection (incl. hops 3–4) stays in the sharp
// ribbon. Only a pathological hub selection should ever exceed it.
export const HOT_EDGE_MAX = 10000;

// Depth-of-field: blur radius (in half-res texels per gaussian step) applied to
// the background while a highlight is active. Higher = more defocused. The blur
// runs at half resolution, so the effective full-res blur is roughly double.
export const DOF_BLUR_RADIUS = 1.2;

// Curve ALL bulk edges (not just highlights) into gentle arcs. Points sampled
// per curve — the GPU expands each edge to this via instancing, so the cost is
// vertex-shader only (no per-frame CPU work); 10 is plenty smooth for a bow.
export const CURVE_ALL_EDGES_SEGMENTS = 10;
// Skip graph-wide curving above this edge count: past here edges are hidden by
// default to stay readable, so the arcs wouldn't show and aren't worth the
// vertex work. Highlights still curve (via the hot-edge ribbon) at any size.
export const CURVE_ALL_EDGES_MAX = 40000;

// ─── Node Opacity ───────────────────────────────────────────────────────

// Non-highlighted nodes when a highlight/search is active: kept clearly
// present but soft ("out of focus" like the rebuild animation) rather than
// shrunk to near-nothing — the highlighted set still stands out via its glow.
export const NODE_OPACITY_DIMMED = 0.45; // when another node is selected
export const NODE_SIZE_DIMMED_SCALE = 0.75; // soften non-highlighted nodes without hiding them
// Highlighted (chat/search) nodes: airy rather than solid beacons — the enlarge
// + glow already draw the eye, so full opacity read as too heavy.
export const NODE_OPACITY_HIGHLIGHTED = 0.6;
export const NODE_SIZE_HIGHLIGHTED_SCALE = 1.6; // enlarge highlighted nodes so they pop (chat/search highlights); the extra room hosts the glow halo

// ─── Zoom Scaling ───────────────────────────────────────────────────────
// Controls how node sizes scale when zooming out.
// Higher = nodes shrink faster when zooming out.

export const ZOOM_SIZE_EXPONENT = 0.7;

// ─── d3-Force Layout ────────────────────────────────────────────────────
// Layout uses only DEFINES edges. These control the force simulation.

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
  // Priority-ORDERED list of tree-forming edge types: each node anchors to
  // ONE full-strength parent spring — its highest-priority tree edge — and
  // surplus tree edges demote to the weak relational weight (see
  // useForceLayout3d). The order encodes where a node with several homes
  // should live:
  //   DEFINES   — code containment (Repository → Directory → File → symbol)
  //   MIRRORS   — a KnowledgeDoc anchors AT its File twin, draping the corpus
  //               over the part of the repo it documents, instead of
  //               orbiting the vault
  //   DOCUMENTS — a repo-spawned Vault hangs off its Repository
  //   CONTAINS  — vault membership; the fallback anchor for non-repo docs
  //               (uploads, URLs, attached globals)
  // LINKS_TO is deliberately NOT a tree type — it is a many-to-many mesh, and
  // as full-strength springs those edges weld the docs into one clump. It stays
  // a semantic cross-link (analogous to CALLS), not hierarchy.
  layoutEdgeType: ['DEFINES', 'MIRRORS', 'DOCUMENTS', 'CONTAINS'],
  structuralTypes: ['Repository', 'Directory', 'Dependency', 'KnowledgeVault'],
  // Color functions — OpenTrace palettes
  getNodeColor,
  getLinkColor,
  buildCommunityColorMap,
  buildCommunityNames,
  getCommunityColor,
};
