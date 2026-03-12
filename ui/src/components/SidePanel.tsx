import { useEffect, useState } from 'react';
import type { NodeObject } from 'react-force-graph-2d';
import type { GraphNode } from '../types/graph';
import type { NodeSourceResponse } from '../store/types';
import FilterPanel from './FilterPanel';
import NodeDetailsPanel from './NodeDetailsPanel';
import './SidePanel.css';

type Node = NodeObject<GraphNode>;

interface TypeEntry {
  type: string;
  count: number;
}

interface SidePanelProps {
  /* Filter props — forwarded to FilterPanel */
  nodeTypes: TypeEntry[];
  linkTypes: TypeEntry[];
  hiddenNodeTypes: Set<string>;
  hiddenLinkTypes: Set<string>;
  onToggleNodeType: (type: string) => void;
  onToggleLinkType: (type: string) => void;
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
}

export default function SidePanel({
  nodeTypes,
  linkTypes,
  hiddenNodeTypes,
  hiddenLinkTypes,
  onToggleNodeType,
  onToggleLinkType,
  onShowAllNodes,
  onHideAllNodes,
  onShowAllLinks,
  onHideAllLinks,
  selectedNode,
  nodeSource,
  sourceLoading,
  sourceError,
  onCloseDetails,
}: SidePanelProps) {
  const [activeTab, setActiveTab] = useState<'filters' | 'details'>('filters');

  // Auto-switch tabs when node selection changes
  useEffect(() => {
    if (selectedNode) {
      setActiveTab('details');
    } else {
      setActiveTab('filters');
    }
  }, [selectedNode]);

  const expanded = selectedNode !== null;

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
            onToggleNodeType={onToggleNodeType}
            onToggleLinkType={onToggleLinkType}
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
        ) : null}
      </div>
    </div>
  );
}
