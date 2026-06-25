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
 * Core Pixi.js graph renderer. Pure class — no React dependency.
 *
 * Scene graph: app.stage → world → [edgeBgGfx, edgeFgGfx, nodeContainer, labelContainer]
 *
 * Performance strategy (from reference implementation):
 * 1. Sprite batching — one circle texture per color
 * 2. Edge throttle — max 10fps (100ms interval)
 * 3. Edge hide during zoom/pan — 1300ms settle delay
 * 4. Drag culling — only draw dragged node's edges
 * 5. Alpha gate — skip when simulation nearly stopped
 * 6. Quadtree — O(log n) hover detection
 */

import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
} from 'pixi.js';
import { quadtree, type Quadtree } from 'd3-quadtree';
import type { Texture } from 'pixi.js';
import type { GraphNode, GraphLink } from '../graph/types';
import type { SelectedEdge } from '../types/graph';
import {
  getCircleTexture,
  getGlowTexture,
  clearTextureCache,
  CIRCLE_RADIUS,
} from './spriteTextures';
import {
  type Viewport,
  computeBounds,
  fitBounds,
  animateViewport,
  screenToWorld,
} from './viewport';
import {
  type PixiScaleBreakpoint,
  selectBreakpoint,
  DEFAULT_BREAKPOINTS,
} from './scaleBreakpoints';
import {
  NODE_OPACITY_DIMMED,
  NODE_SIZE_DIMMED_SCALE,
  NODE_SIZE_HIGHLIGHTED_SCALE,
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_HIGHLIGHTED,
  EDGE_OPACITY_DIMMED,
  LABEL_MAX_LENGTH,
  LABEL_SIZE,
  LABEL_FONT,
} from '../config/graphLayout';
import { getGraphThemeColors } from '../colors/graphThemeColors';

/** Strip control characters and truncate to MAX_LABEL_LENGTH. */
function cleanLabel(raw: string): string {
  const stripped = raw.replace(/[\n\r\t]+/g, ' ').trim();
  return stripped.length > LABEL_MAX_LENGTH
    ? stripped.slice(0, LABEL_MAX_LENGTH) + '…'
    : stripped;
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface PixiNode {
  id: string;
  graphNode: GraphNode;
  x: number;
  y: number;
  size: number;
  color: string;
  sprite: Sprite;
  label?: Text;
  visible: boolean;
}

export interface PixiEdge {
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
const QUADTREE_REBUILD_INTERVAL = 500; // ms
const EDGE_FALLBACK_COLOR = 0x3b4048;
const VIEWPORT_CULL_MARGIN = 0.1; // 10% margin outside viewport

/** Convert CSS hex color string ('#3b82f6') to numeric (0x3b82f6). */
function hexToNum(hex: string): number {
  if (hex.startsWith('#')) return parseInt(hex.slice(1), 16);
  return EDGE_FALLBACK_COLOR;
}

// ─── Geometry helpers for edge hit-testing ──────────────────────────────

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
    // Degenerate segment — just distance to the point
    const ex = px - ax;
    const ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // Project point onto the line, clamping t to [0,1]
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Approximate minimum distance from point to a quadratic Bézier curve.
 * Samples the curve at fixed intervals — fast enough for interactive use.
 */
function pointToQuadraticDist(
  px: number,
  py: number,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  curvature: number,
): number {
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return Math.sqrt((px - sx) ** 2 + (py - sy) ** 2);
  const offset = len * curvature;
  const cpx = mx + (-dy / len) * offset;
  const cpy = my + (dx / len) * offset;

  // Sample 10 segments along the curve
  const SAMPLES = 10;
  let best = Infinity;
  let prevX = sx;
  let prevY = sy;
  for (let i = 1; i <= SAMPLES; i++) {
    const u = i / SAMPLES;
    const inv = 1 - u;
    const cx = inv * inv * sx + 2 * inv * u * cpx + u * u * tx;
    const cy = inv * inv * sy + 2 * inv * u * cpy + u * u * ty;
    const d = pointToSegmentDist(px, py, prevX, prevY, cx, cy);
    if (d < best) best = d;
    prevX = cx;
    prevY = cy;
  }
  return best;
}

// ─── Renderer Class ─────────────────────────────────────────────────────

export class PixiRenderer {
  app: Application | null = null;
  private world: Container | null = null;
  private edgeBgGfx: Graphics | null = null;
  private edgeFgGfx: Graphics | null = null;
  private nodeContainer: Container | null = null;
  private rippleContainer: Container | null = null;
  private labelContainer: Container | null = null;
  /** Wayfinder layer (Fix #30): community names rendered at each
   *  cluster centroid. Visible only in compact layout mode — that's
   *  when the graph's spatial organization actually reflects community
   *  membership; in spread mode the centroids drift across the canvas
   *  and the names don't anchor anything useful. */
  private communityLabelContainer: Container | null = null;
  private communityLabels = new Map<number, Text>();
  private communityAssignments: Record<string, number> | null = null;
  private communityNames: Map<number, string> | null = null;
  private communityColorMap: Map<number, string> | null = null;
  /** Fingerprint of the sorted name set on the last rebuild. Used to
   *  short-circuit `setCommunityData` when Louvain reruns produce the
   *  same names under different community IDs (Fix #36). */
  private communityNamesFingerprint: string | null = null;
  /** Stickiness for community wayfinders (Fix #35). The cull prefers
   *  previously-shown communities so they don't blink in/out as rotation
   *  drifts their projected centroids in and out of overlap with
   *  neighbours. */
  private currentlyShownCommunities = new Set<number>();
  /** User toggle for community wayfinder visibility (Fix #52).
   *  Previously the labels were gated on `layoutMode === 'compact'`,
   *  which conflated "show labels" with "use compact layout". Now
   *  the two are independent: layout mode is changed via the bottom
   *  controls bar, this toggle just shows/hides the label layer. */
  private showCommunityLabels = true;
  /** Once true, the overlap cull stops re-running and the visible
   *  community set is held fixed (Fix #36). Positions still update
   *  every frame so labels track 3D rotation, but membership doesn't
   *  change — the user sees the same wayfinders all the way through a
   *  rotation. Cleared on data change, layout-mode flip, and 3D
   *  on/off, so the cull re-decides under a fresh frame of reference. */
  private communityVisibilityFrozen = false;
  private currentLayoutMode: 'spread' | 'compact' = 'spread';

  // Data
  private nodes: Map<string, PixiNode> = new Map();
  private nodeArray: PixiNode[] = []; // ordered array for indexed access (set at setData time)
  private nodeIdToIndex: Map<string, number> = new Map(); // id → index into nodeArray
  private edges: PixiEdge[] = [];
  private edgeIndex: Map<string, number[]> = new Map(); // nodeId → edge indices
  private edgeColorGroups: Map<string, number[]> = new Map(); // color → edge indices (pre-computed)

  // Viewport
  private vp: Viewport = { x: 0, y: 0, scale: 1 };
  private lastAppliedScale = 1; // vp.scale at last applyCounterScale — re-run on any zoom change
  private _lastEdgeScale = 1; // tracks vp.scale to avoid unnecessary edge redraws
  private width = 0;
  private height = 0;

  // Auto-fit state — keep the graph framed during indexing until user takes
  // control. Flipped to true by any gesture past CLICK_THRESHOLD (wheel,
  // pan, 3D rotate, node drag) and by zoomToNodes; reset by setData() (new
  // graph session) and resetCamera() (explicit "Reset View").
  private hasUserMovedCamera = false;
  /** Target viewport the auto-fit follower is easing the live `vp`
   *  toward, or null when no auto-fit is in flight (Fix #9). Set by
   *  `scheduleAutoFit()`; the ticker reads and interpolates each
   *  frame; cleared automatically when `vp` reaches the target. */
  private autoFitTarget: Viewport | null = null;
  /** Per-frame lerp weight used by the ticker's auto-fit follower.
   *  0.15 = ~95% of the way to a static target in ~18 frames (~0.3 s
   *  at 60fps), which matches the "feel" of the previous one-shot
   *  zoomToFit animation while gracefully tracking a moving target. */
  private readonly AUTO_FIT_FOLLOW_ALPHA = 0.15;
  /** Set by `setAutoFitSuspended()`. When true, `scheduleAutoFit()` is
   *  a no-op. PixiGraphCanvas uses this for the first few seconds of
   *  a layoutMode transition — positions haven't actually moved yet,
   *  so an early fit would just frame the OLD layout. */
  private autoFitSuspended = false;

  // Interaction state
  private _quadtree: Quadtree<PixiNode> | null = null;
  private lastQuadtreeRebuild = 0;
  private quadtreeDirty = false; // set true on position update, cleared on rebuild
  private dragNode: PixiNode | null = null;
  private pendingDragNode: PixiNode | null = null;
  private pointerDownPos: { x: number; y: number } | null = null;
  private callbacks: InteractionCallbacks = {};

  // Performance breakpoint — selected at setData() based on graph size
  private bp: PixiScaleBreakpoint = DEFAULT_BREAKPOINTS[0];
  private breakpoints: PixiScaleBreakpoint[] = DEFAULT_BREAKPOINTS;

  // Edge drawing state
  private lastEdgeRedraw = 0;
  private edgesEnabled = true;
  private hiddenLinkTypes: Set<string> = new Set();
  private layoutSettled = false; // set by consumer when worker reports settled
  private edgesHiddenForInteraction = false; // edges hidden during zoom/pan
  private interactionResumeTimer: ReturnType<typeof setTimeout> | null = null;

  // Highlight state
  private highlightNodes: Set<string> = new Set();
  private highlightLinks: Set<string> = new Set();
  private hasHighlight = false;

  // Ping animation state — maps node ID → animation state
  private pingNodes: Map<string, { startTime: number; glow: Sprite }> =
    new Map();
  private static readonly PING_DURATION = 1000; // ms
  private static readonly PING_SCALE = 1.8; // peak node scale multiplier
  private static readonly GLOW_SIZE = 3.5; // glow sprite scale relative to node

  // Show-all-labels mode (toggled from control panel)
  private showAllLabels = true;

  // Label scale multiplier — independent of node size (default 1.0)
  private labelScaleMultiplier = 1.0;

  // Debounced label re-culling
  private lastLabelCull = 0;
  private readonly LABEL_CULL_INTERVAL = 500; // ms (throttle for non-debounced calls)
  private labelCullDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly LABEL_CULL_DEBOUNCE = 300; // ms — wait for zoom/interaction to stop

  // Level-of-detail handoff: below this viewport zoom the community
  // wayfinders are at/near full strength (matches FADE_START_SCALE in
  // applyCommunityLabelCounterScale), so individual node labels are
  // suppressed and only community labels show. Above it, node labels
  // return and the wayfinders fade out.
  private readonly NODE_LABEL_MIN_VP_SCALE = 0.6;

  // Zoom-size exponent: controls how nodes/edges scale with zoom.
  // 0 = nodes scale fully with zoom (world-space), 1 = fixed screen size.
  // Default 0.5 matches ZOOM_SIZE_EXPONENT=0.7 feel.
  private zoomSizeExponent = 0.8;

  // ── 3D Rotation Mode ────────────────────────────────────────────────
  // Pseudo-3D: nodes get Z from community, camera rotates around Y axis
  // with perspective projection. Physics stays 2D.
  private mode3d = false;
  private mode3dAngle = 0; // Y-axis rotation (radians)
  private mode3dTilt = 0.35; // X-axis tilt (radians)
  private mode3dSpeed = 0.0015; // auto-rotation speed (radians/frame)
  private mode3dAutoRotate = true;
  private mode3dDepthScale = 800;
  private mode3dPerspectiveD = 2000; // perspective distance
  private nodeDepthT: Map<string, number> = new Map(); // per-node depth [-1, 1]
  private mode3dRadius = 0; // computed from node positions at enable time
  private mode3dFrameCounter = 0;

  // Animation cancel
  private cancelAnimation: (() => void) | null = null;

  // Init promise — all public methods that need the app await this
  private initPromise: Promise<void> | null = null;

  // Set to true when destroy() is called — prevents async _init() from continuing
  private destroyed = false;

  // Per-instance texture cache — avoids cross-renderer interference on destroy
  private textureCache: Map<string, Texture> = new Map();

  // AbortController for canvas event listeners — aborted on destroy()
  private interactionAbort: AbortController | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────

  init(container: HTMLElement, width: number, height: number): Promise<void> {
    this.initPromise = this._init(container, width, height);
    return this.initPromise;
  }

  private async _init(
    container: HTMLElement,
    width: number,
    height: number,
  ): Promise<void> {
    this.width = width;
    this.height = height;

    const app = new Application();
    const themeColors = getGraphThemeColors();
    try {
      await app.init({
        width,
        height,
        backgroundColor: hexToNum(themeColors.bg),
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
      });
    } catch (err) {
      if (
        err instanceof TypeError &&
        /dynamically imported module|importing a module script/i.test(
          err.message,
        )
      ) {
        window.location.reload();
        return;
      }
      throw err;
    }

    // Guard: if destroy() was called while init was pending, don't proceed
    if (this.destroyed) {
      app.destroy({ removeView: true });
      return;
    }

    this.app = app;
    container.appendChild(app.canvas);

    // Scene graph
    const world = new Container();
    app.stage.addChild(world);
    this.world = world;

    const edgeBgGfx = new Graphics();
    world.addChild(edgeBgGfx);
    this.edgeBgGfx = edgeBgGfx;

    const edgeFgGfx = new Graphics();
    world.addChild(edgeFgGfx);
    this.edgeFgGfx = edgeFgGfx;

    const nodeContainer = new Container();
    nodeContainer.sortableChildren = true;
    world.addChild(nodeContainer);
    this.nodeContainer = nodeContainer;

    const rippleContainer = new Container();
    world.addChild(rippleContainer);
    this.rippleContainer = rippleContainer;

    const labelContainer = new Container();
    labelContainer.sortableChildren = true;
    world.addChild(labelContainer);
    this.labelContainer = labelContainer;

    // Community wayfinder labels go on top of node labels — they're
    // larger and act as area markers (Fix #30).
    const communityLabelContainer = new Container();
    communityLabelContainer.visible = false;
    world.addChild(communityLabelContainer);
    this.communityLabelContainer = communityLabelContainer;

    // Viewport centered
    this.vp = { x: width / 2, y: height / 2, scale: 1 };
    this.lastAppliedScale = 1;

    // Render loop — apply viewport transform + counter-scale sprites + 3D
    app.ticker.add(() => {
      if (!this.world) return;
      // Auto-fit follower (Fix #9). Replaces the previous one-shot
      // animateViewport for auto-fit — instead of N discrete animations
      // that the user perceives as zoom thrash, we continuously ease
      // the live viewport toward `autoFitTarget`. The target itself is
      // refreshed from the latest node positions whenever
      // `scheduleAutoFit()` is called; if it moves while we're easing,
      // the camera silently re-aims without ever cancelling/restarting
      // an animation. Manual `zoomToFit()` clears `autoFitTarget` and
      // runs a snappy one-shot animation for predictable button feel.
      if (this.autoFitTarget && !this.hasUserMovedCamera) {
        const target = this.autoFitTarget;
        const alpha = this.AUTO_FIT_FOLLOW_ALPHA;
        this.vp = {
          x: this.vp.x + (target.x - this.vp.x) * alpha,
          y: this.vp.y + (target.y - this.vp.y) * alpha,
          scale: this.vp.scale + (target.scale - this.vp.scale) * alpha,
        };
        // Snap + clear when essentially at target — avoids floating-
        // point noise keeping the easer alive forever.
        const dx = Math.abs(target.x - this.vp.x);
        const dy = Math.abs(target.y - this.vp.y);
        const dScale = Math.abs(target.scale - this.vp.scale);
        if (dx < 0.5 && dy < 0.5 && dScale < 0.0005) {
          this.vp = target;
          this.autoFitTarget = null;
        }
        // Don't re-cull labels on each follower ease step (Fix #48).
        // The follower fires per-frame during physics settling and
        // layout-mode transitions; running the cull there reshuffles
        // labels in response to physics, which the user reads as
        // blinking. Sprites/labels still get re-sized for the new
        // scale; only the visibility decision is held.
        this.applyCounterScale(false);
      }
      this.world.position.set(this.vp.x, this.vp.y);
      this.world.scale.set(this.vp.scale);

      // 3D mode: project all nodes every frame (overrides normal position updates)
      if (this.mode3d) {
        this.update3D();
        // No label-cull trigger from the ticker (Fix #37). Rotation
        // — auto or manual — must never reshuffle the visible label
        // set, and even small vp.scale drift counts as a "zoom
        // change" because the auto-fit follower re-aims the camera
        // every worker tick as the sphere's projected silhouette
        // changes shape with the rotation. The wheel handler still
        // calls `debouncedLabelCull()` directly on real user zoom,
        // so deliberate zoom updates are covered.
        // We still bookkeep `_lastEdgeScale` so the 2D path stays
        // consistent if the user toggles back.
        this._lastEdgeScale = this.vp.scale;
        // Re-scale community wayfinders for the current zoom (Fix
        // #51). Without this, 3D mode skips `applyCounterScale`
        // entirely, so the community labels stay at whatever scale
        // they were last rendered at — when the user zooms in after
        // entering 3D the labels look huge because their scale was
        // computed for the original zoom-out vp.scale.
        this.applyCommunityLabelCounterScale();
        this.applyPingAnimations();
        return; // skip counter-scale — 3D handles its own scaling
      }

      // Re-apply counter-scale + label cull whenever the zoom changes.
      // Gate on vp.scale itself, NOT zoomInvScale(): at zoomSizeExponent
      // 0 the latter is (1/vp.scale)^0 === 1, constant, so the old gate
      // never fired mid-zoom — labels were neither counter-scaled (they
      // ballooned/shrank with the world) nor culled (they over-crowded)
      // until the 300ms debounce. Labels always counter-scale at
      // exponent 1 regardless of the sprite exponent, so the trigger must
      // track vp.scale. For any exponent > 0 this fires on the same
      // frames as before. Exponent changes call applyCounterScale()
      // directly via setZoomSizeExponent(), so they stay covered.
      if (this.vp.scale !== this.lastAppliedScale) {
        this.applyCounterScale();
      }

      this.applyPingAnimations();
    });

    // Pointer events on the canvas — cleaned up via AbortController in destroy()
    this.interactionAbort = new AbortController();
    this.setupInteraction(app.canvas, this.interactionAbort.signal);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.app?.renderer.resize(width, height);
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelAnimation?.();
    if (this.interactionResumeTimer !== null) {
      clearTimeout(this.interactionResumeTimer);
      this.interactionResumeTimer = null;
    }
    if (this.labelCullDebounceTimer !== null) {
      clearTimeout(this.labelCullDebounceTimer);
      this.labelCullDebounceTimer = null;
    }
    this.autoFitTarget = null;
    this.interactionAbort?.abort();
    this.interactionAbort = null;
    clearTextureCache(this.textureCache);
    for (const ping of this.pingNodes.values()) ping.glow.destroy();
    this.pingNodes.clear();
    // Pixi's app.destroy({children:true}) recursively destroys all
    // labels — just drop our refs.
    this.communityLabels.clear();
    this.communityAssignments = null;
    this.communityNames = null;
    this.nodes.clear();
    this.nodeArray = [];
    this.nodeIdToIndex.clear();
    this.edges = [];
    this.edgeIndex.clear();
    this.edgeColorGroups.clear();
    if (this.app) {
      try {
        this.app.destroy(
          { removeView: true },
          { children: true, texture: true },
        );
      } catch {
        // Fallback for different Pixi versions
        try {
          this.app.destroy(true, { children: true });
        } catch {
          /* ignore */
        }
      }
    }
    this.app = null;
    this.world = null;
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
    // Wait for init to complete before touching the scene graph
    if (this.initPromise) await this.initPromise;
    if (
      this.destroyed ||
      !this.app ||
      !this.nodeContainer ||
      !this.labelContainer
    )
      return;

    // Clear previous
    this.nodeContainer.removeChildren();
    this.labelContainer.removeChildren();
    this.nodes.clear();
    this.nodeArray = [];
    this.nodeIdToIndex.clear();
    this.edges = [];
    this.edgeIndex.clear();

    // A fresh graph starts a new auto-fit session — forget any prior pan/zoom.
    this.hasUserMovedCamera = false;

    // Build nodes
    for (const gn of graphNodes) {
      const pos = positions.get(gn.id) ?? { x: 0, y: 0 };
      const color = nodeColors.get(gn.id) ?? '#888888';
      const size = nodeSizes.get(gn.id) ?? 4;
      const tex = getCircleTexture(this.app, color, this.textureCache);

      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      sprite.scale.set(size / CIRCLE_RADIUS); // applyCounterScale() adjusts after zoomToFit
      sprite.alpha = 0.9;
      sprite.position.set(pos.x, pos.y);
      this.nodeContainer.addChild(sprite);

      const node: PixiNode = {
        id: gn.id,
        graphNode: gn,
        x: pos.x,
        y: pos.y,
        size,
        color,
        sprite,
        visible: true,
      };
      this.nodeIdToIndex.set(gn.id, this.nodeArray.length);
      this.nodeArray.push(node);
      this.nodes.set(gn.id, node);
    }

    // Build edges and edge index
    const seenEdges = new Set<string>();
    for (const gl of graphLinks) {
      const sourceId =
        typeof gl.source === 'string' ? gl.source : (gl.source as GraphNode).id;
      const targetId =
        typeof gl.target === 'string' ? gl.target : (gl.target as GraphNode).id;
      if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) continue;
      const key = `${sourceId}-${gl.label}-${targetId}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);

      const idx = this.edges.length;
      this.edges.push({
        sourceId,
        targetId,
        label: gl.label,
        graphLink: gl,
        color: linkColors.get(gl.label) ?? '#3b4048',
      });

      // Index: source → edge indices
      let sIdx = this.edgeIndex.get(sourceId);
      if (!sIdx) {
        sIdx = [];
        this.edgeIndex.set(sourceId, sIdx);
      }
      sIdx.push(idx);
      let tIdx = this.edgeIndex.get(targetId);
      if (!tIdx) {
        tIdx = [];
        this.edgeIndex.set(targetId, tIdx);
      }
      tIdx.push(idx);
    }

    // Pre-group edges by color for batched rendering
    this.edgeColorGroups.clear();
    for (let i = 0; i < this.edges.length; i++) {
      const color = this.edges[i].color;
      let group = this.edgeColorGroups.get(color);
      if (!group) {
        group = [];
        this.edgeColorGroups.set(color, group);
      }
      group.push(i);
    }

    // Select performance breakpoint based on graph size
    this.bp = selectBreakpoint(graphNodes.length, this.breakpoints);

    this.layoutSettled = false;

    // Initial edge draw
    this.redrawAllEdges();

    // Build quadtree
    this.rebuildQuadtree();

    // Fit to screen — then immediately counter-scale sprites for the new zoom
    this.zoomToFit(0);
    this.applyCounterScale();
  }

  /**
   * Incrementally add new nodes and edges without touching existing sprites.
   */
  async addData(
    newNodes: GraphNode[],
    newLinks: GraphLink[],
    positions: Map<string, { x: number; y: number }>,
    nodeColors: Map<string, string>,
    nodeSizes: Map<string, number>,
    linkColors: Map<string, string>,
  ): Promise<void> {
    if (this.initPromise) await this.initPromise;
    if (
      this.destroyed ||
      !this.app ||
      !this.nodeContainer ||
      !this.labelContainer
    )
      return;

    // Add only nodes not already present
    for (const gn of newNodes) {
      if (this.nodes.has(gn.id)) continue;

      const pos = positions.get(gn.id) ?? { x: 0, y: 0 };
      const color = nodeColors.get(gn.id) ?? '#888888';
      const size = nodeSizes.get(gn.id) ?? 4;
      const tex = getCircleTexture(this.app, color, this.textureCache);

      const sprite = new Sprite(tex);
      sprite.anchor.set(0.5);
      sprite.scale.set(size / CIRCLE_RADIUS);
      sprite.alpha = 0.9;
      sprite.position.set(pos.x, pos.y);
      this.nodeContainer.addChild(sprite);

      const node: PixiNode = {
        id: gn.id,
        graphNode: gn,
        x: pos.x,
        y: pos.y,
        size,
        color,
        sprite,
        visible: true,
      };
      this.nodeIdToIndex.set(gn.id, this.nodeArray.length);
      this.nodeArray.push(node);
      this.nodes.set(gn.id, node);
    }

    // Add only edges not already present
    const existingEdgeKeys = new Set(
      this.edges.map((e) => `${e.sourceId}-${e.label}-${e.targetId}`),
    );
    for (const gl of newLinks) {
      const sourceId =
        typeof gl.source === 'string' ? gl.source : (gl.source as GraphNode).id;
      const targetId =
        typeof gl.target === 'string' ? gl.target : (gl.target as GraphNode).id;
      if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) continue;
      const key = `${sourceId}-${gl.label}-${targetId}`;
      if (existingEdgeKeys.has(key)) continue;
      existingEdgeKeys.add(key);

      const idx = this.edges.length;
      this.edges.push({
        sourceId,
        targetId,
        label: gl.label,
        graphLink: gl,
        color: linkColors.get(gl.label) ?? '#3b4048',
      });

      let sIdx = this.edgeIndex.get(sourceId);
      if (!sIdx) {
        sIdx = [];
        this.edgeIndex.set(sourceId, sIdx);
      }
      sIdx.push(idx);
      let tIdx = this.edgeIndex.get(targetId);
      if (!tIdx) {
        tIdx = [];
        this.edgeIndex.set(targetId, tIdx);
      }
      tIdx.push(idx);

      const color = linkColors.get(gl.label) ?? '#3b4048';
      let group = this.edgeColorGroups.get(color);
      if (!group) {
        group = [];
        this.edgeColorGroups.set(color, group);
      }
      group.push(idx);
    }

    this.bp = selectBreakpoint(this.nodeArray.length, this.breakpoints);
    this.layoutSettled = false;
    this.redrawAllEdges();
    this.rebuildQuadtree();
    this.applyCounterScale();
  }

  /**
   * Compute the inverse-scale factor for sprites/labels, adjusted by zoom exponent.
   * At exponent 1: fully cancels world zoom (fixed screen size).
   * At exponent 0: no cancellation (world-space scaling).
   */
  private zoomInvScale(): number {
    // exponent 1 = fixed screen size (fully cancel world zoom)
    // exponent 0 = full world-space (no cancellation — nodes scale with zoom)
    // Simplified: (1/vpScale)^exponent
    return Math.pow(1 / this.vp.scale, this.zoomSizeExponent);
  }

  /**
   * Inverse-scale for labels only — always fully cancels viewport zoom
   * (equivalent to exponent=1) so labels stay at constant screen-pixel size.
   * The separate labelScaleMultiplier controls user-adjustable sizing.
   */
  private labelInvScale(): number {
    return 1 / this.vp.scale;
  }

  /**
   * World-space gap from a node's sprite center to the left edge of its
   * label. Sized so the on-screen gap (gap × vp.scale) equals the sprite's
   * actual on-screen radius plus a small breathing margin — the label
   * stays glued to the sprite edge at every zoom level (Fix #27).
   *
   * Sprite screen radius = `node.size × vp.scale^(1 − zoomSizeExponent)`.
   * Translating that back to world units (dividing by vp.scale) gives:
   *   gap = node.size × vp.scale^(−exp) + LABEL_EDGE_MARGIN / vp.scale
   *       = node.size × zoomInvScale + LABEL_EDGE_MARGIN / vp.scale
   *
   * All 2D label position writes and the cull's overlap rect MUST use
   * this same formula — historically they diverged (cull used
   * `zoomInvScale`, render used `labelInvScale`) which made labels
   * jitter by 2–3 character widths as zoom changed.
   */
  private labelGap(node: PixiNode): number {
    return node.size * this.zoomInvScale() + 4 / this.vp.scale;
  }

  /** Counter-scale all sprites, labels, and edges for current viewport scale.
   *
   * `cull` controls whether the visible label set is re-evaluated.
   * - `true` (default) — call from user-zoom paths (wheel, ticker
   *   zoom-change check, imperative setX, initial setData). Recomputes
   *   which labels survive overlap based on the new scale, exactly
   *   what the user wants on zoom.
   * - `false` — call from the auto-fit follower in the ticker (Fix #48).
   *   The follower eases vp.scale every frame during physics settling
   *   and layout-mode transitions; running the cull on each ease step
   *   reshuffles labels in response to physics, not zoom — visible to
   *   the user as label blinking. Skip the cull on those frames; the
   *   sprite/label scaling still happens so things look right at the
   *   new scale, just the *which-labels-are-visible* decision stays
   *   put until a user actually zooms.
   */
  private applyCounterScale(cull = true): void {
    const invScale = this.zoomInvScale();
    const wantLabel: PixiNode[] = [];

    for (const node of this.nodes.values()) {
      if (!node.visible) continue;
      // In 3D mode, skip sprite scale — the ticker's update3D() handles it.
      if (!this.mode3d) {
        const s = this.highlightBaseSize(node);
        node.sprite.scale.set((s / CIRCLE_RADIUS) * invScale);
      }

      if (!this.showAllLabels) {
        if (node.label) node.label.visible = false;
      } else if (this.hasHighlight) {
        if (this.highlightNodes.has(node.id)) {
          wantLabel.push(node);
        } else if (node.label) {
          node.label.visible = false;
        }
      } else {
        wantLabel.push(node);
      }
    }

    const lblInv = this.labelInvScale();
    if (cull) {
      this.applyLabelCulling(wantLabel, lblInv);
    }

    // Update scale + position for visible labels (skip in 3D — ticker handles it)
    if (!this.mode3d) {
      const lm = this.labelScaleMultiplier;
      for (const node of wantLabel) {
        if (!node.label?.visible) continue;
        node.label.scale.set(lblInv * lm);
        const gap = this.labelGap(node);
        node.label.position.set(
          node.sprite.position.x + gap,
          node.sprite.position.y,
        );
      }
    }

    // Only redraw edges if scale actually changed (edge widths depend on zoom).
    // Skip if this is just an exponent change at the same zoom level —
    // edge geometry hasn't changed, only sprite sizes.
    //
    // Skip while edges are hidden for interaction (Fix #24). The wheel
    // handler hides the edge layer for instant zoom response, but the
    // ticker still drives `applyCounterScale` per frame the scale
    // changes — and the original code redrew 15 k+ edges into an
    // invisible Graphics object on each of those frames, blocking the
    // main thread enough that the zoom itself stuttered. The 3D path
    // already had this guard; the 2D path was missing it. The
    // `showEdgesAfterInteraction` path re-draws once on resume so we
    // don't strand the geometry stale.
    const scaleChanged = this.vp.scale !== this._lastEdgeScale;
    this.lastAppliedScale = this.vp.scale;
    if (scaleChanged && !this.edgesHiddenForInteraction) {
      this._lastEdgeScale = this.vp.scale;
      this.redrawAllEdges();
    }

    // Keep community wayfinder labels at constant screen size (Fix #32).
    this.applyCommunityLabelCounterScale();
  }

  /**
   * Apply ping (pulse + glow) animations to newly highlighted nodes.
   * Node scale pops then settles; glow sprite fades in then out.
   */
  private applyPingAnimations(): void {
    if (this.pingNodes.size === 0) return;
    const now = performance.now();
    const invScale = this.zoomInvScale();
    const expired: string[] = [];

    for (const [id, ping] of this.pingNodes) {
      const elapsed = now - ping.startTime;
      if (elapsed >= PixiRenderer.PING_DURATION) {
        expired.push(id);
        continue;
      }
      const node = this.nodes.get(id);
      if (!node?.visible) {
        expired.push(id);
        continue;
      }

      // t goes 0→1 over the duration
      const t = elapsed / PixiRenderer.PING_DURATION;

      // ── Scale pulse: sharp pop then smooth settle ──
      const pulse = Math.sin(Math.PI * t) * (1 - t);
      const pingScale = 1 + (PixiRenderer.PING_SCALE - 1) * pulse;
      const baseSize = this.highlightBaseSize(node);
      node.sprite.scale.set((baseSize / CIRCLE_RADIUS) * invScale * pingScale);

      // ── Glow: follow the sprite's actual position (handles 3D projection) ──
      const glow = ping.glow;
      glow.position.copyFrom(node.sprite.position);
      // Scale the glow relative to node size
      const glowScale =
        (baseSize / CIRCLE_RADIUS) * invScale * PixiRenderer.GLOW_SIZE;
      glow.scale.set(glowScale * (1 + 0.3 * pulse)); // breathe slightly
      // Alpha envelope: quick ramp up (0→0.15), hold, then fade out
      const alphaIn = Math.min(1, t * 5); // 0→1 over first 20% of duration
      const alphaOut = Math.max(0, 1 - (t - 0.5) * 2); // 1→0 over last 50%
      glow.alpha = 0.65 * Math.min(alphaIn, alphaOut);
    }

    for (const id of expired) {
      const ping = this.pingNodes.get(id);
      if (ping) {
        ping.glow.destroy();
        this.pingNodes.delete(id);
      }
    }
  }

  // ─── Position Updates (called from simulation tick) ───────────────

  updatePositions(positions: Map<string, { x: number; y: number }>): void {
    for (const [id, pos] of positions) {
      const node = this.nodes.get(id);
      if (!node || !node.visible) continue;
      node.x = pos.x;
      node.y = pos.y;
      // In 3D mode the ticker handles sprite positioning via projection each frame.
      if (!this.mode3d) {
        node.sprite.position.set(pos.x, pos.y);
        if (node.label?.visible) {
          const gap = this.labelGap(node);
          node.label.position.set(pos.x + gap, pos.y);
        }
      }
    }

    this.postPositionUpdate();
  }

  /**
   * Update positions from a Float64Array buffer (indexed by node order from setData).
   * Avoids Map lookups — pure indexed array access for maximum throughput at 20k+ nodes.
   */
  updatePositionsFromBuffer(buffer: Float64Array): void {
    const arr = this.nodeArray;
    const len = Math.min(arr.length, buffer.length / 2);

    // Always update stored (x, y) — these are the 2D physics positions
    for (let i = 0; i < len; i++) {
      arr[i].x = buffer[i * 2];
      arr[i].y = buffer[i * 2 + 1];
    }

    // In 3D mode, the ticker handles sprite positioning via projection.
    // Just store the 2D positions and let postPositionUpdate run.
    if (!this.mode3d) {
      for (let i = 0; i < len; i++) {
        const node = arr[i];
        if (!node.visible) continue;
        node.sprite.position.set(node.x, node.y);
        if (node.label?.visible) {
          const gap = this.labelGap(node);
          node.label.position.set(node.x + gap, node.y);
        }
      }
    }

    this.postPositionUpdate();
  }

  /** Shared tail for position updates: throttled edge redraw + quadtree rebuild. */
  private postPositionUpdate(): void {
    this.quadtreeDirty = true;

    // Throttled edge redraw — skip entirely when settled (if alpha-gated)
    const now = performance.now();
    const skipForSettle = this.bp.edgeAlphaGate && this.layoutSettled;
    if (
      !skipForSettle &&
      now - this.lastEdgeRedraw >= this.bp.edgeRedrawInterval
    ) {
      if (this.dragNode) {
        this.redrawDragEdges(this.dragNode);
      } else {
        this.redrawAllEdges();
      }
    }

    // Throttled quadtree rebuild — skip if positions haven't changed
    if (
      this.quadtreeDirty &&
      now - this.lastQuadtreeRebuild > QUADTREE_REBUILD_INTERVAL
    ) {
      this.rebuildQuadtree();
      this.quadtreeDirty = false;
    }

    // Re-track community wayfinder centroids while the layout is moving
    // (Fix #32). Throttled — recomputing centroids every worker tick on
    // 8 k nodes is wasted work; 250 ms is more than smooth enough since
    // the labels are at cluster scale.
    if (
      this.showCommunityLabels &&
      this.communityLabels.size > 0 &&
      now - this.lastCommunityCentroidUpdate > 250
    ) {
      this.lastCommunityCentroidUpdate = now;
      this.updateCommunityLabelPositions();
    }
  }
  private lastCommunityCentroidUpdate = 0;

  // ─── Visual State ─────────────────────────────────────────────────

  setHighlight(highlightNodes: Set<string>, highlightLinks: Set<string>): void {
    this.highlightNodes = highlightNodes;
    this.highlightLinks = highlightLinks;
    this.hasHighlight = highlightNodes.size > 0;
    this.applyVisuals();
  }

  /** Trigger a ping/glow animation on the given node IDs (replays even if already highlighted). */
  triggerPing(nodeIds: Iterable<string>): void {
    if (!this.app) return;
    const now = performance.now();
    const triggered: string[] = [];
    const missed: string[] = [];
    for (const id of nodeIds) {
      // Remove existing ping so it replays
      const existing = this.pingNodes.get(id);
      if (existing) {
        existing.glow.destroy();
        this.pingNodes.delete(id);
      }
      const node = this.nodes.get(id);
      if (!node) {
        missed.push(id);
        continue;
      }
      triggered.push(id);
      const tex = getGlowTexture(this.app, node.color, this.textureCache);
      const glow = new Sprite(tex);
      glow.anchor.set(0.5);
      glow.position.copyFrom(node.sprite.position);
      glow.alpha = 0;
      this.rippleContainer?.addChild(glow);
      this.pingNodes.set(id, { startTime: now, glow });
    }
    console.log('[PixiRenderer] triggerPing', {
      triggered: triggered.length,
      missed: missed.length,
      missedIds: missed.slice(0, 3),
    });
  }

  setNodeVisibility(visibleIds: Set<string>): void {
    // Detect whether the visible set actually changed (Fix #38). The
    // wiring effect in PixiGraphCanvas re-fires this on every Louvain
    // rerun because `communityData.assignments` is in its dep list —
    // but the resulting visible-id set is usually identical (Louvain
    // renames communities, doesn't change which nodes pass the
    // filter). Treating every fire as a real change re-culled the
    // labels, which the user sees as random label churn while physics
    // is running.
    let changed = false;
    for (const node of this.nodes.values()) {
      const vis = visibleIds.has(node.id);
      if (node.visible !== vis) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    for (const [id, node] of this.nodes) {
      const vis = visibleIds.has(id);
      node.visible = vis;
      node.sprite.visible = vis;
      // Hide labels for hidden nodes; visible nodes get re-culled below
      if (!vis && node.label) node.label.visible = false;
    }
    // Re-cull labels for the new visible set
    if (this.showAllLabels) {
      const lblInv = this.labelInvScale();
      const wantLabel: PixiNode[] = [];
      for (const node of this.nodes.values()) {
        if (node.visible) wantLabel.push(node);
      }
      this.applyLabelCulling(wantLabel, lblInv);
    }
    if (!this.mode3d) {
      this.redrawAllEdges();
    }
  }

  updateNodeColors(nodeColors: Map<string, string>): void {
    if (!this.app) return;
    for (const [id, color] of nodeColors) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.color = color;
      node.sprite.texture = getCircleTexture(
        this.app,
        color,
        this.textureCache,
      );
    }
  }

  /** Update link colors and re-group for batched rendering. */
  updateLinkColors(linkColors: Map<string, string>): void {
    if (!this.app) return;
    for (const edge of this.edges) {
      edge.color = linkColors.get(edge.label) ?? '#3b4048';
    }
    // Re-group edges by color for batched rendering
    this.edgeColorGroups.clear();
    for (let i = 0; i < this.edges.length; i++) {
      const color = this.edges[i].color;
      let group = this.edgeColorGroups.get(color);
      if (!group) {
        group = [];
        this.edgeColorGroups.set(color, group);
      }
      group.push(i);
    }
    this.redrawAllEdges();
  }

  /** Re-read graph CSS variables and update canvas background + label styles. */
  setThemeColors(): void {
    if (!this.app) return;
    const themeColors = getGraphThemeColors();

    // Update Pixi canvas background
    this.app.renderer.background.color = hexToNum(themeColors.bg);

    // Update all existing label styles
    for (const node of this.nodes.values()) {
      if (!node.label) continue;
      const s = node.label.style;
      s.fill = themeColors.labelColor;
      if (s.dropShadow && typeof s.dropShadow === 'object') {
        s.dropShadow = {
          ...s.dropShadow,
          color: themeColors.labelShadow,
        };
      }
    }
  }

  /** Effective base sprite size for a node given the current highlight
   *  state: enlarged when it's a highlighted node so it pops, shrunk when
   *  it's dimmed by another node's highlight, unchanged otherwise. Used by
   *  every sprite-sizing path (applyVisuals, applyCounterScale, ping, 3D)
   *  so the highlight emphasis stays consistent across zoom and modes. */
  private highlightBaseSize(node: PixiNode): number {
    if (!this.hasHighlight) return node.size;
    return this.highlightNodes.has(node.id)
      ? node.size * NODE_SIZE_HIGHLIGHTED_SCALE
      : node.size * NODE_SIZE_DIMMED_SCALE;
  }

  private applyVisuals(): void {
    if (!this.app) return;
    const invScale = this.zoomInvScale();

    // Pass 1: update sprites + determine which labels want to show
    // In 3D mode, skip sprite scale/alpha — the ticker's update3D() handles those.
    const wantLabel: PixiNode[] = [];
    for (const [id, node] of this.nodes) {
      if (!node.visible) continue;

      if (!this.mode3d) {
        if (this.hasHighlight) {
          const isHighlighted = this.highlightNodes.has(id);
          node.sprite.alpha = isHighlighted ? 1.0 : NODE_OPACITY_DIMMED;
          const s = this.highlightBaseSize(node);
          node.sprite.scale.set((s / CIRCLE_RADIUS) * invScale);
        } else {
          node.sprite.alpha = 0.9;
          node.sprite.scale.set((node.size / CIRCLE_RADIUS) * invScale);
        }
      }

      if (!this.showAllLabels) {
        if (node.label) node.label.visible = false;
      } else if (this.hasHighlight) {
        if (this.highlightNodes.has(id)) {
          wantLabel.push(node);
        } else if (node.label) {
          node.label.visible = false;
        }
      } else {
        wantLabel.push(node);
      }
    }

    // Pass 2: cull overlapping labels (largest nodes first)
    this.applyLabelCulling(wantLabel, this.labelInvScale());

    // In 3D mode, the ticker redraws edges; skip here to avoid 2D position flash
    if (!this.mode3d) {
      this.redrawAllEdges();
    }
  }

  /**
   * Show labels for the given nodes, culling any that overlap a previously
   * placed label. Nodes are processed largest-first so important nodes win.
   *
   * This method ONLY controls visibility. Scale and position are handled by
   * the update paths (update3D, updatePositionsFromBuffer, applyCounterScale)
   * to avoid jitter from competing writes.
   */
  private applyLabelCulling(candidates: PixiNode[], invScale: number): void {
    // Level-of-detail handoff: when zoomed out far enough that the
    // community wayfinders are at full strength, hide ALL individual node
    // labels so the overview shows only community labels. Without this,
    // high-degree nodes keep their labels at any zoom because their sprite
    // stays above MIN_SPRITE_SCREEN_RADIUS. Only applies when community
    // labels are enabled to take over — otherwise node labels stay so the
    // zoomed-out graph isn't left unlabeled.
    if (
      this.showCommunityLabels &&
      this.vp.scale < this.NODE_LABEL_MIN_VP_SCALE
    ) {
      for (const node of candidates) {
        if (node.label) node.label.visible = false;
      }
      return;
    }

    // Sort by size descending — largest (highest degree) nodes get labels first
    candidates.sort((a, b) => b.size - a.size);

    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const lm = this.labelScaleMultiplier;
    const screenLabelScale = invScale * lm * this.vp.scale;
    const labelH = (LABEL_SIZE + 4) * screenLabelScale;

    // Viewport bounds in screen pixels with a small margin so a label
    // partially clipped at the edge still gets a slot — avoids
    // labels popping in/out as you pan across the boundary (Fix #49).
    const VIEWPORT_MARGIN = 80;
    const vpLeft = -VIEWPORT_MARGIN;
    const vpRight = this.width + VIEWPORT_MARGIN;
    const vpTop = -VIEWPORT_MARGIN;
    const vpBottom = this.height + VIEWPORT_MARGIN;

    // Skip labels for nodes whose sprite is too small on screen
    // (Fix #49). At zoom-out the entire graph compresses into a tiny
    // area; without this gate, every node still tries for a label
    // slot and the screen fills with text. Sprite on-screen radius =
    // node.size × vp.scale^(1-zoomSizeExponent). 2.5 px is the
    // current threshold — was 4, lowered so larger anchor nodes get
    // labels at lower zoom levels (overlap cull still keeps the
    // screen from filling with text at extreme zoom-out).
    const MIN_SPRITE_SCREEN_RADIUS = 2.5;
    const spriteRadiusFactor = Math.pow(
      this.vp.scale,
      Math.max(0, 1 - this.zoomSizeExponent),
    );

    for (const node of candidates) {
      // Screen position of the sprite — used for the viewport
      // pre-filter (skip cull work for off-screen labels).
      const cx = node.sprite.position.x * this.vp.scale + this.vp.x;
      const cy = node.sprite.position.y * this.vp.scale + this.vp.y;
      if (cx < vpLeft || cx > vpRight || cy < vpTop || cy > vpBottom) {
        if (node.label) node.label.visible = false;
        continue;
      }

      // Size gate — sprites too small to read don't get labels.
      const spriteScreenRadius = node.size * spriteRadiusFactor;
      if (spriteScreenRadius < MIN_SPRITE_SCREEN_RADIUS) {
        if (node.label) node.label.visible = false;
        continue;
      }

      // World-space gap that lands the label just outside the sprite
      // edge (Fix #27 — the only piece of my label rework that
      // survived the revert; without it the label slides inside the
      // sprite at deep zoom because the sprite is in world coords
      // while the label is screen-pixel-constant).
      const gap = this.labelGap(node);
      const nx = node.sprite.position.x;
      const ny = node.sprite.position.y;

      const sx = (nx + gap) * this.vp.scale + this.vp.x;
      const sy = ny * this.vp.scale + this.vp.y - labelH / 2;
      const textLen = cleanLabel(node.graphNode.name || node.id).length;
      const sw = textLen * LABEL_SIZE * 0.6 * screenLabelScale;
      const sh = labelH;

      let overlapping = false;
      for (const box of boxes) {
        if (
          sx < box.x + box.w &&
          sx + sw > box.x &&
          sy < box.y + box.h &&
          sy + sh > box.y
        ) {
          overlapping = true;
          break;
        }
      }

      if (overlapping) {
        if (node.label) node.label.visible = false;
      } else {
        if (!node.label) {
          node.label = this.createLabel(node);
        }
        node.label.visible = true;
        // Set scale + position for the *current* zoom as we reveal the
        // label. A label hidden during a zoom gesture and revealed here
        // still carries the scale it had when last visible — a different
        // zoom level. The standalone cull paths (debouncedLabelCull,
        // setNodeVisibility) don't run applyCounterScale afterward, and
        // once zoom settles the ticker's scale-change gate stops firing,
        // so that stale scale would persist — labels render too big or
        // small after a fast zoom. applyCounterScale re-sets these in its
        // own tail loop, so the overlap there is harmless.
        node.label.scale.set(invScale * this.labelScaleMultiplier);
        node.label.position.set(nx + gap, ny);
        boxes.push({ x: sx, y: sy, w: sw, h: sh });
      }
    }
  }

  // ─── Edge Drawing ─────────────────────────────────────────────────

  // Curvature factor for bezier edges (fraction of edge length for control point offset).
  private readonly curvature = 0.15;

  /** Draw an edge between two points, using the current breakpoint's edge style. */
  private drawEdge(
    gfx: Graphics,
    sx: number,
    sy: number,
    tx: number,
    ty: number,
  ): void {
    if (this.bp.edgeStyle === 'curve') {
      const mx = (sx + tx) / 2;
      const my = (sy + ty) / 2;
      const dx = tx - sx;
      const dy = ty - sy;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.001) return;
      const offset = len * this.curvature;
      const cpx = mx + (-dy / len) * offset;
      const cpy = my + (dx / len) * offset;
      gfx.moveTo(sx, sy);
      gfx.quadraticCurveTo(cpx, cpy, tx, ty);
    } else {
      gfx.moveTo(sx, sy);
      gfx.lineTo(tx, ty);
    }
  }

  /** Check if a point is within the visible viewport (with margin). */
  private isInViewport(wx: number, wy: number): boolean {
    const sx = wx * this.vp.scale + this.vp.x;
    const sy = wy * this.vp.scale + this.vp.y;
    const mx = this.width * VIEWPORT_CULL_MARGIN;
    const my = this.height * VIEWPORT_CULL_MARGIN;
    return (
      sx >= -mx && sx <= this.width + mx && sy >= -my && sy <= this.height + my
    );
  }

  private redrawAllEdges(): void {
    if (!this.edgeBgGfx || !this.edgeFgGfx) return;

    this.edgeBgGfx.clear();
    this.edgeFgGfx.clear();

    if (!this.edgesEnabled) return;

    const bgAlpha = this.hasHighlight
      ? EDGE_OPACITY_DIMMED
      : EDGE_OPACITY_DEFAULT;
    const edgeWidth = 0.5 * this.zoomInvScale();
    const doCull = this.bp.edgeViewportCulling;

    // Draw background edges using pre-computed color groups
    for (const [color, indices] of this.edgeColorGroups) {
      let drawn = false;
      for (const i of indices) {
        const e = this.edges[i];
        if (this.hiddenLinkTypes.has(e.label)) continue;
        const s = this.nodes.get(e.sourceId);
        const t = this.nodes.get(e.targetId);
        if (!s?.visible || !t?.visible) continue;
        // Viewport culling: skip edges where both endpoints are off-screen.
        // Note: this can miss edges that cross the viewport diagonally (both endpoints
        // outside but the line segment passes through). A full segment-rect intersection
        // test is more expensive; this heuristic is sufficient for layout animation.
        if (
          doCull &&
          !this.isInViewport(s.x, s.y) &&
          !this.isInViewport(t.x, t.y)
        )
          continue;
        this.drawEdge(this.edgeBgGfx, s.x, s.y, t.x, t.y);
        drawn = true;
      }
      if (drawn) {
        this.edgeBgGfx.stroke({
          width: edgeWidth,
          color: hexToNum(color),
          alpha: bgAlpha,
        });
      }
    }

    // Foreground highlight edges
    if (this.hasHighlight) {
      const hlColorGroups = new Map<
        string,
        { sx: number; sy: number; tx: number; ty: number }[]
      >();
      for (let i = 0; i < this.edges.length; i++) {
        const e = this.edges[i];
        if (this.hiddenLinkTypes.has(e.label)) continue;
        const linkKey = `${e.sourceId}-${e.targetId}`;
        if (!this.highlightLinks.has(linkKey)) continue;
        const s = this.nodes.get(e.sourceId);
        const t = this.nodes.get(e.targetId);
        if (!s?.visible || !t?.visible) continue;
        let group = hlColorGroups.get(e.color);
        if (!group) {
          group = [];
          hlColorGroups.set(e.color, group);
        }
        group.push({ sx: s.x, sy: s.y, tx: t.x, ty: t.y });
      }
      for (const [color, lines] of hlColorGroups) {
        for (const l of lines) {
          this.drawEdge(this.edgeFgGfx, l.sx, l.sy, l.tx, l.ty);
        }
        this.edgeFgGfx.stroke({
          width: 1.5 * this.zoomInvScale(),
          color: hexToNum(color),
          alpha: EDGE_OPACITY_HIGHLIGHTED,
        });
      }
    }

    this.lastEdgeRedraw = performance.now();
  }

  private redrawDragEdges(node: PixiNode): void {
    if (!this.edgeBgGfx) return;
    this.edgeBgGfx.clear();

    if (!this.edgesEnabled) return;

    const myEdges = this.edgeIndex.get(node.id) ?? [];
    const neighborIds = new Set<string>();

    // Group drag edges by color
    const dragGroups = new Map<
      string,
      { sx: number; sy: number; tx: number; ty: number }[]
    >();
    for (const idx of myEdges) {
      const e = this.edges[idx];
      if (this.hiddenLinkTypes.has(e.label)) continue;
      const s = this.nodes.get(e.sourceId);
      const t = this.nodes.get(e.targetId);
      if (!s || !t) continue;
      let group = dragGroups.get(e.color);
      if (!group) {
        group = [];
        dragGroups.set(e.color, group);
      }
      group.push({ sx: s.x, sy: s.y, tx: t.x, ty: t.y });
      const neighborId = e.sourceId === node.id ? e.targetId : e.sourceId;
      neighborIds.add(neighborId);
    }
    for (const [color, lines] of dragGroups) {
      for (const l of lines) {
        this.drawEdge(this.edgeBgGfx, l.sx, l.sy, l.tx, l.ty);
      }
      this.edgeBgGfx.stroke({
        width: 1 * this.zoomInvScale(),
        color: hexToNum(color),
        alpha: 0.6,
      });
    }

    // Neighbor-to-neighbor edges for context
    for (const nid of neighborIds) {
      const nEdges = this.edgeIndex.get(nid) ?? [];
      for (const idx of nEdges) {
        const e = this.edges[idx];
        if (neighborIds.has(e.sourceId) && neighborIds.has(e.targetId)) {
          const s = this.nodes.get(e.sourceId);
          const t = this.nodes.get(e.targetId);
          if (s && t) {
            this.drawEdge(this.edgeBgGfx, s.x, s.y, t.x, t.y);
          }
        }
      }
    }
    this.edgeBgGfx.stroke({
      width: 0.4 * this.zoomInvScale(),
      color: EDGE_FALLBACK_COLOR,
      alpha: 0.2,
    });

    this.lastEdgeRedraw = performance.now();
  }

  /**
   * Hide edges during zoom/pan for instant interaction response.
   * Edges redraw after a 1300ms settle delay (Grafana pattern).
   * At 60k edges, hiding the Graphics layer is instant while redrawing
   * takes 5-15ms — this eliminates all edge overhead during interaction.
   */
  private hideEdgesForInteraction(): void {
    if (!this.bp.hideEdgesOnInteraction) return;
    if (!this.edgeBgGfx || !this.edgeFgGfx) return;
    if (!this.edgesHiddenForInteraction) {
      this.edgeBgGfx.visible = false;
      this.edgeFgGfx.visible = false;
      this.edgesHiddenForInteraction = true;
    }
    // Reset the settle timer
    if (this.interactionResumeTimer !== null) {
      clearTimeout(this.interactionResumeTimer);
    }
    this.interactionResumeTimer = setTimeout(() => {
      this.showEdgesAfterInteraction();
    }, this.bp.interactionSettleDelay);
  }

  private showEdgesAfterInteraction(): void {
    if (this.destroyed) return;
    if (!this.edgesHiddenForInteraction) return;
    this.edgesHiddenForInteraction = false;
    this.interactionResumeTimer = null;
    if (this.edgeBgGfx) this.edgeBgGfx.visible = true;
    if (this.edgeFgGfx) this.edgeFgGfx.visible = true;
    if (this.mode3d) {
      // In 3D mode the ticker redraws edges; do NOT re-cull labels —
      // the visible set is decided by zoom and stays stable across
      // rotation/pan/release (Fix #38).
    } else {
      this.redrawAllEdges();
      this.applyCounterScale();
    }
  }

  /** Notify renderer that the layout simulation has settled (skip edge redraws). */
  setLayoutSettled(settled: boolean): void {
    this.layoutSettled = settled;
    if (!settled) {
      // Layout restarted — force one edge redraw
      this.redrawAllEdges();
    }
  }

  setEdgesEnabled(enabled: boolean): void {
    this.edgesEnabled = enabled;
    if (enabled) {
      this.redrawAllEdges();
    } else {
      this.edgeBgGfx?.clear();
      this.edgeFgGfx?.clear();
    }
  }

  setZoomSizeExponent(exponent: number): void {
    this.zoomSizeExponent = Math.max(0, Math.min(1, exponent));
    this.applyCounterScale();
  }

  setLabelScale(scale: number): void {
    this.labelScaleMultiplier = Math.max(0.1, Math.min(3, scale));
    this.applyCounterScale();
  }

  getLabelScale(): number {
    return this.labelScaleMultiplier;
  }

  getZoomSizeExponent(): number {
    return this.zoomSizeExponent;
  }

  setHiddenLinkTypes(hidden: Set<string>): void {
    this.hiddenLinkTypes = hidden;
    this.redrawAllEdges();
  }

  // ─── Community wayfinder labels (Fix #32) ──────────────────────────

  /** Tell the renderer the current layout mode. After Fix #52 this
   *  no longer drives community-label visibility (which now follows
   *  `showCommunityLabels`), but the renderer still tracks it for
   *  downstream consumers (e.g. label-position recomputes). */
  setLayoutMode(mode: 'spread' | 'compact'): void {
    if (this.currentLayoutMode === mode) return;
    this.currentLayoutMode = mode;
    // Force a fresh cull on the next position update — the visible
    // set is determined by current geometry, which just changed.
    this.communityVisibilityFrozen = false;
    this.updateCommunityLabelPositions();
  }

  /** Show or hide the community wayfinder label layer (Fix #52). */
  setShowCommunityLabels(show: boolean): void {
    this.showCommunityLabels = show;
    if (this.communityLabelContainer) {
      this.communityLabelContainer.visible = show;
    }
    if (show) {
      this.updateCommunityLabelPositions();
      // Counter-scale is only applied to *visible* labels (see
      // applyCommunityLabelCounterScale), so flipping the layer back on
      // would leave each Text at whatever scale it had when last seen.
      // For labels that had never been counter-scaled (e.g. opened on a
      // graph that started with labels off), that's the base font size
      // — tiny at the current zoom. Apply now so the first frame after
      // toggling matches what the user will see after the next zoom.
      this.applyCommunityLabelCounterScale();
    }
  }

  /** Refresh the community wayfinder label set. Call after Louvain
   *  finishes (the names map changes) or when assignments swap.
   *
   *  Louvain re-runs frequently (StrictMode, worker respawn,
   *  position-driven dep changes) but the *names* it produces are
   *  generally stable — just attached to different numeric community
   *  IDs. Detect that case via a fingerprint of the sorted name set
   *  and skip the rebuild: the existing label objects get re-keyed
   *  to the new IDs, and the visibility-frozen flag stays put so the
   *  user doesn't see a fresh cull on every rerun (Fix #36). */
  setCommunityData(
    assignments: Record<string, number>,
    names: Map<number, string>,
    colorMap?: Map<number, string>,
  ): void {
    const fingerprint = [...names.values()].sort().join('\n');
    const sameNames = fingerprint === this.communityNamesFingerprint;
    if (sameNames && this.communityLabels.size > 0) {
      this.rekeyCommunityLabels(this.communityNames, names);
      this.communityAssignments = assignments;
      this.communityNames = names;
      this.communityColorMap = colorMap ?? null;
      // Do NOT reset `communityVisibilityFrozen` — same labels, same
      // visible set, just new community IDs under the hood.
      return;
    }
    this.communityAssignments = assignments;
    this.communityNames = names;
    this.communityColorMap = colorMap ?? null;
    this.communityNamesFingerprint = fingerprint;
    this.rebuildCommunityLabels();
  }

  /** Re-key the community-label Map (and the sticky-shown set) when
   *  Louvain produces the same names with different numeric IDs.
   *  Preserves Text instances, positions, and the visible-set
   *  decision across runs. */
  private rekeyCommunityLabels(
    oldNames: Map<number, string> | null,
    newNames: Map<number, string>,
  ): void {
    if (!oldNames) return;
    const nameToNewCid = new Map<string, number>();
    for (const [cid, name] of newNames) nameToNewCid.set(name, cid);

    const reKeyed = new Map<number, Text>();
    for (const [oldCid, text] of this.communityLabels) {
      const oldName = oldNames.get(oldCid);
      if (!oldName) continue;
      const newCid = nameToNewCid.get(oldName);
      if (newCid !== undefined) reKeyed.set(newCid, text);
    }
    this.communityLabels = reKeyed;

    const reKeyedShown = new Set<number>();
    for (const oldCid of this.currentlyShownCommunities) {
      const oldName = oldNames.get(oldCid);
      if (!oldName) continue;
      const newCid = nameToNewCid.get(oldName);
      if (newCid !== undefined) reKeyedShown.add(newCid);
    }
    this.currentlyShownCommunities = reKeyedShown;
  }

  private rebuildCommunityLabels(): void {
    if (!this.communityLabelContainer) return;
    for (const text of this.communityLabels.values()) {
      text.destroy();
    }
    this.communityLabels.clear();
    // Fresh data → fresh cull decision next frame.
    this.communityVisibilityFrozen = false;
    if (!this.communityAssignments || !this.communityNames) return;

    // Count members per community so we can suppress one-node clusters
    // and size labels by importance.
    const memberCount = new Map<number, number>();
    for (const cid of Object.values(this.communityAssignments)) {
      memberCount.set(cid, (memberCount.get(cid) ?? 0) + 1);
    }

    // Only label communities above a meaningful size — Louvain on a
    // 9 k-node graph produces ~130 clusters, most of them small. We
    // want a couple dozen big anchors, not 130 overlapping names.
    const MIN_COMMUNITY_SIZE = 25;
    // Larger than node labels (LABEL_SIZE = 12) so wayfinders read
    // as area markers, not as one of the node names. Tight enough
    // that they don't billboard the canvas at zoom-out. The
    // shrink-by-zoom curve below pulls them down at zoom-in.
    const FONT_MIN = LABEL_SIZE + 3; // 15
    const FONT_MAX = LABEL_SIZE + 6; // 18
    for (const [cid, name] of this.communityNames) {
      if (!name) continue;
      const count = memberCount.get(cid) ?? 0;
      if (count < MIN_COMMUNITY_SIZE) continue;

      // Scale font tightly by member count so the largest cluster gets
      // a touch more emphasis but no label dominates the canvas.
      const sizeT = Math.min(1, Math.log2(count / MIN_COMMUNITY_SIZE) / 4);
      const fontSize = FONT_MIN + (FONT_MAX - FONT_MIN) * sizeT;

      const colorHex = this.communityColorMap?.get(cid);
      const fillColor =
        colorHex !== undefined ? colorHex : getGraphThemeColors().labelColor;

      const text = new Text({
        text: name,
        style: new TextStyle({
          fontSize,
          fontFamily: LABEL_FONT,
          fontWeight: 'bold',
          fill: fillColor,
          // Black stroke + drop-shadow keeps the colored text readable
          // against the underlying cluster colors.
          stroke: { color: 0x000000, width: 3 },
          dropShadow: {
            color: 0x000000,
            distance: 0,
            blur: 6,
            alpha: 0.9,
            angle: 0,
          },
        }),
      });
      text.anchor.set(0.5);
      text.alpha = 0.95;
      this.communityLabelContainer.addChild(text);
      this.communityLabels.set(cid, text);
    }

    this.updateCommunityLabelPositions();
    // Counter-scale immediately so newly-created labels render at the
    // correct screen size on first paint. Without this they appear at
    // their base font size (huge against a zoomed-out graph) until the
    // user's next zoom/pan triggers applyCounterScale.
    this.applyCommunityLabelCounterScale();
  }

  /** Recompute community centroids from current node positions,
   *  reposition each wayfinder label, then run an overlap cull so
   *  adjacent communities don't pile their names on top of each other.
   *  Larger communities (more members) win overlaps.
   *
   *  Callers may pass pre-computed `sums` to skip the per-node loop —
   *  `update3D` does this so it can fold centroid accumulation into
   *  the projection pass it already runs every frame (Fix #34). */
  private updateCommunityLabelPositions(
    sums?: Map<number, { x: number; y: number; n: number }>,
  ): void {
    if (this.communityLabels.size === 0) return;
    if (!this.communityAssignments) return;

    // 1. Compute centroid for each community when not provided.
    // Use sprite.position rather than node.x/node.y so the labels
    // track 3D rotation — in 3D mode sprite.position is the projected
    // world coord while node.x/y stay at the un-projected base (Fix #33).
    if (!sums) {
      sums = new Map<number, { x: number; y: number; n: number }>();
      for (const node of this.nodes.values()) {
        if (!node.visible) continue;
        const cid = this.communityAssignments[node.id];
        if (cid === undefined) continue;
        const sx = node.sprite.position.x;
        const sy = node.sprite.position.y;
        const e = sums.get(cid);
        if (e) {
          e.x += sx;
          e.y += sy;
          e.n += 1;
        } else {
          sums.set(cid, { x: sx, y: sy, n: 1 });
        }
      }
    }

    // 2. Position each label at its centroid. Only update position for
    // labels in the visible set — hidden ones don't need it and we
    // don't want them flickering visible if visibility was set to
    // false elsewhere.
    const positioned: { cid: number; text: Text; n: number }[] = [];
    for (const [cid, text] of this.communityLabels) {
      const s = sums.get(cid);
      if (!s || s.n === 0) continue;
      text.position.set(s.x / s.n, s.y / s.n);
      positioned.push({ cid, text, n: s.n });
    }

    // Overlap cull — runs until the layout is stable, then freezes
    // (Fix #36 / refined in #50). The freeze is what stops labels
    // from blinking during 3D rotation: once decided, positions can
    // continue updating but visibility stays put. But we can't
    // freeze on the *first* cull — at data-add time many new nodes
    // are still at (0,0) and centroids are dragged toward the
    // origin, leaving most communities culled. Wait until the worker
    // reports the layout settled before locking the set in.
    if (this.communityVisibilityFrozen) return;
    this.recullCommunityLabels(positioned);
    if (this.layoutSettled) this.communityVisibilityFrozen = true;
  }

  /** Decide which community labels survive the overlap test. Called
   *  by `updateCommunityLabelPositions` only when the visible set
   *  needs a refresh (data change, layout mode flip, 3D toggle). */
  private recullCommunityLabels(
    positioned: { cid: number; text: Text; n: number }[],
  ): void {
    // Reset any labels that were positioned but aren't in this pass —
    // they'll be hidden below unless picked.
    for (const text of this.communityLabels.values()) {
      text.visible = false;
    }

    // Sticky-first ordering (Fix #35) is still useful when the cull
    // *does* re-run (e.g. user toggles compact mode off and on, or
    // data refreshes) — keeps the previous decision when nothing
    // about the geometry forces a change.
    const shown = this.currentlyShownCommunities;
    positioned.sort((a, b) => {
      const aSticky = shown.has(a.cid) ? 1 : 0;
      const bSticky = shown.has(b.cid) ? 1 : 0;
      if (aSticky !== bSticky) return bSticky - aSticky;
      return b.n - a.n;
    });

    const vp = this.vp;
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const accepted: number[] = [];
    // Less padding so adjacent communities can both surface a label
    // (Fix #47) — previous 12 px was eating slots when labels are
    // smaller anyway.
    const PADDING = 4;
    for (const { cid, text } of positioned) {
      const localBounds = text.getLocalBounds();
      const screenW = localBounds.width;
      const screenH = localBounds.height;
      const cxScreen = text.position.x * vp.scale + vp.x;
      const cyScreen = text.position.y * vp.scale + vp.y;
      const x = cxScreen - screenW / 2 - PADDING;
      const y = cyScreen - screenH / 2 - PADDING;
      const w = screenW + PADDING * 2;
      const h = screenH + PADDING * 2;

      let overlap = false;
      for (const box of boxes) {
        if (
          x < box.x + box.w &&
          x + w > box.x &&
          y < box.y + box.h &&
          y + h > box.y
        ) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        text.visible = true;
        boxes.push({ x, y, w, h });
        accepted.push(cid);
      }
    }
    this.currentlyShownCommunities = new Set(accepted);
  }

  /** Counter-scale community labels and fade them by zoom (Fix #32).
   *  At zoom-out they're prominent wayfinders; as the user zooms in
   *  past where individual node labels become readable they fade out
   *  so the two label layers don't pile on top of each other.
   *
   *  Fade curve: full opacity below `FADE_START_SCALE`, linear ramp to
   *  zero by `FADE_END_SCALE`. Container set invisible once fully
   *  transparent so it stops costing render time. */
  private applyCommunityLabelCounterScale(): void {
    if (!this.communityLabelContainer) return;
    if (!this.showCommunityLabels) {
      this.communityLabelContainer.visible = false;
      return;
    }
    // Fade alpha by zoom (Fix #32 baseline).
    const FADE_START_SCALE = 0.6;
    const FADE_END_SCALE = 1.2;
    let alpha = 1;
    if (this.vp.scale >= FADE_END_SCALE) alpha = 0;
    else if (this.vp.scale > FADE_START_SCALE) {
      alpha =
        1 -
        (this.vp.scale - FADE_START_SCALE) /
          (FADE_END_SCALE - FADE_START_SCALE);
    }
    if (alpha <= 0.01) {
      this.communityLabelContainer.visible = false;
      return;
    }
    this.communityLabelContainer.visible = true;
    this.communityLabelContainer.alpha = alpha;
    // Counter-scale formula (Fix #43 / tuned in #46). Wayfinders stay
    // readable at zoom-out (constant screen size) but shrink in screen
    // size as the user zooms in past the canvas-fit range, so they
    // don't overwhelm the graph at detail zoom. The piecewise formula:
    //
    //   • vp.scale ≤ SHRINK_THRESHOLD:  text.scale = 1/vp.scale
    //       → screen size = constant
    //   • vp.scale > SHRINK_THRESHOLD: text.scale = SHRINK_THRESHOLD / vp.scale²
    //       → screen size = font × SHRINK_THRESHOLD / vp.scale  (shrinks)
    //
    // Continuous at the threshold: both branches give 1/THRESHOLD.
    // 0.2 starts the shrink early so by the time the user has zoomed
    // even a little past fit-to-screen, wayfinders are already
    // dropping in size and don't dominate the node detail behind
    // them (Fix #47).
    const SHRINK_THRESHOLD = 0.2;
    const labelScale =
      this.vp.scale <= SHRINK_THRESHOLD
        ? 1 / this.vp.scale
        : SHRINK_THRESHOLD / (this.vp.scale * this.vp.scale);
    for (const text of this.communityLabels.values()) {
      if (!text.visible) continue;
      text.scale.set(labelScale);
    }
  }

  // ─── Bloom ─────────────────────────────────────────────────────────

  setBloomEnabled(_enabled: boolean): void {
    // Placeholder — full bloom requires pixi-filters v6 package.
    // When available, creates AdvancedBloomFilter on app.stage.
  }

  setBloomStrength(_strength: number): void {
    // Placeholder for bloom strength control — requires pixi-filters.
  }

  // ─── Labels ───────────────────────────────────────────────────────

  /** Create a label Text for a node. Positioned to the right of the node. */
  private createLabel(node: PixiNode): Text {
    const lblInv = this.labelInvScale();
    const themeColors = getGraphThemeColors();
    const label = new Text({
      text: cleanLabel(node.graphNode.name || node.id),
      style: new TextStyle({
        fontSize: LABEL_SIZE,
        fontFamily: LABEL_FONT,
        fontWeight: 'bold',
        fill: themeColors.labelColor,
        dropShadow: {
          alpha: 0.9,
          blur: 3,
          color: themeColors.labelShadow,
          distance: 0,
        },
      }),
    });
    // Anchor left-center, positioned to the right of the node
    label.anchor.set(0, 0.5);
    const lm = this.labelScaleMultiplier;
    label.scale.set(lblInv * lm);
    const gap = this.labelGap(node);
    label.position.set(node.sprite.position.x + gap, node.sprite.position.y);
    this.labelContainer!.addChild(label);
    return label;
  }

  /** Re-cull labels if enough time has passed. For immediate needs (e.g. toggle). */
  private throttledLabelCull(): void {
    const now = performance.now();
    if (now - this.lastLabelCull < this.LABEL_CULL_INTERVAL) return;
    this.runLabelCull();
  }

  /** Debounced label cull — waits for interaction to stop before re-culling. */
  private debouncedLabelCull(): void {
    if (this.labelCullDebounceTimer !== null) {
      clearTimeout(this.labelCullDebounceTimer);
    }
    this.labelCullDebounceTimer = setTimeout(() => {
      this.labelCullDebounceTimer = null;
      this.runLabelCull();
    }, this.LABEL_CULL_DEBOUNCE);
  }

  /** Actually run the label cull. */
  private runLabelCull(): void {
    this.lastLabelCull = performance.now();
    if (!this.showAllLabels) return;
    const invScale = this.labelInvScale();
    const wantLabel: PixiNode[] = [];
    for (const node of this.nodes.values()) {
      if (!node.visible) continue;
      if (this.hasHighlight) {
        if (this.highlightNodes.has(node.id)) {
          wantLabel.push(node);
        } else if (node.label) {
          node.label.visible = false;
        }
      } else {
        wantLabel.push(node);
      }
    }
    this.applyLabelCulling(wantLabel, invScale);
  }

  setShowAllLabels(show: boolean): void {
    this.showAllLabels = show;
    if (!this.app || !this.labelContainer) return;
    // applyCounterScale runs the cull inline; no need to call it
    // separately.
    this.applyCounterScale();
  }

  // ─── Quadtree ─────────────────────────────────────────────────────

  private rebuildQuadtree(): void {
    const visibleNodes: PixiNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.visible) visibleNodes.push(node);
    }
    // In 3D mode, use the sprite's projected position for hit detection
    this._quadtree = quadtree<PixiNode>()
      .x((d) => (this.mode3d ? d.sprite.position.x : d.x))
      .y((d) => (this.mode3d ? d.sprite.position.y : d.y))
      .addAll(visibleNodes);
    this.lastQuadtreeRebuild = performance.now();
  }

  /** Find the nearest node to (worldX, worldY) within maxDistance. */
  findNodeAt(
    worldX: number,
    worldY: number,
    maxDistance = 20,
  ): PixiNode | null {
    if (!this._quadtree) return null;
    // In 3D mode, rebuild quadtree every hit test since projected positions
    // change every frame from rotation. This is O(n log n) but only runs
    // on click/hover (~20fps), not every render frame.
    if (this.mode3d) this.rebuildQuadtree();
    return this._quadtree.find(worldX, worldY, maxDistance) ?? null;
  }

  /**
   * Find the nearest edge to (worldX, worldY) within maxDistance.
   * Uses point-to-segment (or point-to-quadratic-curve) distance testing.
   */
  findEdgeAt(worldX: number, worldY: number, maxDistance = 8): PixiEdge | null {
    if (this.edges.length === 0) return null;

    let bestEdge: PixiEdge | null = null;
    let bestDist = maxDistance;

    for (let i = 0; i < this.edges.length; i++) {
      const e = this.edges[i];
      if (this.hiddenLinkTypes.has(e.label)) continue;
      const s = this.nodes.get(e.sourceId);
      const t = this.nodes.get(e.targetId);
      if (!s?.visible || !t?.visible) continue;

      const sx = this.mode3d ? s.sprite.position.x : s.x;
      const sy = this.mode3d ? s.sprite.position.y : s.y;
      const tx = this.mode3d ? t.sprite.position.x : t.x;
      const ty = this.mode3d ? t.sprite.position.y : t.y;

      // Early bounding-box pruning
      const dx = tx - sx;
      const dy = ty - sy;
      const lenSq = dx * dx + dy * dy;
      const isCurve = this.bp.edgeStyle === 'curve';
      const padding =
        maxDistance + (isCurve ? Math.sqrt(lenSq) * this.curvature : 0);

      if (
        worldX < Math.min(sx, tx) - padding ||
        worldX > Math.max(sx, tx) + padding ||
        worldY < Math.min(sy, ty) - padding ||
        worldY > Math.max(sy, ty) + padding
      ) {
        continue;
      }

      let dist: number;
      if (isCurve) {
        dist = pointToQuadraticDist(
          worldX,
          worldY,
          sx,
          sy,
          tx,
          ty,
          this.curvature,
        );
      } else {
        dist = pointToSegmentDist(worldX, worldY, sx, sy, tx, ty);
      }

      if (dist < bestDist) {
        bestDist = dist;
        bestEdge = e;
      }
    }

    return bestEdge;
  }

  /** Build a SelectedEdge from a PixiEdge, resolving source/target nodes. */
  private buildSelectedEdge(edge: PixiEdge): SelectedEdge {
    const sourceNode = this.nodes.get(edge.sourceId)?.graphNode;
    const targetNode = this.nodes.get(edge.targetId)?.graphNode;
    return {
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.label,
      properties: edge.graphLink.properties,
      sourceNode,
      targetNode,
    };
  }

  // ─── Viewport ─────────────────────────────────────────────────────

  getViewport(): Viewport {
    return { ...this.vp };
  }

  setViewport(vp: Viewport): void {
    this.vp = { ...vp };
  }

  zoomToFit(duration = 300): void {
    if (this.nodes.size === 0) return;
    const positions = Array.from(this.nodes.values())
      .filter((n) => n.visible)
      .map((n) =>
        this.mode3d
          ? { x: n.sprite.position.x, y: n.sprite.position.y }
          : { x: n.x, y: n.y },
      );
    if (positions.length === 0) return;
    const bounds = computeBounds(positions);
    const target = fitBounds(bounds, this.width, this.height);

    // Hand the camera off from any in-progress auto-fit follower to
    // this explicit one-shot animation (Fix #9).
    this.autoFitTarget = null;

    if (duration <= 0) {
      this.vp = target;
      this.applyCounterScale();
      return;
    }

    this.cancelAnimation?.();
    this.cancelAnimation = animateViewport(
      this.vp,
      target,
      duration,
      (vp) => {
        this.vp = vp;
      },
      () => {
        this.redrawAllEdges();
        this.cancelAnimation = null;
      },
    );
  }

  /**
   * Continuous easing auto-fit — refreshes the follower's target from live
   * positions while the user has not taken manual control of the camera. The
   * ticker eases the viewport toward this target each frame, so bursty
   * producers like the d3-force worker streaming positions every ~66 ms drive
   * a smooth chase rather than discrete animations (Fix #9 / Option C).
   *
   * `_duration` is retained for API compatibility with callers (and the
   * `IPixiCanvasHandle` contract); the easing follower has its own per-frame
   * rate, so the value is intentionally ignored.
   */
  scheduleAutoFit(_duration = 200): void {
    if (this.hasUserMovedCamera) return;
    if (this.autoFitSuspended) return;
    if (this.nodes.size === 0) return;
    // A manual zoomToFit/zoomToNodes animation is in progress — the
    // user (or another explicit caller) has the most-recent intent.
    // Don't overwrite their target with auto-fit.
    if (this.cancelAnimation !== null) return;
    // Refresh the follower's target from live positions. Cheap (O(n)
    // bounds compute), called at worker tick rate (~66 ms). The
    // ticker eases `vp` toward this target each frame; if the
    // layout keeps moving, the target keeps shifting and the camera
    // smoothly chases it — no discrete animations, no zoom thrash
    // (Fix #9 / Option C).
    const target = this.computeFitTarget();
    if (target) this.autoFitTarget = target;
  }

  private computeFitTarget(): Viewport | null {
    if (this.nodes.size === 0) return null;
    const positions = Array.from(this.nodes.values())
      .filter((n) => n.visible)
      .map((n) =>
        this.mode3d
          ? { x: n.sprite.position.x, y: n.sprite.position.y }
          : { x: n.x, y: n.y },
      );
    if (positions.length === 0) return null;
    const bounds = computeBounds(positions);
    return fitBounds(bounds, this.width, this.height);
  }

  /** Pause auto-fit (Fix #9). Used during layoutMode transitions to
   *  hold the camera steady before positions have actually moved.
   *  Manual `zoomToFit()` calls still work — only `scheduleAutoFit()`
   *  is gated. */
  setAutoFitSuspended(suspended: boolean): void {
    this.autoFitSuspended = suspended;
    if (suspended) this.autoFitTarget = null;
  }

  /** Mark the camera as user-controlled or not (Fix #41). When true,
   *  the auto-fit follower stops re-framing the view from worker
   *  ticks — the user's current zoom/pan sticks. Used by the layout-
   *  mode toggle so switching compact ↔ spread doesn't zoom in/out
   *  to fit the new layout's extent. The explicit Reset and
   *  Zoom-to-fit buttons clear it via `resetCamera()`. */
  setHasUserMovedCamera(moved: boolean): void {
    this.hasUserMovedCamera = moved;
    if (moved) this.autoFitTarget = null;
  }

  /** Fraction of visible nodes whose sprite sits inside the current
   *  viewport (Fix #42). Used by the layout-mode toggle to decide
   *  whether the graph has outgrown the viewport (spread mode
   *  expanding past the canvas) and a smooth re-fit is warranted.
   *  Returns 1 when nothing's loaded so callers don't trigger fits on
   *  empty graphs. */
  fractionInViewport(): number {
    if (this.nodes.size === 0) return 1;
    const vp = this.vp;
    const left = -vp.x / vp.scale;
    const right = (this.width - vp.x) / vp.scale;
    const top = -vp.y / vp.scale;
    const bottom = (this.height - vp.y) / vp.scale;
    let total = 0;
    let inside = 0;
    for (const node of this.nodes.values()) {
      if (!node.visible) continue;
      total += 1;
      const x = node.sprite.position.x;
      const y = node.sprite.position.y;
      if (x >= left && x <= right && y >= top && y <= bottom) inside += 1;
    }
    return total > 0 ? inside / total : 1;
  }

  zoomToNodes(nodeIds: Iterable<string>, duration = 300): void {
    const positions: { x: number; y: number }[] = [];
    let maxSize = 0;
    for (const id of nodeIds) {
      const node = this.nodes.get(id);
      if (!node?.visible) continue;
      if (node.size > maxSize) maxSize = node.size;
      // In 3D, use projected positions (rotation paused on click so they're stable)
      if (this.mode3d) {
        positions.push({
          x: node.sprite.position.x,
          y: node.sprite.position.y,
        });
      } else {
        positions.push({ x: node.x, y: node.y });
      }
    }
    if (positions.length === 0) return;
    const bounds = computeBounds(positions);
    // Enforce a minimum world-span so focusing on a single node (or a tight
    // cluster) doesn't collapse the bounds to a point and zoom the camera all
    // the way in. Two floors, whichever is larger:
    //   • node-size relative (~24× the largest node) — tight focus on small
    //     loaded subgraphs;
    //   • graph relative (~1/6 of the whole graph's extent) — robust to any
    //     layout coordinate scale, so a big graph never zooms to a pinpoint.
    let allMinX = Infinity,
      allMaxX = -Infinity,
      allMinY = Infinity,
      allMaxY = -Infinity;
    for (const n of this.nodes.values()) {
      if (!n.visible) continue;
      const x = this.mode3d ? n.sprite.position.x : n.x;
      const y = this.mode3d ? n.sprite.position.y : n.y;
      if (x < allMinX) allMinX = x;
      if (x > allMaxX) allMaxX = x;
      if (y < allMinY) allMinY = y;
      if (y > allMaxY) allMaxY = y;
    }
    const fullSpan = Math.max(allMaxX - allMinX, allMaxY - allMinY, 0);
    const minSpan = Math.max(maxSize * 24, fullSpan / 6, 1);
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    if (bounds.maxX - bounds.minX < minSpan) {
      bounds.minX = cx - minSpan / 2;
      bounds.maxX = cx + minSpan / 2;
    }
    if (bounds.maxY - bounds.minY < minSpan) {
      bounds.minY = cy - minSpan / 2;
      bounds.maxY = cy + minSpan / 2;
    }
    const target = fitBounds(bounds, this.width, this.height, 120);

    // Focusing on specific nodes is a deliberate user action — stop auto-fit.
    this.hasUserMovedCamera = true;

    this.cancelAnimation?.();
    this.cancelAnimation = animateViewport(
      this.vp,
      target,
      duration,
      (vp) => {
        this.vp = vp;
      },
      () => {
        this.redrawAllEdges();
        this.cancelAnimation = null;
      },
    );
  }

  zoomIn(duration = 200): void {
    // Mark this as a user-driven zoom so the auto-fit follower
    // doesn't yank the camera back to fit-bounds on the next worker
    // tick (Fix #39). Also clear any pending follower target so it
    // doesn't fight the animation.
    this.hasUserMovedCamera = true;
    this.autoFitTarget = null;
    const target: Viewport = {
      x: this.vp.x,
      y: this.vp.y,
      scale: this.vp.scale * 1.5,
    };
    this.cancelAnimation?.();
    this.cancelAnimation = animateViewport(
      this.vp,
      target,
      duration,
      (vp) => {
        this.vp = vp;
      },
      () => {
        this.redrawAllEdges();
        this.cancelAnimation = null;
      },
    );
  }

  zoomOut(duration = 200): void {
    this.hasUserMovedCamera = true;
    this.autoFitTarget = null;
    const target: Viewport = {
      x: this.vp.x,
      y: this.vp.y,
      scale: this.vp.scale / 1.5,
    };
    this.cancelAnimation?.();
    this.cancelAnimation = animateViewport(
      this.vp,
      target,
      duration,
      (vp) => {
        this.vp = vp;
      },
      () => {
        this.redrawAllEdges();
        this.cancelAnimation = null;
      },
    );
  }

  resetCamera(duration = 300): void {
    // Explicit "Reset View" re-enables auto-fit for subsequent data changes.
    this.hasUserMovedCamera = false;
    this.zoomToFit(duration);
  }

  // ─── Interaction Setup ────────────────────────────────────────────

  setCallbacks(callbacks: InteractionCallbacks): void {
    this.callbacks = callbacks;
  }

  private setupInteraction(
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): void {
    // Wheel zoom — deltaY-proportional for smooth, magnitude-aware zooming
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Smooth zoom: larger deltaY → bigger zoom step
        const zoomFactor = Math.pow(0.999, e.deltaY);
        const newScale = this.vp.scale * zoomFactor;
        // Adjust position so world point under cursor stays fixed
        this.vp.x = mouseX - (mouseX - this.vp.x) * (newScale / this.vp.scale);
        this.vp.y = mouseY - (mouseY - this.vp.y) * (newScale / this.vp.scale);
        this.vp.scale = newScale;

        // User took manual control — stop auto-fitting during indexing.
        this.hasUserMovedCamera = true;

        // Hide edges during zoom for instant response (Grafana pattern).
        // Sprite transforms are instant; edges redraw after 1300ms settle.
        if (!this.dragNode) {
          this.hideEdgesForInteraction();
        }
        // Re-cull labels after zoom settles
        this.debouncedLabelCull();
      },
      { passive: false, signal },
    );

    // Pointer events for pan / drag / click
    let pointerDown = false;
    let pointerDownButton = 0;
    let movedDistance = 0;
    // Track last pointer position to compute pan deltas manually,
    // avoiding movementX/Y which includes the full distance since pointerdown
    // on the first pointermove event after crossing the drag threshold.
    let lastPointerX = 0;
    let lastPointerY = 0;

    // Suppress the browser's right-click menu so right-drag can pan in 3D mode.
    canvas.addEventListener(
      'contextmenu',
      (e) => {
        e.preventDefault();
      },
      { signal },
    );

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        pointerDown = true;
        pointerDownButton = e.button;
        movedDistance = 0;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        this.pointerDownPos = { x: e.clientX, y: e.clientY };

        // Hit test — only left button drags nodes; left-drag on empty area rotates in 3D.
        if (e.button === 0) {
          const rect = canvas.getBoundingClientRect();
          const screenX = e.clientX - rect.left;
          const screenY = e.clientY - rect.top;
          const world = screenToWorld(screenX, screenY, this.vp);
          const hitNode = this.findNodeAt(world.x, world.y, 15 / this.vp.scale);
          this.pendingDragNode = hitNode ?? null;
        } else {
          this.pendingDragNode = null;
        }
      },
      { signal },
    );

    let lastHoverCheck = 0;
    canvas.addEventListener(
      'pointermove',
      (e) => {
        // Hover cursor — throttled to avoid quadtree traversal on every mousemove
        if (!pointerDown) {
          const now = performance.now();
          if (now - lastHoverCheck < 50) return; // 20fps hover check
          lastHoverCheck = now;
          const rect = canvas.getBoundingClientRect();
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const w = screenToWorld(sx, sy, this.vp);
          const hit = this.findNodeAt(w.x, w.y, 15 / this.vp.scale);
          if (hit) {
            canvas.style.cursor = 'pointer';
          } else if (this.edgesEnabled && this.bp.edgeHoverHitTest) {
            const edgeHit = this.findEdgeAt(w.x, w.y, 10 / this.vp.scale);
            canvas.style.cursor = edgeHit ? 'pointer' : 'default';
          } else {
            canvas.style.cursor = 'default';
          }
          return;
        }

        if (!this.pointerDownPos) return;

        const dx = e.clientX - this.pointerDownPos.x;
        const dy = e.clientY - this.pointerDownPos.y;
        movedDistance = Math.sqrt(dx * dx + dy * dy);

        if (movedDistance > CLICK_THRESHOLD) {
          // Any gesture past the click threshold (node drag, pan, 3D rotate)
          // counts as manual control — stop auto-fitting during indexing so
          // the view doesn't fight the user.
          this.hasUserMovedCamera = true;

          if (this.pendingDragNode && !this.dragNode) {
            // Start node drag
            this.dragNode = this.pendingDragNode;
            this.pendingDragNode = null;
            canvas.style.cursor = 'grabbing';
            this.callbacks.onNodeDragStart?.(this.dragNode.id);
          }

          if (this.dragNode) {
            // Move dragged node
            const rect = canvas.getBoundingClientRect();
            const screenX = e.clientX - rect.left;
            const screenY = e.clientY - rect.top;
            const world = screenToWorld(screenX, screenY, this.vp);
            this.dragNode.x = world.x;
            this.dragNode.y = world.y;
            this.dragNode.sprite.position.set(world.x, world.y);
            if (this.dragNode.label?.visible) {
              const gap = this.labelGap(this.dragNode);
              this.dragNode.label.position.set(world.x + gap, world.y);
            }
            this.callbacks.onNodeDragMove?.(this.dragNode.id, world.x, world.y);
            this.redrawDragEdges(this.dragNode);
          } else if (this.mode3d && pointerDownButton === 0) {
            // 3D mode + left-drag on empty area: rotate the camera
            const rotateDx = e.clientX - lastPointerX;
            const rotateDy = e.clientY - lastPointerY;
            // Horizontal drag → Y-axis rotation
            this.mode3dAngle += rotateDx * 0.005;
            // Vertical drag → X-axis tilt (clamped to avoid flipping)
            this.mode3dTilt = Math.max(
              -1.2,
              Math.min(1.2, this.mode3dTilt + rotateDy * 0.005),
            );
            // Pause auto-rotation during manual drag
            if (this.mode3dAutoRotate) {
              this.mode3dAutoRotate = false;
              this.callbacks.on3DAutoRotateChange?.(false);
            }
            // No cull on rotate/release (Fix #38) — labels ride the
            // sphere as a fixed set.
          } else {
            // Pan — compute delta from last pointer position (not movementX/Y)
            // to avoid a jump on the first move after crossing the drag threshold.
            const panDx = e.clientX - lastPointerX;
            const panDy = e.clientY - lastPointerY;
            this.vp.x += panDx;
            this.vp.y += panDy;
            // Hide edges during pan for instant response
            this.hideEdgesForInteraction();
            // No cull on pan (Fix #38) — panning a fixed-zoom view
            // doesn't change which labels should be visible.
          }
        }

        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
      },
      { signal },
    );

    const pointerUp = (e: PointerEvent) => {
      if (!pointerDown) return;
      pointerDown = false;

      if (this.dragNode) {
        this.callbacks.onNodeDragEnd?.(this.dragNode.id);
        this.dragNode = null;
        canvas.style.cursor = 'default';
        this.redrawAllEdges();
      } else if (pointerDownButton === 0 && movedDistance <= CLICK_THRESHOLD) {
        // Click
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const world = screenToWorld(screenX, screenY, this.vp);
        const hitNode = this.findNodeAt(world.x, world.y, 15 / this.vp.scale);

        if (hitNode) {
          // Pause 3D rotation on click so edges stay attached to highlighted node
          if (this.mode3d && this.mode3dAutoRotate) {
            this.mode3dAutoRotate = false;
            this.callbacks.on3DAutoRotateChange?.(false);
          }
          this.callbacks.onNodeClick?.(hitNode.graphNode);
        } else {
          // No node hit — check for edge hit
          const hitEdge = this.edgesEnabled
            ? this.findEdgeAt(world.x, world.y, 10 / this.vp.scale)
            : null;
          if (hitEdge) {
            if (this.mode3d && this.mode3dAutoRotate) {
              this.mode3dAutoRotate = false;
              this.callbacks.on3DAutoRotateChange?.(false);
            }
            this.callbacks.onEdgeClick?.(this.buildSelectedEdge(hitEdge));
          } else {
            // Resume 3D rotation on stage click (deselect)
            if (this.mode3d && !this.mode3dAutoRotate) {
              this.mode3dAutoRotate = true;
              this.callbacks.on3DAutoRotateChange?.(true);
            }
            this.callbacks.onStageClick?.();
          }
        }
      }

      this.pendingDragNode = null;
      this.pointerDownPos = null;
    };

    canvas.addEventListener('pointerup', pointerUp, { signal });
    canvas.addEventListener('pointerleave', pointerUp, { signal });
  }

  // ─── Node Access ──────────────────────────────────────────────────

  getNode(id: string): PixiNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): IterableIterator<PixiNode> {
    return this.nodes.values();
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  getEdgeCount(): number {
    return this.edges.length;
  }

  /** Get the currently active performance breakpoint. */
  getBreakpoint(): PixiScaleBreakpoint {
    return this.bp;
  }

  /** Override the default breakpoint tiers. Takes effect on next setData(). */
  setBreakpoints(breakpoints: PixiScaleBreakpoint[]): void {
    this.breakpoints = breakpoints;
  }

  // ─── 3D Rotation Mode ─────────────────────────────────────────────

  /**
   * Enable/disable pseudo-3D rotation mode.
   * Assigns Z coordinates based on community membership (golden angle distribution)
   * and applies perspective projection + auto-rotation on the Pixi ticker.
   */
  set3DMode(
    enabled: boolean,
    communityAssignments?: Record<string, number>,
  ): void {
    // Guard against re-entry with the same mode (Fix #36). React in
    // dev StrictMode and the `communityData.assignments` dep on the
    // wiring effect both cause this to fire even when nothing about
    // the mode itself changed. Without the guard each rerun would
    // reset `communityVisibilityFrozen`, triggering a fresh community
    // cull — and the user would see a new label set on every Louvain
    // rerun mid-rotation.
    if (this.mode3d === enabled && enabled) {
      // Same mode + 3D: just refresh community depth assignments if
      // provided (still useful when Louvain produces new IDs), but
      // don't unfreeze the wayfinders.
      if (communityAssignments) {
        this.assignCommunityDepths(communityAssignments);
      }
      return;
    }
    this.mode3d = enabled;
    this.mode3dFrameCounter = 0;
    // Re-cull on the next frame — 2D ↔ 3D changes the projection so
    // the prior visible set may no longer be optimal.
    this.communityVisibilityFrozen = false;
    if (!enabled) {
      // Restore 2D positions from stored (x, y)
      for (const node of this.nodeArray) {
        if (!node.visible) continue;
        node.sprite.position.set(node.x, node.y);
        node.sprite.alpha = 0.9;
      }
      this.applyCounterScale();
      this.redrawAllEdges();
      // Rebuild quadtree with 2D positions so hit detection works correctly
      this.rebuildQuadtree();
      return;
    }

    // Compute initial bounding radius from current positions.
    // Reset first so recomputeMode3DExtents() picks the real extent
    // rather than a stale (possibly larger) previous radius.
    this.mode3dRadius = 0;
    this.recomputeMode3DExtents();

    // Assign Z depth per node: community-based + jitter
    if (communityAssignments) {
      this.assignCommunityDepths(communityAssignments);
    } else {
      this.nodeDepthT.clear();
    }

    this.mode3dAngle = 0;
    this.mode3dAutoRotate = true;

    // Run one update3D pass to set projected positions, then cull labels
    this.update3D();
    this.lastLabelCull = 0;
    this.throttledLabelCull();
  }

  /** Assign per-node 3D depth based on community membership. Extracted
   *  so `set3DMode` can refresh depths on Louvain rerun without doing
   *  the rest of the 3D-init work (which would also reset the
   *  community wayfinder freeze flag — Fix #36). */
  private assignCommunityDepths(
    communityAssignments: Record<string, number>,
  ): void {
    this.nodeDepthT.clear();
    const uniqueComms = [...new Set(Object.values(communityAssignments))].sort(
      (a, b) => a - b,
    );
    const commDepth = new Map<number, number>();
    const GOLDEN_ANGLE = 0.618033988749;
    for (let i = 0; i < uniqueComms.length; i++) {
      const t = (i * GOLDEN_ANGLE) % 1;
      commDepth.set(uniqueComms[i], (t - 0.5) * 2);
    }
    for (let i = 0; i < this.nodeArray.length; i++) {
      const node = this.nodeArray[i];
      const cid = communityAssignments[node.id];
      const base = cid !== undefined ? (commDepth.get(cid) ?? 0) : 0;
      // Deterministic jitter from node index
      const hash = Math.sin(i * 127.1 + 311.7) * 43758.5453;
      const jitter = (hash - Math.floor(hash) - 0.5) * 0.8;
      this.nodeDepthT.set(node.id, Math.max(-1, Math.min(1, base + jitter)));
    }
  }

  /**
   * Recompute `mode3dRadius` (and derived perspective/depth scales) from
   * the current node positions.
   *
   * Default behaviour is only-grow: during steady-state physics, brief
   * outward jitter could otherwise cause `getNodeZ()` to hard-clamp
   * drifted nodes to Z=0 (collapsing the sphere into a disk) in the
   * frames between recomputes. Holding R at the high water mark avoids
   * that flicker.
   *
   * `allowShrink=true` shrinks R to fit the current positions. Used
   * during layout transitions (Fix #8) so switching to a tighter layout
   * (e.g. compact community packing) re-tracks the smaller XY extent
   * instead of leaving us with a stale large radius — which would
   * project a tiny XY ring across a full Z spread, i.e. a cylinder.
   */
  private recomputeMode3DExtents(allowShrink = false): void {
    let maxDist = 0;
    for (const node of this.nodeArray) {
      if (!node.visible) continue;
      const d = Math.sqrt(node.x * node.x + node.y * node.y);
      if (d > maxDist) maxDist = d;
    }
    const candidate = maxDist * 1.1 || 500;
    const newRadius = allowShrink
      ? candidate
      : Math.max(this.mode3dRadius, candidate);
    if (newRadius !== this.mode3dRadius) {
      this.mode3dRadius = newRadius;
      // PerspectiveD ~3-4x the radius for a natural look.
      this.mode3dPerspectiveD = newRadius * 3;
      // Depth scale relative to radius — controls how "thick" the sphere is.
      this.mode3dDepthScale = newRadius * 0.6;
    }
  }

  /** Get Z coordinate for a node (filled sphere distribution). */
  private getNodeZ(node: PixiNode): number {
    const R = this.mode3dRadius;
    const R2 = R * R;
    const d2 = node.x * node.x + node.y * node.y;
    if (d2 >= R2) return 0;
    const zMax = Math.sqrt(R2 - d2);
    const t = this.nodeDepthT.get(node.id) ?? 0;
    return t * zMax * (this.mode3dDepthScale / R);
  }

  /** Project a 3D point to 2D screen coordinates with perspective. */
  private project3d(
    x: number,
    y: number,
    z: number,
  ): { px: number; py: number; scale: number; rz: number } {
    // X-axis tilt
    const cosT = Math.cos(this.mode3dTilt);
    const sinT = Math.sin(this.mode3dTilt);
    const ty = y * cosT - z * sinT;
    const tz = y * sinT + z * cosT;
    // Y-axis rotation
    const cosA = Math.cos(this.mode3dAngle);
    const sinA = Math.sin(this.mode3dAngle);
    const rx = x * cosA - tz * sinA;
    const rz = x * sinA + tz * cosA;
    // Perspective
    const scale = this.mode3dPerspectiveD / (this.mode3dPerspectiveD + rz);
    return { px: rx * scale, py: ty * scale, scale, rz };
  }

  /**
   * Called from the Pixi ticker every frame when 3D mode is active.
   * Projects all nodes and redraws edges.
   */
  private update3D(): void {
    // Auto-rotation used to be gated on `layoutSettled` (Fix #54) to hide
    // ticker stutter while the main thread was busy in bursts during
    // indexing. After Plans D + E moved the store and embedder off the
    // main thread, that stutter source is gone, and the gate was instead
    // suppressing rotation on graphs where d3-force never reports settled
    // (large graphs, warm alphaTarget). Manual drag still updates
    // `mode3dAngle` directly in the pointer handler regardless.
    if (this.mode3dAutoRotate) {
      this.mode3dAngle += this.mode3dSpeed;
    }

    // Keep sphere bounds in sync with the layout.
    //   • While the worker simulation is running (`!layoutSettled`) we
    //     recompute every frame with allow-shrink so R tracks live
    //     positions through any transition — e.g. spread → compact,
    //     compact → spread. Without this, switching to a tighter
    //     layout leaves R stuck at the larger value and the projection
    //     collapses into a vertical cylinder (Fix #8).
    //   • Once settled, fall back to throttled only-grows so brief
    //     outward jitter doesn't trigger Z=0 hard-clamp flicker.
    this.mode3dFrameCounter++;
    if (!this.layoutSettled) {
      this.recomputeMode3DExtents(true);
    } else if (this.mode3dFrameCounter % 30 === 0) {
      this.recomputeMode3DExtents();
    }

    const invScale = this.zoomInvScale();
    const lblInv = this.labelInvScale();
    // Fold community-centroid accumulation into the projection loop so
    // the wayfinders re-aim every frame at zero extra cost (Fix #34).
    // Allocating a Map per frame is cheap (~20 entries); the per-node
    // dict lookup is a single property read.
    const trackCommunities =
      this.showCommunityLabels &&
      this.communityLabels.size > 0 &&
      this.communityAssignments !== null;
    const communitySums: Map<
      number,
      { x: number; y: number; n: number }
    > | null = trackCommunities ? new Map() : null;
    // Per-community representative Z (golden-angle bucket from
    // set3DMode), captured from the first member encountered. Reused
    // below to project each community's 2D centroid through the
    // current rotation.
    const communityZ: Map<number, number> | null = trackCommunities
      ? new Map()
      : null;
    const assignments = this.communityAssignments;
    for (const node of this.nodeArray) {
      if (!node.visible) continue;
      // Skip the dragged node — its sprite position is controlled by pointermove
      if (this.dragNode === node) continue;
      const z = this.getNodeZ(node);
      const p = this.project3d(node.x, node.y, z);
      node.sprite.position.set(p.px, p.py);

      if (communitySums && communityZ && assignments) {
        const cid = assignments[node.id];
        if (cid !== undefined) {
          // Accumulate the *2D* physics position, not the projected
          // one (Fix #35 follow-up). Per-node projection bakes the
          // current rotation into each member's screen position, and
          // members at the back of the sphere drift differently than
          // members at the front — the mean wobbles frame to frame
          // because of perspective even though the cluster center
          // hasn't really moved. By averaging 2D first and projecting
          // the single centroid below, the label position becomes a
          // deterministic function of the rotation angle.
          const e = communitySums.get(cid);
          if (e) {
            e.x += node.x;
            e.y += node.y;
            e.n += 1;
          } else {
            communitySums.set(cid, { x: node.x, y: node.y, n: 1 });
            communityZ.set(cid, z);
          }
        }
      }
      // Clamp both ends: the lower bound prevents far nodes from vanishing,
      // the upper bound prevents near-singular perspective scale from exploding
      // sprite/label sizes when rz approaches -mode3dPerspectiveD during rotation.
      const depthScale = Math.max(0.3, Math.min(p.scale, 2));
      const depthAlpha = 0.3 + 0.6 * Math.max(Math.min(p.scale, 1), 0);

      // Depth sorting: closer nodes (lower rz) render on top (higher zIndex)
      // Negate rz so that closer = higher zIndex. Multiply by 1000 for integer precision.
      const depthZ = Math.round(-p.rz * 1000);
      node.sprite.zIndex = depthZ;

      // Apply highlight dimming in 3D (same as 2D applyVisuals)
      if (this.hasHighlight) {
        const isHighlighted = this.highlightNodes.has(node.id);
        const s = this.highlightBaseSize(node);
        node.sprite.scale.set((s / CIRCLE_RADIUS) * invScale * depthScale);
        node.sprite.alpha = isHighlighted
          ? depthAlpha
          : depthAlpha * NODE_OPACITY_DIMMED;
      } else {
        node.sprite.scale.set(
          (node.size / CIRCLE_RADIUS) * invScale * depthScale,
        );
        node.sprite.alpha = depthAlpha;
      }

      if (node.label?.visible) {
        const gap = (node.size + 4) * lblInv * depthScale;
        node.label.position.set(p.px + gap, p.py);
        node.label.scale.set(lblInv * depthScale * this.labelScaleMultiplier);
        node.label.zIndex = depthZ;
      }
    }

    // Redraw edges every frame in 3D (projection changes each frame)
    if (!this.edgesHiddenForInteraction) {
      this.redrawAllEdges3D();
    }

    // Update wayfinder positions every frame using the centroids we
    // accumulated above — no extra O(N) pass, just the same fluid
    // motion node labels get (Fix #34). The overlap cull and label
    // visibility logic still happen here, but they're O(K · K) on
    // ~20-30 communities — negligible.
    //
    // Project each community's 2D centroid through the current
    // rotation so the wayfinder swings around the sphere as one rigid
    // point (Fix #35 follow-up). Without this, every member's
    // perspective scaling factored into the mean and the centroid
    // jittered across frames — which made the overlap cull pick
    // different winners each frame, blinking labels on/off.
    if (communitySums && communityZ) {
      const projected = new Map<number, { x: number; y: number; n: number }>();
      for (const [cid, sum] of communitySums) {
        const cx = sum.x / sum.n;
        const cy = sum.y / sum.n;
        const cz = communityZ.get(cid) ?? 0;
        const cp = this.project3d(cx, cy, cz);
        projected.set(cid, { x: cp.px, y: cp.py, n: 1 });
      }
      this.updateCommunityLabelPositions(projected);
    }
  }

  /**
   * Edge redraw for 3D mode — uses projected positions instead of stored (x, y).
   */
  private redrawAllEdges3D(): void {
    if (!this.edgeBgGfx || !this.edgeFgGfx) return;
    this.edgeBgGfx.clear();
    this.edgeFgGfx.clear();
    if (!this.edgesEnabled) return;

    const bgAlpha = this.hasHighlight
      ? EDGE_OPACITY_DIMMED
      : EDGE_OPACITY_DEFAULT;
    const edgeWidth = 0.5 * this.zoomInvScale();

    for (const [color, indices] of this.edgeColorGroups) {
      let drawn = false;
      for (const i of indices) {
        const e = this.edges[i];
        if (this.hiddenLinkTypes.has(e.label)) continue;
        const s = this.nodes.get(e.sourceId);
        const t = this.nodes.get(e.targetId);
        if (!s?.visible || !t?.visible) continue;
        // Use projected positions (already set on sprites)
        const sx = s.sprite.position.x;
        const sy = s.sprite.position.y;
        const tx = t.sprite.position.x;
        const ty = t.sprite.position.y;
        this.drawEdge(this.edgeBgGfx, sx, sy, tx, ty);
        drawn = true;
      }
      if (drawn) {
        this.edgeBgGfx.stroke({
          width: edgeWidth,
          color: hexToNum(color),
          alpha: bgAlpha,
        });
      }
    }

    // Foreground highlight edges (same logic as 2D redrawAllEdges)
    if (this.hasHighlight) {
      const hlColorGroups = new Map<
        string,
        { sx: number; sy: number; tx: number; ty: number }[]
      >();
      for (let i = 0; i < this.edges.length; i++) {
        const e = this.edges[i];
        if (this.hiddenLinkTypes.has(e.label)) continue;
        const linkKey = `${e.sourceId}-${e.targetId}`;
        if (!this.highlightLinks.has(linkKey)) continue;
        const s = this.nodes.get(e.sourceId);
        const t = this.nodes.get(e.targetId);
        if (!s?.visible || !t?.visible) continue;
        let group = hlColorGroups.get(e.color);
        if (!group) {
          group = [];
          hlColorGroups.set(e.color, group);
        }
        group.push({
          sx: s.sprite.position.x,
          sy: s.sprite.position.y,
          tx: t.sprite.position.x,
          ty: t.sprite.position.y,
        });
      }
      for (const [color, lines] of hlColorGroups) {
        for (const l of lines) {
          this.drawEdge(this.edgeFgGfx, l.sx, l.sy, l.tx, l.ty);
        }
        this.edgeFgGfx.stroke({
          width: 1.5 * this.zoomInvScale(),
          color: hexToNum(color),
          alpha: EDGE_OPACITY_HIGHLIGHTED,
        });
      }
    }

    this.lastEdgeRedraw = performance.now();
  }

  is3DMode(): boolean {
    return this.mode3d;
  }

  set3DAutoRotate(enabled: boolean): void {
    this.mode3dAutoRotate = enabled;
    // No cull on rotation stop (Fix #38) — rotation state, manual or
    // auto, has no bearing on which labels should be visible.
  }

  set3DSpeed(speed: number): void {
    this.mode3dSpeed = speed;
  }

  set3DTilt(tilt: number): void {
    this.mode3dTilt = tilt;
  }

  set3DAngle(angle: number): void {
    this.mode3dAngle = angle;
  }
}
