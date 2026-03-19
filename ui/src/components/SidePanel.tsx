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

import { useEffect, useRef, useState } from 'react';
import type { SelectedNode, SelectedEdge } from '@opentrace/components/utils';
import type { NodeSourceResponse } from '../store/types';
import { useResizablePanel } from '../hooks/useResizablePanel';
import FilterPanel from './FilterPanel';
import DiscoverPanel from './DiscoverPanel';
import NodeDetailsPanel from './NodeDetailsPanel';
import EdgeDetailsPanel from './EdgeDetailsPanel';
import './SidePanel.css';

interface TypeEntry {
  type: string;
  count: number;
}

interface SubTypeEntry {
  subType: string;
  count: number;
}

interface CommunityEntry {
  communityId: number;
  label: string;
  count: number;
  color: string;
}

export type SidePanelTab = 'filters' | 'discover' | 'details';

interface SidePanelProps {
  /* Filter props — forwarded to FilterPanel */
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

  /* Community filter props */
  colorMode?: 'type' | 'community';
  communities?: CommunityEntry[];
  hiddenCommunities?: Set<number>;
  onToggleCommunity?: (cid: number) => void;
  onShowAllCommunities?: () => void;
  onHideAllCommunities?: () => void;

  /* Node details props */
  selectedNode: SelectedNode | null;
  nodeSource: NodeSourceResponse | null;
  sourceLoading: boolean;
  sourceError: string | null;
  onCloseDetails: () => void;
  /** Community name for the selected node */
  communityName?: string;
  /** Community color for the selected node */
  communityColor?: string;

  /* Edge details props */
  selectedLink: SelectedEdge | null;
  onSelectNode?: (nodeId: string) => void;

  /** Bumps when the graph store changes (new indexing, PR import, etc.) */
  graphVersion?: number;
  /** IDs of nodes currently in the graph view */
  graphNodeIds?: string[];
  /** Map of node ID → hop distance from selected node (0 = selected) */
  hopMap?: Map<string, number>;

  /** Mobile: externally controlled active tab */
  mobileActiveTab?: SidePanelTab | null;
  /** Mobile: callback to switch tabs while the panel is open */
  onMobileTabChange?: (tab: SidePanelTab) => void;
  /** Mobile: callback when the panel wants to close */
  onMobileClose?: () => void;
}

export default function SidePanel({
  nodeTypes,
  linkTypes,
  hiddenNodeTypes,
  hiddenLinkTypes,
  subTypesByNodeType,
  hiddenSubTypes,
  onToggleNodeType,
  onToggleLinkType,
  onToggleSubType,
  onShowAllNodes,
  onHideAllNodes,
  onShowAllLinks,
  onHideAllLinks,
  colorMode,
  communities,
  hiddenCommunities,
  onToggleCommunity,
  onShowAllCommunities,
  onHideAllCommunities,
  selectedNode,
  nodeSource,
  communityName,
  communityColor,
  sourceLoading,
  sourceError,
  onCloseDetails,
  selectedLink,
  onSelectNode,
  graphVersion,
  graphNodeIds,
  hopMap,
  mobileActiveTab,
  onMobileTabChange,
  onMobileClose,
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<
    'filters' | 'discover' | 'details'
  >('filters');
  const previousTab = useRef<'filters' | 'discover'>('filters');
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  });

  // On mobile, the externally-set tab takes priority
  const effectiveTab = mobileActiveTab ?? activeTab;

  const hasSelection = selectedNode !== null || selectedLink !== null;
  const expanded = hasSelection || effectiveTab === 'discover';

  const { width: panelWidth, handleMouseDown } = useResizablePanel({
    storageKey: expanded
      ? 'ot_side_panel_expanded_width'
      : 'ot_side_panel_width',
    defaultWidth: expanded ? 480 : 220,
    minWidth: 180,
    maxWidth: 700,
    side: 'right',
  });

  // Auto-switch to details when node or edge is selected
  useEffect(() => {
    if (selectedNode || selectedLink) {
      // Remember where we were before switching to details
      if (activeTabRef.current !== 'details') {
        previousTab.current = activeTabRef.current as 'filters' | 'discover';
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing tab to selection state
      setActiveTab('details');
    } else if (activeTabRef.current === 'details') {
      // Restore previous tab when details close
      setActiveTab(previousTab.current);
    }
  }, [selectedNode, selectedLink]);

  const handleCloseDetails = () => {
    onCloseDetails();
    setActiveTab(previousTab.current);
  };

  const isMobileOpen = !!mobileActiveTab;

  const switchTab = (tab: SidePanelTab) => {
    setActiveTab(tab);
    if (isMobileOpen && onMobileTabChange) onMobileTabChange(tab);
  };

  return (
    <div
      className={`side-panel${isMobileOpen ? ' side-panel--mobile-open' : ''}`}
      style={{ width: isMobileOpen ? undefined : panelWidth }}
    >
      <div className="side-panel-tabs">
        <button
          className={`side-panel-tab ${effectiveTab === 'filters' ? 'side-panel-tab--active' : ''}`}
          onClick={() => switchTab('filters')}
        >
          Filters
        </button>
        <button
          className={`side-panel-tab ${effectiveTab === 'discover' ? 'side-panel-tab--active' : ''}`}
          onClick={() => switchTab('discover')}
        >
          Discover
        </button>
        {hasSelection && (
          <>
            <button
              className={`side-panel-tab ${effectiveTab === 'details' ? 'side-panel-tab--active' : ''}`}
              onClick={() => switchTab('details')}
            >
              Details
            </button>
          </>
        )}
        {isMobileOpen ? (
          <button className="side-panel-close" onClick={onMobileClose}>
            &times;
          </button>
        ) : (
          hasSelection && (
            <button className="side-panel-close" onClick={handleCloseDetails}>
              &times;
            </button>
          )
        )}
      </div>

      <div
        className="side-panel-content"
        style={{ display: effectiveTab === 'filters' ? undefined : 'none' }}
      >
        <FilterPanel
          nodeTypes={nodeTypes}
          linkTypes={linkTypes}
          hiddenNodeTypes={hiddenNodeTypes}
          hiddenLinkTypes={hiddenLinkTypes}
          subTypesByNodeType={subTypesByNodeType}
          hiddenSubTypes={hiddenSubTypes}
          onToggleNodeType={onToggleNodeType}
          onToggleLinkType={onToggleLinkType}
          onToggleSubType={onToggleSubType}
          onShowAllNodes={onShowAllNodes}
          onHideAllNodes={onHideAllNodes}
          onShowAllLinks={onShowAllLinks}
          onHideAllLinks={onHideAllLinks}
          colorMode={colorMode}
          communities={communities}
          hiddenCommunities={hiddenCommunities}
          onToggleCommunity={onToggleCommunity}
          onShowAllCommunities={onShowAllCommunities}
          onHideAllCommunities={onHideAllCommunities}
        />
      </div>
      <div
        className="side-panel-content"
        style={{ display: effectiveTab === 'discover' ? undefined : 'none' }}
      >
        <DiscoverPanel
          onSelectNode={onSelectNode ?? (() => {})}
          graphVersion={graphVersion}
          selectedNodeId={selectedNode?.id as string | undefined}
          graphNodeIds={graphNodeIds}
          hopMap={hopMap}
          isActive={effectiveTab === 'discover'}
        />
      </div>
      {effectiveTab === 'details' && (
        <div className="side-panel-content">
          {selectedNode ? (
            <NodeDetailsPanel
              node={selectedNode}
              nodeSource={nodeSource}
              sourceLoading={sourceLoading}
              communityName={communityName}
              communityColor={communityColor}
              sourceError={sourceError}
            />
          ) : selectedLink ? (
            <EdgeDetailsPanel link={selectedLink} onSelectNode={onSelectNode} />
          ) : null}
        </div>
      )}
      {!isMobileOpen && (
        <div className="side-panel-drag-handle" onMouseDown={handleMouseDown} />
      )}
    </div>
  );
}
