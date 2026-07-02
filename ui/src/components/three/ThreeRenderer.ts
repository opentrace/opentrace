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
  LineSegments,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  Color,
  Vector2,
  Vector3,
  Quaternion,
  Spherical,
  NearestFilter,
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
  NODE_SIZE_DIMMED_SCALE,
  NODE_SIZE_HIGHLIGHTED_SCALE,
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_HIGHLIGHTED,
  EDGE_OPACITY_DIMMED,
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
 *  stiff follow reads as jitter. */
const GROW_FOLLOW_ALPHA = 0.08;
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
 *  to play, fast-forward the backlog (light it instantly) and animate only the
 *  new batch — keeps the pulse within ~1s of the real tool-call progress. */
const TRAVERSAL_MAX_BACKLOG_MS = 700;
/** Above this many edges in one call we light them instantly (skip the pulse)
 *  — keeps a giant tool result from animating for minutes. */
const TRAVERSAL_MAX_EDGES = 160;
/** Travelling-pulse glow color (the "agent" walking the graph). */
const TRAVERSAL_PULSE_COLOR = '#bae6fd';
/** Lit-trail edge color — a vivid cyan so the walked path pops on big graphs. */
const TRAVERSAL_TRAIL_COLOR = '#38bdf8';
/** Floor on the pulse's on-screen radius (px) so it stays visible when the
 *  graph is zoomed way out and individual nodes are sub-pixel. */
const TRAVERSAL_MIN_PULSE_PX = 22;

/** Strip control characters and truncate to LABEL_MAX_LENGTH. */
function cleanLabel(raw: string): string {
  const stripped = raw.replace(/[\n\r\t]+/g, ' ').trim();
  return stripped.length > LABEL_MAX_LENGTH
    ? stripped.slice(0, LABEL_MAX_LENGTH) + '…'
    : stripped;
}

/** Minimum distance from point (px,py) to line segment (ax,ay)→(bx,by). */
function pointToSegmentDist(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 0.0001) {
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
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

  // Node point cloud
  private nodeGeometry: BufferGeometry | null = null;
  private nodeMaterial: ShaderMaterial | null = null;
  private nodePoints: Points | null = null;
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
      dimScale: NODE_SIZE_DIMMED_SCALE,
      dimAlpha: NODE_OPACITY_DIMMED,
    });
    this.edgeMaterial = createEdgeMaterial();
    this.superEdgeMaterial = createEdgeMaterial(); // independent opacity
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
        this.fit3D === null
      )
        return;
      this.needsRender = false;
      if (this.buildAnim) this.updateBuildAnim(performance.now());
      if (this.liveGrowActive) this.updateLiveGrow(performance.now());
      // Animated final fit (smooth end-of-build reframe). Keep drawing while
      // it eases; it clears itself when it reaches the goal.
      if (this.fit3D && this.stepFit3D()) this.needsRender = true;
      if (this.traversalAnim) this.updateTraversalAnim(performance.now());
      if (this.ambientActive) this.updateAmbient(performance.now());
      if (this.nodeMaterial) {
        const u = this.nodeMaterial.uniforms as unknown as NodeMaterialUniforms;
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
      if (this.lodEnabled) this.updateLod();
      renderer.render(scene, cam);
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
      !this.liveGrowActive
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
    if (this.traversalAnim) this.updateTraversalAnim(performance.now());
    if (this.ambientActive) this.updateAmbient(performance.now());

    // Keep the shader's zoom uniform in sync (size attenuation).
    if (this.nodeMaterial) {
      const u = this.nodeMaterial.uniforms as unknown as NodeMaterialUniforms;
      u.uPerspective.value = 0;
      u.uZoom.value = cam.zoom;
      u.uSizeExp.value = this.zoomSizeExponent;
    }
    if (this.edgeMaterial)
      this.edgeMaterial.uniforms.uOpacity.value = this.edgeOpacity();
    if (this.superEdgeMaterial)
      this.superEdgeMaterial.uniforms.uOpacity.value =
        this.edgeOpacityMultiplier;
    if (this.lodEnabled) this.updateLod();

    renderer.render(scene, cam);

    this.updateLabelsPerFrame();
    this.updatePing();
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

    // Candidate set: highlighted-only when a highlight is active, else all visible.
    const candidates: number[] = [];
    for (let i = 0; i < this.nodeArray.length; i++) {
      const node = this.nodeArray[i];
      if (!node.visible) continue;
      if (this.hasHighlight && !this.nodeIsHot(node.id)) continue;
      candidates.push(i);
    }
    // Largest (highest-degree) nodes win label slots.
    candidates.sort((a, b) => this.nodeArray[b].size - this.nodeArray[a].size);

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
   *  judges what's really on screen. 2D: ortho attenuation `zoom^exp`. 3D:
   *  depth cue at the orbit-target distance × the slider's size gain —
   *  `effectiveZoom()` is exactly the shader's `persp` for a node at the
   *  target depth, so `mix(1, persp, 0.5) = (1 + zoom) / 2`. */
  private labelSpriteRadiusFactor(zoom: number): number {
    if (this.mode3d) {
      return ((1 + zoom) / 2) * Math.pow(12, 0.3 - this.zoomSizeExponent);
    }
    return Math.pow(zoom, this.zoomSizeExponent);
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
    this.edgeMaterial?.dispose();
    this.edgeMaterial = null;
    this.pickingMaterial?.dispose();
    this.pickingMaterial = null;
    this.pickTarget?.dispose();
    this.pickTarget = null;
    this.disposeSuperGraph();
    this.superEdgeMaterial?.dispose();
    this.superEdgeMaterial = null;
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
  ): Promise<void> {
    if (this.destroyed || !this.scene) return;

    // Any in-flight build replay refers to the old node/edge arrays.
    this.buildAnim = null;
    this.buildPrepared = false;
    this.preparedSizes = null;
    // The hovered index refers to the old node array.
    this.hoveredNodeIndex = -1;
    // Drop any traversal walk + lit trail — the node/edge ids are about to change.
    if (this.traversalAnim) {
      this.scene.remove(this.traversalAnim.sprite);
      this.traversalAnim.sprite.material.dispose();
      this.traversalAnim = null;
    }
    this.traversalLitNodes.clear();
    this.traversalLitEdges.clear();
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
    } else {
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
    const points = new Points(geo, this.nodeMaterial);
    points.frustumCulled = false; // we manage culling; bounds change every tick
    points.renderOrder = 1; // draw nodes on top of edges
    this.nodeGeometry = geo;
    this.nodePoints = points;
    this.scene.add(points);
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
    if (this.edgeLines) this.edgeLines.renderOrder = order;
    if (this.superEdgeLines) this.superEdgeLines.renderOrder = order;
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
      const lit =
        hasTrail && this.traversalLitEdges.has(`${e.sourceId}-${e.targetId}`);
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
    this.lastEdgeRedraw = performance.now();
    this.requestRender();
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
      return;
    }
    const a = this.edgeAlphaArray;
    const enabled = this.edgesEnabled;
    const lod = this.lodEnabled && this.superList.length > 0;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      // Hot edges (chat traversal trail / highlight neighborhood) stay
      // visible even when the edge layer is off, the link type is hidden, or
      // LOD collapsed the region — "show me the path" beats the hide toggles
      // (highlighted NODES already get the same override in applyNodeStates).
      const hot =
        this.hasHighlight && this.edgeIsHot(`${e.sourceId}-${e.targetId}`);
      let alpha: number;
      if ((!enabled || this.hiddenLinkTypes.has(e.label)) && !hot) {
        alpha = 0;
      } else {
        const sVis = this.nodeArray[e.sourceIdx]?.visible ?? true;
        const tVis = this.nodeArray[e.targetIdx]?.visible ?? true;
        // Under LOD a detail edge only draws when BOTH endpoints' communities
        // are expanded; otherwise a super-edge represents the relationship.
        const lodHidden =
          lod &&
          (!this.nodeLodVisible(e.sourceId) ||
            !this.nodeLodVisible(e.targetId));
        if (!sVis || !tVis || (lodHidden && !hot)) {
          alpha = 0;
        } else if (this.hasHighlight) {
          alpha = hot ? EDGE_OPACITY_HIGHLIGHTED : EDGE_OPACITY_DIMMED;
        } else {
          alpha = EDGE_OPACITY_DEFAULT;
          // The radial tree reads through its DEFINES skeleton. Relational
          // chords (calls/imports) cross the whole map — on a real repo
          // (thousands of them) they drown the structure into a solid web,
          // so keep them faint until a highlight makes them relevant.
          if (this.currentLayoutMode === 'tree' && e.label !== 'DEFINES') {
            alpha *= 0.1;
          }
        }
      }
      a[i * 2] = alpha;
      a[i * 2 + 1] = alpha;
    }
    (this.edgeGeometry.getAttribute('aAlpha') as BufferAttribute).needsUpdate =
      true;
    this.rebuildEdgeDrawIndex();
  }

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
    if (this.edgeDrawIndex.length !== this.edges.length * 2) {
      this.edgeDrawIndex = new Uint32Array(this.edges.length * 2);
    }
    const eidx = this.edgeDrawIndex;
    const cull = this.bp.edgeViewportCulling && this.activeCamera != null;
    const mx = this.width * 0.25;
    const my = this.height * 0.25;
    let ec = 0;
    for (let i = 0; i < this.edges.length; i++) {
      if (a[i * 2] <= 0) continue;
      if (cull) {
        const e = this.edges[i];
        if (
          !this.nodeInView(e.sourceIdx, mx, my) &&
          !this.nodeInView(e.targetIdx, mx, my)
        ) {
          continue; // both endpoints off-screen → don't draw
        }
      }
      eidx[ec++] = i * 2;
      eidx[ec++] = i * 2 + 1;
    }
    this.setGeometryDrawIndex(this.edgeGeometry, eidx, ec);
    if (this.activeCamera)
      this.lastEdgeCullCamPos.copy(this.activeCamera.position);
    this.lastEdgeCull = performance.now();
    this.requestRender();
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

    // Preserve current positions for existing nodes.
    const wasUserMoved = this.hasUserMovedCamera;
    await this.setData(
      mergedNodes,
      mergedLinks,
      positions,
      nodeColors,
      nodeSizes,
      linkColors,
    );
    this.hasUserMovedCamera = wasUserMoved;
  }

  // ─── Position streaming ───────────────────────────────────────────

  /** Stride-3 Float64Array from the layout worker (x0,y0,z0,x1,y1,z1,...).
   *  z is 0 in 2D mode. */
  updatePositionsFromBuffer(buffer: Float64Array): void {
    const len = Math.min(this.nodeArray.length, Math.floor(buffer.length / 3));
    // During a build OR live-build the layout streams into layoutPos (the
    // animation's fly-out / follow targets) and the animation writes the
    // rendered posArray itself. Outside both, it writes posArray directly.
    const toTargets = this.buildAnim !== null || this.liveGrowActive;
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
    const toTargets = this.buildAnim !== null || this.liveGrowActive;
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
   *  become opaque enough to trace. A highlight forces full opacity so the
   *  selected neighborhood always stands out, and 3D stays opaque (depth
   *  already separates crossings). */
  private edgeOpacity(): number {
    // While a highlight/traversal is active, don't let a low user opacity
    // (e.g. Onion's 0%, Planet's 15%) kill the lit path — the per-edge alpha
    // already dims everything that isn't part of the highlight.
    const mult = this.hasHighlight
      ? Math.max(this.edgeOpacityMultiplier, 1)
      : this.edgeOpacityMultiplier;
    return this.edgeBaseOpacity() * mult;
  }

  /** The zoom/highlight-driven base opacity, before the user multiplier. */
  private edgeBaseOpacity(): number {
    if (this.hasHighlight) return 1;
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
   *  Multiplies the zoom-driven base; 1.0 = default behavior. */
  setEdgeOpacity(multiplier: number): void {
    this.edgeOpacityMultiplier = Math.max(0, Math.min(2, multiplier));
    this.requestRender();
  }
  private edgeOpacityMultiplier = 1;

  zoomToFit(duration = 300): void {
    if (this.mode3d) {
      this.reframe3D(this.computeBounds3D());
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
      pu.uZoom.value = cam.zoom;
    }
    pu.uSizeExp.value = this.zoomSizeExponent;

    // Swap every pickable Points to the picking material; hide the line layers
    // (they'd write garbage colors into the id buffer).
    const prevNodeMat = points.material;
    const prevSuperMat = this.superNodePoints?.material;
    const edgeWasVisible = this.edgeLines?.visible ?? false;
    const superEdgeWasVisible = this.superEdgeLines?.visible ?? false;
    points.material = this.pickingMaterial;
    if (this.superNodePoints)
      this.superNodePoints.material = this.pickingMaterial;
    if (this.edgeLines) this.edgeLines.visible = false;
    if (this.superEdgeLines) this.superEdgeLines.visible = false;

    const dpr = renderer.getPixelRatio();
    const buf = renderer.getDrawingBufferSize(this.tmpVec2);
    const px = Math.floor(screenX * dpr);
    // readRenderTargetPixels is bottom-up.
    const py = Math.floor(buf.y - screenY * dpr);

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

    // Restore display state + cached theme clear color.
    points.material = prevNodeMat;
    if (this.superNodePoints && prevSuperMat)
      this.superNodePoints.material = prevSuperMat;
    if (this.edgeLines) this.edgeLines.visible = edgeWasVisible;
    if (this.superEdgeLines) this.superEdgeLines.visible = superEdgeWasVisible;
    renderer.setClearColor(this.bgColor, 1);

    const id =
      this.pickPixel[0] + this.pickPixel[1] * 256 + this.pickPixel[2] * 65536;
    if (id <= 0) return -1;
    if (id > SUPER_PICK_OFFSET) return -(id - SUPER_PICK_OFFSET - 1) - 2;
    return id - 1;
  }

  /** Nearest visible edge to a world point, within `maxDist` world units.
   *  CPU point-to-segment over all edges — used for click selection (not
   *  per-mousemove). */
  private findEdgeAt(
    worldX: number,
    worldY: number,
    maxDist: number,
  ): ThreeEdge | null {
    if (this.edges.length === 0 || !this.edgesEnabled) return null;
    const pos = this.posArray;
    let best: ThreeEdge | null = null;
    let bestDist = maxDist;
    for (const e of this.edges) {
      if (this.hiddenLinkTypes.has(e.label)) continue;
      const s = e.sourceIdx;
      const t = e.targetIdx;
      if (!this.nodeArray[s].visible || !this.nodeArray[t].visible) continue;
      const sx = pos[s * 3];
      const sy = pos[s * 3 + 1];
      const tx = pos[t * 3];
      const ty = pos[t * 3 + 1];
      const d = pointToSegmentDist(worldX, worldY, sx, sy, tx, ty);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    return best;
  }

  private buildSelectedEdge(edge: ThreeEdge): SelectedEdge {
    return {
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.label,
      properties: edge.graphLink.properties,
      sourceNode: this.nodes.get(edge.sourceId)?.graphNode,
      targetNode: this.nodes.get(edge.targetId)?.graphNode,
    };
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
          if (idx !== -1) {
            // Node (idx >= 0) or super-node (idx <= -2) — both clickable.
            canvas.style.cursor = 'pointer';
          } else if (this.edgesEnabled && this.bp.edgeHoverHitTest) {
            const w = this.screenToWorld(
              e.clientX - rect.left,
              e.clientY - rect.top,
            );
            const hit = this.findEdgeAt(w.x, w.y, 8 / this.zoomForHit());
            canvas.style.cursor = hit ? 'pointer' : 'default';
          } else {
            canvas.style.cursor = 'default';
          }
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
          if (button === 0 && moved > CLICK_THRESHOLD) {
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
          // CPU edge hit-test only in 2D (screen→world plane is ill-defined
          // under perspective).
          const edge = this.mode3d
            ? null
            : this.findEdgeAt(
                this.screenToWorld(sx, sy).x,
                this.screenToWorld(sx, sy).y,
                8 / this.zoomForHit(),
              );
          if (edge) {
            this.callbacks.onEdgeClick?.(this.buildSelectedEdge(edge));
          } else {
            // Deliberately does NOT restart 3D auto-rotation: a click in the
            // void is how users dismiss a selection, and having the scene
            // start spinning on it read as a bug.
            this.callbacks.onStageClick?.();
          }
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

  /** Current px-per-world-unit, for converting a pixel hit radius to world. */
  private zoomForHit(): number {
    return this.camera?.zoom ?? 1;
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

  /** True if a node is "hot" — directly highlighted or reached by traversal. */
  private nodeIsHot(id: string): boolean {
    return this.highlightNodes.has(id) || this.traversalLitNodes.has(id);
  }

  /** True if an edge is "hot" — highlighted or crossed by the traversal. */
  private edgeIsHot(key: string): boolean {
    return this.highlightLinks.has(key) || this.traversalLitEdges.has(key);
  }

  /** Repack the per-node `aState` attribute from current visibility +
   *  highlight, then flag it for GPU upload. O(n) but only on state change,
   *  never per frame — the shader does the per-frame sizing/dimming. */
  private applyNodeStates(): void {
    if (!this.nodeGeometry) return;
    const st = this.stateArray;
    const lod = this.lodEnabled && this.superList.length > 0;
    if (this.nodeDrawIndex.length !== this.nodeArray.length) {
      this.nodeDrawIndex = new Uint32Array(this.nodeArray.length);
    }
    const drawIdx = this.nodeDrawIndex;
    let dc = 0;
    for (let i = 0; i < this.nodeArray.length; i++) {
      const node = this.nodeArray[i];
      // Under LOD, a node only draws when its community is expanded — except
      // highlighted nodes, which always show so search/chat focus survives.
      const highlighted = this.hasHighlight && this.nodeIsHot(node.id);
      const visible =
        node.visible && (!lod || highlighted || this.nodeLodVisible(node.id));
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
    }
    (this.nodeGeometry.getAttribute('aState') as BufferAttribute).needsUpdate =
      true;
    // Only submit the visible nodes to the GPU.
    this.setGeometryDrawIndex(this.nodeGeometry, drawIdx, dc);
    this.requestRender();
  }

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
    for (const node of this.nodeArray) {
      const vis = visibleIds.has(node.id);
      if (node.visible !== vis) {
        node.visible = vis;
        changed = true;
      }
    }
    if (!changed) return;
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
    if (
      now - this.lastCommunityUpdate > 250 ||
      this.communityCentroids.size === 0
    ) {
      this.lastCommunityUpdate = now;
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
    if (settled) {
      if (this.ambientEnabled && this.nodeArray.length > 0) {
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
      this.ambientEnabled && this.layoutSettled && this.nodeArray.length > 0;
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
    // Smoothly settle into the final framing (3D animates the reframe; 2D uses
    // the eased zoomToFit). This catches up any zoom the live follow didn't
    // finish when parsing was fast — no end snap.
    if (!this.hasUserMovedCamera) {
      if (this.mode3d) this.animateReframe3D();
      else this.zoomToFit(800);
    }
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
    const tgt = this.growTargetSize;
    const birth = this.growBirth;
    const parent = this.growParent;
    const a = GROW_FOLLOW_ALPHA;
    const n = this.nodeArray.length;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const p = (now - birth[i]) / GROW_REVEAL_MS;
      if (p >= 1) {
        sz[i] = tgt[i];
        pos[o] += (lp[o] - pos[o]) * a;
        pos[o + 1] += (lp[o + 1] - pos[o + 1]) * a;
        pos[o + 2] += (lp[o + 2] - pos[o + 2]) * a;
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
      this.nodeGeometry.setDrawRange(0, this.nodeArray.length);
      for (const a of ['position', 'aColor', 'aSize', 'aState', 'aPickColor']) {
        (this.nodeGeometry.getAttribute(a) as BufferAttribute).needsUpdate =
          true;
      }
    }
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
    this.edgeGeometry.setDrawRange(0, this.edges.length * 2);
    (this.edgeGeometry.getAttribute('aColor') as BufferAttribute).needsUpdate =
      true;
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
    this.requestRender();
  }

  /** Abort an in-flight build replay and snap to the final state. No-op if
   *  none is running. */
  stopBuildAnimation(): void {
    const anim = this.buildAnim;
    if (!anim) return;
    this.buildAnim = null;
    if (this.nodeGeometry) {
      this.posArray.set(this.layoutPos);
      this.sizeArray.set(anim.targetSize);
      (this.nodeGeometry.getAttribute('aSize') as BufferAttribute).needsUpdate =
        true;
      (
        this.nodeGeometry.getAttribute('position') as BufferAttribute
      ).needsUpdate = true;
    }
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

    // Orphans (disconnected finds) just flash where they are.
    if (orphanIds.length > 0) this.triggerPing(orphanIds);

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

    // Big result — light everything at once rather than animate for ages.
    if (edgeCount > TRAVERSAL_MAX_EDGES) {
      for (const leg of legs) {
        for (const e of leg.edges) {
          this.traversalLitEdges.add(`${e.sourceId}-${e.targetId}`);
          this.traversalLitEdges.add(`${e.targetId}-${e.sourceId}`);
          this.traversalLitNodes.add(e.sourceId);
          this.traversalLitNodes.add(e.targetId);
        }
      }
      this.refreshHotState();
      this.triggerPing(legs.map((l) => l.destId));
      return;
    }

    const perEdge = Math.max(
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
        newEdges.push({
          sourceIdx: s,
          targetIdx: t,
          edgeKey: `${e.sourceId}-${e.targetId}`,
          edgeKeyRev: `${e.targetId}-${e.sourceId}`,
          destId: e.targetId,
          startMs: cursor,
          durMs: perEdge,
          arrived: 0,
        });
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
        // Backlog is lagging the real tool-call progress — fast-forward it:
        // instantly light every still-pending edge, then restart the timeline
        // so only the fresh batch animates.
        for (const e of anim.edges) {
          if (e.arrived) continue;
          this.traversalLitEdges.add(e.edgeKey);
          this.traversalLitEdges.add(e.edgeKeyRev);
          this.traversalLitNodes.add(e.destId);
        }
        anim.start = now;
        anim.edges = newEdges;
        anim.duration = cursor;
        this.refreshHotState();
      } else {
        // Chain after the current walk so streamed legs play continuously.
        const base = anim.duration;
        for (const e of newEdges) e.startMs += base;
        anim.edges.push(...newEdges);
        anim.duration = base + cursor;
        if (seededAny) this.refreshHotState();
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
      // Light the seed anchors right away so the walk starts from a lit node.
      if (seededAny) this.refreshHotState();
    }
    this.requestRender();
  }

  /** Per-frame driver for the traversal pulse: positions the glow on the active
   *  edge, and as each edge completes, lights it + pings the node reached. */
  private updateTraversalAnim(now: number): void {
    const anim = this.traversalAnim;
    if (!anim || !this.scene) return;
    const elapsed = now - anim.start;

    let dirty = false;
    let active: TraversalEdge | null = null;
    let anyPending = false;
    for (const e of anim.edges) {
      if (elapsed >= e.startMs && elapsed < e.startMs + e.durMs) {
        active = e;
      }
      if (!e.arrived && elapsed >= e.startMs + e.durMs) {
        e.arrived = 1;
        this.traversalLitEdges.add(e.edgeKey);
        this.traversalLitEdges.add(e.edgeKeyRev);
        this.traversalLitNodes.add(e.destId);
        this.triggerPing([e.destId]);
        dirty = true;
      }
      if (!e.arrived) anyPending = true;
    }
    if (dirty) this.refreshHotState();
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
    }

    if (elapsed >= anim.duration) {
      this.scene.remove(anim.sprite);
      anim.sprite.material.dispose();
      this.traversalAnim = null;
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
    if (
      this.traversalLitNodes.size === 0 &&
      this.traversalLitEdges.size === 0
    ) {
      return;
    }
    this.traversalLitNodes.clear();
    this.traversalLitEdges.clear();
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
