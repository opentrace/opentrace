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
import { getNodeColor } from '../../colors/nodeColors';
import type { TraverseEntry } from './parsers';

interface Props {
  entries: TraverseEntry[];
  onNodeSelect?: (nodeId: string) => void;
}

const INITIAL_LIMIT = 30;

/**
 * Determine which entries are the last at their depth level.
 * An entry is "last at depth" if no subsequent sibling at the same depth
 * appears before the depth decreases or the list ends.
 */
function computeLastAtDepth(entries: TraverseEntry[]): Set<number> {
  const lastSet = new Set<number>();
  for (let i = entries.length - 1; i >= 0; i--) {
    const depth = entries[i].depth;
    // Check if any later entry at the same depth exists before
    // the parent scope ends (i.e., a shallower depth appears)
    let isLast = true;
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].depth < depth) break;
      if (entries[j].depth === depth) {
        isLast = false;
        break;
      }
    }
    if (isLast) lastSet.add(i);
  }
  return lastSet;
}

/** Hierarchical tree view with CSS-based tree-line connectors */
export default function TraverseResult({ entries, onNodeSelect }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (entries.length === 0) {
    return <p className="result-empty">No results found.</p>;
  }

  const visible = expanded ? entries : entries.slice(0, INITIAL_LIMIT);
  const hasMore = entries.length > INITIAL_LIMIT;
  const lastAtDepth = computeLastAtDepth(visible);

  return (
    <div className="result-traverse">
      {visible.map((entry, i) => {
        const { node, relationship, depth } = entry;
        const color = getNodeColor(node.type);
        const isRoot = depth === 0;
        const isLast = lastAtDepth.has(i);

        const classes = [
          'result-traverse-entry',
          isRoot && 'root-entry',
          isLast && 'last-at-depth',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={`${node.id}-${i}`}
            className={classes}
            style={{ paddingLeft: isRoot ? 0 : depth * 20 }}
          >
            {relationship && relationship.type && (
              <span className="result-traverse-rel">{relationship.type} →</span>
            )}
            <div
              className="result-traverse-node"
              onClick={() => onNodeSelect?.(node.id)}
            >
              <span className="result-type-badge" style={{ background: color }}>
                {node.type}
              </span>
              <span className="result-node-name">{node.name}</span>
            </div>
          </div>
        );
      })}
      {hasMore && (
        <button
          className="result-show-more"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : `Show all ${entries.length}`}
        </button>
      )}
    </div>
  );
}
