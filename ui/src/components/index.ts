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
 * @opentrace/components — React component library for graph visualization.
 *
 * Usage:
 *   import { GraphCanvas } from '@opentrace/components';
 *   import '@opentrace/components/style.css'; // optional base styles
 */

// ─── Main component (Pixi.js renderer) ──────────────────────────────────
export { default as Graph } from './PixiGraphCanvas';
export { default as GraphCanvas } from './PixiGraphCanvas';
export { default as PixiGraphCanvas } from './PixiGraphCanvas';
export type {
  GraphCanvasProps,
  GraphCanvasHandle,
  AnimationSettings,
} from './types/canvas';
export {
  type PixiScaleBreakpoint,
  DEFAULT_BREAKPOINTS,
  selectBreakpoint,
} from './pixi/scaleBreakpoints';
export type { LayoutMode } from './workers/pixiLayoutWorker';

// ─── Graph hooks (for custom composition) ───────────────────────────────
export { useGraphInstance } from './graph/useGraphInstance';
export type {
  UseGraphInstanceResult,
  UseGraphInstanceOptions,
} from './graph/useGraphInstance';

export { useGraphFilters, shouldHideNode } from './graph/useGraphFilters';
export { useGraphVisuals } from './graph/useGraphVisuals';
export { useCommunities } from './graph/useCommunities';
export { useHighlights } from './graph/useHighlights';

// ─── Layout types ────────────────────────────────────────────────────────
export type {
  OptimizeStatus,
  LayoutControl,
} from './graph/LayoutPipelineTypes';

// ─── Types ──────────────────────────────────────────────────────────────
export type {
  GraphNode,
  GraphLink,
  GraphData,
  GraphStats,
  SelectedNode,
  SelectedEdge,
} from './types/graph';

export type {
  LayoutConfig,
  FilterState,
  VisualState,
  CommunityData,
  GetSubTypeFn,
} from './graph/types';

// ─── Configuration & defaults ───────────────────────────────────────────
export { DEFAULT_LAYOUT_CONFIG } from './config/graphLayout';

export {
  NODE_SIZE_MIN,
  NODE_SIZE_MAX,
  NODE_SIZE_DEGREE_SCALE,
  NODE_SIZE_MULTIPLIERS,
  EDGE_SIZE_DEFAULT,
  EDGE_SIZE_HIGHLIGHTED,
  EDGE_SIZE_DIMMED,
  EDGE_OPACITY_DEFAULT,
  EDGE_OPACITY_HIGHLIGHTED,
  EDGE_OPACITY_DIMMED,
  NODE_OPACITY_DIMMED,
  ZOOM_SIZE_EXPONENT,
  EDGE_PROGRAM_THRESHOLD,
  LABEL_RENDERED_SIZE_THRESHOLD,
  LABEL_SIZE,
  LABEL_FONT,
  LABEL_COLOR,
  FA2_ENABLED,
  FA2_GRAVITY,
  FA2_SCALING_RATIO,
  FA2_DURATION,
  LOUVAIN_RESOLUTION,
} from './config/graphLayout';

// ─── Color utilities ────────────────────────────────────────────────────
export { getNodeColor } from './colors/nodeColors';
export { getLinkColor } from './colors/linkColors';
export {
  buildCommunityColorMap,
  buildCommunityNames,
  getCommunityColor,
} from './colors/communityColors';
export {
  getGraphThemeColors,
  type GraphThemeColors,
} from './colors/graphThemeColors';

// ─── Indexing components ─────────────────────────────────────────────────
export {
  AddRepoModal,
  IndexingProgress,
  normalizeRepoUrl,
  detectProvider,
} from './indexing';
export type {
  IndexingState,
  StageState as IndexStageState,
  StageStatus as IndexStageStatus,
  StageConfig,
  Provider,
  JobMessage,
  IndexRepoMessage,
  IndexDirectoryMessage,
  AddRepoModalProps,
  IndexingProgressProps,
} from './indexing';

// ─── Panel components ───────────────────────────────────────────────────
export {
  FilterPanel,
  GraphBadge,
  GraphLegend,
  GraphToolbar,
  DiscoverPanel,
  PhysicsPanel,
  PanelResizeHandle,
  useDiscoverTree,
} from './panels';
export type {
  FilterItem,
  FilterPanelProps,
  GraphBadgeProps,
  LegendItem,
  GraphLegendProps,
  MobilePanelTab,
  GraphToolbarProps,
  SearchSuggestion,
  TreeNodeData,
  DiscoverPanelProps,
  DiscoverDataProvider,
  UseDiscoverTreeOptions,
  UseDiscoverTreeResult,
} from './panels';
