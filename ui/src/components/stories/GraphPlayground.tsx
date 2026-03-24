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

import { useCallback, useMemo, useRef, useState } from 'react';
import type { GraphNode } from '../types/graph';
import type { GraphCanvasHandle } from '../types/canvas';
import PixiGraphCanvas from '../PixiGraphCanvas';
import GraphLegend from '../panels/GraphLegend';
import FilterPanel from '../panels/FilterPanel';
import PhysicsPanel from '../panels/PhysicsPanel';
import GraphBadge from '../panels/GraphBadge';
import { getNodeColor } from '../colors/nodeColors';
import { getLinkColor } from '../colors/linkColors';
import type { FilterItem, LegendItem } from '../panels/types';
import type { Dataset } from './datasets';
import { DATASETS } from './datasets';

export interface GraphPlaygroundProps {
  /** Initial dataset to display */
  dataset?: Dataset;
  /** Width override (defaults to 100% of container) */
  width?: number;
  /** Height override */
  height?: number;
}

export default function GraphPlayground({
  dataset: initialDataset,
  width: widthProp,
  height: heightProp,
}: GraphPlaygroundProps) {
  // ── Dataset selection ──────────────────────────────────────────────
  const [currentDataset, setCurrentDataset] = useState<Dataset>(
    initialDataset ?? DATASETS[0],
  );
  const { nodes, links } = currentDataset;

  // ── Dimensions ─────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const width = widthProp ?? 900;
  const height = heightProp ?? 600;

  // ── Graph ref ──────────────────────────────────────────────────────
  const graphRef = useRef<GraphCanvasHandle>(null);

  // ── Search ─────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSearch, setActiveSearch] = useState('');
  const [hops, setHops] = useState(2);

  // ── Selection ──────────────────────────────────────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // ── Color / Display ────────────────────────────────────────────────
  const [colorMode, setColorMode] = useState<'type' | 'community'>('type');
  const [labelsVisible, setLabelsVisible] = useState(true);

  // ── Physics ────────────────────────────────────────────────────────
  const [repulsion, setRepulsion] = useState(100);
  const [isPhysicsRunning, setIsPhysicsRunning] = useState(true);

  // ── Pixi-specific ──────────────────────────────────────────────────
  const [linkDistance, setLinkDistance] = useState(200);
  const [centerStrength, setCenterStrength] = useState(0.3);
  const [edgesEnabled, setEdgesEnabled] = useState(true);
  const [layoutMode, setLayoutMode] = useState<'spread' | 'compact'>('spread');
  const [zoomSizeExponent, setZoomSizeExponent] = useState(0.8);

  // ── Filters ────────────────────────────────────────────────────────
  const [hiddenNodeTypes, setHiddenNodeTypes] = useState<Set<string>>(
    new Set(),
  );
  const [hiddenLinkTypes, setHiddenLinkTypes] = useState<Set<string>>(
    new Set(),
  );

  // ── Side panel ─────────────────────────────────────────────────────
  const [showFilters, setShowFilters] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  // ── Computed data ──────────────────────────────────────────────────

  const nodeTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const n of nodes) {
      counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    }
    return counts;
  }, [nodes]);

  const linkTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of links) {
      counts.set(l.label, (counts.get(l.label) ?? 0) + 1);
    }
    return counts;
  }, [links]);

  const nodeFilterItems: FilterItem[] = useMemo(
    () =>
      [...nodeTypeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({
          key: type,
          label: type,
          count,
          color: getNodeColor(type),
          hidden: hiddenNodeTypes.has(type),
        })),
    [nodeTypeCounts, hiddenNodeTypes],
  );

  const linkFilterItems: FilterItem[] = useMemo(
    () =>
      [...linkTypeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({
          key: label,
          label,
          count,
          color: getLinkColor(label),
          hidden: hiddenLinkTypes.has(label),
        })),
    [linkTypeCounts, hiddenLinkTypes],
  );

  const legendItems: LegendItem[] = useMemo(
    () =>
      [...nodeTypeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({
          label: type,
          count,
          color: getNodeColor(type),
        })),
    [nodeTypeCounts],
  );

  const linkLegendItems: LegendItem[] = useMemo(
    () =>
      [...linkTypeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([label, count]) => ({
          label,
          count,
          color: getLinkColor(label),
        })),
    [linkTypeCounts],
  );

  // ── Callbacks ──────────────────────────────────────────────────────

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNodeId(node.id);
    setSelectedNode(node);
  }, []);

  const handleStageClick = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedNode(null);
  }, []);

  const handleSearch = useCallback(() => {
    setActiveSearch(searchQuery);
  }, [searchQuery]);

  const handleReset = useCallback(() => {
    setSearchQuery('');
    setActiveSearch('');
    setSelectedNodeId(null);
    setSelectedNode(null);
  }, []);

  const toggleNodeType = useCallback((key: string) => {
    setHiddenNodeTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleLinkType = useCallback((key: string) => {
    setHiddenLinkTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleDatasetChange = useCallback((name: string) => {
    const ds = DATASETS.find((d) => d.name === name);
    if (ds) {
      setCurrentDataset(ds);
      setSelectedNodeId(null);
      setSelectedNode(null);
      setSearchQuery('');
      setActiveSearch('');
      setHiddenNodeTypes(new Set());
      setHiddenLinkTypes(new Set());
    }
  }, []);

  const handleStopPhysics = useCallback(() => {
    graphRef.current?.stopPhysics();
    setIsPhysicsRunning(false);
  }, []);

  const handleStartPhysics = useCallback(() => {
    graphRef.current?.startPhysics();
    setIsPhysicsRunning(true);
  }, []);

  const handleRepulsionChange = useCallback((value: number) => {
    setRepulsion(value);
    graphRef.current?.setChargeStrength?.(-value);
  }, []);

  // ── Visible counts (after filtering) ───────────────────────────────
  const visibleNodeCount = useMemo(
    () => nodes.filter((n) => !hiddenNodeTypes.has(n.type)).length,
    [nodes, hiddenNodeTypes],
  );

  const visibleEdgeCount = useMemo(
    () => links.filter((l) => !hiddenLinkTypes.has(l.label)).length,
    [links, hiddenLinkTypes],
  );

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: width + (showFilters || showSettings ? 260 : 0),
        fontFamily: 'Inter, system-ui, sans-serif',
        background: '#0d1117',
        color: '#e6edf3',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Dataset selector */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid #21262d',
          fontSize: 13,
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          Dataset:
          <select
            value={currentDataset.name}
            onChange={(e) => handleDatasetChange(e.target.value)}
            style={{
              background: '#21262d',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 12,
            }}
          >
            {DATASETS.map((ds) => (
              <option key={ds.name} value={ds.name}>
                {ds.name} ({ds.nodes.length} nodes, {ds.links.length} edges)
              </option>
            ))}
          </select>
        </label>
        <span style={{ color: '#8b949e', fontSize: 12 }}>
          {currentDataset.description}
        </span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setShowFilters((v) => !v)}
          style={{
            background: showFilters ? '#30363d' : '#21262d',
            color: '#e6edf3',
            border: '1px solid #30363d',
            borderRadius: 4,
            padding: '3px 10px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Filters
        </button>
        <button
          onClick={() => setShowSettings((v) => !v)}
          style={{
            background: showSettings ? '#30363d' : '#21262d',
            color: '#e6edf3',
            border: '1px solid #30363d',
            borderRadius: 4,
            padding: '3px 10px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Settings
        </button>
      </div>

      <div style={{ display: 'flex', flex: 1 }}>
        {/* Side panel */}
        {(showFilters || showSettings) && (
          <div
            style={{
              width: 250,
              borderRight: '1px solid #21262d',
              overflowY: 'auto',
              padding: '8px 0',
              flexShrink: 0,
            }}
          >
            {showFilters && (
              <>
                <FilterPanel
                  title="Node Types"
                  items={nodeFilterItems}
                  onToggle={toggleNodeType}
                  onShowAll={() => setHiddenNodeTypes(new Set())}
                  onHideAll={() =>
                    setHiddenNodeTypes(new Set(nodeTypeCounts.keys()))
                  }
                />
                <FilterPanel
                  title="Edge Types"
                  items={linkFilterItems}
                  indicator="line"
                  onToggle={toggleLinkType}
                  onShowAll={() => setHiddenLinkTypes(new Set())}
                  onHideAll={() =>
                    setHiddenLinkTypes(new Set(linkTypeCounts.keys()))
                  }
                />
              </>
            )}
            {showSettings && (
              <PhysicsPanel
                repulsion={repulsion}
                onRepulsionChange={handleRepulsionChange}
                labelsVisible={labelsVisible}
                onLabelsVisibleChange={setLabelsVisible}
                colorMode={colorMode}
                onColorModeChange={setColorMode}
                isPhysicsRunning={isPhysicsRunning}
                onStopPhysics={handleStopPhysics}
                onStartPhysics={handleStartPhysics}
                pixiMode
                linkDistance={linkDistance}
                onLinkDistanceChange={(v) => {
                  setLinkDistance(v);
                  graphRef.current?.setLinkDistance?.(v);
                }}
                centerStrength={centerStrength}
                onCenterStrengthChange={(v) => {
                  setCenterStrength(v);
                  graphRef.current?.setCenterStrength?.(v);
                }}
                edgesEnabled={edgesEnabled}
                onEdgesEnabledChange={(v) => {
                  setEdgesEnabled(v);
                  graphRef.current?.setEdgesEnabled?.(v);
                }}
                layoutMode={layoutMode}
                onLayoutModeChange={(mode) => {
                  setLayoutMode(mode);
                  graphRef.current?.setLayoutMode?.(mode);
                }}
                zoomSizeExponent={zoomSizeExponent}
                onZoomSizeExponentChange={(v) => {
                  setZoomSizeExponent(v);
                  graphRef.current?.setZoomSizeExponent?.(v);
                }}
                onReheat={() => graphRef.current?.reheat?.()}
                onFitToScreen={() => graphRef.current?.fitToScreen?.()}
              />
            )}
          </div>
        )}

        {/* Graph area */}
        <div style={{ position: 'relative', flex: 1 }}>
          <PixiGraphCanvas
            key={currentDataset.name}
            ref={graphRef}
            nodes={nodes}
            links={links}
            width={width}
            height={height}
            colorMode={colorMode}
            hiddenNodeTypes={hiddenNodeTypes}
            hiddenLinkTypes={hiddenLinkTypes}
            searchQuery={activeSearch}
            selectedNodeId={selectedNodeId}
            hops={hops}
            labelsVisible={labelsVisible}
            zIndex
            onNodeClick={handleNodeClick}
            onStageClick={handleStageClick}
          />

          {/* Legend overlay */}
          <div style={{ position: 'absolute', bottom: 8, left: 8 }}>
            <GraphLegend items={legendItems} linkItems={linkLegendItems} />
          </div>

          {/* Node info overlay */}
          {selectedNode && (
            <div
              style={{
                position: 'absolute',
                top: 8,
                right: 8,
                background: 'rgba(13, 17, 23, 0.92)',
                border: '1px solid #30363d',
                borderRadius: 8,
                padding: '10px 14px',
                fontSize: 13,
                maxWidth: 260,
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {selectedNode.name}
              </div>
              <div style={{ color: '#8b949e', fontSize: 12, marginBottom: 4 }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: getNodeColor(selectedNode.type),
                    marginRight: 6,
                  }}
                />
                {selectedNode.type}
              </div>
              {selectedNode.properties &&
                Object.keys(selectedNode.properties).length > 0 && (
                  <div style={{ fontSize: 11, color: '#8b949e' }}>
                    {Object.entries(selectedNode.properties).map(([k, v]) => (
                      <div key={k}>
                        <span style={{ color: '#58a6ff' }}>{k}</span>:{' '}
                        {String(v)}
                      </div>
                    ))}
                  </div>
                )}
              <button
                onClick={handleStageClick}
                style={{
                  marginTop: 6,
                  padding: '2px 8px',
                  fontSize: 11,
                  background: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
              >
                Deselect
              </button>
            </div>
          )}

          {/* Bottom bar with badge */}
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              right: 8,
            }}
          >
            <GraphBadge
              nodeCount={visibleNodeCount}
              edgeCount={visibleEdgeCount}
              totalNodes={nodes.length}
              totalEdges={links.length}
            />
          </div>
        </div>
      </div>

      {/* Search bar at bottom */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderTop: '1px solid #21262d',
          fontSize: 13,
        }}
      >
        <input
          type="text"
          placeholder="Search nodes..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          style={{
            flex: 1,
            background: '#21262d',
            color: '#e6edf3',
            border: '1px solid #30363d',
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 13,
            outline: 'none',
          }}
        />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 12,
          }}
        >
          Hops:
          <input
            type="number"
            min={0}
            max={5}
            value={hops}
            onChange={(e) =>
              setHops(Math.max(0, Math.min(5, parseInt(e.target.value) || 0)))
            }
            style={{
              width: 40,
              background: '#21262d',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: 4,
              padding: '4px 6px',
              fontSize: 12,
              textAlign: 'center',
            }}
          />
        </label>
        <button
          onClick={handleSearch}
          style={{
            background: '#238636',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            padding: '4px 12px',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Search
        </button>
        {(activeSearch || selectedNodeId) && (
          <button
            onClick={handleReset}
            style={{
              background: '#21262d',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: 4,
              padding: '4px 12px',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
