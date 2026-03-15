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

export const NODE_SIZE_MIN = 2;
export const NODE_SIZE_MAX = 8;
export const NODE_SIZE_DEGREE_SCALE = 1.1; // how much degree (connections) inflates size

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
export const EDGE_SIZE_HIGHLIGHTED = 2.5; // when part of a selected neighborhood
export const EDGE_SIZE_DIMMED = 0.5; // when another node is selected

// ─── Edge Opacity ───────────────────────────────────────────────────────
// Alpha blend against dark background (0 = invisible, 1 = full color)

export const EDGE_OPACITY_DEFAULT = 0.6; // normal state
export const EDGE_OPACITY_HIGHLIGHTED = 1.0; // when part of a selected neighborhood
export const EDGE_OPACITY_DIMMED = 0.05; // when another node is selected

// ─── Node Opacity ───────────────────────────────────────────────────────

export const NODE_OPACITY_DIMMED = 0.15; // when another node is selected

// ─── Zoom Scaling ───────────────────────────────────────────────────────
// Controls how node sizes scale when zooming out.
// Default sigma uses Math.sqrt (exponent 0.5). Higher = nodes shrink faster when zooming out.

export const ZOOM_SIZE_EXPONENT = 0.9;

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
export const FA2_SCALING_RATIO = 30;
export const FA2_SLOW_DOWN = 2;
export const FA2_BARNES_HUT_THRESHOLD = 300; // use Barnes-Hut when nodeCount > this
export const FA2_BARNES_HUT_THETA = 0.5;
export const FA2_STRONG_GRAVITY = false;
export const FA2_LIN_LOG_MODE = true;
export const FA2_OUTBOUND_ATTRACTION = true;
export const FA2_ADJUST_SIZES = true;
export const FA2_DURATION = 3000; // ms to run before auto-stop

// ─── Noverlap Post-Processing ───────────────────────────────────────────
// Runs after FA2 stops (or after d3-force if FA2 disabled) to push apart remaining overlaps.

export const NOVERLAP_MAX_ITERATIONS = 50;
export const NOVERLAP_RATIO = 1.5;
export const NOVERLAP_MARGIN = 10;
export const NOVERLAP_EXPANSION = 1.5;

// ─── Sigma Renderer ─────────────────────────────────────────────────────

// Above this edge count, use simple line edges instead of curved arrows
export const EDGE_PROGRAM_THRESHOLD = 10000;

export const LABEL_RENDERED_SIZE_THRESHOLD = 8;
export const LABEL_SIZE = 12;
export const LABEL_FONT = 'Inter, system-ui, sans-serif';
export const LABEL_COLOR = '#e2e8f0';

// ─── Louvain Community Detection ────────────────────────────────────────
// Resolution >1 produces more communities (finer), <1 produces fewer (coarser).

export const LOUVAIN_RESOLUTION = 1.0;
