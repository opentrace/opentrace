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
 * PixiGraphCanvas — Pixi.js v8 + d3-force graph renderer.
 *
 * Primary graph visualization component using Pixi.js for WebGL rendering
 * and d3-force for layout simulation.
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

import type { GetSubTypeFn } from './graph/types';
import type { GraphCanvasHandle, GraphCanvasProps } from './types/canvas';
import { useCommunities } from './graph/useCommunities';
import { useHighlights } from './graph/useHighlights';
import { shouldHideNode } from './graph/useGraphFilters';
import { useThemeKey } from './graph/useThemeKey';
import { DEFAULT_LAYOUT_CONFIG } from './config/graphLayout';
import { PixiRenderer } from './pixi/PixiRenderer';
import { usePixiLayout } from './pixi/usePixiLayout';

// Dummy Graphology graph for useHighlights (it needs the type but doesn't use it for BFS)
import Graph from 'graphology';

// ─── Component ──────────────────────────────────────────────────────────

const EMPTY_SET_STR = new Set<string>();
const EMPTY_SET_NUM = new Set<number>();
const EMPTY_MAP = new Map<string, { subType: string; count: number }[]>();
const DEFAULT_GET_SUB_TYPE: GetSubTypeFn = () => null;

const PixiGraphCanvasInner = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function PixiGraphCanvas(props, ref) {
    const {
      nodes,
      links,
      width,
      height,
      layoutConfig = DEFAULT_LAYOUT_CONFIG,
      colorMode = 'type',
      hiddenNodeTypes = EMPTY_SET_STR,
      hiddenLinkTypes = EMPTY_SET_STR,
      hiddenSubTypes = EMPTY_SET_STR,
      hiddenCommunities = EMPTY_SET_NUM,
      searchQuery = '',
      selectedNodeId = null,
      hops = 2,
      getSubType = DEFAULT_GET_SUB_TYPE,
      highlightNodes: highlightNodesProp,
      highlightLinks: highlightLinksProp,
      labelNodes: labelNodesProp,
      availableSubTypes = EMPTY_MAP,
      communityData: communityDataProp,
      onNodeClick,
      onEdgeClick,
      onStageClick,
      onOptimizeStatus,
      labelsVisible: labelsVisibleProp = true,
      layoutMode: layoutModeProp = 'spread',
      mode3d: mode3dProp = false,
      on3DAutoRotateChange,
      className,
      style,
    } = props;

    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<PixiRenderer | null>(null);
    // Incremented when setData completes so dependent effects re-run
    const [dataVersion, setDataVersion] = useState(0);
    // Re-renders when data-theme or data-mode changes on <html>
    const themeKey = useThemeKey();
    const dummyGraph = useMemo(
      () => new Graph({ multi: true, type: 'directed' }),
      [],
    );

    // ── Community detection (reuse existing hook or accept from props) ──
    const internalCommunityData = useCommunities(nodes, links, layoutConfig);
    const communityData = communityDataProp ?? internalCommunityData;

    // ── Filter state (for useHighlights) ────────────────────────────────
    const filterState = useMemo(
      () => ({
        hiddenNodeTypes,
        hiddenLinkTypes,
        hiddenSubTypes,
        hiddenCommunities,
      }),
      [hiddenNodeTypes, hiddenLinkTypes, hiddenSubTypes, hiddenCommunities],
    );

    // ── Highlights (BFS from selected node + search) ────────────────────
    const {
      highlightNodes: computedHighlightNodes,
      highlightLinks: computedHighlightLinks,
      labelNodes: computedLabelNodes,
    } = useHighlights(
      dummyGraph,
      true,
      nodes,
      links,
      searchQuery,
      selectedNodeId,
      hops,
      filterState,
    );

    const activeHighlightNodes = highlightNodesProp ?? computedHighlightNodes;
    const activeHighlightLinks = highlightLinksProp ?? computedHighlightLinks;
    const activeLabelNodes = labelNodesProp ?? computedLabelNodes;

    // ── Node colors ─────────────────────────────────────────────────────
    const nodeColors = useMemo(() => {
      const colors = new Map<string, string>();
      const { assignments, colorMap } = communityData;
      for (const node of nodes) {
        if (colorMode === 'community') {
          colors.set(
            node.id,
            layoutConfig.getCommunityColor(assignments, colorMap, node.id),
          );
        } else {
          colors.set(node.id, layoutConfig.getNodeColor(node.type));
        }
      }
      return colors;
      // themeKey triggers recomputation when theme/mode changes — getNodeColor
      // reads CSS variables whose values depend on the active theme.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, colorMode, communityData, layoutConfig, themeKey]);

    // ── Link colors ─────────────────────────────────────────────────────
    const linkColors = useMemo(() => {
      const colors = new Map<string, string>();
      for (const link of links) {
        if (!colors.has(link.label)) {
          colors.set(link.label, layoutConfig.getLinkColor(link.label));
        }
      }
      return colors;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [links, layoutConfig, themeKey]);

    // ── Layout (d3-force simulation) ────────────────────────────────────
    const onLayoutTick = useCallback(
      (
        positions: Map<string, { x: number; y: number }>,
        buffer?: Float64Array,
      ) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        // Fast path: use indexed Float64Array (avoids 20k Map lookups per tick)
        if (buffer) {
          renderer.updatePositionsFromBuffer(buffer);
        } else {
          renderer.updatePositions(positions);
        }
      },
      [],
    );

    const {
      layoutReady,
      positions,
      nodeSizes,
      simRunning,
      reheat,
      restart,
      toggleSim,
      stopSim,
      startSim,
      fixNode,
      unfixNode,
      boostTheta,
      resetTheta,
      setChargeStrength,
      setLinkDistance,
      setCenterStrength,
      setCommunityGravity,
      setLayoutMode,
      updateCompactConfig,
    } = usePixiLayout(
      nodes,
      links,
      communityData,
      layoutConfig,
      onLayoutTick,
      layoutModeProp,
    );

    // ── Sync layout settled state to renderer for edge redraw gating ────
    useEffect(() => {
      rendererRef.current?.setLayoutSettled(!simRunning);
      // Notify consumer of physics status (replaces Sigma's LayoutPipeline callback)
      onOptimizeStatus?.(simRunning ? { phase: 'fa2' } : { phase: 'done' });
    }, [simRunning, onOptimizeStatus]);

    // ── Initialize Pixi renderer ────────────────────────────────────────
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      // Clear any leftover canvases from previous mounts (strict mode / HMR)
      while (container.firstChild) container.removeChild(container.firstChild);

      const renderer = new PixiRenderer();
      rendererRef.current = renderer;
      // init() is async but setData() internally awaits it, so no race
      renderer.init(container, width, height);

      return () => {
        rendererRef.current = null;
        renderer.destroy();
        // Ensure canvas is removed from DOM (Pixi v8 destroy may not do this)
        while (container.firstChild)
          container.removeChild(container.firstChild);
      };
      // Only init once — resize handled separately
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Resize ──────────────────────────────────────────────────────────
    useEffect(() => {
      rendererRef.current?.resize(width, height);
    }, [width, height]);

    // ── Set data when layout is ready ───────────────────────────────────
    // setData is async — it awaits the Pixi init promise internally.
    // Snapshot positions because the worker may update entries in-place
    // during the async gap.
    //
    // For incremental updates (nodes only added), use addData to append
    // new sprites without destroying existing ones.
    const prevNodeIdsRef = useRef<Set<string>>(new Set());
    useEffect(() => {
      if (!layoutReady || !rendererRef.current) return;

      const currentIds = new Set(nodes.map((n) => n.id));
      const prevIds = prevNodeIdsRef.current;
      const allPrevPresent =
        prevIds.size > 0 && [...prevIds].every((id) => currentIds.has(id));
      const isIncremental = allPrevPresent && currentIds.size > prevIds.size;
      const isSameNodes = allPrevPresent && currentIds.size === prevIds.size;

      prevNodeIdsRef.current = currentIds;

      // Same nodes, only metadata changed — other effects handle colors etc.
      if (isSameNodes) return;

      const posSnapshot = new Map(positions);
      let cancelled = false;

      if (isIncremental) {
        const newNodes = nodes.filter((n) => !prevIds.has(n.id));
        const newLinks = links.filter((l) => {
          const s =
            typeof l.source === 'string'
              ? l.source
              : (l.source as { id: string }).id;
          const t =
            typeof l.target === 'string'
              ? l.target
              : (l.target as { id: string }).id;
          return !prevIds.has(s) || !prevIds.has(t);
        });
        rendererRef.current
          .addData(
            newNodes,
            newLinks,
            posSnapshot,
            nodeColors,
            nodeSizes,
            linkColors,
          )
          .then(() => {
            if (!cancelled) setDataVersion((v) => v + 1);
          });
      } else {
        rendererRef.current
          .setData(nodes, links, posSnapshot, nodeColors, nodeSizes, linkColors)
          .then(() => {
            if (!cancelled) setDataVersion((v) => v + 1);
          });
      }
      return () => {
        cancelled = true;
      };
      // `positions` is a stable Map ref from usePixiLayout (positionsRef.current).
      // It never changes identity — the effect re-runs via `layoutReady` or when
      // nodes/links/colors change.
    }, [
      layoutReady,
      nodes,
      links,
      positions,
      nodeColors,
      nodeSizes,
      linkColors,
    ]);

    // ── Update node colors when colorMode or theme changes ────────────
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.updateNodeColors(nodeColors);
    }, [dataVersion, nodeColors]);

    // ── Update canvas background + label colors when theme changes ──────
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setThemeColors();
    }, [dataVersion, themeKey]);

    // ── Apply labels visibility when data is ready or prop changes ─────
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setShowAllLabels(labelsVisibleProp);
    }, [dataVersion, labelsVisibleProp]);

    // ── Apply 3D mode when data is ready or prop changes ──────────────
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      // Always re-initialize when mode3d is active so new data gets fresh nodeDepthT
      if (mode3dProp) {
        rendererRef.current.set3DMode(true, communityData.assignments);
      } else if (rendererRef.current.is3DMode()) {
        rendererRef.current.set3DMode(false);
      }
    }, [dataVersion, mode3dProp, communityData.assignments]);

    // ── Apply highlights ────────────────────────────────────────────────
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setHighlight(
        activeHighlightNodes,
        activeHighlightLinks,
      );
    }, [
      dataVersion,
      activeHighlightNodes,
      activeHighlightLinks,
      activeLabelNodes,
    ]);

    // ── Apply link type filtering ──────────────────────────────────────
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setHiddenLinkTypes(hiddenLinkTypes);
    }, [dataVersion, hiddenLinkTypes]);

    // ── Apply filters (node visibility) ─────────────────────────────────
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      const visibleIds = new Set<string>();
      for (const node of nodes) {
        const hidden = shouldHideNode(
          node,
          filterState,
          communityData.assignments,
          availableSubTypes,
          getSubType,
        );
        if (!hidden) visibleIds.add(node.id);
      }
      rendererRef.current.setNodeVisibility(visibleIds);
    }, [
      dataVersion,
      nodes,
      filterState,
      communityData.assignments,
      availableSubTypes,
      getSubType,
    ]);

    // ── Interaction callbacks ───────────────────────────────────────────
    useEffect(() => {
      if (!rendererRef.current) return;
      rendererRef.current.setCallbacks({
        onNodeClick,
        onEdgeClick,
        onStageClick,
        onNodeDragStart: (nodeId) => {
          fixNode(nodeId, 0, 0); // will be updated on move
          boostTheta(); // faster Barnes-Hut during drag
        },
        onNodeDragMove: (nodeId, x, y) => {
          fixNode(nodeId, x, y);
        },
        onNodeDragEnd: () => {
          // Keep pinned (like reference implementation)
          resetTheta(); // restore accuracy
        },
        on3DAutoRotateChange,
      });
    }, [
      onNodeClick,
      onEdgeClick,
      onStageClick,
      fixNode,
      unfixNode,
      boostTheta,
      resetTheta,
      on3DAutoRotateChange,
    ]);

    // ── Imperative handle (same as GraphCanvas) ─────────────────────────
    useImperativeHandle(
      ref,
      () => ({
        selectNode: (nodeId: string) => {
          const renderer = rendererRef.current;
          if (!renderer) return;
          const node = renderer.getNode(nodeId);
          if (node) {
            onNodeClick?.(node.graphNode);
            renderer.zoomToNodes([nodeId], 300);
          }
        },
        zoomToFit: (duration?: number) => {
          rendererRef.current?.zoomToFit(duration ?? 300);
        },
        zoomToNodes: (nodeIds: Iterable<string>, duration?: number) => {
          rendererRef.current?.zoomToNodes(nodeIds, duration ?? 300);
        },
        optimize: () => {
          restart();
        },
        zoomIn: (duration?: number) => {
          rendererRef.current?.zoomIn(duration ?? 200);
        },
        zoomOut: (duration?: number) => {
          rendererRef.current?.zoomOut(duration ?? 200);
        },
        resetCamera: (duration?: number) => {
          rendererRef.current?.resetCamera(duration ?? 300);
        },
        stopPhysics: () => {
          stopSim();
        },
        startPhysics: () => {
          startSim();
        },
        isPhysicsRunning: () => simRunning,
        // Pixi-specific
        setEdgesEnabled: (enabled: boolean) => {
          rendererRef.current?.setEdgesEnabled(enabled);
        },
        setShowLabels: (show: boolean) => {
          rendererRef.current?.setShowAllLabels(show);
        },
        setChargeStrength,
        setLinkDistance,
        setCenterStrength,
        setCommunityGravity,
        reheat,
        fitToScreen: () => {
          rendererRef.current?.zoomToFit(300);
        },
        setZoomSizeExponent: (exponent: number) => {
          rendererRef.current?.setZoomSizeExponent(exponent);
        },
        setLayoutMode,
        updateCompactConfig,
        set3DMode: (enabled: boolean) => {
          rendererRef.current?.set3DMode(enabled, communityData.assignments);
        },
        set3DSpeed: (speed: number) => {
          rendererRef.current?.set3DSpeed(speed);
        },
        set3DTilt: (tilt: number) => {
          rendererRef.current?.set3DTilt(tilt);
        },
        set3DAutoRotate: (enabled: boolean) => {
          rendererRef.current?.set3DAutoRotate(enabled);
        },
        setLabelScale: (scale: number) => {
          rendererRef.current?.setLabelScale(scale);
        },
        triggerPing: (nodeIds: Iterable<string>) => {
          rendererRef.current?.triggerPing(nodeIds);
        },
      }),
      [
        onNodeClick,
        restart,
        stopSim,
        startSim,
        toggleSim,
        simRunning,
        reheat,
        setChargeStrength,
        setLinkDistance,
        setCenterStrength,
        setCommunityGravity,
        setLayoutMode,
        updateCompactConfig,
        communityData.assignments,
      ],
    );

    return (
      <div
        ref={containerRef}
        className={className}
        style={{
          width,
          height,
          overflow: 'hidden',
          position: 'relative',
          ...style,
        }}
      />
    );
  },
);

export default memo(PixiGraphCanvasInner);
