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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FilterPanel,
  PanelResizeHandle,
  getLinkColor,
  getNodeColor,
  type FilterItem,
  type FilterPanelProps,
} from '@opentrace/components';
import type { NodeSourceResponse } from '../store/types';
import { useStore } from '../store/context';
import {
  useResizablePanel,
  useResizablePanelHeight,
} from '../hooks/useResizablePanel';
import { useGraph } from '../providers/GraphDataProvider';
import { useGraphInteraction } from '../providers/GraphInteractionProvider';
import { linkId } from '../providers/graphFilterUtils';
import DiscoverPanelContainer from './DiscoverPanelContainer';
import { createStoreDataProvider } from './storeDataProvider';
import NodeDetailsPanel, { type NodeEdge } from './NodeDetailsPanel';
import EdgeDetailsPanel from './EdgeDetailsPanel';
import HistoryPanel from './HistoryPanel';
import IndexMetadataPanel from './IndexMetadataPanel';
import './SidePanel.css';

export type SidePanelTab = 'filters' | 'discover' | 'history' | 'details';

/** Node types whose source code can be fetched and displayed. */
const SOURCE_TYPES = new Set(['File', 'Function', 'Class', 'PullRequest']);

interface SidePanelProps {
  /** Mobile: externally controlled active tab */
  mobileActiveTab?: SidePanelTab | null;
  /** Mobile: callback to switch tabs while the panel is open */
  onMobileTabChange?: (tab: SidePanelTab) => void;
  /** Mobile: callback when the panel wants to close */
  onMobileClose?: () => void;
}

export default function SidePanel({
  mobileActiveTab,
  onMobileTabChange,
  onMobileClose,
}: SidePanelProps) {
  const { store } = useStore();

  // Selection, filters, history, color mode, and derived data come from the
  // GraphInteractionProvider so SidePanel can live as a sibling of GraphViewer.
  const {
    selectedNode,
    selectedLink,
    selectNode,
    selectLink,
    clearSelection,
    nodeHistory,
    setNodeHistory,
    hiddenNodeTypes,
    setHiddenNodeTypes,
    hiddenLinkTypes,
    setHiddenLinkTypes,
    hiddenSubTypes,
    setHiddenSubTypes,
    hiddenCommunities,
    setHiddenCommunities,
    colorMode,
    availableNodeTypes,
    availableLinkTypes,
    availableSubTypes,
    availableCommunities,
    communityData,
    filteredGraphData,
    focusCommunity,
    hopMap,
    graphNodeIds,
  } = useGraphInteraction();
  const { graphVersion, graphData } = useGraph();

  // ─── Source code fetch for the selected node ─────────────────────────
  const [nodeSource, setNodeSource] = useState<NodeSourceResponse | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect -- async fetch pattern with cleanup */
  useEffect(() => {
    if (!selectedNode || !SOURCE_TYPES.has(selectedNode.type)) {
      setNodeSource(null);
      setSourceError(null);
      return;
    }

    let cancelled = false;
    setSourceLoading(true);
    setSourceError(null);
    setNodeSource(null);

    const startLine = selectedNode.properties?.startLine as number | undefined;
    const endLine = selectedNode.properties?.endLine as number | undefined;

    store
      .fetchSource(selectedNode.id, startLine, endLine)
      .then((src) => {
        if (cancelled) return;
        if (src) setNodeSource(src);
        else setSourceError('Source not available');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.name === 'AbortError') return;
        setSourceError(err.message);
      })
      .finally(() => {
        if (!cancelled) setSourceLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNode?.id, store]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  // ─── Selection callbacks (from context, plus light wrappers) ─────────
  const onCommunityFocus = useCallback(
    (key: string) => focusCommunity(Number(key)),
    [focusCommunity],
  );
  const handleSelectNodeId = useCallback(
    (nodeId: string) => {
      const node = graphData.nodes.find((n) => n.id === nodeId);
      if (node) selectNode(node);
    },
    [graphData.nodes, selectNode],
  );
  const handleSelectEdgeFromNode = useCallback(
    (edge: NodeEdge) => {
      if (!selectedNode) return;
      const sourceId =
        edge.direction === 'outgoing' ? selectedNode.id : edge.otherNodeId;
      const targetId =
        edge.direction === 'outgoing' ? edge.otherNodeId : selectedNode.id;
      const nodeMap = new Map(filteredGraphData.nodes.map((n) => [n.id, n]));
      selectLink({
        source: sourceId,
        target: targetId,
        label: edge.label,
        properties: edge.properties,
        sourceNode: nodeMap.get(sourceId),
        targetNode: nodeMap.get(targetId),
      });
    },
    [selectedNode, filteredGraphData.nodes, selectLink],
  );

  const discoverDataProvider = useMemo(
    () => createStoreDataProvider(store),
    [store],
  );

  const [activeTab, setActiveTab] = useState<
    'filters' | 'discover' | 'history' | 'details'
  >('filters');
  const previousTab = useRef<'filters' | 'discover' | 'history'>('filters');
  const activeTabRef = useRef(activeTab);
  useEffect(() => {
    activeTabRef.current = activeTab;
  });

  // On mobile, the externally-set tab takes priority
  const effectiveTab = mobileActiveTab ?? activeTab;

  const hasSelection = selectedNode !== null || selectedLink !== null;

  const panelRef = useRef<HTMLDivElement>(null);
  const { width: panelWidth, handleMouseDown } = useResizablePanel({
    storageKey: 'ot_side_panel_width',
    defaultWidth: 360,
    minWidth: 220,
    maxWidth: 900,
    side: 'right',
    panelRef,
  });
  const { height: panelHeight, handleMouseDown: onHeightDrag } =
    useResizablePanelHeight({
      storageKey: 'ot_side_panel_height',
      minHeight: 320,
      maxHeight: 1400,
      side: 'bottom',
      panelRef,
    });

  // Auto-switch to details when node or edge is selected
  useEffect(() => {
    if (selectedNode || selectedLink) {
      // Remember where we were before switching to details
      if (activeTabRef.current !== 'details') {
        previousTab.current = activeTabRef.current as
          | 'filters'
          | 'discover'
          | 'history';
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing tab to selection state
      setActiveTab('details');
    } else if (activeTabRef.current === 'details') {
      // Restore previous tab when details close
      setActiveTab(previousTab.current);
    }
  }, [selectedNode, selectedLink]);

  // ─── Derived: community label for selected node ───────────────────────
  const selectedCommunityId =
    selectedNode !== null
      ? communityData.assignments[selectedNode.id]
      : undefined;
  const communityName =
    selectedCommunityId !== undefined
      ? communityData.names.get(selectedCommunityId)
      : undefined;
  const communityColor =
    selectedCommunityId !== undefined
      ? communityData.colorMap.get(selectedCommunityId)
      : undefined;

  // ─── Derived: edges connected to the selected node ────────────────────
  const selectedNodeEdges = useMemo<NodeEdge[]>(() => {
    if (!selectedNode) return [];
    const nodeId = selectedNode.id;
    const nodeMap = new Map(filteredGraphData.nodes.map((n) => [n.id, n]));
    return filteredGraphData.links
      .filter((l) => linkId(l.source) === nodeId || linkId(l.target) === nodeId)
      .map((l) => {
        const sourceId = linkId(l.source);
        const targetId = linkId(l.target);
        const isOutgoing = sourceId === nodeId;
        const otherId = isOutgoing ? targetId : sourceId;
        const otherNode = nodeMap.get(otherId);
        return {
          direction: isOutgoing ? ('outgoing' as const) : ('incoming' as const),
          label: l.label || 'unknown',
          properties: l.properties,
          otherNodeId: otherId,
          otherNodeName: otherNode?.name ?? otherId,
          otherNodeType: otherNode?.type,
        };
      });
  }, [selectedNode, filteredGraphData.nodes, filteredGraphData.links]);

  // ─── Derived: filter sections for the FilterPanel UI ──────────────────
  const filterSections = useMemo<FilterPanelProps[]>(() => {
    const nodeFilterItems: FilterItem[] = availableNodeTypes.map(
      ({ type, count }) => {
        const subs = availableSubTypes.get(type);
        const children = subs?.map((s) => ({
          key: `${type}:${s.subType}`,
          label: s.subType,
          count: s.count,
          color: getNodeColor(type),
          hidden: hiddenSubTypes.has(`${type}:${s.subType}`),
        }));
        return {
          key: type,
          label: type,
          count,
          color: getNodeColor(type),
          hidden: hiddenNodeTypes.has(type),
          children,
        };
      },
    );

    const toggleNodeFilter = (key: string) => {
      if (key.includes(':')) {
        // Sub-type key like "Class:Controller"
        setHiddenSubTypes((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      } else {
        const subs = availableSubTypes.get(key);
        if (subs && subs.length > 0) {
          setHiddenSubTypes((prev) => {
            const keys = subs.map((s) => `${key}:${s.subType}`);
            const allHidden = keys.every((k) => prev.has(k));
            const next = new Set(prev);
            if (allHidden) {
              keys.forEach((k) => next.delete(k));
            } else {
              keys.forEach((k) => next.add(k));
            }
            return next;
          });
        } else {
          setHiddenNodeTypes((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        }
      }
    };

    const linkFilterItems: FilterItem[] = availableLinkTypes.map(
      ({ type, count }) => ({
        key: type,
        label: type.toUpperCase(),
        count,
        color: getLinkColor(type),
        hidden: hiddenLinkTypes.has(type),
      }),
    );

    const communityFilterItems: FilterItem[] = availableCommunities.map(
      ({ communityId, label, count, color }) => ({
        key: String(communityId),
        label,
        count,
        color,
        hidden: hiddenCommunities.has(communityId),
      }),
    );

    const sections: FilterPanelProps[] = [];

    if (colorMode === 'community' && communityFilterItems.length > 0) {
      sections.push({
        title: 'Communities',
        items: communityFilterItems,
        onToggle: (key) => {
          const cid = Number(key);
          setHiddenCommunities((prev) => {
            const next = new Set(prev);
            if (next.has(cid)) next.delete(cid);
            else next.add(cid);
            return next;
          });
        },
        onShowAll: () => setHiddenCommunities(new Set()),
        onHideAll: () =>
          setHiddenCommunities(
            new Set(availableCommunities.map((c) => c.communityId)),
          ),
        onFocus: onCommunityFocus,
      });
    }

    sections.push({
      title: 'Node Types',
      items: nodeFilterItems,
      onToggle: toggleNodeFilter,
      onShowAll: () => {
        setHiddenNodeTypes(new Set());
        setHiddenSubTypes(new Set());
      },
      onHideAll: () => {
        setHiddenNodeTypes(new Set(availableNodeTypes.map((t) => t.type)));
        const allSubKeys = new Set<string>();
        availableSubTypes.forEach((subs, type) => {
          subs.forEach((s) => allSubKeys.add(`${type}:${s.subType}`));
        });
        setHiddenSubTypes(allSubKeys);
      },
    });

    sections.push({
      title: 'Edges',
      items: linkFilterItems,
      indicator: 'line',
      emptyMessage: 'No edges',
      onToggle: (key) =>
        setHiddenLinkTypes((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
      onShowAll: () => setHiddenLinkTypes(new Set()),
      onHideAll: () =>
        setHiddenLinkTypes(new Set(availableLinkTypes.map((t) => t.type))),
    });

    return sections;
  }, [
    availableNodeTypes,
    availableLinkTypes,
    availableSubTypes,
    availableCommunities,
    hiddenNodeTypes,
    hiddenLinkTypes,
    hiddenSubTypes,
    hiddenCommunities,
    colorMode,
    onCommunityFocus,
    setHiddenNodeTypes,
    setHiddenLinkTypes,
    setHiddenSubTypes,
    setHiddenCommunities,
  ]);

  const handleCloseDetails = () => {
    clearSelection();
    setActiveTab(previousTab.current);
  };

  const handleClearHistory = () => setNodeHistory([]);

  const isMobileOpen = !!mobileActiveTab;

  const switchTab = (tab: SidePanelTab) => {
    setActiveTab(tab);
    if (isMobileOpen && onMobileTabChange) onMobileTabChange(tab);
  };

  return (
    <div
      ref={panelRef}
      className={`side-panel${isMobileOpen ? ' side-panel--mobile-open' : ''}`}
      style={
        {
          width: panelWidth,
          ...(panelHeight != null
            ? { '--side-panel-height': `${panelHeight}px` }
            : {}),
        } as React.CSSProperties
      }
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
        <button
          className={`side-panel-tab ${effectiveTab === 'history' ? 'side-panel-tab--active' : ''}`}
          onClick={() => switchTab('history')}
        >
          History
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
        <div className="filter-panel">
          {filterSections.map((section) => (
            <FilterPanel key={section.title} {...section} />
          ))}
          <IndexMetadataPanel graphVersion={graphVersion} />
        </div>
      </div>
      <div
        className="side-panel-content"
        style={{ display: effectiveTab === 'discover' ? undefined : 'none' }}
      >
        <DiscoverPanelContainer
          onSelectNode={handleSelectNodeId}
          dataProvider={discoverDataProvider}
          graphVersion={graphVersion}
          selectedNodeId={selectedNode?.id as string | undefined}
          graphNodeIds={graphNodeIds}
          hopMap={hopMap}
          isActive={effectiveTab === 'discover'}
        />
      </div>
      <div
        className="side-panel-content"
        style={{ display: effectiveTab === 'history' ? undefined : 'none' }}
      >
        <HistoryPanel
          entries={nodeHistory}
          onSelectNode={handleSelectNodeId}
          onClear={handleClearHistory}
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
              edges={selectedNodeEdges}
              onSelectNode={handleSelectNodeId}
              onSelectEdge={handleSelectEdgeFromNode}
            />
          ) : selectedLink ? (
            <EdgeDetailsPanel
              link={selectedLink}
              onSelectNode={handleSelectNodeId}
            />
          ) : null}
        </div>
      )}
      <PanelResizeHandle side="right" onMouseDown={handleMouseDown} />
      <PanelResizeHandle side="bottom" onMouseDown={onHeightDrag} />
      <PanelResizeHandle
        side="bottom-right"
        onMouseDown={(e) => {
          handleMouseDown(e, 'nwse-resize');
          onHeightDrag(e, 'nwse-resize');
        }}
      />
    </div>
  );
}
