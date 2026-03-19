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
 * Lightweight re-exports that don't pull in sigma/WebGL.
 * Use this entry point in non-browser contexts (tests, SSR, Node).
 *
 * Usage:
 *   import { getNodeColor, getLinkColor } from '@opentrace/components/utils';
 */

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

// ─── Color utilities ────────────────────────────────────────────────────
export { getNodeColor } from './colors/nodeColors';
export { getLinkColor } from './colors/linkColors';
export {
  buildCommunityColorMap,
  buildCommunityNames,
  getCommunityColor,
} from './colors/communityColors';

// ─── Filter logic (pure function, no React) ─────────────────────────────
export { shouldHideNode } from './graph/useGraphFilters';

// ─── Hooks that don't depend on sigma/WebGL ─────────────────────────────
export { useCommunities } from './graph/useCommunities';
export { useHighlights } from './graph/useHighlights';

// ─── Panel types (no React component imports) ───────────────────────────
export type {
  TypeEntry,
  SubTypeEntry,
  CommunityEntry,
  FilterPanelProps,
  LegendItem,
  GraphLegendProps,
  TreeNodeData,
  DiscoverPanelProps,
} from './panels/types';
