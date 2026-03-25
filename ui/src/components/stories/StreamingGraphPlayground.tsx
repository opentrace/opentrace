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
 * StreamingGraph — demonstrates graph updates arriving in batches over time,
 * simulating the indexing pipeline's incremental data flow.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GraphNode, GraphLink } from '../types/graph';
import type { GraphCanvasHandle } from '../types/canvas';
import PixiGraphCanvas from '../PixiGraphCanvas';
import GraphLegend from '../panels/GraphLegend';
import GraphBadge from '../panels/GraphBadge';
import { getNodeColor } from '../colors/nodeColors';
import { getLinkColor } from '../colors/linkColors';
import type { LegendItem } from '../panels/types';
import type { Dataset } from './datasets';
import { DATASETS } from './datasets';

export interface StreamingGraphPlaygroundProps {
  /** Dataset to stream in (nodes/links added incrementally) */
  dataset?: Dataset;
  /** Nodes to add per batch */
  batchSize?: number;
  /** Milliseconds between batches */
  intervalMs?: number;
  /** Enable 3D perspective mode */
  mode3d?: boolean;
  width?: number;
  height?: number;
}

/**
 * Given the full dataset and a set of visible node IDs, return only the links
 * whose source AND target are both visible.
 */
function visibleLinks(
  allLinks: GraphLink[],
  nodeIds: Set<string>,
): GraphLink[] {
  return allLinks.filter((l) => nodeIds.has(l.source) && nodeIds.has(l.target));
}

export default function StreamingGraphPlayground({
  dataset: initialDataset,
  batchSize = 5,
  intervalMs = 1500,
  mode3d = false,
  width: widthProp,
  height: heightProp,
}: StreamingGraphPlaygroundProps) {
  const ds = initialDataset ?? DATASETS[0];
  const width = widthProp ?? 900;
  const height = heightProp ?? 600;

  const graphRef = useRef<GraphCanvasHandle>(null);

  // How many nodes are currently visible (we reveal them progressively)
  const [revealedCount, setRevealedCount] = useState(batchSize);
  const [streaming, setStreaming] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Slice the dataset to the current reveal count
  const currentNodes = ds.nodes.slice(0, revealedCount);
  const nodeIdSet = new Set(currentNodes.map((n) => n.id));
  const currentLinks = visibleLinks(ds.links, nodeIdSet);

  const isDone = revealedCount >= ds.nodes.length;

  // Timer-based streaming
  useEffect(() => {
    if (!streaming || isDone) return;

    const timer = setInterval(() => {
      setRevealedCount((prev) => {
        const next = Math.min(prev + batchSize, ds.nodes.length);
        if (next >= ds.nodes.length) {
          setStreaming(false);
        }
        return next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [streaming, isDone, batchSize, intervalMs, ds.nodes.length]);

  // Legend items
  const legendItems: LegendItem[] = (() => {
    const counts = new Map<string, number>();
    for (const n of currentNodes) {
      counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({
        label: type,
        count,
        color: getNodeColor(type),
      }));
  })();

  const linkLegendItems: LegendItem[] = (() => {
    const counts = new Map<string, number>();
    for (const l of currentLinks) {
      counts.set(l.label, (counts.get(l.label) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, count]) => ({
        label,
        count,
        color: getLinkColor(label),
      }));
  })();

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNodeId(node.id);
  }, []);

  const handleStageClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  const handleRestart = useCallback(() => {
    setRevealedCount(batchSize);
    setStreaming(true);
    setSelectedNodeId(null);
  }, [batchSize]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width,
        fontFamily: 'Inter, system-ui, sans-serif',
        background: '#0d1117',
        color: '#e6edf3',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Controls bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          borderBottom: '1px solid #21262d',
          fontSize: 13,
        }}
      >
        <span style={{ fontWeight: 600 }}>Streaming Graph</span>
        <span style={{ color: '#8b949e', fontSize: 12 }}>
          {currentNodes.length} / {ds.nodes.length} nodes &middot;{' '}
          {currentLinks.length} edges
        </span>
        <span style={{ flex: 1 }} />
        {streaming ? (
          <button
            onClick={() => setStreaming(false)}
            style={{
              background: '#da3633',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '4px 12px',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Pause
          </button>
        ) : !isDone ? (
          <button
            onClick={() => setStreaming(true)}
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
            Resume
          </button>
        ) : null}
        <button
          onClick={handleRestart}
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
          Restart
        </button>
        {isDone && (
          <span
            style={{
              color: '#3fb950',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Complete
          </span>
        )}
      </div>

      {/* Progress bar */}
      <div
        style={{
          height: 3,
          background: '#21262d',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${(currentNodes.length / ds.nodes.length) * 100}%`,
            background: streaming ? '#58a6ff' : isDone ? '#3fb950' : '#d29922',
            transition: 'width 0.3s ease, background 0.3s ease',
          }}
        />
      </div>

      {/* Graph */}
      <div style={{ position: 'relative' }}>
        <PixiGraphCanvas
          ref={graphRef}
          nodes={currentNodes}
          links={currentLinks}
          width={width}
          height={height}
          zIndex
          mode3d={mode3d}
          selectedNodeId={selectedNodeId}
          hops={2}
          onNodeClick={handleNodeClick}
          onStageClick={handleStageClick}
        />

        <div style={{ position: 'absolute', bottom: 8, left: 8 }}>
          <GraphLegend items={legendItems} linkItems={linkLegendItems} />
        </div>

        <div style={{ position: 'absolute', bottom: 8, right: 8 }}>
          <GraphBadge
            nodeCount={currentNodes.length}
            edgeCount={currentLinks.length}
            totalNodes={ds.nodes.length}
            totalEdges={ds.links.length}
          />
        </div>
      </div>
    </div>
  );
}
