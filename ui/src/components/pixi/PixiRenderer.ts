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
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_HIGHLIGHTED,
  EDGE_OPACITY_DIMMED,
  LABEL_SIZE,
  LABEL_FONT,
  LABEL_COLOR,
} from '../config/graphLayout';

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

// ─── Renderer Class ─────────────────────────────────────────────────────

export class PixiRenderer {
  app: Application | null = null;
  private world: Container | null = null;
  private edgeBgGfx: Graphics | null = null;
  private edgeFgGfx: Graphics | null = null;
  private nodeContainer: Container | null = null;
  private rippleContainer: Container | null = null;
  private labelContainer: Container | null = null;

  // Data
  private nodes: Map<string, PixiNode> = new Map();
  private nodeArray: PixiNode[] = []; // ordered array for indexed access (set at setData time)
  private nodeIdToIndex: Map<string, number> = new Map(); // id → index into nodeArray
  private edges: PixiEdge[] = [];
  private edgeIndex: Map<string, number[]> = new Map(); // nodeId → edge indices
  private edgeColorGroups: Map<string, number[]> = new Map(); // color → edge indices (pre-computed)

  // Viewport
  private vp: Viewport = { x: 0, y: 0, scale: 1 };
  private lastAppliedInvScale = 1; // tracks zoomInvScale() to detect changes
  private _lastEdgeScale = 1; // tracks vp.scale to avoid unnecessary edge redraws
  private width = 0;
  private height = 0;

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
  private pingNodes: Map<string, { startTime: number; glow: Sprite }> = new Map();
  private static readonly PING_DURATION = 900; // ms
  private static readonly PING_SCALE = 1.6; // peak node scale multiplier
  private static readonly GLOW_SIZE = 3; // glow sprite scale relative to node

  // Show-all-labels mode (toggled from control panel)
  private showAllLabels = true;

  // Label scale multiplier — independent of node size (default 1.0)
  private labelScaleMultiplier = 1.0;

  // Debounced label re-culling
  private lastLabelCull = 0;
  private readonly LABEL_CULL_INTERVAL = 500; // ms (throttle for non-debounced calls)
  private labelCullDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly LABEL_CULL_DEBOUNCE = 300; // ms — wait for zoom/interaction to stop

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
  private mode3dSpeed = 0.003; // auto-rotation speed (radians/frame)
  private mode3dAutoRotate = true;
  private mode3dDepthScale = 800;
  private mode3dPerspectiveD = 2000; // perspective distance
  private nodeDepthT: Map<string, number> = new Map(); // per-node depth [-1, 1]
  private mode3dRadius = 0; // computed from node positions at enable time

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
    await app.init({
      width,
      height,
      backgroundColor: 0x0d1117,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });

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

    // Viewport centered
    this.vp = { x: width / 2, y: height / 2, scale: 1 };
    this.lastAppliedInvScale = 1;

    // Render loop — apply viewport transform + counter-scale sprites + 3D
    app.ticker.add(() => {
      if (!this.world) return;
      this.world.position.set(this.vp.x, this.vp.y);
      this.world.scale.set(this.vp.scale);

      // 3D mode: project all nodes every frame (overrides normal position updates)
      if (this.mode3d) {
        this.update3D();
        // Debounce label cull when viewport is actively changing (zoom/pan/rotate).
        // Only schedule the debounce when something actually changed — not every frame.
        if (this.vp.scale !== this._lastEdgeScale) {
          this._lastEdgeScale = this.vp.scale;
          this.debouncedLabelCull();
        } else if (
          !this.mode3dAutoRotate &&
          this.labelCullDebounceTimer === null
        ) {
          // Rotation paused and no pending debounce — cull once for the static view
          this.debouncedLabelCull();
        }
        this.applyPingAnimations();
        return; // skip counter-scale — 3D handles its own scaling
      }

      // Counter-scale sprites when zoom OR exponent changes
      const currentInv = this.zoomInvScale();
      if (currentInv !== this.lastAppliedInvScale) {
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
    this.interactionAbort?.abort();
    this.interactionAbort = null;
    clearTextureCache(this.textureCache);
    for (const ping of this.pingNodes.values()) ping.glow.destroy();
    this.pingNodes.clear();
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

  /** Counter-scale all sprites, labels, and edges for current viewport scale. */
  private applyCounterScale(): void {
    const invScale = this.zoomInvScale();
    const wantLabel: PixiNode[] = [];

    for (const node of this.nodes.values()) {
      if (!node.visible) continue;
      // In 3D mode, skip sprite scale — the ticker's update3D() handles it.
      if (!this.mode3d) {
        const s =
          this.hasHighlight && !this.highlightNodes.has(node.id)
            ? node.size * NODE_SIZE_DIMMED_SCALE
            : node.size;
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
    this.applyLabelCulling(wantLabel, lblInv);

    // Update scale + position for visible labels (skip in 3D — ticker handles it)
    if (!this.mode3d) {
      const lm = this.labelScaleMultiplier;
      for (const node of wantLabel) {
        if (!node.label?.visible) continue;
        node.label.scale.set(lblInv * lm);
        const gap = (node.size + 4) * lblInv * lm;
        node.label.position.set(
          node.sprite.position.x + gap,
          node.sprite.position.y,
        );
      }
    }

    // Only redraw edges if scale actually changed (edge widths depend on zoom).
    // Skip if this is just an exponent change at the same zoom level —
    // edge geometry hasn't changed, only sprite sizes.
    const scaleChanged = this.vp.scale !== this._lastEdgeScale;
    this.lastAppliedInvScale = invScale;
    if (scaleChanged) {
      this._lastEdgeScale = this.vp.scale;
      this.redrawAllEdges();
    }
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
      const baseSize = (this.hasHighlight && !this.highlightNodes.has(id))
        ? node.size * NODE_SIZE_DIMMED_SCALE
        : node.size;
      node.sprite.scale.set((baseSize / CIRCLE_RADIUS) * invScale * pingScale);

      // ── Glow: follow the sprite's actual position (handles 3D projection) ──
      const glow = ping.glow;
      glow.position.copyFrom(node.sprite.position);
      // Scale the glow relative to node size
      const glowScale = (baseSize / CIRCLE_RADIUS) * invScale * PixiRenderer.GLOW_SIZE;
      glow.scale.set(glowScale * (1 + 0.3 * pulse)); // breathe slightly
      // Alpha envelope: quick ramp up (0→0.15), hold, then fade out
      const alphaIn = Math.min(1, t * 5); // 0→1 over first 20% of duration
      const alphaOut = Math.max(0, 1 - (t - 0.5) * 2); // 1→0 over last 50%
      glow.alpha = 0.45 * Math.min(alphaIn, alphaOut);
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
    const invScale = this.zoomInvScale();
    for (const [id, pos] of positions) {
      const node = this.nodes.get(id);
      if (!node || !node.visible) continue;
      node.x = pos.x;
      node.y = pos.y;
      // In 3D mode the ticker handles sprite positioning via projection each frame.
      if (!this.mode3d) {
        node.sprite.position.set(pos.x, pos.y);
        if (node.label?.visible) {
          const gap = (node.size + 4) * invScale;
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
      const invScale = this.zoomInvScale();
      for (let i = 0; i < len; i++) {
        const node = arr[i];
        if (!node.visible) continue;
        node.sprite.position.set(node.x, node.y);
        if (node.label?.visible) {
          const gap = (node.size + 4) * invScale;
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
  }

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
      if (!node) { missed.push(id); continue; }
      triggered.push(id);
      const tex = getGlowTexture(this.app, node.color, this.textureCache);
      const glow = new Sprite(tex);
      glow.anchor.set(0.5);
      glow.position.copyFrom(node.sprite.position);
      glow.alpha = 0;
      this.rippleContainer?.addChild(glow);
      this.pingNodes.set(id, { startTime: now, glow });
    }
    console.log('[PixiRenderer] triggerPing', { triggered: triggered.length, missed: missed.length, missedIds: missed.slice(0, 3) });
  }

  setNodeVisibility(visibleIds: Set<string>): void {
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
          const s = isHighlighted
            ? node.size
            : node.size * NODE_SIZE_DIMMED_SCALE;
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
    // Sort by size descending — largest (highest degree) nodes get labels first
    candidates.sort((a, b) => b.size - a.size);

    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const lm = this.labelScaleMultiplier;
    const screenLabelScale = invScale * lm * this.vp.scale;
    const labelH = (LABEL_SIZE + 4) * screenLabelScale;

    for (const node of candidates) {
      const gap = (node.size + 4) * invScale * lm;
      // Use sprite position (correct in both 2D and 3D modes)
      const nx = node.sprite.position.x;
      const ny = node.sprite.position.y;

      const sx = (nx + gap) * this.vp.scale + this.vp.x;
      const sy = ny * this.vp.scale + this.vp.y - labelH / 2;
      const textLen = (node.graphNode.name || node.id).length;
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
      // In 3D mode the ticker redraws edges; just re-cull labels for new view angle
      this.lastLabelCull = 0;
      this.throttledLabelCull();
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

  // ─── Bloom ─────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setBloomEnabled(_enabled: boolean): void {
    // Placeholder — full bloom requires pixi-filters v6 package.
    // When available, creates AdvancedBloomFilter on app.stage.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setBloomStrength(_strength: number): void {
    // Placeholder for bloom strength control — requires pixi-filters.
  }

  // ─── Labels ───────────────────────────────────────────────────────

  /** Create a label Text for a node. Positioned to the right of the node. */
  private createLabel(node: PixiNode): Text {
    const lblInv = this.labelInvScale();
    const label = new Text({
      text: node.graphNode.name || node.id,
      style: new TextStyle({
        fontSize: LABEL_SIZE,
        fontFamily: LABEL_FONT,
        fontWeight: 'bold',
        fill: LABEL_COLOR,
        dropShadow: {
          alpha: 0.9,
          blur: 3,
          color: '#0d1117',
          distance: 0,
        },
      }),
    });
    // Anchor left-center, positioned to the right of the node
    label.anchor.set(0, 0.5);
    const lm = this.labelScaleMultiplier;
    label.scale.set(lblInv * lm);
    const gap = (node.size + 4) * lblInv * lm;
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
    // Re-run the full counter-scale pass which includes label culling.
    // When showAllLabels=true, all visible nodes become candidates but still
    // go through overlap culling so labels don't pile up.
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

  zoomToNodes(nodeIds: Iterable<string>, duration = 300): void {
    const positions: { x: number; y: number }[] = [];
    for (const id of nodeIds) {
      const node = this.nodes.get(id);
      if (!node?.visible) continue;
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
    const target = fitBounds(bounds, this.width, this.height, 120);

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
    let movedDistance = 0;
    // Track last pointer position to compute pan deltas manually,
    // avoiding movementX/Y which includes the full distance since pointerdown
    // on the first pointermove event after crossing the drag threshold.
    let lastPointerX = 0;
    let lastPointerY = 0;

    canvas.addEventListener(
      'pointerdown',
      (e) => {
        pointerDown = true;
        movedDistance = 0;
        lastPointerX = e.clientX;
        lastPointerY = e.clientY;
        this.pointerDownPos = { x: e.clientX, y: e.clientY };

        // Hit test
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const world = screenToWorld(screenX, screenY, this.vp);
        const hitNode = this.findNodeAt(world.x, world.y, 15 / this.vp.scale);

        if (hitNode) {
          this.pendingDragNode = hitNode;
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
          canvas.style.cursor = hit ? 'pointer' : 'default';
          return;
        }

        if (!this.pointerDownPos) return;

        const dx = e.clientX - this.pointerDownPos.x;
        const dy = e.clientY - this.pointerDownPos.y;
        movedDistance = Math.sqrt(dx * dx + dy * dy);

        if (movedDistance > CLICK_THRESHOLD) {
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
              const gap = (this.dragNode.size + 4) * this.zoomInvScale();
              this.dragNode.label.position.set(world.x + gap, world.y);
            }
            this.callbacks.onNodeDragMove?.(this.dragNode.id, world.x, world.y);
            this.redrawDragEdges(this.dragNode);
          } else if (this.mode3d) {
            // 3D mode: drag rotates the camera instead of panning
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
            this.debouncedLabelCull();
          } else {
            // Pan — compute delta from last pointer position (not movementX/Y)
            // to avoid a jump on the first move after crossing the drag threshold.
            const panDx = e.clientX - lastPointerX;
            const panDy = e.clientY - lastPointerY;
            this.vp.x += panDx;
            this.vp.y += panDy;
            // Hide edges during pan for instant response
            this.hideEdgesForInteraction();
            this.debouncedLabelCull();
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
      } else if (movedDistance <= CLICK_THRESHOLD) {
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
          // Resume 3D rotation on stage click (deselect)
          if (this.mode3d && !this.mode3dAutoRotate) {
            this.mode3dAutoRotate = true;
            this.callbacks.on3DAutoRotateChange?.(true);
          }
          this.callbacks.onStageClick?.();
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
    this.mode3d = enabled;
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

    // Compute bounding radius from current positions
    let maxDist = 0;
    for (const node of this.nodeArray) {
      const d = Math.sqrt(node.x * node.x + node.y * node.y);
      if (d > maxDist) maxDist = d;
    }
    this.mode3dRadius = maxDist * 1.1 || 500;

    // Assign Z depth per node: community-based + jitter
    this.nodeDepthT.clear();
    if (communityAssignments) {
      const uniqueComms = [
        ...new Set(Object.values(communityAssignments)),
      ].sort((a, b) => a - b);
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

    // Scale perspective distance to graph size so the 3D effect is proportional.
    // PerspectiveD should be ~3-4x the radius for a natural look.
    this.mode3dPerspectiveD = this.mode3dRadius * 3;
    // Depth scale relative to radius — controls how "thick" the sphere is
    this.mode3dDepthScale = this.mode3dRadius * 0.6;

    this.mode3dAngle = 0;
    this.mode3dAutoRotate = true;

    // Run one update3D pass to set projected positions, then cull labels
    this.update3D();
    this.lastLabelCull = 0;
    this.throttledLabelCull();
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
    if (this.mode3dAutoRotate) {
      this.mode3dAngle += this.mode3dSpeed;
    }

    const invScale = this.zoomInvScale();
    const lblInv = this.labelInvScale();
    for (const node of this.nodeArray) {
      if (!node.visible) continue;
      // Skip the dragged node — its sprite position is controlled by pointermove
      if (this.dragNode === node) continue;
      const z = this.getNodeZ(node);
      const p = this.project3d(node.x, node.y, z);
      node.sprite.position.set(p.px, p.py);
      const depthScale = Math.max(p.scale, 0.3);
      const depthAlpha = 0.3 + 0.6 * Math.max(Math.min(p.scale, 1), 0);

      // Depth sorting: closer nodes (lower rz) render on top (higher zIndex)
      // Negate rz so that closer = higher zIndex. Multiply by 1000 for integer precision.
      const depthZ = Math.round(-p.rz * 1000);
      node.sprite.zIndex = depthZ;

      // Apply highlight dimming in 3D (same as 2D applyVisuals)
      if (this.hasHighlight) {
        const isHighlighted = this.highlightNodes.has(node.id);
        const s = isHighlighted
          ? node.size
          : node.size * NODE_SIZE_DIMMED_SCALE;
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
    // Force immediate label re-cull when rotation stops
    if (!enabled) {
      this.lastLabelCull = 0;
      this.throttledLabelCull();
    }
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
