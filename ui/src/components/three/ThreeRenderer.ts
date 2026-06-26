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
 * Architecture for 100k+ (see ui/src/components/pixi/PixiRenderer.ts for the
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
} from '../pixi/scaleBreakpoints';
import { computeBounds, type Viewport } from '../pixi/viewport';
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
  label: string;
  graphLink: GraphLink;
  color: string;
}

interface InteractionCallbacks {
  onNodeClick?: (node: GraphNode) => void;
  onEdgeClick?: (edge: SelectedEdge) => void;
  onStageClick?: () => void;
  onNodeDragStart?: (nodeId: string) => void;
  onNodeDragMove?: (nodeId: string, x: number, y: number) => void;
  onNodeDragEnd?: (nodeId: string) => void;
  on3DAutoRotateChange?: (autoRotate: boolean) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────

const CLICK_THRESHOLD = 5; // px — distinguish click from drag
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

  // ── Labels (HTML/CSS overlay) ──────────────────────────────────────
  private nodeLabelLayer: HTMLDivElement | null = null;
  private communityLabelLayer: HTMLDivElement | null = null;
  private nodeLabelEls: Map<string, HTMLDivElement> = new Map();
  private showAllLabels = true;
  private labelScaleMultiplier = 1.0;
  private showCommunityLabels = true;
  private currentLayoutMode: 'spread' | 'compact' | 'tree' = 'spread';
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
  private zoomSizeExponent = 0.8;
  /** Reference zoom that frames the whole graph — updated whenever a fit is
   *  computed. Used to scale edge opacity by how far the user has zoomed in
   *  relative to the overview. */
  private lastFitZoom = 1;
  /** Currently selected node id (for zoom-to-selection), or null. */
  private selectedNodeId: string | null = null;

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
      if (!this.needsRender && this.pingSprites.size === 0) return;
      this.needsRender = false;
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
    if (!this.needsRender && !easing && this.pingSprites.size === 0) return;
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

    // Candidate set: highlighted-only when a highlight is active, else all visible.
    const candidates: number[] = [];
    for (let i = 0; i < this.nodeArray.length; i++) {
      const node = this.nodeArray[i];
      if (!node.visible) continue;
      if (this.hasHighlight && !this.highlightNodes.has(node.id)) continue;
      candidates.push(i);
    }
    // Largest (highest-degree) nodes win label slots.
    candidates.sort((a, b) => this.nodeArray[b].size - this.nodeArray[a].size);

    const lm = this.labelScaleMultiplier;
    const labelH = (LABEL_SIZE + 4) * lm;
    const MARGIN = 80;
    const MIN_SPRITE_SCREEN_RADIUS = 2.5;
    const spriteRadiusFactor = Math.pow(
      zoom,
      Math.max(0, 1 - this.zoomSizeExponent),
    );

    // In 3D, only label nodes within a sphere around the camera. A label is an
    // HTML overlay with no depth, so a back-facing node's label would draw on
    // top of the nodes in front of it — the "labels showing through nodes"
    // problem. At an overview this is the front hemisphere (cut at the orbit
    // distance, +5% so equator nodes still label). But the cutoff is floored at
    // the cloud radius so zooming in — where the orbit distance shrinks toward
    // zero — doesn't collapse the labeled shell and strip labels off the very
    // nodes you're moving toward.
    const is3D = this.mode3d && !!this.perspCamera && !!this.controls;
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
      if (node.size * spriteRadiusFactor < MIN_SPRITE_SCREEN_RADIUS) continue;
      if (is3D) {
        const dx = this.posArray[i * 3] - camPos.x;
        const dy = this.posArray[i * 3 + 1] - camPos.y;
        const dz = this.posArray[i * 3 + 2] - camPos.z;
        if (dx * dx + dy * dy + dz * dz > frontDistSq) continue;
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
      const gapPx = node.size * spriteRadiusFactor + 4;
      const w = text.length * LABEL_SIZE * 0.6 * lm;
      const x = s.x + gapPx;
      const y = s.y - labelH / 2;

      let overlap = false;
      for (const b of boxes) {
        if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + labelH > b.y) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      boxes.push({ x, y, w, h: labelH });
      keep.add(node.id);
      this.ensureNodeLabel(node.id, text, x, s.y);
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

  /** Lightweight per-frame reposition of the already-chosen label set. */
  private syncNodeLabelPositions(): void {
    if (this.nodeLabelEls.size === 0 || !this.activeCamera) return;
    const zoom = this.effectiveZoom();
    const spriteRadiusFactor = Math.pow(
      zoom,
      Math.max(0, 1 - this.zoomSizeExponent),
    );
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
      const gapPx = node.size * spriteRadiusFactor + 4;
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
    for (const tex of this.glowTextures.values()) tex.dispose();
    this.glowTextures.clear();

    this.nodes.clear();
    this.nodeArray = [];
    this.nodeIdToIndex.clear();
    this.edges = [];

    const dom = this.renderer?.domElement;
    this.renderer?.dispose();
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
    this.posArray = new Float32Array(n * 3);
    this.colorArray = new Float32Array(n * 3);
    this.sizeArray = new Float32Array(n);
    this.stateArray = new Float32Array(n);
    this.pickColorArray = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const gn = graphNodes[i];
      const pos = positions.get(gn.id) ?? { x: 0, y: 0 };
      const color = nodeColors.get(gn.id) ?? FALLBACK_COLOR;
      const size = nodeSizes.get(gn.id) ?? 4;

      this.posArray[i * 3] = pos.x;
      this.posArray[i * 3 + 1] = pos.y;
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
    this.zoomToFit(0);
  }

  private buildEdges(
    graphLinks: GraphLink[],
    linkColors: Map<string, string>,
  ): void {
    this.edges = [];
    const seen = new Set<string>();
    for (const gl of graphLinks) {
      const sourceId =
        typeof gl.source === 'string' ? gl.source : (gl.source as GraphNode).id;
      const targetId =
        typeof gl.target === 'string' ? gl.target : (gl.target as GraphNode).id;
      if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) continue;
      const key = `${sourceId}-${gl.label}-${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.edges.push({
        sourceId,
        targetId,
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
    this.edgePosArray = new Float32Array(m * 2 * 3);
    this.edgeColorArray = new Float32Array(m * 2 * 3);
    this.edgeAlphaArray = new Float32Array(m * 2);
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.edgePosArray, 3));
    geo.setAttribute('aColor', new BufferAttribute(this.edgeColorArray, 3));
    geo.setAttribute('aAlpha', new BufferAttribute(this.edgeAlphaArray, 1));
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
    if (this.edgeMaterial) {
      this.edgeMaterial.depthTest = d;
      this.edgeMaterial.needsUpdate = true;
    }
    if (this.superEdgeMaterial) {
      this.superEdgeMaterial.depthTest = d;
      this.superEdgeMaterial.needsUpdate = true;
    }
    if (this.edgeLines) this.edgeLines.renderOrder = order;
    if (this.superEdgeLines) this.superEdgeLines.renderOrder = order;
    this.requestRender();
  }

  /** Write per-vertex edge colors from each edge's resolved link color. */
  private fillEdgeColors(): void {
    const col = this.edgeColorArray;
    for (let i = 0; i < this.edges.length; i++) {
      hexToRgb(this.edges[i].color, this.tmpColor);
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
    const idx = this.nodeIdToIndex;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      const s = idx.get(e.sourceId);
      const t = idx.get(e.targetId);
      const o = i * 6;
      if (s === undefined || t === undefined) {
        // Degenerate (shouldn't happen — edges are filtered at build time).
        ep[o] = ep[o + 1] = ep[o + 2] = 0;
        ep[o + 3] = ep[o + 4] = ep[o + 5] = 0;
        continue;
      }
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
    const a = this.edgeAlphaArray;
    const enabled = this.edgesEnabled;
    const lod = this.lodEnabled && this.superList.length > 0;
    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      let alpha: number;
      if (!enabled || this.hiddenLinkTypes.has(e.label)) {
        alpha = 0;
      } else {
        const sVis = this.nodes.get(e.sourceId)?.visible ?? true;
        const tVis = this.nodes.get(e.targetId)?.visible ?? true;
        // Under LOD a detail edge only draws when BOTH endpoints' communities
        // are expanded; otherwise a super-edge represents the relationship.
        const lodHidden =
          lod &&
          (!this.nodeLodVisible(e.sourceId) ||
            !this.nodeLodVisible(e.targetId));
        if (!sVis || !tVis || lodHidden) {
          alpha = 0;
        } else if (this.hasHighlight) {
          const hot = this.highlightLinks.has(`${e.sourceId}-${e.targetId}`);
          alpha = hot ? EDGE_OPACITY_HIGHLIGHTED : EDGE_OPACITY_DIMMED;
        } else {
          alpha = EDGE_OPACITY_DEFAULT;
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
    const idx = this.nodeIdToIndex;
    let ec = 0;
    for (let i = 0; i < this.edges.length; i++) {
      if (a[i * 2] <= 0) continue;
      if (cull) {
        const e = this.edges[i];
        const s = idx.get(e.sourceId);
        const t = idx.get(e.targetId);
        if (
          s !== undefined &&
          t !== undefined &&
          !this.nodeInView(s, mx, my) &&
          !this.nodeInView(t, mx, my)
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
    const pos = this.posArray;
    for (let i = 0; i < len; i++) {
      const o = i * 3;
      pos[o] = buffer[o];
      pos[o + 1] = buffer[o + 1];
      pos[o + 2] = buffer[o + 2];
    }
    this.markPositionsDirty();
  }

  updatePositions(positions: Map<string, { x: number; y: number }>): void {
    const pos = this.posArray;
    for (const [id, p] of positions) {
      const i = this.nodeIdToIndex.get(id);
      if (i === undefined) continue;
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
    }
    this.markPositionsDirty();
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
      const skipForSettle = this.bp.edgeAlphaGate && this.layoutSettled;
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
    return this.edgeBaseOpacity() * this.edgeOpacityMultiplier;
  }

  /** The zoom/highlight-driven base opacity, before the user multiplier. */
  private edgeBaseOpacity(): number {
    if (this.hasHighlight) return 1;
    if (this.mode3d) return 0.85;
    // Ratio of current zoom to the whole-graph fit zoom: 1 = full overview.
    const ratio = (this.camera?.zoom ?? 1) / Math.max(this.lastFitZoom, 1e-6);
    const MIN = 0.12; // overview — barely-there web
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
    const idx = this.nodeIdToIndex;
    let best: ThreeEdge | null = null;
    let bestDist = maxDist;
    for (const e of this.edges) {
      if (this.hiddenLinkTypes.has(e.label)) continue;
      const s = idx.get(e.sourceId);
      const t = idx.get(e.targetId);
      if (s === undefined || t === undefined) continue;
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

    canvas.addEventListener('contextmenu', (e) => e.preventDefault(), {
      signal,
    });

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        pointerDown = true;
        button = e.button;
        moved = 0;
        lastX = e.clientX;
        lastY = e.clientY;
        downPos = { x: e.clientX, y: e.clientY };
        this.pendingDragIndex = -1;
        this.dragNodeIndex = -1;
        // Node drag is a 2D affordance; in 3D OrbitControls owns left-drag.
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
        const rect = canvas.getBoundingClientRect();
        // Hover cursor (only when not dragging/panning) — throttled.
        if (!pointerDown) {
          const now = performance.now();
          if (now - lastHover < 50) return;
          lastHover = now;
          const idx = this.pickNodeIndexAt(
            e.clientX - rect.left,
            e.clientY - rect.top,
          );
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

        // In 3D, OrbitControls handles rotate/pan/dolly itself.
        if (this.mode3d) {
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
      if (!pointerDown) return;
      pointerDown = false;
      const rect = canvas.getBoundingClientRect();

      if (this.dragNodeIndex >= 0) {
        this.callbacks.onNodeDragEnd?.(this.nodeArray[this.dragNodeIndex].id);
        this.dragNodeIndex = -1;
        canvas.style.cursor = 'default';
      } else if (button === 0 && moved <= CLICK_THRESHOLD) {
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
            if (this.mode3d && !this.mode3dAutoRotate)
              this.set3DAutoRotate(true);
            this.callbacks.onStageClick?.();
          }
        }
      }
      this.pendingDragIndex = -1;
      downPos = null;
    };
    canvas.addEventListener('pointerup', onUp, { signal });
    canvas.addEventListener('pointerleave', onUp, { signal });
  }

  /** Current px-per-world-unit, for converting a pixel hit radius to world. */
  private zoomForHit(): number {
    return this.camera?.zoom ?? 1;
  }

  // ─── Visual state (filled across later phases) ────────────────────

  setHighlight(highlightNodes: Set<string>, highlightLinks: Set<string>): void {
    this.highlightNodes = highlightNodes;
    this.highlightLinks = highlightLinks;
    this.hasHighlight = highlightNodes.size > 0;
    this.applyNodeStates();
    this.updateEdgeAlpha();
    this.runNodeLabelCull();
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
      const highlighted = this.hasHighlight && this.highlightNodes.has(node.id);
      const visible =
        node.visible && (!lod || highlighted || this.nodeLodVisible(node.id));
      let s = visible ? NODE_STATE_VISIBLE : 0;
      if (this.hasHighlight && visible) {
        s |= this.highlightNodes.has(node.id)
          ? NODE_STATE_HIGHLIGHTED
          : NODE_STATE_DIMMED;
      }
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

  setLayoutMode(mode: 'spread' | 'compact' | 'tree'): void {
    if (this.currentLayoutMode === mode) return;
    this.currentLayoutMode = mode;
    // Geometry changed — let the community cull re-decide.
    this.communityVisibilityFrozen = false;
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

  setLayoutSettled(settled: boolean): void {
    this.layoutSettled = settled;
    // Refresh once on the transition so endpoints aren't left stale after the
    // throttle gate stops firing on settle.
    if (this.edgeLines && !this.edgesHiddenForInteraction) {
      this.updateEdgePositions();
    }
    // Build the LOD super-graph from the now-stable centroids.
    if (settled && this.lodEnabled) this.maybeBuildSuperGraph();
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
      controls.target.copy(center);
      controls.autoRotate = this.mode3dAutoRotate;
      controls.autoRotateSpeed = this.autoRotateSpeedFromRadians(
        this.mode3dSpeed,
      );
      // Any manual orbit pauses auto-rotation (mirrors Pixi).
      controls.addEventListener('start', () => {
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
      const screenR = node.size * Math.pow(zoom, 1 - this.zoomSizeExponent);
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
