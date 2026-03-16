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

import { useState } from 'react';
import { getNodeColor } from './nodeColors';
import type { NodeResult } from './parsers';

interface Props {
  nodes: NodeResult[];
  onNodeSelect?: (nodeId: string) => void;
}

const INITIAL_LIMIT = 20;

/** Pick the most useful property to show inline (skip boring ones) */
function pickInlineProp(props: Record<string, unknown>): string | null {
  const skip = new Set(['display_name', 'name', 'id', 'type']);
  for (const [k, v] of Object.entries(props)) {
    if (skip.has(k)) continue;
    const s = String(v);
    if (s && s !== 'undefined' && s !== 'null') return `${k}: ${s}`;
  }
  return null;
}

/** Compact table-like row layout for node lists */
export default function NodeListResult({ nodes, onNodeSelect }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (nodes.length === 0) {
    return <p className="result-empty">No nodes found.</p>;
  }

  // Count by type for the header
  const typeCounts: Record<string, number> = {};
  for (const n of nodes) {
    typeCounts[n.type] = (typeCounts[n.type] || 0) + 1;
  }
  const summary = Object.entries(typeCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
    .join(', ');

  const visible = expanded ? nodes : nodes.slice(0, INITIAL_LIMIT);
  const hasMore = nodes.length > INITIAL_LIMIT;

  return (
    <div className="result-node-list">
      <div className="result-list-header">{summary}</div>
      {visible.map((node) => {
        const color = getNodeColor(node.type);
        const inlineProp = node.properties
          ? pickInlineProp(node.properties)
          : null;
        return (
          <div
            key={node.id}
            className="result-row"
            onClick={() => onNodeSelect?.(node.id)}
          >
            <span className="result-type-badge" style={{ background: color }}>
              {node.type}
            </span>
            <span className="result-node-name">{node.name}</span>
            {inlineProp && (
              <span className="result-prop-inline">{inlineProp}</span>
            )}
          </div>
        );
      })}
      {hasMore && (
        <button
          className="result-show-more"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : `Show all ${nodes.length}`}
        </button>
      )}
    </div>
  );
}
