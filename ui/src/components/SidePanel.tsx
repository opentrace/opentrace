import { useEffect, useRef, useState } from 'react';
import type { NodeObject, LinkObject } from 'react-force-graph-2d';
import type { GraphNode, GraphLink } from '../types/graph';
import type { NodeSourceResponse } from '../store/types';
import FilterPanel from './FilterPanel';
import DiscoverPanel from './DiscoverPanel';
import NodeDetailsPanel from './NodeDetailsPanel';
import EdgeDetailsPanel from './EdgeDetailsPanel';
import './SidePanel.css';

type Node = NodeObject<GraphNode>;
type Link = LinkObject<GraphNode, GraphLink>;

interface TypeEntry {
  type: string;
  count: number;
}

interface SubTypeEntry {
  subType: string;
  count: number;
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

  /* Node details props */
  selectedNode: Node | null;
  nodeSource: NodeSourceResponse | null;
  sourceLoading: boolean;
  sourceError: string | null;
  onCloseDetails: () => void;

  /* Edge details props */
  selectedLink: Link | null;
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
  selectedNode,
  nodeSource,
  sourceLoading,
  sourceError,
  onCloseDetails,
  selectedLink,
  onSelectNode,
  graphVersion,
  graphNodeIds,
  hopMap,
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<'filters' | 'discover' | 'details'>('filters');
  const previousTab = useRef<'filters' | 'discover'>('filters');
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Auto-switch to details when node or edge is selected
  useEffect(() => {
    if (selectedNode || selectedLink) {
      // Remember where we were before switching to details
      if (activeTabRef.current !== 'details') {
        previousTab.current = activeTabRef.current as 'filters' | 'discover';
      }
      setActiveTab('details');
    } else if (activeTabRef.current === 'details') {
      // Restore previous tab when details close
      setActiveTab(previousTab.current);
    }
  }, [selectedNode, selectedLink]);

  const hasSelection = selectedNode !== null || selectedLink !== null;
  const expanded = hasSelection || activeTab === 'discover';

  const handleCloseDetails = () => {
    onCloseDetails();
    setActiveTab(previousTab.current);
  };

  return (
    <div className={`side-panel ${expanded ? 'side-panel--expanded' : ''}`}>
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

      <div className="side-panel-content" style={{ display: activeTab === 'filters' ? undefined : 'none' }}>
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
        />
      </div>
      <div className="side-panel-content" style={{ display: activeTab === 'discover' ? undefined : 'none' }}>
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
              sourceError={sourceError}
            />
          ) : selectedLink ? (
            <EdgeDetailsPanel link={selectedLink} onSelectNode={onSelectNode} />
          ) : null}
        </div>
      )}
    </div>
  );
}
