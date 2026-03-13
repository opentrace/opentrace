import { useEffect, useState } from 'react';
import type { NodeObject, LinkObject } from 'react-force-graph-2d';
import type { GraphNode, GraphLink } from '../types/graph';
import type { NodeSourceResponse } from '../store/types';
import FilterPanel from './FilterPanel';
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
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<'filters' | 'details'>('filters');

  // Auto-switch tabs when node or edge selection changes
  useEffect(() => {
    if (selectedNode || selectedLink) {
      setActiveTab('details');
    } else {
      setActiveTab('filters');
    }
  }, [selectedNode, selectedLink]);

  const expanded = selectedNode !== null || selectedLink !== null;

  return (
    <div className={`side-panel ${expanded ? 'side-panel--expanded' : ''}`}>
      {expanded && (
        <div className="side-panel-tabs">
          <button
            className={`side-panel-tab ${activeTab === 'filters' ? 'side-panel-tab--active' : ''}`}
            onClick={() => setActiveTab('filters')}
          >
            Filters
          </button>
          <button
            className={`side-panel-tab ${activeTab === 'details' ? 'side-panel-tab--active' : ''}`}
            onClick={() => setActiveTab('details')}
          >
            Details
          </button>
          <button className="side-panel-close" onClick={onCloseDetails}>
            &times;
          </button>
        </div>
      )}

      <div className="side-panel-content">
        {activeTab === 'filters' ? (
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
        ) : selectedNode ? (
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
    </div>
  );
}
