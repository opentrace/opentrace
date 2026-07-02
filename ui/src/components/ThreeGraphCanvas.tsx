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
 * ThreeGraphCanvas — the Three.js + d3-force graph renderer (the sole graph
 * canvas). Implements the `GraphCanvasProps` / `GraphCanvasHandle` contract via
 * a prop→imperative-effect orchestration over `ThreeRenderer`, and runs its
 * layout in the 2D/3D-capable `forceLayout3dWorker` (see `useForceLayout3d`).
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
import { ThreeRenderer } from './three/ThreeRenderer';
import { useForceLayout3d } from './three/useForceLayout3d';

import Graph from 'graphology';

const EMPTY_SET_STR = new Set<string>();
const EMPTY_SET_NUM = new Set<number>();
const EMPTY_MAP = new Map<string, { subType: string; count: number }[]>();
const DEFAULT_GET_SUB_TYPE: GetSubTypeFn = () => null;

const ThreeGraphCanvasInner = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function ThreeGraphCanvas(props, ref) {
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
      availableSubTypes = EMPTY_MAP,
      communityData: communityDataProp,
      onNodeClick,
      onEdgeClick,
      onStageClick,
      onNodeHover,
      onOptimizeStatus,
      labelsVisible: labelsVisibleProp = true,
      edgesEnabled: edgesEnabledProp = true,
      communityLabelsVisible: communityLabelsVisibleProp = true,
      layoutMode: layoutModeProp = 'spread',
      zoomSizeExponent: zoomSizeExponentProp,
      labelScale: labelScaleProp,
      edgeOpacity: edgeOpacityProp,
      chargeStrength: chargeStrengthProp,
      linkDistance: linkDistanceProp,
      compactConfig: compactConfigProp,
      mode3d: mode3dProp = false,
      rotationSpeed: rotationSpeedProp,
      cameraTilt: cameraTiltProp,
      on3DAutoRotateChange,
      liveGrow = false,
      className,
      style,
    } = props;

    const containerRef = useRef<HTMLDivElement>(null);
    const rendererRef = useRef<ThreeRenderer | null>(null);
    const [dataVersion, setDataVersion] = useState(0);
    const themeKey = useThemeKey();
    const dummyGraph = useMemo(
      () => new Graph({ multi: true, type: 'directed' }),
      [],
    );

    // Skip the internal Louvain pass when the parent already supplies community
    // data (the app always does) — otherwise we'd run a second worker over the
    // whole graph on every change, doubling the cost during streaming.
    const internalCommunityData = useCommunities(
      nodes,
      links,
      layoutConfig,
      communityDataProp == null,
    );
    const communityData = communityDataProp ?? internalCommunityData;

    const filterState = useMemo(
      () => ({
        hiddenNodeTypes,
        hiddenLinkTypes,
        hiddenSubTypes,
        hiddenCommunities,
      }),
      [hiddenNodeTypes, hiddenLinkTypes, hiddenSubTypes, hiddenCommunities],
    );

    const {
      highlightNodes: computedHighlightNodes,
      highlightLinks: computedHighlightLinks,
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

    const nodeColors = useMemo(() => {
      const colors = new Map<string, string>();
      const { assignments, colorMap } = communityData;
      // Community colors need community data: with communities toggled OFF
      // (or not yet computed) the assignments are empty and every node would
      // hit the gray fallback — fall back to TYPE colors instead of a gray
      // graph. Flipping communities back on restores community colors.
      const byCommunity =
        colorMode === 'community' && Object.keys(assignments).length > 0;
      for (const node of nodes) {
        if (byCommunity) {
          colors.set(
            node.id,
            layoutConfig.getCommunityColor(assignments, colorMap, node.id),
          );
        } else {
          colors.set(node.id, layoutConfig.getNodeColor(node.type));
        }
      }
      return colors;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, colorMode, communityData, layoutConfig, themeKey]);

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

    const onLayoutTick = useCallback(
      (
        positions: Map<string, { x: number; y: number }>,
        buffer?: Float64Array,
      ) => {
        const renderer = rendererRef.current;
        if (!renderer) return;
        if (buffer) {
          renderer.updatePositionsFromBuffer(buffer);
        } else {
          renderer.updatePositions(positions);
        }
        renderer.scheduleAutoFit();
      },
      [],
    );

    const {
      layoutReady,
      positions,
      nodeSizes,
      simRunning,
      reheat,
      reseed,
      setNebula,
      restart,
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
      setDimensions,
      releasePins,
    } = useForceLayout3d(
      nodes,
      links,
      communityData,
      layoutConfig,
      onLayoutTick,
      layoutModeProp,
      mode3dProp ? 3 : 2,
      liveGrow,
    );

    useEffect(() => {
      rendererRef.current?.setLayoutSettled(!simRunning);
      onOptimizeStatus?.(simRunning ? { phase: 'fa2' } : { phase: 'done' });
    }, [simRunning, onOptimizeStatus]);

    // ── Initialize renderer ─────────────────────────────────────────────
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;
      while (container.firstChild) container.removeChild(container.firstChild);

      const renderer = new ThreeRenderer();
      rendererRef.current = renderer;
      renderer.init(container, width, height);
      if (import.meta.env.DEV) {
        (
          window as unknown as { __threeRenderer?: ThreeRenderer }
        ).__threeRenderer = renderer;
      }

      return () => {
        rendererRef.current = null;
        renderer.destroy();
        while (container.firstChild)
          container.removeChild(container.firstChild);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      rendererRef.current?.resize(width, height);
    }, [width, height]);

    // Drive continuous live-build mode. Gated on `layoutReady` so it (re)applies
    // once the renderer exists — robust to mount ordering. On exit, release the
    // worker-side node pins so the graph is interactive/re-layoutable again.
    useEffect(() => {
      const r = rendererRef.current;
      if (!r) return;
      if (liveGrow) {
        r.beginLiveGrow();
      } else {
        r.endLiveGrow();
        releasePins();
      }
    }, [liveGrow, layoutReady, releasePins]);

    // ── Set data when layout is ready ───────────────────────────────────
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

      const posSnapshot = new Map(positions);
      let cancelled = false;

      // Live-build: once the first batch has built the (over-allocated) geometry,
      // every subsequent change appends the delta in place — no geometry rebuild,
      // so the build stays continuous + high-FPS. Pass the FULL graph; the
      // renderer diffs against what it holds (also catching late-arriving edges).
      if (liveGrow && allPrevPresent && prevIds.size > 0) {
        rendererRef.current.appendLiveData(
          nodes,
          links,
          posSnapshot,
          nodeColors,
          nodeSizes,
          linkColors,
        );
        return;
      }
      if (isSameNodes) return;

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
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutReady, nodes, links, positions, nodeSizes, liveGrow]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.updateNodeColors(nodeColors);
    }, [dataVersion, nodeColors]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.updateLinkColors(linkColors);
    }, [dataVersion, linkColors]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setThemeColors();
    }, [dataVersion, themeKey]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setShowAllLabels(labelsVisibleProp);
    }, [dataVersion, labelsVisibleProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setEdgesEnabled(edgesEnabledProp);
    }, [dataVersion, edgesEnabledProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setShowCommunityLabels(communityLabelsVisibleProp);
    }, [dataVersion, communityLabelsVisibleProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      if (zoomSizeExponentProp !== undefined) {
        rendererRef.current.setZoomSizeExponent(zoomSizeExponentProp);
      }
    }, [dataVersion, zoomSizeExponentProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      if (labelScaleProp !== undefined) {
        rendererRef.current.setLabelScale(labelScaleProp);
      }
    }, [dataVersion, labelScaleProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      if (edgeOpacityProp !== undefined) {
        rendererRef.current.setEdgeOpacity(edgeOpacityProp);
      }
    }, [dataVersion, edgeOpacityProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setLayoutMode(layoutModeProp);
    }, [dataVersion, layoutModeProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setCommunityData(
        communityData.assignments,
        communityData.names,
        communityData.colorMap,
      );
    }, [
      dataVersion,
      communityData.assignments,
      communityData.names,
      communityData.colorMap,
    ]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      // Switch the simulation's dimensionality, then the renderer's camera.
      setDimensions(mode3dProp ? 3 : 2);
      if (mode3dProp) {
        rendererRef.current.set3DMode(true, communityData.assignments);
      } else if (rendererRef.current.is3DMode()) {
        rendererRef.current.set3DMode(false);
      }
    }, [dataVersion, mode3dProp, communityData.assignments, setDimensions]);

    // Re-apply persisted physics settings on mount and change, so saved values
    // take effect on load (not just on a live slider drag). These post to the
    // layout worker, which no-ops when the value already matches — so a default
    // load isn't reheated. (charge/link/compact live on the worker, not the
    // renderer, so they go through the layout hook rather than rendererRef.)
    useEffect(() => {
      if (!dataVersion) return;
      if (chargeStrengthProp !== undefined)
        setChargeStrength(chargeStrengthProp);
    }, [dataVersion, chargeStrengthProp, setChargeStrength]);

    useEffect(() => {
      if (!dataVersion) return;
      if (linkDistanceProp !== undefined) setLinkDistance(linkDistanceProp);
    }, [dataVersion, linkDistanceProp, setLinkDistance]);

    useEffect(() => {
      if (!dataVersion) return;
      if (compactConfigProp !== undefined)
        updateCompactConfig(compactConfigProp);
    }, [dataVersion, compactConfigProp, updateCompactConfig]);

    // Re-apply persisted 3D rotation speed / camera tilt on mount and on
    // change. These are prop-driven (like zoomSizeExponent/labelScale) so a
    // saved value actually takes effect on load — the imperative handle alone
    // only fired on a live slider drag, leaving the renderer at its default.
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      if (rotationSpeedProp !== undefined) {
        rendererRef.current.set3DSpeed(rotationSpeedProp);
      }
    }, [dataVersion, rotationSpeedProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      if (cameraTiltProp !== undefined) {
        rendererRef.current.set3DTilt(cameraTiltProp);
      }
    }, [dataVersion, cameraTiltProp]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setHighlight(
        activeHighlightNodes,
        activeHighlightLinks,
      );
    }, [dataVersion, activeHighlightNodes, activeHighlightLinks]);

    // Keep the renderer's selected node in sync so the +/- zoom buttons
    // target it.
    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setSelectedNode(selectedNodeId ?? null);
    }, [dataVersion, selectedNodeId]);

    useEffect(() => {
      if (!dataVersion || !rendererRef.current) return;
      rendererRef.current.setHiddenLinkTypes(hiddenLinkTypes);
    }, [dataVersion, hiddenLinkTypes]);

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

    useEffect(() => {
      if (!rendererRef.current) return;
      rendererRef.current.setCallbacks({
        onNodeClick,
        onEdgeClick,
        onStageClick,
        onNodeHover,
        onNodeDragStart: (nodeId) => {
          fixNode(nodeId, 0, 0);
          boostTheta();
        },
        onNodeDragMove: (nodeId, x, y) => {
          fixNode(nodeId, x, y);
        },
        onNodeDragEnd: () => {
          resetTheta();
        },
        on3DAutoRotateChange,
      });
    }, [
      onNodeClick,
      onEdgeClick,
      onStageClick,
      onNodeHover,
      fixNode,
      unfixNode,
      boostTheta,
      resetTheta,
      on3DAutoRotateChange,
    ]);

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
        scheduleAutoFit: (duration?: number) => {
          rendererRef.current?.scheduleAutoFit(duration ?? 200);
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
        setEdgesEnabled: (enabled: boolean) => {
          rendererRef.current?.setEdgesEnabled(enabled);
        },
        setShowLabels: (show: boolean) => {
          rendererRef.current?.setShowAllLabels(show);
        },
        setShowCommunityLabels: (show: boolean) => {
          rendererRef.current?.setShowCommunityLabels(show);
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
        setEdgeOpacity: (opacity: number) => {
          rendererRef.current?.setEdgeOpacity(opacity);
        },
        triggerPing: (nodeIds: Iterable<string>) => {
          rendererRef.current?.triggerPing(nodeIds);
        },
        armBuildAnimation: () => {
          rendererRef.current?.armBuildAnimation();
        },
        playBuildAnimation: (rootIds?: string[]) => {
          rendererRef.current?.playBuildAnimation(rootIds);
        },
        stopBuildAnimation: () => {
          rendererRef.current?.stopBuildAnimation();
        },
        isBuildAnimating: () =>
          rendererRef.current?.isBuildAnimating() ?? false,
        animateTraversal: (legs, orphanIds) => {
          rendererRef.current?.animateTraversal(legs, orphanIds);
        },
        clearTraversal: () => {
          rendererRef.current?.clearTraversal();
        },
        reseedLayout: () => {
          reseed();
        },
        setNebulaLayout: (enabled: boolean, baseMode = 'spread') => {
          setNebula(
            enabled,
            baseMode as 'spread' | 'compact' | 'tree' | 'onion',
          );
        },
        setAmbientMotion: (enabled: boolean) => {
          // Ambient drift runs renderer-side (60fps, smooth) — see
          // ThreeRenderer.updateAmbient. The worker-side ambient is intentionally
          // left dormant (it posted at ~22fps, which looked jumpy).
          rendererRef.current?.setAmbientActive(enabled);
        },
      }),
      [
        onNodeClick,
        restart,
        stopSim,
        startSim,
        simRunning,
        reheat,
        reseed,
        setNebula,
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

export default memo(ThreeGraphCanvasInner);
