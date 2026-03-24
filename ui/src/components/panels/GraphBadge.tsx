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

import type { GraphBadgeProps } from './types';
import './GraphBadge.css';

export default function GraphBadge({
  nodeCount,
  edgeCount,
  totalNodes,
  totalEdges,
}: GraphBadgeProps) {
  return (
    <span className="graph-badge">
      <span className="graph-badge-rendered">{nodeCount}</span>
      {totalNodes != null && (
        <span className="graph-badge-total">({totalNodes})</span>
      )}
      <span className="graph-badge-label">nodes</span>
      <span className="graph-badge-sep">&middot;</span>
      <span className="graph-badge-rendered">{edgeCount}</span>
      {totalEdges != null && (
        <span className="graph-badge-total">({totalEdges})</span>
      )}
      <span className="graph-badge-label">edges</span>
    </span>
  );
}
