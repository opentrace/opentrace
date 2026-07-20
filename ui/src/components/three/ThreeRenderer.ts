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
 * Three.js graph renderer. Pure class — no React dependency. Drop-in peer of
 * PixiRenderer: same public surface, consumed through the same
 * GraphCanvasProps / GraphCanvasHandle contract.
 *
 * Architecture for 100k+
 * behavior this matches):
 *   • Nodes   — one THREE.Points + ShaderMaterial. One draw call. Size + the
 *               highlight dim/enlarge happen in the vertex shader, so there is
 *               NO per-frame JS loop over nodes.
 *   • Edges   — one THREE.LineSegments over one BufferGeometry (phase 2).
 *   • Picking — GPU color-picking to an offscreen target (phase 3).
 *   • Labels  — HTML/CSS overlay for the visible subset only (phase 4).
 *   • Camera  — OrthographicCamera (2D) / PerspectiveCamera + orbit (3D, phase 5).
 *
 * Phase 1 scope: render nodes from streamed positions; ortho pan / wheel-zoom /
 * zoomToFit + the easing auto-fit follower. Later phases fill the stubs.
 */

import {
  Scene,
  OrthographicCamera,
  PerspectiveCamera,
  WebGLRenderer,
  WebGLRenderTarget,
  BufferGeometry,
  BufferAttribute,
  Points,
  Mesh,
  PlaneGeometry,
  LineSegments,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LineBasicMaterial,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Color,
  Matrix4,
  Vector2,
  Vector3,
  Quaternion,
  Spherical,
  NearestFilter,
  LinearFilter,
  AdditiveBlending,
  type Texture,
  type ShaderMaterial,
} from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { GraphNode, GraphLink } from '../graph/types';
import type { SelectedEdge } from '../types/graph';
import {
  type PixiScaleBreakpoint,
  selectBreakpoint,
  DEFAULT_BREAKPOINTS,
} from './scaleBreakpoints';
import { computeBounds, type Viewport } from './viewport';
import {
  NODE_OPACITY_DIMMED,
  NODE_OPACITY_HIGHLIGHTED,
  NODE_SIZE_DIMMED_SCALE,
  NODE_SIZE_HIGHLIGHTED_SCALE,
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_HIGHLIGHTED,
  EDGE_OPACITY_DIMMED,
  HOT_EDGE_CURVE_SEGMENTS,
  HOT_EDGE_SAG_FACTOR,
  HOT_EDGE_HALF_WIDTH,
  HOT_EDGE_GLOW_ALPHA,
  DOF_BLUR_RADIUS,
  CURVE_ALL_EDGES_SEGMENTS,
  CURVE_ALL_EDGES_MAX,
  LABEL_SIZE,
  LABEL_FONT,
  LABEL_MAX_LENGTH,
} from '../config/graphLayout';
import { getGraphThemeColors } from '../colors/graphThemeColors';
import {
  createNodeMaterial,
  createNodePickingMaterial,
  NODE_STATE_VISIBLE,
  NODE_STATE_HIGHLIGHTED,
  NODE_STATE_DIMMED,
  NODE_STATE_HOVERED,
  type NodeMaterialUniforms,
} from './nodeMaterial';
import { createEdgeMaterial } from './edgeMaterial';
import { createHotEdgeMaterial } from './hotEdgeMaterial';
import {
  createCurvedEdgeMaterial,
  type CurvedEdgeMaterialUniforms,
} from './curvedEdgeMaterial';
import {
  createBlurMaterial,
  createCopyMaterial,
  type BlurMaterialUniforms,
} from './dofMaterials';

// ─── Types ──────────────────────────────────────────────────────────────

export interface ThreeNode {
  id: string;
  graphNode: GraphNode;
  size: number;
  color: string;
  visible: boolean;
}

export interface ThreeEdge {
  sourceId: string;
  targetId: string;
  /** Node-array indices of the endpoints, resolved once at build time so the
   *  per-frame edge hot loops avoid a `nodeIdToIndex.get()` per edge. */
  sourceIdx: number;
  targetIdx: number;
  /** Hot-set lookup key `${sourceId}-${targetId}`, built once at edge creation
   *  so updateEdgeAlpha / fillEdgeColors don't concatenate strings per edge
   *  per call. (Distinct from the dedup key, which includes the label.) */
  key: string;
  label: string;
  graphLink: GraphLink;
  color: string;
}

/** In-flight "watch the graph being built" replay state. Positions are read
 *  Nodes are flung out from their parent's settled spot and overshoot into
 *  place, so final positions + the BFS parent map are snapshotted too. */
interface BuildAnimState {
  /** performance.now() at playback start. */
  start: number;
  /** Total playback length (ms). */
  duration: number;
  /** Per node index → birth offset (ms after `start`) when its reveal begins. */
  birth: Float32Array;
  /** Per node index → its final (pre-animation) size, restored on completion. */
  targetSize: Float32Array;
  /** Per node index → BFS parent index (the node it flies out from), or -1
   *  for component seeds (they pop in place — the blast origins). The fly-out
   *  targets are read LIVE from `layoutPos` each frame (the layout keeps
   *  running during the build), not from a snapshot. */
  parent: Int32Array;
  /** Per node index → 1 once its birth spark has fired (debounce). */
  sparked: Uint8Array;
  /** Spark every Nth node (1 = every node; >1 samples big graphs to bound the
   *  concurrent sprite count while still glowing across the whole graph). */
  sparkStride: number;
}

/** One edge the traversal pulse crosses, in playback order. */
interface TraversalEdge {
  /** Node-array index of the edge's start. */
  sourceIdx: number;
  /** Node-array index of the edge's end (the node "reached"). */
  targetIdx: number;
  /** Lit-set keys for both orientations (`a-b` and `b-a`) — added once crossed.
   *  The pulse may cross an edge opposite to its stored orientation, so both
   *  are lit to guarantee the stored-orientation lookup in updateEdgeAlpha hits. */
  edgeKey: string;
  edgeKeyRev: string;
  /** Node id reached at the far end — pinged + lit when the pulse arrives. */
  destId: string;
  /** ms after the anim's `start` when the pulse enters this edge. */
  startMs: number;
  /** How long the pulse takes to cross this edge (ms) — adaptive per batch. */
  durMs: number;
  /** 1 once the arrival ping/light has fired (debounce). */
  arrived: number;
  /** Fire a node ping on arrival. Every edge in a normal batch; only leg-final
   *  edges in a big (chain-lightning) batch, where per-edge pings would spawn
   *  hundreds of sprites per frame. */
  ping: number;
}

/** In-flight chat-traversal replay: a single glow pulse glides edge-by-edge
 *  through `edges` (ordered), lighting each edge + its far node as it lands.
 *  Newly streamed legs are appended after the current tail so consecutive tool
 *  results chain into one continuous walk. */
interface TraversalAnimState {
  /** performance.now() at playback start. */
  start: number;
  /** Total playback length (ms); grows as legs are appended. */
  duration: number;
  /** Ordered edges to cross. */
  edges: TraversalEdge[];
  /** The travelling glow pulse. */
  sprite: Sprite;
}

interface InteractionCallbacks {
  onNodeClick?: (node: GraphNode) => void;
  onEdgeClick?: (edge: SelectedEdge) => void;
  onStageClick?: () => void;
  onNodeDragStart?: (nodeId: string) => void;
  onNodeDragMove?: (nodeId: string, x: number, y: number) => void;
  onNodeDragEnd?: (nodeId: string) => void;
  on3DAutoRotateChange?: (autoRotate: boolean) => void;
  /** Cursor entered a node (canvas-local px) or left one (`null`). The host
   *  decides what to do with it (e.g. show an info tooltip after a delay). */
  onNodeHover?: (
    node: GraphNode | null,
    screenX: number,
    screenY: number,
  ) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────

const CLICK_THRESHOLD = 5; // px — distinguish click from drag

// A 3D reframe sets the orbit distance from the visible-node bounds. If those
// bounds are momentarily DEGENERATE — many nodes reported visible yet crammed
// into ~zero extent (a fresh zero-initialised posArray, or a reseed before the
// layout has spread) — the distance floors out and the camera lands INSIDE the
// real graph: the whole graph appears to teleport/blow up. These thresholds
// detect that collapsed state so reframes can skip/defer until the layout has
// real extent. A radius at/near computeBounds3D's 0.5 floor means every node is
// within ~`COLLAPSED_BOUNDS_RADIUS` units — implausible for this many real nodes
// in a layout that spreads them hundreds of units apart, i.e. transient.
const COLLAPSED_BOUNDS_RADIUS = 1; // world units — radius at/near the floor
const COLLAPSED_BOUNDS_MIN_NODES = 4; // this many coincident visibles ⇒ collapsed

// The label gate is PROXIMITY-ONLY: a full-graph overview shows NO labels and
// names appear only as the camera closes in on nodes, regardless of how big
// the "Zoom scaling" slider renders them (cranking node size must not flood
// the screen with labels). Distant nodes never label.
//
// 3D: label when min(size, CAP) · (0.5 + 0.5·persp) clears this bar, where
// persp is the node's own perspective factor (px/world at its depth).
// Calibrated to match the tuned Planet-default onset (2 / 12^(0.3−0.7)).
const LABEL_GATE_MIN_3D = 5.4;
// 2D: label when min(size, CAP) · zoom^REF clears the bar — REF is a fixed
// reference attenuation (the Flat preset's tuned exponent), NOT the live
// slider value, so the slider can't re-clutter the overview.
const LABEL_GATE_2D_REF_EXP = 0.75;
const LABEL_GATE_MIN_2D = 2;
// 2D labels only exist once the user has zoomed in past this multiple of the
// whole-graph fit zoom. Unlike the size gate (which depends on absolute zoom
// and therefore on viewport size), this is viewport-independent: the fitted
// overview NEVER shows labels, on any screen.
const LABEL_2D_MIN_FIT_RATIO = 1.35;
// Breathing room enforced between 2D labels (px per side, x/y). Without it
// the overlap cull packs labels wall-to-wall once the zoom gate opens — a
// solid page of text. (3D keeps tight packing: per-node depth already
// staggers arrival there.)
const LABEL_2D_BOX_PAD_X = 22;
const LABEL_2D_BOX_PAD_Y = 14;
// Hard ceiling on simultaneous 2D labels — spacing alone still admits a wall
// of text on big viewports. Candidates are size-sorted, so the most important
// nodes keep their names; zooming further in shrinks the on-screen set below
// the cap naturally. (Highlights are exempt: search/chat label what they hit.)
const LABEL_2D_MAX = 28;
// The label gate judges every node as if it were at most this base size, so
// proximity — not hub size — decides who gets a name: a big hub across the
// cloud stays quiet while the ordinary nodes you're approaching light up.
// (Display sizing/gaps still use the real size.)
const LABEL_GATE_SIZE_CAP = 6;

// Ambient drift touches every node and edge each frame (O(N+E) CPU plus a
// full position-buffer GPU upload) — it permanently defeats the static-frame
// skip that keeps huge graphs cheap. Above this node count the per-node
// wobble is sub-pixel anyway, so ambient stays off.
const AMBIENT_MAX_NODES = 20_000;
// Cursor-freeze zone for ambient drift: nodes within INNER px of the pointer
// hold still (so a click target doesn't float away), ramping smoothly back to
// full drift at OUTER px.
const AMBIENT_FREEZE_INNER_PX = 70;
const AMBIENT_FREEZE_OUTER_PX = 150;
// Per-frame easing toward the freeze target (~0.12 ≈ nodes settle/resume over
// a couple hundred ms at 60fps — no snapping when the cursor jumps).
const AMBIENT_FREEZE_EASE = 0.12;
// Per-frame rate at which a node chases its live drift target when fully
// un-frozen (damp 1). High enough that tracking the slow ambient sines is
// visually exact (~70ms time constant); the damp factor scales it to 0 near
// the cursor, freezing the node AT ITS CURRENT SPOT rather than walking it
// back to its home position.
const AMBIENT_TRACK_RATE = 0.22;
const FALLBACK_COLOR = '#888888';
/** Upper bound on the WebGL backing-store pixel ratio (perf vs sharpness). */
const MAX_PIXEL_RATIO = 1.5;
/** Min interval between label-overlay repositions (ms) — decouples the DOM
 *  label work from the render frame rate. ~30fps is smooth for labels. */
const LABEL_SYNC_INTERVAL = 33;

// ── Hierarchical LOD ("graph Nanite") ───────────────────────────────────
// A community is shown as a single aggregate "super-node" until it projects
// large enough on screen, then expands into its member nodes + intra edges.
// This keeps the on-screen primitive count bounded regardless of total size.
/** Expand a community once its projected radius exceeds this (px). */
const LOD_EXPAND_PX = 110;
/** Collapse below this (px) — hysteresis band prevents flicker at the edge. */
const LOD_COLLAPSE_PX = 70;
/** Min members for a community to get an aggregate node (tiny ones just show
 *  their members). */
const LOD_MIN_COMMUNITY = 4;
/** Cap on aggregate inter-community edges (kept = heaviest by weight). */
const LOD_MAX_SUPER_EDGES = 4000;
/** Pick-id offset distinguishing super-nodes from regular nodes. */
const SUPER_PICK_OFFSET = 2_000_000;
const LOD_UPDATE_INTERVAL = 80; // ms between LOD re-evaluations
/** In 'auto' mode, only aggregate once the graph is too big to draw fully.
 *  Below this, full detail (the whole graph is visible at the overview). */
const LOD_AUTO_THRESHOLD = 30_000;

// ── Build animation ("watch the graph being built") ─────────────────────
/** Per-node reveal window (ms): how long a node takes to fly out + pop in. */
const BUILD_NODE_REVEAL_MS = 560;
/** Adaptive total duration: floor, ceiling, and ms added per node. */
const BUILD_MIN_MS = 3500;
const BUILD_MAX_MS = 7500;
const BUILD_MS_PER_NODE = 0.3;
/** Birth-time jitter (± fraction of the reveal window) so same-depth siblings
 *  don't pop in lockstep — reads as a chaotic burst, not a tidy sweep. */
const BUILD_JITTER_FRAC = 0.55;
/** Max total glow sparks fired across a whole build (caps sprite churn). On
 *  graphs larger than this, sparks are SAMPLED (every Nth node) rather than
 *  disabled — so big graphs still visibly glow, just not every single node. */
const BUILD_SPARK_BUDGET = 3000;
/** Overshoot strength for the fly-out "pop" (classic easeOutBack tuning). */
const BUILD_BACK_C1 = 2.2;

// ── Live-build ("watch the graph build itself WHILE indexing") ───────────
/** Per-frame ease for a settled node following its layout target. Kept GENTLE
 *  (vs the burst) so settled nodes drift toward their moving target smoothly
 *  instead of snapping — the streaming force layout is still settling, so a
 *  stiff follow reads as jitter. Legacy fallback: only used if interpolation
 *  has no interval yet (before the second position post arrives). */
const GROW_FOLLOW_ALPHA = 0.08;
/** Snapshot-interpolation slack. The worker streams positions on a node-count-
 *  scaled interval (~66ms small graphs → ~240ms cap on huge ones), so a settled
 *  node's on-screen motion is only as smooth as that ~5Hz stream unless we
 *  interpolate. Each post we snapshot where the node IS and lerp it toward the
 *  newly-posted target over the measured inter-post interval, evaluated every
 *  render frame → smooth 60fps motion decoupled from the (deliberately throttled,
 *  indexing-protecting) post rate. Slack >1 stretches the interpolation window a
 *  little past the measured interval so a late/slower next post doesn't leave the
 *  node parked at its target (a visible stutter); the next snapshot always
 *  re-bases from the node's actual position, so the mild perpetual lag never
 *  accumulates. */
const LIVE_INTERP_SLACK = 1.2;
/** Assumed inter-post interval (ms) before two posts have been observed. */
const LIVE_INTERP_DEFAULT_MS = 120;
/** EMA weight for the newest measured inter-post interval (rest = history), so
 *  the pacing stays stable as the stream interval grows with the graph. */
const LIVE_INTERP_INTERVAL_EMA = 0.3;
/** Per-node grow-in window (ms): a freshly-indexed node eases out from its
 *  parent + scales 0→full over this long. Slower than the burst for a calm,
 *  controlled reveal (the user's "slow and smooth", not jumpy). */
const GROW_REVEAL_MS = 1000;
/** Birth sentinel for nodes that are already fully grown (settled). */
const GROW_BORN = -1e12;
/** Spread a batch's node births over this window (ms) so they ripple in
 *  gradually instead of popping in lockstep. */
const GROW_STAGGER_MS = 850;
/** Overshoot for the live grow-in. Much softer than the burst's BUILD_BACK_C1
 *  (2.2): during live build the layout target is still MOVING, so a strong
 *  overshoot on top of a moving target reads as a jumpy bounce. A near-zero
 *  overshoot gives a clean eased settle. */
const GROW_BACK_C1 = 0.4;
/** Live-build camera. The graph grows the whole time, so the framing distance
 *  must too. We ease toward a MONOTONIC, low-pass-smoothed target radius so the
 *  camera never lurches (raw settled-bounds jump every batch) or pumps in/out. */
const LIVE_CAM_DIST_MULT = 3.3; // camera distance = target radius × this
// (~2.6 fills the frame edge-to-edge; >2.6 leaves comfortable margin so the
//  finished graph doesn't sit zoomed-in against the edges.)
const LIVE_CAM_RADIUS_SMOOTH = 0.06; // low-pass factor for the target radius
const LIVE_CAM_FOLLOW = 0.045; // per-frame ease of camera dist/target
/** Predicted radius ≈ this × sqrt(nodeCount) — the force layout seeds new nodes
 *  within sqrt(N)·spread, so the settled extent grows ~like sqrt(N). Using this
 *  as a floor lets the camera pull back SMOOTHLY (sqrt is continuous) ahead of
 *  the jumpy actual bounds, instead of chasing each batch. */
const LIVE_CAM_RADIUS_PER_SQRT = 22;
/** Start the camera this much beyond the first framing so early growth barely
 *  moves it (the user's "start further out"). */
const LIVE_CAM_START_FACTOR = 1.4;

// ── Chat traversal animation ("watch the agent walk the graph") ─────────
/** Target wall-clock for one batch's walk (ms). Per-edge time is derived from
 *  this and the edge count so a batch always finishes quickly — a 30-node
 *  result doesn't animate for ten seconds. */
const TRAVERSAL_BUDGET_MS = 1100;
/** Per-edge crossing time is clamped to this range (ms). */
const TRAVERSAL_MIN_EDGE_MS = 55;
const TRAVERSAL_MAX_EDGE_MS = 180;
/** Inter-leg pause as a fraction of the per-edge time. */
const TRAVERSAL_GAP_FRAC = 0.25;
/** When a new batch arrives and the queued walk still has more than this left
 *  to play, compress the backlog into a quick catch-up burst before the new
 *  batch — keeps the pulse within ~1s of the real tool-call progress. */
const TRAVERSAL_MAX_BACKLOG_MS = 700;
/** The compressed backlog plays in this window (ms) — fast, but every edge
 *  still visibly builds instead of popping in. */
const TRAVERSAL_CATCHUP_MS = 320;
/** Above this many edges in one call we switch to "chain-lightning" pacing:
 *  still drawn progressively (the connections visibly build), but on a bigger
 *  fixed budget with a near-zero per-edge floor so a giant tool result never
 *  animates for minutes. Node pings are then fired per LEG (not per edge) to
 *  bound sprite churn. */
const TRAVERSAL_MAX_EDGES = 160;
/** Wall-clock target for one BIG batch's walk (ms). */
const TRAVERSAL_BIG_BUDGET_MS = 2800;
/** Per-edge floor for big batches (ms) — caps truly huge results at
 *  edgeCount × this. */
const TRAVERSAL_BIG_MIN_EDGE_MS = 0.6;
/** Travelling-pulse glow color (the "agent" walking the graph). */
const TRAVERSAL_PULSE_COLOR = '#bae6fd';
/** Lit-trail edge color — a vivid cyan so the walked path pops on big graphs. */
const TRAVERSAL_TRAIL_COLOR = '#38bdf8';
/** Floor on the pulse's on-screen radius (px) so it stays visible when the
 *  graph is zoomed way out and individual nodes are sub-pixel. */
const TRAVERSAL_MIN_PULSE_PX = 22;
/** Above this many nodes+edges, arrivals repaint the hot state at most every
 *  TRAVERSAL_REPAINT_MS instead of every frame — refreshHotState touches
 *  EVERY node and edge, and a chain-lightning walk completes edges nearly
 *  every frame, which at 50k nodes turns the whole walk into seconds of
 *  full-graph repaints. Small graphs keep the per-arrival repaint. */
const TRAVERSAL_REPAINT_THROTTLE_SCALE = 20_000;
const TRAVERSAL_REPAINT_MS = 120;

/** Strip control characters and truncate to LABEL_MAX_LENGTH. */
function cleanLabel(raw: string): string {
  const stripped = raw.replace(/[\n\r\t]+/g, ' ').trim();
  return stripped.length > LABEL_MAX_LENGTH
    ? stripped.slice(0, LABEL_MAX_LENGTH) + '…'
    : stripped;
}

/** Parse a CSS hex string ('#rgb' / '#rrggbb') into raw sRGB 0..1 channels.
 *
 * We deliberately bypass THREE.Color's color management here. The custom node /
 * edge ShaderMaterials write their varying color straight to the (sRGB)
 * framebuffer with no linear→sRGB output encoding (unlike built-in materials),
 * so the attribute must already hold sRGB values. Using `Color.set()` would
 * convert sRGB→linear and the colors would render dark/muddy. Stored on the
 * `out` Color's raw r/g/b fields (no conversion) for buffer extraction. */
function hexToRgb(hex: string, out: Color): Color {
  const raw = (hex || FALLBACK_COLOR).replace('#', '');
  const full =
    raw.length === 3
      ? raw[0] + raw[0] + raw[1] + raw[1] + raw[2] + raw[2]
      : raw;
  const n = parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) {
    out.r = 0.53;
    out.g = 0.53;
    out.b = 0.53; // FALLBACK_COLOR #888888 in sRGB
    return out;
  }
  out.r = ((n >> 16) & 255) / 255;
  out.g = ((n >> 8) & 255) / 255;
  out.b = (n & 255) / 255;
  return out;
}

// ─── Renderer Class ─────────────────────────────────────────────────────

export class ThreeRenderer {
  private renderer: WebGLRenderer | null = null;
  private scene: Scene | null = null;
  private camera: OrthographicCamera | null = null;

  // ── 3D mode (perspective + orbit) ──────────────────────────────────
  private perspCamera: PerspectiveCamera | null = null;
  private controls: OrbitControls | null = null;
  private mode3d = false;
  private mode3dAutoRotate = true;
  private mode3dSpeed = 0.0015; // radians/frame (mapped to OrbitControls speed)
  private mode3dTilt = 0.35; // elevation above the equator (radians)
  private readonly fov = 55;

  // ── Ping / glow ────────────────────────────────────────────────────
  private pingSprites: Map<string, { startTime: number; sprite: Sprite }> =
    new Map();
  private glowTextures: Map<string, Texture> = new Map();
  private static readonly PING_DURATION = 1000;

  // ── Chat traversal ("watch the agent walk the graph") ──────────────
  private traversalAnim: TraversalAnimState | null = null;
  /** Nodes the traversal has reached — kept lit (hot) until cleared. */
  private traversalLitNodes: Set<string> = new Set();
  /** Edges the traversal has crossed — kept lit (hot) until cleared. */
  private traversalLitEdges: Set<string> = new Set();
  /** Edges queued in the walk but not yet crossed — kept INVISIBLE (alpha 0,
   *  overriding even the app-side highlight that pre-marks the whole result
   *  neighborhood hot) so each connection appears only as the pulse builds it.
   *  Keys in both orientations, removed on arrival. */
  private traversalPendingEdges: Set<string> = new Set();
  /** Partial-trail overlay: one trail-colored segment from the active edge's
   *  start to the pulse's current position, so the connection visibly DRAWS
   *  itself behind the pulse (the full edge flips lit only on arrival).
   *  Lazily created, reused across walks; hidden when no edge is mid-cross. */
  private traversalHeadLine: LineSegments | null = null;
  private traversalHeadPos: Float32Array = new Float32Array(6);
  /** Arrival repaint batching on big graphs (see TRAVERSAL_REPAINT_MS). */
  private traversalRepaintPending = false;
  private traversalLastRepaint = 0;

  // ── Build animation ────────────────────────────────────────────────
  private buildAnim: BuildAnimState | null = null;
  /** Set by armBuildAnimation(): the next setData() collapses the graph the
   *  moment it's built (before first paint) and starts the burst IMMEDIATELY,
   *  so the finished graph never flashes AND there's no wait — the burst plays
   *  while the layout is still settling, flying nodes toward the live (still
   *  developing) positions. */
  private buildArmed = false;
  /** True while the graph is held collapsed (armed-and-loaded). */
  private buildPrepared = false;
  /** Final node sizes captured at collapse time — restored as the burst's
   *  targets (sizeArray itself is zeroed while prepared). */
  private preparedSizes: Float32Array | null = null;
  /** Live layout positions (x,y,z stride 3). While a build is running the
   *  layout streams here instead of into posArray, and the burst reads these
   *  as its fly-out targets each frame, writing the interpolated render
   *  positions into posArray. Outside a build it mirrors posArray. */
  private layoutPos: Float32Array = new Float32Array(0);

  // ── Live-build state (continuous "build while indexing") ───────────
  /** Snapshot-interpolation start positions: where each settled node was on
   *  screen at the last position post (stride 3, capacity-sized). The render
   *  loop lerps posArray from here toward `layoutPos` over the measured post
   *  interval so the ~5Hz worker stream renders as smooth 60fps motion. */
  private layoutInterpPrev: Float32Array = new Float32Array(0);
  /** performance.now() of the last position post (interpolation window start). */
  private layoutInterpStart = 0;
  /** EMA of the inter-post interval (ms); the interpolation window length. */
  private layoutInterpDur = 0;
  /** True once a prev snapshot exists (i.e. at least one post seen this build). */
  private layoutInterpActive = false;
  /** After a live build finalizes, the worker keeps streaming its release-pins
   *  settle. While true, those (non-live) posts are snapshot-interpolated too so
   *  the settle stays as smooth as the build instead of rendering raw at the
   *  ~5Hz stream rate. Cleared once the layout settles or an interaction /
   *  ambient drift takes over (see updateStreamInterp). */
  private postBuildSettle = false;
  /** While true, layout output streams into `layoutPos`; the render loop eases
   *  posArray toward it (settled nodes — kept stable by worker-side pinning)
   *  and flies newly-added nodes out from their parent. */
  private liveGrowActive = false;
  private growBirth: Float32Array = new Float32Array(0);
  private growParent: Int32Array = new Int32Array(0);
  private growTargetSize: Float32Array = new Float32Array(0);
  /** Rendered positions by id, snapshotted before a live-build rebuild so eased
   *  positions survive the setData() that addData() triggers. */
  private liveGrowPrevPos: Map<string, [number, number, number]> | null = null;
  private liveGrowLastBirth = 0;
  /** Set by endLiveGrow(): wall-clock at which the last grow-in completes. */
  private liveGrowFinishAt: number | null = null;
  /** Frame counter for throttling per-frame edge/camera work during the build. */
  private liveGrowFrame = 0;
  /** Monotonic, low-pass-smoothed framing radius the live camera eases toward.
   *  0 = not yet initialized (first follow snaps the camera out to it). */
  private liveCamRadius = 0;
  /** Active animated 3D reframe, driven by the render loop. Re-reads the graph
   *  bounds every frame and eases toward them, staying active until the layout
   *  stops expanding — the end-of-build full settle (release-pins) keeps
   *  spreading the graph AFTER the build finalizes, so a one-shot fit to the
   *  pre-settle bounds would leave a big graph zoomed-in. null when idle. */
  private fit3D: {
    smoothR: number;
    cx: number;
    cy: number;
    cz: number;
    init: boolean;
    stableFrames: number;
    lastRadius: number;
  } | null = null;
  /** Allocated capacity (in nodes / edges) of the GPU buffers. During live-build
   *  the buffers are over-allocated so streamed batches append in place instead
   *  of rebuilding all geometry — keeps the build continuous + high-FPS. */
  private nodeCapacity = 0;
  private edgeCapacity = 0;
  /** Edge keys (`src-label-tgt`) currently held — lets the live-build append
   *  dedup streamed links (incl. ones whose endpoints arrived earlier). */
  private edgeKeySet: Set<string> = new Set();

  // ── Labels (HTML/CSS overlay) ──────────────────────────────────────
  private nodeLabelLayer: HTMLDivElement | null = null;
  private communityLabelLayer: HTMLDivElement | null = null;
  private nodeLabelEls: Map<string, HTMLDivElement> = new Map();
  private showAllLabels = true;
  private labelScaleMultiplier = 1.0;
  private showCommunityLabels = true;
  private currentLayoutMode: 'spread' | 'compact' | 'tree' | 'onion' = 'spread';
  /** Below this zoom (px/world) node labels hide so community wayfinders own
   *  the overview (matches the Pixi NODE_LABEL_MIN_VP_SCALE handoff). */
  private readonly NODE_LABEL_MIN_VP_SCALE = 0.6;
  private lastLabelCullZoom = -1;
  private labelCullTimer: ReturnType<typeof setTimeout> | null = null;
  private lastCommunityUpdate = 0;

  // Community wayfinder labels
  private communityLabelEls: Map<number, HTMLDivElement> = new Map();
  private communityAssignments: Record<string, number> | null = null;
  private communityNames: Map<number, string> | null = null;
  private communityColorMap: Map<number, string> | null = null;
  private communityNamesFingerprint: string | null = null;
  private currentlyShownCommunities: Set<number> = new Set();
  private communityVisibilityFrozen = false;
  private communityMemberCount: Map<number, number> = new Map();
  private communityCentroids: Map<number, { x: number; y: number; z: number }> =
    new Map();
  /** True when node positions / visibility changed since the centroids were
   *  last computed — lets the throttled recompute skip entirely on static
   *  frames (recomputing unchanged inputs yields identical centroids). */
  private centroidsDirty = true;

  // Node point cloud
  private nodeGeometry: BufferGeometry | null = null;
  private nodeMaterial: ShaderMaterial | null = null;
  private nodePoints: Points | null = null;
  // Highlighted-node halo overlay (shares the node attributes, own index —
  // drawn after edges without depth writes; see createNodeMaterial haloPass).
  private nodeHaloGeometry: BufferGeometry | null = null;
  private nodeHaloMaterial: ShaderMaterial | null = null;
  private nodeHaloPoints: Points | null = null;
  private nodeHaloDrawIndex: Uint32Array = new Uint32Array(0);
  /** Solid-core material for the foreground (in-front-of-veil) highlight pass —
   *  a copy of the node material with depth test OFF, so highlighted cores draw
   *  on top of the frosted glass even when a dimmed node is nearer the camera. */
  private fgNodeMaterial: ShaderMaterial | null = null;
  private posArray: Float32Array = new Float32Array(0); // x,y,z per node (stride 3)
  private colorArray: Float32Array = new Float32Array(0);
  private sizeArray: Float32Array = new Float32Array(0);
  private stateArray: Float32Array = new Float32Array(0);
  private pickColorArray: Float32Array = new Float32Array(0); // id→rgb per node

  // GPU picking
  private pickingMaterial: ShaderMaterial | null = null;
  private pickTarget: WebGLRenderTarget | null = null;
  private readonly pickPixel = new Uint8Array(4);

  // Drag state
  private dragNodeIndex = -1;
  private pendingDragIndex = -1;

  // Edge line set — one LineSegments, 2 verts/edge.
  private edgeGeometry: BufferGeometry | null = null;
  private edgeMaterial: ShaderMaterial | null = null;
  private edgeLines: LineSegments | null = null;
  private edgePosArray: Float32Array = new Float32Array(0); // 2 verts × xyz
  private edgeColorArray: Float32Array = new Float32Array(0);
  private edgeAlphaArray: Float32Array = new Float32Array(0);
  private edgesEnabled = true;
  private hiddenLinkTypes: Set<string> = new Set();
  private edgesHiddenForInteraction = false;

  // Hot-edge glow ribbon — highlighted / chat edges rendered as soft, curved,
  // additively-blended strands (see hotEdgeMaterial.ts) instead of the bulk
  // straight 1px lines. Built on the CPU from the current hot-edge set; the
  // ribbon width faces the screen via the shader, so orbiting needs no rebuild.
  private hotEdgeGeometry: BufferGeometry | null = null;
  private hotEdgeMaterial: ShaderMaterial | null = null;
  private hotEdgeMesh: Mesh | null = null;
  private hotEdgePosArray: Float32Array = new Float32Array(0);
  private hotEdgeTangentArray: Float32Array = new Float32Array(0);
  private hotEdgeSideArray: Float32Array = new Float32Array(0);
  private hotEdgeColorArray: Float32Array = new Float32Array(0);
  private hotEdgeAlphaArray: Float32Array = new Float32Array(0);
  private hotEdgeIndexArray: Uint32Array = new Uint32Array(0);
  /** The hot edges (endpoints visible) currently drawn as ribbons. */
  private hotEdgeList: ThreeEdge[] = [];
  /** Edge count the ribbon topology was last built for (rebuild on change). */
  private hotEdgeBuiltCount = -1;
  /** Number of triangle indices currently live in the ribbon geometry. */
  private hotEdgeIndexCount = 0;
  /** True while the ribbon owns the hot edges — the bulk line set then zeroes
   *  them so they don't double-draw as straight chords under the curves. */
  private hotRibbonActive = false;
  /** True when the highlight has MORE hot edges than the ribbon can draw
   *  (> HOT_EDGE_MAX). They then render as bright straight chords in the BULK
   *  line set, which lives on the blurred DOF layer — so DOF is skipped for
   *  that frame to stop them smearing into a blur (a huge highlight has no
   *  meaningful "background" to blur anyway). */
  private hotEdgesOverflowed = false;

  // Curve ALL bulk edges — an instanced LineSegments that reuses the straight
  // edge set's own buffers (edgePos/Color/Alpha) as per-instance attributes and
  // bows each edge into an arc entirely in the vertex shader. When active it
  // replaces the straight `edgeLines` in the scene (which is kept for state /
  // hit-testing but removed from rendering). No per-frame CPU cost — the same
  // buffers the straight set already fills drive the curves.
  private curvedEdgeGeometry: InstancedBufferGeometry | null = null;
  private curvedEdgeMaterial: ShaderMaterial | null = null;
  private curvedEdgeObject: LineSegments | null = null;
  private curvedEdgesActive = false;
  /** Instanced buffers wrapping the straight arrays — flagged for re-upload
   *  whenever those arrays change (they alias the same memory). */
  private curvedPosBuffer: InstancedInterleavedBuffer | null = null;
  private curvedColorBuffer: InstancedInterleavedBuffer | null = null;
  private curvedAlphaBuffer: InstancedInterleavedBuffer | null = null;

  // Depth-of-field: while a highlight is active the background (everything on
  // layer 0) is rendered to an offscreen target, blurred (downsampled separable
  // gaussian), composited to screen, then the highlighted set (layer 1: the fg
  // cores, glow halo, hot-edge ribbon) is drawn sharp on top — so the rest of
  // the graph is genuinely out of focus, not merely dimmed.
  private dofSceneRT: WebGLRenderTarget | null = null;
  private dofRtA: WebGLRenderTarget | null = null; // half-res ping/pong
  private dofRtB: WebGLRenderTarget | null = null;
  private blurMaterial: ShaderMaterial | null = null;
  private copyMaterial: ShaderMaterial | null = null;
  private postScene: Scene | null = null;
  private postCamera: OrthographicCamera | null = null;
  private postQuad: Mesh | null = null;
  /** Highlighted node cores re-drawn crisply in front of the blur. Shares the
   *  halo geometry (same highlighted-only draw index) with a depth-test-off
   *  solid material; lives on render layer 1 (the sharp foreground). */
  private fgNodePoints: Points | null = null;

  private interactionResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEdgeRedraw = 0;
  private layoutSettled = false;
  /** Ambient motion runs renderer-side (60fps, continuous sine offsets) rather
   *  than in the worker, so the drift is buttery rather than stepping at the
   *  worker's ~22fps post rate. `ambientEnabled` is the user toggle;
   *  `ambientActive` is true only while it's actually animating (enabled AND the
   *  layout has settled — we don't drift on top of an in-flight layout). */
  private ambientEnabled = false;
  private ambientActive = false;
  /** Settled positions each node oscillates around (captured on settle). */
  private ambientHome: Float32Array | null = null;
  /** performance.now() when the current ambient run started. */
  private ambientStart = 0;
  /** Latest pointer position in canvas-local px, or null when the pointer is
   *  off-canvas (or mid-pinch). Nodes near it get their ambient drift damped
   *  so the node a user is aiming at doesn't float away. */
  private cursorScreen: { x: number; y: number } | null = null;
  /** Per-node ambient damping (0 = held at home near the cursor, 1 = full
   *  drift), eased per frame so nodes glide to rest instead of snapping. */
  private ambientDamp: Float32Array | null = null;
  /** Per-axis drift amplitude in world units (scaled to the graph's extent). */
  private ambientAmplitude = 0;

  // Data
  private nodes: Map<string, ThreeNode> = new Map();
  private nodeArray: ThreeNode[] = [];
  private nodeIdToIndex: Map<string, number> = new Map();
  private edges: ThreeEdge[] = [];
  /** Count of nodes with visible === false (maintained by setNodeVisibility;
   *  creation paths always start nodes visible). Lets the live-build append
   *  fast path know cheaply that per-node visibility can't hide anything. */
  private hiddenNodeCount = 0;

  // Dimensions
  private width = 0;
  private height = 0;
  private pixelRatio = 1;

  // Camera state (ortho). camera.zoom = px-per-world-unit.
  private hasUserMovedCamera = false;
  private autoFitTarget: { x: number; y: number; zoom: number } | null = null;
  private readonly AUTO_FIT_FOLLOW_ALPHA = 0.15;
  private autoFitSuspended = false;
  // 0 = nodes hold their screen size (big at overview), 1 = nodes track the
  // world scale (small at overview) — same direction as the 3D size gain.
  private zoomSizeExponent = 0.2;
  /** Reference zoom that frames the whole graph — updated whenever a fit is
   *  computed. Used to scale edge opacity by how far the user has zoomed in
   *  relative to the overview. */
  private lastFitZoom = 1;
  /** Low-pass-smoothed `lastFitZoom` used ONLY as the 2D node-size reference.
   *  `lastFitZoom` STEPS whenever the graph re-fits (every growth batch during a
   *  live build, every filter/reflow), and dividing node size by it directly
   *  made those steps show up as node-size jitter — the "choppy live build".
   *  Easing the reference toward it (camZoom is already eased) keeps the size
   *  ratio smooth. Converges to `lastFitZoom` at rest, so the settled
   *  scale-independent size is unchanged. 0 = uninitialized (snap on first use). */
  private sizeFitRef = 0;
  /** Currently selected node id (for zoom-to-selection), or null. */
  private selectedNodeId: string | null = null;
  /** Index of the node under the cursor (grows via NODE_STATE_HOVERED), -1
   *  when none. */
  private hoveredNodeIndex = -1;

  // Animation (camera transitions)
  private camAnim: {
    from: { x: number; y: number; zoom: number };
    to: { x: number; y: number; zoom: number };
    start: number;
    duration: number;
  } | null = null;

  // Perf breakpoint
  private bp: PixiScaleBreakpoint = DEFAULT_BREAKPOINTS[0];
  private breakpoints: PixiScaleBreakpoint[] = DEFAULT_BREAKPOINTS;

  // Highlight state — packed into the node `aState` attribute on the GPU.
  private highlightNodes: Set<string> = new Set();
  private highlightLinks: Set<string> = new Set();
  private hasHighlight = false;

  // Interaction
  private callbacks: InteractionCallbacks = {};
  private interactionAbort: AbortController | null = null;

  // On-demand rendering: only draw when something changed. At 100k+ the GPU
  // fill cost of a full frame is high, so redrawing a static scene every frame
  // pins the GPU. Mutations call requestRender(); the loop also renders while
  // easing/animating/pinging or (3D) while orbiting.
  private needsRender = true;

  // ── Hierarchical LOD ("graph Nanite") ──────────────────────────────
  private lodMode: 'on' | 'off' | 'auto' = 'auto';
  private lodEnabled = false;
  // Aggregate super-nodes (one per sizeable community) — own Points reusing
  // the node material; aState toggles which are shown (collapsed communities).
  private superNodeGeometry: BufferGeometry | null = null;
  private superNodePoints: Points | null = null;
  private superPosArray: Float32Array = new Float32Array(0);
  private superColorArray: Float32Array = new Float32Array(0);
  private superSizeArray: Float32Array = new Float32Array(0);
  private superStateArray: Float32Array = new Float32Array(0);
  private superPickArray: Float32Array = new Float32Array(0);
  // Aggregate inter-community edges, own LineSegments + material (so their
  // opacity is independent of the detail edges' zoom-fade).
  private superEdgeGeometry: BufferGeometry | null = null;
  private superEdgeMaterial: ShaderMaterial | null = null;
  private superEdgeLines: LineSegments | null = null;
  private superEdgePosArray: Float32Array = new Float32Array(0);
  private superEdgeColorArray: Float32Array = new Float32Array(0);
  private superEdgeAlphaArray: Float32Array = new Float32Array(0);
  /** Per super-node: community id, centroid, world radius, member count. */
  private superList: {
    cid: number;
    x: number;
    y: number;
    z: number;
    radius: number;
    count: number;
  }[] = [];
  /** Aggregate edges as index pairs into superList + weight. */
  private superEdgeList: { a: number; b: number; weight: number }[] = [];
  private cidToSuper: Map<number, number> = new Map();
  /** Per super-node: 1 = expanded (members shown), 0 = collapsed (aggregate). */
  private communityExpanded: Uint8Array = new Uint8Array(0);
  private lodLastUpdate = 0;
  private superGraphDirty = false;
  // Draw-range culling: index buffers list only the currently-visible
  // node/edge primitives so the GPU doesn't process hidden geometry every
  // frame (the difference between "looks hidden" and "costs nothing").
  private nodeDrawIndex: Uint32Array = new Uint32Array(0);
  private edgeDrawIndex: Uint32Array = new Uint32Array(0);

  // Lifecycle
  private destroyed = false;
  private rafHandle = 0;
  private readonly tmpColor = new Color();
  private readonly tmpVec = new Vector3();
  private readonly tmpVec2 = new Vector2();
  private readonly bgColor = new Color();

  // ─── Lifecycle ──────────────────────────────────────────────────────

  init(container: HTMLElement, width: number, height: number): Promise<void> {
    this.width = width;
    this.height = height;
    // Cap the device pixel ratio: Retina (DPR 2) renders 4× the pixels, which
    // is the dominant GPU cost at this node/edge count. 1.5 keeps points/edges
    // crisp while cutting fill ~45%. Labels are HTML, so they stay fully sharp.
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    const themeColors = getGraphThemeColors();
    const renderer = new WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    // The node/pick shaders decode the packed state attribute with GLSL ES 3
    // integer ops — under a WebGL1 fallback they fail to COMPILE and the
    // whole graph silently renders blank. Fail loudly and readably instead.
    if (!renderer.capabilities.isWebGL2) {
      renderer.forceContextLoss();
      renderer.dispose();
      const msg = document.createElement('div');
      msg.style.cssText =
        'display:flex;align-items:center;justify-content:center;height:100%;' +
        'padding:24px;text-align:center;color:var(--muted-foreground);font-size:0.9rem;';
      msg.textContent =
        'This graph view requires WebGL2, which your browser or GPU driver ' +
        'does not provide. Try a current Chrome/Firefox/Safari, or check that ' +
        'hardware acceleration is enabled.';
      container.appendChild(msg);
      console.error('OpenTrace graph renderer requires WebGL2 — not available');
      // Leave this.renderer null: every public method already no-ops without
      // it, so the app keeps working minus the canvas.
      return Promise.resolve();
    }
    renderer.setPixelRatio(this.pixelRatio);
    renderer.setSize(width, height, false);
    this.bgColor.set(themeColors.bg);
    renderer.setClearColor(this.bgColor, 1);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    this.renderer = renderer;

    // Label overlays — absolutely positioned over the canvas, click-through.
    const mkLayer = (z: string): HTMLDivElement => {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;inset:0;overflow:hidden;pointer-events:none;' +
        `z-index:${z};`;
      container.appendChild(el);
      return el;
    };
    this.nodeLabelLayer = mkLayer('1');
    this.communityLabelLayer = mkLayer('2');

    this.scene = new Scene();

    // Ortho camera: frustum spans the canvas in *pixels*, so camera.zoom is
    // exactly px-per-world-unit (mirrors the Pixi viewport `scale`).
    const cam = new OrthographicCamera(
      -width / 2,
      width / 2,
      height / 2,
      -height / 2,
      -100000,
      100000,
    );
    cam.position.set(0, 0, 1000);
    cam.zoom = 1;
    cam.updateProjectionMatrix();
    this.camera = cam;

    this.nodeMaterial = createNodeMaterial(this.pixelRatio, {
      hlScale: NODE_SIZE_HIGHLIGHTED_SCALE,
      hlAlpha: NODE_OPACITY_HIGHLIGHTED,
      dimScale: NODE_SIZE_DIMMED_SCALE,
      dimAlpha: NODE_OPACITY_DIMMED,
    });
    // Second pass for highlighted nodes: the soft halo, drawn after edges
    // with no depth write so it blends over them (see createNodeMaterial).
    this.nodeHaloMaterial = createNodeMaterial(this.pixelRatio, {
      hlScale: NODE_SIZE_HIGHLIGHTED_SCALE,
      hlAlpha: NODE_OPACITY_HIGHLIGHTED,
      dimScale: NODE_SIZE_DIMMED_SCALE,
      dimAlpha: NODE_OPACITY_DIMMED,
      haloPass: true,
    });
    // Foreground core material: same as the main node material but depth-test
    // off, so the highlighted cores drawn in the sharp DOF pass always sit in
    // front of the blurred background.
    this.fgNodeMaterial = createNodeMaterial(this.pixelRatio, {
      hlScale: NODE_SIZE_HIGHLIGHTED_SCALE,
      hlAlpha: NODE_OPACITY_HIGHLIGHTED,
      dimScale: NODE_SIZE_DIMMED_SCALE,
      dimAlpha: NODE_OPACITY_DIMMED,
    });
    this.fgNodeMaterial.depthTest = false;
    this.fgNodeMaterial.depthWrite = false;
    this.edgeMaterial = createEdgeMaterial();
    this.superEdgeMaterial = createEdgeMaterial(); // independent opacity
    this.hotEdgeMaterial = createHotEdgeMaterial(HOT_EDGE_HALF_WIDTH);
    this.curvedEdgeMaterial = createCurvedEdgeMaterial(HOT_EDGE_SAG_FACTOR);
    // Depth-of-field post pipeline: blur/copy materials + a full-screen quad in
    // its own scene/camera (the shaders emit clip coords directly). Render
    // targets are sized lazily in ensureDofTargets(). The camera must see layer
    // 1 (the sharp foreground) in the normal path; the DOF path toggles layers.
    this.blurMaterial = createBlurMaterial();
    this.copyMaterial = createCopyMaterial();
    this.postScene = new Scene();
    this.postCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.postQuad = new Mesh(new PlaneGeometry(2, 2), this.copyMaterial);
    this.postQuad.frustumCulled = false;
    this.postScene.add(this.postQuad);
    this.camera.layers.enable(1);
    // LOD mode: `?lod=1` forces on, `?lod=0` forces off, otherwise 'auto' —
    // engage aggregation only when the graph is big enough that full detail
    // is slow. Small graphs (e.g. 12k) render fully so you always see the
    // whole graph at the overview. Resolved per-dataset in setData().
    try {
      const flag = new URLSearchParams(window.location.search).get('lod');
      this.lodMode = flag === '1' ? 'on' : flag === '0' ? 'off' : 'auto';
    } catch {
      this.lodMode = 'auto';
    }
    this.pickingMaterial = createNodePickingMaterial(this.pixelRatio, {
      hlScale: NODE_SIZE_HIGHLIGHTED_SCALE,
      dimScale: NODE_SIZE_DIMMED_SCALE,
    });
    const buf = renderer.getDrawingBufferSize(this.tmpVec2);
    this.pickTarget = new WebGLRenderTarget(buf.x, buf.y, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });

    this.interactionAbort = new AbortController();
    this.setupInteraction(renderer.domElement, this.interactionAbort.signal);

    this.startRenderLoop();
    return Promise.resolve();
  }

  private startRenderLoop(): void {
    const loop = () => {
      if (this.destroyed) return;
      this.rafHandle = requestAnimationFrame(loop);
      this.frame();
    };
    this.rafHandle = requestAnimationFrame(loop);
  }

  /** Camera currently in use: perspective in 3D mode, else orthographic. */
  private get activeCamera(): OrthographicCamera | PerspectiveCamera | null {
    return this.mode3d ? this.perspCamera : this.camera;
  }

  /** Mark the scene dirty so the next animation frame renders. */
  private requestRender(): void {
    this.needsRender = true;
  }

  private frame(): void {
    const renderer = this.renderer;
    const scene = this.scene;
    if (!renderer || !scene) return;

    if (this.mode3d) {
      const cam = this.perspCamera;
      if (!cam) return;
      // controls.update() emits 'change' (→ requestRender) while orbiting /
      // damping / auto-rotating; when fully idle it changes nothing.
      this.controls?.update();
      if (
        !this.needsRender &&
        this.pingSprites.size === 0 &&
        this.buildAnim === null &&
        this.traversalAnim === null &&
        !this.ambientActive &&
        !this.liveGrowActive &&
        !this.postBuildSettle &&
        this.fit3D === null
      )
        return;
      this.needsRender = false;
      if (this.buildAnim) this.updateBuildAnim(performance.now());
      if (this.liveGrowActive) this.updateLiveGrow(performance.now());
      if (this.postBuildSettle) this.updateStreamInterp(performance.now());
      // Animated final fit (smooth end-of-build reframe). Keep drawing while
      // it eases; it clears itself when it reaches the goal.
      if (this.fit3D && this.stepFit3D()) this.needsRender = true;
      if (this.traversalAnim) this.updateTraversalAnim(performance.now());
      if (this.ambientActive) this.updateAmbient(performance.now());
      for (const mat of [
        this.nodeMaterial,
        this.nodeHaloMaterial,
        this.fgNodeMaterial,
      ]) {
        if (!mat) continue;
        const u = mat.uniforms as unknown as NodeMaterialUniforms;
        u.uPerspective.value = 1;
        // px-per-world-unit at unit depth for the point-size shader.
        u.uZoom.value =
          this.height / (2 * Math.tan((this.fov * Math.PI) / 360));
        u.uSizeExp.value = this.zoomSizeExponent;
      }
      if (this.edgeMaterial)
        this.edgeMaterial.uniforms.uOpacity.value = this.edgeOpacity();
      if (this.superEdgeMaterial)
        this.superEdgeMaterial.uniforms.uOpacity.value =
          this.edgeOpacityMultiplier;
      this.syncCurvedEdgeFrame();
      if (this.lodEnabled) this.updateLod();
      this.renderScene(cam);
      this.updateLabelsPerFrame();
      this.updatePing();
      return;
    }

    const cam = this.camera;
    if (!cam) return;

    // Skip the frame entirely when nothing changed — the big win at 100k+,
    // where a static scene would otherwise pin the GPU.
    const easing =
      this.camAnim !== null ||
      (this.autoFitTarget !== null && !this.hasUserMovedCamera);
    if (
      !this.needsRender &&
      !easing &&
      this.pingSprites.size === 0 &&
      this.buildAnim === null &&
      this.traversalAnim === null &&
      !this.ambientActive &&
      !this.liveGrowActive &&
      !this.postBuildSettle &&
      // Keep rendering while the node-size reference is still easing toward the
      // current fit (else it would freeze mid-ease and leave nodes slightly
      // mis-sized until the next interaction).
      this.sizeRefSettled()
    )
      return;
    this.needsRender = false;

    // Camera transition animation (zoomToFit/zoomIn/etc.)
    if (this.camAnim) {
      const t = Math.min(
        (performance.now() - this.camAnim.start) / this.camAnim.duration,
        1,
      );
      const ease = 1 - Math.pow(1 - t, 3);
      const { from, to } = this.camAnim;
      cam.position.x = from.x + (to.x - from.x) * ease;
      cam.position.y = from.y + (to.y - from.y) * ease;
      cam.zoom = from.zoom + (to.zoom - from.zoom) * ease;
      cam.updateProjectionMatrix();
      if (t >= 1) this.camAnim = null;
    } else if (this.autoFitTarget && !this.hasUserMovedCamera) {
      // Easing auto-fit follower (mirrors PixiRenderer's ticker follower).
      const target = this.autoFitTarget;
      const a = this.AUTO_FIT_FOLLOW_ALPHA;
      cam.position.x += (target.x - cam.position.x) * a;
      cam.position.y += (target.y - cam.position.y) * a;
      cam.zoom += (target.zoom - cam.zoom) * a;
      const dx = Math.abs(target.x - cam.position.x);
      const dy = Math.abs(target.y - cam.position.y);
      const dz = Math.abs(target.zoom - cam.zoom);
      if (dx < 0.5 && dy < 0.5 && dz < 0.0005) {
        cam.position.x = target.x;
        cam.position.y = target.y;
        cam.zoom = target.zoom;
        this.autoFitTarget = null;
      }
      cam.updateProjectionMatrix();
    }

    if (this.buildAnim) this.updateBuildAnim(performance.now());
    if (this.liveGrowActive) this.updateLiveGrow(performance.now());
    if (this.postBuildSettle) this.updateStreamInterp(performance.now());
    if (this.traversalAnim) this.updateTraversalAnim(performance.now());
    if (this.ambientActive) this.updateAmbient(performance.now());

    // Ease the size reference toward the live fit (snap on first use). camZoom
    // is already eased, so a smoothed denominator keeps node size from STEPPING
    // when lastFitZoom jumps each growth batch / reflow — the live-build judder.
    this.sizeFitRef =
      this.sizeFitRef <= 0
        ? this.lastFitZoom
        : this.sizeFitRef +
          (this.lastFitZoom - this.sizeFitRef) * this.AUTO_FIT_FOLLOW_ALPHA;
    const sizeRef = Math.max(this.sizeFitRef, 1e-6);
    // Keep the shader's zoom uniform in sync (size attenuation).
    for (const mat of [this.nodeMaterial, this.nodeHaloMaterial]) {
      if (!mat) continue;
      const u = mat.uniforms as unknown as NodeMaterialUniforms;
      u.uPerspective.value = 0;
      // Fit-normalized zoom (1.0 at the whole-graph overview) — see the 2D
      // sizing model in nodeMaterial.ts. Uses the SMOOTHED fit reference so node
      // size stays independent of layout world extent (Onion/Flat match at their
      // fit) without stepping while the graph reorganizes.
      u.uZoom.value = cam.zoom / sizeRef;
      u.uSizeExp.value = this.zoomSizeExponent;
    }
    if (this.edgeMaterial)
      this.edgeMaterial.uniforms.uOpacity.value = this.edgeOpacity();
    if (this.superEdgeMaterial)
      this.superEdgeMaterial.uniforms.uOpacity.value =
        this.edgeOpacityMultiplier;
    this.syncCurvedEdgeFrame();
    if (this.lodEnabled) this.updateLod();

    this.renderScene(cam);

    this.updateLabelsPerFrame();
    this.updatePing();
  }

  /** Per-frame upkeep for the curved bulk-edge object: mirror the straight
   *  edge set's visibility (so interaction-hide / LOD / enable toggles all
   *  apply without duplicating them) and its zoom-driven opacity. */
  private syncCurvedEdgeFrame(): void {
    if (
      !this.curvedEdgesActive ||
      !this.curvedEdgeObject ||
      !this.curvedEdgeMaterial
    )
      return;
    this.curvedEdgeObject.visible = this.edgeLines
      ? this.edgeLines.visible
      : true;
    (
      this.curvedEdgeMaterial.uniforms as unknown as CurvedEdgeMaterialUniforms
    ).uOpacity.value = this.edgeOpacity();
  }

  // ─── Depth of field ───────────────────────────────────────────────────

  /** Whether to render through the DOF pipeline this frame (only while a
   *  highlight is active and not mid build / live-grow, which own the frame). */
  private dofActive(): boolean {
    return (
      this.hasHighlight &&
      // A highlight too big for the sharp ribbon draws its hot edges as bright
      // chords on the blurred layer; blurring them smears the whole graph, so
      // skip DOF (nothing meaningful to blur at that highlight size anyway).
      !this.hotEdgesOverflowed &&
      !!this.renderer &&
      !!this.scene &&
      !!this.blurMaterial &&
      !!this.copyMaterial &&
      !!this.postScene &&
      !!this.postCamera &&
      !!this.postQuad &&
      this.buildAnim === null &&
      !this.buildPrepared &&
      !this.liveGrowActive
    );
  }

  /** Full-res scene target + half-res ping/pong for the blur, sized to the
   *  current drawing buffer. */
  private ensureDofTargets(): void {
    const r = this.renderer;
    if (!r) return;
    const buf = r.getDrawingBufferSize(this.tmpVec2);
    const fw = Math.max(1, Math.floor(buf.x));
    const fh = Math.max(1, Math.floor(buf.y));
    const hw = Math.max(1, Math.floor(fw / 2));
    const hh = Math.max(1, Math.floor(fh / 2));
    const opts = { minFilter: LinearFilter, magFilter: LinearFilter };
    if (!this.dofSceneRT) {
      this.dofSceneRT = new WebGLRenderTarget(fw, fh, opts);
      this.dofRtA = new WebGLRenderTarget(hw, hh, opts);
      this.dofRtB = new WebGLRenderTarget(hw, hh, opts);
    } else if (this.dofSceneRT.width !== fw || this.dofSceneRT.height !== fh) {
      this.dofSceneRT.setSize(fw, fh);
      this.dofRtA!.setSize(hw, hh);
      this.dofRtB!.setSize(hw, hh);
    }
  }

  /** Render the scene with depth of field: layer-0 background rendered to a
   *  target, blurred (downsampled separable gaussian), composited to screen,
   *  then the layer-1 sharp foreground (highlighted nodes + edges) on top. */
  private renderWithDof(cam: OrthographicCamera | PerspectiveCamera): void {
    const r = this.renderer!;
    const scene = this.scene!;
    const blur = this.blurMaterial!;
    const copy = this.copyMaterial!;
    const postScene = this.postScene!;
    const postCam = this.postCamera!;
    const quad = this.postQuad!;
    this.ensureDofTargets();
    const rtScene = this.dofSceneRT!;
    const rtA = this.dofRtA!;
    const rtB = this.dofRtB!;
    const bu = blur.uniforms as unknown as BlurMaterialUniforms;
    const cu = copy.uniforms as unknown as { uTex: { value: Texture | null } };

    // Pass 1: background (layer 0) → full-res scene target.
    cam.layers.disableAll();
    cam.layers.enable(0);
    r.setRenderTarget(rtScene);
    r.setClearColor(this.bgColor, 1);
    r.clear();
    r.render(scene, cam);

    // Downsample into the half-res ping target.
    quad.material = copy;
    cu.uTex.value = rtScene.texture;
    r.setRenderTarget(rtA);
    r.render(postScene, postCam);

    // Separable gaussian: horizontal (A→B) then vertical (B→A).
    const radius = DOF_BLUR_RADIUS;
    quad.material = blur;
    bu.uTex.value = rtA.texture;
    bu.uDir.value = [radius / rtA.width, 0];
    r.setRenderTarget(rtB);
    r.render(postScene, postCam);
    bu.uTex.value = rtB.texture;
    bu.uDir.value = [0, radius / rtA.height];
    r.setRenderTarget(rtA);
    r.render(postScene, postCam);

    // Composite the blurred background to the screen.
    r.setRenderTarget(null);
    r.setClearColor(this.bgColor, 1);
    r.clear();
    quad.material = copy;
    cu.uTex.value = rtA.texture;
    r.render(postScene, postCam);

    // Pass 2: sharp foreground (layer 1) over the composite.
    cam.layers.disableAll();
    cam.layers.enable(1);
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    r.render(scene, cam);
    r.autoClear = prevAutoClear;

    // Restore camera layers for the next normal render / GPU pick.
    cam.layers.disableAll();
    cam.layers.enable(0);
    cam.layers.enable(1);
  }

  /** Render the scene, through the DOF pipeline when a highlight is active. */
  private renderScene(cam: OrthographicCamera | PerspectiveCamera): void {
    const r = this.renderer;
    if (!r || !this.scene) return;
    if (this.dofActive()) this.renderWithDof(cam);
    else r.render(this.scene, cam);
  }

  // ─── Labels ────────────────────────────────────────────────────────

  /** Per-frame label work — kept O(visible): reposition the small set of
   *  shown labels every frame so they stay glued as nodes move / camera pans,
   *  and schedule a full (O(n)) overlap-cull only when the zoom changes,
   *  debounced so it runs after the gesture settles (mirrors PixiRenderer). */
  private updateLabelsPerFrame(): void {
    if (!this.activeCamera) return;
    // The HTML label overlay isn't tied to node size/edge alpha, so while the
    // build animation holds the graph collapsed (or plays), labels would keep
    // rendering over the empty canvas. Hide them until it's done. Node labels:
    // hide the layer directly (it has no per-frame state). Community labels:
    // let updateCommunityLabels() hide itself via its OWN display logic — never
    // force its layer's display from here, or the zoom-fade / frozen-visibility
    // state machine breaks. It recovers on its own once the build finishes.
    if (this.buildPrepared || this.buildAnim) {
      if (this.nodeLabelLayer) this.nodeLabelLayer.style.display = 'none';
      this.updateCommunityLabels();
      return;
    }
    if (this.nodeLabelLayer && this.nodeLabelLayer.style.display === 'none') {
      this.nodeLabelLayer.style.display = '';
    }
    const now = performance.now();
    const zoom = this.effectiveZoom();
    if (Math.abs(zoom - this.lastLabelCullZoom) > 1e-4) {
      this.lastLabelCullZoom = zoom;
      this.scheduleNodeLabelCull();
    }
    // In 3D the orbit distance (zoom) stays constant while rotating, so the
    // zoom-debounced cull above never fires. Re-cull on a throttle whenever the
    // camera has actually moved, so labels for nodes that orbit to the back of
    // the cloud drop out and newly front-facing ones get labelled.
    if (this.mode3d) {
      const moved =
        this.activeCamera.position.distanceToSquared(this.lastLabelCamPos) > 1;
      if (moved && now - this.lastLabelCull > 180) this.runNodeLabelCull();
      // Re-cull edges by viewport as the camera orbits, so edges that leave the
      // view (both endpoints off-screen) stop drawing across the empty frame.
      if (
        this.bp.edgeViewportCulling &&
        this.activeCamera.position.distanceToSquared(this.lastEdgeCullCamPos) >
          1 &&
        now - this.lastEdgeCull > 180
      ) {
        this.rebuildEdgeDrawIndex();
      }
    }
    // Throttle the DOM-heavy label repositioning to ~30fps; it doesn't need to
    // run on every render frame and keeps the main thread free during fast
    // rotation / layout streaming.
    if (now - this.lastLabelSync < LABEL_SYNC_INTERVAL) return;
    this.lastLabelSync = now;
    this.syncNodeLabelPositions();
    this.updateCommunityLabels();
  }
  private lastLabelSync = 0;
  private lastLabelCull = 0;
  private readonly lastLabelCamPos = new Vector3();
  private lastEdgeCull = 0;
  private readonly lastEdgeCullCamPos = new Vector3();

  /** A scalar "px-per-world-unit" usable for label LOD/size gates in both
   *  cameras: ortho zoom directly, or (in 3D) the perspective px/world at the
   *  current orbit-target distance. */
  /** True once the smoothed size reference has caught up to the live fit, so the
   *  render loop can idle again (see the 2D size-reference easing in frame()). */
  private sizeRefSettled(): boolean {
    if (this.mode3d) return true; // 3D size doesn't use the fit reference
    if (this.sizeFitRef <= 0) return false; // needs a snap-in first
    return (
      Math.abs(this.sizeFitRef - this.lastFitZoom) <= this.lastFitZoom * 0.005
    );
  }

  private effectiveZoom(): number {
    if (this.mode3d && this.perspCamera && this.controls) {
      const dist = this.perspCamera.position.distanceTo(this.controls.target);
      return (
        this.height /
        (2 * Math.tan((this.fov * Math.PI) / 360)) /
        Math.max(dist, 1)
      );
    }
    return this.camera?.zoom ?? 1;
  }

  private scheduleNodeLabelCull(): void {
    if (this.labelCullTimer !== null) clearTimeout(this.labelCullTimer);
    this.labelCullTimer = setTimeout(() => {
      this.labelCullTimer = null;
      this.runNodeLabelCull();
    }, 200);
  }

  /** World → screen (canvas px). `behind` is true for points behind the
   *  camera (perspective). Manual ortho path avoids per-call allocation. */
  private worldToScreen(
    wx: number,
    wy: number,
    wz: number,
  ): { x: number; y: number; behind: boolean } {
    const cam = this.activeCamera!;
    this.tmpVec.set(wx, wy, wz).project(cam);
    return {
      x: (this.tmpVec.x * 0.5 + 0.5) * this.width,
      y: (1 - (this.tmpVec.y * 0.5 + 0.5)) * this.height,
      behind: this.tmpVec.z > 1,
    };
  }

  /** Decide which node labels are visible: LOD handoff, viewport cull,
   *  min-screen-size gate, then overlap cull (largest nodes first). O(n) but
   *  only runs on zoom change / data / highlight / visibility change. */
  private runNodeLabelCull(): void {
    const layer = this.nodeLabelLayer;
    if (!layer || !this.activeCamera) return;
    const zoom = this.effectiveZoom();
    // Record when/where this cull ran so the per-frame 3D re-cull throttle knows
    // the labels are current for this camera pose.
    this.lastLabelCull = performance.now();
    this.lastLabelCamPos.copy(this.activeCamera.position);

    // Hide everything when labels are off, or zoomed out far enough that the
    // community wayfinders take over the overview.
    if (
      !this.showAllLabels ||
      (this.showCommunityLabels && zoom < this.NODE_LABEL_MIN_VP_SCALE)
    ) {
      this.clearNodeLabels();
      return;
    }

    // 2D: the fitted overview never shows labels (viewport-independent, unlike
    // the absolute-zoom size gate) — names only exist once the user zooms in.
    // Highlights are exempt: search/chat labels must show at any zoom.
    if (
      !this.mode3d &&
      !this.hasHighlight &&
      zoom < this.lastFitZoom * LABEL_2D_MIN_FIT_RATIO
    ) {
      this.clearNodeLabels();
      return;
    }

    // Candidate walk order: a size-sorted index over ALL nodes, rebuilt only
    // when the node set changes (sorting per cull was O(N log N) on every
    // zoom/orbit/highlight). Current filters (visibility / highlight) are
    // applied inline while walking — a stable sort of a filtered subsequence
    // equals the filtered subsequence of the stable-sorted whole, so the
    // resulting candidate order (size desc, ties by ascending node index) is
    // identical to the old filter-then-sort.
    const candidates = this.getLabelOrder();

    const lm = this.labelScaleMultiplier;
    const labelH = (LABEL_SIZE + 4) * lm;
    const MARGIN = 80;
    // Labels belong to nodes the camera is CLOSE to, never to distant dots.
    // The gate is PROXIMITY-ONLY — deliberately independent of the "Zoom
    // scaling" slider (zoomSizeExponent): making nodes render bigger must
    // change their size, not flood the overview with labels. In 3D each
    // node's own camera distance decides; in 2D the ortho zoom decides.
    const is3D = this.mode3d && !!this.perspCamera && !!this.controls;
    // 2D display factor (real rendered size, for the label gap only).
    const spriteRadiusFactor = is3D ? 0 : this.labelSpriteRadiusFactor(zoom);
    // 2D gate factor: fixed reference attenuation, slider-independent.
    // Normalized to the whole-graph fit zoom: on a big repo the fit zoom is
    // tiny (~0.02) and an absolute-zoom gate would keep labels away until an
    // extreme ~20× zoom. Relative to the fit, label onset scales with graph
    // size — crossing the fit-ratio gate above starts revealing the largest
    // nodes' names (the spacing pad + LABEL_2D_MAX keep density in check).
    const gate2dFactor = is3D
      ? 0
      : Math.pow(
          zoom / Math.max(this.lastFitZoom * LABEL_2D_MIN_FIT_RATIO, 1e-6),
          LABEL_GATE_2D_REF_EXP,
        );
    // 3D display gain (real rendered size, for the label gap only).
    const sizeGain3d = Math.pow(12, 0.3 - this.zoomSizeExponent);
    const unitZoom = this.height / (2 * Math.tan((this.fov * Math.PI) / 360));

    // In 3D, only label nodes within a sphere around the camera. A label is an
    // HTML overlay with no depth, so a back-facing node's label would draw on
    // top of the nodes in front of it — the "labels showing through nodes"
    // problem. At an overview this is the front hemisphere (cut at the orbit
    // distance, +5% so equator nodes still label). But the cutoff is floored at
    // the cloud radius so zooming in — where the orbit distance shrinks toward
    // zero — doesn't collapse the labeled shell and strip labels off the very
    // nodes you're moving toward.
    const camPos = this.activeCamera.position;
    let frontDistSq = 0;
    if (is3D) {
      const camDist = this.perspCamera!.position.distanceTo(
        this.controls!.target,
      );
      const cloudRadius = this.computeBounds3D().radius;
      const frontDist = Math.max(camDist * 1.05, cloudRadius);
      frontDistSq = frontDist * frontDist;
    }

    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const keep = new Set<string>();

    for (const i of candidates) {
      const node = this.nodeArray[i];
      // Candidate filter: highlighted-only when a highlight is active, else
      // all visible (formerly applied while building the candidate array).
      if (!node.visible) continue;
      if (this.hasHighlight && !this.nodeIsHot(node.id)) continue;
      // gateSize: capped so proximity beats hub size (see LABEL_GATE_SIZE_CAP);
      // screenR: the node's REAL rendered radius, for the label gap.
      const gateSize = Math.min(node.size, LABEL_GATE_SIZE_CAP);
      let screenR: number;
      if (is3D) {
        const dx = this.posArray[i * 3] - camPos.x;
        const dy = this.posArray[i * 3 + 1] - camPos.y;
        const dz = this.posArray[i * 3 + 2] - camPos.z;
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq > frontDistSq) continue;
        const persp = unitZoom / Math.max(Math.sqrt(distSq), 1e-3);
        const cue = 0.5 + 0.5 * persp;
        if (gateSize * cue < LABEL_GATE_MIN_3D) continue;
        screenR = node.size * cue * sizeGain3d;
      } else {
        if (gateSize * gate2dFactor < LABEL_GATE_MIN_2D) continue;
        screenR = node.size * spriteRadiusFactor;
      }
      const s = this.worldToScreen(
        this.posArray[i * 3],
        this.posArray[i * 3 + 1],
        this.posArray[i * 3 + 2],
      );
      if (
        s.behind ||
        s.x < -MARGIN ||
        s.x > this.width + MARGIN ||
        s.y < -MARGIN ||
        s.y > this.height + MARGIN
      ) {
        continue;
      }
      const text = cleanLabel(node.graphNode.name || node.id);
      const gapPx = screenR + 4;
      const w = text.length * LABEL_SIZE * 0.6 * lm;
      const x = s.x + gapPx;
      const y = s.y - labelH / 2;

      // 2D boxes carry a spacing margin so labels stay sparse instead of
      // tiling the screen edge-to-edge (see LABEL_2D_BOX_PAD_*).
      const padX = is3D ? 0 : LABEL_2D_BOX_PAD_X;
      const padY = is3D ? 0 : LABEL_2D_BOX_PAD_Y;
      const bx = x - padX;
      const by = y - padY;
      const bw = w + padX * 2;
      const bh = labelH + padY * 2;

      let overlap = false;
      for (const b of boxes) {
        if (
          bx < b.x + b.w &&
          bx + bw > b.x &&
          by < b.y + b.h &&
          by + bh > b.y
        ) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      boxes.push({ x: bx, y: by, w: bw, h: bh });
      keep.add(node.id);
      this.ensureNodeLabel(node.id, text, x, s.y);
      // Density ceiling (2D, non-highlight): the size-sorted scan means the
      // biggest nodes claimed the slots — stop before it becomes a text wall.
      if (!is3D && !this.hasHighlight && keep.size >= LABEL_2D_MAX) break;
    }

    // Remove labels no longer kept.
    for (const [id, el] of this.nodeLabelEls) {
      if (!keep.has(id)) {
        el.remove();
        this.nodeLabelEls.delete(id);
      }
    }
  }

  /** All node indices sorted by node size DESC, ties by ascending index (the
   *  stable-sort order the per-cull sort used to produce). Node sizes are
   *  fixed at creation, so the order only changes when the node set does —
   *  setData / appendLiveData mark it dirty. */
  private getLabelOrder(): number[] {
    if (
      this.labelOrderDirty ||
      this.labelOrder.length !== this.nodeArray.length
    ) {
      const n = this.nodeArray.length;
      const order: number[] = new Array(n);
      for (let i = 0; i < n; i++) order[i] = i;
      // Array.prototype.sort is stable, so equal sizes keep ascending-index
      // order — the same tie-break the old candidates sort produced.
      order.sort((a, b) => this.nodeArray[b].size - this.nodeArray[a].size);
      this.labelOrder = order;
      this.labelOrderDirty = false;
    }
    return this.labelOrder;
  }

  private labelOrder: number[] = [];
  private labelOrderDirty = true;

  private ensureNodeLabel(
    id: string,
    text: string,
    x: number,
    cy: number,
  ): HTMLDivElement {
    let el = this.nodeLabelEls.get(id);
    if (!el) {
      el = document.createElement('div');
      el.textContent = text;
      const c = getGraphThemeColors();
      el.style.cssText =
        'position:absolute;left:0;top:0;white-space:nowrap;' +
        `font:700 ${LABEL_SIZE}px ${LABEL_FONT};color:${c.labelColor};` +
        `text-shadow:0 0 3px ${c.labelShadow},0 0 3px ${c.labelShadow};` +
        'will-change:transform;';
      this.nodeLabelLayer!.appendChild(el);
      this.nodeLabelEls.set(id, el);
    }
    const lm = this.labelScaleMultiplier;
    el.style.transform = `translate(${x}px,${cy}px) translateY(-50%) scale(${lm})`;
    el.style.transformOrigin = 'left center';
    return el;
  }

  /** Screen-size multiplier for a node's base size, mirroring the ACTUAL
   *  per-mode shader sizing (nodeMaterial vertex shader) so the label cull
   *  judges what's really on screen. 2D: fit-normalized zoom cue × size gain.
   *  3D: depth cue at the orbit-target distance × the slider's size gain —
   *  `effectiveZoom()` is exactly the shader's `persp` for a node at the
   *  target depth, so `mix(1, persp, 0.5) = (1 + zoom) / 2`. */
  private labelSpriteRadiusFactor(zoom: number): number {
    if (this.mode3d) {
      return ((1 + zoom) / 2) * Math.pow(12, 0.3 - this.zoomSizeExponent);
    }
    // Mirror nodeMaterial's 2D branch: SMOOTHED-fit-normalized zoom × the same
    // gain, so the label gap tracks the node's real rendered radius.
    const ref = this.sizeFitRef > 0 ? this.sizeFitRef : this.lastFitZoom;
    const norm = zoom / Math.max(ref, 1e-6);
    return ((1 + norm) / 2) * Math.pow(12, 0.3 - this.zoomSizeExponent);
  }

  /** Lightweight per-frame reposition of the already-chosen label set. */
  private syncNodeLabelPositions(): void {
    if (this.nodeLabelEls.size === 0 || !this.activeCamera) return;
    const zoom = this.effectiveZoom();
    const is3D = this.mode3d && !!this.perspCamera;
    const spriteRadiusFactor = is3D ? 0 : this.labelSpriteRadiusFactor(zoom);
    // Per-node depth sizing in 3D — must match runNodeLabelCull's estimate so
    // the gap tracks the node's real rendered radius.
    const sizeGain3d = Math.pow(12, 0.3 - this.zoomSizeExponent);
    const unitZoom = this.height / (2 * Math.tan((this.fov * Math.PI) / 360));
    const camPos = this.activeCamera.position;
    const lm = this.labelScaleMultiplier;
    for (const [id, el] of this.nodeLabelEls) {
      const i = this.nodeIdToIndex.get(id);
      if (i === undefined) continue;
      const node = this.nodeArray[i];
      const s = this.worldToScreen(
        this.posArray[i * 3],
        this.posArray[i * 3 + 1],
        this.posArray[i * 3 + 2],
      );
      let screenR: number;
      if (is3D) {
        const dx = this.posArray[i * 3] - camPos.x;
        const dy = this.posArray[i * 3 + 1] - camPos.y;
        const dz = this.posArray[i * 3 + 2] - camPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const persp = unitZoom / Math.max(dist, 1e-3);
        screenR = node.size * (0.5 + 0.5 * persp) * sizeGain3d;
      } else {
        screenR = node.size * spriteRadiusFactor;
      }
      const gapPx = screenR + 4;
      el.style.transform = `translate(${s.x + gapPx}px,${s.y}px) translateY(-50%) scale(${lm})`;
    }
  }

  private clearNodeLabels(): void {
    for (const el of this.nodeLabelEls.values()) el.remove();
    this.nodeLabelEls.clear();
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const cam = this.camera;
    if (cam) {
      cam.left = -width / 2;
      cam.right = width / 2;
      cam.top = height / 2;
      cam.bottom = -height / 2;
      cam.updateProjectionMatrix();
    }
    if (this.perspCamera) {
      this.perspCamera.aspect = width / height;
      this.perspCamera.updateProjectionMatrix();
    }
    this.renderer?.setSize(width, height, false);
    if (this.renderer && this.pickTarget) {
      const buf = this.renderer.getDrawingBufferSize(this.tmpVec2);
      this.pickTarget.setSize(buf.x, buf.y);
    }
    this.requestRender();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.interactionAbort?.abort();
    this.interactionAbort = null;
    this.autoFitTarget = null;
    this.camAnim = null;

    this.disposeNodeObjects();
    this.disposeEdgeObjects();
    this.nodeMaterial?.dispose();
    this.nodeMaterial = null;
    this.nodeHaloMaterial?.dispose();
    this.nodeHaloMaterial = null;
    this.fgNodeMaterial?.dispose();
    this.fgNodeMaterial = null;
    this.edgeMaterial?.dispose();
    this.edgeMaterial = null;
    this.pickingMaterial?.dispose();
    this.pickingMaterial = null;
    this.pickTarget?.dispose();
    this.pickTarget = null;
    this.disposeSuperGraph();
    this.superEdgeMaterial?.dispose();
    this.superEdgeMaterial = null;
    this.disposeHotEdgeGeometry();
    this.hotEdgeMaterial?.dispose();
    this.hotEdgeMaterial = null;
    this.disposeCurvedEdges();
    this.curvedEdgeMaterial?.dispose();
    this.curvedEdgeMaterial = null;
    this.dofSceneRT?.dispose();
    this.dofRtA?.dispose();
    this.dofRtB?.dispose();
    this.dofSceneRT = this.dofRtA = this.dofRtB = null;
    this.blurMaterial?.dispose();
    this.blurMaterial = null;
    this.copyMaterial?.dispose();
    this.copyMaterial = null;
    this.postQuad?.geometry.dispose();
    this.postQuad = null;
    this.postScene = null;
    this.postCamera = null;
    if (this.interactionResumeTimer !== null) {
      clearTimeout(this.interactionResumeTimer);
      this.interactionResumeTimer = null;
    }
    if (this.labelCullTimer !== null) {
      clearTimeout(this.labelCullTimer);
      this.labelCullTimer = null;
    }
    this.nodeLabelLayer?.remove();
    this.communityLabelLayer?.remove();
    this.nodeLabelLayer = null;
    this.communityLabelLayer = null;
    this.nodeLabelEls.clear();
    this.communityLabelEls.clear();
    this.controls?.dispose();
    this.controls = null;
    this.perspCamera = null;
    for (const { sprite } of this.pingSprites.values()) {
      this.scene?.remove(sprite);
      sprite.material.dispose();
    }
    this.pingSprites.clear();
    if (this.traversalAnim) {
      this.scene?.remove(this.traversalAnim.sprite);
      this.traversalAnim.sprite.material.dispose();
      this.traversalAnim = null;
    }
    this.traversalLitNodes.clear();
    this.traversalLitEdges.clear();
    this.traversalPendingEdges.clear();
    if (this.traversalHeadLine) {
      this.scene?.remove(this.traversalHeadLine);
      this.traversalHeadLine.geometry.dispose();
      (this.traversalHeadLine.material as LineBasicMaterial).dispose();
      this.traversalHeadLine = null;
    }
    for (const tex of this.glowTextures.values()) tex.dispose();
    this.glowTextures.clear();

    this.nodes.clear();
    this.nodeArray = [];
    this.nodeIdToIndex.clear();
    this.edges = [];

    const dom = this.renderer?.domElement;
    this.renderer?.dispose();
    // dispose() frees caches but NOT the GL context; browsers cap live
    // contexts (~16 in Chrome) and every repo switch mounts a fresh renderer,
    // so without an explicit loss the oldest canvas eventually goes blank.
    this.renderer?.forceContextLoss();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
  }

  private disposeNodeObjects(): void {
    if (this.nodePoints && this.scene) this.scene.remove(this.nodePoints);
    this.nodeGeometry?.dispose();
    this.nodeGeometry = null;
    this.nodePoints = null;
    if (this.nodeHaloPoints && this.scene)
      this.scene.remove(this.nodeHaloPoints);
    this.nodeHaloGeometry?.dispose();
    this.nodeHaloGeometry = null;
    this.nodeHaloPoints = null;
    // fgNodePoints shares the halo geometry (already disposed above); just drop
    // the object from the scene.
    if (this.fgNodePoints && this.scene) this.scene.remove(this.fgNodePoints);
    this.fgNodePoints = null;
  }

  private disposeEdgeObjects(): void {
    if (this.edgeLines && this.scene) this.scene.remove(this.edgeLines);
    this.edgeGeometry?.dispose();
    this.edgeGeometry = null;
    this.edgeLines = null;
  }

  // ─── Data ─────────────────────────────────────────────────────────

  async setData(
    graphNodes: GraphNode[],
    graphLinks: GraphLink[],
    positions: Map<string, { x: number; y: number }>,
    nodeColors: Map<string, string>,
    nodeSizes: Map<string, number>,
    linkColors: Map<string, string>,
    opts?: {
      /** Skip the instant full-graph zoomToFit after the rebuild. Used by
       *  addData: an incremental append must not snap the user's camera —
       *  restoring `hasUserMovedCamera` afterwards is too late, the fit has
       *  already moved the camera by then. */
      skipAutoFit?: boolean;
    },
  ): Promise<void> {
    if (this.destroyed || !this.scene) return;

    // Any in-flight build replay refers to the old node/edge arrays.
    this.buildAnim = null;
    this.buildPrepared = false;
    this.preparedSizes = null;
    // Fresh dataset → snap the 2D size reference to the new graph's fit on first
    // use rather than easing from the previous graph's (possibly very different)
    // scale.
    this.sizeFitRef = 0;
    // The hovered index refers to the old node array.
    this.hoveredNodeIndex = -1;
    // Drop any traversal walk + lit trail — the node/edge ids are about to change.
    if (this.traversalAnim) {
      this.scene.remove(this.traversalAnim.sprite);
      this.traversalAnim.sprite.material.dispose();
      this.traversalAnim = null;
    }
    if (this.traversalHeadLine) this.traversalHeadLine.visible = false;
    this.traversalLitNodes.clear();
    this.traversalLitEdges.clear();
    this.traversalPendingEdges.clear();
    this.disposeNodeObjects();
    this.disposeEdgeObjects();
    this.disposeSuperGraph();
    this.superGraphDirty = true;
    this.clearNodeLabels();
    this.communityVisibilityFrozen = false;
    this.communityCentroids.clear();
    this.nodes.clear();
    this.nodeArray = [];
    this.nodeIdToIndex.clear();
    this.hasUserMovedCamera = false;
    this.layoutSettled = false;

    const n = graphNodes.length;
    // During live-build, over-allocate so streamed batches append in place
    // (no per-batch geometry rebuild). Buffers hold `nodeCapacity` nodes; only
    // the first `n` are used now, and drawRange limits what's rendered.
    const cap = this.liveGrowActive ? Math.max(n, 4096) : n;
    this.nodeCapacity = cap;
    this.posArray = new Float32Array(cap * 3);
    this.layoutPos = new Float32Array(cap * 3);
    this.layoutInterpPrev = new Float32Array(cap * 3);
    this.colorArray = new Float32Array(cap * 3);
    this.sizeArray = new Float32Array(cap);
    this.stateArray = new Float32Array(cap);
    this.pickColorArray = new Float32Array(cap * 3);

    for (let i = 0; i < n; i++) {
      const gn = graphNodes[i];
      const pos = positions.get(gn.id) ?? { x: 0, y: 0 };
      const color = nodeColors.get(gn.id) ?? FALLBACK_COLOR;
      const size = nodeSizes.get(gn.id) ?? 4;

      // Mirror updatePositionsFromBuffer's finite guard: one NaN coordinate
      // poisons bounds/fit math for the whole graph.
      this.posArray[i * 3] = Number.isFinite(pos.x) ? pos.x : 0;
      this.posArray[i * 3 + 1] = Number.isFinite(pos.y) ? pos.y : 0;
      this.posArray[i * 3 + 2] = 0;
      hexToRgb(color, this.tmpColor);
      this.colorArray[i * 3] = this.tmpColor.r;
      this.colorArray[i * 3 + 1] = this.tmpColor.g;
      this.colorArray[i * 3 + 2] = this.tmpColor.b;
      this.sizeArray[i] = size;
      this.stateArray[i] = NODE_STATE_VISIBLE;
      // Encode index+1 as an RGB id for GPU picking (0 = background/miss).
      const id = i + 1;
      this.pickColorArray[i * 3] = (id & 255) / 255;
      this.pickColorArray[i * 3 + 1] = ((id >> 8) & 255) / 255;
      this.pickColorArray[i * 3 + 2] = ((id >> 16) & 255) / 255;

      const node: ThreeNode = {
        id: gn.id,
        graphNode: gn,
        size,
        color,
        visible: true,
      };
      this.nodeIdToIndex.set(gn.id, i);
      this.nodeArray.push(node);
      this.nodes.set(gn.id, node);
    }
    // Node set replaced: label order must re-sort, every node starts visible,
    // and community centroids must recompute from the new positions.
    this.labelOrderDirty = true;
    this.hiddenNodeCount = 0;
    this.centroidsDirty = true;

    this.buildEdges(graphLinks, linkColors);
    this.bp = selectBreakpoint(n, this.breakpoints);
    // Resolve LOD for this dataset: 'auto' only aggregates large graphs so
    // smaller ones always show the whole graph at the overview.
    this.lodEnabled =
      this.lodMode === 'on'
        ? true
        : this.lodMode === 'off'
          ? false
          : n > LOD_AUTO_THRESHOLD;
    this.buildNodePoints();
    this.buildEdgeObjects();
    if (this.liveGrowActive) {
      this.applyLiveGrowAfterRebuild();
    } else if (!opts?.skipAutoFit) {
      this.zoomToFit(0);
    }
    // If a build animation was armed (post-index), collapse the freshly-built
    // graph NOW — before the first paint — so the finished graph never flashes
    // before the burst. Held collapsed until playBuildAnimation() fires.
    if (this.buildArmed) this.collapseForBuild();
  }

  private buildEdges(
    graphLinks: GraphLink[],
    linkColors: Map<string, string>,
  ): void {
    this.edges = [];
    // Reuse the persisted key set so live-build appends can dedup against it.
    this.edgeKeySet = new Set<string>();
    const seen = this.edgeKeySet;
    for (const gl of graphLinks) {
      const sourceId =
        typeof gl.source === 'string' ? gl.source : (gl.source as GraphNode).id;
      const targetId =
        typeof gl.target === 'string' ? gl.target : (gl.target as GraphNode).id;
      const sourceIdx = this.nodeIdToIndex.get(sourceId);
      const targetIdx = this.nodeIdToIndex.get(targetId);
      if (sourceIdx === undefined || targetIdx === undefined) continue;
      const key = `${sourceId}-${gl.label}-${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.edges.push({
        sourceId,
        targetId,
        sourceIdx,
        targetIdx,
        key: `${sourceId}-${targetId}`,
        label: gl.label,
        graphLink: gl,
        color: linkColors.get(gl.label) ?? '#3b4048',
      });
    }
  }

  private buildNodePoints(): void {
    if (!this.scene || !this.nodeMaterial) return;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.posArray, 3));
    geo.setAttribute('aColor', new BufferAttribute(this.colorArray, 3));
    geo.setAttribute('aSize', new BufferAttribute(this.sizeArray, 1));
    geo.setAttribute('aState', new BufferAttribute(this.stateArray, 1));
    geo.setAttribute('aPickColor', new BufferAttribute(this.pickColorArray, 3));
    // Buffers may be over-allocated (live-build) — only draw the real nodes.
    geo.setDrawRange(0, this.nodeArray.length);
    // Fresh geometry has no draw index yet (drawRange covers raw vertices)
    // until the next applyNodeStates installs one.
    this.nodeDrawIndexValid = false;
    const points = new Points(geo, this.nodeMaterial);
    points.frustumCulled = false; // we manage culling; bounds change every tick
    points.renderOrder = 1; // draw nodes on top of edges
    this.nodeGeometry = geo;
    this.nodePoints = points;
    this.scene.add(points);

    // Halo overlay for highlighted nodes: SHARES the attribute instances (one
    // upload serves both passes), draws only the hot subset via its own index
    // (filled in applyNodeStates), after edges (renderOrder 3 > edges' 2).
    if (this.nodeHaloMaterial) {
      const haloGeo = new BufferGeometry();
      haloGeo.setAttribute('position', geo.getAttribute('position'));
      haloGeo.setAttribute('aColor', geo.getAttribute('aColor'));
      haloGeo.setAttribute('aSize', geo.getAttribute('aSize'));
      haloGeo.setAttribute('aState', geo.getAttribute('aState'));
      haloGeo.setDrawRange(0, 0); // nothing highlighted yet
      const halo = new Points(haloGeo, this.nodeHaloMaterial);
      halo.frustumCulled = false;
      halo.renderOrder = 6; // highlighted glow, above the fg cores (5)
      halo.layers.set(1); // sharp DOF foreground
      this.nodeHaloGeometry = haloGeo;
      this.nodeHaloPoints = halo;
      this.scene.add(halo);

      // Foreground pass: the highlighted node CORES re-drawn crisply in front
      // of the blurred background. Shares the halo geometry (same highlighted-
      // only draw index) but uses the solid, depth-test-off core material.
      if (this.fgNodeMaterial) {
        const fg = new Points(haloGeo, this.fgNodeMaterial);
        fg.frustumCulled = false;
        fg.renderOrder = 5; // under the glow halo (6)
        fg.layers.set(1); // sharp DOF foreground
        this.fgNodePoints = fg;
        this.scene.add(fg);
      }
    }
    this.requestRender();
  }

  /** Build the single LineSegments for all edges. Color/alpha are filled now;
   *  endpoint positions are filled on the next streamed tick (and once here so
   *  the first frame isn't empty). */
  private buildEdgeObjects(): void {
    if (!this.scene || !this.edgeMaterial) return;
    const m = this.edges.length;
    // Over-allocate during live-build so appended edges don't rebuild geometry.
    const cap = this.liveGrowActive ? Math.max(m, 8192) : m;
    this.edgeCapacity = cap;
    this.edgePosArray = new Float32Array(cap * 2 * 3);
    this.edgeColorArray = new Float32Array(cap * 2 * 3);
    this.edgeAlphaArray = new Float32Array(cap * 2);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.edgePosArray, 3));
    geo.setAttribute('aColor', new BufferAttribute(this.edgeColorArray, 3));
    geo.setAttribute('aAlpha', new BufferAttribute(this.edgeAlphaArray, 1));
    geo.setDrawRange(0, m * 2);
    const lines = new LineSegments(geo, this.edgeMaterial);
    lines.frustumCulled = false;
    this.edgeGeometry = geo;
    this.edgeLines = lines;
    this.scene.add(lines);

    this.applyEdgeDepthMode();
    this.fillEdgeColors();
    this.updateEdgeAlpha();
    this.updateEdgePositions();
    // Swap in the curved edge object (or rebuild it to wrap the new arrays).
    this.syncCurvedEdges();
  }

  /** Depth/order policy for the edge layer, by camera mode.
   *
   *  3D: edges depth-test against the opaque node cloud and draw *after* it
   *  (renderOrder 2 > nodes' 1). A line is then hidden where it passes behind a
   *  nearer node and continuous where in front — fixing edges that looked
   *  "split" (a node disc painting over the middle of a line) or that seemed to
   *  end in empty space (the endpoint node occluded behind a closer one).
   *
   *  2D: the graph is coplanar so there's no occlusion; keep edges behind the
   *  nodes (renderOrder 0, no depth test) for the clean dots-on-top look. */
  private applyEdgeDepthMode(): void {
    const d = this.mode3d;
    const order = d ? 2 : 0;
    // Push edges slightly away from the camera in 3D (VIEW-SPACE world
    // units — see edgeMaterial's uDepthBias comment) so a line ending AT a
    // node's center doesn't paint across its disc. Comparable to a node
    // radius; a clip-space offset here previously clipped all edges past
    // the far plane (the "no edges in Planet/Bundled" bug).
    const bias = d ? 2.0 : 0;
    if (this.edgeMaterial) {
      this.edgeMaterial.depthTest = d;
      this.edgeMaterial.uniforms.uDepthBias.value = bias;
      this.edgeMaterial.needsUpdate = true;
    }
    if (this.superEdgeMaterial) {
      this.superEdgeMaterial.depthTest = d;
      this.superEdgeMaterial.uniforms.uDepthBias.value = bias;
      this.superEdgeMaterial.needsUpdate = true;
    }
    // Curved bulk edges match the straight set: occlude behind nodes in 3D,
    // draw-under in 2D. (The hot-edge glow ribbon is separate — always on top.)
    if (this.curvedEdgeMaterial) {
      const u = this.curvedEdgeMaterial
        .uniforms as unknown as CurvedEdgeMaterialUniforms;
      this.curvedEdgeMaterial.depthTest = d;
      u.uDepthBias.value = bias;
      u.uMode3d.value = d ? 1 : 0;
      this.curvedEdgeMaterial.needsUpdate = true;
    }
    if (this.edgeLines) this.edgeLines.renderOrder = order;
    if (this.superEdgeLines) this.superEdgeLines.renderOrder = order;
    if (this.curvedEdgeObject) this.curvedEdgeObject.renderOrder = order;
    this.requestRender();
  }

  /** Write per-vertex edge colors from each edge's resolved link color —
   *  except edges the chat traversal has walked, which are painted in the
   *  vivid trail color so the path pops even on large, zoomed-out graphs. */
  private fillEdgeColors(): void {
    const col = this.edgeColorArray;
    const hasTrail = this.traversalLitEdges.size > 0;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const lit = hasTrail && this.traversalLitEdges.has(e.key);
      hexToRgb(lit ? TRAVERSAL_TRAIL_COLOR : e.color, this.tmpColor);
      const o = i * 6;
      col[o] = this.tmpColor.r;
      col[o + 1] = this.tmpColor.g;
      col[o + 2] = this.tmpColor.b;
      col[o + 3] = this.tmpColor.r;
      col[o + 4] = this.tmpColor.g;
      col[o + 5] = this.tmpColor.b;
    }
    if (this.edgeGeometry) {
      (
        this.edgeGeometry.getAttribute('aColor') as BufferAttribute
      ).needsUpdate = true;
    }
    if (this.curvedEdgesActive && this.curvedColorBuffer)
      this.curvedColorBuffer.needsUpdate = true;
    this.requestRender();
  }

  /** Copy current node endpoints into the edge position buffer. O(edges);
   *  throttled by the caller during animation. */
  private updateEdgePositions(): void {
    if (!this.edgeGeometry) return;
    const pos = this.posArray;
    const ep = this.edgePosArray;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const s = e.sourceIdx;
      const t = e.targetIdx;
      const o = i * 6;
      ep[o] = pos[s * 3];
      ep[o + 1] = pos[s * 3 + 1];
      ep[o + 2] = pos[s * 3 + 2];
      ep[o + 3] = pos[t * 3];
      ep[o + 4] = pos[t * 3 + 1];
      ep[o + 5] = pos[t * 3 + 2];
    }
    (
      this.edgeGeometry.getAttribute('position') as BufferAttribute
    ).needsUpdate = true;
    // Hot-edge ribbons bow between the same endpoints — follow them as the
    // layout streams (topology unchanged, so just rewrite curve samples).
    this.refreshHotEdgePositions();
    // Curved bulk edges alias edgePosArray — re-upload the instanced buffer.
    if (this.curvedEdgesActive && this.curvedPosBuffer)
      this.curvedPosBuffer.needsUpdate = true;
    this.lastEdgeRedraw = performance.now();
    this.requestRender();
  }

  // ─── Hot-edge glow ribbon ─────────────────────────────────────────────
  //
  // Highlighted / chat-traversal edges render as soft, curved, additively-
  // blended strands of light instead of the bulk edges' straight 1px GL lines,
  // so a highlight reads as organic filaments rather than a vector-graphic
  // star. Geometry is built on the CPU (the hot set is small); the ribbon's
  // pixel width and screen-facing orientation are handled in the shader, so
  // orbiting the camera never needs a rebuild — only a change to the hot set
  // (topology) or to node positions (curve samples) does.

  /** Collect the hot edges the ribbon should own this pass: highlighted /
   *  traversal-crossed edges whose endpoints are both visible. Sets
   *  `hotRibbonActive` so the bulk line set zeroes them (no double-draw). Above
   *  HOT_EDGE_MAX the ribbon bows out and the bulk lines keep the hot edges. */
  private syncHotEdgeList(): void {
    // No separate glow ribbon. Highlighted edges are drawn by the SAME bulk edge
    // object as everything else (brightened via edgeAlphaGeneral's absolute-alpha
    // encoding), so a selected node's edges look identical in style to the
    // unselected edges — thin 1px lines, not a fat ribbon. To keep them SHARP
    // over the DOF blur, `updateEdgeLayers` moves the whole edge object to the
    // sharp foreground layer while a highlight is active (DOF still blurs the
    // background nodes). No ribbon, DOF preserved.
    this.hotEdgeList.length = 0;
    this.hotRibbonActive = false;
    this.hotEdgesOverflowed = false;
  }

  /** While a highlight is active, move the bulk edge object to the sharp DOF
   *  foreground layer (1) so its brightened highlighted edges — and the dimmed
   *  rest — render crisp over the blurred background, via the NORMAL edge
   *  renderer (no ribbon). Off-highlight they live on the base layer (0). */
  private updateEdgeLayers(): void {
    const layer = this.hasHighlight ? 1 : 0;
    this.edgeLines?.layers.set(layer);
    this.curvedEdgeObject?.layers.set(layer);
  }

  /** Build / refresh the ribbon geometry from `hotEdgeList`. Topology (side
   *  flags + triangle indices) only rebuilds when the edge count changes;
   *  colours + curve samples refresh every call. */
  private rebuildHotEdges(): void {
    if (!this.scene || !this.hotEdgeMaterial) return;
    const count = this.hotEdgeList.length;
    if (!this.hotRibbonActive || count === 0) {
      this.clearHotEdges();
      return;
    }
    const N = HOT_EDGE_CURVE_SEGMENTS;
    const vertsPerEdge = N * 2;
    const verts = count * vertsPerEdge;

    // Grow the buffers (with headroom) when the edge count outgrows them.
    if (this.hotEdgeSideArray.length < verts) {
      const capV = verts * 2;
      this.hotEdgePosArray = new Float32Array(capV * 3);
      this.hotEdgeTangentArray = new Float32Array(capV * 3);
      this.hotEdgeSideArray = new Float32Array(capV);
      this.hotEdgeColorArray = new Float32Array(capV * 3);
      this.hotEdgeAlphaArray = new Float32Array(capV);
      this.hotEdgeIndexArray = new Uint32Array(capV * 3); // ≥ (N-1)*6 per edge
      this.disposeHotEdgeGeometry(); // rebind fresh arrays below
      this.hotEdgeBuiltCount = -1; // force topology rebuild onto new buffers
    }

    if (this.hotEdgeBuiltCount !== count) {
      const side = this.hotEdgeSideArray;
      const idx = this.hotEdgeIndexArray;
      let ii = 0;
      for (let j = 0; j < count; j++) {
        const base = j * vertsPerEdge;
        for (let i = 0; i < N; i++) {
          side[base + i * 2] = -1;
          side[base + i * 2 + 1] = 1;
          if (i < N - 1) {
            const a0 = base + i * 2;
            const a1 = a0 + 1;
            const b0 = a0 + 2;
            const b1 = a0 + 3;
            // Two triangles per segment quad (a0,a1,b1,b0).
            idx[ii++] = a0;
            idx[ii++] = a1;
            idx[ii++] = b0;
            idx[ii++] = a1;
            idx[ii++] = b1;
            idx[ii++] = b0;
          }
        }
      }
      this.hotEdgeIndexCount = ii;
      this.hotEdgeBuiltCount = count;
      this.ensureHotEdgeGeometry();
    }

    this.fillHotEdgeColors();
    this.refreshHotEdgePositions();

    const geo = this.hotEdgeGeometry;
    if (geo) {
      for (const name of ['aTangent', 'aSide', 'aColor', 'aAlpha']) {
        const attr = geo.getAttribute(name) as BufferAttribute | undefined;
        if (attr) attr.needsUpdate = true;
      }
      const index = geo.getIndex();
      if (index) index.needsUpdate = true;
      geo.setDrawRange(0, this.hotEdgeIndexCount);
    }
    if (this.hotEdgeMesh) this.hotEdgeMesh.visible = true;
    this.requestRender();
  }

  /** Rewrite the ribbon's curve samples (positions + tangents) from the current
   *  node positions. Cheap; safe to call per layout tick. */
  private refreshHotEdgePositions(): void {
    if (!this.hotRibbonActive || !this.hotEdgeGeometry) return;
    const edges = this.hotEdgeList;
    const N = HOT_EDGE_CURVE_SEGMENTS;
    const is3D = this.mode3d;
    const pos = this.posArray;
    const P = this.hotEdgePosArray;
    const T = this.hotEdgeTangentArray;
    for (let j = 0; j < edges.length; j++) {
      const e = edges[j];
      const s = e.sourceIdx * 3;
      const t2 = e.targetIdx * 3;
      const ax = pos[s];
      const ay = pos[s + 1];
      const az = pos[s + 2];
      const bx = pos[t2];
      const by = pos[t2 + 1];
      const bz = pos[t2 + 2];
      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const len = Math.hypot(dx, dy, dz) || 1;
      const inv = 1 / len;
      const dnx = dx * inv;
      const dny = dy * inv;
      const dnz = dz * inv;
      // Bow direction: in the plane for 2D; a stable horizontal arc in 3D
      // (cross(dir, up), falling back to cross(dir, right) when near-vertical).
      let px: number;
      let py: number;
      let pz: number;
      if (!is3D) {
        px = -dny;
        py = dnx;
        pz = 0;
      } else {
        px = -dnz;
        py = 0;
        pz = dnx;
        if (px * px + py * py + pz * pz < 1e-4) {
          px = 0;
          py = dnz;
          pz = -dny;
        }
      }
      const pl = Math.hypot(px, py, pz) || 1;
      const pinv = 1 / pl;
      px *= pinv;
      py *= pinv;
      pz *= pinv;
      const sag = len * HOT_EDGE_SAG_FACTOR;
      const cx = (ax + bx) * 0.5 + px * sag;
      const cy = (ay + by) * 0.5 + py * sag;
      const cz = (az + bz) * 0.5 + pz * sag;
      const base = j * N * 2;
      for (let i = 0; i < N; i++) {
        const tt = i / (N - 1);
        const u = 1 - tt;
        // Quadratic bezier point + tangent.
        const w0 = u * u;
        const w1 = 2 * u * tt;
        const w2 = tt * tt;
        const qx = w0 * ax + w1 * cx + w2 * bx;
        const qy = w0 * ay + w1 * cy + w2 * by;
        const qz = w0 * az + w1 * cz + w2 * bz;
        let gx = 2 * u * (cx - ax) + 2 * tt * (bx - cx);
        let gy = 2 * u * (cy - ay) + 2 * tt * (by - cy);
        let gz = 2 * u * (cz - az) + 2 * tt * (bz - cz);
        const gl = Math.hypot(gx, gy, gz) || 1;
        const ginv = 1 / gl;
        gx *= ginv;
        gy *= ginv;
        gz *= ginv;
        const v0 = (base + i * 2) * 3;
        const v1 = v0 + 3;
        P[v0] = qx;
        P[v0 + 1] = qy;
        P[v0 + 2] = qz;
        P[v1] = qx;
        P[v1 + 1] = qy;
        P[v1 + 2] = qz;
        T[v0] = gx;
        T[v0 + 1] = gy;
        T[v0 + 2] = gz;
        T[v1] = gx;
        T[v1 + 1] = gy;
        T[v1 + 2] = gz;
      }
    }
    const p = this.hotEdgeGeometry.getAttribute('position') as BufferAttribute;
    p.needsUpdate = true;
    this.requestRender();
  }

  /** Per-vertex colour (label colour, or the trail colour while a walk lights
   *  it) and the along-curve alpha taper (ends melt into the nodes). */
  private fillHotEdgeColors(): void {
    const edges = this.hotEdgeList;
    const N = HOT_EDGE_CURVE_SEGMENTS;
    const col = this.hotEdgeColorArray;
    const alp = this.hotEdgeAlphaArray;
    const hasTrail = this.traversalLitEdges.size > 0;
    // Every strand glows at FULL strength, end to end — no per-strand alpha
    // capping, no taper. The hot-edge material uses MAX ("lighten") blending, so
    // overlapping strands at a dense hub take the brightest value instead of
    // summing to a white blob; the pile-up problem is solved at the blend level.
    const peakAlpha = HOT_EDGE_GLOW_ALPHA;
    for (let j = 0; j < edges.length; j++) {
      const e = edges[j];
      const lit = hasTrail && this.traversalLitEdges.has(e.key);
      hexToRgb(lit ? TRAVERSAL_TRAIL_COLOR : e.color, this.tmpColor);
      const r = this.tmpColor.r;
      const g = this.tmpColor.g;
      const b = this.tmpColor.b;
      const base = j * N * 2;
      const end = base + N * 2;
      for (let v = base; v < end; v++) {
        col[v * 3] = r;
        col[v * 3 + 1] = g;
        col[v * 3 + 2] = b;
        alp[v] = peakAlpha;
      }
    }
  }

  /** (Re)create the ribbon geometry + mesh bound to the current buffers. */
  private ensureHotEdgeGeometry(): void {
    if (this.hotEdgeGeometry || !this.scene || !this.hotEdgeMaterial) return;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.hotEdgePosArray, 3));
    geo.setAttribute(
      'aTangent',
      new BufferAttribute(this.hotEdgeTangentArray, 3),
    );
    geo.setAttribute('aSide', new BufferAttribute(this.hotEdgeSideArray, 1));
    geo.setAttribute('aColor', new BufferAttribute(this.hotEdgeColorArray, 3));
    geo.setAttribute('aAlpha', new BufferAttribute(this.hotEdgeAlphaArray, 1));
    geo.setIndex(new BufferAttribute(this.hotEdgeIndexArray, 1));
    const mesh = new Mesh(geo, this.hotEdgeMaterial);
    mesh.frustumCulled = false;
    // Part of the sharp foreground (layer 1): drawn on top of the blurred
    // background with the highlighted nodes (fg cores 5, glow halo 6).
    mesh.renderOrder = 4;
    mesh.layers.set(1);
    this.hotEdgeGeometry = geo;
    this.hotEdgeMesh = mesh;
    this.scene.add(mesh);
  }

  private disposeHotEdgeGeometry(): void {
    if (this.hotEdgeMesh && this.scene) this.scene.remove(this.hotEdgeMesh);
    this.hotEdgeGeometry?.dispose();
    this.hotEdgeGeometry = null;
    this.hotEdgeMesh = null;
  }

  /** Stop drawing the ribbon (keeps buffers for reuse). */
  private clearHotEdges(): void {
    this.hotRibbonActive = false;
    this.hotEdgeList.length = 0;
    if (this.hotEdgeMesh) this.hotEdgeMesh.visible = false;
  }

  // ─── Curve-all bulk edges ─────────────────────────────────────────────
  //
  // Render every edge as a gentle arc instead of a straight ray. An instanced
  // LineSegments draws one template curve per edge; the edge's endpoints /
  // colour / alpha arrive as per-instance attributes that ALIAS the straight
  // edge set's own arrays, and the bezier is evaluated in the vertex shader —
  // so this adds no per-frame CPU work and reuses all the straight set's alpha /
  // colour / visibility logic. When active it replaces the straight `edgeLines`
  // in the scene (kept for hit-testing + state, just not rendered). Gated to
  // graphs small enough that edges are actually shown (see CURVE_ALL_EDGES_MAX)
  // and skipped mid-live-build (arrays realloc there).

  private shouldCurveEdges(): boolean {
    return (
      this.edges.length > 0 &&
      this.edges.length <= CURVE_ALL_EDGES_MAX &&
      !this.liveGrowActive &&
      this.buildAnim === null &&
      !this.buildPrepared
    );
  }

  /** Activate / deactivate / rebuild the curved edge object to match the
   *  current edge set. Call after the straight edge geometry is (re)built. */
  private syncCurvedEdges(): void {
    if (!this.scene) return;
    if (this.shouldCurveEdges()) {
      // Rebuild so the instanced attributes wrap the CURRENT arrays (a prior
      // buildEdgeObjects / append may have reallocated them).
      this.disposeCurvedEdges();
      this.buildCurvedEdgeGeometry();
      if (this.curvedEdgeObject) {
        this.scene.add(this.curvedEdgeObject);
        if (this.edgeLines) this.scene.remove(this.edgeLines);
        this.curvedEdgesActive = true;
        this.applyEdgeDepthMode(); // sets depthTest / bias / renderOrder / mode
        this.flagCurvedEdgeBuffers();
        this.updateEdgeLayers(); // sharp-layer while highlighting
        this.requestRender();
      }
    } else if (this.curvedEdgesActive) {
      this.disposeCurvedEdges();
      if (this.edgeLines && !this.scene.children.includes(this.edgeLines)) {
        this.scene.add(this.edgeLines);
      }
      this.curvedEdgesActive = false;
      this.updateEdgeLayers();
      this.requestRender();
    }
  }

  private buildCurvedEdgeGeometry(): void {
    if (!this.curvedEdgeMaterial) return;
    const N = CURVE_ALL_EDGES_SEGMENTS; // sample points
    const segs = N - 1; // sub-segments (LineSegments → vertex pairs)
    const vtx = segs * 2;
    // Template: a curve parameter per vertex; dummy positions (the shader
    // computes the real position from the per-instance endpoints + aT).
    const aT = new Float32Array(vtx);
    const dummy = new Float32Array(vtx * 3);
    let k = 0;
    for (let i = 0; i < segs; i++) {
      aT[k++] = i / segs;
      aT[k++] = (i + 1) / segs;
    }
    const geo = new InstancedBufferGeometry();
    geo.setAttribute('position', new BufferAttribute(dummy, 3));
    geo.setAttribute('aT', new BufferAttribute(aT, 1));
    // Per-instance attributes aliasing the straight edge arrays (same memory):
    //   edgePosArray   6 floats/edge → iA(0..2), iB(3..5)
    //   edgeColorArray 6 floats/edge → iColor(0..2) (both verts share a colour)
    //   edgeAlphaArray 2 floats/edge → iAlpha(0)
    const posBuf = new InstancedInterleavedBuffer(this.edgePosArray, 6);
    const colBuf = new InstancedInterleavedBuffer(this.edgeColorArray, 6);
    const alpBuf = new InstancedInterleavedBuffer(this.edgeAlphaArray, 2);
    geo.setAttribute('iA', new InterleavedBufferAttribute(posBuf, 3, 0));
    geo.setAttribute('iB', new InterleavedBufferAttribute(posBuf, 3, 3));
    geo.setAttribute('iColor', new InterleavedBufferAttribute(colBuf, 3, 0));
    geo.setAttribute('iAlpha', new InterleavedBufferAttribute(alpBuf, 1, 0));
    geo.instanceCount = this.edges.length;
    this.curvedPosBuffer = posBuf;
    this.curvedColorBuffer = colBuf;
    this.curvedAlphaBuffer = alpBuf;
    const obj = new LineSegments(geo, this.curvedEdgeMaterial);
    obj.frustumCulled = false;
    this.curvedEdgeGeometry = geo;
    this.curvedEdgeObject = obj;
  }

  /** Re-upload the instanced buffers after the aliased arrays change (they
   *  share memory with the straight set, which fills them). */
  private flagCurvedEdgeBuffers(): void {
    if (!this.curvedEdgesActive) return;
    if (this.curvedPosBuffer) this.curvedPosBuffer.needsUpdate = true;
    if (this.curvedColorBuffer) this.curvedColorBuffer.needsUpdate = true;
    if (this.curvedAlphaBuffer) this.curvedAlphaBuffer.needsUpdate = true;
  }

  private disposeCurvedEdges(): void {
    if (this.curvedEdgeObject && this.scene) {
      this.scene.remove(this.curvedEdgeObject);
    }
    this.curvedEdgeGeometry?.dispose();
    this.curvedEdgeGeometry = null;
    this.curvedEdgeObject = null;
    this.curvedPosBuffer = null;
    this.curvedColorBuffer = null;
    this.curvedAlphaBuffer = null;
  }

  /** Recompute per-edge alpha from edgesEnabled / hidden types / highlight.
   *  Endpoints whose node is hidden, or whose link type is hidden, get 0. */
  private updateEdgeAlpha(): void {
    if (!this.edgeGeometry) return;
    // While the build animation is held-collapsed or playing, edge alpha is
    // owned by that flow (0 when prepared, driven per-frame while animating).
    // A stray prop-sync call here would otherwise re-show edges over the still
    // hidden nodes — the "edges flash then disappear" bug. Keep them hidden.
    if (this.buildPrepared || this.buildAnim) {
      this.edgeAlphaArray.fill(0);
      (
        this.edgeGeometry.getAttribute('aAlpha') as BufferAttribute
      ).needsUpdate = true;
      this.clearHotEdges();
      return;
    }
    // Resolve hot-edge state before the per-edge loop, and move the edge object
    // to the sharp DOF layer while a highlight is active so highlighted edges
    // render crisp (as normal thin lines) over the blurred background.
    this.syncHotEdgeList();
    this.updateEdgeLayers();
    const a = this.edgeAlphaArray;
    const enabled = this.edgesEnabled;
    const lod = this.lodEnabled && this.superList.length > 0;
    const lodVis = lod ? this.computeLodVisFlags() : null;
    // While a chat walk is in play (or its lit trail persists), the graph's
    // OTHER edges hide completely instead of dimming — every visible edge is
    // one the agent actually built, so the connections read as appearing from
    // nothing ("watch it build") rather than recoloring an existing web.
    const traversalActive = this.traversalActive();
    // No-highlight fast pass: with no highlight active and no traversal edges
    // pending, the hot / pending branches of the general path are statically
    // false for every edge, so a tight loop over the base computation skips
    // two Set lookups per edge. Output is bit-identical to the general path.
    const noHighlight =
      !this.hasHighlight && this.traversalPendingEdges.size === 0;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const alpha = noHighlight
        ? this.edgeAlphaNoHighlight(e, enabled, lodVis)
        : this.edgeAlphaGeneral(e, enabled, lodVis, traversalActive);
      a[i * 2] = alpha;
      a[i * 2 + 1] = alpha;
    }
    (this.edgeGeometry.getAttribute('aAlpha') as BufferAttribute).needsUpdate =
      true;
    if (this.curvedEdgesActive && this.curvedAlphaBuffer)
      this.curvedAlphaBuffer.needsUpdate = true;
    this.rebuildEdgeDrawIndex();
    this.rebuildHotEdges();
  }

  /** Per-edge alpha, general path (highlight active and/or traversal edges
   *  pending). Exactly the historical updateEdgeAlpha per-edge computation. */
  private edgeAlphaGeneral(
    e: ThreeEdge,
    enabled: boolean,
    lodVis: Uint8Array | null,
    traversalActive: boolean,
  ): number {
    const key = e.key;
    // Hot edges (chat traversal trail / highlight neighborhood) stay
    // visible even when the edge layer is off, the link type is hidden, or
    // LOD collapsed the region — "show me the path" beats the hide toggles
    // (highlighted NODES already get the same override in applyNodeStates).
    const hot = this.hasHighlight && this.edgeIsHot(key);
    if (this.traversalPendingEdges.has(key)) {
      // Queued in the walk but not yet crossed — invisible until the pulse
      // builds it, even if the app-side highlight already marked it hot.
      return 0;
    }
    if ((!enabled || this.hiddenLinkTypes.has(e.label)) && !hot) return 0;
    const sVis = this.nodeArray[e.sourceIdx]?.visible ?? true;
    const tVis = this.nodeArray[e.targetIdx]?.visible ?? true;
    // Under LOD a detail edge only draws when BOTH endpoints' communities
    // are expanded; otherwise a super-edge represents the relationship.
    const lodHidden =
      lodVis !== null &&
      (lodVis[e.sourceIdx] === 0 || lodVis[e.targetIdx] === 0);
    if (!sVis || !tVis || (lodHidden && !hot)) return 0;
    if (this.hasHighlight) {
      // Hot edges normally use the shader's ABSOLUTE encoding (1 + alpha) so
      // the lit path renders fully opaque regardless of the preset's edge
      // opacity. But when the glow ribbon owns them (hotRibbonActive) they must
      // be zeroed here so the straight chord doesn't draw under the curve.
      // Everything else keeps its normal global multiplier and is dimmed
      // relative to it — a preset that hides edges (Onion 0%, Planet 15%) keeps
      // them hidden while the walked path lights up.
      return hot
        ? this.hotRibbonActive
          ? 0
          : 1 + EDGE_OPACITY_HIGHLIGHTED
        : traversalActive
          ? 0
          : EDGE_OPACITY_DIMMED;
    }
    return this.edgeAlphaBase(e);
  }

  /** Per-edge alpha when NO highlight is active and no traversal edges are
   *  pending (the common idle / live-streaming state): the general path with
   *  its hot / pending / highlight branches — all statically false in that
   *  state — removed. Shared by the full updateEdgeAlpha pass and the
   *  appendLiveEdges O(batch) fast path so both compute identical values. */
  private edgeAlphaNoHighlight(
    e: ThreeEdge,
    enabled: boolean,
    lodVis: Uint8Array | null,
  ): number {
    if (!enabled || this.hiddenLinkTypes.has(e.label)) return 0;
    const sVis = this.nodeArray[e.sourceIdx]?.visible ?? true;
    const tVis = this.nodeArray[e.targetIdx]?.visible ?? true;
    // Under LOD a detail edge only draws when BOTH endpoints' communities
    // are expanded; otherwise a super-edge represents the relationship.
    const lodHidden =
      lodVis !== null &&
      (lodVis[e.sourceIdx] === 0 || lodVis[e.targetIdx] === 0);
    if (!sVis || !tVis || lodHidden) return 0;
    return this.edgeAlphaBase(e);
  }

  /** Base (visible, un-highlighted) edge alpha: the default opacity, with the
   *  tree-mode relational-chord fade. */
  private edgeAlphaBase(e: ThreeEdge): number {
    let alpha = EDGE_OPACITY_DEFAULT;
    // The radial tree reads through its DEFINES skeleton. Relational
    // chords (calls/imports) cross the whole map — on a real repo
    // (thousands of them) they drown the structure into a solid web,
    // so keep them faint until a highlight makes them relevant.
    if (this.currentLayoutMode === 'tree' && e.label !== 'DEFINES') {
      alpha *= 0.1;
    }
    return alpha;
  }

  /** Fill (and return) the reusable per-node LOD visibility flag array —
   *  `flags[i] === 1` ⇔ `nodeLodVisible(nodeArray[i].id)`. Lets the per-edge
   *  loops (2 lookups per edge) and applyNodeStates read one array cell per
   *  endpoint instead of re-walking assignments/cidToSuper maps each time.
   *  Only meaningful while LOD is aggregating (callers gate on that). */
  private computeLodVisFlags(): Uint8Array {
    const n = this.nodeArray.length;
    if (this.lodVisFlags.length < n) this.lodVisFlags = new Uint8Array(n);
    const f = this.lodVisFlags;
    for (let i = 0; i < n; i++) {
      f[i] = this.nodeLodVisible(this.nodeArray[i].id) ? 1 : 0;
    }
    return f;
  }

  private lodVisFlags: Uint8Array = new Uint8Array(0);

  /** True if node `i` projects inside the viewport (plus a margin). No
   *  allocation — reuses tmpVec. Used to viewport-cull edges. */
  private nodeInView(i: number, marginX: number, marginY: number): boolean {
    const cam = this.activeCamera;
    if (!cam) return true;
    this.tmpVec
      .set(
        this.posArray[i * 3],
        this.posArray[i * 3 + 1],
        this.posArray[i * 3 + 2],
      )
      .project(cam);
    if (this.tmpVec.z > 1) return false; // behind the camera
    const sx = (this.tmpVec.x * 0.5 + 0.5) * this.width;
    const sy = (1 - (this.tmpVec.y * 0.5 + 0.5)) * this.height;
    return (
      sx >= -marginX &&
      sx <= this.width + marginX &&
      sy >= -marginY &&
      sy <= this.height + marginY
    );
  }

  /** Build the edge index buffer: only edges that draw (alpha > 0), and — when
   *  the tier enables viewport culling — only those with at least one endpoint
   *  on (or near) screen. Without this, zooming in leaves a web of edges whose
   *  BOTH endpoints are off-screen crossing the empty view, which reads as
   *  "edges not connected to any visible node". */
  private rebuildEdgeDrawIndex(): void {
    if (!this.edgeGeometry) return;
    const a = this.edgeAlphaArray;
    // `<` (not `!==`): keep spare capacity so the live-build append fast path
    // can extend in place; entries past edgeDrawCount are never submitted.
    if (this.edgeDrawIndex.length < this.edges.length * 2) {
      this.edgeDrawIndex = new Uint32Array(this.edges.length * 2);
    }
    const eidx = this.edgeDrawIndex;
    const cull = this.bp.edgeViewportCulling && this.activeCamera != null;
    const mx = this.width * 0.25;
    const my = this.height * 0.25;
    // Project each NODE once into a reusable flag array instead of running
    // nodeInView per edge endpoint (up to 2·E projections; E ≈ 1.35·N at
    // Grafana scale, and this reruns every 180ms while orbiting). Decisions
    // are identical — same nodeInView, same margins, same camera. Built
    // lazily on the first drawable edge so states where nothing draws (edges
    // off / all alphas 0) pay no projections at all.
    // While a highlight is active the edge object sits on the sharp DOF layer
    // (see updateEdgeLayers). Drawing the dimmed, non-highlighted edges there
    // too made every OTHER hub's dense edge-convergence show as a crisp "hot
    // spot" instead of blurring into the background. So during a highlight the
    // sharp layer draws ONLY the highlighted edges; the rest drop out (the
    // graph's non-selected edges recede, like the blurred background nodes).
    const hotOnly = this.hasHighlight;
    let view: Uint8Array | null = null;
    let ec = 0;
    for (let i = 0; i < this.edges.length; i++) {
      if (a[i * 2] <= 0) continue;
      if (hotOnly && !this.edgeIsHot(this.edges[i].key)) continue;
      if (cull) {
        if (view === null) view = this.computeNodeViewFlags(mx, my);
        const e = this.edges[i];
        if (view[e.sourceIdx] === 0 && view[e.targetIdx] === 0) {
          continue; // both endpoints off-screen → don't draw
        }
      }
      eidx[ec++] = i * 2;
      eidx[ec++] = i * 2 + 1;
    }
    this.edgeDrawCount = ec;
    this.snapshotEdgeCullCamera(cull);
    this.setGeometryDrawIndex(this.edgeGeometry, eidx, ec);
    if (this.activeCamera)
      this.lastEdgeCullCamPos.copy(this.activeCamera.position);
    this.lastEdgeCull = performance.now();
    this.requestRender();
  }

  /** Fill (and return) the reusable per-node "projects inside the viewport"
   *  flag array — flags[i] ⇔ nodeInView(i, marginX, marginY). One projection
   *  per node, identical decisions to calling nodeInView per use. */
  private computeNodeViewFlags(marginX: number, marginY: number): Uint8Array {
    const n = this.nodeArray.length;
    if (this.nodeViewFlags.length < n) this.nodeViewFlags = new Uint8Array(n);
    const view = this.nodeViewFlags;
    for (let i = 0; i < n; i++) {
      view[i] = this.nodeInView(i, marginX, marginY) ? 1 : 0;
    }
    return view;
  }

  /** Reusable per-node "projects inside the viewport" flags (see
   *  rebuildEdgeDrawIndex). */
  private nodeViewFlags: Uint8Array = new Uint8Array(0);
  /** Index entries currently submitted from edgeDrawIndex. */
  private edgeDrawCount = 0;
  /** Camera pose (projection + view matrices, viewport dims) at the last
   *  culled rebuildEdgeDrawIndex. The live-build append fast path may extend
   *  the index only while this pose is unchanged — otherwise the retained
   *  entries' in-view decisions would be stale vs a full rebuild. */
  private readonly lastCullProj = new Matrix4();
  private readonly lastCullView = new Matrix4();
  private lastCullW = -1;
  private lastCullH = -1;
  private lastCullValid = false;

  private snapshotEdgeCullCamera(cull: boolean): void {
    const cam = this.activeCamera;
    if (!cull || !cam) {
      this.lastCullValid = false;
      return;
    }
    this.lastCullProj.copy(cam.projectionMatrix);
    this.lastCullView.copy(cam.matrixWorldInverse);
    this.lastCullW = this.width;
    this.lastCullH = this.height;
    this.lastCullValid = true;
  }

  /** True while the projection nodeInView uses is exactly the one captured at
   *  the last culled rebuild — same matrices, same viewport. */
  private edgeCullCameraUnchanged(): boolean {
    const cam = this.activeCamera;
    return (
      this.lastCullValid &&
      cam !== null &&
      this.lastCullW === this.width &&
      this.lastCullH === this.height &&
      cam.projectionMatrix.equals(this.lastCullProj) &&
      cam.matrixWorldInverse.equals(this.lastCullView)
    );
  }

  /** Hide the edge layer for instant zoom/pan response, restoring it after the
   *  tier's settle delay (Grafana pattern — see PixiRenderer). */
  private hideEdgesForInteraction(): void {
    if (!this.bp.hideEdgesOnInteraction || !this.edgeLines) return;
    if (!this.edgesHiddenForInteraction) {
      this.edgeLines.visible = false;
      this.edgesHiddenForInteraction = true;
      this.requestRender();
    }
    if (this.interactionResumeTimer !== null) {
      clearTimeout(this.interactionResumeTimer);
    }
    this.interactionResumeTimer = setTimeout(() => {
      this.showEdgesAfterInteraction();
    }, this.bp.interactionSettleDelay);
  }

  private showEdgesAfterInteraction(): void {
    if (this.destroyed || !this.edgesHiddenForInteraction) return;
    this.edgesHiddenForInteraction = false;
    this.interactionResumeTimer = null;
    if (this.edgeLines) this.edgeLines.visible = true;
    this.updateEdgePositions();
    // The pan/zoom changed the viewport — recompute which edges are in view.
    if (this.bp.edgeViewportCulling) this.rebuildEdgeDrawIndex();
    this.requestRender();
  }

  /** Incremental append. For phase 1 we rebuild the point cloud wholesale —
   *  correct, and addData is only used during indexing growth. */
  async addData(
    newNodes: GraphNode[],
    newLinks: GraphLink[],
    positions: Map<string, { x: number; y: number }>,
    nodeColors: Map<string, string>,
    nodeSizes: Map<string, number>,
    linkColors: Map<string, string>,
  ): Promise<void> {
    if (this.destroyed) return;
    // Live-build: snapshot current rendered (eased) positions by id so they
    // survive the full setData() rebuild below.
    if (this.liveGrowActive) {
      const snap = new Map<string, [number, number, number]>();
      for (let i = 0; i < this.nodeArray.length; i++) {
        const i3 = i * 3;
        snap.set(this.nodeArray[i].id, [
          this.posArray[i3],
          this.posArray[i3 + 1],
          this.posArray[i3 + 2],
        ]);
      }
      this.liveGrowPrevPos = snap;
    }
    // Merge into existing graphNode/link lists, then rebuild.
    const mergedNodes = this.nodeArray.map((n) => n.graphNode);
    for (const gn of newNodes) {
      if (!this.nodes.has(gn.id)) mergedNodes.push(gn);
    }
    const mergedLinks = this.edges.map((e) => e.graphLink);
    for (const gl of newLinks) mergedLinks.push(gl);

    // Preserve current positions for existing nodes, and don't let the rebuild
    // snap the camera to a full-graph fit (skipAutoFit — see setData).
    const wasUserMoved = this.hasUserMovedCamera;
    await this.setData(
      mergedNodes,
      mergedLinks,
      positions,
      nodeColors,
      nodeSizes,
      linkColors,
      { skipAutoFit: true },
    );
    this.hasUserMovedCamera = wasUserMoved;
  }

  // ─── Position streaming ───────────────────────────────────────────

  /** Stride-3 Float64Array from the layout worker (x0,y0,z0,x1,y1,z1,...).
   *  z is 0 in 2D mode. */
  /** Open a fresh snapshot-interpolation window for a live build: record where
   *  every node currently IS (posArray) as the lerp start and measure the gap
   *  since the last post so the render loop can pace the lerp. No-op unless a
   *  live build is active. */
  private markLiveInterpPost(): void {
    if (!this.liveGrowActive && !this.postBuildSettle) return;
    const used = this.nodeArray.length * 3;
    if (this.layoutInterpPrev.length < used) return;
    this.layoutInterpPrev.set(this.posArray.subarray(0, used));
    const now = performance.now();
    const dt =
      this.layoutInterpStart > 0
        ? now - this.layoutInterpStart
        : LIVE_INTERP_DEFAULT_MS;
    this.layoutInterpDur =
      this.layoutInterpDur > 0
        ? this.layoutInterpDur * (1 - LIVE_INTERP_INTERVAL_EMA) +
          dt * LIVE_INTERP_INTERVAL_EMA
        : dt;
    this.layoutInterpStart = now;
    this.layoutInterpActive = true;
  }

  /** True when a post should feed the snapshot interpolator rather than being
   *  drawn raw: during the live build, OR during the post-build settle (as long
   *  as nothing else — a drag, ambient drift, or full settle — has taken over). */
  private interpTargetsPosts(): boolean {
    if (this.buildAnim !== null || this.liveGrowActive) return true;
    return (
      this.postBuildSettle &&
      !this.layoutSettled &&
      !this.ambientActive &&
      this.dragNodeIndex < 0
    );
  }

  /** Arm the snapshot interpolator for a layout REFLOW — a preset change
   *  reseeds the force layout, which then streams fresh positions as it
   *  reorganizes. Without this those throttled worker posts (~5–15Hz, scaled by
   *  node count) write posArray raw, so the nodes step between posts while the
   *  camera eases smoothly — the visible judder. This reuses the post-build
   *  settle path: posts feed layoutPos (the targets) and the render loop lerps
   *  posArray toward them every frame → 60fps motion. Cleared automatically when
   *  the worker settles (setLayoutSettled) or a drag / build takes over.
   *
   *  Sets layoutSettled/ambientActive false up-front (mirroring the
   *  setLayoutSettled(false) that the simRunning effect fires a beat later) so
   *  the very first post is already interpolated rather than racing that effect. */
  beginLayoutReflow(): void {
    if (this.nodeArray.length === 0) return;
    // A live build owns node motion with its own easing; don't fight it.
    if (this.liveGrowActive || this.buildAnim !== null) return;
    this.layoutSettled = false;
    this.ambientActive = false;
    this.postBuildSettle = true;
    this.layoutInterpStart = 0;
    this.layoutInterpDur = 0;
    this.layoutInterpActive = false;
    this.requestRender();
  }

  updatePositionsFromBuffer(buffer: Float64Array): void {
    const len = Math.min(this.nodeArray.length, Math.floor(buffer.length / 3));
    // During a build/live-build/post-build settle the layout streams into
    // layoutPos (the interpolation targets) and the render loop writes the eased
    // posArray itself. Otherwise it writes posArray directly.
    const toTargets = this.interpTargetsPosts();
    if (toTargets) this.markLiveInterpPost();
    const pos = toTargets ? this.layoutPos : this.posArray;
    for (let i = 0; i < len; i++) {
      const o = i * 3;
      const x = buffer[o];
      const y = buffer[o + 1];
      const z = buffer[o + 2];
      // A degenerate force step (coincident nodes → zero-distance repulsion)
      // can emit NaN; writing it into the bound attribute vanishes the point
      // and poisons the fit/bounds math. Keep the node's last good position.
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        continue;
      }
      pos[o] = x;
      pos[o + 1] = y;
      pos[o + 2] = z;
    }
    if (toTargets) this.requestRender();
    else this.markPositionsDirty();
  }

  updatePositions(positions: Map<string, { x: number; y: number }>): void {
    const toTargets = this.interpTargetsPosts();
    if (toTargets) this.markLiveInterpPost();
    const pos = toTargets ? this.layoutPos : this.posArray;
    for (const [id, p] of positions) {
      const i = this.nodeIdToIndex.get(id);
      if (i === undefined) continue;
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
    }
    if (toTargets) this.requestRender();
    else this.markPositionsDirty();
  }

  private markPositionsDirty(): void {
    this.centroidsDirty = true;
    this.requestRender();
    if (this.nodeGeometry) {
      (
        this.nodeGeometry.getAttribute('position') as BufferAttribute
      ).needsUpdate = true;
    }
    // Throttled edge-endpoint refresh (mirrors PixiRenderer's edge throttle).
    // Skip entirely when the layout has settled and the tier alpha-gates edges.
    if (this.edgeLines && !this.edgesHiddenForInteraction) {
      const skipForSettle =
        this.bp.edgeAlphaGate && this.layoutSettled && !this.ambientActive;
      const now = performance.now();
      if (
        !skipForSettle &&
        now - this.lastEdgeRedraw >= this.bp.edgeRedrawInterval
      ) {
        this.updateEdgePositions();
      }
    }
  }

  // ─── Camera ───────────────────────────────────────────────────────

  private computeFitTarget(): { x: number; y: number; zoom: number } | null {
    if (this.nodeArray.length === 0) return null;
    const positions: { x: number; y: number }[] = [];
    for (let i = 0; i < this.nodeArray.length; i++) {
      if (!this.nodeArray[i].visible) continue;
      positions.push({ x: this.posArray[i * 3], y: this.posArray[i * 3 + 1] });
    }
    if (positions.length === 0) return null;
    const b = computeBounds(positions);
    const pad = 80;
    const bw = b.maxX - b.minX || 1;
    const bh = b.maxY - b.minY || 1;
    const zoom = Math.min(
      (this.width - pad * 2) / bw,
      (this.height - pad * 2) / bh,
    );
    const fitZoom = Math.max(zoom, 0.00001);
    this.lastFitZoom = fitZoom;
    return {
      x: (b.minX + b.maxX) / 2,
      y: (b.minY + b.maxY) / 2,
      zoom: fitZoom,
    };
  }

  /** Global edge-opacity multiplier driven by zoom (the readability fix for
   *  the 2D hairball). At the overview edges are faint so clusters/nodes read
   *  clearly; as the user zooms into a region (fewer edges on screen) they
   *  become opaque enough to trace. Hot (highlight/traversal) edges bypass
   *  this entirely via the shader's absolute-alpha encoding — see
   *  updateEdgeAlpha — so a highlight no longer lifts the whole edge layer
   *  (which used to flash every edge on Planet/Onion where the preset keeps
   *  edges faint or off). */
  private edgeOpacity(): number {
    return this.edgeBaseOpacity() * this.edgeOpacityMultiplier;
  }

  /** The zoom-driven base opacity, before the user multiplier. */
  private edgeBaseOpacity(): number {
    if (this.mode3d) return 0.85;
    // Ratio of current zoom to the whole-graph fit zoom: 1 = full overview.
    const ratio = (this.camera?.zoom ?? 1) / Math.max(this.lastFitZoom, 1e-6);
    // Overview floor: a force hairball reads better with a barely-there web,
    // but the radial TREE is its spokes — fading them to 0.12 turned the
    // organized layout into an apparent random scatter. Keep the skeleton
    // visible at the fit.
    const MIN = this.currentLayoutMode === 'tree' ? 0.5 : 0.12;
    const MAX = 0.85; // zoomed into a region — readable
    // Reach MAX once zoomed ~6× past the overview fit.
    const t = Math.min(1, Math.max(0, (ratio - 1) / 5));
    return MIN + (MAX - MIN) * t;
  }

  /** User-adjustable edge visibility (Physics panel "Edge opacity" slider).
   *  Multiplies the zoom-driven base for normal edges; also scales the
   *  absolute-alpha HOT (highlighted) edges via uHotOpacity so the slider
   *  controls the selected node's edges too. 1.0 = default behavior. */
  setEdgeOpacity(multiplier: number): void {
    this.edgeOpacityMultiplier = Math.max(0, Math.min(2, multiplier));
    const hot = this.edgeOpacityMultiplier;
    if (this.edgeMaterial) this.edgeMaterial.uniforms.uHotOpacity.value = hot;
    if (this.superEdgeMaterial)
      this.superEdgeMaterial.uniforms.uHotOpacity.value = hot;
    if (this.curvedEdgeMaterial)
      (
        this.curvedEdgeMaterial
          .uniforms as unknown as CurvedEdgeMaterialUniforms
      ).uHotOpacity.value = hot;
    this.requestRender();
  }
  private edgeOpacityMultiplier = 1;

  zoomToFit(duration = 300): void {
    if (this.mode3d) {
      const b = this.computeBounds3D();
      // Don't reframe off collapsed bounds (mid data-swap / reseed) — it would
      // plant the camera inside the graph. Skip; a later call reframes cleanly.
      if (this.bounds3DCollapsed(b.radius)) return;
      this.reframe3D(b);
      return;
    }
    const target = this.computeFitTarget();
    if (!target || !this.camera) return;
    this.autoFitTarget = null;
    this.requestRender();
    if (duration <= 0) {
      this.camera.position.x = target.x;
      this.camera.position.y = target.y;
      this.camera.zoom = target.zoom;
      this.camera.updateProjectionMatrix();
      return;
    }
    this.startCamAnim(target, duration);
  }

  scheduleAutoFit(_duration = 200): void {
    if (this.mode3d) return; // OrbitControls owns the camera in 3D
    if (this.hasUserMovedCamera || this.autoFitSuspended) return;
    if (this.camAnim) return;
    const target = this.computeFitTarget();
    if (target) {
      this.autoFitTarget = target;
      this.requestRender();
    }
  }

  setAutoFitSuspended(suspended: boolean): void {
    this.autoFitSuspended = suspended;
    if (suspended) this.autoFitTarget = null;
  }

  setHasUserMovedCamera(moved: boolean): void {
    this.hasUserMovedCamera = moved;
    if (moved) this.autoFitTarget = null;
  }

  zoomToNodes(nodeIds: Iterable<string>, duration = 300): void {
    if (this.mode3d) {
      let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
      let found = false;
      for (const id of nodeIds) {
        const i = this.nodeIdToIndex.get(id);
        if (i === undefined || !this.nodeArray[i].visible) continue;
        found = true;
        const x = this.posArray[i * 3];
        const y = this.posArray[i * 3 + 1];
        const z = this.posArray[i * 3 + 2];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      if (!found) return;
      const center = new Vector3(
        (minX + maxX) / 2,
        (minY + maxY) / 2,
        (minZ + maxZ) / 2,
      );
      // Min-span floor so focusing one node doesn't slam the camera in.
      const full = this.computeBounds3D().radius;
      const radius = Math.max(
        0.5 * Math.max(maxX - minX, maxY - minY, maxZ - minZ),
        full / 6,
        10,
      );
      this.reframe3D({ center, radius });
      return;
    }
    const positions: { x: number; y: number }[] = [];
    let maxSize = 0;
    for (const id of nodeIds) {
      const i = this.nodeIdToIndex.get(id);
      if (i === undefined || !this.nodeArray[i].visible) continue;
      maxSize = Math.max(maxSize, this.nodeArray[i].size);
      positions.push({ x: this.posArray[i * 3], y: this.posArray[i * 3 + 1] });
    }
    if (positions.length === 0 || !this.camera) return;
    const b = computeBounds(positions);

    // Full-graph extent for the min-span floor (mirrors PixiRenderer).
    let allMinX = Infinity,
      allMaxX = -Infinity,
      allMinY = Infinity,
      allMaxY = -Infinity;
    for (let i = 0; i < this.nodeArray.length; i++) {
      if (!this.nodeArray[i].visible) continue;
      const x = this.posArray[i * 3];
      const y = this.posArray[i * 3 + 1];
      if (x < allMinX) allMinX = x;
      if (x > allMaxX) allMaxX = x;
      if (y < allMinY) allMinY = y;
      if (y > allMaxY) allMaxY = y;
    }
    const fullSpan = Math.max(allMaxX - allMinX, allMaxY - allMinY, 0);
    const minSpan = Math.max(maxSize * 24, fullSpan / 6, 1);
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    let bw = b.maxX - b.minX;
    let bh = b.maxY - b.minY;
    if (bw < minSpan) bw = minSpan;
    if (bh < minSpan) bh = minSpan;
    const pad = 120;
    const zoom = Math.min(
      (this.width - pad * 2) / (bw || 1),
      (this.height - pad * 2) / (bh || 1),
    );

    this.hasUserMovedCamera = true;
    this.startCamAnim(
      { x: cx, y: cy, zoom: Math.max(zoom, 0.00001) },
      duration,
    );
  }

  zoomIn(duration = 200): void {
    this.zoomByFactor(1.5, duration);
  }

  zoomOut(duration = 200): void {
    this.zoomByFactor(1 / 1.5, duration);
  }

  /** Index of the currently selected node if it's present and visible. */
  private selectedNodeIndex(): number {
    if (this.selectedNodeId === null) return -1;
    const i = this.nodeIdToIndex.get(this.selectedNodeId);
    if (i === undefined || !this.nodeArray[i].visible) return -1;
    return i;
  }

  private zoomByFactor(factor: number, duration: number): void {
    const sel = this.selectedNodeIndex();

    if (this.mode3d && this.controls && this.perspCamera) {
      // Zoom toward the selected node (re-aim the orbit target at it), else
      // toward the current target.
      if (sel >= 0) {
        this.controls.target.set(
          this.posArray[sel * 3],
          this.posArray[sel * 3 + 1],
          this.posArray[sel * 3 + 2],
        );
      }
      const offset = new Vector3().subVectors(
        this.perspCamera.position,
        this.controls.target,
      );
      offset.multiplyScalar(1 / factor); // factor>1 (zoomIn) → move closer
      this.perspCamera.position.copy(this.controls.target).add(offset);
      this.controls.update();
      this.requestRender();
      return;
    }
    if (!this.camera) return;
    this.hasUserMovedCamera = true;
    this.autoFitTarget = null;
    // Center on the selected node while zooming, else keep the current center.
    const cx = sel >= 0 ? this.posArray[sel * 3] : this.camera.position.x;
    const cy = sel >= 0 ? this.posArray[sel * 3 + 1] : this.camera.position.y;
    this.startCamAnim(
      { x: cx, y: cy, zoom: this.camera.zoom * factor },
      duration,
    );
  }

  /** Tell the renderer which node is selected so +/- zoom can target it. */
  setSelectedNode(id: string | null): void {
    this.selectedNodeId = id;
  }

  resetCamera(duration = 300): void {
    this.hasUserMovedCamera = false;
    this.zoomToFit(duration);
  }

  private startCamAnim(
    to: { x: number; y: number; zoom: number },
    duration: number,
  ): void {
    if (!this.camera) return;
    this.requestRender();
    if (duration <= 0) {
      this.camera.position.x = to.x;
      this.camera.position.y = to.y;
      this.camera.zoom = to.zoom;
      this.camera.updateProjectionMatrix();
      return;
    }
    this.camAnim = {
      from: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        zoom: this.camera.zoom,
      },
      to,
      start: performance.now(),
      duration,
    };
  }

  /** Screen (canvas px) → world coordinates via the ortho camera. */
  private screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const cam = this.camera;
    if (!cam) return { x: 0, y: 0 };
    const ndcX = (sx / this.width) * 2 - 1;
    const ndcY = -((sy / this.height) * 2 - 1);
    this.tmpVec.set(ndcX, ndcY, 0).unproject(cam);
    return { x: this.tmpVec.x, y: this.tmpVec.y };
  }

  // ─── Picking ──────────────────────────────────────────────────────

  /** GPU color-pick: render node + super-node ids to the offscreen target and
   *  read the one pixel under the cursor. Returns the encoded hit:
   *    >= 0      → node index
   *    <= -2     → super-node index (= -ret - 2)
   *    -1        → miss
   *  O(1) per call regardless of node count. */
  private pickNodeIndexAt(screenX: number, screenY: number): number {
    const renderer = this.renderer;
    const cam = this.activeCamera;
    const points = this.nodePoints;
    if (
      !renderer ||
      !cam ||
      !points ||
      !this.pickingMaterial ||
      !this.pickTarget
    )
      return -1;

    // Sync sizing uniforms with the display material.
    const pu = this.pickingMaterial.uniforms;
    if (this.mode3d) {
      pu.uPerspective.value = 1;
      pu.uZoom.value = this.height / (2 * Math.tan((this.fov * Math.PI) / 360));
    } else {
      pu.uPerspective.value = 0;
      // Match the display material's smoothed fit-normalized 2D zoom so the pick
      // disc tracks the rendered node size.
      const sizeRef = this.sizeFitRef > 0 ? this.sizeFitRef : this.lastFitZoom;
      pu.uZoom.value = cam.zoom / Math.max(sizeRef, 1e-6);
    }
    pu.uSizeExp.value = this.zoomSizeExponent;

    // Swap every pickable Points to the picking material; hide the line layers
    // (they'd write garbage colors into the id buffer).
    const prevNodeMat = points.material;
    const prevSuperMat = this.superNodePoints?.material;
    const edgeWasVisible = this.edgeLines?.visible ?? false;
    const superEdgeWasVisible = this.superEdgeLines?.visible ?? false;
    const haloWasVisible = this.nodeHaloPoints?.visible ?? false;
    const curvedWasVisible = this.curvedEdgeObject?.visible ?? false;
    const hotWasVisible = this.hotEdgeMesh?.visible ?? false;
    const fgWasVisible = this.fgNodePoints?.visible ?? false;
    points.material = this.pickingMaterial;
    if (this.superNodePoints)
      this.superNodePoints.material = this.pickingMaterial;
    if (this.edgeLines) this.edgeLines.visible = false;
    if (this.superEdgeLines) this.superEdgeLines.visible = false;
    // The halo overlay would write its glow colors into the id buffer; the
    // highlighted nodes are already pickable via the main pass's index.
    if (this.nodeHaloPoints) this.nodeHaloPoints.visible = false;
    // Same for the curved bulk edges + hot-edge glow ribbon: an edge passing
    // over a node would otherwise blend its colour into the id pixel and
    // corrupt the pick (the "click does nothing" bug).
    if (this.curvedEdgeObject) this.curvedEdgeObject.visible = false;
    if (this.hotEdgeMesh) this.hotEdgeMesh.visible = false;
    // The fg cores would write node display colours into the id buffer.
    if (this.fgNodePoints) this.fgNodePoints.visible = false;

    const dpr = renderer.getPixelRatio();
    const buf = renderer.getDrawingBufferSize(this.tmpVec2);
    const px = Math.floor(screenX * dpr);
    // readRenderTargetPixels is bottom-up.
    const py = Math.floor(buf.y - screenY * dpr);

    // Scissor the pick render to the single pixel we read back: only that
    // pixel is cleared + rasterized (the scissor test clips fragments, not
    // primitives, so a point whose quad overlaps the pixel still writes it —
    // the read value is identical to a full-target render). The rect is in
    // target device pixels, bottom-up, exactly like readRenderTargetPixels —
    // px/py above already include the pixel ratio. Render-target scissor
    // state lives ON the target (three applies it in setRenderTarget), so it
    // can't leak into the on-screen pass; cleared after the read anyway.
    this.pickTarget.scissor.set(px, py, 1, 1);
    this.pickTarget.scissorTest = true;
    renderer.setRenderTarget(this.pickTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(this.scene!, cam);
    renderer.readRenderTargetPixels(
      this.pickTarget,
      px,
      py,
      1,
      1,
      this.pickPixel,
    );
    renderer.setRenderTarget(null);
    this.pickTarget.scissorTest = false;

    // Restore display state + cached theme clear color.
    points.material = prevNodeMat;
    if (this.superNodePoints && prevSuperMat)
      this.superNodePoints.material = prevSuperMat;
    if (this.edgeLines) this.edgeLines.visible = edgeWasVisible;
    if (this.superEdgeLines) this.superEdgeLines.visible = superEdgeWasVisible;
    if (this.nodeHaloPoints) this.nodeHaloPoints.visible = haloWasVisible;
    if (this.curvedEdgeObject) this.curvedEdgeObject.visible = curvedWasVisible;
    if (this.hotEdgeMesh) this.hotEdgeMesh.visible = hotWasVisible;
    if (this.fgNodePoints) this.fgNodePoints.visible = fgWasVisible;
    renderer.setClearColor(this.bgColor, 1);

    const id =
      this.pickPixel[0] + this.pickPixel[1] * 256 + this.pickPixel[2] * 65536;
    if (id <= 0) return -1;
    if (id > SUPER_PICK_OFFSET) return -(id - SUPER_PICK_OFFSET - 1) - 2;
    return id - 1;
  }

  // ─── Interaction (pan / wheel / pick / drag) ──────────────────────

  setCallbacks(callbacks: InteractionCallbacks): void {
    this.callbacks = callbacks;
  }

  private setupInteraction(
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): void {
    // Suppress native touch gestures (scroll/double-tap-zoom) so pointer
    // events arrive uninterrupted — the app CSS sets this on the viewport,
    // but the renderer shouldn't depend on its host container for that.
    canvas.style.touchAction = 'none';
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.mode3d) return; // OrbitControls dollies in 3D
        e.preventDefault();
        const cam = this.camera;
        if (!cam) return;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const before = this.screenToWorld(mx, my);
        const factor = Math.pow(0.999, e.deltaY);
        cam.zoom = Math.max(cam.zoom * factor, 0.00001);
        cam.updateProjectionMatrix();
        const after = this.screenToWorld(mx, my);
        cam.position.x += before.x - after.x;
        cam.position.y += before.y - after.y;
        cam.updateProjectionMatrix();
        this.hasUserMovedCamera = true;
        this.autoFitTarget = null;
        this.camAnim = null;
        this.requestRender();
        this.hideEdgesForInteraction();
      },
      { passive: false, signal },
    );

    let pointerDown = false;
    let button = 0;
    let moved = 0;
    let downPos: { x: number; y: number } | null = null;
    let lastX = 0;
    let lastY = 0;
    // Multi-touch state for 2D pinch-zoom / two-finger pan. (In 3D,
    // OrbitControls owns touch gestures, so the pinch path never engages.)
    const activePointers = new Map<number, { x: number; y: number }>();
    let primaryPointerId: number | null = null;
    let pinch: { dist: number; mx: number; my: number } | null = null;
    let pinchedThisGesture = false;

    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), {
      signal,
    });

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (!this.mode3d && activePointers.size === 2) {
          // Second finger down → the gesture becomes a pinch. Abort any
          // in-progress node drag and suppress the click on release.
          const [a, b] = [...activePointers.values()];
          pinch = {
            dist: Math.hypot(b.x - a.x, b.y - a.y),
            mx: (a.x + b.x) / 2,
            my: (a.y + b.y) / 2,
          };
          pinchedThisGesture = true;
          // Two fingers down → there's no meaningful "cursor" to freeze around.
          this.cursorScreen = null;
          if (this.dragNodeIndex >= 0) {
            this.callbacks.onNodeDragEnd?.(
              this.nodeArray[this.dragNodeIndex].id,
            );
            this.dragNodeIndex = -1;
            canvas.style.cursor = 'default';
          }
          this.pendingDragIndex = -1;
          return;
        }
        if (activePointers.size > 1) return; // 3rd+ finger: ignore
        primaryPointerId = e.pointerId;
        pinchedThisGesture = false;
        pointerDown = true;
        // A press ends the hover affordance (tooltip/growth) until the next
        // hover pick after release.
        this.setHoveredNode(-1, 0, 0);
        button = e.button;
        moved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
        downPos = { x: e.clientX, y: e.clientY };
        this.pendingDragIndex = -1;
        this.dragNodeIndex = -1;
        // 3D left-drag rotates the graph about its center — snapshot the
        // pivot now so layout ticks mid-drag can't wobble it.
        if (e.button === 0 && this.mode3d) {
          this.rotatePivot =
            this.nodeArray.length > 0 ? this.computeBounds3D().center : null;
        }
        // Node drag is a 2D affordance; in 3D left-drag rotates.
        if (e.button === 0 && !this.mode3d) {
          const rect = canvas.getBoundingClientRect();
          const idx = this.pickNodeIndexAt(
            e.clientX - rect.left,
            e.clientY - rect.top,
          );
          // Only real nodes are draggable (not aggregate super-nodes).
          this.pendingDragIndex = idx >= 0 ? idx : -1;
        }
      },
      { signal },
    );

    let lastHover = 0;
    canvas.addEventListener(
      'pointermove',
      (e) => {
        const tracked = activePointers.get(e.pointerId);
        if (tracked) {
          tracked.x = e.clientX;
          tracked.y = e.clientY;
        }

        // Pinch: zoom about the finger midpoint + pan with it (2D only).
        if (pinch && !this.mode3d && activePointers.size >= 2) {
          const cam = this.camera;
          if (!cam) return;
          const [a, b] = [...activePointers.values()];
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const prect = canvas.getBoundingClientRect();
          const cx = mx - prect.left;
          const cy = my - prect.top;
          // Same anchored-zoom math as the wheel handler.
          const before = this.screenToWorld(cx, cy);
          const factor = pinch.dist > 0 ? dist / pinch.dist : 1;
          cam.zoom = Math.max(cam.zoom * factor, 0.00001);
          cam.updateProjectionMatrix();
          const after = this.screenToWorld(cx, cy);
          cam.position.x += before.x - after.x;
          cam.position.y += before.y - after.y;
          // Two-finger pan: the world point under the midpoint follows it.
          cam.position.x -= (mx - pinch.mx) / cam.zoom;
          cam.position.y += (my - pinch.my) / cam.zoom;
          cam.updateProjectionMatrix();
          pinch = { dist, mx, my };
          this.hasUserMovedCamera = true;
          this.autoFitTarget = null;
          this.camAnim = null;
          this.requestRender();
          this.hideEdgesForInteraction();
          return;
        }

        // Only the first-placed pointer pans/drags — a stray second finger
        // (e.g. in 3D, where OrbitControls owns it) must not yank lastX/lastY.
        if (primaryPointerId !== null && e.pointerId !== primaryPointerId) {
          return;
        }

        const rect = canvas.getBoundingClientRect();
        // Feed the ambient cursor-freeze zone (converted to world per frame in
        // updateAmbient, so pan/zoom between move events can't stale it).
        this.cursorScreen = {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        };
        // Hover cursor (only when not dragging/panning) — throttled.
        if (!pointerDown) {
          const now = performance.now();
          if (now - lastHover < 50) return;
          lastHover = now;
          const hx = e.clientX - rect.left;
          const hy = e.clientY - rect.top;
          const idx = this.pickNodeIndexAt(hx, hy);
          // Real nodes grow on hover (+ host tooltip); super-nodes don't.
          this.setHoveredNode(idx >= 0 ? idx : -1, hx, hy);
          // Only nodes (and super-nodes) are clickable — edges are not, so the
          // pointer cursor appears over nodes only (a pointer over an edge used
          // to imply a click that now does nothing).
          canvas.style.cursor = idx !== -1 ? 'pointer' : 'default';
          return;
        }

        if (!downPos || !this.camera) return;
        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        moved = Math.sqrt(dx * dx + dy * dy);

        // 3D: OrbitControls handles pan (right-drag) and dolly (wheel/pinch),
        // but LEFT-DRAG rotation is ours — it spins the GRAPH around its own
        // center rather than orbiting the (possibly panned-away) target, so
        // panning the graph off-center never changes the rotation pivot.
        if (this.mode3d) {
          // Left-drag / one-finger rotates the graph. But two fingers are a
          // pan+zoom gesture that OrbitControls owns — rotating on the primary
          // finger too would move AND spin at once, so only rotate with a
          // single active pointer.
          if (
            button === 0 &&
            moved > CLICK_THRESHOLD &&
            activePointers.size < 2
          ) {
            this.rotateGraphBy(e.clientX - lastX, e.clientY - lastY);
          }
          lastX = e.clientX;
          lastY = e.clientY;
          return;
        }

        if (moved > CLICK_THRESHOLD) {
          this.hasUserMovedCamera = true;
          this.camAnim = null;

          if (this.pendingDragIndex >= 0 && this.dragNodeIndex < 0) {
            this.dragNodeIndex = this.pendingDragIndex;
            this.pendingDragIndex = -1;
            canvas.style.cursor = 'grabbing';
            this.callbacks.onNodeDragStart?.(
              this.nodeArray[this.dragNodeIndex].id,
            );
          }

          if (this.dragNodeIndex >= 0) {
            // Drag the node: update local position + edges immediately, and
            // pin it in the worker via the move callback.
            const w = this.screenToWorld(
              e.clientX - rect.left,
              e.clientY - rect.top,
            );
            const i = this.dragNodeIndex;
            this.posArray[i * 3] = w.x;
            this.posArray[i * 3 + 1] = w.y;
            this.markPositionsDirty();
            this.updateEdgePositions();
            this.callbacks.onNodeDragMove?.(this.nodeArray[i].id, w.x, w.y);
          } else {
            // Pan.
            const panDx = e.clientX - lastX;
            const panDy = e.clientY - lastY;
            this.camera.position.x -= panDx / this.camera.zoom;
            this.camera.position.y += panDy / this.camera.zoom;
            this.camera.updateProjectionMatrix();
            this.requestRender();
            this.hideEdgesForInteraction();
          }
        }
        lastX = e.clientX;
        lastY = e.clientY;
      },
      { signal },
    );

    const onUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId);

      // A lifted finger or a departed mouse leaves no cursor to freeze around
      // (nor a node to hover); a mouse button release does (still hovering).
      if (
        e.type === 'pointerleave' ||
        e.type === 'pointercancel' ||
        e.pointerType === 'touch'
      ) {
        this.cursorScreen = null;
        this.setHoveredNode(-1, 0, 0);
      }

      if (pinch) {
        if (activePointers.size >= 2) {
          // A finger of a 3+-touch pinch lifted: rebase on the remaining two
          // so the zoom doesn't jump.
          const [a, b] = [...activePointers.values()];
          pinch = {
            dist: Math.hypot(b.x - a.x, b.y - a.y),
            mx: (a.x + b.x) / 2,
            my: (a.y + b.y) / 2,
          };
          return;
        }
        // Pinch over — hand off to a single-finger pan from the survivor,
        // rebasing the pan anchors so the camera doesn't jump.
        pinch = null;
        const rest = activePointers.entries().next().value as
          | [number, { x: number; y: number }]
          | undefined;
        if (rest) {
          primaryPointerId = rest[0];
          lastX = rest[1].x;
          lastY = rest[1].y;
          downPos = { x: rest[1].x, y: rest[1].y };
          return;
        }
      }
      // Ignore a secondary finger lifting; the gesture ends with the last one.
      if (activePointers.size > 0) return;

      primaryPointerId = null;
      if (!pointerDown) return;
      pointerDown = false;
      const rect = canvas.getBoundingClientRect();

      if (this.dragNodeIndex >= 0) {
        this.callbacks.onNodeDragEnd?.(this.nodeArray[this.dragNodeIndex].id);
        this.dragNodeIndex = -1;
        canvas.style.cursor = 'default';
      } else if (
        button === 0 &&
        moved <= CLICK_THRESHOLD &&
        !pinchedThisGesture
      ) {
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const idx = this.pickNodeIndexAt(sx, sy);
        if (idx <= -2) {
          // Aggregate super-node clicked → zoom into its community, which
          // expands it into member nodes on the next LOD pass.
          const superIndex = -idx - 2;
          if (this.mode3d && this.mode3dAutoRotate) this.set3DAutoRotate(false);
          this.zoomToNodes(this.superNodeMembers(superIndex), 400);
        } else if (idx >= 0) {
          // Selecting a node pauses 3D auto-rotation (mirrors Pixi) so edges
          // stay glued to the highlighted node.
          if (this.mode3d && this.mode3dAutoRotate) this.set3DAutoRotate(false);
          this.callbacks.onNodeClick?.(this.nodeArray[idx].graphNode);
        } else {
          // Edges are NOT clickable — only nodes. Near a high-degree node the
          // dense edges used to steal the click and select a relationship
          // instead of the node, which read as a bug; a click that misses a
          // node now just dismisses the current selection.
          // Deliberately does NOT restart 3D auto-rotation: a click in the void
          // is how users dismiss a selection, and having the scene start
          // spinning on it read as a bug.
          this.callbacks.onStageClick?.();
        }
      }
      this.pendingDragIndex = -1;
      downPos = null;
    };
    canvas.addEventListener('pointerup', onUp, { signal });
    canvas.addEventListener('pointerleave', onUp, { signal });
    // iOS Safari cancels pointers when the OS takes over a gesture — treat it
    // as a lift so pinch/pan state can't get stuck.
    canvas.addEventListener('pointercancel', onUp, { signal });
  }

  /** Pivot for the current 3D rotate gesture — the graph's own center,
   *  captured at pointer-down so a mid-drag layout tick can't wobble it. */
  private rotatePivot: Vector3 | null = null;

  /** 3D left-drag: rotate the GRAPH about its own center — camera and orbit
   *  target swing together around the pivot, so a prior pan (which offsets
   *  the target) never becomes the rotation axis. Replaces OrbitControls'
   *  rotate (enableRotate=false), which always orbits the target. */
  private rotateGraphBy(dxPx: number, dyPx: number): void {
    const cam = this.perspCamera;
    const controls = this.controls;
    if (!cam || !controls || (dxPx === 0 && dyPx === 0)) return;
    const pivot =
      this.rotatePivot ??
      (this.nodeArray.length > 0 ? this.computeBounds3D().center : null);
    if (!pivot) return;

    // Manual rotation = user camera takeover. (The controls 'start' hook
    // that normally sets this no longer fires for rotation.)
    this.hasUserMovedCamera = true;
    this.autoFitTarget = null;
    if (this.mode3dAutoRotate) this.set3DAutoRotate(false, true);

    const ROT_SPEED = 0.005; // rad per dragged px, ≈ OrbitControls' feel
    const yawAngle = -dxPx * ROT_SPEED;
    const pitchAngle = -dyPx * ROT_SPEED;

    const up = cam.up;
    const camOff = cam.position.clone().sub(pivot);
    const qYaw = new Quaternion().setFromAxisAngle(up, yawAngle);
    const right = new Vector3().setFromMatrixColumn(cam.matrix, 0).normalize();
    const qPitch = new Quaternion().setFromAxisAngle(right, pitchAngle);
    // Drop the pitch component when it would carry the camera over a pole
    // (lookAt degenerates there) — yaw alone still applies.
    const POLE_EPS = 0.08;
    const pitched = camOff.clone().applyQuaternion(qPitch);
    const polar = pitched.angleTo(up);
    const q =
      polar > POLE_EPS && polar < Math.PI - POLE_EPS
        ? qYaw.multiply(qPitch)
        : qYaw;

    cam.position.copy(camOff.applyQuaternion(q).add(pivot));
    controls.target.sub(pivot).applyQuaternion(q).add(pivot);
    controls.update();
    this.requestRender();
    this.hideEdgesForInteraction();
  }

  /** Mark `idx` as the hovered node (grow it via NODE_STATE_HOVERED) and tell
   *  the host. -1 clears. Cheap: flips one state bit per change, no O(n). */
  private setHoveredNode(idx: number, sx: number, sy: number): void {
    if (idx === this.hoveredNodeIndex) return;
    const st = this.stateArray;
    const prev = this.hoveredNodeIndex;
    if (prev >= 0 && prev < this.nodeArray.length) {
      st[prev] = Number(st[prev]) & ~NODE_STATE_HOVERED;
    }
    this.hoveredNodeIndex = idx;
    if (idx >= 0 && idx < this.nodeArray.length) {
      st[idx] = Number(st[idx]) | NODE_STATE_HOVERED;
    }
    if (this.nodeGeometry) {
      (
        this.nodeGeometry.getAttribute('aState') as BufferAttribute
      ).needsUpdate = true;
    }
    this.requestRender();
    this.callbacks.onNodeHover?.(
      idx >= 0 && idx < this.nodeArray.length
        ? this.nodeArray[idx].graphNode
        : null,
      sx,
      sy,
    );
  }

  // ─── Visual state (filled across later phases) ────────────────────

  setHighlight(highlightNodes: Set<string>, highlightLinks: Set<string>): void {
    this.highlightNodes = highlightNodes;
    this.highlightLinks = highlightLinks;
    this.hasHighlight = this.computeHasHighlight();
    this.applyNodeStates();
    this.updateEdgeAlpha();
    this.runNodeLabelCull();
  }

  /** A highlight is active when search/selection/chat lit any node OR the chat
   *  traversal has reached any node — both dim the rest of the graph. */
  private computeHasHighlight(): boolean {
    return this.highlightNodes.size > 0 || this.traversalLitNodes.size > 0;
  }

  /** True while a chat walk exists — animating, queued, or its lit trail
   *  still on screen. While active, hotness comes ONLY from the traversal
   *  sets: the app-side chat highlight pre-marks the whole result
   *  neighborhood (every node + every edge between result nodes, in their
   *  raw label colors), which would pop in at once and clog the walk. Ends on
   *  clearTraversal (next question / highlights off) or a data reload. */
  private traversalActive(): boolean {
    return (
      this.traversalAnim !== null ||
      this.traversalLitNodes.size > 0 ||
      this.traversalLitEdges.size > 0 ||
      this.traversalPendingEdges.size > 0
    );
  }

  /** True if a node is "hot" — directly highlighted or reached by traversal.
   *  During a walk, only nodes the traversal actually reached count, so each
   *  node lights up when its edge finishes building, not when the app's
   *  highlight lands. */
  private nodeIsHot(id: string): boolean {
    if (this.traversalActive()) return this.traversalLitNodes.has(id);
    return this.highlightNodes.has(id) || this.traversalLitNodes.has(id);
  }

  /** True if an edge is "hot" — highlighted or crossed by the traversal.
   *  During a walk, only built edges count (see traversalActive). */
  private edgeIsHot(key: string): boolean {
    if (this.traversalActive()) return this.traversalLitEdges.has(key);
    return this.highlightLinks.has(key) || this.traversalLitEdges.has(key);
  }

  /** Repack the per-node `aState` attribute from current visibility +
   *  highlight, then flag it for GPU upload. O(n) but only on state change,
   *  never per frame — the shader does the per-frame sizing/dimming. */
  private applyNodeStates(): void {
    if (!this.nodeGeometry) return;
    const st = this.stateArray;
    const lod = this.lodEnabled && this.superList.length > 0;
    const lodVis = lod ? this.computeLodVisFlags() : null;
    // `<` (not `!==`): the append fast path grows these with capacity
    // headroom; entries past the draw count are never submitted.
    if (this.nodeDrawIndex.length < this.nodeArray.length) {
      this.nodeDrawIndex = new Uint32Array(this.nodeArray.length);
    }
    if (this.nodeHaloDrawIndex.length < this.nodeArray.length) {
      this.nodeHaloDrawIndex = new Uint32Array(this.nodeArray.length);
    }
    const drawIdx = this.nodeDrawIndex;
    const haloIdx = this.nodeHaloDrawIndex;
    let dc = 0;
    let hc = 0;
    for (let i = 0; i < this.nodeArray.length; i++) {
      const node = this.nodeArray[i];
      // Under LOD, a node only draws when its community is expanded — except
      // highlighted nodes, which always show so search/chat focus survives.
      const highlighted = this.hasHighlight && this.nodeIsHot(node.id);
      const visible =
        node.visible && (lodVis === null || highlighted || lodVis[i] === 1);
      let s = visible ? NODE_STATE_VISIBLE : 0;
      if (this.hasHighlight && visible) {
        s |= this.nodeIsHot(node.id)
          ? NODE_STATE_HIGHLIGHTED
          : NODE_STATE_DIMMED;
      }
      // Repacking must not drop the transient hover bit mid-hover.
      if (i === this.hoveredNodeIndex) s |= NODE_STATE_HOVERED;
      st[i] = s;
      if (visible) drawIdx[dc++] = i;
      // Highlighted nodes also draw in the halo overlay pass (soft glow over
      // edges, no depth write — see buildNodePoints).
      if (visible && highlighted) haloIdx[hc++] = i;
    }
    (this.nodeGeometry.getAttribute('aState') as BufferAttribute).needsUpdate =
      true;
    // Only submit the visible nodes to the GPU.
    this.nodeDrawCount = dc;
    this.nodeDrawIndexValid = true;
    this.setGeometryDrawIndex(this.nodeGeometry, drawIdx, dc);
    if (this.nodeHaloGeometry) {
      this.setGeometryDrawIndex(this.nodeHaloGeometry, haloIdx, hc);
    }
    this.requestRender();
  }

  /** Entries in nodeDrawIndex currently submitted (the array may hold spare
   *  capacity past this count). Read by the incremental-append fast path to
   *  extend the draw index in place. */
  private nodeDrawCount = 0;
  /** True once applyNodeStates has installed the draw index on the CURRENT
   *  node geometry. A fresh geometry (buildNodePoints) starts index-less
   *  (drawRange covers the raw vertices), so the append fast path must run a
   *  full repack first rather than extend an index that isn't there. */
  private nodeDrawIndexValid = false;

  /** Point/segment index + draw-range so the GPU processes only `count`
   *  vertices from `idx`, instead of the whole buffer. */
  private setGeometryDrawIndex(
    geo: BufferGeometry,
    idx: Uint32Array,
    count: number,
  ): void {
    const existing = geo.getIndex();
    if (!existing || existing.array !== idx) {
      geo.setIndex(new BufferAttribute(idx, 1));
    }
    geo.getIndex()!.needsUpdate = true;
    geo.setDrawRange(0, count);
  }

  setNodeVisibility(visibleIds: Set<string>): void {
    let changed = false;
    let hidden = 0;
    for (const node of this.nodeArray) {
      const vis = visibleIds.has(node.id);
      if (node.visible !== vis) {
        node.visible = vis;
        changed = true;
      }
      if (!vis) hidden++;
    }
    if (!changed) return;
    this.hiddenNodeCount = hidden;
    this.centroidsDirty = true; // centroids average only visible nodes
    this.applyNodeStates();
    this.updateEdgeAlpha();
    this.runNodeLabelCull();
    this.communityVisibilityFrozen = false;
  }

  updateNodeColors(nodeColors: Map<string, string>): void {
    if (!this.nodeGeometry) return;
    let changed = false;
    for (const [id, color] of nodeColors) {
      const i = this.nodeIdToIndex.get(id);
      if (i === undefined) continue;
      const node = this.nodes.get(id);
      if (node) node.color = color;
      hexToRgb(color, this.tmpColor);
      this.colorArray[i * 3] = this.tmpColor.r;
      this.colorArray[i * 3 + 1] = this.tmpColor.g;
      this.colorArray[i * 3 + 2] = this.tmpColor.b;
      changed = true;
    }
    if (changed) {
      (
        this.nodeGeometry.getAttribute('aColor') as BufferAttribute
      ).needsUpdate = true;
      this.requestRender();
    }
  }

  updateLinkColors(linkColors: Map<string, string>): void {
    for (const edge of this.edges) {
      edge.color = linkColors.get(edge.label) ?? '#3b4048';
    }
    this.fillEdgeColors();
  }

  setThemeColors(): void {
    const themeColors = getGraphThemeColors();
    this.bgColor.set(themeColors.bg);
    this.renderer?.setClearColor(this.bgColor, 1);
    this.requestRender();
  }

  setShowAllLabels(show: boolean): void {
    this.showAllLabels = show;
    this.runNodeLabelCull();
  }

  setShowCommunityLabels(show: boolean): void {
    this.showCommunityLabels = show;
    if (this.communityLabelLayer && !show) {
      this.communityLabelLayer.style.display = 'none';
    }
    this.communityVisibilityFrozen = false;
    this.runNodeLabelCull(); // LOD handoff depends on this flag
  }

  setLayoutMode(mode: 'spread' | 'compact' | 'tree' | 'onion'): void {
    if (this.currentLayoutMode === mode) return;
    this.currentLayoutMode = mode;
    // Geometry changed — let the community cull re-decide.
    this.communityVisibilityFrozen = false;
    // Tree mode re-weights per-edge alpha (skeleton vs relational chords).
    this.updateEdgeAlpha();
  }

  setCommunityData(
    assignments: Record<string, number>,
    names: Map<number, string>,
    colorMap?: Map<number, string>,
  ): void {
    const fingerprint = [...names.values()].sort().join('\n');
    const sameNames = fingerprint === this.communityNamesFingerprint;
    this.communityAssignments = assignments;
    this.communityNames = names;
    this.communityColorMap = colorMap ?? null;
    // LOD super-graph depends on assignments/centroids — rebuild once settled.
    if (this.lodEnabled) {
      this.superGraphDirty = true;
      if (this.layoutSettled) this.maybeBuildSuperGraph();
    }
    if (sameNames && this.communityLabelEls.size > 0) {
      // Same names under (possibly) new IDs — keep the current label set and
      // visible decision; centroids re-track from the new assignments.
      return;
    }
    this.communityNamesFingerprint = fingerprint;
    this.rebuildCommunityLabels();
  }

  private rebuildCommunityLabels(): void {
    const layer = this.communityLabelLayer;
    if (!layer) return;
    for (const el of this.communityLabelEls.values()) el.remove();
    this.communityLabelEls.clear();
    this.communityMemberCount.clear();
    this.communityVisibilityFrozen = false;
    this.communityCentroids.clear();
    if (!this.communityAssignments || !this.communityNames) return;

    for (const cid of Object.values(this.communityAssignments)) {
      this.communityMemberCount.set(
        cid,
        (this.communityMemberCount.get(cid) ?? 0) + 1,
      );
    }

    const MIN_COMMUNITY_SIZE = 25;
    const FONT_MIN = LABEL_SIZE + 3;
    const FONT_MAX = LABEL_SIZE + 6;
    for (const [cid, name] of this.communityNames) {
      if (!name) continue;
      const count = this.communityMemberCount.get(cid) ?? 0;
      if (count < MIN_COMMUNITY_SIZE) continue;
      const sizeT = Math.min(1, Math.log2(count / MIN_COMMUNITY_SIZE) / 4);
      const fontSize = Math.round(FONT_MIN + (FONT_MAX - FONT_MIN) * sizeT);
      const color =
        this.communityColorMap?.get(cid) ?? getGraphThemeColors().labelColor;
      const el = document.createElement('div');
      el.textContent = name;
      el.dataset.fs = String(fontSize);
      el.style.cssText =
        'position:absolute;left:0;top:0;white-space:nowrap;display:none;' +
        `font:700 ${fontSize}px ${LABEL_FONT};color:${color};` +
        'text-shadow:0 0 6px #000,0 0 3px #000,0 0 3px #000;' +
        'will-change:transform;transform-origin:center center;';
      layer.appendChild(el);
      this.communityLabelEls.set(cid, el);
    }
    this.requestRender();
  }

  private recomputeCommunityCentroids(): void {
    if (!this.communityAssignments) return;
    const sums = new Map<
      number,
      { x: number; y: number; z: number; n: number }
    >();
    for (let i = 0; i < this.nodeArray.length; i++) {
      const node = this.nodeArray[i];
      if (!node.visible) continue;
      const cid = this.communityAssignments[node.id];
      if (cid === undefined) continue;
      const e = sums.get(cid);
      if (e) {
        e.x += this.posArray[i * 3];
        e.y += this.posArray[i * 3 + 1];
        e.z += this.posArray[i * 3 + 2];
        e.n += 1;
      } else {
        sums.set(cid, {
          x: this.posArray[i * 3],
          y: this.posArray[i * 3 + 1],
          z: this.posArray[i * 3 + 2],
          n: 1,
        });
      }
    }
    this.communityCentroids.clear();
    for (const [cid, s] of sums) {
      if (s.n > 0)
        this.communityCentroids.set(cid, {
          x: s.x / s.n,
          y: s.y / s.n,
          z: s.z / s.n,
        });
    }
  }

  /** Per-frame community wayfinder update: fade by zoom, (throttled) centroid
   *  recompute, position, scale to constant screen size, overlap-cull. O(K)
   *  communities — negligible. */
  private updateCommunityLabels(): void {
    const layer = this.communityLabelLayer;
    if (!layer || !this.activeCamera) return;
    // Held hidden while the build animation runs (the graph is empty); this is
    // the community system's own hide path, so it recovers cleanly afterward.
    if (this.buildPrepared || this.buildAnim) {
      layer.style.display = 'none';
      return;
    }
    if (!this.showCommunityLabels || this.communityLabelEls.size === 0) {
      layer.style.display = 'none';
      return;
    }
    const zoom = this.effectiveZoom();

    const FADE_START = 0.6;
    const FADE_END = 1.2;
    let alpha = 1;
    if (zoom >= FADE_END) alpha = 0;
    else if (zoom > FADE_START)
      alpha = 1 - (zoom - FADE_START) / (FADE_END - FADE_START);
    if (alpha <= 0.01) {
      layer.style.display = 'none';
      return;
    }
    layer.style.display = 'block';
    layer.style.opacity = String(alpha);

    const now = performance.now();
    // Same 250ms cadence as before, but skip entirely while positions /
    // visibility haven't changed since the last recompute — rerunning the
    // O(N) pass on identical inputs would produce identical centroids.
    if (
      (this.centroidsDirty && now - this.lastCommunityUpdate > 250) ||
      this.communityCentroids.size === 0
    ) {
      this.lastCommunityUpdate = now;
      this.centroidsDirty = false;
      this.recomputeCommunityCentroids();
    }

    // Constant screen size below the threshold, then shrink (mirrors Pixi).
    const htmlScale = zoom <= 0.2 ? 1 : 0.2 / zoom;

    // Project all centroids; position the visible ones.
    const positioned: {
      cid: number;
      el: HTMLDivElement;
      n: number;
      sx: number;
      sy: number;
      w: number;
      h: number;
    }[] = [];
    for (const [cid, el] of this.communityLabelEls) {
      const c = this.communityCentroids.get(cid);
      if (!c) {
        el.style.display = 'none';
        continue;
      }
      const s = this.worldToScreen(c.x, c.y, c.z);
      if (s.behind) {
        el.style.display = 'none';
        continue;
      }
      const fs = Number(el.dataset.fs) || LABEL_SIZE;
      const text = el.textContent ?? '';
      const w = text.length * fs * 0.6 * htmlScale;
      const h = fs * htmlScale;
      el.style.transform = `translate(${s.x}px,${s.y}px) translate(-50%,-50%) scale(${htmlScale})`;
      positioned.push({
        cid,
        el,
        n: this.communityMemberCount.get(cid) ?? 0,
        sx: s.x,
        sy: s.y,
        w,
        h,
      });
    }

    if (this.communityVisibilityFrozen) {
      // Keep the frozen visible set; just (re)apply display.
      for (const p of positioned) {
        p.el.style.display = this.currentlyShownCommunities.has(p.cid)
          ? 'block'
          : 'none';
      }
      return;
    }

    // Overlap cull — sticky-first then largest community wins.
    const shown = this.currentlyShownCommunities;
    positioned.sort((a, b) => {
      const aS = shown.has(a.cid) ? 1 : 0;
      const bS = shown.has(b.cid) ? 1 : 0;
      if (aS !== bS) return bS - aS;
      return b.n - a.n;
    });
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const accepted = new Set<number>();
    const PAD = 4;
    for (const p of positioned) {
      const x = p.sx - p.w / 2 - PAD;
      const y = p.sy - p.h / 2 - PAD;
      const w = p.w + PAD * 2;
      const h = p.h + PAD * 2;
      let overlap = false;
      for (const b of boxes) {
        if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) {
          overlap = true;
          break;
        }
      }
      if (overlap) {
        p.el.style.display = 'none';
      } else {
        p.el.style.display = 'block';
        boxes.push({ x, y, w, h });
        accepted.add(p.cid);
      }
    }
    this.currentlyShownCommunities = accepted;
    if (this.layoutSettled) this.communityVisibilityFrozen = true;
  }

  setEdgesEnabled(enabled: boolean): void {
    this.edgesEnabled = enabled;
    this.updateEdgeAlpha();
  }

  setHiddenLinkTypes(hidden: Set<string>): void {
    this.hiddenLinkTypes = hidden;
    this.updateEdgeAlpha();
  }

  /** Toggle ambient motion on/off (the user setting). Actual animation only
   *  runs once the layout has also settled — see refreshAmbient. */
  setAmbientActive(enabled: boolean): void {
    this.ambientEnabled = enabled;
    this.refreshAmbient();
  }

  setLayoutSettled(settled: boolean): void {
    this.layoutSettled = settled;
    // The post-build settle interpolation perpetually lags its target by a hair
    // (LIVE_INTERP_SLACK). On settle, land posArray on the final layout BEFORE
    // edges refresh / ambient captures its home, so nothing centers on the stale
    // lagging positions.
    if (settled && this.postBuildSettle) {
      const used = this.nodeArray.length * 3;
      if (this.layoutInterpActive && used <= this.layoutPos.length) {
        this.posArray.set(this.layoutPos.subarray(0, used));
        if (this.nodeGeometry) {
          (
            this.nodeGeometry.getAttribute('position') as BufferAttribute
          ).needsUpdate = true;
        }
      }
      this.postBuildSettle = false;
    }
    // Refresh once on the transition so endpoints aren't left stale after the
    // throttle gate stops firing on settle.
    if (this.edgeLines && !this.edgesHiddenForInteraction) {
      this.updateEdgePositions();
    }
    // Build the LOD super-graph from the now-stable centroids.
    if (settled && this.lodEnabled) this.maybeBuildSuperGraph();
    // Ambient drift bobs around the SETTLED positions. Re-capture the home on
    // EVERY settle so it tracks the current layout — e.g. after a preset switch
    // the positions changed, and a stale home would drift/clobber the new
    // layout. On un-settle (a re-layout is starting) just PAUSE; do NOT restore
    // the now-stale home into posArray — that overwrote the incoming layout and
    // caused the onion "have to click twice" bug when switching from Bundled.
    // Same gate as refreshAmbient: no ambient above AMBIENT_MAX_NODES (the
    // drift + edge rebuild is per-frame O(N+E) — too heavy on huge graphs) and
    // never during a live build (ambient offsets would fight the grow easing's
    // targets and the nodes judder between the two).
    if (settled) {
      if (
        this.ambientEnabled &&
        !this.liveGrowActive &&
        this.nodeArray.length > 0 &&
        this.nodeArray.length <= AMBIENT_MAX_NODES
      ) {
        this.captureAmbientHome();
        this.ambientActive = true;
      } else {
        this.ambientActive = false;
        this.ambientHome = null;
      }
    } else {
      this.ambientActive = false;
    }
    this.requestRender();
  }

  /** Snapshot the current positions as the ambient oscillation centre and size
   *  the amplitude to the graph's extent. */
  private captureAmbientHome(): void {
    // Fresh run, fresh damping — stale freeze factors from a previous run
    // would make some nodes start half-frozen.
    this.ambientDamp = null;
    const n = this.nodeArray.length;
    this.ambientHome = this.posArray.slice(0, n * 3);
    this.ambientStart = performance.now();
    let ext = 0;
    for (let i = 0; i < n * 3; i++) {
      const v = Math.abs(this.ambientHome[i]);
      if (v > ext) ext = v;
    }
    // Visible-but-gentle drift: a few percent of the graph's half-extent,
    // clamped, eased on big graphs.
    const scale = n > 8000 ? 0.6 : 1;
    this.ambientAmplitude = Math.max(8, Math.min(44, ext * 0.04)) * scale;
  }

  /** Start or stop ambient drift for the USER toggle (setAmbientActive). On
   *  start, snapshot the centre; on stop, restore it so toggling off doesn't
   *  leave the graph frozen mid-wobble. (Layout-driven start/stop is handled in
   *  setLayoutSettled, which must NOT restore — see there.) */
  private refreshAmbient(): void {
    const shouldRun =
      this.ambientEnabled &&
      this.layoutSettled &&
      !this.liveGrowActive &&
      this.nodeArray.length > 0 &&
      this.nodeArray.length <= AMBIENT_MAX_NODES;
    if (shouldRun === this.ambientActive) return;
    if (shouldRun) {
      this.captureAmbientHome();
      this.ambientActive = true;
      this.requestRender();
    } else {
      // Snap back to the captured centre so we don't freeze at a drifted
      // offset — but ONLY if the snapshot still matches the current node count.
      // The graph can grow or shrink while ambient is active (e.g. live-build
      // indexing streams nodes in, or switching repos resets the graph), which
      // makes `ambientHome` a different length than `posArray`; restoring it
      // then would either corrupt positions or throw `offset is out of bounds`.
      if (
        this.ambientHome &&
        this.nodeGeometry &&
        this.ambientHome.length === this.nodeArray.length * 3 &&
        this.ambientHome.length <= this.posArray.length
      ) {
        this.centroidsDirty = true;
        this.posArray.set(this.ambientHome);
        (
          this.nodeGeometry.getAttribute('position') as BufferAttribute
        ).needsUpdate = true;
        if (this.edgeLines && !this.edgesHiddenForInteraction) {
          this.updateEdgePositions();
        }
      }
      this.ambientActive = false;
      this.ambientHome = null;
      this.requestRender();
    }
  }

  /** Per-frame ambient drift: offset every node from its home by a sum of two
   *  slow, incommensurate sines per axis (with a per-node phase), so the whole
   *  graph breathes organically — continuous and bounded, never jumpy. Edges
   *  are rebuilt every frame so they stay glued to the nodes. */
  private updateAmbient(now: number): void {
    const home = this.ambientHome;
    if (!home || !this.nodeGeometry) return;
    this.centroidsDirty = true; // drift moves every node
    const pos = this.posArray;
    const t = (now - this.ambientStart) * 0.001; // seconds
    const A = this.ambientAmplitude;
    const is3D = this.mode3d;
    // Bound by the snapshot length too: if the graph grew since ambient
    // started, the extra nodes have no `home` entry — skip them rather than
    // read past the end (which would write NaN positions).
    const n = Math.min(this.nodeArray.length, (home.length / 3) | 0);

    // Cursor freeze: nodes near the pointer ease to a stop so the node a user
    // is aiming at doesn't float away. Each node's damp factor chases a target
    // (0 inside the freeze radius → 1 past the falloff band) every frame.
    let damp = this.ambientDamp;
    if (!damp || damp.length < n) {
      damp = new Float32Array(n).fill(1);
      this.ambientDamp = damp;
    }
    const cs = this.cursorScreen;
    let freeze = false;
    // 2D: cursor point in world space. 3D: cursor ray (origin + unit dir).
    let cwx = 0;
    let cwy = 0;
    let ox = 0;
    let oy = 0;
    let oz = 0;
    let dirx = 0;
    let diry = 0;
    let dirz = 0;
    let innerW = 0;
    let invBand = 0;
    if (cs) {
      const pxPerWorld = this.effectiveZoom();
      if (pxPerWorld > 0) {
        innerW = AMBIENT_FREEZE_INNER_PX / pxPerWorld;
        const outerW = AMBIENT_FREEZE_OUTER_PX / pxPerWorld;
        invBand = 1 / (outerW - innerW);
        if (!is3D) {
          const w = this.screenToWorld(cs.x, cs.y);
          cwx = w.x;
          cwy = w.y;
          freeze = true;
        } else if (this.perspCamera) {
          const cam = this.perspCamera;
          this.tmpVec
            .set(
              (cs.x / this.width) * 2 - 1,
              -((cs.y / this.height) * 2 - 1),
              0.5,
            )
            .unproject(cam);
          ox = cam.position.x;
          oy = cam.position.y;
          oz = cam.position.z;
          dirx = this.tmpVec.x - ox;
          diry = this.tmpVec.y - oy;
          dirz = this.tmpVec.z - oz;
          const len = Math.sqrt(dirx * dirx + diry * diry + dirz * dirz) || 1;
          dirx /= len;
          diry /= len;
          dirz /= len;
          freeze = true;
        }
      }
    }
    /** Smoothstepped drift factor by distance from the cursor (2D: point
     *  distance in the plane; 3D: distance from the cursor's view ray). */
    const dampTargetAt = (hx: number, hy: number, hz: number): number => {
      let d: number;
      if (!is3D) {
        const ex = hx - cwx;
        const ey = hy - cwy;
        d = Math.sqrt(ex * ex + ey * ey);
      } else {
        const vx = hx - ox;
        const vy = hy - oy;
        const vz = hz - oz;
        const along = vx * dirx + vy * diry + vz * dirz;
        const px = vx - along * dirx;
        const py = vy - along * diry;
        const pz = vz - along * dirz;
        d = Math.sqrt(px * px + py * py + pz * pz);
      }
      const u = Math.min(Math.max((d - innerW) * invBand, 0), 1);
      return u * u * (3 - 2 * u);
    };

    // Freeze model: each node CHASES its live drift target at a rate scaled
    // by its damp factor. Far from the cursor the chase is fast (tracks the
    // sines with imperceptible lag); near the cursor the rate reaches zero so
    // the node stops EXACTLY where it currently is — it must never walk back
    // to its home position (that read as a "jump" when the cursor arrived).
    // When the cursor leaves, the node glides back onto the moving target.

    // Onion: keep the layered shells intact — nodes may only bob gently ALONG
    // THEIR OWN RADIUS (in/out from the centre), never drift laterally (which
    // would smear the shells). Small amplitude so shells stay distinct.
    if (this.currentLayoutMode === 'onion') {
      const Ar = A * 0.3;
      for (let i = 0; i < n; i++) {
        const o = i * 3;
        const hx = home[o];
        const hy = home[o + 1];
        const hz = home[o + 2];
        const target = freeze ? dampTargetAt(hx, hy, hz) : 1;
        const f = (damp[i] += (target - damp[i]) * AMBIENT_FREEZE_EASE);
        const r = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
        const bob = Ar * Math.sin(t * 0.9 + i * 0.7);
        const k = (r + bob) / r; // move along the radial line only
        const rate = AMBIENT_TRACK_RATE * f;
        pos[o] += (hx * k - pos[o]) * rate;
        pos[o + 1] += (hy * k - pos[o + 1]) * rate;
        pos[o + 2] += (hz * k - pos[o + 2]) * rate;
      }
      (
        this.nodeGeometry.getAttribute('position') as BufferAttribute
      ).needsUpdate = true;
      if (this.edgeLines && !this.edgesHiddenForInteraction) {
        this.updateEdgePositions();
      }
      return;
    }

    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const p = i * 0.7; // per-node phase offset
      const target = freeze
        ? dampTargetAt(home[o], home[o + 1], home[o + 2])
        : 1;
      const f = (damp[i] += (target - damp[i]) * AMBIENT_FREEZE_EASE);
      const rate = AMBIENT_TRACK_RATE * f;
      const tx =
        home[o] +
        A * (Math.sin(t * 1.1 + p) + 0.6 * Math.sin(t * 0.67 + p * 1.7));
      const ty =
        home[o + 1] +
        A * (Math.sin(t * 0.95 + p * 1.3) + 0.6 * Math.sin(t * 0.78 + p * 0.5));
      pos[o] += (tx - pos[o]) * rate;
      pos[o + 1] += (ty - pos[o + 1]) * rate;
      if (is3D) {
        const tz =
          home[o + 2] +
          A *
            (Math.sin(t * 1.02 + p * 0.8) + 0.6 * Math.sin(t * 0.61 + p * 2.1));
        pos[o + 2] += (tz - pos[o + 2]) * rate;
      }
    }
    (
      this.nodeGeometry.getAttribute('position') as BufferAttribute
    ).needsUpdate = true;
    if (this.edgeLines && !this.edgesHiddenForInteraction) {
      this.updateEdgePositions();
    }
  }

  setZoomSizeExponent(exponent: number): void {
    this.zoomSizeExponent = Math.max(0, Math.min(1, exponent));
    this.requestRender();
  }

  setLabelScale(scale: number): void {
    this.labelScaleMultiplier = Math.max(0.1, Math.min(3, scale));
    this.runNodeLabelCull();
  }

  // ─── Hierarchical LOD ("graph Nanite") ─────────────────────────────

  /** Whether a node's community is currently expanded (members shown). When
   *  LOD is off, or the node is in a too-small / unassigned community, it's
   *  always visible. */
  private nodeLodVisible(id: string): boolean {
    if (!this.lodEnabled) return true;
    const cid = this.communityAssignments?.[id];
    if (cid === undefined) return true;
    const si = this.cidToSuper.get(cid);
    if (si === undefined) return true;
    return this.communityExpanded[si] === 1;
  }

  setLodEnabled(enabled: boolean): void {
    if (this.lodEnabled === enabled) return;
    this.lodEnabled = enabled;
    if (enabled) {
      this.maybeBuildSuperGraph();
    } else {
      this.disposeSuperGraph();
    }
    this.applyNodeStates();
    this.updateEdgeAlpha();
    this.requestRender();
  }

  isLodEnabled(): boolean {
    return this.lodEnabled;
  }

  /** Build the aggregate super-graph once we have communities + settled-ish
   *  positions. Idempotent-ish: only rebuilds when dirty or missing. */
  private maybeBuildSuperGraph(): void {
    if (
      !this.lodEnabled ||
      !this.communityAssignments ||
      this.nodeArray.length === 0
    )
      return;
    if (this.superList.length > 0 && !this.superGraphDirty) return;
    this.buildSuperGraph();
  }

  private disposeSuperGraph(): void {
    if (this.superNodePoints && this.scene)
      this.scene.remove(this.superNodePoints);
    this.superNodeGeometry?.dispose();
    this.superNodeGeometry = null;
    this.superNodePoints = null;
    if (this.superEdgeLines && this.scene)
      this.scene.remove(this.superEdgeLines);
    this.superEdgeGeometry?.dispose();
    this.superEdgeGeometry = null;
    this.superEdgeLines = null;
    this.superList = [];
    this.superEdgeList = [];
    this.cidToSuper.clear();
    this.communityExpanded = new Uint8Array(0);
    this.superEdgeBaseAlpha = new Float32Array(0);
  }

  private superEdgeBaseAlpha: Float32Array = new Float32Array(0);

  private buildSuperGraph(): void {
    if (!this.scene || !this.nodeMaterial || !this.superEdgeMaterial) return;
    const assignments = this.communityAssignments;
    if (!assignments) return;
    this.disposeSuperGraph();

    // Per-community centroid + count from current positions.
    const sums = new Map<
      number,
      { x: number; y: number; z: number; n: number }
    >();
    for (let i = 0; i < this.nodeArray.length; i++) {
      const cid = assignments[this.nodeArray[i].id];
      if (cid === undefined) continue;
      const x = this.posArray[i * 3];
      const y = this.posArray[i * 3 + 1];
      const z = this.posArray[i * 3 + 2];
      const e = sums.get(cid);
      if (e) {
        e.x += x;
        e.y += y;
        e.z += z;
        e.n++;
      } else {
        sums.set(cid, { x, y, z, n: 1 });
      }
    }
    this.superList = [];
    this.cidToSuper = new Map();
    for (const [cid, s] of sums) {
      if (s.n < LOD_MIN_COMMUNITY) continue;
      this.cidToSuper.set(cid, this.superList.length);
      this.superList.push({
        cid,
        x: s.x / s.n,
        y: s.y / s.n,
        z: s.z / s.n,
        radius: 1,
        count: s.n,
      });
    }
    const m = this.superList.length;
    if (m === 0) {
      this.superGraphDirty = false;
      return;
    }

    // Radius = RMS member distance from centroid (representative spread).
    const radAcc = new Float64Array(m);
    for (let i = 0; i < this.nodeArray.length; i++) {
      const cid = assignments[this.nodeArray[i].id];
      const si = cid !== undefined ? this.cidToSuper.get(cid) : undefined;
      if (si === undefined) continue;
      const s = this.superList[si];
      const dx = this.posArray[i * 3] - s.x;
      const dy = this.posArray[i * 3 + 1] - s.y;
      const dz = this.posArray[i * 3 + 2] - s.z;
      radAcc[si] += dx * dx + dy * dy + dz * dz;
    }
    for (let i = 0; i < m; i++) {
      this.superList[i].radius =
        Math.sqrt(radAcc[i] / Math.max(this.superList[i].count, 1)) || 1;
    }
    this.communityExpanded = new Uint8Array(m); // all collapsed initially

    // Super-node geometry (reuses the node material).
    this.superPosArray = new Float32Array(m * 3);
    this.superColorArray = new Float32Array(m * 3);
    this.superSizeArray = new Float32Array(m);
    this.superStateArray = new Float32Array(m);
    this.superPickArray = new Float32Array(m * 3);
    for (let i = 0; i < m; i++) {
      const s = this.superList[i];
      this.superPosArray[i * 3] = s.x;
      this.superPosArray[i * 3 + 1] = s.y;
      this.superPosArray[i * 3 + 2] = s.z;
      const col = this.communityColorMap?.get(s.cid) ?? FALLBACK_COLOR;
      hexToRgb(col, this.tmpColor);
      this.superColorArray[i * 3] = this.tmpColor.r;
      this.superColorArray[i * 3 + 1] = this.tmpColor.g;
      this.superColorArray[i * 3 + 2] = this.tmpColor.b;
      this.superSizeArray[i] = Math.min(8 + Math.sqrt(s.count) * 1.6, 44);
      this.superStateArray[i] = NODE_STATE_VISIBLE; // collapsed → shown
      const id = SUPER_PICK_OFFSET + i + 1;
      this.superPickArray[i * 3] = (id & 255) / 255;
      this.superPickArray[i * 3 + 1] = ((id >> 8) & 255) / 255;
      this.superPickArray[i * 3 + 2] = ((id >> 16) & 255) / 255;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.superPosArray, 3));
    geo.setAttribute('aColor', new BufferAttribute(this.superColorArray, 3));
    geo.setAttribute('aSize', new BufferAttribute(this.superSizeArray, 1));
    geo.setAttribute('aState', new BufferAttribute(this.superStateArray, 1));
    geo.setAttribute('aPickColor', new BufferAttribute(this.superPickArray, 3));
    const pts = new Points(geo, this.nodeMaterial);
    pts.frustumCulled = false;
    pts.renderOrder = 2; // above detail nodes
    this.superNodeGeometry = geo;
    this.superNodePoints = pts;
    this.scene.add(pts);

    // Aggregate inter-community edges.
    const pairMap = new Map<string, { a: number; b: number; weight: number }>();
    for (const e of this.edges) {
      const ca = assignments[e.sourceId];
      const cb = assignments[e.targetId];
      if (ca === undefined || cb === undefined || ca === cb) continue;
      const sa = this.cidToSuper.get(ca);
      const sb = this.cidToSuper.get(cb);
      if (sa === undefined || sb === undefined) continue;
      const lo = Math.min(sa, sb);
      const hi = Math.max(sa, sb);
      const key = lo + '-' + hi;
      const ex = pairMap.get(key);
      if (ex) ex.weight++;
      else pairMap.set(key, { a: lo, b: hi, weight: 1 });
    }
    let pairs = [...pairMap.values()].sort((x, y) => y.weight - x.weight);
    if (pairs.length > LOD_MAX_SUPER_EDGES)
      pairs = pairs.slice(0, LOD_MAX_SUPER_EDGES);
    this.superEdgeList = pairs;
    const k = pairs.length;
    this.superEdgePosArray = new Float32Array(k * 6);
    this.superEdgeColorArray = new Float32Array(k * 6);
    this.superEdgeAlphaArray = new Float32Array(k * 2);
    this.superEdgeBaseAlpha = new Float32Array(k);
    hexToRgb('#5b6675', this.tmpColor);
    for (let i = 0; i < k; i++) {
      const p = pairs[i];
      const a = this.superList[p.a];
      const b = this.superList[p.b];
      const o = i * 6;
      this.superEdgePosArray[o] = a.x;
      this.superEdgePosArray[o + 1] = a.y;
      this.superEdgePosArray[o + 2] = a.z;
      this.superEdgePosArray[o + 3] = b.x;
      this.superEdgePosArray[o + 4] = b.y;
      this.superEdgePosArray[o + 5] = b.z;
      for (let v = 0; v < 2; v++) {
        this.superEdgeColorArray[o + v * 3] = this.tmpColor.r;
        this.superEdgeColorArray[o + v * 3 + 1] = this.tmpColor.g;
        this.superEdgeColorArray[o + v * 3 + 2] = this.tmpColor.b;
      }
      const wa = Math.min(0.22 + Math.log2(p.weight + 1) * 0.07, 0.75);
      this.superEdgeBaseAlpha[i] = wa;
      this.superEdgeAlphaArray[i * 2] = wa;
      this.superEdgeAlphaArray[i * 2 + 1] = wa;
    }
    const eg = new BufferGeometry();
    eg.setAttribute('position', new BufferAttribute(this.superEdgePosArray, 3));
    eg.setAttribute('aColor', new BufferAttribute(this.superEdgeColorArray, 3));
    eg.setAttribute('aAlpha', new BufferAttribute(this.superEdgeAlphaArray, 1));
    const lines = new LineSegments(eg, this.superEdgeMaterial);
    lines.frustumCulled = false;
    lines.renderOrder = 0;
    this.superEdgeGeometry = eg;
    this.superEdgeLines = lines;
    this.scene.add(lines);

    this.superGraphDirty = false;
    this.updateLod(true);
    this.applyNodeStates();
    this.updateEdgeAlpha();
    this.requestRender();
  }

  /** Per-(throttled)-frame LOD selection: expand on-screen communities that
   *  project large enough, collapse the rest. Drives member-node visibility,
   *  detail-edge vs super-edge routing, and super-node visibility. */
  private updateLod(force = false): void {
    if (!this.lodEnabled || this.superList.length === 0 || !this.activeCamera)
      return;
    const now = performance.now();
    if (!force && now - this.lodLastUpdate < LOD_UPDATE_INTERVAL) return;
    this.lodLastUpdate = now;

    const zoom = this.effectiveZoom();
    const W = this.width;
    const H = this.height;
    const M = 160;
    let changed = false;
    for (let i = 0; i < this.superList.length; i++) {
      const s = this.superList[i];
      const scr = this.worldToScreen(s.x, s.y, s.z);
      const onScreen =
        !scr.behind &&
        scr.x > -M &&
        scr.x < W + M &&
        scr.y > -M &&
        scr.y < H + M;
      const projR = s.radius * zoom;
      const cur = this.communityExpanded[i] === 1;
      let next = cur;
      if (!onScreen) next = false;
      else if (!cur && projR > LOD_EXPAND_PX) next = true;
      else if (cur && projR < LOD_COLLAPSE_PX) next = false;
      if (next !== cur) {
        this.communityExpanded[i] = next ? 1 : 0;
        changed = true;
      }
      const wantState = next ? 0 : NODE_STATE_VISIBLE;
      if (this.superStateArray[i] !== wantState) {
        this.superStateArray[i] = wantState;
        if (this.superNodeGeometry)
          (
            this.superNodeGeometry.getAttribute('aState') as BufferAttribute
          ).needsUpdate = true;
      }
    }
    if (changed || force) {
      this.applyNodeStates();
      this.updateEdgeAlpha();
      this.updateSuperEdgeAlpha();
      this.requestRender();
    }
  }

  /** Super-edge (a,b) is shown unless BOTH endpoints are expanded (then the
   *  real detail edges between them carry the relationship). */
  private updateSuperEdgeAlpha(): void {
    if (!this.superEdgeGeometry) return;
    for (let i = 0; i < this.superEdgeList.length; i++) {
      const p = this.superEdgeList[i];
      const bothExpanded =
        this.communityExpanded[p.a] === 1 && this.communityExpanded[p.b] === 1;
      const a = bothExpanded ? 0 : this.superEdgeBaseAlpha[i];
      this.superEdgeAlphaArray[i * 2] = a;
      this.superEdgeAlphaArray[i * 2 + 1] = a;
    }
    (
      this.superEdgeGeometry.getAttribute('aAlpha') as BufferAttribute
    ).needsUpdate = true;
  }

  /** Member node ids of the community a super-node represents. */
  private superNodeMembers(superIndex: number): string[] {
    const cid = this.superList[superIndex]?.cid;
    if (cid === undefined || !this.communityAssignments) return [];
    const out: string[] = [];
    for (const node of this.nodeArray) {
      if (this.communityAssignments[node.id] === cid) out.push(node.id);
    }
    return out;
  }

  // ─── 3D (phase 5) ─────────────────────────────────────────────────

  /** OrbitControls' autoRotateSpeed is degrees-per-update at 60fps; convert
   *  from our radians/frame so the speed slider keeps its meaning. */
  private autoRotateSpeedFromRadians(radPerFrame: number): number {
    return ((radPerFrame * 60) / (2 * Math.PI)) * 360;
  }

  /** Enter/leave real 3D mode: swap the ortho camera for a perspective one
   *  driven by OrbitControls (rotate/pan/dolly + auto-rotate). The d3-force-3d
   *  worker supplies genuine z-coordinates; the renderer just reframes. */
  set3DMode(
    enabled: boolean,
    _communityAssignments?: Record<string, number>,
  ): void {
    if (enabled === this.mode3d) return;
    const renderer = this.renderer;
    if (!renderer) return;

    if (enabled) {
      const { center, radius } = this.computeBounds3D();
      const dist = Math.max(radius * 2.5, 10);
      if (!this.perspCamera) {
        this.perspCamera = new PerspectiveCamera(
          this.fov,
          this.width / this.height,
          0.1,
          Math.max(dist * 100, 1e6),
        );
        this.perspCamera.layers.enable(1); // see the sharp DOF foreground
      }
      this.perspCamera.aspect = this.width / this.height;
      // Position from azimuth 0 at the configured tilt.
      const sph = new Spherical(dist, Math.PI / 2 - this.mode3dTilt, 0);
      this.perspCamera.position
        .copy(center)
        .add(new Vector3().setFromSpherical(sph));
      this.perspCamera.updateProjectionMatrix();

      const controls = new OrbitControls(this.perspCamera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      // Rotation is implemented by rotateGraphBy (graph-centered pivot);
      // OrbitControls keeps pan + dolly only.
      controls.enableRotate = false;
      controls.target.copy(center);
      controls.autoRotate = this.mode3dAutoRotate;
      controls.autoRotateSpeed = this.autoRotateSpeedFromRadians(
        this.mode3dSpeed,
      );
      // Any manual orbit pauses auto-rotation (mirrors Pixi) AND hands the
      // camera to the user: without the flag, the live-build follow /
      // auto-fit kept zooming out against the user's own zoom during
      // indexing (OrbitControls owns 3D input, so the 2D pointer handlers
      // that normally set this never fire).
      controls.addEventListener('start', () => {
        this.hasUserMovedCamera = true;
        this.autoFitTarget = null;
        if (this.mode3dAutoRotate) this.set3DAutoRotate(false, true);
      });
      // Any camera change (orbit, damping step, auto-rotate) requests a frame.
      controls.addEventListener('change', () => this.requestRender());
      controls.update();
      this.controls = controls;

      this.mode3d = true;
      this.communityVisibilityFrozen = false;
      this.applyEdgeDepthMode();
      this.requestRender();
      // No build re-arm needed: the burst tracks the live layout (layoutPos),
      // so a 2D→3D switch mid-build is followed naturally as z develops.
    } else {
      this.controls?.dispose();
      this.controls = null;
      this.mode3d = false;
      this.communityVisibilityFrozen = false;
      this.applyEdgeDepthMode();
      // Reframe the 2D view.
      this.hasUserMovedCamera = false;
      this.zoomToFit(0);
    }
  }

  /** Center + bounding radius of visible nodes in 3D (x,y,z). */
  private computeBounds3D(): { center: Vector3; radius: number } {
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < this.nodeArray.length; i++) {
      if (!this.nodeArray[i].visible) continue;
      const x = this.posArray[i * 3];
      const y = this.posArray[i * 3 + 1];
      const z = this.posArray[i * 3 + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    if (minX === Infinity) return { center: new Vector3(0, 0, 0), radius: 500 };
    const center = new Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2,
    );
    const radius = 0.5 * Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    return { center, radius };
  }

  /** True when the 3D bounds are transiently DEGENERATE — several nodes report
   *  visible yet occupy essentially no extent (radius at/near computeBounds3D's
   *  floor). This happens for a beat after a data swap (zero-initialised
   *  posArray) or a layout reseed, before real positions stream in. Reframing
   *  from such bounds floors the orbit distance and drops the camera INSIDE the
   *  real graph — the "whole graph teleports" bug. Callers skip/defer instead.
   *  A genuinely tiny graph (1–3 nodes) is NOT flagged: it needs
   *  COLLAPSED_BOUNDS_MIN_NODES coincident visibles, which only occurs when
   *  positions haven't spread yet. */
  private bounds3DCollapsed(radius: number): boolean {
    if (radius > COLLAPSED_BOUNDS_RADIUS) return false;
    let visible = 0;
    for (let i = 0; i < this.nodeArray.length; i++) {
      if (
        this.nodeArray[i].visible &&
        ++visible >= COLLAPSED_BOUNDS_MIN_NODES
      ) {
        return true;
      }
    }
    return false;
  }

  /** Smooth 3D camera follow for live-build: eases the orbit distance + target
   *  toward the LAYOUT-TARGET bounds (stable — not the animating render
   *  positions, which oscillate from the fly-out pop and would make the camera
   *  pulse). Keeps the view direction + auto-rotate; low alpha = gentle pull
   *  back as the graph grows, no per-frame snapping. */
  private liveCameraFollow(): void {
    if (!this.controls || !this.perspCamera) return;
    const n = this.nodeArray.length;
    if (n === 0) return;
    const lp = this.layoutPos;
    let minX = Infinity,
      minY = Infinity,
      minZ = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      maxZ = -Infinity;
    // Frame ALL nodes against their layout target (not just "settled" ones).
    // The old settled-only gate meant that when parsing is fast — the whole
    // graph arrives before any node crosses GROW_REVEAL_MS — the camera sat at
    // its start distance, then SNAPPED out the instant nodes settled. Framing
    // every node's (stable) layoutPos, with the monotonic+smoothed radius
    // below, gives a continuous pull-back with no snap and no pulse.
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (!this.nodeArray[i].visible) continue;
      const o = i * 3;
      const x = lp[o],
        y = lp[o + 1],
        z = lp[o + 2];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      count++;
    }
    if (minX === Infinity) return;
    const cx = (minX + maxX) / 2,
      cy = (minY + maxY) / 2,
      cz = (minZ + maxZ) / 2;
    const boundsRadius =
      0.5 * Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
    // Predicted radius from node count grows CONTINUOUSLY (sqrt), so the camera
    // can pull back ahead of — and smoother than — the jumpy actual bounds.
    const predicted = Math.sqrt(count) * LIVE_CAM_RADIUS_PER_SQRT;
    const rawTarget = Math.max(boundsRadius, predicted);

    if (this.liveCamRadius === 0) {
      // First frame with settled nodes: snap the camera OUT to a generous
      // distance so subsequent growth barely moves it (smooth from the start).
      this.liveCamRadius = rawTarget;
      const startDist = Math.max(
        rawTarget * LIVE_CAM_DIST_MULT * LIVE_CAM_START_FACTOR,
        10,
      );
      const tgt0 = this.controls.target;
      tgt0.set(cx, cy, cz);
      const dir0 = new Vector3().subVectors(this.perspCamera.position, tgt0);
      if (dir0.lengthSq() < 1e-6) dir0.set(0, 0, 1);
      dir0.normalize().multiplyScalar(startDist);
      this.perspCamera.position.copy(tgt0).add(dir0);
      this.controls.update();
      return;
    }

    // Low-pass toward the raw target, but MONOTONIC — never let the framing
    // radius shrink mid-build (that pumps the camera in/out). The final fit
    // at end-of-build tightens the framing once.
    const smoothed =
      this.liveCamRadius +
      (rawTarget - this.liveCamRadius) * LIVE_CAM_RADIUS_SMOOTH;
    this.liveCamRadius = Math.max(this.liveCamRadius, smoothed);
    const desiredDist = Math.max(this.liveCamRadius * LIVE_CAM_DIST_MULT, 10);

    const a = LIVE_CAM_FOLLOW;
    const tgt = this.controls.target;
    tgt.x += (cx - tgt.x) * a;
    tgt.y += (cy - tgt.y) * a;
    tgt.z += (cz - tgt.z) * a;
    const dir = new Vector3().subVectors(this.perspCamera.position, tgt);
    let curDist = dir.length();
    if (curDist < 1e-6) {
      dir.set(0, 0, 1);
      curDist = 1;
    }
    const newDist = curDist + (desiredDist - curDist) * a;
    dir.normalize().multiplyScalar(newDist);
    this.perspCamera.position.copy(tgt).add(dir);
    this.controls.update();
  }

  /** Begin an animated 3D reframe that TRACKS the graph bounds as they change
   *  (the post-build full settle keeps expanding the layout). Driven by the
   *  render loop via {@link stepFit3D}; ends once the layout stabilizes + the
   *  camera has caught up. */
  private animateReframe3D(): void {
    if (!this.controls || !this.perspCamera || this.hasUserMovedCamera) return;
    this.fit3D = {
      smoothR: 0,
      cx: 0,
      cy: 0,
      cz: 0,
      init: false,
      stableFrames: 0,
      lastRadius: 0,
    };
    this.requestRender();
  }

  /** One eased step of the tracking reframe. Re-reads bounds each frame, eases
   *  toward radius × LIVE_CAM_DIST_MULT, and stays active until the required
   *  distance has held steady for ~0.5s AND the camera has converged. Returns
   *  true while still animating (so the render loop keeps drawing). */
  private stepFit3D(): boolean {
    const f = this.fit3D;
    if (!f || !this.controls || !this.perspCamera) return false;
    if (this.hasUserMovedCamera) {
      this.fit3D = null;
      return false;
    }
    const b = this.computeBounds3D();
    // Bounds collapsed for a beat (reseed / data swap before positions stream
    // in): easing toward them would floor the distance and drop the camera
    // inside the graph. Hold the current camera and keep the fit alive — the
    // next frame with real extent resumes the ease. Reset the smoother so it
    // re-seeds from the real radius rather than the collapsed one.
    if (this.bounds3DCollapsed(b.radius)) {
      f.init = false;
      f.stableFrames = 0;
      return true;
    }
    // Low-pass BOTH the radius and the center: during the settle the positions
    // jitter frame to frame (a single flung node spikes the extent, and the
    // min/max midpoint swings as different nodes become the extremes), so
    // easing straight at the raw bounds looks choppy. Smoothing gives the
    // camera a calm target for both distance and orbit center.
    const rl = 0.1;
    if (!f.init) {
      f.init = true;
      f.smoothR = b.radius;
      f.cx = b.center.x;
      f.cy = b.center.y;
      f.cz = b.center.z;
    } else {
      f.smoothR += (b.radius - f.smoothR) * rl;
      f.cx += (b.center.x - f.cx) * rl;
      f.cy += (b.center.y - f.cy) * rl;
      f.cz += (b.center.z - f.cz) * rl;
    }
    const desiredDist = Math.max(f.smoothR * LIVE_CAM_DIST_MULT, 10);
    const a = 0.06;
    const tgt = this.controls.target;
    tgt.x += (f.cx - tgt.x) * a;
    tgt.y += (f.cy - tgt.y) * a;
    tgt.z += (f.cz - tgt.z) * a;
    const dir = new Vector3().subVectors(this.perspCamera.position, tgt);
    let cur = dir.length();
    if (cur < 1e-6) {
      dir.set(0, 0, 1);
      cur = 1;
    }
    const nd = cur + (desiredDist - cur) * a;
    dir.normalize().multiplyScalar(nd);
    this.perspCamera.position.copy(tgt).add(dir);
    this.controls.update();
    // End only once the RAW bounds have stopped changing for a while AND the
    // smoothed radius has caught up to the CURRENT bounds AND the camera has
    // converged. Keying "stable" off the raw radius (not the smoothed one) +
    // requiring catch-up means a transient extent spike during the settle
    // (a node briefly flung far) can't freeze the camera zoomed too far out —
    // the smoothed radius decays back to the real bounds before we stop.
    if (Math.abs(b.radius - f.lastRadius) < b.radius * 0.01) f.stableFrames++;
    else f.stableFrames = 0;
    f.lastRadius = b.radius;
    const caughtUp = Math.abs(f.smoothR - b.radius) < b.radius * 0.05;
    const converged = Math.abs(nd - desiredDist) < desiredDist * 0.02;
    if (caughtUp && converged && f.stableFrames > 30) {
      this.fit3D = null;
      return false;
    }
    return true;
  }

  /** Reposition the orbit camera to frame the given bounds, keeping the
   *  current view direction. */
  private reframe3D(b: { center: Vector3; radius: number }): void {
    if (!this.controls || !this.perspCamera) return;
    const dist = Math.max(b.radius * 2.5, 10);
    const dir = new Vector3().subVectors(
      this.perspCamera.position,
      this.controls.target,
    );
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
    dir.normalize().multiplyScalar(dist);
    this.controls.target.copy(b.center);
    this.perspCamera.position.copy(b.center).add(dir);
    this.controls.update();
    this.requestRender();
  }

  is3DMode(): boolean {
    return this.mode3d;
  }

  set3DSpeed(speed: number): void {
    this.mode3dSpeed = speed;
    if (this.controls)
      this.controls.autoRotateSpeed = this.autoRotateSpeedFromRadians(speed);
  }

  set3DTilt(tilt: number): void {
    this.mode3dTilt = Math.max(-1.2, Math.min(1.2, tilt));
    if (this.controls && this.perspCamera) {
      const offset = new Vector3().subVectors(
        this.perspCamera.position,
        this.controls.target,
      );
      const sph = new Spherical().setFromVector3(offset);
      sph.phi = Math.max(
        0.1,
        Math.min(Math.PI - 0.1, Math.PI / 2 - this.mode3dTilt),
      );
      offset.setFromSpherical(sph);
      this.perspCamera.position.copy(this.controls.target).add(offset);
      this.controls.update();
    }
  }

  set3DAutoRotate(enabled: boolean, fromUser = false): void {
    this.mode3dAutoRotate = enabled;
    if (this.controls) this.controls.autoRotate = enabled;
    if (fromUser) this.callbacks.on3DAutoRotateChange?.(enabled);
  }

  // ─── Ping / glow ───────────────────────────────────────────────────

  // ─── Build animation ("watch the graph being built") ───────────────

  /** True while a build replay is in flight. */
  isBuildAnimating(): boolean {
    return this.buildAnim !== null;
  }

  // ─── Live-build ("build the graph while indexing") ────────────────────

  /** Enter continuous live-build mode: incremental data updates animate in —
   *  newly-added nodes fly out from their parent + scale up (the build-burst
   *  pop), already-placed nodes stay put (kept stable by worker-side pinning).
   *  Does NOT restart on each add. Camera follows the growing graph. */
  beginLiveGrow(): void {
    if (this.liveGrowActive) return;
    this.liveGrowActive = true;
    this.liveGrowFinishAt = null;
    this.liveGrowLastBirth = 0;
    this.liveGrowPrevPos = null;
    this.liveCamRadius = 0;
    // Reset snapshot-interpolation pacing for this build; the prev buffer is
    // (re)sized to the current position buffer so it always matches posArray.
    this.layoutInterpPrev = this.posArray.slice();
    this.layoutInterpStart = 0;
    this.layoutInterpDur = 0;
    this.layoutInterpActive = false;
    this.postBuildSettle = false; // a fresh build supersedes any prior settle
    const n = this.nodeArray.length;
    this.growBirth = new Float32Array(n).fill(GROW_BORN);
    this.growParent = new Int32Array(n).fill(-1);
    this.growTargetSize = this.sizeArray.slice();
    this.requestRender();
  }

  /** Begin leaving live-build GRACEFULLY: stop accepting new nodes but keep
   *  animating so in-flight grow-ins finish, then finalize. */
  endLiveGrow(): void {
    if (!this.liveGrowActive || this.liveGrowFinishAt !== null) return;
    this.liveGrowFinishAt = Math.max(
      performance.now(),
      this.liveGrowLastBirth + GROW_REVEAL_MS,
    );
    this.requestRender();
  }

  private finalizeLiveGrow(): void {
    this.liveGrowActive = false;
    this.liveGrowFinishAt = null;
    this.liveGrowPrevPos = null;
    if (this.nodeGeometry && this.nodeArray.length > 0) {
      const n = this.nodeArray.length;
      this.centroidsDirty = true;
      for (let i = 0; i < n; i++) {
        this.posArray[i * 3] = this.layoutPos[i * 3];
        this.posArray[i * 3 + 1] = this.layoutPos[i * 3 + 1];
        this.posArray[i * 3 + 2] = this.layoutPos[i * 3 + 2];
        this.sizeArray[i] = this.growTargetSize[i] ?? this.sizeArray[i];
      }
      (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
        true;
      (
        this.nodeGeometry.getAttribute('position') as BufferAttribute
      ).needsUpdate = true;
      this.updateEdgePositions();
      this.updateEdgeAlpha();
    }
    // The worker keeps streaming its release-pins settle after the build ends.
    // Keep snapshot-interpolating those posts so the settle stays as smooth as
    // the build instead of stepping at the ~5Hz stream rate. Only arm while the
    // layout is still settling; updateStreamInterp clears it the moment the
    // worker settles or a drag / ambient drift takes over.
    if (this.nodeArray.length > 0 && !this.layoutSettled) {
      this.postBuildSettle = true;
      this.layoutInterpStart = 0;
      this.layoutInterpDur = 0;
      this.layoutInterpActive = false;
    }
    // Smoothly settle into the final framing (3D animates the reframe; 2D uses
    // the eased zoomToFit). This catches up any zoom the live follow didn't
    // finish when parsing was fast — no end snap.
    if (!this.hasUserMovedCamera) {
      if (this.mode3d) this.animateReframe3D();
      else this.zoomToFit(800);
    }
    // liveGrowActive just flipped false — re-evaluate ambient so a user toggle
    // that arrived mid-build (suppressed by the liveGrowActive guard) can
    // start now. If the layout is still re-settling (end-of-build reseed), the
    // layoutSettled gate keeps this a no-op and the settle path activates it.
    this.refreshAmbient();
    // Live build done — the edge arrays are stable now, so curve the bulk edges
    // (skipped while liveGrowActive to avoid chasing reallocating buffers).
    this.syncCurvedEdges();
    this.requestRender();
  }

  /** Reconcile render state after a live-build rebuild: existing nodes keep
   *  their eased positions + stay settled; new nodes start collapsed at an
   *  existing neighbour and are scheduled to grow in. */
  private applyLiveGrowAfterRebuild(): void {
    const n = this.nodeArray.length;
    if (n === 0 || !this.nodeGeometry) {
      this.liveGrowPrevPos = null;
      return;
    }
    const prev = this.liveGrowPrevPos ?? new Map();
    this.layoutPos.set(this.posArray); // setData filled posArray = layout targets
    // Allocate grow arrays at the buffer CAPACITY (not n) so later appends past
    // n stay in-bounds.
    const cap = Math.max(this.nodeCapacity, n);
    this.growTargetSize = this.sizeArray.slice(0, cap);
    this.growBirth = new Float32Array(cap).fill(GROW_BORN);
    this.growParent = new Int32Array(cap).fill(-1);

    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of this.edges) {
      adj[e.sourceIdx].push(e.targetIdx);
      adj[e.targetIdx].push(e.sourceIdx);
    }

    const now = performance.now();
    for (let i = 0; i < n; i++) {
      const p = prev.get(this.nodeArray[i].id);
      if (p) {
        this.posArray[i * 3] = p[0];
        this.posArray[i * 3 + 1] = p[1];
        this.posArray[i * 3 + 2] = p[2];
      }
    }
    // BFS the NEW nodes outward from the existing frontier so each flies out
    // from a parent that's already on screen (or an earlier-born sibling), and
    // stagger their births by BFS rank — an organic ripple, like the burst,
    // instead of the whole batch popping at once.
    const isNew = (i: number) => !prev.has(this.nodeArray[i].id);
    const visited = new Uint8Array(n);
    const order: number[] = [];
    const queue: number[] = [];
    for (let i = 0; i < n; i++) {
      if (!isNew(i) || visited[i]) continue;
      let existingParent = -1;
      for (const nb of adj[i]) {
        if (!isNew(nb)) {
          existingParent = nb;
          break;
        }
      }
      if (existingParent >= 0) {
        visited[i] = 1;
        this.growParent[i] = existingParent;
        queue.push(i);
        order.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const nb of adj[cur]) {
        if (isNew(nb) && !visited[nb]) {
          visited[nb] = 1;
          this.growParent[nb] = cur;
          queue.push(nb);
          order.push(nb);
        }
      }
    }
    // New nodes disconnected from the existing frontier (rare) — append last.
    for (let i = 0; i < n; i++) {
      if (isNew(i) && !visited[i]) {
        this.growParent[i] = adj[i].length ? adj[i][0] : -1;
        order.push(i);
      }
    }
    const total = Math.max(1, order.length);
    for (let r = 0; r < order.length; r++) {
      const i = order[r];
      const h = ((i * 2654435761) >>> 0) / 4294967295; // deterministic jitter
      const birth = now + (r / total) * GROW_STAGGER_MS + (h - 0.5) * 140;
      this.growBirth[i] = birth;
      if (birth > this.liveGrowLastBirth) this.liveGrowLastBirth = birth;
      this.sizeArray[i] = 0;
      const pa = this.growParent[i];
      if (pa >= 0) {
        this.posArray[i * 3] = this.posArray[pa * 3];
        this.posArray[i * 3 + 1] = this.posArray[pa * 3 + 1];
        this.posArray[i * 3 + 2] = this.posArray[pa * 3 + 2];
      }
    }
    (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
      true;
    (
      this.nodeGeometry.getAttribute('position') as BufferAttribute
    ).needsUpdate = true;
    this.liveGrowPrevPos = null;
    this.requestRender();
  }

  /** Per-frame live-build tick: settled nodes glide toward their (pinned-stable)
   *  layout target; freshly-born nodes fly out from their parent's current spot
   *  with the easeOutBack pop; camera tracks the growing graph. */
  private updateLiveGrow(now: number): void {
    if (!this.nodeGeometry || this.nodeArray.length === 0) {
      if (this.liveGrowFinishAt !== null && now >= this.liveGrowFinishAt)
        this.finalizeLiveGrow();
      return;
    }
    this.centroidsDirty = true; // every node eases toward its layout target
    // Soft overshoot (near-eased) — see GROW_BACK_C1. The burst uses a stronger
    // pop, but that's on a settled graph; here the target is still moving.
    const c1 = GROW_BACK_C1;
    const c3 = c1 + 1;
    const backOut = (x: number) => {
      const u = x - 1;
      return 1 + c3 * u * u * u + c1 * u * u;
    };
    const pos = this.posArray;
    const sz = this.sizeArray;
    const lp = this.layoutPos;
    const prev = this.layoutInterpPrev;
    const tgt = this.growTargetSize;
    const birth = this.growBirth;
    const parent = this.growParent;
    const a = GROW_FOLLOW_ALPHA;
    const n = this.nodeArray.length;
    // Snapshot-interpolation factor for settled nodes: fraction of the way from
    // where each node sat at the last post (prev) toward the newly-posted target
    // (lp), paced by the measured post interval so ~5Hz stream → 60fps motion.
    // Falls back to the legacy per-frame ease before the first interval is known.
    const useInterp = this.layoutInterpActive && this.layoutInterpDur > 0;
    const ti = useInterp
      ? Math.min(
          1,
          (now - this.layoutInterpStart) /
            (this.layoutInterpDur * LIVE_INTERP_SLACK),
        )
      : 0;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const p = (now - birth[i]) / GROW_REVEAL_MS;
      if (p >= 1) {
        sz[i] = tgt[i];
        if (useInterp) {
          pos[o] = prev[o] + (lp[o] - prev[o]) * ti;
          pos[o + 1] = prev[o + 1] + (lp[o + 1] - prev[o + 1]) * ti;
          pos[o + 2] = prev[o + 2] + (lp[o + 2] - prev[o + 2]) * ti;
        } else {
          pos[o] += (lp[o] - pos[o]) * a;
          pos[o + 1] += (lp[o + 1] - pos[o + 1]) * a;
          pos[o + 2] += (lp[o + 2] - pos[o + 2]) * a;
        }
        continue;
      }
      const pa = parent[i];
      const fx = pa >= 0 ? pos[pa * 3] : lp[o];
      const fy = pa >= 0 ? pos[pa * 3 + 1] : lp[o + 1];
      const fz = pa >= 0 ? pos[pa * 3 + 2] : lp[o + 2];
      if (p <= 0) {
        sz[i] = 0;
        pos[o] = fx;
        pos[o + 1] = fy;
        pos[o + 2] = fz;
        continue;
      }
      const e = backOut(p);
      sz[i] = tgt[i] * e;
      pos[o] = fx + (lp[o] - fx) * e;
      pos[o + 1] = fy + (lp[o + 1] - fy) * e;
      pos[o + 2] = fz + (lp[o + 2] - fz) * e;
    }
    (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
      true;
    (
      this.nodeGeometry.getAttribute('position') as BufferAttribute
    ).needsUpdate = true;
    // Per-frame edge + camera work is O(edges)/O(n) — throttle on big graphs so
    // the build stays smooth (positions still update every frame; only the edge
    // redraw + camera ease are skipped on intervening frames).
    const f = ++this.liveGrowFrame;
    const heavy = n > 4000;
    if (
      this.edgeLines &&
      !this.edgesHiddenForInteraction &&
      (!heavy || f % 2 === 0)
    ) {
      this.updateEdgePositions();
    }
    // Keep the growing graph framed with a GENTLE eased follow (no per-frame
    // snap — that pulsed the camera). Backs off once the user moves it.
    if (!this.hasUserMovedCamera && (!heavy || f % 3 === 0)) {
      if (this.mode3d) this.liveCameraFollow();
      else this.scheduleAutoFit();
    }
    if (this.liveGrowFinishAt !== null && now >= this.liveGrowFinishAt)
      this.finalizeLiveGrow();
    else this.requestRender();
  }

  /** Per-frame tick for the post-build settle: snapshot-interpolate every node
   *  from where it was at the last worker post toward the freshly-posted target,
   *  so the release-pins settle stays smooth instead of stepping at the ~5Hz
   *  stream rate. Ends (snapping to the final target) once the layout settles or
   *  a drag / ambient drift / new build takes over. */
  private updateStreamInterp(now: number): void {
    if (!this.postBuildSettle || !this.nodeGeometry) return;
    const n = this.nodeArray.length;
    // Hand back to the raw/ambient/interaction path: land on the latest target
    // so nothing freezes mid-lerp, then stop owning the frame.
    if (
      n === 0 ||
      this.liveGrowActive ||
      this.buildAnim !== null ||
      this.layoutSettled ||
      this.ambientActive ||
      this.dragNodeIndex >= 0
    ) {
      if (this.layoutInterpActive && n * 3 <= this.layoutPos.length) {
        this.posArray.set(this.layoutPos.subarray(0, n * 3));
        this.markPositionsDirty();
      }
      this.postBuildSettle = false;
      return;
    }
    const ti =
      this.layoutInterpActive && this.layoutInterpDur > 0
        ? Math.min(
            1,
            (now - this.layoutInterpStart) /
              (this.layoutInterpDur * LIVE_INTERP_SLACK),
          )
        : 1;
    const pos = this.posArray;
    const prev = this.layoutInterpPrev;
    const lp = this.layoutPos;
    const end = n * 3;
    for (let o = 0; o < end; o++) pos[o] = prev[o] + (lp[o] - prev[o]) * ti;
    this.centroidsDirty = true;
    (
      this.nodeGeometry.getAttribute('position') as BufferAttribute
    ).needsUpdate = true;
    // Throttled edge refresh (mirrors markPositionsDirty) — O(edges) per frame is
    // the expensive part on big graphs; positions still ease every frame.
    if (this.edgeLines && !this.edgesHiddenForInteraction) {
      if (now - this.lastEdgeRedraw >= this.bp.edgeRedrawInterval) {
        this.updateEdgePositions();
      }
    }
    this.requestRender(); // keep frames coming between the ~5Hz posts
  }

  /** Append a streamed batch into the pre-allocated live-build buffers WITHOUT
   *  rebuilding geometry. Receives the FULL current graph and diffs against what
   *  it already holds, so it also catches edges whose endpoints arrived earlier.
   *  New nodes are scheduled to grow in (BFS-staggered fly-out). This is what
   *  makes the live build continuous + high-FPS (vs a full rebuild per batch). */
  appendLiveData(
    allNodes: GraphNode[],
    allLinks: GraphLink[],
    positions: Map<string, { x: number; y: number }>,
    nodeColors: Map<string, string>,
    nodeSizes: Map<string, number>,
    linkColors: Map<string, string>,
  ): void {
    if (this.destroyed || !this.nodeGeometry || !this.liveGrowActive) return;
    const oldN = this.nodeArray.length;
    const fresh: GraphNode[] = [];
    for (const gn of allNodes) if (!this.nodes.has(gn.id)) fresh.push(gn);

    if (fresh.length > 0) {
      const newN = oldN + fresh.length;
      if (newN > this.nodeCapacity) this.growNodeBuffers(newN);
      for (let k = 0; k < fresh.length; k++) {
        const i = oldN + k;
        const gn = fresh[k];
        const pos = positions.get(gn.id) ?? { x: 0, y: 0 };
        const color = nodeColors.get(gn.id) ?? FALLBACK_COLOR;
        const size = nodeSizes.get(gn.id) ?? 4;
        const o = i * 3;
        // Same finite guard as setData/updatePositionsFromBuffer.
        const px = Number.isFinite(pos.x) ? pos.x : 0;
        const py = Number.isFinite(pos.y) ? pos.y : 0;
        this.layoutPos[o] = px;
        this.layoutPos[o + 1] = py;
        this.layoutPos[o + 2] = 0;
        this.posArray[o] = px;
        this.posArray[o + 1] = py;
        this.posArray[o + 2] = 0;
        hexToRgb(color, this.tmpColor);
        this.colorArray[o] = this.tmpColor.r;
        this.colorArray[o + 1] = this.tmpColor.g;
        this.colorArray[o + 2] = this.tmpColor.b;
        this.sizeArray[i] = 0; // grows in
        this.growTargetSize[i] = size;
        this.stateArray[i] = NODE_STATE_VISIBLE;
        const id = i + 1;
        this.pickColorArray[o] = (id & 255) / 255;
        this.pickColorArray[o + 1] = ((id >> 8) & 255) / 255;
        this.pickColorArray[o + 2] = ((id >> 16) & 255) / 255;
        this.growBirth[i] = GROW_BORN;
        this.growParent[i] = -1;
        const node: ThreeNode = {
          id: gn.id,
          graphNode: gn,
          size,
          color,
          visible: true,
        };
        this.nodeIdToIndex.set(gn.id, i);
        this.nodeArray.push(node);
        this.nodes.set(gn.id, node);
      }
    }

    const startM = this.edges.length;
    this.appendLiveEdges(allLinks, linkColors);

    if (fresh.length > 0) {
      this.scheduleGrowIn(oldN, startM);
      // New nodes: re-sort the label priority order, refresh centroids.
      this.labelOrderDirty = true;
      this.centroidsDirty = true;
      for (const a of ['position', 'aColor', 'aSize', 'aState', 'aPickColor']) {
        (this.nodeGeometry.getAttribute(a) as BufferAttribute).needsUpdate =
          true;
      }
      // The node geometry carries a draw INDEX (applyNodeStates installs one at
      // build time), so setDrawRange counts index entries — extending the range
      // alone would never expose the appended vertices. Rebuild the
      // visible-node index (and the halo's) over the grown array so appends
      // are self-sufficient rather than relying on the host's highlight effect
      // happening to repaint after every batch.
      //
      // Fast path: when no global render state can alter the rows already in
      // the index (canFastAppend) and the current geometry actually carries
      // the index (nodeDrawIndexValid — a growNodeBuffers rebuild mid-batch
      // creates fresh index-less geometry), the appended nodes are all
      // visible + un-highlighted, so extending the index with [oldN, n) and
      // widening the range reproduces the full repack O(batch) instead of
      // O(N). Anything else → the unchanged full applyNodeStates.
      if (this.canFastAppend() && this.nodeDrawIndexValid) {
        this.appendNodeDrawIndices(oldN);
      } else {
        this.applyNodeStates();
      }
    }
    this.requestRender();
  }

  /** True when appendLiveData / appendLiveEdges may take the O(batch) fast
   *  path: no render state is active that could make EXISTING rows' packed
   *  state or alpha differ from what the last full pass wrote, and the
   *  appended rows' values are derivable from per-edge-local state alone
   *  (edgesEnabled / tree-mode are handled inside the shared per-edge alpha
   *  helper). Any disqualifying state → callers use the full-rebuild paths
   *  unchanged. */
  private canFastAppend(): boolean {
    return (
      !this.hasHighlight &&
      !this.traversalActive() &&
      !this.buildPrepared &&
      this.buildAnim === null &&
      this.hiddenNodeCount === 0 &&
      this.hiddenLinkTypes.size === 0 &&
      !(this.lodEnabled && this.superList.length > 0)
    );
  }

  /** O(batch) node append: under the canFastAppend guard every pre-existing
   *  node is visible and un-highlighted, so the current draw index is exactly
   *  [0, oldN) and the full repack would produce [0, n) with an empty halo
   *  set — append the new rows and widen the range. stateArray rows for the
   *  new nodes were already written by appendLiveData. */
  private appendNodeDrawIndices(oldN: number): void {
    if (!this.nodeGeometry) return;
    const n = this.nodeArray.length;
    if (this.nodeDrawIndex.length < n) {
      const grown = new Uint32Array(Math.max(n, this.nodeDrawIndex.length * 2));
      grown.set(this.nodeDrawIndex.subarray(0, this.nodeDrawCount));
      this.nodeDrawIndex = grown;
    }
    const idx = this.nodeDrawIndex;
    let dc = this.nodeDrawCount;
    for (let i = oldN; i < n; i++) idx[dc++] = i;
    this.nodeDrawCount = dc;
    this.setGeometryDrawIndex(this.nodeGeometry, idx, dc);
    // Halo untouched: no highlight is active (guard), so its index is empty
    // and the appended nodes wouldn't join it either.
    this.requestRender();
  }

  /** Append links not yet held (dedup by key) into the edge buffers in place. */
  private appendLiveEdges(
    allLinks: GraphLink[],
    linkColors: Map<string, string>,
  ): void {
    if (!this.edgeGeometry) return;
    const startM = this.edges.length;
    for (const gl of allLinks) {
      const sId =
        typeof gl.source === 'string' ? gl.source : (gl.source as GraphNode).id;
      const tId =
        typeof gl.target === 'string' ? gl.target : (gl.target as GraphNode).id;
      const key = `${sId}-${gl.label}-${tId}`;
      if (this.edgeKeySet.has(key)) continue;
      const si = this.nodeIdToIndex.get(sId);
      const ti = this.nodeIdToIndex.get(tId);
      if (si === undefined || ti === undefined) continue; // endpoint not in yet
      this.edgeKeySet.add(key);
      const m = this.edges.length;
      if (m + 1 > this.edgeCapacity) this.growEdgeBuffers(m + 1);
      this.edges.push({
        sourceId: sId,
        targetId: tId,
        sourceIdx: si,
        targetIdx: ti,
        key: `${sId}-${tId}`,
        label: gl.label,
        graphLink: gl,
        color: linkColors.get(gl.label) ?? '#3b4048',
      });
    }
    if (this.edges.length === startM) return;
    const col = this.edgeColorArray;
    for (let i = startM; i < this.edges.length; i++) {
      hexToRgb(this.edges[i].color, this.tmpColor);
      const o = i * 6;
      col[o] = col[o + 3] = this.tmpColor.r;
      col[o + 1] = col[o + 4] = this.tmpColor.g;
      col[o + 2] = col[o + 5] = this.tmpColor.b;
    }
    (this.edgeGeometry.getAttribute('aColor') as BufferAttribute).needsUpdate =
      true;
    // Same index-buffer caveat as appendLiveData: the edge geometry got a draw
    // index from rebuildEdgeDrawIndex at build time, so a bare setDrawRange
    // doesn't expose the appended segments — and their alpha is still 0.
    // updateEdgeAlpha fills alpha for the whole (grown) edge list and rebuilds
    // the draw index + range in one pass.
    //
    // Fast path: when no global state can alter the EXISTING rows' alphas
    // (canFastAppend), fill alpha only for the appended range — via the same
    // per-edge helper the full pass uses, so edgesEnabled / tree-mode /
    // node-visibility inputs are respected identically — and extend the draw
    // index in place. O(batch) instead of O(E) per streamed flush.
    if (this.canFastAppend()) {
      this.appendLiveEdgeAlphas(startM);
    } else {
      this.updateEdgeAlpha();
    }
  }

  /** O(batch) edge append (see appendLiveEdges): alphas for [startM, …) from
   *  the shared no-highlight helper (bit-identical to what the full
   *  updateEdgeAlpha pass computes for those rows in this state — LOD is
   *  inactive under the canFastAppend guard, so the lodVis flags are null
   *  exactly as the full pass would pass them), then the draw index grows by
   *  the appended visible rows. When viewport culling is on and the camera
   *  pose has changed since the index was last built, the RETAINED rows'
   *  in-view decisions are stale vs what a full rebuild would decide — fall
   *  back to rebuildEdgeDrawIndex (itself O(N) projections now) so culling
   *  output matches the slow path exactly. */
  private appendLiveEdgeAlphas(startM: number): void {
    if (!this.edgeGeometry) return;
    const a = this.edgeAlphaArray;
    const enabled = this.edgesEnabled;
    for (let i = startM; i < this.edges.length; i++) {
      const alpha = this.edgeAlphaNoHighlight(this.edges[i], enabled, null);
      a[i * 2] = alpha;
      a[i * 2 + 1] = alpha;
    }
    (this.edgeGeometry.getAttribute('aAlpha') as BufferAttribute).needsUpdate =
      true;

    const cull = this.bp.edgeViewportCulling && this.activeCamera != null;
    if (cull && !this.edgeCullCameraUnchanged()) {
      this.rebuildEdgeDrawIndex();
      return;
    }
    if (this.edgeDrawIndex.length < this.edges.length * 2) {
      const grown = new Uint32Array(
        Math.max(this.edges.length * 2, this.edgeDrawIndex.length * 2),
      );
      grown.set(this.edgeDrawIndex.subarray(0, this.edgeDrawCount));
      this.edgeDrawIndex = grown;
    }
    const eidx = this.edgeDrawIndex;
    const mx = this.width * 0.25;
    const my = this.height * 0.25;
    let ec = this.edgeDrawCount;
    for (let i = startM; i < this.edges.length; i++) {
      if (a[i * 2] <= 0) continue;
      if (cull) {
        // Camera pose is unchanged (checked above), so these projections
        // decide exactly as the full rebuild would for the appended rows.
        const e = this.edges[i];
        if (
          !this.nodeInView(e.sourceIdx, mx, my) &&
          !this.nodeInView(e.targetIdx, mx, my)
        ) {
          continue;
        }
      }
      eidx[ec++] = i * 2;
      eidx[ec++] = i * 2 + 1;
    }
    this.edgeDrawCount = ec;
    this.setGeometryDrawIndex(this.edgeGeometry, eidx, ec);
    this.requestRender();
  }

  /** Schedule grow-in for the appended nodes [oldN, n): BFS outward from the
   *  existing frontier (using the just-appended edges [startM, …]) and stagger
   *  births so the batch ripples in rather than popping at once. */
  private scheduleGrowIn(oldN: number, startM: number): void {
    const n = this.nodeArray.length;
    // Adjacency only over edges that touch a new node (the appended ones).
    const adj = new Map<number, number[]>();
    for (let e = startM; e < this.edges.length; e++) {
      const { sourceIdx: s, targetIdx: t } = this.edges[e];
      (adj.get(s) ?? adj.set(s, []).get(s)!).push(t);
      (adj.get(t) ?? adj.set(t, []).get(t)!).push(s);
    }
    const isNew = (i: number) => i >= oldN;
    const visited = new Uint8Array(n - oldN);
    const order: number[] = [];
    const queue: number[] = [];
    for (let i = oldN; i < n; i++) {
      const nbrs = adj.get(i);
      if (!nbrs) continue;
      let existingParent = -1;
      for (const nb of nbrs)
        if (!isNew(nb)) {
          existingParent = nb;
          break;
        }
      if (existingParent >= 0 && !visited[i - oldN]) {
        visited[i - oldN] = 1;
        this.growParent[i] = existingParent;
        queue.push(i);
        order.push(i);
      }
    }
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const nb of adj.get(cur) ?? []) {
        if (isNew(nb) && !visited[nb - oldN]) {
          visited[nb - oldN] = 1;
          this.growParent[nb] = cur;
          queue.push(nb);
          order.push(nb);
        }
      }
    }
    // New nodes with no edge to the existing frontier — append last, pop in place.
    for (let i = oldN; i < n; i++) {
      if (!visited[i - oldN]) {
        const nbrs = adj.get(i);
        this.growParent[i] = nbrs && nbrs.length ? nbrs[0] : -1;
        order.push(i);
      }
    }
    const now = performance.now();
    const total = Math.max(1, order.length);
    for (let r = 0; r < order.length; r++) {
      const i = order[r];
      const h = ((i * 2654435761) >>> 0) / 4294967295;
      const birth = now + (r / total) * GROW_STAGGER_MS + (h - 0.5) * 140;
      this.growBirth[i] = birth;
      if (birth > this.liveGrowLastBirth) this.liveGrowLastBirth = birth;
      const pa = this.growParent[i];
      if (pa >= 0) {
        this.posArray[i * 3] = this.posArray[pa * 3];
        this.posArray[i * 3 + 1] = this.posArray[pa * 3 + 1];
        this.posArray[i * 3 + 2] = this.posArray[pa * 3 + 2];
      }
    }
  }

  /** Grow node buffers (capacity doubling) + recreate node geometry. Rare. */
  private growNodeBuffers(needed: number): void {
    let cap = Math.max(this.nodeCapacity, 1);
    while (cap < needed) cap *= 2;
    const used = this.nodeArray.length;
    const f3 = (old: Float32Array) => {
      const a = new Float32Array(cap * 3);
      a.set(old.subarray(0, used * 3));
      return a;
    };
    const f1 = (old: Float32Array) => {
      const a = new Float32Array(cap);
      a.set(old.subarray(0, used));
      return a;
    };
    this.posArray = f3(this.posArray);
    this.layoutPos = f3(this.layoutPos);
    this.layoutInterpPrev = f3(this.layoutInterpPrev);
    this.colorArray = f3(this.colorArray);
    this.pickColorArray = f3(this.pickColorArray);
    this.sizeArray = f1(this.sizeArray);
    this.stateArray = f1(this.stateArray);
    this.growTargetSize = f1(this.growTargetSize);
    const gb = new Float32Array(cap).fill(GROW_BORN);
    gb.set(this.growBirth.subarray(0, used));
    this.growBirth = gb;
    const gp = new Int32Array(cap).fill(-1);
    gp.set(this.growParent.subarray(0, used));
    this.growParent = gp;
    this.nodeCapacity = cap;
    this.disposeNodeObjects();
    this.buildNodePoints();
  }

  /** Grow edge buffers (capacity doubling) + recreate edge geometry over them. */
  private growEdgeBuffers(needed: number): void {
    if (!this.scene || !this.edgeMaterial) return;
    let cap = Math.max(this.edgeCapacity, 1);
    while (cap < needed) cap *= 2;
    const used = this.edges.length;
    const fp = (old: Float32Array, stride: number) => {
      const a = new Float32Array(cap * stride);
      a.set(old.subarray(0, used * stride));
      return a;
    };
    this.edgePosArray = fp(this.edgePosArray, 6);
    this.edgeColorArray = fp(this.edgeColorArray, 6);
    this.edgeAlphaArray = fp(this.edgeAlphaArray, 2);
    this.edgeCapacity = cap;
    this.disposeEdgeObjects();
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.edgePosArray, 3));
    geo.setAttribute('aColor', new BufferAttribute(this.edgeColorArray, 3));
    geo.setAttribute('aAlpha', new BufferAttribute(this.edgeAlphaArray, 1));
    geo.setDrawRange(0, used * 2);
    const lines = new LineSegments(geo, this.edgeMaterial);
    lines.frustumCulled = false;
    this.edgeGeometry = geo;
    this.edgeLines = lines;
    this.scene.add(lines);
    this.applyEdgeDepthMode();
  }

  /** Arm the NEXT setData() to collapse the graph (before first paint) and hold
   *  it hidden until the layout settles, then auto-play the burst. The caller
   *  arms this when an index completes (before the new data arrives), so the
   *  finished graph never flashes. We deliberately do NOT collapse any
   *  currently-shown graph here: on a re-index the old graph stays visible
   *  until the new data's setData collapses it (no blank gap), and on a first
   *  index there's nothing to collapse yet. */
  armBuildAnimation(): void {
    this.buildArmed = true;
  }

  /** Capture the final sizes, then zero node sizes + edge alpha so the graph
   *  renders empty. Idempotent; consumes the armed flag. */
  private collapseForBuild(): void {
    if (!this.nodeGeometry || this.buildPrepared) {
      this.buildArmed = false;
      return;
    }
    this.preparedSizes = this.sizeArray.slice();
    this.sizeArray.fill(0);
    (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
      true;
    if (this.edgeGeometry) {
      this.edgeAlphaArray.fill(0);
      (
        this.edgeGeometry.getAttribute('aAlpha') as BufferAttribute
      ).needsUpdate = true;
    }
    this.buildPrepared = true;
    this.buildArmed = false;
    // Labels are hidden by updateLabelsPerFrame on the next (and every) frame
    // while prepared — node layer directly, community via its own path.
    this.requestRender();

    // Start the burst IMMEDIATELY — no waiting for the layout to settle. The
    // burst flies nodes toward the live (still-developing) layout positions, so
    // the graph "builds" from the instant indexing ends, with no black gap.
    this.playBuildAnimation();
  }

  /** Play the graph "building itself" as an outward burst: every node/edge is
   *  hidden, then — in BFS order from the root — each node is flung out from its
   *  parent toward its position with a pop, a glow spark fires, and edges
   *  stretch to the flying nodes. The fly-out TARGETS are read LIVE from the
   *  layout each frame (layoutPos), so the burst runs WHILE the layout is still
   *  settling — no waiting, no black gap. `rootIds` overrides the auto-detected
   *  root (Repository node, else highest-degree node). */
  playBuildAnimation(rootIds?: string[]): void {
    if (this.destroyed || !this.nodeGeometry || this.nodeArray.length === 0) {
      return;
    }
    // Restart cleanly if one is already running.
    if (this.buildAnim) this.stopBuildAnimation();

    const n = this.nodeArray.length;
    const duration = Math.min(
      BUILD_MAX_MS,
      Math.max(BUILD_MIN_MS, BUILD_MIN_MS + n * BUILD_MS_PER_NODE),
    );
    // Reserve the per-node reveal window at the tail so the last-born node
    // still finishes by `duration` (plus the jitter headroom).
    const spread = Math.max(1, duration - BUILD_NODE_REVEAL_MS);
    const { birth, parent } = this.computeBuildOrder(rootIds, spread);
    // When armed-and-prepared the live sizeArray is already zeroed, so the
    // real targets come from the snapshot taken at collapse time.
    const targetSize =
      this.buildPrepared && this.preparedSizes
        ? this.preparedSizes.slice()
        : this.sizeArray.slice();
    this.buildPrepared = false;
    this.preparedSizes = null;
    // Seed the live-target buffer from the current positions (the layout keeps
    // streaming updates into it during the build).
    this.layoutPos.set(this.posArray);

    // Start fully collapsed: zero every node size (shader culls size~0) and
    // every edge alpha. updateBuildAnim() flies them back in per the schedule.
    this.sizeArray.fill(0);
    (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
      true;
    if (this.edgeGeometry) {
      this.edgeAlphaArray.fill(0);
      (
        this.edgeGeometry.getAttribute('aAlpha') as BufferAttribute
      ).needsUpdate = true;
    }

    this.buildAnim = {
      start: performance.now(),
      duration,
      birth,
      targetSize,
      parent,
      sparked: new Uint8Array(n),
      sparkStride: Math.max(1, Math.ceil(n / BUILD_SPARK_BUDGET)),
    };
    // Drop the curved bulk-edge overlay for the duration of the burst: it's a
    // separate object whose alpha the build's edge-hiding doesn't touch, so it
    // would stay visible while the straight edges collapse. Deactivating it here
    // (shouldCurveEdges() is now false — buildAnim is set) re-adds the straight
    // edgeLines the burst actually animates; curves are restored at finish.
    this.syncCurvedEdges();
    this.requestRender();
  }

  /** Abort an in-flight build replay and snap to the final state. No-op if
   *  none is running. */
  stopBuildAnimation(): void {
    const anim = this.buildAnim;
    if (!anim) return;
    this.buildAnim = null;
    if (this.nodeGeometry) {
      this.centroidsDirty = true;
      this.posArray.set(this.layoutPos);
      this.sizeArray.set(anim.targetSize);
      (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
        true;
      (
        this.nodeGeometry.getAttribute('position') as BufferAttribute
      ).needsUpdate = true;
    }
    // Restore the curved edge overlay dropped at build start (before the edge
    // refresh so the curve buffers get filled).
    this.syncCurvedEdges();
    this.applyNodeStates();
    this.updateEdgeAlpha();
    this.updateEdgePositions();
    if (this.nodeLabelLayer) this.nodeLabelLayer.style.display = '';
    this.runNodeLabelCull();
    this.requestRender();
  }

  /** BFS the graph from its root, returning per-node-index birth offsets (ms,
   *  spread across `spread`, with jitter) and the BFS parent each node flies
   *  out from (-1 for component seeds). Earlier ranks (closer to the root) are
   *  born first; disconnected components are appended in index order. */
  private computeBuildOrder(
    rootIds: string[] | undefined,
    spread: number,
  ): { birth: Float32Array; parent: Int32Array } {
    const n = this.nodeArray.length;
    const birth = new Float32Array(n);
    const parent = new Int32Array(n).fill(-1);
    if (n === 0) return { birth, parent };

    // Undirected adjacency over node indices.
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of this.edges) {
      adj[e.sourceIdx].push(e.targetIdx);
      adj[e.targetIdx].push(e.sourceIdx);
    }

    const visited = new Uint8Array(n);
    const queue = new Int32Array(n);
    const order = new Int32Array(n);
    let head = 0;
    let tail = 0;
    let produced = 0;
    const enqueue = (i: number, from: number) => {
      if (!visited[i]) {
        visited[i] = 1;
        parent[i] = from;
        queue[tail++] = i;
      }
    };

    // Seeds: explicit roots, else a Repository/Repo node, else highest degree.
    const seeds: number[] = [];
    if (rootIds && rootIds.length) {
      for (const id of rootIds) {
        const i = this.nodeIdToIndex.get(id);
        if (i !== undefined) seeds.push(i);
      }
    }
    if (seeds.length === 0) {
      let repoIdx = -1;
      let bestDeg = -1;
      let bestIdx = 0;
      for (let i = 0; i < n; i++) {
        const type = this.nodeArray[i].graphNode.type;
        if (repoIdx < 0 && (type === 'Repository' || type === 'Repo')) {
          repoIdx = i;
        }
        if (adj[i].length > bestDeg) {
          bestDeg = adj[i].length;
          bestIdx = i;
        }
      }
      seeds.push(repoIdx >= 0 ? repoIdx : bestIdx);
    }
    for (const s of seeds) enqueue(s, -1);

    // BFS, restarting on disconnected components (scan pointer keeps it O(n)).
    let scan = 0;
    while (produced < n) {
      if (head >= tail) {
        while (scan < n && visited[scan]) scan++;
        if (scan >= n) break;
        enqueue(scan, -1);
      }
      const cur = queue[head++];
      order[produced++] = cur;
      for (const nb of adj[cur]) enqueue(nb, cur);
    }

    // Spread births by rank, then add a deterministic per-node jitter (hashed
    // off the index, so no Math.random) so same-depth siblings scatter in time.
    const denom = Math.max(1, produced - 1);
    const jitterAmp = BUILD_NODE_REVEAL_MS * BUILD_JITTER_FRAC;
    for (let rank = 0; rank < produced; rank++) {
      const i = order[rank];
      const h = ((i * 2654435761) >>> 0) / 4294967295; // [0,1)
      const jitter = (h - 0.5) * jitterAmp;
      birth[i] = Math.max(0, (rank / denom) * spread + jitter);
    }
    return { birth, parent };
  }

  /** Per-frame build-animation tick: fling each node out from its parent with
   *  an overshoot "pop", spark a glow as it's born, stretch edges to the
   *  flying nodes, then snap to the exact final state when complete. */
  private updateBuildAnim(now: number): void {
    const anim = this.buildAnim;
    if (!anim || !this.nodeGeometry) return;
    this.centroidsDirty = true; // the burst repositions every node
    const t = now - anim.start;
    // easeOutBack — overshoots past 1 then settles, giving the launch + pop.
    const c1 = BUILD_BACK_C1;
    const c3 = c1 + 1;
    const backOut = (x: number) => {
      const u = x - 1;
      return 1 + c3 * u * u * u + c1 * u * u;
    };

    const pos = this.posArray;
    const sz = this.sizeArray;
    const tgt = anim.targetSize;
    // Live layout targets — updated by the running simulation each frame, so
    // the burst flies nodes toward where the layout currently has them and they
    // keep tracking it as it settles (no stale snapshot).
    const lp = this.layoutPos;
    const birth = anim.birth;
    const parent = anim.parent;
    const sparked = anim.sparked;
    const n = this.nodeArray.length;

    for (let i = 0; i < n; i++) {
      const p = (t - birth[i]) / BUILD_NODE_REVEAL_MS;
      // Origin to fly out from: the parent's CURRENT spot (seeds pop in place).
      const pa = parent[i];
      const fx = pa >= 0 ? lp[pa * 3] : lp[i * 3];
      const fy = pa >= 0 ? lp[pa * 3 + 1] : lp[i * 3 + 1];
      const fz = pa >= 0 ? lp[pa * 3 + 2] : lp[i * 3 + 2];
      if (p <= 0) {
        // Parked at the parent, invisible (size 0 → shader-culled).
        sz[i] = 0;
        pos[i * 3] = fx;
        pos[i * 3 + 1] = fy;
        pos[i * 3 + 2] = fz;
        continue;
      }
      if (p >= 1) {
        // Fully revealed → sit exactly at the live layout position (follows it).
        sz[i] = tgt[i];
        pos[i * 3] = lp[i * 3];
        pos[i * 3 + 1] = lp[i * 3 + 1];
        pos[i * 3 + 2] = lp[i * 3 + 2];
        continue;
      }
      const e = backOut(p); // shared pop curve for travel + scale
      sz[i] = tgt[i] * e;
      pos[i * 3] = fx + (lp[i * 3] - fx) * e;
      pos[i * 3 + 1] = fy + (lp[i * 3 + 1] - fy) * e;
      pos[i * 3 + 2] = fz + (lp[i * 3 + 2] - fz) * e;
      // Spark once, the moment it's born (sampled on big graphs via the
      // stride; only for nodes that are actually drawn).
      if (
        !sparked[i] &&
        i % anim.sparkStride === 0 &&
        this.nodeArray[i].visible
      ) {
        sparked[i] = 1;
        this.triggerPing([this.nodeArray[i].id]);
      }
    }
    (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
      true;
    (
      this.nodeGeometry.getAttribute('position') as BufferAttribute
    ).needsUpdate = true;

    // Edges connect the live (flying) node positions; alpha ramps in with the
    // later-born endpoint so an edge fades in as its child node lands. Same
    // filters as updateEdgeAlpha so the build matches the user's current view.
    if (this.edgeGeometry) {
      const ep = this.edgePosArray;
      const ea = this.edgeAlphaArray;
      for (let k = 0; k < this.edges.length; k++) {
        const e = this.edges[k];
        const o = k * 6;
        const k2 = k * 2;
        const s = e.sourceIdx;
        const tt = e.targetIdx;
        if (
          !this.edgesEnabled ||
          this.hiddenLinkTypes.has(e.label) ||
          !this.nodeArray[s].visible ||
          !this.nodeArray[tt].visible
        ) {
          ea[k2] = ea[k2 + 1] = 0;
          continue;
        }
        const pLater =
          (t - Math.max(birth[s], birth[tt])) / BUILD_NODE_REVEAL_MS;
        const alpha =
          pLater <= 0 ? 0 : Math.min(1, pLater) * EDGE_OPACITY_DEFAULT;
        ep[o] = pos[s * 3];
        ep[o + 1] = pos[s * 3 + 1];
        ep[o + 2] = pos[s * 3 + 2];
        ep[o + 3] = pos[tt * 3];
        ep[o + 4] = pos[tt * 3 + 1];
        ep[o + 5] = pos[tt * 3 + 2];
        ea[k2] = ea[k2 + 1] = alpha;
      }
      (
        this.edgeGeometry.getAttribute('position') as BufferAttribute
      ).needsUpdate = true;
      (
        this.edgeGeometry.getAttribute('aAlpha') as BufferAttribute
      ).needsUpdate = true;
    }

    if (t >= anim.duration) {
      // Done — hand positions back to the live layout, restore sizes + edges.
      this.buildAnim = null;
      this.posArray.set(this.layoutPos);
      this.sizeArray.set(tgt);
      (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
        true;
      (
        this.nodeGeometry.getAttribute('position') as BufferAttribute
      ).needsUpdate = true;
      // Restore the curved edge overlay (buildAnim is null → shouldCurveEdges
      // true again) BEFORE the edge refresh so updateEdgeAlpha/Positions fill
      // the curve buffers.
      this.syncCurvedEdges();
      this.applyNodeStates();
      this.updateEdgeAlpha();
      this.updateEdgePositions();
      // Node labels were hidden during the burst — re-cull so they reappear.
      // Community labels recover on their own via updateCommunityLabels().
      if (this.nodeLabelLayer) this.nodeLabelLayer.style.display = '';
      this.runNodeLabelCull();
    }
    // Keep the loop alive for the next frame.
    this.needsRender = true;
  }

  triggerPing(nodeIds: Iterable<string>): void {
    if (!this.scene) return;
    const now = performance.now();
    for (const id of nodeIds) {
      const i = this.nodeIdToIndex.get(id);
      if (i === undefined) continue;
      const node = this.nodeArray[i];
      const existing = this.pingSprites.get(id);
      if (existing) {
        this.scene.remove(existing.sprite);
        existing.sprite.material.dispose();
        this.pingSprites.delete(id);
      }
      const tex = this.getGlowTexture(node.color);
      const sprite = new Sprite(
        new SpriteMaterial({
          map: tex,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      );
      sprite.renderOrder = 2;
      sprite.position.set(
        this.posArray[i * 3],
        this.posArray[i * 3 + 1],
        this.posArray[i * 3 + 2],
      );
      this.scene.add(sprite);
      this.pingSprites.set(id, { startTime: now, sprite });
    }
    this.requestRender();
  }

  /** Animate active pings — pulse + radial-gradient glow fade (mirrors Pixi). */
  private updatePing(): void {
    if (this.pingSprites.size === 0) return;
    const now = performance.now();
    const zoom = this.effectiveZoom();
    const expired: string[] = [];
    for (const [id, ping] of this.pingSprites) {
      const elapsed = now - ping.startTime;
      const i = this.nodeIdToIndex.get(id);
      if (elapsed >= ThreeRenderer.PING_DURATION || i === undefined) {
        expired.push(id);
        continue;
      }
      const t = elapsed / ThreeRenderer.PING_DURATION;
      const pulse = Math.sin(Math.PI * t) * (1 - t);
      const node = this.nodeArray[i];
      ping.sprite.position.set(
        this.posArray[i * 3],
        this.posArray[i * 3 + 1],
        this.posArray[i * 3 + 2],
      );
      // Glow diameter in world units ~ several × the node's on-screen size.
      const screenR = node.size * this.labelSpriteRadiusFactor(zoom);
      const world = (screenR * 7) / Math.max(zoom, 1e-4);
      const s = world * (1 + 0.3 * pulse);
      ping.sprite.scale.set(s, s, 1);
      const alphaIn = Math.min(1, t * 5);
      const alphaOut = Math.max(0, 1 - (t - 0.5) * 2);
      ping.sprite.material.opacity = 0.65 * Math.min(alphaIn, alphaOut);
    }
    for (const id of expired) {
      const ping = this.pingSprites.get(id);
      if (ping && this.scene) {
        this.scene.remove(ping.sprite);
        ping.sprite.material.dispose();
      }
      this.pingSprites.delete(id);
    }
  }

  /** Per-color soft radial-gradient glow texture (smooth, no banding). */
  private getGlowTexture(color: string): Texture {
    const cached = this.glowTextures.get(color);
    if (cached) return cached;
    const R = 64;
    const size = R * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d')!;
    // sRGB bytes (hexToRgb writes raw sRGB into the Color's fields).
    hexToRgb(color, this.tmpColor);
    const r = Math.round(this.tmpColor.r * 255);
    const g = Math.round(this.tmpColor.g * 255);
    const b = Math.round(this.tmpColor.b * 255);
    const grad = ctx.createRadialGradient(R, R, 0, R, R, R);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.55)`);
    grad.addColorStop(0.5, `rgba(${r},${g},${b},0.16)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    const tex = new CanvasTexture(canvas);
    this.glowTextures.set(color, tex);
    return tex;
  }

  // ─── Chat traversal ("watch the agent walk the graph") ─────────────

  /** Animate the agent traversing the graph: a glow pulse glides edge-by-edge
   *  through each leg, lighting the edge and pinging the node it reaches. Legs
   *  are ordered paths of real edges (discovered → newly-found node). `orphanIds`
   *  are newly-found nodes with no path to the discovered set — they just ping.
   *  Reached nodes/edges stay lit (hot) until `clearTraversal()`. Successive
   *  calls (per streamed tool result) append to the running walk.
   *  No-op cosmetic overlay — the persistent highlight set is unchanged. */
  animateTraversal(
    legs: { edges: { sourceId: string; targetId: string }[]; destId: string }[],
    orphanIds: string[] = [],
  ): void {
    if (this.destroyed || !this.scene || !this.nodeGeometry) return;

    // Orphans (disconnected finds) flash where they are AND join the lit set —
    // during a walk, highlightNodes are ignored (see traversalActive), so
    // without this they'd never light at all.
    if (orphanIds.length > 0) {
      this.triggerPing(orphanIds);
      let litAny = false;
      for (const id of orphanIds) {
        if (this.nodeIdToIndex.has(id)) {
          this.traversalLitNodes.add(id);
          litAny = true;
        }
      }
      if (litAny) this.refreshHotState();
    }

    // Count resolvable edges first so the per-edge time can be derived from the
    // batch budget — many edges → quick crossings, few edges → leisurely.
    let edgeCount = 0;
    for (const leg of legs) {
      for (const e of leg.edges) {
        if (
          this.nodeIdToIndex.has(e.sourceId) &&
          this.nodeIdToIndex.has(e.targetId)
        ) {
          edgeCount++;
        }
      }
    }
    if (edgeCount === 0) return;

    // Big result — keep the progressive draw ("see the connections build") but
    // switch to chain-lightning pacing: bigger budget, near-zero per-edge
    // floor, pings only at leg ends. A giant result plays in seconds, never
    // instantly floods.
    const big = edgeCount > TRAVERSAL_MAX_EDGES;
    const perEdge = big
      ? Math.max(TRAVERSAL_BIG_MIN_EDGE_MS, TRAVERSAL_BIG_BUDGET_MS / edgeCount)
      : Math.max(
          TRAVERSAL_MIN_EDGE_MS,
          Math.min(TRAVERSAL_MAX_EDGE_MS, TRAVERSAL_BUDGET_MS / edgeCount),
        );
    const gap = perEdge * TRAVERSAL_GAP_FRAC;

    // Build the ordered edge list with cumulative entry times. Seed nodes (each
    // leg's first source — an already-discovered anchor) light immediately.
    const newEdges: TraversalEdge[] = [];
    let cursor = 0;
    let seededAny = false;
    for (const leg of legs) {
      if (leg.edges.length === 0) continue;
      const seedId = leg.edges[0].sourceId;
      if (
        this.nodeIdToIndex.has(seedId) &&
        !this.traversalLitNodes.has(seedId)
      ) {
        this.traversalLitNodes.add(seedId);
        seededAny = true;
      }
      for (let j = 0; j < leg.edges.length; j++) {
        const e = leg.edges[j];
        const s = this.nodeIdToIndex.get(e.sourceId);
        const t = this.nodeIdToIndex.get(e.targetId);
        if (s === undefined || t === undefined) continue;
        const isLast = j === leg.edges.length - 1;
        const edgeKey = `${e.sourceId}-${e.targetId}`;
        const edgeKeyRev = `${e.targetId}-${e.sourceId}`;
        newEdges.push({
          sourceIdx: s,
          targetIdx: t,
          edgeKey,
          edgeKeyRev,
          destId: e.targetId,
          startMs: cursor,
          durMs: perEdge,
          arrived: 0,
          ping: big ? (isLast ? 1 : 0) : 1,
        });
        // Hide the queued edge until the pulse builds it — unless an earlier
        // leg already lit it (a re-crossed edge must not flicker off).
        if (!this.traversalLitEdges.has(edgeKey)) {
          this.traversalPendingEdges.add(edgeKey);
          this.traversalPendingEdges.add(edgeKeyRev);
        }
        cursor += perEdge + (isLast ? gap : 0);
      }
    }

    if (newEdges.length === 0) {
      if (seededAny) this.refreshHotState();
      return;
    }

    const now = performance.now();
    const anim = this.traversalAnim;
    if (anim) {
      const remaining = anim.duration - (now - anim.start);
      if (remaining > TRAVERSAL_MAX_BACKLOG_MS) {
        // Backlog is lagging the real tool-call progress — COMPRESS it into a
        // short catch-up burst rather than flash-lighting it: every edge must
        // visibly build (never pop in), but the walk also can't fall minutes
        // behind streamed tool results.
        const backlog = anim.edges.filter((e) => !e.arrived);
        const per = TRAVERSAL_CATCHUP_MS / Math.max(backlog.length, 1);
        let catchUp = 0;
        for (const e of backlog) {
          e.startMs = catchUp;
          e.durMs = per;
          catchUp += per;
        }
        for (const e of newEdges) e.startMs += catchUp;
        anim.start = now;
        anim.edges = [...backlog, ...newEdges];
        anim.duration = catchUp + cursor;
        this.refreshHotState();
      } else {
        // Chain after the current walk so streamed legs play continuously.
        const base = anim.duration;
        for (const e of newEdges) e.startMs += base;
        anim.edges.push(...newEdges);
        anim.duration = base + cursor;
        // Always repaint: the freshly-QUEUED edges must hide now (pending),
        // not just when a seed node lit.
        this.refreshHotState();
      }
    } else {
      const sprite = new Sprite(
        new SpriteMaterial({
          map: this.getGlowTexture(TRAVERSAL_PULSE_COLOR),
          transparent: true,
          depthTest: false,
          depthWrite: false,
          blending: AdditiveBlending,
        }),
      );
      sprite.renderOrder = 3;
      sprite.visible = false;
      this.scene.add(sprite);
      this.traversalAnim = {
        start: now,
        duration: cursor,
        edges: newEdges,
        sprite,
      };
      // Repaint now: seed anchors light up AND the queued (pending) edges —
      // plus the rest of the graph's web — hide so the walk builds from
      // nothing.
      this.refreshHotState();
    }
    this.requestRender();
  }

  /** Lazily create the partial-trail overlay segment (see traversalHeadLine).
   *  Reused across walks; only destroy() disposes it. */
  private ensureTraversalHead(): LineSegments | null {
    if (this.traversalHeadLine || !this.scene) return this.traversalHeadLine;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.traversalHeadPos, 3));
    const line = new LineSegments(
      geo,
      new LineBasicMaterial({
        color: TRAVERSAL_TRAIL_COLOR,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );
    line.frustumCulled = false;
    line.renderOrder = 3; // over edges + nodes, like the pulse sprite
    line.visible = false;
    this.traversalHeadLine = line;
    this.scene.add(line);
    return line;
  }

  /** Per-frame driver for the traversal pulse: positions the glow on the active
   *  edge, fills the trail segment behind it (the connection visibly draws
   *  itself), and as each edge completes, lights it + pings the node reached. */
  private updateTraversalAnim(now: number): void {
    const anim = this.traversalAnim;
    if (!anim || !this.scene) return;
    const elapsed = now - anim.start;

    let dirty = false;
    let active: TraversalEdge | null = null;
    let anyPending = false;
    // Batched — a big (chain-lightning) walk completes many edges per frame,
    // and one triggerPing call per frame beats hundreds.
    let pings: string[] | null = null;
    for (const e of anim.edges) {
      if (elapsed >= e.startMs && elapsed < e.startMs + e.durMs) {
        active = e;
      }
      if (!e.arrived && elapsed >= e.startMs + e.durMs) {
        e.arrived = 1;
        this.traversalLitEdges.add(e.edgeKey);
        this.traversalLitEdges.add(e.edgeKeyRev);
        this.traversalLitNodes.add(e.destId);
        this.traversalPendingEdges.delete(e.edgeKey);
        this.traversalPendingEdges.delete(e.edgeKeyRev);
        if (e.ping) (pings ??= []).push(e.destId);
        dirty = true;
      }
      if (!e.arrived) anyPending = true;
    }
    if (pings) this.triggerPing(pings);
    // Repaint on arrival — but on big graphs batch arrivals to at most one
    // full-graph repaint per TRAVERSAL_REPAINT_MS (refreshHotState is
    // O(nodes+edges)); the final flush fires as soon as nothing is pending.
    if (dirty) this.traversalRepaintPending = true;
    if (this.traversalRepaintPending) {
      const throttle =
        this.nodeArray.length + this.edges.length >
        TRAVERSAL_REPAINT_THROTTLE_SCALE
          ? TRAVERSAL_REPAINT_MS
          : 0;
      if (!anyPending || now - this.traversalLastRepaint >= throttle) {
        this.traversalRepaintPending = false;
        this.traversalLastRepaint = now;
        this.refreshHotState();
      }
    }
    // Chained chat traversals keep appending to this timeline within one
    // session; once everything so far has arrived, drop the scanned-per-frame
    // backlog (the lit state lives in traversalLit*, not here).
    if (!anyPending && anim.edges.length > 0 && !active) {
      anim.edges.length = 0;
    }

    if (active) {
      const t = (elapsed - active.startMs) / active.durMs;
      // Smoothstep so the pulse eases out of one node and into the next.
      const ease = t * t * (3 - 2 * t);
      const si = active.sourceIdx * 3;
      const ti = active.targetIdx * 3;
      const x =
        this.posArray[si] + (this.posArray[ti] - this.posArray[si]) * ease;
      const y =
        this.posArray[si + 1] +
        (this.posArray[ti + 1] - this.posArray[si + 1]) * ease;
      const z =
        this.posArray[si + 2] +
        (this.posArray[ti + 2] - this.posArray[si + 2]) * ease;
      anim.sprite.position.set(x, y, z);
      anim.sprite.visible = true;
      // Fill the already-crossed part of the edge in the trail color so the
      // connection builds behind the pulse (the full edge only flips lit in
      // the buffers on arrival).
      const head = this.ensureTraversalHead();
      if (head) {
        const hp = this.traversalHeadPos;
        hp[0] = this.posArray[si];
        hp[1] = this.posArray[si + 1];
        hp[2] = this.posArray[si + 2];
        hp[3] = x;
        hp[4] = y;
        hp[5] = z;
        (
          head.geometry.getAttribute('position') as BufferAttribute
        ).needsUpdate = true;
        head.visible = true;
      }
      // Size off the node being approached, but enforce a screen-space floor so
      // the pulse stays visible on big graphs where nodes are sub-pixel. A gentle
      // throb (sin over the crossing) draws the eye to the moving head.
      const zoom = this.effectiveZoom();
      const node = this.nodeArray[active.targetIdx];
      const screenR = node.size * this.labelSpriteRadiusFactor(zoom);
      const screen = Math.max(screenR * 8, TRAVERSAL_MIN_PULSE_PX);
      const world = screen / Math.max(zoom, 1e-4);
      const throb = 1 + 0.18 * Math.sin(Math.PI * t);
      const s = world * throb;
      anim.sprite.scale.set(s, s, 1);
      anim.sprite.material.opacity = 1;
    } else {
      anim.sprite.visible = false;
      if (this.traversalHeadLine) this.traversalHeadLine.visible = false;
    }

    if (elapsed >= anim.duration) {
      this.scene.remove(anim.sprite);
      anim.sprite.material.dispose();
      this.traversalAnim = null;
      if (this.traversalHeadLine) this.traversalHeadLine.visible = false;
    }
    this.requestRender();
  }

  /** Clear the traversal walk + its lit trail (a new question / highlights-off).
   *  Falls back through to the standard highlight state so the graph un-dims. */
  clearTraversal(): void {
    if (this.traversalAnim) {
      this.scene?.remove(this.traversalAnim.sprite);
      this.traversalAnim.sprite.material.dispose();
      this.traversalAnim = null;
    }
    if (this.traversalHeadLine) this.traversalHeadLine.visible = false;
    if (
      this.traversalLitNodes.size === 0 &&
      this.traversalLitEdges.size === 0 &&
      this.traversalPendingEdges.size === 0
    ) {
      return;
    }
    this.traversalLitNodes.clear();
    this.traversalLitEdges.clear();
    this.traversalPendingEdges.clear();
    this.traversalRepaintPending = false;
    this.refreshHotState();
    this.requestRender();
  }

  /** Re-derive `hasHighlight` from the current highlight + traversal sets and
   *  repaint node states + edge alpha + edge colors so the hot trail shows /
   *  clears. */
  private refreshHotState(): void {
    this.hasHighlight = this.computeHasHighlight();
    this.applyNodeStates();
    this.updateEdgeAlpha();
    this.fillEdgeColors();
  }

  // ─── Node access ──────────────────────────────────────────────────

  getNode(id: string): ThreeNode | undefined {
    return this.nodes.get(id);
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  getEdgeCount(): number {
    return this.edges.length;
  }

  getBreakpoint(): PixiScaleBreakpoint {
    return this.bp;
  }

  setBreakpoints(breakpoints: PixiScaleBreakpoint[]): void {
    this.breakpoints = breakpoints;
  }

  getViewport(): Viewport {
    const cam = this.camera;
    return cam
      ? { x: cam.position.x, y: cam.position.y, scale: cam.zoom }
      : { x: 0, y: 0, scale: 1 };
  }
}
