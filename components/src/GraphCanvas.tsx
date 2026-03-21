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

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { SigmaContainer, useSigma } from '@react-sigma/core';
import { EdgeCurvedArrowProgram } from '@sigma/edge-curve';
import { EdgeLineProgram } from 'sigma/rendering';
import '@react-sigma/core/lib/style.css';
import { useSelectionPulse } from './sigma/useSelectionPulse';

import type { GraphNode, GraphLink, SelectedEdge } from './types/graph';
import type {
  LayoutConfig,
  FilterState,
  VisualState,
  CommunityData,
} from './graph/types';
import { useGraphInstance } from './graph/useGraphInstance';
import { useGraphFilters } from './graph/useGraphFilters';
import { useGraphVisuals } from './graph/useGraphVisuals';
import { useCommunities } from './graph/useCommunities';
import { useHighlights } from './graph/useHighlights';
import LayoutPipeline, { type OptimizeStatus } from './graph/LayoutPipeline';
import { drawNodeHover, setHoveredNodeKey } from './graph/drawNodeHover';
import { drawNodeLabel, resetLabelGrid } from './graph/drawNodeLabel';
import { zoomToNodes, zoomToFit } from './sigma/zoomToNodes';
import {
  ZOOM_SIZE_EXPONENT,
  EDGE_PROGRAM_THRESHOLD,
  LABEL_RENDERED_SIZE_THRESHOLD,
  LABEL_SIZE,
  LABEL_FONT,
  LABEL_COLOR,
  DEFAULT_LAYOUT_CONFIG,
} from './config/graphLayout';
import type { GetSubTypeFn } from './graph/types';

// ─── Types ──────────────────────────────────────────────────────────────

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
  /** Animation settings (glow, pulse, particles, smooth layout). */
  animationSettings?: AnimationSettings;
  /** Called when a node is clicked. */
  onNodeClick?: (node: GraphNode) => void;
  /** Called when an edge is clicked. */
  onEdgeClick?: (edge: SelectedEdge) => void;
  /** Called when the background (stage) is clicked. */
  onStageClick?: () => void;
  /** Called when the optimize status changes. */
  onOptimizeStatus?: (status: OptimizeStatus | null) => void;
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
}

// ─── Internal components ────────────────────────────────────────────────

/** Captures the sigma instance ref from inside SigmaContainer. */
function SigmaRefCapture({
  onReady,
}: {
  onReady: (sigma: ReturnType<typeof useSigma>) => void;
}) {
  const sigma = useSigma();
  const readyRef = useRef(false);

  useEffect(() => {
    if (!readyRef.current) {
      readyRef.current = true;
      onReady(sigma);
    }
  }, [sigma, onReady]);

  // Reset label density grid before each render
  useEffect(() => {
    const s = sigma as unknown as import('sigma').Sigma;
    const handler = () => resetLabelGrid();
    s.on('beforeRender', handler);
    return () => {
      s.off('beforeRender', handler);
    };
  }, [sigma]);

  return null;
}

/** Registers click/drag events inside the SigmaContainer context. */
function GraphEventHandler({
  onNodeClick,
  onEdgeClick,
  onStageClick,
}: {
  onNodeClick?: (node: GraphNode) => void;
  onEdgeClick?: (edge: SelectedEdge) => void;
  onStageClick?: () => void;
}) {
  const sigma = useSigma();

  useEffect(() => {
    const container = sigma.getContainer();
    const graph = sigma.getGraph();
    const s = sigma as unknown as import('sigma').Sigma;

    const mouseCanvas = container.querySelector(
      '.sigma-mouse',
    ) as HTMLElement | null;
    let overNode = false;
    let overEdge = false;

    // ── Drag state ────────────────────────────────────────────────
    let draggedNode: string | null = null;
    let isDragging = false;

    function updateCursor() {
      const value = isDragging
        ? 'grabbing'
        : overNode || overEdge
          ? 'pointer'
          : 'grab';
      container.style.cursor = value;
      if (mouseCanvas) mouseCanvas.style.cursor = value;
    }
    updateCursor();

    const handlers = {
      enterNode: ({ node }: { node: string }) => {
        setHoveredNodeKey(node);
        overNode = true;
        updateCursor();
      },
      leaveNode: () => {
        setHoveredNodeKey(null);
        overNode = false;
        updateCursor();
      },
      enterEdge: () => {
        overEdge = true;
        updateCursor();
      },
      leaveEdge: () => {
        overEdge = false;
        updateCursor();
      },
      // Start drag on mousedown over a node
      downNode: ({ node }: { node: string }) => {
        draggedNode = node;
        isDragging = false; // not dragging yet — only on mousemove
        // Fix node so FA2 doesn't fight the drag
        graph.setNodeAttribute(node, 'fixed', true);
        // Disable sigma's built-in camera drag while we're dragging a node
        s.getCamera().disable();
      },
      clickNode: ({ node }: { node: string }) => {
        // If we were dragging, don't fire click
        if (isDragging) {
          isDragging = false;
          return;
        }
        if (!onNodeClick) return;
        const attrs = graph.getNodeAttributes(node);
        const graphNode = attrs._graphNode as GraphNode | undefined;
        if (graphNode) onNodeClick(graphNode);
      },
      clickEdge: ({ edge }: { edge: string }) => {
        if (!onEdgeClick) return;
        const attrs = graph.getEdgeAttributes(edge);
        const source = graph.source(edge);
        const target = graph.target(edge);
        const sourceAttrs = graph.getNodeAttributes(source);
        const targetAttrs = graph.getNodeAttributes(target);
        onEdgeClick({
          source,
          target,
          label: (attrs.label as string) || 'unknown',
          properties: (
            attrs._graphLink as { properties?: Record<string, unknown> }
          )?.properties,
          sourceNode: sourceAttrs._graphNode as GraphNode | undefined,
          targetNode: targetAttrs._graphNode as GraphNode | undefined,
        });
      },
      clickStage: () => {
        onStageClick?.();
      },
    };

    // ── Mouse move/up for drag (on the container, not sigma events) ──
    function onMouseMove(e: MouseEvent) {
      if (!draggedNode) return;
      isDragging = true;
      updateCursor();

      // Convert viewport coords to graph coords
      const pos = s.viewportToGraph({
        x: e.offsetX,
        y: e.offsetY,
      });
      graph.setNodeAttribute(draggedNode, 'x', pos.x);
      graph.setNodeAttribute(draggedNode, 'y', pos.y);

      // Prevent sigma from processing this as a camera pan
      e.preventDefault();
    }

    function onMouseUp() {
      if (draggedNode) {
        // Keep node fixed so FA2's worker doesn't snap it back to
        // its stale position. The node stays where it was dropped
        // and acts as an anchor for its neighbors.
        draggedNode = null;
        s.getCamera().enable();
        updateCursor();
      }
    }

    // Register sigma events
    sigma.on('enterNode', handlers.enterNode);
    sigma.on('leaveNode', handlers.leaveNode);
    sigma.on('enterEdge', handlers.enterEdge);
    sigma.on('leaveEdge', handlers.leaveEdge);
    sigma.on('downNode', handlers.downNode);
    sigma.on('clickNode', handlers.clickNode);
    sigma.on('clickEdge', handlers.clickEdge);
    sigma.on('clickStage', handlers.clickStage);

    // Mouse events on the container for drag tracking
    const mouseTarget = mouseCanvas ?? container;
    mouseTarget.addEventListener('mousemove', onMouseMove);
    mouseTarget.addEventListener('mouseup', onMouseUp);
    mouseTarget.addEventListener('mouseleave', onMouseUp);

    return () => {
      sigma.off('enterNode', handlers.enterNode);
      sigma.off('leaveNode', handlers.leaveNode);
      sigma.off('enterEdge', handlers.enterEdge);
      sigma.off('leaveEdge', handlers.leaveEdge);
      sigma.off('downNode', handlers.downNode);
      sigma.off('clickNode', handlers.clickNode);
      sigma.off('clickEdge', handlers.clickEdge);
      sigma.off('clickStage', handlers.clickStage);

      mouseTarget.removeEventListener('mousemove', onMouseMove);
      mouseTarget.removeEventListener('mouseup', onMouseUp);
      mouseTarget.removeEventListener('mouseleave', onMouseUp);
    };
  }, [sigma, onNodeClick, onEdgeClick, onStageClick]);

  return null;
}

/** Renders animation hooks that require useSigma() context. */
function AnimationEffects({
  selectedNodeId,
  animationSettings,
}: {
  selectedNodeId: string | null;
  animationSettings: AnimationSettings;
}) {
  const sigma = useSigma() as unknown as import('sigma').Sigma;

  useSelectionPulse(
    sigma,
    selectedNodeId,
    animationSettings.selectionPulse,
  );

  return null;
}

// ─── Default sub-type extractor ─────────────────────────────────────────

const defaultGetSubType: GetSubTypeFn = () => null;

// ─── Main component ─────────────────────────────────────────────────────

const EMPTY_STRING_SET = new Set<string>();
const EMPTY_NUMBER_SET = new Set<number>();
const EMPTY_SUB_TYPES = new Map<string, { subType: string; count: number }[]>();
const DEFAULT_ANIMATION: AnimationSettings = {
  selectionPulse: true,
};

const GraphCanvas = memo(
  forwardRef<GraphCanvasHandle, GraphCanvasProps>(
    function GraphCanvas(props, ref) {
      const {
        nodes,
        links,
        width,
        height,
        layoutConfig = DEFAULT_LAYOUT_CONFIG,
        colorMode = 'type',
        hiddenNodeTypes = EMPTY_STRING_SET,
        hiddenLinkTypes = EMPTY_STRING_SET,
        hiddenSubTypes = EMPTY_STRING_SET,
        hiddenCommunities = EMPTY_NUMBER_SET,
        searchQuery = '',
        selectedNodeId = null,
        hops = 2,
        getSubType = defaultGetSubType,
        highlightNodes: highlightNodesProp,
        highlightLinks: highlightLinksProp,
        labelNodes: labelNodesProp,
        availableSubTypes = EMPTY_SUB_TYPES,
        zIndex: zIndexEnabled = false,
        communityData: communityDataProp,
        animationSettings = DEFAULT_ANIMATION,
        onNodeClick,
        onEdgeClick,
        onStageClick,
        onOptimizeStatus,
        className,
        style,
      } = props;

      const sigmaRef = useRef<ReturnType<typeof useSigma> | null>(null);
      const [optimizeTick, setOptimizeTick] = useState(0);

      // Community detection — use external data if provided, otherwise compute
      const internalCommunityData = useCommunities(nodes, links, layoutConfig);
      const communityData = communityDataProp ?? internalCommunityData;

      // Build filter state
      const filterState: FilterState = useMemo(
        () => ({
          hiddenNodeTypes,
          hiddenLinkTypes,
          hiddenSubTypes,
          hiddenCommunities,
        }),
        [hiddenNodeTypes, hiddenLinkTypes, hiddenSubTypes, hiddenCommunities],
      );

      // Graph instance with layout
      const { graph, layoutReady } = useGraphInstance({
        allNodes: nodes,
        allLinks: links,
        communityData,
        layoutConfig,
      });

      // Apply filters
      useGraphFilters(
        graph,
        layoutReady,
        filterState,
        communityData.assignments,
        availableSubTypes,
        getSubType,
      );

      // Compute highlights internally
      const internalHighlights = useHighlights(
        graph,
        layoutReady,
        nodes,
        links,
        searchQuery,
        selectedNodeId ?? null,
        hops,
        filterState,
      );

      // Use external overrides if provided, otherwise use internal highlights
      const effectiveHighlightNodes =
        highlightNodesProp ?? internalHighlights.highlightNodes;
      const effectiveHighlightLinks =
        highlightLinksProp ?? internalHighlights.highlightLinks;
      const effectiveLabelNodes =
        labelNodesProp ?? internalHighlights.labelNodes;

      // Compute degree map for visual sizing
      const degreeMap = useMemo(() => {
        const map = new Map<string, number>();
        links.forEach((l) => {
          const sourceId =
            typeof l.source === 'string'
              ? l.source
              : (l.source as GraphNode).id;
          const targetId =
            typeof l.target === 'string'
              ? l.target
              : (l.target as GraphNode).id;
          map.set(sourceId, (map.get(sourceId) || 0) + 1);
          map.set(targetId, (map.get(targetId) || 0) + 1);
        });
        return map;
      }, [links]);

      const isLargeGraph = links.length > EDGE_PROGRAM_THRESHOLD;

      // Visual state
      const visualState: VisualState = useMemo(
        () => ({
          colorMode,
          highlightNodes: effectiveHighlightNodes,
          highlightLinks: effectiveHighlightLinks,
          labelNodes: effectiveLabelNodes,
          selectedNodeId: selectedNodeId ?? null,
        }),
        [
          colorMode,
          effectiveHighlightNodes,
          effectiveHighlightLinks,
          effectiveLabelNodes,
          selectedNodeId,
        ],
      );

      useGraphVisuals(
        graph,
        layoutReady,
        visualState,
        layoutConfig,
        degreeMap,
        isLargeGraph,
      );

      // When zIndex is enabled and a selection is active, raise the edges
      // canvas above the nodes canvas so dimmed nodes render behind edges.
      // Highlighted nodes use sigma's hoverNodes layer (already above edges)
      // via the `highlighted` attribute.
      useEffect(() => {
        if (!zIndexEnabled) return;
        const container = sigmaRef.current?.getContainer?.();
        if (!container) return;

        const layers = [
          'sigma-edges',
          'sigma-edgeLabels',
          'sigma-nodes',
          'sigma-labels',
          'sigma-hovers',
          'sigma-hoverNodes',
          'sigma-mouse',
        ];
        const els = layers.map(
          (cls) => container.querySelector(`.${cls}`) as HTMLElement | null,
        );

        const hasSelection = effectiveHighlightNodes.size > 0;
        if (hasSelection) {
          // Reorder: nodes(1) < edges(2) < edgeLabels(3) < labels(4) <
          //          hoverNodes(5) < hovers(6) < mouse(7)
          // hovers (tooltips) must be ABOVE hoverNodes (highlighted nodes)
          // so tooltips aren't occluded by the highlighted node circles.
          const zMap = [2, 3, 1, 4, 6, 5, 7];
          els.forEach((el, i) => {
            if (el) el.style.zIndex = String(zMap[i]);
          });
        } else {
          els.forEach((el) => {
            if (el) el.style.zIndex = '';
          });
        }
      }, [zIndexEnabled, effectiveHighlightNodes]);

      // Sigma settings
      const sigmaSettings = useMemo(
        () => ({
          defaultNodeType: 'circle' as const,
          defaultEdgeType: isLargeGraph
            ? ('line' as const)
            : ('curvedArrow' as const),
          edgeProgramClasses: {
            ...(isLargeGraph
              ? { line: EdgeLineProgram }
              : { curvedArrow: EdgeCurvedArrowProgram }),
          },
          renderEdgeLabels: false,
          enableEdgeEvents: !isLargeGraph,
          labelRenderedSizeThreshold: LABEL_RENDERED_SIZE_THRESHOLD,
          labelFont: LABEL_FONT,
          labelColor: { color: LABEL_COLOR },
          labelSize: LABEL_SIZE,
          defaultDrawNodeLabel: drawNodeLabel,
          defaultDrawNodeHover: drawNodeHover,
          allowInvalidContainer: true,
          zIndex: zIndexEnabled,
          zoomToSizeRatioFunction: (ratio: number) =>
            Math.pow(ratio, ZOOM_SIZE_EXPONENT),
        }),
        [isLargeGraph, zIndexEnabled],
      );

      // Keep edge widths constant in screen space by compensating for camera zoom.
      // Sigma's edge shader divides size by sizeRatio; multiplying by camera ratio
      // here cancels that out, so edges stay the same pixel width at all zoom levels.
      const edgeReducer = useCallback(
        (_edge: string, data: Record<string, unknown>) => {
          if (!sigmaRef.current) return data;
          const ratio = (
            sigmaRef.current as unknown as import('sigma').Sigma
          ).getCamera().ratio;
          return { ...data, size: ((data.size as number) || 1) * ratio };
        },
        [],
      );

      const handleSigmaReady = useCallback(
        (sigma: ReturnType<typeof useSigma>) => {
          sigmaRef.current = sigma;
          // Set the edge reducer once sigma is ready
          (sigma as unknown as import('sigma').Sigma).setSetting(
            'edgeReducer',
            edgeReducer,
          );
        },
        [],
      );

      // Imperative handle
      useImperativeHandle(
        ref,
        () => ({
          selectNode: (nodeId: string, nodeHops?: number) => {
            const node = nodes.find((n) => n.id === nodeId);
            if (node) {
              onNodeClick?.(node);
              if (sigmaRef.current) {
                // BFS to find neighborhood
                const neighborhood = new Set<string>([nodeId]);
                const h = nodeHops ?? hops;
                let frontier = new Set<string>([nodeId]);
                const adj = new Map<string, string[]>();
                for (const l of links) {
                  const s =
                    typeof l.source === 'string'
                      ? l.source
                      : (l.source as GraphNode).id;
                  const t =
                    typeof l.target === 'string'
                      ? l.target
                      : (l.target as GraphNode).id;
                  if (!adj.has(s)) adj.set(s, []);
                  if (!adj.has(t)) adj.set(t, []);
                  adj.get(s)!.push(t);
                  adj.get(t)!.push(s);
                }
                for (let d = 0; d < h && frontier.size > 0; d++) {
                  const next = new Set<string>();
                  frontier.forEach((id) => {
                    adj.get(id)?.forEach((nb) => {
                      if (!neighborhood.has(nb)) {
                        next.add(nb);
                        neighborhood.add(nb);
                      }
                    });
                  });
                  frontier = next;
                }
                zoomToNodes(
                  sigmaRef.current as unknown as import('sigma').Sigma,
                  neighborhood,
                  600,
                );
              }
            }
          },
          zoomToFit: (duration = 400) => {
            if (sigmaRef.current) {
              zoomToFit(
                sigmaRef.current as unknown as import('sigma').Sigma,
                duration,
              );
            }
          },
          zoomToNodes: (nodeIds: Iterable<string>, duration = 600) => {
            if (sigmaRef.current) {
              zoomToNodes(
                sigmaRef.current as unknown as import('sigma').Sigma,
                nodeIds,
                duration,
              );
            }
          },
          optimize: () => {
            setOptimizeTick((t) => t + 1);
          },
          zoomIn: (duration = 300) => {
            if (sigmaRef.current) {
              const camera = (
                sigmaRef.current as unknown as import('sigma').Sigma
              ).getCamera();
              camera.animatedZoom({ duration });
            }
          },
          zoomOut: (duration = 300) => {
            if (sigmaRef.current) {
              const camera = (
                sigmaRef.current as unknown as import('sigma').Sigma
              ).getCamera();
              camera.animatedUnzoom({ duration });
            }
          },
          resetCamera: (duration = 400) => {
            if (sigmaRef.current) {
              const camera = (
                sigmaRef.current as unknown as import('sigma').Sigma
              ).getCamera();
              camera.animatedReset({ duration });
            }
          },
        }),
        [nodes, links, hops, onNodeClick],
      );

      return (
        <div
          className={className}
          style={{
            position: 'relative',
            width,
            height,
            ...style,
          }}
        >
          {!layoutReady && nodes.length > 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(0,0,0,0.5)',
                color: '#e2e8f0',
                fontSize: 14,
              }}
            >
              Computing layout ({nodes.length.toLocaleString()} nodes)...
            </div>
          )}
          <SigmaContainer
            graph={graph}
            style={{
              width,
              height,
              position: 'absolute',
              top: 0,
              left: 0,
            }}
            settings={sigmaSettings}
          >
            <GraphEventHandler
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
              onStageClick={onStageClick}
            />
            <LayoutPipeline
              layoutReady={layoutReady}
              layoutConfig={layoutConfig}
              optimizeTick={optimizeTick}
              onOptimizeStatus={onOptimizeStatus}
            />
            <AnimationEffects
              selectedNodeId={selectedNodeId ?? null}
              animationSettings={animationSettings}
            />
            <SigmaRefCapture onReady={handleSigmaReady} />
          </SigmaContainer>
        </div>
      );
    },
  ),
);

export default GraphCanvas;
