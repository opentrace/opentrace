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
import { getCircleTexture, clearTextureCache, CIRCLE_RADIUS } from './spriteTextures';
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
  LABEL_RENDERED_SIZE_THRESHOLD,
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
  private labelNodes: Set<string> = new Set();
  private hasHighlight = false;

  // Show-all-labels mode (toggled from control panel)
  private showAllLabels = false;

  // Zoom-size exponent: controls how nodes/edges scale with zoom.
  // 0 = nodes scale fully with zoom (world-space), 1 = fixed screen size.
  // Default 0.5 matches ZOOM_SIZE_EXPONENT=0.7 feel.
  private zoomSizeExponent = 0.8;

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

  init(
    container: HTMLElement,
    width: number,
    height: number,
  ): Promise<void> {
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
    world.addChild(nodeContainer);
    this.nodeContainer = nodeContainer;

    const labelContainer = new Container();
    world.addChild(labelContainer);
    this.labelContainer = labelContainer;

    // Viewport centered
    this.vp = { x: width / 2, y: height / 2, scale: 1 };
    this.lastAppliedInvScale = 1;

    // Render loop — apply viewport transform + counter-scale sprites
    app.ticker.add(() => {
      if (!this.world) return;
      this.world.position.set(this.vp.x, this.vp.y);
      this.world.scale.set(this.vp.scale);

      // Counter-scale sprites when zoom OR exponent changes
      const currentInv = this.zoomInvScale();
      if (currentInv !== this.lastAppliedInvScale) {
        this.applyCounterScale();
      }
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
    this.interactionAbort?.abort();
    this.interactionAbort = null;
    clearTextureCache(this.textureCache);
    this.nodes.clear();
    this.nodeArray = [];
    this.nodeIdToIndex.clear();
    this.edges = [];
    this.edgeIndex.clear();
    this.edgeColorGroups.clear();
    if (this.app) {
      try {
        this.app.destroy({ removeView: true }, { children: true, texture: true });
      } catch {
        // Fallback for different Pixi versions
        try { this.app.destroy(true, { children: true }); } catch { /* ignore */ }
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
    if (this.destroyed || !this.app || !this.nodeContainer || !this.labelContainer) return;

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
      const sourceId = typeof gl.source === 'string' ? gl.source : (gl.source as GraphNode).id;
      const targetId = typeof gl.target === 'string' ? gl.target : (gl.target as GraphNode).id;
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
      if (!sIdx) { sIdx = []; this.edgeIndex.set(sourceId, sIdx); }
      sIdx.push(idx);
      let tIdx = this.edgeIndex.get(targetId);
      if (!tIdx) { tIdx = []; this.edgeIndex.set(targetId, tIdx); }
      tIdx.push(idx);
    }

    // Pre-group edges by color for batched rendering
    this.edgeColorGroups.clear();
    for (let i = 0; i < this.edges.length; i++) {
      const color = this.edges[i].color;
      let group = this.edgeColorGroups.get(color);
      if (!group) { group = []; this.edgeColorGroups.set(color, group); }
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

  /** Counter-scale all sprites, labels, and edges for current viewport scale. */
  private applyCounterScale(): void {
    const invScale = this.zoomInvScale();
    const wantLabel: PixiNode[] = [];

    for (const node of this.nodes.values()) {
      if (!node.visible) continue;
      const s = (this.hasHighlight && !this.highlightNodes.has(node.id))
        ? node.size * NODE_SIZE_DIMMED_SCALE
        : node.size;
      node.sprite.scale.set((s / CIRCLE_RADIUS) * invScale);

      const autoLabel = !this.hasHighlight && node.size >= LABEL_RENDERED_SIZE_THRESHOLD;
      if (this.showAllLabels || this.labelNodes.has(node.id) || autoLabel) {
        wantLabel.push(node);
      } else if (node.label) {
        node.label.visible = false;
      }
    }

    this.applyLabelCulling(wantLabel, invScale);
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

  // ─── Position Updates (called from simulation tick) ───────────────

  updatePositions(positions: Map<string, { x: number; y: number }>): void {
    // Cache invScale once for this tick (avoid repeated Math.pow)
    const invScale = this.zoomInvScale();
    for (const [id, pos] of positions) {
      const node = this.nodes.get(id);
      if (!node || !node.visible) continue;
      node.x = pos.x;
      node.y = pos.y;
      node.sprite.position.set(pos.x, pos.y);
      // Update label position if visible (right of node)
      if (node.label?.visible) {
        const gap = (node.size + 4) * invScale;
        node.label.position.set(pos.x + gap, pos.y);
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
    const invScale = this.zoomInvScale();
    const len = Math.min(arr.length, buffer.length / 2);

    for (let i = 0; i < len; i++) {
      const node = arr[i];
      if (!node.visible) continue;
      const x = buffer[i * 2];
      const y = buffer[i * 2 + 1];
      node.x = x;
      node.y = y;
      node.sprite.position.set(x, y);
      if (node.label?.visible) {
        const gap = (node.size + 4) * invScale;
        node.label.position.set(x + gap, y);
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
    if (!skipForSettle && now - this.lastEdgeRedraw >= this.bp.edgeRedrawInterval) {
      if (this.dragNode) {
        this.redrawDragEdges(this.dragNode);
      } else {
        this.redrawAllEdges();
      }
    }

    // Throttled quadtree rebuild — skip if positions haven't changed
    if (this.quadtreeDirty && now - this.lastQuadtreeRebuild > QUADTREE_REBUILD_INTERVAL) {
      this.rebuildQuadtree();
      this.quadtreeDirty = false;
    }
  }

  // ─── Visual State ─────────────────────────────────────────────────

  setHighlight(
    highlightNodes: Set<string>,
    highlightLinks: Set<string>,
    labelNodes: Set<string>,
  ): void {
    this.highlightNodes = highlightNodes;
    this.highlightLinks = highlightLinks;
    this.labelNodes = labelNodes;
    this.hasHighlight = highlightNodes.size > 0;
    this.applyVisuals();
  }

  setNodeVisibility(visibleIds: Set<string>): void {
    for (const [id, node] of this.nodes) {
      const vis = visibleIds.has(id);
      node.visible = vis;
      node.sprite.visible = vis;
      if (node.label) node.label.visible = vis && this.labelNodes.has(id);
    }
    this.redrawAllEdges();
  }

  updateNodeColors(nodeColors: Map<string, string>): void {
    if (!this.app) return;
    for (const [id, color] of nodeColors) {
      const node = this.nodes.get(id);
      if (!node) continue;
      node.color = color;
      node.sprite.texture = getCircleTexture(this.app, color, this.textureCache);
    }
  }

  private applyVisuals(): void {
    if (!this.app) return;
    const invScale = this.zoomInvScale();

    // Pass 1: update sprites + determine which labels want to show
    const wantLabel: PixiNode[] = [];
    for (const [id, node] of this.nodes) {
      if (!node.visible) continue;

      if (this.hasHighlight) {
        const isHighlighted = this.highlightNodes.has(id);
        node.sprite.alpha = isHighlighted ? 1.0 : NODE_OPACITY_DIMMED;
        const s = isHighlighted ? node.size : node.size * NODE_SIZE_DIMMED_SCALE;
        node.sprite.scale.set((s / CIRCLE_RADIUS) * invScale);
      } else {
        node.sprite.alpha = 0.9;
        node.sprite.scale.set((node.size / CIRCLE_RADIUS) * invScale);
      }

      const autoLabel = !this.hasHighlight && node.size >= LABEL_RENDERED_SIZE_THRESHOLD;
      if (this.showAllLabels || this.labelNodes.has(id) || autoLabel) {
        wantLabel.push(node);
      } else if (node.label) {
        node.label.visible = false;
      }
    }

    // Pass 2: cull overlapping labels (largest nodes first)
    this.applyLabelCulling(wantLabel, invScale);

    this.redrawAllEdges();
  }

  /**
   * Show labels for the given nodes, culling any that overlap a previously
   * placed label. Nodes are processed largest-first so important nodes win.
   * Labels are only created (expensive Text objects) for nodes that pass culling.
   */
  private applyLabelCulling(candidates: PixiNode[], invScale: number): void {
    // Sort by size descending — largest (highest degree) nodes get labels first
    candidates.sort((a, b) => b.size - a.size);

    // Occupied regions in screen coordinates
    const boxes: { x: number; y: number; w: number; h: number }[] = [];
    const labelH = LABEL_SIZE + 4;

    for (const node of candidates) {
      const gap = (node.size + 4) * invScale;

      // Compute screen-space bounding box for overlap test BEFORE creating the label
      const sx = (node.x + gap) * this.vp.scale + this.vp.x;
      const sy = node.y * this.vp.scale + this.vp.y - labelH / 2;
      const textLen = (node.graphNode.name || node.id).length;
      const sw = textLen * LABEL_SIZE * 0.6;
      const sh = labelH;

      // Check overlap
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
        // Only create the label Text if it passes culling
        if (!node.label) {
          node.label = this.createLabel(node);
        }
        node.label.visible = true;
        node.label.scale.set(invScale);
        node.label.position.set(node.x + gap, node.y);
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
    sx: number, sy: number,
    tx: number, ty: number,
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
    return sx >= -mx && sx <= this.width + mx && sy >= -my && sy <= this.height + my;
  }

  private redrawAllEdges(): void {
    if (!this.edgeBgGfx || !this.edgeFgGfx) return;

    this.edgeBgGfx.clear();
    this.edgeFgGfx.clear();

    if (!this.edgesEnabled) return;

    const bgAlpha = this.hasHighlight ? EDGE_OPACITY_DIMMED : EDGE_OPACITY_DEFAULT;
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
        if (doCull && !this.isInViewport(s.x, s.y) && !this.isInViewport(t.x, t.y)) continue;
        this.drawEdge(this.edgeBgGfx, s.x, s.y, t.x, t.y);
        drawn = true;
      }
      if (drawn) {
        this.edgeBgGfx.stroke({ width: edgeWidth, color: hexToNum(color), alpha: bgAlpha });
      }
    }

    // Foreground highlight edges
    if (this.hasHighlight) {
      const hlColorGroups = new Map<string, { sx: number; sy: number; tx: number; ty: number }[]>();
      for (let i = 0; i < this.edges.length; i++) {
        const e = this.edges[i];
        if (this.hiddenLinkTypes.has(e.label)) continue;
        const linkKey = `${e.sourceId}-${e.targetId}`;
        if (!this.highlightLinks.has(linkKey)) continue;
        const s = this.nodes.get(e.sourceId);
        const t = this.nodes.get(e.targetId);
        if (!s?.visible || !t?.visible) continue;
        let group = hlColorGroups.get(e.color);
        if (!group) { group = []; hlColorGroups.set(e.color, group); }
        group.push({ sx: s.x, sy: s.y, tx: t.x, ty: t.y });
      }
      for (const [color, lines] of hlColorGroups) {
        for (const l of lines) {
          this.drawEdge(this.edgeFgGfx, l.sx, l.sy, l.tx, l.ty);
        }
        this.edgeFgGfx.stroke({ width: 1.5 * this.zoomInvScale(), color: hexToNum(color), alpha: EDGE_OPACITY_HIGHLIGHTED });
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
    const dragGroups = new Map<string, { sx: number; sy: number; tx: number; ty: number }[]>();
    for (const idx of myEdges) {
      const e = this.edges[idx];
      if (this.hiddenLinkTypes.has(e.label)) continue;
      const s = this.nodes.get(e.sourceId);
      const t = this.nodes.get(e.targetId);
      if (!s || !t) continue;
      let group = dragGroups.get(e.color);
      if (!group) { group = []; dragGroups.set(e.color, group); }
      group.push({ sx: s.x, sy: s.y, tx: t.x, ty: t.y });
      const neighborId = e.sourceId === node.id ? e.targetId : e.sourceId;
      neighborIds.add(neighborId);
    }
    for (const [color, lines] of dragGroups) {
      for (const l of lines) {
        this.drawEdge(this.edgeBgGfx, l.sx, l.sy, l.tx, l.ty);
      }
      this.edgeBgGfx.stroke({ width: 1 * this.zoomInvScale(), color: hexToNum(color), alpha: 0.6 });
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
    this.edgeBgGfx.stroke({ width: 0.4 * this.zoomInvScale(), color: EDGE_FALLBACK_COLOR, alpha: 0.2 });

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
    this.redrawAllEdges();
    this.applyCounterScale();
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

  getZoomSizeExponent(): number {
    return this.zoomSizeExponent;
  }

  setHiddenLinkTypes(hidden: Set<string>): void {
    this.hiddenLinkTypes = hidden;
    this.redrawAllEdges();
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
    const invScale = this.zoomInvScale();
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
    label.scale.set(invScale);
    const gap = (node.size + 4) * this.zoomInvScale();
    label.position.set(node.x + gap, node.y);
    this.labelContainer!.addChild(label);
    return label;
  }

  setShowAllLabels(show: boolean): void {
    this.showAllLabels = show;
    if (!this.app || !this.labelContainer) return;

    const invScale = this.zoomInvScale();
    for (const [id, node] of this.nodes) {
      if (!node.visible) continue;

      if (show) {
        if (!node.label) {
          node.label = this.createLabel(node);
        }
        node.label.visible = true;
        node.label.scale.set(invScale);
      } else {
        if (node.label) {
          node.label.visible = this.labelNodes.has(id);
        }
      }
    }
  }

  // ─── Quadtree ─────────────────────────────────────────────────────

  private rebuildQuadtree(): void {
    const visibleNodes: PixiNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.visible) visibleNodes.push(node);
    }
    this._quadtree = quadtree<PixiNode>()
      .x((d) => d.x)
      .y((d) => d.y)
      .addAll(visibleNodes);
    this.lastQuadtreeRebuild = performance.now();
  }

  /** Find the nearest node to (worldX, worldY) within maxDistance. */
  findNodeAt(worldX: number, worldY: number, maxDistance = 20): PixiNode | null {
    if (!this._quadtree) return null;
    // d3-quadtree.find() is a native optimized nearest-neighbor search
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
      .map((n) => ({ x: n.x, y: n.y }));
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
      (vp) => { this.vp = vp; },
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
      if (node?.visible) positions.push({ x: node.x, y: node.y });
    }
    if (positions.length === 0) return;
    const bounds = computeBounds(positions);
    const target = fitBounds(bounds, this.width, this.height, 120);

    this.cancelAnimation?.();
    this.cancelAnimation = animateViewport(
      this.vp,
      target,
      duration,
      (vp) => { this.vp = vp; },
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
    this.cancelAnimation = animateViewport(this.vp, target, duration,
      (vp) => { this.vp = vp; },
      () => { this.redrawAllEdges(); this.cancelAnimation = null; },
    );
  }

  zoomOut(duration = 200): void {
    const target: Viewport = {
      x: this.vp.x,
      y: this.vp.y,
      scale: this.vp.scale / 1.5,
    };
    this.cancelAnimation?.();
    this.cancelAnimation = animateViewport(this.vp, target, duration,
      (vp) => { this.vp = vp; },
      () => { this.redrawAllEdges(); this.cancelAnimation = null; },
    );
  }

  resetCamera(duration = 300): void {
    this.zoomToFit(duration);
  }

  // ─── Interaction Setup ────────────────────────────────────────────

  setCallbacks(callbacks: InteractionCallbacks): void {
    this.callbacks = callbacks;
  }

  private setupInteraction(canvas: HTMLCanvasElement, signal: AbortSignal): void {
    // Wheel zoom — deltaY-proportional for smooth, magnitude-aware zooming
    canvas.addEventListener('wheel', (e) => {
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
    }, { passive: false, signal });

    // Pointer events for pan / drag / click
    let pointerDown = false;
    let movedDistance = 0;
    // Track last pointer position to compute pan deltas manually,
    // avoiding movementX/Y which includes the full distance since pointerdown
    // on the first pointermove event after crossing the drag threshold.
    let lastPointerX = 0;
    let lastPointerY = 0;

    canvas.addEventListener('pointerdown', (e) => {
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
    }, { signal });

    let lastHoverCheck = 0;
    canvas.addEventListener('pointermove', (e) => {
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
        } else {
          // Pan — compute delta from last pointer position (not movementX/Y)
          // to avoid a jump on the first move after crossing the drag threshold.
          const panDx = e.clientX - lastPointerX;
          const panDy = e.clientY - lastPointerY;
          this.vp.x += panDx;
          this.vp.y += panDy;
          // Hide edges during pan for instant response
          this.hideEdgesForInteraction();
        }
      }

      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
    }, { signal });

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
          this.callbacks.onNodeClick?.(hitNode.graphNode);
        } else {
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
}
