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
  /** Section heading. */
  title: string;
  /** Items to display in this section. */
  items: FilterItem[];
  /** Called when an item's checkbox is toggled. */
  onToggle: (key: string) => void;
  /** Show all items in this section. */
  onShowAll: () => void;
  /** Hide all items in this section. */
  onHideAll: () => void;
  /** Shape of the color indicator. Defaults to 'dot'. */
  indicator?: 'dot' | 'line';
  /** Message when items is empty. */
  emptyMessage?: string;
  /** Called when the focus/target button is clicked for an item. */
  onFocus?: (key: string) => void;
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

// ─── GraphBadge types ────────────────────────────────────────────────

export interface GraphBadgeProps {
  /** Number of currently rendered/filtered nodes. */
  nodeCount: number;
  /** Number of currently rendered/filtered edges. */
  edgeCount: number;
  /** Total node count from the API (shown in parentheses). */
  totalNodes?: number;
  /** Total edge count from the API (shown in parentheses). */
  totalEdges?: number;
}

// ─── GraphToolbar types ─────────────────────────────────────────────

export interface MobilePanelTab {
  /** Unique key identifying this tab. */
  key: string;
  /** Display label. */
  label: string;
  /** SVG icon rendered before the label. */
  icon: React.ReactNode;
  /** Whether this tab should be shown. Defaults to true. */
  visible?: boolean;
}

/** A single autocomplete suggestion for the toolbar search. */
export interface SearchSuggestion {
  label: string;
  category: 'name' | 'community';
  /** Color for the leading dot indicator. */
  color?: string;
  /** Community label shown on the right side. */
  communityLabel?: string;
  /** Color for the community label. */
  communityColor?: string;
  /** Community ID — used for direct lookup when selecting a community suggestion. */
  communityId?: number;
}

export interface GraphToolbarProps {
  /** Logo element rendered at the leading edge of the header. */
  logo: React.ReactNode;

  // ─── Search ────────────────────────────────────────────────
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSearch: () => void;
  onReset: () => void;
  /** Disable the search button (e.g. when query is unchanged). */
  searchDisabled?: boolean;
  /** Show a "Show All" reset button (e.g. when a search is active). */
  showResetButton?: boolean;
  /** Autocomplete suggestions shown while typing in the search box. */
  searchSuggestions?: SearchSuggestion[];
  /** Called when a suggestion is selected (clicked or Enter). */
  onSuggestionSelect?: (suggestion: SearchSuggestion) => void;

  // ─── Hops ──────────────────────────────────────────────────
  hops: number;
  onHopsChange: (hops: number) => void;
  maxHops?: number;

  // ─── Badge ─────────────────────────────────────────────────
  nodeCount: number;
  edgeCount: number;
  totalNodes?: number;
  totalEdges?: number;

  // ─── Mobile panel tabs ─────────────────────────────────────
  /** Tabs shown at the top of the mobile dropdown menu. */
  mobilePanelTabs?: MobilePanelTab[];
  onMobilePanelTab?: (key: string) => void;

  // ─── App-specific actions slot ─────────────────────────────
  /**
   * Rendered after the GraphBadge in the nav.
   * Intended for app-specific toolbar actions (theme toggle,
   * chat button, settings, etc.).
   */
  actions?: React.ReactNode;

  /**
   * Always-visible actions that never collapse into the burger menu.
   * On desktop: rendered between the Badge and actions inside the nav.
   * On mobile: rendered next to the burger button, outside the dropdown.
   */
  persistentActions?: React.ReactNode;

  /** Optional className for the outer header element. */
  className?: string;
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
  /** Collapse all expanded nodes */
  onCollapseAll?: () => void;
  /** Expand all loaded expandable nodes */
  onExpandAll?: () => void;
  /** Currently selected node ID */
  selectedNodeId?: string;
  /** Node IDs currently visible in the graph */
  graphNodeIds?: string[];
  /** Map of node ID → hop distance from selected node */
  hopMap?: Map<string, number>;
  /** Whether a node can be expanded. Defaults to Repository, Directory, File, Class, PullRequest types. */
  isExpandable?: (node: TreeNodeData) => boolean;
}
