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

// ─── FilterPanel types ──────────────────────────────────────────────

export interface FilterItem {
  key: string;
  label: string;
  count: number;
  color: string;
  hidden: boolean;
  /** Sub-items (e.g. sub-types under a node type). */
  children?: FilterItem[];
}

export interface FilterPanelProps {
  nodeTypes: TypeEntry[];
  linkTypes: TypeEntry[];
  hiddenNodeTypes: Set<string>;
  hiddenLinkTypes: Set<string>;
  subTypesByNodeType: Map<string, SubTypeEntry[]>;
  hiddenSubTypes: Set<string>;
  onToggleNodeType: (type: string) => void;
  onToggleLinkType: (type: string) => void;
  onToggleSubType: (key: string) => void;
  onShowAllNodes: () => void;
  onHideAllNodes: () => void;
  onShowAllLinks: () => void;
  onHideAllLinks: () => void;
  colorMode?: 'type' | 'community';
  communities?: CommunityEntry[];
  hiddenCommunities?: Set<number>;
  onToggleCommunity?: (cid: number) => void;
  onShowAllCommunities?: () => void;
  onHideAllCommunities?: () => void;
}

// ─── GraphLegend types ──────────────────────────────────────────────

export interface LegendItem {
  label: string;
  count: number;
  color: string;
}

export interface GraphLegendProps {
  /** Node or community items (dots). */
  items: LegendItem[];
  /** Link/edge items (lines). */
  linkItems?: LegendItem[];
  /** Max node/community items before overflow. Defaults to 5. */
  maxVisible?: number;
}

// ─── DiscoverPanel types ────────────────────────────────────────────

export interface TreeNodeData {
  id: string;
  type: string;
  name: string;
  properties?: Record<string, unknown>;
}

export interface DiscoverPanelProps {
  /** Root nodes of the tree */
  roots: TreeNodeData[];
  /** Pre-fetched parent → children mapping */
  childrenMap: Map<string, TreeNodeData[]>;
  /** Currently expanded node IDs (controlled) */
  expanded: Set<string>;
  /** Called when a node's expand/collapse toggle is clicked */
  onToggleExpand: (nodeId: string) => void;
  /** Called when a node name is clicked */
  onSelectNode: (nodeId: string) => void;
  /** Currently selected node ID */
  selectedNodeId?: string;
  /** Node IDs currently visible in the graph */
  graphNodeIds?: string[];
  /** Map of node ID → hop distance from selected node */
  hopMap?: Map<string, number>;
  /** Whether a node can be expanded. Defaults to Repository, Directory, File, Class, PullRequest types. */
  isExpandable?: (node: TreeNodeData) => boolean;
}
