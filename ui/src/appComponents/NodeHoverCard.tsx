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

import { useEffect, useState } from 'react';
import { getNodeColor } from '@opentrace/components';
import type { GraphNode } from '../components/graph/types';
import { useStore } from '../store/context';
import './NodeHoverCard.css';

export interface HoverInfo {
  node: GraphNode;
  /** Canvas-local px where the hover was picked. */
  x: number;
  y: number;
}

/** How long the cursor must rest on a node before the card appears. */
const SHOW_DELAY_MS = 600;

/** Pick a human-readable one-liner from the node's properties. */
function summaryOf(props: Record<string, unknown> | undefined): string | null {
  if (!props) return null;
  for (const key of ['summary', 'signature', 'docstring', 'description']) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Delayed hover tooltip for graph nodes: name + type badge immediately known,
 * summary/signature resolved lazily (graph data is kept lean — property blobs
 * live in the store, mirroring SidePanel's fetch-on-demand).
 */
export default function NodeHoverCard({ info }: { info: HoverInfo | null }) {
  const { store } = useStore();
  const [visible, setVisible] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);

  // Show only after the cursor has rested on the node for SHOW_DELAY_MS.
  /* eslint-disable react-hooks/set-state-in-effect -- timer/fetch pattern */
  useEffect(() => {
    setVisible(false);
    if (!info) return;
    const t = setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, [info?.node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve the summary lazily; the lean graph data usually has no properties.
  useEffect(() => {
    setSummary(null);
    if (!info) return;
    const inline = summaryOf(info.node.properties);
    if (inline) {
      setSummary(inline);
      return;
    }
    let cancelled = false;
    store
      .getNode(info.node.id)
      .then((n) => {
        if (!cancelled) setSummary(summaryOf(n?.properties ?? undefined));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [info?.node.id, store]); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!info || !visible) return null;

  return (
    <div
      className="node-hover-card"
      style={{ left: info.x + 14, top: info.y + 14 }}
      role="tooltip"
    >
      <div className="node-hover-card__head">
        <span
          className="node-hover-card__dot"
          style={{ backgroundColor: getNodeColor(info.node.type) }}
        />
        <span className="node-hover-card__name">{info.node.name}</span>
        <span className="node-hover-card__type">{info.node.type}</span>
      </div>
      {summary && <div className="node-hover-card__summary">{summary}</div>}
    </div>
  );
}
