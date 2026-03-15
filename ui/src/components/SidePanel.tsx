import { useEffect, useRef, useState } from 'react';
import type { SelectedNode, SelectedEdge } from '../types/graph';
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
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<
    'filters' | 'discover' | 'details'
  >('filters');
  const previousTab = useRef<'filters' | 'discover'>('filters');
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  });

  const hasSelection = selectedNode !== null || selectedLink !== null;
  const expanded = hasSelection || activeTab === 'discover';

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

  return (
    <div className="side-panel" style={{ width: panelWidth }}>
      <div className="side-panel-tabs">
        <button
          className={`side-panel-tab ${activeTab === 'filters' ? 'side-panel-tab--active' : ''}`}
          onClick={() => setActiveTab('filters')}
        >
          Filters
        </button>
        <button
          className={`side-panel-tab ${activeTab === 'discover' ? 'side-panel-tab--active' : ''}`}
          onClick={() => setActiveTab('discover')}
        >
          Discover
        </button>
        {hasSelection && (
          <>
            <button
              className={`side-panel-tab ${activeTab === 'details' ? 'side-panel-tab--active' : ''}`}
              onClick={() => setActiveTab('details')}
            >
              Details
            </button>
            <button className="side-panel-close" onClick={handleCloseDetails}>
              &times;
            </button>
          </>
        )}
      </div>

      <div
        className="side-panel-content"
        style={{ display: activeTab === 'filters' ? undefined : 'none' }}
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
        style={{ display: activeTab === 'discover' ? undefined : 'none' }}
      >
        <DiscoverPanel
          onSelectNode={onSelectNode ?? (() => {})}
          graphVersion={graphVersion}
          selectedNodeId={selectedNode?.id as string | undefined}
          graphNodeIds={graphNodeIds}
          hopMap={hopMap}
          isActive={activeTab === 'discover'}
        />
      </div>
      {activeTab === 'details' && (
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
      <div className="side-panel-drag-handle" onMouseDown={handleMouseDown} />
    </div>
  );
}
